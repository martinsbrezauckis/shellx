import {
  cleanupDebugApiBrowserSettleFixture,
  debugApiBrowserSettleRequestPath,
  prepareDebugApiBrowserSettleFixture,
  verifyDebugApiBrowserSettleJson,
  type DebugApiBrowserSettleFixture,
} from "./debug-api-browser-settle-fixture";

type Json = Record<string, unknown>;
type DebugApiConnection = { base: string; token: string };
type InvokeTauri = (command: string, args: Json) => Promise<unknown>;

type BrowserEngineBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type TauriCommandBrowserEngineSyncFixture = {
  lifecycle: DebugApiBrowserSettleFixture;
  engineId: string;
  profileId: string;
  baselineUpdatedAtMs: number;
  targetBounds: BrowserEngineBounds;
};

export async function prepareTauriCommandBrowserEngineSyncFixture(
  connection: DebugApiConnection,
  invoke: InvokeTauri,
): Promise<TauriCommandBrowserEngineSyncFixture> {
  const lifecycle = await prepareDebugApiBrowserSettleFixture(connection);
  try {
    await settleOwnedBrowserFixture(connection, lifecycle);
    const state = requireRecord(await invoke("shellx_browser_state", {}), "Browser engine sync baseline");
    const tab = requireArray(state.tabs, "Browser engine sync tabs")
      .map((row) => requireRecord(row, "Browser engine sync tab"))
      .find((row) => row.browserTabId === lifecycle.browserTabId);
    if (!tab || tab.taskId !== lifecycle.taskId) {
      throw new Error("Browser engine sync baseline omitted the exact owned tab and task");
    }
    const engineId = requiredString(tab.engineId, "Browser engine sync engineId");
    const profileId = requiredString(tab.profileId, "Browser engine sync profileId");
    if (profileId !== "task-disposable") {
      throw new Error("Browser engine sync fixture did not use the disposable task profile");
    }
    const engine = findEngine(state, engineId, "Browser engine sync baseline");
    verifyEngineIdentity(engine, { lifecycle, engineId, profileId });
    const baselineUpdatedAtMs = requirePositiveTimestamp(
      engine.updatedAtMs,
      "Browser engine sync baseline updatedAtMs",
    );
    const baselineBounds = requireBounds(engine.bounds, "Browser engine sync baseline bounds");
    if (baselineBounds.width < 120 || baselineBounds.height < 120) {
      throw new Error("Browser engine sync baseline is too small for a bounded layout adjustment");
    }
    return {
      lifecycle,
      engineId,
      profileId,
      baselineUpdatedAtMs,
      targetBounds: {
        x: baselineBounds.x + 1,
        y: baselineBounds.y + 1,
        width: baselineBounds.width - 1,
        height: baselineBounds.height - 1,
      },
    };
  } catch (error) {
    const cleanup = await cleanupDebugApiBrowserSettleFixture(connection, lifecycle);
    if (cleanup) {
      throw new Error(`${errorMessage(error)}; cleanup: ${cleanup}`);
    }
    throw error;
  }
}

export function tauriCommandBrowserEngineSyncArgs(
  fixture: TauriCommandBrowserEngineSyncFixture,
): Json {
  return {
    request: {
      engineId: fixture.engineId,
      browserTabId: fixture.lifecycle.browserTabId,
      profileId: fixture.profileId,
      url: fixture.lifecycle.url,
      preserveExistingPage: true,
      bounds: fixture.targetBounds,
    },
  };
}

export async function verifyTauriCommandBrowserEngineSync(
  value: unknown,
  connection: DebugApiConnection,
  invoke: InvokeTauri,
  fixture: TauriCommandBrowserEngineSyncFixture,
): Promise<string> {
  const returned = requireRecord(value, "shellx_browser_sync_engine response");
  verifyEngineIdentity(returned, fixture);
  verifyExactBounds(returned.bounds, fixture.targetBounds, "shellx_browser_sync_engine response bounds");
  const returnedUpdatedAtMs = requirePositiveTimestamp(
    returned.updatedAtMs,
    "shellx_browser_sync_engine response updatedAtMs",
  );
  if (returnedUpdatedAtMs < fixture.baselineUpdatedAtMs) {
    throw new Error("shellx_browser_sync_engine response regressed the owned engine update timestamp");
  }

  const state = requireRecord(await invoke("shellx_browser_state", {}), "Browser engine sync readback");
  const engine = findEngine(state, fixture.engineId, "Browser engine sync readback");
  verifyEngineIdentity(engine, fixture);
  verifyExactBounds(engine.bounds, fixture.targetBounds, "Browser engine sync readback bounds");
  if (requirePositiveTimestamp(engine.updatedAtMs, "Browser engine sync readback updatedAtMs") !== returnedUpdatedAtMs) {
    throw new Error("Browser engine sync readback did not retain the exact returned engine revision timestamp");
  }
  await settleOwnedBrowserFixture(connection, fixture.lifecycle);

  const verified = await apiJson(connection, "POST", "/browser/action", {
    action: "verify",
    taskId: fixture.lifecycle.taskId,
    browserTabId: fixture.lifecycle.browserTabId,
    key: "text",
    value: "Owned Browser settle fixture ready",
    timeoutMs: 30_000,
  });
  const verification = requireRecord(verified.verification, "Browser engine sync page verification");
  const receipt = requireRecord(verified.receipt, "Browser engine sync verification receipt");
  if (verified.ok !== true || verified.taskId !== fixture.lifecycle.taskId
    || verified.currentUrl !== fixture.lifecycle.url || verification.passed !== true
    || receipt.kind !== "browserVerificationPassed" || receipt.taskId !== fixture.lifecycle.taskId) {
    throw new Error("Browser engine sync did not preserve the exact owned loopback page canary");
  }
  return "Installed IPC resynchronized one exact owned Browser engine with bounded layout coordinates while preserving its settled loopback page; readback, settle, and page verification all passed before exact task, tab, and engine cleanup.";
}

