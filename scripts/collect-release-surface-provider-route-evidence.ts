import { createHash, randomUUID } from "node:crypto";
import { lstatSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import type {
  ConnectionPreset,
  ConnectionProviderCapabilitySnapshot,
  ConnectionProviderScanEntry,
} from "../src/components/ConnectionPicker";
import {
  loadReleaseSurfaceCandidateAttestation,
  type ReleaseSurfaceCandidateAttestation,
} from "./lib/release-surface-candidate-attestation";
import {
  RELEASE_SURFACE_NORMALIZED_PROVIDER_EVENT_SCHEMA,
  RELEASE_SURFACE_PROVIDER_ROUTE_CANARY_ID,
  releaseSurfaceProviderRouteId,
  type ReleaseSurfaceHostOs,
  type ReleaseSurfaceProviderRoute,
} from "./lib/release-surface-scenario-report";
import {
  RELEASE_SURFACE_PROVIDER_ROUTE_COLLECTOR_ID,
  RELEASE_SURFACE_PROVIDER_ROUTE_CANARY_TEXT,
  RELEASE_SURFACE_PROVIDER_ROUTE_EVIDENCE_SCHEMA,
  deriveReleaseSurfaceProviderNormalizedEvents,
  deriveReleaseSurfaceProviderOutputText,
  validateReleaseSurfaceProviderRouteEvidence,
  type ReleaseSurfaceProviderNormalizedEvent,
  type ReleaseSurfaceProviderRawFrameDigest,
  type ReleaseSurfaceProviderRouteEvidence,
  type ReleaseSurfaceProviderRouteHealth,
} from "./lib/release-surface-provider-route-evidence";
import {
  assertReleaseSurfaceCollectorSource,
  type ReleaseSurfaceGitRunner,
} from "./lib/release-surface-source-provenance";

const PROVIDERS = ["grok", "codex-cli", "claude-code", "antigravity-cli"] as const;
type ProviderId = typeof PROVIDERS[number];
export type ReleaseSurfaceProviderRouteRawEventFrame = { t: number; kind: string; payload: unknown };
export interface ReleaseSurfaceProviderRouteEventStream {
  waitFor(input: {
    timeoutMs: number;
    accept: (frame: ReleaseSurfaceProviderRouteRawEventFrame) => boolean;
    terminal: (frame: ReleaseSurfaceProviderRouteRawEventFrame) => boolean;
  }): Promise<ReleaseSurfaceProviderRouteRawEventFrame[]>;
  close(): void;
}

export interface CollectReleaseSurfaceProviderRouteInput {
  candidate: ReleaseSurfaceCandidateAttestation;
  preset: ConnectionPreset;
  providerId: ProviderId;
  transportId: string;
  cwd: string;
  targetHostOs?: ReleaseSurfaceHostOs;
  evidenceMode: "identity-only" | "live-canary";
  token: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  eventStreamFactory?: (base: string, token: string) => Promise<ReleaseSurfaceProviderRouteEventStream>;
  now?: () => Date;
}

const COLLECTOR_TRACKED_SOURCES = [
  "scripts/collect-release-surface-provider-route-evidence.ts",
  "scripts/lib/release-surface-provider-route-evidence.ts",
  "scripts/lib/release-surface-scenario-report.ts",
] as const;

export function assertReleaseSurfaceProviderCollectorSource(input: {
  sourceCommit: string;
  repositoryRoot?: string;
  runGit?: ReleaseSurfaceGitRunner;
}): void {
  assertReleaseSurfaceCollectorSource({
    sourceCommit: input.sourceCommit,
    repositoryRoot: input.repositoryRoot ?? resolve(dirname(fileURLToPath(import.meta.url)), ".."),
    trackedSources: COLLECTOR_TRACKED_SOURCES,
    runGit: input.runGit,
  });
}

export async function collectReleaseSurfaceProviderRouteEvidence(
  input: CollectReleaseSurfaceProviderRouteInput,
): Promise<ReleaseSurfaceProviderRouteEvidence> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const now = input.now ?? (() => new Date());
  const timeoutMs = Math.max(10_000, Math.min(input.timeoutMs ?? 120_000, 600_000));
  assertCollectorInput(input);
  const healthBefore = await collectHealth(input.candidate, input.token, fetchImpl, now);
  const collectorStartedAt = now().toISOString();
  const capabilitySnapshot = await postJson<ConnectionProviderCapabilitySnapshot>(
    input.candidate.runtime.debugBase,
    "/connections/provider-scan",
    input.token,
    { preset: input.preset },
    fetchImpl,
    30_000,
  );
  const provider = requireReadyProvider(capabilitySnapshot, input.providerId);
  const routeStartedAt = now().toISOString();
  let run: CollectedRun;
  if (input.evidenceMode === "live-canary") {
    const eventStream = await (input.eventStreamFactory ?? openAuthenticatedEventStream)(
      input.candidate.runtime.debugBase,
      input.token,
    );
    try {
      run = input.providerId === "grok"
        ? await collectGrokRoute(input, fetchImpl, eventStream, timeoutMs, now)
        : await collectProviderSessionRoute(input, fetchImpl, eventStream, timeoutMs, now);
    } finally {
      eventStream.close();
    }
  } else {
    run = identityOnlyObservation(now);
  }
  const routeCompletedAt = now().toISOString();
  const routeWithoutEvidence = buildRoute({
    input,
    capabilitySnapshot,
    provider,
    run,
    routeStartedAt,
    routeCompletedAt,
  });
  const collectorCompletedAt = now().toISOString();
  const healthAfter = await collectHealth(input.candidate, input.token, fetchImpl, now);
  const evidence: ReleaseSurfaceProviderRouteEvidence = {
    schema: RELEASE_SURFACE_PROVIDER_ROUTE_EVIDENCE_SCHEMA,
    mode: "final-frozen-candidate",
    evidenceMode: input.evidenceMode,
    collector: {
      id: RELEASE_SURFACE_PROVIDER_ROUTE_COLLECTOR_ID,
      sourceCommit: input.candidate.sourceCommit,
      startedAt: collectorStartedAt,
      completedAt: collectorCompletedAt,
    },
    candidate: {
      platform: input.candidate.platform,
      sourceCommit: input.candidate.sourceCommit,
      version: input.candidate.version,
      artifactSha256: input.candidate.distributionArtifact.sha256,
      processId: input.candidate.runtime.processId,
      instanceId: input.candidate.runtime.instanceId,
      debugBase: input.candidate.runtime.debugBase,
    },
    healthBefore,
    healthAfter,
    eventStream: {
      transport: input.evidenceMode === "live-canary" ? "authenticated-websocket" : "not-opened",
      lagWarnings: 0,
    },
    capabilitySnapshot,
    route: routeWithoutEvidence,
    rawFrames: run.rawFrames,
    normalizedEvents: run.normalizedEvents,
    cleanup: run.cleanup,
  };
  const temporaryRoute = { ...routeWithoutEvidence, evidence: { basename: "pending.json", sha256: "0".repeat(64), bytes: 1 } };
  const errors = validateReleaseSurfaceProviderRouteEvidence({
    evidence,
    candidate: input.candidate,
    expectedRoute: temporaryRoute,
  });
  if (errors.length > 0) throw new Error(`collected provider route evidence is invalid: ${errors.join("; ")}`);
  return evidence;
}

