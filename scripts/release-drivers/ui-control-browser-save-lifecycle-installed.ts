import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmdirSync,
  unlinkSync,
} from "node:fs";
import { dirname, extname, join, resolve, win32 } from "node:path";
import { pathToFileURL } from "node:url";

import {
  clickReleaseSurfaceInstalledInputElement,
  closeReleaseSurfaceInstalledInputWindow,
  createReleaseSurfaceInstalledInputSession,
  switchReleaseSurfaceInstalledInputWindow,
  switchReleaseSurfaceInstalledInputWindowByTitle,
  waitForReleaseSurfaceInstalledInputElement,
  type ReleaseSurfaceInstalledInputSession,
} from "../lib/release-surface-installed-input-client";
import {
  RELEASE_SURFACE_DRIVER_MANIFEST_SCHEMA,
  RELEASE_SURFACE_DRIVER_REPORT_SCHEMA,
  completionTimestamp,
  type ReleaseSurfaceDriverManifest,
  type ReleaseSurfaceDriverOutcome,
  type ReleaseSurfaceDriverReport,
  type ReleaseSurfaceDriverRequest,
} from "../lib/release-surface-driver-protocol";
import { resolveReleaseSurfaceRuntimeCandidate } from "../lib/release-surface-runtime-candidate";
import { runReleaseSurfaceDriverCli } from "../lib/release-surface-driver-cli";
import { ReleaseSurfaceTauriInvokeSession } from "../lib/release-surface-tauri-invoke-client";
import {
  cleanupDebugApiBrowserSettleFixture,
  debugApiBrowserSettleRequestPath,
  prepareDebugApiBrowserSettleFixture,
  verifyDebugApiBrowserSettleJson,
  type DebugApiBrowserSettleFixture,
} from "./debug-api-browser-settle-fixture";
import { nodeReadablePath } from "./ui-control-work-preview-start";

type Assignment = ReleaseSurfaceDriverRequest["assignments"][number];
type Connection = { base: string; token: string };
type BrowserTransfer = Record<string, unknown>;
type SaveArtifact = {
  transferId: string;
  nodePath: string;
};

type SaveConfig = {
  action: string;
  selector: string;
  reasons: string[];
  queued: boolean;
};

const DRIVER_ID = "ui-control-browser-save-lifecycle-installed";
const FIXTURE_ID = "ui:browser-save-owned-page-and-download-folder";
const ORACLE_ID = "ui:activation:browser-save-artifact-or-intent-recorded";
const CLEANUP_ID = "ui:close-owned-browser-task-with-candidate-teardown";
const SAVE_MENU = "[data-debug-id='shellx-browser-save-page']";
const SAVE_PANEL = "#shellx-browser-save-menu[aria-labelledby='shellx-browser-save-page']";
const DOWNLOAD_PANEL = "#shellx-browser-download-sidecar[aria-labelledby='shellx-browser-downloads-menu']";
const TIMEOUT_MS = 30_000;

