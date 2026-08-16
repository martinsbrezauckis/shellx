import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, lstatSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import type { ReleasePlatform, ReleaseSurfaceInventory } from "./lib/release-surface-inventory";
import { ensureEdgeDriver, installedMicrosoftEdgeVersion } from "./edge-webdriver";
import { loadReleaseSurfaceCandidateAttestation } from "./lib/release-surface-candidate-attestation";
import { loadFinalSurfaceDriverPlan } from "./lib/release-surface-driver-plan";
import {
  releaseSurfaceDriverRunFailedDriverIds,
  runReleaseSurfaceDrivers,
} from "./lib/release-surface-driver-runner";
import { startReleaseSurfaceHealthCollector } from "./lib/release-surface-health-collector";
import type { ReleaseSurfaceHealthEvidence } from "./lib/release-surface-health-evidence";
import {
  collectReleaseSurfaceProviderRouteBatch,
  loadReleaseSurfaceProviderRouteBatchPlan,
  validateReleaseSurfaceProviderRouteBatchPlan,
} from "./lib/release-surface-provider-route-batch";
import { loadFinalSurfaceContract } from "./lib/release-surface-receipts";
import {
  RELEASE_SURFACE_SCENARIO_REPORT_SCHEMA,
  validateReleaseSurfaceScenarioReport,
  type ReleaseSurfaceScenarioReport,
} from "./lib/release-surface-scenario-report";
import { withReleaseSurfaceWebDriverOrchestration } from "./lib/release-surface-webdriver-orchestration";
import { releaseSurfaceCandidateProcessExists } from "./lib/release-surface-run-profile";
import {
  validateCreateOnlyEvidenceDirectory,
  validateDirectEvidenceOutputs,
} from "./lib/release-surface-evidence-paths";
import {
  releaseSurfaceControllerNodeArguments,
} from "./lib/release-surface-controller-binding";

const root = resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const selectedDriverIds = readArgs(args, "--driver-id")
  .flatMap((value) => value.split(","))
  .map((value) => value.trim())
  .filter(Boolean);
const selectedSurfaceIds = readArgs(args, "--surface-id")
  .flatMap((value) => value.split(","))
  .map((value) => value.trim())
  .filter(Boolean);
if (selectedSurfaceIds.length > 0 && selectedDriverIds.length === 0) {
  throw new Error("--surface-id requires one or more exact --driver-id values");
}
const targetedClosure = selectedDriverIds.length > 0 || selectedSurfaceIds.length > 0;
const collectScenario = args.includes("--collect-scenario");
if (collectScenario && !targetedClosure) {
  throw new Error("--collect-scenario is valid only for a targeted post-matrix closure");
}
const expectedExecutionWindow = targetedClosure
  ? "targeted-post-matrix"
  : "immediately-before-publish";
