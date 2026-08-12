import { createHash, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

import { validateHarnessState, type InstalledHarnessState } from "./shellx-installed-harness";

type JsonObject = Record<string, unknown>;
type Bookmark = {
  bookmarkId: string;
  label: string;
  kind: "link" | "folder";
  url?: string | null;
  category: string;
  parentId?: string | null;
  toolbarPinned: boolean;
  toolbarOrder?: number | null;
  agentWorkflow?: JsonObject | null;
};

const TIMEOUT_MS = 30_000;
const OWNED_PREFIX = "installed-restart-";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
  console.log(`  ✓ ${message}`);
}

function requiredArg(name: string): string {
  const args = process.argv.slice(2);
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : args.find((entry) => entry.startsWith(`${name}=`))?.slice(name.length + 1);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function optionalArg(name: string): string | null {
  const args = process.argv.slice(2);
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] ?? null : args.find((entry) => entry.startsWith(`${name}=`))?.slice(name.length + 1) ?? null;
}

function psLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function runPowerShell(script: string, label: string): string {
  const result = spawnSync("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    script,
  ], { encoding: "utf8", timeout: TIMEOUT_MS });
  if (result.status !== 0) {
    throw new Error(`${label}: ${(result.stderr || result.stdout || result.error?.message || "PowerShell failed").trim()}`);
  }
  return result.stdout.trim();
}

function stopExactProcess(state: InstalledHarnessState): void {
  runPowerShell([
    "$ErrorActionPreference = 'Stop'",
    `$process = Get-Process -Id ${state.pid} -ErrorAction SilentlyContinue`,
    "if (-not $process) { throw 'Owned ShellX candidate is not running' }",
    `$expected = [IO.Path]::GetFullPath(${psLiteral(state.executablePath)})`,
    "$actual = [IO.Path]::GetFullPath($process.Path)",
    "if (-not $actual.Equals($expected, [StringComparison]::OrdinalIgnoreCase)) { throw \"Refusing PID image mismatch: $actual\" }",
    "$null = $process.CloseMainWindow()",
    "if (-not $process.WaitForExit(10000)) { Stop-Process -Id $process.Id -Force; Wait-Process -Id $process.Id -Timeout 10 -ErrorAction SilentlyContinue }",
  ].join("\n"), "stop exact installed candidate");
}

function startExactProcess(state: InstalledHarnessState): number {
  const output = runPowerShell([
    "$ErrorActionPreference = 'Stop'",
    `$env:HOME = ${psLiteral(state.profilePath)}`,
    `$env:USERPROFILE = ${psLiteral(state.profilePath)}`,
    `$env:LOCALAPPDATA = Join-Path ${psLiteral(state.profilePath)} 'AppData\\Local'`,
    `$env:APPDATA = Join-Path ${psLiteral(state.profilePath)} 'AppData\\Roaming'`,
    `$env:TEMP = Join-Path ${psLiteral(state.profilePath)} 'Temp'`,
    "$env:TMP = $env:TEMP",
    "$env:SHELLX_TEST_INSTANCE = '1'",
    `$env:SHELLX_TEST_INSTANCE_ID = ${psLiteral(state.instanceId)}`,
    "$env:SHELLX_MIGRATE_DATA_DIR = '0'",
    `$env:SHELLX_DEBUG_PORT = ${psLiteral(String(state.debugPort))}`,
    `$env:SHELLX_MCP_PORT = ${psLiteral(String(state.mcpPort))}`,
    "$env:SHELLX_VAULT_E2E = '1'",
    `$env:SHELLX_VAULT_PROFILE_DIR = ${psLiteral(state.vaultProfilePath)}`,
    `$process = Start-Process -FilePath ${psLiteral(state.executablePath)} -PassThru`,
    "$process.Id",
  ].join("\n"), "restart exact installed candidate");
  const line = output.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean).at(-1);
  const pid = Number(line);
  if (!Number.isInteger(pid) || pid <= 0) throw new Error("Restarted candidate did not return a positive PID");
  return pid;
}

