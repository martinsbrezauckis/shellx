import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { existsSync, lstatSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { ReleaseSurfaceCandidateAttestation } from "./release-surface-candidate-attestation";
import {
  RELEASE_SURFACE_HEALTH_COLLECTOR_ID,
  RELEASE_SURFACE_HEALTH_EVIDENCE_SCHEMA,
  validateReleaseSurfaceHealthEvidence,
  type ReleaseSurfaceHealthEvidence,
} from "./release-surface-health-evidence";
import type { ReleasePlatform, ReleaseSurfaceInventory } from "./release-surface-inventory";
import type { ReleaseSurfaceScenarioReport } from "./release-surface-scenario-report";
import type {
  ReleaseSurfaceWebDriverSessionDeleteObserver,
} from "./release-surface-webdriver-lifecycle";
import type { ReleaseSurfaceWebDriverSession } from "./release-surface-webdriver-binding";
import {
  clickReleaseSurfaceWebDriverElement,
  executeReleaseSurfaceWebDriverScript,
  waitForReleaseSurfaceWebDriverElement,
} from "./release-surface-webdriver-client";
import {
  assertReleaseSurfaceCollectorSource,
  type ReleaseSurfaceGitRunner,
} from "./release-surface-source-provenance";

const MAX_EVENT_BYTES = 64 * 1024;
const MAX_EVENTS = 10_000;
const HEALTH_OBSERVER_KEY = "__shellxReleaseHealthObserverV1";
const HEALTH_COLLECTOR_TRACKED_SOURCES = [
  "scripts/lib/release-surface-health-collector.ts",
  "scripts/lib/release-surface-health-evidence.ts",
  "scripts/lib/release-surface-webdriver-client.ts",
  "scripts/lib/release-surface-webdriver-lifecycle.ts",
] as const;

type ObservedEvent = {
  sequence: number;
  observedAtMs: number;
  kind: "ready" | "link" | "console" | "checkpoint" | "closed";
  debugId?: string;
  href?: string;
  level?: string;
  message?: string;
};

export interface ReleaseSurfaceHealthCollectorResult {
  evidence: ReleaseSurfaceHealthEvidence;
  outputPath: string;
  scenarioStartedAt: string;
}

export interface ReleaseSurfaceHealthCollector {
  scenarioStartedAt: string;
  discoverRenderedLinks(): Promise<void>;
  sessionDeleteObserver: ReleaseSurfaceWebDriverSessionDeleteObserver;
  finalized: Promise<ReleaseSurfaceHealthCollectorResult>;
}

export async function startReleaseSurfaceHealthCollector(input: {
  candidate: ReleaseSurfaceCandidateAttestation;
  candidateToken: string;
  session: ReleaseSurfaceWebDriverSession;
  inventory: ReleaseSurfaceInventory;
  platform: ReleasePlatform;
  healthPort: number;
  outputPath: string;
  repositoryRoot?: string;
  runGit?: ReleaseSurfaceGitRunner;
  fetchImpl?: typeof fetch;
  executeScript?: typeof executeReleaseSurfaceWebDriverScript;
  processExists?: (pid: number) => boolean;
  checkLink?: (href: string) => Promise<"ok" | "broken">;
  now?: () => Date;
}): Promise<ReleaseSurfaceHealthCollector> {
  validateStartInput(input);
  const outputPath = requireCreateOnlyOutput(input.outputPath);
  assertReleaseSurfaceCollectorSource({
    sourceCommit: input.candidate.sourceCommit,
    repositoryRoot: input.repositoryRoot ?? resolve(import.meta.dirname, "../.."),
    trackedSources: HEALTH_COLLECTOR_TRACKED_SOURCES,
    runGit: input.runGit,
  });
  const now = createReleaseSurfaceNondecreasingClock(input.now ?? (() => new Date()));
  const fetchImpl = input.fetchImpl ?? fetch;
  const executeScript = input.executeScript ?? executeReleaseSurfaceWebDriverScript;
  const token = randomBytes(32).toString("hex");
  const eventStore = new HealthEventStore(token);
  const server = await listenHealthServer(input.healthPort, eventStore);
  const collectorStartedAt = now().toISOString();
  let finalizedResolve!: (value: ReleaseSurfaceHealthCollectorResult) => void;
  let finalizedReject!: (reason: unknown) => void;
  const finalized = new Promise<ReleaseSurfaceHealthCollectorResult>((resolveResult, rejectResult) => {
    finalizedResolve = resolveResult;
    finalizedReject = rejectResult;
  });
  void finalized.catch(() => undefined);
  let startup: ReleaseSurfaceHealthEvidence["startup"];
  let scenarioStartedAt = "";
  let links: ReleaseSurfaceHealthEvidence["links"] | null = null;
  try {
    const response = await candidateJson(
      input.candidate.runtime.debugBase,
      input.candidateToken,
      "GET",
      "/health",
      undefined,
      fetchImpl,
    );
    const responseIdentity = jsonIdentity(response);
    startup = {
      observedAt: now().toISOString(),
      responseSha256: responseIdentity.sha256,
      responseBytes: responseIdentity.bytes,
      response,
    };
    requireExactCandidateHealth(response, input.candidate);
    const endpoint = `http://127.0.0.1:${input.healthPort}/events?token=${encodeURIComponent(token)}`;
    const installed = await executeScript(input.session, INSTALL_HEALTH_OBSERVER_SCRIPT, [
      endpoint,
      HEALTH_OBSERVER_KEY,
    ]) as { installed?: unknown; readySequence?: unknown };
    if (installed?.installed !== true || !Number.isSafeInteger(installed.readySequence)) {
      throw new Error("installed WebView health observer did not return its exact ready sequence");
    }
    await eventStore.waitForSequence(Number(installed.readySequence), 5_000);
    const ready = eventStore.event(Number(installed.readySequence));
    if (ready?.kind !== "ready") throw new Error("installed WebView health observer emitted no ready event");
    scenarioStartedAt = now().toISOString();
  } catch (error) {
    await closeServer(server);
    throw error;
  }

  const anchorSurfaceByDebugId = expectedAnchorSurfaces(input.inventory, input.platform);
  const collector: ReleaseSurfaceHealthCollector = {
    scenarioStartedAt,
    async discoverRenderedLinks(): Promise<void> {
      if (links) throw new Error("rendered links may be discovered only once");
      links = await discoverRenderedLinks({
        candidate: input.candidate,
        candidateToken: input.candidateToken,
        session: input.session,
        eventStore,
        anchorSurfaceByDebugId,
        fetchImpl,
        executeScript,
        checkLink: input.checkLink ?? checkHttpLink,
        now,
      });
    },
    sessionDeleteObserver: {
      async beforeSessionDelete(session): Promise<void> {
        if (session !== input.session) throw new Error("health observer was asked to flush another WebDriver session");
        if (!links) throw new Error("rendered-link discovery did not complete before candidate shutdown");
        const value = await executeScript(session, FLUSH_HEALTH_OBSERVER_SCRIPT, [HEALTH_OBSERVER_KEY]) as {
          checkpointSequence?: unknown;
        };
        if (!Number.isSafeInteger(value?.checkpointSequence)) {
          throw new Error("installed WebView health observer did not return its checkpoint sequence");
        }
        await eventStore.waitForSequence(Number(value.checkpointSequence), 5_000);
        if (eventStore.event(Number(value.checkpointSequence))?.kind !== "checkpoint") {
          throw new Error("installed WebView health observer checkpoint did not reach the collector");
        }
      },
      async afterSessionDelete(observation): Promise<void> {
        try {
          if (observation.session !== input.session) {
            throw new Error("health observer received another WebDriver session deletion");
          }
          if (observation.status !== "pass") {
            throw new Error("health observer cannot prove shutdown after WebDriver session deletion failed");
          }
          if (!links) {
            throw new Error("health observer cannot finalize before rendered-link discovery completes");
          }
          const shutdownObservedAt = await waitForProcessAbsent(
            input.candidate.runtime.processId,
            input.processExists ?? defaultProcessExists,
            now,
            10_000,
          );
          await eventStore.waitForKind("closed", 2_000).catch(() => undefined);
          await delay(100);
          const evidence = buildEvidence({
            candidate: input.candidate,
            collectorStartedAt,
            collectorCompletedAt: now().toISOString(),
            startup,
            links,
            events: eventStore.events(),
            scenarioStartedAt,
            shutdownRequestedAt: observation.requestedAt,
            shutdownObservedAt,
          });
          writeFileSync(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, {
            encoding: "utf8",
            flag: "wx",
            mode: 0o600,
          });
          const scenario = {
            startedAt: scenarioStartedAt,
            completedAt: shutdownObservedAt,
            health: {
              brokenLinks: evidence.links.brokenLinks,
              unexpectedConsoleErrors: evidence.console.unexpectedConsoleErrors,
            },
          } as ReleaseSurfaceScenarioReport;
          const evidenceErrors = validateReleaseSurfaceHealthEvidence({
            evidence,
            candidate: input.candidate,
            scenario,
            knownSurfaceIds: new Set(input.inventory.items.map((item) => item.id)),
            expectedLinkSurfaceIds: new Set(anchorSurfaceByDebugId.values()),
          });
          if (evidenceErrors.length > 0) {
            throw new Error(`collected release health evidence is invalid: ${evidenceErrors.join("; ")}`);
          }
          const result = { evidence, outputPath, scenarioStartedAt };
          finalizedResolve(result);
        } catch (error) {
          finalizedReject(error);
          throw error;
        } finally {
          await closeServer(server);
        }
      },
    },
    finalized,
  };
  return collector;
}

export function createReleaseSurfaceNondecreasingClock(source: () => Date): () => Date {
  let latestMs = Number.NEGATIVE_INFINITY;
  return () => {
    const observed = source();
    const observedMs = observed.getTime();
    if (!Number.isFinite(observedMs)) throw new Error("release health clock returned an invalid date");
    latestMs = Math.max(latestMs, observedMs);
    return new Date(latestMs);
  };
}

export async function waitForReleaseSurfaceRenderedAnchor(input: {
  session: ReleaseSurfaceWebDriverSession;
  debugId: string;
  executeScript?: typeof executeReleaseSurfaceWebDriverScript;
  timeoutMs?: number;
  pollMs?: number;
}): Promise<void> {
  if (!/^[a-zA-Z0-9._:-]{1,256}$/.test(input.debugId)) {
    throw new Error("rendered anchor debug id must be a bounded stable identifier");
  }
  const timeoutMs = input.timeoutMs ?? 5_000;
  const pollMs = input.pollMs ?? 100;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60_000
    || !Number.isSafeInteger(pollMs) || pollMs <= 0 || pollMs > timeoutMs) {
    throw new Error("rendered anchor wait bounds are invalid");
  }
  const executeScript = input.executeScript ?? executeReleaseSurfaceWebDriverScript;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const observation = await executeScript(
      input.session,
      RENDERED_ANCHOR_VISIBILITY_SCRIPT,
      [input.debugId],
    );
    const counts = requireRenderedAnchorObservation(observation);
    if (counts.renderedExternalHrefCount > 0) return;
    await delay(pollMs);
  }
  throw new Error(`installed anchor did not become rendered and hit-testable before timeout: ${input.debugId}`);
}

