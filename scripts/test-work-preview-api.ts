import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";

type WorkPreviewState = {
  tabId: string;
  status: "idle" | "starting" | "running" | "failed" | "stopped";
  kind: "staticHtml" | "webApp" | "expoWeb" | null;
  url: string | null;
  pid: number | null;
  logs: Array<{ stream: string; line: string }>;
  error: string | null;
};

type WorkPreviewDiagnostic = {
  ok: boolean;
  status: string;
  title: string | null;
  issues: Array<{ severity: string; source: string; message: string }>;
  browserEvents: unknown[];
};

const baseUrl =
  process.env.SHELLX_WORK_PREVIEW_BASE_URL ||
  process.env.SHELLX_PREVIEW_BASE_URL ||
  process.env.DEBUG_API_URL;
const token =
  process.env.SHELLX_WORK_PREVIEW_TOKEN ||
  process.env.SHELLX_PREVIEW_TOKEN ||
  process.env.GROK_SHELL_DEBUG_SECRET ||
  readOptional(join(homedir(), ".shellx", "shellxagent.token"));

let failures = 0;

function joinTargetPath(root: string, child: string): string {
  if (/^(?:[A-Za-z]:[\\/]|\\\\)/.test(root)) {
    return `${root.replace(/[\\/]+$/, "")}\\${child}`;
  }
  return join(root, child);
}

function readOptional(path: string): string {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return "";
  }
}

function assert(cond: boolean, label: string): void {
  console.log(`  ${cond ? "✓" : "✗"} ${label}`);
  if (!cond) failures += 1;
}

function originFor(url: string): string {
  const parsed = new URL(url);
  return parsed.origin;
}

function headers(extra?: Record<string, string>): Record<string, string> {
  return {
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...(extra ?? {}),
  };
}

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  if (!baseUrl) throw new Error("SHELLX_WORK_PREVIEW_BASE_URL or DEBUG_API_URL is required");
  const response = await fetch(`${baseUrl}${path}`, init);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${init?.method ?? "GET"} ${path} -> ${response.status}: ${text}`);
  }
  return JSON.parse(text) as T;
}

async function startPreview(
  tabId: string,
  body: { cwd: string; kind: string; entry?: string },
): Promise<WorkPreviewState> {
  return json<WorkPreviewState>(`/preview/work/start?tabId=${encodeURIComponent(tabId)}`, {
    method: "POST",
    headers: headers({ "content-type": "application/json" }),
    body: JSON.stringify({ tabId, ...body }),
  });
}

async function stopPreview(tabId: string): Promise<WorkPreviewState> {
  return json<WorkPreviewState>(`/preview/work/stop?tabId=${encodeURIComponent(tabId)}`, {
    method: "POST",
    headers: headers({ "content-type": "application/json" }),
    body: JSON.stringify({ tabId }),
  });
}

async function diagnosePreview(tabId: string, body: object = {}): Promise<WorkPreviewDiagnostic> {
  return json<WorkPreviewDiagnostic>(`/preview/work/diagnose?tabId=${encodeURIComponent(tabId)}`, {
    method: "POST",
    headers: headers({ "content-type": "application/json" }),
    body: JSON.stringify({ tabId, ...body }),
  });
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`preview fetch ${url} -> ${response.status}`);
  return response.text();
}

async function removeTempDir(path: string): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      rmSync(path, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt === 9) throw error;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }
}

async function main(): Promise<void> {
  console.log("\n=== work preview debug-api smoke ===");

  if (!baseUrl) {
    console.log("SKIP work preview API smoke: no live debug API base URL supplied");
    return;
  }

  await json("/health");
  assert(true, "debug API health responds");

  const fixtureRoot = process.env.SHELLX_WORK_PREVIEW_FIXTURE_ROOT || tmpdir();
  const root = mkdtempSync(join(fixtureRoot, "shellx-work-preview-api-"));
  const targetRootBase = process.env.SHELLX_WORK_PREVIEW_TARGET_ROOT;
  const targetRoot = targetRootBase ? joinTargetPath(targetRootBase, basename(root)) : root;
  const staticRoot = join(root, "static");
  const webRoot = join(root, "web");
  const staticTargetRoot = joinTargetPath(targetRoot, "static");
  const webTargetRoot = joinTargetPath(targetRoot, "web");

  try {
    mkdirSync(staticRoot, { recursive: true });
    mkdirSync(webRoot, { recursive: true });
    const smokeScriptTag = `<${"script"} src="/app.js"></${"script"}>`;
    writeFileSync(
      join(staticRoot, "index.html"), // nosemgrep: javascript.lang.security.audit.unknown-value-with-script-tag.unknown-value-with-script-tag -- fixed local smoke fixture.
      `<!doctype html><html><body><main>STATIC_ENDPOINT_OK</main>${smokeScriptTag}</body></html>`,
      "utf8",
    );
    writeFileSync(join(staticRoot, "app.js"), "window.shellxPreviewSmoke = true;", "utf8");
    writeFileSync(join(staticRoot, "alpha.html"), "<main>ALPHA_ENTRY_SHOULD_NOT_BE_USED</main>", "utf8");
    writeFileSync(
      join(staticRoot, "shellx-preview-test.html"),
      "<main>REQUESTED_STATIC_ENTRY_OK</main>",
      "utf8",
    );
    writeFileSync(join(staticRoot, ".env"), "SECRET=should-not-serve", "utf8");
    writeFileSync(join(staticRoot, "package.json"), JSON.stringify({ private: "not-preview-asset" }), "utf8");
    writeFileSync(
      join(webRoot, "package.json"),
      JSON.stringify({ scripts: { dev: "node server.js" } }),
      "utf8",
    );
    writeFileSync(
      join(webRoot, "server.js"),
      `
