import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  parseJsonValue,
  readJsonProperty,
  requireBooleanProperty,
  requireJsonObject,
  requireStringProperty,
} from "./runtime-json";
import { validateHarnessState, type InstalledHarnessState } from "./shellx-installed-harness";

const RECEIPT_SCHEMA = "shellx.setup-guide-installed.v1";
const WINDOWS_FRAME = { width: 14, height: 37 } as const;
const VIEWPORTS = [
  { width: 1024, height: 720 },
  { width: 1280, height: 720 },
  { width: 1440, height: 900 },
] as const;
const STEP_SELECTORS = ["vault", "browser", "downloads", "agents", "requests"]
  .map((id) => `[data-debug-id='shellx-setup-step-${id}']`);

interface HighlightResult {
  id: string;
  selector: string;
  status: string;
  clipped: boolean;
  contentClipped: boolean;
  viewportWidth: number;
  viewportHeight: number;
}

function readArg(name: string): string | undefined {
  const args = process.argv.slice(2);
  const index = args.indexOf(name);
  if (index >= 0) return args[index + 1];
  return args.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1);
}

function powerShellLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function runPowerShell(script: string): string {
  const result = spawnSync("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    script,
  ], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || result.error?.message || "PowerShell failed").trim());
  }
  return result.stdout.trim();
}

function resizeOwnedWindow(state: InstalledHarnessState, width: number, height: number): void {
  runPowerShell([
    "$ErrorActionPreference = 'Stop'",
    `$process = Get-Process -Id ${state.pid} -ErrorAction SilentlyContinue`,
    "if (-not $process) { throw 'Owned ShellX process is not running' }",
    `$expected = [IO.Path]::GetFullPath(${powerShellLiteral(state.executablePath)})`,
    "$actual = [IO.Path]::GetFullPath($process.Path)",
    "if (-not $actual.Equals($expected, [StringComparison]::OrdinalIgnoreCase)) { throw \"PID image mismatch: $actual\" }",
    "Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class ShellXWindow { [DllImport(\"user32.dll\", SetLastError=true)] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int width, int height, uint flags); }'",
    "$deadline = [DateTime]::UtcNow.AddSeconds(5)",
    "do { $handle = (Get-Process -Id $process.ProcessId).MainWindowHandle; if ($handle -ne 0) { break }; Start-Sleep -Milliseconds 100 } while ([DateTime]::UtcNow -lt $deadline)",
    "if ($handle -eq 0) { throw 'Owned ShellX main window handle is unavailable' }",
    `if (-not [ShellXWindow]::SetWindowPos($handle, [IntPtr]::Zero, 0, 0, ${width}, ${height}, 0x0046)) { throw 'SetWindowPos failed' }`,
  ].join("\n"));
}

async function request(base: string, token: string, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  return fetch(`${base}${path}`, { ...init, headers, signal: AbortSignal.timeout(10_000) });
}

