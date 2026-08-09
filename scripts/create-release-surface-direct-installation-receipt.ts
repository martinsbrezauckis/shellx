import { createHash } from "node:crypto";
import { spawnSync, execFileSync } from "node:child_process";
import {
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, resolve } from "node:path";
import type { ReleasePlatform } from "./lib/release-surface-inventory";
import {
  RELEASE_SURFACE_INSTALLATION_RECEIPT_SCHEMA,
  validateReleaseSurfaceInstallationReceipt,
  type ReleaseSurfaceInstallationReceipt,
} from "./lib/release-surface-installation-receipt";
import {
  collectReleaseSurfaceInstalledPayloadManifestForPlatform,
  isReleaseSurfacePathInsideRoot,
  sameReleaseSurfaceInstalledPayloadManifest,
} from "./lib/release-surface-installed-payload-manifest";

const root = resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const platform = requiredArg(args, "--platform") as ReleasePlatform;
if (!( ["windows-installed", "macos-installed", "linux-installed"] as string[]).includes(platform)) {
  throw new Error("valid --platform is required");
}
const artifactPath = requiredArg(args, "--artifact");
const targetRootPath = requiredArg(args, "--target-root");
const payloadRelativePath = requiredArg(args, "--payload-relative-path");
const outputPath = requiredArg(args, "--out");
if (!/^[A-Za-z0-9._-]+$/.test(payloadRelativePath) || payloadRelativePath === "." || payloadRelativePath === "..") {
  throw new Error("--payload-relative-path must be one safe filename for direct staging");
}
assertCanonicalTargetRoot(targetRootPath, platform);
assertPlatformHost(platform);
const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" });
if (dirty.trim()) throw new Error("installation receipt requires a clean frozen source checkout");
const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const version = (JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as { version: string }).version;
const nodeArtifactPath = nodeReadablePath(artifactPath, platform);
const artifact = identifyRegularFile(nodeArtifactPath, "distribution artifact");
const nodeTargetRoot = nodeReadablePath(targetRootPath, platform);
const nodeOutputPath = nodeReadablePath(outputPath, platform);
const targetName = basename(nodeTargetRoot.replace(/[\\/]+$/, ""));
if (!/^shellx-final-install-[A-Za-z0-9._-]+$/.test(targetName)) {
  throw new Error("--target-root basename must start with shellx-final-install-");
}
if (!existsSync(dirname(nodeTargetRoot))) throw new Error("installation target parent must already exist");
const targetParentStat = lstatSync(dirname(nodeTargetRoot));
if (targetParentStat.isSymbolicLink() || !targetParentStat.isDirectory()) {
  throw new Error("installation target parent must be a regular non-link directory");
}
if (existsSync(nodeTargetRoot)) throw new Error("installation target root must be absent before direct staging");
if (isReleaseSurfacePathInsideRoot(nodeTargetRoot, nodeOutputPath, platform)) {
  throw new Error("installation receipt output must be outside the staged payload root");
}
if (existsSync(nodeOutputPath)) throw new Error("installation receipt output already exists");
const outputParentStat = lstatSync(dirname(nodeOutputPath));
if (outputParentStat.isSymbolicLink() || !outputParentStat.isDirectory()) {
  throw new Error("installation receipt parent must be a regular non-link directory");
}

