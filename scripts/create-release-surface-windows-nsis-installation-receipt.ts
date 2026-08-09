import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
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
import {
  validateReleaseSurfaceWindowsNsisInstallationObservation,
  windowsNsisPowerShellArguments,
  type ReleaseSurfaceWindowsNsisInstallationObservation,
} from "./lib/release-surface-windows-nsis-installation";
import {
  loadReleaseSurfaceSignatureReceipt,
  validateReleaseSurfaceSignatureReceipt,
} from "./lib/release-surface-signature-receipt";

const root = resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
assertWindowsHost();
const artifactPath = requiredArg(args, "--artifact");
const targetRoot = requiredArg(args, "--target-root");
const expectedUser = requiredArg(args, "--expected-user");
const signatureReceiptPath = resolve(requiredArg(args, "--signature-receipt"));
const outputPath = resolve(requiredArg(args, "--out"));
assertCanonicalWindowsPath(artifactPath, "--artifact");
assertCanonicalWindowsPath(targetRoot, "--target-root");
if (!/^shellx-final-install-[A-Za-z0-9._-]+$/.test(targetRoot.split("\\").at(-1) ?? "")) {
  throw new Error("--target-root must name one shellx-final-install-* run-owned directory");
}
if (existsSync(outputPath)) throw new Error("installation receipt output already exists");
const outputParent = lstatSync(dirname(outputPath));
if (outputParent.isSymbolicLink() || !outputParent.isDirectory()) {
  throw new Error("installation receipt parent must be a regular non-link directory");
}
const nodeTargetRoot = windowsToNodePath(targetRoot);
if (isReleaseSurfacePathInsideRoot(nodeTargetRoot, outputPath, "windows-installed")) {
  throw new Error("installation receipt output must be outside the installed target root");
}
const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" });
if (dirty.trim()) throw new Error("installation receipt requires a clean frozen source checkout");
const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const version = (JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as { version: string }).version;
const nodeArtifactPath = windowsToNodePath(artifactPath);
const artifact = identifyRegularFile(nodeArtifactPath, "signed Windows distribution artifact");
const signatureReceipt = identifyRegularFile(signatureReceiptPath, "Windows signature receipt");
const contract = JSON.parse(readFileSync(resolve(root, "release", "surface-contract.json"), "utf8")) as {
  platforms: Record<string, { signatureStatus: "verified" | "digest-verified"; requiredSignatureChecks: string[] }>;
};
const windowsContract = contract.platforms["windows-installed"];
if (!windowsContract) throw new Error("final surface contract has no Windows platform signing policy");
const parsedSignatureReceipt = loadReleaseSurfaceSignatureReceipt(signatureReceiptPath);
const signatureErrors = validateReleaseSurfaceSignatureReceipt({
  receipt: parsedSignatureReceipt,
  platform: "windows-installed",
  sourceCommit,
  version,
  artifact,
  expectedStatus: windowsContract.signatureStatus,
  requiredChecks: windowsContract.requiredSignatureChecks,
});
if (signatureErrors.length > 0) throw new Error(`Windows signature receipt is invalid: ${signatureErrors.join("; ")}`);
if (parsedSignatureReceipt.nativeVerification.kind !== "windows-authenticode") {
  throw new Error("Windows signature receipt does not contain native Authenticode signing-profile evidence");
}
const orchestrator = process.platform === "win32" ? "native" : "wsl";
const scriptPath = nodeToWindowsPath(resolve(root, "scripts", "run-release-surface-windows-nsis-install.ps1"));
const result = spawnSync("powershell.exe", windowsNsisPowerShellArguments({
  scriptPath,
  artifactPath,
  targetRoot,
  expectedUser,
  expectedVersion: version,
  orchestrator,
}), { encoding: "utf8", timeout: 20 * 60_000, maxBuffer: 16 * 1024 * 1024 });
if (result.status !== 0) {
  throw new Error((result.stderr || result.stdout || "Windows NSIS installation adapter failed").trim());
}
const jsonLine = result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
if (!jsonLine) throw new Error("Windows NSIS installation adapter returned no JSON observation");
const observation = JSON.parse(jsonLine) as ReleaseSurfaceWindowsNsisInstallationObservation;
const observationErrors = validateReleaseSurfaceWindowsNsisInstallationObservation({
  observation,
  orchestrator,
  expectedUser,
  expectedVersion: version,
  artifact,
  artifactPath,
  targetRoot,
  approvedSignature: parsedSignatureReceipt.nativeVerification,
});
if (observationErrors.length > 0) {
  throw new Error(`Windows NSIS installation observation is invalid: ${observationErrors.join("; ")}`);
}
const installedPayload = {
  ...identifyRegularFile(windowsToNodePath(observation.mainExecutablePath), "installed ShellX executable"),
  path: observation.mainExecutablePath,
};
const firstManifest = collectReleaseSurfaceInstalledPayloadManifestForPlatform({
  nodeRootPath: nodeTargetRoot,
  recordedRootPath: targetRoot,
  platform: "windows-installed",
  scope: "installer-target-root",
  mainExecutableRelativePath: "shellx.exe",
});
const secondManifest = collectReleaseSurfaceInstalledPayloadManifestForPlatform({
  nodeRootPath: nodeTargetRoot,
  recordedRootPath: targetRoot,
  platform: "windows-installed",
  scope: "installer-target-root",
  mainExecutableRelativePath: "shellx.exe",
});
if (!sameReleaseSurfaceInstalledPayloadManifest(firstManifest, secondManifest)) {
  throw new Error("Windows installed payload changed between mandatory native manifest snapshots");
}
const uninstaller = secondManifest.entries.find((entry) => entry.path.toLowerCase() === "uninstall.exe");
if (!uninstaller || uninstaller.kind !== "file" || uninstaller.bytes <= 0) {
  throw new Error("Windows NSIS installed payload does not contain a non-empty uninstaller");
}
const artifactAfter = identifyRegularFile(nodeArtifactPath, "signed Windows distribution artifact after install");
if (artifactAfter.sha256 !== artifact.sha256 || artifactAfter.bytes !== artifact.bytes) {
  throw new Error("signed Windows distribution artifact changed before receipt creation");
}
const receipt: ReleaseSurfaceInstallationReceipt = {
  schema: RELEASE_SURFACE_INSTALLATION_RECEIPT_SCHEMA,
  platform: "windows-installed",
  sourceCommit,
  version,
  createdAt: new Date().toISOString(),
  method: "installer-observed",
  status: "pass",
  distributionArtifact: artifact,
  installedPayload,
  coverage: { payload: "complete-target-root", systemEffects: "declared-subset" },
  systemEffects: observation.systemEffects,
  nativeWindowsNsisObservation: observation,
  signatureReceipt,
  windowsSignatureVerification: parsedSignatureReceipt.nativeVerification,
  operation: {
    adapter: "windows-nsis-install-v1",
    orchestrator,
    startedAt: observation.operation.startedAt,
    completedAt: observation.operation.completedAt,
    targetRootStateBefore: "absent",
    exitCode: 0,
  },
  payloadManifest: secondManifest,
  manifestVerification: {
    firstCollectedAt: firstManifest.collectedAt,
    secondCollectedAt: secondManifest.collectedAt,
    firstManifestSha256: firstManifest.manifestSha256,
    secondManifestSha256: secondManifest.manifestSha256,
  },
  checks: [
    "disposable-user-baseline",
    "artifact-signature-valid",
    "artifact-unchanged",
    "target-absent",
    "installer-exit-zero",
    "payload-created",
    "payload-hash-recomputed",
    "manifest-double-collected",
    "system-effects-observed",
    "machine-registration-absent",
    "process-autolaunch-absent",
    "webview2-unchanged",
  ].map((id) => ({
    id,
    status: "pass" as const,
    observed: `${id} passed in the native isolated Windows NSIS adapter`,
  })),
};
const receiptErrors = validateReleaseSurfaceInstallationReceipt({
  receipt,
  platform: "windows-installed",
  sourceCommit,
  version,
  method: "installer-observed",
  artifact,
  installedPayload,
});
if (receiptErrors.length > 0) throw new Error(`generated Windows installation receipt is invalid: ${receiptErrors.join("; ")}`);
writeFileSync(outputPath, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
console.log(`Installed and recorded the Windows NSIS candidate: ${outputPath}`);

function identifyRegularFile(path: string, label: string) {
  const absolute = resolve(path);
  const stat = lstatSync(absolute);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size <= 0) {
    throw new Error(`${label} must be a non-empty regular non-link file: ${absolute}`);
  }
  const bytes = readFileSync(absolute);
  return { basename: basename(absolute), sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length };
}

