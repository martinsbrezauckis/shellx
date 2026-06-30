import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import {
  buildVaultRequestCenterItems,
  extractVaultPermissionRequests,
  vaultRequestSummaryText,
} from "../src/lib/vault-request-center";

const tabs = [
  { tabId: "tab-oauth", title: "OAuth setup" },
  { tabId: "tab-shell", title: "Shell command" },
];

const events = [
  {
    t: 1_717_000_300_000,
    kind: "permission-request",
    payload: {
      _meta: { tabId: "tab-oauth" },
      reqId: "req-vault-fill",
      params: {
        toolCall: {
          title: "browser_fill_from_vault",
          rawInput: {
            secretRef: "vault:gmail/password",
            selector: "#password",
          },
        },
      },
    },
  },
  {
    t: 1_717_000_400_000,
    kind: "permission-request",
    payload: {
      _meta: { tabId: "tab-shell" },
      reqId: "req-shell",
      params: {
        toolCall: {
          title: "terminal/create",
          rawInput: {
            command: "ls",
          },
        },
      },
    },
  },
];

const sessionPermissions = extractVaultPermissionRequests(events as never, tabs);
assert.equal(sessionPermissions.length, 1, "Vault Request Center must not show generic shell permissions");
assert.equal(sessionPermissions[0]?.requestId, "req-vault-fill");
assert.equal(sessionPermissions[0]?.tabTitle, "OAuth setup");
assert.equal(sessionPermissions[0]?.toolName, "browser_fill_from_vault");

const endedSessionPermissions = extractVaultPermissionRequests(
  [
    ...events,
    {
      t: 1_717_000_500_000,
      kind: "session-ended",
      payload: {
        _meta: { tabId: "tab-oauth" },
        reason: "tab closed",
      },
    },
  ] as never,
  tabs,
);
assert.equal(
  endedSessionPermissions.length,
  0,
  "Vault Request Center must clean pending session permission requests when their session ends",
);

const requests = buildVaultRequestCenterItems({
  sessionPermissions,
  browserSessionGrants: [
    {
      grantId: "browser-grant-1",
      taskId: "browser-task-1",
      fromProfileId: "personal",
      toProfileId: "agent-work",
      reason: "Use remembered Gmail session",
      status: "requested",
      ttlSeconds: 3600,
      createdAtMs: 1_717_000_200_000,
      resolvedAtMs: null,
      appliedAtMs: null,
    },
  ],
  browserVaultDeposits: [
    {
      depositId: "deposit-1",
      label: "Saved login",
      storageCommitHash: "sha256:hidden",
      secretExposed: false,
      taskId: "browser-task-2",
      sourceUrl: "https://example.test/login",
    },
  ],
  vaultGrants: [
    {
      grantId: "grant-pending-1",
      secretRef: "gmail/password",
      actorScope: "allShellxAgents",
      operation: "fill",
      expiresAtMs: null,
      revoked: false,
      approved: false,
    },
    {
      grantId: "grant-approved-1",
      secretRef: "discord/bot-token",
      actorScope: "allShellxAgents",
      operation: "providerUse",
      expiresAtMs: null,
      revoked: false,
      approved: true,
    },
  ],
  dismissedDepositIds: new Set<string>(),
});

assert.equal(requests.length, 4, "center should combine Browser, session, and pending Vault grant requests");
assert.equal(requests[0]?.kind, "sessionPermission", "newer session Vault permission should be first");
assert.equal(requests[0]?.primaryAction.kind, "allowPermission");
assert.equal(requests[0]?.secondaryAction?.kind, "denyPermission");
assert.ok(requests.some((request) => request.kind === "browserSessionGrant"), "Browser session grants should be present");
assert.ok(requests.some((request) => request.kind === "browserVaultDeposit"), "Browser Vault deposits should be present");
const pendingGrant = requests.find((request) => request.kind === "vaultGrant");
assert.ok(pendingGrant, "pending Vault grants should be present");
assert.equal(pendingGrant?.grantId, "grant-pending-1");
assert.equal(pendingGrant?.primaryAction.kind, "approveVaultGrant");
assert.equal(pendingGrant?.secondaryAction?.kind, "denyVaultGrant");
assert.ok(!requests.some((request) => request.grantId === "grant-approved-1"), "approved Vault grants should not appear as pending requests");
assert.equal(vaultRequestSummaryText(requests), "4 Vault requests");
assert.equal(vaultRequestSummaryText([]), "Vault ready");

