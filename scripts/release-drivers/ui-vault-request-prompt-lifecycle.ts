import { createServer, type Server } from "node:http";
import type { Socket } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  clickReleaseSurfaceInstalledInputElement,
  closeReleaseSurfaceInstalledInputWindow,
  findReleaseSurfaceInstalledInputElement,
  switchReleaseSurfaceInstalledInputWindow,
  switchReleaseSurfaceInstalledInputWindowByTitle,
  waitForReleaseSurfaceInstalledInputElement,
  waitForReleaseSurfaceInstalledInputElementAbsent,
  type ReleaseSurfaceInstalledInputSession,
} from "../lib/release-surface-installed-input-client";
import type {
  ReleaseSurfaceDriverOutcome,
  ReleaseSurfaceDriverRequest,
} from "../lib/release-surface-driver-protocol";
import { cleanupOwnedBrowserLifecycle } from "../shellx-browser-test-cleanup";
import {
  cleanupDebugApiBrowserSettleFixture,
  prepareDebugApiBrowserSettleFixture,
  type DebugApiBrowserSettleFixture,
} from "./debug-api-browser-settle-fixture";

type Assignment = ReleaseSurfaceDriverRequest["assignments"][number];
type Connection = { base: string; token: string };
type InstalledInput = ReleaseSurfaceInstalledInputSession;
type UiTab = Record<string, unknown> & { tabId: string };
type UiState = Record<string, unknown> & { activeTabId?: unknown; openTabs?: unknown };
type VaultDirectory = { keys: string[]; entries: Array<Record<string, unknown> & { key: string }> };
type VaultGrant = {
  grantId: string;
  secretRef: string;
  operation: string;
  origin: string;
  approved: boolean;
  revoked: boolean;
};
type Action =
  | "header-tertiary"
  | "header-secondary"
  | "header-primary"
  | "header-tertiary-marker"
  | "browser-secondary"
  | "browser-primary"
  | "browser-secondary-marker"
  | "browser-primary-marker"
  | "browser-card"
  | "browser-stack"
  | "fill-panel"
  | "fill-unavailable";

const HEADER_TOGGLE = "[data-debug-id='header-vault-request-center']";
const HEADER_POPOVER = "[data-debug-id='vault-request-center-popover']";
const NEW_SESSION = "[title='New session (⌘T)']";
const BROWSER_REQUESTS_TAB = "[data-debug-id='shellx-browser-right-tab-requests']";
const BROWSER_STACK = "[data-debug-id='shellx-browser-vault-prompt-stack']";
const BROWSER_CARD = "[data-debug-id='shellx-browser-vault-prompt-card']";
const VAULT_MODAL = "[data-debug-id='vault-workspace-modal']";
const VAULT_MODAL_CLOSE = `${VAULT_MODAL} [aria-label='Close']`;
const FILL_MENU = "[data-debug-id='shellx-browser-vault-fill-menu']";
const FILL_PANEL = "[data-debug-id='shellx-browser-vault-fill-panel']";
const FILL_UNAVAILABLE = "[data-debug-id='shellx-browser-vault-fill-unavailable']";
const SYNTHETIC_DEPOSIT_SECRET = "SHELLX_RELEASE_VAULT_PROMPT_DEPOSIT_VALUE_035";
const SYNTHETIC_VAULT_PASSPHRASE = "ShellX-release-vault-prompt-owned-passphrase-035";

function controlId(source: string, occurrence: number): string {
  return `ui-control:${source}@${source.split(":", 1)[0]}#${occurrence}`;
}

const HEADER_SOURCE = "src/components/HeaderVaultRequestCenter.tsx:[data-debug-id^=\"vault-request-action-\"]";
const BROWSER_SOURCE = "src/browser/components/VaultPromptCards.tsx:[data-debug-id^=\"shellx-browser-vault-prompt-\"]";

const ACTIONS = new Map<string, Action>([
  [controlId(HEADER_SOURCE, 5), "header-tertiary"],
  [controlId(HEADER_SOURCE, 6), "header-secondary"],
  [controlId(HEADER_SOURCE, 7), "header-primary"],
  ["ui-debug-surface:vault-request-action-*@src/components/HeaderVaultRequestCenter.tsx#7", "header-tertiary-marker"],
  [controlId(BROWSER_SOURCE, 1), "browser-secondary"],
  [controlId(BROWSER_SOURCE, 2), "browser-primary"],
  ["ui-debug-surface:shellx-browser-vault-prompt-*@src/browser/components/VaultPromptCards.tsx#3", "browser-secondary-marker"],
  ["ui-debug-surface:shellx-browser-vault-prompt-*@src/browser/components/VaultPromptCards.tsx#4", "browser-primary-marker"],
  ["ui-debug-surface:shellx-browser-vault-prompt-card@src/browser/components/VaultPromptCards.tsx#2", "browser-card"],
  ["ui-debug-surface:shellx-browser-vault-prompt-stack@src/browser/components/VaultPromptCards.tsx#1", "browser-stack"],
  ["ui-debug-surface:shellx-browser-vault-fill-unavailable@src/browser/components/BrowserVaultFillPanel.tsx#2", "fill-unavailable"],
]);

