import {
  clearReleaseSurfaceInstalledInputElement as clearReleaseSurfaceWebDriverElement,
  clickReleaseSurfaceInstalledInputElement as clickReleaseSurfaceWebDriverElement,
  observeReleaseSurfaceInstalledInputElement,
  setReleaseSurfaceInstalledInputElementValue as setReleaseSurfaceWebDriverElementValue,
  waitForReleaseSurfaceInstalledInputElement as waitForReleaseSurfaceWebDriverElement,
  waitForReleaseSurfaceInstalledInputElementAbsent as waitForReleaseSurfaceWebDriverElementAbsent,
  type ReleaseSurfaceInstalledInputSession,
} from "../lib/release-surface-installed-input-client";
import type {
  ReleaseSurfaceDriverOutcome,
  ReleaseSurfaceDriverRequest,
} from "../lib/release-surface-driver-protocol";

type Assignment = ReleaseSurfaceDriverRequest["assignments"][number];
type WebDriver = ReleaseSurfaceInstalledInputSession;
type Connection = { base: string; token: string };
type VaultFormTab = "profileCard" | "secret" | "stripeAgentWallet";
type OwnedVaultGrant = { grantId: string; secretRef: string; secretValue: string };

const SETTINGS_DIALOG = "[role='dialog'][aria-label='Settings']";
const SETTINGS_VAULT_TAB = "[data-debug-id='settings-tab-vault']";
const SETTINGS_TABS = ["general", "vault", "connections", "connectors", "desktop", "shellxagent", "data", "about"] as const;
const VAULT_SECRETS_TAB = "[data-debug-id='vault-tab-secrets']";
const VAULT_GRANTS_TAB = "[data-debug-id='vault-tab-grants']";
const VAULT_SETUP_TAB = "[data-debug-id='vault-tab-setup']";
const VAULT_GRANTS_PANEL = "[data-debug-id='shellx-vault-grants']";
const VAULT_GRANT_ROW = "[data-debug-id='shellx-vault-grant-row']";
const VAULT_GRANTS_REFRESH = ".vault-grants-panel .vault-panel-head > button.settings-pill";
const VAULT_GRANT_REVOKE = `${VAULT_GRANT_ROW} > button.settings-pill`;
const VAULT_SETUP_MODE_LOCAL = "[data-debug-id='shellx-vault-setup-mode'] > button:first-child";
const VAULT_SETUP_MODE_EXTERNAL = "[data-debug-id='shellx-vault-setup-mode'] > button:last-child";
const VAULT_RECOVERY_CREATE = ".vault-setup-actions > button:first-child";
const VAULT_RECOVERY_COPY = "[data-debug-id='shellx-vault-recovery-copy']";
const VAULT_RECOVERY_IMPORT = ".vault-recovery-kit .vault-check-row input";
const VAULT_RECOVERY_CONFIRM = "[data-debug-id='shellx-vault-recovery-confirm']";
const VAULT_CONFIGURED_SUMMARY = "[data-debug-id='shellx-vault-configured-summary']";
const VAULT_CHANGE_SETUP = "[data-debug-id='shellx-vault-change-setup']";
const VAULT_UNLOCK_FORM = "[data-debug-id='shellx-vault-unlock-form']";
const VAULT_UNLOCK_PASSPHRASE = "[data-debug-id='shellx-vault-unlock-passphrase']";
const VAULT_UNLOCK_REMEMBER_DEVICE = "[data-debug-id='shellx-vault-remember-device-unlock']";
const VAULT_UNLOCK = "[data-debug-id='shellx-vault-unlock']";
const VAULT_REMEMBER_PASSPHRASE = "[data-debug-id='shellx-vault-remember-passphrase']";
const VAULT_REMEMBER_DEVICE_ENABLE = "[data-debug-id='shellx-vault-remember-device-enable']";
const VAULT_FORGET_DEVICE = "[data-debug-id='shellx-vault-forget-device']";
const VAULT_WORKSPACE_MODAL = "[data-debug-id='vault-workspace-modal']";
const VAULT_WORKSPACE_LOCK = "[data-debug-id='vault-workspace-lock']";
const VAULT_WORKSPACE_QUICK_UNLOCK = "[data-debug-id='vault-workspace-quick-unlock']";
const VAULT_WORKSPACE_PASSPHRASE = "[aria-label='Vault master passphrase']";
const VAULT_WORKSPACE_UNLOCK = "[data-debug-id='surface-components-vaultpanel-5']";
const VAULT_MASTER_PASSPHRASE = "[data-debug-id='shellx-vault-master-passphrase']";
const VAULT_CONFIRM_PASSPHRASE = "[data-debug-id='shellx-vault-confirm-passphrase']";
const OWNED_RECOVERY_PASSPHRASE = "ShellX-Release-UI-Vault-Passphrase-035";
const OWNED_GRANT_SECRET_VALUE_A = "SHELLX_RELEASE_SYNTHETIC_GRANT_VALUE_A_035";
const OWNED_GRANT_SECRET_VALUE_B = "SHELLX_RELEASE_SYNTHETIC_GRANT_VALUE_B_035";

type VaultDraftOwner = { tab: VaultFormTab; setup?: never; setupMode?: never }
  | { tab?: never; setup: true; setupMode?: "local" | "external" };
type TextConfig = VaultDraftOwner & { control: string; value: string; label: string };
type ChoiceConfig = VaultDraftOwner & {
  control: string;
  kind: "checkbox" | "select" | "pressed-group" | "setup-mode";
  label: string;
  options?: Readonly<Record<string, string>>;
  target?: string;
};

const profileTextFields = [
  ["Card label", "Final surface profile"],
  ["Full name", "Final Surface User"],
  ["Email", "final-surface@example.invalid"],
  ["Username", "final-surface-user"],
  ["Company", "Final Surface Co"],
  ["Role", "Test operator"],
  ["Phone", "+00000000000"],
  ["Address line 1", "1 Fixture Street"],
  ["Address line 2", "Suite 0"],
  ["City", "Fixture City"],
  ["Region", "Fixture Region"],
  ["Postal code", "00000"],
  ["Country", "Fixtureland"],
] as const;

const walletTextFields = [
  ["Wallet label", "Final surface wallet"],
  ["Stripe API secret ref", "fixture/nonexistent-stripe-reference"],
  ["Webhook signing secret ref", "fixture/nonexistent-webhook-reference"],
  ["Stripe account ref", "fixture-account-reference"],
  ["Stripe cardholder ref", "fixture-cardholder-reference"],
  ["Stripe card ref", "fixture-card-reference"],
  ["Budget summary", "Synthetic release-surface budget"],
  ["Allowed origins, comma-separated", "https://example.invalid"],
  ["Allowed categories, comma-separated", "synthetic"],
] as const;

const textConfigs = new Map<string, TextConfig>([
  [surface("[data-debug-id=\"vault-filter-input\"]"), {
    tab: "secret",
    control: "[data-debug-id='vault-filter-input']",
    value: "final-surface-no-match",
    label: "Vault list filter",
  }],
  [surface("[data-debug-id=\"vault-secret-key-input\"]"), {
    tab: "secret",
    control: "[data-debug-id='vault-secret-key-input']",
    value: "fixture/nonexistent-secret",
    label: "unsaved secret key",
  }],
  [surface("[data-debug-id=\"vault-secret-value-input\"]"), {
    tab: "secret",
    control: "[data-debug-id='vault-secret-value-input']",
    value: "synthetic-not-a-credential",
    label: "unsaved synthetic secret value",
  }],
  ...profileTextFields.map(([placeholder, value]) => [
    surface(`[placeholder=\"${placeholder}\"]`),
    { tab: "profileCard" as const, control: `[placeholder='${placeholder}']`, value, label: `unsaved profile ${placeholder}` },
  ] as const),
  ...walletTextFields.map(([placeholder, value]) => [
    surface(`[placeholder=\"${placeholder}\"]`),
    { tab: "stripeAgentWallet" as const, control: `[placeholder='${placeholder}']`, value, label: `unsaved wallet ${placeholder}` },
  ] as const),
  [setupSurface("[placeholder=\"Server URL\"]"), {
    setup: true,
    setupMode: "external",
    control: "[placeholder='Server URL']",
    value: "https://vault.example.invalid",
    label: "unsaved external Vault server URL",
  }],
  [setupSurface("[placeholder=\"Repo\"]"), {
    setup: true,
    setupMode: "external",
    control: "[placeholder='Repo']",
    value: "fixture/vault-repository",
    label: "unsaved external Vault repository",
  }],
  [setupSurface("[placeholder=\"Access token\"]"), {
    setup: true,
    setupMode: "external",
    control: "[placeholder='Access token']",
    value: "synthetic-not-an-access-token",
    label: "unsaved external Vault access-token draft",
  }],
  [setupSurface("[data-debug-id=\"shellx-vault-master-passphrase\"]"), {
    setup: true,
    setupMode: "local",
    control: "[data-debug-id='shellx-vault-master-passphrase']",
    value: "synthetic-release-passphrase",
    label: "unsaved Vault master-passphrase draft",
  }],
  [setupSurface("[data-debug-id=\"shellx-vault-confirm-passphrase\"]"), {
    setup: true,
    setupMode: "local",
    control: "[data-debug-id='shellx-vault-confirm-passphrase']",
    value: "synthetic-release-passphrase",
    label: "unsaved Vault passphrase-confirmation draft",
  }],
]);

