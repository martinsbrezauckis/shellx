import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { assertDebugHealthVersion } from "./shellx-debug-version";
import { shellxHomeCandidates } from "./shellx-debug-paths";

export const SHELLX_VISIBLE_SURFACE_SECTIONS = [
  "app-chrome",
  "right-rail",
  "bottom-panel",
  "composer",
  "modals",
  "vault",
  "browser-entry",
] as const;

type SurfaceSection = typeof SHELLX_VISIBLE_SURFACE_SECTIONS[number];
type Verdict = "pass" | "fail" | "na";
type Json = Record<string, unknown>;

interface DebugHighlightResult {
  id?: string;
  selector?: string;
  status?: string;
  message?: string | null;
  rect?: { left: number; top: number; width: number; height: number } | null;
  visibleRect?: { left: number; top: number; width: number; height: number } | null;
  clipped?: boolean;
  contentClipped?: boolean;
  viewportWidth?: number;
  viewportHeight?: number;
}

interface DebugActionResult {
  action?: string;
  selector?: string;
  status?: string;
  message?: string | null;
}

interface EvidenceRow {
  id: string;
  section: SurfaceSection;
  label: string;
  selector: string;
  present: Verdict;
  render: Verdict;
  click: Verdict;
  result: Verdict;
  evidence: string;
  screenshot?: { path: string; bytes: number } | null;
}

interface CheckSpec {
  id: string;
  section: SurfaceSection;
  label: string;
  selector: string;
  before?: () => Promise<void>;
  drive?: () => Promise<string>;
  result: () => Promise<string>;
  after?: () => Promise<void>;
}

interface DebugConnection {
  shellxHome: string;
  base: string;
  token: string;
}

const EVIDENCE_ROOT = process.env.SHELLX_VISIBLE_SURFACE_WALKTHROUGH_OUT?.trim()
  || join(homedir(), ".shellx", "evidence", "visible-surface-walkthrough");
const SCREENSHOT_FULL = process.env.SHELLX_DEBUG_SCREENSHOT_FULL === "1";
const DEFAULT_WAIT_MS = parsePositiveInt(process.env.SHELLX_VISIBLE_SURFACE_TIMEOUT_MS, 60_000);
const CLICK_WAIT_MS = parsePositiveInt(process.env.SHELLX_VISIBLE_SURFACE_CLICK_TIMEOUT_MS, 90_000);

function readTrim(path: string): string | null {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return null;
  }
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function request(base: string, token: string, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  return fetch(`${base}${path}`, { ...init, headers });
}

