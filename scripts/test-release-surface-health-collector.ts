import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ReleaseSurfaceCandidateAttestation } from "./lib/release-surface-candidate-attestation";
import {
  createReleaseSurfaceNondecreasingClock,
  startReleaseSurfaceHealthCollector,
  waitForReleaseSurfaceRenderedAnchor,
} from "./lib/release-surface-health-collector";
import type { ReleaseSurfaceInventory } from "./lib/release-surface-inventory";

const root = resolve(import.meta.dirname, "..");
const temp = mkdtempSync(join(tmpdir(), "shellx-health-collector-"));
let fixtureStaleElementReturned = false;
const webdriverServer = await createFixtureWebDriverServer();
try {
  const clockValues = [
    new Date("2026-07-29T12:00:00.100Z"),
    new Date("2026-07-29T12:00:00.050Z"),
    new Date("2026-07-29T12:00:00.200Z"),
  ];
  const nondecreasingClock = createReleaseSurfaceNondecreasingClock(() => clockValues.shift()!);
  assert.deepEqual(
    [nondecreasingClock(), nondecreasingClock(), nondecreasingClock()].map((value) => value.toISOString()),
    [
      "2026-07-29T12:00:00.100Z",
      "2026-07-29T12:00:00.100Z",
      "2026-07-29T12:00:00.200Z",
    ],
    "release health timestamps remain ordered across a backward host-clock correction",
  );
  assert.throws(
    () => createReleaseSurfaceNondecreasingClock(() => new Date(Number.NaN))(),
    /clock returned an invalid date/,
    "release health collection rejects an unusable wall clock",
  );
  let renderedAnchorPolls = 0;
  await waitForReleaseSurfaceRenderedAnchor({
    session: { base: "http://127.0.0.1:31337", sessionId: "fixture-rendered-anchor-session" },
    debugId: "surface-lib-markdown-links-2",
    timeoutMs: 50,
    pollMs: 1,
    executeScript: async () => {
      renderedAnchorPolls += 1;
      return renderedAnchorPolls === 1
        ? { matchCount: 2, renderedCount: 0, renderedExternalHrefCount: 0 }
        : { matchCount: 2, renderedCount: 1, renderedExternalHrefCount: 1 };
    },
  });
  assert.equal(renderedAnchorPolls, 2, "rendered anchor wait retries until a visible hit-tested external link exists");
  await assert.rejects(
    waitForReleaseSurfaceRenderedAnchor({
      session: { base: "http://127.0.0.1:31337", sessionId: "fixture-hidden-anchor-session" },
      debugId: "surface-lib-markdown-links-2",
      timeoutMs: 5,
      pollMs: 1,
      executeScript: async () => ({ matchCount: 2, renderedCount: 0, renderedExternalHrefCount: 0 }),
    }),
    /did not become rendered and hit-testable/,
    "present but hidden or obscured anchors remain a hard failure",
  );
  await assert.rejects(
    waitForReleaseSurfaceRenderedAnchor({
      session: { base: "http://127.0.0.1:31337", sessionId: "fixture-malformed-anchor-session" },
      debugId: "surface-lib-markdown-links-2",
      executeScript: async () => ({ matchCount: null, renderedCount: 0, renderedExternalHrefCount: 0 }),
    }),
    /observation counts are invalid/,
    "malformed renderer evidence fails closed",
  );
  const inventory = JSON.parse(readFileSync(join(root, "release", "surface-inventory.json"), "utf8")) as ReleaseSurfaceInventory;
  const healthPort = await unusedPort();
  const webdriverAddress = webdriverServer.address();
  if (!webdriverAddress || typeof webdriverAddress === "string") throw new Error("fixture WebDriver has no port");
  const session = { base: `http://127.0.0.1:${webdriverAddress.port}`, sessionId: "fixture-health-session-0001" };
  const candidate = fixtureCandidate();
  let endpoint = "";
  let sequence = 0;
  let firstFlush = true;
  const send = async (kind: string, fields: Record<string, unknown> = {}): Promise<number> => {
    const next = ++sequence;
    const response = await fetch(endpoint, {
      method: "POST",
      body: JSON.stringify({ sequence: next, observedAtMs: Date.now(), kind, ...fields }),
    });
    assert.equal(response.status, 204);
    return next;
  };
  const collector = await startReleaseSurfaceHealthCollector({
    candidate,
    candidateToken: "candidate-token-".padEnd(48, "t"),
    session,
    inventory,
    platform: "linux-installed",
    healthPort,
    outputPath: join(temp, "health.json"),
    repositoryRoot: root,
    runGit: fixtureHealthGit,
    fetchImpl: async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (path === "/health") {
        return Response.json({
          processId: candidate.runtime.processId,
          instanceId: candidate.runtime.instanceId,
          appVersion: candidate.version,
          buildCommit: candidate.sourceCommit,
          debugApiPort: candidate.runtime.debugPort,
        });
      }
      if (path === "/state/ui" && init?.method === "POST") return Response.json({ ok: true });
      return new Response("not found", { status: 404 });
    },
    executeScript: async (_session, script, args) => {
      if (script.includes("MutationObserver")) {
        endpoint = String(args?.[0]);
        return { installed: true, readySequence: await send("ready") };
      }
      if (script.includes("renderedExternalHrefCount")) {
        assert.deepEqual(args, ["surface-lib-markdown-links-2"]);
        return { matchCount: 2, renderedCount: 1, renderedExternalHrefCount: 1 };
      }
      if (!script.includes("checkpointSequence")) throw new Error("unexpected fixture WebDriver script");
      if (firstFlush) {
        firstFlush = false;
        await send("link", { debugId: "surface-components-settings-abouttab-4", href: "https://theshellx.com/" });
        await send("link", { debugId: "surface-components-settings-abouttab-5", href: "https://x.com/theshellx" });
        await send("link", { debugId: "about-full-manual-link", href: "https://docs.theshellx.com/manual/shellx/" });
        await send("link", { debugId: "surface-components-settings-abouttab-9", href: "https://github.com/martinsbrezauckis/shellx" });
        await send("link", { debugId: "surface-components-settings-abouttab-10", href: "https://github.com/martinsbrezauckis/shellx/issues" });
        await send("link", { debugId: "surface-lib-markdown-links-2", href: "https://github.com/martinsbrezauckis/shellx/releases" });
      }
      return { checkpointSequence: await send("checkpoint") };
    },
    processExists: () => false,
    checkLink: async () => "ok",
  });
  const unauthorizedEndpoint = new URL(endpoint);
  unauthorizedEndpoint.searchParams.set("token", "wrong-token");
  const unauthorized = await fetch(unauthorizedEndpoint, {
    method: "POST",
    body: JSON.stringify({ sequence: 999, observedAtMs: Date.now(), kind: "checkpoint" }),
  });
  assert.equal(unauthorized.status, 401, "loopback health events require the in-memory run token");
  await send("console", {
    level: "error",
    message: "[ErrorBoundary] caught render-time throw: Error: SHELLX_RELEASE_TEST_RENDERER_CRASH_035",
  });
  await collector.discoverRenderedLinks();
  await collector.sessionDeleteObserver.beforeSessionDelete(session);
  const requestedAt = new Date().toISOString();
  await collector.sessionDeleteObserver.afterSessionDelete({
    session,
    requestedAt,
    completedAt: new Date().toISOString(),
    status: "pass",
  });
  const result = await collector.finalized;
  assert.equal(result.evidence.links.checkedCount, 6);
  assert.equal(result.evidence.links.brokenLinks, 0);
  assert.equal(result.evidence.links.discovery.gapCount, 0);
  assert.equal(result.evidence.console.observedEvents, 1);
  assert.equal(result.evidence.console.unexpectedConsoleErrors, 0);
  assert.equal(result.evidence.console.observations[0]?.classification, "expected");
  assert.equal(
    result.evidence.console.subscription.gapCount,
    0,
    "the exact pre-delete checkpoint remains complete when native shutdown preempts pagehide",
  );
  assert.equal(result.evidence.shutdown.processId, candidate.runtime.processId);
  assert.equal(result.evidence.shutdown.processAbsent, true);
  assert.deepEqual(JSON.parse(readFileSync(result.outputPath, "utf8")), result.evidence);

  endpoint = "";
  sequence = 0;
  const incompleteOutput = join(temp, "health-incomplete.json");
  const incompleteCollector = await startReleaseSurfaceHealthCollector({
    candidate,
    candidateToken: "candidate-token-".padEnd(48, "t"),
    session,
    inventory,
    platform: "linux-installed",
    healthPort: await unusedPort(),
    outputPath: incompleteOutput,
    repositoryRoot: root,
    runGit: fixtureHealthGit,
    fetchImpl: async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (path === "/health") {
        return Response.json({
          processId: candidate.runtime.processId,
          instanceId: candidate.runtime.instanceId,
          appVersion: candidate.version,
          buildCommit: candidate.sourceCommit,
          debugApiPort: candidate.runtime.debugPort,
        });
      }
      if (path === "/state/ui" && init?.method === "POST") return Response.json({ ok: true });
      return new Response("not found", { status: 404 });
    },
    executeScript: async (_session, script, args) => {
      if (!script.includes("MutationObserver")) throw new Error("unexpected incomplete collector script");
      endpoint = String(args?.[0]);
      return { installed: true, readySequence: await send("ready") };
    },
    processExists: () => false,
    checkLink: async () => "ok",
  });
  await assert.rejects(
    incompleteCollector.sessionDeleteObserver.beforeSessionDelete(session),
    /rendered-link discovery did not complete/,
  );
  const incompleteShutdown = incompleteCollector.sessionDeleteObserver.afterSessionDelete({
    session,
    requestedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    status: "pass",
  });
  await assert.rejects(incompleteShutdown, /cannot finalize before rendered-link discovery completes/);
  await assert.rejects(incompleteCollector.finalized, /cannot finalize before rendered-link discovery completes/);
  assert.equal(existsSync(incompleteOutput), false, "failed health discovery must not write a partial receipt");

  const aboutSource = readFileSync(join(root, "src", "components", "settings", "AboutTab.tsx"), "utf8");
  assert.equal((aboutSource.match(/href="#"/g) ?? []).length, 0, "About links must not advertise fragment placeholders");
  for (const href of [
    "https://theshellx.com",
    "https://x.com/theshellx",
    "https://github.com/martinsbrezauckis/shellx",
    "https://github.com/martinsbrezauckis/shellx/issues",
  ]) {
    assert(aboutSource.includes(`href="${href}"`), `About link must expose semantic href ${href}`);
  }
  assert(aboutSource.includes("href={MANUAL_URL}"), "manual link must expose its semantic href");
  const collectorSource = readFileSync(join(root, "scripts", "lib", "release-surface-health-collector.ts"), "utf8");
  assert(collectorSource.includes('anchor.closest("[inert], [aria-hidden=\'true\']")'));
  assert(collectorSource.includes("document.elementFromPoint"));
  assert(!collectorSource.includes(
    'waitForReleaseSurfaceWebDriverElement(input.session, "[data-debug-id=\'surface-lib-markdown-links-2\']")',
  ), "native link discovery must not depend on the known-false Edge displayed verdict");
  const rendererObserverSource = readFileSync(
    join(root, "src", "components", "ReleaseSurfaceRendererHealthObserver.tsx"),
    "utf8",
  );
  const mainSource = readFileSync(join(root, "src", "main.tsx"), "utf8");
  const debugApiSource = readFileSync(join(root, "src-tauri", "src", "debug_api.rs"), "utf8");
  for (const marker of [
    'invoke<DebugUiSnapshot>("debug_ui_snapshot")',
    "releaseTestInstance !== true",
    'invoke("renderer_error"',
    'window.addEventListener("error"',
    'window.addEventListener("unhandledrejection"',
  ]) assert(rendererObserverSource.includes(marker), `renderer health observer is missing ${marker}`);
  assert(mainSource.includes("<ReleaseSurfaceRendererHealthObserver />"));
  assert(debugApiSource.includes("release_test_instance: crate::isolated_test_instance_requested()"));

  console.log("Release surface lifecycle health collector tests passed");
} finally {
  await closeServer(webdriverServer);
  rmSync(temp, { recursive: true, force: true });
}

