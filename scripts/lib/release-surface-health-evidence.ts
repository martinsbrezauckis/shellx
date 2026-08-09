import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { ReleaseSurfaceCandidateAttestation } from "./release-surface-candidate-attestation";
import type { ReleaseSurfaceScenarioReport } from "./release-surface-scenario-report";

export const RELEASE_SURFACE_HEALTH_EVIDENCE_SCHEMA = "shellx/release-surface-health-evidence@1";
export const RELEASE_SURFACE_HEALTH_COLLECTOR_ID = "shellx-release-health-driver@1";

export interface ReleaseSurfaceHealthEvidence {
  schema: typeof RELEASE_SURFACE_HEALTH_EVIDENCE_SCHEMA;
  mode: "final-frozen-candidate";
  collector: {
    id: typeof RELEASE_SURFACE_HEALTH_COLLECTOR_ID;
    sourceCommit: string;
    startedAt: string;
    completedAt: string;
  };
  candidate: {
    platform: ReleaseSurfaceCandidateAttestation["platform"];
    sourceCommit: string;
    version: string;
    artifactSha256: string;
    processId: number;
    instanceId: string;
    debugBase: string;
  };
  startup: {
    observedAt: string;
    responseSha256: string;
    responseBytes: number;
    response: unknown;
  };
  links: {
    scope: "installed-driver-discovered-rendered-app-links";
    startedAt: string;
    completedAt: string;
    discovery: {
      collectorId: "installed-ui-rendered-link-discovery@1";
      startedAt: string;
      completedAt: string;
      discoveredCount: number;
      identitySetSha256: string;
      gapCount: number;
    };
    checkedCount: number;
    brokenLinks: number;
    observations: Array<{
      sourceSurfaceId: string;
      hrefSha256: string;
      result: "ok" | "broken";
      observedAt: string;
    }>;
  };
  console: {
    scope: "installed-driver-console-subscription";
    startedAt: string;
    completedAt: string;
    subscription: {
      collectorId: "installed-webview-console-subscription@1";
      openedAt: string;
      closedAt: string;
      gapCount: number;
    };
    observedEvents: number;
    unexpectedConsoleErrors: number;
    observations: Array<{
      level: string;
      messageSha256: string;
      classification: "expected" | "unexpected";
      observedAt: string;
    }>;
  };
  shutdown: {
    requestedAt: string;
    observedAt: string;
    processId: number;
    mechanism: string;
    processAbsent: true;
    elapsedMs: number;
  };
}

export function loadReleaseSurfaceHealthEvidence(path: string): ReleaseSurfaceHealthEvidence {
  return JSON.parse(readFileSync(path, "utf8")) as ReleaseSurfaceHealthEvidence;
}

export function validateReleaseSurfaceHealthEvidence(input: {
  evidence: ReleaseSurfaceHealthEvidence;
  candidate: ReleaseSurfaceCandidateAttestation;
  scenario: ReleaseSurfaceScenarioReport;
  knownSurfaceIds?: ReadonlySet<string>;
  expectedLinkSurfaceIds?: ReadonlySet<string>;
}): string[] {
  const { evidence, candidate, scenario } = input;
  const errors: string[] = [];
  if (evidence?.schema !== RELEASE_SURFACE_HEALTH_EVIDENCE_SCHEMA) {
    errors.push(`health evidence schema must be ${RELEASE_SURFACE_HEALTH_EVIDENCE_SCHEMA}`);
  }
  if (evidence?.mode !== "final-frozen-candidate") errors.push("health evidence mode is invalid");
  if (evidence?.collector?.id !== RELEASE_SURFACE_HEALTH_COLLECTOR_ID) errors.push("health evidence collector id is invalid");
  if (evidence?.collector?.sourceCommit !== candidate.sourceCommit) errors.push("health evidence collector source commit drifted");
  if (!validIsoRange(evidence?.collector?.startedAt, evidence?.collector?.completedAt)) {
    errors.push("health evidence collector timestamps are invalid");
  }
  const expectedCandidate: ReleaseSurfaceHealthEvidence["candidate"] = {
    platform: candidate.platform,
    sourceCommit: candidate.sourceCommit,
    version: candidate.version,
    artifactSha256: candidate.distributionArtifact.sha256,
    processId: candidate.runtime.processId,
    instanceId: candidate.runtime.instanceId,
    debugBase: candidate.runtime.debugBase,
  };
  if (JSON.stringify(evidence?.candidate) !== JSON.stringify(expectedCandidate)) {
    errors.push("health evidence candidate binding drifted");
  }
  validateStartup(evidence, candidate, errors);
  validateLinks(evidence, scenario, input.knownSurfaceIds, input.expectedLinkSurfaceIds, errors);
  validateConsole(evidence, scenario, errors);
  validateShutdown(evidence, candidate, scenario, errors);
  const collectorStart = Date.parse(evidence?.collector?.startedAt);
  const collectorEnd = Date.parse(evidence?.collector?.completedAt);
  const scenarioStart = Date.parse(scenario?.startedAt);
  const scenarioEnd = Date.parse(scenario?.completedAt);
  if ([collectorStart, collectorEnd, scenarioStart, scenarioEnd].every(Number.isFinite)
    && (collectorStart > scenarioStart || collectorEnd < scenarioEnd)) {
    errors.push("health evidence collector interval must enclose the scenario");
  }
  const startupAt = Date.parse(evidence?.startup?.observedAt);
  if ([collectorStart, collectorEnd, startupAt, scenarioStart].every(Number.isFinite)
    && (startupAt < collectorStart || startupAt > scenarioStart || startupAt > collectorEnd)) {
    errors.push("health startup observation must precede the scenario inside the collector interval");
  }
  return errors;
}

