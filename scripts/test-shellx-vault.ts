import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { strict as assert } from "node:assert";
import { readRustModuleFamily } from "./read-rust-module-family";
import { buildBrowserVaultFillCandidates } from "../src/browser/vaultFillCandidates";

const root = process.cwd();

const mustContain: Array<[string, string]> = [
  ["src-tauri/src/debug_api.rs", "/vault/setup/begin"],
  ["src-tauri/src/debug_api.rs", "/vault/setup/confirm-recovery"],
  ["src-tauri/src/debug_api.rs", "/vault/remember-device"],
  ["src-tauri/src/debug_api.rs", "/vault/lock"],
  ["src-tauri/src/debug_api.rs", "vault_lock_http"],
  ["src-tauri/src/debug_api_vault.rs", "shellx:vault-status-invalidated"],
  ["src-tauri/src/debug_api_vault.rs", "import_legacy"],
  ["src-tauri/src/debug_api.rs", "/vault/grants"],
  ["src-tauri/src/debug_api_preview_tools.rs", "raw_secret_reveal_denied"],
  ["src-tauri/src/debug_api.rs", "/vault/e2e/reset"],
  ["src-tauri/src/debug_api_vault.rs", "SHELLX_VAULT_E2E"],
  ["src-tauri/src/debug_api_vault.rs", "vault_e2e_profile_not_isolated"],
  ["src-tauri/src/debug_api.rs", "/vault/e2e/probe-use"],
  ["src-tauri/src/debug_api.rs", "/vault/e2e/audit"],
  ["src-tauri/src/shellx_vault/grants.rs", "GrantActorContext"],
  ["src-tauri/src/shellx_vault/grants.rs", "Connector"],
  ["src-tauri/src/shellx_vault/backend.rs", "authorize_secret_use_for_actor"],
  ["src-tauri/src/shellx_vault/backend.rs", "debug_probe_secret_use"],
  ["src-tauri/src/shellx_vault/backend.rs", "grantActorMismatch"],
  ["src-tauri/src/shellx_vault/backend.rs", "grantUserOnlySecret"],
  ["src-tauri/src/shellx_vault/backend.rs", "default_profile_dir"],
  ["src-tauri/src/shellx_vault/backend.rs", "migrate_legacy_profile_dir"],
  ["src-tauri/src/shellx_vault/backend.rs", "load_persisted_profile_status"],
  ["src-tauri/src/shellx_vault/backend.rs", "debug_require_isolated_e2e_profile"],
  ["src-tauri/src/shellx_vault/backend.rs", "SHELLX_VAULT_PROFILE_DIR"],
  ["src-tauri/src/shellx_vault/backend.rs", "UnlockRequest"],
  ["src-tauri/src/shellx_vault/backend.rs", "remembered_keyfile_json"],
  ["src-tauri/src/shellx_vault/backend.rs", "unlock_with_remembered_device_if_available"],
  ["src-tauri/src/shellx_vault/backend.rs", "remembered_device_keyfile_json"],
  ["src-tauri/src/shellx_vault/backend.rs", "read_persisted_grants"],
  ["src-tauri/src/shellx_vault/backend.rs", "write_grants_snapshot"],
  ["src-tauri/src/shellx_vault/backend.rs", "always_grants_survive_backend_restart_and_revocation"],
  ["src-tauri/src/shellx_vault/backend.rs", "legacy_persisted_grants_without_approval_default_pending"],
  ["src-tauri/src/shellx_vault/grants.rs", "created_at_ms"],
  ["src/lib/vault-request-center.ts", "grant.createdAtMs"],
  ["src-tauri/src/shellx_vault/backend.rs", "persisted_local_profile_unlocks_after_restart"],
  ["src-tauri/src/shellx_vault/backend.rs", "USERPROFILE"],
  ["src-tauri/src/shellx_vault/backend.rs", "ShellxVaultKeyMeta"],
  ["src-tauri/src/shellx_vault/backend.rs", "VaultResourceKind"],
  ["src-tauri/src/shellx_vault/backend.rs", "ProfileCard"],
  ["src-tauri/src/shellx_vault/backend.rs", "EmailInbox"],
  ["src-tauri/src/shellx_vault/backend.rs", "StripeAgentWallet"],
  ["src-tauri/src/shellx_vault/backend.rs", "resource_kind"],
  ["src-tauri/src/shellx_vault/backend.rs", "compat_list_resources_with_meta"],
  ["src-tauri/src/shellx_vault/backend.rs", "compat_list_agent_visible_resources_with_meta"],
  ["src-tauri/src/shellx_vault/backend.rs", "compat_update_description"],
  ["src-tauri/src/shellx_vault/backend.rs", "compat_list_agent_visible_keys_with_meta"],
  ["src-tauri/src/shellx_vault/backend.rs", "user_only"],
  ["src-tauri/src/debug_api.rs", "/vault/resources"],
  ["src-tauri/src/debug_api.rs", "vault_resources_http"],
  ["src-tauri/src/debug_api_vault.rs", "\"entries\": entries"],
  ["src-tauri/src/lib.rs", "vault_list_resources"],
  ["src-tauri/src/lib.rs", "vault_update_resource_metadata"],
  ["src-tauri/src/lib.rs", "shellx_vault_begin_setup"],
  ["src-tauri/src/lib.rs", "shellx_vault_unlock"],
  ["src-tauri/src/lib.rs", "shellx_vault_lock"],
  ["src-tauri/src/lib.rs", "shellx_vault_set_remembered_device_enabled"],
  ["src-tauri/src/lib.rs", "shellx_vault_list_grants"],
  ["src-tauri/src/lib.rs", "shellx_vault_approve_grant"],
  ["src-tauri/src/lib.rs", "description: Option<String>"],
  ["src-tauri/src/lib.rs", "vault_update_metadata"],
  ["src-tauri/src/host_mcp/vault_tools.rs", "vault_generate"],
  ["src-tauri/src/host_mcp/vault_tools.rs", "generateAndStore"],
  ["src-tauri/src/host_mcp/vault_tools.rs", "VAULT_GENERATE_ITEM_EXISTS"],
  ["src-tauri/src/shellx_vault/backend.rs", "compat_create_with_description"],
  ["src-tauri/src/host_mcp.rs", '"vault_generate"'],
  ["src-tauri/src/host_mcp/vault_tools.rs", "vault_deposit"],
  ["src-tauri/src/host_mcp/tool_specs_core.rs", "The caller must POST the captured secretValue"],
  ["src-tauri/src/host_mcp/browser_specs.rs", "browser_fill_from_vault"],
  ["src-tauri/src/host_mcp/tool_specs_core.rs", "\"name\": \"vault_list\""],
  ["src-tauri/src/host_mcp/tool_specs_core.rs", "\"name\": \"vault_list_grants\""],
  ["src-tauri/src/host_mcp/tool_specs_core.rs", "\"name\": \"vault_request_grant\""],
  ["src-tauri/src/host_mcp/vault_tools.rs", "pendingOperatorApproval"],
  ["src-tauri/src/host_mcp/vault_tools.rs", "refuses rawReveal"],
  ["src-tauri/src/host_mcp/vault_tools.rs", "agentVisibleOnly"],
  ["src-tauri/src/shellx_browser_vault.rs", "browserVaultCredentialFilled"],
  ["src-tauri/src/shellx_browser_vault.rs", "shellx_browser_fill_user_vault_secret"],
  ["src-tauri/src/shellx_browser_vault.rs", "BrowserUserVaultFillRequest"],
  ["src-tauri/src/shellx_browser_vault.rs", "insecureCredentialEntryApproval"],
  ["src-tauri/src/lib.rs", "shellx_browser_fill_user_vault_secret"],
  ["src/browser/api.ts", "fillUserVaultSecret"],
  ["src/browser/api.ts", "vault_list_keys_with_meta"],
  ["src/browser/components/BrowserChrome.tsx", "shellx-browser-vault-fill-menu"],
  ["src/browser/components/BrowserVaultFillPanel.tsx", "shellx-browser-vault-fill-suggestion"],
  ["src/browser/hooks/useBrowserVaultFill.ts", "Vault fill requires a direct user click."],
  ["src/browser/vaultFillCandidates.ts", "buildBrowserVaultFillCandidates"],
  ["src/browser/hooks/useBrowserVaultFill.ts", "observationRefresh"],
  ["scripts/test-shellx-browser-debug-api.ts", "Vault approved fill grant authorizes Browser agent actor"],
  ["scripts/test-shellx-browser-debug-api.ts", "approved Vault fill still blocks on local HTTP credential page"],
  ["scripts/test-shellx-browser-debug-api.ts", "Vault user-only secret refuses agent grant approval"],
  ["src-tauri/src/shellx_browser_vault.rs", "prepare_vault_grant_fill_action"],
  ["src-tauri/src/debug_api_browser_action.rs", "fillFromVaultGrant"],
  ["src-tauri/src/debug_api_browser_security.rs", "authorize_secret_use_for_actor"],
  ["src/components/VaultPanel.tsx", "vault-workspace-lock-status"],
  ["src/components/VaultPanel.tsx", "data-debug-id=\"vault-workspace-lock\""],
  ["src/components/VaultPanel.tsx", "vault-workspace-quick-unlock"],
  ["src/components/VaultPanel.tsx", "shellx_vault_lock"],
  ["src/components/VaultPanel.tsx", "shellx:vault-status-invalidated"],
  ["src/components/HeaderVaultRequestCenter.tsx", "vault-open"],
  ["src/components/HeaderVaultRequestCenter.tsx", "vault-closed"],
  ["src/components/HeaderVaultRequestCenter.tsx", "shellx:vault-status-invalidated"],
  ["src/components/VaultPasswordGenerator.tsx", "vault-password-generator"],
  ["src/lib/vault-password-generator.ts", "VAULT_PASSWORD_POCKET_TTL_MS"],
  ["src/components/settings/VaultTab.tsx", "data-debug-id=\"vault-description-input\""],
  ["src/components/settings/VaultTab.tsx", "data-debug-id=\"vault-description-inline\""],
  ["src/components/settings/VaultTab.tsx", "data-debug-id=\"vault-user-only-toggle\""],
  ["src/components/VaultPanel.tsx", "<VaultTab"],
  ["src/components/VaultPanel.tsx", "vault-workspace-modal"],
  ["src/components/VaultPanel.tsx", "ShellX Vault"],
  ["src/components/settings/VaultSetupPanel.tsx", "shellx_vault_begin_setup"],
  ["src/components/settings/VaultSetupPanel.tsx", "shellx_vault_set_remembered_device_enabled"],
  ["src/components/settings/VaultSetupPanel.tsx", "data-debug-id=\"shellx-vault-remember-device-setup\""],
  ["src/components/settings/VaultSetupPanel.tsx", "data-debug-id=\"shellx-vault-remember-device-unlock\""],
  ["src/components/settings/VaultSetupPanel.tsx", "data-debug-id=\"shellx-vault-forget-device\""],
  ["src/components/settings/VaultSetupPanel.tsx", "data-debug-id=\"shellx-vault-setup-mode\""],
  ["src/components/settings/VaultSetupPanel.tsx", "Confirm master passphrase"],
  ["src/components/settings/VaultSetupPanel.tsx", "data-debug-id=\"shellx-vault-master-passphrase\""],
  ["src/components/settings/VaultSetupPanel.tsx", "data-debug-id=\"shellx-vault-confirm-passphrase\""],
  ["src/components/settings/VaultSetupPanel.tsx", "passphrases do not match"],
  ["src/components/settings/VaultSetupPanel.tsx", "copyRecoveryKit"],
  ["src/components/settings/VaultSetupPanel.tsx", "handleKeyfileFile"],
  ["src/components/settings/VaultSetupPanel.tsx", "data-debug-id=\"surface-components-settings-vaultsetuppanel-17\""],
  ["src/components/settings/VaultSetupPanel.tsx", "Use existing keyfile"],
  ["src/components/settings/VaultSetupPanel.tsx", "type=\"file\""],
  ["src/components/settings/VaultSetupPanel.tsx", "data-debug-id=\"shellx-vault-recovery-copy\""],
  ["src/components/settings/VaultSetupPanel.tsx", "shellx-vault-recovery-confirm"],
  ["src/components/settings/VaultSetupPanel.tsx", "data-debug-id=\"shellx-vault-configured-summary\""],
  ["src/components/settings/VaultSetupPanel.tsx", "data-debug-id=\"shellx-vault-unlock-passphrase\""],
  ["src/components/settings/VaultSetupPanel.tsx", "data-debug-id=\"shellx-vault-unlock\""],
  ["src/components/settings/VaultTab.tsx", "invoke<GrantSummary[]>(\"shellx_vault_list_grants\""],
  ["src/components/settings/VaultTab.tsx", "data-debug-id=\"vault-permission-bar\""],
  ["src/components/settings/VaultTab.tsx", "isTrustedShellxUserEvent"],
  ["src/components/settings/VaultTab.tsx", "data-debug-id=\"vault-secret-form\""],
  ["src/components/settings/VaultTab.tsx", "vault-resource-section-secrets"],
  ["src/components/settings/VaultTab.tsx", "vault-resource-section-profile-cards"],
  ["src/components/settings/VaultTab.tsx", "vault-resource-section-agent-wallets"],
  ["src/components/settings/VaultTab.tsx", "useState<VaultResourceFormTab>(\"secret\")"],
  ["src/lib/vault-resource-model.ts", "id: \"secret\""],
  ["src/lib/vault-resource-model.ts", "Profile cards"],
  ["src/lib/vault-resource-model.ts", "Agent wallets"],
  ["src/components/settings/VaultTab.tsx", "Stripe API secret ref"],
  ["src/components/settings/VaultTab.tsx", "Webhook signing secret ref"],
  ["src/lib/vault-resource-model.ts", "User only"],
  ["src/lib/vault-resource-model.ts", "Visible / ask"],
  ["src/lib/vault-resource-model.ts", "Fill by site"],
  ["src/lib/vault-resource-model.ts", "Tool use always"],
  ["src/components/settings/VaultGrantsPanel.tsx", "shellx-vault-grants"],
  ["src/components/settings/VaultGrantsPanel.tsx", "data-debug-id=\"shellx-vault-grant-row\""],
  ["src/lib/vault-request-center.ts", "approveVaultGrant"],
  ["src/lib/trusted-user-event.ts", "isTrustedShellxUserEvent"],
  ["src/App.tsx", "isTrustedShellxUserEvent"],
  ["src/components/ShellxBrowserApp.tsx", "isTrustedShellxUserEvent"],
  ["src/App.tsx", "shellx_vault_approve_grant"],
  ["docs/public/API.md", "Vault Request Center"],
  ["docs/public/API.md", "POST | `/vault/lock`"],
  ["skills/shellx-host/SKILL.md", "vault_request_grant"],
  ["src/browser/components/AgentSidebar.tsx", "data-debug-id=\"shellx-browser-vault-prompt\""],
  ["src/App.css", ".vault-setup-panel"],
  ["docs/public/API.md", "/vault/setup/begin"],
  ["docs/public/API.md", "raw_secret_reveal_denied"],
  ["shellx-browser/README.md", "Vault credential"],
  ["src-tauri/Cargo.toml", "../vendor/shellx-vault/crates/vault-client"],
  ["src-tauri/Cargo.toml", "../vendor/shellx-vault/crates/vault-server"],
  ["src-tauri/Cargo.toml", "../vendor/shellx-vault/crates/vault-broker"],
  ["package.json", "\"test:shellx-vault-adversary\""],
  ["package.json", "\"test:shellx-vault-setup-ui\""],
  ["scripts/test-shellx-vault-setup-ui.ts", "SHELLX_VAULT_E2E=1"],
  ["scripts/test-vault-request-center-ui.ts", "SHELLX_VAULT_PROFILE_DIR"],
  ["scripts/test-shellx-vault-setup-ui.ts", "recovery-confirm-survived-selection"],
  ["scripts/test-shellx-vault-adversary.ts", "ShellX Vault Browser adversary smoke"],
  ["scripts/test-shellx-vault-adversary.ts", "assertNoSentinel"],
  ["scripts/test-shellx-vault-adversary.ts", "/browser/trace/export"],
  ["scripts/test-shellx-vault-adversary.ts", "debug-api-fetch"],
  ["scripts/fixtures/vault-browser-site/server.mjs", "/heavy-spa"],
  ["scripts/fixtures/vault-browser-site/server.mjs", "/heavy-agent-app"],
  ["scripts/fixtures/vault-browser-site/server.mjs", "/capture"],
  ["scripts/fixtures/vault-browser-site/server.mjs", "valueHash"],
  ["scripts/fixtures/vault-browser-site/public/login.html", "SXV_E2E_USERNAME"],
  ["scripts/fixtures/vault-browser-site/public/signup.html", "data-generated-password-target"],
  ["scripts/fixtures/vault-browser-site/public/api-key.html", "SXV_E2E_API_KEY_CANDIDATE"],
  ["scripts/fixtures/vault-browser-site/public/call-api.html", "data-api-key-input"],
  ["scripts/fixtures/vault-browser-site/public/adversary.html", "postMessage"],
  ["scripts/fixtures/vault-browser-site/public/adversary.html", "debugPort"],
  ["scripts/fixtures/vault-browser-site/public/heavy-spa.html", "data-virtualized-list"],
  ["scripts/fixtures/vault-browser-site/public/heavy-agent-app.html", "data-streaming-output"],
];

