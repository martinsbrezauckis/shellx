import { createHash } from "node:crypto";
import type {
  ReleasePlatform,
  ReleaseSurfaceItem,
  ReleaseSurfaceKind,
} from "./release-surface-inventory";
import { parseExactReleaseSurfaceLoopbackBase } from "./release-surface-candidate-attestation";
import {
  validateReleaseSurfaceWindowsRuntimeBinding,
  type ReleaseSurfaceWindowsNativeBinding,
} from "./release-surface-windows-native-runtime";
import {
  releaseSurfacePosixPathDigest,
  validateReleaseSurfacePosixRuntimeBinding,
  type ReleaseSurfacePosixNativeBinding,
} from "./release-surface-posix-native-runtime";
import {
  parseExactReleaseSurfaceWebDriverBase,
  type ReleaseSurfaceWebDriverRequestBinding,
} from "./release-surface-webdriver-binding";
import {
  validateReleaseSurfaceControllerBinding,
  type ReleaseSurfaceControllerBinding,
} from "./release-surface-controller-binding";
import {
  validateReleaseSurfaceMacosNativeInputRequestBinding,
  type ReleaseSurfaceMacosNativeInputRequestBinding,
} from "./release-surface-macos-native-input";

export const RELEASE_SURFACE_DRIVER_MANIFEST_SCHEMA = "shellx/release-surface-driver-manifest@5";
export const RELEASE_SURFACE_DRIVER_REQUEST_SCHEMA = "shellx/release-surface-driver-request@7";
export const RELEASE_SURFACE_DRIVER_REPORT_SCHEMA = "shellx/release-surface-driver-report@7";

export interface ReleaseSurfaceDriverManifest {
  schema: typeof RELEASE_SURFACE_DRIVER_MANIFEST_SCHEMA;
  id: string;
  kind: ReleaseSurfaceKind;
  runtimeBinding: "attested-process";
  invocationTransport:
    | "native-webdriver"
    | "native-installed-input"
    | "native-installed-input-with-fixture-webdriver"
    | "debug-api-direct"
    | "debug-api-synthetic"
    | "process-cli"
    | "process-cli-with-fixture-webdriver";
  supportedFixtures: string[];
  supportedCleanups: string[];
  supportedOracles: string[];
  controllerFiles?: string[];
  maxAssignmentsPerProcess?: number;
}

export interface ReleaseSurfaceDriverRequest {
  schema: typeof RELEASE_SURFACE_DRIVER_REQUEST_SCHEMA;
  mode: "final-frozen-candidate";
  driverId: string;
  driverKind: ReleaseSurfaceKind;
  platform: ReleasePlatform;
  sourceCommit: string;
  version: string;
  inventoryDigest: string;
  artifact: {
    basename: string;
    sha256: string;
  };
  controller: ReleaseSurfaceControllerBinding;
  runtime: ReleaseSurfaceDriverRuntimeIdentity;
  nativeWebDriver?: ReleaseSurfaceWebDriverRequestBinding;
  macosNativeInput?: ReleaseSurfaceMacosNativeInputRequestBinding;
  assignments: Array<{
    surface: ReleaseSurfaceItem;
    fixtureId: string;
    expectedEffect: string;
    oracleId: string;
    cleanupId: string;
  }>;
}

export interface ReleaseSurfaceDriverRuntimeIdentity {
  processId: number;
  instanceId: string;
  debugBase: string;
  debugTokenPath: string;
  mcpBase: string;
  mcpTokenPath: string;
  executableSha256: string;
  installedPayloadPath: string;
  installedManifestSha256: string;
  windowsNative?: ReleaseSurfaceWindowsNativeBinding;
  posixNative?: ReleaseSurfacePosixNativeBinding;
}

export type ReleaseSurfaceDriverVerdict = "pass" | "fail";
export type ReleaseSurfaceDriverCleanupVerdict = ReleaseSurfaceDriverVerdict | "deferred-candidate-teardown";