const http = require('http');
const port = Number(process.env.PORT || 0);
const host = process.env.HOST || '127.0.0.1';
http.createServer((req, res) => {
  console.log('served ' + req.url);
  res.end('WEB_ENDPOINT_OK');
}).listen(port, host, () => console.log('ready ' + host + ':' + port));
`,
      "utf8",
    );

    const staticState = await startPreview("api-static", { cwd: staticTargetRoot, kind: "static" });
    assert(staticState.status === "running", "static preview starts");
    assert(staticState.kind === "staticHtml", "static preview kind is reported");
    assert(!!staticState.url, "static preview returns URL");
    const staticBody = await fetchText(staticState.url ?? "");
    assert(staticBody.includes("STATIC_ENDPOINT_OK"), "static preview serves index.html");
    assert(staticBody.includes("data-shellx-preview-doctor"), "static preview injects browser diagnostics bridge");
    const staticOrigin = originFor(staticState.url ?? "");
    const staticAsset = await fetchText(`${staticOrigin}/app.js`);
    assert(staticAsset.includes("shellxPreviewSmoke"), "static preview serves JS assets");
    const envResponse = await fetch(`${staticOrigin}/.env`);
    assert(!envResponse.ok, "static preview blocks .env files");
    const packageResponse = await fetch(`${staticOrigin}/package.json`);
    assert(!packageResponse.ok, "static preview blocks package metadata");
    const staticStopped = await stopPreview("api-static");
    assert(staticStopped.status === "stopped", "static preview stops");

    const staticEntryState = await startPreview("api-static-entry", {
      cwd: staticTargetRoot,
      kind: "static",
      entry: "shellx-preview-test.html",
    });
    assert(staticEntryState.status === "running", "static preview starts with requested entry");
    assert(
      (staticEntryState.url ?? "").endsWith("/shellx-preview-test.html"),
      "static preview URL points at requested HTML entry",
    );
    const staticEntryBody = await fetchText(staticEntryState.url ?? "");
    assert(staticEntryBody.includes("REQUESTED_STATIC_ENTRY_OK"), "static preview serves requested HTML entry");
    assert(!staticEntryBody.includes("ALPHA_ENTRY_SHOULD_NOT_BE_USED"), "static preview does not pick first HTML");
    const staticEntryDiagnostic = await diagnosePreview("api-static-entry", {
      browserEvents: [
        {
          level: "error",
          message: "ReferenceError: missingState is not defined",
          source: "shellx-preview-test.html",
        },
      ],
      screenshotPath: "preview-smoke.png",
    });
    assert(!staticEntryDiagnostic.ok, "Preview Doctor reports browser errors");
    assert(
      staticEntryDiagnostic.issues.some((issue) => issue.source === "browser"),
      "Preview Doctor includes browser issue source",
    );
    assert(staticEntryDiagnostic.browserEvents.length === 1, "Preview Doctor echoes browser events");
    const staticEntryStopped = await stopPreview("api-static-entry");
    assert(staticEntryStopped.status === "stopped", "requested-entry static preview stops");

    const webState = await startPreview("api-web", {
      cwd: webTargetRoot,
      kind: "web",
    });
    assert(webState.status === "running", "command preview starts");
    assert(webState.kind === "webApp", "command preview kind is reported");
    assert(!!webState.pid, "command preview reports pid");
    const webBody = await fetchText(webState.url ?? "");
    assert(webBody.includes("WEB_ENDPOINT_OK"), "command preview serves HTTP output");
    await new Promise((resolve) => setTimeout(resolve, 150));
    const webLatest = await json<WorkPreviewState>("/preview/work/state?tabId=api-web", {
      headers: headers(),
    });
    assert(webLatest.logs.some((line) => /ready|served/.test(line.line)), "command preview captures logs");
    const webStopped = await stopPreview("api-web");
    assert(webStopped.status === "stopped", "command preview stops");
  } finally {
    await stopPreview("api-static").catch(() => undefined);
    await stopPreview("api-static-entry").catch(() => undefined);
    await stopPreview("api-web").catch(() => undefined);
    await removeTempDir(root);
  }

  console.log(`\n${failures === 0 ? "PASS" : "FAIL"} work preview debug-api smoke`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
