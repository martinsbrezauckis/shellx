import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import {
  clickReleaseSurfaceInstalledInputElement,
  observeReleaseSurfaceInstalledInputElement,
  waitForReleaseSurfaceInstalledInputElement,
  waitForReleaseSurfaceInstalledInputElementAbsent,
  type ReleaseSurfaceInstalledInputSession,
} from "../lib/release-surface-installed-input-client";
import type {
  ReleaseSurfaceDriverOutcome,
  ReleaseSurfaceDriverRequest,
} from "../lib/release-surface-driver-protocol";
import { apiJson, nodeReadablePath, postUi } from "./ui-control-work-preview-start";

type Assignment = ReleaseSurfaceDriverRequest["assignments"][number];
type Connection = { base: string; token: string };
type RightRailTab = "Tasks" | "Tooling" | "Git" | "Preview" | "Plan" | "Files";

const RECEIPT_TOGGLE_SURFACE = "src/components/BuildRunCockpit.tsx::is([title=\"Show every receipt in this Build Mode run\"],[title=\"Show latest receipts only\"])";
const RECEIPT_TOGGLE = ":is([title='Show every receipt in this Build Mode run'],[title='Show latest receipts only'])";
const RECEIPT_FIXTURE_ID = "build-run-cockpit-receipts";
const RECEIPT_LEDGER_STATE = "[data-shellx-release-control='build-receipt-ledger-state']";
const STATE_RECEIPT = "[data-shellx-release-control='build-run-state-receipt']";
const RIGHT_RAIL_TABS = new Set<RightRailTab>(["Tasks", "Tooling", "Git", "Preview", "Plan", "Files"]);
export const BUILD_RUN_COCKPIT_FIXTURES = [
  "ui:build-run-cockpit-owned-terminal-receipts",
  "ui:build-run-cockpit-owned-approve",
  "ui:build-run-cockpit-owned-reject",
  "ui:build-run-cockpit-owned-pause",
  "ui:build-run-cockpit-owned-resume",
  "ui:build-run-cockpit-owned-recheck",
  "ui:build-run-cockpit-owned-checkpoint",
  "ui:build-run-cockpit-owned-stop",
  "ui:build-plan-review-owned-approve",
  "ui:build-plan-review-owned-reject",
] as const;
export const BUILD_RUN_COCKPIT_CLEANUPS = [
  "ui:collapse-and-clear-build-run-fixture-restore-right-rail",
  "ui:clear-owned-build-run-project-provider-git-and-restore-view",
] as const;
export const BUILD_RUN_COCKPIT_ORACLES = [
  "ui:boolean-state-transition",
  "ui:activation:build-run-cockpit-owned-state-transition",
] as const;

type BuildAction = "approve" | "reject" | "pause" | "resume" | "recheck" | "checkpoint" | "stop";
type BuildFixtureState = "awaiting-approval" | "active" | "paused" | "blocked-recheckable";
type BuildActionConfig = {
  action: BuildAction;
  selector: string;
  fixtureId: string;
  fixtureState: BuildFixtureState;
  expectedStatus: "active" | "halted" | "paused";
  expectedReceipt: string;
  providerAction?: "build-approve" | "build-resume";
  confirmReject?: boolean;
  surfaceLabel: string;
};