export async function cleanupTauriCommandBrowserEngineSyncFixture(
  connection: DebugApiConnection,
  fixture: TauriCommandBrowserEngineSyncFixture,
): Promise<string | null> {
  return cleanupDebugApiBrowserSettleFixture(connection, fixture.lifecycle, [fixture.engineId]);
}

async function settleOwnedBrowserFixture(
  connection: DebugApiConnection,
  fixture: DebugApiBrowserSettleFixture,
): Promise<void> {
  const path = debugApiBrowserSettleRequestPath("/browser/settle", fixture);
  const settled = await apiJson(connection, "GET", path);
  verifyDebugApiBrowserSettleJson("/browser/settle", settled, fixture);
}

function findEngine(state: Json, engineId: string, label: string): Json {
  const pool = requireRecord(state.enginePool, `${label}.enginePool`);
  const matches = requireArray(pool.engines, `${label}.enginePool.engines`)
    .map((row) => requireRecord(row, `${label}.engine`))
    .filter((row) => row.engineId === engineId);
  if (matches.length !== 1) throw new Error(`${label} did not contain exactly one owned engine`);
  return matches[0]!;
}

function verifyEngineIdentity(
  engine: Json,
  fixture: Pick<TauriCommandBrowserEngineSyncFixture, "lifecycle" | "engineId" | "profileId">,
): void {
  if (engine.engineId !== fixture.engineId
    || engine.browserTabId !== fixture.lifecycle.browserTabId
    || engine.taskId !== fixture.lifecycle.taskId
    || engine.profileId !== fixture.profileId
    || engine.url !== fixture.lifecycle.url
    || engine.pendingUrl !== null
    || engine.mounted !== true
    || typeof engine.loadStatus !== "string" || !engine.loadStatus
    || !Number.isFinite(Number(engine.updatedAtMs)) || Number(engine.updatedAtMs) <= 0) {
    throw new Error("Browser engine sync drifted from the exact mounted task, tab, profile, page, or settled revision");
  }
}

function requirePositiveTimestamp(value: unknown, label: string): number {
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp) || timestamp <= 0) throw new Error(`${label} must be a positive finite timestamp`);
  return timestamp;
}

function verifyExactBounds(value: unknown, expected: BrowserEngineBounds, label: string): void {
  const actual = requireBounds(value, label);
  for (const key of ["x", "y", "width", "height"] as const) {
    if (actual[key] !== expected[key]) throw new Error(`${label}.${key} did not match the bounded request`);
  }
}

function requireBounds(value: unknown, label: string): BrowserEngineBounds {
  const body = requireRecord(value, label);
  const output = {
    x: Number(body.x),
    y: Number(body.y),
    width: Number(body.width),
    height: Number(body.height),
  };
  if (!Object.values(output).every(Number.isFinite) || output.x < 0 || output.y < 0
    || output.width <= 0 || output.height <= 0) {
    throw new Error(`${label} is not a positive finite Browser engine rectangle`);
  }
  return output;
}

async function apiJson(
  connection: DebugApiConnection,
  method: "GET" | "POST",
  path: string,
  body?: Json,
): Promise<Json> {
  const response = await fetch(`${connection.base.replace(/\/$/, "")}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${connection.token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path} failed ${response.status}: ${text.slice(0, 1_200)}`);
  return requireRecord(text.trim() ? JSON.parse(text) : {}, `${method} ${path}`);
}

function requireRecord(value: unknown, label: string): Json {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} did not return an object`);
  return value as Json;
}

function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} did not return an array`);
  return value;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
