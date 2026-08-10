import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  loadReleaseSurfaceCandidateAttestation,
  validateReleaseSurfaceCandidateAttestation,
  type ReleaseSurfaceCandidateAttestation,
  type ReleaseSurfaceFileIdentity,
} from "./lib/release-surface-candidate-attestation";
import { loadFinalSurfaceDriverPlan } from "./lib/release-surface-driver-plan";
import {
  releaseSurfaceDriverRunFailedDriverIds,
  runReleaseSurfaceDrivers,
} from "./lib/release-surface-driver-runner";
import type { ReleaseSurfaceHealthEvidence } from "./lib/release-surface-health-evidence";
import {
  createReleaseSurfaceMacosInstalledInputSession,
} from "./lib/release-surface-installed-input-client";
import type { ReleaseSurfaceInventory } from "./lib/release-surface-inventory";
import {
  loadReleaseSurfaceInstallationReceipt,
  validateReleaseSurfaceInstallationReceipt,
} from "./lib/release-surface-installation-receipt";
import {
  startReleaseSurfaceMacosHealthCollector,
  type ReleaseSurfaceMacosHealthCollector,
} from "./lib/release-surface-macos-health-collector";
import {
  releaseSurfaceMacosNativeInputFileIdentity,
  validateReleaseSurfaceMacosNativeInputBinding,
  type ReleaseSurfaceMacosNativeInputBindingEvidence,
} from "./lib/release-surface-macos-native-input";
import {
  collectReleaseSurfaceProviderRouteBatch,
  loadReleaseSurfaceProviderRouteBatchPlan,
  validateReleaseSurfaceProviderRouteBatchPlan,
} from "./lib/release-surface-provider-route-batch";
import { loadFinalSurfaceContract } from "./lib/release-surface-receipts";
import {
  releaseSurfaceCandidateProcessExists,
  releaseSurfaceProfileLaunchRootFromDebugTokenPath,
  cleanupReleaseSurfaceRunProfile,
  type ReleaseSurfaceRunProfile,
} from "./lib/release-surface-run-profile";
import {
  RELEASE_SURFACE_SCENARIO_REPORT_SCHEMA,
  validateReleaseSurfaceScenarioReport,
  type ReleaseSurfaceScenarioReport,
} from "./lib/release-surface-scenario-report";
import { releaseSurfaceControllerNodeArguments } from "./lib/release-surface-controller-binding";
import {
  loadReleaseSurfaceSignatureReceipt,
  validateReleaseSurfaceSignatureReceipt,
} from "./lib/release-surface-signature-receipt";

const RELEASE_SURFACE_MACOS_CANDIDATE_PREPARATION_SCHEMA =
  "shellx/release-surface-macos-candidate-preparation@2";

export const RELEASE_SURFACE_MACOS_CANDIDATE_ORCHESTRATION_SCHEMA =
  "shellx/release-surface-macos-candidate-orchestration@1";

if (process.platform !== "darwin") {
  throw new Error("macOS candidate orchestration must run on the native Mac candidate host");
}

const root = resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const selectedDriverIds = readArgs(args, "--driver-id")
  .flatMap((value) => value.split(","))
  .map((value) => value.trim())
  .filter(Boolean);