const CANDIDATE_TEARDOWN_CLEANUP_IDS = new Set([
  "debug-api:close-owned-browser-task-and-candidate-teardown",
  "debug-api:complete-owned-browser-task-and-candidate-teardown",
  "debug-api:delete-owned-browser-robot-recipe-close-task-and-candidate-teardown",
  "debug-api:delete-owned-transfer-file-close-task-and-candidate-teardown",
  "debug-api:delete-owned-vault-deposit-close-task-and-candidate-teardown",
  "debug-api:close-owned-browser-teach-task-and-candidate-teardown",
  "debug-api:close-browser-window-with-candidate-teardown",
  "tauri:discard-with-candidate-profile",
  "tauri:preserve-rotated-token-until-candidate-teardown",
  "tauri:close-owned-browser-operator-workflow-and-candidate-teardown",
  "ui:close-owned-browser-task-with-candidate-teardown",
  "ui:reset-disposable-vault-with-candidate-teardown",
  "ui:delete-owned-teach-evidence-key-lock-disposable-vault-and-candidate-teardown",
]);

export interface ReleaseSurfaceDriverOutcome {
  id: string;
  expectedEffect: string;
  oracleId: string;
  present: ReleaseSurfaceDriverVerdict;
  invoke: ReleaseSurfaceDriverVerdict;
  effect: ReleaseSurfaceDriverVerdict;
  cleanup: ReleaseSurfaceDriverCleanupVerdict;
  cleanupEvidence?: {
    cleanupId: string;
    status: ReleaseSurfaceDriverCleanupVerdict;
    proofSha256: string;
    privatePayloadRetained: false;
  };
  observedEffect: string;
  error?: string;
}

export interface ReleaseSurfaceDriverReport {
  schema: typeof RELEASE_SURFACE_DRIVER_REPORT_SCHEMA;
  mode: "final-frozen-candidate";
  driverId: string;
  driverKind: ReleaseSurfaceKind;
  platform: ReleasePlatform;
  sourceCommit: string;
  version: string;
  inventoryDigest: string;
  artifactSha256: string;
  controller: ReleaseSurfaceControllerBinding;
  runtime: ReleaseSurfaceDriverRuntimeIdentity;
  nativeWebDriver?: ReleaseSurfaceWebDriverRequestBinding;
  macosNativeInput?: ReleaseSurfaceMacosNativeInputRequestBinding;
  startedAt: string;
  completedAt: string;
  outcomes: ReleaseSurfaceDriverOutcome[];
}