const descriptionSurface = surface("[placeholder=\"description visible to agents unless marked user-only\"]");
const createRecoverySurface = setupSurface('role=button;name="Create recovery kit"');
const importRecoverySurface = setupSurface('role=input;name="Import existing ShellX secrets"');
const confirmRecoverySurface = setupSurface('[data-debug-id="shellx-vault-recovery-confirm"]');
const changeSetupSurface = setupSurface('[data-debug-id="shellx-vault-change-setup"]');
const unlockPassphraseSurface = setupSurface('[data-debug-id="shellx-vault-unlock-passphrase"]');
const unlockRememberDeviceSurface = setupSurface('[data-debug-id="shellx-vault-remember-device-unlock"]');
const unlockSurface = setupSurface('[data-debug-id="shellx-vault-unlock"]');
const rememberPassphraseSurface = setupSurface('[data-debug-id="shellx-vault-remember-passphrase"]');
const rememberDeviceEnableSurface = setupSurface('[data-debug-id="shellx-vault-remember-device-enable"]');
const forgetDeviceSurface = setupSurface('[data-debug-id="shellx-vault-forget-device"]');
const grantsRefreshSurface = grantsSurface('role=button;name="Refresh"');
const grantRevokeSurface = grantsSurface('role=button;name="Revoke"');
const workspaceLockSurface = 'src/components/VaultPanel.tsx:[data-debug-id="vault-workspace-lock"]';
const workspacePassphraseSurface = 'src/components/VaultPanel.tsx:[aria-label="Vault master passphrase"]';
const workspaceUnlockSurface = 'src/components/VaultPanel.tsx:[data-debug-id="surface-components-vaultpanel-5"]';

const choiceConfigs = new Map<string, ChoiceConfig>([
  [surface("[data-debug-id=\"surface-components-settings-vaulttab-45\"]"), {
    tab: "profileCard",
    control: "[data-debug-id='surface-components-settings-vaulttab-45']",
    kind: "checkbox",
    label: "unsaved profile user-only",
  }],
  [surface("[data-debug-id=\"surface-components-settings-vaulttab-48\"]"), {
    tab: "stripeAgentWallet",
    control: "[data-debug-id='surface-components-settings-vaulttab-48']",
    kind: "select",
    label: "unsaved wallet Stripe mode",
    options: { test: "Stripe test", live: "Stripe live" },
  }],
  [surface("[data-debug-id=\"surface-components-settings-vaulttab-57\"]"), {
    tab: "stripeAgentWallet",
    control: "[data-debug-id='surface-components-settings-vaulttab-57']",
    kind: "select",
    label: "unsaved wallet status",
    options: { dryRun: "Dry-run", active: "Active", frozen: "Frozen" },
  }],
  [surface("[data-debug-id=\"surface-components-settings-vaulttab-59\"]"), {
    tab: "stripeAgentWallet",
    control: "[data-debug-id='surface-components-settings-vaulttab-59']",
    kind: "checkbox",
    label: "unsaved wallet user-only",
  }],
  ...(["visible", "userOnly", "toolUseAlways", "browserFillAlways"] as const).map((level) => [
    surface(`[data-debug-id="vault-permission-${level}"]`),
    {
      tab: "secret" as const,
      control: `[data-debug-id='vault-permission-${level}']`,
      kind: "pressed-group" as const,
      label: `unsaved secret ${level} permission level`,
      target: level,
    },
  ] as const),
  [setupSurface('role=button;name="Local"'), {
    setup: true,
    control: VAULT_SETUP_MODE_LOCAL,
    kind: "setup-mode",
    label: "unsaved local Vault setup mode",
    target: "local",
  }],
  [setupSurface('role=button;name="External"'), {
    setup: true,
    control: VAULT_SETUP_MODE_EXTERNAL,
    kind: "setup-mode",
    label: "unsaved external Vault setup mode",
    target: "external",
  }],
  [setupSurface("[data-debug-id=\"shellx-vault-remember-device-setup\"]"), {
    setup: true,
    control: "[data-debug-id='shellx-vault-remember-device-setup']",
    kind: "checkbox",
    label: "unsaved Vault remember-device choice",
  }],
]);

export const SAFE_VAULT_DRAFT_FIXTURES = [
  "ui:vault-unsaved-draft-text-baseline",
  "ui:vault-unsaved-draft-choice-baseline",
  "ui:vault-unsaved-draft-permission-baseline",
  "ui:vault-setup-recovery-action",
  "ui:vault-setup-recovery-import-choice",
  "ui:vault-setup-recovery-confirm-action",
  "ui:vault-configured-change-setup-action",
  "ui:vault-configured-unlock-passphrase",
  "ui:vault-configured-unlock-remember-device",
  "ui:vault-configured-unlock-action",
  "ui:vault-configured-remember-passphrase",
  "ui:vault-configured-remember-device-enable",
  "ui:vault-configured-forget-device",
  "ui:vault-workspace-lock-action",
  "ui:vault-workspace-unlock-passphrase",
  "ui:vault-workspace-unlock-action",
  "ui:vault-grants-refresh-owned-grants",
  "ui:vault-grants-revoke-owned-grant",
] as const;
export const SAFE_VAULT_DRAFT_CLEANUPS = [
  "ui:restore-vault-unsaved-draft-and-settings-owner",
  "ui:reset-disposable-vault-and-close-settings",
] as const;
export const SAFE_VAULT_DRAFT_ORACLES = [
  "ui:activation:vault-recovery-kit-created",
  "ui:activation:vault-recovery-confirmed",
  "ui:activation:vault-change-setup-opened",
  "ui:activation:vault-unlocked",
  "ui:activation:vault-locked",
  "ui:activation:vault-remembered-device-enabled",
  "ui:activation:vault-remembered-device-disabled",
  "ui:activation:vault-grants-refreshed",
  "ui:activation:vault-grant-revoked",
] as const;

export function supportsSafeVaultDraftControl(assignment: Assignment): boolean {
  return assignment.surface.name === createRecoverySurface
    || assignment.surface.name === importRecoverySurface
    || assignment.surface.name === confirmRecoverySurface
    || assignment.surface.name === changeSetupSurface
    || assignment.surface.name === unlockPassphraseSurface
    || assignment.surface.name === unlockRememberDeviceSurface
    || assignment.surface.name === unlockSurface
    || assignment.surface.name === rememberPassphraseSurface
    || assignment.surface.name === rememberDeviceEnableSurface
    || assignment.surface.name === forgetDeviceSurface
    || assignment.surface.name === grantsRefreshSurface
    || assignment.surface.name === grantRevokeSurface
    || assignment.surface.name === workspaceLockSurface
    || assignment.surface.name === workspacePassphraseSurface
    || assignment.surface.name === workspaceUnlockSurface
    || Boolean(textConfig(assignment) || choiceConfigs.has(assignment.surface.name));
}

export async function exerciseSafeVaultDraftControl(
  connection: Connection,
  webdriver: WebDriver,
  assignment: Assignment,
): Promise<ReleaseSurfaceDriverOutcome> {
  if (assignment.surface.name === createRecoverySurface) {
    return await exerciseCreateRecoveryKit(connection, webdriver, assignment);
  }
  if (assignment.surface.name === importRecoverySurface) {
    return await exerciseRecoveryImportChoice(connection, webdriver, assignment);
  }
  if (assignment.surface.name === confirmRecoverySurface) {
    return await exerciseConfirmRecovery(connection, webdriver, assignment);
  }
  if (assignment.surface.name === changeSetupSurface) {
    return await exerciseChangeSetup(connection, webdriver, assignment);
  }
  if (assignment.surface.name === unlockPassphraseSurface) {
    return await exerciseUnlockPassphrase(connection, webdriver, assignment);
  }
  if (assignment.surface.name === unlockRememberDeviceSurface) {
    return await exerciseUnlockRememberDevice(connection, webdriver, assignment);
  }
  if (assignment.surface.name === unlockSurface) {
    return await exerciseUnlock(connection, webdriver, assignment);
  }
  if (assignment.surface.name === rememberPassphraseSurface) {
    return await exerciseRememberPassphrase(connection, webdriver, assignment);
  }
  if (assignment.surface.name === rememberDeviceEnableSurface) {
    return await exerciseRememberDeviceEnable(connection, webdriver, assignment);
  }
  if (assignment.surface.name === forgetDeviceSurface) {
    return await exerciseForgetDevice(connection, webdriver, assignment);
  }
  if (assignment.surface.name === grantsRefreshSurface) {
    return await exerciseGrantsRefresh(connection, webdriver, assignment);
  }
  if (assignment.surface.name === grantRevokeSurface) {
    return await exerciseGrantRevoke(connection, webdriver, assignment);
  }
  if (assignment.surface.name === workspaceLockSurface) {
    return await exerciseWorkspaceLock(connection, webdriver, assignment);
  }
  if (assignment.surface.name === workspacePassphraseSurface) {
    return await exerciseWorkspacePassphrase(connection, webdriver, assignment);
  }
  if (assignment.surface.name === workspaceUnlockSurface) {
    return await exerciseWorkspaceUnlock(connection, webdriver, assignment);
  }
  const text = textConfig(assignment);
  return text
    ? await exerciseText(connection, webdriver, assignment, text)
    : await exerciseChoice(connection, webdriver, assignment, choiceConfigs.get(assignment.surface.name)!);
}

async function prepareRecoveryChallenge(
  connection: Connection,
  webdriver: WebDriver,
): Promise<string> {
  await resetDisposableVault(connection);
  const baselineSetupMode = await openVaultDraft(connection, webdriver, { setup: true, setupMode: "local" });
  if (!baselineSetupMode) throw new Error("Vault recovery setup omitted its baseline mode");
  await replaceInput(
    webdriver,
    await waitForReleaseSurfaceWebDriverElement(webdriver, VAULT_MASTER_PASSPHRASE),
    VAULT_MASTER_PASSPHRASE,
    OWNED_RECOVERY_PASSPHRASE,
  );
  await replaceInput(
    webdriver,
    await waitForReleaseSurfaceWebDriverElement(webdriver, VAULT_CONFIRM_PASSPHRASE),
    VAULT_CONFIRM_PASSPHRASE,
    OWNED_RECOVERY_PASSPHRASE,
  );
  return baselineSetupMode;
}

