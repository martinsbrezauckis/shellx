import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  captureManualAtlas,
  type ManualAtlasCaptureAdapter,
  type ManualAtlasCaptureTarget,
} from "./lib/manual-atlas-capture";
import { calculateManualAtlasProductSourceSha256FromGit } from "./lib/manual-atlas-product-source.js";
import { MANUAL_ATLAS_CAPTURE_PLAN } from "./lib/manual-atlas-capture-plan";
import {
  captureReleaseSurfaceWebDriverScreenshot,
  executeReleaseSurfaceWebDriverScript,
  setReleaseSurfaceWebDriverWindowRect,
  switchReleaseSurfaceWebDriverWindowByTitle,
} from "./lib/release-surface-webdriver-client";
import type { ReleaseSurfaceWebDriverSession } from "./lib/release-surface-webdriver-binding";

const root = resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const webdriverBase = exactLoopbackOrigin(requiredArg(args, "--webdriver-base"), "WebDriver base");
const debugBase = exactLoopbackOrigin(requiredArg(args, "--debug-base"), "Debug API base");
const appDemoCwd = resolve(requiredArg(args, "--app-demo-cwd"));
const appDemoCwdLaunch = optionalArg(args, "--app-demo-cwd-launch") ?? appDemoCwd;
const appDemoCwdStat = lstatSync(appDemoCwd);
if (!appDemoCwdStat.isDirectory() || appDemoCwdStat.isSymbolicLink()) {
  throw new Error("manual atlas app demo cwd must be a real directory");
}
if (!appDemoCwd.replaceAll("\\", "/").endsWith("/shellx-manual-demo")) {
  throw new Error("manual atlas app demo cwd must use the public-safe shellx-manual-demo leaf");
}
if (!appDemoCwdLaunch.replaceAll("\\", "/").endsWith("/shellx-manual-demo")
  || /[\r\n\0]/.test(appDemoCwdLaunch)) {
  throw new Error("manual atlas app launch cwd must use the public-safe shellx-manual-demo leaf");
}
const sessionId = requiredArg(args, "--session-id");
if (!/^[a-zA-Z0-9._:-]{8,256}$/.test(sessionId)) throw new Error("WebDriver session id is invalid");
const tokenPath = resolve(requiredArg(args, "--debug-token-file"));
const debugToken = readFileSync(tokenPath, "utf8").trim();
if (debugToken.length < 32 || debugToken.length > 4_096 || /[\r\n\0]/.test(debugToken)) {
  throw new Error("Debug API token file does not contain one bounded token");
}
const outputDir = resolve(requiredArg(args, "--out-dir"));
prepareOutputDirectory(outputDir);
const sourceCommit = requiredArg(args, "--source-commit");

const visuals = JSON.parse(readFileSync(join(root, "docs/public/manual/shellx/visuals.json"), "utf8")) as {
  captures: Record<string, ManualAtlasCaptureTarget>;
};
const webdriver: ReleaseSurfaceWebDriverSession = { base: webdriverBase, sessionId };
let browserPrepared = false;

const adapter: ManualAtlasCaptureAdapter = {
  async selectSurface(surface) {
    if (surface === "app") {
      await switchReleaseSurfaceWebDriverWindowByTitle(webdriver, "shellX");
      return;
    }
    if (!browserPrepared) await prepareBrowserWindow();
    await switchReleaseSurfaceWebDriverWindowByTitle(webdriver, "ShellX Browser");
  },
  async setWindowSize(width, height) {
    const devicePixelRatio = Number(await executeReleaseSurfaceWebDriverScript(
      webdriver,
      "return window.devicePixelRatio || 1;",
      [],
    ));
    if (!Number.isFinite(devicePixelRatio) || devicePixelRatio < 1 || devicePixelRatio > 4) {
      throw new Error("manual atlas renderer returned an invalid device-pixel ratio");
    }
    const logicalWidth = Math.round(width / devicePixelRatio);
    const logicalHeight = Math.round(height / devicePixelRatio);
    await setReleaseSurfaceWebDriverWindowRect(webdriver, logicalWidth, logicalHeight);
  },
  async postPatch(_surface, body) {
    await postDebugUi(body);
    await delay(175);
  },
  async click(selector) {
    const result = await executeReleaseSurfaceWebDriverScript(
      webdriver,
      "const node=document.querySelector(arguments[0]); if(!(node instanceof HTMLElement))return false; node.click(); return true;",
      [selector],
    );
    if (result !== true) throw new Error(`manual atlas click target was not found: ${selector}`);
    await delay(175);
  },
  async waitForSelector(selector) {
    await waitForRendererSelector(selector);
  },
  async scroll(selector, edge) {
    const result = await executeReleaseSurfaceWebDriverScript(
      webdriver,
      "const node=document.querySelector(arguments[0]); if(!node)return false; node.scrollTop=arguments[1]==='bottom'?node.scrollHeight:0; return true;",
      [selector, edge],
    );
    if (result !== true) throw new Error(`manual atlas scroll target was not found: ${selector}`);
    await delay(100);
  },
  async screenshot() {
    return captureReleaseSurfaceWebDriverScreenshot(webdriver);
  },
  async saveCapture(file, bytes) {
    const path = join(outputDir, file);
    if (existsSync(path)) throw new Error(`refusing to overwrite manual atlas capture: ${path}`);
    writeFileSync(path, bytes, { flag: "wx" });
  },
  async settle() {
    await delay(350);
  },
};

