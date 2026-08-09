import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type {
  ConnectionProviderCapabilitySnapshot,
  ConnectionProviderScanEntry,
} from "../../src/components/ConnectionPicker";
import type { ReleaseSurfaceCandidateAttestation } from "./release-surface-candidate-attestation";
import {
  RELEASE_SURFACE_NORMALIZED_PROVIDER_EVENT_SCHEMA,
  RELEASE_SURFACE_PROVIDER_ROUTE_CANARY_ID,
  type ReleaseSurfaceProviderRoute,
} from "./release-surface-scenario-report";

export const RELEASE_SURFACE_PROVIDER_ROUTE_EVIDENCE_SCHEMA =
  "shellx/release-surface-provider-route-evidence@3";
export const RELEASE_SURFACE_PROVIDER_ROUTE_COLLECTOR_ID =
  "shellx-release-provider-route-collector@1";
export const RELEASE_SURFACE_PROVIDER_ROUTE_CANARY_TEXT =
  "SHELLX_PROVIDER_ROUTE_CANARY_V1";
const RELEASE_SURFACE_PROVIDER_IDS = ["grok", "codex-cli", "claude-code", "antigravity-cli"];

export interface ReleaseSurfaceProviderRawFrameDigest {
  ordinal: number;
  observedAtMs: number;
  channel: string;
  payloadSha256: string;
  payloadBytes: number;
  payload: unknown;
}

export interface ReleaseSurfaceProviderNormalizedEvent {
  schema: typeof RELEASE_SURFACE_NORMALIZED_PROVIDER_EVENT_SCHEMA;
  sequence: number;
  occurredAtMs: number;
  runId: string;
  providerId: string;
  kind: "started" | "text" | "completed" | "failed" | "aborted" | "other";
  nativeProtocol: string;
  sourceFrameSha256: string;
  textSha256?: string;
  canaryMatched?: boolean;
  exitCode?: number;
}