export function validateReleaseSurfaceDriverRequest(
  manifest: ReleaseSurfaceDriverManifest,
  request: ReleaseSurfaceDriverRequest,
): string[] {
  const errors: string[] = [];
  rejectUnknownKeys(request, [
    "schema", "mode", "driverId", "driverKind", "platform", "sourceCommit", "version",
    "inventoryDigest", "artifact", "controller", "runtime", "nativeWebDriver", "macosNativeInput", "assignments",
  ], "request", errors);
  rejectUnknownKeys(request.artifact, ["basename", "sha256"], "request artifact", errors);
  rejectUnknownKeys(request.runtime, [
    "processId", "instanceId", "debugBase", "debugTokenPath", "mcpBase", "mcpTokenPath",
    "executableSha256", "installedPayloadPath", "installedManifestSha256", "windowsNative", "posixNative",
  ], "request runtime", errors);
  if (request.schema !== RELEASE_SURFACE_DRIVER_REQUEST_SCHEMA) errors.push(`request schema must be ${RELEASE_SURFACE_DRIVER_REQUEST_SCHEMA}`);
  if (request.mode !== "final-frozen-candidate") errors.push("request mode must be final-frozen-candidate");
  if (request.driverId !== manifest.id) errors.push(`request driverId must be ${manifest.id}`);
  if (request.driverKind !== manifest.kind) errors.push(`request driverKind must be ${manifest.kind}`);
  if (manifest.runtimeBinding !== "attested-process") errors.push("driver manifest must require attested-process runtime binding");
  if (!request.platform?.trim()) errors.push("request platform is required");
  if (!/^[a-f0-9]{40,64}$/.test(request.sourceCommit ?? "")) {
    errors.push("request sourceCommit must be a lowercase Git object id");
  }
  if (!request.version?.trim()) errors.push("request version is required");
  if (!/^[a-f0-9]{64}$/.test(request.inventoryDigest ?? "")) errors.push("request inventoryDigest must be 64 lowercase hex characters");
  if (!request.artifact?.basename?.trim()) errors.push("request artifact basename is required");
  if (!/^[a-f0-9]{64}$/.test(request.artifact?.sha256 ?? "")) errors.push("request artifact sha256 must be 64 lowercase hex characters");
  errors.push(...validateReleaseSurfaceControllerBinding(request.controller));
  // A targeted post-matrix run may bind a scripts-only descendant controller
  // while the installed candidate remains on its signed source commit. The
  // orchestrator proves ancestry, path scope, and patch digest before it can
  // construct this request; the driver still binds every executable file.
  const expectedControllerFiles = [...(manifest.controllerFiles ?? [])].sort();
  const actualControllerFiles = Array.isArray(request.controller?.auxiliaryFiles)
    ? request.controller.auxiliaryFiles.map((file) => file.relativePath).sort()
    : [];
  if (JSON.stringify(actualControllerFiles) !== JSON.stringify(expectedControllerFiles)) {
    errors.push("request controller auxiliary files must match the exact driver manifest");
  }
  if (!Number.isSafeInteger(request.runtime?.processId) || request.runtime.processId <= 0) errors.push("request runtime processId must be a positive integer");
  if (!/^[a-zA-Z0-9._-]{16,128}$/.test(request.runtime?.instanceId ?? "")) errors.push("request runtime instanceId must be an opaque run nonce");
  const parsedDebugBase = parseExactReleaseSurfaceLoopbackBase(request.runtime?.debugBase);
  if (!parsedDebugBase) {
    errors.push("request runtime debugBase must be an exact http://127.0.0.1:<port> origin");
  }
  if (!request.runtime?.debugTokenPath?.trim()) errors.push("request runtime debugTokenPath is required");
  const parsedMcpBase = parseExactReleaseSurfaceLoopbackBase(request.runtime?.mcpBase);
  if (!parsedMcpBase) {
    errors.push("request runtime mcpBase must be an exact http://127.0.0.1:<port> origin");
  }
  if (!request.runtime?.mcpTokenPath?.trim()) errors.push("request runtime mcpTokenPath is required");
  if (parsedDebugBase && parsedMcpBase && parsedDebugBase.port === parsedMcpBase.port) {
    errors.push("request runtime Debug API and MCP ports must be distinct");
  }
  if (!/^[a-f0-9]{64}$/.test(request.runtime?.executableSha256 ?? "")) errors.push("request runtime executableSha256 must be 64 lowercase hex characters");
  if (!request.runtime?.installedPayloadPath?.trim()) errors.push("request runtime installedPayloadPath is required");
  if (!/^[a-f0-9]{64}$/.test(request.runtime?.installedManifestSha256 ?? "")) {
    errors.push("request runtime installedManifestSha256 must be 64 lowercase hex characters");
  }
  if (request.platform === "windows-installed") {
    if (request.runtime?.posixNative) errors.push("POSIX native runtime binding is not valid for a Windows request");
    if (!request.runtime?.windowsNative) {
      errors.push("Windows driver requests require native process and listener binding");
    } else {
      errors.push(...validateReleaseSurfaceWindowsRuntimeBinding(request.runtime.windowsNative));
      if (request.runtime.windowsNative.process.pid !== request.runtime.processId) errors.push("Windows runtime binding PID does not match request processId");
      if (parsedDebugBase && request.runtime.windowsNative.listener.port !== Number(parsedDebugBase.port)) {
        errors.push("Windows runtime binding port does not match request debugBase");
      }
      if (request.runtime.windowsNative.process.imageSha256 !== request.runtime.executableSha256) {
        errors.push("Windows runtime binding hash does not match request executable");
      }
      if (normalizeWindowsPath(request.runtime.windowsNative.process.imagePath)
        !== normalizeWindowsPath(request.runtime.installedPayloadPath)) {
        errors.push("Windows runtime binding path does not match installed payload");
      }
    }
  } else {
    if (request.runtime?.windowsNative) {
      errors.push("Windows native runtime binding is not valid for a non-Windows request");
    }
    if (!request.runtime?.posixNative) {
      errors.push("Linux and macOS driver requests require native process and listener binding");
    } else {
      errors.push(...validateReleaseSurfacePosixRuntimeBinding(request.runtime.posixNative));
      const expectedPlatform = request.platform === "linux-installed" ? "linux" : "macos";
      if (request.runtime.posixNative.platform !== expectedPlatform) errors.push("POSIX runtime binding platform does not match request");
      if (request.runtime.posixNative.process.pid !== request.runtime.processId) errors.push("POSIX runtime binding PID does not match request processId");
      if (parsedDebugBase && request.runtime.posixNative.listener.port !== Number(parsedDebugBase.port)) {
        errors.push("POSIX runtime binding port does not match request debugBase");
      }
      if (request.runtime.posixNative.process.imageSha256 !== request.runtime.executableSha256) {
        errors.push("POSIX runtime binding hash does not match request executable");
      }
      if (request.runtime.posixNative.process.imagePathSha256
        !== releaseSurfacePosixPathDigest(request.runtime.installedPayloadPath)) {
        errors.push("POSIX runtime binding path identity does not match installed payload");
      }
    }
  }
  if (manifest.invocationTransport === "native-webdriver"
    || manifest.invocationTransport === "process-cli-with-fixture-webdriver") {
    validateNativeWebDriverRequestBinding(request.nativeWebDriver, errors);
    if (request.macosNativeInput) errors.push("native WebDriver drivers must not receive a macOS native-input helper");
  } else if (manifest.invocationTransport === "native-installed-input-with-fixture-webdriver") {
    validateNativeWebDriverRequestBinding(request.nativeWebDriver, errors);
    if (request.platform === "macos-installed") {
      errors.push(...validateReleaseSurfaceMacosNativeInputRequestBinding({
        binding: request.macosNativeInput,
        debugTokenPath: request.runtime?.debugTokenPath ?? "",
      }));
    } else if (request.macosNativeInput) {
      errors.push("non-macOS fixture-WebDriver installed-input drivers must not receive a macOS native-input helper");
    }
  } else if (manifest.invocationTransport === "native-installed-input" && request.platform === "macos-installed") {
    if (request.nativeWebDriver) errors.push("macOS native-input drivers must not receive a native WebDriver session");
    errors.push(...validateReleaseSurfaceMacosNativeInputRequestBinding({
      binding: request.macosNativeInput,
      debugTokenPath: request.runtime?.debugTokenPath ?? "",
    }));
  } else if (manifest.invocationTransport === "native-installed-input") {
    validateNativeWebDriverRequestBinding(request.nativeWebDriver, errors);
    if (request.macosNativeInput) errors.push("non-macOS installed-input drivers must not receive a macOS native-input helper");
  } else {
    if (request.nativeWebDriver) errors.push("non-WebDriver drivers must not receive a native WebDriver session");
    if (request.macosNativeInput) errors.push("non-native-input drivers must not receive a macOS native-input helper");
  }
  if (!Array.isArray(request.assignments) || request.assignments.length === 0) errors.push("request must contain at least one exact surface assignment");

  const ids = new Set<string>();
  for (const assignment of request.assignments ?? []) {
    rejectUnknownKeys(assignment, [
      "surface", "fixtureId", "expectedEffect", "oracleId", "cleanupId",
    ], `assignment ${String(assignment?.surface?.id ?? "unknown")}`, errors);
    const id = assignment.surface?.id;
    if (!id?.trim()) errors.push("assignment surface id is required");
    else if (ids.has(id)) errors.push(`assignment surface ${id} appears more than once`);
    else ids.add(id);
    if (assignment.surface?.kind !== manifest.kind) errors.push(`assignment ${id ?? "unknown"} kind must be ${manifest.kind}`);
    if (!assignment.surface?.platforms?.includes(request.platform)) errors.push(`assignment ${id ?? "unknown"} does not apply to ${request.platform}`);
    if (!manifest.supportedFixtures.includes(assignment.fixtureId)) errors.push(`assignment ${id ?? "unknown"} uses unsupported fixture ${assignment.fixtureId}`);
    if (!assignment.expectedEffect?.trim()) errors.push(`assignment ${id ?? "unknown"} expectedEffect is required`);
    if (!manifest.supportedOracles.includes(assignment.oracleId)) errors.push(`assignment ${id ?? "unknown"} uses unsupported oracle ${assignment.oracleId}`);
    if (!manifest.supportedCleanups.includes(assignment.cleanupId)) errors.push(`assignment ${id ?? "unknown"} uses unsupported cleanup ${assignment.cleanupId}`);
  }
  return errors;
}

