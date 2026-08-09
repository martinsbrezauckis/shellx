import {
  clearReleaseSurfaceInstalledInputElement,
  clickReleaseSurfaceInstalledInputElement,
  findReleaseSurfaceInstalledInputElement,
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

type Assignment = ReleaseSurfaceDriverRequest["assignments"][number];
type Connection = { base: string; token: string };
type WebDriver = ReleaseSurfaceInstalledInputSession;
type VaultEntry = {
  key: string;
  description?: string | null;
  userOnly?: boolean;
  resourceKind?: string;
  [key: string]: unknown;
};
type VaultDirectory = { keys: string[]; entries: VaultEntry[]; [key: string]: unknown };
type UiBaseline = { settingsOpen: boolean; settingsTab: string };
type Action =
  | "reload"
  | "dismiss-notice"
  | "hide-row"
  | "hide-inline"
  | "open-replace"
  | "replace-input"
  | "replace-generate"
  | "replace-save"
  | "replace-cancel"
  | "open-metadata"
  | "metadata-description"
  | "metadata-user-only"
  | "metadata-save"
  | "metadata-cancel"
  | "new-description"
  | "new-user-only"
  | "confirm-delete"
  | "new-value-reveal"
  | "new-generator-open"
  | "new-secret-save"
  | "profile-save"
  | "wallet-save"
  | "generator-regenerate"
  | "generator-use"
  | "generator-save"
  | "generator-delete";

export const OWNED_VAULT_KEY = "release-surface-ui-owned-secret";
const OWNED_VAULT_INITIAL_VALUE = "SHELLX_RELEASE_UI_DEBUG_SECRET_VALUE";
const OWNED_VAULT_REPLACEMENT_VALUE = "SHELLX_RELEASE_UI_REPLACEMENT_VALUE_035";
const OWNED_VAULT_NEW_VALUE = "SHELLX_RELEASE_UI_NEW_VALUE_035";
const OWNED_PROFILE_KEY = "profile-cards/release-ui-owned-profile";
const OWNED_WALLET_KEY = "agent-wallets/release-ui-owned-wallet";
const OWNED_RESOURCE_KEYS = [OWNED_VAULT_KEY, OWNED_PROFILE_KEY, OWNED_WALLET_KEY] as const;
const INITIAL_DESCRIPTION = "Disposable final-surface Vault row";
const UPDATED_DESCRIPTION = "Updated disposable final-surface Vault row";
const DRAFT_DESCRIPTION = "Unsaved disposable Vault description";
const SETTINGS_DIALOG = "[role='dialog'][aria-label='Settings']";
const SETTINGS_VAULT_TAB = "[data-debug-id='settings-tab-vault']";
const VAULT_SECRETS_TAB = "[data-debug-id='vault-tab-secrets']";
const REVEAL = `[aria-label='Reveal value for ${OWNED_VAULT_KEY}']`;
const HIDE = `[aria-label='Hide value for ${OWNED_VAULT_KEY}']`;
const REVEALED = `[aria-label='Revealed value for ${OWNED_VAULT_KEY}']`;
const INLINE_HIDE = ".vault-row-reveal [title='Hide value']";
const REVEAL_MARKER = "[data-debug-id='vault-row-reveal'][data-shellx-sensitive='true']";
const REPLACE = `[aria-label='Replace value for ${OWNED_VAULT_KEY}']`;
const REPLACE_INPUT = `[aria-label='New value for ${OWNED_VAULT_KEY}']`;
const REPLACE_GENERATE = ".vault-row-edit [title='Generate a strong replacement']";
const REPLACE_SAVE = ".vault-row-edit input[type='password'] ~ button[type='submit']";
const REPLACE_CANCEL = "[data-debug-id='surface-components-settings-vaulttab-22']";
const METADATA = `[aria-label='Edit metadata for ${OWNED_VAULT_KEY}']`;
const METADATA_DESCRIPTION = `[aria-label='Description for ${OWNED_VAULT_KEY}']`;
const METADATA_USER_ONLY = ".vault-row-edit [data-debug-id='vault-user-only-toggle']";
const METADATA_SAVE = ".vault-row-edit textarea ~ button[type='submit']";
const METADATA_CANCEL = "[data-debug-id='surface-components-settings-vaulttab-18']";
const NEW_DESCRIPTION = "[aria-label='New secret description']";
const NEW_USER_ONLY = "[data-debug-id='vault-secret-form'] [data-debug-id='vault-user-only-toggle']";
const NEW_KEY = "[aria-label='New secret key name']";
const NEW_VALUE = "[aria-label='New secret value']";
const NEW_VALUE_REVEAL = ":is([aria-label='Hide generated secret value'],[aria-label='Reveal generated secret value'])";
const NEW_VALUE_HIDE = "[aria-label='Hide generated secret value']";
const NEW_VALUE_SHOW = "[aria-label='Reveal generated secret value']";
const NEW_GENERATOR_OPEN = "[data-debug-id='vault-generate-password']";
const NEW_SECRET_SAVE = "[data-debug-id='surface-components-settings-vaulttab-30']";
const NEW_COPY_ENABLED = "[title='Copy without revealing']:not([disabled])";
const GENERATOR = "[data-debug-id='vault-password-generator']";
const GENERATOR_REVEAL = "[aria-label='Reveal generated password']";
const GENERATOR_HIDE = "[aria-label='Hide generated password']";
const GENERATOR_REGENERATE = "[data-debug-id='vault-password-generator-regenerate']";
const GENERATOR_USE = "[data-debug-id='vault-password-generator-use']";
const GENERATOR_SAVE = "[data-debug-id='vault-password-generator-save']";
const GENERATOR_DELETE = ".vault-password-actions > button:last-child";
const DELETE = `[aria-label='Delete ${OWNED_VAULT_KEY}']`;
const CONFIRM_DELETE = `[aria-label='Confirm delete ${OWNED_VAULT_KEY}']`;
const PROFILE_TAB = "[data-debug-id='vault-resource-form-tab-profileCard']";
const PROFILE_LABEL = "[placeholder='Card label']";
const PROFILE_SAVE = "[data-debug-id='vault-profile-card-form'] button[type='submit']";
const WALLET_TAB = "[data-debug-id='vault-resource-form-tab-stripeAgentWallet']";
const WALLET_LABEL = "[placeholder='Wallet label']";
const WALLET_SAVE = "[data-debug-id='vault-agent-wallet-form'] button[type='submit']";
const RELOAD = "[title='Reload key list']";
const DISMISS_NOTICE = "[aria-label='Dismiss notification']";

const ACTIONS = new Map<string, Action>([
  [id('[title="Reload key list"]', 4), "reload"],
  [id('[aria-label="Dismiss notification"]', 5), "dismiss-notice"],
  [id('[aria-label^="Hide value for "]', 9), "hide-row"],
  [id('[aria-label^="Replace value for "]', 10), "open-replace"],
  [id('[aria-label^="Edit metadata for "]', 11), "open-metadata"],
  [id('[aria-label="Hide value"]', 14), "hide-inline"],
  [id('[data-debug-id="vault-description-input"]', 15), "metadata-description"],
  [id('[data-debug-id="vault-user-only-toggle"]', 16), "metadata-user-only"],
  [id('role=button;name="Save"', 17), "metadata-save"],
  [id('[data-debug-id="surface-components-settings-vaulttab-18"]', 18), "metadata-cancel"],
  [id('[aria-label^="New value for "]', 19), "replace-input"],
  [id('[title="Generate a strong replacement"]', 20), "replace-generate"],
  [id('role=button;name="Save"', 21), "replace-save"],
  [id('[data-debug-id="surface-components-settings-vaulttab-22"]', 22), "replace-cancel"],
  [id('[data-debug-id="vault-description-input"]', 28), "new-description"],
  [id('[data-debug-id="vault-user-only-toggle"]', 29), "new-user-only"],
  [id('[aria-label^="Confirm delete "]', 12), "confirm-delete"],
  [id(':is([aria-label="Hide generated secret value"],[aria-label="Reveal generated secret value"])', 25), "new-value-reveal"],
  [id('[data-debug-id="vault-generate-password"]', 26), "new-generator-open"],
  [id('[data-debug-id="surface-components-settings-vaulttab-30"]', 30), "new-secret-save"],
  [id('role=button;name="Save profile card"', 46), "profile-save"],
  [id('role=button;name="Save wallet"', 60), "wallet-save"],
  [externalId("src/components/VaultPasswordGenerator.tsx", '[data-debug-id="vault-password-generator-regenerate"]', 7), "generator-regenerate"],
  [externalId("src/components/VaultPasswordGenerator.tsx", '[data-debug-id="vault-password-generator-use"]', 8), "generator-use"],
  [externalId("src/components/VaultPasswordGenerator.tsx", '[data-debug-id="vault-password-generator-save"]', 9), "generator-save"],
  [externalId("src/components/VaultPasswordGenerator.tsx", 'role=button;name="Replace"', 10), "generator-delete"],
]);
const NEW_RESOURCE_ACTIONS = new Set<Action>([
  "new-value-reveal",
  "new-generator-open",
  "new-secret-save",
  "profile-save",
  "wallet-save",
  "generator-regenerate",
  "generator-use",
  "generator-save",
  "generator-delete",
]);

export const VAULT_OWNED_EDIT_SURFACE_IDS = new Set(ACTIONS.keys());
export const VAULT_OWNED_EDIT_FIXTURES = [
  "ui:vault-owned-secret-redacted-directory",
  "ui:vault-owned-secret-revealed-user-action",
  "ui:vault-owned-secret-metadata-edit",
  "ui:vault-owned-secret-replacement-edit",
  "ui:vault-unsaved-new-secret-edit",
  "ui:vault-owned-secret-delete",
  "ui:vault-unsaved-new-secret-value",
  "ui:vault-unsaved-new-secret-generator",
  "ui:vault-owned-new-secret-save",
  "ui:vault-owned-profile-save",
  "ui:vault-owned-wallet-save",
  "ui:vault-owned-generator-save",
] as const;
export const VAULT_OWNED_EDIT_CLEANUPS = [
  "ui:delete-exact-owned-vault-key-restore-redacted-directory-and-settings",
  "ui:delete-exact-owned-vault-resources-clear-sensitive-drafts-and-restore-settings",
] as const;
export const VAULT_OWNED_EDIT_ORACLES = [
  "ui:activation:vault-owned-directory-reloaded",
  "ui:activation:vault-owned-notice-dismissed",
  "ui:activation:vault-owned-reveal-hidden",
  "ui:activation:vault-owned-metadata-transition",
  "ui:activation:vault-owned-replacement-transition",
  "ui:activation:vault-owned-secret-deleted",
  "ui:activation:vault-new-secret-value-visibility",
  "ui:activation:vault-new-secret-generator-opened",
  "ui:activation:vault-owned-resource-saved",
  "ui:activation:vault-generator-regenerated",
  "ui:activation:vault-generator-used",
  "ui:activation:vault-generator-cleared",
  "ui:value-state-transition",
  "ui:boolean-state-transition",
] as const;
export const VAULT_OWNED_REVEAL_MARKER_SURFACE_ID =
  "ui-debug-surface:vault-row-reveal@src/components/settings/VaultTab.tsx#11";
export const VAULT_OWNED_REVEAL_MARKER_FIXTURE = "ui:vault-owned-secret-reveal-marker";
export const VAULT_OWNED_REVEAL_MARKER_CLEANUP =
  "ui:hide-owned-vault-secret-delete-exact-owned-key-and-restore-settings";
export const VAULT_OWNED_REVEAL_MARKER_ORACLE =
  "ui:visible:vault-owned-sensitive-row-without-value-observation";

export function supportsOwnedVaultEditControl(assignment: Assignment): boolean {
  return ACTIONS.has(assignment.surface.id);
}

export async function exerciseOwnedVaultEditControl(
  connection: Connection,
  webdriver: WebDriver,
  assignment: Assignment,
): Promise<ReleaseSurfaceDriverOutcome> {
  const action = ACTIONS.get(assignment.surface.id);
  const outcome = emptyOutcome(assignment);
  const cleanupErrors: string[] = [];
  let directoryBaseline: VaultDirectory | null = null;
  let uiBaseline: UiBaseline | null = null;
  try {
    if (!action) throw new Error(`owned Vault edit driver does not support ${assignment.surface.id}`);
    directoryBaseline = await readVaultDirectory(connection);
    if (hasOwnedResource(directoryBaseline)) throw new Error("an owned Vault lifecycle resource already existed");
    uiBaseline = await readUiBaseline(connection);

    if (action === "reload") {
      await openVault(connection, webdriver);
      await assertAbsent(webdriver, REPLACE, "owned Vault row before external seed");
      await seedOwnedSecret(connection);
      await assertAbsent(webdriver, REPLACE, "unrefreshed owned Vault row");
    } else if (NEW_RESOURCE_ACTIONS.has(action)) {
      await openVault(connection, webdriver);
    } else {
      await seedOwnedSecret(connection);
      await openVault(connection, webdriver);
      await waitForReleaseSurfaceInstalledInputElement(webdriver, REPLACE);
    }

    if (action === "reload") {
      await invokeControl(webdriver, RELOAD, outcome);
      await waitForReleaseSurfaceInstalledInputElement(webdriver, REPLACE);
      outcome.observedEffect = "Native input refreshed the rendered Vault directory and exposed exactly the externally seeded owned metadata row.";
    } else if (action === "dismiss-notice") {
      await revealOwnedSecret(webdriver);
      await hideOwnedSecret(webdriver, INLINE_HIDE);
      await invokeControl(webdriver, DISMISS_NOTICE, outcome);
      await waitForReleaseSurfaceInstalledInputElementAbsent(webdriver, DISMISS_NOTICE);
      outcome.observedEffect = "Native input dismissed the reveal success notice after the owned value was immediately hidden; no value entered the receipt.";
    } else if (action === "hide-row" || action === "hide-inline") {
      await revealOwnedSecret(webdriver);
      await invokeControl(webdriver, action === "hide-row" ? HIDE : INLINE_HIDE, outcome);
      await waitForReleaseSurfaceInstalledInputElementAbsent(webdriver, REVEALED);
      outcome.observedEffect = "Native input hid the deliberately revealed owned value and removed its sensitive input from the rendered tree.";
    } else if (action === "open-replace") {
      await invokeControl(webdriver, REPLACE, outcome);
      await waitForReleaseSurfaceInstalledInputElement(webdriver, REPLACE_INPUT);
      outcome.observedEffect = "Native input opened the replacement editor with an empty password field and disabled Save baseline.";
      await assertDisabled(webdriver, REPLACE_SAVE, true);
    } else if (action === "replace-input") {
      await openReplace(webdriver);
      const control = await waitForReleaseSurfaceInstalledInputElement(webdriver, REPLACE_INPUT);
      outcome.present = "pass";
      await setReleaseSurfaceInstalledInputElementValue(webdriver, control, OWNED_VAULT_REPLACEMENT_VALUE);
      outcome.invoke = "pass";
      await assertDisabled(webdriver, REPLACE_SAVE, false);
      outcome.observedEffect = "Native text entry changed the password-only replacement draft and enabled Save without observing or reporting its contents.";
    } else if (action === "replace-generate") {
      await openReplace(webdriver);
      await assertDisabled(webdriver, REPLACE_SAVE, true);
      await invokeControl(webdriver, REPLACE_GENERATE, outcome);
      await assertDisabled(webdriver, REPLACE_SAVE, false);
      outcome.observedEffect = "Native input generated a non-empty password-only replacement draft and enabled Save without reading or reporting the generated value.";
    } else if (action === "replace-save") {
      await openReplace(webdriver);
      await setValue(webdriver, REPLACE_INPUT, OWNED_VAULT_REPLACEMENT_VALUE);
      await invokeControl(webdriver, REPLACE_SAVE, outcome);
      await waitForReleaseSurfaceInstalledInputElementAbsent(webdriver, REPLACE_INPUT);
      await revealOwnedSecret(webdriver);
      await hideOwnedSecret(webdriver, INLINE_HIDE);
      await requireOwnedEntry(connection, INITIAL_DESCRIPTION, false);
      outcome.observedEffect = "Native input saved the owned replacement, closed its editor, then completed a fresh user reveal-and-hide transition while preserving exact metadata; no secret value was observed or reported.";
    } else if (action === "replace-cancel") {
      await openReplace(webdriver);
      await setValue(webdriver, REPLACE_INPUT, OWNED_VAULT_REPLACEMENT_VALUE);
      await invokeControl(webdriver, REPLACE_CANCEL, outcome);
      await waitForReleaseSurfaceInstalledInputElementAbsent(webdriver, REPLACE_INPUT);
      await revealOwnedSecret(webdriver);
      await hideOwnedSecret(webdriver, INLINE_HIDE);
      await requireOwnedEntry(connection, INITIAL_DESCRIPTION, false);
      outcome.observedEffect = "Native input canceled the password-only replacement draft, then proved the owned row still supports a fresh reveal-and-hide transition without emitting its value.";
    } else if (action === "open-metadata") {
      await invokeControl(webdriver, METADATA, outcome);
      await requireMetadataDraft(webdriver, INITIAL_DESCRIPTION, false);
      outcome.observedEffect = "Native input opened the owned metadata editor with its exact description and agent-visibility baseline.";
    } else if (action === "metadata-description") {
      await openMetadata(webdriver);
      const control = await waitForReleaseSurfaceInstalledInputElement(webdriver, METADATA_DESCRIPTION);
      outcome.present = "pass";
      await replaceValue(webdriver, control, DRAFT_DESCRIPTION);
      outcome.invoke = "pass";
      await assertValue(webdriver, METADATA_DESCRIPTION, DRAFT_DESCRIPTION);
      outcome.observedEffect = "Native text entry changed only the owned metadata description draft before deterministic cancellation.";
    } else if (action === "metadata-user-only") {
      await openMetadata(webdriver);
      await invokeControl(webdriver, METADATA_USER_ONLY, outcome);
      await assertChecked(webdriver, METADATA_USER_ONLY, true);
      outcome.observedEffect = "Native input changed only the owned metadata user-only draft before deterministic cancellation.";
    } else if (action === "metadata-save") {
      await openMetadata(webdriver);
      await setValue(webdriver, METADATA_DESCRIPTION, UPDATED_DESCRIPTION, true);
      await clickSelector(webdriver, METADATA_USER_ONLY);
      await invokeControl(webdriver, METADATA_SAVE, outcome);
      await waitForReleaseSurfaceInstalledInputElementAbsent(webdriver, METADATA_DESCRIPTION);
      await requireOwnedEntry(connection, UPDATED_DESCRIPTION, true);
      await openMetadata(webdriver);
      await requireMetadataDraft(webdriver, UPDATED_DESCRIPTION, true);
      await clickSelector(webdriver, METADATA_CANCEL);
      outcome.observedEffect = "Native input saved the owned description and user-only transition, then reopening the editor proved both exact persisted metadata fields.";
    } else if (action === "metadata-cancel") {
      await openMetadata(webdriver);
      await setValue(webdriver, METADATA_DESCRIPTION, UPDATED_DESCRIPTION, true);
      await clickSelector(webdriver, METADATA_USER_ONLY);
      await invokeControl(webdriver, METADATA_CANCEL, outcome);
      await waitForReleaseSurfaceInstalledInputElementAbsent(webdriver, METADATA_DESCRIPTION);
      await requireOwnedEntry(connection, INITIAL_DESCRIPTION, false);
      outcome.observedEffect = "Native input canceled both owned metadata drafts and the redacted directory retained its exact initial metadata.";
    } else if (action === "new-description") {
      const control = await waitForReleaseSurfaceInstalledInputElement(webdriver, NEW_DESCRIPTION);
      outcome.present = "pass";
      await replaceValue(webdriver, control, DRAFT_DESCRIPTION);
      outcome.invoke = "pass";
      await assertValue(webdriver, NEW_DESCRIPTION, DRAFT_DESCRIPTION);
      await replaceValue(webdriver, control, "");
      await assertValue(webdriver, NEW_DESCRIPTION, "");
      outcome.observedEffect = "Native text entry changed and exactly cleared only the unsaved new-secret description without submitting a Vault resource.";
    } else if (action === "new-user-only") {
      await invokeControl(webdriver, NEW_USER_ONLY, outcome);
      await assertChecked(webdriver, NEW_USER_ONLY, true);
      await clickSelector(webdriver, NEW_USER_ONLY);
      await assertChecked(webdriver, NEW_USER_ONLY, false);
      outcome.observedEffect = "Native input changed and exactly restored only the unsaved new-secret user-only choice without submitting a Vault resource.";
    } else if (action === "confirm-delete") {
      await clickSelector(webdriver, DELETE);
      await waitForReleaseSurfaceInstalledInputElement(webdriver, CONFIRM_DELETE);
      await invokeControl(webdriver, CONFIRM_DELETE, outcome);
      await waitForReleaseSurfaceInstalledInputElementAbsent(webdriver, REPLACE);
      await requireOwnedResourceAbsent(connection, OWNED_VAULT_KEY);
      outcome.observedEffect = "Native input confirmed deletion of the exact owned disposable secret and its redacted directory row disappeared without exposing the value.";
    } else if (action === "new-value-reveal") {
      await setValue(webdriver, NEW_VALUE, OWNED_VAULT_NEW_VALUE);
      await invokeControl(webdriver, NEW_VALUE_REVEAL, outcome);
      await waitForReleaseSurfaceInstalledInputElement(webdriver, NEW_VALUE_HIDE);
      await clickSelector(webdriver, NEW_VALUE_HIDE);
      await waitForReleaseSurfaceInstalledInputElement(webdriver, NEW_VALUE_SHOW);
      outcome.observedEffect = "Native input toggled and exactly restored only the unsaved synthetic secret field visibility without observing or reporting its contents.";
    } else if (action === "new-generator-open") {
      await invokeControl(webdriver, NEW_GENERATOR_OPEN, outcome);
      await waitForReleaseSurfaceInstalledInputElement(webdriver, GENERATOR);
      outcome.observedEffect = "Native input opened the unsaved secret password generator while generated contents remained unobserved.";
    } else if (action === "new-secret-save") {
      await setValue(webdriver, NEW_KEY, OWNED_VAULT_KEY);
      await setValue(webdriver, NEW_VALUE, OWNED_VAULT_NEW_VALUE);
      await invokeControl(webdriver, NEW_SECRET_SAVE, outcome);
      await waitForReleaseSurfaceInstalledInputElement(webdriver, REPLACE);
      await requireOwnedResource(connection, OWNED_VAULT_KEY, "secret");
      outcome.observedEffect = "Native input saved one exact owned disposable password/key and proved only its redacted secret-resource metadata before cleanup.";
    } else if (action === "profile-save") {
      await clickSelector(webdriver, PROFILE_TAB);
      await setValue(webdriver, PROFILE_LABEL, "Release UI owned profile");
      await invokeControl(webdriver, PROFILE_SAVE, outcome);
      await waitForReleaseSurfaceInstalledInputElement(webdriver, `[aria-label='Replace value for ${OWNED_PROFILE_KEY}']`);
      await requireOwnedResource(connection, OWNED_PROFILE_KEY, "profileCard");
      outcome.observedEffect = "Native input saved one exact owned disposable profile card and proved only its redacted profile metadata before cleanup.";
    } else if (action === "wallet-save") {
      await clickSelector(webdriver, WALLET_TAB);
      await setValue(webdriver, WALLET_LABEL, "Release UI owned wallet");
      await invokeControl(webdriver, WALLET_SAVE, outcome);
      await waitForReleaseSurfaceInstalledInputElement(webdriver, `[aria-label='Replace value for ${OWNED_WALLET_KEY}']`);
      await requireOwnedResource(connection, OWNED_WALLET_KEY, "stripeAgentWallet");
      outcome.observedEffect = "Native input saved one exact owned disposable wallet descriptor and proved only its redacted wallet metadata before cleanup.";
    } else if (action === "generator-regenerate" || action === "generator-delete") {
      await openNewSecretGenerator(webdriver, false);
      await clickSelector(webdriver, GENERATOR_REVEAL);
      await waitForReleaseSurfaceInstalledInputElement(webdriver, GENERATOR_HIDE);
      await invokeControl(webdriver, action === "generator-regenerate" ? GENERATOR_REGENERATE : GENERATOR_DELETE, outcome);
      await waitForReleaseSurfaceInstalledInputElement(webdriver, GENERATOR_REVEAL);
      outcome.observedEffect = action === "generator-regenerate"
        ? "Native input regenerated the temporary password pocket and reset its reveal state without observing either generated value."
        : "Native input cleared and replaced the temporary password pocket while resetting its reveal state without observing either value.";
    } else if (action === "generator-use") {
      await openNewSecretGenerator(webdriver, false);
      await invokeControl(webdriver, GENERATOR_USE, outcome);
      await waitForReleaseSurfaceInstalledInputElementAbsent(webdriver, GENERATOR);
      await waitForReleaseSurfaceInstalledInputElement(webdriver, NEW_COPY_ENABLED);
      outcome.observedEffect = "Native input moved the temporary password into the unsaved password field, closed the generator, and proved only the copy control's enabled state.";
    } else if (action === "generator-save") {
      await openNewSecretGenerator(webdriver, true);
      await invokeControl(webdriver, GENERATOR_SAVE, outcome);
      await waitForReleaseSurfaceInstalledInputElementAbsent(webdriver, GENERATOR);
      await waitForReleaseSurfaceInstalledInputElement(webdriver, REPLACE);
      await requireOwnedResource(connection, OWNED_VAULT_KEY, "secret");
      outcome.observedEffect = "Native input saved the generated password under one exact owned key and proved only redacted directory metadata before cleanup.";
    } else {
      throw new Error(`owned Vault edit action ${action} is not implemented`);
    }
    outcome.effect = "pass";
  } catch (error) {
    outcome.error = errorText(error);
  } finally {
    await cleanupAttempt(cleanupErrors, async () => {
      if (await findReleaseSurfaceInstalledInputElement(webdriver, REVEALED)) {
        await clickSelector(webdriver, INLINE_HIDE);
        await waitForReleaseSurfaceInstalledInputElementAbsent(webdriver, REVEALED);
      }
      if (await findReleaseSurfaceInstalledInputElement(webdriver, METADATA_CANCEL)) {
        await clickSelector(webdriver, METADATA_CANCEL);
      }
      if (await findReleaseSurfaceInstalledInputElement(webdriver, REPLACE_CANCEL)) {
        await clickSelector(webdriver, REPLACE_CANCEL);
      }
    });
    if (directoryBaseline) await cleanupAttempt(cleanupErrors, () => cleanupOwnedResources(connection, directoryBaseline!));
    if (uiBaseline) {
      await cleanupAttempt(cleanupErrors, () => restoreUiBaseline(connection, webdriver, uiBaseline!));
    }
    if (cleanupErrors.length === 0 && directoryBaseline && uiBaseline) outcome.cleanup = "pass";
    else if (cleanupErrors.length > 0) outcome.error = appendError(outcome.error, `cleanup: ${cleanupErrors.join(" | ")}`);
  }
  return finalize(outcome);
}

export async function exerciseOwnedVaultRevealMarker(
  connection: Connection,
  webdriver: WebDriver,
  assignment: Assignment,
): Promise<ReleaseSurfaceDriverOutcome> {
  const outcome = emptyOutcome(assignment);
  const cleanupErrors: string[] = [];
  let directoryBaseline: VaultDirectory | null = null;
  let uiBaseline: UiBaseline | null = null;
  try {
    if (assignment.surface.id !== VAULT_OWNED_REVEAL_MARKER_SURFACE_ID) {
      throw new Error(`owned Vault reveal-marker driver does not support ${assignment.surface.id}`);
    }
    directoryBaseline = await readVaultDirectory(connection);
    if (hasOwnedResource(directoryBaseline)) throw new Error("an owned Vault lifecycle resource already existed");
    uiBaseline = await readUiBaseline(connection);
    await seedOwnedSecret(connection);
    await openVault(connection, webdriver);
    await waitForReleaseSurfaceInstalledInputElement(webdriver, REPLACE);
    if (await findReleaseSurfaceInstalledInputElement(webdriver, REVEAL_MARKER)) {
      throw new Error("owned Vault reveal marker unexpectedly existed before trusted input");
    }
    await clickSelector(webdriver, REVEAL);
    outcome.invoke = "pass";
    await waitForReleaseSurfaceInstalledInputElement(webdriver, REVEAL_MARKER);
    outcome.present = "pass";
    outcome.effect = "pass";
    outcome.observedEffect = "Native input revealed one fixed synthetic owned secret long enough to resolve only its sensitive container marker, then hid it without reading, highlighting, hashing, or reporting the input value.";
    await clickSelector(webdriver, INLINE_HIDE);
    await waitForReleaseSurfaceInstalledInputElementAbsent(webdriver, REVEAL_MARKER);
  } catch (error) {
    outcome.error = errorText(error);
  } finally {
    await cleanupAttempt(cleanupErrors, async () => {
      if (await findReleaseSurfaceInstalledInputElement(webdriver, REVEAL_MARKER)) {
        await clickSelector(webdriver, INLINE_HIDE);
        await waitForReleaseSurfaceInstalledInputElementAbsent(webdriver, REVEAL_MARKER);
      }
    });
    if (directoryBaseline) await cleanupAttempt(cleanupErrors, () => cleanupOwnedResources(connection, directoryBaseline!));
    if (uiBaseline) await cleanupAttempt(cleanupErrors, () => restoreUiBaseline(connection, webdriver, uiBaseline!));
    if (cleanupErrors.length === 0 && directoryBaseline && uiBaseline) outcome.cleanup = "pass";
    else if (cleanupErrors.length > 0) outcome.error = appendError(outcome.error, `cleanup: ${cleanupErrors.join(" | ")}`);
  }
  return finalize(outcome);
}

async function openVault(connection: Connection, webdriver: WebDriver): Promise<void> {
  await postUi(connection, { openModal: "settings", source: "final-surface-owned-vault-edit" });
  await waitForReleaseSurfaceInstalledInputElement(webdriver, SETTINGS_DIALOG);
  await clickSelector(webdriver, SETTINGS_VAULT_TAB);
  await waitForReleaseSurfaceInstalledInputElement(webdriver, `${SETTINGS_VAULT_TAB}[aria-selected='true']`);
  await clickSelector(webdriver, VAULT_SECRETS_TAB);
}

async function openNewSecretGenerator(webdriver: WebDriver, withOwnedKey: boolean): Promise<void> {
  if (withOwnedKey) await setValue(webdriver, NEW_KEY, OWNED_VAULT_KEY);
  await clickSelector(webdriver, NEW_GENERATOR_OPEN);
  await waitForReleaseSurfaceInstalledInputElement(webdriver, GENERATOR);
}

async function openReplace(webdriver: WebDriver): Promise<void> {
  await clickSelector(webdriver, REPLACE);
  await waitForReleaseSurfaceInstalledInputElement(webdriver, REPLACE_INPUT);
}

async function openMetadata(webdriver: WebDriver): Promise<void> {
  await clickSelector(webdriver, METADATA);
  await waitForReleaseSurfaceInstalledInputElement(webdriver, METADATA_DESCRIPTION);
}

async function revealOwnedSecret(webdriver: WebDriver): Promise<void> {
  await clickSelector(webdriver, REVEAL);
  await waitForReleaseSurfaceInstalledInputElement(webdriver, REVEALED);
  await waitForReleaseSurfaceInstalledInputElement(webdriver, HIDE);
}

async function hideOwnedSecret(webdriver: WebDriver, selector: string): Promise<void> {
  await clickSelector(webdriver, selector);
  await waitForReleaseSurfaceInstalledInputElementAbsent(webdriver, REVEALED);
}

async function invokeControl(
  webdriver: WebDriver,
  selector: string,
  outcome: ReleaseSurfaceDriverOutcome,
): Promise<void> {
  const control = await waitForReleaseSurfaceInstalledInputElement(webdriver, selector);
  outcome.present = "pass";
  await clickReleaseSurfaceInstalledInputElement(webdriver, control);
  outcome.invoke = "pass";
}

async function clickSelector(webdriver: WebDriver, selector: string): Promise<void> {
  await clickReleaseSurfaceInstalledInputElement(
    webdriver,
    await waitForReleaseSurfaceInstalledInputElement(webdriver, selector),
  );
}

async function setValue(
  webdriver: WebDriver,
  selector: string,
  value: string,
  clear = false,
): Promise<void> {
  const control = await waitForReleaseSurfaceInstalledInputElement(webdriver, selector);
  if (clear) await clearReleaseSurfaceInstalledInputElement(webdriver, control);
  await setReleaseSurfaceInstalledInputElementValue(webdriver, control, value);
}

async function replaceValue(
  webdriver: WebDriver,
  control: Awaited<ReturnType<typeof waitForReleaseSurfaceInstalledInputElement>>,
  value: string,
): Promise<void> {
  await clearReleaseSurfaceInstalledInputElement(webdriver, control);
  if (value) await setReleaseSurfaceInstalledInputElementValue(webdriver, control, value);
}

async function assertValue(webdriver: WebDriver, selector: string, expected: string): Promise<void> {
  const observed = await observeReleaseSurfaceInstalledInputElement(webdriver, selector, ["value"]);
  if (!observed.present || !observed.visible || observed.value !== expected) {
    throw new Error(`${selector} did not reach its exact non-secret draft value`);
  }
}

async function assertChecked(webdriver: WebDriver, selector: string, expected: boolean): Promise<void> {
  const observed = await observeReleaseSurfaceInstalledInputElement(webdriver, selector, ["checked"]);
  if (!observed.present || !observed.visible || observed.checked !== expected) {
    throw new Error(`${selector} did not reach checked=${expected}`);
  }
}

async function assertDisabled(webdriver: WebDriver, selector: string, expected: boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const observed = await observeReleaseSurfaceInstalledInputElement(webdriver, selector, ["disabled"]);
    if (observed.present && observed.visible && observed.disabled === expected) return;
    await delay(50);
  }
  throw new Error(`${selector} did not reach disabled=${expected}`);
}