if (readArg(args, "--candidate-stage") !== "signed-and-frozen"
  || readArg(args, "--execution-window") !== expectedExecutionWindow) {
  throw new Error(
    targetedClosure
      ? "refusing targeted execution: pass --candidate-stage signed-and-frozen "
        + "--execution-window targeted-post-matrix with one or more --driver-id values"
      : "refusing routine execution: pass --candidate-stage signed-and-frozen "
        + "--execution-window immediately-before-publish for the final candidate only",
  );
}
const platform = requiredArg(args, "--platform") as ReleasePlatform;
if (platform !== "windows-installed" && platform !== "linux-installed") {
  throw new Error("external WebDriver orchestration supports only windows-installed or linux-installed");
}
assertLinuxDisplayAuthority(platform);
const runId = requiredArg(args, "--run-id");
const artifactPath = requiredArg(args, "--artifact");
const signatureReceiptPath = requiredArg(args, "--signature-receipt");
const installationReceiptPath = requiredArg(args, "--installation-receipt");
const applicationLaunchPath = requiredArg(args, "--application-launch");
const applicationNodePath = requiredArg(args, "--application-node");
const tauriDriverCommand = requiredArg(args, "--tauri-driver");
const tauriDriverNodePath = readArg(args, "--tauri-driver-node") ?? tauriDriverCommand;
const nativeDriverLaunchPath = readArg(args, "--native-driver");
const nativeDriverNodePath = readArg(args, "--native-driver-node");
if (Boolean(nativeDriverLaunchPath) !== Boolean(nativeDriverNodePath)) {
  throw new Error("--native-driver and --native-driver-node must be supplied together");
}
if (platform === "windows-installed" && !nativeDriverLaunchPath) {
  throw new Error("Windows external WebDriver orchestration requires an exact native Edge driver");
}
if (platform === "windows-installed") {
  const browserVersion = installedMicrosoftEdgeVersion();
  ensureEdgeDriver({
    autoInstall: false,
    browserVersion,
    cachePath: nativeDriverLaunchPath!,
    configuredPath: nativeDriverLaunchPath!,
  });
}
const profileNodePath = requiredArg(args, "--profile-node");
const profileLaunchPath = requiredArg(args, "--profile-launch");
const candidateAttestationPath = requiredArg(args, "--candidate-attestation-out");
const driverOutputDir = requiredArg(args, "--driver-out-dir");
const lifecycleEvidencePath = requiredArg(args, "--lifecycle-out");
const profileCleanupEvidencePath = requiredArg(args, "--profile-cleanup-out");
const candidateTeardownEvidencePath = requiredArg(args, "--candidate-teardown-out");
const orchestrationEvidencePath = requiredArg(args, "--orchestration-out");
const providerRoutePlanPath = requiredArg(args, "--provider-route-plan");
const providerRouteOutputDir = requiredArg(args, "--provider-route-out-dir");
const healthEvidencePath = requiredArg(args, "--health-out");
const scenarioReportPath = requiredArg(args, "--scenario-out");
const debugPort = requiredPort(args, "--debug-port");
const mcpPort = requiredPort(args, "--mcp-port");
const driverPort = requiredPort(args, "--driver-port");
const nativePort = requiredPort(args, "--native-port");
const healthPort = requiredPort(args, "--health-port");
if (new Set([debugPort, mcpPort, driverPort, nativePort, healthPort]).size !== 5) {
  throw new Error("Debug API, MCP, WebDriver, native-driver, and health collector ports must all be distinct");
}

const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" });
if (dirty.trim()) throw new Error("frozen-candidate orchestration requires a clean source checkout");
const controllerSourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const candidateSourceCommitArg = readArg(args, "--candidate-source-commit");
if (candidateSourceCommitArg && !targetedClosure) {
  throw new Error("--candidate-source-commit is valid only for targeted post-matrix closure");
}
const sourceCommit = candidateSourceCommitArg ?? controllerSourceCommit;
if (!/^[a-f0-9]{40,64}$/.test(sourceCommit)) {
  throw new Error("candidate source commit must be a lowercase Git object id");
}
const version = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string }).version;
const inventory = JSON.parse(readFileSync(join(root, "release", "surface-inventory.json"), "utf8")) as ReleaseSurfaceInventory;
const plan = loadFinalSurfaceDriverPlan(join(root, "release", "surface-driver-plan.json"));
const contract = loadFinalSurfaceContract(join(root, "release", "surface-contract.json"));
const providerRoutePlan = loadReleaseSurfaceProviderRouteBatchPlan(providerRoutePlanPath);
const providerRoutePlanErrors = validateReleaseSurfaceProviderRouteBatchPlan({
  plan: providerRoutePlan,
  contract,
  platform,
});
if ((!targetedClosure || collectScenario) && providerRoutePlanErrors.length > 0) {
  throw new Error(`invalid provider route batch plan: ${providerRoutePlanErrors.join("; ")}`);
}
validateProviderRouteOutputs(providerRouteOutputDir, providerRoutePlan.routes, profileNodePath, driverOutputDir);
validateCreateOnlyEvidenceDirectory({
  outputDir: driverOutputDir,
  profilePath: profileNodePath,
  label: "release driver output",
});
validateDirectEvidenceOutputs({
  profilePath: profileNodePath,
  paths: [
    candidateAttestationPath,
    lifecycleEvidencePath,
    profileCleanupEvidencePath,
    candidateTeardownEvidencePath,
    orchestrationEvidencePath,
    healthEvidencePath,
    scenarioReportPath,
    join(resolve(providerRouteOutputDir), "run-manifest.json"),
    ...providerRoutePlan.routes.map((route) => join(
      resolve(providerRouteOutputDir),
      `${route.providerId}--${route.transportId}.json`,
    )),
  ],
});