export const VAULT_REQUEST_PROMPT_SURFACE_IDS = new Set(ACTIONS.keys());
export const VAULT_REQUEST_PROMPT_CONTROL_SURFACE_IDS = new Set(
  [...ACTIONS.entries()].filter(([id]) => id.startsWith("ui-control:")).map(([id]) => id),
);
export const VAULT_REQUEST_PROMPT_DEBUG_SURFACE_IDS = new Set(
  [...ACTIONS.entries()].filter(([id]) => id.startsWith("ui-debug-surface:")).map(([id]) => id),
);
export const VAULT_REQUEST_PROMPT_FIXTURES = [
  "ui:vault-request-owned-renderer-permission",
  "ui:vault-request-owned-pending-grant",
  "ui:browser-vault-owned-grant-and-deposit",
  "ui:browser-vault-owned-locked-fill-form",
] as const;
export const VAULT_REQUEST_PROMPT_CLEANUPS = [
  "ui:clear-owned-renderer-request-close-owned-tab-and-restore-header",
  "ui:reset-isolated-vault-grants-and-restore-header",
  "ui:delete-exact-deposits-abort-owned-browser-and-close-window",
  "ui:close-owned-fill-tab-reset-isolated-vault-and-close-window",
] as const;
export const VAULT_REQUEST_PROMPT_ORACLES = [
  "ui:activation:vault-request-focus-owned-session",
  "ui:activation:vault-grant-decision-transition",
  "ui:activation:browser-vault-prompt-decisions",
  "ui:surface:browser-vault-action-specific-markers",
  "ui:surface:browser-vault-unavailable-fill-panel",
] as const;

export function supportsVaultRequestPromptSurface(assignment: Assignment): boolean {
  return ACTIONS.has(assignment.surface.id);
}

export async function exerciseVaultRequestPromptSurface(
  connection: Connection,
  installedInput: InstalledInput,
  request: ReleaseSurfaceDriverRequest,
  assignment: Assignment,
): Promise<ReleaseSurfaceDriverOutcome> {
  const action = ACTIONS.get(assignment.surface.id);
  if (!action) return finalize(emptyOutcome(assignment), "unsupported Vault request/prompt surface");
  if (action === "header-tertiary" || action === "header-tertiary-marker") {
    return exerciseHeaderTertiary(connection, installedInput, assignment, action);
  }
  if (action === "header-secondary" || action === "header-primary") {
    return exerciseHeaderGrant(connection, installedInput, request, assignment, action);
  }
  if (action === "fill-panel" || action === "fill-unavailable") {
    return exerciseUnavailableFill(connection, installedInput, assignment, action);
  }
  return exerciseBrowserPrompts(connection, installedInput, request, assignment, action);
}