export function validateReleaseSurfaceDriverReport(
  request: ReleaseSurfaceDriverRequest,
  report: ReleaseSurfaceDriverReport,
): string[] {
  const errors: string[] = [];
  rejectUnknownKeys(report, [
    "schema", "mode", "driverId", "driverKind", "platform", "sourceCommit", "version",
    "inventoryDigest", "artifactSha256", "controller", "runtime", "nativeWebDriver", "macosNativeInput",
    "startedAt", "completedAt", "outcomes",
  ], "report", errors);
  if (report.schema !== RELEASE_SURFACE_DRIVER_REPORT_SCHEMA) errors.push(`report schema must be ${RELEASE_SURFACE_DRIVER_REPORT_SCHEMA}`);
  for (const [field, expected, actual] of [
    ["mode", request.mode, report.mode],
    ["driverId", request.driverId, report.driverId],
    ["driverKind", request.driverKind, report.driverKind],
    ["platform", request.platform, report.platform],
    ["sourceCommit", request.sourceCommit, report.sourceCommit],
    ["version", request.version, report.version],
    ["inventoryDigest", request.inventoryDigest, report.inventoryDigest],
    ["artifactSha256", request.artifact.sha256, report.artifactSha256],
  ] as const) {
    if (actual !== expected) errors.push(`report ${field} must match the exact request`);
  }
  if (JSON.stringify(report.runtime) !== JSON.stringify(request.runtime)) {
    errors.push("report runtime must match the exact candidate process request");
  }
  if (JSON.stringify(report.controller) !== JSON.stringify(request.controller)) {
    errors.push("report controller must match the exact frozen controller request");
  }
  if (JSON.stringify(report.nativeWebDriver) !== JSON.stringify(request.nativeWebDriver)) {
    errors.push("report nativeWebDriver must match the exact bound session request");
  }
  if (JSON.stringify(report.macosNativeInput) !== JSON.stringify(request.macosNativeInput)) {
    errors.push("report macosNativeInput must match the exact bound helper request");
  }
  if (!validIsoRange(report.startedAt, report.completedAt)) errors.push("report timestamps must be valid and ordered");

  const requestedAssignments = new Map(
    (Array.isArray(request.assignments) ? request.assignments : []).map((assignment) => [assignment.surface.id, assignment]),
  );
  const requestedIds = new Set(requestedAssignments.keys());
  const outcomes = new Map<string, ReleaseSurfaceDriverOutcome>();
  if (!Array.isArray(report.outcomes)) errors.push("report outcomes must be an array");
  for (const outcome of Array.isArray(report.outcomes) ? report.outcomes : []) {
    rejectUnknownKeys(outcome, [
      "id", "expectedEffect", "oracleId", "present", "invoke", "effect", "cleanup",
      "cleanupEvidence", "observedEffect", "error",
    ], `report outcome ${String(outcome?.id ?? "unknown")}`, errors);
    if (outcomes.has(outcome.id)) errors.push(`report outcome ${outcome.id} appears more than once`);
    else outcomes.set(outcome.id, outcome);
    if (!requestedIds.has(outcome.id)) errors.push(`report outcome ${outcome.id} was not requested`);
    const assignment = requestedAssignments.get(outcome.id);
    if (assignment) {
      if (outcome.expectedEffect !== assignment.expectedEffect) {
        errors.push(`report outcome ${outcome.id} expectedEffect must match the exact assignment`);
      }
      if (outcome.oracleId !== assignment.oracleId) {
        errors.push(`report outcome ${outcome.id} oracleId must match the exact assignment`);
      }
      const cleanupEvidence = outcome.cleanupEvidence;
      rejectUnknownKeys(cleanupEvidence, [
        "cleanupId", "status", "proofSha256", "privatePayloadRetained",
      ], `report outcome ${outcome.id} cleanup evidence`, errors);
      if (cleanupEvidence?.cleanupId !== assignment.cleanupId) {
        errors.push(`report outcome ${outcome.id} cleanupId must match the exact assignment`);
      }
      if (cleanupEvidence?.status !== outcome.cleanup) {
        errors.push(`report outcome ${outcome.id} cleanup evidence status must match the cleanup verdict`);
      }
      if (cleanupEvidence?.privatePayloadRetained !== false) {
        errors.push(`report outcome ${outcome.id} cleanup evidence must not retain private payloads`);
      }
      const expectedProof = releaseSurfaceCleanupProofSha256(request, outcome.id, assignment.cleanupId, outcome.cleanup);
      if (cleanupEvidence?.proofSha256 !== expectedProof) {
        errors.push(`report outcome ${outcome.id} cleanup proof does not match the exact request and verdict`);
      }
    }
    if (!outcome.oracleId?.trim()) errors.push(`report outcome ${outcome.id} must name the effect oracle`);
    else if (!/^[a-z0-9][a-z0-9:._/-]*$/i.test(outcome.oracleId)) {
      errors.push(`report outcome ${outcome.id} oracleId contains unsupported characters`);
    }
    if (!boundedPublicNarrative(outcome.observedEffect, 2_048)) {
      errors.push(`report outcome ${outcome.id} must contain one bounded public-safe observed effect`);
    }
    const actionVerdicts = [outcome.present, outcome.invoke, outcome.effect];
    if (actionVerdicts.some((verdict) => verdict !== "pass" && verdict !== "fail")
      || !(["pass", "fail", "deferred-candidate-teardown"] as string[]).includes(outcome.cleanup)) {
      errors.push(`report outcome ${outcome.id} contains an invalid verdict`);
    }
    const requiresCandidateTeardown = Boolean(assignment && candidateTeardownCleanupRequired(assignment.cleanupId));
    if (requiresCandidateTeardown && outcome.cleanup === "pass") {
      errors.push(`report outcome ${outcome.id} cannot pass candidate teardown while the candidate is still live`);
    }
    if (!requiresCandidateTeardown && outcome.cleanup === "deferred-candidate-teardown") {
      errors.push(`report outcome ${outcome.id} defers candidate teardown for an unrelated cleanup`);
    }
    if (outcome.cleanup === "deferred-candidate-teardown" && actionVerdicts.some((verdict) => verdict !== "pass")) {
      errors.push(`report outcome ${outcome.id} cannot defer cleanup after a failed action verdict`);
    }
    const failed = actionVerdicts.includes("fail") || outcome.cleanup === "fail";
    if (failed && !/^redacted-error-sha256:[a-f0-9]{64}$/.test(outcome.error ?? "")) {
      errors.push(`failed report outcome ${outcome.id} must include only a redacted error identity`);
    }
    if (!failed && outcome.error !== undefined) {
      errors.push(`passing report outcome ${outcome.id} must not include an error payload`);
    }
  }
  for (const id of requestedIds) {
    if (!outcomes.has(id)) errors.push(`report is missing requested outcome ${id}`);
  }
  return errors;
}

