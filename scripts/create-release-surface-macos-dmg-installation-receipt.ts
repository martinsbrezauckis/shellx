import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
  RELEASE_SURFACE_INSTALLATION_RECEIPT_SCHEMA,
  validateReleaseSurfaceInstallationReceipt,
  type ReleaseSurfaceInstallationReceipt,
  type ReleaseSurfaceInstallationSystemEffect,
} from "./lib/release-surface-installation-receipt";
import {
  collectReleaseSurfaceInstalledPayloadManifest,
  isReleaseSurfacePathInsideRoot,
  sameReleaseSurfaceInstalledPayloadManifest,
} from "./lib/release-surface-installed-payload-manifest";
import {
  RELEASE_SURFACE_MACOS_DMG_INSTALLATION_SCHEMA,
  releaseSurfaceMacosPayloadTreeDigest,
  validateReleaseSurfaceMacosDmgInstallationObservation,
  type ReleaseSurfaceMacosDmgInstallationObservation,
} from "./lib/release-surface-macos-dmg-installation";
import {
  assertCanonicalMacosAbsolutePath,
  assertReleaseSurfaceNoSymlinkAncestry,
  assertReleaseSurfacePathInsidePrivateRoot,
  detachReleaseSurfaceMacosMountedImage,
  identifyReleaseSurfaceRegularFile,
  parseReleaseSurfaceGatekeeperAssessment,
  parseReleaseSurfaceHdiutilAttachJson,
} from "./lib/release-surface-macos-native";
import {
  RELEASE_SURFACE_MACOS_APP_BASENAME,
  loadReleaseSurfaceSignatureReceipt,
  validateReleaseSurfaceSignatureReceipt,
} from "./lib/release-surface-signature-receipt";

const root = resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
if (process.platform !== "darwin") throw new Error("macOS DMG installation requires a native macOS host");
const artifactInput = requiredArg(args, "--artifact");
const targetInput = requiredArg(args, "--target-app");
assertCanonicalMacosAbsolutePath(artifactInput, "--artifact");
assertCanonicalMacosAbsolutePath(targetInput, "--target-app");
const artifactPath = resolve(artifactInput);
const targetApp = resolve(targetInput);
const signatureReceiptPath = resolve(requiredArg(args, "--signature-receipt"));
const outputPath = resolve(requiredArg(args, "--out"));
assertRunOwnedTarget(targetApp);
if (existsSync(targetApp)) throw new Error("macOS DMG installation target must be absent");
if (existsSync(outputPath)) throw new Error("macOS DMG installation receipt output already exists");
for (const [path, label] of [
  [artifactPath, "macOS distribution artifact"],
  [signatureReceiptPath, "macOS signature receipt"],
  [dirname(targetApp), "macOS release-evidence target parent"],
  [dirname(outputPath), "macOS installation receipt output parent"],
] as const) assertReleaseSurfaceNoSymlinkAncestry(path, label);
const outputParent = lstatSync(dirname(outputPath));
if (outputParent.isSymbolicLink() || !outputParent.isDirectory()) {
  throw new Error("macOS installation receipt output parent must be a regular non-link directory");
}
if (isReleaseSurfacePathInsideRoot(targetApp, outputPath, "macos-installed")) {
  throw new Error("macOS installation receipt output must be outside the installed application target");
}
const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" });
if (dirty.trim()) throw new Error("macOS DMG installation requires a clean frozen source checkout");
const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const version = (JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as { version: string }).version;
const artifact = identifyReleaseSurfaceRegularFile(artifactPath, "signed macOS distribution DMG");
const signatureReceiptIdentity = identifyReleaseSurfaceRegularFile(signatureReceiptPath, "macOS signature receipt");
const contract = JSON.parse(readFileSync(resolve(root, "release", "surface-contract.json"), "utf8")) as {
  platforms: Record<string, { signatureStatus: "verified" | "digest-verified"; requiredSignatureChecks: string[] }>;
};
const macosContract = contract.platforms["macos-installed"];
if (!macosContract) throw new Error("final surface contract has no macOS signing policy");
const parsedSignatureReceipt = loadReleaseSurfaceSignatureReceipt(signatureReceiptPath);
const signatureErrors = validateReleaseSurfaceSignatureReceipt({
  receipt: parsedSignatureReceipt,
  platform: "macos-installed",
  sourceCommit,
  version,
  artifact,
  expectedStatus: macosContract.signatureStatus,
  requiredChecks: macosContract.requiredSignatureChecks,
});
if (signatureErrors.length > 0) throw new Error(`macOS signature receipt is invalid: ${signatureErrors.join("; ")}`);
if (parsedSignatureReceipt.nativeVerification.kind !== "macos-codesign") {
  throw new Error("macOS signature receipt does not contain structured Developer ID evidence");
}