async function prepareLockedConfiguredVault(
  connection: Connection,
  webdriver: WebDriver,
): Promise<void> {
  await prepareRecoveryChallenge(connection, webdriver);
  await clickSelector(webdriver, VAULT_RECOVERY_CREATE);
  await waitForReleaseSurfaceWebDriverElement(webdriver, VAULT_RECOVERY_COPY);
  await clickSelector(webdriver, VAULT_RECOVERY_CONFIRM);
  await waitForReleaseSurfaceWebDriverElement(webdriver, VAULT_CONFIGURED_SUMMARY);
  const locked = await apiJson(connection, "POST", "/vault/lock", {});
  if (locked.unlocked !== false || locked.rememberedDeviceEnabled !== false) {
    throw new Error("disposable Vault lock did not return the exact locked non-remembered state");
  }
  await waitForReleaseSurfaceWebDriverElement(webdriver, VAULT_UNLOCK_FORM);
  const status = await apiJson(connection, "GET", "/vault/status");
  if (status.mode !== "local" || status.unlocked !== false || status.recoveryConfirmed !== true
    || status.rememberedDeviceEnabled !== false) {
    throw new Error("disposable Vault did not reach its exact configured and locked state");
  }
}

async function prepareVaultWorkspace(
  connection: Connection,
  webdriver: WebDriver,
  locked: boolean,
): Promise<void> {
  await prepareRecoveryChallenge(connection, webdriver);
  await clickSelector(webdriver, VAULT_RECOVERY_CREATE);
  await waitForReleaseSurfaceWebDriverElement(webdriver, VAULT_RECOVERY_COPY);
  await clickSelector(webdriver, VAULT_RECOVERY_CONFIRM);
  await waitForReleaseSurfaceWebDriverElement(webdriver, VAULT_CONFIGURED_SUMMARY);
  if (locked) await apiJson(connection, "POST", "/vault/lock", {});
  await postUi(connection, { openModal: "vault", source: "final-surface-vault-workspace-lifecycle" });
  await waitForReleaseSurfaceWebDriverElement(webdriver, VAULT_WORKSPACE_MODAL);
  await waitForReleaseSurfaceWebDriverElement(
    webdriver,
    locked ? VAULT_WORKSPACE_QUICK_UNLOCK : VAULT_WORKSPACE_LOCK,
  );
  const status = await apiJson(connection, "GET", "/vault/status");
  if (status.mode !== "local" || status.unlocked !== !locked || status.recoveryConfirmed !== true
    || status.rememberedDeviceEnabled !== false) {
    throw new Error(`disposable Vault workspace did not reach its exact ${locked ? "locked" : "unlocked"} state`);
  }
}

async function exerciseCreateRecoveryKit(
  connection: Connection,
  webdriver: WebDriver,
  assignment: Assignment,
): Promise<ReleaseSurfaceDriverOutcome> {
  const outcome = emptyOutcome(assignment, "No native Vault recovery-kit creation effect was observed.");
  let baselineStorage: string | null | undefined;
  let baselineSetupMode: string | null = null;
  try {
    baselineStorage = await readSettingsStorage(connection, webdriver);
    baselineSetupMode = await prepareRecoveryChallenge(connection, webdriver);
    const control = await waitForReleaseSurfaceWebDriverElement(webdriver, VAULT_RECOVERY_CREATE);
    outcome.present = "pass";
    await clickReleaseSurfaceWebDriverElement(webdriver, control);
    outcome.invoke = "pass";
    await waitForReleaseSurfaceWebDriverElement(webdriver, VAULT_RECOVERY_COPY);
    await waitForInput(webdriver, VAULT_MASTER_PASSPHRASE, "");
    await waitForInput(webdriver, VAULT_CONFIRM_PASSPHRASE, "");
    const status = await apiJson(connection, "GET", "/vault/status");
    if (status.mode !== "unconfigured" || status.unlocked !== false || status.recoveryConfirmed !== false) {
      throw new Error("Vault recovery-kit creation changed the logical Vault status before operator confirmation");
    }
    outcome.effect = "pass";
    outcome.observedEffect = "Native WebDriver input began one disposable Vault recovery challenge, rendered its copy action, cleared both passphrase fields, and retained no confirmed Vault state; recovery words were never observed.";
  } catch (error) {
    outcome.error = errorText(error);
  } finally {
    await cleanupStep(outcome, async () => {
      for (const selector of [VAULT_MASTER_PASSPHRASE, VAULT_CONFIRM_PASSPHRASE]) {
        const control = await visibleElement(webdriver, selector);
        if (control) await clearReleaseSurfaceWebDriverElement(webdriver, control);
      }
      await resetDisposableVault(connection);
    });
    if (baselineSetupMode) await cleanupStep(outcome, () => setSetupMode(webdriver, baselineSetupMode!));
    await cleanupOwner(connection, webdriver, outcome, baselineStorage);
  }
  return finalize(outcome);
}

async function exerciseRecoveryImportChoice(
  connection: Connection,
  webdriver: WebDriver,
  assignment: Assignment,
): Promise<ReleaseSurfaceDriverOutcome> {
  const outcome = emptyOutcome(assignment, "No native Vault recovery import-choice effect was observed.");
  let baselineStorage: string | null | undefined;
  let baselineSetupMode: string | null = null;
  let importToggled = false;
  try {
    baselineStorage = await readSettingsStorage(connection, webdriver);
    baselineSetupMode = await prepareRecoveryChallenge(connection, webdriver);
    await clickReleaseSurfaceWebDriverElement(
      webdriver,
      await waitForReleaseSurfaceWebDriverElement(webdriver, VAULT_RECOVERY_CREATE),
    );
    await waitForReleaseSurfaceWebDriverElement(webdriver, VAULT_RECOVERY_COPY);
    const control = await waitForReleaseSurfaceWebDriverElement(webdriver, VAULT_RECOVERY_IMPORT);
    const baseline = await readChoice(webdriver, VAULT_RECOVERY_IMPORT);
    if (baseline.checked !== false) throw new Error("Vault recovery import choice did not start disabled");
    outcome.present = "pass";
    await clickReleaseSurfaceWebDriverElement(webdriver, control);
    importToggled = true;
    outcome.invoke = "pass";
    await waitForChoice(webdriver, VAULT_RECOVERY_IMPORT, { checked: true });
    outcome.effect = "pass";
    outcome.observedEffect = "Native WebDriver input changed only the disposable recovery challenge's legacy-import choice, without confirming setup or observing recovery words.";
  } catch (error) {
    outcome.error = errorText(error);
  } finally {
    if (importToggled) await cleanupStep(outcome, async () => {
      const control = await visibleElement(webdriver, VAULT_RECOVERY_IMPORT);
      if (control && (await readChoice(webdriver, VAULT_RECOVERY_IMPORT)).checked === true) {
        await clickReleaseSurfaceWebDriverElement(webdriver, control);
        await waitForChoice(webdriver, VAULT_RECOVERY_IMPORT, { checked: false });
      }
    });
    await cleanupStep(outcome, () => resetDisposableVault(connection));
    if (baselineSetupMode) await cleanupStep(outcome, () => setSetupMode(webdriver, baselineSetupMode!));
    await cleanupOwner(connection, webdriver, outcome, baselineStorage);
  }
  return finalize(outcome);
}

async function exerciseConfirmRecovery(
  connection: Connection,
  webdriver: WebDriver,
  assignment: Assignment,
): Promise<ReleaseSurfaceDriverOutcome> {
  const outcome = emptyOutcome(assignment, "No native Vault recovery-confirmation effect was observed.");
  let baselineStorage: string | null | undefined;
  try {
    baselineStorage = await readSettingsStorage(connection, webdriver);
    await prepareRecoveryChallenge(connection, webdriver);
    await clickReleaseSurfaceWebDriverElement(
      webdriver,
      await waitForReleaseSurfaceWebDriverElement(webdriver, VAULT_RECOVERY_CREATE),
    );
    await waitForReleaseSurfaceWebDriverElement(webdriver, VAULT_RECOVERY_COPY);
    const control = await waitForReleaseSurfaceWebDriverElement(webdriver, VAULT_RECOVERY_CONFIRM);
    outcome.present = "pass";
    await clickReleaseSurfaceWebDriverElement(webdriver, control);
    outcome.invoke = "pass";
    await waitForReleaseSurfaceWebDriverElement(webdriver, VAULT_CONFIGURED_SUMMARY);
    const status = await apiJson(connection, "GET", "/vault/status");
    if (status.mode !== "local" || status.unlocked !== true || status.recoveryConfirmed !== true
      || status.rememberedDeviceEnabled !== false) {
      throw new Error("Vault recovery confirmation did not reach its exact configured and unlocked status");
    }
    outcome.effect = "pass";
    outcome.observedEffect = "Native WebDriver input confirmed one disposable recovery challenge, rendered the configured summary, and proved the Vault unlocked without observing recovery words.";
  } catch (error) {
    outcome.error = errorText(error);
  } finally {
    await cleanupStep(outcome, () => resetDisposableVault(connection));
    await cleanupOwner(connection, webdriver, outcome, baselineStorage);
  }
  return finalize(outcome);
}

