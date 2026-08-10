import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  rmdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { releaseSurfaceProfileLaunchRootFromDebugTokenPath } from "../lib/release-surface-run-profile";
import {
  clearReleaseSurfaceInstalledInputElement,
  clickReleaseSurfaceInstalledInputElement,
  observeReleaseSurfaceInstalledInputElement,
  setReleaseSurfaceInstalledInputElementValue,
  waitForReleaseSurfaceInstalledInputElement,
  waitForReleaseSurfaceInstalledInputElementAbsent,
  type ReleaseSurfaceInstalledInputSession,
} from "../lib/release-surface-installed-input-client";
import type {
  ReleaseSurfaceDriverOutcome,
  ReleaseSurfaceDriverRequest,
} from "../lib/release-surface-driver-protocol";
import { postUi } from "./ui-control-work-preview-start";

type Assignment = ReleaseSurfaceDriverRequest["assignments"][number];
type Connection = { base: string; token: string };
type InstalledInput = ReleaseSurfaceInstalledInputSession;
type Action = "recommended" | "toggle" | "install-key" | "install-zero" | "save-key" | "remove";
type VaultDirectory = { keys: string[]; entries: Array<Record<string, unknown>> };
type FileSnapshot = {
  path: string;
  existed: boolean;
  content: Buffer | null;
  mode: number | null;
  parentExisted: boolean;
};
type Fixture = {
  files: FileSnapshot[];
  vault: VaultDirectory;
};

const SURFACE_IDS = new Map<string, Action>([
  [id('role=button;name="Enable Recommended"', 4), "recommended"],
  [id('[data-debug-id="plugins-entry-toggle"]', 7), "toggle"],
  [id('[data-debug-id="surface-components-pluginsmodal-10"]', 10), "install-key"],
  [id('[data-debug-id="surface-components-pluginsmodal-11"]', 11), "install-zero"],
  [id('[data-debug-id="surface-components-pluginsmodal-13"]', 13), "save-key"],
  [id('role=button;name="Remove"', 8), "remove"],
]);

const DIALOG = "[role='dialog'][aria-label='Plugins']";
const HERO = ".mp-hero button.mp-action-btn-primary";
const CONTEXT_ROW = "[data-marketplace-entry-id='context7']";
const GITHUB_ROW = "[data-marketplace-entry-id='github']";
const CONTEXT_ENABLE = `${CONTEXT_ROW} [data-debug-id='surface-components-pluginsmodal-11']`;
const GITHUB_ENABLE_ANYWAY = `${GITHUB_ROW} [data-debug-id='surface-components-pluginsmodal-10']`;
const CONTEXT_TOGGLE = `${CONTEXT_ROW} [data-debug-id='plugins-entry-toggle']`;
const CONTEXT_REMOVE = `${CONTEXT_ROW} .mp-row-actions > button.mp-action-btn-secondary`;
const GITHUB_ADD_KEY = `${GITHUB_ROW} [title='Enter your API key inline']`;
const GITHUB_INPUT = `${GITHUB_ROW} [data-debug-id='plugins-vault-key-input']`;
const GITHUB_SAVE = `${GITHUB_ROW} [data-debug-id='surface-components-pluginsmodal-13']`;
const GITHUB_ENABLE = `${GITHUB_ROW} [data-debug-id='surface-components-pluginsmodal-11']`;
const OWNED_VAULT_KEY = "github/pat";
const OWNED_VAULT_VALUE = "SHELLX_RELEASE_PLUGIN_SYNTHETIC_VAULT_VALUE";
const FIXTURE_ID = "ui:plugins-owned-production-profile";
const CLEANUP_ID = "ui:restore-owned-plugin-config-delete-synthetic-vault-key-and-close-modal";

export const PLUGINS_PRODUCTION_FIXTURES = [FIXTURE_ID] as const;
export const PLUGINS_PRODUCTION_CLEANUPS = [CLEANUP_ID] as const;
export const PLUGINS_PRODUCTION_ORACLES = [
  "ui:activation:plugins-recommended-installed",
  "ui:boolean-state-transition",
  "ui:activation:plugins-entry-installed",
  "ui:activation:plugins-vault-key-saved",
  "ui:activation:plugins-entry-removed",
] as const;

