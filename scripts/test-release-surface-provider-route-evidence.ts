import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import {
  assertReleaseSurfaceProviderCollectorSource,
  collectReleaseSurfaceProviderRouteEvidence,
  providerStateQuery,
  providerTransportFields,
  type ReleaseSurfaceProviderRouteRawEventFrame,
} from "./collect-release-surface-provider-route-evidence";
import {
  deriveReleaseSurfaceProviderNormalizedEvents,
  deriveReleaseSurfaceProviderOutputText,
  validateReleaseSurfaceProviderRouteEvidence,
} from "./lib/release-surface-provider-route-evidence";
import type { ReleaseSurfaceCandidateAttestation } from "./lib/release-surface-candidate-attestation";
import type { ConnectionPreset } from "../src/components/ConnectionPicker";

const baseMs = Date.parse("2026-07-28T18:00:00.000Z");
let clockTick = 0;
const now = () => new Date(baseMs + clockTick++ * 10);
const candidate: ReleaseSurfaceCandidateAttestation = {
  schema: "shellx/release-surface-candidate-attestation@5",
  mode: "final-frozen-candidate",
  platform: "linux-installed",
  sourceCommit: "b".repeat(40),
  version: "0.3.5",
  createdAt: "2026-07-28T17:59:00.000Z",
  distributionArtifact: { basename: "shellx.AppImage", sha256: "a".repeat(64), bytes: 10_000 },
  installation: {
    method: "direct-artifact",
    sourceArtifactSha256: "a".repeat(64),
    receipt: { basename: "install.json", sha256: "c".repeat(64), bytes: 500 },
    payloadManifestSha256: "d".repeat(64),
  },
  installedPayload: { basename: "shellx.AppImage", sha256: "a".repeat(64), bytes: 10_000, path: "/tmp/shellx.AppImage" },
  process: { pid: 4321, executablePath: "/tmp/shellx.AppImage", executableSha256: "a".repeat(64) },
  runtime: {
    debugBase: "http://127.0.0.1:5757",
    debugPort: 5757,
    debugTokenPath: "/tmp/token",
    mcpBase: "http://127.0.0.1:5758",
    mcpPort: 5758,
    mcpTokenPath: "/tmp/mcp.token",
    processId: 4321,
    instanceId: "fixture-instance-0001",
    appVersion: "0.3.5",
    buildCommit: "b".repeat(40),
  },
};
const preset: ConnectionPreset = {
  id: "fixture-local",
  label: "Fixture local",
  transport: { kind: "local" },
  createdMs: baseMs - 1_000,
  lastUsedMs: baseMs - 1_000,
};
const providerBinarySha256 = createHash("sha256").update("codex fixture binary").digest("hex");
let startBody: Record<string, unknown> | undefined;
let providerStartCount = 0;

const fakeFetch = async (request: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const url = new URL(typeof request === "string" || request instanceof URL ? request : request.url);
  const method = init?.method ?? "GET";
  if (url.pathname === "/health") {
    return jsonResponse({
      processId: 4321,
      instanceId: "fixture-instance-0001",
      appVersion: "0.3.5",
      buildCommit: "b".repeat(40),
      debugApiPort: 5757,
    });
  }
  if (url.pathname === "/connections/provider-scan" && method === "POST") {
    return jsonResponse({
      schemaVersion: "shellx.provider-capability-snapshot.v2",
      generatedAtMs: baseMs + 15,
      freshUntilMs: baseMs + 60_015,
      target: { key: "local:linux", transport: "local", runtime: "posix", label: "Local linux" },
      providers: [
        missingProvider("grok"),
        {
          providerId: "codex-cli",
          canRun: true,
          status: "ready",
          binary: "/usr/bin/codex",
          version: "codex-cli 1.2.3",
          binarySha256: providerBinarySha256,
          binaryBytes: 12_345,
          targetKey: "local:linux",
          checkedAtMs: baseMs + 14,
        },
        missingProvider("claude-code"),
        missingProvider("antigravity-cli"),
      ],
    });
  }
  if (url.pathname === "/provider-sessions/start" && method === "POST") {
    providerStartCount += 1;
    startBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return jsonResponse({ ok: true, run: { runId: "provider-run-fixture" } });
  }
  if (url.pathname === "/events/recent") {
    const tabId = String(startBody?.tabId);
    return jsonResponse([
      providerEvent(baseMs + 21, tabId, 1, "started"),
      providerEvent(baseMs + 22, tabId, 2, "text", "SHELLX_PROVIDER_ROUTE_CANARY_V1"),
      providerEvent(baseMs + 23, tabId, 3, "completed", undefined, 0),
    ]);
  }
  if (url.pathname === "/provider-sessions/state") {
    return jsonResponse({ activeRun: null, recentRuns: [{ runId: "provider-run-fixture", phase: "completed" }] });
  }
  return new Response(`unhandled ${method} ${url.pathname}`, { status: 404 });
};