function validateNativeWebDriverRequestBinding(
  value: ReleaseSurfaceWebDriverRequestBinding | undefined,
  errors: string[],
): void {
  if (!value) {
    errors.push("native WebDriver drivers require a same-process session binding");
    return;
  }
  rejectUnknownKeys(value, ["base", "sessionId", "evidence"], "native WebDriver binding", errors);
  rejectUnknownKeys(value.evidence, ["basename", "sha256", "bytes"], "native WebDriver binding evidence", errors);
  if (!parseExactReleaseSurfaceWebDriverBase(value.base)) {
    errors.push("native WebDriver base must be an exact http://127.0.0.1:<port> origin");
  }
  if (!/^[a-zA-Z0-9._:-]{8,256}$/.test(value.sessionId ?? "")) {
    errors.push("native WebDriver sessionId must be a bounded opaque identifier");
  }
  if (!value.evidence?.basename?.trim()
    || !/^[a-f0-9]{64}$/.test(value.evidence?.sha256 ?? "")
    || !Number.isSafeInteger(value.evidence?.bytes)
    || value.evidence.bytes <= 0) {
    errors.push("native WebDriver binding evidence identity is invalid");
  }
}

export function releaseSurfaceDriverReportPassed(report: ReleaseSurfaceDriverReport): boolean {
  return Array.isArray(report.outcomes) && report.outcomes.length > 0 && report.outcomes.every((outcome) => (
    outcome.present === "pass"
    && outcome.invoke === "pass"
    && outcome.effect === "pass"
    && outcome.cleanup === "pass"
  ));
}