const manifest = await captureManualAtlas({
  plan: MANUAL_ATLAS_CAPTURE_PLAN,
  targets: visuals.captures,
  candidate: {
    sourceCommit,
    productSourceSha256: calculateManualAtlasProductSourceSha256FromGit(root, sourceCommit),
    version: requiredArg(args, "--version"),
    platform: requiredArg(args, "--platform"),
  },
  adapter,
});
const manifestPath = join(outputDir, "capture-manifest.json");
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
console.log(`Captured ${manifest.captureCount} unreviewed installed-Tauri manual states in ${outputDir}`);

async function prepareBrowserWindow(): Promise<void> {
  try {
    await switchReleaseSurfaceWebDriverWindowByTitle(webdriver, "ShellX Browser");
    browserPrepared = true;
    return;
  } catch {
    await switchReleaseSurfaceWebDriverWindowByTitle(webdriver, "shellX");
  }
  await postDebugUi({
    debugSurface: "app",
    source: "manual-atlas-installed-candidate",
    debugClick: { selector: "[data-debug-id='header-shellx-browser']" },
  });
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      await switchReleaseSurfaceWebDriverWindowByTitle(webdriver, "ShellX Browser");
      browserPrepared = true;
      return;
    } catch {
      await delay(150);
    }
  }
  throw new Error("ShellX Browser window did not open for the installed-candidate atlas");
}

async function postDebugUi(body: Record<string, unknown>): Promise<void> {
  const patch = body.debugSurface === "app"
    ? {
        ...body,
        activeTab: {
          tabId: await resolveActiveAppTabId(),
          cwd: appDemoCwdLaunch,
        },
      }
    : body;
  const response = await fetch(`${debugBase}/state/ui`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${debugToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(patch),
    signal: AbortSignal.timeout(5_000),
  });
  const responseText = await response.text();
  if (!response.ok) {
    throw new Error(`manual atlas Debug API patch failed ${response.status}: ${responseText.slice(0, 1_000)}`);
  }
}

async function resolveActiveAppTabId(): Promise<string> {
  const deadline = Date.now() + 10_000;
  let lastState: Record<string, unknown> | null = null;
  while (Date.now() < deadline) {
    const response = await fetch(`${debugBase}/state/ui`, {
      headers: { Authorization: `Bearer ${debugToken}` },
      signal: AbortSignal.timeout(2_000),
    });
    if (response.ok) {
      lastState = await response.json() as Record<string, unknown>;
      const tabId = typeof lastState.activeTabId === "string"
        ? lastState.activeTabId.trim()
        : "";
      if (/^[a-zA-Z0-9._:-]{1,256}$/.test(tabId)) return tabId;
    } else {
      await response.body?.cancel();
    }
    await delay(100);
  }
  throw new Error(`manual atlas app tab identity did not become available: ${JSON.stringify(lastState)}`);
}

async function waitForRendererSelector(selector: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  let lastObservation: unknown = null;
  while (Date.now() < deadline) {
    lastObservation = await executeReleaseSurfaceWebDriverScript(
      webdriver,
      [
        "const node=document.querySelector(arguments[0]);",
        "if(!(node instanceof HTMLElement))return {present:false};",
        "const rect=node.getBoundingClientRect(); const style=getComputedStyle(node);",
        "return {present:true,width:rect.width,height:rect.height,display:style.display,visibility:style.visibility,opacity:style.opacity};",
      ].join(" "),
      [selector],
    );
    if (isVisibleRendererObservation(lastObservation)) return;
    await delay(100);
  }
  throw new Error(
    `manual atlas renderer selector did not become visible: ${selector}; `
      + `last observation=${JSON.stringify(lastObservation)}`,
  );
}

function isVisibleRendererObservation(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const observation = value as Record<string, unknown>;
  return observation.present === true
    && typeof observation.width === "number" && observation.width > 0
    && typeof observation.height === "number" && observation.height > 0
    && observation.display !== "none"
    && observation.visibility !== "hidden"
    && observation.visibility !== "collapse"
    && observation.opacity !== "0";
}

function prepareOutputDirectory(path: string): void {
  if (existsSync(path)) {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error("manual atlas output must be a real directory");
    }
    if (readdirSync(path).length > 0) throw new Error("manual atlas output directory must be empty");
    return;
  }
  mkdirSync(path, { recursive: true });
}

function requiredArg(values: string[], name: string): string {
  const index = values.indexOf(name);
  const value = index >= 0 ? values[index + 1]?.trim() : "";
  if (!value) throw new Error(`missing required argument ${name}`);
  return value;
}

function optionalArg(values: string[], name: string): string | undefined {
  const index = values.indexOf(name);
  if (index < 0) return undefined;
  const value = values[index + 1]?.trim();
  if (!value || value.startsWith("--") || /[\r\n\0]/.test(value)) {
    throw new Error(`${name} must have one bounded value`);
  }
  return value;
}

function exactLoopbackOrigin(value: string, label: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be an exact loopback HTTP origin`);
  }
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port
    || url.pathname !== "/" || url.search || url.hash || url.username || url.password) {
    throw new Error(`${label} must be an exact http://127.0.0.1:<port> origin`);
  }
  return url.origin;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
