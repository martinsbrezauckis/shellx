import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import type {
  ReleaseSurfaceDriverOutcome,
  ReleaseSurfaceDriverRequest,
} from "../lib/release-surface-driver-protocol";
import {
  cleanupDebugApiBrowserSettleFixture,
  prepareDebugApiBrowserSettleFixture,
} from "./debug-api-browser-settle-fixture";

const BROWSER_EVIDENCE_ARTIFACT_MUTATIONS = new Set([
  "POST /browser/evaluations",
  "POST /browser/flight-recorder/export",
  "POST /browser/har/export",
  "POST /browser/performance/export",
  "POST /browser/recipes/export",
  "POST /browser/recipes/replay",
  "POST /browser/storage-state/export",
  "POST /browser/trace/export",
]);

const TIMEOUT_MS = 30_000;
const MAX_FLIGHT_ARTIFACT_BYTES = 512 * 1024;
const MAX_EVALUATION_ARTIFACT_BYTES = 256 * 1024;
const MAX_GENERAL_BROWSER_ARTIFACT_BYTES = 16 * 1024 * 1024;

type DebugApiConnection = { base: string; token: string; callerSessionId?: string };
type DriverAssignment = ReleaseSurfaceDriverRequest["assignments"][number];

export type ArtifactIdentity = {
  id: string;
  taskId: string;
  path: string;
  nodePath: string;
  bytes: number;
  sha256: string;
};

export function isDebugApiBrowserEvidenceArtifactMutation(name: string): boolean {
  return BROWSER_EVIDENCE_ARTIFACT_MUTATIONS.has(name);
}