export function releaseSurfaceDriverPhaseReportPassed(report: ReleaseSurfaceDriverReport): boolean {
  return Array.isArray(report.outcomes) && report.outcomes.length > 0 && report.outcomes.every((outcome) => (
    outcome.present === "pass"
    && outcome.invoke === "pass"
    && outcome.effect === "pass"
    && (outcome.cleanup === "pass" || outcome.cleanup === "deferred-candidate-teardown")
  ));
}

export function candidateTeardownCleanupRequired(cleanupId: string): boolean {
  return CANDIDATE_TEARDOWN_CLEANUP_IDS.has(cleanupId);
}

export function sealReleaseSurfaceDriverReport(
  request: ReleaseSurfaceDriverRequest,
  report: ReleaseSurfaceDriverReport,
): ReleaseSurfaceDriverReport {
  return {
    ...report,
    controller: request.controller,
    outcomes: (Array.isArray(report.outcomes) ? report.outcomes : []).map((outcome) => {
      const assignment = request.assignments.find((row) => row.surface.id === outcome.id);
      const error = outcome.error?.trim();
      const actionFailed = [outcome.present, outcome.invoke, outcome.effect].includes("fail");
      const requiresCandidateTeardown = Boolean(
        assignment && candidateTeardownCleanupRequired(assignment.cleanupId),
      );
      let cleanup = requiresCandidateTeardown && outcome.cleanup === "pass"
        ? actionFailed
          ? "fail" as const
          : "deferred-candidate-teardown" as const
        : outcome.cleanup;
      // A driver may complete its visible effect and then encounter a
      // post-effect restoration or fixture error. Never let that raw error
      // coexist with an all-pass outcome: preserve the completed action
      // verdicts, fail cleanup, and retain only the redacted error identity.
      if (error && !actionFailed && cleanup !== "fail") cleanup = "fail";
      const failed = actionFailed || cleanup === "fail";
      return {
        ...outcome,
        cleanup,
        observedEffect: failed
          ? "Requested effect was not fully verified; private failure details were not retained."
          : outcome.observedEffect,
        ...(assignment ? {
          cleanupEvidence: {
            cleanupId: assignment.cleanupId,
            status: cleanup,
            proofSha256: releaseSurfaceCleanupProofSha256(request, outcome.id, assignment.cleanupId, cleanup),
            privatePayloadRetained: false as const,
          },
        } : {}),
        ...(error ? { error: `redacted-error-sha256:${sha256(error)}` } : { error: undefined }),
      };
    }),
  };
}