const ACTIONS = new Map<string, SaveConfig>([
  ['src/browser/components/BrowserMenus.tsx:[data-debug-id="shellx-browser-save-fullpage-screenshot"]', {
    action: "full-page-screenshot",
    selector: "[data-debug-id='shellx-browser-save-fullpage-screenshot']",
    reasons: ["userPageSave:fullPageScreenshot"],
    queued: false,
  }],
  ['src/browser/components/BrowserMenus.tsx:[data-debug-id="shellx-browser-save-screenshot"]', {
    action: "window-screenshot",
    selector: "[data-debug-id='shellx-browser-save-screenshot']",
    reasons: ["userPageSave:screenshot"],
    queued: false,
  }],
  ['src/browser/components/BrowserMenus.tsx:[data-debug-id="shellx-browser-save-markdown"]', {
    action: "markdown",
    selector: "[data-debug-id='shellx-browser-save-markdown']",
    reasons: ["userPageSave:markdown"],
    queued: false,
  }],
  ['src/browser/components/BrowserMenus.tsx:[data-debug-id="shellx-browser-save-links"]', {
    action: "links-json",
    selector: "[data-debug-id='shellx-browser-save-links']",
    reasons: ["userPageSave:linksJson"],
    queued: false,
  }],
  ['src/browser/components/BrowserMenus.tsx:[data-debug-id="shellx-browser-save-snapshot"]', {
    action: "snapshot-bundle",
    selector: "[data-debug-id='shellx-browser-save-snapshot']",
    reasons: ["userPageSave:fullPageScreenshot", "userPageSave:snapshotJson"],
    queued: false,
  }],
  ['src/browser/components/BrowserMenus.tsx:[data-debug-id="shellx-browser-save-media"]', {
    action: "queue-media-copy",
    selector: "[data-debug-id='shellx-browser-save-media']",
    reasons: ["userPageSave:media"],
    queued: true,
  }],
  ['src/browser/components/BrowserMenus.tsx:[data-debug-id="shellx-browser-save-code"]', {
    action: "queue-code-copy",
    selector: "[data-debug-id='shellx-browser-save-code']",
    reasons: ["userPageSave:code"],
    queued: true,
  }],
  ['src/browser/components/BrowserMenus.tsx:[data-debug-id="shellx-browser-save-site"]', {
    action: "queue-site-copy",
    selector: "[data-debug-id='shellx-browser-save-site']",
    reasons: ["userPageSave:workingSiteCopy"],
    queued: true,
  }],
]);

const manifest: ReleaseSurfaceDriverManifest = {
  schema: RELEASE_SURFACE_DRIVER_MANIFEST_SCHEMA,
  id: DRIVER_ID,
  kind: "ui-control",
  runtimeBinding: "attested-process",
  invocationTransport: "native-installed-input",
  controllerFiles: [
    "scripts/lib/release-surface-installed-input-client.ts",
    "scripts/lib/release-surface-bounded-observation.ts",
    "scripts/lib/release-surface-macos-native-input.ts",
    "scripts/lib/release-surface-tauri-invoke-client.ts",
    "scripts/release-drivers/debug-api-browser-settle-fixture.ts",
    "scripts/release-drivers/ui-control-browser-save-lifecycle-installed.ts",
    "scripts/shellx-browser-test-cleanup.ts",
  ],
  supportedFixtures: [FIXTURE_ID],
  supportedCleanups: [CLEANUP_ID],
  supportedOracles: [ORACLE_ID],
};

