import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  debugApiConnectionCandidates,
  resolveShellxDebugApiConnection,
} from "./shellx-debug-paths";

const root = mkdtempSync(join(tmpdir(), "shellx-debug-paths-"));
const staleHome = join(root, "stale");
const healthyHome = join(root, "healthy");
mkdirSync(staleHome);
mkdirSync(healthyHome);

const token = "healthy-test-token";
const server = createServer((request, response) => {
  if (request.url !== "/browser/state") {
    response.writeHead(404).end();
    return;
  }
  if (request.headers.authorization !== `Bearer ${token}`) {
    response.writeHead(401).end();
    return;
  }
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify({ ok: true }));
});

const envKeys = ["SHELLX_DEBUG_BASE", "SHELLX_DEBUG_PORT", "SHELLX_DEBUG_SECRET", "SHELLX_DEBUG_TOKEN"] as const;
const savedEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
for (const key of envKeys) delete process.env[key];

const debugApiFilesSource = readFileSync(
  resolve(import.meta.dirname, "..", "src-tauri", "src", "debug_api_files.rs"),
  "utf8",
).replaceAll("\r\n", "\n");
const debugApiReportsSource = readFileSync(
  resolve(import.meta.dirname, "..", "src-tauri", "src", "debug_api_reports.rs"),
  "utf8",
).replaceAll("\r\n", "\n");
assert.equal(
  debugApiReportsSource.match(/host_subagents::list_recent_read_only/g)?.length,
  2,
  "agent-run and subagent GET routes must both use read-only SQLite snapshots",
);
assert(
  !debugApiReportsSource.includes("host_subagents::gc_older_than_ms"),
  "subagent GET routes must not run database maintenance",
);
const debugTabCwdSource = debugApiFilesSource.match(
  /pub\(super\) async fn debug_tab_cwd[\s\S]*?\n}\n\n(?:pub\(super\) )?async fn debug_tab_command_text/,
)?.[0] ?? "";
assert(debugTabCwdSource.includes("get_existing(&tab_key)"), "GitHub status reads resolve only an existing tab session");
assert(!debugTabCwdSource.includes("get_or_create"), "GitHub status reads must not materialize a ghost session");
const stateGithubSource = debugApiFilesSource.match(
  /pub\(super\) async fn state_github[\s\S]*?\n}\n\n\/\/ state_projects/,
)?.[0] ?? "";
assert(
  stateGithubSource.includes("q.cwd.filter") && stateGithubSource.includes("debug_tab_cwd(&s, tab_id.clone()).await"),
  "GitHub status reads must prefer an explicit owned cwd and retain existing-tab fallback",
);

try {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string" || !Number.isInteger(address.port)) {
    throw new Error("Debug path fixture did not bind a TCP port");
  }
  const port = String(address.port);
  writeFileSync(join(staleHome, "debug-api.port"), port);
  writeFileSync(join(staleHome, "shellxagent.token"), "stale-test-token");
  writeFileSync(join(healthyHome, "debug-api.port"), port);
  writeFileSync(join(healthyHome, "shellxagent.token"), token);

  const homeCandidates = [staleHome, healthyHome];
  const candidates = debugApiConnectionCandidates({ homeCandidates });
  assert.equal(candidates.length, 2);
  assert.equal(candidates[0]?.token, "stale-test-token");
  assert.equal(candidates[1]?.token, token);

  const explicitBaseCandidates = debugApiConnectionCandidates({
    base: `http://127.0.0.1:${port}`,
    homeCandidates: [healthyHome],
  });
  assert.deepEqual(explicitBaseCandidates, [{
    base: `http://127.0.0.1:${port}`,
    token,
    source: healthyHome,
  }]);

  const connection = await resolveShellxDebugApiConnection({ homeCandidates, timeoutMs: 250 });
  assert.equal(connection.base, `http://127.0.0.1:${port}`);
  assert.equal(connection.token, token);
  console.log("ShellX Debug API candidate resolver tests passed");
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(root, { recursive: true, force: true });
  for (const key of envKeys) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