for (const [file, needle] of mustContain) {
  const body = readFileSync(join(root, file), "utf8");
  if (!body.includes(needle)) {
    throw new Error(`${file} is missing ${needle}`);
  }
}

const vaultSetupPanel = readFileSync(join(root, "src/components/settings/VaultSetupPanel.tsx"), "utf8");
if (!vaultSetupPanel.includes("passphrase === confirmPassphrase")) {
  throw new Error("Vault setup must require matching master passphrase confirmation before creating a recovery kit");
}
if (!vaultSetupPanel.includes("navigator.clipboard.writeText(recoveryKit.words.join(\" \"))")) {
  throw new Error("Vault setup must provide an explicit recovery-kit copy button instead of forcing text selection");
}
if (!/setRecoveryKit\(kit\);[\s\S]*?setPassphrase\(""\);[\s\S]*?setConfirmPassphrase\(""\);/.test(vaultSetupPanel)) {
  throw new Error("Vault setup must clear master passphrase fields after creating the recovery kit");
}
if (vaultSetupPanel.includes("Existing keyfile JSON")) {
  throw new Error("Vault setup must use a file picker for existing keyfiles instead of asking users to paste raw JSON");
}
const keyfileInput = vaultSetupPanel.match(/<input[\s\S]*?\/>/g)
  ?.find((input) => input.includes("ref={keyfileInputRef}"));