async function exerciseHeaderTertiary(
  connection: Connection,
  input: InstalledInput,
  assignment: Assignment,
  action: "header-tertiary" | "header-tertiary-marker",
): Promise<ReleaseSurfaceDriverOutcome> {
  const outcome = emptyOutcome(assignment);
  const cleanupErrors: string[] = [];
  let baseline: { tabs: UiTab[]; activeTabId: string } | null = null;
  let root: string | null = null;
  let ownedTabId: string | null = null;
  try {
    baseline = exactUiBaseline(await apiJson(connection, "GET", "/state/ui"), "header tertiary baseline");
    root = mkdtempSync(join(tmpdir(), "shellx-release-vault-request-"));
    const attachmentPath = join(root, "owned-vault-request.txt");
    const imagePath = join(root, "owned-vault-request.png");
    writeFileSync(attachmentPath, "owned Vault request fixture\n", { encoding: "utf8", mode: 0o600 });
    writeFileSync(imagePath, "owned renderer fixture", { encoding: "utf8", mode: 0o600 });
    await apiJson(connection, "POST", "/state/ui", {
      source: "final-surface-vault-request-tertiary",
      debugRendererFixture: { id: "event-projections", attachmentPath, imagePath },
    });
    await clickSelector(input, NEW_SESSION);
    const changed = await waitForUi(connection, (state) => {
      const tabs = safeTabs(state);
      return tabs.length === baseline!.tabs.length + 1 && state.activeTabId !== baseline!.activeTabId;
    }, "owned focus target tab");
    ownedTabId = requiredString(changed.activeTabId, "owned focus target tab id");
    await openHeader(input);
    const requestSelector = "[data-request-id='session-permission:release-fixture-permission']";
    const focusSelector = `${requestSelector} [data-debug-id='vault-request-action-focusSession']`;
    await waitForReleaseSurfaceInstalledInputElement(input, focusSelector);
    outcome.present = "pass";
    if (action === "header-tertiary") {
      await clickSelector(input, focusSelector);
      outcome.invoke = "pass";
      await waitForUi(connection, (state) => state.activeTabId === baseline!.activeTabId, "Vault request Focus action");
      outcome.effect = "pass";
      outcome.observedEffect = "Native installed input activated the exact focusSession action on an owned Vault-like permission request and returned focus from the owned disposable tab to its exact source session.";
    } else {
      outcome.invoke = "pass";
      outcome.effect = "pass";
      outcome.observedEffect = "Native installed input opened the Request Center after an owned three-action Vault-like permission fixture was established, and the exact focusSession tertiary marker was visibly bound without activating a provider or permission decision.";
    }
  } catch (error) {
    outcome.error = errorText(error);
  } finally {
    await cleanupAttempt(cleanupErrors, async () => closeHeader(input));
    await cleanupAttempt(cleanupErrors, async () => {
      await apiJson(connection, "POST", "/state/ui", {
        source: "final-surface-vault-request-tertiary-cleanup",
        debugRendererFixture: "clear",
      });
    });
    if (ownedTabId) {
      await cleanupAttempt(cleanupErrors, async () => {
        await clickSelector(input, `[data-tab-id='${cssString(ownedTabId!)}'] [aria-label='Close session']`);
        await waitForUi(connection, (state) => !safeTabs(state).some((tab) => tab.tabId === ownedTabId), "owned focus target cleanup");
      });
    }
    if (baseline) {
      await cleanupAttempt(cleanupErrors, async () => {
        const state = await apiJson(connection, "GET", "/state/ui");
        if (state.activeTabId !== baseline!.activeTabId) await clickSelector(input, `[data-tab-id='${cssString(baseline!.activeTabId)}']`);
        const restored = exactUiBaseline(await waitForUi(connection, (candidate) => candidate.activeTabId === baseline!.activeTabId, "header tertiary UI restore"), "header tertiary restored UI");
        if (JSON.stringify(restored) !== JSON.stringify(baseline)) throw new Error("header tertiary cleanup did not restore the exact tab baseline");
      });
    }
    if (root) await cleanupAttempt(cleanupErrors, async () => rmSync(root!, { recursive: true }));
    finishCleanup(outcome, cleanupErrors);
  }
  return finalize(outcome);
}

async function exerciseHeaderGrant(
  connection: Connection,
  input: InstalledInput,
  request: ReleaseSurfaceDriverRequest,
  assignment: Assignment,
  action: "header-secondary" | "header-primary",
): Promise<ReleaseSurfaceDriverOutcome> {
  const outcome = emptyOutcome(assignment);
  const cleanupErrors: string[] = [];
  let grant: VaultGrant | null = null;
  try {
    await resetIsolatedVault(connection);
    const secretRef = `release/request-center/${request.sourceCommit.slice(0, 16)}/${action}`;
    const created = await apiJson(connection, "POST", "/vault/grants", {
      secretRef,
      operation: "fill",
      actorScope: { kind: "allShellxAgents" },
      origin: "https://example.com",
    });
    grant = validateCreatedGrant(created, secretRef);
    await openHeader(input);
    const decision = action === "header-primary" ? "approveVaultGrant" : "denyVaultGrant";
    const selector = `[data-request-id='vault-grant:${cssString(grant.grantId)}'] [data-debug-id='vault-request-action-${decision}']`;
    await waitForReleaseSurfaceInstalledInputElement(input, selector);
    outcome.present = "pass";
    await clickSelector(input, selector);
    outcome.invoke = "pass";
    await waitForGrant(connection, grant.grantId, (candidate) => action === "header-primary"
      ? candidate.approved === true && candidate.revoked === false
      : candidate.approved === false && candidate.revoked === true);
    outcome.effect = "pass";
    outcome.observedEffect = action === "header-primary"
      ? "Native installed input activated the exact approveVaultGrant primary action and changed only the isolated pending grant to approved without reading a Vault value."
      : "Native installed input activated the exact denyVaultGrant secondary action and changed only the isolated pending grant to revoked without reading a Vault value.";
  } catch (error) {
    outcome.error = errorText(error);
  } finally {
    await cleanupAttempt(cleanupErrors, async () => closeHeader(input));
    await cleanupAttempt(cleanupErrors, async () => resetIsolatedVault(connection));
    finishCleanup(outcome, cleanupErrors);
  }
  return finalize(outcome);
}