const result = await withReleaseSurfaceWebDriverOrchestration({
  platform,
  runId,
  profileNodePath,
  profileLaunchPath,
  debugPort,
  mcpPort,
  lifecycle: {
    tauriDriverCommand,
    tauriDriverNodePath,
    applicationLaunchPath,
    applicationNodePath,
    ...(nativeDriverLaunchPath && nativeDriverNodePath
      ? { nativeDriverLaunchPath, nativeDriverNodePath }
      : {}),
    driverPort,
    nativePort,
    evidencePath: lifecycleEvidencePath,
  },
  profileCleanupEvidencePath,
  candidateTeardownEvidencePath,
  orchestrationEvidencePath,
  requireProviderRouteBatch: !targetedClosure || collectScenario,
  requireHealthEvidence: !targetedClosure || collectScenario,
  targetedClosure,
}, async (session, context) => {
  const runtime = await waitForCandidateRuntime({
    debugBase: context.profile.debugBase,
    debugTokenNodePath: context.profile.debugTokenNodePath,
    expectedPort: context.profile.debugPort,
    expectedInstanceId: `shellx-final-${runId}`,
    sourceCommit,
    version,
    signal: context.signal,
  });
  context.bindApplication({
    processId: runtime.processId,
    executableNodePath: applicationNodePath,
    executableLaunchPath: applicationLaunchPath,
  });

  const attestation = spawnSync(process.execPath, releaseSurfaceControllerNodeArguments(
    resolve(root, "scripts/create-release-surface-candidate-attestation.ts"), [
    "--platform", platform,
    "--artifact", artifactPath,
    "--installed-payload", applicationLaunchPath,
    "--installation-receipt", installationReceiptPath,
    "--candidate-source-commit", sourceCommit,
    "--pid", String(runtime.processId),
    "--debug-base", context.profile.debugBase,
    "--debug-token-file", context.profile.debugTokenLaunchPath,
    "--mcp-base", context.profile.mcpBase,
    "--mcp-token-file", context.profile.mcpTokenLaunchPath,
    "--out", candidateAttestationPath,
  ]), { cwd: root, encoding: "utf8", timeout: 60_000, maxBuffer: 1024 * 1024 });
  if (attestation.status !== 0) {
    throw new Error(`candidate attestation failed: ${(attestation.stderr || attestation.stdout).trim()}`);
  }
  context.bindCandidateAttestation(candidateAttestationPath);
  const candidate = loadReleaseSurfaceCandidateAttestation(candidateAttestationPath);
  const token = readCandidateToken(context.profile.debugTokenNodePath);
  const healthCollector = targetedClosure && !collectScenario
    ? null
    : await startReleaseSurfaceHealthCollector({
      candidate,
      candidateToken: token,
      session,
      inventory,
      platform,
      healthPort,
      outputPath: healthEvidencePath,
      processExists: (processId) => releaseSurfaceCandidateProcessExists(
        platform,
        processId,
        candidate.process.executablePath,
      ),
    });
  let scenarioInputs: {
    providerRoutes: Awaited<ReturnType<typeof collectReleaseSurfaceProviderRouteBatch>>["batch"];
  } | null = null;
  if (healthCollector) {
    context.registerSessionDeleteObserver({
      beforeSessionDelete: healthCollector.sessionDeleteObserver.beforeSessionDelete,
      afterSessionDelete: async (observation) => {
        await healthCollector.sessionDeleteObserver.afterSessionDelete(observation);
        const healthResult = await healthCollector.finalized;
        if (!scenarioInputs) throw new Error("scenario inputs were not complete before candidate shutdown");
        writeScenarioReport({
          path: scenarioReportPath,
          healthPath: healthResult.outputPath,
          candidate,
          inventoryDigest: inventory.digest,
          providerRoutes: scenarioInputs.providerRoutes.routes,
          health: healthResult.evidence,
          scenarioStartedAt: healthResult.scenarioStartedAt,
          contract,
        });
        context.bindHealthEvidence(healthResult.outputPath);
        context.bindScenarioReport(scenarioReportPath);
      },
    });
    await healthCollector.discoverRenderedLinks();
  }

  const manifest = runReleaseSurfaceDrivers({
    rootDir: root,
    plan,
    inventory,
    contract,
    platform,
    sourceCommit,
    controllerSourceCommit,
    version,
    artifactPath,
    signatureReceiptPath,
    candidateAttestationPath,
    installationReceiptPath,
    outputDir: driverOutputDir,
    ...(targetedClosure ? {
      selectedDriverIds,
      ...(selectedSurfaceIds.length > 0 ? { selectedSurfaceIds } : {}),
    } : {}),
    nativeWebDriver: session,
  });
  const manifestPath = join(resolve(driverOutputDir), "run-manifest.json");
  context.bindDriverRunManifest(manifestPath);
  const providerRoutes = targetedClosure && !collectScenario
    ? null
    : await collectReleaseSurfaceProviderRouteBatch({
      plan: providerRoutePlan,
      contract,
      candidate,
      token,
      outputDir: providerRouteOutputDir,
    });
  if (providerRoutes) {
    context.bindProviderRouteBatch(providerRoutes.manifestPath);
    scenarioInputs = { providerRoutes: providerRoutes.batch };
  }
  const failedDriverIds = releaseSurfaceDriverRunFailedDriverIds(manifest, driverOutputDir);
  if (failedDriverIds.length > 0) {
    throw new Error(
      `${targetedClosure ? "targeted closure" : "complete discovery matrix"} recorded failed driver sections: `
      + failedDriverIds.join(", "),
    );
  }
  return { manifest, providerRoutes: providerRoutes?.batch ?? null };
});

