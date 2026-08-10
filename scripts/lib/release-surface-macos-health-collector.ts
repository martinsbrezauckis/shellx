import { createHash } from "node:crypto";
import { existsSync, lstatSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { ReleaseSurfaceCandidateAttestation } from "./release-surface-candidate-attestation";
import type { ReleaseSurfaceHealthEvidence } from "./release-surface-health-evidence";
import {
  RELEASE_SURFACE_HEALTH_COLLECTOR_ID,
  RELEASE_SURFACE_HEALTH_EVIDENCE_SCHEMA,
  validateReleaseSurfaceHealthEvidence,
} from "./release-surface-health-evidence";
import type { ReleaseSurfaceInventory } from "./release-surface-inventory";
import type { ReleaseSurfaceScenarioReport } from "./release-surface-scenario-report";
import type { ReleaseSurfaceInstalledInputSession } from "./release-surface-installed-input-client";
import {
  clickReleaseSurfaceInstalledInputElement,
  findReleaseSurfaceInstalledInputElement,
  observeReleaseSurfaceInstalledInputElement,
  waitForReleaseSurfaceInstalledInputElement,
  waitForReleaseSurfaceInstalledInputElementAbsent,
} from "./release-surface-installed-input-client";
import {
  assertReleaseSurfaceCollectorSource,
  type ReleaseSurfaceGitRunner,
} from "./release-surface-source-provenance";

const MACOS_HEALTH_TRACKED_SOURCES = [
  "scripts/lib/release-surface-macos-health-collector.ts",
  "scripts/lib/release-surface-health-evidence.ts",
  "scripts/lib/release-surface-installed-input-client.ts",
  "src/lib/debug-element-observation.ts",
  "src/components/ReleaseSurfaceRendererHealthObserver.tsx",
] as const;
const MAX_CAPTURED_EVENTS = 10_000;
// Keep the marker intentionally low-entropy. DebugHub recursively scrubs
// credential-shaped free-form strings before broadcasting /events frames; a
// run-id-bearing marker is correctly redacted and therefore cannot be matched
// by the collector. Every final run uses a fresh create-only profile, so this
// fixed marker cannot collide with an earlier run's backlog.
const RELEASE_SURFACE_MACOS_HEALTH_MARKER = "release-health-macos-g16";
const SETTINGS_DIALOG = "[role='dialog'][aria-label='Settings']";
const ABOUT_TAB = "[data-debug-id='settings-tab-about']";
const ABOUT_PANEL = "#settings-tab-panel[aria-labelledby='settings-tab-about']";
const QUICK_START_CONTROL = "[title='Read the shellX quick-start guide']";
const QUICK_START_DIALOG = "[role='dialog'][aria-label='Quick start']";
const QUICK_START_CLOSE = `${QUICK_START_DIALOG} [aria-label='Close (Esc)']`;
const MARKDOWN_SURFACE_NAME =
  'src/lib/markdown-links.tsx:[data-debug-id="surface-lib-markdown-links-2"]';

export const RELEASE_SURFACE_MACOS_RENDERED_LINK_TARGETS = [
  {
    surfaceName: 'src/components/settings/AboutTab.tsx:[data-debug-id="surface-components-settings-abouttab-4"]',
    selector: "[data-debug-id='surface-components-settings-abouttab-4']",
    href: "https://theshellx.com/",
  },
  {
    surfaceName: 'src/components/settings/AboutTab.tsx:[data-debug-id="surface-components-settings-abouttab-5"]',
    selector: "[data-debug-id='surface-components-settings-abouttab-5']",
    href: "https://x.com/theshellx",
  },
  {
    surfaceName: 'src/components/settings/AboutTab.tsx:[data-debug-id="about-full-manual-link"]',
    selector: "[data-debug-id='about-full-manual-link']",
    href: "https://docs.theshellx.com/manual/shellx/",
  },
  {
    surfaceName: 'src/components/settings/AboutTab.tsx:[data-debug-id="surface-components-settings-abouttab-9"]',
    selector: "[data-debug-id='surface-components-settings-abouttab-9']",
    href: "https://github.com/martinsbrezauckis/shellx",
  },
  {
    surfaceName: 'src/components/settings/AboutTab.tsx:[data-debug-id="surface-components-settings-abouttab-10"]',
    selector: "[data-debug-id='surface-components-settings-abouttab-10']",
    href: "https://github.com/martinsbrezauckis/shellx/issues",
  },
] as const;

export const RELEASE_SURFACE_MACOS_QUICK_START_LINK_TARGETS = [
  {
    surfaceName: MARKDOWN_SURFACE_NAME,
    selector: "[data-shellx-release-health-link='quick-start-releases']",
    href: "https://github.com/martinsbrezauckis/shellx/releases",
  },
  {
    surfaceName: MARKDOWN_SURFACE_NAME,
    selector: "[data-shellx-release-health-link='quick-start-issues']",
    href: "https://github.com/martinsbrezauckis/shellx/issues",
  },
] as const;

type RawEvent = { t: number; kind: string; payload: unknown };

export interface ReleaseSurfaceMacosHealthCollector {
  scenarioStartedAt: string;
  discoverRenderedLinks(session: ReleaseSurfaceInstalledInputSession): Promise<void>;
  beginShutdown(requestedAt?: string): string;
  finalize(input: {
    shutdownObservedAt: string;
    mechanism: string;
  }): Promise<{ evidence: ReleaseSurfaceHealthEvidence; outputPath: string; scenarioStartedAt: string }>;
  abort(): void;
}

export async function startReleaseSurfaceMacosHealthCollector(input: {
  candidate: ReleaseSurfaceCandidateAttestation;
  candidateToken: string;
  inventory: ReleaseSurfaceInventory;
  outputPath: string;
  repositoryRoot?: string;
  runGit?: ReleaseSurfaceGitRunner;
  fetchImpl?: typeof fetch;
  checkLink?: (href: string) => Promise<"ok" | "broken">;
  openWebSocket?: (url: string) => WebSocket;
  now?: () => Date;
}): Promise<ReleaseSurfaceMacosHealthCollector> {
  if (input.candidate.platform !== "macos-installed") {
    throw new Error("macOS health collection requires a macos-installed candidate");
  }
  if (input.candidateToken.trim().length < 32) throw new Error("macOS health candidate token is invalid");
  if (!Array.isArray(input.inventory?.items) || !input.inventory.digest?.trim()) {
    throw new Error("macOS health collection requires the exact surface inventory");
  }
  assertReleaseSurfaceCollectorSource({
    sourceCommit: input.candidate.sourceCommit,
    repositoryRoot: input.repositoryRoot ?? resolve(import.meta.dirname, "../.."),
    trackedSources: MACOS_HEALTH_TRACKED_SOURCES,
    runGit: input.runGit,
  });
  const outputPath = createOnlyOutput(input.outputPath);
  const fetchImpl = input.fetchImpl ?? fetch;
  const now = createReleaseSurfaceMacosNondecreasingClock(input.now ?? (() => new Date()));
  const collectorStartedAt = now().toISOString();
  const startupResponse = await candidateJson(
    input.candidate.runtime.debugBase,
    input.candidateToken,
    "GET",
    "/health",
    undefined,
    fetchImpl,
    false,
  );
  requireExactCandidateHealth(startupResponse, input.candidate);
  const startupObservedAt = now().toISOString();
  const startupIdentity = jsonIdentity(startupResponse);
  const stream = await openMacosHealthEventStream({
    base: input.candidate.runtime.debugBase,
    token: input.candidateToken,
    sourceCommit: input.candidate.sourceCommit,
    openWebSocket: input.openWebSocket,
    now,
  });
  const marker = RELEASE_SURFACE_MACOS_HEALTH_MARKER;
  const markerObserved = stream.beginAtMarker(marker);
  void markerObserved.catch(() => undefined);
  let scenarioStartedAt: string;
  try {
    await candidateJson(
      input.candidate.runtime.debugBase,
      input.candidateToken,
      "POST",
      "/state/ui",
      { source: marker },
      fetchImpl,
    );
    scenarioStartedAt = await markerObserved;
  } catch (error) {
    stream.abort();
    await markerObserved.catch(() => undefined);
    throw error;
  }
  let links: ReleaseSurfaceHealthEvidence["links"] | null = null;
  let shutdownRequestedAt: string | null = null;

  return {
    scenarioStartedAt,
    async discoverRenderedLinks(session): Promise<void> {
      if (links) throw new Error("macOS rendered links may be discovered only once");
      links = await collectMacosRenderedLinks({
        candidate: input.candidate,
        token: input.candidateToken,
        inventory: input.inventory,
        session,
        fetchImpl,
        checkLink: input.checkLink ?? checkHttpLink,
        now,
      });
    },
    beginShutdown(requestedAt = now().toISOString()): string {
      if (!links) throw new Error("macOS health shutdown cannot begin before rendered-link discovery");
      if (shutdownRequestedAt) throw new Error("macOS health shutdown was already requested");
      if (!Number.isFinite(Date.parse(requestedAt))) throw new Error("macOS health shutdown timestamp is invalid");
      shutdownRequestedAt = requestedAt;
      stream.expectCandidateShutdown();
      return requestedAt;
    },
    async finalize({ shutdownObservedAt, mechanism }) {
      if (!links || !shutdownRequestedAt) {
        throw new Error("macOS health evidence cannot finalize before links and shutdown request");
      }
      if (!mechanism.trim() || !Number.isFinite(Date.parse(shutdownObservedAt))) {
        throw new Error("macOS health shutdown observation is invalid");
      }
      await stream.waitForExpectedClose();
      const consoleObservations = stream.consoleObservations(shutdownObservedAt);
      const collectorCompletedAt = now().toISOString();
      const evidence: ReleaseSurfaceHealthEvidence = {
        schema: RELEASE_SURFACE_HEALTH_EVIDENCE_SCHEMA,
        mode: "final-frozen-candidate",
        collector: {
          id: RELEASE_SURFACE_HEALTH_COLLECTOR_ID,
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
        startup: {
          observedAt: startupObservedAt,
          responseSha256: startupIdentity.sha256,
          responseBytes: startupIdentity.bytes,
          response: startupResponse,
        },
        links,
        console: {
          scope: "installed-driver-console-subscription",
          startedAt: scenarioStartedAt,
          completedAt: shutdownObservedAt,
          subscription: {
            collectorId: "installed-webview-console-subscription@1",
            openedAt: scenarioStartedAt,
            closedAt: shutdownObservedAt,
            gapCount: stream.gapCount(),
          },
          observedEvents: consoleObservations.length,
          unexpectedConsoleErrors: consoleObservations.filter((event) => event.classification === "unexpected").length,
          observations: consoleObservations,
        },
        shutdown: {
          requestedAt: shutdownRequestedAt,
          observedAt: shutdownObservedAt,
          processId: input.candidate.runtime.processId,
          mechanism,
          processAbsent: true,
          elapsedMs: Date.parse(shutdownObservedAt) - Date.parse(shutdownRequestedAt),
        },
      };
      const scenario = {
        startedAt: scenarioStartedAt,
        completedAt: shutdownObservedAt,
        health: {
          brokenLinks: evidence.links.brokenLinks,
          unexpectedConsoleErrors: evidence.console.unexpectedConsoleErrors,
        },
      } as ReleaseSurfaceScenarioReport;
      const errors = validateReleaseSurfaceHealthEvidence({
        evidence,
        candidate: input.candidate,
        scenario,
        knownSurfaceIds: new Set(input.inventory.items.map((item) => item.id)),
        expectedLinkSurfaceIds: expectedLinkSurfaceIds(input.inventory),
      });
      if (errors.length > 0) {
        throw new Error(`collected macOS health evidence is invalid: ${errors.join("; ")}`);
      }
      writeFileSync(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      return { evidence, outputPath, scenarioStartedAt };
    },
    abort(): void {
      stream.abort();
    },
  };
}

async function collectMacosRenderedLinks(input: {
  candidate: ReleaseSurfaceCandidateAttestation;
  token: string;
  inventory: ReleaseSurfaceInventory;
  session: ReleaseSurfaceInstalledInputSession;
  fetchImpl: typeof fetch;
  checkLink: (href: string) => Promise<"ok" | "broken">;
  now: () => Date;
}): Promise<ReleaseSurfaceHealthEvidence["links"]> {
  if (input.session.transport !== "macos-native-input") {
    throw new Error("macOS rendered-link collection requires the exact native-input session");
  }
  const startedAt = input.now().toISOString();
  const observations: ReleaseSurfaceHealthEvidence["links"]["observations"] = [];
  let collected = false;
  try {
    await candidateJson(input.candidate.runtime.debugBase, input.token, "POST", "/state/ui", {
      openModal: "settings",
      source: "final-surface-macos-health-links",
    }, input.fetchImpl);
    await waitForReleaseSurfaceInstalledInputElement(input.session, SETTINGS_DIALOG);
    const about = await waitForReleaseSurfaceInstalledInputElement(input.session, ABOUT_TAB);
    await clickReleaseSurfaceInstalledInputElement(input.session, about);
    await waitForReleaseSurfaceInstalledInputElement(input.session, ABOUT_PANEL);
    for (const target of RELEASE_SURFACE_MACOS_RENDERED_LINK_TARGETS) {
      observations.push(await observeTarget(input, target));
    }
    const quickStart = await waitForReleaseSurfaceInstalledInputElement(input.session, QUICK_START_CONTROL);
    await clickReleaseSurfaceInstalledInputElement(input.session, quickStart);
    await waitForReleaseSurfaceInstalledInputElement(input.session, QUICK_START_DIALOG);
    for (const target of RELEASE_SURFACE_MACOS_QUICK_START_LINK_TARGETS) {
      observations.push(await observeTarget(input, target));
    }
    collected = true;
  } finally {
    const cleanupFailures: string[] = [];
    const attempt = async (label: string, action: () => Promise<unknown>): Promise<void> => {
      try {
        await action();
      } catch (error) {
        cleanupFailures.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
      }
    };
    let close: Awaited<ReturnType<typeof findReleaseSurfaceInstalledInputElement>> = null;
    await attempt("locate quick-start close", async () => {
      close = await findReleaseSurfaceInstalledInputElement(input.session, QUICK_START_CLOSE);
    });
    if (close) {
      await attempt("close quick-start dialog", () => clickReleaseSurfaceInstalledInputElement(input.session, close!));
    }
    await attempt("observe quick-start dialog absent", () => (
      waitForReleaseSurfaceInstalledInputElementAbsent(input.session, QUICK_START_DIALOG)
    ));
    await attempt("request settings cleanup", () => candidateJson(
      input.candidate.runtime.debugBase,
      input.token,
      "POST",
      "/state/ui",
      { openModal: "close", source: "final-surface-macos-health-links-cleanup" },
      input.fetchImpl,
    ));
    await attempt("observe settings dialog absent", () => (
      waitForReleaseSurfaceInstalledInputElementAbsent(input.session, SETTINGS_DIALOG)
    ));
    if (collected && cleanupFailures.length > 0) {
      throw new Error(`macOS rendered-link cleanup was incomplete: ${cleanupFailures.join("; ")}`);
    }
  }
  const completedAt = input.now().toISOString();
  const identities = observations.map((item) => `${item.sourceSurfaceId}:${item.hrefSha256}`).sort();
  return {
    scope: "installed-driver-discovered-rendered-app-links",
    startedAt,
    completedAt,
    discovery: {
      collectorId: "installed-ui-rendered-link-discovery@1",
      startedAt,
      completedAt,
      discoveredCount: identities.length,
      identitySetSha256: sha256(JSON.stringify(identities)),
      gapCount: 0,
    },
    checkedCount: observations.length,
    brokenLinks: observations.filter((item) => item.result === "broken").length,
    observations,
  };
}

async function observeTarget(
  input: Parameters<typeof collectMacosRenderedLinks>[0],
  target: { surfaceName: string; selector: string; href: string },
): Promise<ReleaseSurfaceHealthEvidence["links"]["observations"][number]> {
  const item = input.inventory.items.find((candidate) => (
    candidate.kind === "ui-control"
    && candidate.name === target.surfaceName
    && candidate.platforms.includes("macos-installed")
  ));
  if (!item) throw new Error(`macOS health link target is absent from inventory: ${target.surfaceName}`);
  const observed = await observeReleaseSurfaceInstalledInputElement(input.session, target.selector, ["href"]);
  if (!observed.present || observed.href !== target.href) {
    throw new Error(`macOS rendered link drifted for ${target.surfaceName}`);
  }
  return {
    sourceSurfaceId: item.id,
    hrefSha256: sha256(observed.href),
    result: await input.checkLink(observed.href),
    observedAt: input.now().toISOString(),
  };
}

function expectedLinkSurfaceIds(inventory: ReleaseSurfaceInventory): Set<string> {
  const names = new Set([
    ...RELEASE_SURFACE_MACOS_RENDERED_LINK_TARGETS.map((target) => target.surfaceName),
    MARKDOWN_SURFACE_NAME,
  ]);
  const ids = new Set(inventory.items.filter((item) => (
    item.kind === "ui-control"
    && item.platforms.includes("macos-installed")
    && names.has(item.name)
  )).map((item) => item.id));
  if (ids.size !== names.size) throw new Error("macOS health link inventory coverage is incomplete");
  return ids;
}

async function openMacosHealthEventStream(input: {
  base: string;
  token: string;
  sourceCommit: string;
  openWebSocket?: (url: string) => WebSocket;
  now: () => Date;
}) {
  const events: RawEvent[] = [];
  let markerSource: string | null = null;
  let markerStartedAt: string | null = null;
  let expectingShutdown = false;
  let closed = false;
  let aborted = false;
  let gaps = 0;
  let fatal: Error | null = null;
  const url = new URL(input.base.replace(/^http:/, "ws:"));
  url.pathname = "/events";
  url.searchParams.set("token", input.token);
  const socket = (input.openWebSocket ?? ((value) => new WebSocket(value)))(url.toString());
  socket.addEventListener("message", (message) => {
    try {
      if (typeof message.data !== "string") throw new Error("macOS health event frame was not text");
      const event = JSON.parse(message.data) as RawEvent;
      if (event.kind === "debug-api" && isRecord(event.payload) && event.payload.warning === "lagged") {
        gaps += 1;
        return;
      }
      if (!Number.isSafeInteger(event.t) || event.t <= 0 || typeof event.kind !== "string") return;
      if (!markerStartedAt && markerSource && event.kind === "debug-ui-state-patch"
        && debugUiPatchSource(event.payload) === markerSource) {
        markerStartedAt = new Date(event.t).toISOString();
      }
      if (markerStartedAt) {
        if (events.length >= MAX_CAPTURED_EVENTS) throw new Error("macOS health event capture exceeded its bound");
        events.push(event);
      }
    } catch (error) {
      fatal = error instanceof Error ? error : new Error(String(error));
    }
  });
  socket.addEventListener("close", () => {
    closed = true;
    if (!expectingShutdown && !aborted) fatal = new Error("macOS health event stream closed before candidate shutdown");
  });
  socket.addEventListener("error", () => {
    if (!expectingShutdown && !aborted) fatal = new Error("macOS health event stream failed before candidate shutdown");
  });
  await waitForSocketOpen(socket);
  return {
    async beginAtMarker(source: string): Promise<string> {
      if (markerSource) throw new Error("macOS health event marker was already configured");
      markerSource = source;
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        if (aborted) throw new Error("macOS health event stream was aborted before its start marker");
        if (fatal) throw fatal;
        if (markerStartedAt) return markerStartedAt;
        await delay(25);
      }
      throw new Error("macOS health event stream did not observe its exact start marker");
    },
    expectCandidateShutdown(): void {
      if (fatal) throw fatal;
      expectingShutdown = true;
    },
    async waitForExpectedClose(): Promise<void> {
      const deadline = Date.now() + 5_000;
      while (!closed && Date.now() < deadline) await delay(25);
      if (fatal) throw fatal;
      if (!closed) {
        socket.close();
        throw new Error("macOS health event stream remained open after candidate teardown");
      }
      if (gaps !== 0) throw new Error("macOS health event subscription reported a capture gap");
    },
    gapCount(): number {
      return gaps;
    },
    consoleObservations(shutdownObservedAt: string): ReleaseSurfaceHealthEvidence["console"]["observations"] {
      if (!markerStartedAt) throw new Error("macOS health console collection has no start marker");
      const endMs = Date.parse(shutdownObservedAt);
      return events.filter((event) => event.kind === "renderer-error" && event.t <= endMs).map((event) => {
        const payload = isRecord(event.payload) ? event.payload : {};
        const message = [payload.message, payload.stack, payload.componentStack]
          .filter((value): value is string => typeof value === "string")
          .join("\n")
          .slice(0, 12_000);
        return {
          level: "error",
          messageSha256: sha256(message || "renderer-error"),
          classification: expectedConsoleError(message, payload, input.sourceCommit)
            ? "expected" as const
            : "unexpected" as const,
          observedAt: new Date(event.t).toISOString(),
        };
      });
    },
    abort(): void {
      aborted = true;
      socket.close();
    },
  };
}

function debugUiPatchSource(payload: unknown): string | null {
  if (!isRecord(payload) || !isRecord(payload.patch)) return null;
  return typeof payload.patch.source === "string" ? payload.patch.source : null;
}

function waitForSocketOpen(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.OPEN) return Promise.resolve();
  return new Promise((resolveOpen, rejectOpen) => {
    const timeout = setTimeout(() => rejectOpen(new Error("macOS health event stream did not open")), 5_000);
    socket.addEventListener("open", () => {
      clearTimeout(timeout);
      resolveOpen();
    }, { once: true });
    socket.addEventListener("error", () => {
      clearTimeout(timeout);
      rejectOpen(new Error("macOS health event stream failed to open"));
    }, { once: true });
  });
}

async function candidateJson(
  base: string,
  token: string,
  method: "GET" | "POST",
  path: string,
  body: unknown,
  fetchImpl: typeof fetch,
  authenticated = true,
): Promise<unknown> {
  const response = await fetchImpl(`${base}${path}`, {
    method,
    headers: {
      ...(authenticated ? { Authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(10_000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`candidate ${method} ${path} returned ${response.status}: ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : {};
}

function requireExactCandidateHealth(value: unknown, candidate: ReleaseSurfaceCandidateAttestation): void {
  const health = isRecord(value) ? value : {};
  if (Number(health.processId) !== candidate.runtime.processId
    || String(health.instanceId ?? "") !== candidate.runtime.instanceId
    || String(health.appVersion ?? health.app_version ?? "") !== candidate.version
    || String(health.buildCommit ?? health.build_commit ?? "") !== candidate.sourceCommit
    || Number(health.debugApiPort ?? health.debug_api_port) !== candidate.runtime.debugPort) {
    throw new Error("macOS health startup response does not identify the exact candidate");
  }
}

async function checkHttpLink(href: string): Promise<"ok" | "broken"> {
  try {
    const response = await fetch(href, {
      method: "GET",
      redirect: "follow",
      headers: { "User-Agent": "ShellX-Release-Link-Check/1" },
      signal: AbortSignal.timeout(15_000),
    });
    await response.body?.cancel();
    return response.status >= 200 && response.status < 400 ? "ok" : "broken";
  } catch {
    return "broken";
  }
}

function expectedConsoleError(
  message: string,
  payload: Record<string, unknown>,
  sourceCommit: string,
): boolean {
  const directDriverMarker = `SHELLX_RELEASE_RENDERER_ERROR_${sourceCommit.slice(0, 16)}`;
  if (payload.message === directDriverMarker
    && payload.stack === "final-surface-renderer-stack"
    && payload.componentStack === "final-surface-component-stack") {
    return true;
  }
  return message.includes("SHELLX_RELEASE_TEST_RENDERER_CRASH_035")
    && (message.includes("[ErrorBoundary] caught render-time throw:")
      || message.trimStart().startsWith("Error: SHELLX_RELEASE_TEST_RENDERER_CRASH_035"));
}

function jsonIdentity(value: unknown): { sha256: string; bytes: number } {
  const encoded = JSON.stringify(value);
  const bytes = Buffer.from(typeof encoded === "string" ? encoded : "");
  return { sha256: sha256(bytes), bytes: bytes.length };
}

function createOnlyOutput(path: string): string {
  const absolute = resolve(path);
  if (existsSync(absolute)) throw new Error(`macOS health output already exists: ${absolute}`);
  const parent = lstatSync(dirname(absolute));
  if (parent.isSymbolicLink() || !parent.isDirectory()) {
    throw new Error("macOS health output parent must be a regular non-link directory");
  }
  return absolute;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

export function createReleaseSurfaceMacosNondecreasingClock(
  read: () => Date,
): () => Date {
  let lastMs = Number.NEGATIVE_INFINITY;
  return () => {
    const nextMs = read().getTime();
    if (!Number.isFinite(nextMs)) throw new Error("macOS health clock returned an invalid date");
    lastMs = Math.max(lastMs, nextMs);
    return new Date(lastMs);
  };
}
