import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shellxHomeCandidates } from "./shellx-debug-paths";

type Json = Record<string, unknown>;

interface DebugHighlightResult {
  id?: string;
  selector?: string;
  status?: string;
  message?: string | null;
  rect?: { left: number; top: number; width: number; height: number } | null;
}

interface BrowserSessionGrant {
  grantId: string;
  status: string;
}

interface BrowserVaultDepositResponse {
  depositId: string;
}

interface VaultGrant {
  grantId: string;
  secretRef: string;
  approved: boolean;
  revoked: boolean;
}

interface VaultGrantsResponse {
  grants?: VaultGrant[];
}

interface BrowserTask {
  taskId: string;
  profileId: string;
}

interface BrowserState {
  sessionGrants?: BrowserSessionGrant[];
  vaultDeposits?: BrowserVaultDepositResponse[];
  tasks?: BrowserTask[];
  activeTaskId?: string | null;
}

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
  console.log(`  ✓ ${message}`);
}

function readTrim(path: string): string | null {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return null;
  }
}

let localE2eProfileDir: string | null = null;

function e2eProfileDirForLocalLaunch(): string {
  if (process.env.SHELLX_VAULT_PROFILE_DIR?.trim()) return process.env.SHELLX_VAULT_PROFILE_DIR.trim();
  if (!localE2eProfileDir) {
    localE2eProfileDir = mkdtempSync(join(tmpdir(), "shellx-vault-e2e-"));
  }
  return localE2eProfileDir;
}