async function requireMetadataDraft(webdriver: WebDriver, description: string, userOnly: boolean): Promise<void> {
  await assertValue(webdriver, METADATA_DESCRIPTION, description);
  await assertChecked(webdriver, METADATA_USER_ONLY, userOnly);
}

async function assertAbsent(webdriver: WebDriver, selector: string, label: string): Promise<void> {
  if (await findReleaseSurfaceInstalledInputElement(webdriver, selector)) throw new Error(`${label} unexpectedly existed`);
}

async function seedOwnedSecret(connection: Connection): Promise<void> {
  const body = await apiJson(connection, "POST", "/vault/set", {
    key: OWNED_VAULT_KEY,
    value: OWNED_VAULT_INITIAL_VALUE,
    description: INITIAL_DESCRIPTION,
    userOnly: false,
  });
  assertNoSecretMaterial(body, "POST /vault/set");
  if (body.ok !== true || body.key !== OWNED_VAULT_KEY) throw new Error("owned Vault seed returned the wrong mutation envelope");
  await requireOwnedEntry(connection, INITIAL_DESCRIPTION, false);
}

async function requireOwnedEntry(
  connection: Connection,
  description: string,
  userOnly: boolean,
): Promise<VaultEntry> {
  const directory = await readVaultDirectory(connection);
  const entry = directory.entries.find((row) => row.key === OWNED_VAULT_KEY);
  if (!entry || !directory.keys.includes(OWNED_VAULT_KEY)
    || entry.description !== description || entry.userOnly !== userOnly) {
    throw new Error("owned Vault metadata did not reach its exact redacted state");
  }
  return entry;
}