export async function executeBrowserSaveLifecycle(
  request: ReleaseSurfaceDriverRequest,
): Promise<ReleaseSurfaceDriverReport> {
  const startedAt = new Date().toISOString();
  const connection = await resolveReleaseSurfaceRuntimeCandidate(request);
  const input = createReleaseSurfaceInstalledInputSession(request, connection);
  const relay = new ReleaseSurfaceTauriInvokeSession(connection);
  const output = prepareOutputDirectory(request);
  let browserFixture: DebugApiBrowserSettleFixture | null = null;
  let mainWindowHandle: string | null = null;
  let baselineDownloadFolder: string | null = null;
  let downloadFolderChanged = false;
  const outcomes: ReleaseSurfaceDriverOutcome[] = [];
  let setupError: string | null = null;

  try {
    const state = requireObject(await relay.invoke("shellx_browser_state", {}), "Browser Save baseline state");
    baselineDownloadFolder = optionalString(state.downloadFolder, "Browser Save baseline download folder");
    const updated = await relay.invoke("shellx_browser_update_download_folder", {
      request: { downloadFolder: output.launchPath },
    });
    if (updated !== output.launchPath) throw new Error("Browser Save did not set the exact owned download folder");
    downloadFolderChanged = true;
    const readback = requireObject(await relay.invoke("shellx_browser_state", {}), "Browser Save folder readback");
    if (readback.downloadFolder !== output.launchPath) {
      throw new Error("Browser Save did not read back the exact owned download folder");
    }

    browserFixture = await prepareDebugApiBrowserSettleFixture(connection);
    const settled = await apiJson(
      connection,
      "GET",
      debugApiBrowserSettleRequestPath("/browser/settle", browserFixture),
    );
    verifyDebugApiBrowserSettleJson("/browser/settle", settled, browserFixture);
    const switched = await switchReleaseSurfaceInstalledInputWindowByTitle(input, "ShellX Browser");
    mainWindowHandle = switched.originalHandle;

    for (const assignment of request.assignments) {
      outcomes.push(await exerciseBrowserSaveAction(
        connection,
        input,
        assignment,
        browserFixture,
        output.nodePath,
      ));
    }
  } catch (error) {
    setupError = errorText(error);
    for (const assignment of request.assignments.slice(outcomes.length)) {
      const outcome = emptyOutcome(assignment);
      outcome.error = `Browser Save lifecycle setup failed: ${setupError}`;
      outcomes.push(outcome);
    }
  } finally {
    const cleanupErrors: string[] = [];
    if (mainWindowHandle) {
      try {
        await switchReleaseSurfaceInstalledInputWindow(input, mainWindowHandle);
      } catch (error) {
        cleanupErrors.push(`main window restore: ${errorText(error)}`);
      }
    }
    if (browserFixture) {
      try {
        const error = await cleanupDebugApiBrowserSettleFixture(connection, browserFixture);
        if (error) cleanupErrors.push(`owned Browser: ${error}`);
      } catch (error) {
        cleanupErrors.push(`owned Browser: ${errorText(error)}`);
      }
      try {
        const switched = await switchReleaseSurfaceInstalledInputWindowByTitle(input, "ShellX Browser");
        await closeReleaseSurfaceInstalledInputWindow(input);
        await switchReleaseSurfaceInstalledInputWindow(input, mainWindowHandle ?? switched.originalHandle);
      } catch (error) {
        cleanupErrors.push(`Browser window: ${errorText(error)}`);
      }
    }
    if (downloadFolderChanged) {
      try {
        await relay.invoke("shellx_browser_update_download_folder", {
          request: { downloadFolder: baselineDownloadFolder },
        });
        const state = requireObject(await relay.invoke("shellx_browser_state", {}), "Browser Save cleanup state");
        if (optionalString(state.downloadFolder, "Browser Save cleanup download folder") !== baselineDownloadFolder) {
          throw new Error("Browser Save cleanup did not restore the exact download folder baseline");
        }
      } catch (error) {
        cleanupErrors.push(`download folder restore: ${errorText(error)}`);
      }
    }
    try {
      await relay.cleanup();
    } catch (error) {
      cleanupErrors.push(`Tauri relay: ${errorText(error)}`);
    }
    try {
      removeOutputDirectory(output.nodePath);
    } catch (error) {
      cleanupErrors.push(`output directory: ${errorText(error)}`);
    }
    if (cleanupErrors.length > 0) {
      const detail = cleanupErrors.join("; ");
      for (const outcome of outcomes) {
        outcome.cleanup = "fail";
        outcome.error = appendError(outcome.error, `cleanup: ${detail}`);
      }
    }
  }

  return {
    schema: RELEASE_SURFACE_DRIVER_REPORT_SCHEMA,
    mode: request.mode,
    driverId: request.driverId,
    driverKind: request.driverKind,
    platform: request.platform,
    sourceCommit: request.sourceCommit,
    version: request.version,
    inventoryDigest: request.inventoryDigest,
    artifactSha256: request.artifact.sha256,
    controller: request.controller,
    runtime: request.runtime,
    nativeWebDriver: request.nativeWebDriver,
    macosNativeInput: request.macosNativeInput,
    startedAt,
    completedAt: completionTimestamp(startedAt),
    outcomes,
  };
}