function fixtureCandidate(): ReleaseSurfaceCandidateAttestation {
  return {
    schema: "shellx/release-surface-candidate-attestation@5",
    mode: "final-frozen-candidate",
    platform: "linux-installed",
    sourceCommit: "b".repeat(40),
    version: "0.3.5",
    distributionArtifact: { basename: "shellx.deb", sha256: "a".repeat(64), bytes: 1024 },
    runtime: {
      processId: 4321,
      instanceId: "fixture-instance",
      debugBase: "http://127.0.0.1:31341",
      debugPort: 31341,
      debugTokenPath: "/tmp/shellxagent.token",
      appVersion: "0.3.5",
      buildCommit: "b".repeat(40),
      executable: { basename: "shellx", sha256: "c".repeat(64), bytes: 2048 },
    },
  } as unknown as ReleaseSurfaceCandidateAttestation;
}

function fixtureHealthGit(args: string[]): string {
  if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return `${root}\n`;
  if (args[0] === "rev-parse" && args[1] === "HEAD") return `${"b".repeat(40)}\n`;
  if (args[0] === "status") return "";
  if (args[0] === "ls-files") {
    return [
      "scripts/lib/release-surface-health-collector.ts",
      "scripts/lib/release-surface-health-evidence.ts",
      "scripts/lib/release-surface-webdriver-client.ts",
      "scripts/lib/release-surface-webdriver-lifecycle.ts",
      "",
    ].join("\n");
  }
  throw new Error(`unexpected health collector git probe ${args.join(" ")}`);
}