async function requireOwnedResource(
  connection: Connection,
  key: string,
  resourceKind: string,
): Promise<VaultEntry> {
  const directory = await readVaultDirectory(connection);
  const entry = directory.entries.find((row) => row.key === key);
  if (!entry || !directory.keys.includes(key)
    || entry.resourceKind !== resourceKind || entry.userOnly !== false) {
    throw new Error(`owned Vault resource ${key} did not reach its exact redacted ${resourceKind} state`);
  }
  return entry;
}

async function requireOwnedResourceAbsent(connection: Connection, key: string): Promise<void> {
  const directory = await readVaultDirectory(connection);
  if (directory.keys.includes(key) || directory.entries.some((entry) => entry.key === key)) {
    throw new Error(`owned Vault resource ${key} remained in the redacted directory`);
  }
}

async function cleanupOwnedResources(connection: Connection, baseline: VaultDirectory): Promise<void> {
  const current = await readVaultDirectory(connection);
  for (const key of OWNED_RESOURCE_KEYS.filter((candidate) => (
    current.keys.includes(candidate) || current.entries.some((entry) => entry.key === candidate)
  ))) {
    const deleted = await apiJson(connection, "POST", "/vault/delete", { key });
    assertNoSecretMaterial(deleted, "POST /vault/delete");
    if (deleted.ok !== true || deleted.key !== key) throw new Error("owned Vault delete returned the wrong mutation envelope");
  }
  const restored = await readVaultDirectory(connection);
  if (JSON.stringify(restored) !== JSON.stringify(baseline)) {
    throw new Error("owned Vault edit fixture did not restore the redacted key directory exactly");
  }
}

