import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { FinalSurfaceDriverPlan } from "./lib/release-surface-driver-plan";
import type { ReleaseSurfaceInventory } from "./lib/release-surface-inventory";
import { createReleaseSurfaceInstalledInputSession } from "./lib/release-surface-installed-input-client";
import type { ReleaseSurfaceDriverRequest } from "./lib/release-surface-driver-protocol";
import { releaseSurfaceFixtureSourceCommit, releaseSurfaceFixtureVersion } from "./fixtures/release-surface-controller-binding-fixture";
import { releaseSurfacePosixNativeBindingFixture } from "./fixtures/release-surface-posix-native-runtime-fixture";
import { exerciseProviderActionLifecycle } from "./release-drivers/ui-control-provider-action-lifecycle-installed";
import { providerActionPromptMatches } from "../src/lib/debug-provider-action-fixture";

const root = resolve(import.meta.dirname, "..");
const temp = mkdtempSync(join(tmpdir(), "shellx-ui-provider-action-"));
const profileRoot = join(temp, `shellx-final-provider-action-${"a".repeat(16)}`);
const shellxHome = join(profileRoot, ".shellx");
const statePath = join(temp, "fixture-state.json");
const tokenPath = join(shellxHome, "shellxagent.token");
const token = "fixture-ui-provider-action-token-0001";
const sessionId = "fixture-provider-action-session-0001";
const instanceId = "fixture-provider-action-instance-0001";
const sourceCommit = releaseSurfaceFixtureSourceCommit;
const fixturePlatform = process.platform === "win32" ? "windows-installed" : "linux-installed";
const fixtureImagePath = fixturePlatform === "windows-installed"
  ? "C:\\Temp\\ShellXReleaseFixture\\shellx.exe"
  : "/tmp/fixture/shellx";
const driverId = "ui-control-provider-action-lifecycle-installed";
const exactNames = new Set([
  'src/components/ActivityBrowserModal.tsx:role=button;name="Ask agent"',
  'src/components/BottomPanel.tsx:[data-debug-id="composer-send"]',
  'src/components/TasksPanel.tsx:[aria-label="Ask the active agent to inspect the visible background tasks"]',
  'src/components/TasksPanel.tsx:[title="Ask the active agent to inspect this background task and its latest output"]',
  'src/components/WorkPreviewPanel.tsx:[id="work-preview-ask-fix"]',
  'src/components/WorkPreviewPanel.tsx:[data-debug-id="surface-components-workpreviewpanel-16"]',
  'src/components/WorkPreviewPanel.tsx:[id="work-preview-stage-ask-fix"]',
  'src/components/RightRail.tsx:[data-debug-id="surface-components-rightrail-11"]',
  'src/components/RightRail.tsx:[title="Ask the active agent to inspect this diagnostic snapshot"]',
  'src/browser/components/AgentSidebar.tsx:[data-debug-id="shellx-browser-agent-send"]',
  'src/browser/components/AgentSidebar.tsx:[data-debug-id="shellx-browser-chat-explain-page"]',
]);

assertProviderFixtureIsolationContracts();
assertBrowserPromptContracts();

