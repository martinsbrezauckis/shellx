import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
  RELEASE_SURFACE_RUN_PROFILE_SCHEMA,
  releaseSurfaceProfileLaunchRootFromDebugTokenPath,
  releaseSurfaceProfileMarkerLaunchPath,
} from "../lib/release-surface-run-profile";
import {
  clearReleaseSurfaceInstalledInputElement,
  clickReleaseSurfaceInstalledInputElement,
  closeReleaseSurfaceInstalledInputWindow,
  createReleaseSurfaceInstalledInputSession,
  findReleaseSurfaceInstalledInputElement,
  observeReleaseSurfaceInstalledInputElement,
  performReleaseSurfaceInstalledInputKeyChord,
  selectReleaseSurfaceInstalledInputPickerPath,
  setReleaseSurfaceInstalledInputElementValue,
  switchReleaseSurfaceInstalledInputWindow,
  switchReleaseSurfaceInstalledInputWindowByTitle,
  waitForReleaseSurfaceInstalledInputElement,
  waitForReleaseSurfaceInstalledInputElementAbsent,
  type ReleaseSurfaceInstalledInputElement,
  type ReleaseSurfaceInstalledInputSession,
} from "../lib/release-surface-installed-input-client";
import { resolveReleaseSurfaceRuntimeCandidate } from "../lib/release-surface-runtime-candidate";
import {
  RELEASE_SURFACE_DRIVER_REPORT_SCHEMA,
  completionTimestamp,
  type ReleaseSurfaceDriverOutcome,
  type ReleaseSurfaceDriverReport,
  type ReleaseSurfaceDriverRequest,
} from "../lib/release-surface-driver-protocol";
import { cleanupOwnedBrowserLifecycle } from "../shellx-browser-test-cleanup";

type Connection = { base: string; token: string };
type Input = ReleaseSurfaceInstalledInputSession;
type Assignment = ReleaseSurfaceDriverRequest["assignments"][number];
type Json = Record<string, unknown>;

export const NATIVE_PICKER_FIXTURES = [
  "native-picker:owned-file-empty-composer",
  "native-picker:owned-directory-local-tab",
  "native-picker:owned-settings-download-directory",
  "native-picker:owned-browser-download-directory",
  "native-picker:owned-vault-keyfile-setup",
] as const;
export const NATIVE_PICKER_CLEANUPS = [
  "native-picker:remove-exact-attachment-restore-tab-delete-fixture",
  "native-picker:restore-exact-tab-delete-fixture",
  "native-picker:restore-exact-settings-delete-fixture",
  "native-picker:restore-exact-browser-settings-task-window-delete-fixture",
  "native-picker:clear-owned-vault-keyfile-close-settings-delete-fixture",
] as const;
export const NATIVE_PICKER_ORACLES = [
  "native-picker:exact-owned-file-attached",
  "ui:activation:native-picker-exact-owned-file-attached",
  "ui:activation:native-picker-exact-owned-directory-selected",
  "ui:activation:native-picker-exact-settings-directory-selected",
  "ui:activation:native-picker-exact-browser-directory-selected",
  "ui:activation:native-picker-exact-owned-vault-keyfile-selected",
  "ui:activation:native-picker-owned-vault-keyfile-cleared",
] as const;

const APP_FILE_SURFACES = new Set([
  "keyboard-shortcut:attach",
  "palette-action:act-attach",
  'ui-control:src/components/BottomPanel.tsx:[data-debug-id="composer-attach"]@src/components/BottomPanel.tsx#15',
  'ui-control:src/components/AttachmentMediaBoard.tsx:[title="Attach file"]@src/components/AttachmentMediaBoard.tsx#4',
]);
const APP_FOLDER_SURFACE =
  'ui-control:src/components/BottomPanel.tsx:[data-debug-id="composer-folder"]@src/components/BottomPanel.tsx#21';
const SETTINGS_FOLDER_SURFACE =
  'ui-control:src/components/settings/GeneralTab.tsx:[data-debug-id="settings-browser-download-folder-choose"]@src/components/settings/GeneralTab.tsx#8';
const BROWSER_FOLDER_SURFACE =
  'ui-control:src/browser/components/DownloadSidecar.tsx:[data-debug-id="shellx-browser-download-folder-choose"]@src/browser/components/DownloadSidecar.tsx#3';
const VAULT_KEYFILE_SELECT_SURFACE =
  'ui-control:src/components/settings/VaultSetupPanel.tsx:[data-debug-id="surface-components-settings-vaultsetuppanel-17"]@src/components/settings/VaultSetupPanel.tsx#17';
const VAULT_KEYFILE_CLEAR_SURFACE =
  'ui-control:src/components/settings/VaultSetupPanel.tsx:role=button;name="Clear"@src/components/settings/VaultSetupPanel.tsx#18';

