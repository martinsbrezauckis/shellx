import { createServer, type Server } from "node:http";
import type { Socket } from "node:net";
import { cleanupOwnedBrowserLifecycle } from "../shellx-browser-test-cleanup";

type DebugApiConnection = { base: string; token: string };

export type DebugApiBrowserSettleFixture = {
  taskId: string;
  browserTabId: string;
  callerSessionId: string | null;
  url: string;
  server: Server;
  sockets: Set<Socket>;
};

const TIMEOUT_MS = 30_000;

export async function prepareDebugApiBrowserSettleFixture(
  connection: DebugApiConnection,
  options: { callerSessionId?: string | null } = {},
): Promise<DebugApiBrowserSettleFixture> {
  const local = await startOwnedPage();
  const callerSessionId = options.callerSessionId?.trim() || null;
  let taskId: string | null = null;
  try {
    const task = await apiJson(connection, "POST", "/browser/task/start", {
      goal: "Final surface Browser settle proof",
      startUrl: local.url,
      profileId: "task-disposable",
      autonomy: "assistedAutonomous",
      expectedDomains: ["127.0.0.1"],
    }, callerSessionId);
    taskId = requiredString(task.taskId, "Browser settle taskId");
    if (callerSessionId && task.ownerSessionId !== callerSessionId) {
      throw new Error("Browser settle task omitted its exact owner session binding");
    }
    const browserTabId = await waitForOwnedBrowserTab(connection, taskId, callerSessionId);
    const fixture = { taskId, browserTabId, callerSessionId, ...local };
    const settlePath = debugApiBrowserSettleRequestPath("/browser/settle", fixture);
    const settled = await apiJson(connection, "GET", settlePath, undefined, callerSessionId);
    verifyDebugApiBrowserSettleJson("/browser/settle", settled, fixture);
    return fixture;
  } catch (error) {
    const cleanupErrors: string[] = [];
    if (taskId) {
      try {
        const result = await cleanupOwnedBrowserLifecycle(
          (method, path, body) => apiJson(connection, method, path, body, callerSessionId),
          { taskIds: [taskId], label: "final-surface-debug-api-browser-settle-setup" },
        );
        cleanupErrors.push(...result.errors);
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError instanceof Error ? cleanupError.message : String(cleanupError));
      }
    }
    await closeOwnedPage(local.server, local.sockets);
    throw new Error(`${error instanceof Error ? error.message : String(error)}${cleanupErrors.length ? `; setup cleanup: ${cleanupErrors.join(" | ")}` : ""}`);
  }
}

export async function cleanupDebugApiBrowserSettleFixture(
  connection: DebugApiConnection,
  fixture: DebugApiBrowserSettleFixture,
  engineIds: Iterable<string> = [],
): Promise<string | null> {
  const errors: string[] = [];
  try {
    const result = await cleanupOwnedBrowserLifecycle(
      (method, path, body) => apiJson(connection, method, path, body, fixture.callerSessionId),
      {
        taskIds: [fixture.taskId],
        tabIds: [fixture.browserTabId],
        engineIds,
        label: "final-surface-debug-api-browser-settle",
      },
    );
    errors.push(...result.errors);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  try {
    await closeOwnedPage(fixture.server, fixture.sockets);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  return errors.length ? errors.join(" | ") : null;
}

export function debugApiBrowserSettleRequestPath(
  path: string,
  fixture: DebugApiBrowserSettleFixture | null,
): string {
  if (path !== "/browser/settle") return path;
  const owned = requireFixture(fixture);
  const query = new URLSearchParams({
    taskId: owned.taskId,
    browserTabId: owned.browserTabId,
    timeoutMs: String(TIMEOUT_MS),
  });
  return `${path}?${query}`;
}

export function verifyDebugApiBrowserSettleJson(
  path: string,
  value: unknown,
  fixture: DebugApiBrowserSettleFixture | null,
): string | null {
  if (path !== "/browser/settle") return null;
  const owned = requireFixture(fixture);
  const body = requireObject(value, path);
  if (body.settled !== true || body.taskId !== owned.taskId || body.browserTabId !== owned.browserTabId
    || body.taskStatus !== "running"
    || !["loaded", "ready"].includes(String(body.tabStatus))
    || typeof body.engineId !== "string" || !body.engineId
    || body.engineLoadStatus !== "loaded" || body.engineUrl !== owned.url
    || typeof body.revision !== "string" || !body.revision
    || body.pendingUrl !== null) {
    throw new Error("Browser settle omitted the exact settled task, tab, engine, or revision state");
  }
  return "Browser settle waited for one exact owned task and tab to reach a stable engine revision with no pending URL; identities and URLs were not retained.";
}

async function startOwnedPage(): Promise<{
  url: string;
  server: Server;
  sockets: Set<Socket>;
}> {
  const sockets = new Set<Socket>();
  const server = createServer((request, response) => {
    if (request.method !== "GET" || new URL(request.url ?? "/", "http://127.0.0.1").pathname !== "/settle") {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end("<!doctype html><title>ShellX release settle</title><main>Owned Browser settle fixture ready</main><label>Owned Teach input <input id=\"shellx-release-teach-input\" autocomplete=\"off\"></label>");
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
  if (!address || typeof address === "string") throw new Error("Browser settle fixture did not bind");
  return { url: `http://127.0.0.1:${address.port}/settle`, server, sockets };
}

async function closeOwnedPage(server: Server, sockets: Set<Socket>): Promise<void> {
  for (const socket of sockets) socket.destroy();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function apiJson(
  connection: DebugApiConnection,
  method: "GET" | "POST",
  path: string,
  body?: Record<string, unknown>,
  callerSessionId?: string | null,
): Promise<Record<string, unknown>> {
  const response = await fetch(`${connection.base}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${connection.token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(callerSessionId ? { "x-shellx-mcp-caller-id": callerSessionId } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path} failed ${response.status}: ${text.slice(0, 1_200)}`);
  return requireObject(text.trim() ? JSON.parse(text) : {}, `${method} ${path}`);
}

async function waitForOwnedBrowserTab(
  connection: DebugApiConnection,
  taskId: string,
  callerSessionId: string | null,
): Promise<string> {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    const state = await apiJson(connection, "GET", "/browser/state", undefined, callerSessionId);
    const tabs = Array.isArray(state.tabs) ? state.tabs : [];
    const tab = tabs.find((value) => {
      const row = value && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
      return row?.taskId === taskId && typeof row.browserTabId === "string" && row.browserTabId.length > 0;
    }) as Record<string, unknown> | undefined;
    if (tab) return requiredString(tab.browserTabId, "Browser settle browserTabId");
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error("Browser settle task did not publish its exact owned Browser tab");
}

function requireFixture(value: DebugApiBrowserSettleFixture | null): DebugApiBrowserSettleFixture {
  if (!value) throw new Error("owned Browser settle fixture is unavailable");
  return value;
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} did not return an object`);
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value;
}