interface CollectedRun {
  runId: string;
  rawFrames: ReleaseSurfaceProviderRawFrameDigest[];
  normalizedEvents: ReleaseSurfaceProviderNormalizedEvent[];
  cleanup: ReleaseSurfaceProviderRouteEvidence["cleanup"];
}

function identityOnlyObservation(now: () => Date): CollectedRun {
  return {
    runId: "",
    rawFrames: [],
    normalizedEvents: [],
    cleanup: {
      requested: false,
      noActiveProviderRun: true,
      terminalState: "not-started",
      observedAt: now().toISOString(),
      observed: "no provider run was started; executable readiness and identity were observed through the bounded capability scan",
    },
  };
}

async function collectProviderSessionRoute(
  input: CollectReleaseSurfaceProviderRouteInput,
  fetchImpl: typeof fetch,
  eventStream: ReleaseSurfaceProviderRouteEventStream,
  timeoutMs: number,
  now: () => Date,
): Promise<CollectedRun> {
  const tabId = `release-route-${input.providerId}-${randomUUID()}`;
  const transport = providerTransportFields(input.preset);
  const started = await postJson<{ ok: boolean; run: { runId: string } }>(
    input.candidate.runtime.debugBase,
    "/provider-sessions/start",
    input.token,
    {
      tabId,
      providerId: input.providerId,
      cwd: input.cwd,
      prompt: `Return exactly ${RELEASE_SURFACE_PROVIDER_ROUTE_CANARY_TEXT} and no other text. Do not call tools.`,
      includeMcpProbe: false,
      includeShellxTooling: false,
      shellxToolExposure: "off",
      timeoutMs,
      persistSession: false,
      permissionMode: "readOnly",
      ...transport,
    },
    fetchImpl,
    20_000,
  );
  if (!started.ok || !started.run?.runId) throw new Error("provider session did not return a run id");
  const runId = started.run.runId;
  let frames: ReleaseSurfaceProviderRouteRawEventFrame[] = [];
  try {
    frames = await eventStream.waitFor({
      timeoutMs,
      accept: (frame) => frame.kind === "provider-session-event"
        && isRecord(frame.payload)
        && frame.payload.runId === runId,
      terminal: (frame) => {
        const kind = isRecord(frame.payload) ? String(frame.payload.kind ?? "").toLowerCase() : "";
        return ["completed", "failed", "aborted"].includes(kind);
      },
    });
  } catch (error) {
    await postJson(input.candidate.runtime.debugBase, "/provider-sessions/abort", input.token, {
      tabId,
      runId,
      ...transport,
    }, fetchImpl, 10_000).catch(() => undefined);
    throw error;
  }
  frames = sortProviderSessionFrames(frames);
  const rawFrames = digestRawFrames(frames);
  const normalized = deriveReleaseSurfaceProviderNormalizedEvents(rawFrames, input.providerId, nativeProtocol(input.providerId));
  assertSuccessfulCanary(normalized, rawFrames, input.providerId);
  const statePath = `/provider-sessions/state?${providerStateQuery(tabId, input.preset)}`;
  const state = await getJson<Record<string, unknown>>(
    input.candidate.runtime.debugBase,
    statePath,
    input.token,
    fetchImpl,
    10_000,
  );
  const noActiveProviderRun = state.activeRun == null;
  const recentRuns = Array.isArray(state.recentRuns) ? state.recentRuns : [];
  const terminalRunMatched = recentRuns.some((value) => isRecord(value)
    && value.runId === runId && String(value.phase ?? "").toLowerCase() === "completed");
  if (!noActiveProviderRun || !terminalRunMatched) {
    await postJson(input.candidate.runtime.debugBase, "/provider-sessions/abort", input.token, {
      tabId,
      runId,
      ...transport,
    }, fetchImpl, 10_000).catch(() => undefined);
    throw new Error(`provider route ${runId} cleanup did not expose the exact completed registry row`);
  }
  const stateIdentity = jsonIdentity(state);
  return {
    runId,
    rawFrames,
    normalizedEvents: normalized,
    cleanup: {
      requested: true,
      noActiveProviderRun,
      tabId,
      runId,
      terminalState: "completed",
      terminalEventSha256: normalized.at(-1)!.sourceFrameSha256,
      stateEndpoint: "/provider-sessions/state",
      stateSha256: stateIdentity.sha256,
      stateBytes: stateIdentity.bytes,
      state,
      observedAt: now().toISOString(),
      observed: "provider session registry reported no active run after the terminal event",
    },
  };
}