let fixture: ChildProcess | null = null;
try {
  mkdirSync(shellxHome, { recursive: true, mode: 0o700 });
  writeFileSync(tokenPath, token, { encoding: "utf8", mode: 0o600 });
  fixture = spawn(process.execPath, [
    "--import", "tsx",
    resolve(root, "scripts/fixtures/release-surface-ui-control-webdriver-server-fixture.ts"),
    "--state-out", statePath,
    "--token", token,
    "--session-id", sessionId,
    "--instance-id", instanceId,
    "--process-id", "4321",
    "--version", releaseSurfaceFixtureVersion,
    "--source-commit", sourceCommit,
    "--profile-root", profileRoot,
  ], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  const ports = await waitForPorts(statePath, fixture);
  const candidateBase = `http://127.0.0.1:${ports.candidatePort}`;
  const webdriverBase = `http://127.0.0.1:${ports.webdriverPort}`;

  const described = spawnSync(process.execPath, [
    "--import", "tsx",
    resolve(root, "scripts/release-drivers/ui-control-provider-action-lifecycle-installed.ts"),
    "--describe",
  ], { cwd: root, encoding: "utf8" });
  assert.equal(described.status, 0, described.stderr || described.stdout);
  const manifest = JSON.parse(described.stdout) as {
    id: string;
    invocationTransport: string;
    supportedFixtures: string[];
    supportedCleanups: string[];
    supportedOracles: string[];
  };
  assert.equal(manifest.id, driverId);
  assert.equal(manifest.invocationTransport, "native-installed-input");
  assert.equal(manifest.supportedFixtures.length, 11);
  assert.equal(manifest.supportedCleanups.length, 1);
  assert.deepEqual(manifest.supportedOracles, ["ui:activation:provider-action-prompt-dispatched"]);

  const request = createRequest(candidateBase, webdriverBase, ports.candidatePort);
  const input = createReleaseSurfaceInstalledInputSession(request, { base: candidateBase, token });
  const baselineResponse = await fetch(`${candidateBase}/state/ui`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(baselineResponse.status, 200);
  const baseline = await baselineResponse.json() as { activeTab: Record<string, unknown> };
  const agentResponse = await fetch(`${candidateBase}/state/ui`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      activeTab: { ...baseline.activeTab, agentId: "codex-cli" },
      source: "provider-action-focused-agent-session",
    }),
  });
  assert.equal(agentResponse.status, 200);
  const outcomes = [];
  for (const assignment of request.assignments) {
    outcomes.push(await exerciseProviderActionLifecycle({ base: candidateBase, token }, input, request, assignment));
  }
  assert.equal(outcomes.length, 11);
  assert(outcomes.every(passed), JSON.stringify(outcomes, null, 2));

  const auditResponse = await fetch(`${candidateBase}/audit`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(auditResponse.status, 200);
  const audit = await auditResponse.json() as {
    rightTab: string;
    activeTab: { tabId?: string };
    providerActionFixture: string | null;
    providerActionDigest: string | null;
    providerActionRunId: string | null;
    ownedBackgroundTasks: unknown[];
    activeTaskId: string | null;
    browserTaskId: string | null;
    browserTaskTabId: string | null;
    browserTaskOwnerSessionId: string | null;
    activeTaskStatus: string | null;
    browserWindowOpen: boolean;
    currentWindow: string;
    browserGoalValue: string;
    clickedSelectors: string[];
  };
  assert.equal(audit.rightTab, "Tasks");
  assert.equal(audit.activeTab.tabId, "fixture-active-tab-035");
  assert.equal(audit.providerActionFixture, null);
  assert.equal(audit.providerActionDigest, null);
  assert.equal(audit.providerActionRunId, null);
  assert.deepEqual(audit.ownedBackgroundTasks, []);
  assert.equal(audit.activeTaskId, null);
  assert.match(audit.browserTaskId ?? "", /^fixture-browser-task-/);
  assert.equal(audit.browserTaskTabId, null);
  assert.equal(audit.browserTaskOwnerSessionId, "fixture-active-tab-035");
  assert.equal(audit.activeTaskStatus, "aborted");
  assert.equal(audit.browserWindowOpen, false);
  assert.equal(audit.currentWindow, "main-window");
  assert.equal(audit.browserGoalValue, "");
  const providerClicks = audit.clickedSelectors.filter((selector) => (
    selector.includes("Ask the active agent")
    || selector.includes("Activity Browser")
    || selector.includes("work-preview-ask-fix")
    || selector.includes("work-preview-stage-ask-fix")
    || selector.includes("workpreviewpanel-16")
    || selector.includes("rightrail-11")
    || selector.includes("shellx-browser-agent-send")
    || selector.includes("shellx-browser-chat-explain-page")
    || selector.includes("composer-send")
  ));
  assert.equal(providerClicks.length, 11);

  const plan = JSON.parse(readFileSync(join(root, "release/surface-driver-plan.json"), "utf8")) as FinalSurfaceDriverPlan;
  const assignments = plan.assignments.filter((assignment) => assignment.driverId === driverId);
  assert.equal(assignments.length, 11);
  assert(assignments.every((assignment) => assignment.expectedEffect.includes("disposable ShellX provider child")));
  assert(assignments.every((assignment) => assignment.expectedEffect.includes("provider-route batch")));
  console.log("Provider action lifecycle passed: 11 exact prompt actions, 11 disposable process receipts, 2 owned Browser lifecycles, 0 external provider calls");
} finally {
  if (fixture && fixture.exitCode === null && fixture.signalCode === null) fixture.kill("SIGTERM");
  if (fixture) await waitForExit(fixture);
  rmSync(temp, { recursive: true, force: true });
}