const BUILD_ACTIONS = new Map<string, BuildActionConfig>([
  ['src/components/BuildRunCockpit.tsx:[title="Approve the Build Mode scratchboard and start execution."]', {
    action: "approve",
    selector: "[title='Approve the Build Mode scratchboard and start execution.']",
    fixtureId: "ui:build-run-cockpit-owned-approve",
    fixtureState: "awaiting-approval",
    expectedStatus: "active",
    expectedReceipt: "planApproved",
    providerAction: "build-approve",
    surfaceLabel: "Build Run Cockpit",
  }],
  ['src/components/BuildRunCockpit.tsx:[title="Reject this Build Mode plan and halt the run."]', {
    action: "reject",
    selector: "[title='Reject this Build Mode plan and halt the run.']",
    fixtureId: "ui:build-run-cockpit-owned-reject",
    fixtureState: "awaiting-approval",
    expectedStatus: "halted",
    expectedReceipt: "planRejected",
    surfaceLabel: "Build Run Cockpit",
  }],
  ['src/components/BuildRunCockpit.tsx:[title="Pause Build Mode auto-continuation."]', {
    action: "pause",
    selector: "[title='Pause Build Mode auto-continuation.']",
    fixtureId: "ui:build-run-cockpit-owned-pause",
    fixtureState: "active",
    expectedStatus: "paused",
    expectedReceipt: "planApproved",
    surfaceLabel: "Build Run Cockpit",
  }],
  ['src/components/BuildRunCockpit.tsx::is([title="Reconnect this tab and resume Build Mode auto-continuation."],[title="Resume Build Mode auto-continuation."])', {
    action: "resume",
    selector: "[title='Resume Build Mode auto-continuation.']",
    fixtureId: "ui:build-run-cockpit-owned-resume",
    fixtureState: "paused",
    expectedStatus: "active",
    expectedReceipt: "planApproved",
    providerAction: "build-resume",
    surfaceLabel: "Build Run Cockpit",
  }],
  ['src/components/BuildRunCockpit.tsx:[title="Recheck blocker evidence without restarting or prompting the Agent."]', {
    action: "recheck",
    selector: "[title='Recheck blocker evidence without restarting or prompting the Agent.']",
    fixtureId: "ui:build-run-cockpit-owned-recheck",
    fixtureState: "blocked-recheckable",
    expectedStatus: "active",
    expectedReceipt: "blockerResolved",
    surfaceLabel: "Build Run Cockpit",
  }],
  ['src/components/BuildRunCockpit.tsx:[title="Create a local shellX git checkpoint and attach it to this Build Mode run."]', {
    action: "checkpoint",
    selector: "[title='Create a local shellX git checkpoint and attach it to this Build Mode run.']",
    fixtureId: "ui:build-run-cockpit-owned-checkpoint",
    fixtureState: "active",
    expectedStatus: "active",
    expectedReceipt: "checkpointCreated",
    surfaceLabel: "Build Run Cockpit",
  }],
  ['src/components/BuildRunCockpit.tsx:[title="Stop Build Mode manually without accepting completion."]', {
    action: "stop",
    selector: "[title='Stop Build Mode manually without accepting completion.']",
    fixtureId: "ui:build-run-cockpit-owned-stop",
    fixtureState: "active",
    expectedStatus: "halted",
    expectedReceipt: "runHalted",
    surfaceLabel: "Build Run Cockpit",
  }],
  ['src/components/BuildPlanReviewModal.tsx:[data-debug-id="surface-components-buildplanreviewmodal-4"]', {
    action: "reject",
    selector: "[data-debug-id='surface-components-buildplanreviewmodal-4']",
    fixtureId: "ui:build-plan-review-owned-reject",
    fixtureState: "awaiting-approval",
    expectedStatus: "halted",
    expectedReceipt: "planRejected",
    confirmReject: true,
    surfaceLabel: "Build Plan modal",
  }],
  ['src/components/BuildPlanReviewModal.tsx:[data-debug-id="surface-components-buildplanreviewmodal-5"]', {
    action: "approve",
    selector: "[data-debug-id='surface-components-buildplanreviewmodal-5']",
    fixtureId: "ui:build-plan-review-owned-approve",
    fixtureState: "awaiting-approval",
    expectedStatus: "active",
    expectedReceipt: "planApproved",
    providerAction: "build-approve",
    surfaceLabel: "Build Plan modal",
  }],
]);

export function supportsBuildRunCockpitControl(assignment: Assignment): boolean {
  return (assignment.surface.source === "src/components/BuildRunCockpit.tsx"
      && assignment.surface.name === RECEIPT_TOGGLE_SURFACE)
    || BUILD_ACTIONS.has(assignment.surface.name);
}