type BrowserPromptFixture = {
  browser: DebugApiBrowserSettleFixture;
  grantId: string;
  depositId: string;
  vaultRef: string;
  vaultBaseline: VaultDirectory;
  originalWindow: string;
};

async function exerciseBrowserPrompts(
  connection: Connection,
  input: InstalledInput,
  request: ReleaseSurfaceDriverRequest,
  assignment: Assignment,
  action: Exclude<Action, "header-tertiary" | "header-secondary" | "header-primary" | "header-tertiary-marker" | "fill-panel" | "fill-unavailable">,
): Promise<ReleaseSurfaceDriverOutcome> {
  const outcome = emptyOutcome(assignment);
  const cleanupErrors: string[] = [];
  let fixture: BrowserPromptFixture | null = null;
  try {
    fixture = await prepareBrowserPromptFixture(connection, input, request, action);
    const grantCard = `[data-prompt-id='session-grant-${cssString(fixture.grantId)}']`;
    const depositCard = `[data-prompt-id='vault-deposit-${cssString(fixture.depositId)}']`;
    await clickSelector(input, BROWSER_REQUESTS_TAB);
    await waitForReleaseSurfaceInstalledInputElement(input, grantCard);
    await waitForReleaseSurfaceInstalledInputElement(input, depositCard);

    if (action === "browser-secondary") {
      const deny = `${grantCard} [data-debug-id='shellx-browser-vault-prompt-denySessionGrant']`;
      await waitForReleaseSurfaceInstalledInputElement(input, deny);
      outcome.present = "pass";
      await clickSelector(input, deny);
      outcome.invoke = "pass";
      await waitForBrowserGrant(connection, fixture.grantId, "denied");
      const dismiss = `${depositCard} [data-debug-id='shellx-browser-vault-prompt-dismissDeposit']`;
      await clickSelector(input, dismiss);
      await waitForReleaseSurfaceInstalledInputElementAbsent(input, depositCard);
      outcome.effect = "pass";
      outcome.observedEffect = "Native installed input exercised both unambiguous secondary variants: it denied the exact owned Browser session grant and dismissed the exact owned deposit prompt, with backend and rendered-state oracles.";
    } else if (action === "browser-primary") {
      const approve = `${grantCard} [data-debug-id='shellx-browser-vault-prompt-approveSessionGrant']`;
      await waitForReleaseSurfaceInstalledInputElement(input, approve);
      outcome.present = "pass";
      await clickSelector(input, approve);
      outcome.invoke = "pass";
      await waitForBrowserGrant(connection, fixture.grantId, "granted");
      const open = `${depositCard} [data-debug-id='shellx-browser-vault-prompt-openVault']`;
      await clickSelector(input, open);
      await switchReleaseSurfaceInstalledInputWindow(input, fixture.originalWindow);
      await waitForReleaseSurfaceInstalledInputElement(input, VAULT_MODAL);
      await clickSelector(input, VAULT_MODAL_CLOSE);
      await waitForReleaseSurfaceInstalledInputElementAbsent(input, VAULT_MODAL);
      await switchReleaseSurfaceInstalledInputWindowByTitle(input, "ShellX Browser");
      await waitForReleaseSurfaceInstalledInputElementAbsent(input, depositCard);
      outcome.effect = "pass";
      outcome.observedEffect = "Native installed input exercised both unambiguous primary variants: it approved the exact owned Browser session grant and opened then closed Vault from the exact owned deposit prompt.";
    } else {
      const selectors = action === "browser-secondary-marker"
        ? [
            `${grantCard} [data-debug-id='shellx-browser-vault-prompt-denySessionGrant']`,
            `${depositCard} [data-debug-id='shellx-browser-vault-prompt-dismissDeposit']`,
          ]
        : action === "browser-primary-marker"
          ? [
              `${grantCard} [data-debug-id='shellx-browser-vault-prompt-approveSessionGrant']`,
              `${depositCard} [data-debug-id='shellx-browser-vault-prompt-openVault']`,
            ]
          : action === "browser-card"
            ? [BROWSER_CARD, grantCard, depositCard]
            : [BROWSER_STACK, grantCard, depositCard];
      for (const selector of selectors) await waitForReleaseSurfaceInstalledInputElement(input, selector);
      outcome.present = "pass";
      outcome.invoke = "pass";
      outcome.effect = "pass";
      outcome.observedEffect = action.includes("marker")
        ? `Native installed input opened the Requests panel with both owned decision types, and exact ${action.includes("secondary") ? "denySessionGrant plus dismissDeposit" : "approveSessionGrant plus openVault"} dynamic action markers were visibly bound without generic slot inference.`
        : `Native installed input opened the non-empty Browser Vault prompt ${action === "browser-card" ? "cards" : "stack"} with separately identified owned grant and deposit rows.`;
    }
  } catch (error) {
    outcome.error = errorText(error);
  } finally {
    if (fixture) await cleanupBrowserPromptFixture(connection, input, fixture, cleanupErrors);
    finishCleanup(outcome, cleanupErrors);
  }
  return finalize(outcome);
}

