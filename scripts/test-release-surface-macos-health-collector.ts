import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ReleaseSurfaceCandidateAttestation } from "./lib/release-surface-candidate-attestation";
import {
  RELEASE_SURFACE_MACOS_QUICK_START_LINK_TARGETS,
  RELEASE_SURFACE_MACOS_RENDERED_LINK_TARGETS,
  startReleaseSurfaceMacosHealthCollector,
} from "./lib/release-surface-macos-health-collector";
import type { ReleaseSurfaceInstalledInputSession } from "./lib/release-surface-installed-input-client";
import type { ReleaseSurfaceInventory } from "./lib/release-surface-inventory";
import {
  RELEASE_SURFACE_MACOS_NATIVE_INPUT_HELPER_RESPONSE_SCHEMA,
  type ReleaseSurfaceMacosNativeInputHelperRequest,
  type ReleaseSurfaceMacosNativeInputHelperResponse,
} from "./lib/release-surface-macos-native-input";

const root = resolve(import.meta.dirname, "..");
const temp = mkdtempSync(join(tmpdir(), "shellx-macos-health-"));
const inventory = JSON.parse(
  readFileSync(join(root, "release", "surface-inventory.json"), "utf8"),
) as ReleaseSurfaceInventory;
const candidate = fixtureCandidate();
const hrefBySelector = new Map<string, string>([
  ...RELEASE_SURFACE_MACOS_RENDERED_LINK_TARGETS,
  ...RELEASE_SURFACE_MACOS_QUICK_START_LINK_TARGETS,
].map((target) => [target.selector, target.href]));
let active: { id: string; selector: string; observe: string[] } | null = null;
let settingsOpen = false;
let quickStartOpen = false;
let quickStartCloseResolutions = 0;
let fixtureSocket: FixtureWebSocket | null = null;
let helperClicks = 0;
let actualMarkerTime = 0;
let postedHealthMarker: string | null = null;
const originalFetch = globalThis.fetch;

class FixtureWebSocket extends EventTarget {
  readyState: number = WebSocket.CONNECTING;

  constructor() {
    super();
    queueMicrotask(() => {
      this.readyState = WebSocket.OPEN;
      this.dispatchEvent(new Event("open"));
    });
  }

  emit(kind: string, payload: unknown, t = Date.now()): void {
    this.dispatchEvent(new MessageEvent("message", {
      data: JSON.stringify({ t, kind, payload }),
    }));
  }

  close(): void {
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSED;
    this.dispatchEvent(new Event("close"));
  }
}

