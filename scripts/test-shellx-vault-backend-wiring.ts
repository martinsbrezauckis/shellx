import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const activeConsumers = [
  "src-tauri/src/acp.rs",
  "src-tauri/src/agent_cli_setup.rs",
  "src-tauri/src/connections.rs",
  "src-tauri/src/debug_api_diagnostics_github.rs",
  "src-tauri/src/host_mcp/vault_tools.rs",
  "src-tauri/src/mcp_marketplace.rs",
  "src-tauri/src/provider_adapters.rs",
  "src-tauri/src/subagent.rs",
] as const;

for (const path of activeConsumers) {
  const source = readFileSync(resolve(path), "utf8");
  assert(
    source.includes("crate::shellx_vault"),
    `${path} must resolve active Vault operations through the integrated backend`,
  );
  assert(
    !source.includes("crate::vault::Vault"),
    `${path} must not reopen legacy ~/.shellx/vault.enc`,
  );
}

const backend = readFileSync(resolve("src-tauri/src/shellx_vault/backend.rs"), "utf8");
assert.equal(
  (backend.match(/crate::vault::Vault::open\(\)/g) ?? []).length,
  2,
  "legacy Vault opens are restricted to the two explicit import/migration paths",
);
assert(
  backend.includes("pub async fn compat_get") &&
    backend.includes("pub async fn compat_set") &&
    backend.includes("pub async fn compat_delete"),
  "integrated backend exposes the compatibility bridge used by active consumers",
);

const hostToolSpecs = readFileSync(resolve("src-tauri/src/host_mcp/tool_specs_core.rs"), "utf8");
const secretSetDescription = hostToolSpecs.match(
  /"name": "secret_set",\s*"description": "([^"]+)"/,
)?.[1] ?? "";
assert(
  secretSetDescription.includes("active integrated ShellX Vault backend"),
  "secret_set advertises the integrated Vault backend",
);
assert(
  !secretSetDescription.includes("vault.enc"),
  "secret_set does not advertise the legacy import-only Vault envelope",
);

const rustLib = readFileSync(resolve("src-tauri/src/lib.rs"), "utf8");
const browserRoot = readFileSync(resolve("src-tauri/src/shellx_browser.rs"), "utf8");
const browserVault = readFileSync(resolve("src-tauri/src/shellx_browser_vault.rs"), "utf8");
const browserActions = readFileSync(resolve("src-tauri/src/shellx_browser_actions.rs"), "utf8");
const browserScripts = readFileSync(resolve("src-tauri/src/shellx_browser_scripts.rs"), "utf8");
const browserActionRoute = readFileSync(resolve("src-tauri/src/debug_api_browser_action.rs"), "utf8");
const browserSecurityRoutes = readFileSync(resolve("src-tauri/src/debug_api_browser_security.rs"), "utf8");
const appUi = readFileSync(resolve("src/App.tsx"), "utf8");
const builtinDocs = readFileSync(resolve("src/lib/builtin-docs.ts"), "utf8");

assert(
  builtinDocs.includes("shellx-vault/profile.json") &&
    builtinDocs.includes("Settings → Vault") &&
    builtinDocs.includes("vault.enc\\` is import-only"),
  "embedded docs identify the shared Vault profile and label vault.enc import-only",
);
assert(
  !builtinDocs.includes("- Vault: \\`<config>/vault.enc\\`"),
  "embedded docs must not advertise legacy vault.enc as the active Vault location",
);