function validateStartInput(input: {
  candidate: ReleaseSurfaceCandidateAttestation;
  candidateToken: string;
  inventory: ReleaseSurfaceInventory;
  platform: ReleasePlatform;
  healthPort: number;
  processExists?: (pid: number) => boolean;
}): void {
  if (input.candidate.schema !== "shellx/release-surface-candidate-attestation@5"
    || input.candidate.mode !== "final-frozen-candidate") {
    throw new Error("health collection requires a v5 frozen candidate attestation");
  }
  if (input.candidate.platform !== input.platform) throw new Error("health collector platform drifted from the candidate");
  if (input.platform === "windows-installed" && !input.processExists) {
    throw new Error("Windows health collection requires a native Windows candidate process observer");
  }
  if (input.candidateToken.trim().length < 32) throw new Error("health collector candidate token is invalid");
  if (!Number.isSafeInteger(input.healthPort) || input.healthPort <= 0 || input.healthPort > 65_535) {
    throw new Error("health collector port must be a valid TCP port");
  }
  if (!Array.isArray(input.inventory?.items) || !input.inventory.digest?.trim()) {
    throw new Error("health collector requires the exact release surface inventory");
  }
}

function expectedAnchorSurfaces(inventory: ReleaseSurfaceInventory, platform: ReleasePlatform): Map<string, string> {
  const values = new Map<string, string>();
  for (const item of inventory.items) {
    if (item.kind !== "ui-control" || item.elementTag !== "a" || !item.platforms.includes(platform)) continue;
    const match = item.selector?.match(/^\[data-debug-id=["']([^"']+)["']\]$/);
    if (!match) throw new Error(`link surface ${item.id} lacks an exact data-debug-id selector`);
    const debugId = match[1]!;
    if (values.has(debugId)) throw new Error(`link debug id ${debugId} maps to more than one inventory surface`);
    values.set(debugId, item.id);
  }
  if (values.size === 0) throw new Error(`release inventory contains no rendered link surfaces for ${platform}`);
  return values;
}