try {
  const fixtureFetch: typeof fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path === "/health") {
      return Response.json({
        processId: candidate.runtime.processId,
        instanceId: candidate.runtime.instanceId,
        appVersion: candidate.version,
        buildCommit: candidate.sourceCommit,
        debugApiPort: candidate.runtime.debugPort,
      });
    }
    if (path !== "/state/ui") return new Response("not found", { status: 404 });
    if ((init?.method ?? "GET") === "POST") {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        source?: string;
        openModal?: string;
        debugHighlights?: Array<{ id?: string; selector?: string; observe?: string[] }>;
      };
      if (body.openModal === "settings") settingsOpen = true;
      if (body.openModal === "close") settingsOpen = false;
      const highlight = body.debugHighlights?.[0];
      active = highlight?.id && highlight.selector
        ? { id: highlight.id, selector: highlight.selector, observe: highlight.observe ?? [] }
        : body.debugHighlights ? null : active;
      if (body.source === "release-health-macos-g16") {
        postedHealthMarker = body.source;
        const decoyMarkerTime = Date.now();
        actualMarkerTime = decoyMarkerTime + 1;
        fixtureSocket?.emit("debug-ui-state-patch", { source: body.source }, decoyMarkerTime);
        fixtureSocket?.emit("debug-ui-state-patch", {
          patch: { source: body.source },
          state: { lastUiPatchSource: body.source },
        }, actualMarkerTime);
      }
      return Response.json({ ok: true });
    }
    if (!active) return Response.json({ debugHighlightResultsBySurface: { app: [], browser: [] } });
    const isSettings = active.selector === "[role='dialog'][aria-label='Settings']";
    const isQuickStartControl = active.selector === "[title='Read the shellX quick-start guide']";
    const isQuickStart = active.selector === "[role='dialog'][aria-label='Quick start']";
    const isQuickStartClose = active.selector.endsWith("[aria-label='Close (Esc)']");
    if (isQuickStartControl) quickStartOpen = true;
    const present = (!isSettings || settingsOpen) && (!isQuickStart || quickStartOpen)
      && (!isQuickStartClose || quickStartOpen);
    const href = hrefBySelector.get(active.selector);
    const offscreen = active.selector.includes("quick-start-issues");
    const row = {
      id: active.id,
      selector: active.selector,
      status: present ? offscreen ? "hidden" : "resolved" : "missing",
      ...(present ? {
        ...(offscreen ? {
          message: "matched element is outside the visible viewport",
          rect: { left: 20, top: 900, width: 300, height: 24 },
        } : {
          visibleRect: { left: 20, top: 40, width: 300, height: 24 },
        }),
        viewportWidth: 1200,
        viewportHeight: 800,
        observation: href && active.observe.includes("href") ? { href } : {},
      } : {}),
    };
    if (isQuickStartClose && present) {
      quickStartCloseResolutions += 1;
      if (quickStartCloseResolutions >= 2) quickStartOpen = false;
    }
    return Response.json({ debugHighlightResultsBySurface: { app: [row], browser: [] } });
  };
  globalThis.fetch = fixtureFetch;
  const session = fixtureInstalledInputSession();
  const checkedLinks: string[] = [];
  const collector = await startReleaseSurfaceMacosHealthCollector({
    candidate,
    candidateToken: "fixture-candidate-token".padEnd(48, "t"),
    inventory,
    outputPath: join(temp, "macos-health.json"),
    repositoryRoot: root,
    runGit: fixtureHealthGit,
    fetchImpl: fixtureFetch,
    checkLink: async (href) => {
      checkedLinks.push(href);
      return "ok";
    },
    openWebSocket: () => {
      fixtureSocket = new FixtureWebSocket();
      return fixtureSocket as unknown as WebSocket;
    },
  });
  assert.equal(
    collector.scenarioStartedAt,
    new Date(actualMarkerTime).toISOString(),
    "the health collector must bind the production nested patch envelope, not a top-level source decoy",
  );
  assert.equal(
    postedHealthMarker,
    "release-health-macos-g16",
    "the health marker must remain a stable non-secret string that survives event credential scrubbing",
  );
  await collector.discoverRenderedLinks(session);
  assert.equal(checkedLinks.length, 7);
  assert(checkedLinks.every((href) => href.startsWith("https://")));
  assert.equal(settingsOpen, false, "rendered-link collection closes Settings before drivers continue");
  assert.equal(quickStartOpen, false, "rendered-link collection closes Quick start before drivers continue");
  assert(helperClicks >= 3, "native input opened About, Quick start, and its close control");
  fixtureSocket!.emit("renderer-error", {
    message: "[ErrorBoundary] caught render-time throw: Error: SHELLX_RELEASE_TEST_RENDERER_CRASH_035",
  });
  fixtureSocket!.emit("renderer-error", {
    message: `SHELLX_RELEASE_RENDERER_ERROR_${candidate.sourceCommit.slice(0, 16)}`,
    stack: "final-surface-renderer-stack",
    componentStack: "final-surface-component-stack",
  });
  const requestedAt = collector.beginShutdown();
  fixtureSocket!.close();
  const result = await collector.finalize({
    shutdownObservedAt: new Date(Math.max(Date.now(), Date.parse(requestedAt))).toISOString(),
    mechanism: "fixture-native-finalizer",
  });
  assert.equal(result.evidence.links.checkedCount, 7);
  assert.equal(result.evidence.links.discovery.discoveredCount, 7);
  assert.equal(result.evidence.links.brokenLinks, 0);
  assert.equal(result.evidence.console.observedEvents, 2);
  assert.equal(result.evidence.console.unexpectedConsoleErrors, 0);
  assert(result.evidence.console.observations.every((row) => row.classification === "expected"));
  assert.equal(result.evidence.shutdown.processAbsent, true);
  assert.deepEqual(JSON.parse(readFileSync(result.outputPath, "utf8")), result.evidence);

  console.log("Release surface macOS lifecycle health collector tests passed");
} finally {
  globalThis.fetch = originalFetch;
  rmSync(temp, { recursive: true, force: true });
}