async function collectGrokRoute(
  input: CollectReleaseSurfaceProviderRouteInput,
  fetchImpl: typeof fetch,
  eventStream: ReleaseSurfaceProviderRouteEventStream,
  timeoutMs: number,
  now: () => Date,
): Promise<CollectedRun> {
  const tabId = `release-route-grok-${randomUUID()}`;
  const saved = await getJson<{ presets?: ConnectionPreset[] }>(
    input.candidate.runtime.debugBase,
    "/connections",
    input.token,
    fetchImpl,
    10_000,
  );
  const storedPreset = saved.presets?.find((preset) => preset.id === input.preset.id);
  if (!storedPreset || JSON.stringify(storedPreset.transport) !== JSON.stringify(input.preset.transport)) {
    throw new Error("Grok route collection requires an existing saved connection with the exact tested transport");
  }
  await postJson(input.candidate.runtime.debugBase, `/connect?tabId=${encodeURIComponent(tabId)}`, input.token, {
    tabId,
    cwd: input.cwd,
    connectionId: input.preset.id,
    permissionMode: "plan",
  }, fetchImpl, 30_000);
  let frames: ReleaseSurfaceProviderRouteRawEventFrame[] = [];
  try {
    await postJson(input.candidate.runtime.debugBase, `/prompt?tabId=${encodeURIComponent(tabId)}`, input.token, {
      tabId,
      prompt: `Return exactly ${RELEASE_SURFACE_PROVIDER_ROUTE_CANARY_TEXT} and no other text. Do not call tools.`,
    }, fetchImpl, 10_000);
    frames = await eventStream.waitFor({
      timeoutMs,
      accept: (frame) => rawFrameTabId(frame) === tabId
        && (frame.kind === "grok-acp-event" || frame.kind === "prompt-complete"),
      terminal: (frame) => frame.kind === "prompt-complete",
    });
    const rawFrames = digestRawFrames(frames);
    const normalized = deriveReleaseSurfaceProviderNormalizedEvents(rawFrames, "grok", "acp");
    const runId = normalized[0]?.runId ?? "";
    assertSuccessfulCanary(normalized, rawFrames, "grok");
    await postJson(input.candidate.runtime.debugBase, `/abort?tabId=${encodeURIComponent(tabId)}`, input.token, {}, fetchImpl, 15_000);
    const state = await getJson<Record<string, unknown>>(
      input.candidate.runtime.debugBase,
      "/state/sessions",
      input.token,
      fetchImpl,
      10_000,
    );
    const tabs = Array.isArray(state.tabs) ? state.tabs : [];
    const matchingTabs = tabs.filter((value) => isRecord(value) && value.tabId === tabId);
    if (matchingTabs.length > 0) throw new Error("Grok route tab remained in the session registry after abort");
    const stateIdentity = jsonIdentity(state);
    return {
      runId,
      rawFrames,
      normalizedEvents: normalized,
      cleanup: {
        requested: true,
        noActiveProviderRun: true,
        tabId,
        runId,
        terminalState: "completed",
        terminalEventSha256: normalized.at(-1)!.sourceFrameSha256,
        stateEndpoint: "/state/sessions",
        stateSha256: stateIdentity.sha256,
        stateBytes: stateIdentity.bytes,
        state,
        observedAt: now().toISOString(),
        observed: "Grok route received a terminal prompt event and the tab-scoped session abort completed",
      },
    };
  } catch (error) {
    await postJson(input.candidate.runtime.debugBase, `/abort?tabId=${encodeURIComponent(tabId)}`, input.token, {}, fetchImpl, 15_000)
      .catch(() => undefined);
    throw error;
  }
}