async function exerciseChangeSetup(
  connection: Connection,
  webdriver: WebDriver,
  assignment: Assignment,
): Promise<ReleaseSurfaceDriverOutcome> {
  const outcome = emptyOutcome(assignment, "No native configured-Vault setup-form transition was observed.");
  let baselineStorage: string | null | undefined;
  try {
    baselineStorage = await readSettingsStorage(connection, webdriver);
    await prepareRecoveryChallenge(connection, webdriver);
    await clickSelector(webdriver, VAULT_RECOVERY_CREATE);
    await waitForReleaseSurfaceWebDriverElement(webdriver, VAULT_RECOVERY_COPY);
    await clickSelector(webdriver, VAULT_RECOVERY_CONFIRM);
    await waitForReleaseSurfaceWebDriverElement(webdriver, VAULT_CONFIGURED_SUMMARY);
    const control = await waitForReleaseSurfaceWebDriverElement(webdriver, VAULT_CHANGE_SETUP);
    outcome.present = "pass";
    await clickReleaseSurfaceWebDriverElement(webdriver, control);
    outcome.invoke = "pass";
    await waitForReleaseSurfaceWebDriverElement(webdriver, VAULT_MASTER_PASSPHRASE);
    await waitForReleaseSurfaceWebDriverElementAbsent(webdriver, VAULT_CONFIGURED_SUMMARY);
    const status = await apiJson(connection, "GET", "/vault/status");
    if (status.mode !== "local" || status.unlocked !== true || status.recoveryConfirmed !== true) {
      throw new Error("Change setup altered the configured Vault backend state");
    }
    outcome.effect = "pass";
    outcome.observedEffect = "Native WebDriver input opened the configured Vault setup form while the disposable backend remained configured and unlocked.";
  } catch (error) {
    outcome.error = errorText(error);
  } finally {
    await cleanupStep(outcome, () => resetDisposableVault(connection));
    await cleanupOwner(connection, webdriver, outcome, baselineStorage);
  }
  return finalize(outcome);
}

async function exerciseUnlockPassphrase(
  connection: Connection,
  webdriver: WebDriver,
  assignment: Assignment,
): Promise<ReleaseSurfaceDriverOutcome> {
  const outcome = emptyOutcome(assignment, "No native locked-Vault passphrase entry was observed.");
  let baselineStorage: string | null | undefined;
  try {
    baselineStorage = await readSettingsStorage(connection, webdriver);
    await prepareLockedConfiguredVault(connection, webdriver);
    const control = await waitForReleaseSurfaceWebDriverElement(webdriver, VAULT_UNLOCK_PASSPHRASE);
    outcome.present = "pass";
    await replaceInput(webdriver, control, VAULT_UNLOCK_PASSPHRASE, OWNED_RECOVERY_PASSPHRASE);
    outcome.invoke = "pass";
    await waitForInput(webdriver, VAULT_UNLOCK_PASSPHRASE, OWNED_RECOVERY_PASSPHRASE);
    const status = await apiJson(connection, "GET", "/vault/status");
    if (status.unlocked !== false || status.recoveryConfirmed !== true) {
      throw new Error("passphrase entry changed the locked Vault backend state");
    }
    outcome.effect = "pass";
    outcome.observedEffect = "Native WebDriver text entry changed only the locked disposable Vault's passphrase draft while its backend remained configured and locked.";
  } catch (error) {
    outcome.error = errorText(error);
  } finally {
    await cleanupStep(outcome, async () => {
      const control = await visibleElement(webdriver, VAULT_UNLOCK_PASSPHRASE);
      if (control) await clearReleaseSurfaceWebDriverElement(webdriver, control);
      await resetDisposableVault(connection);
    });
    await cleanupOwner(connection, webdriver, outcome, baselineStorage);
  }
  return finalize(outcome);
}

async function exerciseUnlockRememberDevice(
  connection: Connection,
  webdriver: WebDriver,
  assignment: Assignment,
): Promise<ReleaseSurfaceDriverOutcome> {
  const outcome = emptyOutcome(assignment, "No native locked-Vault remember-device choice was observed.");
  let baselineStorage: string | null | undefined;
  let toggled = false;
  try {
    baselineStorage = await readSettingsStorage(connection, webdriver);
    await prepareLockedConfiguredVault(connection, webdriver);
    const control = await waitForReleaseSurfaceWebDriverElement(webdriver, VAULT_UNLOCK_REMEMBER_DEVICE);
    const baseline = await readChoice(webdriver, VAULT_UNLOCK_REMEMBER_DEVICE);
    if (baseline.checked !== true) throw new Error("locked Vault remember-device choice did not start enabled");
    outcome.present = "pass";
    await clickReleaseSurfaceWebDriverElement(webdriver, control);
    toggled = true;
    outcome.invoke = "pass";
    await waitForChoice(webdriver, VAULT_UNLOCK_REMEMBER_DEVICE, { checked: false });
    const status = await apiJson(connection, "GET", "/vault/status");
    if (status.unlocked !== false || status.rememberedDeviceEnabled !== false) {
      throw new Error("remember-device draft changed the locked Vault backend state");
    }
    outcome.effect = "pass";
    outcome.observedEffect = "Native WebDriver input changed only the locked disposable Vault's remember-device choice while the backend remained locked and device remembering stayed disabled.";
  } catch (error) {
    outcome.error = errorText(error);
  } finally {
    if (toggled) await cleanupStep(outcome, async () => {
      const control = await visibleElement(webdriver, VAULT_UNLOCK_REMEMBER_DEVICE);
      if (control && (await readChoice(webdriver, VAULT_UNLOCK_REMEMBER_DEVICE)).checked === false) {
        await clickReleaseSurfaceWebDriverElement(webdriver, control);
        await waitForChoice(webdriver, VAULT_UNLOCK_REMEMBER_DEVICE, { checked: true });
      }
    });
    await cleanupStep(outcome, () => resetDisposableVault(connection));
    await cleanupOwner(connection, webdriver, outcome, baselineStorage);
  }
  return finalize(outcome);
}

async function exerciseUnlock(
  connection: Connection,
  webdriver: WebDriver,
  assignment: Assignment,
): Promise<ReleaseSurfaceDriverOutcome> {
  const outcome = emptyOutcome(assignment, "No native locked-Vault unlock effect was observed.");
  let baselineStorage: string | null | undefined;
  try {
    baselineStorage = await readSettingsStorage(connection, webdriver);
    await prepareLockedConfiguredVault(connection, webdriver);
    const rememberControl = await waitForReleaseSurfaceWebDriverElement(webdriver, VAULT_UNLOCK_REMEMBER_DEVICE);
    if ((await readChoice(webdriver, VAULT_UNLOCK_REMEMBER_DEVICE)).checked === true) {
      await clickReleaseSurfaceWebDriverElement(webdriver, rememberControl);
      await waitForChoice(webdriver, VAULT_UNLOCK_REMEMBER_DEVICE, { checked: false });
    }
    await replaceInput(
      webdriver,
      await waitForReleaseSurfaceWebDriverElement(webdriver, VAULT_UNLOCK_PASSPHRASE),
      VAULT_UNLOCK_PASSPHRASE,
      OWNED_RECOVERY_PASSPHRASE,
    );
    const control = await waitForReleaseSurfaceWebDriverElement(webdriver, VAULT_UNLOCK);
    outcome.present = "pass";
    await clickReleaseSurfaceWebDriverElement(webdriver, control);
    outcome.invoke = "pass";
    await waitForReleaseSurfaceWebDriverElementAbsent(webdriver, VAULT_UNLOCK_FORM);
    const status = await apiJson(connection, "GET", "/vault/status");
    if (status.mode !== "local" || status.unlocked !== true || status.recoveryConfirmed !== true
      || status.rememberedDeviceEnabled !== false) {
      throw new Error("native Vault unlock did not reach the exact unlocked non-remembered state");
    }
    outcome.effect = "pass";
    outcome.observedEffect = "Native WebDriver input unlocked the configured disposable Vault with its owned passphrase while device remembering remained disabled and the passphrase field disappeared.";
  } catch (error) {
    outcome.error = errorText(error);
  } finally {
    await cleanupStep(outcome, () => resetDisposableVault(connection));
    await cleanupOwner(connection, webdriver, outcome, baselineStorage);
  }
  return finalize(outcome);
}

async function exerciseRememberPassphrase(
  connection: Connection,
  webdriver: WebDriver,
  assignment: Assignment,
): Promise<ReleaseSurfaceDriverOutcome> {
  const outcome = emptyOutcome(assignment, "No native remembered-device passphrase draft was observed.");
  let baselineStorage: string | null | undefined;
  try {
    baselineStorage = await readSettingsStorage(connection, webdriver);
    await prepareRecoveryChallenge(connection, webdriver);
    await clickSelector(webdriver, VAULT_RECOVERY_CREATE);
    await waitForReleaseSurfaceWebDriverElement(webdriver, VAULT_RECOVERY_COPY);
    await clickSelector(webdriver, VAULT_RECOVERY_CONFIRM);
    await waitForReleaseSurfaceWebDriverElement(webdriver, VAULT_CONFIGURED_SUMMARY);
    const control = await waitForReleaseSurfaceWebDriverElement(webdriver, VAULT_REMEMBER_PASSPHRASE);
    outcome.present = "pass";
    await replaceInput(webdriver, control, VAULT_REMEMBER_PASSPHRASE, OWNED_RECOVERY_PASSPHRASE);
    outcome.invoke = "pass";
    await waitForInput(webdriver, VAULT_REMEMBER_PASSPHRASE, OWNED_RECOVERY_PASSPHRASE);
    const status = await apiJson(connection, "GET", "/vault/status");
    if (status.unlocked !== true || status.recoveryConfirmed !== true || status.rememberedDeviceEnabled !== false) {
      throw new Error("remembered-device passphrase draft changed the disposable Vault backend state");
    }
    outcome.effect = "pass";
    outcome.observedEffect = "Native WebDriver text entry changed only the remembered-device passphrase draft while the disposable Vault remained unlocked and device remembering stayed disabled.";
  } catch (error) {
    outcome.error = errorText(error);
  } finally {
    await cleanupStep(outcome, async () => {
      const control = await visibleElement(webdriver, VAULT_REMEMBER_PASSPHRASE);
      if (control) await clearReleaseSurfaceWebDriverElement(webdriver, control);
      await resetDisposableVault(connection);
    });
    await cleanupOwner(connection, webdriver, outcome, baselineStorage);
  }
  return finalize(outcome);
}