const evidence = await collectReleaseSurfaceProviderRouteEvidence({
  candidate,
  preset,
  providerId: "codex-cli",
  transportId: "local-native",
  evidenceMode: "live-canary",
  cwd: "/tmp/shellx-provider-route",
  token: "fixture-debug-token-that-is-long-enough",
  fetchImpl: fakeFetch as typeof fetch,
  eventStreamFactory: async () => memoryEventStream([
    providerEvent(baseMs + 21, "unused-until-start", 1, "started"),
    providerEvent(baseMs + 22, "unused-until-start", 2, "text", "SHELLX_PROVIDER_ROUTE_CANARY_V1"),
    providerEvent(baseMs + 23, "unused-until-start", 3, "completed", undefined, 0),
  ]),
  now,
});

assert.equal(evidence.route.id, "codex-cli::local-native");
assert.equal(evidence.route.provider.executableSha256, providerBinarySha256);
assert.equal(evidence.route.target.shellKind, "posix-shell");
assert.deepEqual(evidence.route.stream.observedEventKinds, ["started", "text", "completed"]);
assert.equal(evidence.route.stream.canaryMatched, true);
assert.equal(evidence.rawFrames.length, 3);
assert.equal(evidence.cleanup.noActiveProviderRun, true);
assert.equal(startBody?.includeShellxTooling, false);
assert.equal(startBody?.shellxToolExposure, "off");
assert.equal(startBody?.permissionMode, "readOnly");
assert.equal(providerStartCount, 1);

const nativeWindowsPreset: ConnectionPreset = {
  id: "native-windows",
  label: "Native Windows",
  transport: {
    kind: "ssh",
    host: "operator@windows.example.test",
    remoteGrokPath: "C:\\Users\\operator\\.grok\\bin\\grok.exe",
    remoteRuntime: "windows",
  },
  createdMs: 1,
  lastUsedMs: 1,
};
assert.deepEqual(providerTransportFields(nativeWindowsPreset), {
  transport: "ssh",
  sshHost: "operator@windows.example.test",
  sshPort: undefined,
  sshKeyVaultRef: undefined,
  sshRemoteRuntime: "windows",
  sshWslDistro: undefined,
});
const nativeWindowsStateQuery = new URLSearchParams(
  providerStateQuery("tab-native", nativeWindowsPreset),
);
assert.equal(nativeWindowsStateQuery.get("sshRemoteRuntime"), "windows");
assert.equal(nativeWindowsStateQuery.has("sshWslDistro"), false);
assert.equal(
  nativeWindowsStateQuery.has("sshPort"),
  false,
  "an omitted default port must keep the start/state identity exact",
);

const windowsWslPreset: ConnectionPreset = {
  ...nativeWindowsPreset,
  id: "windows-wsl",
  label: "Windows WSL",
  transport: {
    kind: "ssh",
    host: "operator@windows.example.test",
    remoteGrokPath: "/home/operator/.grok/bin/grok",
    remoteRuntime: "windows_wsl",
    wslDistro: "Ubuntu-24.04",
  },
};
const windowsWslStateQuery = new URLSearchParams(
  providerStateQuery("tab-wsl", windowsWslPreset),
);
assert.equal(windowsWslStateQuery.get("sshRemoteRuntime"), "windows_wsl");
assert.equal(windowsWslStateQuery.get("sshWslDistro"), "Ubuntu-24.04");

const expectedRoute = {
  ...evidence.route,
  evidence: { basename: "codex-local.json", sha256: "e".repeat(64), bytes: 1_000 },
};
assert.deepEqual(validateReleaseSurfaceProviderRouteEvidence({ evidence, candidate, expectedRoute }), []);