async function prepareBrowserPromptFixture(
  connection: Connection,
  input: InstalledInput,
  request: ReleaseSurfaceDriverRequest,
  action: string,
): Promise<BrowserPromptFixture> {
  await prepareIsolatedUnlockedVault(connection);
  const vaultBaseline = await readVaultDirectory(connection);
  const browser = await prepareDebugApiBrowserSettleFixture(connection);
  let vaultRef = "";
  try {
    const grantBody = await apiJson(connection, "POST", "/browser/session-grants/request", {
      taskId: browser.taskId,
      fromProfileId: "personal",
      toProfileId: "task-disposable",
      reason: `Final surface ${action}`,
      ttlSeconds: 300,
    });
    const grantId = requiredString(grantBody.grantId, "owned Browser grant id");
    if (grantBody.status !== "requested") throw new Error("owned Browser grant did not start requested");
    const deposit = await apiJsonNoEcho(connection, "/browser/vault-deposits", {
      taskId: browser.taskId,
      label: `Final surface owned deposit ${request.sourceCommit.slice(0, 12)}`,
      secretValue: SYNTHETIC_DEPOSIT_SECRET,
      sourceUrl: browser.url,
    }, SYNTHETIC_DEPOSIT_SECRET);
    const depositId = requiredString(deposit.depositId, "owned Browser deposit id");
    vaultRef = requiredString(deposit.vaultRef, "owned Browser deposit Vault reference");
    if (deposit.secretExposed !== false || !vaultRef.startsWith("browser-deposits/")) {
      throw new Error("owned Browser deposit omitted its write-only Vault contract");
    }
    const switched = await switchReleaseSurfaceInstalledInputWindowByTitle(input, "ShellX Browser");
    return { browser, grantId, depositId, vaultRef, vaultBaseline, originalWindow: switched.originalHandle };
  } catch (error) {
    const errors: string[] = [];
    if (vaultRef) await cleanupAttempt(errors, async () => deleteVaultKey(connection, vaultRef));
    const browserError = await cleanupDebugApiBrowserSettleFixture(connection, browser);
    if (browserError) errors.push(browserError);
    await cleanupAttempt(errors, async () => resetIsolatedVault(connection));
    throw new Error(`${errorText(error)}${errors.length ? `; setup cleanup: ${errors.join(" | ")}` : ""}`);
  }
}

async function cleanupBrowserPromptFixture(
  connection: Connection,
  input: InstalledInput,
  fixture: BrowserPromptFixture,
  errors: string[],
): Promise<void> {
  await cleanupAttempt(errors, async () => deleteVaultKey(connection, fixture.vaultRef));
  await cleanupAttempt(errors, async () => {
    const browserError = await cleanupDebugApiBrowserSettleFixture(connection, fixture.browser);
    if (browserError) throw new Error(browserError);
  });
  await cleanupAttempt(errors, async () => {
    await switchReleaseSurfaceInstalledInputWindowByTitle(input, "ShellX Browser");
    await closeReleaseSurfaceInstalledInputWindow(input);
    await switchReleaseSurfaceInstalledInputWindow(input, fixture.originalWindow);
  });
  await cleanupAttempt(errors, async () => {
    const restored = await readVaultDirectory(connection);
    if (JSON.stringify(restored) !== JSON.stringify(fixture.vaultBaseline)) {
      throw new Error("Browser prompt cleanup did not restore the redacted Vault directory exactly");
    }
  });
  await cleanupAttempt(errors, async () => resetIsolatedVault(connection));
}