async function apiJson(base: string, token: string, method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
  const headers = new Headers();
  if (body !== undefined) headers.set("Content-Type", "application/json");
  const response = await request(base, token, path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path} returned ${response.status}: ${text.slice(0, 500)}`);
  return parseJsonValue(text, `${method} ${path}`);
}

function parseHighlight(value: unknown): HighlightResult {
  const result = requireJsonObject(value, "Debug highlight result");
  const viewportWidth = readJsonProperty(result, "viewportWidth", "Debug highlight result");
  const viewportHeight = readJsonProperty(result, "viewportHeight", "Debug highlight result");
  assert(typeof viewportWidth === "number" && Number.isFinite(viewportWidth));
  assert(typeof viewportHeight === "number" && Number.isFinite(viewportHeight));
  return {
    id: requireStringProperty(result, "id", "Debug highlight result"),
    selector: requireStringProperty(result, "selector", "Debug highlight result"),
    status: requireStringProperty(result, "status", "Debug highlight result"),
    clipped: requireBooleanProperty(result, "clipped", "Debug highlight result"),
    contentClipped: requireBooleanProperty(result, "contentClipped", "Debug highlight result"),
    viewportWidth,
    viewportHeight,
  };
}

async function waitForHighlights(
  base: string,
  token: string,
  requests: Array<{ id: string; selector: string }>,
): Promise<HighlightResult[]> {
  const expectedIds = requests.map((request) => request.id);
  const deadline = Date.now() + 10_000;
  let attempt = 0;
  while (Date.now() < deadline) {
    if (attempt % 5 === 0) {
      await apiJson(base, token, "POST", "/state/ui", {
        debugHighlights: requests,
        source: "setup-guide-installed-proof",
      });
    }
    attempt += 1;
    const state = requireJsonObject(await apiJson(base, token, "GET", "/state/ui"), "UI state");
    const bySurface = readJsonProperty(state, "debugHighlightResultsBySurface", "UI state");
    const app = bySurface && typeof bySurface === "object"
      ? readJsonProperty(bySurface, "app", "UI highlight surfaces")
      : undefined;
    if (Array.isArray(app)) {
      const parsed = app.map(parseHighlight);
      if (expectedIds.every((id) => parsed.some((result) => result.id === id))) return parsed;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error("Timed out waiting for Setup Guide highlight measurements");
}

function pngDimensions(bytes: Buffer): { width: number; height: number } {
  assert(bytes.length > 24 && bytes.subarray(1, 4).toString("ascii") === "PNG", "screenshot must be a PNG");
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

async function main(): Promise<void> {
  const statePath = readArg("--harness-state");
  const outputDir = readArg("--out");
  if (!statePath || !outputDir) {
    throw new Error("Usage: tsx scripts/test-shellx-setup-guide-installed.ts --harness-state <path> --out <dir>");
  }
  const state = validateHarnessState(parseJsonValue(readFileSync(resolve(statePath), "utf8"), "Installed harness state"));
  const token = readFileSync(join(state.shellxHome, "shellxagent.token"), "utf8").trim();
  assert(token.length >= 32, "installed harness token must be available for UI evidence");
  const absoluteOutputDir = resolve(outputDir);
  mkdirSync(absoluteOutputDir, { recursive: true });
  await apiJson(state.debugBase, token, "POST", "/state/ui", {
    setupGuideDismissed: false,
    openModal: "close",
    debugHighlights: [],
    source: "setup-guide-installed-proof",
  });

  const viewportReceipts = [];
  for (const viewport of VIEWPORTS) {
    resizeOwnedWindow(
      state,
      viewport.width + WINDOWS_FRAME.width,
      viewport.height + WINDOWS_FRAME.height,
    );
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
    const requests = [
      { id: "guide", selector: "[data-debug-id='shellx-setup-guide']" },
      { id: "ready", selector: ".shellx-setup-step.ready" },
      { id: "todo", selector: ".shellx-setup-step.todo" },
      ...STEP_SELECTORS.map((selector, index) => ({ id: `step-${index}`, selector })),
    ];
    const results = await waitForHighlights(state.debugBase, token, requests);
    const firstResult = results[0];
    assert(firstResult, `Setup Guide measurements must not be empty at ${viewport.width}px`);
    for (const result of results.filter((entry) => requests.some((request) => request.id === entry.id))) {
      assert.equal(result.status, "resolved", `${result.id} must resolve at ${viewport.width}px`);
      if (result.id !== "guide") {
        assert.equal(result.clipped, false, `${result.id} must remain inside the viewport at ${viewport.width}px`);
      }
      assert.equal(result.contentClipped, false, `${result.id} content must fit at ${viewport.width}px`);
      assert(Math.abs(result.viewportWidth - viewport.width) <= 2, `renderer viewport must be ${viewport.width}px, got ${result.viewportWidth}`);
    }

    await apiJson(state.debugBase, token, "POST", "/state/ui", {
      debugHighlights: [],
      source: "setup-guide-installed-proof",
    });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
    const response = await request(state.debugBase, token, "/screenshot");
    assert(response.ok, `screenshot must succeed at ${viewport.width}px`);
    const png = Buffer.from(await response.arrayBuffer());
    assert(png.length > 10_000, `screenshot must be non-trivial at ${viewport.width}px`);
    const screenshotPath = join(absoluteOutputDir, `setup-guide-${viewport.width}x${viewport.height}.png`);
    writeFileSync(screenshotPath, png);
    viewportReceipts.push({
      requested: viewport,
      renderer: { width: firstResult.viewportWidth, height: firstResult.viewportHeight },
      readyAndTodoVisible: true,
      contentClipped: false,
      screenshot: {
        path: screenshotPath,
        bytes: png.length,
        sha256: createHash("sha256").update(png).digest("hex"),
        dimensions: pngDimensions(png),
      },
    });
  }
  await apiJson(state.debugBase, token, "POST", "/state/ui", {
    debugHighlights: [],
    source: "setup-guide-installed-proof",
  });
  const receiptPath = join(absoluteOutputDir, "setup-guide-installed.json");
  const receipt = {
    schemaVersion: RECEIPT_SCHEMA,
    generatedAt: new Date().toISOString(),
    candidate: {
      appVersion: state.appVersion,
      executableVersion: state.executableVersion,
      artifactSha256: state.artifactSha256,
    },
    viewports: viewportReceipts,
    verdict: "pass",
  };
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  console.log(`PASS installed Setup Guide viewport proof: ${receiptPath}`);
}

main().catch((error) => {
  console.error(`FAIL installed Setup Guide viewport proof: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