async function exerciseRememberDeviceEnable(
  connection: Connection,
  webdriver: WebDriver,
  assignment: Assignment,
): Promise<ReleaseSurfaceDriverOutcome> {
  const outcome = emptyOutcome(assignment, "No native remembered-device enable effect was observed.");
  let baselineStorage: string | null | undefined;
  try {
    baselineStorage = await readSettingsStorage(connection, webdriver);
    await prepareConfiguredUnlockedVault(connection, webdriver);
    await replaceInput(
      webdriver,
      await waitForReleaseSurfaceWebDriverElement(webdriver, VAULT_REMEMBER_PASSPHRASE),
      VAULT_REMEMBER_PASSPHRASE,
      OWNED_RECOVERY_PASSPHRASE,
    );
    const control = await waitForReleaseSurfaceWebDriverElement(webdriver, VAULT_REMEMBER_DEVICE_ENABLE);
    outcome.present = "pass";
    await clickReleaseSurfaceWebDriverElement(webdriver, control);
    outcome.invoke = "pass";
    await waitForReleaseSurfaceWebDriverElement(webdriver, VAULT_FORGET_DEVICE);
    await waitForReleaseSurfaceWebDriverElementAbsent(webdriver, VAULT_REMEMBER_DEVICE_ENABLE);
    const status = await apiJson(connection, "GET", "/vault/status");
    if (status.mode !== "local" || status.unlocked !== true || status.recoveryConfirmed !== true
      || status.rememberedDeviceEnabled !== true) {
      throw new Error("remember-device enable did not reach the exact configured remembered state");
    }
    outcome.effect = "pass";
    outcome.observedEffect = "Native WebDriver input enabled remembered-device credentials only inside the disposable Vault namespace, replaced the enable form with the Forget action, and proved the exact configured, unlocked, remembered backend state.";
  } catch (error) {
    outcome.error = errorText(error);
  } finally {
    await cleanupStep(outcome, async () => {
      const control = await visibleElement(webdriver, VAULT_REMEMBER_PASSPHRASE);
      if (control) await clearReleaseSurfaceWebDriverElement(webdriver, control);
      await resetDisposableVault(connection);
    });
    await cleanupOwner(connection, webdriver, outcome, baselineStorage);
  }
  return finalize(outcome);
}

async function exerciseForgetDevice(
  connection: Connection,
  webdriver: WebDriver,
  assignment: Assignment,
): Promise<ReleaseSurfaceDriverOutcome> {
  const outcome = emptyOutcome(assignment, "No native remembered-device removal effect was observed.");
  let baselineStorage: string | null | undefined;
  try {
    baselineStorage = await readSettingsStorage(connection, webdriver);
    await prepareConfiguredUnlockedVault(connection, webdriver);
    await replaceInput(
      webdriver,
      await waitForReleaseSurfaceWebDriverElement(webdriver, VAULT_REMEMBER_PASSPHRASE),
      VAULT_REMEMBER_PASSPHRASE,
      OWNED_RECOVERY_PASSPHRASE,
    );
    await clickSelector(webdriver, VAULT_REMEMBER_DEVICE_ENABLE);
    const control = await waitForReleaseSurfaceWebDriverElement(webdriver, VAULT_FORGET_DEVICE);
    const remembered = await apiJson(connection, "GET", "/vault/status");
    if (remembered.rememberedDeviceEnabled !== true) {
      throw new Error("Forget-device fixture did not begin from the exact remembered state");
    }
    outcome.present = "pass";
    await clickReleaseSurfaceWebDriverElement(webdriver, control);
    outcome.invoke = "pass";
    await waitForReleaseSurfaceWebDriverElement(webdriver, VAULT_REMEMBER_DEVICE_ENABLE);
    await waitForReleaseSurfaceWebDriverElementAbsent(webdriver, VAULT_FORGET_DEVICE);
    const status = await apiJson(connection, "GET", "/vault/status");
    if (status.mode !== "local" || status.unlocked !== true || status.recoveryConfirmed !== true
      || status.rememberedDeviceEnabled !== false) {
      throw new Error("Forget device did not restore the exact configured non-remembered state");
    }
    outcome.effect = "pass";
    outcome.observedEffect = "Native WebDriver input removed remembered-device credentials only from the disposable Vault namespace, restored the enable form, and proved the exact configured, unlocked, non-remembered backend state.";
  } catch (error) {
    outcome.error = errorText(error);
  } finally {
    await cleanupStep(outcome, async () => {
      const control = await visibleElement(webdriver, VAULT_REMEMBER_PASSPHRASE);
      if (control) await clearReleaseSurfaceWebDriverElement(webdriver, control);
      await resetDisposableVault(connection);
    });
    await cleanupOwner(connection, webdriver, outcome, baselineStorage);
  }
  return finalize(outcome);
}

async function prepareConfiguredUnlockedVault(
  connection: Connection,
  webdriver: WebDriver,
): Promise<void> {
  await prepareRecoveryChallenge(connection, webdriver);
  await clickSelector(webdriver, VAULT_RECOVERY_CREATE);
  await waitForReleaseSurfaceWebDriverElement(webdriver, VAULT_RECOVERY_COPY);
  await clickSelector(webdriver, VAULT_RECOVERY_CONFIRM);
  await waitForReleaseSurfaceWebDriverElement(webdriver, VAULT_CONFIGURED_SUMMARY);
  const status = await apiJson(connection, "GET", "/vault/status");
  if (status.mode !== "local" || status.unlocked !== true || status.recoveryConfirmed !== true
    || status.rememberedDeviceEnabled !== false) {
    throw new Error("disposable Vault did not reach the exact configured unlocked non-remembered state");
  }
}

async function exerciseGrantsRefresh(
  connection: Connection,
  webdriver: WebDriver,
  assignment: Assignment,
): Promise<ReleaseSurfaceDriverOutcome> {
  const outcome = emptyOutcome(assignment, "No native owned Vault grants refresh effect was observed.");
  let baselineStorage: string | null | undefined;
  try {
    baselineStorage = await readSettingsStorage(connection, webdriver);
    await resetDisposableVaultAndVerifyGrants(connection);
    const first = await seedOwnedGrant(
      connection,
      "release-ui/grants-refresh-a",
      OWNED_GRANT_SECRET_VALUE_A,
    );
    await openVaultGrants(connection, webdriver);
    await waitForGrantRows(webdriver, [first.secretRef]);
    const second = await seedOwnedGrant(
      connection,
      "release-ui/grants-refresh-b",
      OWNED_GRANT_SECRET_VALUE_B,
    );
    await requireOwnedGrantDirectory(connection, [first, second]);
    await requireGrantRows(webdriver, [first.secretRef]);
    const control = await waitForReleaseSurfaceWebDriverElement(webdriver, VAULT_GRANTS_REFRESH);
    outcome.present = "pass";
    await clickReleaseSurfaceWebDriverElement(webdriver, control);
    outcome.invoke = "pass";
    await waitForGrantRows(webdriver, [first.secretRef, second.secretRef]);
    await requireOwnedGrantDirectory(connection, [first, second]);
    outcome.effect = "pass";
    outcome.observedEffect = "Native WebDriver input refreshed the disposable Vault grants ledger from one rendered owned grant to the exact two-grant backend state without reading either synthetic secret value.";
  } catch (error) {
    outcome.error = errorText(error);
  } finally {
    await cleanupStep(outcome, () => resetDisposableVaultAndVerifyGrants(connection));
    await cleanupOwner(connection, webdriver, outcome, baselineStorage, true);
  }
  return finalize(outcome);
}

async function exerciseGrantRevoke(
  connection: Connection,
  webdriver: WebDriver,
  assignment: Assignment,
): Promise<ReleaseSurfaceDriverOutcome> {
  const outcome = emptyOutcome(assignment, "No native owned Vault grant revoke effect was observed.");
  let baselineStorage: string | null | undefined;
  try {
    baselineStorage = await readSettingsStorage(connection, webdriver);
    await resetDisposableVaultAndVerifyGrants(connection);
    const owned = await seedOwnedGrant(
      connection,
      "release-ui/grant-revoke",
      OWNED_GRANT_SECRET_VALUE_A,
    );
    await openVaultGrants(connection, webdriver);
    await waitForGrantRows(webdriver, [owned.secretRef]);
    const control = await waitForReleaseSurfaceWebDriverElement(webdriver, VAULT_GRANT_REVOKE);
    outcome.present = "pass";
    await clickReleaseSurfaceWebDriverElement(webdriver, control);
    outcome.invoke = "pass";
    await waitForGrantRows(webdriver, []);
    const rows = await readGrantDirectory(connection, [owned.secretValue]);
    const revoked = rows.find((row) => row.grantId === owned.grantId);
    if (!revoked || revoked.secretRef !== owned.secretRef || revoked.approved !== true || revoked.revoked !== true) {
      throw new Error("native Vault grant revoke did not reach the exact revoked metadata state");
    }
    outcome.effect = "pass";
    outcome.observedEffect = "Native WebDriver input revoked exactly one approved grant in the guarded disposable Vault, removed its active renderer row, and never read the synthetic secret value.";
  } catch (error) {
    outcome.error = errorText(error);
  } finally {
    await cleanupStep(outcome, () => resetDisposableVaultAndVerifyGrants(connection));
    await cleanupOwner(connection, webdriver, outcome, baselineStorage, true);
  }
  return finalize(outcome);
}