export async function exerciseBuildRunCockpitControl(
  connection: Connection,
  webdriver: ReleaseSurfaceInstalledInputSession,
  request: ReleaseSurfaceDriverRequest,
  assignment: Assignment,
): Promise<ReleaseSurfaceDriverOutcome> {
  const action = BUILD_ACTIONS.get(assignment.surface.name);
  if (action) return exerciseBuildRunAction(connection, webdriver, request, assignment, action);
  const outcome = emptyOutcome(assignment);
  let baselineRightTab: RightRailTab | null = null;
  let fixturePrepared = false;
  try {
    if (!supportsBuildRunCockpitControl(assignment)) {
      throw new Error(`Build Run Cockpit driver does not support ${assignment.surface.name}`);
    }
    const baseline = await apiJson(connection, "GET", "/state/ui");
    baselineRightTab = requireRightRailTab(baseline.rightTab);
    await postUi(connection, {
      rightTab: "Plan",
      debugRendererFixture: { id: RECEIPT_FIXTURE_ID },
      source: "final-surface-build-run-cockpit",
    });
    fixturePrepared = true;

    const control = await waitForReleaseSurfaceInstalledInputElement(webdriver, RECEIPT_TOGGLE, {
      timeoutMs: 5_000,
      pollMs: 50,
    });
    const collapsed = await receiptState(webdriver);
    verifyReceiptState(collapsed, {
      title: "Show every receipt in this Build Mode run",
      label: "All 8",
      visibleReceiptCount: 6,
    }, "collapsed fixture baseline");
    outcome.present = "pass";

    await clickReleaseSurfaceInstalledInputElement(webdriver, control);
    outcome.invoke = "pass";
    const expanded = await waitForReceiptState(webdriver, 8, "Show latest receipts only");
    verifyReceiptState(expanded, {
      title: "Show latest receipts only",
      label: "Latest",
      visibleReceiptCount: 8,
    }, "expanded receipt ledger");
    outcome.effect = "pass";
    outcome.observedEffect = "A native WebDriver click expanded the fixed eight-receipt terminal Build fixture from six visible rows to all eight and changed the exact disclosure label; no build action, project, provider, file, or clipboard path was invoked.";
  } catch (error) {
    outcome.error = errorMessage(error);
  } finally {
    const cleanupErrors: string[] = [];
    if (fixturePrepared) {
      try {
        const current = await receiptState(webdriver).catch(() => null);
        if (current?.title === "Show latest receipts only") {
          const toggle = await waitForReleaseSurfaceInstalledInputElement(webdriver, RECEIPT_TOGGLE, {
            timeoutMs: 2_000,
            pollMs: 50,
          });
          await clickReleaseSurfaceInstalledInputElement(webdriver, toggle);
          await waitForReceiptState(webdriver, 6, "Show every receipt in this Build Mode run");
        }
        await postUi(connection, {
          rightTab: baselineRightTab ?? "Tasks",
          debugRendererFixture: "clear",
          source: "final-surface-build-run-cockpit-cleanup",
        });
        await waitForReleaseSurfaceInstalledInputElementAbsent(webdriver, RECEIPT_TOGGLE, {
          timeoutMs: 5_000,
          pollMs: 50,
        });
        const restored = await apiJson(connection, "GET", "/state/ui");
        if (restored.rightTab !== baselineRightTab) throw new Error("right rail did not return to its exact baseline");
      } catch (error) {
        cleanupErrors.push(errorMessage(error));
      }
    }
    if (!fixturePrepared) cleanupErrors.push("Build Run Cockpit fixture was not prepared");
    if (cleanupErrors.length === 0) outcome.cleanup = "pass";
    else {
      const detail = cleanupErrors.join("; ");
      outcome.error = outcome.error ? `${outcome.error}; cleanup: ${detail}` : `cleanup: ${detail}`;
    }
  }
  if ([outcome.present, outcome.invoke, outcome.effect, outcome.cleanup].includes("fail") && !outcome.error) {
    outcome.error = "Build Run Cockpit receipt disclosure did not satisfy every required verdict";
  }
  return outcome;
}

type BuildUiState = {
  activeTabId: string;
  activeTab: Record<string, unknown>;
  rightTab: RightRailTab;
};

type OwnedBuildFixture = {
  action: BuildAction;
  tabId: string;
  objective: string;
  nodeProject: string;
  launchProject: string;
  nodeBuildStoreRoot: string;
  nodeBuildTabRoot: string;
  nodeCheckpointRoot: string;
  ownedCheckpointPath: string | null;
};