async function readVaultDirectory(connection: Connection): Promise<VaultDirectory> {
  const body = await apiJson(connection, "GET", "/vault/keys");
  assertNoSecretMaterial(body, "GET /vault/keys");
  if (!Array.isArray(body.keys) || !Array.isArray(body.entries)
    || body.keys.some((key) => typeof key !== "string" || !key)
    || body.entries.some((entry) => !entry || typeof entry !== "object" || Array.isArray(entry)
      || typeof (entry as Record<string, unknown>).key !== "string")
    || body.keys.length !== body.entries.length) {
    throw new Error("GET /vault/keys returned an invalid redacted directory");
  }
  return body as VaultDirectory;
}

function assertNoSecretMaterial(value: unknown, label: string): void {
  const text = JSON.stringify(value);
  if (text.includes(OWNED_VAULT_INITIAL_VALUE) || text.includes(OWNED_VAULT_REPLACEMENT_VALUE)
    || text.includes(OWNED_VAULT_NEW_VALUE)
    || /"(?:value|secret)"\s*:/.test(text)) {
    throw new Error(`${label} exposed secret material`);
  }
}

function hasOwnedResource(directory: VaultDirectory): boolean {
  return OWNED_RESOURCE_KEYS.some((key) => (
    directory.keys.includes(key) || directory.entries.some((entry) => entry.key === key)
  ));
}