const targetedClosure = selectedDriverIds.length > 0;
requireExecutionWindow(args, targetedClosure);
const runId = requiredArg(args, "--run-id");
const preparationPath = regularFile(requiredArg(args, "--preparation"), "candidate preparation");
const artifactPath = regularFile(requiredArg(args, "--artifact"), "distribution artifact");
const signatureReceiptPath = regularFile(requiredArg(args, "--signature-receipt"), "signature receipt");
const installationReceiptPath = regularFile(
  requiredArg(args, "--installation-receipt"),
  "installation receipt",
);
const candidatePath = regularFile(requiredArg(args, "--candidate-attestation"), "candidate attestation");
const helperPath = regularFile(requiredArg(args, "--helper"), "macOS native-input helper");
const bindingPath = createOnlyFilePath(requiredArg(args, "--macos-native-input-binding-out"), "native-input binding");
const driverOutputDir = createOnlyDirectoryPath(requiredArg(args, "--driver-out-dir"), "driver output directory");
const providerPlanPath = regularFile(requiredArg(args, "--provider-route-plan"), "provider route plan");
const providerOutputDir = emptyDirectory(requiredArg(args, "--provider-route-out-dir"), "provider route output directory");
const healthPath = createOnlyFilePath(requiredArg(args, "--health-out"), "health output");
const scenarioPath = createOnlyFilePath(requiredArg(args, "--scenario-out"), "scenario output");
const profileCleanupPath = createOnlyFilePath(requiredArg(args, "--profile-cleanup-out"), "profile cleanup output");
const candidateTeardownPath = createOnlyFilePath(requiredArg(args, "--candidate-teardown-out"), "candidate teardown output");
const orchestrationPath = createOnlyFilePath(requiredArg(args, "--orchestration-out"), "orchestration output");
if (!/^[a-f0-9]{16,64}$/.test(runId)) throw new Error("release run id must be 16 to 64 lowercase hexadecimal characters");
for (const path of [
  bindingPath,
  driverOutputDir,
  providerOutputDir,
  healthPath,
  scenarioPath,
  profileCleanupPath,
  candidateTeardownPath,
  orchestrationPath,
]) {
  if (resolve(path) === resolve(dirname(path))) throw new Error("macOS evidence path is invalid");
}
if (new Set([
  bindingPath,
  driverOutputDir,
  providerOutputDir,
  healthPath,
  scenarioPath,
  profileCleanupPath,
  candidateTeardownPath,
  orchestrationPath,
].map((path) => resolve(path))).size !== 8) {
  throw new Error("macOS durable evidence paths must be distinct");
}
if (resolve(driverOutputDir) === resolve(providerOutputDir)) {
  throw new Error("macOS driver and provider evidence directories must differ");
}

const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" });
if (dirty.trim()) throw new Error("macOS candidate orchestration requires a clean frozen source checkout");
const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const version = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string }).version;
const inventory = JSON.parse(readFileSync(join(root, "release", "surface-inventory.json"), "utf8")) as ReleaseSurfaceInventory;
const plan = loadFinalSurfaceDriverPlan(join(root, "release", "surface-driver-plan.json"));
const contract = loadFinalSurfaceContract(join(root, "release", "surface-contract.json"));
const providerPlan = loadReleaseSurfaceProviderRouteBatchPlan(providerPlanPath);
const providerPlanErrors = validateReleaseSurfaceProviderRouteBatchPlan({
  plan: providerPlan,
  contract,
  platform: "macos-installed",
});
if (providerPlanErrors.length > 0) {
  throw new Error(`invalid macOS provider route batch plan: ${providerPlanErrors.join("; ")}`);
}

const preparation = loadPreparation(preparationPath);
const candidate = loadReleaseSurfaceCandidateAttestation(candidatePath);
const candidateIdentity = fileIdentity(candidatePath);
const helperIdentity = releaseSurfaceMacosNativeInputFileIdentity(helperPath);
validateFrozenCandidateInputs({
  candidate,
  sourceCommit,
  version,
  artifactPath,
  signatureReceiptPath,
  installationReceiptPath,
  contract,
});
if (preparation.schema !== RELEASE_SURFACE_MACOS_CANDIDATE_PREPARATION_SCHEMA
  || preparation.mode !== "final-frozen-candidate"
  || preparation.status !== "pass"
  || preparation.platform !== "macos-installed"
  || preparation.runId !== runId
  || preparation.sourceCommit !== sourceCommit
  || preparation.version !== version
  || JSON.stringify(preparation.candidateAttestation) !== JSON.stringify(candidateIdentity)
  || JSON.stringify(preparation.helper) !== JSON.stringify(helperIdentity)
  || preparation.activation.method !== "system-events-frontmost-by-pid"
  || preparation.activation.processId !== candidate.process.pid
  || preparation.activation.verified !== true
  || preparation.runtime.debugPort !== candidate.runtime.debugPort
  || preparation.runtime.mcpPort !== candidate.runtime.mcpPort) {
  throw new Error("macOS candidate preparation no longer binds the frozen source, candidate, and helper");
}
if (candidate.platform !== "macos-installed"
  || candidate.sourceCommit !== sourceCommit
  || candidate.version !== version
  || candidate.process.pid !== preparation.runtime.processId) {
  throw new Error("macOS candidate attestation drifted from its preparation receipt");
}
const profileRoot = releaseSurfaceProfileLaunchRootFromDebugTokenPath(
  candidate.runtime.debugTokenPath,
  "macos-installed",
);
if (basename(profileRoot) !== `shellx-final-webdriver-${runId}`
  || sha256(profileRoot) !== preparation.runtime.profilePathSha256
  || dirname(helperPath) !== profileRoot) {
  throw new Error("macOS candidate profile or helper path drifted from the exact run id");
}
for (const output of [
  preparationPath,
  artifactPath,
  signatureReceiptPath,
  installationReceiptPath,
  candidatePath,
  providerPlanPath,
  bindingPath,
  driverOutputDir,
  providerOutputDir,
  healthPath,
  scenarioPath,
  profileCleanupPath,
  candidateTeardownPath,
  orchestrationPath,
]) {
  const fromProfile = relative(profileRoot, output);
  if (fromProfile === "" || (!fromProfile.startsWith("..") && !isAbsolute(fromProfile))) {
    throw new Error("durable macOS candidate evidence must remain outside the disposable profile");
  }
}
const markerPath = join(profileRoot, "shellx-final-profile.json");
if (JSON.stringify(fileIdentity(markerPath)) !== JSON.stringify(preparation.profileMarker)) {
  throw new Error("macOS candidate profile marker changed after preparation");
}
if (!releaseSurfaceCandidateProcessExists("macos-installed", candidate.process.pid, candidate.process.executablePath)) {
  throw new Error("prepared macOS candidate is no longer running");
}