async function discoverRenderedLinks(input: {
  candidate: ReleaseSurfaceCandidateAttestation;
  candidateToken: string;
  session: ReleaseSurfaceWebDriverSession;
  eventStore: HealthEventStore;
  anchorSurfaceByDebugId: Map<string, string>;
  fetchImpl: typeof fetch;
  executeScript: typeof executeReleaseSurfaceWebDriverScript;
  checkLink: (href: string) => Promise<"ok" | "broken">;
  now: () => Date;
}): Promise<ReleaseSurfaceHealthEvidence["links"]> {
  const startedAt = input.now().toISOString();
  try {
    await candidateJson(input.candidate.runtime.debugBase, input.candidateToken, "POST", "/state/ui", {
      openModal: "settings",
      source: "final-surface-health-link-discovery",
    }, input.fetchImpl);
    const aboutTab = await waitForReleaseSurfaceWebDriverElement(input.session, "[data-debug-id='settings-tab-about']");
    await clickReleaseSurfaceWebDriverElement(input.session, aboutTab);
    for (const debugId of input.anchorSurfaceByDebugId.keys()) {
      if (debugId === "surface-lib-markdown-links-2") continue;
      await waitForReleaseSurfaceWebDriverElement(input.session, `[data-debug-id='${debugId}']`);
    }
    const quickStart = await waitForReleaseSurfaceWebDriverElement(
      input.session,
      "[title='Read the shellX quick-start guide']",
    );
    await clickReleaseSurfaceWebDriverElement(input.session, quickStart);
    await waitForReleaseSurfaceRenderedAnchor({
      session: input.session,
      debugId: "surface-lib-markdown-links-2",
      executeScript: input.executeScript,
    });
    const flush = await input.executeScript(input.session, FLUSH_HEALTH_OBSERVER_SCRIPT, [HEALTH_OBSERVER_KEY]) as {
      checkpointSequence?: unknown;
    };
    if (!Number.isSafeInteger(flush?.checkpointSequence)) {
      throw new Error("installed WebView health observer link scan returned no checkpoint");
    }
    await input.eventStore.waitForSequence(Number(flush.checkpointSequence), 5_000);
    await waitForExpectedLinks(input.eventStore, new Set(input.anchorSurfaceByDebugId.keys()), 5_000);
    const discovered = uniqueLinkEvents(input.eventStore.events());
    const observations: ReleaseSurfaceHealthEvidence["links"]["observations"] = [];
    for (const event of discovered) {
      const sourceSurfaceId = input.anchorSurfaceByDebugId.get(event.debugId!);
      if (!sourceSurfaceId) throw new Error(`rendered link used unknown data-debug-id ${event.debugId}`);
      observations.push({
        sourceSurfaceId,
        hrefSha256: sha256(event.href!),
        result: await input.checkLink(event.href!),
        observedAt: input.now().toISOString(),
      });
    }
    const completedAt = input.now().toISOString();
    const identitySet = observations.map((observation) => (
      `${observation.sourceSurfaceId}:${observation.hrefSha256}`
    )).sort();
    const observedSurfaceIds = new Set(observations.map((observation) => observation.sourceSurfaceId));
    const missingSurfaces = [...input.anchorSurfaceByDebugId.values()].filter((id) => !observedSurfaceIds.has(id));
    return {
      scope: "installed-driver-discovered-rendered-app-links",
      startedAt,
      completedAt,
      discovery: {
        collectorId: "installed-ui-rendered-link-discovery@1",
        startedAt,
        completedAt,
        discoveredCount: identitySet.length,
        identitySetSha256: sha256(JSON.stringify(identitySet)),
        gapCount: missingSurfaces.length,
      },
      checkedCount: observations.length,
      brokenLinks: observations.filter((observation) => observation.result === "broken").length,
      observations,
    };
  } finally {
    await candidateJson(input.candidate.runtime.debugBase, input.candidateToken, "POST", "/state/ui", {
      openModal: "close",
      source: "final-surface-health-link-discovery-cleanup",
    }, input.fetchImpl).catch(() => undefined);
  }
}