async function readUiBaseline(connection: Connection): Promise<UiBaseline> {
  const body = await apiJson(connection, "GET", "/state/ui");
  return {
    settingsOpen: body.settingsOpen === true,
    settingsTab: typeof body.settingsTab === "string" && body.settingsTab ? body.settingsTab : "general",
  };
}

async function restoreUiBaseline(connection: Connection, webdriver: WebDriver, baseline: UiBaseline): Promise<void> {
  if (baseline.settingsOpen) {
    await postUi(connection, { openModal: "settings", source: "final-surface-owned-vault-restore" });
    await waitForReleaseSurfaceInstalledInputElement(webdriver, SETTINGS_DIALOG);
    await clickSelector(webdriver, `[data-debug-id='settings-tab-${baseline.settingsTab}']`);
  } else {
    await postUi(connection, { openModal: "settings", source: "final-surface-owned-vault-owner-restore" });
    await waitForReleaseSurfaceInstalledInputElement(webdriver, SETTINGS_DIALOG);
    await clickSelector(webdriver, `[data-debug-id='settings-tab-${baseline.settingsTab}']`);
    await postUi(connection, { openModal: "close", source: "final-surface-owned-vault-cleanup" });
    await waitForReleaseSurfaceInstalledInputElementAbsent(webdriver, SETTINGS_DIALOG);
  }
  const restored = await readUiBaseline(connection);
  if (JSON.stringify(restored) !== JSON.stringify(baseline)) throw new Error("owned Vault edit UI owner did not restore exactly");
}