function buildRoute(input: {
  input: CollectReleaseSurfaceProviderRouteInput;
  capabilitySnapshot: ConnectionProviderCapabilitySnapshot;
  provider: ConnectionProviderScanEntry;
  run: CollectedRun;
  routeStartedAt: string;
  routeCompletedAt: string;
}): Omit<ReleaseSurfaceProviderRoute, "evidence"> {
  const { capabilitySnapshot, provider, run } = input;
  const target = routeTarget(input.input);
  const observedEventKinds = [...new Set(run.normalizedEvents.map((event) => event.kind))];
  const terminal = run.normalizedEvents.at(-1);
  const targetFingerprint = sha256(JSON.stringify({
    target: capabilitySnapshot.target,
    providers: capabilitySnapshot.providers.map((row) => ({
      providerId: row.providerId,
      binarySha256: row.binarySha256,
      binaryBytes: row.binaryBytes,
    })).sort((a, b) => a.providerId.localeCompare(b.providerId)),
  }));
  return {
    id: releaseSurfaceProviderRouteId(input.input.providerId, input.input.transportId),
    transportId: input.input.transportId,
    providerId: input.input.providerId,
    status: "pass",
    evidenceMode: input.input.evidenceMode,
    appHostPlatform: input.input.candidate.platform,
    target: { ...target, hostFingerprintSha256: targetFingerprint },
    provider: {
      executable: provider.binary!,
      executableSha256: provider.binarySha256!,
      executableBytes: provider.binaryBytes!,
      version: provider.version!,
    },
    stream: {
      canaryId: input.input.evidenceMode === "live-canary" ? RELEASE_SURFACE_PROVIDER_ROUTE_CANARY_ID : null,
      nativeProtocol: nativeProtocol(input.input.providerId),
      nativeStreamKind: nativeStreamKind(input.input.providerId),
      normalizedSchema: RELEASE_SURFACE_NORMALIZED_PROVIDER_EVENT_SCHEMA,
      eventCount: run.normalizedEvents.length,
      observedEventKinds,
      finalState: input.input.evidenceMode === "identity-only"
        ? "not-run" : terminal?.kind === "completed" ? "completed" : "failed",
      canaryMatched: run.normalizedEvents.some((event) => event.canaryMatched),
      gapCount: contiguousSequences(run.normalizedEvents) ? 0 : 1,
      parseErrorCount: 0,
    },
    cleanup: run.cleanup.noActiveProviderRun ? "pass" : "fail",
    startedAt: input.routeStartedAt,
    completedAt: input.routeCompletedAt,
    observed: input.input.evidenceMode === "live-canary"
      ? `${input.input.providerId} returned the bounded canary over ${input.input.transportId}; exact executable identity and cleanup were observed`
      : `${input.input.providerId} readiness, version, and executable identity were observed over ${input.input.transportId} without paid generation`,
  };
}