function tokenFor(state: InstalledHarnessState): string {
  const token = readFileSync(`${state.shellxHome}/shellxagent.token`, "utf8").trim();
  if (!/^[a-f0-9]{32}$/i.test(token)) throw new Error("Installed candidate Debug token has an invalid format");
  return token;
}

async function requestJson(
  state: InstalledHarnessState,
  token: string,
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: JsonObject,
): Promise<JsonObject> {
  const response = await fetch(`${state.debugBase}${path}`, {
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

async function waitForRestart(state: InstalledHarnessState, token: string): Promise<void> {
  const deadline = Date.now() + TIMEOUT_MS;
  let lastError = "not ready";
  while (Date.now() < deadline) {
    try {
      const health = await requestJson(state, token, "GET", "/health");
      if (health.ok !== true || health.processId !== state.pid || health.instanceId !== state.instanceId
        || health.buildCommit !== state.buildCommit || health.appVersion !== state.appVersion) {
        throw new Error("health identity does not match the restarted candidate");
      }
      await requestJson(state, token, "GET", "/browser/bookmarks");
      return;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  throw new Error(`Restarted candidate did not become ready: ${lastError}`);
}

async function restartCandidate(statePath: string, state: InstalledHarnessState, token: string): Promise<InstalledHarnessState> {
  stopExactProcess(state);
  const next = validateHarnessState({ ...state, pid: startExactProcess(state) });
  writeFileSync(statePath, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await waitForRestart(next, token);
  return next;
}

async function bookmarks(state: InstalledHarnessState, token: string): Promise<Bookmark[]> {
  const response = await requestJson(state, token, "GET", "/browser/bookmarks");
  if (!Array.isArray(response.bookmarks)) throw new Error("Browser bookmarks response omitted bookmarks");
  return response.bookmarks as Bookmark[];
}

function normalizedBookmarks(values: Bookmark[]): string {
  return JSON.stringify(values.map((bookmark) => ({
    bookmarkId: bookmark.bookmarkId,
    label: bookmark.label,
    kind: bookmark.kind,
    url: bookmark.url ?? null,
    category: bookmark.category,
    parentId: bookmark.parentId ?? null,
    toolbarPinned: bookmark.toolbarPinned,
    toolbarOrder: bookmark.toolbarOrder ?? null,
    agentWorkflow: bookmark.agentWorkflow ?? null,
  })).sort((a, b) => a.bookmarkId.localeCompare(b.bookmarkId)));
}

async function upsert(state: InstalledHarnessState, token: string, body: JsonObject): Promise<void> {
  await requestJson(state, token, "POST", "/browser/bookmarks", body);
}

async function remove(state: InstalledHarnessState, token: string, id: string): Promise<void> {
  await requestJson(state, token, "DELETE", `/browser/bookmarks/${encodeURIComponent(id)}`);
}

async function main(): Promise<void> {
  console.log("\n=== ShellX installed bookmark restart durability ===");
  const statePath = resolve(requiredArg("--state"));
  let state = validateHarnessState(JSON.parse(readFileSync(statePath, "utf8")));
  const token = tokenFor(state);
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const expectedCommit = process.env.SHELLX_EXPECT_BUILD_COMMIT?.trim();
  if (expectedCommit) assert(state.buildCommit === expectedCommit, `installed build commit matches ${expectedCommit}`);
  const baseline = await bookmarks(state, token);
  assert(!baseline.some((bookmark) => bookmark.bookmarkId.startsWith(OWNED_PREFIX)), "owned bookmark namespace is initially empty");

  const suffix = randomBytes(4).toString("hex");
  const folderId = `${OWNED_PREFIX}folder-${suffix}`;
  const linkId = `${OWNED_PREFIX}link-${suffix}`;
  const workflowId = `${OWNED_PREFIX}workflow-${suffix}`;
  const deletedId = `${OWNED_PREFIX}deleted-${suffix}`;
  await upsert(state, token, { bookmarkId: folderId, label: "Installed restart folder", kind: "folder", toolbarPinned: false });
  await upsert(state, token, {
    bookmarkId: linkId,
    label: "Installed restart link",
    kind: "link",
    url: "https://shellx.invalid/installed-restart-link",
    toolbarPinned: false,
  });
  await upsert(state, token, {
    bookmarkId: workflowId,
    label: "Installed restart workflow",
    kind: "link",
    url: "https://shellx.invalid/installed-restart-workflow",
    category: "workflow",
    toolbarPinned: true,
    toolbarOrder: 0,
    agentWorkflow: {
      siteKey: "shellx.invalid",
      taskType: "get",
      target: "release-status",
      surface: "browser",
      aliases: ["status"],
      permissionsNeeded: ["network"],
      recipeId: `recipe-${suffix}`,
      goal: "Read the current release status",
      steps: 2,
      source: "installed-restart-test",
      createdAtMs: Date.now(),
      health: "healthy",
    },
  });
  await upsert(state, token, {
    bookmarkId: deletedId,
    label: "Installed deleted before restart",
    kind: "link",
    url: "https://shellx.invalid/installed-restart-deleted",
  });
  await requestJson(state, token, "POST", "/browser/bookmarks/reorder", {
    items: [
      { bookmarkId: linkId, parentId: folderId, toolbarPinned: false, toolbarOrder: 0 },
      { bookmarkId: workflowId, parentId: null, toolbarPinned: true, toolbarOrder: 0 },
    ],
  });
  await remove(state, token, deletedId);
  assert((await bookmarks(state, token)).filter((bookmark) => bookmark.bookmarkId.startsWith(OWNED_PREFIX)).length === 3, "create, reorder, workflow metadata, and pre-restart deletion are committed");

  state = await restartCandidate(statePath, state, token);
  assert(createHash("sha256").update(tokenFor(state)).digest("hex") === tokenHash, "Debug token remains authoritative across installed restart");
  const persisted = await bookmarks(state, token);
  const folder = persisted.find((bookmark) => bookmark.bookmarkId === folderId);
  const link = persisted.find((bookmark) => bookmark.bookmarkId === linkId);
  const workflow = persisted.find((bookmark) => bookmark.bookmarkId === workflowId);
  assert(folder?.kind === "folder", "folder bookmark survives installed restart");
  assert(link?.parentId === folderId && link.toolbarPinned === false, "nested bookmark placement survives installed restart");
  assert(workflow?.toolbarPinned === true && workflow.toolbarOrder === 0, "toolbar pin and order survive installed restart");
  assert(workflow?.category === "workflow" && workflow.agentWorkflow?.recipeId === `recipe-${suffix}`, "workflow bookmark metadata survives installed restart");
  assert(!persisted.some((bookmark) => bookmark.bookmarkId === deletedId), "bookmark deleted before restart stays deleted");

  await remove(state, token, linkId);
  await remove(state, token, folderId);
  await remove(state, token, workflowId);
  state = await restartCandidate(statePath, state, token);
  const finalBookmarks = await bookmarks(state, token);
  assert(!finalBookmarks.some((bookmark) => bookmark.bookmarkId.startsWith(OWNED_PREFIX)), "owned bookmarks stay deleted after a second installed restart");
  assert(normalizedBookmarks(finalBookmarks) === normalizedBookmarks(baseline), "bookmark cleanup restores the exact isolated baseline");

  const receipt = {
    schemaVersion: "shellx.browser-bookmark-restart-installed.v1",
    testedAt: new Date().toISOString(),
    appVersion: state.appVersion,
    buildCommit: state.buildCommit,
    artifactSha256: state.artifactSha256,
    restartCount: 2,
    createdKinds: ["folder", "link", "workflow"],
    deletionDurable: true,
    baselineRestored: true,
    tokenIdentityStable: true,
  };
  const outputPath = optionalArg("--out");
  if (outputPath) writeFileSync(resolve(outputPath), `${JSON.stringify(receipt, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  console.log(JSON.stringify(receipt, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