async function createFixtureWebDriverServer(): Promise<Server> {
  const server = createServer(async (request, response) => {
    const body = await readRequestBody(request);
    const path = request.url ?? "";
    response.setHeader("Content-Type", "application/json");
    if (request.method === "POST" && path.endsWith("/element")) {
      const selector = String((JSON.parse(body) as { value?: unknown }).value ?? "");
      response.end(JSON.stringify({ value: { "element-6066-11e4-a52e-4f735466cecf": Buffer.from(selector).toString("hex").slice(0, 64) || "element" } }));
      return;
    }
    if (request.method === "GET" && path.endsWith("/displayed") && !fixtureStaleElementReturned) {
      fixtureStaleElementReturned = true;
      response.statusCode = 404;
      response.end(JSON.stringify({ value: {
        error: "stale element reference",
        message: "fixture element was replaced between lookup and visibility observation",
      } }));
      return;
    }
    if (request.method === "GET" && path.endsWith("/displayed")) {
      response.end(JSON.stringify({ value: true }));
      return;
    }
    if (request.method === "POST" && path.endsWith("/click")) {
      response.end(JSON.stringify({ value: null }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ value: { error: "unknown command" } }));
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  return server;
}

async function readRequestBody(request: import("node:http").IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("unable to allocate fixture port");
  const port = address.port;
  await closeServer(server);
  return port;
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => error ? rejectClose(error) : resolveClose());
  });
}
