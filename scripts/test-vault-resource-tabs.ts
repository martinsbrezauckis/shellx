import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

const source = readFileSync("src/components/settings/VaultTab.tsx", "utf8");
const setupSource = readFileSync("src/components/settings/VaultSetupPanel.tsx", "utf8");
const model = readFileSync("src/lib/vault-resource-model.ts", "utf8");
const css = [
  readFileSync("src/App.css", "utf8"),
  readFileSync("src/components/settings/vaultFields.css", "utf8"),
].join("\n");

assert.ok(
  source.includes('data-debug-id="vault-resource-form-tabs"'),
  "Vault settings must expose a stable resource form tabs debug id",
);
assert.ok(
  source.includes("VAULT_RESOURCE_FORM_TABS") &&
    model.includes("VAULT_RESOURCE_FORM_TABS"),
  "Vault resource forms must be driven by a compact tab model",
);
for (const tab of ["secret", "profileCard", "stripeAgentWallet"]) {
  assert.ok(
    model.includes(`id: "${tab}"`),
    `Vault settings must model ${tab} resource form tab`,
  );
}
assert.ok(
  source.includes('useState<VaultResourceFormTab>("secret")'),
  "Vault resource form tabs must open on Secrets by default",
);
assert.ok(
  model.includes('label: "Passwords & keys"') &&
    source.includes("Passwords & keys") &&
    !source.includes(">Secrets<"),
  "Vault user-facing secret storage label must read as Passwords & keys",
);
assert.ok(
  source.includes("generateVaultPassword") &&
    source.includes("VaultPasswordGenerator") &&
    source.includes('data-debug-id="vault-generate-password"') &&
    source.includes('data-debug-id="vault-secret-key-input"') &&
    source.includes('data-debug-id="vault-secret-value-input"'),
  "Vault Secrets form must expose a first-class password generator panel and stable fields",
);
assert.ok(
  source.includes("intent === \"generatePassword\"") &&
    source.includes("setSecretGeneratorOpen(true)"),
  "Standalone Vault quick actions must be able to open directly into the generated-password panel",
);
for (const removed of ["emailInbox\", label", "EmailInboxForm", "vault-email-inbox-form", "Email inboxes"]) {
  assert.ok(
    !source.includes(removed),
    `Vault settings must not expose email passwords as a separate resource tab: ${removed}`,
  );
}
assert.ok(
  source.includes("vault-resource-form-tab-${tab.id}"),
  "Vault resource form tab buttons must expose per-tab debug ids",
);
assert.ok(
  source.includes('const VAULT_WORKSPACE_TABS: readonly VaultWorkspaceTab[] = ["secrets", "grants", "setup"]') &&
    source.includes("handleVaultTabKeyDown") &&
    source.includes('event.key === "ArrowRight"') &&
    source.includes('event.key === "ArrowLeft"') &&
    source.includes('event.key === "Home"') &&
    source.includes('event.key === "End"'),
  "Vault tablists must provide automatic arrow, Home, and End keyboard navigation",
);
for (const tab of ["secrets", "grants", "setup"]) {
  assert.ok(
    source.includes(`id="vault-tab-${tab}"`) &&
      source.includes(`aria-controls="vault-workspace-panel-${tab}"`) &&
      source.includes(`id="vault-workspace-panel-${tab}"`) &&
      source.includes(`aria-labelledby="vault-tab-${tab}"`),
    `Vault workspace tab ${tab} must exactly own its labelled tabpanel`,
  );
}
assert.ok(
  source.includes('tabIndex={workspaceTab === "secrets" ? 0 : -1}') &&
    source.includes('tabIndex={workspaceTab === "grants" ? 0 : -1}') &&
    source.includes('tabIndex={workspaceTab === "setup" ? 0 : -1}'),
  "Vault workspace tabs must expose one roving keyboard focus owner",
);
assert.ok(
  source.includes('id={`vault-resource-form-tab-${tab.id}`}') &&
    source.includes('aria-controls={`vault-resource-form-panel-${tab.id}`}') &&
    source.includes('tabIndex={resourceFormTab === tab.id ? 0 : -1}') &&
    source.includes('id={`vault-resource-form-panel-${resourceFormTab}`}') &&
    source.includes('aria-labelledby={`vault-resource-form-tab-${resourceFormTab}`}'),
  "Vault resource tabs must expose roving focus and exactly owned labelled tabpanels",
);
assert.ok(
  /resourceFormTab\s*===\s*"secret"[\s\S]*<SecretForm/.test(source),
  "Secret form should render only inside the first tab",
);
assert.ok(
  /resourceFormTab\s*===\s*"profileCard"[\s\S]*<ProfileCardForm/.test(source),
  "Profile card form should render only inside its active tab",
);
assert.ok(
  /resourceFormTab\s*===\s*"stripeAgentWallet"[\s\S]*<AgentWalletForm/.test(source),
  "Agent wallet form should render only inside its active tab",
);
assert.ok(
  source.includes("stripeApiKeyRef") && source.includes("webhookSecretRef"),
  "Agent wallet form must reference Stripe/API secrets stored as normal Vault secrets",
);
assert.ok(
  (source.match(/<VaultField label=/g) ?? []).length >= 26 &&
    source.includes('<VaultField label="Card label">') &&
    source.includes('<VaultField label="Wallet status">') &&
    setupSource.includes('<VaultField label="Server URL">') &&
    setupSource.includes('<VaultField label="Access token">') &&
    setupSource.includes('<VaultField label="Confirm master passphrase">'),
  "Vault setup, profile, and wallet inputs must retain visible programmatic labels after values replace placeholders",
);
assert.ok(
  model.includes("permissionLevelForEntry") &&
    model.includes("desiredGrantOperationsForLevel") &&
    model.includes("groupVaultEntriesByResourceKind") &&
    !source.includes("function permissionLevelForEntry") &&
    !source.includes("function desiredGrantOperationsForLevel") &&
    !source.includes("function resourceKindOf"),
  "Vault permission/resource model must live outside the UI component",
);
assert.ok(
  css.includes(".vault-resource-form-tabs") &&
    css.includes(".vault-resource-form-panel") &&
    css.includes(".vault-resource-form-tab.active") &&
    css.includes(".vault-secret-value-control") &&
    css.includes(".vault-field-label"),
  "Vault resource form tabs must have compact tab-panel CSS",
);

console.log("Vault resource tabs contract passed");