async function postUi(connection: Connection, body: Record<string, unknown>): Promise<void> {
  await apiJson(connection, "POST", "/state/ui", body);
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
  if (!response.ok) throw new Error(`${method} ${path} failed ${response.status}: ${text.slice(0, 1_200)}`);
  const value = text.trim() ? JSON.parse(text) : {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${method} ${path} returned invalid JSON`);
  return value as Record<string, unknown>;
}

function id(selector: string, occurrence: number): string {
  return `ui-control:src/components/settings/VaultTab.tsx:${selector}@src/components/settings/VaultTab.tsx#${occurrence}`;
}

function externalId(source: string, selector: string, occurrence: number): string {
  return `ui-control:${source}:${selector}@${source}#${occurrence}`;
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
    observedEffect: "No bounded owned-Vault editing transition was observed.",
  };
}

function finalize(outcome: ReleaseSurfaceDriverOutcome): ReleaseSurfaceDriverOutcome {
  if ([outcome.present, outcome.invoke, outcome.effect, outcome.cleanup].includes("fail") && !outcome.error) {
    outcome.error = "owned Vault edit control did not satisfy every required verdict";
  }
  return outcome;
}

async function cleanupAttempt(errors: string[], action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (error) {
    errors.push(errorText(error));
  }
}

function appendError(current: string | undefined, next: string): string {
  return current ? `${current}; ${next}` : next;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