export function supportsPluginsProductionControl(assignment: Assignment): boolean {
  return SURFACE_IDS.has(assignment.surface.id);
}

export async function exercisePluginsProductionControl(
  connection: Connection,
  installedInput: InstalledInput,
  request: ReleaseSurfaceDriverRequest,
  assignment: Assignment,
): Promise<ReleaseSurfaceDriverOutcome> {
  const outcome = emptyOutcome(assignment);
  const action = SURFACE_IDS.get(assignment.surface.id);
  let fixture: Fixture | null = null;
  try {
    if (!action) throw new Error(`unsupported Plugins production surface ${assignment.surface.id}`);
    fixture = await prepareFixture(connection, installedInput, request);
    if (action === "recommended") {
      await invokeControl(installedInput, HERO, outcome);
      await waitForReleaseSurfaceInstalledInputElement(installedInput, CONTEXT_TOGGLE);
      await requireChecked(installedInput, CONTEXT_TOGGLE, true);
      verifyMarketplaceMutation(fixture, "context7", true, true, true);
      outcome.observedEffect = "Native input ran the real recommended-install path for the one fixed offline connector and proved its exact isolated marketplace/config state.";
    } else if (action === "toggle") {
      await installContext7(installedInput);
      outcome.present = "pass";
      await clickSelector(installedInput, CONTEXT_TOGGLE);
      outcome.invoke = "pass";
      await requireChecked(installedInput, CONTEXT_TOGGLE, false);
      verifyMarketplaceMutation(fixture, "context7", true, false, true);
      outcome.observedEffect = "Native input disabled the installed fixed connector through the real toggle path and proved installed=true, enabled=false in isolated state/config.";
    } else if (action === "install-key") {
      await invokeControl(installedInput, GITHUB_ENABLE_ANYWAY, outcome);
      await waitForReleaseSurfaceInstalledInputElement(installedInput, `${GITHUB_ROW} [data-debug-id='plugins-entry-toggle']`);
      verifyMarketplaceMutation(fixture, "github", true, true, true);
      await requireVaultUnchanged(connection, fixture.vault);
      outcome.observedEffect = "Native input used the real missing-key install path, wrote only the isolated GitHub marketplace/config records, and left Vault unchanged.";
    } else if (action === "install-zero") {
      await invokeControl(installedInput, CONTEXT_ENABLE, outcome);
      await waitForReleaseSurfaceInstalledInputElement(installedInput, CONTEXT_TOGGLE);
      verifyMarketplaceMutation(fixture, "context7", true, true, true);
      outcome.observedEffect = "Native input installed the fixed zero-key connector through the real production path and proved its exact isolated marketplace/config records.";
    } else if (action === "save-key") {
      await clickSelector(installedInput, GITHUB_ADD_KEY);
      const input = await waitForReleaseSurfaceInstalledInputElement(installedInput, GITHUB_INPUT);
      await clearReleaseSurfaceInstalledInputElement(installedInput, input);
      await setReleaseSurfaceInstalledInputElementValue(installedInput, input, OWNED_VAULT_VALUE);
      outcome.present = "pass";
      await clickSelector(installedInput, GITHUB_SAVE);
      outcome.invoke = "pass";
      await waitForReleaseSurfaceInstalledInputElementAbsent(installedInput, GITHUB_INPUT);
      await waitForReleaseSurfaceInstalledInputElement(installedInput, GITHUB_ENABLE);
      await requireOwnedVaultKey(connection, fixture.vault);
      requireFilesEqual(fixture.files, "Vault Save unexpectedly changed marketplace files");
      outcome.observedEffect = "Native input saved one synthetic value through the real Vault path, proved only its redacted key metadata, and observed no marketplace/config mutation.";
    } else if (action === "remove") {
      await installContext7(installedInput);
      outcome.present = "pass";
      await clickSelector(installedInput, CONTEXT_REMOVE);
      outcome.invoke = "pass";
      await waitForReleaseSurfaceInstalledInputElement(installedInput, CONTEXT_ENABLE);
      verifyMarketplaceMutation(fixture, "context7", false, true, false);
      outcome.observedEffect = "Native input removed the fixed connector through the real production path, proved installed=false in isolated state, and proved its managed config block absent.";
    }
    outcome.effect = "pass";
  } catch (error) {
    outcome.error = errorText(error);
  } finally {
    const cleanupError = fixture
      ? await cleanupFixture(connection, installedInput, fixture)
      : await closeFixture(connection, installedInput);
    if (!cleanupError) outcome.cleanup = "pass";
    else outcome.error = outcome.error ? `${outcome.error}; cleanup: ${cleanupError}` : `cleanup: ${cleanupError}`;
  }
  return finalize(outcome);
}

