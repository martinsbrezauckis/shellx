import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { join } from "node:path";
import { shellxDataPaths } from "./shellx-debug-paths";

type JsonObject = Record<string, unknown>;

const MEDIATED_VAULT_RESOURCE_ACTIONS = [
  "fillProfileCardGrant",
  "readEmailCodeGrant",
  "useAgentWalletGrant",
] as const;

interface BrowserTask {
  taskId: string;
  profileId: string;
}

interface BrowserTab {
  browserTabId: string;
  taskId?: string | null;
  profileId: string;
  url?: string | null;
  status: string;
  shields?: {
    blockedAdTrackerCount?: number;
  } | null;
}

interface BrowserState {
  tabs?: BrowserTab[];
  activeBrowserTabId?: string | null;
  engine?: {
    mounted: boolean;
    url?: string | null;
    title?: string | null;
    loadStatus: string;
    lastError?: string | null;
  } | null;
}

interface BrowserActionResponse {
  ok: boolean;
  status: string;
  requiredApproval?: string | null;
  message?: string | null;
  receipt?: { kind?: string; evidence?: JsonObject };
  screenshot?: {
    path: string;
    bytes: number;
    sha256: string;
    width?: number | null;
    height?: number | null;
    source?: string | null;
  };
  findResult?: {
    query: string;
    matchCount: number;
    scrolled: boolean;
  };
  observation?: {
    refs?: Array<{
      refId: string;
      selector?: string;
      testId?: string | null;
      label?: string;
      role?: string;
      visible?: boolean;
      enabled?: boolean;
      editable?: boolean;
    }>;
    domSummary?: {
      links: number;
      buttons: number;
      inputs: number;
      forms: number;
      tables: number;
      headings: number;
      textBytes: number;
    };
    formFields?: Array<{
      selector?: string | null;
      label: string;
      fieldKind: string;
    }>;
  } | null;
}

interface BrowserDialogEvent {
  dialogId: string;
  taskId?: string | null;
  browserTabId?: string | null;
  dialogType: string;
  text: string;
  status: string;
  requiresApproval: boolean;
  receipt: { kind: string };
}

interface BrowserPermissionEvent {
  permissionId: string;
  taskId?: string | null;
  browserTabId?: string | null;
  permissionKind: string;
  origin?: string | null;
  path?: string | null;
  queryRetained: boolean;
  fragmentRetained: boolean;
  status: string;
  requiresApproval: boolean;
  receipt: { kind: string };
}

function readFirst(paths: string[]): string | null {
  for (const path of paths) {
    if (!existsSync(path)) continue;
    const value = readFileSync(path, "utf8").trim();
    if (value) return value;
  }
  return null;
}

function debugBase(): { base: string; token: string } {
  const explicitBase = process.env.SHELLX_DEBUG_BASE?.trim();
  const port = process.env.SHELLX_DEBUG_PORT?.trim()
    ?? readFirst(shellxDataPaths("debug-api.port"));
  const token = process.env.SHELLX_DEBUG_SECRET?.trim()
    ?? process.env.SHELLX_DEBUG_TOKEN?.trim()
    ?? readFirst(shellxDataPaths("shellxagent.token"))
    ?? readFirst(shellxDataPaths("debug.token"));
  if (!explicitBase && !port) {
    throw new Error("ShellX debug API port not found. Start the installed app or set SHELLX_DEBUG_BASE.");
  }
  if (!token) {
    throw new Error("ShellX debug API token not found. Set SHELLX_DEBUG_SECRET or start the installed app.");
  }
  return {
    base: explicitBase ?? `http://127.0.0.1:${port}`,
    token,
  };
}

function assert(cond: boolean, message: string): void {
  if (!cond) throw new Error(message);
  console.log(`  ✓ ${message}`);
}