interface DebugConnection {
  shellxHome: string;
  base: string;
  token: string;
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
      if (res.ok) return { shellxHome: dir, base, token };
      errors.push(`${dir}: /health ${res.status}`);
    } catch (err) {
      errors.push(`${dir}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  throw new Error(`ShellX debug API is not reachable from candidate homes: ${errors.join("; ")}`);
}

function ensureMainShellxWindowVisible(): void {
  const localCandidates = [
    process.env.SHELLX_REQUEST_CENTER_APP_EXE,
    join(process.cwd(), "src-tauri", "target", "release", "app"),
    join(process.cwd(), "src-tauri", "target", "debug", "app"),
  ].filter((entry): entry is string => Boolean(entry));
  const localExe = localCandidates.find((candidate) => existsSync(candidate));
  if (localExe) {
    try {
      execFileSync(localExe, [], {
        stdio: "ignore",
        env: {
          ...process.env,
          SHELLX_VAULT_E2E: "1",
          SHELLX_VAULT_PROFILE_DIR: e2eProfileDirForLocalLaunch(),
        },
        timeout: 5_000,
      });
    } catch {
      // If the primary app is already focused or the platform refuses focus,
      // the rendered highlight wait below remains the source of truth.
    }
    return;
  }
  if (process.env.SHELLX_REQUEST_CENTER_START_INSTALLED !== "1") return;
  try {
    execFileSync("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      [
        "$candidates=@(",
        "(Join-Path $env:LOCALAPPDATA 'shellX\\shellx.exe'),",
        "(Join-Path $env:LOCALAPPDATA 'shellx\\shellx.exe'),",
        "'C:\\Users\\FixtureUser\\AppData\\Local\\shellX\\shellx.exe',",
        "'C:\\Users\\FixtureUser\\AppData\\Local\\shellx\\shellx.exe'",
        ");",
        "$exe=$candidates | Where-Object { Test-Path $_ } | Select-Object -First 1;",
        "$env:SHELLX_VAULT_E2E='1';",
        "$vaultProfile=$env:SHELLX_VAULT_PROFILE_DIR;",
        "if (-not $vaultProfile) { $vaultProfile=Join-Path $env:TEMP ('shellx-vault-e2e-' + [guid]::NewGuid().ToString('N')) };",
        "New-Item -ItemType Directory -Force -Path $vaultProfile | Out-Null;",
        "$env:SHELLX_VAULT_PROFILE_DIR=$vaultProfile;",
        "if ($exe) { Start-Process -FilePath $exe; Start-Sleep -Seconds 2 }",
      ].join(" "),
    ], { stdio: "ignore" });
  } catch {
    // Non-Windows/dev runs can still pass if the main renderer is already alive.
  }
}

function restartInstalledShellxVaultE2e(): void {
  execFileSync("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    [
      "$ErrorActionPreference='Stop';",
      "Get-Process shellx -ErrorAction SilentlyContinue | Stop-Process -Force;",
      "Start-Sleep -Milliseconds 700;",
      "$candidates=@(",
      "(Join-Path $env:LOCALAPPDATA 'shellX\\shellx.exe'),",
      "(Join-Path $env:LOCALAPPDATA 'shellx\\shellx.exe')",
      ");",
      "$exe=$candidates | Where-Object { Test-Path $_ } | Select-Object -First 1;",
      "if (-not $exe) { throw 'installed shellX executable not found' };",
      "$vaultProfile=Join-Path $env:TEMP ('shellx-vault-e2e-' + [guid]::NewGuid().ToString('N'));",
      "New-Item -ItemType Directory -Force -Path $vaultProfile | Out-Null;",
      "$env:SHELLX_VAULT_E2E='1';",
      "$env:SHELLX_VAULT_PROFILE_DIR=$vaultProfile;",
      "Start-Process -FilePath $exe;",
      "Start-Sleep -Seconds 5;",
    ].join(" "),
  ], { stdio: "ignore" });
}

async function reconnectAfterInstalledVaultE2eRestart(): Promise<DebugConnection> {
  restartInstalledShellxVaultE2e();
  const connection = await resolveDebugConnection();
  await waitFor("Vault E2E reset route becomes available after isolated relaunch", async () => {
    return await resetVaultE2eIfAvailable(connection.base, connection.token) ? { ok: true } : null;
  }, 12_000, 500);
  return connection;
}

function hasStaleBrowserVaultRequests(state: BrowserState): boolean {
  return (state.vaultDeposits?.length ?? 0) > 0
    || (state.sessionGrants?.some((grant) => grant.status === "requested") ?? false);
}

async function focusMainShellxWindow(base: string, token: string): Promise<void> {
  try {
    await api<Json>(base, token, "POST", "/vault/open-panel");
    await sleep(400);
    await postAppUi(base, token, {
      source: "vault-request-center-ui-smoke",
      openModal: "close",
      debugHighlights: [],
    });
    await sleep(150);
    return;
  } catch {
    ensureMainShellxWindowVisible();
    await sleep(500);
  }
}

async function request(base: string, token: string, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  return fetch(`${base}${path}`, { ...init, headers });
}

async function api<T>(
  base: string,
  token: string,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<T> {
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

async function postAppUi(base: string, token: string, body: Json): Promise<void> {
  await api(base, token, "POST", "/state/ui", { debugSurface: "app", ...body });
}

async function postAppUiForbidden(base: string, token: string, body: Json): Promise<void> {
  const res = await request(base, token, "/state/ui", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ debugSurface: "app", ...body }),
  });
  const text = await res.text();
  if (res.status !== 403 || !text.includes("debug_ui_human_only_control")) {
    throw new Error(`expected /state/ui human-only denial, got ${res.status}: ${text}`);
  }
}

async function resetVaultE2eIfAvailable(base: string, token: string): Promise<boolean> {
  const res = await request(base, token, "/vault/e2e/reset", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  if (res.ok) return true;
  if (res.status === 403 || res.status === 404) return false;
  throw new Error(`vault e2e reset failed ${res.status}: ${await res.text()}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor<T>(
  label: string,
  fn: () => Promise<T | null>,
  timeoutMs = 12_000,
  intervalMs = 250,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      const result = await fn();
      if (result !== null) return result;
    } catch (err) {
      lastError = err;
    }
    await sleep(intervalMs);
  }
  throw new Error(`${label} timed out${lastError ? `: ${lastError instanceof Error ? lastError.message : String(lastError)}` : ""}`);
}

function expectedHighlights(name: string, selectors: string[], label = name): Json[] {
  return selectors.map((selector, index) => ({
    id: `${name}-${index}`,
    selector,
    label,
    color: "cyan",
  }));
}