async function prepareFixture(
  connection: Connection,
  installedInput: InstalledInput,
  request: ReleaseSurfaceDriverRequest,
): Promise<Fixture> {
  const files = snapshotMarketplaceFiles(request);
  const vault = await readVaultDirectory(connection);
  if (vault.keys.includes(OWNED_VAULT_KEY)) throw new Error("synthetic Plugins Vault key already existed");
  await postUi(connection, { openModal: "close", debugPluginsFixture: "clear", source: "final-surface-plugins-production-baseline" });
  await waitForReleaseSurfaceInstalledInputElementAbsent(installedInput, DIALOG);
  await postUi(connection, { debugPluginsFixture: "owned-production", openModal: "plugins", source: "final-surface-plugins-production-open" });
  await waitForReleaseSurfaceInstalledInputElement(installedInput, DIALOG);
  await waitForReleaseSurfaceInstalledInputElement(installedInput, CONTEXT_ENABLE);
  await waitForReleaseSurfaceInstalledInputElement(installedInput, GITHUB_ENABLE_ANYWAY);
  requireFilesEqual(files, "Plugins fixture preparation changed marketplace files");
  return { files, vault };
}

async function installContext7(installedInput: InstalledInput): Promise<void> {
  await clickSelector(installedInput, CONTEXT_ENABLE);
  await waitForReleaseSurfaceInstalledInputElement(installedInput, CONTEXT_TOGGLE);
  await requireChecked(installedInput, CONTEXT_TOGGLE, true);
}

async function invokeControl(
  installedInput: InstalledInput,
  selector: string,
  outcome: ReleaseSurfaceDriverOutcome,
): Promise<void> {
  const control = await waitForReleaseSurfaceInstalledInputElement(installedInput, selector);
  outcome.present = "pass";
  await clickReleaseSurfaceInstalledInputElement(installedInput, control);
  outcome.invoke = "pass";
}

async function clickSelector(installedInput: InstalledInput, selector: string): Promise<void> {
  await clickReleaseSurfaceInstalledInputElement(
    installedInput,
    await waitForReleaseSurfaceInstalledInputElement(installedInput, selector),
  );
}

async function requireChecked(installedInput: InstalledInput, selector: string, expected: boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const observed = await observeReleaseSurfaceInstalledInputElement(installedInput, selector, ["checked"]);
    if (observed.present && observed.visible && observed.checked === expected) return;
    await delay(50);
  }
  throw new Error(`${selector} did not reach checked=${String(expected)}`);
}