function routeTarget(input: CollectReleaseSurfaceProviderRouteInput): Omit<ReleaseSurfaceProviderRoute["target"], "hostFingerprintSha256"> {
  const platformOs = input.candidate.platform === "windows-installed"
    ? "windows" : input.candidate.platform === "macos-installed" ? "macos" : "linux";
  switch (input.transportId) {
    case "local-native":
      return {
        transport: "local",
        hostOs: platformOs,
        runtimeKind: platformOs === "windows" ? "windows-native" : "posix-native",
        runtimeOs: platformOs,
        shellKind: platformOs === "windows" ? "powershell" : "posix-shell",
      };
    case "local-wsl":
      return { transport: "wsl", hostOs: "windows", runtimeKind: "wsl", runtimeOs: "linux", shellKind: "wsl-bash", wslDistro: requireWslDistro(input.preset) };
    case "ssh-posix-native":
      return { transport: "ssh", hostOs: input.targetHostOs!, runtimeKind: "posix-native", runtimeOs: input.targetHostOs!, shellKind: "posix-shell" };
    case "ssh-windows-native":
      return { transport: "ssh", hostOs: "windows", runtimeKind: "windows-native", runtimeOs: "windows", shellKind: "powershell" };
    case "ssh-windows-wsl":
      return { transport: "ssh", hostOs: "windows", runtimeKind: "wsl", runtimeOs: "linux", shellKind: "wsl-bash", wslDistro: requireWslDistro(input.preset) };
    default:
      throw new Error(`unsupported provider route transport ${input.transportId}`);
  }
}

function assertCollectorInput(input: CollectReleaseSurfaceProviderRouteInput): void {
  if (!PROVIDERS.includes(input.providerId)) throw new Error(`unsupported provider ${input.providerId}`);
  if (input.evidenceMode !== "identity-only" && input.evidenceMode !== "live-canary") {
    throw new Error("provider route evidence mode is invalid");
  }
  if (!input.cwd.trim()) throw new Error("provider route cwd is required");
  if (input.token.length < 32) throw new Error("candidate Debug API token is invalid");
  if (input.candidate.schema !== "shellx/release-surface-candidate-attestation@5"
    || input.candidate.mode !== "final-frozen-candidate") {
    throw new Error("provider route collection requires a v3 frozen candidate attestation");
  }
  const kind = input.preset.transport.kind;
  const expectedKind = input.transportId === "local-native" ? "local"
    : input.transportId === "local-wsl" ? "wsl" : "ssh";
  if (kind !== expectedKind) throw new Error(`${input.transportId} requires a ${expectedKind} preset`);
  if (input.transportId === "local-wsl" && input.candidate.platform !== "windows-installed") {
    throw new Error("local-wsl is valid only for a Windows candidate");
  }
  if (input.transportId === "ssh-posix-native" && !["linux", "macos"].includes(input.targetHostOs ?? "")) {
    throw new Error("ssh-posix-native requires --target-host-os linux or macos");
  }
  if (kind === "ssh") {
    const runtime = input.preset.transport.remoteRuntime ?? "posix";
    const expected = input.transportId === "ssh-windows-native" ? "windows"
      : input.transportId === "ssh-windows-wsl" ? "windows_wsl" : "posix";
    if (runtime !== expected) throw new Error(`${input.transportId} requires SSH remoteRuntime ${expected}`);
  }
}