export async function exerciseBrowserSaveAction(
  connection: Connection,
  input: ReleaseSurfaceInstalledInputSession,
  assignment: Assignment,
  browserFixture: DebugApiBrowserSettleFixture,
  outputNodePath: string,
): Promise<ReleaseSurfaceDriverOutcome> {
  const outcome = emptyOutcome(assignment);
  const config = ACTIONS.get(assignment.surface.name);
  if (!config || assignment.fixtureId !== FIXTURE_ID || assignment.oracleId !== ORACLE_ID
    || assignment.cleanupId !== CLEANUP_ID) {
    outcome.error = `Browser Save driver rejected ${assignment.surface.name}`;
    return outcome;
  }
  const artifacts: SaveArtifact[] = [];
  try {
    assertOutputDirectoryEmpty(outputNodePath);
    const before = await browserDownloads(connection);
    const beforeIds = new Set(before.map((entry) => requiredString(entry.transferId, "Browser transferId")));

    const menu = await waitForReleaseSurfaceInstalledInputElement(input, SAVE_MENU, {
      timeoutMs: 8_000,
      pollMs: 50,
    });
    await clickReleaseSurfaceInstalledInputElement(input, menu);
    await waitForReleaseSurfaceInstalledInputElement(input, SAVE_PANEL, { timeoutMs: 8_000, pollMs: 50 });
    const control = await waitForReleaseSurfaceInstalledInputElement(input, config.selector, {
      timeoutMs: 8_000,
      pollMs: 50,
    });
    outcome.present = "pass";
    await clickReleaseSurfaceInstalledInputElement(input, control);
    outcome.invoke = "pass";

    const transfers = await waitForNewTransfers(connection, beforeIds, config.reasons.length);
    verifyTransferSet(transfers, config, browserFixture, outputNodePath, artifacts);
    await waitForReleaseSurfaceInstalledInputElement(input, DOWNLOAD_PANEL, { timeoutMs: 10_000, pollMs: 50 });
    outcome.effect = "pass";
    outcome.observedEffect = config.queued
      ? `The installed Browser ${config.action} control recorded exactly one release-owned queued transfer intent for the visible page and opened Downloads; the monotonic row ends with candidate teardown.`
      : `The installed Browser ${config.action} control wrote exact release-owned local artifact bytes, recorded matching completed transfer identity and SHA-256 evidence, opened Downloads, and deleted the owned artifact immediately; the monotonic row ends with candidate teardown.`;
  } catch (error) {
    outcome.error = errorText(error);
  } finally {
    const errors: string[] = [];
    for (const artifact of artifacts) {
      try {
        if (existsSync(artifact.nodePath)) unlinkSync(artifact.nodePath);
        if (existsSync(artifact.nodePath)) throw new Error(`artifact ${artifact.transferId} remained`);
      } catch (error) {
        errors.push(errorText(error));
      }
    }
    try {
      assertOutputDirectoryEmpty(outputNodePath);
    } catch (error) {
      errors.push(errorText(error));
    }
    if (errors.length === 0) outcome.cleanup = "pass";
    else outcome.error = appendError(outcome.error, `action cleanup: ${errors.join("; ")}`);
  }
  return outcome;
}

function verifyTransferSet(
  transfers: BrowserTransfer[],
  config: SaveConfig,
  fixture: DebugApiBrowserSettleFixture,
  outputNodePath: string,
  artifacts: SaveArtifact[],
): void {
  const reasons = transfers.map((entry) => requiredString(entry.reason, `${config.action} reason`)).sort();
  if (JSON.stringify(reasons) !== JSON.stringify([...config.reasons].sort())) {
    throw new Error(`${config.action} produced the wrong exact transfer reason set`);
  }
  for (const entry of transfers) {
    const transferId = requiredString(entry.transferId, `${config.action} transferId`);
    if (entry.direction !== "download" || entry.taskId !== fixture.taskId
      || entry.browserTabId !== fixture.browserTabId || entry.url !== fixture.url
      || !Number.isSafeInteger(entry.requestedAtMs) || Number(entry.requestedAtMs) <= 0) {
      throw new Error(`${config.action} omitted its exact owned task, tab, page, or request identity`);
    }
    if (config.queued) {
      if (entry.status !== "requested" || entry.finalPath !== null || entry.completedAtMs !== null
        || entry.bytes !== null || entry.sha256 !== null || entry.approvalId !== null) {
        throw new Error(`${config.action} did not remain one exact queued transfer intent`);
      }
      continue;
    }
    const finalPath = requiredString(entry.finalPath, `${config.action} finalPath`);
    const nodePath = nodeReadableTransferPath(finalPath);
    const stat = lstatSync(nodePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || entry.status !== "completed"
      || !Number.isSafeInteger(entry.bytes) || Number(entry.bytes) !== stat.size
      || !Number.isSafeInteger(entry.completedAtMs) || Number(entry.completedAtMs) <= 0) {
      throw new Error(`${config.action} did not produce one exact completed regular artifact`);
    }
    assertContainedArtifact(outputNodePath, nodePath);
    const bytes = readFileSync(nodePath);
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (entry.sha256 !== digest) throw new Error(`${config.action} artifact SHA-256 did not match its transfer row`);
    verifyArtifactContent(entry, nodePath, bytes, fixture.url);
    artifacts.push({ transferId, nodePath });
  }
}