if (!keyfileInput || !keyfileInput.includes("hidden") || keyfileInput.includes("data-debug-id")) {
  throw new Error("Vault setup must keep the native keyfile input hidden and address the visible picker trigger instead");
}
if (!/async function chooseKeyfile\(\)[\s\S]*?takeShellxReleasePickerClaim\("file"\)[\s\S]*?if \(!claim\)[\s\S]*?keyfileInputRef\.current\?\.click\(\)/.test(vaultSetupPanel)) {
  throw new Error("Vault setup must fall back from the isolated release lease to the hidden native keyfile picker");
}
if (!/data-debug-id="surface-components-settings-vaultsetuppanel-17"[\s\S]*?onClick=\{\(\) => void chooseKeyfile\(\)\}/.test(vaultSetupPanel)) {
  throw new Error("Vault setup must expose a stable visible trigger wired to the guarded keyfile picker");
}
if (!vaultSetupPanel.includes("const [importLegacy, setImportLegacy] = useState(false);")) {
  throw new Error("Vault setup must require explicit opt-in before importing existing ShellX secrets");
}
if (!/data-debug-id="shellx-vault-setup"[\s\S]*?onPointerDown=\{\(event\) => event\.stopPropagation\(\)\}[\s\S]*?onClick=\{\(event\) => event\.stopPropagation\(\)\}/.test(vaultSetupPanel)) {
  throw new Error("Vault setup panel must stop pointer/click propagation so recovery word selection cannot close Settings");
}
if (!vaultSetupPanel.includes("Save setup") || !vaultSetupPanel.includes("Save setup and unlock vault")) {
  throw new Error("Vault setup must expose an explicit save action before and after recovery-kit creation");
}
if (!/data-debug-id="shellx-vault-recovery-confirm"[\s\S]*?disabled=\{!recoveryKit \|\| busy\}/.test(vaultSetupPanel)) {
  throw new Error("Vault setup save button must stay visible and disabled until a recovery kit exists");
}
if (vaultSetupPanel.includes("Finish setup")) {
  throw new Error("Vault setup final action must use save/unlock wording, not ambiguous finish wording");
}
if (!/showingConfiguredSummary[\s\S]*status\?\.recoveryConfirmed === true[\s\S]*!recoveryKit[\s\S]*!showSetupForm/.test(vaultSetupPanel)) {
  throw new Error("Vault setup must switch to a configured summary after recovery is confirmed");
}
if (!/data-debug-id="shellx-vault-configured-summary"[\s\S]*Vault configured/.test(vaultSetupPanel)) {
  throw new Error("Vault setup configured summary must replace passphrase setup fields after setup");
}
if (!/shellx_vault_unlock[\s\S]*keyfileJson: keyfileJson\.trim\(\) \|\| null/.test(vaultSetupPanel)) {
  throw new Error("Configured Vault summary must provide an explicit unlock action without forcing re-setup");
}
if (!/shellx_vault_unlock[\s\S]*rememberDevice/.test(vaultSetupPanel)) {
  throw new Error("Vault unlock must pass the remember-device choice to the backend");
}
if (!/shellx_vault_begin_setup[\s\S]*rememberDevice/.test(vaultSetupPanel)) {
  throw new Error("Vault setup must default to remembering this device and send that choice to the backend");
}
if (!/shellx_vault_set_remembered_device_enabled[\s\S]*passphrase: enabled \? rememberPassphrase : null/.test(vaultSetupPanel)) {
  throw new Error("Vault remember-device toggle must delete without passphrase and require passphrase when enabling");
}
if (!/data-debug-id="shellx-vault-unlock-passphrase"[\s\S]*autoComplete="current-password"/.test(vaultSetupPanel)) {
  throw new Error("Vault unlock must use a current-password field in configured locked state");
}