async function exerciseBuildRunAction(
  connection: Connection,
  input: ReleaseSurfaceInstalledInputSession,
  request: ReleaseSurfaceDriverRequest,
  assignment: Assignment,
  config: BuildActionConfig,
): Promise<ReleaseSurfaceDriverOutcome> {
  const outcome = emptyOutcome(assignment);
  if (assignment.fixtureId !== config.fixtureId
    || assignment.oracleId !== "ui:activation:build-run-cockpit-owned-state-transition"
    || assignment.cleanupId !== "ui:clear-owned-build-run-project-provider-git-and-restore-view") {
    outcome.error = `Build Run Cockpit ${config.action} assignment does not match its isolated lifecycle`;
    return outcome;
  }
  let baseline: BuildUiState | null = null;
  let fixture: OwnedBuildFixture | null = null;
  let fixtureStarted = false;
  try {
    baseline = await readBuildUiState(connection);
    fixture = prepareOwnedBuildFixture(request, config.action);
    await postUi(connection, {
      rightTab: "Plan",
      activeTabId: fixture.tabId,
      activeTab: {
        ...baseline.activeTab,
        tabId: fixture.tabId,
        cwd: fixture.launchProject,
        status: "Connected",
      },
      source: "final-surface-build-run-action",
    });
    await apiJson(connection, "POST", "/build/start", {
      tabId: fixture.tabId,
      objective: fixture.objective,
      cwd: fixture.launchProject,
      releaseTestState: config.fixtureState,
    });
    fixtureStarted = true;
    await waitForBuildState(connection, fixture.tabId, config.fixtureState === "awaiting-approval"
      ? "awaitingApproval"
      : config.fixtureState === "blocked-recheckable"
        ? "blocked"
        : config.fixtureState);

    const control = await waitForReleaseSurfaceInstalledInputElement(input, config.selector, {
      timeoutMs: 8_000,
      pollMs: 50,
    });
    outcome.present = "pass";
    await clickReleaseSurfaceInstalledInputElement(input, control);
    if (config.confirmReject) {
      await waitForBuildRejectConfirmation(input, config.selector);
      const confirmation = await waitForReleaseSurfaceInstalledInputElement(input, config.selector, {
        timeoutMs: 5_000,
        pollMs: 50,
      });
      await clickReleaseSurfaceInstalledInputElement(input, confirmation);
    }
    outcome.invoke = "pass";

    const state = await waitForBuildState(connection, fixture.tabId, config.expectedStatus);
    const receipts = await readBuildReceipts(connection, fixture.tabId);
    if (!receipts.some((receipt) => receipt.kind === config.expectedReceipt)) {
      throw new Error(`Build ${config.action} omitted ${config.expectedReceipt} from its exact owned ledger`);
    }
    await waitForBoundedBuildReceipt(input, config.expectedStatus);
    const providerDigest = config.providerAction
      ? await verifyBuildProviderFixture(connection, fixture.tabId, config.providerAction)
      : null;
    verifyBuildActionEffect(config, fixture, state, receipts, request);
    outcome.effect = "pass";
    outcome.observedEffect = buildActionObservedEffect(config, providerDigest);
  } catch (error) {
    outcome.error = errorMessage(error);
  } finally {
    const cleanupErrors: string[] = [];
    if (fixture && fixtureStarted) {
      try {
        const cleared = await apiJson(connection, "POST", "/build/stop", {
          tabId: fixture.tabId,
          releaseTestClearState: true,
        });
        if (cleared.releaseTestCleared !== true) throw new Error("Build release-test state was not cleared");
        const state = await apiJson(connection, "GET", `/build/state?tabId=${encodeURIComponent(fixture.tabId)}`);
        if (state.state !== null) throw new Error("Build state remained after release-test cleanup");
        if (config.providerAction) {
          const provider = await apiJson(connection, "GET", `/provider-sessions/state?tabId=${encodeURIComponent(fixture.tabId)}&transport=local`);
          if (provider.activeRun != null || !Array.isArray(provider.recentRuns) || provider.recentRuns.length !== 0) {
            throw new Error("fixed provider child registry row remained after cleanup");
          }
        }
      } catch (error) {
        cleanupErrors.push(`Build state: ${errorMessage(error)}`);
      }
    }
    if (fixture) {
      try {
        if (fixture.ownedCheckpointPath && existsSync(fixture.ownedCheckpointPath)) {
          rmSync(fixture.ownedCheckpointPath, { recursive: true });
        }
        if (existsSync(fixture.nodeBuildTabRoot)) rmSync(fixture.nodeBuildTabRoot, { recursive: true });
        if (existsSync(fixture.nodeProject)) rmSync(fixture.nodeProject, { recursive: true });
        if (existsSync(fixture.nodeBuildStoreRoot) && readdirSync(fixture.nodeBuildStoreRoot).length === 0) {
          rmdirSync(fixture.nodeBuildStoreRoot);
        }
        if (existsSync(fixture.nodeCheckpointRoot) && readdirSync(fixture.nodeCheckpointRoot).length === 0) {
          rmdirSync(fixture.nodeCheckpointRoot);
        }
        if (existsSync(fixture.nodeProject)
          || existsSync(fixture.nodeBuildTabRoot)
          || (fixture.ownedCheckpointPath !== null && existsSync(fixture.ownedCheckpointPath))) {
          throw new Error("owned Build project, checkpoint, or store namespace remained");
        }
      } catch (error) {
        cleanupErrors.push(`filesystem: ${errorMessage(error)}`);
      }
    }
    if (baseline) {
      try {
        await postUi(connection, {
          rightTab: baseline.rightTab,
          activeTabId: baseline.activeTabId,
          activeTab: baseline.activeTab,
          source: "final-surface-build-run-action-cleanup",
        });
        const restored = await readBuildUiState(connection);
        if (restored.activeTabId !== baseline.activeTabId
          || restored.rightTab !== baseline.rightTab
          || JSON.stringify(restored.activeTab) !== JSON.stringify(baseline.activeTab)) {
          throw new Error("Build action cleanup did not restore the exact UI baseline");
        }
      } catch (error) {
        cleanupErrors.push(`view: ${errorMessage(error)}`);
      }
    }
    if (cleanupErrors.length === 0) outcome.cleanup = "pass";
    else outcome.error = outcome.error
      ? `${outcome.error}; cleanup: ${cleanupErrors.join("; ")}`
      : `cleanup: ${cleanupErrors.join("; ")}`;
  }
  if ([outcome.present, outcome.invoke, outcome.effect, outcome.cleanup].includes("fail") && !outcome.error) {
    outcome.error = `Build Run Cockpit ${config.action} lifecycle did not satisfy every verdict`;
  }
  return outcome;
}