console.log(
  `${targetedClosure ? "Targeted" : "Final"} ${platform} WebDriver candidate orchestration passed `
  + `${result.value.manifest.driverReports.reduce((sum, report) => sum + report.outcomes, 0)} exact surface outcomes `
  + `${result.value.providerRoutes ? `and ${result.value.providerRoutes.routes.length} exact provider routes.` : "without rerunning provider routes."}`,
);

function assertLinuxDisplayAuthority(value: ReleasePlatform): void {
  if (value !== "linux-installed") return;
  const display = process.env.DISPLAY?.trim();
  if (!display) throw new Error("Linux installed-candidate orchestration requires DISPLAY");
  const xauthority = process.env.XAUTHORITY?.trim();
  if (!xauthority) {
    throw new Error(
      "Linux installed-candidate orchestration requires XAUTHORITY whenever DISPLAY is set; "
      + "without it exact ShellX-window capture can silently fail under Xwayland",
    );
  }
  let stat;
  try {
    stat = lstatSync(xauthority);
    accessSync(xauthority, constants.R_OK);
  } catch (error) {
    throw new Error(`Linux XAUTHORITY is not a readable file: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error("Linux XAUTHORITY must be a readable regular non-link file");
  }
}
console.log(`Evidence: ${resolve(orchestrationEvidencePath)}`);

async function waitForCandidateRuntime(input: {
  debugBase: string;
  debugTokenNodePath: string;
  expectedPort: number;
  expectedInstanceId: string;
  sourceCommit: string;
  version: string;
  signal: AbortSignal;
  timeoutMs?: number;
}): Promise<{ processId: number }> {
  const deadline = Date.now() + (input.timeoutMs ?? 30_000);
  let lastError = "candidate files are not ready";
  while (Date.now() < deadline) {
    if (input.signal.aborted) throw input.signal.reason;
    try {
      const token = readCandidateToken(input.debugTokenNodePath);
      const response = await fetch(`${input.debugBase}/health`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(1_500),
      });
      if (!response.ok) throw new Error(`/health returned ${response.status}`);
      const health = await response.json() as Record<string, unknown>;
      const processId = positiveInteger(health.processId, "health processId");
      if (health.debugApiPort !== input.expectedPort) throw new Error("health debugApiPort does not match the reserved port");
      if (health.instanceId !== input.expectedInstanceId) throw new Error("health instanceId does not match the run profile");
      if (health.appVersion !== input.version) throw new Error("health appVersion does not match the frozen version");
      if (health.buildCommit !== input.sourceCommit) throw new Error("health buildCommit does not match the frozen source commit");
      const protectedResponse = await fetch(`${input.debugBase}/browser/state`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(1_500),
      });
      await protectedResponse.body?.cancel();
      if (!protectedResponse.ok) throw new Error(`/browser/state returned ${protectedResponse.status}`);
      return { processId };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      await delay(100);
    }
  }
  throw new Error(`WebDriver candidate did not become attestable before timeout: ${lastError}`);
}

function readCandidateToken(path: string): string {
  if (!existsSync(path)) throw new Error("candidate token file is not ready");
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("candidate token must be a regular non-link file");
  const value = readFileSync(path, "utf8").trim();
  if (value.length < 32) throw new Error("candidate token is invalid");
  return value;
}

function validateProviderRouteOutputs(
  outputDirValue: string,
  routes: Array<{ providerId: string; transportId: string }>,
  profilePathValue: string,
  driverOutputDirValue: string,
): void {
  const outputDir = resolve(outputDirValue);
  if (outputDir === resolve(driverOutputDirValue)) {
    throw new Error("provider route output directory must differ from the driver output directory");
  }
  const stat = lstatSync(outputDir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error("provider route output directory must be a regular non-link directory");
  }
  const rel = relative(resolve(profilePathValue), outputDir);
  if (!rel || rel === "." || (!rel.startsWith(`..${sep}`) && rel !== "..")) {
    throw new Error("provider route output directory must be outside the disposable profile");
  }
  for (const path of [
    join(outputDir, "run-manifest.json"),
    ...routes.map((route) => join(outputDir, `${route.providerId}--${route.transportId}.json`)),
  ]) {
    if (existsSync(path)) throw new Error(`provider route output already exists: ${path}`);
  }
  if (readdirSync(outputDir).length > 0) {
    throw new Error("provider route output directory must start empty");
  }
}

function writeScenarioReport(input: {
  path: string;
  healthPath: string;
  candidate: ReturnType<typeof loadReleaseSurfaceCandidateAttestation>;
  inventoryDigest: string;
  providerRoutes: ReleaseSurfaceScenarioReport["providerRoutes"];
  health: ReleaseSurfaceHealthEvidence;
  scenarioStartedAt: string;
  contract: ReturnType<typeof loadFinalSurfaceContract>;
}): void {
  const healthIdentity = identifyRegularFile(input.healthPath, "health evidence");
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
      observed: "Exact startup identity, complete rendered-link inventory, lifecycle console stream, and candidate PID shutdown were observed.",
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
  if (errors.length > 0) throw new Error(`collected scenario report is invalid: ${errors.join("; ")}`);
  writeFileSync(resolve(input.path), `${JSON.stringify(report, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
}

function identifyRegularFile(path: string, label: string): { basename: string; sha256: string; bytes: number } {
  const absolute = resolve(path);
  const stat = lstatSync(absolute);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`${label} must be a regular non-link file`);
  const contents = readFileSync(absolute);
  if (contents.length === 0) throw new Error(`${label} must not be empty`);
  return { basename: basename(absolute), sha256: createHash("sha256").update(contents).digest("hex"), bytes: contents.length };
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) throw new Error(`${label} must be a positive integer`);
  return Number(value);
}

function requiredPort(values: string[], name: string): number {
  const value = Number(requiredArg(values, name));
  if (!Number.isSafeInteger(value) || value <= 0 || value > 65_535) throw new Error(`${name} must be a valid TCP port`);
  return value;
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

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