async function waitForHighlights(
  base: string,
  token: string,
  name: string,
  selectors: string[],
  timeoutMs = 20_000,
  patch: Json = {},
): Promise<DebugHighlightResult[]> {
  const expectedIds = selectors.map((_, index) => `${name}-${index}`);
  let broadcastAttempt = 0;
  const broadcast = () => postAppUi(base, token, {
    ...patch,
    source: "vault-request-center-ui-smoke",
    debugHighlights: expectedHighlights(name, selectors, `${name}-${broadcastAttempt++}`),
  });
  await broadcast();
  let lastBroadcastMs = Date.now();
  return await waitFor(`debug highlights ${name}`, async () => {
    const ui = await api<{
      debugHighlightResults?: DebugHighlightResult[];
      debugHighlightResultsBySurface?: Record<string, DebugHighlightResult[]>;
    }>(base, token, "GET", "/state/ui");
    const appResults = ui.debugHighlightResultsBySurface?.app;
    const results = Array.isArray(appResults)
      ? appResults
      : Array.isArray(ui.debugHighlightResults)
        ? ui.debugHighlightResults
        : [];
    const byId = new Map(results.map((result) => [result.id, result]));
    const missing = expectedIds.filter((id) => {
      const result = byId.get(id);
      return result?.status !== "resolved" || !result.rect || result.rect.width <= 0 || result.rect.height <= 0;
    });
    if (missing.length === 0) return results.filter((result) => expectedIds.includes(result.id ?? ""));
    if (Date.now() - lastBroadcastMs > 1_000) {
      await broadcast();
      lastBroadcastMs = Date.now();
    }
    return null;
  }, timeoutMs);
}

async function highlightsVisible(
  base: string,
  token: string,
  name: string,
  selectors: string[],
  timeoutMs = 1_500,
): Promise<boolean> {
  await postAppUi(base, token, {
    source: "vault-request-center-ui-smoke",
    debugHighlights: expectedHighlights(name, selectors),
  });
  try {
    await waitForHighlights(base, token, name, selectors, timeoutMs);
    return true;
  } catch {
    return false;
  }
}

async function openRequestCenter(
  base: string,
  token: string,
  name: string,
  itemSelector?: string,
): Promise<void> {
  await focusMainShellxWindow(base, token);
  const selectors = [
    "[data-debug-id='vault-request-center-popover']",
    ...(itemSelector ? [itemSelector] : []),
  ];
  if (await highlightsVisible(base, token, `${name}-already-open`, selectors, 7_000)) {
    return;
  }
  if (itemSelector && await highlightsVisible(base, token, `${name}-popover-already-open`, [
    "[data-debug-id='vault-request-center-popover']",
  ], 1_000)) {
    await waitForHighlights(base, token, name, selectors);
    return;
  }
  await postAppUi(base, token, {
    source: "vault-request-center-ui-smoke",
    openModal: "close",
    debugHighlights: expectedHighlights(`${name}-header`, [
      "[data-debug-id='header-vault-request-center']",
    ]),
  });
  await waitForHighlights(base, token, `${name}-header`, [
    "[data-debug-id='header-vault-request-center']",
  ]);
  await postAppUi(base, token, {
    source: "vault-request-center-ui-smoke",
    vaultRequestCenterOpen: true,
    debugHighlights: [],
  });
  await waitForHighlights(base, token, `${name}-popover-open`, [
    "[data-debug-id='vault-request-center-popover']",
  ], 7_000);
  await waitForHighlights(base, token, name, selectors);
}