function createRequest(candidateBase: string, webdriverBase: string, candidatePort: number): ReleaseSurfaceDriverRequest {
  const inventory = JSON.parse(readFileSync(join(root, "release/surface-inventory.json"), "utf8")) as ReleaseSurfaceInventory;
  const plan = JSON.parse(readFileSync(join(root, "release/surface-driver-plan.json"), "utf8")) as FinalSurfaceDriverPlan;
  const inventoryById = new Map(inventory.items.map((surface) => [surface.id, surface]));
  const assignments = plan.assignments.filter((assignment) => assignment.driverId === driverId).map((assignment) => {
    const surface = inventoryById.get(assignment.surfaceId);
    assert(surface, "provider action assignment must exist in the inventory");
    assert(exactNames.has(surface.name), `unexpected provider action surface ${surface.name}`);
    return { surface, fixtureId: assignment.fixtureId, expectedEffect: assignment.expectedEffect, oracleId: assignment.oracleId, cleanupId: assignment.cleanupId };
  });
  assert.equal(assignments.length, exactNames.size);
  return {
    schema: "shellx/release-surface-driver-request@7",
    mode: "final-frozen-candidate",
    driverId,
    driverKind: "ui-control",
    platform: fixturePlatform,
    sourceCommit,
    version: releaseSurfaceFixtureVersion,
    inventoryDigest: inventory.digest,
    artifact: { basename: "shellx", sha256: "d".repeat(64) },
    controller: {} as ReleaseSurfaceDriverRequest["controller"],
    runtime: {
      processId: 4321,
      instanceId,
      debugBase: candidateBase,
      debugTokenPath: tokenPath,
      mcpBase: "http://127.0.0.1:9",
      mcpTokenPath: tokenPath,
      executableSha256: "e".repeat(64),
      installedPayloadPath: fixtureImagePath,
      installedManifestSha256: "f".repeat(64),
      ...(fixturePlatform === "windows-installed" ? {
        windowsNative: {
          schema: "shellx/release-surface-windows-native-binding@1" as const,
          process: {
            pid: 4321,
            startId: "2026-07-28T17:59:00.000Z",
            imagePath: fixtureImagePath,
            imageSha256: "e".repeat(64),
            imageBytes: 1024,
            imageFileId: `abcd1234:0x${"1".repeat(32)}`,
          },
          listener: { address: "127.0.0.1" as const, port: candidatePort, owningPid: 4321 },
        },
      } : {
        posixNative: releaseSurfacePosixNativeBindingFixture({
          processId: 4321,
          port: candidatePort,
          imagePath: fixtureImagePath,
          imageSha256: "e".repeat(64),
        }),
      }),
    },
    nativeWebDriver: { base: webdriverBase, sessionId, evidence: { basename: "native-webdriver-binding.json", sha256: "a".repeat(64), bytes: 1024 } },
    assignments,
  };
}

function passed(outcome: { present: string; invoke: string; effect: string; cleanup: string; error?: string }): boolean {
  return outcome.present === "pass" && outcome.invoke === "pass" && outcome.effect === "pass" && outcome.cleanup === "pass" && !outcome.error;
}

async function waitForPorts(path: string, child: ChildProcess): Promise<{ candidatePort: number; webdriverPort: number }> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`provider action fixture exited before startup: ${await streamText(child.stderr)}`);
    try {
      const value = JSON.parse(readFileSync(path, "utf8")) as { candidatePort?: number; webdriverPort?: number };
      if (Number.isInteger(value.candidatePort) && Number.isInteger(value.webdriverPort)) return { candidatePort: Number(value.candidatePort), webdriverPort: Number(value.webdriverPort) };
    } catch { /* state is create-only and may not exist yet */ }
    await delay(50);
  }
  throw new Error("provider action fixture did not publish its ports");
}

async function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await Promise.race([new Promise<void>((resolveExit) => child.once("exit", () => resolveExit())), delay(2_000)]);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