export function releaseSurfaceCleanupProofSha256(
  request: ReleaseSurfaceDriverRequest,
  outcomeId: string,
  cleanupId: string,
  status: ReleaseSurfaceDriverCleanupVerdict,
): string {
  return sha256(JSON.stringify({
    schema: "shellx/release-surface-cleanup-proof@1",
    sourceCommit: request.sourceCommit,
    artifactSha256: request.artifact.sha256,
    installedManifestSha256: request.runtime.installedManifestSha256,
    installedExecutableSha256: request.runtime.executableSha256,
    processId: request.runtime.processId,
    instanceId: request.runtime.instanceId,
    controllerTreeOid: request.controller.sourceTreeOid,
    controllerEntrypointSha256: request.controller.entrypoint.sha256,
    driverId: request.driverId,
    outcomeId,
    cleanupId,
    status,
  }));
}

export function completionTimestamp(startedAt: string, now = Date.now()): string {
  const started = Date.parse(startedAt);
  const completed = Number.isFinite(started) ? Math.max(started, now) : now;
  return new Date(completed).toISOString();
}

function validIsoRange(startedAt: string, completedAt: string): boolean {
  const start = Date.parse(startedAt);
  const end = Date.parse(completedAt);
  return Number.isFinite(start) && Number.isFinite(end) && end >= start;
}

function normalizeWindowsPath(value: string | undefined): string {
  return (value ?? "").replaceAll("/", "\\").replace(/\\+$/, "").toLowerCase();
}

function rejectUnknownKeys(
  value: unknown,
  allowed: readonly string[],
  label: string,
  errors: string[],
): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    errors.push(`${label} must be an object`);
    return;
  }
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) errors.push(`${label} contains undeclared field ${key}`);
  }
}

function boundedPublicNarrative(value: string | undefined, maxBytes: number): boolean {
  return Boolean(value?.trim())
    && value === value?.trim()
    && Buffer.byteLength(value ?? "") <= maxBytes
    && !/[\r\n\0]/.test(value ?? "")
    && !/Bearer\s+[A-Za-z0-9._~+/=-]{20,}/i.test(value ?? "")
    && !/(token|secret)(\s*[=:]\s*)[^\s;,]+/i.test(value ?? "");
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