function buildEvidence(input: {
  candidate: ReleaseSurfaceCandidateAttestation;
  collectorStartedAt: string;
  collectorCompletedAt: string;
  startup: ReleaseSurfaceHealthEvidence["startup"];
  links: ReleaseSurfaceHealthEvidence["links"];
  events: ObservedEvent[];
  scenarioStartedAt: string;
  shutdownRequestedAt: string;
  shutdownObservedAt: string;
}): ReleaseSurfaceHealthEvidence {
  const consoleEvents = input.events.filter((event) => event.kind === "console");
  const consoleStartedAtMs = Math.min(
    Date.parse(input.scenarioStartedAt),
    ...input.events.map((event) => event.observedAtMs),
  );
  const sequenceGapCount = eventSequenceGapCount(input.events);
  const consoleObservations: ReleaseSurfaceHealthEvidence["console"]["observations"] = consoleEvents.map((event) => ({
    level: event.level!,
    messageSha256: sha256(event.message!),
    classification: expectedReleaseSurfaceConsoleError(event.message!) ? "expected" : "unexpected",
    observedAt: new Date(event.observedAtMs).toISOString(),
  }));
  return {
    schema: RELEASE_SURFACE_HEALTH_EVIDENCE_SCHEMA,
    mode: "final-frozen-candidate",
    collector: {
      id: RELEASE_SURFACE_HEALTH_COLLECTOR_ID,
      sourceCommit: input.candidate.sourceCommit,
      startedAt: input.collectorStartedAt,
      completedAt: input.collectorCompletedAt,
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
    startup: input.startup,
    links: input.links,
    console: {
      scope: "installed-driver-console-subscription",
      startedAt: new Date(consoleStartedAtMs).toISOString(),
      completedAt: input.shutdownObservedAt,
      subscription: {
        collectorId: "installed-webview-console-subscription@1",
        openedAt: new Date(consoleStartedAtMs).toISOString(),
        closedAt: input.shutdownObservedAt,
        // A forceful native candidate shutdown is allowed to terminate the
        // WebView before `pagehide` can enqueue its best-effort `closed`
        // marker. The exact pre-delete checkpoint, contiguous event sequence,
        // successful session deletion, and observed candidate-PID absence are
        // the authoritative completeness boundary.
        gapCount: sequenceGapCount,
      },
      observedEvents: consoleObservations.length,
      unexpectedConsoleErrors: consoleObservations.filter((event) => event.classification === "unexpected").length,
      observations: consoleObservations,
    },
    shutdown: {
      requestedAt: input.shutdownRequestedAt,
      observedAt: input.shutdownObservedAt,
      processId: input.candidate.runtime.processId,
      mechanism: "webdriver-session-delete",
      processAbsent: true,
      elapsedMs: Date.parse(input.shutdownObservedAt) - Date.parse(input.shutdownRequestedAt),
    },
  };
}

function expectedReleaseSurfaceConsoleError(message: string): boolean {
  return message.includes("SHELLX_RELEASE_TEST_RENDERER_CRASH_035")
    && (message.includes("[ErrorBoundary] caught render-time throw:")
      || message.trimStart().startsWith("Error: SHELLX_RELEASE_TEST_RENDERER_CRASH_035"));
}

class HealthEventStore {
  private readonly bySequence = new Map<number, ObservedEvent>();
  private readonly waiters = new Set<() => void>();

  constructor(readonly token: string) {}

  add(event: ObservedEvent): void {
    if (this.bySequence.size >= MAX_EVENTS && !this.bySequence.has(event.sequence)) {
      throw new Error(`installed health observer exceeded ${MAX_EVENTS} events`);
    }
    const existing = this.bySequence.get(event.sequence);
    if (existing && JSON.stringify(existing) !== JSON.stringify(event)) {
      throw new Error(`installed health observer sequence ${event.sequence} changed payload`);
    }
    this.bySequence.set(event.sequence, event);
    for (const wake of this.waiters) wake();
  }

  event(sequence: number): ObservedEvent | undefined {
    return this.bySequence.get(sequence);
  }

  events(): ObservedEvent[] {
    return [...this.bySequence.values()].sort((left, right) => left.sequence - right.sequence);
  }

  async waitForSequence(sequence: number, timeoutMs: number): Promise<void> {
    await this.waitFor(() => this.bySequence.has(sequence), timeoutMs, `health observer sequence ${sequence}`);
  }

  async waitForKind(kind: ObservedEvent["kind"], timeoutMs: number): Promise<void> {
    await this.waitFor(
      () => [...this.bySequence.values()].some((event) => event.kind === kind),
      timeoutMs,
      `health observer event ${kind}`,
    );
  }

  private async waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return;
      await new Promise<void>((resolveWait) => {
        const wake = (): void => {
          clearTimeout(timeout);
          this.waiters.delete(wake);
          resolveWait();
        };
        const timeout = setTimeout(wake, Math.min(50, Math.max(1, deadline - Date.now())));
        this.waiters.add(wake);
      });
    }
    throw new Error(`${label} did not reach the loopback collector before timeout`);
  }
}