let healthCollector: ReleaseSurfaceMacosHealthCollector | null = null;
let accessibilityBlocked = false;
let finalized = false;
try {
  const proof = spawnSync(process.execPath, releaseSurfaceControllerNodeArguments(
    resolve(root, "scripts/prove-release-surface-macos-native-input-binding.ts"), [
      "--candidate-attestation", candidatePath,
      "--helper", helperPath,
      "--out", bindingPath,
    ],
  ), { cwd: root, encoding: "utf8", timeout: 60_000, maxBuffer: 1024 * 1024 });
  if (proof.status === 3) {
    accessibilityBlocked = true;
    throw new Error((proof.stderr || proof.stdout).trim());
  }
  if (proof.status !== 0) {
    throw new Error(`macOS native-input binding failed: ${(proof.stderr || proof.stdout).trim()}`);
  }
  const binding = JSON.parse(readFileSync(bindingPath, "utf8")) as ReleaseSurfaceMacosNativeInputBindingEvidence;
  const bindingErrors = validateReleaseSurfaceMacosNativeInputBinding({
    evidence: binding,
    candidate,
    helperPath,
    helperIdentity,
  });
  if (bindingErrors.length > 0) {
    throw new Error(`macOS native-input proof is invalid: ${bindingErrors.join("; ")}`);
  }
  const bindingIdentity = fileIdentity(bindingPath);
  const token = readPrivateToken(candidate.runtime.debugTokenPath);
  const installedInput = createReleaseSurfaceMacosInstalledInputSession({
    candidate,
    helperPath,
    binding,
    bindingIdentity,
    connection: { base: candidate.runtime.debugBase, token },
  });
  healthCollector = await startReleaseSurfaceMacosHealthCollector({
    candidate,
    candidateToken: token,
    inventory,
    outputPath: healthPath,
  });
  await healthCollector.discoverRenderedLinks(installedInput);
  const manifest = runReleaseSurfaceDrivers({
    rootDir: root,
    plan,
    inventory,
    contract,
    platform: "macos-installed",
    sourceCommit,
    version,
    artifactPath,
    signatureReceiptPath,
    candidateAttestationPath: candidatePath,
    installationReceiptPath,
    outputDir: driverOutputDir,
    ...(targetedClosure ? { selectedDriverIds } : {}),
    macosNativeInput: {
      helperPath,
      bindingReceiptPath: bindingPath,
    },
  });
  const driverManifestPath = join(driverOutputDir, "run-manifest.json");
  const providerRoutes = await collectReleaseSurfaceProviderRouteBatch({
    plan: providerPlan,
    contract,
    candidate,
    token,
    outputDir: providerOutputDir,
  });
  const failedDriverIds = releaseSurfaceDriverRunFailedDriverIds(manifest, driverOutputDir);
  const shutdownRequestedAt = healthCollector.beginShutdown();
  const finalizer = spawnSync(process.execPath, releaseSurfaceControllerNodeArguments(
    resolve(root, "scripts/finalize-release-surface-macos-candidate.ts"), [
      "--run-id", runId,
      "--candidate-attestation", candidatePath,
      "--driver-manifest", driverManifestPath,
      "--macos-native-input-binding", join(driverOutputDir, "macos-native-input-binding.json"),
      "--profile-cleanup-out", profileCleanupPath,
      "--candidate-teardown-out", candidateTeardownPath,
    ],
  ), { cwd: root, encoding: "utf8", timeout: 60_000, maxBuffer: 1024 * 1024 });
  if (finalizer.status !== 0) {
    throw new Error(`macOS candidate finalization failed: ${(finalizer.stderr || finalizer.stdout).trim()}`);
  }
  const cleanup = JSON.parse(readFileSync(profileCleanupPath, "utf8")) as { completedAt?: unknown };
  if (typeof cleanup.completedAt !== "string" || Date.parse(cleanup.completedAt) < Date.parse(shutdownRequestedAt)) {
    throw new Error("macOS profile cleanup did not return a valid post-shutdown observation time");
  }
  const health = await healthCollector.finalize({
    shutdownObservedAt: cleanup.completedAt,
    mechanism: "macos-native-candidate-finalizer",
  });
  writeScenarioReport({
    path: scenarioPath,
    healthPath: health.outputPath,
    candidate,
    inventoryDigest: inventory.digest,
    providerRoutes: providerRoutes.batch.routes,
    health: health.evidence,
    scenarioStartedAt: health.scenarioStartedAt,
    contract,
  });
  const orchestration = {
    schema: RELEASE_SURFACE_MACOS_CANDIDATE_ORCHESTRATION_SCHEMA,
    mode: "final-frozen-candidate",
    status: failedDriverIds.length === 0 ? "pass" : "failed",
    platform: "macos-installed",
    runId,
    sourceCommit,
    version,
    completedAt: new Date().toISOString(),
    preparation: fileIdentity(preparationPath),
    candidateAttestation: candidateIdentity,
    nativeInputBinding: fileIdentity(bindingPath),
    driverRunManifest: fileIdentity(driverManifestPath),
    providerRouteManifest: fileIdentity(providerRoutes.manifestPath),
    health: fileIdentity(healthPath),
    scenario: fileIdentity(scenarioPath),
    profileCleanup: fileIdentity(profileCleanupPath),
    candidateTeardown: fileIdentity(candidateTeardownPath),
  } as const;
  writeFileSync(orchestrationPath, `${JSON.stringify(orchestration, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  finalized = true;
  if (failedDriverIds.length > 0) {
    throw new Error(
      `complete discovery matrix recorded failed driver sections: ${failedDriverIds.join(", ")}`,
    );
  }
  console.log(
    `Final macOS candidate passed ${manifest.driverReports.reduce((sum, report) => sum + report.outcomes, 0)} `
    + `exact surfaces and ${providerRoutes.batch.routes.length} provider routes: ${orchestrationPath}`,
  );
} finally {
  if (!finalized) {
    healthCollector?.abort();
    if (!accessibilityBlocked && existsSync(profileRoot)) {
      const failureCleanupPath = nextAvailableFailurePath(
        dirname(orchestrationPath),
        `macos-run-failure-cleanup-${runId}`,
      );
      await cleanupReleaseSurfaceRunProfile({
        profile: reconstructedProfile(candidate, runId, profileRoot),
        evidencePath: failureCleanupPath,
        application: {
          processId: candidate.process.pid,
          executableNodePath: candidate.process.executablePath,
          executableLaunchPath: candidate.process.executablePath,
        },
      }).catch(() => undefined);
    }
  }
}

function reconstructedProfile(
  candidate: ReleaseSurfaceCandidateAttestation,
  runId: string,
  profileRoot: string,
): ReleaseSurfaceRunProfile {
  return {
    schema: "shellx/release-surface-run-profile@1",
    platform: "macos-installed",
    runId,
    nodePath: profileRoot,
    launchPath: profileRoot,
    markerPath: join(profileRoot, "shellx-final-profile.json"),
    debugBase: candidate.runtime.debugBase,
    debugPort: candidate.runtime.debugPort,
    mcpBase: candidate.runtime.mcpBase,
    mcpPort: candidate.runtime.mcpPort,
    debugTokenNodePath: candidate.runtime.debugTokenPath,
    debugTokenLaunchPath: candidate.runtime.debugTokenPath,
    mcpTokenNodePath: candidate.runtime.mcpTokenPath,
    mcpTokenLaunchPath: candidate.runtime.mcpTokenPath,
    environment: {},
  };
}

function writeScenarioReport(input: {
  path: string;
  healthPath: string;
  candidate: ReleaseSurfaceCandidateAttestation;
  inventoryDigest: string;
  providerRoutes: ReleaseSurfaceScenarioReport["providerRoutes"];
  health: ReleaseSurfaceHealthEvidence;
  scenarioStartedAt: string;
  contract: ReturnType<typeof loadFinalSurfaceContract>;
}): void {
  const healthIdentity = fileIdentity(input.healthPath);
  const report: ReleaseSurfaceScenarioReport = {
    schema: RELEASE_SURFACE_SCENARIO_REPORT_SCHEMA,
    mode: "final-frozen-candidate",
    platform: input.candidate.platform,
    sourceCommit: input.candidate.sourceCommit,
    version: input.candidate.version,
    inventoryDigest: input.inventoryDigest,
    artifactSha256: input.candidate.distributionArtifact.sha256,
    startedAt: input.scenarioStartedAt,
    completedAt: input.health.shutdown.observedAt,
    providerRoutes: input.providerRoutes,
    health: {
      startup: "pass",
      shutdown: "pass",
      brokenLinks: input.health.links.brokenLinks,
      unexpectedConsoleErrors: input.health.console.unexpectedConsoleErrors,
      observed: "Exact macOS startup identity, native rendered-link inventory, renderer-error stream, and candidate PID shutdown were observed.",
      evidence: healthIdentity,
    },
  };
  const errors = validateReleaseSurfaceScenarioReport({
    report,
    contract: input.contract,
    platform: input.candidate.platform,
    sourceCommit: input.candidate.sourceCommit,
    version: input.candidate.version,
    inventoryDigest: input.inventoryDigest,
    artifactSha256: input.candidate.distributionArtifact.sha256,
  });
  if (errors.length > 0) throw new Error(`collected macOS scenario report is invalid: ${errors.join("; ")}`);
  writeFileSync(input.path, `${JSON.stringify(report, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
}

interface MacosPreparation {
  schema: string;
  mode: string;
  status: string;
  platform: string;
  runId: string;
  sourceCommit: string;
  version: string;
  candidateAttestation: ReleaseSurfaceFileIdentity;
  helper: ReleaseSurfaceFileIdentity;
  profileMarker: ReleaseSurfaceFileIdentity;
  activation: {
    method: "system-events-frontmost-by-pid";
    processId: number;
    verified: boolean;
  };
  runtime: {
    processId: number;
    debugPort: number;
    mcpPort: number;
    profilePathSha256: string;
  };
}

function validateFrozenCandidateInputs(input: {
  candidate: ReleaseSurfaceCandidateAttestation;
  sourceCommit: string;
  version: string;
  artifactPath: string;
  signatureReceiptPath: string;
  installationReceiptPath: string;
  contract: ReturnType<typeof loadFinalSurfaceContract>;
}): void {
  const platform = "macos-installed" as const;
  const artifact = fileIdentity(input.artifactPath);
  const signatureReceiptIdentity = fileIdentity(input.signatureReceiptPath);
  const installationReceiptIdentity = fileIdentity(input.installationReceiptPath);
  const platformContract = input.contract.platforms[platform];
  if (!platformContract) throw new Error("macOS is absent from the final surface contract");
  const signature = loadReleaseSurfaceSignatureReceipt(input.signatureReceiptPath);
  const signatureErrors = validateReleaseSurfaceSignatureReceipt({
    receipt: signature,
    platform,
    sourceCommit: input.sourceCommit,
    version: input.version,
    artifact,
    expectedStatus: platformContract.signatureStatus,
    requiredChecks: platformContract.requiredSignatureChecks,
  });
  if (signatureErrors.length > 0) {
    throw new Error(`macOS candidate signature receipt is invalid: ${signatureErrors.join("; ")}`);
  }
  const candidateErrors = validateReleaseSurfaceCandidateAttestation({
    attestation: input.candidate,
    platform,
    sourceCommit: input.sourceCommit,
    version: input.version,
    artifact,
    installationReceipt: installationReceiptIdentity,
  });
  if (candidateErrors.length > 0) {
    throw new Error(`macOS candidate attestation is invalid: ${candidateErrors.join("; ")}`);
  }
  const installation = loadReleaseSurfaceInstallationReceipt(input.installationReceiptPath);
  const installationErrors = validateReleaseSurfaceInstallationReceipt({
    receipt: installation,
    platform,
    sourceCommit: input.sourceCommit,
    version: input.version,
    method: input.candidate.installation.method,
    artifact,
    installedPayload: input.candidate.installedPayload,
  });
  if (installationErrors.length > 0) {
    throw new Error(`macOS candidate installation receipt is invalid: ${installationErrors.join("; ")}`);
  }
  if (installation.signatureReceipt
    && (installation.signatureReceipt.basename !== signatureReceiptIdentity.basename
      || installation.signatureReceipt.sha256 !== signatureReceiptIdentity.sha256
      || installation.signatureReceipt.bytes !== signatureReceiptIdentity.bytes)) {
    throw new Error("macOS installation receipt is not bound to the exact signature receipt file");
  }
  if (input.candidate.installation.payloadManifestSha256
    !== installation.payloadManifest.manifestSha256) {
    throw new Error("macOS candidate payload manifest digest does not match installation receipt");
  }
}

function loadPreparation(path: string): MacosPreparation {
  return JSON.parse(readFileSync(path, "utf8")) as MacosPreparation;
}

function readPrivateToken(path: string): string {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("candidate token must be a regular non-link file");
  const token = readFileSync(path, "utf8").trim();
  if (token.length < 32) throw new Error("candidate token is invalid");
  return token;
}

function fileIdentity(path: string): ReleaseSurfaceFileIdentity {
  const contents = readFileSync(path);
  if (contents.length === 0) throw new Error(`evidence file is empty: ${path}`);
  return { basename: basename(path), sha256: sha256(contents), bytes: contents.length };
}

function regularFile(path: string, label: string): string {
  const absolute = resolve(path);
  const stat = lstatSync(absolute);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size <= 0) {
    throw new Error(`${label} must be a non-empty regular non-link file`);
  }
  return absolute;
}

function createOnlyFilePath(path: string, label: string): string {
  const absolute = resolve(path);
  if (existsSync(absolute)) throw new Error(`${label} already exists`);
  const parent = lstatSync(dirname(absolute));
  if (parent.isSymbolicLink() || !parent.isDirectory()) {
    throw new Error(`${label} parent must be a regular non-link directory`);
  }
  return absolute;
}

function createOnlyDirectoryPath(path: string, label: string): string {
  const absolute = resolve(path);
  if (existsSync(absolute)) throw new Error(`${label} already exists`);
  const parent = lstatSync(dirname(absolute));
  if (parent.isSymbolicLink() || !parent.isDirectory()) {
    throw new Error(`${label} parent must be a regular non-link directory`);
  }
  return absolute;
}

function nextAvailableFailurePath(parent: string, stem: string): string {
  for (let index = 1; index <= 1_000; index += 1) {
    const candidate = join(parent, `${stem}-${index}.json`);
    if (!existsSync(candidate)) return candidate;
  }
  throw new Error(`unable to allocate bounded failure evidence path for ${stem}`);
}

function emptyDirectory(path: string, label: string): string {
  const absolute = resolve(path);
  const stat = lstatSync(absolute);
  if (stat.isSymbolicLink() || !stat.isDirectory() || readdirSync(absolute).length !== 0) {
    throw new Error(`${label} must be an empty regular non-link directory`);
  }
  return absolute;
}

function requireExecutionWindow(values: string[], targetedClosure: boolean): void {
  const expectedExecutionWindow = targetedClosure
    ? "targeted-post-matrix"
    : "immediately-before-publish";
  if (readArg(values, "--candidate-stage") !== "signed-and-frozen"
    || readArg(values, "--execution-window") !== expectedExecutionWindow) {
    throw new Error(
      targetedClosure
        ? "refusing targeted execution: pass --candidate-stage signed-and-frozen "
          + "--execution-window targeted-post-matrix with one or more --driver-id values"
        : "refusing routine execution: pass --candidate-stage signed-and-frozen "
          + "--execution-window immediately-before-publish for the final candidate only",
    );
  }
}

function requiredArg(values: string[], name: string): string {
  const value = readArg(values, name)?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function readArg(values: string[], name: string): string | undefined {
  const index = values.indexOf(name);
  if (index >= 0) return values[index + 1];
  return values.find((value) => value.startsWith(`${name}=`))?.slice(name.length + 1);
}

function readArgs(values: string[], name: string): string[] {
  const prefix = `${name}=`;
  return values.flatMap((value, index) => {
    if (value === name) return values[index + 1] ? [values[index + 1]!] : [];
    return value.startsWith(prefix) ? [value.slice(prefix.length)] : [];
  });
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