const vaultTab = readFileSync(join(root, "src/components/settings/VaultTab.tsx"), "utf8");
const vaultResourceModel = readFileSync(join(root, "src/lib/vault-resource-model.ts"), "utf8");
if (!vaultTab.includes("data-debug-id=\"vault-permission-bar\"")) {
  throw new Error("Vault key rows must expose a visible per-secret permission bar");
}
if (
  !vaultResourceModel.includes("type PermissionLevel") ||
  !vaultResourceModel.includes("Visible / ask") ||
  !vaultResourceModel.includes("Fill by site") ||
  !vaultResourceModel.includes("Tool use always")
) {
  throw new Error("Vault key rows must present understandable visibility, site-bound fill, and always-use choices");
}
if (!/handleSetPermission[\s\S]*?shellx_vault_create_grant/.test(vaultTab)) {
  throw new Error("Vault permission bar must create grants without requiring a manually typed secret reference");
}
if (!/desiredGrantOperationsForLevel[\s\S]*?browserFillAlways[\s\S]*?fill[\s\S]*?toolUseAlways[\s\S]*?providerUse/.test(vaultResourceModel)) {
  throw new Error("Vault always-use choices must map to mediated grant operations");
}
if (!/browserFillAlways[\s\S]*?window\.prompt[\s\S]*?normalizeBrowserGrantOriginInput[\s\S]*?origin: isBrowserGrantOperation/.test(vaultTab)) {
  throw new Error("Vault browser-fill grants must collect, validate, and submit an exact website origin");
}
if (/case "toolUseAlways":[\s\S]*?return \["fill", "providerUse"\]/.test(vaultResourceModel)) {
  throw new Error("Vault generic tool-use permission must not silently create an originless browser-fill grant");
}
if (vaultTab.includes("user_only:")) {
  throw new Error("VaultTab must send Tauri boolean command args as userOnly so the user-only checkbox works");
}
if (!/vault_update_metadata[\s\S]*?userOnly:/.test(vaultTab)) {
  throw new Error("VaultTab metadata updates must wire userOnly through to Tauri");
}
for (const removed of [
  "function EmailInboxForm",
  "vault-resource-section-email-inboxes",
  "vault-email-inbox-form",
  "Email inboxes",
  "handleAddEmailInbox",
]) {
  if (vaultTab.includes(removed)) {
    throw new Error(`VaultTab must not expose email inboxes as a separate resource UI: ${removed}`);
  }
}
if (!/stripeApiKeyRef[\s\S]*Webhook signing secret ref/.test(vaultTab)) {
  throw new Error("Agent wallet form must expose Vault secret refs for Stripe/API secrets");
}
for (const removed of [
  "function XaiKeyRow",
  "xAI API Key",
  "Paste your xAI key",
  "console.x.ai",
  "STT ready",
]) {
  if (vaultTab.includes(removed)) {
    throw new Error(`VaultTab must not keep the legacy bespoke xAI key surface: ${removed}`);
  }
}