async function listenHealthServer(port: number, store: HealthEventStore): Promise<Server> {
  const server = createServer((request, response) => {
    void handleHealthEventRequest(request, response, store);
  });
  server.maxHeadersCount = 32;
  await new Promise<void>((resolveListen, rejectListen) => {
    const onError = (error: Error): void => rejectListen(error);
    server.once("error", onError);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", onError);
      resolveListen();
    });
  });
  return server;
}

async function handleHealthEventRequest(
  request: IncomingMessage,
  response: ServerResponse,
  store: HealthEventStore,
): Promise<void> {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Cache-Control", "no-store");
  if (request.method === "OPTIONS") {
    response.statusCode = 204;
    response.end();
    return;
  }
  try {
    if (request.socket.remoteAddress !== "127.0.0.1" && request.socket.remoteAddress !== "::ffff:127.0.0.1") {
      throw new HttpError(403, "loopback only");
    }
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method !== "POST" || url.pathname !== "/events") throw new HttpError(404, "not found");
    if (!safeTokenEqual(url.searchParams.get("token") ?? "", store.token)) throw new HttpError(401, "unauthorized");
    const body = await readBoundedBody(request);
    store.add(parseObservedEvent(JSON.parse(body)));
    response.statusCode = 204;
    response.end();
  } catch (error) {
    response.statusCode = error instanceof HttpError ? error.status : 400;
    response.end("rejected");
  }
}

