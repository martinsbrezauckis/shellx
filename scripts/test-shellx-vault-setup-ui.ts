import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { shellxHomeCandidates } from "./shellx-debug-paths";

type Json = Record<string, unknown>;

interface DebugHighlightResult {
  id?: string;
  selector?: string;
  status?: string;
  message?: string | null;
  rect?: { width: number; height: number } | null;
}

interface VaultStatus {
  mode?: string;
  unlocked?: boolean;
  recoveryConfirmed?: boolean;
}

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
  console.log(`  ok ${message}`);
}

function readTrim(path: string): string | null {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return null;
  }
}

function findShellxHome(): string {
  const candidates = shellxHomeCandidates();
  for (const dir of candidates) {
    if (existsSync(join(dir, "debug-api.port")) || existsSync(join(dir, "shellxagent.token"))) return dir;
  }
  return candidates[0] ?? ".shellx";
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
  return await res.json() as T;
}

async function postUi(base: string, token: string, body: Json): Promise<void> {
  await api(base, token, "POST", "/state/ui", body);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor<T>(
  label: string,
  fn: () => Promise<T | null>,
  timeoutMs = 12_000,
  intervalMs = 200,
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

function expectedHighlights(name: string, selectors: string[]): Json[] {
  return selectors.map((selector, index) => ({
    id: `${name}-${index}`,
    selector,
    label: name,
    color: "green",
  }));
}

async function waitForHighlights(
  base: string,
  token: string,
  name: string,
  selectors: string[],
  timeoutMs = 12_000,
  patch: Json = {},
): Promise<DebugHighlightResult[]> {
  const expectedIds = selectors.map((_, index) => `${name}-${index}`);
  const broadcast = () => postUi(base, token, {
    ...patch,
    source: "vault-setup-ui-test",
    debugHighlights: expectedHighlights(name, selectors),
  });
  await broadcast();
  let lastBroadcastMs = Date.now();
  return await waitFor(`debug highlights ${name}`, async () => {
    if (Date.now() - lastBroadcastMs > 1_000) {
      await broadcast();
      lastBroadcastMs = Date.now();
    }
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
    return missing.length === 0 ? results.filter((result) => expectedIds.includes(result.id ?? "")) : null;
  }, timeoutMs);
}

async function waitForMissingHighlights(
  base: string,
  token: string,
  name: string,
  selectors: string[],
  timeoutMs = 12_000,
): Promise<void> {
  const expectedIds = selectors.map((_, index) => `${name}-${index}`);
  await postUi(base, token, {
    source: "vault-setup-ui-test",
    debugHighlights: expectedHighlights(name, selectors),
  });
  await waitFor(`debug missing highlights ${name}`, async () => {
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
    const allMissing = expectedIds.every((id) => byId.get(id)?.status === "missing");
    return allMissing ? true : null;
  }, timeoutMs);
}

async function verifyE2eEnabled(base: string, token: string): Promise<void> {
  try {
    await api(base, token, "POST", "/vault/e2e/reset", {});
  } catch (err) {
    throw new Error(`Vault setup UI test requires an app launched with SHELLX_VAULT_E2E=1 and disposable SHELLX_VAULT_PROFILE_DIR: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function main(): Promise<void> {
  const shellxHome = findShellxHome();
  const port = process.env.SHELLX_DEBUG_PORT ?? readTrim(join(shellxHome, "debug-api.port"));
  const token = process.env.SHELLX_DEBUG_TOKEN ?? process.env.SHELLX_DEBUG_SECRET ?? readTrim(join(shellxHome, "shellxagent.token"));
  if (!port) throw new Error(`debug-api.port not found under ${shellxHome}`);
  if (!token) throw new Error(`shellxagent.token not found under ${shellxHome}`);
  const base = process.env.SHELLX_DEBUG_BASE ?? `http://127.0.0.1:${port}`;

  await verifyE2eEnabled(base, token);
  await postUi(base, token, { openModal: "close", debugHighlights: [] });
  await waitForHighlights(base, token, "settings-open", [".settings-modal"], 15_000, {
    openModal: "settings",
  });
  await waitForHighlights(base, token, "vault-tab-open", [
    "[data-debug-id='shellx-vault-setup']",
    "[data-debug-id='shellx-vault-master-passphrase']",
    "[data-debug-id='shellx-vault-confirm-passphrase']",
    "[data-debug-id='shellx-vault-recovery-confirm']",
  ], 15_000, {
    debugClick: "[data-debug-id='settings-tab-vault']",
  });

  const passphrase = `shellx-vault-ui-${Date.now()}`;
  await postUi(base, token, {
    debugInput: { selector: "[data-debug-id='shellx-vault-master-passphrase']", value: passphrase },
  });
  await postUi(base, token, {
    debugInput: { selector: "[data-debug-id='shellx-vault-confirm-passphrase']", value: passphrase },
  });
  await sleep(250);
  await waitForHighlights(base, token, "recovery-kit-ready", [
    ".vault-recovery-kit code",
    "[data-debug-id='shellx-vault-recovery-copy']",
    ".vault-check-row input",
    "[data-debug-id='shellx-vault-recovery-confirm']",
  ], 15_000, {
    debugClick: { selector: "button", text: "Create recovery kit" },
  });

  await postUi(base, token, {
    debugDrag: { selector: ".vault-recovery-kit code", dx: 900, dy: 420, steps: 6 },
  });
  await sleep(150);
  await waitForHighlights(base, token, "recovery-confirm-survived-selection", [
    "[data-debug-id='shellx-vault-recovery-confirm']",
  ]);

  await postUi(base, token, { debugClick: "[data-debug-id='shellx-vault-recovery-copy']" });
  await waitForHighlights(base, token, "recovery-confirm-survived-copy", [
    "[data-debug-id='shellx-vault-recovery-confirm']",
  ]);

  let lastConfirmClickMs = 0;
  const status = await waitFor<VaultStatus>("vault recovery confirmation", async () => {
    if (Date.now() - lastConfirmClickMs > 1_000) {
      await postUi(base, token, { debugClick: "[data-debug-id='shellx-vault-recovery-confirm']" });
      lastConfirmClickMs = Date.now();
    }
    const value = await api<VaultStatus>(base, token, "GET", "/vault/status");
    return value.recoveryConfirmed === true && value.unlocked === true ? value : null;
  }, 15_000);
  assert(status.recoveryConfirmed === true, "vault setup recovery is confirmed");
  assert(status.unlocked === true, "vault setup leaves the vault unlocked");
  await waitForHighlights(base, token, "vault-configured-summary", [
    "[data-debug-id='shellx-vault-configured-summary']",
  ]);
  await waitForMissingHighlights(base, token, "vault-setup-fields-hidden-after-save", [
    "[data-debug-id='shellx-vault-master-passphrase']",
    "[data-debug-id='shellx-vault-confirm-passphrase']",
  ]);
  console.log("  ok configured vault hides passphrase setup fields");

  await postUi(base, token, { openModal: "close", debugHighlights: [] });
  console.log("vault setup UI flow passed without storing recovery-word screenshots");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