const vaultGrantsPanel = readFileSync(join(root, "src/components/settings/VaultGrantsPanel.tsx"), "utf8");
if (vaultGrantsPanel.includes("placeholder=\"Secret reference\"")) {
  throw new Error("Vault grants panel must not ask users to type raw secret references by default");
}
if (vaultGrantsPanel.includes("setSecretRef") || vaultGrantsPanel.includes("const [secretRef")) {
  throw new Error("Vault grants panel must be review/revoke only; assignment belongs on each secret row");
}
if (!/const activeGrants = grants\.filter[\s\S]*?!grant\.revoked/.test(vaultGrantsPanel)) {
  throw new Error("Vault grants panel must hide revoked grants from the normal active list");
}
if (vaultGrantsPanel.includes("grants.map((grant)")) {
  throw new Error("Vault grants panel must render activeGrants, not every historical grant");
}

const vaultPanelSource = readFileSync(join(root, "src/components/VaultPanel.tsx"), "utf8");
if (!vaultPanelSource.includes("rememberDevice: false") || vaultPanelSource.includes("rememberDevice: true")) {
  throw new Error("Vault workspace quick unlock must not silently persist a remembered-device credential");
}
if (vaultPanelSource.includes("user_only:")) {
  throw new Error("VaultPanel must send Tauri boolean command args as userOnly so user-only add works");
}
if (vaultPanelSource.includes("invoke(\"vault_set\"") || vaultPanelSource.includes("vault_list_keys_with_meta")) {
  throw new Error("VaultPanel must not keep a duplicate Vault CRUD implementation; it should host VaultTab");
}

const vaultSetupPanelSource = readFileSync(join(root, "src/components/settings/VaultSetupPanel.tsx"), "utf8");
if (vaultSetupPanelSource.includes('setMessage("Vault unlocked on this device.")')) {
  throw new Error("Vault setup panel must not duplicate unlocked status below the configured summary");
}
if (vaultSetupPanelSource.includes("Recovery saved for this device.")) {
  throw new Error("Vault setup panel must not duplicate recovery status below the configured summary");
}