const header = readFileSync("src/components/Header.tsx", "utf8");
const app = readFileSync("src/App.tsx", "utf8");
const css = readFileSync("src/App.css", "utf8");
const popoverBlock = css.match(/^\.vault-request-popover\s*\{[^}]+\}/m)?.[0] ?? "";
assert.ok(
  header.includes('data-debug-id="header-vault-request-center"'),
  "Header must expose a stable Vault Request Center debug id",
);
assert.ok(
  header.includes('data-debug-id="vault-request-center-popover"'),
  "Vault Request Center popover must expose a stable debug id",
);
for (const id of [
  "vault-request-open-vault",
  "vault-request-new-secret",
  "vault-request-generate-password",
]) {
  assert.ok(
    header.includes(`data-debug-id="${id}"`),
    `Vault Request Center must expose ${id} quick action`,
  );
}
assert.ok(
  header.indexOf('data-debug-id="header-shellx-browser"') <
    header.indexOf('data-debug-id="header-vault-request-center"') &&
    header.indexOf('data-debug-id="header-vault-request-center"') <
    header.indexOf('aria-label="Open connector inbox"'),
  "Vault Request Center icon must sit between Browser and Connector Inbox",
);
assert.ok(
  app.includes("vaultRequestCenter={vaultRequestCenter}"),
  "App must pass a global Vault request summary into Header",
);
assert.ok(
  app.includes("onOpenVault={openVaultPanel}") &&
    app.includes("vaultPanelIntent") &&
    app.includes("vaultPanelIntentSeq"),
  "App must open the standalone Vault workspace with quick-action intent",
);
assert.ok(
  header.includes("VaultPasswordGenerator") &&
    header.includes("setVaultPasswordGeneratorOpen(true)") &&
    !header.includes('onOpenVault("generatePassword")'),
  "Vault Request Center Generate must open the standalone generator instead of the full Vault workspace",
);
assert.ok(
  app.includes('"vaultRequestCenterOpen",'),
  "Vault Request Center debug open command must survive authoritative UI-state merge",
);
assert.ok(
  app.includes('invoke<AppVaultGrant[]>("shellx_vault_list_grants"') &&
    app.includes('"shellx_vault_approve_grant"') &&
    app.includes('"shellx_vault_revoke_grant"'),
  "App must list pending Vault grants and resolve them through operator-only Tauri commands",
);
assert.ok(
  app.includes("mergeAppVaultGrants") &&
    app.includes('apiGet<{ grants?: AppVaultGrant[] }>("/vault/grants")') &&
    !app.includes('invoke<AppVaultGrant[]>("shellx_vault_list_grants").catch(() => [])'),
  "Vault Request Center must merge Debug API grant state instead of hiding it behind an empty native fallback",
);
assert.ok(
  popoverBlock.includes("background: var(--surface") && !popoverBlock.includes("var(--surface-1)"),
  "Vault Request Center popover must render on an opaque defined surface",
);
assert.ok(
  css.includes(".vault-request-quick-actions") &&
    css.includes(".vault-password-generator") &&
    css.includes(".hdr-vault-request-icon.vault-open") &&
    css.includes(".hdr-vault-request-icon.vault-closed") &&
    css.includes(".vault-workspace-modal"),
  "Vault Request Center quick actions, generator, lock state, and standalone Vault workspace must have CSS",
);

console.log("Vault Request Center contract passed");
