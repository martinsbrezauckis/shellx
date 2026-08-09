import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readdirSync, rmdirSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
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
import {
  assertNativeReleaseSurfaceLinuxHost,
  collectReleaseSurfaceLinuxHostState,
  findReleaseSurfaceLinuxTargetProcesses,
  RELEASE_SURFACE_LINUX_DEB_FINALIZATION_SCHEMA,
  removeReleaseSurfaceLinuxManifestTarget,
  type ReleaseSurfaceLinuxDebFinalizationEvidence,
} from "./lib/release-surface-linux-deb-installation";

const root = resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
assertNativeReleaseSurfaceLinuxHost();
const receiptPath = resolve(requiredArg(args, "--installation-receipt"));
const outputPath = resolve(requiredArg(args, "--out"));
assertNoSymlinkAncestry(receiptPath, "installation receipt");
assertNoSymlinkAncestry(dirname(outputPath), "finalization output parent");
if (existsSync(outputPath)) throw new Error("Linux finalization output already exists");
const outputParent = lstatSync(dirname(outputPath));
if (outputParent.isSymbolicLink() || !outputParent.isDirectory()) {
  throw new Error("Linux finalization output parent must be a regular non-link directory");
}
const receiptIdentity = identifyRegularFile(receiptPath, "Linux installation receipt");
const receiptBytes = readFileSync(receiptPath);
const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" });
if (dirty.trim()) throw new Error("Linux finalization requires the clean frozen source checkout");
const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const version = (JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as { version: string }).version;
const receipt = JSON.parse(receiptBytes.toString("utf8")) as ReleaseSurfaceInstallationReceipt;
if (receipt.platform !== "linux-installed" || receipt.method !== "installer-observed") {
  throw new Error("Linux finalization requires a Linux installer-observed receipt");
}
const receiptErrors = validateReleaseSurfaceInstallationReceipt({
  receipt,
  platform: "linux-installed",
  sourceCommit,
  version,
  method: "installer-observed",
  artifact: receipt.distributionArtifact,
  installedPayload: receipt.installedPayload,
});
if (receiptErrors.length > 0) throw new Error(`Linux installation receipt is invalid: ${receiptErrors.join("; ")}`);
const targetRoot = resolve(receipt.payloadManifest.rootPath);
if (isReleaseSurfacePathInsideRoot(targetRoot, outputPath, "linux-installed")) {
  throw new Error("Linux finalization output must be outside the receipt-owned target root");
}
if (isReleaseSurfacePathInsideRoot(dirname(targetRoot), outputPath, "linux-installed")) {
  throw new Error("Linux finalization output must be outside the receipt-owned run root");
}
if (isReleaseSurfacePathInsideRoot(dirname(targetRoot), receiptPath, "linux-installed")) {
  throw new Error("Linux installation receipt must be outside the receipt-owned run root");
}
const currentManifest = collectReleaseSurfaceInstalledPayloadManifest({
  nodeRootPath: targetRoot,
  recordedRootPath: receipt.payloadManifest.rootPath,
  platform: "linux-installed",
  scope: "installer-target-root",
  mainExecutableRelativePath: receipt.payloadManifest.mainExecutableRelativePath,
});
if (!sameReleaseSurfaceInstalledPayloadManifest(receipt.payloadManifest, currentManifest)) {
  throw new Error("Linux installed payload changed after candidate testing; refusing finalization");
}
const hostBefore = collectReleaseSurfaceLinuxHostState();
if (JSON.stringify(hostBefore) !== JSON.stringify(receipt.nativeLinuxDebObservation!.safety.after)) {
  throw new Error("Linux host package, process, or integration state drifted after candidate testing");
}
const activeTargetProcessIds = findReleaseSurfaceLinuxTargetProcesses(targetRoot);
if (activeTargetProcessIds.length > 0) {
  throw new Error(`Linux installed payload is still active in PID ${activeTargetProcessIds.join(",")}; preserving target`);
}
const removed = removeReleaseSurfaceLinuxManifestTarget({ targetRoot, manifest: currentManifest });
const runRoot = dirname(targetRoot);
if (!/^shellx-final-linux-run-[A-Za-z0-9._-]+$/.test(basename(runRoot)) || readdirSync(runRoot).length !== 0) {
  throw new Error("Linux receipt-owned run root is not empty after target finalization; preserving it");
}
rmdirSync(runRoot);
if (existsSync(targetRoot) || existsSync(runRoot)) throw new Error("Linux finalizer claimed success but owned paths remain");
const hostAfter = collectReleaseSurfaceLinuxHostState();
if (JSON.stringify(hostAfter) !== JSON.stringify(hostBefore)) {
  throw new Error("Linux host state changed during finalization; refusing to write success evidence");
}
const receiptIdentityAfter = identifyRegularFile(receiptPath, "Linux installation receipt after finalization");
if (JSON.stringify(receiptIdentityAfter) !== JSON.stringify(receiptIdentity)) {
  throw new Error("Linux installation receipt changed during finalization");
}
const evidence: ReleaseSurfaceLinuxDebFinalizationEvidence = {
  schema: RELEASE_SURFACE_LINUX_DEB_FINALIZATION_SCHEMA,
  platform: "linux-installed",
  sourceCommit,
  version,
  createdAt: new Date().toISOString(),
  installationReceipt: receiptIdentity,
  targetRootSha256: receipt.nativeLinuxDebObservation!.targetRootSha256,
  removedFiles: removed.removedFiles,
  removedDirectories: removed.removedDirectories,
  targetRemoved: true,
  runRootRemoved: true,
  recursiveDeleteUsed: false,
  activeTargetProcessIds: [],
  hostStateUnchanged: true,
};
writeFileSync(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
console.log(`Finalized the receipt-bound Linux Debian candidate: ${outputPath}`);

function identifyRegularFile(path: string, label: string): ReleaseSurfaceFileIdentity {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size <= 0) throw new Error(`${label} must be a non-empty regular non-link file`);
  const bytes = readFileSync(path);
  return { basename: basename(path), sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length };
}

function assertNoSymlinkAncestry(path: string, label: string): void {
  let current = resolve(path);
  while (true) {
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error(`${label} must not have a symlink in its ancestry`);
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

function requiredArg(values: string[], name: string): string {
  const index = values.indexOf(name);
  const value = index >= 0 ? values[index + 1] : values.find((entry) => entry.startsWith(`${name}=`))?.slice(name.length + 1);
  if (!value?.trim()) throw new Error(`${name} is required`);
  return value;
}