function parseObservedEvent(value: unknown): ObservedEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("event must be an object");
  const event = value as Record<string, unknown>;
  const allowed = new Set(["sequence", "observedAtMs", "kind", "debugId", "href", "level", "message"]);
  if (Object.keys(event).some((key) => !allowed.has(key))) throw new Error("event contains unknown fields");
  if (!Number.isSafeInteger(event.sequence) || Number(event.sequence) <= 0) throw new Error("event sequence is invalid");
  if (!Number.isSafeInteger(event.observedAtMs) || Number(event.observedAtMs) <= 0) throw new Error("event time is invalid");
  if (!["ready", "link", "console", "checkpoint", "closed"].includes(String(event.kind))) {
    throw new Error("event kind is invalid");
  }
  const parsed: ObservedEvent = {
    sequence: Number(event.sequence),
    observedAtMs: Number(event.observedAtMs),
    kind: event.kind as ObservedEvent["kind"],
  };
  if (parsed.kind === "link") {
    if (typeof event.debugId !== "string" || !/^[a-zA-Z0-9._:-]{1,256}$/.test(event.debugId)) {
      throw new Error("link debug id is invalid");
    }
    if (typeof event.href !== "string" || event.href.length > 4_096 || !/^https?:\/\//i.test(event.href)) {
      throw new Error("link href is invalid");
    }
    parsed.debugId = event.debugId;
    parsed.href = event.href;
  } else if (parsed.kind === "console") {
    if (!["error", "window-error", "unhandled-rejection"].includes(String(event.level))) {
      throw new Error("console level is invalid");
    }
    if (typeof event.message !== "string" || !event.message.trim() || event.message.length > 4_096) {
      throw new Error("console message is invalid");
    }
    parsed.level = String(event.level);
    parsed.message = event.message;
  } else if (event.debugId !== undefined || event.href !== undefined || event.level !== undefined || event.message !== undefined) {
    throw new Error("non-payload event contains extra fields");
  }
  return parsed;
}

async function readBoundedBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += value.length;
    if (bytes > MAX_EVENT_BYTES) throw new HttpError(413, "event too large");
    chunks.push(value);
  }
  if (bytes === 0) throw new Error("event body is empty");
  return Buffer.concat(chunks).toString("utf8");
}

function uniqueLinkEvents(events: ObservedEvent[]): ObservedEvent[] {
  const values = new Map<string, ObservedEvent>();
  for (const event of events) {
    if (event.kind !== "link") continue;
    values.set(`${event.debugId}\0${event.href}`, event);
  }
  return [...values.values()].sort((left, right) => (
    `${left.debugId}\0${left.href}`.localeCompare(`${right.debugId}\0${right.href}`)
  ));
}

