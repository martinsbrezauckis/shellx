import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { ReleaseSurfaceFileIdentity } from "./lib/release-surface-candidate-attestation";
import {
  validateReleaseSurfaceInstallationReceipt,
  type ReleaseSurfaceInstallationReceipt,
} from "./lib/release-surface-installation-receipt";
import {
  collectReleaseSurfaceInstalledPayloadManifest,
  isReleaseSurfacePathInsideRoot,
  sameReleaseSurfaceInstalledPayloadManifest,
} from "./lib/release-surface-installed-payload-manifest";
import { removeReleaseSurfaceMacosManifestBoundTree } from "./lib/release-surface-macos-dmg-installation";
import { assertReleaseSurfaceNoSymlinkAncestry } from "./lib/release-surface-macos-native";

const FINALIZATION_SCHEMA = "shellx/release-surface-macos-dmg-finalization@1";
const root = resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
if (process.platform !== "darwin") throw new Error("macOS DMG finalization requires a native macOS host");
const receiptPath = resolve(requiredArg(args, "--installation-receipt"));
const outputPath = resolve(requiredArg(args, "--out"));
if (existsSync(outputPath)) throw new Error("macOS DMG finalization output already exists");
const outputParent = lstatSync(dirname(outputPath));
if (outputParent.isSymbolicLink() || !outputParent.isDirectory()) {
  throw new Error("macOS DMG finalization output parent must be a regular non-link directory");
}
assertReleaseSurfaceNoSymlinkAncestry(receiptPath, "macOS installation receipt");
assertReleaseSurfaceNoSymlinkAncestry(dirname(outputPath), "macOS finalization output parent");
const receiptIdentity = identifyRegularFile(receiptPath, "macOS installation receipt");
const receiptBytes = readFileSync(receiptPath);
const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" });
if (dirty.trim()) throw new Error("macOS DMG finalization requires the clean frozen source checkout");
const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const version = (JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as { version: string }).version;
const receipt = JSON.parse(receiptBytes.toString("utf8")) as ReleaseSurfaceInstallationReceipt;
if (receipt.platform !== "macos-installed" || receipt.method !== "installer-observed") {
  throw new Error("macOS DMG finalization requires a macOS installer-observed receipt");
}
const targetApp = receipt.payloadManifest.rootPath;
assertRunOwnedTarget(targetApp);
if (isReleaseSurfacePathInsideRoot(targetApp, outputPath, "macos-installed")) {
  throw new Error("macOS DMG finalization output must be outside the receipt-bound application");
}
const receiptErrors = validateReleaseSurfaceInstallationReceipt({
  receipt,
  platform: "macos-installed",
  sourceCommit,
  version,
  method: "installer-observed",
  artifact: receipt.distributionArtifact,
  installedPayload: receipt.installedPayload,
});
if (receiptErrors.length > 0) throw new Error(`macOS installation receipt is invalid: ${receiptErrors.join("; ")}`);
const currentManifest = collectReleaseSurfaceInstalledPayloadManifest({
  nodeRootPath: targetApp,
  recordedRootPath: targetApp,
  platform: "macos-installed",
  scope: "installer-target-root",
  mainExecutableRelativePath: receipt.payloadManifest.mainExecutableRelativePath,
});
if (!sameReleaseSurfaceInstalledPayloadManifest(receipt.payloadManifest, currentManifest)) {
  throw new Error("macOS installed application changed after candidate testing; refusing finalization");
}
if (collectShellxProcessIds().length !== 0) {
  throw new Error("no shellX application process may exist before receipt-bound finalization");
}
const mountedImage = receipt.nativeMacosDmgObservation!.mountedImage;
if (mountedImage.detached !== true || existsSync(mountedImage.mountPoint)) {
  throw new Error("receipt-bound DMG mount point still exists; refusing application finalization");
}
const receiptIdentityBeforeDelete = identifyRegularFile(receiptPath, "macOS installation receipt before deletion");
if (!sameIdentity(receiptIdentityBeforeDelete, receiptIdentity)) {
  throw new Error("macOS installation receipt changed before finalization");
}
const startedAt = new Date().toISOString();
removeReleaseSurfaceMacosManifestBoundTree({ targetApp, manifest: currentManifest });
const completedAt = new Date().toISOString();
if (existsSync(targetApp)) throw new Error("macOS manifest-bound finalizer left the target application behind");
const receiptIdentityAfter = identifyRegularFile(receiptPath, "macOS installation receipt after finalization");
if (!sameIdentity(receiptIdentityAfter, receiptIdentity)) {
  throw new Error("macOS installation receipt changed during finalization");
}
const finalizationReceipt = {
  schema: FINALIZATION_SCHEMA,
  sourceCommit,
  version,
  createdAt: new Date().toISOString(),
  installationReceipt: receiptIdentity,
  targetApp,
  payloadManifestSha256: currentManifest.manifestSha256,
  mountedImageDeviceEntry: mountedImage.deviceEntry,
  mountedImageDetachedAt: mountedImage.detachedAt,
  startedAt,
  completedAt,
  targetRemoved: true,
  imageMountPointAbsent: true,
  exactManifestBoundDeletion: true,
  recursiveDeleteUsed: false,
  shellxProcessIdsBefore: [],
};
writeFileSync(outputPath, `${JSON.stringify(finalizationReceipt, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
console.log(`Finalized the receipt-bound macOS DMG candidate: ${outputPath}`);

function assertRunOwnedTarget(path: string): void {
  const expectedParent = join(homedir(), "Library", "Application Support", "ShellXReleaseEvidence");
  if (dirname(path) !== expectedParent || !/^shellx-final-install-[A-Za-z0-9._-]+\.app$/.test(basename(path))) {
    throw new Error("receipt-bound target is outside the user-owned ShellX release-evidence directory");
  }
  assertReleaseSurfaceNoSymlinkAncestry(path, "receipt-bound macOS target application");
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory() || stat.uid !== process.getuid!()) {
    throw new Error("receipt-bound macOS target application must be a user-owned regular non-link directory");
  }
}

function collectShellxProcessIds(): number[] {
  const result = spawnSync("/usr/bin/pgrep", ["-x", "shellX"], { encoding: "utf8", timeout: 30_000 });
  if (result.error) throw new Error(`shellX process observation could not start: ${result.error.message}`);
  if (result.status === 1) return [];
  if (result.status !== 0) throw new Error((result.stderr || "shellX process observation failed").trim());
  const ids = result.stdout.split(/\s+/).filter(Boolean).map(Number);
  if (ids.some((id) => !Number.isSafeInteger(id) || id <= 0)) throw new Error("shellX process observation returned an invalid PID");
  return [...new Set(ids)].sort((left, right) => left - right);
}

function identifyRegularFile(path: string, label: string): ReleaseSurfaceFileIdentity {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size <= 0) throw new Error(`${label} must be a non-empty regular file`);
  const bytes = readFileSync(path);
  return { basename: basename(path), sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length };
}

function sameIdentity(left: ReleaseSurfaceFileIdentity, right: ReleaseSurfaceFileIdentity): boolean {
  return left.basename === right.basename && left.sha256 === right.sha256 && left.bytes === right.bytes;
}

function requiredArg(values: string[], name: string): string {
  const index = values.indexOf(name);
  const value = index >= 0 ? values[index + 1] : values.find((entry) => entry.startsWith(`${name}=`))?.slice(name.length + 1);
  if (!value?.trim()) throw new Error(`${name} is required`);
  return value;
}