function requireReadyProvider(
  snapshot: ConnectionProviderCapabilitySnapshot,
  providerId: ProviderId,
): ConnectionProviderScanEntry {
  if (snapshot.schemaVersion !== "shellx.provider-capability-snapshot.v2") throw new Error("candidate returned a non-v2 capability snapshot");
  const provider = snapshot.providers.find((row) => row.providerId === providerId);
  if (!provider || provider.status !== "ready" || !provider.canRun || !provider.binary || !provider.version
    || !/^[a-f0-9]{64}$/i.test(provider.binarySha256 ?? "") || !Number.isSafeInteger(provider.binaryBytes) || Number(provider.binaryBytes) <= 0) {
    throw new Error(`${providerId} is not ready with exact executable identity on the selected target`);
  }
  return provider;
}

async function collectHealth(
  candidate: ReleaseSurfaceCandidateAttestation,
  token: string,
  fetchImpl: typeof fetch,
  now: () => Date,
): Promise<ReleaseSurfaceProviderRouteHealth> {
  const value = await getJson<Record<string, unknown>>(candidate.runtime.debugBase, "/health", token, fetchImpl, 5_000);
  const health: ReleaseSurfaceProviderRouteHealth = {
    observedAt: now().toISOString(),
    processId: Number(value.processId),
    instanceId: String(value.instanceId ?? ""),
    appVersion: String(value.appVersion ?? value.app_version ?? ""),
    buildCommit: String(value.buildCommit ?? value.build_commit ?? ""),
    debugPort: Number(value.debugApiPort ?? value.debug_api_port),
  };
  if (health.processId !== candidate.runtime.processId || health.instanceId !== candidate.runtime.instanceId
    || health.appVersion !== candidate.version || health.buildCommit !== candidate.sourceCommit
    || health.debugPort !== candidate.runtime.debugPort) {
    throw new Error("candidate /health identity drifted during provider route collection");
  }
  return health;
}

function digestRawFrames(frames: ReleaseSurfaceProviderRouteRawEventFrame[]): ReleaseSurfaceProviderRawFrameDigest[] {
  return frames.map((frame, index) => {
    const payload = Buffer.from(JSON.stringify(frame.payload));
    return {
      ordinal: index + 1,
      observedAtMs: frame.t,
      channel: frame.kind,
      payloadSha256: createHash("sha256").update(payload).digest("hex"),
      payloadBytes: payload.length,
      payload: frame.payload,
    };
  });
}

function assertSuccessfulCanary(
  events: ReleaseSurfaceProviderNormalizedEvent[],
  rawFrames: ReleaseSurfaceProviderRawFrameDigest[],
  providerId: ProviderId,
): void {
  if (!contiguousSequences(events)) throw new Error("normalized provider event sequence contains a gap");
  if (!events.some((event) => event.kind === "started")) throw new Error("provider route emitted no started event");
  const canaryEvents = events.filter((event) => event.kind === "text" && event.canaryMatched);
  if (canaryEvents.length !== 1
    || deriveReleaseSurfaceProviderOutputText(rawFrames, providerId) !== RELEASE_SURFACE_PROVIDER_ROUTE_CANARY_TEXT) {
    throw new Error("provider route did not return the exact canary as its sole assistant text");
  }
  const terminal = events.at(-1);
  if (terminal?.kind !== "completed" || (terminal.exitCode !== undefined && terminal.exitCode !== 0)) {
    throw new Error("provider route did not complete successfully");
  }
}

function contiguousSequences(events: ReleaseSurfaceProviderNormalizedEvent[]): boolean {
  return events.every((event, index) => event.sequence === index + 1);
}

export function providerTransportFields(preset: ConnectionPreset): Record<string, unknown> {
  switch (preset.transport.kind) {
    case "local": return { transport: "local" };
    case "wsl": return { transport: "wsl", wslDistro: preset.transport.distro };
    case "ssh": return {
      transport: "ssh",
      sshHost: preset.transport.host,
      sshPort: preset.transport.port,
      sshKeyVaultRef: preset.transport.keyVaultRef,
      sshRemoteRuntime: preset.transport.remoteRuntime ?? "posix",
      sshWslDistro: preset.transport.wslDistro,
    };
    default: throw new Error(`unsupported provider route preset ${preset.transport.kind}`);
  }
}

