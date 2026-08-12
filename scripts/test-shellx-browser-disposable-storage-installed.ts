import { createServer, type Server } from "node:http";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import type { AddressInfo, Socket } from "node:net";
import { join } from "node:path";

import { cleanupOwnedBrowserLifecycle } from "./shellx-browser-test-cleanup";
import { debugApiConnectionCandidates } from "./shellx-debug-paths";

type JsonObject = Record<string, unknown>;
const TIMEOUT_MS = 30_000;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
  console.log(`  ✓ ${message}`);
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value;
}

async function requestJson(
  base: string,
  token: string,
  method: "GET" | "POST",
  path: string,
  body?: JsonObject,
): Promise<JsonObject> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path} failed with ${response.status}: ${text.slice(0, 1_000)}`);
  const parsed = text ? JSON.parse(text) : {};
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${method} ${path} returned a non-object response`);
  }
  return parsed as JsonObject;
}

async function resolveDebugConnection(): Promise<{ base: string; token: string; shellxHome: string }> {
  const errors: string[] = [];
  for (const candidate of debugApiConnectionCandidates()) {
    try {
      const health = await requestJson(candidate.base, candidate.token, "GET", "/health");
      if (health.ok === true) return { ...candidate, shellxHome: candidate.source };
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  throw new Error(`No installed ShellX Debug API is available: ${errors.join(" | ")}`);
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  return (server.address() as AddressInfo).port;
}

async function closeServer(server: Server, sockets: Set<Socket>): Promise<void> {
  for (const socket of sockets) socket.destroy();
  if (!server.listening) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

function fixtureDocument(mode: "seed" | "check"): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Disposable storage ${mode}</title></head>
<body><main id="status">Starting disposable storage check</main><script>
const status = document.querySelector('#status');
const openDb = () => new Promise((resolve, reject) => {
  const request = indexedDB.open('shellx-disposable-proof', 1);
  request.onupgradeneeded = () => request.result.createObjectStore('proof');
  request.onerror = () => reject(request.error);
  request.onsuccess = () => resolve(request.result);
});
const readIdb = async (db) => await new Promise((resolve, reject) => {
  const request = db.transaction('proof', 'readonly').objectStore('proof').get('value');
  request.onerror = () => reject(request.error);
  request.onsuccess = () => resolve(request.result || null);
});
const writeIdb = async (db) => await new Promise((resolve, reject) => {
  const transaction = db.transaction('proof', 'readwrite');
  transaction.objectStore('proof').put('seeded', 'value');
  transaction.onerror = () => reject(transaction.error);
  transaction.oncomplete = () => resolve();
});
(async () => {
  const db = await openDb();
  if (${JSON.stringify(mode)} === 'seed') {
    document.cookie = 'shellx_disposable_proof=seeded; SameSite=Strict';
    localStorage.setItem('shellx-disposable-proof', 'seeded');
    await writeIdb(db);
    status.textContent = 'Seed complete: cookies=true localStorage=true indexedDB=true';
  } else {
    const cookie = document.cookie.includes('shellx_disposable_proof=seeded');
    const local = localStorage.getItem('shellx-disposable-proof') === 'seeded';
    const idb = await readIdb(db) === 'seeded';
    status.textContent = 'Fresh profile: cookies=' + cookie + ' localStorage=' + local + ' indexedDB=' + idb;
  }
})().catch((error) => { status.textContent = 'Storage check failed: ' + String(error); });
</script></body></html>`;
}

function ephemeralRoots(parent: string): string[] {
  if (!existsSync(parent)) return [];
  return readdirSync(parent, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("root-"))
    .map((entry) => join(parent, entry.name));
}

async function waitForRootCount(parent: string, expected: number): Promise<string[]> {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    const roots = ephemeralRoots(parent);
    if (roots.length === expected) return roots;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Disposable WebView root count did not reach ${expected}`);
}

async function startTask(
  connection: { base: string; token: string },
  url: string,
  goal: string,
): Promise<string> {
  const task = await requestJson(connection.base, connection.token, "POST", "/browser/task/start", {
    goal,
    startUrl: url,
    profileId: "task-disposable",
    autonomy: "assistedAutonomous",
    expectedDomains: ["127.0.0.1"],
  });
  const taskId = requireString(task.taskId, "Browser task id");
  const settled = await requestJson(
    connection.base,
    connection.token,
    "GET",
    `/browser/settle?taskId=${encodeURIComponent(taskId)}&timeoutMs=${TIMEOUT_MS}`,
  );
  assert(settled.settled === true, `${goal} navigation settles in its native WebView`);
  return taskId;
}

async function waitForPageText(
  connection: { base: string; token: string },
  taskId: string,
  value: string,
): Promise<void> {
  const result = await requestJson(connection.base, connection.token, "POST", "/browser/action", {
    taskId,
    action: "waitFor",
    value,
    timeoutMs: TIMEOUT_MS,
  });
  assert(result.status === "applied", `native Browser observes ${JSON.stringify(value)}`);
}

async function main(): Promise<void> {
  console.log("\n=== ShellX installed disposable WebView storage ===");
  const connection = await resolveDebugConnection();
  const expectedCommit = process.env.SHELLX_EXPECT_BUILD_COMMIT?.trim();
  const health = await requestJson(connection.base, connection.token, "GET", "/health");
  if (expectedCommit) assert(health.buildCommit === expectedCommit, `installed build commit matches ${expectedCommit}`);

  const ephemeralParent = join(connection.shellxHome, "browser", "ephemeral-webview-data");
  assert((await waitForRootCount(ephemeralParent, 0)).length === 0, "isolated candidate starts with no disposable WebView roots");

  const sockets = new Set<Socket>();
  const server = createServer((request, response) => {
    const mode = request.url === "/seed" ? "seed" : request.url === "/check" ? "check" : null;
    if (!mode) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    response.end(fixtureDocument(mode));
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  const port = await listen(server);
  const taskIds = new Set<string>();
  try {
    const seededTaskId = await startTask(connection, `http://127.0.0.1:${port}/seed`, "disposable seed task");
    taskIds.add(seededTaskId);
    await waitForPageText(connection, seededTaskId, "Seed complete: cookies=true localStorage=true indexedDB=true");
    const seededRoots = await waitForRootCount(ephemeralParent, 1);
    const marker = JSON.parse(readFileSync(join(seededRoots[0]!, ".shellx-ephemeral-root.json"), "utf8"));
    assert(marker.schemaVersion === 2, "mounted disposable WebView root has the current ownership marker");

    const firstCleanup = await cleanupOwnedBrowserLifecycle(
      (method, path, body) => requestJson(connection.base, connection.token, method, path, body),
      { taskIds: [seededTaskId], label: "disposable-storage-seed" },
    );
    taskIds.delete(seededTaskId);
    assert(firstCleanup.errors.length === 0, "seed task closes without deferred cleanup errors");
    assert((await waitForRootCount(ephemeralParent, 0)).length === 0, "seed task WebView root is removed after native close");

    const freshTaskId = await startTask(connection, `http://127.0.0.1:${port}/check`, "disposable fresh task");
    taskIds.add(freshTaskId);
    await waitForPageText(connection, freshTaskId, "Fresh profile: cookies=false localStorage=false indexedDB=false");
    const freshRoots = await waitForRootCount(ephemeralParent, 1);
    assert(freshRoots[0] !== seededRoots[0], "next disposable task receives a different native WebView root");
  } finally {
    if (taskIds.size) {
      await cleanupOwnedBrowserLifecycle(
        (method, path, body) => requestJson(connection.base, connection.token, method, path, body),
        { taskIds, label: "disposable-storage-final" },
      );
    }
    await closeServer(server, sockets);
  }
  assert((await waitForRootCount(ephemeralParent, 0)).length === 0, "final disposable task leaves no owned WebView root");
  console.log("PASS installed disposable WebView storage isolation");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
