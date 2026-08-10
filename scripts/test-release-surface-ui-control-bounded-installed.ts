import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ReleaseSurfaceDriverRequest } from "./lib/release-surface-driver-protocol";
import type { ReleaseSurfaceItem } from "./lib/release-surface-inventory";
import {
  UI_CONTROL_BOUNDED_INSTALLED_DRIVER_ID,
  assertBoundedInstalledUiControlAssignments,
  supportsBoundedInstalledUiControl,
} from "./release-drivers/ui-control-bounded-installed-assignments";

type Assignment = ReleaseSurfaceDriverRequest["assignments"][number];

const root = resolve(import.meta.dirname, "..");
const entrypoint = "scripts/release-drivers/ui-control-bounded-installed.ts";
const inventory = JSON.parse(readFileSync(resolve(root, "release/surface-inventory.json"), "utf8")) as {
  items: ReleaseSurfaceItem[];
};
const plan = JSON.parse(readFileSync(resolve(root, "release/surface-driver-plan.json"), "utf8")) as {
  drivers: Array<{ id: string; platforms: Record<string, string> }>;
  assignments: Array<{
    surfaceId: string;
    driverId: string;
    fixtureId: string;
    expectedEffect: string;
    oracleId: string;
    cleanupId: string;
  }>;
};
const installedDriverSource = readFileSync(
  resolve(root, "scripts/release-drivers/ui-control-installed.ts"),
  "utf8",
);
const vaultPasswordGeneratorSource = readFileSync(
  resolve(root, "src/components/VaultPasswordGenerator.tsx"),
  "utf8",
);
const safeFamiliesSource = readFileSync(
  resolve(root, "scripts/release-drivers/ui-control-safe-families.ts"),
  "utf8",
);
const leftRailSource = readFileSync(resolve(root, "src/components/LeftRail.tsx"), "utf8");
const pluginsSource = readFileSync(resolve(root, "src/components/PluginsModal.tsx"), "utf8");
const connectionEditorSource = readFileSync(resolve(root, "src/components/ConnectionEditor.tsx"), "utf8");
const connectorsTabSource = readFileSync(resolve(root, "src/components/settings/ConnectorsTab.tsx"), "utf8");
const connectorsOwnedDriverSource = readFileSync(
  resolve(root, "scripts/release-drivers/ui-control-connectors-owned.ts"),
  "utf8",
);
const prCreateModalSource = readFileSync(resolve(root, "src/components/PRCreateModal.tsx"), "utf8");
const workPreviewPanelSource = readFileSync(resolve(root, "src/components/WorkPreviewPanel.tsx"), "utf8");
const previewCenterSource = readFileSync(resolve(root, "src/components/PreviewCenter.tsx"), "utf8");
const workPreviewKindDriverSource = readFileSync(
  resolve(root, "scripts/release-drivers/ui-control-work-preview-kind.ts"),
  "utf8",
);
const workPreviewSafeDriverSource = readFileSync(
  resolve(root, "scripts/release-drivers/ui-control-work-preview-safe.ts"),
  "utf8",
);
const workPreviewRunningDriverSource = readFileSync(
  resolve(root, "scripts/release-drivers/ui-control-work-preview-running.ts"),
  "utf8",
);
const attachmentMediaDriverSource = readFileSync(
  resolve(root, "scripts/release-drivers/ui-control-attachment-media-safe.ts"),
  "utf8",
);
const attachmentMediaSource = readFileSync(resolve(root, "src/components/AttachmentMediaBoard.tsx"), "utf8");
const vaultTabSource = readFileSync(resolve(root, "src/components/settings/VaultTab.tsx"), "utf8");
const vaultSetupSource = readFileSync(resolve(root, "src/components/settings/VaultSetupPanel.tsx"), "utf8");
const vaultPanelSource = readFileSync(resolve(root, "src/components/VaultPanel.tsx"), "utf8");
const safeVaultDraftDriverSource = readFileSync(
  resolve(root, "scripts/release-drivers/ui-control-safe-vault-drafts.ts"),
  "utf8",
);
const boundedTextObservationSources = new Map([
  ["src/browser/components/AgentSidebar.tsx", 1],
  ["src/browser/components/BookmarkSidecar.tsx", 3],
  ["src/browser/components/BrowserChrome.tsx", 1],
  ["src/browser/components/BrowserHistorySidecar.tsx", 2],
  ["src/browser/components/BrowserMenus.tsx", 4],
  ["src/browser/components/DownloadSidecar.tsx", 1],
  ["src/components/ActivityBrowserModal.tsx", 1],
  ["src/components/BottomPanel.tsx", 1],
  ["src/components/CommandPalette.tsx", 1],
  ["src/components/ConnectorInboxModal.tsx", 2],
  ["src/components/FilesPane.tsx", 1],
  ["src/components/FindPopover.tsx", 1],
  ["src/components/PRCreateModal.tsx", 3],
  ["src/components/TasksPanel.tsx", 1],
  ["src/components/settings/GeneralTab.tsx", 2],
]);
const surfaceById = new Map(inventory.items.map((surface) => [surface.id, surface]));
const assignmentWithSurface = (row: typeof plan.assignments[number]): Assignment => ({
  surface: requiredSurface(row.surfaceId),
  fixtureId: row.fixtureId,
  expectedEffect: row.expectedEffect,
  oracleId: row.oracleId,
  cleanupId: row.cleanupId,
});