export function providerStateQuery(tabId: string, preset: ConnectionPreset): string {
  const fields = new URLSearchParams({ tabId, transport: preset.transport.kind });
  if (preset.transport.kind === "wsl") fields.set("wslDistro", preset.transport.distro);
  if (preset.transport.kind === "ssh") {
    fields.set("sshHost", preset.transport.host);
    if (preset.transport.port !== undefined) fields.set("sshPort", String(preset.transport.port));
    fields.set("sshRemoteRuntime", preset.transport.remoteRuntime ?? "posix");
    if (preset.transport.keyVaultRef) fields.set("sshKeyVaultRef", preset.transport.keyVaultRef);
    if (preset.transport.wslDistro) fields.set("sshWslDistro", preset.transport.wslDistro);
  }
  return fields.toString();
}

function requireWslDistro(preset: ConnectionPreset): string {
  if (preset.transport.kind === "wsl") return preset.transport.distro;
  if (preset.transport.kind === "ssh" && preset.transport.wslDistro) return preset.transport.wslDistro;
  throw new Error("provider route requires an explicit WSL distro");
}

function nativeProtocol(providerId: ProviderId): string {
  switch (providerId) {
    case "grok": return "acp";
    case "codex-cli": return "codex-jsonl";
    case "claude-code": return "claude-stream-json";
    case "antigravity-cli": return "antigravity-stream-json";
  }
}

function nativeStreamKind(providerId: ProviderId): string {
  return providerId === "grok" || providerId === "codex-cli" ? "jsonl" : "stream-json";
}

function rawFrameKey(frame: ReleaseSurfaceProviderRouteRawEventFrame): string {
  const payload = isRecord(frame.payload) ? frame.payload : undefined;
  const eventId = payload && typeof payload.eventId === "string" ? payload.eventId : "";
  return eventId || `${frame.t}:${frame.kind}:${hashJson(frame.payload)}`;
}

function sortProviderSessionFrames(
  frames: ReleaseSurfaceProviderRouteRawEventFrame[],
): ReleaseSurfaceProviderRouteRawEventFrame[] {
  return [...frames].sort((left, right) => {
    const leftSequence = isRecord(left.payload) ? Number(left.payload.sequence) : Number.NaN;
    const rightSequence = isRecord(right.payload) ? Number(right.payload.sequence) : Number.NaN;
    if (Number.isSafeInteger(leftSequence) && Number.isSafeInteger(rightSequence)) return leftSequence - rightSequence;
    return left.t - right.t;
  });
}

function rawFrameTabId(frame: ReleaseSurfaceProviderRouteRawEventFrame): string | undefined {
  if (!isRecord(frame.payload)) return undefined;
  if (typeof frame.payload.tabId === "string") return frame.payload.tabId;
  const meta = isRecord(frame.payload._meta) ? frame.payload._meta : undefined;
  if (typeof meta?.tabId === "string") return meta.tabId;
  const params = isRecord(frame.payload.params) ? frame.payload.params : undefined;
  const paramsMeta = params && isRecord(params._meta) ? params._meta : undefined;
  return typeof paramsMeta?.tabId === "string" ? paramsMeta.tabId : undefined;
}

async function openAuthenticatedEventStream(
  base: string,
  token: string,
): Promise<ReleaseSurfaceProviderRouteEventStream> {
  const url = `${base.replace(/^http/, "ws").replace(/\/$/, "")}/events?token=${encodeURIComponent(token)}`;
  const socket = new WebSocket(url);
  const frames: ReleaseSurfaceProviderRouteRawEventFrame[] = [];
  let lagged = false;
  let closedError: Error | undefined;
  socket.onmessage = (event) => {
    try {
      const frame = JSON.parse(String(event.data)) as ReleaseSurfaceProviderRouteRawEventFrame;
      if (frame.kind === "debug-api" && isRecord(frame.payload) && frame.payload.warning === "lagged") {
        lagged = true;
      } else if (Number.isFinite(frame.t) && typeof frame.kind === "string") {
        frames.push(frame);
      }
    } catch {
      lagged = true;
    }
  };
  socket.onerror = () => {
    closedError = new Error("authenticated provider route event stream failed");
  };
  socket.onclose = () => {
    if (!closedError) closedError = new Error("authenticated provider route event stream closed before collection finished");
  };
  await new Promise<void>((resolveOpen, rejectOpen) => {
    const timeout = setTimeout(() => rejectOpen(new Error("authenticated provider route event stream did not open")), 10_000);
    socket.onopen = () => {
      clearTimeout(timeout);
      resolveOpen();
    };
    socket.onerror = () => {
      clearTimeout(timeout);
      rejectOpen(new Error("authenticated provider route event stream failed to open"));
    };
  });
  socket.onerror = () => {
    closedError = new Error("authenticated provider route event stream failed");
  };
  return {
    async waitFor(input) {
      const deadline = Date.now() + input.timeoutMs;
      while (Date.now() < deadline) {
        if (lagged) throw new Error("provider route event stream reported lagged frames");
        if (closedError) throw closedError;
        const observed = new Map<string, ReleaseSurfaceProviderRouteRawEventFrame>();
        for (const frame of frames) {
          if (input.accept(frame)) observed.set(rawFrameKey(frame), frame);
        }
        const accepted = [...observed.values()].sort((a, b) => a.t - b.t);
        if (accepted.some(input.terminal)) return accepted;
        await new Promise((resolveWait) => setTimeout(resolveWait, 20));
      }
      throw new Error(`provider route event stream did not complete within ${input.timeoutMs}ms`);
    },
    close() {
      socket.close();
    },
  };
}