const processesBefore = collectShellxProcessIds();
if (processesBefore.length !== 0) throw new Error("no shellX application process may exist before DMG installation");
const mountRoot = mkdtempSync(join(tmpdir(), "shellx-final-install-image-"));
let mounted: ReturnType<typeof parseReleaseSurfaceHdiutilAttachJson> | undefined;
let detachedAt = "";
let observation: ReleaseSurfaceMacosDmgInstallationObservation | undefined;
let operationError: unknown;
try {
  const startedAt = new Date().toISOString();
  const attach = run("/usr/bin/hdiutil", [
    "attach", artifactPath, "-readonly", "-nobrowse", "-noautoopen", "-mountroot", mountRoot, "-plist",
  ], "read-only DMG attach", 2 * 60_000);
  const plist = run("/usr/bin/plutil", ["-convert", "json", "-o", "-", "-"],
    "hdiutil property-list conversion", 30_000, attach.stdout);
  mounted = parseReleaseSurfaceHdiutilAttachJson(JSON.parse(plist.stdout) as unknown);
  assertReleaseSurfacePathInsidePrivateRoot(mountRoot, mounted.mountPoint, "DMG mount point");
  const sourceApp = resolveSourceApplication(mounted.mountPoint);
  const sourceExecutableRelativePath = parsedSignatureReceipt.nativeVerification.application.executableRelativePath;
  const targetExecutableRelativePath = sourceExecutableRelativePath.replace(`${RELEASE_SURFACE_MACOS_APP_BASENAME}/`, "");
  const sourceExecutablePath = join(mounted.mountPoint, ...sourceExecutableRelativePath.split("/"));
  const sourceExecutable = identifyReleaseSurfaceRegularFile(sourceExecutablePath, "mounted ShellX main executable");
  if (!sameIdentity(sourceExecutable, parsedSignatureReceipt.nativeVerification.application.executable)) {
    throw new Error("mounted DMG application executable does not match the approved signature receipt");
  }
  const sourceManifest = collectReleaseSurfaceInstalledPayloadManifest({
    nodeRootPath: sourceApp,
    recordedRootPath: sourceApp,
    platform: "macos-installed",
    scope: "installer-target-root",
    mainExecutableRelativePath: targetExecutableRelativePath,
  });
  if (existsSync(targetApp)) throw new Error("macOS DMG target appeared before exclusive creation");
  mkdirSync(targetApp, { recursive: false, mode: 0o700 });
  run("/usr/bin/ditto", [sourceApp, targetApp], "copy-only ShellX application install", 5 * 60_000);
  const targetStat = lstatSync(targetApp);
  if (targetStat.isSymbolicLink() || !targetStat.isDirectory() || targetStat.uid !== process.getuid!()) {
    throw new Error("copied macOS application target must be a user-owned regular non-link directory");
  }
  const targetExecutablePath = join(targetApp, ...targetExecutableRelativePath.split("/"));
  const targetExecutable = identifyReleaseSurfaceRegularFile(targetExecutablePath, "copied ShellX main executable");
  if (!sameIdentity(targetExecutable, sourceExecutable)) {
    throw new Error("copied ShellX executable does not match the mounted DMG executable");
  }
  run("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--all-architectures", "--verbose=4", targetApp],
    "copied application signature verification", 2 * 60_000);
  const gatekeeperResult = run("/usr/sbin/spctl", ["--assess", "--type", "execute", "--verbose=4", targetApp],
    "copied application Gatekeeper assessment", 2 * 60_000);
  parseReleaseSurfaceGatekeeperAssessment(`${gatekeeperResult.stdout}\n${gatekeeperResult.stderr}`);
  const targetManifest = collectReleaseSurfaceInstalledPayloadManifest({
    nodeRootPath: targetApp,
    recordedRootPath: targetApp,
    platform: "macos-installed",
    scope: "installer-target-root",
    mainExecutableRelativePath: targetExecutableRelativePath,
  });
  const sourceTreeSha256 = releaseSurfaceMacosPayloadTreeDigest(sourceManifest);
  const targetTreeSha256 = releaseSurfaceMacosPayloadTreeDigest(targetManifest);
  if (sourceTreeSha256 !== targetTreeSha256 || sourceManifest.entryCount !== targetManifest.entryCount
    || sourceManifest.totalFileBytes !== targetManifest.totalFileBytes) {
    throw new Error("copied application does not match the complete mounted application manifest");
  }
  const processesAfter = collectShellxProcessIds();
  if (processesAfter.length !== 0) throw new Error("DMG copy unexpectedly launched a shellX application process");
  const systemEffects = createSystemEffects(targetApp, mounted.deviceEntry);
  observation = {
    schema: RELEASE_SURFACE_MACOS_DMG_INSTALLATION_SCHEMA,
    collector: "macos-native-dmg-install-v1",
    artifact: { ...artifact, path: artifactPath },
    operation: {
      startedAt,
      completedAt: "pending-detach",
      exitCode: 0,
      targetRootStateBefore: "absent",
      arguments: ["attach-readonly-nobrowse-noautoopen", "ditto-copy-without-launch", "detach-exact-device"],
    },
    mountedImage: {
      ...mounted,
      detachedAt: "pending-detach",
      readOnly: true,
      noBrowse: true,
      noAutoOpen: true,
      detached: true,
      sourceApplicationRelativePath: RELEASE_SURFACE_MACOS_APP_BASENAME,
    },
    sourceApplication: {
      executableRelativePath: sourceExecutableRelativePath,
      executable: sourceExecutable,
      payloadTreeSha256: sourceTreeSha256,
      entryCount: sourceManifest.entryCount,
      totalFileBytes: sourceManifest.totalFileBytes,
    },
    targetApplication: {
      path: targetApp,
      stateBefore: "absent",
      createdWithoutOverwrite: true,
      ownerUid: targetStat.uid,
      executableRelativePath: targetExecutableRelativePath,
      executable: targetExecutable,
      payloadTreeSha256: targetTreeSha256,
      entryCount: targetManifest.entryCount,
      totalFileBytes: targetManifest.totalFileBytes,
      codesignVerified: true,
      gatekeeperAccepted: true,
    },
    safety: { shellxProcessIdsBefore: [], shellxProcessIdsAfter: [], launchRequested: false },
    systemEffects,
  };
} catch (error) {
  operationError = error;
  throw error;
} finally {
  try {
    detachedAt = detachReleaseSurfaceMacosMountedImage({ mountRoot, mounted });
  } catch (detachError) {
    if (operationError) {
      throw new AggregateError([operationError, detachError], "macOS DMG install failed and its private image mount could not be detached");
    }
    throw detachError;
  }
}
if (!observation || !detachedAt) throw new Error("macOS DMG installation did not complete its exact detach lifecycle");
observation.mountedImage.detachedAt = detachedAt;
observation.operation.completedAt = detachedAt;
const artifactAfter = identifyReleaseSurfaceRegularFile(artifactPath, "macOS distribution DMG after installation");
if (!sameIdentity(artifactAfter, artifact)) throw new Error("macOS distribution DMG changed during installation");
const firstManifest = collectReleaseSurfaceInstalledPayloadManifest({
  nodeRootPath: targetApp,
  recordedRootPath: targetApp,
  platform: "macos-installed",
  scope: "installer-target-root",
  mainExecutableRelativePath: observation.targetApplication.executableRelativePath,
});
const secondManifest = collectReleaseSurfaceInstalledPayloadManifest({
  nodeRootPath: targetApp,
  recordedRootPath: targetApp,
  platform: "macos-installed",
  scope: "installer-target-root",
  mainExecutableRelativePath: observation.targetApplication.executableRelativePath,
});
if (!sameReleaseSurfaceInstalledPayloadManifest(firstManifest, secondManifest)
  || releaseSurfaceMacosPayloadTreeDigest(secondManifest) !== observation.targetApplication.payloadTreeSha256) {
  throw new Error("macOS installed application changed between mandatory complete manifest snapshots");
}
const installedPayload = {
  ...identifyReleaseSurfaceRegularFile(
    join(targetApp, ...secondManifest.mainExecutableRelativePath.split("/")),
    "installed ShellX executable",
  ),
  path: join(targetApp, ...secondManifest.mainExecutableRelativePath.split("/")),
};
const receipt: ReleaseSurfaceInstallationReceipt = {
  schema: RELEASE_SURFACE_INSTALLATION_RECEIPT_SCHEMA,
  platform: "macos-installed",
  sourceCommit,
  version,
  createdAt: new Date().toISOString(),
  method: "installer-observed",
  status: "pass",
  distributionArtifact: artifact,
  installedPayload,
  coverage: { payload: "complete-target-root", systemEffects: "declared-subset" },
  systemEffects: observation.systemEffects,
  nativeMacosDmgObservation: observation,
  signatureReceipt: signatureReceiptIdentity,
  macosSignatureVerification: parsedSignatureReceipt.nativeVerification,
  operation: {
    adapter: "macos-dmg-install-v1",
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
    "artifact-signature-valid", "artifact-unchanged", "target-absent", "image-mounted-readonly",
    "app-copied-without-overwrite", "payload-hash-recomputed", "manifest-double-collected",
    "system-effects-observed", "process-autolaunch-absent", "image-detached",
  ].map((id) => ({ id, status: "pass" as const, observed: `${id} passed in the native copy-only macOS DMG adapter` })),
};
const observationErrors = validateReleaseSurfaceMacosDmgInstallationObservation({
  observation,
  artifact,
  artifactPath,
  targetApp,
  approvedSignature: parsedSignatureReceipt.nativeVerification,
  targetManifest: secondManifest,
});
if (observationErrors.length > 0) throw new Error(`macOS DMG observation is invalid: ${observationErrors.join("; ")}`);
const receiptErrors = validateReleaseSurfaceInstallationReceipt({
  receipt,
  platform: "macos-installed",
  sourceCommit,
  version,
  method: "installer-observed",
  artifact,
  installedPayload,
});
if (receiptErrors.length > 0) throw new Error(`generated macOS installation receipt is invalid: ${receiptErrors.join("; ")}`);
writeFileSync(outputPath, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
console.log(`Installed and recorded the macOS DMG candidate: ${outputPath}`);

function assertRunOwnedTarget(path: string): void {
  const expectedParent = join(homedir(), "Library", "Application Support", "ShellXReleaseEvidence");
  if (dirname(path) !== expectedParent || !/^shellx-final-install-[A-Za-z0-9._-]+\.app$/.test(basename(path))) {
    throw new Error("--target-app must be one run-owned shellx-final-install-*.app in ~/Library/Application Support/ShellXReleaseEvidence");
  }
  const parent = lstatSync(expectedParent);
  if (parent.isSymbolicLink() || !parent.isDirectory() || parent.uid !== process.getuid!()) {
    throw new Error("macOS release-evidence target parent must be a user-owned regular non-link directory");
  }
}

function resolveSourceApplication(mountPoint: string): string {
  const apps = readdirSync(mountPoint).filter((name) => name.endsWith(".app"));
  if (apps.length !== 1 || apps[0] !== RELEASE_SURFACE_MACOS_APP_BASENAME) {
    throw new Error(`mounted DMG must contain exactly one top-level ${RELEASE_SURFACE_MACOS_APP_BASENAME}`);
  }
  const path = join(mountPoint, apps[0]);
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("mounted ShellX app must be a regular non-link directory");
  return path;
}

function createSystemEffects(targetAppPath: string, deviceEntry: string): ReleaseSurfaceInstallationSystemEffect[] {
  return [
    {
      id: "macos-app-bundle-copy",
      status: "pass",
      observed: "ditto copied the complete mounted shellX.app into one exclusively created run-owned target",
      details: { sourceApp: RELEASE_SURFACE_MACOS_APP_BASENAME, targetApp: targetAppPath, copyTool: "/usr/bin/ditto", overwriteAllowed: false },
    },
    {
      id: "macos-disk-image-lifecycle",
      status: "pass",
      observed: "the exact DMG device was mounted read-only without browsing or auto-open and then detached",
      details: { deviceEntry, readOnly: true, detached: true },
    },
    {
      id: "macos-autolaunch-suppressed",
      status: "pass",
      observed: "the adapter never requested launch and observed zero shellX processes before and after copy",
      details: { launchRequested: false, processesBefore: 0, processesAfter: 0 },
    },
  ];
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

function run(command: string, commandArgs: string[], label: string, timeout: number, input?: string) {
  const result = spawnSync(command, commandArgs, { encoding: "utf8", timeout, maxBuffer: 32 * 1024 * 1024, input });
  if (result.error) throw new Error(`${label} could not start: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${label} failed: ${(result.stderr || result.stdout || `exit ${result.status}`).trim()}`);
  return { stdout: result.stdout, stderr: result.stderr };
}

function sameIdentity(left: { basename: string; sha256: string; bytes: number }, right: { basename: string; sha256: string; bytes: number }): boolean {
  return left.basename === right.basename && left.sha256 === right.sha256 && left.bytes === right.bytes;
}

function requiredArg(values: string[], name: string): string {
  const index = values.indexOf(name);
  const value = index >= 0 ? values[index + 1] : values.find((entry) => entry.startsWith(`${name}=`))?.slice(name.length + 1);
  if (!value?.trim()) throw new Error(`${name} is required`);
  return value;
}
