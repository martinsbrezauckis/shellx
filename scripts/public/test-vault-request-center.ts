import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import {
  buildVaultRequestCenterItems,
  extractVaultPermissionRequests,
  vaultRequestSummaryText,
} from "../../src/lib/vault-request-center";
import {
  browserEventTouchesVaultRequests,
  mergeVaultRequestCenterAgentRequests,
  mergeVaultRequestCenterGrants,
} from "../../src/lib/useVaultRequestCenterState";
import { readAppStyles } from "./lib/app-styles";

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
  agentRequests: [
    {
      requestId: "request-agent-1",
      requestDigest: "digest-agent-1",
      actorId: "codex-tab-1",
      actorLabel: "Codex",
      status: "pending",
      createdAtMs: 1_717_000_100_000,
      expiresAtMs: Date.now() + 300_000,
      spec: {
        purpose: "Publish an authenticated package",
        program: "/usr/bin/npm",
        args: ["publish", "--dry-run"],
        cwd: "/workspace/package",
        bindings: [
          {
            resourceId: "npm/token",
            field: "value",
            env: "NODE_AUTH_TOKEN",
          },
        ],
        timeoutMs: 120_000,
      },
    },
  ],
  dismissedDepositIds: new Set<string>(),
});

assert.equal(requests.length, 5, "center should combine Browser, session, Vault grant, and executable requests");
assert.equal(requests[0]?.kind, "vaultAgentRequest", "executable requests should receive danger priority");
const sessionRequest = requests.find((request) => request.kind === "sessionPermission");
assert.equal(sessionRequest?.primaryAction.kind, "allowPermission");
assert.equal(sessionRequest?.secondaryAction?.kind, "denyPermission");
assert.ok(requests.some((request) => request.kind === "browserSessionGrant"), "Browser session grants should be present");
assert.ok(requests.some((request) => request.kind === "browserVaultDeposit"), "Browser Vault deposits should be present");
const pendingGrant = requests.find((request) => request.kind === "vaultGrant");
assert.ok(pendingGrant, "pending Vault grants should be present");
assert.equal(pendingGrant?.grantId, "grant-pending-1");
assert.equal(pendingGrant?.primaryAction.kind, "approveVaultGrant");
assert.equal(pendingGrant?.secondaryAction?.kind, "denyVaultGrant");
assert.ok(!requests.some((request) => request.grantId === "grant-approved-1"), "approved Vault grants should not appear as pending requests");
const agentRequest = requests.find((request) => request.kind === "vaultAgentRequest");
assert.ok(agentRequest, "pending Vault executable requests should be present");
assert.equal(agentRequest?.agentRequestId, "request-agent-1");
assert.equal(agentRequest?.expectedDigest, "digest-agent-1");
assert.equal(agentRequest?.primaryAction.kind, "approveVaultAgentRequest");
assert.equal(agentRequest?.secondaryAction?.kind, "denyVaultAgentRequest");
assert.ok(agentRequest?.detailLines.some((line) => line.includes("/usr/bin/npm")));
assert.ok(agentRequest?.detailLines.some((line) => line.includes("NODE_AUTH_TOKEN <- npm/token")));
assert.equal(vaultRequestSummaryText(requests), "5 approvals needed");
assert.equal(vaultRequestSummaryText([]), "Ready");

const nativeGrant = {
  grantId: "shared-grant",
  secretRef: "native/value",
  actorScope: "native",
  operation: "fill",
  revoked: false,
  approved: false,
};
const debugGrant = { ...nativeGrant, secretRef: "debug/value", actorScope: "debug" };
assert.deepEqual(
  mergeVaultRequestCenterGrants(
    [nativeGrant],
    [debugGrant, { ...debugGrant, grantId: "debug-only" }],
  ).map((grant) => [grant.grantId, grant.secretRef]),
  [["shared-grant", "native/value"], ["debug-only", "debug/value"]],
  "native Vault state must win duplicate ids while Debug API fills missing grants",
);

