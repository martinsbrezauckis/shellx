import { readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { cleanupOwnedBrowserLifecycle } from "./shellx-browser-test-cleanup";
import { resolveShellxDebugApiConnection } from "./shellx-debug-paths";

type JsonObject = Record<string, unknown>;

interface BrowserTask {
  taskId: string;
  profileId: string;
  ownerActorId: string;
  ownerSurface: string;
  status: string;
}

interface BrowserTaskControlResponse {
  ok: boolean;
  status: string;
  action: string;
  task: BrowserTask;
  receipt: { kind: string; evidence?: JsonObject };
}

interface BrowserTab {
  browserTabId: string;
  engineId?: string | null;
  taskId?: string | null;
  profileId: string;
  url?: string | null;
  status: string;
  shields?: {
    host?: string | null;
    effectiveAdTrackerMode: string;
    scriptBlockingEnabled: boolean;
    hasSiteOverride: boolean;
  } | null;
  lock?: {
    leaseId: string;
    ownerAgentId: string;
    ownerRunId: string;
    expiresAtMs: number;
  } | null;
}

interface BrowserEngineSnapshot {
  engineId: string;
  mounted: boolean;
  webviewLabel?: string;
  browserTabId?: string | null;
  taskId?: string | null;
  profileId?: string | null;
  url?: string | null;
  title?: string | null;
  loadStatus: string;
  lastError?: string | null;
}

interface BrowserEnginePoolSnapshot {
  engines: BrowserEngineSnapshot[];
  limits?: {
    effectiveBackgroundEngines?: number;
    configuredParallelAgents?: string;
  };
  waiting?: unknown[];
  parkedTabs?: string[];
  windowState?: string;
  automationMode?: string;
}

interface BrowserBookmark {
  bookmarkId: string;
  label: string;
  url?: string | null;
  category: string;
  kind: "link" | "folder";
  parentId?: string | null;
  toolbarPinned?: boolean;
  toolbarOrder?: number | null;
}

interface BrowserState {
  profiles: Array<{ profileId: string }>;
  tasks?: BrowserTask[];
  tabs?: BrowserTab[];
  activeBrowserTabId?: string | null;
  bookmarks?: BrowserBookmark[];
  bookmarkToolbar?: Array<{ label: string; url?: string | null; kind: "link" | "folder"; children: Array<{ label: string; url?: string | null }> }>;
  history?: Array<{ url: string; profileId: string; title?: string | null }>;
  receipts?: Array<{ kind?: string }>;
  privacy?: {
    globalAdMode: string;
    profileModes: Array<{ profileId: string; adMode: string }>;
    exposesShellxIdentity: boolean;
  };
  shields?: BrowserShieldSettings;
  developerMode?: BrowserDeveloperModeSettings;
  downloads?: Array<{ transferId: string; direction: string; status: string }>;
  uploads?: Array<{ transferId: string; direction: string; status: string }>;
  engine?: BrowserEngineSnapshot | null;
  enginePool?: BrowserEnginePoolSnapshot | null;
  permissions?: BrowserPermissionEvent[];
  personalLock?: {
    enabled?: boolean;
    locked?: boolean;
  };
}

interface BrowserShieldSettings {
  enabled: boolean;
  adTrackerMode: string;
  cookieMode: string;
  fingerprintingMode: string;
  httpsUpgradeEnabled: boolean;
  scriptBlockingEnabled: boolean;
  siteOverrides: Array<{ host: string; adTrackerMode: string; scriptBlockingEnabled: boolean }>;
}

interface BrowserDeveloperModeSettings {
  enabled: boolean;
  fullCdpAccess: boolean;
  policyDisabled: boolean;
  approvedHosts: string[];
}

interface BrowserActionResponse {
  ok: boolean;
  status: string;
  requiresEngine: boolean;
  requiredApproval?: string | null;
  extractedText?: string;
  receipt?: { kind?: string; evidence?: JsonObject };
  currentUrl?: string | null;
  stepSummary?: {
    action: string;
    status: string;
    snapshotId?: string | null;
    targetRefId?: string | null;
    targetSelector?: string | null;
    currentUrl?: string | null;
    title?: string | null;
    securityLevel: string;
    pageStatus: string;
    refs: number;
    formFields: number;
    accessibilityNodes: number;
    needsObserve: boolean;
    nextActions: string[];
    recoveryHints: string[];
    failedChecks?: string[];
    locatorCandidates?: Array<{
      refId: string;
      role?: string;
      label?: string;
      action?: string | null;
      selector?: string | null;
      visible?: boolean | null;
      enabled?: boolean | null;
      editable?: boolean | null;
      locatorSuggestions?: Array<{ kind: string; value: string; strict: boolean; matchCount: number }>;
    }>;
  };
  actionability?: {
    attached: boolean;
    visible: boolean;
    stable: boolean;
    expectedFingerprint?: string | null;
    actualFingerprint?: string | null;
    fingerprintMatches?: boolean | null;
    enabled: boolean;
    editable: boolean;
    inViewport: boolean;
    receivesEvents: boolean;
    strictMatchCount: number;
    selector?: string | null;
    failedChecks?: string[];
    coveringElement?: {
      selector?: string | null;
      role?: string | null;
      label?: string | null;
      bounds?: { x: number; y: number; width: number; height: number } | null;
    } | null;
  };
  verification?: {
    expectationType: string;
    passed: boolean;
    selector?: string | null;
    checkedText?: string | null;
    checkedUrl?: string | null;
    failures: string[];
  };
  screenshot?: {
    path: string;
    bytes: number;
    sha256: string;
    width?: number | null;
    height?: number | null;
    source: string;
    fullPage?: boolean;
    pageWidth?: number | null;
    pageHeight?: number | null;
  };
  findResult?: {
    query: string;
    matchCount: number;
    activeIndex?: number | null;
    snippet?: string | null;
    scrolled: boolean;
    caseSensitive: boolean;
  };
  observation?: {
    snapshotId?: string;
    refs?: Array<{
      refId: string;
      selector?: string;
      fingerprint?: string | null;
      domPath?: string | null;
      frameUrl?: string | null;
      shadowPath?: string[];
      optionValues?: string[];
      label?: string;
      role?: string;
      name?: string | null;
      testId?: string | null;
      action?: string;
      locatorSuggestions?: Array<{ kind: string; value: string; strict: boolean; matchCount: number }>;
      bounds?: { x: number; y: number; width: number; height: number } | null;
      visible?: boolean;
      enabled?: boolean;
      editable?: boolean;
      frameId?: string | null;
      strictMatchCount?: number;
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
      refId?: string | null;
      selector?: string | null;
      label: string;
      fieldKind: string;
      required: boolean;
      disabled: boolean;
      value?: string | null;
      autocomplete?: string | null;
      formAction?: string | null;
    }>;
    formFieldGroups?: Array<{
      groupId: string;
      groupKind: string;
      label: string;
      formAction?: string | null;
      fieldIntents: string[];
      sensitive: boolean;
      fields: Array<{
        refId?: string | null;
        selector?: string | null;
        label: string;
        fieldKind: string;
        intent: string;
        required: boolean;
        disabled: boolean;
        sensitive: boolean;
      }>;
    }>;
    accessibilityTree?: Array<{
      refId?: string | null;
      role: string;
      label: string;
      action?: string | null;
      selector?: string | null;
    }>;
  };
}

interface BrowserBookmarkResponse {
  ok: boolean;
  bookmark: BrowserBookmark;
  receipt: { kind?: string; evidence?: JsonObject };
}

interface BrowserVaultDepositResponse {
  depositId: string;
  storageCommitHash: string;
  vaultRef?: string;
  serverReceipt: {
    id: string;
    payloadHash: string;
    createdMs: number;
    fromToken: string;
  };
  receipt: { kind: string };
}

interface VaultSetResponse {
  ok: boolean;
  key: string;
  secretExposed?: boolean;
}

interface VaultApprovedGrantResponse {
  ok: boolean;
  grant: {
    grantId: string;
    secretRef: string;
    origin: string | null;
    approved: boolean;
    revoked: boolean;
  };
  secretExposed: boolean;
}

interface VaultProbeResponse {
  ok: boolean;
  decision: string;
  reason?: string | null;
  secretRef: string;
  secretPresent: boolean;
  secretExposed: boolean;
}

interface VaultResourcesResponse {
  ok: boolean;
  resources: Array<{ key: string; userOnly?: boolean; secretExposed?: boolean }>;
  secretExposed: boolean;
}

interface BrowserConsoleLog {
  logId: string;
  taskId?: string;
  level: string;
  source: string;
  message: string;
  url?: string;
  line?: number;
  column?: number;
}

interface BrowserTraceBundleResponse {
  traceId: string;
  taskId?: string | null;
  path: string;
  bytes: number;
  sha256: string;
  source: string;
  receipt: { kind: string; taskId?: string | null };
}

interface BrowserCdpExecuteResponse {
  ok: boolean;
  status: string;
  method: string;
  requiredApproval?: string | null;
  result?: JsonObject;
  resultRedacted: boolean;
  durationMs: number;
  receipt: { kind: string };
}

interface BrowserHarExportResponse {
  harId: string;
  path: string;
  bytes: number;
  sha256: string;
  entries: number;
  source: string;
  receipt: { kind: string };
}

interface BrowserPerformanceExportResponse {
  performanceId: string;
  path: string;
  bytes: number;
  sha256: string;
  source: string;
  metrics?: JsonObject;
  receipt: { kind: string };
}

interface BrowserRecipeExportResponse {
  recipeId: string;
  path: string;
  bytes: number;
  sha256: string;
  steps: number;
  source: string;
  receipt: { kind: string };
}

interface BrowserRecipeReplayResponse {
  ok: boolean;
  status: string;
  stepsPlanned: number;
  stepsApplied: number;
  decisionPoints: JsonObject[];
  dryRun: boolean;
  receipt: { kind: string };
}

interface BrowserRobotJob {
  jobId: string;
  status: string;
  kind: string;
  recipePath?: string | null;
  attempts: number;
  receipt: { kind: string; evidence?: JsonObject };
}

interface BrowserStorageStateManifest {
  profileId: string;
  storageRoot?: string | null;
  cookiesEnabled: boolean;
  localStorageEnabled: boolean;
  persistent: boolean;
  retentionPolicy: string;
  sessionGrantStatus: string;
  cookieValuesExposed: boolean;
  localStorageValuesExposed: boolean;
  artifactHash?: string | null;
}

interface BrowserStorageStateResponse {
  profiles: BrowserStorageStateManifest[];
}

interface BrowserStorageStateExportResponse {
  exportId: string;
  path: string;
  bytes: number;
  sha256: string;
  profiles: BrowserStorageStateManifest[];
  receipt: { kind: string };
}

interface BrowserDialogEvent {
  dialogId: string;
  taskId?: string | null;
  browserTabId?: string | null;
  profileId?: string | null;
  dialogType: string;
  text: string;
  url?: string | null;
  status: string;
  requiresApproval: boolean;
  promptValueProvided: boolean;
  createdAtMs: number;
  resolvedAtMs?: number | null;
  receipt: { kind: string };
}

interface BrowserPermissionEvent {
  permissionId: string;
  taskId?: string | null;
  browserTabId?: string | null;
  profileId?: string | null;
  permissionKind: string;
  origin?: string | null;
  path?: string | null;
  queryRetained: boolean;
  fragmentRetained: boolean;
  userInitiated: boolean;
  status: string;
  requiresApproval: boolean;
  createdAtMs: number;
  resolvedAtMs?: number | null;
  receipt: { kind: string };
}

interface BrowserPopupEvent {
  popupId: string;
  taskId?: string | null;
  browserTabId?: string | null;
  profileId?: string | null;
  openerUrl?: string | null;
  targetUrl: string;
  origin?: string | null;
  path?: string | null;
  queryRetained: boolean;
  status: string;
  requiresApproval: boolean;
  receipt: { kind: string };
}

interface BrowserNetworkEntry {
  networkId: string;
  taskId?: string | null;
  browserTabId?: string | null;
  profileId?: string | null;
  method: string;
  url: string;
  origin?: string | null;
  path?: string | null;
  queryRetained: boolean;
  fragmentRetained: boolean;
  bodyRetained: boolean;
  requestHeadersRedacted: boolean;
  responseHeadersRedacted: boolean;
  resourceType: string;
  blocked: boolean;
}

interface BrowserFileTransfer {
  transferId: string;
  direction: string;
  status: string;
  finalPath?: string | null;
  mimeType?: string | null;
  contentKind?: string | null;
  bytes?: number | null;
  sha256?: string | null;
  sourceUrl?: string | null;
  destination?: string | null;
  retentionReason?: string | null;
  approvalId?: string | null;
  receipt: { kind: string };
}

const SECRET_SENTINEL = "SHELLX_BROWSER_SMOKE_SECRET_DO_NOT_ECHO";
const CONSOLE_ERROR_SENTINEL = "SHELLX_BROWSER_CONSOLE_SMOKE_ERROR";
const CONTROL_FIXTURE_TITLE = "ShellX Browser Control Fixture";

function assert(cond: boolean, message: string): void {
  if (!cond) throw new Error(message);
  console.log(`  ✓ ${message}`);
}

function recordsEqual(left: unknown, right: unknown): boolean {
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  const leftRecord = left as JsonObject;
  const rightRecord = right as JsonObject;
  const leftKeys = Object.keys(leftRecord);
  return leftKeys.length === Object.keys(rightRecord).length && leftKeys.every((key) => Object.is(leftRecord[key], rightRecord[key]));
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
      `${method} ${path} could not reach ${ctx.base}. Start the installed ShellX app with Debug API enabled, then rerun pnpm test:shellx-browser-debug-api. Cause: ${err instanceof Error ? err.message : String(err)}`,
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

async function apiMaybe<T>(
  ctx: { base: string; token: string },
  method: string,
  path: string,
  body?: unknown,
): Promise<{ ok: true; value: T } | { ok: false; status: number; text: string }> {
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
  if (!res.ok) return { ok: false, status: res.status, text };
  const parsed = text ? JSON.parse(text) as T : ({} as T);
  return { ok: true, value: parsed };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function startControlFixture(): Promise<{ url: string; close: () => Promise<void> }> {
  const html = `<!doctype html>
<html>
  <head><meta charset="utf-8"><title>${CONTROL_FIXTURE_TITLE}</title></head>
  <body>
    <style>
      body { min-height: 1800px; font-family: system-ui, sans-serif; }
      #bottom-marker { margin-top: 1200px; padding: 24px; border: 1px solid #2684ff; }
      #hidden-action { display: none; }
      #covered-wrap { position: relative; display: inline-block; margin: 12px 0; }
      #covered-action { width: 180px; height: 42px; }
      #cover-layer { position: absolute; inset: 0; z-index: 2; background: rgba(220, 38, 38, 0.12); }
    </style>
    <h1>${CONTROL_FIXTURE_TITLE}</h1>
    <label for="agent-input">Agent input</label>
    <input id="agent-input" value="">
    <label>Account password <input type="password" name="Passwd" autocomplete="current-password"></label>
    <label id="rich-label" for="rich-editor">Rich editor</label>
    <div id="rich-editor" role="textbox" contenteditable="true" aria-labelledby="rich-label"></div>
    <div id="choice-card" role="radio" tabindex="0" aria-checked="false">For myself I want a personal space</div>
    <button id="apply">Apply</button>
    <button id="stale-target" aria-label="Stale target version one">Stale target v1</button>
    <button id="replace-stale-target">Replace stale target</button>
    <button id="advance-signin-step">Advance sign-in step</button>
    <button id="hidden-action">Hidden action</button>
    <div id="covered-wrap">
      <button id="covered-action">Covered action</button>
      <div id="cover-layer" aria-label="Fixture blocking layer"></div>
    </div>
    <button id="start-delayed">Start delayed status</button>
    <output id="result">Waiting</output>
    <output id="stale-result">Stale target waiting</output>
    <output id="signin-step">Identifier step</output>
    <output id="choice-result">Choice waiting</output>
    <output id="rich-result">Rich waiting</output>
    <output id="delayed-status">Delayed waiting</output>
    <table id="data-table">
      <tr><th>Name</th><th>Status</th></tr>
      <tr><td>Alpha</td><td>Ready</td></tr>
    </table>
    <div id="bottom-marker">Bottom marker for Browser scroll smoke</div>
    <script>
      let richBeforeInput = 0;
      let richInput = 0;
      document.getElementById("rich-editor").addEventListener("beforeinput", () => {
        richBeforeInput += 1;
      });
      document.getElementById("rich-editor").addEventListener("input", () => {
        richInput += 1;
      });
      document.getElementById("apply").addEventListener("click", () => {
        document.getElementById("result").textContent = "Clicked " + document.getElementById("agent-input").value;
        document.getElementById("rich-result").textContent = [
          "Rich",
          document.getElementById("rich-editor").textContent,
          "beforeOk=" + String(richBeforeInput > 0),
          "inputOk=" + String(richInput > 0)
        ].join(" ");
      });
      document.getElementById("stale-target").addEventListener("click", () => {
        document.getElementById("stale-result").textContent = "Original stale target clicked";
      });
      document.getElementById("replace-stale-target").addEventListener("click", () => {
        const replacement = document.createElement("button");
        replacement.id = "stale-target";
        replacement.setAttribute("aria-label", "Stale target version two");
        replacement.textContent = "Stale target v2";
        replacement.addEventListener("click", () => {
          document.getElementById("stale-result").textContent = "Fresh stale target clicked";
        });
        document.getElementById("stale-target").replaceWith(replacement);
      });
      document.getElementById("advance-signin-step").addEventListener("click", () => {
        window.history.pushState({ step: "password" }, "", "/password-step");
        document.title = "${CONTROL_FIXTURE_TITLE} Password";
        document.getElementById("signin-step").textContent = "Password step ready";
      });
      document.getElementById("choice-card").addEventListener("click", () => {
        document.getElementById("choice-card").setAttribute("aria-checked", "true");
        document.getElementById("choice-result").textContent = "Choice card selected";
      });
      document.getElementById("start-delayed").addEventListener("click", () => {
        document.getElementById("delayed-status").textContent = "Delayed pending";
        setTimeout(() => {
          document.getElementById("delayed-status").textContent = "Delayed Browser ready";
        }, 650);
      });
    </script>
  </body>
</html>`;
  const sockets = new Set<Socket>();
  const server = createServer((_, response) => {
    response.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    });
    response.end(html);
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
  return {
    url: `http://127.0.0.1:${address.port}/`,
    close: () => closeServer(server, sockets),
  };
}

function closeServer(server: Server, sockets: Set<Socket>): Promise<void> {
  return new Promise((resolve, reject) => {
    for (const socket of sockets) socket.destroy();
    server.close((err) => err ? reject(err) : resolve());
  });
}

async function waitForBrowserEngine(ctx: { base: string; token: string }, expectedUrl: string): Promise<BrowserState> {
  const deadline = Date.now() + 15_000;
  let last: BrowserState | null = null;
  while (Date.now() < deadline) {
    last = await api<BrowserState>(ctx, "GET", "/browser/state");
    const engine = findLoadedEngineForUrl(last, expectedUrl);
    if (engine) {
      return last;
    }
    await sleep(500);
  }
  throw new Error(`browser engine did not load ${expectedUrl}; last=${JSON.stringify({
    foreground: last?.engine ?? null,
    pool: last?.enginePool?.engines ?? [],
  })}`);
}

async function waitForActiveEngineAlignment(ctx: { base: string; token: string }): Promise<BrowserState> {
  const deadline = Date.now() + 15_000;
  let last: BrowserState | null = null;
  while (Date.now() < deadline) {
    last = await api<BrowserState>(ctx, "GET", "/browser/state");
    const active = last.tabs?.find((tab) => tab.browserTabId === last?.activeBrowserTabId);
    const engine = active ? findEngineForTab(last, active) : null;
    if (
      active?.url
      && engine?.mounted
      && browserUrlMatchesExpected(engine.url, active.url)
      && ["loaded", "observed"].includes(engine.loadStatus)
    ) {
      return last;
    }
    await sleep(500);
  }
  throw new Error(`browser engine did not align to active tab; last=${JSON.stringify({
    activeBrowserTabId: last?.activeBrowserTabId ?? null,
    activeTab: last?.tabs?.find((tab) => tab.browserTabId === last?.activeBrowserTabId) ?? null,
    foreground: last?.engine ?? null,
    pool: last?.enginePool?.engines ?? [],
  })}`);
}

function allBrowserEngines(state: BrowserState): BrowserEngineSnapshot[] {
  const engines = [...(state.enginePool?.engines ?? [])];
  if (state.engine && !engines.some((engine) => engine.engineId === state.engine?.engineId)) {
    engines.push(state.engine);
  }
  return engines;
}

function loadedEngineMatches(engine: BrowserEngineSnapshot | null | undefined, expectedUrl: string): boolean {
  return Boolean(
    engine?.mounted
      && browserUrlMatchesExpected(engine.url, expectedUrl)
      && ["mounted", "loaded", "observed", "actionApplied", "screenshotCaptured"].includes(engine.loadStatus),
  );
}

function findLoadedEngineForUrl(state: BrowserState, expectedUrl: string): BrowserEngineSnapshot | null {
  return allBrowserEngines(state).find((engine) => loadedEngineMatches(engine, expectedUrl)) ?? null;
}

function findEngineForTab(state: BrowserState, tab: BrowserTab): BrowserEngineSnapshot | null {
  const engines = allBrowserEngines(state);
  return engines.find((engine) => tab.engineId && engine.engineId === tab.engineId)
    ?? engines.find((engine) => engine.browserTabId === tab.browserTabId)
    ?? null;
}

function browserUrlMatchesExpected(actual: string | null | undefined, expected: string): boolean {
  if (!actual) return false;
  try {
    const actualUrl = new URL(actual);
    const expectedUrl = new URL(expected);
    return actualUrl.origin === expectedUrl.origin
      && actualUrl.pathname === expectedUrl.pathname
      && (!expectedUrl.search || actualUrl.search === expectedUrl.search)
      && (!expectedUrl.hash || actualUrl.hash === expectedUrl.hash);
  } catch {
    return actual === expected;
  }
}

function bodyDoesNotEchoSecret(value: unknown): boolean {
  return !JSON.stringify(value).includes(SECRET_SENTINEL);
}

function hasExposedStorageValues(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((item) => hasExposedStorageValues(item));
  for (const [key, item] of Object.entries(value as JsonObject)) {
    const normalized = key.toLowerCase();
    const valueBearingKey = [
      "cookies",
      "cookievalue",
      "cookievalues",
      "localstorage",
      "localstoragevalue",
      "localstoragevalues",
      "sessionstorage",
      "sessionstoragevalue",
      "sessionstoragevalues",
    ].includes(normalized);
    if (valueBearingKey && item !== false && item !== null) return true;
    if (hasExposedStorageValues(item)) return true;
  }
  return false;
}

function hostReadablePath(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const driveMatch = normalized.match(/^([A-Za-z]):\/(.*)$/);
  if (driveMatch) return `/mnt/${driveMatch[1]!.toLowerCase()}/${driveMatch[2]}`;
  return path;
}

function isShellxBrowserArtifactPath(path: string | null | undefined, folder: string): boolean {
  if (!path) return false;
  const normalized = path.replace(/\\/g, "/").toLowerCase();
  return normalized.includes(`/.shellx/browser-artifacts/${folder.toLowerCase()}/`);
}

async function main(): Promise<void> {
  console.log("\n=== ShellX Browser live Debug API smoke ===");
  const ctx = await resolveShellxDebugApiConnection();
  let fixture: { url: string; close: () => Promise<void> } | null = null;
  let depositVaultRef: string | null = null;
  const baselineTaskIds = new Set<string>();
  const baselineTabIds = new Set<string>();

  try {
    const health = await api<JsonObject>(ctx, "GET", "/health");
    assert(Boolean(health), "debug API health responds");
    assert(typeof health.appVersion === "string" && health.appVersion.length > 0, "debug API health identifies the app version");
    assert(typeof health.buildCommit === "string" && health.buildCommit.length > 0, "debug API health identifies the build commit");
    assert(health.browserProtocolVersion === "1.5.0", "debug API health identifies the Browser protocol version");
    assert(typeof health.browserSchemaRevision === "string" && health.browserSchemaRevision.length > 0, "debug API health identifies the Browser schema revision");
    assert(Array.isArray(health.browserFeatureFlags), "debug API health advertises Browser feature flags");
    assert((health.browserFeatureFlags as unknown[]).includes("hiddenRenderedCheck"), "debug API health advertises hidden rendered checks");

  const initialSummary = await api<JsonObject>(ctx, "GET", "/browser/summary");
  assert(Buffer.byteLength(JSON.stringify(initialSummary), "utf8") < 16 * 1024, "Browser summary stays under the 16 KiB orientation budget");
  assert(!JSON.stringify(initialSummary).includes("lastObservation"), "Browser summary excludes prior observations");
  assert(typeof initialSummary.revisions === "object" && initialSummary.revisions !== null, "Browser summary exposes revision ids");
  const quietCheck = await api<JsonObject>(ctx, "GET", "/browser/check?timeoutMs=0");
  const quietEffects = quietCheck.effects as JsonObject;
  assert(quietCheck.schema === "shellx/browser-quiet-check@1" && quietCheck.mode === "quiet", "Browser quiet check exposes a versioned compact contract");
  assert(Object.values(quietEffects).every((value) => value === false), "Browser quiet check reports no UI, task, engine, or receipt mutation");
  assert(recordsEqual((quietCheck.summary as JsonObject).revisions, initialSummary.revisions), "Browser quiet check leaves Browser revisions unchanged");

  const coreState = await api<BrowserState>(ctx, "GET", "/browser/state?view=core");
  assert((coreState.history ?? []).length === 0 && (coreState.receipts ?? []).length === 0, "Browser core state excludes heavy history and receipt slices");

  const state = await api<BrowserState>(ctx, "GET", "/browser/state");
  for (const task of state.tasks ?? []) baselineTaskIds.add(task.taskId);
  for (const tab of state.tabs ?? []) baselineTabIds.add(tab.browserTabId);
  assert(state.profiles.some((profile) => profile.profileId === "agent-work"), "browser state exposes Agent Work profile");
  assert(state.profiles.some((profile) => profile.profileId === "task-disposable"), "browser state exposes Task Disposable profile");
  const personalBrowserLocked = state.personalLock?.enabled === true && state.personalLock.locked === true;
  const tasklessProfileId = personalBrowserLocked ? "task-disposable" : "personal";

  await api<JsonObject>(ctx, "POST", "/browser/open", {
    startUrl: "https://example.com/",
  });
  assert(true, "browser window open route accepts startUrl");

  const task = await api<BrowserTask>(ctx, "POST", "/browser/task/start", {
    goal: "Smoke test: read example.com, prove gates, and write report",
    startUrl: "https://example.com/",
    profileId: "agent-work",
    autonomy: "assistedAutonomous",
    expectedDomains: ["example.com"],
  });
  assert(task.taskId.startsWith("browser-task-"), "browser task starts through debug API");
  assert(task.profileId === "agent-work", "browser task uses requested profile");
  await waitForBrowserEngine(ctx, "https://example.com/");
  assert(true, "native Browser engine loads example.com");
  const taskSummaries = await api<{ detail: string; includeObservation: boolean; tasks: JsonObject[] }>(ctx, "GET", "/browser/tasks");
  assert(taskSummaries.detail === "summary" && taskSummaries.includeObservation === false, "Browser task listing defaults to summary detail");
  assert(!JSON.stringify(taskSummaries.tasks).includes("lastObservation"), "Browser task summaries omit observations");
  const settledTask = await api<{ settled: boolean; taskId?: string }>(ctx, "GET", `/browser/settle?taskId=${encodeURIComponent(task.taskId)}&timeoutMs=1000`);
  assert(settledTask.settled === true && settledTask.taskId === task.taskId, "Browser settle endpoint returns a compact settled task snapshot");

  const tabsResponse = await api<{ tabs: BrowserTab[] }>(ctx, "GET", "/browser/tabs");
  const taskTab = tabsResponse.tabs.find((tab) => tab.taskId === task.taskId);
  assert(Boolean(taskTab?.browserTabId), "GET /browser/tabs exposes task tab");

  if (personalBrowserLocked) {
    const deniedPersonalOpen = await apiError(ctx, "POST", "/browser/tabs/open", {
      profileId: "personal",
      url: "https://example.org/",
    });
    assert(
      deniedPersonalOpen.includes("Personal browser is locked"),
      "locked Personal Browser rejects personal tab open through Debug API",
    );
  }

  const tasklessTab = await api<{ ok: boolean; tab: BrowserTab }>(ctx, "POST", "/browser/tabs/open", {
    profileId: tasklessProfileId,
    url: "https://example.org/",
  });
  assert(
    tasklessTab.ok && tasklessTab.tab.browserTabId.startsWith("browser-tab-"),
    personalBrowserLocked
      ? "POST /browser/tabs/open creates a disposable taskless tab when personal tabs are locked"
      : "POST /browser/tabs/open creates a personal taskless tab",
  );
  await api<{ ok: boolean; tab: BrowserTab }>(ctx, "POST", "/browser/tabs/focus", {
    browserTabId: tasklessTab.tab.browserTabId,
  });
  await waitForBrowserEngine(ctx, "https://example.org/");
  assert(true, "native Browser engine loads focused taskless tab");
  const tasklessNavigate = await api<BrowserActionResponse>(ctx, "POST", "/browser/action", {
    browserTabId: tasklessTab.tab.browserTabId,
    action: "navigate",
    url: "https://example.net/",
  });
  assert(tasklessNavigate.status === "applied", "taskless tab navigation action is accepted");
  await waitForBrowserEngine(ctx, "https://example.net/");
  assert(true, "taskless tab navigation drives the native Browser engine");

  await api<{ ok: boolean; tab: BrowserTab }>(ctx, "POST", "/browser/tabs/focus", {
    browserTabId: taskTab!.browserTabId,
  });
  await waitForBrowserEngine(ctx, "https://example.com/");
  const refocusedTaskTabs = await api<{ tabs: BrowserTab[] }>(ctx, "GET", "/browser/tabs");
  assert(
    refocusedTaskTabs.tabs.find((tab) => tab.browserTabId === taskTab!.browserTabId)?.url === "https://example.com/",
    "task tab keeps its URL after returning from personal-tab navigation",
  );

  const extraTab = await api<{ ok: boolean; tab: BrowserTab }>(ctx, "POST", "/browser/tabs/open", {
    profileId: "task-disposable",
    url: "https://example.com/parallel",
  });
  assert(extraTab.ok && extraTab.tab.browserTabId.startsWith("browser-tab-"), "POST /browser/tabs/open creates a parallel tab");
  const reorderedTabs = await api<{ ok: boolean; tabs: BrowserTab[] }>(ctx, "POST", "/browser/tabs/reorder", {
    browserTabIds: [extraTab.tab.browserTabId, taskTab!.browserTabId, tasklessTab.tab.browserTabId],
  });
  assert(
    reorderedTabs.ok && reorderedTabs.tabs[0]?.browserTabId === extraTab.tab.browserTabId,
    "POST /browser/tabs/reorder moves a Browser tab",
  );

  await api<{ ok: boolean; tab: BrowserTab }>(ctx, "POST", "/browser/tabs/focus", {
    browserTabId: taskTab!.browserTabId,
  });
  assert(true, "POST /browser/tabs/focus returns to the task tab");

  const activeCloseTab = await api<{ ok: boolean; tab: BrowserTab }>(ctx, "POST", "/browser/tabs/open", {
    profileId: "task-disposable",
    url: "https://example.com/active-close",
  });
  assert(activeCloseTab.ok && activeCloseTab.tab.browserTabId.startsWith("browser-tab-"), "POST /browser/tabs/open creates an active close regression tab");
  await waitForBrowserEngine(ctx, "https://example.com/active-close");
  const closedActiveTab = await api<{ ok: boolean; tab: BrowserTab }>(ctx, "POST", "/browser/tabs/close", {
    browserTabId: activeCloseTab.tab.browserTabId,
  });
  assert(closedActiveTab.ok && closedActiveTab.tab.status === "closed", "POST /browser/tabs/close closes the active tab");
  await waitForActiveEngineAlignment(ctx);
  assert(true, "active tab close restores native Browser engine to the surviving active tab");

  const closedExtraTab = await api<{ ok: boolean; tab: BrowserTab }>(ctx, "POST", "/browser/tabs/close", {
    browserTabId: extraTab.tab.browserTabId,
  });
  assert(closedExtraTab.ok && closedExtraTab.tab.status === "closed", "POST /browser/tabs/close closes a parallel tab");
  const afterCloseTabs = await api<{ tabs: BrowserTab[] }>(ctx, "GET", "/browser/tabs");
  assert(!afterCloseTabs.tabs.some((tab) => tab.browserTabId === extraTab.tab.browserTabId), "closed Browser tab is removed from active tab list");

  const lockedTab = await api<{ ok: boolean; tab: BrowserTab }>(ctx, "POST", "/browser/tabs/lock", {
    browserTabId: taskTab!.browserTabId,
    ownerAgentId: "agent-a",
    ownerRunId: "run-a",
    ttlSeconds: 120,
  });
  const leaseId = lockedTab.tab.lock?.leaseId;
  assert(Boolean(leaseId), "POST /browser/tabs/lock returns a lease");

  const lockedObserve = await api<BrowserActionResponse>(ctx, "POST", "/browser/action", {
    browserTabId: taskTab!.browserTabId,
    taskId: task.taskId,
    action: "observe",
    ownerAgentId: "agent-b",
    ownerRunId: "run-b",
  });
  assert(lockedObserve.status === "tabLocked", "non-owner observe on locked tab returns tabLocked");
  assert(lockedObserve.receipt?.kind === "browserTabLockDenied", "locked tab denial emits browserTabLockDenied receipt");

  const deniedForceUnlock = await apiError(ctx, "POST", "/browser/tabs/unlock", {
    browserTabId: taskTab!.browserTabId,
    leaseId: "fake-lease",
    ownerAgentId: "agent-b",
    ownerRunId: "run-b",
    force: true,
  });
  assert(deniedForceUnlock.includes("operator-only"), "POST /browser/tabs/unlock rejects force unlock from Debug API");

  const heartbeat = await api<{ ok: boolean; tab: BrowserTab }>(ctx, "POST", "/browser/tabs/heartbeat", {
    browserTabId: taskTab!.browserTabId,
    leaseId,
    ownerAgentId: "agent-a",
    ownerRunId: "run-a",
    ttlSeconds: 180,
  });
  assert((heartbeat.tab.lock?.expiresAtMs ?? 0) > Date.now(), "POST /browser/tabs/heartbeat refreshes the lease");

  const unlocked = await api<{ ok: boolean; tab: BrowserTab }>(ctx, "POST", "/browser/tabs/unlock", {
    browserTabId: taskTab!.browserTabId,
    leaseId,
    ownerAgentId: "agent-a",
    ownerRunId: "run-a",
  });
  assert(unlocked.ok && !unlocked.tab.lock, "POST /browser/tabs/unlock releases the tab");

  const privacyMutationDenied = await apiError(ctx, "POST", "/browser/privacy", {
    profileId: "agent-work",
    profileAdMode: "visualCleanCompatibility",
  });
  assert(privacyMutationDenied.includes("browser_privacy_requires_operator"), "POST /browser/privacy cannot mutate privacy from Debug API");

  const privacyState = await api<{ privacy: BrowserState["privacy"] }>(ctx, "GET", "/browser/privacy");
  assert(privacyState.privacy?.exposesShellxIdentity === false, "GET /browser/privacy reports no ShellX identity exposure");

  const shieldsState = await api<{ shields: BrowserShieldSettings }>(ctx, "GET", "/browser/shields");
  assert(shieldsState.shields.enabled && shieldsState.shields.adTrackerMode === "balanced", "GET /browser/shields reports compatibility-first defaults");

  const globalShieldsMutationDenied = await apiError(ctx, "POST", "/browser/shields", {
    enabled: false,
  });
  assert(globalShieldsMutationDenied.includes("browser_shields_requires_operator"), "POST /browser/shields cannot mutate Shields from Debug API");

  const siteShieldsMutationDenied = await apiError(ctx, "POST", "/browser/shields/site", {
    host: "example.com",
    adTrackerMode: "strict",
    cookieMode: "blockThirdParty",
    fingerprintingMode: "compatibility",
    httpsUpgradeEnabled: true,
    scriptBlockingEnabled: true,
  });
  assert(siteShieldsMutationDenied.includes("browser_shields_requires_operator"), "POST /browser/shields/site cannot mutate Shields from Debug API");

  const siteShieldsDeleteDenied = await apiError(ctx, "DELETE", "/browser/shields/site/example.com");
  assert(siteShieldsDeleteDenied.includes("browser_shields_requires_operator"), "DELETE /browser/shields/site/:host cannot mutate Shields from Debug API");

  const developerModeInitial = await api<{ developerMode: BrowserDeveloperModeSettings }>(ctx, "GET", "/browser/developer-mode");
  assert(developerModeInitial.developerMode.policyDisabled === false, "GET /browser/developer-mode reports policy state");
  const developerModeResetDenied = await apiError(ctx, "POST", "/browser/developer-mode", {
    enabled: false,
    fullCdpAccess: false,
    approvedHosts: [],
  });
  assert(developerModeResetDenied.includes("developer_mode_requires_operator"), "Debug API cannot reset Developer Mode or CDP approvals");

  const cdpBeforeApproval = await api<BrowserActionResponse>(ctx, "POST", "/browser/action", {
    taskId: task.taskId,
    action: "cdpCommand",
    sensitiveKind: "fullCdpAccess",
  });
  assert(cdpBeforeApproval.requiredApproval === "browserDeveloperModeApproval", "CDP action is blocked before Developer Mode approval");
  assert(cdpBeforeApproval.receipt?.kind === "browserCdpAccessRequested", "blocked CDP action emits browserCdpAccessRequested");

  const developerModeEnableDenied = await apiError(ctx, "POST", "/browser/developer-mode", {
    enabled: true,
    fullCdpAccess: true,
  });
  assert(developerModeEnableDenied.includes("developer_mode_requires_operator"), "Debug API cannot self-enable full CDP access");

  const developerModeApprovalDenied = await apiError(ctx, "POST", "/browser/developer-mode/approval", {
    taskId: task.taskId,
    fullCdpAccess: true,
  });
  assert(developerModeApprovalDenied.includes("developer_mode_requires_operator"), "Debug API cannot self-approve an active task host");
  await waitForBrowserEngine(ctx, "https://example.com/");

  const cdpExecuteDenied = await api<BrowserCdpExecuteResponse>(ctx, "POST", "/browser/cdp/execute", {
    taskId: task.taskId,
    method: "Runtime.evaluate",
    expression: "document.title",
    reason: "Debug API smoke verifies CDP remains gated without operator approval",
  });
  assert(cdpExecuteDenied.status === "blocked", "CDP executor stays gated without operator approval");
  assert(cdpExecuteDenied.requiredApproval === "browserDeveloperModeApproval", "CDP executor returns Developer Mode approval requirement");

  const cdpAfterApproval = await api<BrowserActionResponse>(ctx, "POST", "/browser/action", {
    taskId: task.taskId,
    action: "cdpCommand",
    sensitiveKind: "fullCdpAccess",
  });
  assert(cdpAfterApproval.status === "blocked", "unapproved CDP action remains blocked");
  assert(cdpAfterApproval.requiredApproval === "browserDeveloperModeApproval", "unapproved CDP action still asks for Developer Mode approval");

  assert(true, "Developer Mode remains owned by the ShellX operator path after CDP smoke");

  const downloadIntent = await api<BrowserFileTransfer>(ctx, "POST", "/browser/downloads/request", {
    taskId: task.taskId,
    browserTabId: taskTab!.browserTabId,
    url: "https://example.com/report.pdf",
    fileName: "report.pdf",
    reason: "Debug API smoke requested a controlled download intent",
  });
  assert(downloadIntent.direction === "download" && downloadIntent.status === "requested", "POST /browser/downloads/request records explicit download intent");

  const rejectedDownloadCompletion = await apiError(ctx, "POST", "/browser/downloads/complete", {
    transferId: downloadIntent.transferId,
    finalPath: "/home/user/Downloads/report.pdf",
    mimeType: "application/pdf",
    bytes: 4096,
    sha256: "a".repeat(64),
    sourceUrl: "https://example.com/report.pdf?token=must-not-echo",
    destination: "local-downloads",
    retentionReason: "Debug API smoke retained a controlled download artifact",
    approvalId: "debug-download-grant",
  });
  assert(rejectedDownloadCompletion.includes("host-granted"), "POST /browser/downloads/complete rejects arbitrary approval ids");

  const uploadIntent = await api<BrowserFileTransfer>(ctx, "POST", "/browser/uploads/request", {
    taskId: task.taskId,
    browserTabId: taskTab!.browserTabId,
    filePath: "/home/user/example-upload.txt",
    displayName: "example-upload.txt",
    destinationOrigin: "https://example.com",
    refId: "upload",
    reason: "Debug API smoke requested a controlled upload intent",
  });
  assert(uploadIntent.direction === "upload" && uploadIntent.status === "requested", "POST /browser/uploads/request records explicit upload intent");

  const rejectedUploadCompletion = await apiError(ctx, "POST", "/browser/uploads/complete", {
    transferId: uploadIntent.transferId,
    finalPath: "/home/user/example-upload.txt",
    mimeType: "text/plain",
    bytes: 128,
    sha256: "b".repeat(64),
    sourceUrl: "https://example.com/upload?session=must-not-echo",
    destination: "https://example.com",
    retentionReason: "Debug API smoke retained an upload receipt",
    approvalId: "debug-file-grant",
  });
  assert(rejectedUploadCompletion.includes("host-granted"), "POST /browser/uploads/complete rejects arbitrary approval ids");

  const storageState = await api<BrowserStorageStateResponse>(ctx, "GET", "/browser/storage-state");
  const agentStorage = storageState.profiles.find((profile) => profile.profileId === "agent-work");
  const disposableStorage = storageState.profiles.find((profile) => profile.profileId === "task-disposable");
  assert(Boolean(agentStorage?.storageRoot), "GET /browser/storage-state exposes profile storage roots");
  assert(agentStorage?.cookieValuesExposed === false, "storage-state manifest does not expose cookie values");
  assert(agentStorage?.localStorageValuesExposed === false, "storage-state manifest does not expose local-storage values");
  assert(disposableStorage?.cookiesEnabled === false, "storage-state manifest preserves disposable no-cookie policy");

  const storageExport = await api<BrowserStorageStateExportResponse>(ctx, "POST", "/browser/storage-state/export", {
    profileId: "agent-work",
    reason: "Debug API smoke needs a safe storage-state manifest",
  });
  assert(storageExport.exportId.startsWith("browser-storage-"), "storage-state export returns export id");
  assert(isShellxBrowserArtifactPath(storageExport.path, "shellx-browser-storage-state"), "storage-state export returns ShellX Browser storage artifact path");
  assert(/^[a-f0-9]{64}$/i.test(storageExport.sha256), "storage-state export returns SHA-256");
  assert(storageExport.receipt.kind === "browserStorageStateManifestExported", "storage-state export emits browserStorageStateManifestExported receipt");
  const storageJson = JSON.parse(readFileSync(hostReadablePath(storageExport.path), "utf8")) as JsonObject;
  assert(!hasExposedStorageValues(storageJson), "storage-state export omits cookie/local-storage values");

  const initialNetwork = await api<{ entries: BrowserNetworkEntry[] }>(ctx, "GET", "/browser/network?limit=200");
  assert(initialNetwork.entries.some((entry) =>
    entry.origin === "https://example.com"
    && entry.resourceType === "document"
    && entry.bodyRetained === false
    && entry.requestHeadersRedacted === true
  ), "GET /browser/network exposes safe document-load metadata");

  const harExport = await api<BrowserHarExportResponse>(ctx, "POST", "/browser/har/export", {
    taskId: task.taskId,
    browserTabId: taskTab!.browserTabId,
    reason: "Debug API smoke needs a redacted Browser HAR",
  });
  assert(harExport.harId.startsWith("browser-har-"), "HAR export returns har id");
  assert(isShellxBrowserArtifactPath(harExport.path, "shellx-browser-har"), "HAR export returns ShellX Browser HAR artifact path");
  assert(harExport.entries > 0, "HAR export includes at least one network entry");
  assert(/^[a-f0-9]{64}$/i.test(harExport.sha256), "HAR export returns SHA-256");
  assert(harExport.receipt.kind === "browserHarExported", "HAR export emits browserHarExported receipt");
  const harJson = JSON.parse(readFileSync(hostReadablePath(harExport.path), "utf8")) as JsonObject;
  assert(!JSON.stringify(harJson).includes("must-not-echo"), "HAR export omits query-secret sentinels");
  const harEntries = (((harJson.log as JsonObject).entries ?? []) as JsonObject[]);
  assert(harEntries.every((entry) => ((entry.request as JsonObject).headers as unknown[]).length === 0), "HAR export stores empty request header arrays");

  const performanceExport = await api<BrowserPerformanceExportResponse>(ctx, "POST", "/browser/performance/export", {
    taskId: task.taskId,
    browserTabId: taskTab!.browserTabId,
    reason: "Debug API smoke needs Browser performance metrics",
  });
  assert(performanceExport.performanceId.startsWith("browser-performance-"), "performance export returns performance id");
  assert(isShellxBrowserArtifactPath(performanceExport.path, "shellx-browser-performance"), "performance export returns ShellX Browser performance artifact path");
  assert(performanceExport.bytes > 100, "performance export writes non-empty JSON");
  assert(/^[a-f0-9]{64}$/i.test(performanceExport.sha256), "performance export returns SHA-256");
  assert(performanceExport.receipt.kind === "browserPerformanceExported", "performance export emits browserPerformanceExported receipt");
  const performanceJson = JSON.parse(readFileSync(hostReadablePath(performanceExport.path), "utf8")) as JsonObject;
  assert(!JSON.stringify(performanceJson).includes("must-not-echo"), "performance export omits query-secret sentinels");

  const recordedDialog = await api<BrowserDialogEvent>(ctx, "POST", "/browser/dialogs", {
    taskId: task.taskId,
    browserTabId: taskTab!.browserTabId,
    dialogType: "prompt",
    text: "Enter workspace label",
    url: "https://example.com/account?dialogSecret=must-not-echo",
    requiresApproval: true,
  });
  assert(recordedDialog.dialogId.startsWith("browser-dialog-"), "POST /browser/dialogs records a dialog event");
  assert(recordedDialog.status === "pending" && recordedDialog.requiresApproval === true, "dialog event starts pending and approval-gated");
  assert(recordedDialog.receipt.kind === "browserDialogRecorded", "dialog record emits browserDialogRecorded receipt");

  const dialogResolveDenied = await apiError(ctx, "POST", "/browser/dialogs/resolve", {
    dialogId: recordedDialog.dialogId,
    action: "accept",
    promptValue: "Smoke workspace",
  });
  assert(dialogResolveDenied.includes("browser_prompt_resolution_requires_operator"), "POST /browser/dialogs/resolve requires operator approval over Debug API");
  assert(!dialogResolveDenied.includes("Smoke workspace"), "dialog resolve denial does not echo prompt input");

  const dialogs = await api<{ dialogs: BrowserDialogEvent[] }>(ctx, "GET", "/browser/dialogs?limit=20");
  assert(dialogs.dialogs.some((dialog) => dialog.dialogId === recordedDialog.dialogId && dialog.status === "pending"), "GET /browser/dialogs keeps Debug API-denied dialog pending");

  const recordedPermission = await api<BrowserPermissionEvent>(ctx, "POST", "/browser/permissions", {
    taskId: task.taskId,
    browserTabId: taskTab!.browserTabId,
    permissionKind: "notifications",
    url: "https://example.com/account?permissionSecret=must-not-echo#notify",
    userInitiated: true,
    requiresApproval: true,
  });
  assert(recordedPermission.permissionId.startsWith("browser-permission-"), "POST /browser/permissions records a permission event");
  assert(recordedPermission.status === "pending" && recordedPermission.requiresApproval === true, "permission event starts pending and approval-gated");
  assert(recordedPermission.permissionKind === "notifications", "permission event records normalized kind");
  assert(recordedPermission.origin === "https://example.com", "permission event records safe origin");
  assert(recordedPermission.path === "/account", "permission event records safe path");
  assert(recordedPermission.queryRetained === false && recordedPermission.fragmentRetained === false, "permission event strips query and fragment");
  assert(recordedPermission.receipt.kind === "browserPermissionRequested", "permission record emits browserPermissionRequested receipt");
  assert(!JSON.stringify(recordedPermission).includes("must-not-echo"), "permission record does not expose query secret");

  const permissionResolveDenied = await apiError(ctx, "POST", "/browser/permissions/resolve", {
    permissionId: recordedPermission.permissionId,
    action: "deny",
  });
  assert(permissionResolveDenied.includes("browser_prompt_resolution_requires_operator"), "POST /browser/permissions/resolve requires operator approval over Debug API");

  const permissions = await api<{ permissions: BrowserPermissionEvent[] }>(ctx, "GET", "/browser/permissions?limit=20");
  assert(permissions.permissions.some((event) => event.permissionId === recordedPermission.permissionId && event.status === "pending"), "GET /browser/permissions keeps Debug API-denied permission pending");
  assert(!JSON.stringify(permissions).includes("must-not-echo"), "permission list does not expose query secret");

  const recordedPopup = await api<BrowserPopupEvent>(ctx, "POST", "/browser/popups", {
    taskId: task.taskId,
    browserTabId: taskTab!.browserTabId,
    openerUrl: "https://example.com/",
    targetUrl: "https://example.com/new?invite=must-not-echo#section",
    disposition: "new-tab",
    requiresApproval: true,
  });
  assert(recordedPopup.popupId.startsWith("browser-popup-"), "POST /browser/popups records a popup event");
  assert(recordedPopup.targetUrl === "https://example.com/new", "popup event strips query and fragment from target URL");
  assert(recordedPopup.queryRetained === false, "popup event reports query redaction");
  assert(!("urlHash" in recordedPopup), "popup event does not expose a reusable full target URL hash");
  assert(recordedPopup.receipt.kind === "browserPopupRecorded", "popup record emits browserPopupRecorded receipt");

  const popups = await api<{ popups: BrowserPopupEvent[] }>(ctx, "GET", "/browser/popups?limit=20");
  assert(popups.popups.some((popup) => popup.popupId === recordedPopup.popupId), "GET /browser/popups returns popup events");
  assert(!JSON.stringify(popups).includes("must-not-echo"), "popup list does not expose query secret");

  const observe = await api<BrowserActionResponse>(ctx, "POST", "/browser/action", {
    taskId: task.taskId,
    action: "observe",
  });
  assert(observe.status === "applied", "observe action is applied");
  assert(Boolean(observe.observation?.refs?.some((ref) => ref.refId === "page")), "observe returns page ref");
  assert(Boolean(observe.observation?.refs?.some((ref) => ref.selector)), "observe returns selector-backed DOM refs");
  assert(Number.isFinite(observe.observation?.domSummary?.textBytes), "observe returns DOM summary text byte count");
  assert(Number.isFinite(observe.observation?.domSummary?.links), "observe returns DOM summary link count");
  assert(Array.isArray(observe.observation?.accessibilityTree), "observe returns accessibility control summary");
  assert(Boolean(observe.observation?.accessibilityTree?.some((node) => node.refId === "page")), "observe accessibility summary includes synthetic page node");

  const extract = await api<BrowserActionResponse>(ctx, "POST", "/browser/action", {
    taskId: task.taskId,
    action: "extractMarkdown",
  });
  assert(extract.status === "applied", "extractMarkdown action is applied");
  assert(Boolean(extract.extractedText?.includes("Example Domain")), "extractMarkdown returns real Example Domain page text");

  const bookmarkCurrent = await api<BrowserActionResponse>(ctx, "POST", "/browser/action", {
    taskId: task.taskId,
    action: "bookmarkCurrent",
    value: "Example Domain smoke",
  });
  assert(bookmarkCurrent.status === "applied", "bookmarkCurrent saves the active page");
  assert(bookmarkCurrent.receipt?.kind === "browserBookmarkSaved", "bookmarkCurrent emits browserBookmarkSaved receipt");
  const bookmarkedState = await api<BrowserState>(ctx, "GET", "/browser/state");
  assert(Boolean(bookmarkedState.bookmarks?.some((item) => item.url === "https://example.com/" && item.label === "Example Domain smoke")), "browser state includes saved current-page bookmark");
  assert(Boolean(bookmarkedState.history?.some((item) => item.url === "https://example.com/" && item.profileId === "agent-work")), "browser state includes navigation history entry");

  const smokeFolderId = "debug-smoke-folder";
  const smokeLinkId = "debug-smoke-link";
  await api<JsonObject>(ctx, "DELETE", `/browser/bookmarks/${smokeLinkId}`).catch(() => undefined);
  await api<JsonObject>(ctx, "DELETE", `/browser/bookmarks/${smokeFolderId}`).catch(() => undefined);
  const smokeFolder = await api<BrowserBookmarkResponse>(ctx, "POST", "/browser/bookmarks", {
    bookmarkId: smokeFolderId,
    label: "Smoke folder",
    kind: "folder",
    category: "debug-smoke",
    toolbarPinned: false,
  });
  assert(smokeFolder.bookmark.kind === "folder", "POST /browser/bookmarks creates a folder bookmark");
  const smokeLink = await api<BrowserBookmarkResponse>(ctx, "POST", "/browser/bookmarks", {
    bookmarkId: smokeLinkId,
    label: "Smoke link",
    kind: "link",
    url: "https://example.com/debug-bookmark",
    category: "debug-smoke",
    toolbarPinned: false,
  });
  assert(smokeLink.bookmark.kind === "link", "POST /browser/bookmarks creates a link bookmark");
  const nestedBookmark = await api<{ ok: boolean; bookmarkToolbar: BrowserState["bookmarkToolbar"]; receipt: { kind?: string } }>(
    ctx,
    "POST",
    "/browser/bookmarks/reorder",
    {
      items: [{
        bookmarkId: smokeLink.bookmark.bookmarkId,
        parentId: smokeFolder.bookmark.bookmarkId,
        toolbarPinned: false,
        toolbarOrder: 0,
      }],
    },
  );
  assert(nestedBookmark.ok && nestedBookmark.receipt.kind === "browserBookmarkToolbarChanged", "POST /browser/bookmarks/reorder accepts folder drops");
  const nestedBookmarkState = await api<{ bookmarks: BrowserBookmark[]; bookmarkToolbar: BrowserState["bookmarkToolbar"] }>(
    ctx,
    "GET",
    "/browser/bookmarks",
  );
  assert(
    nestedBookmarkState.bookmarks.some((item) => item.bookmarkId === smokeLink.bookmark.bookmarkId && item.parentId === smokeFolder.bookmark.bookmarkId),
    "bookmark reorder moves a link into a folder",
  );
  const rootPinnedBookmark = await api<{ ok: boolean; bookmarkToolbar: BrowserState["bookmarkToolbar"]; receipt: { kind?: string } }>(
    ctx,
    "POST",
    "/browser/bookmarks/reorder",
    {
      items: [{
        bookmarkId: smokeLink.bookmark.bookmarkId,
        parentId: null,
        toolbarPinned: true,
        toolbarOrder: 0,
      }],
    },
  );
  assert(rootPinnedBookmark.ok, "POST /browser/bookmarks/reorder accepts root drops");
  const rootPinnedBookmarkState = await api<{ bookmarks: BrowserBookmark[]; bookmarkToolbar: BrowserState["bookmarkToolbar"] }>(
    ctx,
    "GET",
    "/browser/bookmarks",
  );
  assert(
    rootPinnedBookmarkState.bookmarks.some((item) => item.bookmarkId === smokeLink.bookmark.bookmarkId && !item.parentId && item.toolbarPinned === true),
    "bookmark reorder moves a link back to root and pins it",
  );
  assert(Boolean(rootPinnedBookmarkState.bookmarkToolbar?.some((item) => item.label === "Smoke link")), "bookmark toolbar reflects root-pinned bookmark");
  await api<JsonObject>(ctx, "DELETE", `/browser/bookmarks/${smokeLinkId}`).catch(() => undefined);
  await api<JsonObject>(ctx, "DELETE", `/browser/bookmarks/${smokeFolderId}`).catch(() => undefined);

  const waitFor = await api<BrowserActionResponse>(ctx, "POST", "/browser/action", {
    taskId: task.taskId,
    action: "waitFor",
    value: "Example Domain",
  });
  assert(waitFor.status === "applied", "waitFor applies through the native Browser engine");
  assert(waitFor.requiresEngine === false, "waitFor does not require a missing engine");

  const screenshot = await api<BrowserActionResponse>(ctx, "POST", "/browser/action", {
    taskId: task.taskId,
    action: "captureScreenshot",
  });
  assert(screenshot.status === "applied", "captureScreenshot applies through the Browser debug API");
  assert(screenshot.receipt?.kind === "browserScreenshotCaptured", "captureScreenshot emits browserScreenshotCaptured receipt");
  assert(isShellxBrowserArtifactPath(screenshot.screenshot?.path, "shellx-browser-screenshots"), "captureScreenshot returns ShellX Browser screenshot path");
  assert((screenshot.screenshot?.bytes ?? 0) > 10_000, "captureScreenshot returns non-empty PNG bytes");
  assert(/^[a-f0-9]{64}$/i.test(screenshot.screenshot?.sha256 ?? ""), "captureScreenshot returns screenshot SHA-256");
  assert((screenshot.screenshot?.width ?? 0) > 0, "captureScreenshot returns screenshot width");
  assert((screenshot.screenshot?.height ?? 0) > 0, "captureScreenshot returns screenshot height");

  const selectorlessClick = await api<BrowserActionResponse>(ctx, "POST", "/browser/action", {
    taskId: task.taskId,
    action: "click",
    refId: "page",
  });
  assert(selectorlessClick.status === "notFound", "selectorless click reports notFound instead of fake success");
  assert(selectorlessClick.requiresEngine === false, "selectorless click has an engine but no target");

  fixture = await startControlFixture();
  const renderedSummaryBefore = await api<JsonObject>(ctx, "GET", "/browser/summary");
  const renderedCheckUrl = new URL(fixture.url);
  renderedCheckUrl.searchParams.set("redacted", "query-secret");
  const renderedCheck = await api<JsonObject>(ctx, "POST", "/browser/rendered-check", {
    url: renderedCheckUrl.toString(),
    expectText: CONTROL_FIXTURE_TITLE,
    titleIncludes: CONTROL_FIXTURE_TITLE,
    selector: "#apply",
    timeoutMs: 10_000,
    expectedDomains: ["127.0.0.1"],
  });
  const renderedEvidence = renderedCheck.evidence as JsonObject;
  const renderedEffects = renderedCheck.effects as JsonObject;
  assert(renderedCheck.schema === "shellx/browser-rendered-check@1" && renderedCheck.status === "passed", "hidden rendered check loads and verifies the JavaScript-capable fixture");
  assert(renderedEvidence.textMatched === true && renderedEvidence.titleMatched === true && renderedEvidence.selectorMatched === true, "hidden rendered check returns bounded expectation evidence");
  assert(!String(renderedEvidence.finalUrl).includes("query-secret"), "hidden rendered check redacts final URL query data");
  assert(renderedEffects.visibleWindowOpened === false && renderedEffects.browserTaskCreated === false && renderedEffects.browserTabCreated === false, "hidden rendered check does not mutate the visible cowork surface");
  assert(renderedEffects.hiddenRendererDestroyed === true && renderedEffects.profilePersisted === false, "hidden rendered check destroys its incognito renderer");
  const renderedSummaryAfter = await api<JsonObject>(ctx, "GET", "/browser/summary");
  assert(recordsEqual(renderedSummaryAfter.revisions, renderedSummaryBefore.revisions), "hidden rendered check leaves Browser registry revisions unchanged");
  const controlTask = await api<BrowserTask>(ctx, "POST", "/browser/task/start", {
    goal: "Smoke test: fill, click, wait, and extract a local control fixture",
    startUrl: fixture.url,
    profileId: "agent-work",
    autonomy: "assistedAutonomous",
    expectedDomains: ["127.0.0.1"],
  });
  await waitForBrowserEngine(ctx, fixture.url);
  assert(true, "native Browser engine loads local control fixture");

  const fixtureObserve = await api<BrowserActionResponse>(ctx, "POST", "/browser/action", {
    taskId: controlTask.taskId,
    action: "observe",
  });
  assert(fixtureObserve.status === "applied", "observe applies on local control fixture");
  assert(typeof fixtureObserve.observation?.snapshotId === "string" && fixtureObserve.observation.snapshotId.startsWith("browser-snapshot-"), "observe returns a stable Browser snapshot id");
  assert(fixtureObserve.stepSummary?.snapshotId === fixtureObserve.observation?.snapshotId, "observe step summary references the active snapshot id");
  assert(fixtureObserve.observation?.domSummary?.tables === 1, "observe DOM summary counts fixture table");
  assert(fixtureObserve.observation?.domSummary?.inputs === 3, "observe DOM summary counts fixture input, password, and rich editor");
  assert(Boolean(fixtureObserve.observation?.formFields?.some((field) =>
    field.selector === "#agent-input"
    && field.label === "Agent input"
    && field.fieldKind === "text"
  )), "observe returns fixture form field map");
  assert(Boolean(fixtureObserve.observation?.formFieldGroups?.some((group) =>
    group.fieldIntents.includes("password")
    && group.sensitive === true
    && group.fields.some((field) => field.intent === "password" && field.sensitive === true)
  )), "observe returns grouped form intelligence for sensitive password fields");
  assert(Boolean(fixtureObserve.observation?.accessibilityTree?.some((node) =>
    node.role === "button"
    && node.label === "Apply"
    && node.selector === "#apply"
  )), "observe returns fixture accessibility action node");
  const applyRef = fixtureObserve.observation?.refs?.find((ref) => ref.selector === "#apply");
  assert(Boolean(applyRef?.locatorSuggestions?.some((locator) => locator.kind === "css" && locator.value === "#apply" && locator.strict)), "observe returns strict CSS locator suggestion for fixture button");
  assert(Boolean(applyRef?.locatorSuggestions?.some((locator) => locator.kind === "role" && locator.value.includes("button"))), "observe returns role/name locator suggestion for fixture button");
  assert((applyRef?.strictMatchCount ?? 0) === 1, "observe returns strict match count for fixture button");
  assert((applyRef?.bounds?.width ?? 0) > 0 && (applyRef?.bounds?.height ?? 0) > 0, "observe returns element bounds for fixture button");
  assert(applyRef?.visible === true && applyRef.enabled === true, "observe returns visible/enabled metadata for fixture button");
  assert(applyRef?.frameId === "main", "observe marks fixture button in main frame");
  assert(typeof applyRef?.fingerprint === "string" && applyRef.fingerprint.startsWith("fp-"), "observe returns an opaque element fingerprint");
  assert(typeof applyRef?.domPath === "string" && applyRef.domPath.includes("button#apply"), "observe returns a bounded DOM path");
  assert(applyRef?.frameUrl === fixture.url, "observe returns the main-frame URL for a ref");
  assert(Array.isArray(applyRef?.shadowPath) && applyRef.shadowPath.length === 0, "observe returns an explicit empty shadow path for a main-DOM ref");
  const inputRef = fixtureObserve.observation?.refs?.find((ref) => ref.selector === "#agent-input");
  assert(inputRef?.editable === true, "observe returns editable metadata for fixture input");

  const unchangedObserve = await api<BrowserActionResponse>(ctx, "POST", "/browser/action", {
    taskId: controlTask.taskId,
    action: "observe",
  });
  const unchangedApplyRef = unchangedObserve.observation?.refs?.find((ref) => ref.selector === "#apply");
  assert(unchangedApplyRef?.refId === applyRef?.refId, "unchanged controls keep the same deterministic ref across observations");
  assert(unchangedApplyRef?.fingerprint === applyRef?.fingerprint, "unchanged controls keep the same fingerprint across observations");

  const staleTargetRef = unchangedObserve.observation?.refs?.find((ref) => ref.selector === "#stale-target");
  assert(Boolean(staleTargetRef?.refId && staleTargetRef.fingerprint), "observe returns a stable ref for the stale-target fixture");
  const replaceStaleTarget = await api<BrowserActionResponse>(ctx, "POST", "/browser/action", {
    taskId: controlTask.taskId,
    action: "clickRef",
    selector: "#replace-stale-target",
  });
  assert(replaceStaleTarget.status === "applied", "fixture replaces a same-selector control after observation");
  const staleTargetClick = await api<BrowserActionResponse>(ctx, "POST", "/browser/action", {
    taskId: controlTask.taskId,
    action: "clickRef",
    refId: staleTargetRef?.refId,
  });
  assert(staleTargetClick.status === "staleRef" && staleTargetClick.ok === false, "changed element identity blocks an old observation ref");
  assert(staleTargetClick.actionability?.fingerprintMatches === false, "stale ref response exposes fingerprint mismatch evidence");
  assert(staleTargetClick.stepSummary?.failedChecks?.includes("fingerprint") === true, "stale ref step summary requires a fresh observe");
  const refreshedObserve = await api<BrowserActionResponse>(ctx, "POST", "/browser/action", {
    taskId: controlTask.taskId,
    action: "observe",
  });
  const refreshedStaleTargetRef = refreshedObserve.observation?.refs?.find((ref) => ref.selector === "#stale-target");
  assert(refreshedStaleTargetRef?.refId !== staleTargetRef?.refId, "changed semantic identity produces a new deterministic ref");
  const refreshedStaleTargetClick = await api<BrowserActionResponse>(ctx, "POST", "/browser/action", {
    taskId: controlTask.taskId,
    action: "clickRef",
    refId: refreshedStaleTargetRef?.refId,
  });
  assert(refreshedStaleTargetClick.status === "applied", "fresh observation ref acts on the replacement control");

  const controlTabState = await api<BrowserState>(ctx, "GET", "/browser/state");
  const controlTab = controlTabState.tabs?.find((tab) => tab.taskId === controlTask.taskId);
  assert(Boolean(controlTab?.browserTabId), "control fixture task has a Browser tab before tab-switch regression");
  const passwordStepUrl = new URL("/password-step", fixture.url).toString();
  const advanceSigninStep = await api<BrowserActionResponse>(ctx, "POST", "/browser/action", {
    taskId: controlTask.taskId,
    action: "clickRef",
    selector: "#advance-signin-step",
  });
  assert(advanceSigninStep.status === "applied", "fixture can advance to a same-document password step");
  const passwordStepObserve = await api<BrowserActionResponse>(ctx, "POST", "/browser/action", {
    taskId: controlTask.taskId,
    action: "observe",
  });
  assert(browserUrlMatchesExpected(passwordStepObserve.currentUrl, passwordStepUrl), "observe records the same-document password-step URL");
  const preservationOtherTab = await api<{ ok: boolean; tab: BrowserTab }>(ctx, "POST", "/browser/tabs/open", {
    profileId: "task-disposable",
    url: "https://example.com/shellx-preserve-other-tab",
  });
  assert(preservationOtherTab.ok, "tab-switch regression opens a second tab");
  await waitForBrowserEngine(ctx, "https://example.com/shellx-preserve-other-tab");
  await api<{ ok: boolean; tab: BrowserTab }>(ctx, "POST", "/browser/tabs/focus", {
    browserTabId: controlTab!.browserTabId,
  });
  const preservedState = await waitForActiveEngineAlignment(ctx);
  const preservedTab = preservedState.tabs?.find((tab) => tab.browserTabId === controlTab!.browserTabId);
  const preservedEngine = preservedTab ? findEngineForTab(preservedState, preservedTab) : null;
  assert(browserUrlMatchesExpected(preservedTab?.url, passwordStepUrl), "tab focus preserves the same-document password-step tab URL");
  assert(browserUrlMatchesExpected(preservedEngine?.url, passwordStepUrl), "tab focus preserves the live engine password-step URL");
  const preservedObserve = await api<BrowserActionResponse>(ctx, "POST", "/browser/action", {
    taskId: controlTask.taskId,
    action: "observe",
  });
  assert(browserUrlMatchesExpected(preservedObserve.currentUrl, passwordStepUrl), "post-focus observe stays on the password-step URL");
  await api<{ ok: boolean }>(ctx, "POST", "/browser/tabs/close", {
    browserTabId: preservationOtherTab.tab.browserTabId,
  });

  const fullPageScreenshot = await api<BrowserActionResponse>(ctx, "POST", "/browser/action", {
    taskId: controlTask.taskId,
    action: "captureScreenshot",
    fullPage: true,
  });
  assert(fullPageScreenshot.status === "applied", "captureScreenshot supports full-page capture through the Browser debug API");
  assert(fullPageScreenshot.receipt?.kind === "browserScreenshotCaptured", "full-page screenshot emits browserScreenshotCaptured receipt");
  assert(fullPageScreenshot.screenshot?.fullPage === true, "full-page screenshot reports fullPage metadata");
  assert(fullPageScreenshot.screenshot?.source === "browser-page", "full-page screenshot captures page content instead of Browser chrome");
  assert((fullPageScreenshot.screenshot?.pageHeight ?? 0) >= 1800, "full-page screenshot reports full document height");
  assert((fullPageScreenshot.screenshot?.height ?? 0) > 1200, "full-page screenshot PNG height exceeds the visible Browser viewport");

  const passwordRef = fixtureObserve.observation?.refs?.find((ref) => ref.role === "password" && ref.selector === "input[name=\"Passwd\"]");
  assert(passwordRef?.editable === true && passwordRef.action === "fillRef", "observe returns a strict executable selector for named password fields");
  assert((passwordRef?.strictMatchCount ?? 0) === 1, "named password ref is strict");
  const richRef = fixtureObserve.observation?.refs?.find((ref) => ref.selector === "#rich-editor");
  assert(richRef?.editable === true && richRef.action === "fillRef", "observe returns editable metadata for fixture rich editor");
  const choiceRef = fixtureObserve.observation?.refs?.find((ref) => ref.selector === "#choice-card");
  assert(Boolean(choiceRef), "observe returns custom radio cards as clickable refs");
  assert(choiceRef!.role === "radio" && choiceRef!.action === "clickRef", "custom radio card ref has clickable metadata");
  assert(choiceRef!.visible === true && choiceRef!.enabled === true, "custom radio card ref is visible and enabled");

  const fill = await api<BrowserActionResponse>(ctx, "POST", "/browser/action", {
    taskId: controlTask.taskId,
    action: "fillRef",
    selector: "#agent-input",
    value: "Canvas beta",
  });
  assert(fill.status === "applied", "fillRef applies through the native Browser engine");
  assert(fill.actionability?.visible === true && fill.actionability?.editable === true, "fillRef returns successful actionability evidence");
  assert(Boolean(fill.receipt?.evidence?.actionability) && typeof fill.receipt?.evidence?.actionability === "object", "fillRef receipt includes actionability evidence");
  assert(fill.stepSummary?.action === "fillRef" && fill.stepSummary.status === "applied", "fillRef returns compact step summary");
  assert((fill.stepSummary?.refs ?? 0) > 0 && (fill.stepSummary?.nextActions?.length ?? 0) > 0, "compact step summary carries bounded next-action context");
  assert(!JSON.stringify(fill.stepSummary).includes("Canvas beta"), "compact step summary omits raw typed values");

  const passwordFill = await api<BrowserActionResponse>(ctx, "POST", "/browser/action", {
    taskId: controlTask.taskId,
    action: "fillRef",
    refId: passwordRef?.refId,
    value: "fixture-password",
  });
  assert(passwordFill.status === "applied", "fillRef applies through a named password ref from observe");
  assert(passwordFill.actionability?.selector === passwordRef?.selector, "password ref resolves to the strict observed selector");
  assert(!JSON.stringify(passwordFill).includes("fixture-password"), "password fill response omits raw typed value");

  const richFill = await api<BrowserActionResponse>(ctx, "POST", "/browser/action", {
    taskId: controlTask.taskId,
    action: "fillRef",
    selector: "#rich-editor",
    value: "Rich beta",
  });
  assert(richFill.status === "applied", "fillRef applies to a contenteditable fixture");
  assert(richFill.actionability?.editable === true, "contenteditable fillRef returns editable actionability evidence");

  const clickApply = await api<BrowserActionResponse>(ctx, "POST", "/browser/action", {
    taskId: controlTask.taskId,
    action: "clickRef",
    selector: "#apply",
  });
  assert(clickApply.status === "applied", "clickRef applies through the native Browser engine");
  assert(clickApply.actionability?.visible === true && clickApply.actionability?.receivesEvents === true, "clickRef returns successful actionability evidence");

  const richResult = await api<BrowserActionResponse>(ctx, "POST", "/browser/action", {
    taskId: controlTask.taskId,
    action: "verify",
    key: "text",
    value: "Rich Rich beta beforeOk=true inputOk=true",
  });
  assert(richResult.status === "applied", "contenteditable fillRef emits browser text input events visible to page code");

  const choiceClick = await api<BrowserActionResponse>(ctx, "POST", "/browser/action", {
    taskId: controlTask.taskId,
    action: "clickRef",
    refId: choiceRef!.refId,
  });
  assert(choiceClick.status === "applied", "clickRef applies through a custom radio card ref");
  const choiceResult = await api<BrowserActionResponse>(ctx, "POST", "/browser/action", {
    taskId: controlTask.taskId,
    action: "verify",
    key: "text",
    value: "Choice card selected",
  });
  assert(choiceResult.status === "applied", "custom radio card click mutates fixture state");

  const hiddenClick = await api<BrowserActionResponse>(ctx, "POST", "/browser/action", {
    taskId: controlTask.taskId,
    action: "clickRef",
    selector: "#hidden-action",
  });
  assert(hiddenClick.status === "notActionable", "hidden fixture click reports notActionable");
  assert(hiddenClick.actionability?.visible === false, "hidden fixture click records visible:false");
  assert(hiddenClick.stepSummary?.snapshotId === passwordStepObserve.observation?.snapshotId, "notActionable step summary preserves the latest snapshot id agents acted from");
  assert(hiddenClick.stepSummary?.targetSelector === "#hidden-action", "notActionable step summary records the selector used");
  assert(hiddenClick.stepSummary?.failedChecks?.includes("visible") === true, "notActionable step summary records failed actionability checks");
  assert(hiddenClick.stepSummary?.needsObserve === true, "notActionable step summary asks the agent to re-observe");
  assert(Boolean(hiddenClick.stepSummary?.recoveryHints?.some((hint) => hint.includes("Re-observe"))), "notActionable step summary includes recovery guidance");

  const coveredClick = await api<BrowserActionResponse>(ctx, "POST", "/browser/action", {
    taskId: controlTask.taskId,
    action: "clickRef",
    selector: "#covered-action",
  });
  assert(coveredClick.status === "notActionable", "covered fixture click reports notActionable");
  assert(coveredClick.actionability?.receivesEvents === false, "covered fixture click records receivesEvents:false");
  assert(coveredClick.actionability?.coveringElement?.selector === "#cover-layer", "covered fixture click reports the covering element selector");
  assert(coveredClick.stepSummary?.failedChecks?.includes("receivesEvents") === true, "covered fixture step summary includes receivesEvents failed check");

  const startDelayed = await api<BrowserActionResponse>(ctx, "POST", "/browser/action", {
    taskId: controlTask.taskId,
    action: "clickRef",
    selector: "#start-delayed",
  });
  assert(startDelayed.status === "applied", "delayed fixture trigger click applies");
  const waitDelayed = await api<BrowserActionResponse>(ctx, "POST", "/browser/action", {
    taskId: controlTask.taskId,
    action: "waitFor",
    value: "Delayed Browser ready",
    timeoutMs: 3_000,
  });
  assert(waitDelayed.status === "applied", "waitFor polls until delayed fixture text appears");

  const waitClicked = await api<BrowserActionResponse>(ctx, "POST", "/browser/action", {
    taskId: controlTask.taskId,
    action: "waitFor",
    value: "Clicked Canvas beta",
  });
  assert(waitClicked.status === "applied", "waitFor observes deterministic page mutation");

  const verifyText = await api<BrowserActionResponse>(ctx, "POST", "/browser/action", {
    taskId: controlTask.taskId,
    action: "verify",
    key: "text",
    value: "Clicked Canvas beta",
  });
  assert(verifyText.status === "applied", "verify text applies through the native Browser engine");
  assert(verifyText.verification?.passed === true && verifyText.receipt?.kind === "browserVerificationPassed", "verify text emits browserVerificationPassed receipt");

  const verifyUrl = await api<BrowserActionResponse>(ctx, "POST", "/browser/action", {
    taskId: controlTask.taskId,
    action: "verify",
    key: "url",
    value: "127.0.0.1",
  });
  assert(verifyUrl.verification?.passed === true, "verify URL checks current Browser URL");

  const verifyElement = await api<BrowserActionResponse>(ctx, "POST", "/browser/action", {
    taskId: controlTask.taskId,
    action: "verify",
    key: "element",
    selector: "#result",
  });
  assert(verifyElement.verification?.passed === true, "verify element checks visible selector state");

  const table = await api<BrowserActionResponse>(ctx, "POST", "/browser/action", {
    taskId: controlTask.taskId,
    action: "extractTable",
    selector: "#data-table",
  });
  assert(table.status === "applied", "extractTable applies through the native Browser engine");
  assert(Boolean(table.extractedText?.includes("Alpha")), "extractTable returns fixture table data");

  const verifyTable = await api<BrowserActionResponse>(ctx, "POST", "/browser/action", {
    taskId: controlTask.taskId,
    action: "verify",
    key: "table",
    selector: "#data-table",
    value: "Alpha",
  });
  assert(verifyTable.verification?.passed === true, "verify table checks table cell text");

  const verifySchema = await api<BrowserActionResponse>(ctx, "POST", "/browser/action", {
    taskId: controlTask.taskId,
    action: "verify",
    key: "schema",
    value: JSON.stringify({
      text: "Clicked Canvas beta",
      urlContains: "127.0.0.1",
      selectors: ["#result", "#data-table"],
    }),
  });
  assert(verifySchema.verification?.passed === true, "verify schema checks text, URL, and selectors");

  const findText = await api<BrowserActionResponse>(ctx, "POST", "/browser/action", {
    taskId: controlTask.taskId,
    action: "findText",
    value: "Clicked Canvas beta",
  });
  assert(findText.status === "applied", "findText applies when visible text is present");
  assert((findText.findResult?.matchCount ?? 0) > 0, "findText returns positive match count");
  assert(findText.findResult?.scrolled === true, "findText scrolls the first match into view");
  assert(findText.receipt?.kind === "browserFindTextCompleted", "findText emits browserFindTextCompleted receipt");

  const findMissing = await api<BrowserActionResponse>(ctx, "POST", "/browser/action", {
    taskId: controlTask.taskId,
    action: "findText",
    value: "Definitely missing Browser smoke text",
  });
  assert(findMissing.status === "notFound", "findText reports notFound for absent text");
  assert(findMissing.findResult?.matchCount === 0, "findText absent result returns zero matches");

  const verifyMissing = await api<BrowserActionResponse>(ctx, "POST", "/browser/action", {
    taskId: controlTask.taskId,
    action: "verify",
    key: "text",
    value: "Definitely missing Browser smoke text",
  });
  assert(verifyMissing.status === "failed", "verify missing text returns failed status");
  assert(verifyMissing.verification?.passed === false && verifyMissing.receipt?.kind === "browserVerificationFailed", "verify missing text emits browserVerificationFailed receipt");

  const scrollDown = await api<BrowserActionResponse>(ctx, "POST", "/browser/action", {
    taskId: controlTask.taskId,
    action: "scroll",
    value: "900",
  });
  assert(scrollDown.status === "applied", "scroll applies through the native Browser engine");

  const scrollToMarker = await api<BrowserActionResponse>(ctx, "POST", "/browser/action", {
    taskId: controlTask.taskId,
    action: "scroll",
    selector: "#bottom-marker",
  });
  assert(scrollToMarker.status === "applied", "scroll can target a fixture element selector");

  const traceSecretLog = await api<BrowserConsoleLog>(ctx, "POST", "/browser/logs", {
    taskId: controlTask.taskId,
    level: "error",
    source: "trace-redaction-fixture",
    message: "SXV_BROWSER_TRACE_SECRET_1234567890abcdef1234567890abcdef",
    url: fixture!.url,
  });
  assert(!traceSecretLog.message.includes("SXV_BROWSER_TRACE_SECRET"), "trace fixture console sentinel is redacted before storage");

  const recipeExport = await api<BrowserRecipeExportResponse>(ctx, "POST", "/browser/recipes/export", {
    taskId: controlTask.taskId,
    reason: "Debug API smoke needs a reusable Browser recipe",
  });
  assert(recipeExport.recipeId.startsWith("browser-recipe-"), "recipe export returns recipe id");
  assert(isShellxBrowserArtifactPath(recipeExport.path, "shellx-browser-recipes"), "recipe export returns ShellX Browser recipe artifact path");
  assert(recipeExport.steps > 0, "recipe export records replay steps");
  assert(/^[a-f0-9]{64}$/i.test(recipeExport.sha256), "recipe export returns SHA-256");
  assert(recipeExport.receipt.kind === "browserRecipeExported", "recipe export emits browserRecipeExported receipt");
  const recipeArtifactPath = hostReadablePath(recipeExport.path);
  const recipeArtifactText = readFileSync(recipeArtifactPath, "utf8");
  const recipeJson = JSON.parse(recipeArtifactText) as JsonObject;
  assert(recipeJson.schemaVersion === 2, "recipe export records the Action Recipe V2 schema version");
  assert(typeof recipeJson.goal === "string" && recipeJson.goal.includes("Smoke test"), "recipe export records a reusable workflow goal");
  assert(Array.isArray(recipeJson.variableInputs), "recipe export records variable input declarations");
  assert(Array.isArray(recipeJson.assertions), "recipe export records verification assertions");
  assert(Array.isArray(recipeJson.decisionPoints), "recipe export records decision point placeholders");
  assert(Array.isArray(recipeJson.sourceReceipts), "recipe export records bounded source receipt references");
  assert((recipeJson.redactionPolicy as JsonObject)?.rawInputValues === false, "recipe export records raw input redaction");
  assert(!JSON.stringify(recipeJson).includes("Canvas beta"), "recipe export omits raw typed fixture values");

  const recipeReplay = await api<BrowserRecipeReplayResponse>(ctx, "POST", "/browser/recipes/replay", {
    taskId: controlTask.taskId,
    recipePath: recipeExport.path,
    dryRun: true,
    reason: "Debug API smoke dry-runs a Browser recipe",
  });
  assert(recipeReplay.ok && recipeReplay.dryRun === true, "recipe replay supports dry-run mode");
  assert(recipeReplay.stepsPlanned === recipeExport.steps, "recipe replay counts planned steps from recipe artifact");
  assert(recipeReplay.stepsApplied === 0, "recipe dry-run does not apply steps");
  assert(Array.isArray(recipeReplay.decisionPoints), "recipe replay returns decision points for dry-run recovery");
  assert(recipeReplay.decisionPoints.length === (recipeJson.decisionPoints as unknown[]).length, "recipe replay decision points match the exported recipe");
  assert(recipeReplay.receipt.kind === "browserRecipeReplayCompleted", "recipe replay emits browserRecipeReplayCompleted receipt");

  const scheduledRobot = await api<BrowserRobotJob>(ctx, "POST", "/browser/robots/schedule", {
    taskId: controlTask.taskId,
    recipePath: recipeExport.path,
    kind: "recipeReplay",
    reason: "Debug API smoke schedules a Browser recipe robot",
  });
  assert(scheduledRobot.jobId.startsWith("browser-robot-") && scheduledRobot.status === "scheduled", "robot schedule creates a queued Browser job");
  assert(scheduledRobot.receipt.kind === "browserRobotScheduled", "robot schedule emits browserRobotScheduled receipt");
  const robotsList = await api<{ robots: BrowserRobotJob[] }>(ctx, "GET", "/browser/robots?limit=20");
  assert(robotsList.robots.some((job) => job.jobId === scheduledRobot.jobId), "GET /browser/robots lists scheduled jobs");

  const robotRun = await api<BrowserRobotJob>(ctx, "POST", "/browser/robots/run", {
    jobId: scheduledRobot.jobId,
    dryRun: true,
  });
  assert(robotRun.status === "dryRunCompleted" && robotRun.attempts >= 1, "robot run supports dry-run execution");
  assert(robotRun.receipt.kind === "browserRobotRunCompleted", "robot run emits browserRobotRunCompleted receipt");
  assert(robotRun.receipt.evidence?.stepsPlanned === recipeExport.steps, "robot run executes the saved recipe dry-run planner before completion");

  const cancelRobot = await api<BrowserRobotJob>(ctx, "POST", "/browser/robots/schedule", {
    taskId: controlTask.taskId,
    recipePath: recipeExport.path,
    kind: "recipeReplay",
    reason: "Debug API smoke schedules a Browser robot for cancellation",
  });
  const cancelledRobot = await api<BrowserRobotJob>(ctx, "POST", "/browser/robots/cancel", {
    jobId: cancelRobot.jobId,
    reason: "Debug API smoke verifies cancellation",
  });
  assert(cancelledRobot.status === "cancelled", "robot cancel marks a queued job cancelled");
  assert(cancelledRobot.receipt.kind === "browserRobotCancelled", "robot cancel emits browserRobotCancelled receipt");

  let changedRecipeError = "";
  try {
    writeFileSync(recipeArtifactPath, `${recipeArtifactText}\n`, "utf8");
    changedRecipeError = await apiError(ctx, "POST", "/browser/recipes/replay", {
      taskId: controlTask.taskId,
      recipePath: recipeExport.path,
      dryRun: true,
      reason: "Debug API smoke rejects a changed Browser recipe",
    });
  } finally {
    writeFileSync(recipeArtifactPath, recipeArtifactText, "utf8");
  }
  assert(changedRecipeError.includes("does not match its export receipt"), "recipe replay rejects a changed saved artifact");

  const traceBundle = await api<BrowserTraceBundleResponse>(ctx, "POST", "/browser/trace/export", {
    taskId: controlTask.taskId,
    reason: "Debug API smoke needs a bounded Browser trace bundle",
  });
  assert(traceBundle.traceId.startsWith("browser-trace-"), "trace bundle export returns trace id");
  assert(traceBundle.taskId === controlTask.taskId, "trace bundle response preserves its exact typed task identity after payload redaction");
  assert(isShellxBrowserArtifactPath(traceBundle.path, "shellx-browser-traces"), "trace bundle export returns ShellX Browser trace artifact path");
  assert(traceBundle.bytes > 100, "trace bundle export writes non-empty JSON");
  assert(/^[a-f0-9]{64}$/i.test(traceBundle.sha256), "trace bundle export returns SHA-256");
  assert(traceBundle.receipt.kind === "browserTraceBundleExported", "trace bundle export emits browserTraceBundleExported receipt");
  assert(traceBundle.receipt.taskId === controlTask.taskId, "trace bundle receipt preserves its exact typed task identity after payload redaction");
  const traceJson = JSON.parse(readFileSync(hostReadablePath(traceBundle.path), "utf8")) as JsonObject;
  assert((traceJson.redactionPolicy as JsonObject)?.rawDom === false, "trace bundle records raw DOM redaction");
  const diagnosticsSections = traceJson.diagnosticsSections as JsonObject;
  assert(Boolean(diagnosticsSections?.console), "trace bundle records console diagnostics metadata");
  assert(Boolean(diagnosticsSections?.network), "trace bundle records network diagnostics metadata");
  assert(Boolean(diagnosticsSections?.runtimeErrors), "trace bundle records runtime-error diagnostics metadata");
  assert(Boolean(diagnosticsSections?.domStyle), "trace bundle records DOM/style diagnostics metadata");
  assert(Boolean(diagnosticsSections?.performance), "trace bundle records performance diagnostics metadata");
  assert((diagnosticsSections.network as JsonObject)?.requestHeadersRedacted === true, "trace bundle records request header redaction");
  assert((diagnosticsSections.domStyle as JsonObject)?.rawDomIncluded === false, "trace bundle records DOM redaction");
  assert((diagnosticsSections.performance as JsonObject)?.included === false, "trace bundle records performance capture as metadata-only");
  assert(!("lastObservation" in ((traceJson.task as JsonObject | null) ?? {})), "trace bundle task summary omits raw lastObservation");
  assert(!JSON.stringify(traceJson).includes("Bottom marker for Browser scroll smoke"), "trace bundle omits raw page text");
  assert(!JSON.stringify(traceJson).includes("SXV_BROWSER_TRACE_SECRET"), "trace bundle omits trace secret sentinels");

  const consoleLog = await api<BrowserConsoleLog>(ctx, "POST", "/browser/logs", {
    taskId: task.taskId,
    level: "error",
    source: "page-console",
    message: CONSOLE_ERROR_SENTINEL,
    url: "https://example.com/",
    line: 12,
    column: 4,
  });
  assert(consoleLog.level === "error", "browser console error can be recorded through debug API");
  assert(consoleLog.message === CONSOLE_ERROR_SENTINEL, "browser console error message is returned");

  const logs = await api<{ logs: BrowserConsoleLog[] }>(ctx, "GET", "/browser/logs?limit=20");
  assert(logs.logs.some((entry) => entry.message === CONSOLE_ERROR_SENTINEL), "browser console errors can be read through debug API");

  const sessionGrant = await api<{ grantId: string; status: string }>(ctx, "POST", "/browser/session-grants/request", {
    taskId: task.taskId,
    fromProfileId: "personal",
    toProfileId: "agent-work",
    reason: "Debug API smoke verifies scoped session grant receipts",
    ttlSeconds: 900,
  });
  assert(sessionGrant.grantId.startsWith("browser-grant-"), "session grant request creates grant id");
  assert(sessionGrant.status === "requested", "session grant starts requested");

  const rejectedGrantResolve = await apiError(ctx, "POST", "/browser/session-grants/resolve", {
    grantId: sessionGrant.grantId,
    approved: true,
  });
  assert(rejectedGrantResolve.includes("browser_session_grant_resolution_requires_operator"), "session grant resolve is operator-only over Debug API");

  const rejectedGrantApply = await apiError(ctx, "POST", "/browser/session-grants/apply", {
    grantId: sessionGrant.grantId,
    taskId: task.taskId,
  });
  assert(rejectedGrantApply.includes("not granted"), "session grant apply rejects unapproved grants");

  for (const route of ["/browser/vault/fill-receipt", "/browser/vault/generate-receipt"]) {
    const rejectedReceipt = await apiError(ctx, "POST", route, {
      taskId: task.taskId,
      origin: "https://example.com",
      itemId: "caller-authored-receipt",
      grantId: "caller-authored-grant",
    });
    assert(
      rejectedReceipt.includes("browser_vault_receipt_requires_verified_operation"),
      `${route} rejects caller-authored success receipts`,
    );
    assert(bodyDoesNotEchoSecret(rejectedReceipt), `${route} denial remains redacted`);
  }

  const depositKeyBaseline = await api<{ keys: string[] }>(ctx, "GET", "/vault/keys?prefix=browser-deposits%2F");
  for (const invalid of [
    { label: "   ", secretValue: SECRET_SENTINEL },
    { label: "Browser empty secret", secretValue: "" },
    { label: "Browser oversized secret", secretValue: "x".repeat(4_097) },
  ]) {
    const rejected = await apiMaybe<JsonObject>(ctx, "POST", "/browser/vault-deposits", invalid);
    if (rejected.ok || rejected.status !== 400) throw new Error("invalid Vault deposit must fail before persistence");
    assert(bodyDoesNotEchoSecret(rejected.text), "invalid Vault deposit error does not echo secret material");
  }
  const depositKeysAfterRejections = await api<{ keys: string[] }>(ctx, "GET", "/vault/keys?prefix=browser-deposits%2F");
  assert(
    recordsEqual([...depositKeysAfterRejections.keys].sort(), [...depositKeyBaseline.keys].sort()),
    "invalid Vault deposits do not create orphan browser-deposits keys",
  );

  const deposit = await api<BrowserVaultDepositResponse>(ctx, "POST", "/browser/vault-deposits", {
    taskId: task.taskId,
    label: "Browser smoke API key",
    secretValue: SECRET_SENTINEL,
    sourceUrl: "https://example.com/",
  });
  assert(deposit.depositId.startsWith("browser-deposit-"), "write-only Vault deposit returns deposit id");
  assert(deposit.serverReceipt.id === deposit.depositId, "deposit serverReceipt id matches deposit id");
  assert(deposit.serverReceipt.payloadHash === deposit.storageCommitHash, "deposit serverReceipt carries payload hash");
  assert(typeof deposit.vaultRef === "string" && deposit.vaultRef.startsWith("browser-deposits/"), "write-only Vault deposit persists to a Vault ref");
  assert(bodyDoesNotEchoSecret(deposit), "write-only Vault deposit response does not echo secret");
  depositVaultRef = deposit.vaultRef ?? null;

  for (const [action, expected] of [
    ["submitFinal", "finalActionApproval"],
    ["delete", "destructiveActionApproval"],
    ["clearHistory", "destructiveActionApproval"],
    ["uploadFile", "fileGrant"],
    ["downloadFile", "downloadApproval"],
  ] as const) {
    const gated = await api<BrowserActionResponse>(ctx, "POST", "/browser/action", {
      taskId: task.taskId,
      action,
      refId: "page",
    });
    assert(gated.status === "blocked", `${action} is blocked`);
    assert(gated.requiredApproval === expected, `${action} requires ${expected}`);
  }

  const deniedVaultFill = await api<VaultProbeResponse>(ctx, "POST", "/vault/e2e/probe-use", {
    grantId: "grant-missing",
    secretRef: "missing/browser-password",
    operation: "fill",
    actor: { agentId: "shellx-browser-agent", origin: new URL(fixture.url).origin },
  });
  assert(
    deniedVaultFill.ok === false && deniedVaultFill.decision === "deny" && deniedVaultFill.reason === "grantNotFound",
    "Vault probe rejects a missing grant before Browser fill",
  );
  assert(deniedVaultFill.secretPresent === false, "missing Browser fill secret remains absent");
  assert(bodyDoesNotEchoSecret(deniedVaultFill), "denied Vault fill response does not echo secret sentinel");

  const vaultGrantSecretRef = `000-smoke/browser-debug-grant-${Date.now()}`;
  const vaultUserOnlySecretRef = `${vaultGrantSecretRef}-user-only`;
  const seedVaultGrantSecret = await apiMaybe<VaultSetResponse>(ctx, "POST", "/vault/set", {
    key: vaultGrantSecretRef,
    value: SECRET_SENTINEL,
    description: "Disposable Browser grant smoke password",
    userOnly: false,
  });
  if (!seedVaultGrantSecret.ok && seedVaultGrantSecret.status === 403) {
    assert(
      seedVaultGrantSecret.text.includes("vault_write_requires_operator") ||
        seedVaultGrantSecret.text.includes("vault_e2e_profile_not_isolated"),
      "Vault grant smoke skips writes unless SHELLX_VAULT_E2E=1 and disposable SHELLX_VAULT_PROFILE_DIR are enabled",
    );
  } else {
    const seededSecretRefs = [vaultGrantSecretRef];
    try {
      if (!seedVaultGrantSecret.ok) {
        throw new Error(`POST /vault/set failed ${seedVaultGrantSecret.status}: ${seedVaultGrantSecret.text}`);
      }
      assert(seedVaultGrantSecret.value.ok === true, "Vault grant smoke seeds disposable agent-visible secret");
      assert(bodyDoesNotEchoSecret(seedVaultGrantSecret.value), "Vault grant seed response does not echo the disposable secret");

      const approvedVaultGrant = await api<VaultApprovedGrantResponse>(ctx, "POST", "/vault/e2e/approve-grant", {
        secretRef: vaultGrantSecretRef,
        actorScope: { kind: "allShellxAgents" },
        operation: "fill",
        origin: new URL(fixture.url).origin,
        expiresAtMs: Date.now() + 10 * 60 * 1000,
      });
      assert(approvedVaultGrant.ok === true && approvedVaultGrant.grant.approved === true, "Vault E2E grant can approve mediated Browser fill");
      assert(approvedVaultGrant.grant.origin === new URL(fixture.url).origin, "Vault E2E Browser grant remains bound to the exact fixture origin");
      assert(approvedVaultGrant.secretExposed === false && bodyDoesNotEchoSecret(approvedVaultGrant), "Vault grant approval response is redacted");

      const probeAllowed = await api<VaultProbeResponse>(ctx, "POST", "/vault/e2e/probe-use", {
        grantId: approvedVaultGrant.grant.grantId,
        secretRef: vaultGrantSecretRef,
        operation: "fill",
        actor: { agentId: "shellx-browser-agent", origin: new URL(fixture.url).origin },
      });
      assert(probeAllowed.ok === true && probeAllowed.decision === "allowMediated", "Vault approved fill grant authorizes Browser agent actor");
      assert(probeAllowed.secretPresent === true && probeAllowed.secretExposed === false, "Vault approved fill probe reports presence without value");

      const insecureFill = await api<BrowserActionResponse>(ctx, "POST", "/browser/action", {
        taskId: controlTask.taskId,
        action: "fillFromVaultGrant",
        refId: passwordRef?.refId,
        grantId: approvedVaultGrant.grant.grantId,
        secretRef: vaultGrantSecretRef,
      });
      assert(insecureFill.status === "blocked", "approved Vault fill still blocks on local HTTP credential page");
      assert(insecureFill.requiredApproval === "insecureCredentialEntryApproval", "approved Vault fill requires separate approval on insecure pages");
      assert(bodyDoesNotEchoSecret(insecureFill), "blocked approved Vault fill response does not echo the disposable secret");

      const seedUserOnly = await api<VaultSetResponse>(ctx, "POST", "/vault/set", {
        key: vaultUserOnlySecretRef,
        value: SECRET_SENTINEL,
        description: "Disposable user-only Browser grant smoke password",
        userOnly: true,
      });
      assert(seedUserOnly.ok === true, "Vault grant smoke seeds disposable user-only secret");
      seededSecretRefs.push(vaultUserOnlySecretRef);
      assert(bodyDoesNotEchoSecret(seedUserOnly), "Vault user-only seed response does not echo the disposable secret");

      const deniedUserOnlyGrant = await apiMaybe<VaultApprovedGrantResponse>(ctx, "POST", "/vault/e2e/approve-grant", {
        secretRef: vaultUserOnlySecretRef,
        actorScope: { kind: "allShellxAgents" },
        operation: "fill",
        origin: new URL(fixture.url).origin,
        expiresAtMs: Date.now() + 10 * 60 * 1000,
      });
      if (deniedUserOnlyGrant.ok || deniedUserOnlyGrant.status !== 400) {
        throw new Error("Vault user-only secret refuses agent grant approval");
      }
      assert(true, "Vault user-only secret refuses agent grant approval");
      assert(deniedUserOnlyGrant.text.includes("grantUserOnlySecret"), "Vault user-only grant denial reports the policy reason");
      assert(bodyDoesNotEchoSecret(deniedUserOnlyGrant.text), "Vault user-only grant denial remains redacted");

      const agentResources = await api<VaultResourcesResponse>(ctx, "GET", `/vault/resources?prefix=${encodeURIComponent(vaultGrantSecretRef)}`);
      assert(agentResources.secretExposed === false, "Vault resources planning response is redacted");
      assert(agentResources.resources.some((resource) => resource.key === vaultGrantSecretRef), "Vault resources lists disposable agent-visible secret metadata");
      assert(!agentResources.resources.some((resource) => resource.key === vaultUserOnlySecretRef), "Vault resources hides disposable user-only secret metadata from agents");
    } finally {
      for (const key of seededSecretRefs) {
        const deleted = await api<{ ok: boolean }>(ctx, "POST", "/vault/delete", { key });
        assert(deleted.ok === true, `Vault grant smoke cleanup deletes ${key}`);
        const afterDelete = await api<{ keys: string[] }>(ctx, "GET", `/vault/keys?prefix=${encodeURIComponent(key)}`);
        assert(!afterDelete.keys.includes(key), `Vault grant smoke cleanup proves ${key} absent`);
      }
    }
  }

  const rawReveal = await api<BrowserActionResponse>(ctx, "POST", "/browser/action", {
    taskId: task.taskId,
    action: "fillRef",
    refId: "secret",
    sensitiveKind: "rawSecretReveal",
  });
  assert(rawReveal.status === "blocked", "raw secret reveal is blocked");
  assert(rawReveal.requiredApproval === "rawSecretRevealApproval", "raw secret reveal requires explicit approval");

  const tasksBeforePolicyDenial = await api<{ tasks: JsonObject[] }>(ctx, "GET", "/browser/tasks");
  const tabsBeforePolicyDenial = await api<{ tabs: BrowserTab[] }>(ctx, "GET", "/browser/tabs");
  const deniedLegacyAutonomy = await apiMaybe<JsonObject>(ctx, "POST", "/browser/task/start", {
    goal: "Smoke test: reject a policy label that ShellX does not enforce",
    startUrl: "https://example.com/",
    profileId: "agent-work",
    autonomy: "approvalFirst",
    expectedDomains: ["example.com"],
  });
  if (deniedLegacyAutonomy.ok || deniedLegacyAutonomy.status !== 403) {
    throw new Error("Debug API unexpectedly accepted a legacy Browser autonomy label");
  }
  assert(deniedLegacyAutonomy.text.includes("browser_task_autonomy_policy_fixed"), "legacy Browser autonomy denial exposes a stable machine-readable code");
  const tasksAfterPolicyDenial = await api<{ tasks: JsonObject[] }>(ctx, "GET", "/browser/tasks");
  const tabsAfterPolicyDenial = await api<{ tabs: BrowserTab[] }>(ctx, "GET", "/browser/tabs");
  assert(
    tasksAfterPolicyDenial.tasks.length === tasksBeforePolicyDenial.tasks.length &&
      tabsAfterPolicyDenial.tabs.length === tabsBeforePolicyDenial.tabs.length,
    "rejected Browser autonomy creates no task or tab lifecycle",
  );
  const deniedAutonomyMutation = await apiMaybe<JsonObject>(ctx, "POST", "/browser/task/autonomy", {
    taskId: task.taskId,
    autonomy: "assistedAutonomous",
  });
  if (deniedAutonomyMutation.ok || deniedAutonomyMutation.status !== 403) {
    throw new Error("Debug API unexpectedly mutated fixed Browser autonomy");
  }
  assert(deniedAutonomyMutation.text.includes("browser_task_autonomy_policy_fixed"), "Browser autonomy mutation denial exposes a stable machine-readable code");

  const operatorTask = await api<BrowserTask>(ctx, "POST", "/browser/task/start", {
    goal: "Smoke test: operator pause, resume, takeover, and abort Browser task controls",
    startUrl: "https://example.com/",
    profileId: "agent-work",
    autonomy: "assistedAutonomous",
    expectedDomains: ["example.com"],
  });
  assert(operatorTask.ownerActorId === "shellxDebugApiAgent" && operatorTask.ownerSurface === "debugApiBearer", "Browser task records its authenticated Debug API owner principal");
  const pausedTask = await api<BrowserTaskControlResponse>(ctx, "POST", "/browser/task/control", {
    taskId: operatorTask.taskId,
    action: "pause",
    reason: "debug-api smoke pause",
    requestedBy: "debug-api-smoke",
  });
  assert(pausedTask.ok === true && pausedTask.status === "paused", "browser task control can pause a task");
  assert(pausedTask.receipt.kind === "browserTaskPaused", "browser task pause emits browserTaskPaused receipt");
  assert(pausedTask.receipt.evidence?.requestedBy === "shellxDebugApiAgent", "browser task pause actor comes from the authenticated API surface");
  const blockedPausedAction = await api<BrowserActionResponse>(ctx, "POST", "/browser/action", {
    taskId: operatorTask.taskId,
    action: "observe",
  });
  assert(blockedPausedAction.status === "taskPaused", "paused browser task blocks agent actions");
  assert(blockedPausedAction.receipt?.kind === "browserTaskActionBlocked", "paused task action block emits browserTaskActionBlocked receipt");
  const resumedTask = await api<BrowserTaskControlResponse>(ctx, "POST", "/browser/task/control", {
    taskId: operatorTask.taskId,
    action: "resume",
    requestedBy: "debug-api-smoke",
  });
  assert(resumedTask.status === "running", "browser task control can resume a paused task");
  assert(resumedTask.receipt.kind === "browserTaskResumed", "browser task resume emits browserTaskResumed receipt");
  assert(resumedTask.receipt.evidence?.requestedBy === "shellxDebugApiAgent", "browser task resume ignores a forged requestedBy actor");
  const deniedTakeover = await apiMaybe<JsonObject>(ctx, "POST", "/browser/task/control", {
    taskId: operatorTask.taskId,
    action: "userTakeover",
    reason: "debug-api smoke user takeover",
    requestedBy: "debug-api-smoke",
  });
  if (deniedTakeover.ok || deniedTakeover.status !== 403) {
    throw new Error("Debug API unexpectedly claimed operator user takeover");
  }
  assert(true, "Debug API cannot claim operator user takeover");
  assert(deniedTakeover.text.includes("browser_task_operator_control_required"), "takeover denial exposes a stable machine-readable code");
  const abortedTask = await api<BrowserTaskControlResponse>(ctx, "POST", "/browser/task/control", {
    taskId: operatorTask.taskId,
    action: "abort",
    reason: "debug-api smoke abort",
    requestedBy: "debug-api-smoke",
  });
  assert(abortedTask.status === "aborted", "browser task control can abort a task");
  assert(abortedTask.receipt.kind === "browserTaskAborted", "browser task abort emits browserTaskAborted receipt");
  assert(abortedTask.receipt.evidence?.requestedBy === "shellxDebugApiAgent", "browser task abort actor comes from the authenticated API surface");
  const blockedAbortAction = await api<BrowserActionResponse>(ctx, "POST", "/browser/action", {
    taskId: operatorTask.taskId,
    action: "observe",
  });
  assert(blockedAbortAction.status === "taskAborted", "aborted browser task blocks agent actions");

  const report = await api<{ reportId: string; receipt: { kind: string } }>(ctx, "POST", "/browser/report", {
    taskId: task.taskId,
    title: "Browser Debug API Smoke",
    body: "Read-only extraction, session grant, deposit, and hard gates were exercised.",
  });
  assert(report.reportId.startsWith("browser-report-"), "report route creates report receipt");
  assert(report.receipt.kind === "browserReportWritten", "report receipt kind is browserReportWritten");

  const finish = await api<BrowserTask>(ctx, "POST", "/browser/task/finish", {
    taskId: task.taskId,
    status: "completed",
  });
  assert(finish.status === "completed", "browser task can be completed through debug API");

  const receipts = await api<{ receipts: Array<{ kind: string; taskId?: string | null }> }>(ctx, "GET", "/browser/receipts?limit=200");
  for (const kind of [
    "browserTaskStarted",
    "browserBookmarkSaved",
    "browserCdpAccessRequested",
    "browserEngineActionApplied",
    "browserEngineObserved",
    "browserMarkdownExtracted",
    "browserVerificationPassed",
    "browserVerificationFailed",
    "browserHarExported",
    "browserPerformanceExported",
    "browserRecipeExported",
    "browserRecipeReplayCompleted",
    "browserRobotScheduled",
    "browserRobotRunCompleted",
    "browserRobotCancelled",
    "browserTraceBundleExported",
    "browserStorageStateManifestExported",
    "browserDialogRecorded",
    "browserPopupRecorded",
    "browserNetworkObserved",
    "browserDownloadRequested",
    "browserUploadRequested",
    "browserConsoleError",
    "browserSessionGrantRequested",
    "browserVaultDepositCreated",
    "browserTaskPaused",
    "browserTaskResumed",
    "browserTaskAborted",
    "browserTaskActionBlocked",
    "browserReportWritten",
    "browserWorkflowCompleted",
  ]) {
    assert(receipts.receipts.some((receipt) => receipt.kind === kind), `receipt log includes ${kind}`);
  }
  assert(
    !receipts.receipts.some((receipt) => receipt.kind === "browserTaskUserTakeover" && receipt.taskId === operatorTask.taskId),
    "denied Debug API takeover does not emit a successful user-takeover receipt",
  );

  console.log("ShellX Browser live Debug API smoke passed");
  } finally {
    try {
      if (depositVaultRef) {
        const deleted = await api<{ ok: boolean }>(ctx, "POST", "/vault/delete", { key: depositVaultRef });
        assert(deleted.ok === true, "write-only Vault deposit cleanup deletes its exact owned key");
        const afterDelete = await api<{ keys: string[] }>(ctx, "GET", `/vault/keys?prefix=${encodeURIComponent(depositVaultRef)}`);
        assert(!afterDelete.keys.includes(depositVaultRef), "write-only Vault deposit cleanup proves its key absent");
      }
      const current = await api<BrowserState>(ctx, "GET", "/browser/state");
      await cleanupOwnedBrowserLifecycle(
        (method, path, body) => api(ctx, method, path, body),
        {
          taskIds: (current.tasks ?? [])
            .map((task) => task.taskId)
            .filter((taskId) => !baselineTaskIds.has(taskId)),
          tabIds: (current.tabs ?? [])
            .map((tab) => tab.browserTabId)
            .filter((tabId) => !baselineTabIds.has(tabId)),
          label: "browser-debug-api",
        },
      );
    } finally {
      await fixture?.close();
    }
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