async function streamText(stream: NodeJS.ReadableStream | null): Promise<string> {
  if (!stream) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function assertProviderFixtureIsolationContracts(): void {
  const debugProviders = readFileSync(join(root, "src-tauri/src/debug_api_providers.rs"), "utf8");
  const handlerStart = debugProviders.indexOf("pub(super) async fn provider_sessions_start_http(");
  const handlerEnd = debugProviders.indexOf("const PROVIDER_ACTION_RELEASE_FIXTURE_ISOLATION_ERROR", handlerStart);
  assert(handlerStart >= 0 && handlerEnd > handlerStart, "provider start HTTP handler must remain source-addressable");
  const handler = debugProviders.slice(handlerStart, handlerEnd);
  const fixtureBranch = handler.indexOf("if body.release_fixture.is_some()");
  const isolatedGate = handler.indexOf("crate::isolated_test_instance_requested()", fixtureBranch);
  const fixtureDispatch = handler.indexOf("provider_action_release_fixture_start(s, body).await", fixtureBranch);
  assert(fixtureBranch >= 0 && isolatedGate > fixtureBranch && fixtureDispatch > isolatedGate,
    "releaseFixture must pass the isolated-instance gate before validation or spawn");
  assert.match(handler, /StatusCode::FORBIDDEN/);
  assert.doesNotMatch(handler, /body\.prompt/, "normal-instance rejection must not echo prompt data");
  assert.match(debugProviders, /normal_debug_api_instance_rejects_release_provider_fixture_without_prompt_data/);

  const providerSessions = readFileSync(join(root, "src-tauri/src/provider_sessions.rs"), "utf8");
  const normalStart = providerSessions.slice(
    providerSessions.indexOf("pub async fn start_provider_session("),
    providerSessions.indexOf("/// Start the release-owned provider action fixture"),
  );
  assert(normalStart.indexOf("if request.release_fixture.is_some()") >= 0);
  assert(normalStart.indexOf("if request.release_fixture.is_some()") < normalStart.indexOf("let tab_id ="),
    "normal provider start must reject releaseFixture before resolving execution state");
  assert.match(providerSessions, /normal_provider_start_rejects_release_fixture_before_emitting_or_resolving/);

  const driver = readFileSync(join(root, "scripts/release-drivers/ui-control-provider-action-lifecycle-installed.ts"), "utf8");
  assert.match(driver, /const restored = await uiState\(connection\)/);
  assert.match(driver, /cleanup did not restore rightTab/);
  assert.match(driver, /cleanup did not restore activeTabId/);
  assert.match(driver, /cleanup did not restore the submitted activeTab fields/);
  assert.match(driver, /prepareDebugApiBrowserSettleFixture\(connection, \{ callerSessionId: activeTabId \}\)/);
  assert.match(driver, /cleanupDebugApiBrowserSettleFixture\(connection, browserFixture\)/);
}

function assertBrowserPromptContracts(): void {
  const url = "http://127.0.0.1:43117/settle";
  const envelope = (visiblePrompt: string) => [
    "ShellX Browser cowork request",
    "Browser task ID: browser-task-owned-035",
    "Browser tab ID: browser-tab-owned-035",
    `Current URL: ${url}`,
    "",
    "Work in the visible native ShellX Browser with the explicit task and tab IDs above. Use ShellX Browser tools, preserve operator pause/takeover/abort authority, and keep Vault or sensitive actions inside Request Center. Do not switch to a hidden or unrelated browser surface.",
    "",
    "User message:",
    visiblePrompt,
  ].join("\n");
  assert(providerActionPromptMatches("browser-send", envelope("SHELLX_RELEASE_PROVIDER_ACTION_BROWSER_SEND_035")));
  assert(!providerActionPromptMatches("browser-send", envelope("SHELLX_RELEASE_PROVIDER_ACTION_BROWSER_SEND_035 extra")));
  assert(!providerActionPromptMatches("browser-send", envelope("SHELLX_RELEASE_PROVIDER_ACTION_BROWSER_SEND_035").replace(url, `${url}?token=secret`)));
  const explain = [
    "Explain the current browser page for the user.",
    `URL: ${url}`,
    "Title: ShellX release settle",
    "Page excerpt: Owned Browser settle fixture ready",
    "Summarize what the page is for, the important visible facts/actions, and any security or trust concerns. Do not assume access to user secrets or hidden session data unless the user explicitly grants it.",
  ].join("\n");
  assert(providerActionPromptMatches("browser-explain-page", envelope(explain)));
  assert(!providerActionPromptMatches("browser-explain-page", envelope(explain.replace("Owned Browser settle fixture ready", "Unowned page"))));
  assert(providerActionPromptMatches("composer-send", "SHELLX_RELEASE_PROVIDER_ACTION_COMPOSER_SEND_035"));
  assert(!providerActionPromptMatches("composer-send", "SHELLX_RELEASE_PROVIDER_ACTION_COMPOSER_SEND_035 extra"));
}