function prepareOwnedBuildFixture(
  request: ReleaseSurfaceDriverRequest,
  action: BuildAction,
): OwnedBuildFixture {
  const tokenPath = nodeReadablePath(request.runtime.debugTokenPath, request.platform);
  const tokenStat = lstatSync(tokenPath);
  if (!tokenStat.isFile() || tokenStat.isSymbolicLink()
    || basename(tokenPath) !== "shellxagent.token" || basename(dirname(tokenPath)) !== ".shellx") {
    throw new Error("Build lifecycle requires the installed candidate's regular .shellx token");
  }
  const shellxHome = dirname(tokenPath);
  const suffix = request.sourceCommit.slice(0, 8).toLowerCase().replace(/[^a-f0-9]/g, "0");
  const tabId = `release-build-run-${action}`;
  const directory = `${tabId}-${suffix}`;
  const nodeProject = resolve(shellxHome, directory);
  const rel = relative(resolve(shellxHome), nodeProject);
  if (!rel || rel === "." || rel === ".." || rel.startsWith(`..${sep}`) || existsSync(nodeProject)) {
    throw new Error("Build lifecycle project is not a fresh direct candidate-home child");
  }
  const nodeBuildStoreRoot = resolve(shellxHome, "build-runs");
  const nodeBuildTabRoot = resolve(nodeBuildStoreRoot, tabId);
  const nodeCheckpointRoot = resolve(shellxHome, "git-checkpoints");
  if (existsSync(nodeBuildTabRoot)) {
    throw new Error("Build lifecycle exact owned tab namespace was not fresh");
  }
  mkdirSync(nodeProject, { mode: 0o700 });
  try {
    runGit(nodeProject, ["init", "-b", "release-build-fixture"]);
    writeFileSync(join(nodeProject, "README.md"), "# ShellX isolated Build Run fixture\n", { encoding: "utf8", flag: "wx", mode: 0o600 });
    runGit(nodeProject, ["add", "--", "README.md"]);
    runGit(nodeProject, ["-c", "user.name=ShellX Release Fixture", "-c", "user.email=shellx-release@example.invalid", "commit", "-m", "fixture baseline"]);
    writeFileSync(join(nodeProject, "README.md"), "# ShellX isolated Build Run fixture\n\nOwned working-tree change.\n", { encoding: "utf8", flag: "w", mode: 0o600 });
    writeFileSync(join(nodeProject, "owned-untracked.txt"), "SHELLX_BUILD_RUN_OWNED_UNTRACKED_035\n", { encoding: "utf8", flag: "wx", mode: 0o600 });
  } catch (error) {
    rmSync(nodeProject, { recursive: true, force: true });
    throw error;
  }
  const launchShellxHome = portableParent(request.runtime.debugTokenPath, request.platform);
  return {
    action,
    tabId,
    objective: `Exercise isolated Build Run Cockpit ${action}`,
    nodeProject,
    launchProject: portableJoin(launchShellxHome, directory, request.platform),
    nodeBuildStoreRoot,
    nodeBuildTabRoot,
    nodeCheckpointRoot,
    ownedCheckpointPath: null,
  };
}