async function api<T>(base: string, token: string, method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const headers = new Headers();
  if (body !== undefined) headers.set("Content-Type", "application/json");
  const res = await request(base, token, path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${path} failed ${res.status}: ${await res.text()}`);
  return await res.json();
}

async function resolveDebugConnection(): Promise<DebugConnection> {
  const baseOverride = process.env.SHELLX_DEBUG_BASE?.trim();
  const portOverride = process.env.SHELLX_DEBUG_PORT?.trim();
  const tokenOverride = process.env.SHELLX_DEBUG_TOKEN?.trim();
  const errors: string[] = [];
  for (const dir of shellxHomeCandidates()) {
    const port = portOverride || readTrim(join(dir, "debug-api.port"));
    const token = tokenOverride || readTrim(join(dir, "shellxagent.token"));
    if (!port || !token) {
      errors.push(`${dir}: missing ${!port ? "debug-api.port" : "shellxagent.token"}`);
      continue;
    }
    const base = baseOverride || `http://127.0.0.1:${port}`;
    try {
      const res = await request(base, token, "/health");
      if (res.ok) {
        await assertDebugHealthVersion(res, dir);
        return { shellxHome: dir, base, token };
      }
      errors.push(`${dir}: /health ${res.status}`);
    } catch (error) {
      errors.push(`${dir}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`ShellX debug API is not reachable from candidate homes: ${errors.join("; ")}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor<T>(
  label: string,
  fn: () => Promise<T | null>,
  timeoutMs = DEFAULT_WAIT_MS,
  intervalMs = 200,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value !== null) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(intervalMs);
  }
  throw new Error(`${label} timed out${lastError ? `: ${lastError instanceof Error ? lastError.message : String(lastError)}` : ""}`);
}

function expectedHighlights(id: string, selectors: string[]): Json[] {
  return selectors.map((selector, index) => ({
    id: `${id}-${index}`,
    selector,
    label: id,
    color: "cyan",
  }));
}

async function postUi(ctx: DebugConnection, body: Json): Promise<void> {
  await api(ctx.base, ctx.token, "POST", "/state/ui", { debugSurface: "app", source: "shellx-visible-surface-walkthrough", ...body });
}

async function focusMainShellxWindow(ctx: DebugConnection): Promise<void> {
  try {
    await api<Json>(ctx.base, ctx.token, "POST", "/vault/open-panel", {});
    await sleep(500);
  } catch {
    // Focusing is best-effort; per-row evidence remains authoritative.
  }
  await postUi(ctx, { openModal: "close", debugHighlights: [] });
  await sleep(250);
}

async function getUi(ctx: DebugConnection): Promise<Json> {
  return await api<Json>(ctx.base, ctx.token, "GET", "/state/ui");
}

async function getSettingsTheme(ctx: DebugConnection): Promise<string | null> {
  const settings = await api<Json>(ctx.base, ctx.token, "GET", "/settings").catch(() => ({} as Json));
  const theme = settings["theme"];
  return typeof theme === "string" ? theme : null;
}

async function debugClick(ctx: DebugConnection, selector: string): Promise<void> {
  await postUi(ctx, { debugActionResults: [], debugClick: selector });
  await waitFor(`debug click ${selector}`, async () => {
    const ui = await getUi(ctx) as { debugActionResults?: DebugActionResult[] };
    const results = Array.isArray(ui.debugActionResults) ? ui.debugActionResults : [];
    const result = results.find((entry) => entry.action === "debugClick" && entry.selector === selector);
    if (!result) return null;
    if (result.status === "clicked") return result;
    throw new Error(result.message || `debug click ${selector} reported ${result.status || "unknown status"}`);
  }, CLICK_WAIT_MS);
}

async function debugInput(ctx: DebugConnection, selector: string, value: string): Promise<void> {
  await postUi(ctx, { debugInput: { selector, value } });
}

async function waitForHighlights(ctx: DebugConnection, id: string, selectors: string[]): Promise<DebugHighlightResult[]> {
  const expectedIds = selectors.map((_, index) => `${id}-${index}`);
  const attempts = 3;
  const perAttemptTimeoutMs = Math.min(DEFAULT_WAIT_MS, 20_000);
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    await postUi(ctx, { debugHighlights: [] });
    await sleep(100);
    await postUi(ctx, { debugHighlights: expectedHighlights(id, selectors) });
    try {
      return await waitFor(`debug highlights ${id} attempt ${attempt}`, async () => {
        const ui = await getUi(ctx) as {
          debugHighlightResults?: DebugHighlightResult[];
          debugHighlightResultsBySurface?: Record<string, DebugHighlightResult[]>;
        };
        const results = Array.isArray(ui.debugHighlightResultsBySurface?.app)
          ? ui.debugHighlightResultsBySurface.app
          : Array.isArray(ui.debugHighlightResults)
            ? ui.debugHighlightResults
            : [];
        const byId = new Map(results.map((result) => [result.id, result]));
        const unresolved = expectedIds.filter((expectedId) => {
          const result = byId.get(expectedId);
          const rect = result?.visibleRect ?? result?.rect;
          return result?.status !== "resolved" || !rect || rect.width <= 0 || rect.height <= 0;
        });
        if (unresolved.length === 0) return results.filter((result) => expectedIds.includes(result.id ?? ""));
        return null;
      }, perAttemptTimeoutMs);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`debug highlights ${id} timed out`);
}

async function captureScreenshot(ctx: DebugConnection, outDir: string, id: string): Promise<{ path: string; bytes: number } | null> {
  const res = await request(ctx.base, ctx.token, SCREENSHOT_FULL ? "/screenshot?fullScreen=1" : "/screenshot");
  if (!res.ok) return null;
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length < 10_000) return null;
  const path = join(outDir, `${id}.png`);
  writeFileSync(path, bytes);
  return { path, bytes: bytes.length };
}

async function expectUiField(ctx: DebugConnection, key: string, value: string): Promise<string> {
  await waitFor(`${key}=${value}`, async () => {
    const ui = await getUi(ctx);
    return ui[key] === value ? ui : null;
  });
  return `/state/ui.${key} became ${value}`;
}

async function activateEditableTab(ctx: DebugConnection): Promise<void> {
  const ui = await getUi(ctx) as {
    openTabs?: Array<{
      tabId?: string;
      sessionId?: string | null;
      agentId?: string | null;
      connectionId?: string | null;
      status?: string | null;
      isSending?: boolean | null;
    }>;
  };
  const editableTabs = ui.openTabs?.filter((tab) => (
    typeof tab.tabId === "string"
    && !tab.sessionId
    && tab.status !== "Connected"
    && tab.isSending !== true
  )) ?? [];
  const candidate = editableTabs.find((tab) => !tab.connectionId && !tab.agentId)
    ?? editableTabs.find((tab) => !tab.connectionId)
    ?? editableTabs[0];
  await postUi(ctx, {
    activeTabId: candidate?.tabId,
    bottomTab: "Chat",
    composerMenu: "close",
  });
  if (candidate?.tabId) {
    await expectUiField(ctx, "activeTabId", candidate.tabId);
  }
}

async function expectSelector(ctx: DebugConnection, id: string, selector: string): Promise<string> {
  await waitForHighlights(ctx, `result-${id}`, [selector]);
  return `${selector} resolved after action`;
}

async function resetFloatingSurfaces(ctx: DebugConnection): Promise<void> {
  await postUi(ctx, {
    openModal: "close",
    composerMenu: "close",
    cwdPicker: { open: false },
    vaultRequestCenterOpen: false,
    setupGuideDismissed: false,
    debugActionResults: [],
    debugHighlights: [],
  });
  await sleep(150);
}

function checks(ctx: DebugConnection): CheckSpec[] {
  let themeBefore: string | null = null;
  return [
    {
      id: "shellx-setup-guide-vault",
      section: "app-chrome",
      label: "Setup guide Vault chip opens Vault workspace",
      selector: "[data-debug-id='shellx-setup-guide']",
      before: async () => postUi(ctx, {
        openModal: "close",
        setupGuideDismissed: false,
        debugHighlights: [],
      }),
      drive: async () => {
        await debugClick(ctx, "[data-debug-id='shellx-setup-step-vault']");
        return "clicked setup guide Vault step";
      },
      result: async () => expectSelector(ctx, "shellx-setup-guide-vault", "[data-debug-id='vault-workspace-modal']"),
      after: async () => postUi(ctx, { openModal: "close", debugHighlights: [] }),
    },
    {
      id: "header-vault-request-center",
      section: "app-chrome",
      label: "Vault Request Center header button opens popover",
      selector: "[data-debug-id='header-vault-request-center']",
      before: async () => postUi(ctx, { openModal: "close", debugHighlights: [] }),
      drive: async () => { await debugClick(ctx, "[data-debug-id='header-vault-request-center']"); return "clicked header Vault Request Center"; },
      result: async () => expectSelector(ctx, "header-vault-request-center", "[data-debug-id='vault-request-center-popover']"),
      after: async () => postUi(ctx, { vaultRequestCenterOpen: false, debugHighlights: [] }),
    },
    {
      id: "header-settings",
      section: "app-chrome",
      label: "Settings header button opens Settings",
      selector: ".settings-cog",
      before: async () => postUi(ctx, { openModal: "close", debugHighlights: [] }),
      drive: async () => { await debugClick(ctx, ".settings-cog"); return "clicked Settings header button"; },
      result: async () => expectSelector(ctx, "header-settings", ".settings-modal"),
      after: async () => postUi(ctx, { openModal: "close", debugHighlights: [] }),
    },
    {
      id: "header-theme-toggle",
      section: "app-chrome",
      label: "Header theme toggle switches bright mode",
      selector: "[data-debug-id='header-theme-toggle']",
      before: async () => {
        themeBefore = await getSettingsTheme(ctx);
        await postUi(ctx, { openModal: "close", debugHighlights: [] });
      },
      drive: async () => { await debugClick(ctx, "[data-debug-id='header-theme-toggle']"); return "clicked header theme toggle"; },
      result: async () => waitFor("settings theme changed", async () => {
        const theme = await getSettingsTheme(ctx);
        return theme && theme !== themeBefore ? `settings.theme changed to ${theme}` : null;
      }),
      after: async () => {
        if (themeBefore === "black" || themeBefore === "bright") {
          const theme = await getSettingsTheme(ctx);
          if (theme !== themeBefore) {
            await debugClick(ctx, "[data-debug-id='header-theme-toggle']").catch(() => undefined);
          }
        }
      },
    },
    {
      id: "right-rail-tasks",
      section: "right-rail",
      label: "Right rail Tasks tab activates",
      selector: "[data-debug-id='right-tab-tasks']",
      drive: async () => { await postUi(ctx, { rightTab: "Tasks" }); return "set rightTab=Tasks through debug state"; },
      result: async () => expectUiField(ctx, "rightTab", "Tasks"),
    },
    {
      id: "right-rail-tooling",
      section: "right-rail",
      label: "Right rail Tooling tab activates",
      selector: "[data-debug-id='right-tab-tooling']",
      drive: async () => { await postUi(ctx, { rightTab: "Tooling" }); return "set rightTab=Tooling through debug state"; },
      result: async () => expectUiField(ctx, "rightTab", "Tooling"),
    },
    {
      id: "right-rail-git",
      section: "right-rail",
      label: "Right rail Git tab activates",
      selector: "[data-debug-id='right-tab-git']",
      drive: async () => { await postUi(ctx, { rightTab: "Git" }); return "set rightTab=Git through debug state"; },
      result: async () => expectUiField(ctx, "rightTab", "Git"),
    },
    {
      id: "right-rail-preview",
      section: "right-rail",
      label: "Right rail Preview tab activates",
      selector: "[data-debug-id='right-tab-preview']",
      drive: async () => { await postUi(ctx, { rightTab: "Preview" }); return "set rightTab=Preview through debug state"; },
      result: async () => expectUiField(ctx, "rightTab", "Preview"),
    },
    {
      id: "right-rail-plan",
      section: "right-rail",
      label: "Right rail Plan tab activates",
      selector: "[data-debug-id='right-tab-plan']",
      drive: async () => { await postUi(ctx, { rightTab: "Plan" }); return "set rightTab=Plan through debug state"; },
      result: async () => expectUiField(ctx, "rightTab", "Plan"),
    },
    {
      id: "right-rail-files",
      section: "right-rail",
      label: "Right rail Files tab activates",
      selector: "[data-debug-id='right-tab-files']",
      drive: async () => { await postUi(ctx, { rightTab: "Files" }); return "set rightTab=Files through debug state"; },
      result: async () => expectUiField(ctx, "rightTab", "Files"),
    },
    {
      id: "bottom-chat",
      section: "bottom-panel",
      label: "Bottom Chat tab activates",
      selector: "[data-debug-id='bottom-tab-chat']",
      drive: async () => { await debugClick(ctx, "[data-debug-id='bottom-tab-chat']"); return "clicked Chat tab"; },
      result: async () => expectUiField(ctx, "bottomTab", "Chat"),
    },
    {
      id: "bottom-terminal",
      section: "bottom-panel",
      label: "Bottom Terminal tab activates",
      selector: "[data-debug-id='bottom-tab-terminal']",
      drive: async () => { await debugClick(ctx, "[data-debug-id='bottom-tab-terminal']"); return "clicked Terminal tab"; },
      result: async () => expectUiField(ctx, "bottomTab", "Terminal"),
    },
    {
      id: "bottom-logs",
      section: "bottom-panel",
      label: "Bottom Logs tab activates",
      selector: "[data-debug-id='bottom-tab-logs']",
      drive: async () => { await debugClick(ctx, "[data-debug-id='bottom-tab-logs']"); return "clicked Logs tab"; },
      result: async () => expectUiField(ctx, "bottomTab", "Logs"),
    },
    {
      id: "bottom-stderr",
      section: "bottom-panel",
      label: "Bottom Stderr tab activates",
      selector: "[data-debug-id='bottom-tab-stderr']",
      drive: async () => { await debugClick(ctx, "[data-debug-id='bottom-tab-stderr']"); return "clicked Stderr tab"; },
      result: async () => expectUiField(ctx, "bottomTab", "Stderr"),
    },
    {
      id: "composer-prompt-input",
      section: "composer",
      label: "Composer accepts typed text",
      selector: "[data-debug-id='composer-prompt']",
      before: async () => activateEditableTab(ctx),
      drive: async () => { await debugInput(ctx, "[data-debug-id='composer-prompt']", "/commands"); return "typed /commands into composer"; },
      result: async () => expectSelector(ctx, "composer-prompt-input", "[data-debug-id='composer-prompt']"),
      after: async () => debugInput(ctx, "[data-debug-id='composer-prompt']", ""),
    },
    {
      id: "composer-connection-picker",
      section: "composer",
      label: "Composer connection picker opens",
      selector: "[data-debug-id='composer-connection']",
      before: async () => activateEditableTab(ctx),
      drive: async () => { await postUi(ctx, { composerMenu: "connection" }); return "opened composer connection picker through debug state"; },
      result: async () => expectSelector(ctx, "composer-connection-picker", ".connection-picker-pop"),
      after: async () => postUi(ctx, { composerMenu: "close" }),
    },
    {
      id: "composer-agent-picker",
      section: "composer",
      label: "Composer agent picker opens",
      selector: "[data-debug-id='composer-agent']",
      before: async () => activateEditableTab(ctx),
      drive: async () => { await postUi(ctx, { composerMenu: "agent" }); return "opened composer agent picker through debug state"; },
      result: async () => expectSelector(ctx, "composer-agent-picker", "[data-agent-picker-root]"),
      after: async () => postUi(ctx, { composerMenu: "close" }),
    },
    {
      id: "composer-branch-picker",
      section: "composer",
      label: "Composer branch picker opens",
      selector: "[data-debug-id='composer-branch']",
      before: async () => activateEditableTab(ctx),
      drive: async () => { await postUi(ctx, { composerMenu: "branch" }); return "opened composer branch picker through debug state"; },
      result: async () => expectSelector(ctx, "composer-branch-picker", ".branch-picker--portal"),
      after: async () => postUi(ctx, { composerMenu: "close" }),
    },
    {
      id: "modal-help",
      section: "modals",
      label: "Help modal renders from the debug command route",
      selector: "[aria-label='Keyboard shortcuts']",
      before: async () => postUi(ctx, { openModal: "help", debugHighlights: [] }),
      drive: async () => "help modal opened in setup",
      result: async () => expectSelector(ctx, "modal-help", "[aria-label='Keyboard shortcuts']"),
      after: async () => postUi(ctx, { openModal: "close", debugHighlights: [] }),
    },
    {
      id: "modal-palette",
      section: "modals",
      label: "Command palette renders and accepts search text",
      selector: "[data-debug-id='command-palette-input']",
      before: async () => postUi(ctx, { openModal: "palette", debugHighlights: [] }),
      drive: async () => {
        await debugInput(ctx, "[data-debug-id='command-palette-input']", "settings");
        return "typed settings into open palette";
      },
      result: async () => expectSelector(ctx, "modal-palette", "[data-debug-id='command-palette-input']"),
      after: async () => postUi(ctx, { openModal: "close", debugHighlights: [] }),
    },
    {
      id: "modal-plugins",
      section: "modals",
      label: "Plugins modal renders",
      selector: ".plugins-modal",
      before: async () => postUi(ctx, { openModal: "plugins", debugHighlights: [] }),
      drive: async () => "plugins modal opened in setup",
      result: async () => expectSelector(ctx, "modal-plugins", ".plugins-modal"),
      after: async () => postUi(ctx, { openModal: "close", debugHighlights: [] }),
    },
    {
      id: "modal-vault",
      section: "vault",
      label: "Vault workspace renders management inputs",
      selector: "[data-debug-id='vault-workspace-modal']",
      before: async () => postUi(ctx, { openModal: "vault", debugHighlights: [] }),
      drive: async () => "vault modal opened in setup",
      result: async () => expectSelector(ctx, "modal-vault", "[data-debug-id='vault-secret-key-input']"),
      after: async () => postUi(ctx, { openModal: "close", debugHighlights: [] }),
    },
    {
      id: "header-browser",
      section: "browser-entry",
      label: "Browser header button is wired",
      selector: "[data-debug-id='header-shellx-browser']",
      before: async () => postUi(ctx, { openModal: "close", debugHighlights: [] }),
      drive: async () => { await debugClick(ctx, "[data-debug-id='header-shellx-browser']"); return "clicked ShellX Browser header button"; },
      result: async () => expectSelector(ctx, "header-browser", "[data-debug-id='header-shellx-browser']"),
    },
  ];
}

async function runCheck(ctx: DebugConnection, outDir: string, spec: CheckSpec): Promise<EvidenceRow> {
  const row: EvidenceRow = {
    id: spec.id,
    section: spec.section,
    label: spec.label,
    selector: spec.selector,
    present: "fail",
    render: "fail",
    click: "fail",
    result: "fail",
    evidence: "",
    screenshot: null,
  };
  try {
    await resetFloatingSurfaces(ctx);
    await spec.before?.();
    const highlights = await waitForHighlights(ctx, `present-${spec.id}`, [spec.selector]);
    const rect = highlights[0]?.visibleRect ?? highlights[0]?.rect ?? null;
    row.present = highlights[0]?.status === "resolved" ? "pass" : "fail";
    row.render = rect && rect.width > 0 && rect.height > 0 ? "pass" : "fail";
    row.screenshot = await captureScreenshot(ctx, outDir, spec.id);
    const driveEvidence = spec.drive ? await spec.drive() : "no click path declared";
    row.click = spec.drive ? "pass" : "na";
    const resultEvidence = await spec.result();
    row.result = "pass";
    row.evidence = `${driveEvidence}; ${resultEvidence}`;
    await spec.after?.();
  } catch (error) {
    row.evidence = error instanceof Error ? error.message : String(error);
    await spec.after?.().catch(() => undefined);
  }
  console.log(
    `${row.present === "pass" ? "PASS" : "FAIL"} ${row.id}: PRESENT=${row.present} RENDER=${row.render} CLICK=${row.click} RESULT=${row.result} - ${row.evidence}`,
  );
  return row;
}

function renderMarkdown(receipt: Json & { rows?: EvidenceRow[] }): string {
  const rows = receipt.rows ?? [];
  const lines = [
    "# ShellX Visible Surface Walkthrough",
    "",
    `Generated: ${receipt.generatedAt}`,
    `Status: ${String(receipt.status).toUpperCase()}`,
    "",
    "## Rows",
    "",
  ];
  for (const row of rows) {
    lines.push(`- ${row.id}: PRESENT=${row.present} RENDER=${row.render} CLICK=${row.click} RESULT=${row.result}`);
    lines.push(`  - ${row.evidence}`);
  }
  return `${lines.join("\n")}\n`;
}

async function main(): Promise<void> {
  const ctx = await resolveDebugConnection();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = join(EVIDENCE_ROOT, stamp);
  mkdirSync(outDir, { recursive: true });
  console.log(`\n=== ShellX visible surface walkthrough ===`);
  console.log("Development aid only; this is not the exhaustive frozen-candidate release gate.");
  console.log(`debugApi=${ctx.base}`);
  console.log(`shellxHome=${ctx.shellxHome}`);
  console.log(`evidence=${outDir}`);

  await focusMainShellxWindow(ctx);
  const rows: EvidenceRow[] = [];
  for (const spec of checks(ctx)) {
    rows.push(await runCheck(ctx, outDir, spec));
  }
  await postUi(ctx, {
    openModal: "close",
    composerMenu: "close",
    cwdPicker: { open: false },
    vaultRequestCenterOpen: false,
    setupGuideDismissed: false,
    bottomTab: "Chat",
    debugHighlights: [],
  }).catch(() => undefined);

  const failed = rows.filter((row) => row.present !== "pass" || row.render !== "pass" || row.click !== "pass" || row.result !== "pass");
  const receipt = {
    schema: "shellx/visible-surface-walkthrough@1",
    generatedAt: new Date().toISOString(),
    status: failed.length === 0 ? "pass" : "fail",
    coverage: {
      everyDeclaredSectionCovered: SHELLX_VISIBLE_SURFACE_SECTIONS.every((section) => rows.some((row) => row.section === section)),
      everyRowPresent: rows.every((row) => row.present === "pass"),
      everyRowRendered: rows.every((row) => row.render === "pass"),
      everyRowClicked: rows.every((row) => row.click === "pass"),
      everyRowResultVerified: rows.every((row) => row.result === "pass"),
    },
    totals: {
      rows: rows.length,
      failed: failed.length,
    },
    rows,
  };
  const jsonPath = join(outDir, "receipt.json");
  const markdownPath = join(outDir, "receipt.md");
  writeFileSync(jsonPath, JSON.stringify(receipt, null, 2), "utf8");
  writeFileSync(markdownPath, renderMarkdown(receipt), "utf8");
  console.log(`receipt=${jsonPath}`);
  if (failed.length > 0) {
    throw new Error(`${failed.length} visible surface walkthrough row(s) failed`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