async function openVaultGrants(connection: Connection, webdriver: WebDriver): Promise<void> {
  await postUi(connection, { openModal: "settings", source: "final-surface-owned-vault-grants" });
  await waitForReleaseSurfaceWebDriverElement(webdriver, SETTINGS_DIALOG);
  await clickSelector(webdriver, SETTINGS_VAULT_TAB);
  await waitForReleaseSurfaceWebDriverElement(webdriver, `${SETTINGS_VAULT_TAB}[aria-selected='true']`);
  await clickSelector(webdriver, VAULT_GRANTS_TAB);
  await waitForReleaseSurfaceWebDriverElement(webdriver, VAULT_GRANTS_PANEL);
}

async function seedOwnedGrant(
  connection: Connection,
  secretRef: string,
  secretValue: string,
): Promise<OwnedVaultGrant> {
  const seeded = await apiJson(connection, "POST", "/vault/e2e/seed-secret", { secretRef, value: secretValue });
  assertNoOwnedSecretLeak(seeded, [secretValue], "Vault grant seed");
  if (seeded.ok !== true || seeded.secretRef !== secretRef || seeded.secretPresent !== true
    || seeded.secretExposed !== false) {
    throw new Error("owned Vault grant seed did not return its exact redacted contract");
  }
  const approved = await apiJson(connection, "POST", "/vault/e2e/approve-grant", {
    secretRef,
    actorScope: { kind: "allShellxAgents" },
    operation: "fill",
    origin: "https://example.com",
    expiresAtMs: Date.now() + 10 * 60_000,
  });
  assertNoOwnedSecretLeak(approved, [secretValue], "Vault grant approval");
  const grant = record(approved.grant);
  if (approved.ok !== true || approved.secretExposed !== false
    || typeof grant.grantId !== "string" || !grant.grantId
    || grant.secretRef !== secretRef || grant.approved !== true || grant.revoked !== false
    || grant.origin !== "https://example.com" || grant.operation !== "Fill") {
    throw new Error("owned Vault grant approval did not return its exact active metadata row");
  }
  return { grantId: grant.grantId, secretRef, secretValue };
}

async function readGrantDirectory(
  connection: Connection,
  excludedValues: readonly string[],
): Promise<Array<Record<string, unknown>>> {
  const directory = await apiJson(connection, "GET", "/vault/grants");
  assertNoOwnedSecretLeak(directory, excludedValues, "Vault grant directory");
  if (!Array.isArray(directory.grants)) throw new Error("Vault grant directory omitted its metadata rows");
  return directory.grants.map((row) => record(row));
}

async function requireOwnedGrantDirectory(
  connection: Connection,
  expected: readonly OwnedVaultGrant[],
): Promise<void> {
  const rows = await readGrantDirectory(connection, expected.map((grant) => grant.secretValue));
  if (rows.length !== expected.length || expected.some((grant) => !rows.some((row) => (
    row.grantId === grant.grantId && row.secretRef === grant.secretRef
      && row.approved === true && row.revoked === false
  )))) {
    throw new Error("Vault grant directory did not match the exact owned active metadata set");
  }
}

async function readGrantRows(
  webdriver: WebDriver,
): Promise<{ rowCount: number; revokePresent: boolean }> {
  const state = await observeReleaseSurfaceInstalledInputElement(webdriver, VAULT_GRANTS_PANEL, ["title"]);
  const match = state.title?.match(/^Vault grants state: active=(\d+); revocable=(yes|no)$/);
  if (!state.present || !state.visible || !match) {
    throw new Error("Vault grants renderer omitted its bounded metadata-only state receipt");
  }
  const rowCount = Number(match[1]);
  const revokePresent = match[2] === "yes";
  if (!Number.isSafeInteger(rowCount) || rowCount < 0 || revokePresent !== (rowCount > 0)) {
    throw new Error("Vault grants renderer returned an inconsistent bounded state receipt");
  }
  return {
    rowCount,
    revokePresent,
  };
}

async function requireGrantRows(webdriver: WebDriver, secretRefs: readonly string[]): Promise<void> {
  const state = await readGrantRows(webdriver);
  if (state.rowCount !== secretRefs.length || state.revokePresent !== (secretRefs.length > 0)) {
    throw new Error("Vault grants renderer did not match the exact isolated owned row count");
  }
}

async function waitForGrantRows(webdriver: WebDriver, secretRefs: readonly string[]): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      await requireGrantRows(webdriver, secretRefs);
      return;
    } catch {
      await delay(50);
    }
  }
  throw new Error(`Vault grants renderer did not reach ${secretRefs.length} owned rows`);
}

async function resetDisposableVaultAndVerifyGrants(connection: Connection): Promise<void> {
  await resetDisposableVault(connection);
  const rows = await readGrantDirectory(connection, [OWNED_GRANT_SECRET_VALUE_A, OWNED_GRANT_SECRET_VALUE_B]);
  if (rows.length !== 0) throw new Error("disposable Vault reset retained owned grant metadata");
}

function assertNoOwnedSecretLeak(value: unknown, secretValues: readonly string[], label: string): void {
  const serialized = JSON.stringify(value);
  if (secretValues.some((secretValue) => serialized.includes(secretValue))) {
    throw new Error(`${label} exposed a synthetic secret value`);
  }
}

async function exerciseWorkspaceLock(
  connection: Connection,
  webdriver: WebDriver,
  assignment: Assignment,
): Promise<ReleaseSurfaceDriverOutcome> {
  const outcome = emptyOutcome(assignment, "No native Vault workspace lock effect was observed.");
  let baselineStorage: string | null | undefined;
  try {
    baselineStorage = await readSettingsStorage(connection, webdriver);
    await prepareVaultWorkspace(connection, webdriver, false);
    const control = await waitForReleaseSurfaceWebDriverElement(webdriver, VAULT_WORKSPACE_LOCK);
    outcome.present = "pass";
    await clickReleaseSurfaceWebDriverElement(webdriver, control);
    outcome.invoke = "pass";
    await waitForReleaseSurfaceWebDriverElement(webdriver, VAULT_WORKSPACE_QUICK_UNLOCK);
    const status = await apiJson(connection, "GET", "/vault/status");
    if (status.unlocked !== false || status.recoveryConfirmed !== true || status.rememberedDeviceEnabled !== false) {
      throw new Error("native workspace lock did not reach the exact locked non-remembered state");
    }
    outcome.effect = "pass";
    outcome.observedEffect = "Native WebDriver input locked the configured disposable Vault workspace and exposed its quick-unlock form without enabling device remembering.";
  } catch (error) {
    outcome.error = errorText(error);
  } finally {
    await cleanupStep(outcome, () => resetDisposableVault(connection));
    await cleanupOwner(connection, webdriver, outcome, baselineStorage, true);
  }
  return finalize(outcome);
}

async function exerciseWorkspacePassphrase(
  connection: Connection,
  webdriver: WebDriver,
  assignment: Assignment,
): Promise<ReleaseSurfaceDriverOutcome> {
  const outcome = emptyOutcome(assignment, "No native Vault workspace passphrase entry was observed.");
  let baselineStorage: string | null | undefined;
  try {
    baselineStorage = await readSettingsStorage(connection, webdriver);
    await prepareVaultWorkspace(connection, webdriver, true);
    const control = await waitForReleaseSurfaceWebDriverElement(webdriver, VAULT_WORKSPACE_PASSPHRASE);
    outcome.present = "pass";
    await replaceInput(webdriver, control, VAULT_WORKSPACE_PASSPHRASE, OWNED_RECOVERY_PASSPHRASE);
    outcome.invoke = "pass";
    await waitForInput(webdriver, VAULT_WORKSPACE_PASSPHRASE, OWNED_RECOVERY_PASSPHRASE);
    const status = await apiJson(connection, "GET", "/vault/status");
    if (status.unlocked !== false || status.recoveryConfirmed !== true) {
      throw new Error("workspace passphrase entry changed the locked Vault backend state");
    }
    outcome.effect = "pass";
    outcome.observedEffect = "Native WebDriver text entry changed only the locked Vault workspace passphrase draft while the disposable backend remained configured and locked.";
  } catch (error) {
    outcome.error = errorText(error);
  } finally {
    await cleanupStep(outcome, async () => {
      const control = await visibleElement(webdriver, VAULT_WORKSPACE_PASSPHRASE);
      if (control) await clearReleaseSurfaceWebDriverElement(webdriver, control);
      await resetDisposableVault(connection);
    });
    await cleanupOwner(connection, webdriver, outcome, baselineStorage, true);
  }
  return finalize(outcome);
}

async function exerciseWorkspaceUnlock(
  connection: Connection,
  webdriver: WebDriver,
  assignment: Assignment,
): Promise<ReleaseSurfaceDriverOutcome> {
  const outcome = emptyOutcome(assignment, "No native Vault workspace unlock effect was observed.");
  let baselineStorage: string | null | undefined;
  try {
    baselineStorage = await readSettingsStorage(connection, webdriver);
    await prepareVaultWorkspace(connection, webdriver, true);
    await replaceInput(
      webdriver,
      await waitForReleaseSurfaceWebDriverElement(webdriver, VAULT_WORKSPACE_PASSPHRASE),
      VAULT_WORKSPACE_PASSPHRASE,
      OWNED_RECOVERY_PASSPHRASE,
    );
    const control = await waitForReleaseSurfaceWebDriverElement(webdriver, VAULT_WORKSPACE_UNLOCK);
    outcome.present = "pass";
    await clickReleaseSurfaceWebDriverElement(webdriver, control);
    outcome.invoke = "pass";
    await waitForReleaseSurfaceWebDriverElement(webdriver, VAULT_WORKSPACE_LOCK);
    await waitForReleaseSurfaceWebDriverElementAbsent(webdriver, VAULT_WORKSPACE_QUICK_UNLOCK);
    const status = await apiJson(connection, "GET", "/vault/status");
    if (status.mode !== "local" || status.unlocked !== true || status.recoveryConfirmed !== true
      || status.rememberedDeviceEnabled !== false) {
      throw new Error("native workspace unlock did not reach the exact unlocked non-remembered state");
    }
    outcome.effect = "pass";
    outcome.observedEffect = "Native WebDriver input unlocked the configured disposable Vault workspace without silently enabling remembered-device credentials.";
  } catch (error) {
    outcome.error = errorText(error);
  } finally {
    await cleanupStep(outcome, () => resetDisposableVault(connection));
    await cleanupOwner(connection, webdriver, outcome, baselineStorage, true);
  }
  return finalize(outcome);
}

