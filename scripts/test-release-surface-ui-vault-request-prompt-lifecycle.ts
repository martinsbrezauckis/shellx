import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  releaseSurfaceDriverRequiresNativeWebDriver,
  releaseSurfaceDriverSupportsMacosNativeInput,
} from "./lib/release-surface-webdriver-binding";
import { createReleaseSurfaceInstalledInputSession } from "./lib/release-surface-installed-input-client";
import type { ReleaseSurfaceItem } from "./lib/release-surface-inventory";
import type { ReleaseSurfaceDriverRequest } from "./lib/release-surface-driver-protocol";
import {
  VAULT_REQUEST_PROMPT_CLEANUPS,
  VAULT_REQUEST_PROMPT_CONTROL_SURFACE_IDS,
  VAULT_REQUEST_PROMPT_DEBUG_SURFACE_IDS,
  VAULT_REQUEST_PROMPT_FIXTURES,
  VAULT_REQUEST_PROMPT_ORACLES,
  VAULT_REQUEST_PROMPT_SURFACE_IDS,
  exerciseVaultRequestPromptSurface,
  supportsVaultRequestPromptSurface,
} from "./release-drivers/ui-vault-request-prompt-lifecycle";

const root = resolve(import.meta.dirname, "..");
const inventory = JSON.parse(readFileSync(resolve(root, "release/surface-inventory.json"), "utf8")) as {
  items: ReleaseSurfaceItem[];
};
const plan = JSON.parse(readFileSync(resolve(root, "release/surface-driver-plan.json"), "utf8")) as {
  drivers: Array<{ id: string; kind: string; entrypoint: string; platforms: Record<string, string> }>;
  assignments: Array<{
    surfaceId: string;
    driverId: string;
    fixtureId: string;
    expectedEffect: string;
    oracleId: string;
    cleanupId: string;
  }>;
};
const surfaces = new Map(inventory.items.map((surface) => [surface.id, surface]));
const assignments = new Map(plan.assignments.map((assignment) => [assignment.surfaceId, assignment]));
const controlDriverId = "ui-control-vault-request-prompt-installed";
const debugDriverId = "ui-debug-surface-vault-request-prompt-installed";

assert.equal(VAULT_REQUEST_PROMPT_SURFACE_IDS.size, 11);
assert.equal(VAULT_REQUEST_PROMPT_CONTROL_SURFACE_IDS.size, 5);
assert.equal(VAULT_REQUEST_PROMPT_DEBUG_SURFACE_IDS.size, 6);
assert.equal(plan.assignments.length, inventory.items.length);
assert.equal(new Set(plan.assignments.map((assignment) => assignment.surfaceId)).size, inventory.items.length);