function validateStartup(
  evidence: ReleaseSurfaceHealthEvidence,
  candidate: ReleaseSurfaceCandidateAttestation,
  errors: string[],
): void {
  const startup = evidence?.startup;
  if (!validIso(startup?.observedAt)) errors.push("health startup timestamp is invalid");
  const identity = jsonIdentity(startup?.response);
  if (startup?.responseSha256 !== identity.sha256 || startup?.responseBytes !== identity.bytes) {
    errors.push("health startup response identity is invalid");
  }
  const response = isRecord(startup?.response) ? startup.response : {};
  if (Number(response.processId) !== candidate.runtime.processId
    || String(response.instanceId ?? "") !== candidate.runtime.instanceId
    || String(response.appVersion ?? response.app_version ?? "") !== candidate.version
    || String(response.buildCommit ?? response.build_commit ?? "") !== candidate.sourceCommit
    || Number(response.debugApiPort ?? response.debug_api_port) !== candidate.runtime.debugPort) {
    errors.push("health startup response does not identify the exact candidate");
  }
}

function validateLinks(
  evidence: ReleaseSurfaceHealthEvidence,
  scenario: ReleaseSurfaceScenarioReport,
  knownSurfaceIds: ReadonlySet<string> | undefined,
  expectedLinkSurfaceIds: ReadonlySet<string> | undefined,
  errors: string[],
): void {
  const links = evidence?.links;
  if (links?.scope !== "installed-driver-discovered-rendered-app-links") errors.push("health link scope is invalid");
  if (!validIsoRange(links?.startedAt, links?.completedAt)) errors.push("health link timestamps are invalid");
  if (!Array.isArray(links?.observations) || links.observations.length === 0
    || links.checkedCount !== links.observations.length) {
    errors.push("health link observations are incomplete");
    return;
  }
  let broken = 0;
  const identities = new Set<string>();
  for (const observation of links.observations) {
    if (!observation?.sourceSurfaceId?.trim() || !isSha256(observation?.hrefSha256)
      || !validIso(observation?.observedAt) || !["ok", "broken"].includes(observation?.result)) {
      errors.push("health link observation is invalid");
    }
    if (knownSurfaceIds && !knownSurfaceIds.has(observation.sourceSurfaceId)) {
      errors.push(`health link observation names unknown surface ${observation.sourceSurfaceId}`);
    }
    if (Date.parse(observation.observedAt) < Date.parse(links.startedAt)
      || Date.parse(observation.observedAt) > Date.parse(links.completedAt)) {
      errors.push("health link observation falls outside its capture interval");
    }
    const identity = `${observation.sourceSurfaceId}:${observation.hrefSha256}`;
    if (identities.has(identity)) errors.push("health link observation is duplicated");
    identities.add(identity);
    if (observation.result === "broken") broken += 1;
  }
  if (links.brokenLinks !== broken || scenario.health?.brokenLinks !== broken || broken !== 0) {
    errors.push("health link evidence must derive zero broken links");
  }
  if (expectedLinkSurfaceIds) {
    const observedSurfaceIds = new Set(links.observations.map((observation) => observation.sourceSurfaceId));
    const expected = [...expectedLinkSurfaceIds].sort();
    const observed = [...observedSurfaceIds].sort();
    if (JSON.stringify(observed) !== JSON.stringify(expected)) {
      errors.push("health link observations must cover the exact rendered link surface inventory");
    }
  }
  const discovery = links.discovery;
  const discoveredIdentitySha256 = createHash("sha256")
    .update(JSON.stringify([...identities].sort()))
    .digest("hex");
  if (discovery?.collectorId !== "installed-ui-rendered-link-discovery@1"
    || discovery?.startedAt !== links.startedAt || discovery?.completedAt !== links.completedAt
    || discovery?.discoveredCount !== identities.size
    || discovery?.identitySetSha256 !== discoveredIdentitySha256
    || discovery?.gapCount !== 0) {
    errors.push("health link observations do not equal the installed driver's discovered link set");
  }
  if (Date.parse(links.startedAt) < Date.parse(scenario.startedAt)
    || Date.parse(links.completedAt) > Date.parse(evidence.shutdown?.requestedAt)) {
    errors.push("health link capture must stay inside the live scenario before shutdown");
  }
}