const vaultBackend = readFileSync(join(root, "src-tauri/src/shellx_vault/backend.rs"), "utf8");
if (!/pub enum VaultResourceKind[\s\S]*Secret[\s\S]*ProfileCard[\s\S]*EmailInbox[\s\S]*StripeAgentWallet/.test(vaultBackend)) {
  throw new Error("ShellX Vault must model typed resources for secrets, profile cards, email inboxes, and Stripe agent wallets");
}
if (!/pub struct ShellxVaultKeyMeta[\s\S]*resource_kind[\s\S]*resource_summary[\s\S]*resource_provider[\s\S]*resource_fields/.test(vaultBackend)) {
  throw new Error("Vault metadata listing must include redacted resource fields for agents and UI grouping");
}
if (
  !/VaultResource::from_typed_vault_item[\s\S]*compat_meta_from_resource/.test(vaultBackend) ||
  !/typed_resource_item_from_compat[\s\S]*VAULT_RESOURCE_SCHEMA_VERSION[\s\S]*ResourcePermission::VisibleAsk/.test(vaultBackend)
) {
  throw new Error("ShellX Vault must persist resources through the shared typed VaultResource schema, not compat notes");
}
if (!/VaultResource::from_shellx_compat_item[\s\S]*compat_meta_from_resource/.test(vaultBackend)) {
  throw new Error("ShellX Vault must keep a temporary migration reader for legacy shellx-compat-v1 notes");
}
if (/unwrap_or_else\(\|_\|[\s\S]*?PathBuf::from\(\"\\.\"\)[\s\S]*?join\(\"\\.config\"\)[\s\S]*?join\(\"shellx-vault\"\)/.test(vaultBackend)) {
  throw new Error("ShellX Vault profile path must not fall back to cwd-relative .config/shellx-vault");
}
if (
  !/vault_broker::profile::resolve_current_profile_dirs\(\)[\s\S]*canonical_dir/.test(vaultBackend) ||
  !/vault_broker::profile::canonical_profile_path/.test(vaultBackend) ||
  !/shellx_legacy_profile_path[\s\S]*vault_broker::profile::shellx_legacy_profile_path/.test(vaultBackend)
) {
  throw new Error("ShellX Vault must use the shared broker profile directory/profile.json and keep shellx-profile.json as a legacy import source");
}
if (!/current_profile_collision_warning[\s\S]*ProfileDiscovery::BothConflict/.test(vaultBackend)) {
  throw new Error("ShellX Vault must surface shared-vs-legacy profile collisions to the UI");
}
if (!/profile_path\(&profile_dir\)[\s\S]*?load_persisted_profile_status/.test(vaultBackend)) {
  throw new Error("ShellX Vault startup must load persisted profile status instead of showing unconfigured");
}
if (!/remember_device:[\s\S]*default_remember_device/.test(vaultBackend)) {
  throw new Error("ShellX Vault profile must default remember-device to on for old and new profiles");
}
if (!/remembered_device_keyfile_json[\s\S]*?rewrap\(passphrase, device_secret\)/.test(vaultBackend)) {
  throw new Error("Remembered device unlock must use a separate device keyfile rather than storing the master passphrase in profile JSON");
}
if (!/create_grant[\s\S]*?write_grants_snapshot/.test(vaultBackend)) {
  throw new Error("Vault grants must persist when created so always-granted agent permissions survive restart");
}
if (!/revoke_grant[\s\S]*?write_grants_snapshot/.test(vaultBackend)) {
  throw new Error("Vault grant revocation must persist so revoked permissions stay revoked after restart");
}
if (!/pub async fn unlock[\s\S]*read_persisted_profile[\s\S]*prepare_session/.test(vaultBackend)) {
  throw new Error("ShellX Vault must unlock a configured persisted profile after restart");
}
if (!/pub async fn compat_list_keys_with_meta[\s\S]*ensure_remembered_device_unlocked_for_access\(\)\.await/.test(vaultBackend)) {
  throw new Error("Vault Settings/listing reads must trigger remembered-device unlock before returning an empty pre-unlock cache");
}
if (!/pub async fn compat_get[\s\S]*ensure_remembered_device_unlocked_for_access\(\)\.await/.test(vaultBackend)) {
  throw new Error("Vault get/fill reads must trigger remembered-device unlock before looking up stored secrets");
}
if (!vaultBackend.includes("remembered_device_list_unlocks_before_status_poll")) {
  throw new Error("Vault backend must regression-test listing secrets before a status poll has unlocked the remembered device");
}
if (!vaultBackend.includes("manual_lock_blocks_remembered_device_auto_unlock_until_passphrase_unlock")) {
  throw new Error("Vault backend must regression-test manual lock blocking remembered-device auto-unlock");
}
if (!/pub async fn compat_delete[\s\S]*revoke_grants_for_secret\(key\)\.await/.test(vaultBackend)) {
  throw new Error("Deleting a Vault secret must revoke grants for that secret reference");
}
if (!/pub async fn compat_set_with_metadata[\s\S]*if user_only \{[\s\S]*revoke_grants_for_secret\(key\)\.await/.test(vaultBackend)) {
  throw new Error("Setting a Vault secret to user-only must revoke existing grants");
}
if (!/pub async fn compat_update_metadata[\s\S]*if user_only \{[\s\S]*revoke_grants_for_secret\(key\)\.await/.test(vaultBackend)) {
  throw new Error("Marking a Vault secret user-only must revoke existing grants");
}
if (!/async fn revoke_grants_for_secret[\s\S]*revoke_grants_for_resource\(secret_ref/.test(vaultBackend)) {
  throw new Error("Vault backend must revoke per-secret grants through the shared broker grant policy");
}
if (!/fn canonical_legacy_import_key[\s\S]*"providers\.xai\.api_key"[\s\S]*=>[\s\S]*"xai\/api-key"/.test(vaultBackend)) {
  throw new Error("Vault legacy import must canonicalize the old xAI key into xai/api-key");
}
if (!/pub async fn unlock[\s\S]*import_legacy_xai_key_if_present\(\)\.await/.test(vaultBackend)) {
  throw new Error("Configured Vault unlock must best-effort import legacy xAI keys into xai/api-key");
}
if (!/fn canonical_legacy_import_key[\s\S]*"grok\/api-key"[\s\S]*=>[\s\S]*"xai\/api-key"/.test(vaultBackend)) {
  throw new Error("Legacy grok/api-key alias must migrate into xai/api-key");
}
const browserVaultBackend = readFileSync(join(root, "src-tauri/src/shellx_browser_vault.rs"), "utf8");
if (!/shellx_browser_fill_user_vault_secret[\s\S]*lock_denial_for_action[\s\S]*BrowserTabOwnerKind::User[\s\S]*credential_entry_allowed[\s\S]*get_webview[\s\S]*engine_action_targets_active_context[\s\S]*compat_get/.test(browserVaultBackend)) {
  throw new Error("Manual Browser Vault fills must check lock, tab ownership, page security, and active engine before reading a Vault value");
}
if (!/shellx_browser_fill_user_vault_secret[\s\S]*try_apply_engine_action[\s\S]*record_vault_fill_receipt/.test(browserVaultBackend)) {
  throw new Error("Manual Browser Vault fills must use the native engine fill path and record a redacted Vault fill receipt");
}
if (!/expected_origin[\s\S]*browser_origin_for_url[\s\S]*eq_ignore_ascii_case\(&expected_origin\)[\s\S]*compat_get/.test(browserVaultBackend)) {
  throw new Error("Manual Browser Vault fills must reject a page-origin change before reading the Vault value");
}
const browserEngineScripts = readFileSync(join(root, "src-tauri/src/shellx_browser_scripts.rs"), "utf8");
const browserActionability = readFileSync(join(root, "src-tauri/src/shellx_browser_actionability.rs"), "utf8");
if (!/expectedOrigin[\s\S]*shellxPageOriginMatches[\s\S]*originChanged/.test(browserEngineScripts) || !/shellxPageOriginMatches[\s\S]*location\.origin/.test(browserActionability) || !/expected_origin: Some\(expected_origin\.clone\(\)\)/.test(browserVaultBackend)) {
  throw new Error("Manual Browser Vault fills must recheck the expected origin inside the exact page execution context");
}
const browserEngineRuntime = readFileSync(join(root, "src-tauri/src/shellx_browser_engine_runtime.rs"), "utf8");
if (!/browser_engine_webview_builder[\s\S]*general_autofill_enabled\(false\)/.test(browserEngineRuntime)) {
  throw new Error("ShellX Browser must disable native WebView form autofill because ShellX Vault owns credential suggestions");
}
if (!/install_browser_native_credential_controls[\s\S]*SetIsGeneralAutofillEnabled\(false\)[\s\S]*SetIsPasswordAutosaveEnabled\(false\)/.test(browserEngineRuntime)) {
  throw new Error("Windows ShellX Browser must disable both WebView2 autofill and password autosave");
}
const browserAppSource = readFileSync(join(root, "src/components/ShellxBrowserApp.tsx"), "utf8");
const browserVaultFillCandidates = readFileSync(join(root, "src/browser/vaultFillCandidates.ts"), "utf8");
const browserVaultFillHook = readFileSync(join(root, "src/browser/hooks/useBrowserVaultFill.ts"), "utf8");
if (!/menu === VAULT_FILL_MENU[\s\S]*browserVaultFill\.requestObservationRefresh\(\)/.test(browserAppSource)) {
  throw new Error("Manual Browser Vault fill menu must refresh observation when opened so dynamic login forms can offer saved credentials");
}
if (!/fillCandidate[\s\S]*fillUserVaultSecret[\s\S]*setObservation\(null\)[\s\S]*setObservationRefresh\(\(current\) => current \+ 1\)/.test(browserVaultFillHook)) {
  throw new Error("Manual Browser Vault fill must refresh observation after a successful fill so the same login can be detected again");
}
if (!/fillCandidate[\s\S]*isTrustedShellxUserEvent[\s\S]*fillUserVaultSecret/.test(browserVaultFillHook)) {
  throw new Error("Manual Browser Vault fill UI must require a trusted user click before invoking the Tauri fill command");
}
if (!/bestByTarget[\s\S]*candidate\.key[\s\S]*candidate\.refId/.test(browserVaultFillCandidates)) {
  throw new Error("Manual Browser Vault fill suggestions must de-duplicate duplicate matches for the same key and field");
}
const appCssSource = readFileSync(join(root, "src/App.css"), "utf8");
if (!/\.shellx-browser-vault-fill-main strong[\s\S]*overflow-wrap: anywhere[\s\S]*white-space: normal/.test(appCssSource)) {
  throw new Error("Manual Browser Vault fill suggestions must show readable full key names instead of hiding them behind ellipses");
}
if (!/observedContext\.origin !== pageContext\.origin[\s\S]*originScore[\s\S]*originScore <= 0[\s\S]*continue/.test(browserVaultFillCandidates)) {
  throw new Error("Manual Browser Vault fill must reject stale observations and secrets not bound to the current origin");
}
if (!/expectedOrigin: candidate\.origin/.test(browserVaultFillHook)) {
  throw new Error("Manual Browser Vault fill must bind the native fill request to the observed candidate origin");
}

const bdaObservation = {
  url: "https://ekursi.bda.lv/login/index.php",
  title: "Pieslegties saja vietne | BDA e-kursi",
  refs: [{
    refId: "ref-password",
    role: "password",
    label: "Parole",
    selector: "#password",
    action: "fillRef",
    visible: true,
    editable: true,
  }],
};
const bdaCandidates = buildBrowserVaultFillCandidates({
  url: bdaObservation.url,
  observation: bdaObservation,
  entries: [
    { key: "unrelated.example/login", description: "Password for unrelated.example" },
    { key: "bda.lv/login", description: "BDA e-kursi password" },
  ],
});
assert.deepEqual(bdaCandidates.map((candidate) => candidate.key), ["bda.lv/login"], "BDA login offers only a credential explicitly associated with bda.lv");
assert.equal(buildBrowserVaultFillCandidates({
  url: bdaObservation.url,
  observation: { ...bdaObservation, url: "https://unrelated.example/login" },
  entries: [{ key: "bda.lv/login", description: "BDA e-kursi password" }],
}).length, 0, "a stale cross-origin observation cannot produce a Vault suggestion");
assert.equal(buildBrowserVaultFillCandidates({
  url: "https://phishing.example/login",
  observation: { ...bdaObservation, url: "https://phishing.example/login", title: "Google sign in" },
  entries: [{ key: "google/password", description: "Gmail password" }],
}).length, 0, "page text cannot make a credential eligible on an unrelated origin");
assert.deepEqual(buildBrowserVaultFillCandidates({
  url: "https://accounts.example.co.uk/login",
  observation: { ...bdaObservation, url: "https://accounts.example.co.uk/login" },
  entries: [
    { key: "co.uk/login", description: "Unrelated compound suffix credential" },
    { key: "example.co.uk/login", description: "Example UK account password" },
  ],
}).map((candidate) => candidate.key), ["example.co.uk/login"], "compound public suffixes are not treated as credential site domains");
if (!/loadSecretForUser[\s\S]*isTrustedShellxUserEvent[\s\S]*invoke<string \| null>\("vault_get"/.test(vaultTab)) {
  throw new Error("Vault tab user copy/reveal must require a trusted user click before invoking vault_get");
}
if (!/handleCopyValue[\s\S]*navigator\.clipboard\.writeText/.test(vaultTab) || !/handleRevealValue[\s\S]*revealValue/.test(vaultTab)) {
  throw new Error("Vault tab must support user copy-without-display and explicit reveal flows");
}
const debugApi = readRustModuleFamily(join(root, "src-tauri/src/debug_api.rs"));
const debugApiBrowserSecurity = readFileSync(join(root, "src-tauri/src/debug_api_browser_security.rs"), "utf8");
if (!/vault_resources_http[\s\S]*compat_list_agent_visible_resources_with_meta[\s\S]*secretExposed[\s\S]*false/.test(debugApi)) {
  throw new Error("Debug API /vault/resources must return only redacted agent-visible Vault resources");
}
if (!/fillFromVaultGrant[\s\S]*?authorize_secret_use_for_actor[\s\S]*?GrantOperation::Fill[\s\S]*?compat_get/.test(debugApi)) {
  throw new Error("Browser fillFromVaultGrant must authorize a Fill grant and retrieve the secret only inside ShellX");
}
if (!/readEmailCodeGrant[\s\S]*debug_api_browser_security::browser_vault_resource_receipt_action_http/.test(debugApi)) {
  throw new Error("Browser readEmailCodeGrant must delegate to the browser security receipt route");
}
if (!/readEmailCodeGrant[\s\S]*?codeReturned[\s\S]*?secretExposed/.test(debugApiBrowserSecurity)) {
  throw new Error("Browser readEmailCodeGrant must truthfully label when an OTP code is returned");
}
if (!/fn classify_secret_get_ref[\s\S]*strip_prefix\("vault:"\)[\s\S]*SecretGetRef::Vault/.test(debugApi)) {
  throw new Error("Debug API secret_get must classify vault: refs before legacy pass-store refs");
}
if (!/fn vault_raw_reveal_denied_response[\s\S]*RAW_SECRET_REVEAL_DENIED/.test(debugApi)) {
  throw new Error("Debug API secret_get must deny raw Vault reveal with a structured code");
}
if (!/fn legacy_pass_reveal_denied_response[\s\S]*LEGACY_PASS_REVEAL_DENIED/.test(debugApi)) {
  throw new Error("Debug API secret_get must deny legacy pass-store reveal with a structured code");
}
const apiDocs = readFileSync(join(root, "docs/public/API.md"), "utf8");
const secretGetDocs = apiDocs.match(/### 12\.6 `POST \/tools\/secret_get`[\s\S]*?(?=\n### |\n## |$)/)?.[0] ?? "";
if (!/RAW_SECRET_REVEAL_DENIED/.test(secretGetDocs) || !/LEGACY_PASS_REVEAL_DENIED/.test(secretGetDocs) || !/mediated fill\/injection/.test(secretGetDocs)) {
  throw new Error("API docs must document Vault and legacy pass raw reveal denial for /tools/secret_get");
}
const voiceBackend = readFileSync(join(root, "src-tauri/src/voice.rs"), "utf8");
if (!/async fn resolve_xai_key[\s\S]*crate::shellx_vault::shared_backend\(\)[\s\S]*compat_get\("xai\/api-key"\)/.test(voiceBackend)) {
  throw new Error("Voice xAI credential lookup must read xai/api-key from the ShellX Vault backend");
}
if (!/pub async fn voice_credential_source[\s\S]*crate::shellx_vault::shared_backend\(\)[\s\S]*compat_get\("xai\/api-key"\)/.test(voiceBackend)) {
  throw new Error("Voice credential source must report ShellX Vault-backed xai/api-key");
}
const hostMcp =
  readFileSync(join(root, "src-tauri/src/host_mcp.rs"), "utf8") +
  readdirSync(join(root, "src-tauri/src/host_mcp"), { recursive: true, encoding: "utf8" })
    .filter((file) => file.endsWith(".rs"))
    .sort()
    .map((file) => readFileSync(join(root, "src-tauri/src/host_mcp", file), "utf8"))
    .join("\n");
if (!/browser_fill_from_vault[\s\S]*?secret value is injected by ShellX and is never returned/.test(hostMcp)) {
  throw new Error("Host MCP must expose an agent-discoverable Vault-mediated browser fill tool");
}
if (!/vault_request_grant[\s\S]*?pending[\s\S]*?Vault Request Center[\s\S]*?tool_vault_request_grant/.test(hostMcp)) {
  throw new Error("Host MCP must expose an agent-discoverable pending Vault grant request flow");
}
if (!/async fn resolve_xai_vision_bearer[\s\S]*crate::shellx_vault::shared_backend\(\)[\s\S]*compat_get\("xai\/api-key"\)/.test(hostMcp)) {
  throw new Error("Vision xAI credential lookup must read xai/api-key from the ShellX Vault backend");
}

const vaultSetupPanelContract = readFileSync(join(root, "src/components/settings/VaultSetupPanel.tsx"), "utf8");
if (!/type VaultStatus[\s\S]*lastError\?: string \| null/.test(vaultSetupPanelContract) || !/status\?\.lastError[\s\S]*vault-profile-collision/.test(vaultSetupPanelContract)) {
  throw new Error("Vault setup UI must show backend profile collision/status errors");
}

if (
  !/import \{ inTauri \} from "\.\.\/\.\.\/lib\/tauri-bridge"/.test(vaultTab) ||
  !/const desktopVaultAvailable = clipboardFixtureActive \|\| inTauri\(\)/.test(vaultTab) ||
  !/if \(!desktopVaultAvailable\) return;[\s\S]*invoke<VaultKeyMeta\[\]>\("vault_list_keys_with_meta"\)/.test(vaultTab) ||
  !/role="status"[\s\S]*Desktop Vault is unavailable in browser preview/.test(vaultTab)
) {
  throw new Error("Vault settings must fail closed to a deliberate unavailable state outside Tauri");
}

for (const crate of ["vault-broker", "vault-client", "vault-core", "vault-server"]) {
  const standaloneCrate = join(root, "..", "shellx-vault", "crates", crate);
  const vendoredCrate = join(root, "vendor", "shellx-vault", "crates", crate);
  if (existsSync(standaloneCrate)) {
    assertTreesEqual(standaloneCrate, vendoredCrate, `vendored ${crate}`);
  }
}

const vaultPanel = vaultPanelSource;
if (
  !vaultPanel.includes("<VaultTab") ||
  !vaultTab.includes('className="vault-row-reveal"') ||
  !vaultTab.includes("onHideReveal")
) {
  throw new Error("Vault reveal must be owned by the shared VaultTab row UI, not a duplicate parent overlay");
}
if (
  !/backdropPointerStartedOnBackdrop[\s\S]*?onPointerDownCapture=\{handleBackdropPointerDown\}[\s\S]*?onClick=\{handleBackdropClick\}/.test(vaultPanel) ||
  !/handleBackdropClick[\s\S]*?startedOnBackdrop[\s\S]*?event\.target !== event\.currentTarget \|\| !startedOnBackdrop[\s\S]*?return;[\s\S]*?onClose\(\)/.test(vaultPanel)
) {
  throw new Error("Vault overlay must only close when the pointer starts and ends on the backdrop");
}

const settingsPanel = readFileSync(join(root, "src/components/Settings.tsx"), "utf8");
if (
  !/backdropPointerStartedOnBackdrop[\s\S]*?onPointerDownCapture=\{handleSettingsBackdropPointerDown\}[\s\S]*?onClick=\{handleSettingsBackdropClick\}/.test(settingsPanel) ||
  !/handleSettingsBackdropClick[\s\S]*?startedOnBackdrop[\s\S]*?event\.target !== event\.currentTarget \|\| !startedOnBackdrop[\s\S]*?return;[\s\S]*?onClose\(\)/.test(settingsPanel)
) {
  throw new Error("Settings modal must only close when the pointer starts and ends on the backdrop");
}

const forbidden: Array<[string, string]> = [
  ["src-tauri/src", "shellx-vault-migration: replace"],
  ["src-tauri/src", "\"secretValue\": request.secret_value"],
  ["src-tauri/src", "\"secretValue\": request.secretValue"],
  ["src-tauri/src", "/vault/migration/decline"],
  ["src-tauri/src", "LegacyLimited"],
  ["src-tauri/src", "legacyModeAllowed"],
  ["src-tauri/src", "legacy_mode_allowed"],
  ["src", "legacyModeAllowed"],
];

function readTree(path: string): string {
  const full = join(root, path);
  const stat = statSync(full);
  if (stat.isFile()) return readFileSync(full, "utf8");
  let body = "";
  for (const name of readdirSync(full)) {
    if (["target", "node_modules", ".git"].includes(name)) continue;
    body += readTree(join(path, name));
  }
  return body;
}

function assertTreesEqual(left: string, right: string, label: string): void {
  const leftEntries = listFiles(left).sort();
  const rightEntries = listFiles(right).sort();
  if (leftEntries.join("\n") !== rightEntries.join("\n")) {
    throw new Error(`${label} file list is out of sync with standalone Vault`);
  }
  for (const entry of leftEntries) {
    const leftBody = readFileSync(join(left, entry), "utf8");
    const rightBody = readFileSync(join(right, entry), "utf8");
    if (leftBody !== rightBody) {
      throw new Error(`${label} file ${entry} is out of sync with standalone Vault`);
    }
  }
}

function listFiles(path: string, prefix = ""): string[] {
  return readdirSync(path).flatMap((name) => {
    if (["target", "node_modules", ".git"].includes(name)) return [];
    const full = join(path, name);
    const rel = prefix ? join(prefix, name) : name;
    const stat = statSync(full);
    return stat.isFile() ? [rel] : listFiles(full, rel);
  });
}

for (const [path, needle] of forbidden) {
  const body = readTree(path);
  if (body.includes(needle)) {
    throw new Error(`${path} still contains forbidden marker ${needle}`);
  }
}

console.log("ShellX Vault source contract ok");