const driver = plan.drivers.find((row) => row.id === UI_CONTROL_BOUNDED_INSTALLED_DRIVER_ID);
assert.deepEqual(driver?.platforms, {
  "windows-installed": "ready",
  "macos-installed": "ready",
  "linux-installed": "ready",
});
const bounded = plan.assignments
  .filter((row) => row.driverId === UI_CONTROL_BOUNDED_INSTALLED_DRIVER_ID)
  .map(assignmentWithSurface);
assert.equal(bounded.length, 364);
assert(bounded.every(supportsBoundedInstalledUiControl));
assert.doesNotThrow(() => assertBoundedInstalledUiControlAssignments(bounded));

const generic = plan.assignments
  .filter((row) => row.driverId === "ui-control-installed")
  .map(assignmentWithSurface);
assert.equal(generic.length, 0);
assert(generic.every((row) => !supportsBoundedInstalledUiControl(row)));
const deliberatelyDisallowed = {
  ...bounded[0]!,
  surface: { ...bounded[0]!.surface, name: "release-test:deliberately-non-allowlisted" },
};
assert.throws(
  () => assertBoundedInstalledUiControlAssignments([deliberatelyDisallowed]),
  /refuses non-allowlisted surfaces/,
);

const described = spawnSync(process.execPath, ["--import", "tsx", resolve(root, entrypoint), "--describe"], {
  cwd: root,
  encoding: "utf8",
});
assert.equal(described.status, 0, described.stderr || described.stdout);
const manifest = JSON.parse(described.stdout) as {
  id?: string;
  invocationTransport?: string;
  controllerFiles?: string[];
};
assert.equal(manifest.id, UI_CONTROL_BOUNDED_INSTALLED_DRIVER_ID);
assert.equal(manifest.invocationTransport, "native-installed-input");
assert(manifest.controllerFiles?.includes("scripts/release-drivers/ui-control-installed.ts"));
assert(manifest.controllerFiles?.includes("scripts/release-drivers/ui-control-bounded-installed-assignments.ts"));
assert(!installedDriverSource.includes("SHELLX_VAULT_PASSWORD_GENERATOR_LOCAL_STATE"));
assert(!installedDriverSource.includes("SHELLX_OWNED_INPUT_STATE"));
assert(installedDriverSource.includes("observeReleaseSurfaceInstalledInputElement(webdriver, control, [field])"));
const settingsTabWaitSource = installedDriverSource.slice(
  installedDriverSource.indexOf("async function waitForSettingsTab"),
  installedDriverSource.indexOf("async function setRightRailTab"),
);
assert(!settingsTabWaitSource.includes("executeReleaseSurfaceWebDriverScript"));
const storedSettingsTabSource = installedDriverSource.slice(
  installedDriverSource.indexOf("async function readStoredSettingsTab"),
  installedDriverSource.indexOf("async function exerciseOverlayTextInput"),
);
assert(storedSettingsTabSource.includes('apiJson<Record<string, unknown>>(connection, "GET", "/state/ui")'));
assert(!storedSettingsTabSource.includes("executeReleaseSurfaceWebDriverScript"));
assert.equal(vaultPasswordGeneratorSource.match(/data-shellx-release-observe="value"/g)?.length, 2);
assert.equal(vaultPasswordGeneratorSource.match(/data-shellx-release-observe="checked"/g)?.length, 1);
assert.equal(vaultPasswordGeneratorSource.match(/data-shellx-release-observe="title"/g)?.length, 1);
assert.equal(vaultTabSource.match(/data-shellx-release-observe="nonempty"/g)?.length, 27);
assert.equal(vaultSetupSource.match(/data-shellx-release-observe="nonempty"/g)?.length, 7);
assert.equal(vaultPanelSource.match(/data-shellx-release-observe="nonempty"/g)?.length, 1);
assert(!safeVaultDraftDriverSource.includes("SHELLX_SAFE_VAULT_DRAFT_INPUT_STATE"));
assert(!safeVaultDraftDriverSource.includes("SHELLX_SAFE_VAULT_DRAFT_CHOICE_STATE"));
assert(!safeVaultDraftDriverSource.includes("SHELLX_SAFE_VAULT_DRAFT_SETTINGS_STORAGE"));
assert(!safeVaultDraftDriverSource.includes("SHELLX_SAFE_VAULT_GRANTS_STATE"));
assert(!safeVaultDraftDriverSource.includes("executeReleaseSurfaceInstalledInputScript"));
assert(safeVaultDraftDriverSource.includes('observeReleaseSurfaceInstalledInputElement(webdriver, selector, ["nonempty"])'));
assert.equal(
  readFileSync(resolve(root, "src/components/settings/VaultGrantsPanel.tsx"), "utf8")
    .match(/data-shellx-release-observe="title"/g)?.length,
  1,
);
assert(!safeFamiliesSource.includes("SHELLX_SAFE_FAMILY_DISCLOSURE_STATE"));
assert(!safeFamiliesSource.includes("SHELLX_SAFE_FAMILY_GENERAL_SETTING_STATE"));
assert(!safeFamiliesSource.includes("SHELLX_SAFE_FAMILY_CHOICE_STATE"));
assert(!safeFamiliesSource.includes("SHELLX_SAFE_CONNECTOR_DRAFT_STATE"));
assert(safeFamiliesSource.includes('observeReleaseSurfaceInstalledInputElement(webdriver, selector, ["expanded"])'));
assert(safeFamiliesSource.includes('expected.pressed === undefined ? ["value"] as const : ["pressed"] as const'));
assert.equal(leftRailSource.match(/data-shellx-release-observe="expanded"/g)?.length, 3);
assert.equal(pluginsSource.match(/data-shellx-release-observe="expanded"/g)?.length, 3);
assert.equal(connectionEditorSource.match(/data-shellx-release-observe="value"/g)?.length, 6);
assert.equal(connectionEditorSource.match(/data-shellx-release-observe="checked"/g)?.length, 1);
assert.equal(connectorsTabSource.match(/data-shellx-release-observe="selected"/g)?.length, 1);
assert.equal(connectorsTabSource.match(/data-shellx-release-observe="pressed"/g)?.length, 6);
assert.equal(connectorsTabSource.match(/data-shellx-release-observe="value"/g)?.length, 3);
assert.equal(connectorsTabSource.match(/data-shellx-release-observe="disabled"/g)?.length, 4);
assert.equal(connectorsTabSource.match(/data-shellx-release-observe="mounted"/g)?.length, 1);
assert.equal(connectorsTabSource.match(/data-shellx-release-observe="nonempty"/g)?.length, 6);
assert(!connectorsOwnedDriverSource.includes("executeReleaseSurfaceInstalledInputScript"));
assert.equal(
  readFileSync(resolve(root, "src/components/ConnectorInboxModal.tsx"), "utf8")
    .match(/data-shellx-release-observe="selected"/g)?.length,
  1,
);
assert.equal(prCreateModalSource.match(/data-shellx-release-observe="checked"/g)?.length, 1);
assert.equal(prCreateModalSource.match(/data-shellx-release-observe="pressed"/g)?.length, 1);
assert(!installedDriverSource.includes("SHELLX_OWNED_CHECKBOX_STATE"));
assert(!installedDriverSource.includes("SHELLX_PR_DRAFT_STATE"));
assert(!installedDriverSource.includes("SHELLX_CONNECTOR_INBOX_FILTER_STATE"));
assert(!installedDriverSource.includes("SHELLX_TASKS_TOGGLE_STATE"));
assert(!installedDriverSource.includes("SHELLX_TASKS_TOGGLE_STORAGE_RESTORE"));
assert(!installedDriverSource.includes("SHELLX_BROWSER_RIGHT_SIDEBAR_STATE"));
assert(!installedDriverSource.includes("SHELLX_OWNED_SELECT_STATE"));
assert(!installedDriverSource.includes("SHELLX_BROWSER_HISTORY_SCOPE_STATE"));
assert(!installedDriverSource.includes("SHELLX_BROWSER_BOOKMARK_MODE_STATE"));
assert(!installedDriverSource.includes("SHELLX_BROWSER_RIGHT_PANEL_STATE"));
assert(!installedDriverSource.includes("SHELLX_OWNED_BUTTON_STATE"));
assert.equal(readFileSync(resolve(root, "src/browser/components/AgentSidebar.tsx"), "utf8").match(/data-shellx-release-observe="selected"/g)?.length, 5);
assert.equal(readFileSync(resolve(root, "src/browser/components/AgentSidebar.tsx"), "utf8").match(/data-shellx-release-observe="disabled"/g)?.length, 6);
assert.equal(readFileSync(resolve(root, "src/browser/components/BrowserHistorySidecar.tsx"), "utf8").match(/data-shellx-release-observe="pressed"/g)?.length, 2);
assert(!readFileSync(resolve(root, "scripts/release-drivers/ui-control-owned-browser-history.ts"), "utf8")
  .includes("executeReleaseSurfaceInstalledInputScript"));