const identityEvidence = await collectReleaseSurfaceProviderRouteEvidence({
  candidate,
  preset,
  providerId: "codex-cli",
  transportId: "local-native",
  evidenceMode: "identity-only",
  cwd: "/tmp/shellx-provider-route-identity",
  token: "fixture-debug-token-that-is-long-enough",
  fetchImpl: fakeFetch as typeof fetch,
  eventStreamFactory: async () => {
    throw new Error("identity-only evidence must not open the paid provider event stream");
  },
  now,
});
assert.equal(identityEvidence.route.evidenceMode, "identity-only");
assert.equal(identityEvidence.route.stream.finalState, "not-run");
assert.equal(identityEvidence.route.stream.canaryId, null);
assert.deepEqual(identityEvidence.rawFrames, []);
assert.deepEqual(identityEvidence.normalizedEvents, []);
assert.equal(identityEvidence.eventStream.transport, "not-opened");
assert.equal(identityEvidence.cleanup.requested, false);
assert.equal(identityEvidence.cleanup.terminalState, "not-started");
assert.equal(providerStartCount, 1, "identity-only evidence must not spend a provider generation");
const expectedIdentityRoute = {
  ...identityEvidence.route,
  evidence: { basename: "codex-local-identity.json", sha256: "f".repeat(64), bytes: 1_000 },
};
assert.deepEqual(validateReleaseSurfaceProviderRouteEvidence({
  evidence: identityEvidence,
  candidate,
  expectedRoute: expectedIdentityRoute,
}), []);

const repositoryRoot = realpathSync(process.cwd());
const cleanGit = (args: string[]) => {
  if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return `${repositoryRoot}\n`;
  if (args[0] === "rev-parse" && args[1] === "HEAD") return `${candidate.sourceCommit}\n`;
  if (args[0] === "status") return "";
  if (args[0] === "ls-files") {
    return "scripts/collect-release-surface-provider-route-evidence.ts\nscripts/lib/release-surface-provider-route-evidence.ts\nscripts/lib/release-surface-scenario-report.ts\n";
  }
  throw new Error(`unexpected git probe ${args.join(" ")}`);
};
assert.doesNotThrow(() => assertReleaseSurfaceProviderCollectorSource({
  sourceCommit: candidate.sourceCommit,
  repositoryRoot,
  runGit: cleanGit,
}));
assert.throws(() => assertReleaseSurfaceProviderCollectorSource({
  sourceCommit: candidate.sourceCommit,
  repositoryRoot,
  runGit: (args) => args[0] === "status" ? " M scripts/collect-release-surface-provider-route-evidence.ts\n" : cleanGit(args),
}), /repository is not clean/);

const forgedCanary = structuredClone(evidence);
const canaryEvent = forgedCanary.normalizedEvents.find((event) => event.canaryMatched)!;
const sourceFrame = forgedCanary.rawFrames.find((frame) => frame.payloadSha256 === canaryEvent.sourceFrameSha256)!;
sourceFrame.payload = { ...(sourceFrame.payload as Record<string, unknown>), text: "NOT_THE_CANARY" };
const sourceBytes = Buffer.from(JSON.stringify(sourceFrame.payload));
sourceFrame.payloadBytes = sourceBytes.length;
sourceFrame.payloadSha256 = createHash("sha256").update(sourceBytes).digest("hex");
canaryEvent.sourceFrameSha256 = sourceFrame.payloadSha256;
assert(
  validateReleaseSurfaceProviderRouteEvidence({ evidence: forgedCanary, candidate, expectedRoute })
    .some((error) => error.includes("canary match is not derived")),
  "a claimed canary must remain bound to the exact raw canary payload",
);

const driftedIdentity = structuredClone(evidence);
driftedIdentity.capabilitySnapshot.providers.find((row) => row.providerId === "codex-cli")!.binarySha256 = "f".repeat(64);
assert(
  validateReleaseSurfaceProviderRouteEvidence({ evidence: driftedIdentity, candidate, expectedRoute })
    .some((error) => error.includes("executable identity does not match")),
  "a scenario route cannot escape its fresh executable identity snapshot",
);