function textConfig(assignment: Assignment): TextConfig | null {
  const direct = textConfigs.get(assignment.surface.name);
  if (direct) return direct;
  if (assignment.surface.name !== descriptionSurface) return null;
  const profile = Number(assignment.surface.line) < 1600;
  return {
    tab: profile ? "profileCard" : "stripeAgentWallet",
    control: "[placeholder='description visible to agents unless marked user-only']",
    value: profile ? "Synthetic profile description" : "Synthetic wallet description",
    label: `unsaved ${profile ? "profile" : "wallet"} description`,
  };
}

async function exerciseText(
  connection: Connection,
  webdriver: WebDriver,
  assignment: Assignment,
  config: TextConfig,
): Promise<ReleaseSurfaceDriverOutcome> {
  const outcome = emptyOutcome(assignment, "No native unsaved Vault draft text effect was observed.");
  let baselineStorage: string | null | undefined;
  let baselineWasEmpty = false;
  let baselineSetupMode: string | null = null;
  try {
    baselineStorage = await readSettingsStorage(connection, webdriver);
    baselineSetupMode = await openVaultDraft(connection, webdriver, config);
    const control = await waitForReleaseSurfaceWebDriverElement(webdriver, config.control);
    if (await readInputNonempty(webdriver, config.control)) {
      throw new Error(`${config.label} did not start from the isolated empty draft baseline`);
    }
    baselineWasEmpty = true;
    outcome.present = "pass";
    await replaceInput(webdriver, control, config.control, config.value);
    outcome.invoke = "pass";
    outcome.effect = "pass";
    outcome.observedEffect = config.setup
      ? `Native WebDriver input changed only the ${config.label}; no Vault setup, save, credential, grant, or permission action was invoked.`
      : `Native WebDriver input changed only the ${config.label}; no Vault save, credential, grant, or permission action was invoked.`;
  } catch (error) {
    outcome.error = errorText(error);
  } finally {
    if (baselineWasEmpty) await cleanupStep(outcome, async () => {
      const control = await waitForReleaseSurfaceWebDriverElement(webdriver, config.control);
      await clearReleaseSurfaceWebDriverElement(webdriver, control);
      await waitForInput(webdriver, config.control, "");
    });
    if (baselineSetupMode) await cleanupStep(outcome, () => setSetupMode(webdriver, baselineSetupMode!));
    await cleanupOwner(connection, webdriver, outcome, baselineStorage);
  }
  return finalize(outcome);
}

async function exerciseChoice(
  connection: Connection,
  webdriver: WebDriver,
  assignment: Assignment,
  config: ChoiceConfig,
): Promise<ReleaseSurfaceDriverOutcome> {
  const outcome = emptyOutcome(assignment, "No native unsaved Vault draft choice effect was observed.");
  let baselineStorage: string | null | undefined;
  let baseline: { checked: boolean | null; value: string | null } | null = null;
  let baselineSetupMode: string | null = null;
  try {
    baselineStorage = await readSettingsStorage(connection, webdriver);
    baselineSetupMode = await openVaultDraft(connection, webdriver, config);
    const control = await waitForReleaseSurfaceWebDriverElement(webdriver, config.control);
    baseline = await readChoice(webdriver, config.control);
    outcome.present = "pass";
    if (config.kind === "checkbox") {
      if (typeof baseline.checked !== "boolean") throw new Error(`${config.label} omitted checkbox state`);
      await clickReleaseSurfaceWebDriverElement(webdriver, control);
      await waitForChoice(webdriver, config.control, { checked: !baseline.checked });
    } else if (config.kind === "select") {
      if (!baseline.value || !config.options) throw new Error(`${config.label} omitted select state`);
      if (!config.options[baseline.value]) throw new Error(`${config.label} exposed an unsupported baseline choice`);
      const alternate = Object.keys(config.options).find((value) => value !== baseline!.value);
      if (!alternate) throw new Error(`${config.label} has no alternate choice`);
      await setReleaseSurfaceWebDriverElementValue(webdriver, control, config.options[alternate]!);
      await waitForChoice(webdriver, config.control, { value: alternate });
    } else if (config.kind === "setup-mode") {
      if (!baseline.value || !config.target) throw new Error(`${config.label} omitted setup-mode state`);
      if (baseline.value === config.target) {
        const alternate = config.target === "local" ? "external" : "local";
        await setSetupMode(webdriver, alternate);
      }
      await clickReleaseSurfaceWebDriverElement(webdriver, control);
      await waitForChoice(webdriver, config.control, { checked: true, value: config.target });
    } else {
      if (!baseline.value || !config.target) throw new Error(`${config.label} omitted pressed-group state`);
      if (baseline.value === config.target) {
        const alternate = ["visible", "userOnly", "toolUseAlways", "browserFillAlways"]
          .find((value) => value !== config.target);
        if (!alternate) throw new Error(`${config.label} has no alternate permission baseline`);
        await clickSelector(webdriver, permissionSelector(alternate));
        await waitForChoice(webdriver, config.control, { checked: false, value: alternate });
      }
      await clickReleaseSurfaceWebDriverElement(webdriver, control);
      await waitForChoice(webdriver, config.control, { checked: true, value: config.target });
    }
    outcome.invoke = "pass";
    outcome.effect = "pass";
    outcome.observedEffect = config.setup
      ? `Native WebDriver changed only the ${config.label}; no Vault setup, save, credential, grant, or permission action was invoked.`
      : config.kind === "pressed-group"
      ? `Native WebDriver changed only the ${config.label}; no Vault save, credential, or grant action was invoked.`
      : `Native WebDriver changed only the ${config.label}; no Vault save, credential, grant, or permission action was invoked.`;
  } catch (error) {
    outcome.error = errorText(error);
  } finally {
    if (baseline) await cleanupStep(outcome, async () => {
      const current = await readChoice(webdriver, config.control);
      const control = await waitForReleaseSurfaceWebDriverElement(webdriver, config.control);
      if (config.kind === "checkbox" && current.checked !== baseline!.checked) {
        await clickReleaseSurfaceWebDriverElement(webdriver, control);
      } else if (config.kind === "select" && current.value !== baseline!.value) {
        await setReleaseSurfaceWebDriverElementValue(webdriver, control, config.options![baseline!.value!]!);
      } else if (config.kind === "setup-mode" && current.value !== baseline!.value) {
        await setSetupMode(webdriver, baseline!.value!);
      } else if (config.kind === "pressed-group" && current.value !== baseline!.value) {
        await clickSelector(webdriver, permissionSelector(baseline!.value!));
      }
      await waitForChoice(webdriver, config.control, baseline!);
    });
    if (baselineSetupMode) await cleanupStep(outcome, () => setSetupMode(webdriver, baselineSetupMode!));
    await cleanupOwner(connection, webdriver, outcome, baselineStorage);
  }
  return finalize(outcome);
}

async function openVaultDraft(
  connection: Connection,
  webdriver: WebDriver,
  config: Pick<TextConfig | ChoiceConfig, "tab" | "setup" | "setupMode">,
): Promise<string | null> {
  await postUi(connection, { openModal: "settings", source: "final-surface-safe-vault-draft" });
  await waitForReleaseSurfaceWebDriverElement(webdriver, SETTINGS_DIALOG);
  await clickSelector(webdriver, SETTINGS_VAULT_TAB);
  await waitForReleaseSurfaceWebDriverElement(webdriver, `${SETTINGS_VAULT_TAB}[aria-selected='true']`);
  if (config.setup) {
    await clickSelector(webdriver, VAULT_SETUP_TAB);
    const baseline = (await readChoice(webdriver, VAULT_SETUP_MODE_LOCAL)).value;
    if (!baseline) throw new Error("Vault setup mode omitted its baseline state");
    if (config.setupMode) await setSetupMode(webdriver, config.setupMode);
    return baseline;
  }
  const tab = config.tab;
  if (!tab) throw new Error("Vault resource draft omitted its form tab");
  await clickSelector(webdriver, VAULT_SECRETS_TAB);
  await clickSelector(webdriver, resourceTabSelector(tab));
  await waitForReleaseSurfaceWebDriverElement(
    webdriver,
    `${resourceTabSelector(tab)}.active[aria-selected='true']`,
  );
  return null;
}

async function cleanupOwner(
  connection: Connection,
  webdriver: WebDriver,
  outcome: ReleaseSurfaceDriverOutcome,
  baselineStorage: string | null | undefined,
  restoreVaultWorkspace = false,
): Promise<void> {
  await cleanupStep(outcome, async () => {
    const restoreTab = validSettingsTab(baselineStorage) ? baselineStorage : "general";
    if (!await visibleElement(webdriver, SETTINGS_DIALOG)) {
      await postUi(connection, { openModal: "settings", source: "final-surface-safe-vault-owner-restore" });
      await waitForReleaseSurfaceWebDriverElement(webdriver, SETTINGS_DIALOG);
    }
    if (restoreVaultWorkspace) {
      await clickSelector(webdriver, SETTINGS_VAULT_TAB);
      await waitForReleaseSurfaceWebDriverElement(webdriver, `${SETTINGS_VAULT_TAB}[aria-selected='true']`);
      await clickSelector(webdriver, VAULT_SECRETS_TAB);
    }
    await clickSelector(webdriver, `[data-debug-id='settings-tab-${restoreTab}']`);
    await waitForReleaseSurfaceWebDriverElement(
      webdriver,
      `[data-debug-id='settings-tab-${restoreTab}'][aria-selected='true']`,
    );
    const restored = await readSettingsStorage(connection, webdriver);
    if (restored !== restoreTab) throw new Error("Settings tab persistence was not exactly restored");
    await postUi(connection, { openModal: "close", source: "final-surface-safe-vault-draft-cleanup" });
    await waitForReleaseSurfaceWebDriverElementAbsent(webdriver, SETTINGS_DIALOG);
    await waitForReleaseSurfaceWebDriverElementAbsent(webdriver, VAULT_WORKSPACE_MODAL);
  });
}