function fixtureInstalledInputSession(): ReleaseSurfaceInstalledInputSession {
  return {
    transport: "macos-native-input",
    request: {
      platform: "macos-installed",
      runtime: {
        processId: candidate.runtime.processId,
        instanceId: candidate.runtime.instanceId,
        debugBase: candidate.runtime.debugBase,
        debugTokenPath: candidate.runtime.debugTokenPath,
        mcpBase: candidate.runtime.mcpBase,
        mcpTokenPath: candidate.runtime.mcpTokenPath,
        executableSha256: candidate.process.executableSha256,
        installedPayloadPath: candidate.process.executablePath,
        installedManifestSha256: candidate.installation.payloadManifestSha256,
      },
      macosNativeInput: {
        helperPath: "/tmp/shellx-release-macos-native-input",
        expectedWindowTitle: "shellX",
        windowNumber: 71,
        helper: { basename: "shellx-release-macos-native-input", sha256: "d".repeat(64), bytes: 2048 },
        evidence: { basename: "binding.json", sha256: "e".repeat(64), bytes: 1024 },
      },
    },
    base: candidate.runtime.debugBase,
    token: "fixture-candidate-token".padEnd(48, "t"),
    activeWindow: { handle: "macos-native:app", surface: "app", title: "shellX", windowNumber: 71 },
    runHelper: (_path: string, action: ReleaseSurfaceMacosNativeInputHelperRequest) => {
      helperClicks += 1;
      return appliedResponse(action);
    },
  } as ReleaseSurfaceInstalledInputSession;
}

function appliedResponse(
  action: ReleaseSurfaceMacosNativeInputHelperRequest,
): ReleaseSurfaceMacosNativeInputHelperResponse {
  return {
    schema: RELEASE_SURFACE_MACOS_NATIVE_INPUT_HELPER_RESPONSE_SCHEMA,
    ok: true,
    action: action.action,
    status: action.action === "preflight" ? "ready" : "applied",
    candidate: {
      processId: candidate.runtime.processId,
      executableSha256: candidate.process.executableSha256,
      pathMatched: true,
    },
    permissions: { accessibilityTrusted: true, eventPostingTrusted: true, promptRequested: false },
    window: {
      number: 71,
      ownerProcessId: candidate.runtime.processId,
      titleSha256: sha256("shellX"),
      bounds: { left: 0, top: 0, width: 1200, height: 800 },
      webAreaBounds: { left: 0, top: 0, width: 1200, height: 800 },
      webAreaSource: "ax-web-area",
    },
    mapping: { valid: true, screenX: 100, screenY: 100 },
    effect: { applicationActivated: action.action !== "preflight", eventsPosted: action.action === "preflight" ? 0 : 1 },
  };
}

function fixtureCandidate(): ReleaseSurfaceCandidateAttestation {
  return {
    schema: "shellx/release-surface-candidate-attestation@5",
    mode: "final-frozen-candidate",
    platform: "macos-installed",
    sourceCommit: "b".repeat(40),
    version: "0.3.5",
    createdAt: new Date().toISOString(),
    distributionArtifact: { basename: "shellX.dmg", sha256: "a".repeat(64), bytes: 4096 },
    installation: {
      method: "installer-observed",
      sourceArtifactSha256: "a".repeat(64),
      receipt: { basename: "macos-installation.json", sha256: "c".repeat(64), bytes: 1024 },
      payloadManifestSha256: "f".repeat(64),
    },
    installedPayload: {
      basename: "shellX",
      sha256: "d".repeat(64),
      bytes: 2048,
      path: "/Applications/shellX.app/Contents/MacOS/shellX",
    },
    process: {
      pid: 4321,
      executablePath: "/Applications/shellX.app/Contents/MacOS/shellX",
      executableSha256: "d".repeat(64),
    },
    runtime: {
      processId: 4321,
      instanceId: "fixture-macos-health-0001",
      debugBase: "http://127.0.0.1:31341",
      debugPort: 31341,
      debugTokenPath: "/tmp/debug.token",
      mcpBase: "http://127.0.0.1:31342",
      mcpPort: 31342,
      mcpTokenPath: "/tmp/mcp.token",
      appVersion: "0.3.5",
      buildCommit: "b".repeat(40),
    },
  } as ReleaseSurfaceCandidateAttestation;
}

function fixtureHealthGit(args: string[]): string {
  if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return `${root}\n`;
  if (args[0] === "rev-parse" && args[1] === "HEAD") return `${candidate.sourceCommit}\n`;
  if (args[0] === "status") return "";
  if (args[0] === "ls-files") {
    return [
      "scripts/lib/release-surface-macos-health-collector.ts",
      "scripts/lib/release-surface-health-evidence.ts",
      "scripts/lib/release-surface-installed-input-client.ts",
      "src/lib/debug-element-observation.ts",
      "src/components/ReleaseSurfaceRendererHealthObserver.tsx",
      "",
    ].join("\n");
  }
  throw new Error(`unexpected macOS health git probe ${args.join(" ")}`);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
