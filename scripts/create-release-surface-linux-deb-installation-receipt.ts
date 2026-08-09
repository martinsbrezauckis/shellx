import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
  RELEASE_SURFACE_INSTALLATION_RECEIPT_SCHEMA,
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
  collectReleaseSurfaceLinuxDebInstallation,
  RELEASE_SURFACE_LINUX_DEB_MAIN_EXECUTABLE,
} from "./lib/release-surface-linux-deb-installation";
import {
  loadReleaseSurfaceSignatureReceipt,
  validateReleaseSurfaceSignatureReceipt,
} from "./lib/release-surface-signature-receipt";

const root = resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
assertNativeReleaseSurfaceLinuxHost();
const artifactPath = resolve(requiredArg(args, "--artifact"));
const targetRoot = resolve(requiredArg(args, "--target-root"));
const signatureReceiptPath = resolve(requiredArg(args, "--signature-receipt"));
const outputPath = resolve(requiredArg(args, "--out"));
assertNoSymlinkAncestry(artifactPath, "Linux Debian artifact");
assertNoSymlinkAncestry(signatureReceiptPath, "Linux artifact digest receipt");
assertCreateOnlyOutput(outputPath, targetRoot);
const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" });
if (dirty.trim()) throw new Error("Linux Debian installation receipt requires a clean frozen source checkout");
const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const version = (JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as { version: string }).version;
const artifact = identifyRegularFile(artifactPath, "Linux Debian distribution artifact");
const signatureReceipt = identifyRegularFile(signatureReceiptPath, "Linux artifact digest receipt");
const contract = JSON.parse(readFileSync(resolve(root, "release", "surface-contract.json"), "utf8")) as {
  platforms: Record<string, { signatureStatus: "verified" | "digest-verified"; requiredSignatureChecks: string[] }>;
};
const linuxContract = contract.platforms["linux-installed"];
if (!linuxContract) throw new Error("final surface contract has no Linux platform signing policy");
const parsedSignatureReceipt = loadReleaseSurfaceSignatureReceipt(signatureReceiptPath);
const signatureErrors = validateReleaseSurfaceSignatureReceipt({
  receipt: parsedSignatureReceipt,
  platform: "linux-installed",
  sourceCommit,
  version,
  artifact,
  expectedStatus: linuxContract.signatureStatus,
  requiredChecks: linuxContract.requiredSignatureChecks,
});
if (signatureErrors.length > 0) throw new Error(`Linux signature receipt is invalid: ${signatureErrors.join("; ")}`);
if (parsedSignatureReceipt.nativeVerification.kind !== "artifact-digest") {
  throw new Error("Linux signature receipt does not contain exact artifact-digest evidence");
}
const observation = collectReleaseSurfaceLinuxDebInstallation({ artifactPath, targetRoot, expectedVersion: version });
if (observation.environment !== "native-linux") throw new Error("Linux shipping-package receipt cannot be created from a WSL fixture");
const installedPath = join(targetRoot, ...RELEASE_SURFACE_LINUX_DEB_MAIN_EXECUTABLE.split("/"));
const installedPayload = { ...identifyRegularFile(installedPath, "installed ShellX executable"), path: installedPath };
const firstManifest = collectReleaseSurfaceInstalledPayloadManifest({
  nodeRootPath: targetRoot,
  recordedRootPath: targetRoot,
  platform: "linux-installed",
  scope: "installer-target-root",
  mainExecutableRelativePath: RELEASE_SURFACE_LINUX_DEB_MAIN_EXECUTABLE,
});
const secondManifest = collectReleaseSurfaceInstalledPayloadManifest({
  nodeRootPath: targetRoot,
  recordedRootPath: targetRoot,
  platform: "linux-installed",
  scope: "installer-target-root",
  mainExecutableRelativePath: RELEASE_SURFACE_LINUX_DEB_MAIN_EXECUTABLE,
});
if (!sameReleaseSurfaceInstalledPayloadManifest(firstManifest, secondManifest)) {
  throw new Error("Linux installed payload changed between mandatory manifest snapshots");
}
const artifactAfter = identifyRegularFile(artifactPath, "Linux Debian distribution artifact after extraction");
if (JSON.stringify(artifactAfter) !== JSON.stringify(artifact)) throw new Error("Linux Debian artifact changed before receipt creation");
const receipt: ReleaseSurfaceInstallationReceipt = {
  schema: RELEASE_SURFACE_INSTALLATION_RECEIPT_SCHEMA,
  platform: "linux-installed",
  sourceCommit,
  version,
  createdAt: new Date().toISOString(),
  method: "installer-observed",
  status: "pass",
  distributionArtifact: artifact,
  installedPayload,
  coverage: { payload: "complete-target-root", systemEffects: "declared-subset" },
  systemEffects: observation.systemEffects,
  nativeLinuxDebObservation: observation,
  signatureReceipt,
  linuxDigestVerification: parsedSignatureReceipt.nativeVerification,
  operation: {
    adapter: "linux-package-install-v1",
    orchestrator: "native",
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
    "native-linux-baseline",
    "artifact-digest-valid",
    "artifact-unchanged",
    "target-absent",
    "package-metadata-valid",
    "package-extraction-exit-zero",
    "payload-created",
    "payload-hash-recomputed",
    "manifest-double-collected",
    "system-effects-observed",
    "package-database-unchanged",
    "process-autolaunch-absent",
    "host-integration-unchanged",
  ].map((id) => ({ id, status: "pass" as const, observed: `${id} passed in the native owned-root Debian adapter` })),
};
const receiptErrors = validateReleaseSurfaceInstallationReceipt({
  receipt,
  platform: "linux-installed",
  sourceCommit,
  version,
  method: "installer-observed",
  artifact,
  installedPayload,
});
if (receiptErrors.length > 0) throw new Error(`generated Linux installation receipt is invalid: ${receiptErrors.join("; ")}`);
writeFileSync(outputPath, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
console.log(`Extracted and recorded the Linux Debian candidate: ${outputPath}`);

function identifyRegularFile(path: string, label: string) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size <= 0) throw new Error(`${label} must be a non-empty regular non-link file`);
  const bytes = readFileSync(path);
  return { basename: basename(path), sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length };
}

function assertCreateOnlyOutput(outputPath: string, targetRoot: string): void {
  if (existsSync(outputPath)) throw new Error("Linux installation receipt output already exists");
  const outputParent = lstatSync(dirname(outputPath));
  if (outputParent.isSymbolicLink() || !outputParent.isDirectory()) {
    throw new Error("Linux installation receipt parent must be a regular non-link directory");
  }
  assertNoSymlinkAncestry(dirname(outputPath), "Linux installation receipt parent");
  if (isReleaseSurfacePathInsideRoot(targetRoot, outputPath, "linux-installed")) {
    throw new Error("Linux installation receipt output must be outside the installed target root");
  }
  if (isReleaseSurfacePathInsideRoot(dirname(targetRoot), outputPath, "linux-installed")) {
    throw new Error("Linux installation receipt output must be outside the receipt-owned run root");
  }
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