async function waitForExpectedLinks(
  store: HealthEventStore,
  expectedDebugIds: Set<string>,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const observed = new Set(uniqueLinkEvents(store.events()).map((event) => event.debugId!));
    if ([...expectedDebugIds].every((id) => observed.has(id))) return;
    await delay(50);
  }
  const observed = new Set(uniqueLinkEvents(store.events()).map((event) => event.debugId!));
  const missing = [...expectedDebugIds].filter((id) => !observed.has(id));
  throw new Error(`installed WebView did not render every link surface: ${missing.join(", ")}`);
}

async function candidateJson(
  base: string,
  token: string,
  method: "GET" | "POST",
  path: string,
  body: unknown,
  fetchImpl: typeof fetch,
): Promise<unknown> {
  const headers = new Headers({ Authorization: `Bearer ${token}` });
  if (body !== undefined) headers.set("Content-Type", "application/json");
  const response = await fetchImpl(`${base.replace(/\/$/, "")}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(5_000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`candidate ${method} ${path} returned ${response.status}: ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : {};
}

function requireExactCandidateHealth(value: unknown, candidate: ReleaseSurfaceCandidateAttestation): void {
  const health = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
  if (Number(health.processId) !== candidate.runtime.processId
    || String(health.instanceId ?? "") !== candidate.runtime.instanceId
    || String(health.appVersion ?? health.app_version ?? "") !== candidate.version
    || String(health.buildCommit ?? health.build_commit ?? "") !== candidate.sourceCommit
    || Number(health.debugApiPort ?? health.debug_api_port) !== candidate.runtime.debugPort) {
    throw new Error("health collector startup response does not identify the exact candidate");
  }
}

async function checkHttpLink(href: string): Promise<"ok" | "broken"> {
  try {
    const response = await fetch(href, {
      method: "GET",
      redirect: "follow",
      headers: { "User-Agent": "ShellX-Release-Link-Check/0.3.5" },
      signal: AbortSignal.timeout(15_000),
    });
    await response.body?.cancel();
    return response.status >= 200 && response.status < 400 ? "ok" : "broken";
  } catch {
    return "broken";
  }
}

async function waitForProcessAbsent(
  pid: number,
  processExists: (pid: number) => boolean,
  now: () => Date,
  timeoutMs: number,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processExists(pid)) return now().toISOString();
    await delay(50);
  }
  throw new Error(`candidate process ${pid} remained alive after WebDriver session deletion`);
}

function defaultProcessExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    throw error;
  }
}

function eventSequenceGapCount(events: ObservedEvent[]): number {
  if (events.length === 0) return 1;
  let gaps = 0;
  for (let index = 0; index < events.length; index += 1) {
    if (events[index]!.sequence !== index + 1) gaps += 1;
  }
  return gaps;
}

function jsonIdentity(value: unknown): { sha256: string; bytes: number } {
  const encoded = JSON.stringify(value);
  const bytes = Buffer.from(typeof encoded === "string" ? encoded : "");
  return { sha256: sha256(bytes), bytes: bytes.length };
}

function requireCreateOnlyOutput(path: string): string {
  const absolute = resolve(path);
  const parent = lstatSync(dirname(absolute));
  if (parent.isSymbolicLink() || !parent.isDirectory()) {
    throw new Error("health evidence output parent must be a regular non-link directory");
  }
  if (existsSync(absolute)) throw new Error(`health evidence already exists: ${absolute}`);
  return absolute;
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => error ? rejectClose(error) : resolveClose());
  });
}