assert(rustLib.includes("mod shellx_browser_vault;"), "Browser Vault mediation module is registered");
assert(
  browserVault.includes("pub(crate) fn prepare_vault_deposit") &&
    browserVault.includes("pub(crate) fn commit_prepared_vault_deposit") &&
    !browserVault.includes("pub fn create_vault_deposit") &&
    browserActions.includes("capture_browser_page_secret_value") &&
    browserScripts.includes("capturePageSecretToVault") &&
    browserVault.includes("pub fn record_vault_fill_receipt") &&
    browserVault.includes("pub fn record_profile_card_fill_receipt") &&
    browserVault.includes("pub fn record_email_code_receipt") &&
    browserVault.includes("pub fn record_agent_wallet_unavailable_receipt") &&
    browserVault.includes("pub fn record_agent_wallet_blocked_receipt") &&
    browserVault.includes("browserVaultDepositCreated") &&
    browserVault.includes("browserVaultCredentialFilled") &&
    browserVault.includes("browserAgentWalletCheckoutUnavailable") &&
    !browserVault.includes("browserVaultPasswordGenerated"),
  "Browser Vault deposit and verified credential receipt behavior stays in its focused module",
);
assert(
  browserSecurityRoutes.includes("browser_vault_receipt_requires_verified_operation") &&
    browserSecurityRoutes.includes("browser_vault_fill_receipt_http") &&
    browserSecurityRoutes.includes("browser_vault_generate_receipt_http") &&
    browserSecurityRoutes.includes("browser_agent_wallet_checkout_unavailable") &&
    browserSecurityRoutes.includes("StatusCode::NOT_IMPLEMENTED"),
  "Browser rejects caller-authored Vault receipts and unavailable agent-wallet checkout claims",
);
assert(
  browserActionRoute.includes("capturePageSecretToVault") &&
    browserActionRoute.includes("capture_browser_page_secret_value") &&
    browserActionRoute.includes("browser_vault_deposit_key") &&
    browserActionRoute.includes("compat_create_with_description") &&
    browserActionRoute.includes('"secretExposed": false'),
  "Browser captures page-visible secrets into a unique owned Vault ref without returning raw text",
);
assert(
  !browserRoot.includes("pub fn create_vault_deposit") &&
    !browserRoot.includes("pub fn record_vault_fill_receipt") &&
    !browserRoot.includes("pub fn record_profile_card_fill_receipt") &&
    !browserRoot.includes("pub fn record_email_code_receipt") &&
    !browserRoot.includes("pub fn record_agent_wallet_unavailable_receipt") &&
    !browserRoot.includes("pub fn record_agent_wallet_blocked_receipt") &&
    !browserRoot.includes("pub fn record_vault_generate_receipt") &&
    !browserRoot.includes("fn record_vault_credential_receipt"),
  "Browser Vault deposit and credential receipt methods are absent from the facade",
);
assert(
  browserVault.includes("pub async fn shellx_browser_open_vault_panel") &&
    browserVault.includes("pub fn prepare_vault_grant_fill_action") &&
    browserVault.includes("pub fn prepare_profile_card_fill_action") &&
    browserVault.includes("SHELLX_OPEN_VAULT_PANEL_EVENT") &&
    !/fn emit_open_vault_panel\s*\(/.test(browserRoot) &&
    !/pub fn prepare_vault_grant_fill_action\s*\(/.test(browserRoot) &&
    !/pub fn prepare_profile_card_fill_action\s*\(/.test(browserRoot),
  "Browser Vault bridge helpers stay in their focused module",
);
assert(
  browserVault.includes("SHELLX_VAULT_PANEL_OPENED_EVENT") &&
    browserVault.includes("SHELLX_VAULT_PANEL_OPEN_ACK_WAIT_MS") &&
    browserVault.includes("app.listen(SHELLX_VAULT_PANEL_OPENED_EVENT") &&
    browserVault.includes("tokio::time::timeout") &&
    browserVault.includes("app.unlisten(listener_id)") &&
    !browserVault.includes("tauri::async_runtime::spawn"),
  "Browser Vault panel bridge waits for a bounded renderer acknowledgement instead of claiming fire-and-forget success",
);
assert(
  appUi.includes('listen<{ requestId?: unknown }>("shellx:open-vault-panel"') &&
    appUi.includes('emit("shellx:vault-panel-opened", { requestId })') &&
    appUi.includes('requestId.startsWith("vault-panel-open-")') &&
    appUi.includes("pendingVaultPanelAckIdsRef"),
  "main renderer acknowledges only bounded owned Vault panel requests after the panel is open",
);
assert(browserRoot.includes("fillProfileCardGrant"), "Browser exposes mediated profile-card fill");
assert(browserRoot.includes("readEmailCodeGrant"), "Browser exposes mediated email-code reads");
assert(browserRoot.includes("useAgentWalletGrant"), "Browser reserves mediated agent-wallet checkout");
assert(browserVault.includes("browserProfileCardFilled"), "Browser receipts include profile-card fills");
assert(browserVault.includes("browserEmailCodeRead"), "Browser receipts include email-code reads");
assert(browserVault.includes("browserAgentWalletCheckoutUnavailable"), "Browser records unavailable agent-wallet checkout");
assert(!browserVault.includes("browserAgentWalletCheckoutPrepared"), "Browser never claims an unperformed agent-wallet checkout");
assert(browserVault.includes("browserAgentWalletCheckoutBlocked"), "Browser receipts include blocked agent-wallet checkout");

console.log("ShellX Vault single-backend wiring checks passed");
