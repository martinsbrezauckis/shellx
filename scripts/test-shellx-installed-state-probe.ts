import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  parseInstalledBrowserState,
  summarizeInstalledBrowserState,
} from "./shellx-installed-state-probe";

const healthy = summarizeInstalledBrowserState({
  tabs: [],
  tasks: [{ taskId: "history", status: "aborted" }],
  enginePool: { engines: [{ mounted: true }], waiting: [], parkedTabs: [] },
  sessionGrants: [{ status: "cancelled" }],
  dialogs: [{ status: "resolved" }],
}, "http://127.0.0.1:30123");
assert.equal(healthy.healthy, true);
assert.deepEqual(Object.values(healthy.counts), Object.values(healthy.counts).map(() => 0));

const dirty = summarizeInstalledBrowserState({
  tabs: [{ browserTabId: "tab-1", lock: { leaseId: "lease" } }],
  tasks: [{ taskId: "task-1", status: "running" }],
  activeTaskId: "task-1",
  activeBrowserTabId: "tab-1",
  enginePool: {
    engines: [{ mounted: true, browserTabId: "tab-1", taskId: "task-1", waitlist: { active: {}, waiting: [{}] } }],
    waiting: [{}],
    parkedTabs: ["tab-2"],
  },
  engineWaitlist: { active: {}, waiting: [{}] },
  sessionGrants: [{ status: "requested" }],
  dialogs: [{ status: "pending" }],
  permissions: [{ status: "pending" }],
}, "http://127.0.0.1:30123");
assert.equal(dirty.healthy, false);
assert.equal(dirty.counts.tabs, 1);
assert.equal(dirty.counts.activeTasks, 1);
assert.equal(dirty.counts.busyEngines, 1);
assert.equal(dirty.counts.waitingEngineActions, 2);
assert.match(dirty.issues.join(" "), /pendingSessionGrants=1/);
assert.throws(
  () => parseInstalledBrowserState({ tabs: "not-an-array" }),
  /Installed Browser state.tabs must be an array/,
);
assert.throws(
  () => parseInstalledBrowserState({ enginePool: { parkedTabs: [42] } }),
  /parkedTabs\[0\] must be a string/,
);

const requestCenter = readFileSync(new URL("./test-vault-request-center-ui.ts", import.meta.url), "utf8");
assert.doesNotMatch(requestCenter, /Get-Process\s+shellx|Stop-Process\s+-Force|restartInstalledShellx/i);
assert.match(requestCenter, /cleanupOwnedBrowserLifecycle/);

const tempRoot = mkdtempSync(join(tmpdir(), "shellx-installed-state-probe-test-"));
const outputPath = join(tempRoot, "snapshot.json");
const fixtureToken = "fixture-token";
const fixtureState = {
  tabs: [],
  tasks: [],
  enginePool: { engines: [], waiting: [], parkedTabs: [] },
  sessionGrants: [],
  dialogs: [],
  permissions: [],
};
const server = createServer((request, response) => {
  assert.equal(request.headers.authorization, `Bearer ${fixtureToken}`);
  assert.equal(request.url, "/browser/state");
  response.writeHead(200, { "content-type": "application/json", connection: "keep-alive" });
  response.end(JSON.stringify(fixtureState));
});
await new Promise<void>((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
try {
  const address = server.address();
  assert(address && typeof address === "object");
  const startedAt = Date.now();
  const child = spawn(process.execPath, [
    "--import",
    "tsx",
    fileURLToPath(new URL("./shellx-installed-state-probe.ts", import.meta.url)),
    "--out",
    outputPath,
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      SHELLX_HOME: tempRoot,
      SHELLX_DEBUG_BASE: `http://127.0.0.1:${address.port}`,
      SHELLX_DEBUG_SECRET: fixtureToken,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("installed Browser state probe CLI did not terminate within 4 seconds"));
    }, 4_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
  assert.equal(exitCode, 0, stderr);
  assert(Date.now() - startedAt < 4_000, "installed Browser state probe must be a bounded CLI");
  assert.match(stdout, /shellx\.installed-browser-state\.v1/);
  const receipt = JSON.parse(readFileSync(outputPath, "utf8")) as { healthy?: boolean };
  assert.equal(receipt.healthy, true);
} finally {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  rmSync(tempRoot, { recursive: true, force: true });
}

console.log("ShellX installed Browser state probe tests passed");