async function api<T>(ctx: { base: string; token: string }, method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${ctx.base}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${ctx.token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    throw new Error(
      `${method} ${path} could not reach ${ctx.base}. Start ShellX with Debug API enabled, then rerun pnpm test:shellx-browser-everyday-apps. Cause: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const text = await res.text();
  let parsed: unknown = {};
  if (text.trim()) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  if (!res.ok) {
    throw new Error(`${method} ${path} failed with ${res.status}: ${text.slice(0, 800)}`);
  }
  return parsed as T;
}

async function apiError(ctx: { base: string; token: string }, method: string, path: string, body?: unknown): Promise<string> {
  let res: Response;
  try {
    res = await fetch(`${ctx.base}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${ctx.token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    throw new Error(
      `${method} ${path} could not reach ${ctx.base}. Cause: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const text = await res.text();
  if (res.ok) {
    throw new Error(`${method} ${path} unexpectedly succeeded: ${text.slice(0, 800)}`);
  }
  return text;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor<T>(
  label: string,
  fn: () => Promise<T | null>,
  timeoutMs = 20_000,
  intervalMs = 500,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value !== null) return value;
    } catch (err) {
      lastError = err;
    }
    await sleep(intervalMs);
  }
  throw new Error(`${label} timed out${lastError ? `: ${lastError instanceof Error ? lastError.message : String(lastError)}` : ""}`);
}

async function closeAllBrowserTabs(ctx: { base: string; token: string }): Promise<void> {
  const state = await api<BrowserState>(ctx, "GET", "/browser/state").catch(() => null);
  for (const tab of state?.tabs ?? []) {
    await api<JsonObject>(ctx, "POST", "/browser/tabs/close", { browserTabId: tab.browserTabId }).catch(() => undefined);
  }
  await waitFor("Browser tab cleanup", async () => {
    const next = await api<BrowserState>(ctx, "GET", "/browser/state");
    return (next.tabs?.length ?? 0) === 0 ? next : null;
  }, 8_000, 250).catch(() => undefined);
}

async function startEverydayFixture(): Promise<{ baseUrl: string; routeUrl: string; close: () => Promise<void> }> {
  const fixturePath = join(process.cwd(), "scripts", "fixtures", "vault-browser-site", "public", "everyday-apps.html");
  const sockets = new Set<Socket>();
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/health") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify({ ok: true, fixture: "shellx-everyday-apps", routes: ["/everyday-apps"] }));
      return;
    }
    if (req.method === "GET" && url.pathname === "/everyday-apps") {
      const html = await readFile(fixturePath, "utf8");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(html);
      return;
    }
    res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: false, error: "fixture route not found" }));
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;
  return {
    baseUrl,
    routeUrl: `${baseUrl}/everyday-apps`,
    close: () => closeServer(server, sockets),
  };
}

function closeServer(server: Server, sockets: Set<Socket>): Promise<void> {
  return new Promise((resolve, reject) => {
    for (const socket of sockets) socket.destroy();
    server.close((err) => err ? reject(err) : resolve());
  });
}

async function browserAction(ctx: { base: string; token: string }, taskId: string, body: JsonObject): Promise<BrowserActionResponse> {
  return await api<BrowserActionResponse>(ctx, "POST", "/browser/action", {
    taskId,
    ...body,
  });
}

async function waitForBrowserEngine(ctx: { base: string; token: string }, expectedUrl: string, taskId: string): Promise<BrowserState> {
  return await waitFor("everyday fixture Browser engine load", async () => {
    const state = await api<BrowserState>(ctx, "GET", "/browser/state");
    const active = state.tabs?.find((tab) => tab.browserTabId === state.activeBrowserTabId);
    if (active?.taskId !== taskId) return null;
    if (!state.engine?.mounted || !state.engine.url?.startsWith(expectedUrl)) return null;
    if (state.engine.loadStatus === "error") throw new Error(state.engine.lastError ?? "Browser engine error");
    return ["loaded", "observed", "screenshotCaptured"].includes(state.engine.loadStatus) ? state : null;
  }, 20_000, 500);
}

async function clickSelector(ctx: { base: string; token: string }, taskId: string, selector: string, label: string): Promise<void> {
  const result = await browserAction(ctx, taskId, {
    action: "clickRef",
    selector,
  });
  assert(result.status === "applied", label);
}

async function fillSelector(ctx: { base: string; token: string }, taskId: string, selector: string, value: string, label: string): Promise<void> {
  const result = await browserAction(ctx, taskId, {
    action: "fillRef",
    selector,
    value,
  });
  assert(result.status === "applied", label);
}

async function verifyText(ctx: { base: string; token: string }, taskId: string, value: string, label: string): Promise<void> {
  const result = await browserAction(ctx, taskId, {
    action: "verify",
    key: "text",
    value,
  });
  assert(result.status === "applied", label);
}

async function observeVisibleSelector(ctx: { base: string; token: string }, taskId: string, selector: string, label: string): Promise<void> {
  const observe = await browserAction(ctx, taskId, { action: "observe" });
  const testId = selector.match(/\[data-testid=['"]?([^'"\]]+)['"]?\]/)?.[1] ?? null;
  const ref = observe.observation?.refs?.find((candidate) =>
    candidate.selector === selector
    || (Boolean(testId) && candidate.testId === testId)
  );
  assert(observe.status === "applied" && Boolean(ref) && ref?.visible !== false, label);
}

async function activateSection(ctx: { base: string; token: string }, taskId: string, section: string): Promise<void> {
  await clickSelector(ctx, taskId, `[data-nav-target='${section}']`, `agent opens ${section} section`);
}

async function assertBeforeUnloadFeedback(ctx: { base: string; token: string }, taskId: string, nextUrl: string): Promise<BrowserDialogEvent> {
  const navigate = await browserAction(ctx, taskId, {
    action: "navigate",
    url: nextUrl,
  });
  assert(navigate.status === "applied" || navigate.status === "blockedBeforeUnload", "dirty-page navigation request is accepted or gated before leaving page");
  const blocked = navigate.status === "blockedBeforeUnload" ? navigate : await waitFor("beforeunload blocker feedback", async () => {
    const observe = await browserAction(ctx, taskId, { action: "observe" });
    if (observe.status === "blockedBeforeUnload") return observe;
    const dialogs = await api<{ dialogs: BrowserDialogEvent[] }>(ctx, "GET", "/browser/dialogs?limit=20");
    const pending = dialogs.dialogs.find((dialog) =>
      dialog.taskId === taskId
      && dialog.dialogType === "beforeunload"
      && dialog.status === "pending"
      && dialog.requiresApproval
    );
    return pending ? observe : null;
  }, 10_000, 750);
  assert(blocked.status === "blockedBeforeUnload", "beforeunload prompt is surfaced as blockedBeforeUnload");
  const dialogs = await api<{ dialogs: BrowserDialogEvent[] }>(ctx, "GET", "/browser/dialogs?limit=20");
  const beforeUnload = dialogs.dialogs.find((dialog) =>
    dialog.taskId === taskId
    && dialog.dialogType === "beforeunload"
    && dialog.status === "pending"
  );
  assert(Boolean(beforeUnload), "GET /browser/dialogs exposes pending beforeunload confirmation");
  assert(beforeUnload?.receipt.kind === "browserBeforeUnloadBlocked", "beforeunload dialog carries blocker receipt");
  return beforeUnload as BrowserDialogEvent;
}

async function main(): Promise<void> {
  console.log("\n=== ShellX Browser everyday-app smoke ===");
  const ctx = debugBase();
  let fixture: { baseUrl: string; routeUrl: string; close: () => Promise<void> } | null = null;
  let tabId: string | null = null;

  try {
    fixture = await startEverydayFixture();
    await api<JsonObject>(ctx, "GET", "/health");
    assert(true, "debug API health responds");
    const opened = await api<{ ok: boolean }>(ctx, "POST", "/browser/open", {
      startUrl: fixture.routeUrl,
    });
    assert(opened.ok, "Browser window opens for everyday app smoke");

    const task = await api<BrowserTask>(ctx, "POST", "/browser/task/start", {
      goal: "Everyday app smoke: mail, docs, calendar, sheets, drive, checkout, permissions, beforeunload",
      startUrl: fixture.routeUrl,
      profileId: "agent-work",
      autonomy: "assistedAutonomous",
      expectedDomains: ["127.0.0.1"],
    });
    assert(task.taskId.startsWith("browser-task-"), "everyday app Browser task starts");
    const loaded = await waitForBrowserEngine(ctx, fixture.routeUrl, task.taskId);
    tabId = loaded.tabs?.find((tab) => tab.browserTabId === loaded.activeBrowserTabId)?.browserTabId ?? null;
    assert(Boolean(tabId), "everyday task has an active Browser tab");

    const observe = await browserAction(ctx, task.taskId, { action: "observe" });
    assert(observe.status === "applied", "agent observes everyday app fixture");
    assert((observe.observation?.domSummary?.forms ?? 0) >= 1, "observation sees active everyday form surface");
    assert(Boolean(observe.observation?.refs?.some((ref) => ref.testId === "mail-search")), "observation exposes mail search field");

    await clickSelector(ctx, task.taskId, "[data-testid=cookie-accept]", "agent dismisses blocking cookie-style overlay");
    await waitFor("ad filter fixture cleanup", async () => {
      const result = await browserAction(ctx, task.taskId, { action: "observe" });
      if (result.status !== "applied" || !result.observation?.domSummary) return null;
      const text = JSON.stringify(result.observation);
      if (!text.includes("ShellX ad filter cleaned")) return null;
      if (text.includes("Portāls atvērsies") || text.includes("Aizvērt reklāmu")) return null;
      const state = await api<BrowserState>(ctx, "GET", "/browser/state");
      const active = state.tabs?.find((tab) => tab.browserTabId === state.activeBrowserTabId);
      return (active?.shields?.blockedAdTrackerCount ?? 0) > 0 ? result : null;
    }, 8_000, 500);
    assert(true, "balanced ad filter cleans fixture elements, ad interstitials, and tab shield count");

    await fillSelector(ctx, task.taskId, "[data-testid=mail-search]", "invoice", "agent fills mail search");
    await clickSelector(ctx, task.taskId, "[data-app-shell='mail'] button[type='submit']", "agent submits mail search");
    await verifyText(ctx, task.taskId, "Mail search complete: 1 result", "mail search workflow verifies result");
    const findMail = await browserAction(ctx, task.taskId, {
      action: "findText",
      value: "Invoice ready for review",
    });
    assert(findMail.status === "applied" && (findMail.findResult?.matchCount ?? 0) > 0, "agent uses findText inside mail results");

    await activateSection(ctx, task.taskId, "docs");
    await observeVisibleSelector(ctx, task.taskId, "[data-testid=doc-editor]", "observation exposes editable docs surface after opening docs");
    await fillSelector(ctx, task.taskId, "[data-testid=doc-title]", "Browser release notes", "agent fills document title");
    await fillSelector(ctx, task.taskId, "[data-testid=doc-editor]", "Agent edited document body from ShellX Browser.", "agent edits rich document body");
    await verifyText(ctx, task.taskId, "Doc has unsaved changes", "docs dirty state is visible before save");
    await clickSelector(ctx, task.taskId, "[data-testid=doc-save]", "agent saves document");
    await verifyText(ctx, task.taskId, "Doc saved for Browser smoke", "docs save workflow verifies result");

    await activateSection(ctx, task.taskId, "calendar");
    await observeVisibleSelector(ctx, task.taskId, "[data-testid=calendar-title]", "observation exposes calendar field after opening calendar");
    await fillSelector(ctx, task.taskId, "[data-testid=calendar-title]", "Vault release review", "agent fills calendar title");
    const calendarSelect = await browserAction(ctx, task.taskId, {
      action: "select",
      selector: "[data-testid=calendar-time]",
      value: "11:30",
    });
    assert(calendarSelect.status === "applied", "agent selects calendar time");
    await clickSelector(ctx, task.taskId, "[data-testid=calendar-form] button[type='submit']", "agent creates calendar event");
    await verifyText(ctx, task.taskId, "Calendar event created: Vault release review", "calendar workflow verifies result");

    await activateSection(ctx, task.taskId, "sheets");
    await observeVisibleSelector(ctx, task.taskId, "[data-testid=sheet-budget]", "observation exposes sheet cell input after opening sheets");
    await fillSelector(ctx, task.taskId, "[data-testid=sheet-budget]", "950", "agent edits spreadsheet-style cell");
    await clickSelector(ctx, task.taskId, "[data-testid=sheet-save]", "agent saves spreadsheet-style table");
    await verifyText(ctx, task.taskId, "Sheet saved with budget 950", "sheets workflow verifies result");

    await activateSection(ctx, task.taskId, "drive");
    await observeVisibleSelector(ctx, task.taskId, "[data-testid=drive-filter]", "observation exposes drive filter after opening drive");
    await fillSelector(ctx, task.taskId, "[data-testid=drive-filter]", "vault", "agent filters drive-style file list");
    await verifyText(ctx, task.taskId, "Drive filter active: vault", "drive filter workflow verifies result");
    const findDrive = await browserAction(ctx, task.taskId, {
      action: "findText",
      value: "Vault import checklist.pdf",
    });
    assert(findDrive.status === "applied", "agent finds a drive file by in-page text");

    await activateSection(ctx, task.taskId, "checkout");
    await observeVisibleSelector(ctx, task.taskId, "[data-testid=checkout-email]", "observation exposes checkout field after opening checkout");
    await fillSelector(ctx, task.taskId, "[data-testid=checkout-email]", "agent@example.test", "agent fills checkout email");
    await fillSelector(ctx, task.taskId, "[data-testid=checkout-note]", "Hold for Browser smoke pickup", "agent fills checkout note");
    await clickSelector(ctx, task.taskId, "[data-testid=checkout-submit]", "agent submits checkout-style form");
    await verifyText(ctx, task.taskId, "Order submitted for agent@example.test", "checkout workflow verifies result");

    await activateSection(ctx, task.taskId, "profile-card");
    await observeVisibleSelector(ctx, task.taskId, "[data-testid=profile-email]", "observation exposes profile-card email field");
    await fillSelector(ctx, task.taskId, "[data-testid=profile-full-name]", "Claude Code", "agent fills profile-card name");
    await fillSelector(ctx, task.taskId, "[data-testid=profile-email]", "agent@example.test", "agent fills profile-card email");
    await fillSelector(ctx, task.taskId, "[data-testid=profile-company]", "ShellX", "agent fills profile-card company");
    await fillSelector(ctx, task.taskId, "[data-testid=profile-city]", "Riga", "agent fills profile-card city");
    await clickSelector(ctx, task.taskId, "[data-testid=profile-card-submit]", "agent submits profile-card form");
    await verifyText(ctx, task.taskId, "Profile created for agent@example.test at ShellX", "profile-card workflow verifies result");

    await activateSection(ctx, task.taskId, "email-code");
    await observeVisibleSelector(ctx, task.taskId, "[data-testid=email-code-input]", "observation exposes email-code input");
    await fillSelector(ctx, task.taskId, "[data-testid=email-code-input]", "739214", "agent fills email-code input");
    await clickSelector(ctx, task.taskId, "[data-testid=email-code-submit]", "agent submits email code");
    await verifyText(ctx, task.taskId, "Email code accepted", "email-code workflow verifies result");

    await activateSection(ctx, task.taskId, "agent-wallet");
    await observeVisibleSelector(ctx, task.taskId, "[data-testid=agent-wallet-email]", "observation exposes agent-wallet checkout email");
    await fillSelector(ctx, task.taskId, "[data-testid=agent-wallet-email]", "agent@example.test", "agent fills wallet checkout email");
    await clickSelector(ctx, task.taskId, "[data-testid=agent-wallet-terms]", "agent checks subscription approval box");
    await clickSelector(ctx, task.taskId, "[data-testid=agent-wallet-submit]", "agent submits wallet checkout dry run");
    await verifyText(ctx, task.taskId, "Subscription dry-run prepared for agent@example.test", "agent-wallet workflow verifies result");
    assert(MEDIATED_VAULT_RESOURCE_ACTIONS.length === 3, "everyday app smoke tracks mediated Vault resource actions");

    const permission = await api<BrowserPermissionEvent>(ctx, "POST", "/browser/permissions", {
      taskId: task.taskId,
      browserTabId: tabId,
      permissionKind: "notifications",
      url: `${fixture.routeUrl}?notificationSecret=must-not-echo#notify`,
      userInitiated: true,
      requiresApproval: true,
    });
    assert(permission.status === "pending" && permission.requiresApproval, "notification permission request is approval-gated");
    assert(permission.permissionKind === "notifications", "notification permission kind is normalized");
    assert(permission.origin === fixture.baseUrl, "notification permission exposes safe origin");
    assert(permission.path === "/everyday-apps", "notification permission exposes safe path");
    assert(permission.queryRetained === false && permission.fragmentRetained === false, "notification permission strips query and fragment");
    assert(!JSON.stringify(permission).includes("must-not-echo"), "notification permission record does not expose query secret");

    const deniedPermission = await apiError(ctx, "POST", "/browser/permissions/resolve", {
      permissionId: permission.permissionId,
      action: "deny",
    });
    assert(deniedPermission.includes("browser_prompt_resolution_requires_operator"), "Debug API cannot resolve notification permission without operator UI");
    const permissions = await api<{ permissions: BrowserPermissionEvent[] }>(ctx, "GET", "/browser/permissions?limit=20");
    assert(permissions.permissions.some((event) => event.permissionId === permission.permissionId && event.status === "pending"), "GET /browser/permissions keeps Debug API-denied notification decision pending");

    const screenshot = await browserAction(ctx, task.taskId, { action: "captureScreenshot" });
    assert(screenshot.status === "applied" && (screenshot.screenshot?.bytes ?? 0) > 10_000, "everyday workflow screenshot captures non-empty Browser evidence");

    await activateSection(ctx, task.taskId, "docs");
    await fillSelector(ctx, task.taskId, "[data-testid=doc-editor]", "Unsaved text before navigation.", "agent creates dirty document state for beforeunload");
    const beforeUnload = await assertBeforeUnloadFeedback(ctx, task.taskId, `${fixture.routeUrl}?after=dirty`);
    const beforeUnloadDenied = await apiError(ctx, "POST", "/browser/dialogs/resolve", {
      dialogId: beforeUnload.dialogId,
      action: "accept",
    });
    assert(beforeUnloadDenied.includes("browser_prompt_resolution_requires_operator"), "Debug API cannot accept beforeunload navigation without the owning task id");
    const beforeUnloadDismissed = await api<BrowserDialogEvent>(ctx, "POST", "/browser/dialogs/resolve", {
      dialogId: beforeUnload.dialogId,
      taskId: task.taskId,
      action: "dismiss",
    });
    assert(beforeUnloadDismissed.status === "dismissed", "owning Browser task can dismiss its task-owned beforeunload prompt");

    console.log("ShellX Browser everyday-app smoke passed");
  } finally {
    await closeAllBrowserTabs(ctx);
    if (fixture) await fixture.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