const COMPOSER_CHIP = ".composer-attachment-chip";
const COMPOSER_REMOVE = ".composer-attachment-remove";
const ASSET_BOARD = "[role='dialog'][aria-label='Attachment and media board']";
const ASSET_BOARD_ROW = "[data-debug-id='surface-components-attachmentmediaboard-9']";
const SETTINGS_DIALOG = ".settings-modal[role='dialog']";
const SETTINGS_INPUT = "[data-debug-id='settings-browser-download-folder']";
const VAULT_KEYFILE_CHOOSE = "[data-debug-id='surface-components-settings-vaultsetuppanel-17']";
const VAULT_KEYFILE_CLEAR = ".vault-keyfile-picker > button:last-child";
const BROWSER_DOWNLOAD_OWNER = "[data-debug-id='shellx-browser-downloads-menu']";
const BROWSER_DOWNLOAD_PANEL = "#shellx-browser-download-sidecar[aria-labelledby='shellx-browser-downloads-menu']";
const BROWSER_DOWNLOAD_INPUT = "[data-debug-id='shellx-browser-download-folder']";
const SETTINGS_TABS = [
  "general", "vault", "connections", "connectors", "desktop", "shellxagent", "data", "about",
] as const;

export type NativePickerFixture = {
  root: string;
  file: string;
  directory: string;
  keyfile: string;
};

type AppTabFixture = {
  baseline: Json;
  baselineTab: Json;
  baselineTabId: string;
};

type PublicSettings = {
  browserDownloadFolder: string;
  chatFontPx: number;
  density: string;
  githubGhBinary: string;
  permissionUx: string;
  theme: string;
};