const agentRequestFixture = (requestId: string, actorLabel: string) => ({
  requestId,
  requestDigest: `digest-${requestId}`,
  actorId: `actor-${requestId}`,
  actorLabel,
  status: "pending",
  createdAtMs: 1,
  expiresAtMs: 2,
  spec: {
    purpose: "test",
    program: "/bin/test",
    bindings: [],
    timeoutMs: 1_000,
  },
});
assert.deepEqual(
  mergeVaultRequestCenterAgentRequests(
    [agentRequestFixture("shared-request", "native")],
    [
      agentRequestFixture("shared-request", "debug"),
      agentRequestFixture("debug-request", "debug"),
    ],
  ).map((request) => [request.requestId, request.actorLabel]),
  [["shared-request", "native"], ["debug-request", "debug"]],
  "native Vault state must win duplicate ids while Debug API fills missing agent requests",
);
assert.equal(
  browserEventTouchesVaultRequests({ receipt: { kind: "browserSessionGrantRequested" } }),
  true,
  "session grant Browser events must refresh the global Request Center",
);
assert.equal(
  browserEventTouchesVaultRequests({ receipt: { kind: "browserVaultDepositCreated" } }),
  true,
  "Vault deposit Browser events must refresh the global Request Center",
);
assert.equal(
  browserEventTouchesVaultRequests({ receipt: { kind: "browserEngineActionApplied" } }),
  false,
  "unrelated Browser activity must not fan out into Vault reads",
);

