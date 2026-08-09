import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import type { ReleaseSurfaceFileIdentity } from "./lib/release-surface-candidate-attestation";
import {
  validateReleaseSurfaceInstallationReceipt,
  type ReleaseSurfaceInstallationReceipt,
} from "./lib/release-surface-installation-receipt";
import {
  collectReleaseSurfaceInstalledPayloadManifestForPlatform,
  isReleaseSurfacePathInsideRoot,
  sameReleaseSurfaceInstalledPayloadManifest,
} from "./lib/release-surface-installed-payload-manifest";

const FINALIZATION_SCHEMA = "shellx/release-surface-windows-nsis-finalization@1";
const root = resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
assertWindowsHost();
const receiptPath = resolve(requiredArg(args, "--installation-receipt"));
const expectedUser = requiredArg(args, "--expected-user");
const outputPath = resolve(requiredArg(args, "--out"));
if (existsSync(outputPath)) throw new Error("Windows NSIS finalization output already exists");
const outputParent = lstatSync(dirname(outputPath));
if (outputParent.isSymbolicLink() || !outputParent.isDirectory()) {
  throw new Error("Windows NSIS finalization output parent must be a regular non-link directory");
}
assertNoSymlinkAncestry(receiptPath, "installation receipt");
assertNoSymlinkAncestry(dirname(outputPath), "finalization output parent");
const receiptStat = lstatSync(receiptPath);
if (receiptStat.isSymbolicLink() || !receiptStat.isFile() || receiptStat.size <= 0) {
  throw new Error("installation receipt must be a non-empty regular non-link file");
}
const receiptBytes = readFileSync(receiptPath);
const receiptIdentity: ReleaseSurfaceFileIdentity = {
  basename: basename(receiptPath),
  sha256: createHash("sha256").update(receiptBytes).digest("hex"),
  bytes: receiptBytes.length,
};
const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" });
if (dirty.trim()) throw new Error("Windows NSIS finalization requires the clean frozen source checkout");
const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const version = (JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as { version: string }).version;
const receipt = JSON.parse(receiptBytes.toString("utf8")) as ReleaseSurfaceInstallationReceipt;
if (receipt.platform !== "windows-installed" || receipt.method !== "installer-observed") {
  throw new Error("Windows NSIS finalization requires a Windows installer-observed receipt");
}
const receiptErrors = validateReleaseSurfaceInstallationReceipt({
  receipt,
  platform: "windows-installed",
  sourceCommit,
  version,
  method: "installer-observed",
  artifact: receipt.distributionArtifact,
  installedPayload: receipt.installedPayload,
});
if (receiptErrors.length > 0) throw new Error(`Windows installation receipt is invalid: ${receiptErrors.join("; ")}`);
const currentManifest = collectReleaseSurfaceInstalledPayloadManifestForPlatform({
  nodeRootPath: windowsToNodePath(receipt.payloadManifest.rootPath),
  recordedRootPath: receipt.payloadManifest.rootPath,
  platform: "windows-installed",
  scope: "installer-target-root",
  mainExecutableRelativePath: receipt.payloadManifest.mainExecutableRelativePath,
});
const nodeTargetRoot = windowsToNodePath(receipt.payloadManifest.rootPath);
if (isReleaseSurfacePathInsideRoot(nodeTargetRoot, outputPath, "windows-installed")) {
  throw new Error("Windows NSIS finalization output must be outside the receipt-bound TargetRoot");
}
if (!sameReleaseSurfaceInstalledPayloadManifest(receipt.payloadManifest, currentManifest)) {
  throw new Error("Windows installed payload changed after candidate testing; refusing finalization");
}
const uninstaller = currentManifest.entries.find((entry) => entry.path.toLowerCase() === "uninstall.exe");
if (!uninstaller || uninstaller.kind !== "file") throw new Error("Windows installed manifest has no receipt-bound uninstaller");
const orchestrator = process.platform === "win32" ? "native" : "wsl";
const scriptPath = nodeToWindowsPath(resolve(root, "scripts", "finalize-release-surface-windows-nsis-installation.ps1"));
const result = spawnSync("powershell.exe", [
  "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath,
  "-TargetRoot", receipt.payloadManifest.rootPath,
  "-ExpectedUser", expectedUser,
  "-ExpectedUserSid", receipt.nativeWindowsNsisObservation!.userSid,
  "-ExpectedUninstallerSha256", uninstaller.sha256,
  "-Orchestrator", orchestrator,
], { encoding: "utf8", timeout: 10 * 60_000, maxBuffer: 4 * 1024 * 1024 });
if (result.status !== 0) throw new Error((result.stderr || result.stdout || "Windows NSIS finalization failed").trim());
const line = result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
if (!line) throw new Error("Windows NSIS finalizer returned no JSON");
const observation = JSON.parse(line) as Record<string, unknown>;
if (observation.schema !== FINALIZATION_SCHEMA || observation.orchestrator !== orchestrator
  || observation.userName !== expectedUser
  || observation.userSid !== receipt.nativeWindowsNsisObservation!.userSid
  || observation.targetRoot !== receipt.payloadManifest.rootPath
  || observation.uninstallerSha256 !== uninstaller.sha256 || observation.exitCode !== 0
  || observation.targetRemoved !== true || observation.productRegistrationRemoved !== true
  || observation.uninstallRegistrationRemoved !== true || observation.shortcutsAndHandoffAbsent !== true
  || observation.recursiveDeleteUsed !== false) {
  throw new Error("Windows NSIS finalization observation is incomplete or does not bind the receipt");
}
if (existsSync(windowsToNodePath(receipt.payloadManifest.rootPath))) {
  throw new Error("Windows NSIS finalizer claimed success but TargetRoot still exists");
}
const receiptIdentityAfter = identifyRegularFile(receiptPath, "installation receipt after finalization");
if (receiptIdentityAfter.basename !== receiptIdentity.basename
  || receiptIdentityAfter.sha256 !== receiptIdentity.sha256
  || receiptIdentityAfter.bytes !== receiptIdentity.bytes) {
  throw new Error("installation receipt changed during finalization; refusing to write success evidence");
}
const finalizationReceipt = {
  ...observation,
  sourceCommit,
  version,
  createdAt: new Date().toISOString(),
  installationReceipt: receiptIdentity,
};
writeFileSync(outputPath, `${JSON.stringify(finalizationReceipt, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
console.log(`Finalized the receipt-bound Windows NSIS candidate: ${outputPath}`);

function identifyRegularFile(path: string, label: string): ReleaseSurfaceFileIdentity {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size <= 0) throw new Error(`${label} must be a non-empty regular file`);
  const bytes = readFileSync(path);
  return { basename: basename(path), sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length };
}

function assertNoSymlinkAncestry(path: string, label: string): void {
  let current = resolve(path);
  while (true) {
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error(`${label} must not have a symlink in its ancestry: ${current}`);
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
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

function assertWindowsHost(): void {
  const wsl = Boolean(process.env.WSL_INTEROP?.trim() || process.env.WSL_DISTRO_NAME?.trim());
  if (process.platform !== "win32" && !(process.platform === "linux" && wsl)) {
    throw new Error("Windows NSIS finalization requires native Windows or WSL orchestration");
  }
}

function requiredArg(values: string[], name: string): string {
  const index = values.indexOf(name);
  const value = index >= 0 ? values[index + 1] : values.find((entry) => entry.startsWith(`${name}=`))?.slice(name.length + 1);
  if (!value?.trim()) throw new Error(`${name} is required`);
  return value;
}