export async function executeNativePickerLifecycleDriver(
  request: ReleaseSurfaceDriverRequest,
): Promise<ReleaseSurfaceDriverReport> {
  const startedAt = new Date().toISOString();
  const macosBound = request.platform === "macos-installed"
    && Boolean(request.macosNativeInput) && !request.nativeWebDriver;
  const webdriverBound = (request.platform === "windows-installed" || request.platform === "linux-installed")
    && Boolean(request.nativeWebDriver) && !request.macosNativeInput;
  if (!macosBound && !webdriverBound) {
    throw new Error("native picker lifecycle requires the exact platform-native macOS helper or Windows/Linux native WebDriver binding");
  }
  const connection = await resolveReleaseSurfaceRuntimeCandidate(request);
  const installedInput = createReleaseSurfaceInstalledInputSession(request, connection);
  const input: Input = installedInput;
  const outcomes: ReleaseSurfaceDriverOutcome[] = [];
  for (const assignment of request.assignments) {
    outcomes.push(await exerciseNativePicker(request, connection, input, assignment));
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

export function supportsNativePickerAssignment(assignment: Assignment): boolean {
  return APP_FILE_SURFACES.has(assignment.surface.id)
    || assignment.surface.id === APP_FOLDER_SURFACE
    || assignment.surface.id === SETTINGS_FOLDER_SURFACE
    || assignment.surface.id === BROWSER_FOLDER_SURFACE
    || assignment.surface.id === VAULT_KEYFILE_SELECT_SURFACE
    || assignment.surface.id === VAULT_KEYFILE_CLEAR_SURFACE;
}

async function exerciseNativePicker(
  request: ReleaseSurfaceDriverRequest,
  connection: Connection,
  input: Input,
  assignment: Assignment,
): Promise<ReleaseSurfaceDriverOutcome> {
  const outcome = emptyOutcome(assignment);
  let fixture: NativePickerFixture | null = null;
  let pickerMayBeOpen = false;
  try {
    if (!supportsNativePickerAssignment(assignment)) {
      throw new Error(`native picker lifecycle does not support ${assignment.surface.id}`);
    }
    fixture = prepareNativePickerFixture(request, assignment.surface.id);
    if (APP_FILE_SURFACES.has(assignment.surface.id)) {
      pickerMayBeOpen = await exerciseAppFilePicker(request, connection, input, assignment, fixture, outcome);
    } else if (assignment.surface.id === APP_FOLDER_SURFACE) {
      pickerMayBeOpen = await exerciseAppFolderPicker(request, connection, input, fixture, outcome);
    } else if (assignment.surface.id === SETTINGS_FOLDER_SURFACE) {
      pickerMayBeOpen = await exerciseSettingsFolderPicker(request, connection, input, fixture, outcome);
    } else if (assignment.surface.id === VAULT_KEYFILE_SELECT_SURFACE
      || assignment.surface.id === VAULT_KEYFILE_CLEAR_SURFACE) {
      pickerMayBeOpen = await exerciseVaultKeyfilePicker(request, connection, input, assignment, fixture, outcome);
    } else {
      pickerMayBeOpen = await exerciseBrowserFolderPicker(request, connection, input, fixture, outcome);
    }
  } catch (error) {
    outcome.error = errorMessage(error);
  } finally {
    const cleanupErrors: string[] = [];
    if (pickerMayBeOpen) {
      try {
        await performReleaseSurfaceInstalledInputKeyChord(input, ["escape"]);
      } catch (error) {
        cleanupErrors.push(`native dialog cancellation: ${errorMessage(error)}`);
      }
    }
    if (input.transport === "native-webdriver") {
      try {
        await apiJson<Json>(connection, "DELETE", "/release-test/native-picker");
      } catch (error) {
        cleanupErrors.push(`isolated picker lease cleanup: ${errorMessage(error)}`);
      }
    }
    if (fixture) {
      try {
        removeNativePickerFixture(request, fixture);
      } catch (error) {
        cleanupErrors.push(`fixture removal: ${errorMessage(error)}`);
      }
    }
    if (cleanupErrors.length > 0) {
      const detail = cleanupErrors.join("; ");
      outcome.error = outcome.error ? `${outcome.error}; cleanup: ${detail}` : `cleanup: ${detail}`;
      outcome.cleanup = "fail";
    }
  }
  if ([outcome.present, outcome.invoke, outcome.effect, outcome.cleanup].includes("fail") && !outcome.error) {
    outcome.error = "native picker lifecycle did not satisfy every required verdict";
  }
  return outcome;
}

async function armReleaseNativePicker(
  connection: Connection,
  input: Input,
  pickerPath: string,
  pickerKind: "file" | "directory",
): Promise<void> {
  if (input.transport === "macos-native-input") return;
  const armed = await apiJson<Json>(connection, "POST", "/release-test/native-picker", {
    kind: pickerKind,
    path: pickerPath,
  });
  const expectedHash = createHash("sha256").update(pickerPath).digest("hex");
  if (armed.armed !== true || armed.kind !== pickerKind || armed.pathSha256 !== expectedHash) {
    throw new Error("isolated native-picker lease did not bind the exact receipt-owned path");
  }
}

async function completeReleaseNativePicker(
  connection: Connection,
  input: Input,
  selection: {
    ownedRootPath: string;
    pickerPath: string;
    pickerKind: "file" | "directory";
  },
): Promise<void> {
  if (input.transport === "macos-native-input") {
    await selectReleaseSurfaceInstalledInputPickerPath(input, selection);
    return;
  }
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const status = await apiJson<Json>(connection, "GET", "/release-test/native-picker");
    if (status.armed === false) return;
    await delay(50);
  }
  throw new Error("renderer-bound native-picker result was not consumed by the production handler");
}

async function exerciseVaultKeyfilePicker(
  request: ReleaseSurfaceDriverRequest,
  connection: Connection,
  input: Input,
  assignment: Assignment,
  fixture: NativePickerFixture,
  outcome: ReleaseSurfaceDriverOutcome,
): Promise<boolean> {
  let originalTab: string | null = null;
  let pickerMayBeOpen = false;
  try {
    await postUi(connection, { openModal: "settings" });
    await waitForReleaseSurfaceInstalledInputElement(input, SETTINGS_DIALOG);
    originalTab = await selectedSettingsTab(input);
    if (originalTab !== "vault") {
      await clickReleaseSurfaceInstalledInputElement(
        input,
        await waitForReleaseSurfaceInstalledInputElement(input, "[data-debug-id='settings-tab-vault']"),
      );
      await waitForObservedBoolean(input, "[data-debug-id='settings-tab-vault']", "selected", true);
    }
    const choose = await waitForReleaseSurfaceInstalledInputElement(input, VAULT_KEYFILE_CHOOSE);
    if (assignment.surface.id === VAULT_KEYFILE_SELECT_SURFACE) outcome.present = "pass";
    await armReleaseNativePicker(connection, input, fixture.keyfile, "file");
    pickerMayBeOpen = input.transport === "macos-native-input";
    await clickReleaseSurfaceInstalledInputElement(input, choose);
    await completeReleaseNativePicker(connection, input, {
      ownedRootPath: profileRoot(request),
      pickerPath: fixture.keyfile,
      pickerKind: "file",
    });
    pickerMayBeOpen = false;
    const clear = await waitForReleaseSurfaceInstalledInputElement(
      input,
      VAULT_KEYFILE_CLEAR,
      { timeoutMs: 10_000, pollMs: 50 },
    );
    if (assignment.surface.id === VAULT_KEYFILE_SELECT_SURFACE) {
      outcome.invoke = "pass";
      outcome.effect = "pass";
      outcome.observedEffect = pickerObservedEffect(
        input,
        "The candidate-owned native file dialog selected one bounded synthetic JSON keyfile and exposed only its reversible local Vault setup draft.",
        "The isolated one-shot file result was consumed by the production Vault keyfile handler, which exposed only its reversible local setup draft.",
      );
      await clickReleaseSurfaceInstalledInputElement(input, clear);
      await waitForReleaseSurfaceInstalledInputElementAbsent(input, VAULT_KEYFILE_CLEAR);
    } else {
      outcome.present = "pass";
      await clickReleaseSurfaceInstalledInputElement(input, clear);
      outcome.invoke = "pass";
      await waitForReleaseSurfaceInstalledInputElementAbsent(input, VAULT_KEYFILE_CLEAR);
      outcome.effect = "pass";
      outcome.observedEffect = "A native click cleared the exact synthetic Vault keyfile draft without invoking setup, unlocking Vault, or retaining keyfile material.";
    }
  } finally {
    const cleanupErrors: string[] = [];
    if (pickerMayBeOpen) {
      try {
        await performReleaseSurfaceInstalledInputKeyChord(input, ["escape"]);
        pickerMayBeOpen = false;
      } catch (error) {
        cleanupErrors.push(errorMessage(error));
      }
    }
    try {
      const clear = await findReleaseSurfaceInstalledInputElement(input, VAULT_KEYFILE_CLEAR);
      if (clear) await clickReleaseSurfaceInstalledInputElement(input, clear);
      await waitForReleaseSurfaceInstalledInputElementAbsent(input, VAULT_KEYFILE_CLEAR);
    } catch (error) {
      cleanupErrors.push(errorMessage(error));
    }
    if (originalTab && originalTab !== "vault") {
      try {
        const selector = `[data-debug-id='settings-tab-${originalTab}']`;
        await clickReleaseSurfaceInstalledInputElement(input, await waitForReleaseSurfaceInstalledInputElement(input, selector));
        await waitForObservedBoolean(input, selector, "selected", true);
      } catch (error) {
        cleanupErrors.push(errorMessage(error));
      }
    }
    try {
      await postUi(connection, { openModal: "close", debugHighlights: [] });
      await waitForReleaseSurfaceInstalledInputElementAbsent(input, SETTINGS_DIALOG);
    } catch (error) {
      cleanupErrors.push(errorMessage(error));
    }
    if (cleanupErrors.length) throw new Error(cleanupErrors.join("; "));
    if (!pickerMayBeOpen) outcome.cleanup = "pass";
  }
  return pickerMayBeOpen;
}

async function exerciseAppFilePicker(
  request: ReleaseSurfaceDriverRequest,
  connection: Connection,
  input: Input,
  assignment: Assignment,
  fixture: NativePickerFixture,
  outcome: ReleaseSurfaceDriverOutcome,
): Promise<boolean> {
  const tab = await prepareAppTab(connection, fixture.root);
  let pickerMayBeOpen = false;
  let boardOpen = false;
  try {
    await postUi(connection, { openModal: "close", debugHighlights: [] });
    await waitForReleaseSurfaceInstalledInputElementAbsent(input, COMPOSER_CHIP);
    await armReleaseNativePicker(connection, input, fixture.file, "file");
    pickerMayBeOpen = input.transport === "macos-native-input";
    if (assignment.surface.id === "keyboard-shortcut:attach") {
      outcome.present = "pass";
      await performReleaseSurfaceInstalledInputKeyChord(
        input,
        input.transport === "macos-native-input" ? ["meta", "u"] : ["\uE009", "u"],
      );
    } else if (assignment.surface.id === "palette-action:act-attach") {
      await postUi(connection, { openModal: "palette" });
      const control = await waitForReleaseSurfaceInstalledInputElement(input, "[data-palette-action-id='act-attach']");
      outcome.present = "pass";
      await clickReleaseSurfaceInstalledInputElement(input, control);
    } else if (assignment.surface.id.includes("AttachmentMediaBoard")) {
      await postUi(connection, { openModal: "assets" });
      await waitForReleaseSurfaceInstalledInputElement(input, ASSET_BOARD);
      boardOpen = true;
      const control = await waitForReleaseSurfaceInstalledInputElement(input, `${ASSET_BOARD} [title='Attach file']`);
      outcome.present = "pass";
      await clickReleaseSurfaceInstalledInputElement(input, control);
    } else {
      const control = await waitForReleaseSurfaceInstalledInputElement(input, "[data-debug-id='composer-attach']");
      outcome.present = "pass";
      await clickReleaseSurfaceInstalledInputElement(input, control);
    }
    await completeReleaseNativePicker(connection, input, {
      ownedRootPath: profileRoot(request),
      pickerPath: fixture.file,
      pickerKind: "file",
    });
    pickerMayBeOpen = false;
    outcome.invoke = "pass";
    await waitForExactObservedValue(input, COMPOSER_CHIP, "title", fixture.file);
    if (boardOpen) await waitForExactObservedValue(input, ASSET_BOARD_ROW, "title", fixture.file);
    outcome.effect = "pass";
    outcome.observedEffect = pickerObservedEffect(
      input,
      "The candidate-owned native file dialog selected the exact receipt-owned regular file and rendered its exact pending attachment.",
      "The isolated one-shot file result was consumed by the production attachment handler and rendered as the exact pending attachment.",
    );
    const remove = await waitForReleaseSurfaceInstalledInputElement(input, boardOpen
      ? `${ASSET_BOARD} [title='Remove attachment']`
      : COMPOSER_REMOVE);
    await clickReleaseSurfaceInstalledInputElement(input, remove);
    await waitForReleaseSurfaceInstalledInputElementAbsent(input, COMPOSER_CHIP);
  } finally {
    if (pickerMayBeOpen) {
      await performReleaseSurfaceInstalledInputKeyChord(input, ["escape"]);
      pickerMayBeOpen = false;
    }
    await postUi(connection, { openModal: "close", debugHighlights: [] });
    await restoreAppTab(connection, tab);
    if (!pickerMayBeOpen) outcome.cleanup = "pass";
  }
  return pickerMayBeOpen;
}

async function exerciseAppFolderPicker(
  request: ReleaseSurfaceDriverRequest,
  connection: Connection,
  input: Input,
  fixture: NativePickerFixture,
  outcome: ReleaseSurfaceDriverOutcome,
): Promise<boolean> {
  const tab = await prepareAppTab(connection, fixture.root);
  let pickerMayBeOpen = false;
  try {
    const control = await waitForReleaseSurfaceInstalledInputElement(input, "[data-debug-id='composer-folder']");
    outcome.present = "pass";
    await armReleaseNativePicker(connection, input, fixture.directory, "directory");
    pickerMayBeOpen = input.transport === "macos-native-input";
    await clickReleaseSurfaceInstalledInputElement(input, control);
    await completeReleaseNativePicker(connection, input, {
      ownedRootPath: profileRoot(request),
      pickerPath: fixture.directory,
      pickerKind: "directory",
    });
    pickerMayBeOpen = false;
    outcome.invoke = "pass";
    await waitForUi(connection, (state) => activeTab(state)?.cwd === fixture.directory, "owned folder selection");
    outcome.effect = "pass";
    outcome.observedEffect = pickerObservedEffect(
      input,
      "The candidate-owned native directory dialog selected the exact receipt-owned directory and changed only the active isolated tab cwd.",
      "The isolated one-shot directory result was consumed by the production folder handler and changed only the active isolated tab cwd.",
    );
  } finally {
    if (pickerMayBeOpen) {
      await performReleaseSurfaceInstalledInputKeyChord(input, ["escape"]);
      pickerMayBeOpen = false;
    }
    await restoreAppTab(connection, tab);
    if (!pickerMayBeOpen) outcome.cleanup = "pass";
  }
  return pickerMayBeOpen;
}

async function exerciseSettingsFolderPicker(
  request: ReleaseSurfaceDriverRequest,
  connection: Connection,
  input: Input,
  fixture: NativePickerFixture,
  outcome: ReleaseSurfaceDriverOutcome,
): Promise<boolean> {
  const baseline = await readPublicSettings(connection);
  let originalTab: string | null = null;
  let pickerMayBeOpen = false;
  let inputControl: ReleaseSurfaceInstalledInputElement | null = null;
  try {
    await postUi(connection, { openModal: "settings" });
    await waitForReleaseSurfaceInstalledInputElement(input, SETTINGS_DIALOG);
    originalTab = await selectedSettingsTab(input);
    if (originalTab !== "general") {
      await clickReleaseSurfaceInstalledInputElement(
        input,
        await waitForReleaseSurfaceInstalledInputElement(input, "[data-debug-id='settings-tab-general']"),
      );
      await waitForObservedBoolean(input, "[data-debug-id='settings-tab-general']", "selected", true);
    }
    const choose = await waitForReleaseSurfaceInstalledInputElement(
      input,
      "[data-debug-id='settings-browser-download-folder-choose']",
    );
    inputControl = await waitForReleaseSurfaceInstalledInputElement(input, SETTINGS_INPUT);
    outcome.present = "pass";
    await armReleaseNativePicker(connection, input, fixture.directory, "directory");
    pickerMayBeOpen = input.transport === "macos-native-input";
    await clickReleaseSurfaceInstalledInputElement(input, choose);
    await completeReleaseNativePicker(connection, input, {
      ownedRootPath: profileRoot(request),
      pickerPath: fixture.directory,
      pickerKind: "directory",
    });
    pickerMayBeOpen = false;
    outcome.invoke = "pass";
    await waitForExactObservedValue(input, SETTINGS_INPUT, "value", fixture.directory);
    await waitForPublicSettings(connection, { ...baseline, browserDownloadFolder: fixture.directory });
    outcome.effect = "pass";
    outcome.observedEffect = pickerObservedEffect(
      input,
      "The candidate-owned native directory dialog selected the exact receipt-owned default Browser download directory in Settings and its public backing state.",
      "The isolated one-shot directory result was consumed by the production Settings handler and updated the exact default Browser download directory plus its public backing state.",
    );
  } finally {
    const cleanupErrors: string[] = [];
    if (pickerMayBeOpen) {
      try {
        await performReleaseSurfaceInstalledInputKeyChord(input, ["escape"]);
        pickerMayBeOpen = false;
      } catch (error) {
        cleanupErrors.push(errorMessage(error));
      }
    }
    if (inputControl) {
      try {
        await replaceInputValue(input, inputControl, SETTINGS_INPUT, baseline.browserDownloadFolder);
        await waitForPublicSettings(connection, baseline);
      } catch (error) {
        cleanupErrors.push(errorMessage(error));
      }
    }
    if (originalTab && originalTab !== "general") {
      try {
        const selector = `[data-debug-id='settings-tab-${originalTab}']`;
        await clickReleaseSurfaceInstalledInputElement(input, await waitForReleaseSurfaceInstalledInputElement(input, selector));
        await waitForObservedBoolean(input, selector, "selected", true);
      } catch (error) {
        cleanupErrors.push(errorMessage(error));
      }
    }
    try {
      await postUi(connection, { openModal: "close", debugHighlights: [] });
      await waitForReleaseSurfaceInstalledInputElementAbsent(input, SETTINGS_DIALOG);
    } catch (error) {
      cleanupErrors.push(errorMessage(error));
    }
    if (cleanupErrors.length) throw new Error(cleanupErrors.join("; "));
    if (!pickerMayBeOpen) outcome.cleanup = "pass";
  }
  return pickerMayBeOpen;
}

async function exerciseBrowserFolderPicker(
  request: ReleaseSurfaceDriverRequest,
  connection: Connection,
  input: Input,
  fixture: NativePickerFixture,
  outcome: ReleaseSurfaceDriverOutcome,
): Promise<boolean> {
  const baseline = await readPublicSettings(connection);
  let taskId: string | null = null;
  let originalWindow: string | null = null;
  let browserWindowOpen = false;
  let pickerMayBeOpen = false;
  let inputControl: ReleaseSurfaceInstalledInputElement | null = null;
  try {
    const task = await apiJson<Json>(connection, "POST", "/browser/task/start", {
      goal: "Final surface owned native Browser download-folder picker proof",
      profileId: "task-disposable",
      autonomy: "assistedAutonomous",
      startUrl: "about:blank",
    });
    taskId = requiredString(task.taskId, "browser task start.taskId");
    const switched = await waitForBrowserWindow(input);
    originalWindow = switched.originalHandle;
    browserWindowOpen = true;
    const owner = await waitForReleaseSurfaceInstalledInputElement(input, BROWSER_DOWNLOAD_OWNER);
    if (await findReleaseSurfaceInstalledInputElement(input, BROWSER_DOWNLOAD_PANEL)) {
      await clickReleaseSurfaceInstalledInputElement(input, owner);
      await waitForReleaseSurfaceInstalledInputElementAbsent(input, BROWSER_DOWNLOAD_PANEL);
    }
    await clickReleaseSurfaceInstalledInputElement(input, owner);
    await waitForReleaseSurfaceInstalledInputElement(input, BROWSER_DOWNLOAD_PANEL);
    const choose = await waitForReleaseSurfaceInstalledInputElement(
      input,
      "[data-debug-id='shellx-browser-download-folder-choose']",
    );
    inputControl = await waitForReleaseSurfaceInstalledInputElement(input, BROWSER_DOWNLOAD_INPUT);
    outcome.present = "pass";
    await armReleaseNativePicker(connection, input, fixture.directory, "directory");
    pickerMayBeOpen = input.transport === "macos-native-input";
    await clickReleaseSurfaceInstalledInputElement(input, choose);
    await completeReleaseNativePicker(connection, input, {
      ownedRootPath: profileRoot(request),
      pickerPath: fixture.directory,
      pickerKind: "directory",
    });
    pickerMayBeOpen = false;
    outcome.invoke = "pass";
    await waitForExactObservedValue(input, BROWSER_DOWNLOAD_INPUT, "value", fixture.directory);
    await waitForPublicSettings(connection, { ...baseline, browserDownloadFolder: fixture.directory });
    outcome.effect = "pass";
    outcome.observedEffect = pickerObservedEffect(
      input,
      "The candidate-owned Browser native directory dialog selected the exact receipt-owned directory and updated only the public default-download setting.",
      "The isolated one-shot directory result was consumed by the production Browser handler and updated only the public default-download setting.",
    );
  } finally {
    const cleanupErrors: string[] = [];
    if (pickerMayBeOpen) {
      try {
        await performReleaseSurfaceInstalledInputKeyChord(input, ["escape"]);
        pickerMayBeOpen = false;
      } catch (error) {
        cleanupErrors.push(errorMessage(error));
      }
    }
    if (inputControl) {
      try {
        await replaceInputValue(input, inputControl, BROWSER_DOWNLOAD_INPUT, baseline.browserDownloadFolder);
        await waitForPublicSettings(connection, baseline);
      } catch (error) {
        cleanupErrors.push(errorMessage(error));
      }
    }
    if (browserWindowOpen) {
      try {
        const close = await findReleaseSurfaceInstalledInputElement(input, "[data-debug-id='shellx-browser-downloads-close']");
        if (close) await clickReleaseSurfaceInstalledInputElement(input, close);
        await waitForReleaseSurfaceInstalledInputElementAbsent(input, BROWSER_DOWNLOAD_PANEL);
      } catch (error) {
        cleanupErrors.push(errorMessage(error));
      }
    }
    if (taskId) {
      try {
        const result = await cleanupOwnedBrowserLifecycle(
          (method, path, body) => apiJson(connection, method, path, body),
          { taskIds: [taskId], label: "final surface native picker" },
        );
        if (result.errors.length) throw new Error(result.errors.join("; "));
      } catch (error) {
        cleanupErrors.push(errorMessage(error));
      }
    }
    if (browserWindowOpen && originalWindow) {
      try {
        await closeReleaseSurfaceInstalledInputWindow(input);
        await switchReleaseSurfaceInstalledInputWindow(input, originalWindow);
      } catch (error) {
        cleanupErrors.push(errorMessage(error));
      }
    }
    if (cleanupErrors.length) throw new Error(cleanupErrors.join("; "));
    if (!pickerMayBeOpen) outcome.cleanup = "pass";
  }
  return pickerMayBeOpen;
}

export function prepareNativePickerFixture(
  request: ReleaseSurfaceDriverRequest,
  surfaceId: string,
): NativePickerFixture {
  const root = profileRoot(request);
  validateRunProfile(request, root);
  const suffix = createHash("sha256").update(surfaceId).digest("hex").slice(0, 16);
  const fixtureRoot = join(root, `release-native-picker-${suffix}`);
  if (existsSync(fixtureRoot)) throw new Error("native picker fixture root must be absent before creation");
  mkdirSync(fixtureRoot, { mode: 0o700 });
  const directory = join(fixtureRoot, "selected-folder");
  mkdirSync(directory, { mode: 0o700 });
  const file = join(fixtureRoot, "attached.txt");
  writeFileSync(file, "ShellX final native picker fixture\n", { encoding: "utf8", flag: "wx", mode: 0o600 });
  const keyfile = join(fixtureRoot, "vault-keyfile.json");
  writeFileSync(keyfile, `${JSON.stringify({
    schema: "shellx/vault-keyfile@1",
    fixture: "SHELLX_RELEASE_SYNTHETIC_KEYFILE_035",
  }, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  return { root: fixtureRoot, file, directory, keyfile };
}

function validateRunProfile(request: ReleaseSurfaceDriverRequest, root: string): void {
  const rootStat = lstatSync(root);
  const runId = basename(root).match(/^shellx-final-webdriver-([a-f0-9]{16,64})$/)?.[1];
  if (!runId || rootStat.isSymbolicLink() || !rootStat.isDirectory() || resolve(root) !== root) {
    throw new Error("native picker requires the exact regular isolated final-run profile root");
  }
  const markerPath = releaseSurfaceProfileMarkerLaunchPath(request.runtime.debugTokenPath, request.platform);
  if (dirname(markerPath) !== root) throw new Error("native picker profile marker escaped the exact candidate root");
  const markerStat = lstatSync(markerPath);
  if (markerStat.isSymbolicLink() || !markerStat.isFile() || markerStat.size > 16_384) {
    throw new Error("native picker requires one bounded regular run-profile marker");
  }
  const marker = JSON.parse(readFileSync(markerPath, "utf8")) as Json;
  if (marker.schema !== RELEASE_SURFACE_RUN_PROFILE_SCHEMA
    || marker.platform !== request.platform
    || marker.runId !== runId
    || marker.launchPath !== root) {
    throw new Error("native picker run-profile marker did not match the exact candidate root");
  }
}

export function removeNativePickerFixture(
  request: ReleaseSurfaceDriverRequest,
  fixture: NativePickerFixture,
): void {
  const root = profileRoot(request);
  const stat = lstatSync(fixture.root);
  if (stat.isSymbolicLink() || !stat.isDirectory() || dirname(fixture.root) !== root
    || !/^release-native-picker-[a-f0-9]{16}$/.test(basename(fixture.root))) {
    throw new Error("native picker cleanup refused a fixture outside its exact receipt-owned root");
  }
  rmSync(fixture.root, { recursive: true });
  if (existsSync(fixture.root)) throw new Error("native picker fixture remained after exact cleanup");
}

function profileRoot(request: ReleaseSurfaceDriverRequest): string {
  return releaseSurfaceProfileLaunchRootFromDebugTokenPath(request.runtime.debugTokenPath, request.platform);
}

async function prepareAppTab(connection: Connection, cwd: string): Promise<AppTabFixture> {
  const baseline = await apiJson<Json>(connection, "GET", "/state/ui");
  const baselineTab = activeTab(baseline);
  const baselineTabId = requiredString(baseline.activeTabId, "active renderer tab id");
  if (baselineTab.tabId !== baselineTabId) throw new Error("active renderer tab identity was inconsistent");
  await postUi(connection, {
    activeTab: {
      ...baselineTab,
      tabId: baselineTabId,
      cwd,
      connectionTransport: "local",
      connectionId: null,
      connectionLabel: "Local",
    },
  });
  await waitForUi(connection, (state) => {
    const tab = activeTab(state);
    return state.activeTabId === baselineTabId && tab.cwd === cwd && tab.connectionTransport === "local";
  }, "owned local picker tab fixture");
  return { baseline, baselineTab, baselineTabId };
}

async function restoreAppTab(connection: Connection, fixture: AppTabFixture): Promise<void> {
  await postUi(connection, { activeTab: fixture.baselineTab, activeTabId: fixture.baselineTabId });
  await waitForUi(connection, (state) => state.activeTabId === fixture.baselineTabId
    && JSON.stringify(activeTab(state)) === JSON.stringify(fixture.baselineTab), "exact active tab restoration");
}

async function selectedSettingsTab(input: Input): Promise<string> {
  const selected: string[] = [];
  for (const tab of SETTINGS_TABS) {
    const selector = `[data-debug-id='settings-tab-${tab}']`;
    const element = await findReleaseSurfaceInstalledInputElement(input, selector);
    if (!element) continue;
    const observed = await observeReleaseSurfaceInstalledInputElement(input, selector, ["selected"]);
    if (observed.selected === true) selected.push(tab);
  }
  if (selected.length !== 1) throw new Error("Settings did not expose exactly one selected tab");
  return selected[0]!;
}

async function waitForBrowserWindow(input: Input): Promise<{ originalHandle: string; targetHandle: string }> {
  const deadline = Date.now() + 10_000;
  let last: unknown = null;
  while (Date.now() < deadline) {
    try {
      return await switchReleaseSurfaceInstalledInputWindowByTitle(input, "ShellX Browser");
    } catch (error) {
      last = error;
      await delay(100);
    }
  }
  throw last instanceof Error ? last : new Error("ShellX Browser window did not appear");
}

async function replaceInputValue(
  input: Input,
  control: ReleaseSurfaceInstalledInputElement,
  selector: string,
  value: string,
): Promise<void> {
  await clearReleaseSurfaceInstalledInputElement(input, control);
  await waitForExactObservedValue(input, selector, "value", "");
  if (value) await setReleaseSurfaceInstalledInputElementValue(input, control, value);
  await waitForExactObservedValue(input, selector, "value", value);
}

async function waitForExactObservedValue(
  input: Input,
  selector: string,
  field: "title" | "value",
  expected: string,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      await waitForReleaseSurfaceInstalledInputElement(input, selector, { timeoutMs: 500, pollMs: 50 });
      const observed = await observeReleaseSurfaceInstalledInputElement(input, selector, [field]);
      if (observed[field] === expected) return;
    } catch {
      // The native dialog resolution and renderer update settle asynchronously.
    }
    await delay(50);
  }
  throw new Error(`bounded ${field} observation did not reach its exact owned value`);
}

async function waitForObservedBoolean(
  input: Input,
  selector: string,
  field: "selected",
  expected: boolean,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const observed = await observeReleaseSurfaceInstalledInputElement(input, selector, [field]);
    if (observed[field] === expected) return;
    await delay(50);
  }
  throw new Error(`bounded ${field} observation did not reach ${expected}`);
}

async function readPublicSettings(connection: Connection): Promise<PublicSettings> {
  const body = await apiJson<Json>(connection, "GET", "/settings");
  const keys = Object.keys(body).sort();
  const expectedKeys = ["browserDownloadFolder", "chatFontPx", "density", "githubGhBinary", "permissionUx", "theme"];
  if (JSON.stringify(keys) !== JSON.stringify(expectedKeys)
    || typeof body.browserDownloadFolder !== "string"
    || !Number.isSafeInteger(body.chatFontPx)
    || !["compact", "default", "comfortable"].includes(String(body.density))
    || !["gh", "gh.exe"].includes(String(body.githubGhBinary))
    || !["pill", "modal", "both"].includes(String(body.permissionUx))
    || !["black", "black_warm", "bright"].includes(String(body.theme))) {
    throw new Error("public Settings payload did not match its exact normalized schema");
  }
  return body as PublicSettings;
}

async function waitForPublicSettings(connection: Connection, expected: PublicSettings): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (JSON.stringify(await readPublicSettings(connection)) === JSON.stringify(expected)) return;
    await delay(50);
  }
  throw new Error("public Settings did not reach its exact expected state");
}

async function waitForUi(
  connection: Connection,
  predicate: (state: Json) => boolean,
  label: string,
): Promise<Json> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const state = await apiJson<Json>(connection, "GET", "/state/ui");
    if (predicate(state)) return state;
    await delay(50);
  }
  throw new Error(`${label} did not appear before timeout`);
}

function activeTab(state: Json): Json {
  if (!state.activeTab || typeof state.activeTab !== "object" || Array.isArray(state.activeTab)) {
    throw new Error("candidate UI state did not expose one active tab object");
  }
  return state.activeTab as Json;
}

async function postUi(connection: Connection, body: Json): Promise<void> {
  await apiJson(connection, "POST", "/state/ui", {
    debugSurface: "app",
    source: "final-surface-native-picker-lifecycle",
    ...body,
  });
}

async function apiJson<T>(
  connection: Connection,
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: unknown,
): Promise<T> {
  const headers = new Headers({ Authorization: `Bearer ${connection.token}` });
  if (body !== undefined) headers.set("Content-Type", "application/json");
  const response = await fetch(`${connection.base}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(3_000),
  });
  if (!response.ok) throw new Error(`${method} ${path} failed ${response.status}: ${(await response.text()).slice(0, 800)}`);
  return await response.json() as T;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 4096 || /[\r\n\0]/.test(value)) {
    throw new Error(`${label} was absent or invalid`);
  }
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
    observedEffect: "No candidate-owned native picker effect was observed.",
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function pickerObservedEffect(input: Input, macosEffect: string, webdriverEffect: string): string {
  return input.transport === "macos-native-input" ? macosEffect : webdriverEffect;
}