function validateConsole(
  evidence: ReleaseSurfaceHealthEvidence,
  scenario: ReleaseSurfaceScenarioReport,
  errors: string[],
): void {
  const consoleEvidence = evidence?.console;
  if (consoleEvidence?.scope !== "installed-driver-console-subscription") errors.push("health console scope is invalid");
  if (!validIsoRange(consoleEvidence?.startedAt, consoleEvidence?.completedAt)) {
    errors.push("health console timestamps are invalid");
  }
  if (!Array.isArray(consoleEvidence?.observations)
    || consoleEvidence.observedEvents !== consoleEvidence.observations.length) {
    errors.push("health console observation count is invalid");
    return;
  }
  const subscription = consoleEvidence.subscription;
  if (subscription?.collectorId !== "installed-webview-console-subscription@1"
    || subscription?.openedAt !== consoleEvidence.startedAt
    || subscription?.closedAt !== consoleEvidence.completedAt
    || subscription?.gapCount !== 0) {
    errors.push("health console evidence lacks a complete installed-driver subscription");
  }
  let unexpected = 0;
  for (const observation of consoleEvidence.observations) {
    if (!observation?.level?.trim() || !isSha256(observation?.messageSha256)
      || !validIso(observation?.observedAt)
      || !["expected", "unexpected"].includes(observation?.classification)) {
      errors.push("health console observation is invalid");
    }
    if (Date.parse(observation.observedAt) < Date.parse(consoleEvidence.startedAt)
      || Date.parse(observation.observedAt) > Date.parse(consoleEvidence.completedAt)) {
      errors.push("health console observation falls outside its capture interval");
    }
    if (observation.classification === "unexpected") unexpected += 1;
  }
  if (consoleEvidence.unexpectedConsoleErrors !== unexpected
    || scenario.health?.unexpectedConsoleErrors !== unexpected || unexpected !== 0) {
    errors.push("health console evidence must derive zero unexpected errors");
  }
  if (Date.parse(consoleEvidence.startedAt) > Date.parse(scenario.startedAt)
    || Date.parse(consoleEvidence.completedAt) < Date.parse(scenario.completedAt)) {
    errors.push("health console observation window must enclose the scenario");
  }
  if (Date.parse(consoleEvidence.startedAt) < Date.parse(evidence.collector?.startedAt)
    || Date.parse(consoleEvidence.completedAt) > Date.parse(evidence.collector?.completedAt)) {
    errors.push("health console observation window must stay inside the collector interval");
  }
}

function validateShutdown(
  evidence: ReleaseSurfaceHealthEvidence,
  candidate: ReleaseSurfaceCandidateAttestation,
  scenario: ReleaseSurfaceScenarioReport,
  errors: string[],
): void {
  const shutdown = evidence?.shutdown;
  if (!validIsoRange(shutdown?.requestedAt, shutdown?.observedAt)) errors.push("health shutdown timestamps are invalid");
  if (shutdown?.processId !== candidate.runtime.processId || shutdown?.processAbsent !== true) {
    errors.push("health shutdown did not prove the exact candidate process absent");
  }
  if (!shutdown?.mechanism?.trim() || !Number.isSafeInteger(shutdown?.elapsedMs) || shutdown.elapsedMs < 0
    || shutdown.elapsedMs > 120_000) {
    errors.push("health shutdown observation is invalid");
  }
  const shutdownDeltaMs = Date.parse(shutdown?.observedAt) - Date.parse(shutdown?.requestedAt);
  if (!Number.isFinite(shutdownDeltaMs) || shutdown?.elapsedMs !== shutdownDeltaMs) {
    errors.push("health shutdown elapsedMs must equal its observed timestamp interval");
  }
  if (Number.isFinite(Date.parse(shutdown?.observedAt))
    && Date.parse(shutdown.observedAt) !== Date.parse(scenario.completedAt)) {
    errors.push("scenario completion must equal the observed candidate shutdown");
  }
  if (Number.isFinite(Date.parse(shutdown?.requestedAt))
    && Number.isFinite(Date.parse(evidence?.links?.completedAt))
    && Date.parse(shutdown.requestedAt) < Date.parse(evidence.links.completedAt)) {
    errors.push("candidate shutdown was requested before link capture completed");
  }
}

function jsonIdentity(value: unknown): { sha256: string; bytes: number } {
  const encoded = JSON.stringify(value);
  const bytes = Buffer.from(typeof encoded === "string" ? encoded : "");
  return { sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
}

function validIso(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function validIsoRange(start: unknown, end: unknown): boolean {
  return validIso(start) && validIso(end) && Date.parse(end) >= Date.parse(start);
}