export interface ReleaseSurfaceProviderRouteEvidence {
  schema: typeof RELEASE_SURFACE_PROVIDER_ROUTE_EVIDENCE_SCHEMA;
  mode: "final-frozen-candidate";
  evidenceMode: "identity-only" | "live-canary";
  collector: {
    id: typeof RELEASE_SURFACE_PROVIDER_ROUTE_COLLECTOR_ID;
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
  healthBefore: ReleaseSurfaceProviderRouteHealth;
  healthAfter: ReleaseSurfaceProviderRouteHealth;
  eventStream: {
    transport: "not-opened" | "authenticated-websocket";
    lagWarnings: 0;
  };
  capabilitySnapshot: ConnectionProviderCapabilitySnapshot;
  route: Omit<ReleaseSurfaceProviderRoute, "evidence">;
  rawFrames: ReleaseSurfaceProviderRawFrameDigest[];
  normalizedEvents: ReleaseSurfaceProviderNormalizedEvent[];
  cleanup: {
    requested: boolean;
    noActiveProviderRun: boolean;
    tabId?: string;
    runId?: string;
    terminalState: "not-started" | "completed";
    terminalEventSha256?: string;
    stateEndpoint?: "/provider-sessions/state" | "/state/sessions";
    stateSha256?: string;
    stateBytes?: number;
    state?: unknown;
    observedAt: string;
    observed: string;
  };
}

export interface ReleaseSurfaceProviderRouteHealth {
  observedAt: string;
  processId: number;
  instanceId: string;
  appVersion: string;
  buildCommit: string;
  debugPort: number;
}

export function loadReleaseSurfaceProviderRouteEvidence(
  path: string,
): ReleaseSurfaceProviderRouteEvidence {
  return JSON.parse(readFileSync(path, "utf8")) as ReleaseSurfaceProviderRouteEvidence;
}

export function deriveReleaseSurfaceProviderNormalizedEvents(
  rawFrames: ReleaseSurfaceProviderRawFrameDigest[],
  providerId: string,
  nativeProtocol: string,
): ReleaseSurfaceProviderNormalizedEvent[] {
  if (providerId === "grok") return deriveGrokEvents(rawFrames, nativeProtocol);
  const reconstructedOutput = deriveReleaseSurfaceProviderOutputText(rawFrames, providerId);
  const lastTextOrdinal = rawFrames.reduce(
    (last, frame) => normalizedRawFrameText(frame, providerId) !== undefined ? frame.ordinal : last,
    -1,
  );
  const events: ReleaseSurfaceProviderNormalizedEvent[] = [];
  for (const frame of rawFrames) {
    const payload = isRecord(frame.payload) ? frame.payload : {};
    const rawKind = String(payload.kind ?? "other").toLowerCase();
    if (rawKind === "raw" || rawKind === "thinking") continue;
    const text = normalizedRawFrameText(frame, providerId);
    events.push({
      schema: RELEASE_SURFACE_NORMALIZED_PROVIDER_EVENT_SCHEMA,
      sequence: events.length + 1,
      occurredAtMs: Number(payload.occurredAtMs ?? frame.observedAtMs),
      runId: typeof payload.runId === "string" ? payload.runId : "",
      providerId: typeof payload.providerId === "string" ? payload.providerId : "",
      kind: normalizedProviderKind(rawKind),
      nativeProtocol,
      sourceFrameSha256: frame.payloadSha256,
      ...(text ? {
        textSha256: createPayloadSha256(Buffer.from(text)),
        canaryMatched: frame.ordinal === lastTextOrdinal
          && reconstructedOutput === RELEASE_SURFACE_PROVIDER_ROUTE_CANARY_TEXT,
      } : {}),
      ...(Number.isInteger(payload.exitCode) ? { exitCode: Number(payload.exitCode) } : {}),
    });
  }
  return events;
}

export function deriveReleaseSurfaceProviderOutputText(
  rawFrames: ReleaseSurfaceProviderRawFrameDigest[],
  providerId: string,
): string {
  return rawFrames
    .map((frame) => providerId === "grok" ? grokRawFrameText(frame) : normalizedRawFrameText(frame, providerId))
    .filter((text): text is string => text !== undefined)
    .join("");
}

export function validateReleaseSurfaceProviderRouteEvidence(input: {
  evidence: ReleaseSurfaceProviderRouteEvidence;
  candidate: ReleaseSurfaceCandidateAttestation;
  expectedRoute: ReleaseSurfaceProviderRoute;
}): string[] {
  const { evidence, candidate, expectedRoute } = input;
  const errors: string[] = [];
  const label = `provider route evidence ${expectedRoute.id}`;
  if (evidence?.schema !== RELEASE_SURFACE_PROVIDER_ROUTE_EVIDENCE_SCHEMA) {
    errors.push(`${label} schema must be ${RELEASE_SURFACE_PROVIDER_ROUTE_EVIDENCE_SCHEMA}`);
  }
  if (evidence?.mode !== "final-frozen-candidate") errors.push(`${label} mode is invalid`);
  if (evidence?.evidenceMode !== expectedRoute.evidenceMode) {
    errors.push(`${label} evidence mode does not match the declared route`);
  }
  if (evidence?.collector?.id !== RELEASE_SURFACE_PROVIDER_ROUTE_COLLECTOR_ID) {
    errors.push(`${label} collector id is invalid`);
  }
  if (evidence?.collector?.sourceCommit !== candidate.sourceCommit) {
    errors.push(`${label} collector source commit does not match the candidate`);
  }
  if (!validIsoRange(evidence?.collector?.startedAt, evidence?.collector?.completedAt)) {
    errors.push(`${label} collector timestamps are invalid`);
  }
  const expectedCandidate: ReleaseSurfaceProviderRouteEvidence["candidate"] = {
    platform: candidate.platform,
    sourceCommit: candidate.sourceCommit,
    version: candidate.version,
    artifactSha256: candidate.distributionArtifact.sha256,
    processId: candidate.runtime.processId,
    instanceId: candidate.runtime.instanceId,
    debugBase: candidate.runtime.debugBase,
  };
  if (JSON.stringify(evidence?.candidate) !== JSON.stringify(expectedCandidate)) {
    errors.push(`${label} candidate binding does not match the exact attested process`);
  }
  validateHealth(evidence?.healthBefore, candidate, "before", errors);
  validateHealth(evidence?.healthAfter, candidate, "after", errors);
  const expectedEventTransport = expectedRoute.evidenceMode === "live-canary"
    ? "authenticated-websocket" : "not-opened";
  if (evidence?.eventStream?.transport !== expectedEventTransport || evidence?.eventStream?.lagWarnings !== 0) {
    errors.push(`${label} event stream mode is inconsistent with its evidence mode`);
  }
  const beforeAt = Date.parse(evidence?.healthBefore?.observedAt);
  const afterAt = Date.parse(evidence?.healthAfter?.observedAt);
  const collectorStart = Date.parse(evidence?.collector?.startedAt);
  const collectorEnd = Date.parse(evidence?.collector?.completedAt);
  if ([beforeAt, afterAt, collectorStart, collectorEnd].every(Number.isFinite)
    && (beforeAt > collectorStart || afterAt < collectorEnd)) {
    errors.push(`${label} health observations must bracket collection`);
  }

  const expectedRouteWithoutEvidence = structuredClone(expectedRoute);
  const observedRouteWithoutEvidence = structuredClone(evidence?.route);
  if (expectedRouteWithoutEvidence) delete (expectedRouteWithoutEvidence as { evidence?: unknown }).evidence;
  if (JSON.stringify(observedRouteWithoutEvidence) !== JSON.stringify(expectedRouteWithoutEvidence)) {
    errors.push(`${label} derived route does not match the scenario summary`);
  }
  if (validIsoRange(expectedRoute?.startedAt, expectedRoute?.completedAt)
    && validIsoRange(evidence?.collector?.startedAt, evidence?.collector?.completedAt)
    && (Date.parse(expectedRoute.startedAt) < Date.parse(evidence.collector.startedAt)
      || Date.parse(expectedRoute.completedAt) > Date.parse(evidence.collector.completedAt))) {
    errors.push(`${label} route timestamps must stay inside the collector interval`);
  }

  validateCapabilitySnapshot(evidence?.capabilitySnapshot, expectedRoute, errors);
  if (expectedRoute.evidenceMode === "live-canary") {
    validateRawAndNormalizedEvents(evidence, expectedRoute, errors);
    if (evidence?.cleanup?.requested !== true || evidence?.cleanup?.noActiveProviderRun !== true) {
      errors.push(`${label} cleanup did not prove the route process is inactive`);
    }
    validateCleanup(evidence, expectedRoute, errors);
  } else {
    validateIdentityOnlyEvidence(evidence, expectedRoute, errors);
  }
  if (!validIso(evidence?.cleanup?.observedAt) || !evidence?.cleanup?.observed?.trim()) {
    errors.push(`${label} cleanup observation is invalid`);
  }
  if (Number.isFinite(Date.parse(evidence?.cleanup?.observedAt))
    && Number.isFinite(Date.parse(expectedRoute?.completedAt))
    && Date.parse(evidence.cleanup.observedAt) > Date.parse(expectedRoute.completedAt)) {
    errors.push(`${label} cleanup observation follows route completion`);
  }
  if (Number.isFinite(Date.parse(evidence?.cleanup?.observedAt))
    && Number.isFinite(Date.parse(evidence?.collector?.completedAt))
    && Date.parse(evidence.cleanup.observedAt) > Date.parse(evidence.collector.completedAt)) {
    errors.push(`${label} cleanup observation falls outside the collector interval`);
  }
  return errors;
}

function validateIdentityOnlyEvidence(
  evidence: ReleaseSurfaceProviderRouteEvidence,
  route: ReleaseSurfaceProviderRoute,
  errors: string[],
): void {
  const label = `provider route evidence ${route.id}`;
  if (evidence.rawFrames?.length !== 0 || evidence.normalizedEvents?.length !== 0) {
    errors.push(`${label} identity-only evidence must not contain provider output frames`);
  }
  const cleanup = evidence.cleanup;
  if (cleanup?.requested !== false || cleanup?.noActiveProviderRun !== true
    || cleanup?.terminalState !== "not-started") {
    errors.push(`${label} identity-only evidence must prove that no provider run was started`);
  }
  for (const field of ["tabId", "runId", "terminalEventSha256", "stateEndpoint", "stateSha256", "stateBytes", "state"] as const) {
    if (cleanup?.[field] !== undefined) errors.push(`${label} identity-only cleanup must omit ${field}`);
  }
}

function validateHealth(
  health: ReleaseSurfaceProviderRouteHealth | undefined,
  candidate: ReleaseSurfaceCandidateAttestation,
  phase: string,
  errors: string[],
): void {
  const label = `provider route ${phase} health`;
  if (!validIso(health?.observedAt)) errors.push(`${label} timestamp is invalid`);
  if (health?.processId !== candidate.runtime.processId) errors.push(`${label} processId drifted`);
  if (health?.instanceId !== candidate.runtime.instanceId) errors.push(`${label} instanceId drifted`);
  if (health?.appVersion !== candidate.version) errors.push(`${label} appVersion drifted`);
  if (health?.buildCommit !== candidate.sourceCommit) errors.push(`${label} buildCommit drifted`);
  if (health?.debugPort !== candidate.runtime.debugPort) errors.push(`${label} debugPort drifted`);
}

function validateCapabilitySnapshot(
  snapshot: ConnectionProviderCapabilitySnapshot | undefined,
  route: ReleaseSurfaceProviderRoute,
  errors: string[],
): void {
  const label = `provider route evidence ${route.id}`;
  if (snapshot?.schemaVersion !== "shellx.provider-capability-snapshot.v2") {
    errors.push(`${label} capability snapshot schema is invalid`);
    return;
  }
  if (!Number.isFinite(snapshot.generatedAtMs) || !Number.isFinite(snapshot.freshUntilMs)
    || snapshot.freshUntilMs - snapshot.generatedAtMs !== 60_000) {
    errors.push(`${label} capability snapshot timestamps are invalid`);
  }
  const startedAtMs = Date.parse(route.startedAt);
  if (snapshot.generatedAtMs > startedAtMs || snapshot.freshUntilMs < startedAtMs) {
    errors.push(`${label} capability snapshot was not fresh when the route started`);
  }
  if (snapshot.target?.transport !== route.target.transport) {
    errors.push(`${label} capability target transport does not match the route`);
  }
  const expectedRuntime = route.target.runtimeKind === "windows-native"
    ? "windows"
    : route.target.runtimeKind === "wsl" && route.target.transport === "ssh"
      ? "windows_wsl"
      : "posix";
  if (snapshot.target?.runtime !== expectedRuntime) {
    errors.push(`${label} capability target runtime does not match the route`);
  }
  if ((snapshot.target?.wslDistro ?? undefined) !== (route.target.wslDistro ?? undefined)) {
    errors.push(`${label} capability WSL distro does not match the route`);
  }
  const expectedFingerprint = createPayloadSha256(Buffer.from(JSON.stringify({
    target: snapshot.target,
    providers: (snapshot.providers ?? []).map((row) => ({
      providerId: row.providerId,
      binarySha256: row.binarySha256,
      binaryBytes: row.binaryBytes,
    })).sort((a, b) => a.providerId.localeCompare(b.providerId)),
  })));
  if (route.target.hostFingerprintSha256 !== expectedFingerprint) {
    errors.push(`${label} target fingerprint is not derived from the fresh capability snapshot`);
  }
  const providerIds = snapshot.providers?.map((row) => row.providerId).sort() ?? [];
  if (new Set(providerIds).size !== providerIds.length
    || JSON.stringify(providerIds) !== JSON.stringify([...RELEASE_SURFACE_PROVIDER_IDS].sort())) {
    errors.push(`${label} capability snapshot must contain each supported provider exactly once`);
  }
  for (const row of snapshot.providers ?? []) {
    if (row.targetKey !== snapshot.target.key) errors.push(`${label} capability row ${row.providerId} belongs to another target`);
  }
  const provider = snapshot.providers?.find((row) => row.providerId === route.providerId);
  validateReadyCapabilityProvider(provider, route, errors);
}

function validateReadyCapabilityProvider(
  provider: ConnectionProviderScanEntry | undefined,
  route: ReleaseSurfaceProviderRoute,
  errors: string[],
): void {
  const label = `provider route evidence ${route.id}`;
  if (!provider || provider.status !== "ready" || provider.canRun !== true) {
    errors.push(`${label} capability row is not ready`);
    return;
  }
  if (provider.binary !== route.provider.executable
    || provider.binarySha256 !== route.provider.executableSha256
    || provider.binaryBytes !== route.provider.executableBytes
    || provider.version !== route.provider.version) {
    errors.push(`${label} executable identity does not match the fresh capability row`);
  }
  if (!Number.isFinite(provider.checkedAtMs)) errors.push(`${label} capability checkedAtMs is invalid`);
  else if (provider.checkedAtMs > Date.parse(route.startedAt)) {
    errors.push(`${label} capability row was checked after route execution started`);
  }
}

function validateRawAndNormalizedEvents(
  evidence: ReleaseSurfaceProviderRouteEvidence,
  route: ReleaseSurfaceProviderRoute,
  errors: string[],
): void {
  const label = `provider route evidence ${route.id}`;
  if (!Array.isArray(evidence?.rawFrames) || evidence.rawFrames.length === 0) {
    errors.push(`${label} raw frame digests are missing`);
    return;
  }
  const rawHashes = new Set<string>();
  const rawFramesByHash = new Map<string, ReleaseSurfaceProviderRawFrameDigest>();
  evidence.rawFrames.forEach((frame, index) => {
    if (frame.ordinal !== index + 1) errors.push(`${label} raw frame ordinals are not contiguous`);
    if (!Number.isSafeInteger(frame.observedAtMs) || frame.observedAtMs <= 0) errors.push(`${label} raw frame timestamp is invalid`);
    else if (frame.observedAtMs < Date.parse(route.startedAt) || frame.observedAtMs > Date.parse(route.completedAt)) {
      errors.push(`${label} raw frame timestamp falls outside route execution`);
    }
    if (!frame.channel?.trim()) errors.push(`${label} raw frame channel is missing`);
    const encodedPayload = JSON.stringify(frame.payload);
    if (typeof encodedPayload !== "string") {
      errors.push(`${label} raw frame payload is not JSON serializable`);
      return;
    }
    const payloadBytes = Buffer.from(encodedPayload);
    const payloadSha256 = createPayloadSha256(payloadBytes);
    if (!isSha256(frame.payloadSha256) || !Number.isSafeInteger(frame.payloadBytes) || frame.payloadBytes <= 0
      || frame.payloadSha256 !== payloadSha256 || frame.payloadBytes !== payloadBytes.length) {
      errors.push(`${label} raw frame identity is invalid`);
    }
    rawHashes.add(frame.payloadSha256);
    rawFramesByHash.set(frame.payloadSha256, frame);
    if (route.providerId === "grok") validateGrokRawFrame(frame, index, evidence, route, errors);
    else validateProviderSessionRawFrame(frame, index, evidence, route, errors);
  });
  if (route.providerId === "grok") {
    const promptCompleteFrames = evidence.rawFrames.filter((frame) => frame.channel === "prompt-complete");
    if (promptCompleteFrames.length !== 1 || evidence.rawFrames.at(-1)?.channel !== "prompt-complete") {
      errors.push(`${label} Grok raw stream must end with exactly one prompt-complete frame`);
    }
  }
  if (!Array.isArray(evidence.normalizedEvents) || evidence.normalizedEvents.length < 3) {
    errors.push(`${label} normalized events are missing`);
    return;
  }
  try {
    const derived = deriveReleaseSurfaceProviderNormalizedEvents(
      evidence.rawFrames,
      route.providerId,
      route.stream.nativeProtocol,
    );
    if (JSON.stringify(derived) !== JSON.stringify(evidence.normalizedEvents)) {
      errors.push(`${label} normalized events are not deterministically derived from raw payloads`);
    }
  } catch {
    errors.push(`${label} normalized events could not be derived from raw payloads`);
  }
  const runIds = new Set<string>();
  const kinds = new Set<string>();
  let canaryMatched = false;
  let canaryMatchCount = 0;
  evidence.normalizedEvents.forEach((event, index) => {
    if (event.schema !== RELEASE_SURFACE_NORMALIZED_PROVIDER_EVENT_SCHEMA) errors.push(`${label} normalized event schema is invalid`);
    if (event.sequence !== index + 1) errors.push(`${label} normalized event sequence contains a gap`);
    if (!Number.isSafeInteger(event.occurredAtMs) || event.occurredAtMs <= 0) errors.push(`${label} normalized event timestamp is invalid`);
    if (!event.runId?.trim()) errors.push(`${label} normalized event runId is missing`);
    else runIds.add(event.runId);
    if (event.providerId !== route.providerId) errors.push(`${label} normalized event provider drifted`);
    if (event.nativeProtocol !== route.stream.nativeProtocol) errors.push(`${label} normalized event native protocol drifted`);
    if (!rawHashes.has(event.sourceFrameSha256)) errors.push(`${label} normalized event is not bound to a raw frame digest`);
    const source = rawFramesByHash.get(event.sourceFrameSha256);
    if (source && event.occurredAtMs !== source.observedAtMs) errors.push(`${label} normalized event timestamp drifted from its raw frame`);
    if (event.canaryMatched === true) {
      const sourceText = source
        ? route.providerId === "grok" ? grokRawFrameText(source) : normalizedRawFrameText(source, route.providerId)
        : undefined;
      if (event.kind !== "text" || sourceText === undefined
        || event.textSha256 !== createPayloadSha256(Buffer.from(sourceText))) {
        errors.push(`${label} canary match is not derived from the exact bounded raw text`);
      } else {
        canaryMatched = true;
        canaryMatchCount += 1;
      }
    }
    kinds.add(event.kind);
  });
  if (runIds.size !== 1) errors.push(`${label} normalized events must belong to exactly one run`);
  const eventKinds = evidence.normalizedEvents.map((event) => event.kind);
  const startedCount = eventKinds.filter((kind) => kind === "started").length;
  const completedCount = eventKinds.filter((kind) => kind === "completed").length;
  const textCount = eventKinds.filter((kind) => kind === "text").length;
  const exactLifecycle = startedCount === 1
    && completedCount === 1
    && textCount >= 1
    && eventKinds[0] === "started"
    && eventKinds.at(-1) === "completed"
    && eventKinds.slice(1, -1).every((kind) => kind === "text");
  if (!exactLifecycle) errors.push(`${label} normalized lifecycle must be exactly started, assistant text, completed`);
  const terminal = evidence.normalizedEvents.at(-1);
  if (terminal?.kind !== "completed" || terminal.exitCode !== 0) {
    errors.push(`${label} final normalized event must be a successful completion with exit code zero`);
  }
  const reconstructedOutput = deriveReleaseSurfaceProviderOutputText(evidence.rawFrames, route.providerId);
  if (!canaryMatched || canaryMatchCount !== 1
    || reconstructedOutput !== RELEASE_SURFACE_PROVIDER_ROUTE_CANARY_TEXT) {
    errors.push(`${label} normalized evidence did not match the exact sole output ${RELEASE_SURFACE_PROVIDER_ROUTE_CANARY_ID}`);
  }
  if (route.stream.eventCount !== evidence.normalizedEvents.length) errors.push(`${label} scenario event count is not derived from raw evidence`);
  if (JSON.stringify(route.stream.observedEventKinds) !== JSON.stringify([...kinds])) {
    errors.push(`${label} scenario event kinds are not derived from normalized evidence`);
  }
  if (route.stream.gapCount !== 0 || route.stream.parseErrorCount !== 0) errors.push(`${label} scenario stream reports gaps or parse errors`);
}

function validateProviderSessionRawFrame(
  frame: ReleaseSurfaceProviderRawFrameDigest,
  index: number,
  evidence: ReleaseSurfaceProviderRouteEvidence,
  route: ReleaseSurfaceProviderRoute,
  errors: string[],
): void {
  const label = `provider route evidence ${route.id}`;
  if (frame.channel !== "provider-session-event" || !isRecord(frame.payload)) {
    errors.push(`${label} non-Grok raw frame must use the provider-session-event channel`);
    return;
  }
  const payload = frame.payload;
  if (payload.schemaVersion !== 1 || typeof payload.eventId !== "string" || !payload.eventId.trim()) {
    errors.push(`${label} provider-session raw frame identity is invalid`);
  }
  if (payload.sequence !== index + 1) errors.push(`${label} provider-session raw sequence contains a gap`);
  if (payload.occurredAtMs !== frame.observedAtMs) errors.push(`${label} provider-session raw timestamp drifted`);
  if (payload.runId !== evidence.cleanup?.runId || payload.tabId !== evidence.cleanup?.tabId) {
    errors.push(`${label} provider-session raw frame belongs to another run or tab`);
  }
  if (payload.providerId !== route.providerId) errors.push(`${label} provider-session raw frame belongs to another provider`);
  const meta = isRecord(payload._meta) ? payload._meta : undefined;
  if (meta?.tabId !== evidence.cleanup?.tabId) errors.push(`${label} provider-session raw metadata tab is invalid`);
}

function validateGrokRawFrame(
  frame: ReleaseSurfaceProviderRawFrameDigest,
  _index: number,
  evidence: ReleaseSurfaceProviderRouteEvidence,
  route: ReleaseSurfaceProviderRoute,
  errors: string[],
): void {
  const label = `provider route evidence ${route.id}`;
  if (!isRecord(frame.payload)
    || (frame.channel !== "grok-acp-event" && frame.channel !== "prompt-complete")) {
    errors.push(`${label} Grok raw frame channel or payload is invalid`);
    return;
  }
  if (rawFrameTabId(frame) !== evidence.cleanup?.tabId) {
    errors.push(`${label} Grok raw frame belongs to another tab`);
  }
  if (frame.channel === "grok-acp-event") {
    if (typeof frame.payload.method !== "string" || !frame.payload.method.trim()
      || !isRecord(frame.payload.params)) {
      errors.push(`${label} Grok ACP frame envelope is invalid`);
    }
  } else if (frame.payload.kind !== "prompt_complete" || !grokRawFrameStopReason(frame)) {
    errors.push(`${label} Grok prompt-complete envelope is invalid`);
  }
}

function validateCleanup(
  evidence: ReleaseSurfaceProviderRouteEvidence,
  route: ReleaseSurfaceProviderRoute,
  errors: string[],
): void {
  const cleanup = evidence.cleanup;
  const label = `provider route evidence ${route.id}`;
  if (!cleanup?.tabId?.startsWith("release-route-") || cleanup.tabId === "release-route-default") {
    errors.push(`${label} cleanup tab id is invalid`);
  }
  const runIds = new Set(evidence.normalizedEvents?.map((event) => event.runId) ?? []);
  if (runIds.size !== 1 || !runIds.has(cleanup?.runId ?? "")) errors.push(`${label} cleanup run id does not match the raw stream`);
  const terminal = evidence.normalizedEvents?.at(-1);
  if (cleanup?.terminalState !== "completed" || terminal?.kind !== "completed"
    || cleanup?.terminalEventSha256 !== terminal?.sourceFrameSha256) {
    errors.push(`${label} cleanup terminal binding is invalid`);
  }
  const encoded = JSON.stringify(cleanup?.state);
  if (typeof encoded !== "string") {
    errors.push(`${label} cleanup state is not JSON serializable`);
    return;
  }
  const bytes = Buffer.from(encoded);
  if (cleanup.stateBytes !== bytes.length || cleanup.stateSha256 !== createPayloadSha256(bytes)) {
    errors.push(`${label} cleanup state identity is invalid`);
  }
  if (route.providerId === "grok") {
    if (cleanup.stateEndpoint !== "/state/sessions") errors.push(`${label} Grok cleanup endpoint is invalid`);
    const state = isRecord(cleanup.state) ? cleanup.state : {};
    const tabs = Array.isArray(state.tabs) ? state.tabs : [];
    const matching = tabs.filter((tab) => isRecord(tab) && tab.tabId === cleanup.tabId);
    if (matching.length > 0) errors.push(`${label} Grok cleanup state still contains the route tab`);
  } else {
    if (cleanup.stateEndpoint !== "/provider-sessions/state") errors.push(`${label} provider cleanup endpoint is invalid`);
    const state = isRecord(cleanup.state) ? cleanup.state : {};
    if (state.activeRun != null) errors.push(`${label} provider cleanup state still has an active run`);
    const recentRuns = Array.isArray(state.recentRuns) ? state.recentRuns : [];
    const matched = recentRuns.some((run) => isRecord(run)
      && run.runId === cleanup.runId && String(run.phase ?? "").toLowerCase() === "completed");
    if (!matched) errors.push(`${label} provider cleanup state does not contain the exact completed run`);
  }
}

function deriveGrokEvents(
  rawFrames: ReleaseSurfaceProviderRawFrameDigest[],
  nativeProtocol: string,
): ReleaseSurfaceProviderNormalizedEvent[] {
  const first = rawFrames[0];
  if (!first) return [];
  const runId = `grok-route-${createPayloadSha256(Buffer.from(rawFrames.map((frame) => frame.payloadSha256).join(""))).slice(0, 32)}`;
  const events: ReleaseSurfaceProviderNormalizedEvent[] = [{
    schema: RELEASE_SURFACE_NORMALIZED_PROVIDER_EVENT_SCHEMA,
    sequence: 1,
    occurredAtMs: first.observedAtMs,
    runId,
    providerId: "grok",
    kind: "started",
    nativeProtocol,
    sourceFrameSha256: first.payloadSha256,
  }];
  const reconstructedOutput = deriveReleaseSurfaceProviderOutputText(rawFrames, "grok");
  const lastTextOrdinal = rawFrames.reduce(
    (last, frame) => grokRawFrameText(frame) !== undefined ? frame.ordinal : last,
    -1,
  );
  for (const frame of rawFrames) {
    const text = grokRawFrameText(frame);
    if (!text) continue;
    events.push({
      schema: RELEASE_SURFACE_NORMALIZED_PROVIDER_EVENT_SCHEMA,
      sequence: events.length + 1,
      occurredAtMs: frame.observedAtMs,
      runId,
      providerId: "grok",
      kind: "text",
      nativeProtocol,
      sourceFrameSha256: frame.payloadSha256,
      textSha256: createPayloadSha256(Buffer.from(text)),
      canaryMatched: frame.ordinal === lastTextOrdinal
        && reconstructedOutput === RELEASE_SURFACE_PROVIDER_ROUTE_CANARY_TEXT,
    });
  }
  const terminal = [...rawFrames].reverse().find((frame) => frame.channel === "prompt-complete");
  if (terminal) {
    const stopReason = grokRawFrameStopReason(terminal)?.trim().toLowerCase();
    const terminalKind: ReleaseSurfaceProviderNormalizedEvent["kind"] =
      stopReason === "end_turn" || stopReason === "completed"
        ? "completed"
        : stopReason === "cancelled" || stopReason === "canceled" || stopReason === "aborted"
          ? "aborted"
          : "failed";
    events.push({
      schema: RELEASE_SURFACE_NORMALIZED_PROVIDER_EVENT_SCHEMA,
      sequence: events.length + 1,
      occurredAtMs: terminal.observedAtMs,
      runId,
      providerId: "grok",
      kind: terminalKind,
      nativeProtocol,
      sourceFrameSha256: terminal.payloadSha256,
      exitCode: terminalKind === "completed" ? 0 : terminalKind === "aborted" ? 130 : 1,
    });
  }
  return events;
}

function normalizedRawFrameText(
  frame: ReleaseSurfaceProviderRawFrameDigest,
  _providerId: string,
): string | undefined {
  if (!isRecord(frame.payload)) return undefined;
  const kind = normalizedProviderKind(String(frame.payload.kind ?? "other").toLowerCase());
  return kind === "text" && typeof frame.payload.text === "string" ? frame.payload.text : undefined;
}

function normalizedProviderKind(rawKind: string): ReleaseSurfaceProviderNormalizedEvent["kind"] {
  if (rawKind === "started") return "started";
  if (rawKind === "text" || rawKind === "textdelta") return "text";
  if (rawKind === "completed") return "completed";
  if (rawKind === "failed") return "failed";
  if (rawKind === "aborted") return "aborted";
  return "other";
}

function grokRawFrameText(frame: ReleaseSurfaceProviderRawFrameDigest): string | undefined {
  if (frame.channel !== "grok-acp-event" || !isRecord(frame.payload)) return undefined;
  const params = isRecord(frame.payload.params) ? frame.payload.params : undefined;
  const update = params && isRecord(params.update) ? params.update : undefined;
  if (update?.sessionUpdate !== "agent_message_chunk") return undefined;
  const content = update.content;
  if (Array.isArray(content)) {
    return content.map((item) => isRecord(item) && typeof item.text === "string" ? item.text : "").join("") || undefined;
  }
  return isRecord(content) && typeof content.text === "string" ? content.text : undefined;
}

function grokRawFrameStopReason(frame: ReleaseSurfaceProviderRawFrameDigest): string | undefined {
  if (!isRecord(frame.payload)) return undefined;
  const params = isRecord(frame.payload.params) ? frame.payload.params : undefined;
  const update = params && isRecord(params.update) ? params.update : undefined;
  const meta = params && isRecord(params._meta) ? params._meta : undefined;
  for (const value of [frame.payload.stopReason, params?.stopReason, update?.stopReason, meta?.stopReason]) {
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

function rawFrameTabId(frame: ReleaseSurfaceProviderRawFrameDigest): string | undefined {
  if (!isRecord(frame.payload)) return undefined;
  if (typeof frame.payload.tabId === "string") return frame.payload.tabId;
  const meta = isRecord(frame.payload._meta) ? frame.payload._meta : undefined;
  if (typeof meta?.tabId === "string") return meta.tabId;
  const params = isRecord(frame.payload.params) ? frame.payload.params : undefined;
  const paramsMeta = params && isRecord(params._meta) ? params._meta : undefined;
  return typeof paramsMeta?.tabId === "string" ? paramsMeta.tabId : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
}

function createPayloadSha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function validIso(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function validIsoRange(start: unknown, end: unknown): boolean {
  return validIso(start) && validIso(end) && Date.parse(end) >= Date.parse(start);
}