for (const [driverId, kind, entrypoint] of [
  [controlDriverId, "ui-control", "scripts/release-drivers/ui-control-vault-request-prompt-installed.ts"],
  [debugDriverId, "ui-debug-surface", "scripts/release-drivers/ui-debug-surface-vault-request-prompt-installed.ts"],
] as const) {
  const driver = plan.drivers.find((candidate) => candidate.id === driverId);
  assert(driver, `missing ${driverId}`);
  assert.equal(driver.kind, kind);
  assert.equal(driver.entrypoint, entrypoint);
  assert.deepEqual(driver.platforms, {
    "windows-installed": "ready",
    "macos-installed": "ready",
    "linux-installed": "ready",
  });
  assert.equal(releaseSurfaceDriverRequiresNativeWebDriver(driverId, kind), true);
  assert.equal(releaseSurfaceDriverSupportsMacosNativeInput(driverId, kind), true);
  const described = spawnSync(process.execPath, ["--import", "tsx", resolve(root, entrypoint), "--describe"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(described.status, 0, described.stderr || described.stdout);
  const manifest = JSON.parse(described.stdout) as {
    id: string;
    kind: string;
    invocationTransport: string;
    controllerFiles: string[];
    supportedFixtures: string[];
    supportedCleanups: string[];
    supportedOracles: string[];
  };
  assert.equal(manifest.id, driverId);
  assert.equal(manifest.kind, kind);
  assert.equal(manifest.invocationTransport, "native-installed-input");
  assert(manifest.controllerFiles.includes("scripts/release-drivers/ui-vault-request-prompt-lifecycle.ts"));
  assert.deepEqual(manifest.supportedFixtures, [...VAULT_REQUEST_PROMPT_FIXTURES]);
  assert.deepEqual(manifest.supportedCleanups, [...VAULT_REQUEST_PROMPT_CLEANUPS]);
  assert.deepEqual(manifest.supportedOracles, [...VAULT_REQUEST_PROMPT_ORACLES]);
}

for (const surfaceId of VAULT_REQUEST_PROMPT_SURFACE_IDS) {
  const surface = surfaces.get(surfaceId);
  const assignment = assignments.get(surfaceId);
  assert(surface, `inventory is missing ${surfaceId}`);
  assert(assignment, `plan is missing ${surfaceId}`);
  assert.equal(
    assignment.driverId,
    surface.kind === "ui-control" ? controlDriverId : debugDriverId,
    `wrong action-specific driver for ${surfaceId}`,
  );
  assert(!assignment.expectedEffect.startsWith("BUILDING:"));
  assert(VAULT_REQUEST_PROMPT_FIXTURES.includes(assignment.fixtureId as typeof VAULT_REQUEST_PROMPT_FIXTURES[number]));
  assert(VAULT_REQUEST_PROMPT_CLEANUPS.includes(assignment.cleanupId as typeof VAULT_REQUEST_PROMPT_CLEANUPS[number]));
  assert(VAULT_REQUEST_PROMPT_ORACLES.includes(assignment.oracleId as typeof VAULT_REQUEST_PROMPT_ORACLES[number]));
  const requestAssignment = {
    surface,
    fixtureId: assignment.fixtureId,
    expectedEffect: assignment.expectedEffect,
    oracleId: assignment.oracleId,
    cleanupId: assignment.cleanupId,
  } as ReleaseSurfaceDriverRequest["assignments"][number];
  assert.equal(supportsVaultRequestPromptSurface(requestAssignment), true);
}

const actualFillIds = [
  'ui-control:src/browser/components/BrowserVaultFillPanel.tsx:[data-debug-id="shellx-browser-vault-fill-suggestion"]@src/browser/components/BrowserVaultFillPanel.tsx#1',
  "ui-debug-surface:shellx-browser-vault-fill-suggestion@src/browser/components/BrowserVaultFillPanel.tsx#3",
];
for (const surfaceId of actualFillIds) {
  const assignment = assignments.get(surfaceId);
  assert(assignment, `missing trusted fill assignment ${surfaceId}`);
  assert.equal(
    assignment.driverId,
    surfaceId.startsWith("ui-control:")
      ? "ui-control-trusted-vault-fill-installed"
      : "ui-debug-surface-trusted-vault-fill-installed",
  );
  assert(!assignment.expectedEffect.startsWith("BUILDING:"));
  assert.match(assignment.expectedEffect, /trusted HTTPS|trusted-origin/i);
  assert.equal(VAULT_REQUEST_PROMPT_SURFACE_IDS.has(surfaceId), false);
}

const fakeSurface = {
  ...(inventory.items.find((surface) => surface.kind === "ui-control") as ReleaseSurfaceItem),
  id: "ui-control:unsupported-vault-request-surface",
};
assert.equal(supportsVaultRequestPromptSurface({
  surface: fakeSurface,
  fixtureId: VAULT_REQUEST_PROMPT_FIXTURES[0],
  expectedEffect: "must fail closed",
  oracleId: VAULT_REQUEST_PROMPT_ORACLES[0],
  cleanupId: VAULT_REQUEST_PROMPT_CLEANUPS[0],
}), false);

const source = readFileSync(resolve(root, "scripts/release-drivers/ui-vault-request-prompt-lifecycle.ts"), "utf8");
assert(!source.includes("debugClick"), "action-specific driver must not actuate controls through Debug API relay");
assert(!source.includes("shellx_browser_fill_user_vault_secret"), "unavailable-fill proof must not invoke credential fill");
assert(!source.includes("vault_get"), "request/prompt proof must not read Vault values");
assert(source.includes("SYNTHETIC_DEPOSIT_SECRET"));
assert(source.includes("text.includes(forbidden)"), "deposit route must reject secret echo");
assert(source.includes("cleanupOwnedBrowserLifecycle"));
assert(source.includes("/vault/e2e/reset"));

type MockGrant = { grantId: string; secretRef: string; approved: boolean; revoked: boolean };
type MockBrowserGrant = { grantId: string; taskId: string; status: string };
type MockDeposit = { depositId: string; taskId: string; vaultRef: string };

class VaultRequestPromptRuntimeFixture {
  readonly candidateBase = "http://127.0.0.1:41035";
  readonly webdriverBase = "http://127.0.0.1:41036";
  readonly token = "fixture-vault-request-prompt-token-0001";
  readonly depositSecret = "SHELLX_RELEASE_VAULT_PROMPT_DEPOSIT_VALUE_035";
  private vaultConfigured = false;
  private grants: MockGrant[] = [];
  private vaultKeys = new Set<string>();
  private tasks: Array<{ taskId: string; status: string; currentUrl: string }> = [];
  private browserTabs: Array<{ browserTabId: string; taskId: string | null }> = [];
  private browserGrants: MockBrowserGrant[] = [];
  private deposits: MockDeposit[] = [];
  private dismissedDeposits = new Set<string>();
  private tabs: Array<Record<string, unknown> & { tabId: string }> = [{ tabId: "fixture-main-tab", title: "Fixture main" }];
  private activeTabId = "fixture-main-tab";
  private rendererRequest = false;
  private requestSourceTabId = "fixture-main-tab";
  private headerOpen = false;
  private vaultModal = false;
  private browserWindow = false;
  private browserRequestsOpen = false;
  private fillPanelOpen = false;
  private fillUnavailable = false;
  private currentWindow: "main" | "browser" = "main";
  private nextId = 1;
  private elements = new Map<string, string>();

  readonly fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input.toString() : input.url);
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    if (url.origin === this.candidateBase) return this.candidate(method, url.pathname, body);
    if (url.origin === this.webdriverBase) return this.webdriver(method, url.pathname, body);
    throw new Error(`fixture fetch refused unexpected origin ${url.origin}`);
  };

  request(assignments: ReleaseSurfaceDriverRequest["assignments"]): ReleaseSurfaceDriverRequest {
    return {
      schema: "shellx/release-surface-driver-request@7",
      mode: "final-frozen-candidate",
      driverId: "fixture-vault-request-prompt",
      driverKind: "ui-control",
      platform: "linux-installed",
      sourceCommit: "a".repeat(40),
      version: "0.3.5",
      inventoryDigest: "b".repeat(64),
      artifact: { basename: "shellx", sha256: "c".repeat(64) },
      controller: {} as ReleaseSurfaceDriverRequest["controller"],
      runtime: {
        processId: 4321,
        instanceId: "fixture-vault-request-prompt-instance",
        debugBase: this.candidateBase,
        debugTokenPath: "/tmp/fixture/.shellx/shellxagent.token",
        mcpBase: "http://127.0.0.1:9",
        mcpTokenPath: "/tmp/fixture/.shellx/shellxagent.token",
        executableSha256: "d".repeat(64),
        installedPayloadPath: "/tmp/fixture/shellx",
        installedManifestSha256: "e".repeat(64),
      },
      nativeWebDriver: {
        base: this.webdriverBase,
        sessionId: "fixture-vault-prompt-session-0001",
        evidence: { basename: "native-binding.json", sha256: "f".repeat(64), bytes: 512 },
      },
      assignments,
    };
  }

  assertClean(): void {
    assert.equal(this.vaultConfigured, false);
    assert.deepEqual(this.grants, []);
    assert.deepEqual([...this.vaultKeys], []);
    assert(this.tasks.every((task) => task.status === "aborted"));
    assert.deepEqual(this.browserTabs, []);
    assert.deepEqual(this.tabs, [{ tabId: "fixture-main-tab", title: "Fixture main" }]);
    assert.equal(this.activeTabId, "fixture-main-tab");
    assert.equal(this.rendererRequest, false);
    assert.equal(this.headerOpen, false);
    assert.equal(this.vaultModal, false);
    assert.equal(this.browserWindow, false);
    assert.equal(this.currentWindow, "main");
  }

  private candidate(method: string, path: string, body: Record<string, unknown>): Response {
    if (method === "GET" && path === "/state/ui") return json({ activeTabId: this.activeTabId, openTabs: this.tabs });
    if (method === "POST" && path === "/state/ui") {
      if (body.debugRendererFixture === "clear") this.rendererRequest = false;
      else if (body.debugRendererFixture && typeof body.debugRendererFixture === "object") {
        this.rendererRequest = true;
        this.requestSourceTabId = this.activeTabId;
      }
      return json({ ok: true });
    }
    if (method === "POST" && path === "/vault/e2e/reset") {
      this.vaultConfigured = false;
      this.grants = [];
      this.vaultKeys.clear();
      return json({ ok: true, receipt: { action: "vaultE2eReset", secretExposed: false } });
    }
    if (method === "GET" && path === "/vault/status") {
      return json({ mode: this.vaultConfigured ? "local" : "unconfigured", unlocked: this.vaultConfigured, recoveryConfirmed: this.vaultConfigured });
    }
    if (method === "POST" && path === "/vault/setup/begin") {
      return json({ ok: true, recoveryKit: { confirmationId: "1".repeat(32), words: Array.from({ length: 16 }, (_, index) => `owned-word-${index}`) } });
    }
    if (method === "POST" && path === "/vault/setup/confirm-recovery") {
      this.vaultConfigured = true;
      return json({ ok: true });
    }
    if (method === "GET" && path === "/vault/grants") return json({ grants: this.grants.map((grant) => ({ ...grant, actorScope: "allShellxAgents", operation: "Fill" })) });
    if (method === "POST" && path === "/vault/grants") {
      if (body.operation !== "fill" || body.origin !== "https://example.com") {
        return json({ error: "browser-sensitive Vault grant requires exact fixture origin" }, 400);
      }
      const grant = {
        grantId: `fixture-vault-grant-${this.nextId++}`,
        secretRef: String(body.secretRef),
        origin: String(body.origin),
        approved: false,
        revoked: false,
      };
      this.grants.push(grant);
      return json({ ok: true, grant: { ...grant, actorScope: "allShellxAgents", operation: "Fill" } });
    }
    if (method === "GET" && path === "/vault/keys") {
      const keys = [...this.vaultKeys];
      return json({ keys, entries: keys.map((key) => ({ key, description: "Owned Browser deposit", userOnly: true })) });
    }
    if (method === "POST" && path === "/vault/delete") {
      this.vaultKeys.delete(String(body.key));
      return json({ ok: true, key: body.key });
    }
    if (method === "POST" && path === "/browser/task/start") {
      const taskId = `fixture-task-${this.nextId++}`;
      const browserTabId = `fixture-task-tab-${this.nextId++}`;
      this.tasks.push({ taskId, status: "running", currentUrl: String(body.startUrl ?? "about:blank") });
      this.browserTabs.push({ browserTabId, taskId });
      this.browserWindow = true;
      return json({ taskId, browserTabId });
    }
    if (method === "POST" && path === "/browser/session-grants/request") {
      const grant = { grantId: `fixture-browser-grant-${this.nextId++}`, taskId: String(body.taskId), status: "requested" };
      this.browserGrants.push(grant);
      return json({ ...grant, fromProfileId: body.fromProfileId, toProfileId: body.toProfileId, reason: body.reason, ttlSeconds: body.ttlSeconds });
    }
    if (method === "POST" && path === "/browser/vault-deposits") {
      if (!this.vaultConfigured) return json({ error: "Vault unavailable" }, 409);
      const depositId = `fixture-deposit-${this.nextId++}`;
      const vaultRef = `browser-deposits/${depositId}`;
      this.deposits.push({ depositId, taskId: String(body.taskId), vaultRef });
      this.vaultKeys.add(vaultRef);
      return json({ depositId, vaultRef, secretExposed: false, taskId: body.taskId });
    }
    if (method === "GET" && path === "/browser/state") {
      return json({
        windowOpen: this.browserWindow,
        engine: { engineId: "fixture-vault-prompt-engine", mounted: this.browserWindow },
        enginePool: {
          engines: [{ engineId: "fixture-vault-prompt-engine", mounted: this.browserWindow }],
        },
        tasks: this.tasks,
        tabs: this.browserTabs,
        activeTaskId: this.tasks.find((task) => task.status === "running")?.taskId ?? null,
        sessionGrants: this.browserGrants,
      });
    }
    if (method === "GET" && path === "/browser/settle") {
      const task = this.tasks.find((candidate) => candidate.status === "running");
      const tab = this.browserTabs.find((candidate) => candidate.taskId === task?.taskId);
      if (!task || !tab) return json({ error: "owned Browser settle fixture is absent" }, 404);
      return json({
        settled: true,
        taskId: task.taskId,
        browserTabId: tab.browserTabId,
        taskStatus: task.status,
        tabStatus: "loaded",
        engineId: "fixture-vault-prompt-engine",
        engineLoadStatus: "loaded",
        engineUrl: task.currentUrl,
        pendingUrl: null,
        revision: `engine-${this.nextId}`,
      });
    }
    if (method === "POST" && path === "/browser/task/finish") {
      const taskId = String(body.taskId);
      const task = this.tasks.find((candidate) => candidate.taskId === taskId);
      if (task) task.status = "aborted";
      for (const grant of this.browserGrants) if (grant.taskId === taskId && grant.status === "requested") grant.status = "cancelled";
      return json({ ok: true });
    }
    if (method === "POST" && path === "/browser/tabs/close") {
      this.browserTabs = this.browserTabs.filter((tab) => tab.browserTabId !== body.browserTabId);
      return json({ ok: true });
    }
    if (method === "POST" && path === "/browser/tabs/open") {
      const browserTabId = `fixture-personal-tab-${this.nextId++}`;
      this.browserTabs.push({ browserTabId, taskId: null });
      this.fillUnavailable = !this.vaultConfigured;
      this.fillPanelOpen = this.fillUnavailable;
      return json({ browserTabId, profileId: "personal", ownerKind: "user" });
    }
    if (method === "POST" && path === "/browser/tabs/focus") return json({ ok: true });
    return json({ error: `unsupported candidate route ${method} ${path}` }, 404);
  }

  private webdriver(method: string, path: string, body: Record<string, unknown>): Response {
    const prefix = "/session/fixture-vault-prompt-session-0001";
    if (!path.startsWith(prefix)) return webdriverError("invalid session id", 404);
    const route = path.slice(prefix.length) || "/";
    if (method === "GET" && route === "/window") return webdriverValue(this.currentWindow);
    if (method === "GET" && route === "/window/handles") return webdriverValue(this.browserWindow ? ["main", "browser"] : ["main"]);
    if (method === "POST" && route === "/window") {
      const handle = String(body.handle);
      if (handle !== "main" && (handle !== "browser" || !this.browserWindow)) return webdriverError("no such window", 404);
      this.currentWindow = handle as "main" | "browser";
      return webdriverValue(null);
    }
    if (method === "GET" && route === "/title") return webdriverValue(this.currentWindow === "main" ? "shellX" : "ShellX Browser");
    if (method === "POST" && route === "/execute/sync") {
      const script = String(body.script ?? "");
      if (this.currentWindow !== "browser" || !script.includes('internals.invoke("plugin:window|close"')) {
        return webdriverError("fixture refuses unbounded script execution", 400);
      }
      this.browserWindow = false;
      this.currentWindow = "main";
      this.browserRequestsOpen = false;
      this.fillPanelOpen = false;
      return webdriverValue(true);
    }
    if (method === "DELETE" && route === "/window") {
      if (this.currentWindow !== "browser") return webdriverError("fixture refuses main close", 400);
      this.browserWindow = false;
      this.currentWindow = "main";
      this.browserRequestsOpen = false;
      this.fillPanelOpen = false;
      return webdriverValue(["main"]);
    }
    if (method === "POST" && route === "/element") {
      const selector = String(body.value ?? "");
      if (!this.displayed(selector)) return webdriverError(`fixture does not expose ${selector}`, 404);
      const id = `fixture-element-${this.nextId++}`;
      this.elements.set(id, selector);
      return webdriverValue({ "element-6066-11e4-a52e-4f735466cecf": id });
    }
    const displayed = route.match(/^\/element\/([^/]+)\/displayed$/);
    if (method === "GET" && displayed) return webdriverValue(this.displayed(this.elements.get(displayed[1]!) ?? ""));
    const clicked = route.match(/^\/element\/([^/]+)\/click$/);
    if (method === "POST" && clicked) {
      const selector = this.elements.get(clicked[1]!) ?? "";
      if (!this.displayed(selector)) return webdriverError("stale element", 404);
      this.click(selector);
      return webdriverValue(null);
    }
    return webdriverError(`unsupported WebDriver route ${method} ${route}`, 404);
  }

  private displayed(selector: string): boolean {
    if (this.currentWindow === "main") {
      if (selector === "[data-debug-id='header-vault-request-center']" || selector === "[title='New session (⌘T)']") return true;
      if (selector === "[data-debug-id='vault-request-center-popover']") return this.headerOpen;
      if (selector === "[data-debug-id='vault-workspace-modal']" || selector === "[data-debug-id='vault-workspace-modal'] [aria-label='Close']") return this.vaultModal;
      const tabId = selector.match(/^\[data-tab-id='([^']+)'\](?: \[aria-label='Close session'\])?$/)?.[1];
      if (tabId) return this.tabs.some((tab) => tab.tabId === tabId);
      if (selector.includes("session-permission:release-fixture-permission") && selector.includes("vault-request-action-focusSession")) {
        return this.headerOpen && this.rendererRequest;
      }
      const grant = selector.match(/data-request-id='vault-grant:([^']+)'/)?.[1];
      const decision = selector.match(/data-debug-id='vault-request-action-(approveVaultGrant|denyVaultGrant)'/)?.[1];
      return Boolean(this.headerOpen && grant && decision && this.grants.some((candidate) => candidate.grantId === grant && !candidate.approved && !candidate.revoked));
    }
    if (selector === "[data-debug-id='shellx-browser-right-tab-requests']") return this.browserWindow;
    if (selector === "[data-debug-id='shellx-browser-vault-prompt-stack']") return this.browserRequestsOpen;
    if (selector === "[data-debug-id='shellx-browser-vault-prompt-card']") return this.browserRequestsOpen && this.hasBrowserPrompt();
    if (selector === "[data-debug-id='shellx-browser-vault-fill-menu']") return this.fillUnavailable;
    if (selector === "[data-debug-id='shellx-browser-vault-fill-panel']") return this.fillPanelOpen;
    if (selector === "[data-debug-id='shellx-browser-vault-fill-unavailable']") return this.fillPanelOpen && this.fillUnavailable;
    const browserGrant = selector.match(/data-prompt-id='session-grant-([^']+)'/)?.[1];
    if (browserGrant) {
      const row = this.browserGrants.find((candidate) => candidate.grantId === browserGrant);
      return Boolean(this.browserRequestsOpen && row?.status === "requested");
    }
    const deposit = selector.match(/data-prompt-id='vault-deposit-([^']+)'/)?.[1];
    return Boolean(this.browserRequestsOpen && deposit && this.deposits.some((candidate) => candidate.depositId === deposit) && !this.dismissedDeposits.has(deposit));
  }

  private click(selector: string): void {
    if (this.currentWindow === "main") {
      if (selector === "[data-debug-id='header-vault-request-center']") this.headerOpen = !this.headerOpen;
      else if (selector === "[title='New session (⌘T)']") {
        const tabId = `fixture-owned-tab-${this.nextId++}`;
        this.tabs.push({ tabId, title: "Owned tab" });
        this.activeTabId = tabId;
      } else if (selector.includes("vault-request-action-focusSession")) {
        this.activeTabId = this.requestSourceTabId;
        this.headerOpen = false;
      } else if (selector.includes("[aria-label='Close session']")) {
        const tabId = selector.match(/^\[data-tab-id='([^']+)'/)?.[1];
        this.tabs = this.tabs.filter((tab) => tab.tabId !== tabId);
        if (this.activeTabId === tabId) this.activeTabId = this.tabs[0]!.tabId;
      } else if (selector === "[data-debug-id='vault-workspace-modal'] [aria-label='Close']") {
        this.vaultModal = false;
      } else {
        const grantId = selector.match(/data-request-id='vault-grant:([^']+)'/)?.[1];
        const grant = this.grants.find((candidate) => candidate.grantId === grantId);
        if (grant && selector.includes("approveVaultGrant")) grant.approved = true;
        if (grant && selector.includes("denyVaultGrant")) grant.revoked = true;
      }
      return;
    }
    if (selector === "[data-debug-id='shellx-browser-right-tab-requests']") this.browserRequestsOpen = true;
    else if (selector === "[data-debug-id='shellx-browser-vault-fill-menu']") this.fillPanelOpen = !this.fillPanelOpen;
    else {
      const grantId = selector.match(/data-prompt-id='session-grant-([^']+)'/)?.[1];
      const grant = this.browserGrants.find((candidate) => candidate.grantId === grantId);
      if (grant && selector.includes("approveSessionGrant")) grant.status = "granted";
      if (grant && selector.includes("denySessionGrant")) grant.status = "denied";
      const depositId = selector.match(/data-prompt-id='vault-deposit-([^']+)'/)?.[1];
      if (depositId && selector.includes("dismissDeposit")) this.dismissedDeposits.add(depositId);
      if (depositId && selector.includes("openVault")) {
        this.dismissedDeposits.add(depositId);
        this.vaultModal = true;
      }
    }
  }

  private hasBrowserPrompt(): boolean {
    return this.browserGrants.some((grant) => grant.status === "requested")
      || this.deposits.some((deposit) => !this.dismissedDeposits.has(deposit.depositId));
  }
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