function windowsToNodePath(path: string): string {
  if (process.platform === "win32") return resolve(path);
  const result = spawnSync("wslpath", ["-u", path], { encoding: "utf8" });
  if (result.status !== 0 || !result.stdout.trim()) throw new Error(`unable to map Windows path ${path}`);
  return resolve(result.stdout.trim());
}

function nodeToWindowsPath(path: string): string {
  if (process.platform === "win32") return resolve(path);
  const result = spawnSync("wslpath", ["-w", path], { encoding: "utf8" });
  if (result.status !== 0 || !result.stdout.trim()) throw new Error(`unable to map script path ${path}`);
  return result.stdout.trim();
}

function assertCanonicalWindowsPath(path: string, label: string): void {
  if (!/^[A-Za-z]:\\[^/]+/.test(path) || path.includes("/") || path.endsWith("\\") || path.includes("\\\\")
    || path.slice(3).split("\\").some((part) => !part || part === "." || part === "..")) {
    throw new Error(`${label} must be a canonical local absolute Windows path`);
  }
}

function assertWindowsHost(): void {
  const wsl = Boolean(process.env.WSL_INTEROP?.trim() || process.env.WSL_DISTRO_NAME?.trim());
  if (process.platform !== "win32" && !(process.platform === "linux" && wsl)) {
    throw new Error("Windows NSIS installation requires native Windows or WSL orchestration");
  }
}

function requiredArg(values: string[], name: string): string {
  const index = values.indexOf(name);
  const value = index >= 0 ? values[index + 1] : values.find((entry) => entry.startsWith(`${name}=`))?.slice(name.length + 1);
  if (!value?.trim()) throw new Error(`${name} is required`);
  return value;
}