function verifyArtifactContent(
  entry: BrowserTransfer,
  nodePath: string,
  bytes: Buffer,
  sourceUrl: string,
): void {
  const reason = requiredString(entry.reason, "Browser Save artifact reason");
  const extension = extname(nodePath).toLowerCase();
  if (reason === "userPageSave:screenshot" || reason === "userPageSave:fullPageScreenshot") {
    if (extension !== ".png" || entry.mimeType !== "image/png"
      || bytes.length < 8 || !bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) {
      throw new Error("Browser Save screenshot artifact was not an exact PNG");
    }
    return;
  }
  const text = bytes.toString("utf8");
  if (reason === "userPageSave:markdown") {
    if (extension !== ".md" || entry.mimeType !== "text/markdown"
      || !text.includes("Owned Browser settle fixture ready")) {
      throw new Error("Browser Save Markdown artifact was empty or mislabeled");
    }
    return;
  }
  if (extension !== ".json" || entry.mimeType !== "application/json") {
    throw new Error("Browser Save JSON artifact was mislabeled");
  }
  const json = requireObject(JSON.parse(text), "Browser Save JSON artifact");
  if (json.sourceUrl !== sourceUrl || typeof json.capturedAt !== "string") {
    throw new Error("Browser Save JSON artifact omitted its exact source and capture identity");
  }
  if (reason === "userPageSave:linksJson") {
    if (!Number.isSafeInteger(json.count) || !Array.isArray(json.links) || json.count !== json.links.length) {
      throw new Error("Browser Save Links JSON omitted its exact bounded link collection");
    }
  } else if (reason === "userPageSave:snapshotJson") {
    const screenshot = requireObject(json.screenshot, "Browser Save snapshot screenshot");
    if (typeof json.markdown !== "string" || !json.markdown.includes("Owned Browser settle fixture ready")
      || !Array.isArray(json.links) || typeof screenshot.sha256 !== "string"
      || !/^[a-f0-9]{64}$/.test(screenshot.sha256)) {
      throw new Error("Browser Save snapshot JSON omitted page text, links, or screenshot evidence");
    }
  } else {
    throw new Error(`unsupported completed Browser Save reason ${reason}`);
  }
}

async function waitForNewTransfers(
  connection: Connection,
  baselineIds: Set<string>,
  expectedCount: number,
): Promise<BrowserTransfer[]> {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    const fresh = (await browserDownloads(connection)).filter((entry) => {
      const id = typeof entry.transferId === "string" ? entry.transferId : "";
      return id && !baselineIds.has(id);
    });
    if (fresh.length > expectedCount) throw new Error("Browser Save created more transfer rows than declared");
    if (fresh.length === expectedCount && fresh.every((entry) => entry.status === "requested" || entry.status === "completed")) {
      return fresh;
    }
    await delay(50);
  }
  throw new Error(`Browser Save did not expose ${expectedCount} exact new transfer row(s)`);
}