const header = readFileSync("src/components/Header.tsx", "utf8");
const requestCenterComponent = readFileSync("src/components/HeaderVaultRequestCenter.tsx", "utf8");
const app = readFileSync("src/App.tsx", "utf8");
const requestStateHook = readFileSync("src/lib/useVaultRequestCenterState.ts", "utf8");
const eventPollingHook = readFileSync("src/lib/useEventAwarePolling.ts", "utf8");
const debugVaultApi = readFileSync("src-tauri/src/debug_api_vault.rs", "utf8");
const css = readAppStyles();
const generatorCss = readFileSync("src/components/VaultPasswordGenerator.css", "utf8");
const vaultCss = readFileSync("src/components/settings/VaultTab.css", "utf8");
const popoverBlock = css.match(/^\.vault-request-popover\s*\{[^}]+\}/m)?.[0] ?? "";
assert.ok(
  requestCenterComponent.includes('data-debug-id="header-vault-request-center"'),
  "Header must expose a stable Request Center debug id",
);
assert.ok(
  requestCenterComponent.includes('data-debug-id="vault-request-center-popover"'),
  "Request Center popover must expose a stable debug id",
);
assert.ok(
  requestCenterComponent.includes("Requests") &&
    requestCenterComponent.includes("No pending requests.") &&
    requestCenterComponent.includes('aria-label="Open requests"'),
  "Request Center uses generic user-facing approval language",
);
for (const id of [
  "vault-request-open-vault",
  "vault-request-new-secret",
  "vault-request-generate-password",
]) {
  assert.ok(
    requestCenterComponent.includes(`data-debug-id="${id}"`),
    `Request Center must expose ${id} quick action`,
  );
}
assert.ok(
  header.indexOf('data-debug-id="header-shellx-browser"') <
    header.indexOf('<HeaderVaultRequestCenter') &&
    header.indexOf('<HeaderVaultRequestCenter') <
    header.indexOf('aria-label="Open connector inbox"'),
  "Request Center icon must sit between Browser and Connector Inbox",
);
assert.ok(
  header.includes("HeaderVaultRequestCenter") &&
    !header.includes('data-debug-id="vault-request-center-popover"') &&
    !header.includes("vault-request-list"),
  "Header must delegate Request Center popover rendering to a focused component",
);
assert.ok(
  app.includes("vaultRequestCenter={vaultRequestCenter}"),
  "App must pass a global request summary into Header",
);
assert.ok(
  app.includes("onOpenVault={openVaultPanel}") &&
    app.includes("vaultPanelIntent") &&
    app.includes("vaultPanelIntentSeq"),
  "App must open the standalone Vault workspace with quick-action intent",
);
assert.ok(
  requestCenterComponent.includes("VaultPasswordGenerator") &&
    requestCenterComponent.includes("setVaultPasswordGeneratorOpen(true)") &&
    !requestCenterComponent.includes('onOpenVault("generatePassword")'),
  "Vault Request Center Generate must open the standalone generator instead of the full Vault workspace",
);
assert.ok(
  requestCenterComponent.includes('lazy(() => import("./VaultPasswordGenerator")') &&
    requestCenterComponent.includes('label="Password generator"') &&
    requestCenterComponent.includes('variant="inline"'),
  "header password generation must retain a recoverable on-demand boundary",
);
assert.ok(
  app.includes('"vaultRequestCenterOpen",'),
  "Vault Request Center debug open command must survive authoritative UI-state merge",
);
assert.ok(
  requestStateHook.includes('invoke<VaultGrantPromptSource[]>("shellx_vault_list_grants"') &&
    app.includes('"shellx_vault_approve_grant"') &&
    app.includes('"shellx_vault_revoke_grant"'),
  "App must list pending Vault grants and resolve them through operator-only Tauri commands",
);
assert.ok(
  requestStateHook.includes('invoke<VaultAgentRequestSnapshot>("shellx_vault_agent_request_center"') &&
    app.includes('"shellx_vault_agent_request_approve"') &&
    app.includes('"shellx_vault_agent_request_deny"'),
  "App must list and resolve digest-bound Vault executable requests through operator-only Tauri commands",
);
assert.ok(
  requestStateHook.includes("mergeVaultRequestCenterGrants") &&
    requestStateHook.includes('apiGet<{ grants?: VaultGrantPromptSource[] }>("/vault/grants")') &&
    !requestStateHook.includes('invoke<VaultGrantPromptSource[]>("shellx_vault_list_grants").catch(() => [])'),
  "Vault Request Center must merge Debug API grant state instead of hiding it behind an empty native fallback",
);
assert.ok(
  app.includes("useVaultRequestCenterState()") &&
    !app.includes("window.setInterval(() => void refresh(), 2500)") &&
    requestStateHook.includes("useEventAwarePolling({") &&
    requestStateHook.includes("intervalMs: 10_000") &&
    requestStateHook.includes('register<unknown>("browser-event"') &&
    requestStateHook.includes('register<unknown>("shellx:vault-status-invalidated"') &&
    requestStateHook.includes('document.addEventListener("visibilitychange"') &&
    eventPollingHook.includes("return run;"),
  "Request Center refreshes must be serialized, event-aware, visibility-aware, and manually refreshable",
);
assert.ok(
  requestCenterComponent.includes("useEventAwarePolling({") &&
    requestCenterComponent.includes('scopeKey: "header-vault-status"') &&
    requestCenterComponent.includes("intervalMs: 10_000") &&
    requestCenterComponent.includes('document.addEventListener("visibilitychange"') &&
    !requestCenterComponent.includes("window.setInterval(() => void refreshVaultStatus(), 10000)"),
  "Header Vault status must reuse serialized event-aware polling and pause while hidden",
);
for (const reason of [
  "grantCreated",
  "grantRevoked",
  "agentRequestCreated",
  "agentRequestCancelled",
]) {
  assert.ok(
    debugVaultApi.includes(`emit_vault_status_invalidated(&s, "${reason}")`),
    `Debug Vault mutation must invalidate Request Center state for ${reason}`,
  );
}
assert.ok(
  popoverBlock.includes("background: var(--surface") && !popoverBlock.includes("var(--surface-1)"),
  "Vault Request Center popover must render on an opaque defined surface",
);
assert.ok(
  css.includes(".vault-request-quick-actions") &&
    generatorCss.includes(".vault-password-generator") &&
    css.includes(".hdr-vault-request-icon.vault-open") &&
    css.includes(".hdr-vault-request-icon.vault-closed") &&
    vaultCss.includes(".vault-workspace-modal"),
  "Vault Request Center quick actions, generator, lock state, and standalone Vault workspace must have CSS",
);

console.log("Vault Request Center contract passed");