function safeTokenEqual(value: string, expected: string): boolean {
  const left = Buffer.from(value);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function requireRenderedAnchorObservation(value: unknown): {
  matchCount: number;
  renderedCount: number;
  renderedExternalHrefCount: number;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("rendered anchor observation must be an object");
  }
  const observation = value as Record<string, unknown>;
  const counts = [
    observation.matchCount,
    observation.renderedCount,
    observation.renderedExternalHrefCount,
  ];
  if (!counts.every((count) => (
    typeof count === "number" && Number.isSafeInteger(count) && count >= 0 && count <= 128
  ))) {
    throw new Error("rendered anchor observation counts are invalid");
  }
  const [matchCount, renderedCount, renderedExternalHrefCount] = counts as [number, number, number];
  if (renderedExternalHrefCount > renderedCount || renderedCount > matchCount) {
    throw new Error("rendered anchor observation counts are invalid");
  }
  return { matchCount, renderedCount, renderedExternalHrefCount };
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

const INSTALL_HEALTH_OBSERVER_SCRIPT = `
const endpoint = arguments[0];
const observerKey = arguments[1];
if (typeof endpoint !== "string" || typeof observerKey !== "string" || window[observerKey]) {
  throw new Error("release health observer arguments are invalid or already installed");
}
const state = { sequence: 0, closing: false, seenLinks: new Set() };
const stringify = (value) => {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.stack || value.message || String(value);
  try { return JSON.stringify(value); } catch { return String(value); }
};
const send = (kind, fields = {}, beacon = false) => {
  if (state.closing && kind !== "closed") return state.sequence;
  const event = { sequence: ++state.sequence, observedAtMs: Date.now(), kind, ...fields };
  const body = JSON.stringify(event);
  if (beacon && navigator.sendBeacon) navigator.sendBeacon(endpoint, body);
  else void fetch(endpoint, { method: "POST", body, keepalive: true, cache: "no-store" }).catch(() => {});
  return event.sequence;
};
const scan = () => {
  for (const anchor of document.querySelectorAll("a[data-debug-id]")) {
    const debugId = anchor.getAttribute("data-debug-id") || "";
    const href = anchor.href || "";
    if (!debugId || !/^https?:\\/\\//i.test(href)) continue;
    const key = debugId + "\\u0000" + href;
    if (state.seenLinks.has(key)) continue;
    state.seenLinks.add(key);
    send("link", { debugId, href });
  }
};
const originalError = console.error.bind(console);
console.error = (...args) => {
  send("console", { level: "error", message: args.map(stringify).join(" ").slice(0, 4096) || "console.error" });
  originalError(...args);
};
const onError = (event) => send("console", {
  level: "window-error",
  message: String(event.message || event.error || "window error").slice(0, 4096),
});
const onRejection = (event) => send("console", {
  level: "unhandled-rejection",
  message: stringify(event.reason || "unhandled rejection").slice(0, 4096),
});
window.addEventListener("error", onError);
window.addEventListener("unhandledrejection", onRejection);
const mutations = new MutationObserver(scan);
mutations.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["href", "data-debug-id"] });
window.addEventListener("beforeunload", () => {
  if (state.closing) return;
  scan();
  state.closing = true;
  mutations.disconnect();
  send("closed", {}, true);
}, { once: true });
state.checkpoint = () => { scan(); return send("checkpoint"); };
window[observerKey] = state;
scan();
const readySequence = send("ready");
return { installed: true, readySequence };
`;

const FLUSH_HEALTH_OBSERVER_SCRIPT = `
const observerKey = arguments[0];
const state = window[observerKey];
if (!state || typeof state.checkpoint !== "function" || state.closing) {
  throw new Error("release health observer is unavailable");
}
return { checkpointSequence: state.checkpoint() };
`;

const RENDERED_ANCHOR_VISIBILITY_SCRIPT = `
const debugId = arguments[0];
if (typeof debugId !== "string" || !/^[a-zA-Z0-9._:-]{1,256}$/.test(debugId)) {
  throw new Error("rendered anchor debug id is invalid");
}
const candidates = Array.from(document.querySelectorAll("a[data-debug-id]"))
  .filter((anchor) => anchor.getAttribute("data-debug-id") === debugId);
const rendered = candidates.filter((anchor) => {
  if (!(anchor instanceof HTMLElement) || anchor.closest("[inert], [aria-hidden='true']")) return false;
  let current = anchor;
  while (current instanceof HTMLElement) {
    const style = getComputedStyle(current);
    if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse"
      || Number(style.opacity) <= 0) return false;
    current = current.parentElement;
  }
  if (typeof anchor.checkVisibility === "function" && !anchor.checkVisibility()) return false;
  for (const rect of anchor.getClientRects()) {
    const left = Math.max(0, rect.left);
    const right = Math.min(window.innerWidth, rect.right);
    const top = Math.max(0, rect.top);
    const bottom = Math.min(window.innerHeight, rect.bottom);
    if (right - left <= 1 || bottom - top <= 1) continue;
    const hit = document.elementFromPoint((left + right) / 2, (top + bottom) / 2);
    if (hit === anchor || (hit instanceof Node && anchor.contains(hit))) return true;
  }
  return false;
});
return {
  matchCount: candidates.length,
  renderedCount: rendered.length,
  renderedExternalHrefCount: rendered.filter((anchor) => /^https?:\\/\\//i.test(anchor.href || "")).length,
};
`;