async function main(): Promise<void> {
  let { shellxHome, base, token } = await resolveDebugConnection();
  assert(true, `debug API health responds from ${shellxHome}`);
  let resetAvailable = await resetVaultE2eIfAvailable(base, token);
  if (!resetAvailable) {
    ({ shellxHome, base, token } = await reconnectAfterInstalledVaultE2eRestart());
    resetAvailable = true;
  }
  assert(resetAvailable, "Vault E2E reset route is available for Request Center smoke");
  let state = await api<BrowserState>(base, token, "GET", "/browser/state");
  if (hasStaleBrowserVaultRequests(state)) {
    ({ shellxHome, base, token } = await reconnectAfterInstalledVaultE2eRestart());
    assert(true, `Vault Request Center smoke isolated Browser request state in ${shellxHome}`);
  }
  await focusMainShellxWindow(base, token);

  state = await api<BrowserState>(base, token, "GET", "/browser/state");
  let task = state.tasks?.find((entry) => entry.taskId === state.activeTaskId) ?? null;
  if (!task) {
    await api<Json>(base, token, "POST", "/browser/open", { startUrl: "https://example.org/" });
    task = await api<BrowserTask>(base, token, "POST", "/browser/task/start", {
      goal: "Vault Request Center UI smoke",
      startUrl: "https://example.org/",
      profileId: "agent-work",
      autonomy: "assistedAutonomous",
    });
  }
  assert(Boolean(task?.taskId), "Browser task available for Vault Request Center UI smoke");

  const deposit = await api<BrowserVaultDepositResponse>(base, token, "POST", "/browser/vault-deposits", {
    taskId: task.taskId,
    label: `Header Vault Center saved login ${Date.now()}`,
    secretValue: "sxv-request-center-smoke-secret",
    sourceUrl: "https://example.org/login",
  });
  const depositSelector = `[data-request-id='browser-vault-deposit:${deposit.depositId}']`;
  await openRequestCenter(base, token, "vault-center-deposit-visible", depositSelector);
  await postAppUiForbidden(base, token, {
    source: "vault-request-center-ui-smoke",
    debugClick: `${depositSelector} [data-debug-id='vault-request-action-openVault']`,
    debugHighlights: [],
  });
  assert(true, "Header center rejects debug relay Open Vault for saved-credential request");
  await api<Json>(base, token, "POST", "/vault/open-panel");
  await waitForHighlights(base, token, "vault-center-open-vault", [
    "[data-debug-id='vault-workspace-modal']",
    "[data-debug-id='vault-filter-input']",
  ]);
  assert(true, "Header center operator path opens Vault panel");
  await postAppUi(base, token, {
    source: "vault-request-center-ui-smoke",
    openModal: "close",
    debugHighlights: [],
  });

  await openRequestCenter(base, token, "vault-center-quick-actions-visible");
  await waitForHighlights(base, token, "vault-center-quick-actions", [
    "[data-debug-id='vault-request-open-vault']",
    "[data-debug-id='vault-request-new-secret']",
    "[data-debug-id='vault-request-generate-password']",
  ]);
  await postAppUi(base, token, {
    source: "vault-request-center-ui-smoke",
    debugClick: "[data-debug-id='vault-request-open-vault']",
    debugHighlights: [],
  });
  await waitForHighlights(base, token, "vault-center-quick-open-workspace", [
    "[data-debug-id='vault-workspace-modal']",
    "[data-debug-id='vault-filter-input']",
  ]);
  assert(true, "Header center quick Open button opens Vault workspace");
  await postAppUi(base, token, {
    source: "vault-request-center-ui-smoke",
    openModal: "close",
    debugHighlights: [],
  });

  await openRequestCenter(base, token, "vault-center-quick-new-secret-visible");
  await postAppUi(base, token, {
    source: "vault-request-center-ui-smoke",
    debugClick: "[data-debug-id='vault-request-new-secret']",
    debugHighlights: [],
  });
  await waitForHighlights(base, token, "vault-center-quick-new-secret-form", [
    "[data-debug-id='vault-workspace-modal']",
    "[data-debug-id='vault-secret-key-input']",
    "[data-debug-id='vault-secret-value-input']",
  ]);
  assert(true, "Header center quick Secret button opens Vault secret form");
  await postAppUi(base, token, {
    source: "vault-request-center-ui-smoke",
    openModal: "close",
    debugHighlights: [],
  });

  await openRequestCenter(base, token, "vault-center-quick-generate-visible");
  await postAppUi(base, token, {
    source: "vault-request-center-ui-smoke",
    debugClick: "[data-debug-id='vault-request-generate-password']",
    debugHighlights: [],
  });
  await waitForHighlights(base, token, "vault-center-quick-generate-form", [
    "[data-debug-id='vault-password-generator']",
    "[data-debug-id='vault-password-generator-output']",
    "[data-debug-id='vault-password-generator-copy']",
  ]);
  assert(true, "Header center quick Generate button opens the standalone password generator");
  await postAppUi(base, token, {
    source: "vault-request-center-ui-smoke",
    debugClick: "[data-debug-id='vault-password-generator-close']",
    debugHighlights: [],
  });
  await sleep(200);

  const dismissDeposit = await api<BrowserVaultDepositResponse>(base, token, "POST", "/browser/vault-deposits", {
    taskId: task.taskId,
    label: `Header Vault Center dismissed login ${Date.now()}`,
    secretValue: "sxv-request-center-dismiss-secret",
    sourceUrl: "https://example.org/login",
  });
  const dismissSelector = `[data-request-id='browser-vault-deposit:${dismissDeposit.depositId}']`;
  await openRequestCenter(base, token, "vault-center-dismiss-visible", dismissSelector);
  await postAppUiForbidden(base, token, {
    source: "vault-request-center-ui-smoke",
    debugClick: `${dismissSelector} [data-debug-id='vault-request-action-dismissDeposit']`,
    debugHighlights: [],
  });
  await openRequestCenter(base, token, "vault-center-dismiss-still-visible-after-relay-denial", dismissSelector);
  assert(true, "Header center rejects debug relay Done for saved-credential reminder");

  const browserGrant = await api<BrowserSessionGrant>(base, token, "POST", "/browser/session-grants/request", {
    taskId: task.taskId,
    fromProfileId: "personal",
    toProfileId: "agent-work",
    reason: "Header Vault Request Center relay-denial smoke",
    ttlSeconds: 900,
  });
  const approveSelector = `[data-request-id='browser-session-grant:${browserGrant.grantId}']`;
  await waitFor("Header center sees Browser approval grant", async () => {
    state = await api<BrowserState>(base, token, "GET", "/browser/state");
    const grant = state.sessionGrants?.find((entry) => entry.grantId === browserGrant.grantId);
    return grant?.status === "requested" ? grant : null;
  });
  await openRequestCenter(base, token, "vault-center-browser-grant-visible", approveSelector);
  await postAppUiForbidden(base, token, {
    source: "vault-request-center-ui-smoke",
    debugClick: `${approveSelector} [data-debug-id='vault-request-action-approveBrowserGrant']`,
    debugHighlights: [],
  });
  await waitFor("Header center approve relay keeps Browser grant requested", async () => {
    const next = await api<BrowserState>(base, token, "GET", "/browser/state");
    const grant = next.sessionGrants?.find((entry) => entry.grantId === browserGrant.grantId);
    return grant?.status === "requested" ? grant : null;
  });
  assert(true, "Header center rejects debug relay approve for Browser grant");

  await postAppUiForbidden(base, token, {
    source: "vault-request-center-ui-smoke",
    debugClick: `${approveSelector} [data-debug-id='vault-request-action-denyBrowserGrant']`,
    debugHighlights: [],
  });
  await waitFor("Header center deny relay keeps Browser grant requested", async () => {
    const next = await api<BrowserState>(base, token, "GET", "/browser/state");
    const grant = next.sessionGrants?.find((entry) => entry.grantId === browserGrant.grantId);
    return grant?.status === "requested" ? grant : null;
  });
  assert(true, "Header center rejects debug relay deny for Browser grant");

  const vaultGrant = await api<{ ok: true; grant: VaultGrant }>(base, token, "POST", "/vault/grants", {
    secretRef: `000-smoke/request-center-relay-${Date.now()}`,
    operation: "fill",
    actorScope: { kind: "allShellxAgents" },
  });
  const vaultGrantSelector = `[data-request-id='vault-grant:${vaultGrant.grant.grantId}']`;
  await openRequestCenter(base, token, "vault-center-vault-grant-visible", vaultGrantSelector);
  await postAppUiForbidden(base, token, {
    source: "vault-request-center-ui-smoke",
    debugClick: `${vaultGrantSelector} [data-debug-id='vault-request-action-approveVaultGrant']`,
    debugHighlights: [],
  });
  await waitFor("Header center approve relay keeps pending Vault grant pending", async () => {
    const next = await api<VaultGrantsResponse>(base, token, "GET", "/vault/grants");
    const grant = next.grants?.find((entry) => entry.grantId === vaultGrant.grant.grantId);
    return grant?.approved === false && grant.revoked === false ? grant : null;
  });
  assert(true, "Header center rejects debug relay approve for Vault grant");

  await postAppUiForbidden(base, token, {
    source: "vault-request-center-ui-smoke",
    debugClick: `${vaultGrantSelector} [data-debug-id='vault-request-action-denyVaultGrant']`,
    debugHighlights: [],
  });
  await waitFor("Header center deny relay keeps pending Vault grant pending", async () => {
    const next = await api<VaultGrantsResponse>(base, token, "GET", "/vault/grants");
    const grant = next.grants?.find((entry) => entry.grantId === vaultGrant.grant.grantId);
    return grant?.approved === false && grant.revoked === false ? grant : null;
  });
  assert(true, "Header center rejects debug relay deny for Vault grant");

  console.log("Vault Request Center installed UI smoke passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