const grokFailureFrames = [
  rawGrokFrame(1, "grok-acp-event", {
    method: "session/update",
    params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "SHELLX_PROVIDER_ROUTE_CANARY_V1" } } },
  }),
  rawGrokFrame(2, "prompt-complete", { kind: "prompt_complete", stopReason: "error" }),
];
const grokFailureEvents = deriveReleaseSurfaceProviderNormalizedEvents(grokFailureFrames, "grok", "acp");
assert.equal(
  grokFailureEvents.at(-1)?.kind,
  "failed",
  "a Grok prompt-complete error must never be normalized as a successful route",
);

const grokSplitCanaryFrames = [
  rawGrokFrame(1, "grok-acp-event", grokTextChunk("SHELLX_PROVIDER_")),
  rawGrokFrame(2, "grok-acp-event", grokTextChunk("ROUTE_CANARY_V1")),
  rawGrokFrame(3, "prompt-complete", { kind: "prompt_complete", stopReason: "end_turn" }),
];
const grokSplitCanaryEvents = deriveReleaseSurfaceProviderNormalizedEvents(grokSplitCanaryFrames, "grok", "acp");
assert.equal(deriveReleaseSurfaceProviderOutputText(grokSplitCanaryFrames, "grok"), "SHELLX_PROVIDER_ROUTE_CANARY_V1");
assert.equal(grokSplitCanaryEvents.filter((event) => event.canaryMatched).length, 1);
assert.equal(grokSplitCanaryEvents.at(-1)?.kind, "completed");

const grokNoisyFrames = [
  rawGrokFrame(1, "grok-acp-event", grokTextChunk("SHELLX_PROVIDER_ROUTE_CANARY_V1")),
  rawGrokFrame(2, "grok-acp-event", grokTextChunk("EXTRA_OUTPUT")),
  rawGrokFrame(3, "prompt-complete", { kind: "prompt_complete", stopReason: "end_turn" }),
];
const grokNoisyEvents = deriveReleaseSurfaceProviderNormalizedEvents(grokNoisyFrames, "grok", "acp");
assert.equal(grokNoisyEvents.some((event) => event.canaryMatched), false, "additional Grok text must invalidate the canary");

console.log("Release surface provider route evidence tests passed");

function missingProvider(providerId: "grok" | "claude-code" | "antigravity-cli") {
  return {
    providerId,
    canRun: false,
    status: "missing",
    targetKey: "local:linux",
    checkedAtMs: baseMs + 14,
  } as const;
}

function providerEvent(
  t: number,
  tabId: string,
  sequence: number,
  kind: string,
  text?: string,
  exitCode?: number,
) {
  return {
    t,
    kind: "provider-session-event",
    payload: {
      schemaVersion: 1,
      eventId: `event-${sequence}`,
      sequence,
      occurredAtMs: t,
      runId: "provider-run-fixture",
      tabId,
      providerId: "codex-cli",
      kind,
      ...(text ? { text } : {}),
      ...(exitCode !== undefined ? { exitCode } : {}),
      _meta: { tabId },
    },
  };
}

function memoryEventStream(frames: ReleaseSurfaceProviderRouteRawEventFrame[]) {
  return {
    async waitFor(input: {
      accept: (frame: ReleaseSurfaceProviderRouteRawEventFrame) => boolean;
      terminal: (frame: ReleaseSurfaceProviderRouteRawEventFrame) => boolean;
    }) {
      const tabId = String(startBody?.tabId);
      const accepted = frames
        .map((frame) => ({
          ...frame,
          payload: { ...(frame.payload as Record<string, unknown>), tabId, _meta: { tabId } },
        }))
        .filter(input.accept);
      if (!accepted.some(input.terminal)) throw new Error("fixture stream has no terminal frame");
      return accepted;
    },
    close() {},
  };
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function rawGrokFrame(ordinal: number, channel: string, payload: unknown) {
  const bytes = Buffer.from(JSON.stringify(payload));
  return {
    ordinal,
    observedAtMs: baseMs + ordinal,
    channel,
    payloadSha256: createHash("sha256").update(bytes).digest("hex"),
    payloadBytes: bytes.length,
    payload,
  };
}

function grokTextChunk(text: string) {
  return {
    method: "session/update",
    params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } },
  };
}