type OwnedPage = { url: string; server: Server; sockets: Set<Socket> };

async function exerciseUnavailableFill(
  connection: Connection,
  input: InstalledInput,
  assignment: Assignment,
  action: "fill-panel" | "fill-unavailable",
): Promise<ReleaseSurfaceDriverOutcome> {
  const outcome = emptyOutcome(assignment);
  const cleanupErrors: string[] = [];
  let browser: DebugApiBrowserSettleFixture | null = null;
  let page: OwnedPage | null = null;
  let personalTabId: string | null = null;
  let originalWindow: string | null = null;
  try {
    await resetIsolatedVault(connection);
    const status = await apiJson(connection, "GET", "/vault/status");
    if (status.unlocked === true) throw new Error("isolated Vault reset did not reproduce locked/unavailable state");
    page = await startOwnedLoginPage();
    browser = await prepareDebugApiBrowserSettleFixture(connection);
    const opened = await apiJson(connection, "POST", "/browser/tabs/open", {
      profileId: "personal",
      url: page.url,
      expectedDomains: ["127.0.0.1"],
    });
    personalTabId = requiredString(opened.browserTabId, "owned personal Browser tab id");
    await apiJson(connection, "POST", "/browser/tabs/focus", { browserTabId: personalTabId });
    const switched = await switchReleaseSurfaceInstalledInputWindowByTitle(input, "ShellX Browser");
    originalWindow = switched.originalHandle;
    await waitForReleaseSurfaceInstalledInputElement(input, FILL_PANEL, { timeoutMs: 15_000, pollMs: 100 });
    await waitForReleaseSurfaceInstalledInputElement(input, FILL_UNAVAILABLE);
    outcome.present = "pass";
    await clickSelector(input, FILL_MENU);
    await waitForReleaseSurfaceInstalledInputElementAbsent(input, FILL_PANEL);
    await clickSelector(input, FILL_MENU);
    outcome.invoke = "pass";
    await waitForReleaseSurfaceInstalledInputElement(input, FILL_PANEL);
    await waitForReleaseSurfaceInstalledInputElement(input, action === "fill-panel" ? FILL_PANEL : FILL_UNAVAILABLE);
    outcome.effect = "pass";
    outcome.observedEffect = "A local HTTP password form plus deliberately locked isolated Vault produced the unavailable fill state; native installed input closed and reopened the panel, and no suggestion, credential read, fill, or trusted-HTTPS boundary was invoked.";
  } catch (error) {
    outcome.error = errorText(error);
  } finally {
    if (personalTabId || browser) {
      await cleanupAttempt(cleanupErrors, async () => {
        const result = await cleanupOwnedBrowserLifecycle(
          (method, path, body) => apiJson(connection, method, path, body),
          {
            taskIds: browser ? [browser.taskId] : [],
            tabIds: personalTabId ? [personalTabId] : [],
            label: "final surface unavailable Browser Vault fill",
          },
        );
        if (result.errors.length) throw new Error(result.errors.join("; "));
      });
    }
    if (browser) await cleanupAttempt(cleanupErrors, async () => {
      await closeOwnedPage(browser!.server, browser!.sockets);
    });
    if (originalWindow) await cleanupAttempt(cleanupErrors, async () => {
      await switchReleaseSurfaceInstalledInputWindowByTitle(input, "ShellX Browser");
      await closeReleaseSurfaceInstalledInputWindow(input);
      await switchReleaseSurfaceInstalledInputWindow(input, originalWindow!);
    });
    if (page) await cleanupAttempt(cleanupErrors, async () => closeOwnedPage(page!.server, page!.sockets));
    await cleanupAttempt(cleanupErrors, async () => resetIsolatedVault(connection));
    finishCleanup(outcome, cleanupErrors);
  }
  return finalize(outcome);
}