function runGit(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 10_000 });
  if (result.status !== 0) {
    throw new Error(`git ${args[0]} failed: ${(result.stderr || result.stdout || "no output").trim()}`);
  }
  return result.stdout.trim();
}

async function readBuildUiState(connection: Connection): Promise<BuildUiState> {
  const state = await apiJson(connection, "GET", "/state/ui");
  if (typeof state.activeTabId !== "string" || !isRecord(state.activeTab)
    || typeof state.rightTab !== "string" || !RIGHT_RAIL_TABS.has(state.rightTab as RightRailTab)) {
    throw new Error("Build lifecycle could not read an exact restorable UI baseline");
  }
  return {
    activeTabId: state.activeTabId,
    activeTab: structuredClone(state.activeTab),
    rightTab: state.rightTab as RightRailTab,
  };
}

async function waitForBuildState(
  connection: Connection,
  tabId: string,
  status: string,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 10_000;
  let last: unknown = null;
  while (Date.now() < deadline) {
    const response = await apiJson(connection, "GET", `/build/state?tabId=${encodeURIComponent(tabId)}`);
    last = response.state;
    if (isRecord(last) && last.tabId === tabId && last.status === status) return last;
    await delay(50);
  }
  throw new Error(`Build state did not reach ${status}: ${JSON.stringify(last)}`);
}

async function readBuildReceipts(connection: Connection, tabId: string): Promise<Array<Record<string, unknown>>> {
  const response = await apiJson(connection, "GET", `/build/receipts?tabId=${encodeURIComponent(tabId)}`);
  if (!Array.isArray(response.receipts) || !response.receipts.every(isRecord)) {
    throw new Error("Build receipt ledger was not an exact object array");
  }
  return response.receipts;
}

async function waitForBoundedBuildReceipt(
  input: ReleaseSurfaceInstalledInputSession,
  status: string,
): Promise<void> {
  const deadline = Date.now() + 8_000;
  let last: string | undefined;
  while (Date.now() < deadline) {
    const receipt = await observeReleaseSurfaceInstalledInputElement(input, STATE_RECEIPT, ["title"]);
    last = receipt.title;
    if (receipt.present && receipt.visible
      && typeof last === "string" && last.startsWith(`Build run state · ${status} · `)) return;
    await delay(50);
  }
  throw new Error(`Build bounded state receipt did not reach ${status}; last=${last ?? "missing"}`);
}