const personalLockDriverSource = readFileSync(
  resolve(root, "scripts/release-drivers/ui-control-browser-personal-lock-settings.ts"),
  "utf8",
);
assert(personalLockDriverSource.includes("waitForPinDraftReady"));
assert(!personalLockDriverSource.includes("executeReleaseSurfaceInstalledInputScript"));
const bookmarkSidecarSource = readFileSync(resolve(root, "src/browser/components/BookmarkSidecar.tsx"), "utf8");
assert.equal(bookmarkSidecarSource.match(/data-shellx-release-observe="pressed"/g)?.length, 2);
assert.equal(bookmarkSidecarSource.match(/data-shellx-release-observe="value"/g)?.length, 3);
assert.equal(readFileSync(resolve(root, "src/browser/components/AgentSidebar.tsx"), "utf8").match(/data-shellx-release-observe="title"/g)?.length, 2);
assert.equal(readFileSync(resolve(root, "src/browser/components/BrowserChrome.tsx"), "utf8").match(/data-shellx-release-observe="title"/g)?.length, 1);
assert.equal(readFileSync(resolve(root, "src/browser/components/BrowserMenus.tsx"), "utf8").match(/data-shellx-release-observe="checked"/g)?.length, 1);
const tasksPanelSource = readFileSync(resolve(root, "src/components/TasksPanel.tsx"), "utf8");
assert.equal(tasksPanelSource.match(/data-shellx-release-observe="checked"/g)?.length, 2);
assert.equal(tasksPanelSource.match(/localStorage\.removeItem\(SHOW_(?:COMPLETED|ALL_TABS)_KEY\)/g)?.length, 2);
assert.equal(workPreviewPanelSource.match(/data-shellx-release-observe="selected"/g)?.length, 7);
assert.equal(workPreviewPanelSource.match(/data-shellx-release-observe="title"/g)?.length, 4);
assert.equal(previewCenterSource.match(/data-shellx-release-observe="selected"/g)?.length, 2);
assert.equal(previewCenterSource.match(/data-shellx-release-observe="title"/g)?.length, 2);
assert(workPreviewKindDriverSource.includes('observeReleaseSurfaceInstalledInputElement(webdriver, selector, ["selected"])'));
assert(!workPreviewKindDriverSource.includes("executeReleaseSurfaceInstalledInputScript"));
assert(!workPreviewSafeDriverSource.includes("SHELLX_WORK_PREVIEW_RENDERED_STATE"));
assert(!workPreviewSafeDriverSource.includes("SHELLX_WORK_PREVIEW_DOCTOR_STATE"));
assert(!workPreviewSafeDriverSource.includes("SHELLX_PREVIEW_CENTER_MODE_STATE"));
assert(!workPreviewSafeDriverSource.includes("executeReleaseSurfaceInstalledInputScript"));
assert(!workPreviewRunningDriverSource.includes("SHELLX_WORK_PREVIEW_FRAME_STATE"));
assert(!workPreviewRunningDriverSource.includes("SHELLX_WORK_PREVIEW_LOG_STATE"));
assert(!workPreviewRunningDriverSource.includes("SHELLX_WORK_PREVIEW_LOG_CLEAR"));
assert(!workPreviewRunningDriverSource.includes("executeReleaseSurfaceInstalledInputScript"));
assert(!attachmentMediaDriverSource.includes("SHELLX_OWNED_ATTACHMENT_MEDIA_STATE"));
assert(!attachmentMediaDriverSource.includes("executeReleaseSurfaceInstalledInputScript"));
const filePreviewDriverSource = readFileSync(
  resolve(root, "scripts/release-drivers/ui-control-file-preview-safe.ts"),
  "utf8",
);
assert(!filePreviewDriverSource.includes("SHELLX_FILE_PREVIEW_MODE_STATE"));
assert(!filePreviewDriverSource.includes("SHELLX_FILE_PREVIEW_RUN_STATE"));
assert(!filePreviewDriverSource.includes("executeReleaseSurfaceInstalledInputScript"));
const ownedBrowserDriverSource = readFileSync(
  resolve(root, "scripts/release-drivers/ui-control-owned-browser-bookmarks.ts"),
  "utf8",
);
assert(!ownedBrowserDriverSource.includes("executeReleaseSurfaceInstalledInputScript"));
assert(!ownedBrowserDriverSource.includes("localStorage"));
assert(!installedDriverSource.includes("SHELLX_BROWSER_STORAGE_RESTORE"));
assert(!installedDriverSource.includes("SHELLX_BROWSER_COLOR_MODE_STATE"));
assert.equal(attachmentMediaSource.match(/data-shellx-release-observe="title"/g)?.length, 2);
assert.equal(
  readFileSync(resolve(root, "src/components/settings/GeneralTab.tsx"), "utf8")
    .match(/data-shellx-release-observe="pressed"/g)?.length,
  4,
);
for (const [relativePath, expectedCount] of boundedTextObservationSources) {
  const source = readFileSync(resolve(root, relativePath), "utf8");
  assert.equal(
    source.match(/data-shellx-release-observe="[^"]*\bvalue\b[^"]*"/g)?.length,
    expectedCount,
    relativePath,
  );
}

console.log("Release surface bounded installed UI routing tests passed (364 cross-platform bounded assignments, 0 generic assignments)");

function requiredSurface(id: string): ReleaseSurfaceItem {
  const surface = surfaceById.get(id);
  if (!surface) throw new Error(`missing inventory surface ${id}`);
  return surface;
}