async function startOwnedLoginPage(): Promise<OwnedPage> {
  const sockets = new Set<Socket>();
  const server = createServer((request, response) => {
    if (request.method !== "GET" || new URL(request.url ?? "/", "http://127.0.0.1").pathname !== "/login") {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    response.end("<!doctype html><title>Owned Vault unavailable form</title><form><label>Username <input autocomplete='username'></label><label>Password <input type='password' autocomplete='current-password'></label></form>");
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("owned Vault fill page did not bind");
  return { url: `http://127.0.0.1:${address.port}/login`, server, sockets };
}

async function closeOwnedPage(server: Server, sockets: Set<Socket>): Promise<void> {
  for (const socket of sockets) socket.destroy();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function openHeader(input: InstalledInput): Promise<void> {
  if (await findReleaseSurfaceInstalledInputElement(input, HEADER_POPOVER)) return;
  await clickSelector(input, HEADER_TOGGLE);
  await waitForReleaseSurfaceInstalledInputElement(input, HEADER_POPOVER);
}

async function closeHeader(input: InstalledInput): Promise<void> {
  if (!await findReleaseSurfaceInstalledInputElement(input, HEADER_POPOVER)) return;
  await clickSelector(input, HEADER_TOGGLE);
  await waitForReleaseSurfaceInstalledInputElementAbsent(input, HEADER_POPOVER);
}

async function clickSelector(input: InstalledInput, selector: string): Promise<void> {
  const element = await waitForReleaseSurfaceInstalledInputElement(input, selector, { timeoutMs: 10_000, pollMs: 75 });
  await clickReleaseSurfaceInstalledInputElement(input, element);
}

async function resetIsolatedVault(connection: Connection): Promise<void> {
  const response = await apiJson(connection, "POST", "/vault/e2e/reset", {});
  if (response.ok !== true) throw new Error("isolated Vault reset did not confirm success");
  const grants = await readVaultGrants(connection);
  if (grants.length !== 0) throw new Error("isolated Vault reset left grant metadata");
}

async function prepareIsolatedUnlockedVault(connection: Connection): Promise<void> {
  await resetIsolatedVault(connection);
  const begun = await apiJsonNoEcho(connection, "/vault/setup/begin", {
    target: "local",
    passphrase: SYNTHETIC_VAULT_PASSPHRASE,
    rememberDevice: false,
  }, SYNTHETIC_VAULT_PASSPHRASE);
  const kit = record(begun.recoveryKit, "isolated Vault recovery kit");
  const confirmationId = requiredString(kit.confirmationId, "isolated Vault recovery confirmation id");
  if (!Array.isArray(kit.words) || kit.words.length !== 16) throw new Error("isolated Vault setup omitted its bounded recovery challenge");
  await apiJson(connection, "POST", "/vault/setup/confirm-recovery", { confirmationId, importLegacy: false });
  const status = await apiJson(connection, "GET", "/vault/status");
  if (status.mode !== "local" || status.unlocked !== true || status.recoveryConfirmed !== true) {
    throw new Error("isolated Vault setup did not reach configured unlocked state");
  }
}

async function readVaultGrants(connection: Connection): Promise<VaultGrant[]> {
  const response = await apiJson(connection, "GET", "/vault/grants");
  if (!Array.isArray(response.grants)) throw new Error("Vault grants response omitted its array");
  return response.grants.map((value, index) => validateGrant(value, `Vault grant ${index}`));
}

function validateCreatedGrant(value: Record<string, unknown>, secretRef: string): VaultGrant {
  if (value.ok !== true) throw new Error("Vault grant create did not confirm success");
  const grant = validateGrant(value.grant, "created Vault grant");
  if (grant.secretRef !== secretRef || grant.operation !== "Fill" || grant.origin !== "https://example.com"
    || grant.approved || grant.revoked) throw new Error("created Vault grant was not the exact pending fixture");
  return grant;
}

function validateGrant(value: unknown, label: string): VaultGrant {
  const row = record(value, label);
  const grantId = requiredString(row.grantId, `${label} id`);
  const secretRef = requiredString(row.secretRef, `${label} secretRef`);
  const operation = requiredString(row.operation, `${label} operation`);
  const origin = requiredString(row.origin, `${label} origin`);
  if (typeof row.approved !== "boolean" || typeof row.revoked !== "boolean") throw new Error(`${label} omitted decision state`);
  return { grantId, secretRef, operation, origin, approved: row.approved, revoked: row.revoked };
}

async function waitForGrant(connection: Connection, grantId: string, predicate: (grant: VaultGrant) => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const grant = (await readVaultGrants(connection)).find((candidate) => candidate.grantId === grantId);
    if (grant && predicate(grant)) return;
    await delay(100);
  }
  throw new Error("Vault grant did not reach its exact decision state");
}

async function waitForBrowserGrant(connection: Connection, grantId: string, status: "granted" | "denied"): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const state = await apiJson(connection, "GET", "/browser/state");
    const rows = Array.isArray(state.sessionGrants) ? state.sessionGrants : [];
    const grant = rows.map((value) => record(value, "Browser grant")).find((value) => value.grantId === grantId);
    if (grant?.status === status) return;
    await delay(100);
  }
  throw new Error(`Browser grant did not reach ${status}`);
}

async function readVaultDirectory(connection: Connection): Promise<VaultDirectory> {
  const response = await apiJson(connection, "GET", "/vault/keys");
  const text = JSON.stringify(response);
  if (text.includes(SYNTHETIC_DEPOSIT_SECRET) || /"(?:secret|value)"\s*:/.test(text)) {
    throw new Error("redacted Vault directory exposed secret material");
  }
  if (!Array.isArray(response.keys) || !Array.isArray(response.entries)) throw new Error("Vault directory omitted keys or entries");
  const keys = response.keys.map((value) => requiredString(value, "Vault directory key"));
  const entries = response.entries.map((value) => {
    const entry = record(value, "Vault directory entry");
    return { ...entry, key: requiredString(entry.key, "Vault directory entry key") };
  });
  return { keys, entries };
}

async function deleteVaultKey(connection: Connection, key: string): Promise<void> {
  const directory = await readVaultDirectory(connection);
  if (!directory.keys.includes(key) && !directory.entries.some((entry) => entry.key === key)) return;
  const deleted = await apiJson(connection, "POST", "/vault/delete", { key });
  if (deleted.ok !== true || deleted.key !== key) throw new Error("exact owned Vault delete returned the wrong envelope");
}

function exactUiBaseline(value: Record<string, unknown>, label: string): { tabs: UiTab[]; activeTabId: string } {
  const tabs = safeTabs(value);
  if (!Array.isArray(value.openTabs) || tabs.length !== value.openTabs.length || tabs.length === 0) throw new Error(`${label} omitted exact tabs`);
  const activeTabId = requiredString(value.activeTabId, `${label} active tab`);
  if (!tabs.some((tab) => tab.tabId === activeTabId)) throw new Error(`${label} active tab was outside its tab list`);
  return { tabs, activeTabId };
}

function safeTabs(value: Record<string, unknown>): UiTab[] {
  if (!Array.isArray(value.openTabs)) return [];
  return value.openTabs.flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return [];
    const row = candidate as Record<string, unknown>;
    return typeof row.tabId === "string" && row.tabId ? [row as UiTab] : [];
  });
}