async function verifyBuildProviderFixture(
  connection: Connection,
  tabId: string,
  action: "build-approve" | "build-resume",
): Promise<string> {
  const deadline = Date.now() + 12_000;
  let last = "";
  while (Date.now() < deadline) {
    const state = await apiJson(connection, "GET", `/provider-sessions/state?tabId=${encodeURIComponent(tabId)}&transport=local`);
    const runs = Array.isArray(state.recentRuns) ? state.recentRuns.filter(isRecord) : [];
    const completed = runs.find((run) => run.phase === "completed"
      && run.persistSession === false && run.shellxToolExposure === "off");
    const events = await apiValue(connection, `/events/recent?tabId=${encodeURIComponent(tabId)}&limit=200`);
    const rows = Array.isArray(events) ? events : [];
    const buildEvent = rows.filter(isRecord).find((row) => {
      const payload = isRecord(row.payload) ? row.payload : null;
      return row.kind === "build-event" && payload?.kind === "release_fixture_provider_started"
        && payload.tabId === tabId && payload.action === action;
    });
    const buildPayload = buildEvent && isRecord(buildEvent.payload) ? buildEvent.payload : null;
    const digest = typeof buildPayload?.promptSha256 === "string" ? buildPayload.promptSha256 : "";
    const textEvent = rows.filter(isRecord).find((row) => {
      const payload = isRecord(row.payload) ? row.payload : null;
      return row.kind === "provider-session-event" && payload?.runId === completed?.runId
        && payload?.kind === "text" && payload?.text === `SHELLX_PROVIDER_ACTION_RECEIPT ${action} ${digest}`;
    });
    last = `${completed?.runId ?? "no-run"}:${digest || "no-digest"}`;
    if (completed && /^[a-f0-9]{64}$/.test(digest) && textEvent) return digest;
    await delay(75);
  }
  throw new Error(`fixed Build provider child lacked its correlated JSONL receipt: ${last}`);
}