const startedAt = new Date().toISOString();
let ownsTarget = false;
try {
  mkdirSync(nodeTargetRoot);
  ownsTarget = true;
  const installedNodePath = resolve(nodeTargetRoot, payloadRelativePath);
  copyFileSync(nodeArtifactPath, installedNodePath, constants.COPYFILE_EXCL);
  const completedAt = new Date().toISOString();
  const installedPayload = {
    ...identifyRegularFile(installedNodePath, "staged installed payload"),
    path: joinPlatformPath(targetRootPath, payloadRelativePath, platform),
  };
  const firstManifest = collectReleaseSurfaceInstalledPayloadManifestForPlatform({
    nodeRootPath: nodeTargetRoot,
    recordedRootPath: targetRootPath,
    platform,
    scope: "staged-direct-file",
    mainExecutableRelativePath: payloadRelativePath,
  });
  const secondManifest = collectReleaseSurfaceInstalledPayloadManifestForPlatform({
    nodeRootPath: nodeTargetRoot,
    recordedRootPath: targetRootPath,
    platform,
    scope: "staged-direct-file",
    mainExecutableRelativePath: payloadRelativePath,
  });
  if (!sameReleaseSurfaceInstalledPayloadManifest(firstManifest, secondManifest)) {
    throw new Error("installed payload changed between mandatory manifest snapshots");
  }
  const receipt: ReleaseSurfaceInstallationReceipt = {
    schema: RELEASE_SURFACE_INSTALLATION_RECEIPT_SCHEMA,
    platform,
    sourceCommit,
    version,
    createdAt: new Date().toISOString(),
    method: "direct-artifact",
    status: "pass",
    distributionArtifact: artifact,
    installedPayload,
    coverage: { payload: "staged-direct-file", systemEffects: "not-observed" },
    systemEffects: [],
    operation: {
      adapter: directAdapter(platform),
      orchestrator: installationOrchestrator(platform),
      startedAt,
      completedAt,
      targetRootStateBefore: "absent",
    },
    payloadManifest: secondManifest,
    manifestVerification: {
      firstCollectedAt: firstManifest.collectedAt,
      secondCollectedAt: secondManifest.collectedAt,
      firstManifestSha256: firstManifest.manifestSha256,
      secondManifestSha256: secondManifest.manifestSha256,
    },
    checks: ["target-absent", "payload-staged", "payload-hash-recomputed", "manifest-double-collected"].map((id) => ({
      id,
      status: "pass" as const,
      observed: `${id} passed in the isolated ${platform} direct-stage adapter`,
    })),
  };
  const errors = validateReleaseSurfaceInstallationReceipt({
    receipt,
    platform,
    sourceCommit,
    version,
    method: "direct-artifact",
    artifact,
    installedPayload,
  });
  if (errors.length > 0) throw new Error(`generated installation receipt is invalid: ${errors.join("; ")}`);
  writeFileSync(nodeOutputPath, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  console.log(`Staged and recorded ${platform} direct payload: ${nodeOutputPath}`);
} catch (error) {
  if (ownsTarget) rmSync(nodeTargetRoot, { recursive: true, force: false });
  throw error;
}

function identifyRegularFile(path: string, label: string) {
  const absolute = resolve(path);
  const stat = lstatSync(absolute);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`${label} must be a regular non-link file: ${absolute}`);
  const bytes = readFileSync(absolute);
  if (bytes.length === 0) throw new Error(`${label} must not be empty: ${absolute}`);
  return {
    basename: basename(absolute),
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.length,
  };
}

function directAdapter(platform: ReleasePlatform): ReleaseSurfaceInstallationReceipt["operation"]["adapter"] {
  if (platform === "windows-installed") return "windows-direct-stage-v1";
  if (platform === "macos-installed") return "macos-direct-stage-v1";
  return "linux-direct-stage-v1";
}

function installationOrchestrator(platform: ReleasePlatform): "native" | "wsl" {
  if (platform !== "windows-installed" || process.platform === "win32") return "native";
  if (process.env.WSL_INTEROP?.trim()) return "wsl";
  throw new Error("Windows direct installation staging requires native Windows or WSL interop");
}

function nodeReadablePath(path: string, platform: ReleasePlatform): string {
  if (platform !== "windows-installed" || process.platform === "win32" || !/^[A-Za-z]:[\\/]/.test(path)) return resolve(path);
  const result = spawnSync("wslpath", ["-u", path], { encoding: "utf8" });
  if (result.status !== 0 || !result.stdout.trim()) throw new Error(`unable to map Windows installation path ${path}`);
  return resolve(result.stdout.trim());
}

function joinPlatformPath(rootPath: string, relativePath: string, platform: ReleasePlatform): string {
  const separator = platform === "windows-installed" ? "\\" : "/";
  return `${rootPath.replace(/[\\/]+$/, "")}${separator}${relativePath}`;
}

function assertCanonicalTargetRoot(path: string, platform: ReleasePlatform): void {
  if (platform === "windows-installed") {
    if (!/^[A-Za-z]:\\[^/]+/.test(path) || path.includes("/") || path.endsWith("\\") || path.includes("\\\\")
      || path.slice(3).split("\\").some((part) => !part || part === "." || part === "..")) {
      throw new Error("--target-root must be a canonical local absolute Windows path");
    }
    return;
  }
  if (!path.startsWith("/") || path === "/" || path.includes("\\") || path.endsWith("/") || path.includes("//")
    || path.slice(1).split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error("--target-root must be a canonical non-root absolute POSIX path");
  }
}


function assertPlatformHost(platform: ReleasePlatform): void {
  const inWsl = Boolean(process.env.WSL_INTEROP?.trim() || process.env.WSL_DISTRO_NAME?.trim());
  if (platform === "windows-installed") {
    if (process.platform !== "win32" && !(process.platform === "linux" && inWsl)) {
      throw new Error("windows-installed direct staging requires native Windows or WSL interop");
    }
    return;
  }
  if (platform === "macos-installed" && process.platform !== "darwin") {
    throw new Error("macos-installed direct staging requires a native macOS host");
  }
  if (platform === "linux-installed" && (process.platform !== "linux" || inWsl)) {
    throw new Error("linux-installed direct staging requires a native non-WSL Linux host");
  }
}

function requiredArg(values: string[], name: string): string {
  const index = values.indexOf(name);
  const value = index >= 0 ? values[index + 1] : values.find((entry) => entry.startsWith(`${name}=`))?.slice(name.length + 1);
  if (!value?.trim()) throw new Error(`${name} is required`);
  return value;
}