function verifyMarketplaceMutation(
  fixture: Fixture,
  id: "context7" | "github",
  installed: boolean,
  enabled: boolean,
  configPresent: boolean,
): void {
  const stateFile = fixture.files.find((file) => file.path.endsWith("mcp-marketplace.json"));
  const configFile = fixture.files.find((file) => file.path.endsWith("config.toml"));
  if (!stateFile || !configFile || !existsSync(stateFile.path)) throw new Error("marketplace state file was not written");
  const parsed = JSON.parse(readFileSync(stateFile.path, "utf8")) as { entries?: Record<string, { installed?: boolean; enabled?: boolean }> };
  const entries = parsed.entries ?? {};
  const entry = entries[id];
  if (!entry || entry.installed !== installed || entry.enabled !== enabled || Object.keys(entries).some((key) => key !== id)) {
    throw new Error(`marketplace state did not reach the exact isolated ${id} transition`);
  }
  const config = existsSync(configFile.path) ? readFileSync(configFile.path, "utf8") : "";
  const begin = `# shellX:managed-mcp-marketplace:${id} BEGIN - do not edit by hand`;
  const end = `# shellX:managed-mcp-marketplace:${id} END`;
  if (configPresent !== (config.includes(begin) && config.includes(end))) {
    throw new Error(`marketplace config block presence was wrong for ${id}`);
  }
  if (configPresent) {
    const block = config.slice(config.indexOf(begin), config.indexOf(end) + end.length);
    if (!block.includes(`enabled = ${enabled ? "true" : "false"}`)) {
      throw new Error(`marketplace config enabled state was wrong for ${id}`);
    }
    if (id === "github" && !block.includes("${SHELLX_MCP_MARKETPLACE_GITHUB_PAT}")) {
      throw new Error("GitHub config did not preserve the Vault environment reference");
    }
  }
  if (config.includes(OWNED_VAULT_VALUE)) throw new Error("marketplace config exposed synthetic Vault material");
  const markers = [...config.matchAll(/# shellX:managed-mcp-marketplace:([^ ]+) BEGIN/g)].map((match) => match[1]);
  if (markers.some((marker) => marker !== id)) throw new Error("marketplace action changed a non-fixture managed config block");
}

async function requireOwnedVaultKey(connection: Connection, baseline: VaultDirectory): Promise<void> {
  const current = await readVaultDirectory(connection);
  if (!current.keys.includes(OWNED_VAULT_KEY)
    || current.keys.length !== baseline.keys.length + 1
    || current.entries.some((entry) => Object.hasOwn(entry, "value") || Object.hasOwn(entry, "secret"))) {
    throw new Error("Plugins Vault Save did not create exactly one redacted synthetic key");
  }
}

async function requireVaultUnchanged(connection: Connection, baseline: VaultDirectory): Promise<void> {
  const current = await readVaultDirectory(connection);
  if (stableJson(current) !== stableJson(baseline)) throw new Error("marketplace action changed isolated Vault metadata");
}

async function cleanupFixture(
  connection: Connection,
  installedInput: InstalledInput,
  fixture: Fixture,
): Promise<string | null> {
  const errors: string[] = [];
  try {
    const closeError = await closeFixture(connection, installedInput);
    if (closeError) errors.push(closeError);
  } catch (error) {
    errors.push(errorText(error));
  }
  try {
    const current = await readVaultDirectory(connection);
    if (current.keys.includes(OWNED_VAULT_KEY)) {
      const deleted = await apiJson(connection, "POST", "/vault/delete", { key: OWNED_VAULT_KEY });
      assertNoSecretMaterial(deleted, "Vault cleanup");
      if (deleted.ok !== true || deleted.key !== OWNED_VAULT_KEY) throw new Error("Vault cleanup returned the wrong redacted receipt");
    }
    await requireVaultUnchanged(connection, fixture.vault);
  } catch (error) {
    errors.push(errorText(error));
  }
  try {
    restoreFiles(fixture.files);
    requireFilesEqual(fixture.files, "marketplace files were not restored exactly");
  } catch (error) {
    errors.push(errorText(error));
  }
  try {
    await postUi(connection, { debugPluginsFixture: "owned-production", openModal: "plugins", source: "final-surface-plugins-production-cleanup-proof" });
    await waitForReleaseSurfaceInstalledInputElement(installedInput, CONTEXT_ENABLE);
    await waitForReleaseSurfaceInstalledInputElement(installedInput, GITHUB_ENABLE_ANYWAY);
    const closeError = await closeFixture(connection, installedInput);
    if (closeError) errors.push(closeError);
  } catch (error) {
    errors.push(errorText(error));
  }
  return errors.length > 0 ? errors.join("; ") : null;
}

async function closeFixture(connection: Connection, installedInput: InstalledInput): Promise<string | null> {
  try {
    await postUi(connection, { openModal: "close", debugPluginsFixture: "clear", source: "final-surface-plugins-production-close" });
    await waitForReleaseSurfaceInstalledInputElementAbsent(installedInput, DIALOG);
    return null;
  } catch (error) {
    return errorText(error);
  }
}

function snapshotMarketplaceFiles(request: ReleaseSurfaceDriverRequest): FileSnapshot[] {
  const launchRoot = releaseSurfaceProfileLaunchRootFromDebugTokenPath(request.runtime.debugTokenPath, request.platform);
  const root = nodeReadablePath(launchRoot, request.platform);
  if (!/^shellx-final-webdriver-[a-f0-9]{16,64}$/.test(basename(root))) {
    throw new Error("Plugins production driver requires the exact disposable final-candidate profile");
  }
  return [join(root, ".shellx", "mcp-marketplace.json"), join(root, ".grok", "config.toml")].map((path) => ({
    path,
    existed: existsSync(path),
    content: existsSync(path) ? readFileSync(path) : null,
    mode: existsSync(path) ? statSync(path).mode & 0o777 : null,
    parentExisted: existsSync(dirname(path)),
  }));
}

function restoreFiles(files: FileSnapshot[]): void {
  for (const file of files) {
    if (file.existed) {
      if (!file.content || file.mode === null) throw new Error("marketplace baseline snapshot was incomplete");
      mkdirSync(dirname(file.path), { recursive: true, mode: 0o700 });
      writeFileSync(file.path, file.content, { flag: "w", mode: file.mode });
      if (process.platform !== "win32") chmodSync(file.path, file.mode);
    } else if (existsSync(file.path)) {
      rmSync(file.path);
    }
  }
  for (const parent of [...new Set(files.filter((file) => !file.parentExisted).map((file) => dirname(file.path)))]) {
    if (existsSync(parent)) {
      try { rmdirSync(parent); } catch { /* Other candidate-owned state keeps the directory. */ }
    }
  }
}

function requireFilesEqual(files: FileSnapshot[], message: string): void {
  for (const file of files) {
    if (file.existed) {
      if (!existsSync(file.path) || !file.content || !readFileSync(file.path).equals(file.content)) throw new Error(message);
    } else if (existsSync(file.path)) {
      throw new Error(message);
    }
  }
}

async function readVaultDirectory(connection: Connection): Promise<VaultDirectory> {
  const body = await apiJson(connection, "GET", "/vault/keys");
  assertNoSecretMaterial(body, "Vault directory");
  if (!Array.isArray(body.keys) || !Array.isArray(body.entries)
    || body.keys.some((key) => typeof key !== "string")
    || body.entries.some((entry) => !entry || typeof entry !== "object" || Array.isArray(entry))) {
    throw new Error("Vault directory returned an invalid redacted envelope");
  }
  return body as VaultDirectory;
}

async function apiJson(
  connection: Connection,
  method: "GET" | "POST",
  path: string,
  body?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await fetch(`${connection.base}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${connection.token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(5_000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path} failed ${response.status}: ${text.slice(0, 1_000)}`);
  const value = text.trim() ? JSON.parse(text) : {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${method} ${path} returned invalid JSON`);
  assertNoSecretMaterial(value, `${method} ${path}`);
  return value as Record<string, unknown>;
}

function assertNoSecretMaterial(value: unknown, label: string): void {
  const text = JSON.stringify(value);
  if (text.includes(OWNED_VAULT_VALUE) || /"(?:value|secret)"\s*:/.test(text)) {
    throw new Error(`${label} exposed synthetic secret material`);
  }
}

function nodeReadablePath(path: string, platform: ReleaseSurfaceDriverRequest["platform"]): string {
  if (platform !== "windows-installed" || process.platform === "win32" || !/^[A-Za-z]:[\\/]/.test(path)) return resolve(path);
  const mapped = spawnSync("wslpath", ["-u", path], { encoding: "utf8" });
  if (mapped.status !== 0 || !mapped.stdout.trim()) throw new Error("unable to map candidate profile into the driver host");
  return resolve(mapped.stdout.trim());
}

function id(selector: string, occurrence: number): string {
  return `ui-control:src/components/PluginsModal.tsx:${selector}@src/components/PluginsModal.tsx#${occurrence}`;
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
    observedEffect: "No isolated production Plugins transition was observed.",
  };
}

function finalize(outcome: ReleaseSurfaceDriverOutcome): ReleaseSurfaceDriverOutcome {
  if ([outcome.present, outcome.invoke, outcome.effect, outcome.cleanup].includes("fail") && !outcome.error) {
    outcome.error = "Plugins production control did not satisfy every required verdict";
  }
  return outcome;
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replaceAll(OWNED_VAULT_VALUE, "[redacted]");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