async function replaceInput(
  webdriver: WebDriver,
  control: Awaited<ReturnType<typeof waitForReleaseSurfaceWebDriverElement>>,
  selector: string,
  value: string,
): Promise<void> {
  await clearReleaseSurfaceWebDriverElement(webdriver, control);
  if (value) await setReleaseSurfaceWebDriverElementValue(webdriver, control, value);
  await waitForInput(webdriver, selector, value);
}

async function readInputNonempty(webdriver: WebDriver, selector: string): Promise<boolean> {
  const state = await observeReleaseSurfaceInstalledInputElement(webdriver, selector, ["nonempty"]);
  if (typeof state.nonempty !== "boolean") throw new Error(`Vault draft input ${selector} omitted its value-blind state`);
  return state.nonempty;
}

async function waitForInput(webdriver: WebDriver, selector: string, expected: string): Promise<void> {
  const expectedNonempty = expected.length > 0;
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await readInputNonempty(webdriver, selector) === expectedNonempty) return;
    await delay(50);
  }
  throw new Error(`Vault draft input ${selector} did not reach expected value-blind state`);
}

async function readChoice(
  webdriver: WebDriver,
  selector: string,
): Promise<{ checked: boolean | null; value: string | null }> {
  if (selector === VAULT_SETUP_MODE_LOCAL || selector === VAULT_SETUP_MODE_EXTERNAL) {
    const value = await selectedPressedChoice(webdriver, [
      ["local", VAULT_SETUP_MODE_LOCAL],
      ["external", VAULT_SETUP_MODE_EXTERNAL],
    ]);
    return { checked: value === (selector === VAULT_SETUP_MODE_LOCAL ? "local" : "external"), value };
  }
  if (selector.startsWith("[data-debug-id='vault-permission-")) {
    const value = await selectedPressedChoice(webdriver, [
      ["visible", permissionSelector("visible")],
      ["userOnly", permissionSelector("userOnly")],
      ["toolUseAlways", permissionSelector("toolUseAlways")],
      ["browserFillAlways", permissionSelector("browserFillAlways")],
    ]);
    const target = selector.slice("[data-debug-id='vault-permission-".length, -2);
    return { checked: value === target, value };
  }
  const checked = await optionalObservation(webdriver, selector, "checked");
  if (typeof checked === "boolean") return { checked, value: null };
  const value = await optionalObservation(webdriver, selector, "value");
  return { checked: null, value: typeof value === "string" ? value : null };
}

async function selectedPressedChoice(
  webdriver: WebDriver,
  choices: readonly (readonly [string, string])[],
): Promise<string> {
  const selected: string[] = [];
  for (const [value, selector] of choices) {
    if (await optionalObservation(webdriver, selector, "pressed") === true) selected.push(value);
  }
  if (selected.length !== 1) throw new Error(`Vault choice group exposed ${selected.length} selected controls`);
  return selected[0]!;
}

async function optionalObservation(
  webdriver: WebDriver,
  selector: string,
  field: "checked" | "pressed" | "selected" | "value",
): Promise<boolean | string | undefined> {
  try {
    const state = await observeReleaseSurfaceInstalledInputElement(webdriver, selector, [field]);
    return state[field];
  } catch (error) {
    if (errorText(error).includes(`omitted its declared ${field} field`)) return undefined;
    throw error;
  }
}

async function waitForChoice(
  webdriver: WebDriver,
  selector: string,
  expected: { checked?: boolean | null; value?: string | null },
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const state = await readChoice(webdriver, selector);
    if ((expected.checked === undefined || state.checked === expected.checked)
      && (expected.value === undefined || state.value === expected.value)) return;
    await delay(50);
  }
  throw new Error(`Vault draft choice ${selector} did not reach ${JSON.stringify(expected)}`);
}

async function readSettingsStorage(connection: Connection, webdriver: WebDriver): Promise<string | null> {
  if (!await visibleElement(webdriver, SETTINGS_DIALOG)) {
    await postUi(connection, { openModal: "settings", source: "final-surface-safe-vault-baseline" });
    await waitForReleaseSurfaceWebDriverElement(webdriver, SETTINGS_DIALOG);
  }
  const selected: string[] = [];
  for (const tab of SETTINGS_TABS) {
    const state = await observeReleaseSurfaceInstalledInputElement(
      webdriver,
      `[data-debug-id='settings-tab-${tab}']`,
      ["selected"],
    );
    if (state.selected === true) selected.push(tab);
  }
  if (selected.length !== 1) throw new Error(`Settings tab state exposed ${selected.length} selected controls`);
  return selected[0]!;
}

function resourceTabSelector(tab: VaultFormTab): string {
  return `[data-debug-id='vault-resource-form-tab-${tab}']`;
}

function permissionSelector(level: string): string {
  if (!["visible", "userOnly", "toolUseAlways", "browserFillAlways"].includes(level)) {
    throw new Error(`unsupported Vault permission level ${level}`);
  }
  return `[data-debug-id='vault-permission-${level}']`;
}

function setupModeSelector(mode: string): string {
  if (mode === "local") return VAULT_SETUP_MODE_LOCAL;
  if (mode === "external") return VAULT_SETUP_MODE_EXTERNAL;
  throw new Error(`unsupported Vault setup mode ${mode}`);
}

async function setSetupMode(webdriver: WebDriver, mode: string): Promise<void> {
  const selector = setupModeSelector(mode);
  const state = await readChoice(webdriver, selector);
  if (state.value !== mode) await clickSelector(webdriver, selector);
  await waitForChoice(webdriver, selector, { checked: true, value: mode });
}

function validSettingsTab(value: string | null | undefined): value is string {
  return SETTINGS_TABS.includes((value ?? "") as typeof SETTINGS_TABS[number]);
}

function surface(selector: string): string {
  return `src/components/settings/VaultTab.tsx:${selector}`;
}

function setupSurface(selector: string): string {
  return `src/components/settings/VaultSetupPanel.tsx:${selector}`;
}

function grantsSurface(selector: string): string {
  return `src/components/settings/VaultGrantsPanel.tsx:${selector}`;
}

async function clickSelector(webdriver: WebDriver, selector: string): Promise<void> {
  await clickReleaseSurfaceWebDriverElement(
    webdriver,
    await waitForReleaseSurfaceWebDriverElement(webdriver, selector),
  );
}

async function visibleElement(webdriver: WebDriver, selector: string) {
  try {
    return await waitForReleaseSurfaceWebDriverElement(webdriver, selector, { timeoutMs: 250, pollMs: 50 });
  } catch {
    return null;
  }
}

async function postUi(connection: Connection, body: Record<string, unknown>): Promise<void> {
  const response = await fetch(`${connection.base}/state/ui`, {
    method: "POST",
    headers: { Authorization: `Bearer ${connection.token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(3_000),
  });
  if (!response.ok) throw new Error(`POST /state/ui failed ${response.status}: ${await response.text()}`);
}

async function apiJson(
  connection: Connection,
  method: "GET" | "POST",
  path: string,
  body?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await fetch(`${connection.base}${path}`, {
    method,
    headers: { Authorization: `Bearer ${connection.token}`, "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`${method} ${path} failed ${response.status}: ${await response.text()}`);
  const value = await response.json();
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${method} ${path} returned invalid JSON`);
  return value as Record<string, unknown>;
}

async function resetDisposableVault(connection: Connection): Promise<void> {
  await apiJson(connection, "POST", "/vault/e2e/reset", {});
  const status = await apiJson(connection, "GET", "/vault/status");
  if (status.mode !== "unconfigured" || status.unlocked !== false || status.recoveryConfirmed !== false) {
    throw new Error("disposable Vault reset did not restore its exact unconfigured status");
  }
}

function emptyOutcome(assignment: Assignment, observedEffect: string): ReleaseSurfaceDriverOutcome {
  return {
    id: assignment.surface.id,
    expectedEffect: assignment.expectedEffect,
    oracleId: assignment.oracleId,
    present: "fail",
    invoke: "fail",
    effect: "fail",
    cleanup: "fail",
    observedEffect,
  };
}

async function cleanupStep(outcome: ReleaseSurfaceDriverOutcome, action: () => Promise<void>): Promise<void> {
  try {
    await action();
    if (!outcome.error?.includes("cleanup:")) outcome.cleanup = "pass";
  } catch (error) {
    const detail = errorText(error);
    outcome.cleanup = "fail";
    outcome.error = outcome.error ? `${outcome.error}; cleanup: ${detail}` : `cleanup: ${detail}`;
  }
}

function finalize(outcome: ReleaseSurfaceDriverOutcome): ReleaseSurfaceDriverOutcome {
  if ([outcome.present, outcome.invoke, outcome.effect, outcome.cleanup].includes("fail") && !outcome.error) {
    outcome.error = "safe Vault draft control did not satisfy every required verdict";
  }
  return outcome;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("WebDriver state must be an object");
  return value as Record<string, unknown>;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