async function apiValue(connection: Connection, path: string): Promise<unknown> {
  const response = await fetch(`${connection.base}${path}`, {
    headers: { Authorization: `Bearer ${connection.token}` },
    signal: AbortSignal.timeout(10_000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`GET ${path} failed ${response.status}: ${text.slice(0, 800)}`);
  return text.trim() ? JSON.parse(text) : null;
}

function verifyBuildActionEffect(
  config: BuildActionConfig,
  fixture: OwnedBuildFixture,
  state: Record<string, unknown>,
  receipts: Array<Record<string, unknown>>,
  request: ReleaseSurfaceDriverRequest,
): void {
  if (state.cwd !== fixture.launchProject || state.objective !== fixture.objective) {
    throw new Error("Build action escaped its exact owned project or objective");
  }
  if (config.action === "approve") {
    const scratchboard = nodeReadablePath(String(state.scratchboardPath ?? ""), request.platform);
    if (!readFileSync(scratchboard, "utf8").includes("Status: IN_PROGRESS")) {
      throw new Error("Build approval did not patch the exact owned scratchboard to IN_PROGRESS");
    }
  }
  if (config.action === "resume" && Number(state.continuationsTotal) !== 1) {
    throw new Error("Build resume did not generate exactly one real continuation");
  }
  if (config.action === "recheck" && (state.openBlocker !== null || state.reviewSatisfied !== true)) {
    throw new Error("Build blocker recheck did not clear only the satisfied owned review blocker");
  }
  if (config.action === "checkpoint") {
    const receipt = receipts.find((row) => row.kind === "checkpointCreated");
    const data = receipt && isRecord(receipt.data) ? receipt.data : null;
    const path = nodeReadablePath(typeof data?.path === "string" ? data.path : "", request.platform);
    if (state.checkpointId !== data?.checkpointId
      || !resolve(path).startsWith(`${resolve(fixture.nodeCheckpointRoot)}${sep}`)
      || data?.repoRoot !== fixture.launchProject) {
      throw new Error("Build checkpoint escaped its exact owned Git namespace");
    }
    fixture.ownedCheckpointPath = path;
    if (!existsSync(join(path, "checkpoint.json"))
      || !existsSync(join(path, "unstaged.patch"))
      || !existsSync(join(path, "untracked.json"))) {
      throw new Error("Build checkpoint did not attach its exact complete owned Git snapshot");
    }
  }
  if (config.action === "stop") {
    const receipt = receipts.find((row) => row.kind === "runHalted");
    if (receipt?.summary !== "Stopped manually from Build cockpit") {
      throw new Error("Build stop receipt did not preserve the exact UI summary");
    }
  }
}

function buildActionObservedEffect(config: BuildActionConfig, digest: string | null): string {
  const provider = digest ? ` and correlated fixed JSONL provider receipt ${digest}` : "";
  return `Native installed input exercised the exact isolated ${config.action} action in the ${config.surfaceLabel}, observed its real ${config.expectedStatus} Build state and durable receipt${provider}, then removed its disposable Build, Git, provider, and project namespaces without touching operator state.`;
}

async function waitForBuildRejectConfirmation(
  input: ReleaseSurfaceInstalledInputSession,
  selector: string,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const state = await observeReleaseSurfaceInstalledInputElement(input, selector, ["title", "disabled"]);
    if (state.present && state.visible
      && state.disabled === false
      && state.title === "Confirm rejection and halt this Build Mode run") return;
    await delay(50);
  }
  throw new Error("Build Plan rejection did not reach its exact in-window confirmation state");
}

function portableParent(value: string, platform: ReleaseSurfaceDriverRequest["platform"]): string {
  const separator = platform === "windows-installed" ? "\\" : "/";
  const normalized = value.replace(/[\\/]+$/, "");
  const index = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
  if (index <= 0) throw new Error("Build token path has no candidate ShellX-home parent");
  return normalized.slice(0, index).replace(/[\\/]/g, separator);
}

function portableJoin(root: string, child: string, platform: ReleaseSurfaceDriverRequest["platform"]): string {
  const separator = platform === "windows-installed" ? "\\" : "/";
  return `${root.replace(/[\\/]+$/, "")}${separator}${child}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveWait) => setTimeout(resolveWait, ms));
}

type ReceiptState = {
  present: boolean;
  title: string | null;
  pressed: boolean | null;
  totalReceiptCount: number | null;
  visibleReceiptCount: number | null;
  mode: string | null;
};

async function receiptState(webdriver: ReleaseSurfaceInstalledInputSession): Promise<ReceiptState> {
  const [toggle, ledger] = await Promise.all([
    observeReleaseSurfaceInstalledInputElement(webdriver, RECEIPT_TOGGLE, ["pressed", "title"]),
    observeReleaseSurfaceInstalledInputElement(webdriver, RECEIPT_LEDGER_STATE, ["title"]),
  ]);
  const match = ledger.title?.match(/^Build receipt ledger · total=(\d+) · visible=(\d+) · mode=(latest|all)$/);
  return {
    present: toggle.present && toggle.visible && ledger.present && ledger.visible,
    title: toggle.title ?? null,
    pressed: typeof toggle.pressed === "boolean" ? toggle.pressed : null,
    totalReceiptCount: match ? Number(match[1]) : null,
    visibleReceiptCount: match ? Number(match[2]) : null,
    mode: match?.[3] ?? null,
  };
}

async function waitForReceiptState(
  webdriver: ReleaseSurfaceInstalledInputSession,
  visibleReceiptCount: number,
  title: string,
): Promise<ReceiptState> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const state = await receiptState(webdriver);
    if (state.visibleReceiptCount === visibleReceiptCount && state.title === title) return state;
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error(`Build Run Cockpit receipt ledger did not reach ${visibleReceiptCount} rows with ${title}`);
}

function verifyReceiptState(
  state: ReceiptState,
  expected: { title: string; label: string; visibleReceiptCount: number },
  label: string,
): void {
  if (state.present !== true
    || state.title !== expected.title
    || state.pressed !== (expected.label === "Latest")
    || state.totalReceiptCount !== 8
    || state.visibleReceiptCount !== expected.visibleReceiptCount
    || state.mode !== (expected.label === "Latest" ? "all" : "latest")) {
    throw new Error(`${label} did not expose the exact bounded receipt disclosure state`);
  }
}

function requireRightRailTab(value: unknown): RightRailTab {
  if (typeof value !== "string" || !RIGHT_RAIL_TABS.has(value as RightRailTab)) {
    throw new Error("Build Run Cockpit fixture could not read a restorable right-rail baseline");
  }
  return value as RightRailTab;
}

function emptyOutcome(assignment: Assignment): ReleaseSurfaceDriverOutcome {
  return {
    id: assignment.surface.id,
    expectedEffect: assignment.expectedEffect,
    oracleId: assignment.oracleId,
    present: "fail",
    invoke: "fail",
    effect: "fail",
    cleanup: "fail",
    observedEffect: "No native Build Run Cockpit receipt disclosure effect was observed.",
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