export async function exerciseDebugApiBrowserEvidenceArtifactMutation(
  connection: DebugApiConnection,
  request: ReleaseSurfaceDriverRequest,
  assignment: DriverAssignment,
): Promise<ReleaseSurfaceDriverOutcome> {
  const outcome: ReleaseSurfaceDriverOutcome = {
    id: assignment.surface.id,
    expectedEffect: assignment.expectedEffect,
    oracleId: assignment.oracleId,
    present: "fail",
    invoke: "fail",
    effect: "fail",
    cleanup: "fail",
    observedEffect: "No owned Browser evidence artifact effect was observed.",
  };
  const ownedArtifactPaths = new Set<string>();
  let fixture: Awaited<ReturnType<typeof prepareDebugApiBrowserSettleFixture>> | null = null;
  let comparisonFixture: Awaited<ReturnType<typeof prepareDebugApiBrowserSettleFixture>> | null = null;
  try {
    if (!BROWSER_EVIDENCE_ARTIFACT_MUTATIONS.has(assignment.surface.name)) {
      throw new Error(`unsupported Browser evidence artifact route ${assignment.surface.name}`);
    }
    const callerSessionId = `release-evidence-${randomUUID()}`;
    const scopedConnection: DebugApiConnection = { ...connection, callerSessionId };
    fixture = await prepareDebugApiBrowserSettleFixture(connection, { callerSessionId });
    outcome.present = "pass";
    const suiteId = `release-surface-${randomUUID()}`;
    if (assignment.surface.name === "POST /browser/evaluations") {
      const verification = await apiJson(scopedConnection, "POST", "/browser/action", {
        action: "verify",
        taskId: fixture.taskId,
        browserTabId: fixture.browserTabId,
        key: "text",
        value: "Owned Browser settle fixture ready",
        timeoutMs: TIMEOUT_MS,
      });
      if (verification.ok !== true
        || requireObject(verification.verification, "Browser evaluation source verification").passed !== true) {
        throw new Error("Browser evaluation fixture did not produce a source-bound verification receipt");
      }
    }
    const baseline = assignment.surface.name === "POST /browser/flight-recorder/export"
      || assignment.surface.name === "POST /browser/evaluations"
      ? await exportFlightRecorder(
        scopedConnection,
        request,
        fixture.taskId,
        fixture.browserTabId,
        suiteId,
        "baseline",
        0,
        ownedArtifactPaths,
      )
      : null;
    if (assignment.surface.name === "POST /browser/flight-recorder/export") {
      if (!baseline) throw new Error("Flight Recorder baseline artifact was not prepared");
      outcome.invoke = "pass";
      outcome.effect = "pass";
      outcome.observedEffect = "POST /browser/flight-recorder/export wrote one bounded, complete, exact-task artifact whose bytes and SHA-256 matched its response; task and artifact identities were not retained.";
    } else if (assignment.surface.name === "POST /browser/evaluations") {
      if (!baseline) throw new Error("Browser evaluation baseline artifact was not prepared");
      comparisonFixture = await prepareDebugApiBrowserSettleFixture(connection, { callerSessionId });
      const candidateVerification = await apiJson(scopedConnection, "POST", "/browser/action", {
        action: "verify",
        taskId: comparisonFixture.taskId,
        browserTabId: comparisonFixture.browserTabId,
        key: "text",
        value: "Owned Browser settle fixture ready",
        timeoutMs: TIMEOUT_MS,
      });
      if (candidateVerification.ok !== true
        || requireObject(
          candidateVerification.verification,
          "Browser evaluation candidate verification",
        ).passed !== true) {
        throw new Error("Browser evaluation candidate fixture did not produce a source-bound verification receipt");
      }
      const candidate = await exportFlightRecorder(
        scopedConnection,
        request,
        comparisonFixture.taskId,
        comparisonFixture.browserTabId,
        suiteId,
        "candidate",
        1,
        ownedArtifactPaths,
      );
      const evaluatedAtMs = Date.now();
      const report = await apiJson(scopedConnection, "POST", "/browser/evaluations", {
        suiteId,
        evaluatedAtMs,
        taskId: fixture.taskId,
        baselineLabel: "release-baseline",
        candidateLabel: "release-candidate",
        reason: "Final release surface Browser evaluation proof",
        attempts: [
          evaluationAttempt(baseline, "baseline", 2),
          evaluationAttempt(candidate, "candidate", 1),
        ],
      });
      outcome.invoke = "pass";
      verifyExactKeys(report, [
        "attempts", "baselineAttempts", "candidateAttempts", "evaluatedAtMs", "evidenceComplete",
        "evidenceDigest", "improvementRating", "improvementScore", "path", "receipt", "reportId",
        "safetyViolationDelta", "sha256", "source", "suiteId", "taskId", "bytes",
      ], "Browser evaluation response");
      const reportId = requiredString(report.reportId, "Browser evaluation reportId");
      if (report.suiteId !== suiteId || report.taskId !== fixture.taskId || report.evaluatedAtMs !== evaluatedAtMs
        || report.attempts !== 2 || report.baselineAttempts !== 1 || report.candidateAttempts !== 1
        || report.evidenceComplete !== true || report.source !== "shellx-browser-evaluations") {
        throw new Error("Browser evaluation response omitted its exact owned comparison identity");
      }
      requiredSha256(report.evidenceDigest, "Browser evaluation evidenceDigest");
      const receipt = requireObject(report.receipt, "Browser evaluation receipt");
      if (receipt.kind !== "browserEvaluationReportWritten" || receipt.taskId !== fixture.taskId) {
        throw new Error("Browser evaluation receipt was not bound to the exact owned task");
      }
      const reportArtifact = verifyArtifactFile(
        request,
        report,
        reportId,
        fixture.taskId,
        MAX_EVALUATION_ARTIFACT_BYTES,
        "Browser evaluation",
      );
      ownedArtifactPaths.add(reportArtifact.nodePath);
      const reportBody = requireObject(
        JSON.parse(readFileSync(reportArtifact.nodePath, "utf8")),
        "Browser evaluation artifact body",
      );
      if (reportBody.reportId !== reportId || reportBody.evidenceDigest !== report.evidenceDigest
        || requireObject(reportBody.manifest, "Browser evaluation manifest").suiteId !== suiteId) {
        throw new Error("Browser evaluation artifact did not match its response and owned suite identity");
      }
      outcome.effect = "pass";
      outcome.observedEffect = "POST /browser/evaluations bound two exact-task, SHA-256-verified Flight Recorder attempts into one evidence-complete report whose bytes and digest matched its response; attempt and report identities were not retained.";
    } else if (assignment.surface.name === "POST /browser/recipes/replay") {
      const { artifact: exported, steps: recipeSteps } = await prepareOwnedBrowserRecipeArtifact(
        scopedConnection,
        request,
        fixture,
      );
      ownedArtifactPaths.add(exported.nodePath);
      const replay = await apiJson(scopedConnection, "POST", "/browser/recipes/replay", {
        taskId: fixture.taskId,
        browserTabId: fixture.browserTabId,
        recipePath: exported.path,
        dryRun: true,
        reason: "Final release surface Browser recipe replay proof",
      });
      outcome.invoke = "pass";
      verifyExactKeys(replay, [
        "browserTabId", "decisionPoints", "dryRun", "ok", "receipt", "skippedSteps",
        "status", "stepResults", "stepsApplied", "stepsPlanned", "stepsSkipped", "taskId",
      ], "Browser recipe replay response");
      const skippedSteps = requireObjectArray(replay.skippedSteps, "Browser recipe replay skippedSteps");
      const stepResults = requireObjectArray(replay.stepResults, "Browser recipe replay stepResults");
      requireObjectArray(replay.decisionPoints, "Browser recipe replay decisionPoints");
      if (replay.ok !== true || replay.status !== "dryRunCompleted" || replay.dryRun !== true
        || replay.taskId !== fixture.taskId || replay.browserTabId !== fixture.browserTabId
        || replay.stepsPlanned !== recipeSteps.length || replay.stepsApplied !== 0
        || replay.stepsSkipped !== skippedSteps.length || stepResults.length !== recipeSteps.length) {
        throw new Error("Browser recipe replay response did not match its exact owned dry-run plan");
      }
      const receipt = requireObject(replay.receipt, "Browser recipe replay receipt");
      const evidence = requireObject(receipt.evidence, "Browser recipe replay receipt evidence");
      if (receipt.kind !== "browserRecipeReplayCompleted" || receipt.taskId !== fixture.taskId
        || evidence.browserTabId !== fixture.browserTabId || evidence.recipePath !== exported.path
        || evidence.dryRun !== true || evidence.stepsPlanned !== recipeSteps.length
        || evidence.stepsApplied !== 0 || evidence.stepsSkipped !== skippedSteps.length) {
        throw new Error("Browser recipe replay receipt was not bound to the exact owned dry-run plan");
      }
      outcome.effect = "pass";
      outcome.observedEffect = "POST /browser/recipes/replay dry-ran one SHA-256-verified exact-task recipe, returned one ordered result for every planned or skipped step with zero applied actions, and retained neither task nor artifact identity.";
    } else {
      const exported = await exportAdjacentBrowserArtifact(
        scopedConnection,
        request,
        assignment.surface.name,
        fixture.taskId,
        fixture.browserTabId,
        fixture.url,
      );
      ownedArtifactPaths.add(exported.nodePath);
      outcome.invoke = "pass";
      outcome.effect = "pass";
      outcome.observedEffect = `${assignment.surface.name} wrote one bounded exact-task/profile artifact whose bytes, SHA-256, redaction identity, and receipt matched its response; task and artifact identities were not retained.`;
    }
  } catch (error) {
    outcome.error = error instanceof Error ? error.message : String(error);
  } finally {
    const cleanupErrors: string[] = [];
    for (const path of ownedArtifactPaths) {
      try {
        if (!existsSync(path)) throw new Error("owned artifact disappeared before cleanup");
        unlinkSync(path);
        if (existsSync(path)) throw new Error("owned artifact remained after exact deletion");
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (comparisonFixture) {
      const cleanupError = await cleanupDebugApiBrowserSettleFixture(connection, comparisonFixture);
      if (cleanupError) cleanupErrors.push(cleanupError);
    }
    if (fixture) {
      const cleanupError = await cleanupDebugApiBrowserSettleFixture(connection, fixture);
      if (cleanupError) cleanupErrors.push(cleanupError);
    }
    if (cleanupErrors.length === 0) {
      outcome.cleanup = "pass";
    } else {
      const detail = cleanupErrors.join(" | ");
      outcome.error = outcome.error ? `${outcome.error}; cleanup: ${detail}` : `cleanup: ${detail}`;
    }
  }
  return outcome;
}

export async function prepareOwnedBrowserRecipeArtifact(
  connection: DebugApiConnection,
  request: ReleaseSurfaceDriverRequest,
  fixture: { taskId: string; browserTabId: string; url: string },
): Promise<{ artifact: ArtifactIdentity; steps: Array<Record<string, unknown>> }> {
  const verified = await apiJson(connection, "POST", "/browser/action", {
    action: "verify",
    taskId: fixture.taskId,
    browserTabId: fixture.browserTabId,
    key: "text",
    value: "Owned Browser settle fixture ready",
    timeoutMs: 30_000,
  });
  const verification = requireObject(verified.verification, "Browser recipe verification");
  const verificationReceipt = requireObject(verified.receipt, "Browser recipe verification receipt");
  if (verified.ok !== true || verification.passed !== true
    || verificationReceipt.kind !== "browserVerificationPassed"
    || verificationReceipt.taskId !== fixture.taskId) {
    throw new Error("Browser recipe fixture did not create one exact replayable verification step");
  }
  const artifact = await exportAdjacentBrowserArtifact(
    connection,
    request,
    "POST /browser/recipes/export",
    fixture.taskId,
    fixture.browserTabId,
    fixture.url,
  );
  const recipe = requireObject(
    JSON.parse(readFileSync(artifact.nodePath, "utf8")),
    "Browser recipe fixture",
  );
  const steps = requireObjectArray(recipe.steps, "Browser recipe fixture steps");
  if (steps.length < 1) throw new Error("Browser recipe fixture exported no replayable steps");
  return { artifact, steps };
}

async function exportAdjacentBrowserArtifact(
  connection: DebugApiConnection,
  request: ReleaseSurfaceDriverRequest,
  surfaceName: string,
  taskId: string,
  browserTabId: string,
  expectedUrl: string,
): Promise<ArtifactIdentity> {
  const configs: Record<string, {
    path: string;
    idKey: string;
    source?: string;
    receiptKind: string;
    countKey?: "entries" | "steps";
    extraKeys?: string[];
  }> = {
    "POST /browser/har/export": {
      path: "/browser/har/export",
      idKey: "harId",
      source: "shellx-browser-har",
      receiptKind: "browserHarExported",
      countKey: "entries",
    },
    "POST /browser/performance/export": {
      path: "/browser/performance/export",
      idKey: "performanceId",
      source: "shellx-browser-performance",
      receiptKind: "browserPerformanceExported",
      extraKeys: ["metrics"],
    },
    "POST /browser/recipes/export": {
      path: "/browser/recipes/export",
      idKey: "recipeId",
      source: "shellx-browser-recipes",
      receiptKind: "browserRecipeExported",
      countKey: "steps",
    },
    "POST /browser/storage-state/export": {
      path: "/browser/storage-state/export",
      idKey: "exportId",
      receiptKind: "browserStorageStateManifestExported",
    },
    "POST /browser/trace/export": {
      path: "/browser/trace/export",
      idKey: "traceId",
      source: "shellx-browser-trace-bundle",
      receiptKind: "browserTraceBundleExported",
    },
  };
  const config = configs[surfaceName];
  if (!config) throw new Error(`unsupported adjacent Browser artifact route ${surfaceName}`);
  const storageState = config.path === "/browser/storage-state/export";
  const response = await apiJson(connection, "POST", config.path, storageState
    ? { profileId: "task-disposable", reason: "Final release surface storage-state proof" }
    : { taskId, browserTabId, reason: `Final release surface ${config.idKey} proof` });
  const commonKeys = [config.idKey, "path", "bytes", "sha256", "createdAtMs", "receipt"];
  const expectedKeys = storageState
    ? [...commonKeys, "profiles"]
    : [
      ...commonKeys,
      "taskId",
      "browserTabId",
      "source",
      ...(config.countKey ? [config.countKey] : []),
      ...(config.extraKeys ?? []),
    ];
  verifyExactKeys(response, expectedKeys, `${surfaceName} response`);
  const id = requiredString(response[config.idKey], `${surfaceName} ${config.idKey}`);
  if (storageState) {
    const profiles = requireObjectArray(response.profiles, `${surfaceName} profiles`);
    if (profiles.length !== 1 || profiles[0]?.profileId !== "task-disposable"
      || profiles[0]?.cookieValuesExposed !== false || profiles[0]?.localStorageValuesExposed !== false
      || profiles[0]?.artifactHash !== response.sha256) {
      throw new Error(`${surfaceName} response exposed values or omitted its exact disposable profile hash`);
    }
  } else if (response.taskId !== taskId || response.browserTabId !== browserTabId || response.source !== config.source) {
    throw new Error(`${surfaceName} response omitted its exact owned task, tab, or source identity`);
  }
  if (config.countKey) nonNegativeInteger(response[config.countKey], `${surfaceName} ${config.countKey}`);
  nonNegativeInteger(response.createdAtMs, `${surfaceName} createdAtMs`);
  const receipt = requireObject(response.receipt, `${surfaceName} receipt`);
  const receiptEvidence = requireObject(receipt.evidence, `${surfaceName} receipt evidence`);
  if (receipt.kind !== config.receiptKind
    || (storageState ? receipt.profileId !== "task-disposable" : receipt.taskId !== taskId)) {
    throw new Error(`${surfaceName} receipt was not bound to the exact owned task or profile`);
  }
  const identity = verifyArtifactFile(
    request,
    response,
    id,
    taskId,
    MAX_GENERAL_BROWSER_ARTIFACT_BYTES,
    surfaceName,
  );
  const body = requireObject(JSON.parse(readFileSync(identity.nodePath, "utf8")), `${surfaceName} artifact body`);
  if (config.path === "/browser/har/export") {
    const shellx = requireObject(body.shellx, "HAR shellx metadata");
    const log = requireObject(body.log, "HAR log");
    if (shellx.harId !== id || shellx.taskId !== taskId || shellx.browserTabId !== browserTabId || log.version !== "1.2") {
      throw new Error("HAR artifact body did not match its exact response and owned task identity");
    }
  } else if (config.path === "/browser/performance/export") {
    const metrics = requireObject(response.metrics, "Browser performance metrics");
    const artifactMetrics = requireObject(body.metrics, "Browser performance artifact metrics");
    const policy = requireObject(body.redactionPolicy, "Browser performance artifact redaction policy");
    const metricsPolicy = requireObject(metrics.redactionPolicy, "Browser performance metrics redaction policy");
    const navigation = requireObjectArray(metrics.navigation, "Browser performance navigation metrics");
    const resources = requireObjectArray(metrics.resources, "Browser performance resource metrics");
    const paints = requireObjectArray(metrics.paint, "Browser performance paint metrics");
    const counters = requireObject(metrics.counters, "Browser performance counters");
    const currentUrl = requiredString(metrics.currentUrl, "Browser performance currentUrl");
    if (body.performanceId !== id || body.taskId !== taskId || body.browserTabId !== browserTabId
      || metrics.engineMounted !== true || metrics.captureStatus !== "captured"
      || currentUrl !== expectedUrl || metrics.title !== "ShellX release settle"
      || navigation.length < 1 || !navigation.some((entry) => entry.name === expectedUrl)
      || navigation.some((entry) => unsafeMetricUrl(entry.name))
      || resources.some((entry) => unsafeMetricUrl(entry.name))
      || counters.navigation !== navigation.length || counters.resources !== resources.length
      || counters.paints !== paints.length
      || JSON.stringify(artifactMetrics) !== JSON.stringify(metrics)
      || policy.resourceUrlsSanitized !== true || policy.queryAndFragmentRetained !== false
      || policy.headers !== false || policy.bodies !== false || policy.cookies !== false
      || JSON.stringify(metricsPolicy) !== JSON.stringify(policy)
      || receiptEvidence.performanceId !== id || receiptEvidence.browserTabId !== browserTabId
      || receiptEvidence.path !== response.path || receiptEvidence.bytes !== response.bytes
      || receiptEvidence.sha256 !== response.sha256 || receiptEvidence.source !== config.source) {
      throw new Error("Browser performance artifact did not prove an exact captured engine metric bundle and redaction contract");
    }
  } else if (config.path === "/browser/recipes/export") {
    if (body.schemaVersion !== 2 || body.recipeId !== id || body.taskId !== taskId
      || body.browserTabId !== browserTabId || body.source !== "shellx-browser-recorder") {
      throw new Error("Browser recipe artifact body did not match its exact response and owned task identity");
    }
  } else if (config.path === "/browser/storage-state/export") {
    const policy = requireObject(body.redactionPolicy, "storage-state redaction policy");
    const profiles = requireObjectArray(body.profiles, "storage-state artifact profiles");
    if (body.exportId !== id || profiles.length !== 1 || profiles[0]?.profileId !== "task-disposable"
      || policy.cookieValues !== false || policy.localStorageValues !== false || policy.safeManifestOnly !== true) {
      throw new Error("storage-state artifact body did not preserve its exact safe-manifest contract");
    }
  } else {
    const task = requireObject(body.task, "trace task");
    const tab = requireObject(body.tab, "trace tab");
    const policy = requireObject(body.redactionPolicy, "trace redaction policy");
    if (body.traceId !== id || task.taskId !== taskId || tab.browserTabId !== browserTabId
      || policy.rawSecrets !== false || policy.cookies !== false || policy.rawDom !== false) {
      throw new Error("trace artifact body did not match its exact owned task and redaction contract");
    }
  }
  return identity;
}

function unsafeMetricUrl(value: unknown): boolean {
  return typeof value !== "string" || !value || value.includes("?") || value.includes("#");
}

async function exportFlightRecorder(
  connection: DebugApiConnection,
  request: ReleaseSurfaceDriverRequest,
  taskId: string,
  browserTabId: string,
  suiteId: string,
  group: "baseline" | "candidate",
  attemptIndex: number,
  ownedArtifactPaths: Set<string>,
): Promise<ArtifactIdentity> {
  const artifact = await apiJson(connection, "POST", "/browser/flight-recorder/export", {
    taskId,
    browserTabId,
    suiteId,
    group,
    attemptIndex,
    reason: `Final release surface ${group} Flight Recorder proof`,
  });
  verifyExactKeys(artifact, [
    "attemptId", "browserTabId", "bytes", "createdAtMs", "droppedEvents", "droppedReceipts",
    "events", "evidenceComplete", "firstSourceSequence", "gapCount", "lastSourceSequence", "path",
    "receipt", "receipts", "retentionDroppedEvents", "retentionDroppedReceipts", "sanitizerLossCount", "sha256", "source", "taskId",
  ], "Flight Recorder response");
  const attemptId = requiredString(artifact.attemptId, "Flight Recorder attemptId");
  if (artifact.taskId !== taskId || artifact.browserTabId !== browserTabId
    || artifact.source !== "shellx-browser-flight-recorder" || artifact.evidenceComplete !== true
    || nonNegativeInteger(artifact.gapCount, "Flight Recorder gapCount") !== 0) {
    throw new Error("Flight Recorder response omitted its exact owned complete-evidence identity");
  }
  for (const field of [
    "events", "receipts", "droppedEvents", "droppedReceipts",
    "retentionDroppedEvents", "retentionDroppedReceipts", "sanitizerLossCount", "createdAtMs",
  ]) nonNegativeInteger(artifact[field], `Flight Recorder ${field}`);
  const receipt = requireObject(artifact.receipt, "Flight Recorder receipt");
  if (receipt.kind !== "browserFlightRecorderExported" || receipt.taskId !== taskId) {
    throw new Error("Flight Recorder receipt was not bound to the exact owned task");
  }
  const identity = verifyArtifactFile(
    request,
    artifact,
    attemptId,
    taskId,
    MAX_FLIGHT_ARTIFACT_BYTES,
    "Flight Recorder",
  );
  ownedArtifactPaths.add(identity.nodePath);
  const body = requireObject(JSON.parse(readFileSync(identity.nodePath, "utf8")), "Flight Recorder artifact body");
  if (body.schemaVersion !== "sx.flightRecorder.v1" || body.attemptId !== attemptId) {
    throw new Error("Flight Recorder artifact body did not match its response identity");
  }
  const manifest = requireObject(body.manifest, "Flight Recorder manifest");
  if (manifest.taskId !== taskId || manifest.browserTabId !== browserTabId
    || manifest.suiteId !== suiteId || manifest.group !== group || manifest.attemptIndex !== attemptIndex) {
    throw new Error("Flight Recorder artifact body did not match its exact owned suite and task identity");
  }
  return identity;
}

function evaluationAttempt(
  identity: ArtifactIdentity,
  group: "baseline" | "candidate",
  steps: number,
): Record<string, unknown> {
  return {
    attemptId: identity.id,
    group,
    taskId: identity.taskId,
    status: "passed",
    durationMs: group === "baseline" ? 2 : 1,
    steps,
    safetyViolations: 0,
    artifactPath: identity.path,
    artifactBytes: identity.bytes,
    artifactSha256: identity.sha256,
  };
}

function verifyArtifactFile(
  request: ReleaseSurfaceDriverRequest,
  artifact: Record<string, unknown>,
  id: string,
  taskId: string,
  maxBytes: number,
  label: string,
): ArtifactIdentity {
  const launchPath = requiredString(artifact.path, `${label} path`);
  const nodePath = resolve(nodeReadablePath(launchPath, request.platform));
  const tokenPath = resolve(nodeReadablePath(request.runtime.debugTokenPath, request.platform));
  const profileRoot = resolve(dirname(dirname(tokenPath)));
  const rel = relative(profileRoot, nodePath);
  if (!rel || rel === "." || rel === ".." || rel.startsWith(`..${sep}`)) {
    throw new Error(`${label} artifact escaped the disposable final-run profile`);
  }
  const stat = lstatSync(nodePath);
  const bytes = positiveInteger(artifact.bytes, `${label} bytes`);
  const sha256 = requiredSha256(artifact.sha256, `${label} sha256`);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size !== bytes || bytes > maxBytes) {
    throw new Error(`${label} artifact was not one matching bounded regular file`);
  }
  const actualSha256 = createHash("sha256").update(readFileSync(nodePath)).digest("hex");
  if (actualSha256 !== sha256) throw new Error(`${label} artifact SHA-256 did not match its response`);
  return { id, taskId, path: launchPath, nodePath, bytes, sha256 };
}

async function apiJson(
  connection: DebugApiConnection,
  method: "GET" | "POST",
  path: string,
  body?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await fetch(`${connection.base}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${connection.token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(connection.callerSessionId
        ? { "x-shellx-mcp-caller-id": connection.callerSessionId }
        : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path} failed ${response.status}: ${text.slice(0, 1_200)}`);
  return requireObject(text.trim() ? JSON.parse(text) : {}, `${method} ${path}`);
}

function nodeReadablePath(path: string, platform: ReleaseSurfaceDriverRequest["platform"]): string {
  if (platform !== "windows-installed" || process.platform === "win32" || !/^[A-Za-z]:[\\/]/.test(path)) {
    return resolve(path);
  }
  const result = spawnSync("wslpath", ["-u", path], { encoding: "utf8" });
  if (result.status !== 0 || !result.stdout.trim()) throw new Error("unable to map a Windows Browser artifact path");
  return resolve(result.stdout.trim());
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} did not return an object`);
  return value as Record<string, unknown>;
}

function requireObjectArray(value: unknown, label: string): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) throw new Error(`${label} did not return an array`);
  return value.map((entry, index) => requireObject(entry, `${label}[${index}]`));
}

function verifyExactKeys(value: Record<string, unknown>, expected: string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new Error(`${label} keys changed: ${actual.join(", ")}`);
  }
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function requiredSha256(value: unknown, label: string): string {
  const digest = requiredString(value, label).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error(`${label} must be a lowercase SHA-256 digest`);
  return digest;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) throw new Error(`${label} must be a positive integer`);
  return Number(value);
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`${label} must be a non-negative integer`);
  return Number(value);
}