async function browserDownloads(connection: Connection): Promise<BrowserTransfer[]> {
  const body = await apiJson(connection, "GET", "/browser/downloads");
  if (!Array.isArray(body.downloads)) throw new Error("Browser downloads did not return an array");
  return body.downloads.map((entry, index) => requireObject(entry, `Browser downloads[${index}]`));
}

function prepareOutputDirectory(
  request: ReleaseSurfaceDriverRequest,
): { launchPath: string; nodePath: string } {
  const suffix = request.sourceCommit.slice(0, 16).toLowerCase().replace(/[^a-f0-9]/g, "0");
  const name = `release-browser-save-${suffix}`;
  const launchPath = siblingPath(request.runtime.debugTokenPath, name, request.platform);
  const nodePath = nodeReadablePath(launchPath, request.platform);
  if (existsSync(nodePath)) throw new Error(`Browser Save output directory pre-existed: ${name}`);
  mkdirSync(nodePath, { mode: 0o700 });
  const stat = lstatSync(nodePath);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Browser Save output is not a regular directory");
  return { launchPath, nodePath };
}

function removeOutputDirectory(nodePath: string): void {
  if (!existsSync(nodePath)) return;
  assertOutputDirectoryEmpty(nodePath);
  rmdirSync(nodePath);
  if (existsSync(nodePath)) throw new Error("Browser Save output directory remained");
}

function assertOutputDirectoryEmpty(nodePath: string): void {
  const entries = readdirSync(nodePath);
  if (entries.length !== 0) throw new Error(`Browser Save output retained ${entries.length} unexpected item(s)`);
}

function assertContainedArtifact(outputNodePath: string, artifactNodePath: string): void {
  const root = realpathSync(outputNodePath);
  const artifact = realpathSync(artifactNodePath);
  const separator = process.platform === "win32" ? "\\" : "/";
  if (!artifact.startsWith(`${root}${separator}`) || dirname(artifact) !== root) {
    throw new Error("Browser Save artifact escaped its exact owned output directory");
  }
}

function siblingPath(
  tokenPath: string,
  name: string,
  platform: ReleaseSurfaceDriverRequest["platform"],
): string {
  if (platform === "windows-installed" && /^[A-Za-z]:[\\/]/.test(tokenPath)) {
    return win32.join(win32.dirname(tokenPath), name);
  }
  return join(dirname(tokenPath), name);
}

function nodeReadableTransferPath(path: string): string {
  if (process.platform !== "win32" && /^[A-Za-z]:[\\/]/.test(path)) {
    const result = spawnSync("wslpath", ["-u", path], { encoding: "utf8" });
    if (result.status !== 0 || !result.stdout.trim()) {
      throw new Error("unable to map the Browser Save artifact path into WSL");
    }
    return resolve(result.stdout.trim());
  }
  return resolve(path);
}

async function apiJson(
  connection: Connection,
  method: "GET" | "POST",
  path: string,
): Promise<Record<string, unknown>> {
  const response = await fetch(`${connection.base}${path}`, {
    method,
    headers: { Authorization: `Bearer ${connection.token}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path} failed ${response.status}: ${text.slice(0, 1_200)}`);
  return requireObject(text.trim() ? JSON.parse(text) : {}, `${method} ${path}`);
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} did not return an object`);
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function optionalString(value: unknown, label: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be null or a non-empty string`);
  return value;
}

function emptyOutcome(assignment: Assignment): ReleaseSurfaceDriverOutcome {
  return {
    id: assignment.surface.id,
    expectedEffect: assignment.expectedEffect,
    oracleId: assignment.oracleId,
    present: "fail",
    invoke: "fail",
    effect: "fail",
    cleanup: "fail",
    observedEffect: "No exact installed Browser Save artifact or queued transfer lifecycle was observed.",
  };
}

function appendError(current: string | undefined, next: string): string {
  return current ? `${current}; ${next}` : next;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runReleaseSurfaceDriverCli(manifest, executeBrowserSaveLifecycle).catch((error) => {
    console.error(errorText(error));
    process.exitCode = 1;
  });
}