function hashJson(value: unknown): string {
  return sha256(JSON.stringify(value));
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function jsonIdentity(value: unknown): { sha256: string; bytes: number } {
  const bytes = Buffer.from(JSON.stringify(value));
  return { sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function getJson<T>(base: string, path: string, token: string, fetchImpl: typeof fetch, timeoutMs: number): Promise<T> {
  const response = await fetchImpl(`${base.replace(/\/$/, "")}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`GET ${path} returned ${response.status}: ${(await response.text()).slice(0, 500)}`);
  return await response.json() as T;
}

async function postJson<T = Record<string, unknown>>(
  base: string,
  path: string,
  token: string,
  body: unknown,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<T> {
  const response = await fetchImpl(`${base.replace(/\/$/, "")}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`POST ${path} returned ${response.status}: ${(await response.text()).slice(0, 500)}`);
  const text = await response.text();
  return (text ? JSON.parse(text) : {}) as T;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const candidatePath = requiredArg(args, "--candidate-attestation");
  const presetPath = requiredArg(args, "--preset");
  const providerId = requiredArg(args, "--provider") as ProviderId;
  const transportId = requiredArg(args, "--transport-id");
  const cwd = requiredArg(args, "--cwd");
  const outputPath = resolve(requiredArg(args, "--out"));
  const targetHostOs = optionalArg(args, "--target-host-os") as ReleaseSurfaceHostOs | undefined;
  const evidenceMode = requiredArg(args, "--evidence-mode") as CollectReleaseSurfaceProviderRouteInput["evidenceMode"];
  const candidate = loadReleaseSurfaceCandidateAttestation(candidatePath);
  assertReleaseSurfaceProviderCollectorSource({ sourceCommit: candidate.sourceCommit });
  const preset = JSON.parse(readFileSync(resolve(presetPath), "utf8")) as ConnectionPreset;
  const token = readCandidateToken(candidate);
  const parent = lstatSync(dirname(outputPath));
  if (parent.isSymbolicLink() || !parent.isDirectory()) throw new Error("provider route evidence parent must be a regular directory");
  const evidence = await collectReleaseSurfaceProviderRouteEvidence({
    candidate,
    preset,
    providerId,
    transportId,
    cwd,
    targetHostOs,
    evidenceMode,
    token,
  });
  writeFileSync(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  process.stdout.write(`Collected ${providerId} on ${transportId}: ${outputPath}\n`);
}

function readCandidateToken(candidate: ReleaseSurfaceCandidateAttestation): string {
  let path = candidate.runtime.debugTokenPath;
  if (candidate.platform === "windows-installed" && process.platform !== "win32" && /^[A-Za-z]:[\\/]/.test(path)) {
    const mapped = spawnSync("wslpath", ["-u", path], { encoding: "utf8" });
    if (mapped.status !== 0 || !mapped.stdout.trim()) throw new Error(`unable to map candidate token path ${path}`);
    path = mapped.stdout.trim();
  }
  const absolute = resolve(path);
  const stat = lstatSync(absolute);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("candidate token path must be a regular non-symlink file");
  const token = readFileSync(absolute, "utf8").trim();
  if (token.length < 32) throw new Error("candidate token is invalid");
  return token;
}

function requiredArg(args: string[], flag: string): string {
  const value = optionalArg(args, flag);
  if (!value) throw new Error(`${flag} is required`);
  return value;
}

function optionalArg(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1]?.trim() || undefined : undefined;
}

const invokedAsScript = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedAsScript) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exit(1);
  });
}