function webdriverValue(value: unknown): Response {
  return json({ value });
}

function webdriverError(message: string, status: number): Response {
  return json({ value: { error: status === 404 ? "no such element" : "unknown error", message } }, status);
}

const runtime = new VaultRequestPromptRuntimeFixture();
const originalFetch = globalThis.fetch;
globalThis.fetch = runtime.fetch;
try {
  const request = runtime.request([...VAULT_REQUEST_PROMPT_SURFACE_IDS].map((surfaceId) => {
    const surface = surfaces.get(surfaceId);
    const assignment = assignments.get(surfaceId);
    assert(surface && assignment);
    return {
      surface,
      fixtureId: assignment.fixtureId,
      expectedEffect: assignment.expectedEffect,
      oracleId: assignment.oracleId,
      cleanupId: assignment.cleanupId,
    };
  }));
  const connection = { base: request.runtime.debugBase, token: runtime.token };
  const input = createReleaseSurfaceInstalledInputSession(request, connection);
  const outcomes = [];
  for (const assignment of request.assignments) {
    outcomes.push(await exerciseVaultRequestPromptSurface(
      connection,
      input,
      request,
      assignment,
    ));
  }
  assert.equal(outcomes.length, 11);
  assert(outcomes.every((outcome) => outcome.present === "pass"), JSON.stringify(outcomes, null, 2));
  assert(outcomes.every((outcome) => outcome.invoke === "pass"), JSON.stringify(outcomes, null, 2));
  assert(outcomes.every((outcome) => outcome.effect === "pass"), JSON.stringify(outcomes, null, 2));
  assert(outcomes.every((outcome) => outcome.cleanup === "pass"), JSON.stringify(outcomes, null, 2));
  assert(!JSON.stringify(outcomes).includes(runtime.depositSecret));
  runtime.assertClean();
} finally {
  globalThis.fetch = originalFetch;
}

console.log("Release surface Vault request/prompt lifecycle tests passed (11 request/unavailable action-specific native-input surfaces)");