async function waitForUi(connection: Connection, predicate: (state: UiState) => boolean, label: string): Promise<UiState> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const state = await apiJson(connection, "GET", "/state/ui");
    if (predicate(state)) return state;
    await delay(100);
  }
  throw new Error(`${label} did not settle`);
}

async function apiJsonNoEcho(
  connection: Connection,
  path: string,
  body: Record<string, unknown>,
  forbidden: string,
): Promise<Record<string, unknown>> {
  const response = await fetch(`${connection.base}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${connection.token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`POST ${path} failed ${response.status}: ${text.slice(0, 1_200)}`);
  if (text.includes(forbidden)) throw new Error(`POST ${path} echoed secret material`);
  return record(text.trim() ? JSON.parse(text) : {}, `POST ${path}`);
}

async function apiJson(
  connection: Connection,
  method: "GET" | "POST",
  path: string,
  body?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await fetch(`${connection.base}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${connection.token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10_000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path} failed ${response.status}: ${text.slice(0, 1_200)}`);
  return record(text.trim() ? JSON.parse(text) : {}, `${method} ${path}`);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} did not return an object`);
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a nonempty string`);
  return value;
}

function cssString(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("'", "\\'");
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
    observedEffect: "No action-specific installed Vault request or Browser prompt lifecycle was observed.",
  };
}

function finishCleanup(outcome: ReleaseSurfaceDriverOutcome, errors: string[]): void {
  if (errors.length === 0) outcome.cleanup = "pass";
  else outcome.error = appendError(outcome.error, `cleanup: ${errors.join(" | ")}`);
}

function finalize(outcome: ReleaseSurfaceDriverOutcome, error?: string): ReleaseSurfaceDriverOutcome {
  if (error) outcome.error = error;
  if ([outcome.present, outcome.invoke, outcome.effect, outcome.cleanup].includes("fail") && !outcome.error) {
    outcome.error = "Vault request/prompt lifecycle did not satisfy every required verdict";
  }
  return outcome;
}

async function cleanupAttempt(errors: string[], action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (error) {
    errors.push(errorText(error));
  }
}

function appendError(current: string | undefined, next: string): string {
  return current ? `${current}; ${next}` : next;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
