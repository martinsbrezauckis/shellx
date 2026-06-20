import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import { buildVaultApprovalPrompts, vaultPromptSummaryText } from "../src/lib/vault-approval-prompts";

const pendingGrant = {
  grantId: "browser-grant-1",
  taskId: "task-1",
  fromProfileId: "personal",
  toProfileId: "agent-work",
  reason: "Use the remembered Gmail session for Google Docs automation",
  status: "requested",
  ttlSeconds: 3600,
  createdAtMs: 1_717_000_000_000,
  resolvedAtMs: null,
  appliedAtMs: null,
};

const resolvedGrant = {
  ...pendingGrant,
  grantId: "browser-grant-2",
  status: "granted",
  resolvedAtMs: 1_717_000_100_000,
};

const newerPendingGrant = {
  ...pendingGrant,
  grantId: "browser-grant-3",
  reason: "Newest permission request should stay visible first",
  createdAtMs: 1_717_000_200_000,
};

const vaultDeposit = {
  depositId: "deposit-1",
  label: "Claude Code trial login",
  storageCommitHash: "sha256:super-sensitive-hash-value",
  secretExposed: false,
  taskId: "task-2",
  sourceUrl: "https://example.test/signup",
  serverReceipt: { createdMs: 1_717_000_300_000 },
};

const prompts = buildVaultApprovalPrompts({
  sessionGrants: [resolvedGrant, pendingGrant, newerPendingGrant],
  vaultDeposits: [vaultDeposit],
});

assert.equal(prompts.length, 3, "only active operator prompts should be returned");
assert.equal(
  prompts[0]?.id,
  "session-grant:browser-grant-3",
  "newer pending operator prompts should stay visible before stale pending prompts",
);

const grantPrompt = prompts.find((prompt) => prompt.id === "session-grant:browser-grant-1");
assert.ok(grantPrompt, "pending session grants should create an approval prompt");
assert.equal(grantPrompt.kind, "sessionGrant");
assert.equal(grantPrompt.title, "Approve session access");
assert.equal(grantPrompt.primaryAction?.label, "Approve");
assert.equal(grantPrompt.secondaryAction?.label, "Deny");
assert.equal(grantPrompt.tone, "attention");
assert.ok(
  grantPrompt.detailLines.includes("personal -> agent-work"),
  "session prompts should show the profile boundary",
);
assert.ok(
  grantPrompt.detailLines.some((line) => line.includes("1 hour")),
  "session prompts should format TTL for humans",
);

const depositPrompt = prompts.find((prompt) => prompt.id === "vault-deposit:deposit-1");
assert.ok(depositPrompt, "vault deposits should create a review prompt");
assert.equal(depositPrompt.kind, "vaultDeposit");
assert.equal(depositPrompt.title, "Review saved credential");
assert.equal(depositPrompt.createdAtMs, 1_717_000_300_000);
assert.equal(depositPrompt.primaryAction?.label, "Open Vault");
assert.equal(depositPrompt.secondaryAction?.label, "Done");
assert.equal(depositPrompt.tone, "neutral");
assert.ok(
  depositPrompt.summary.includes("Claude Code trial login"),
  "deposit prompts should use the saved credential label",
);

const visibleText = vaultPromptSummaryText(prompts);
assert.equal(visibleText, "3 Vault prompts");
for (const prompt of prompts) {
  const flattened = [prompt.title, prompt.summary, ...prompt.detailLines].join("\n");
  assert.ok(!flattened.includes("super-sensitive-hash-value"), "prompt copy must not expose storage commit hashes");
  assert.ok(!flattened.includes("sha256:"), "prompt copy must not expose storage commit hash prefixes");
}

const readyText = vaultPromptSummaryText(buildVaultApprovalPrompts({ sessionGrants: [], vaultDeposits: [] }));
assert.equal(readyText, "Vault ready");

const browserUi = readFileSync("src/components/ShellxBrowserApp.tsx", "utf8");
const agentSidebarUi = readFileSync("src/browser/components/AgentSidebar.tsx", "utf8");
const browserVaultPromptCards = readFileSync("src/browser/components/VaultPromptCards.tsx", "utf8");
const browserApi = readFileSync("src/browser/api.ts", "utf8");
assert.ok(
  browserVaultPromptCards.includes("data-debug-id=\"shellx-browser-vault-prompt-card\"") &&
    agentSidebarUi.includes("<VaultPromptCards"),
  "Browser right rail should render reusable Vault prompt cards through the extracted component",
);
assert.ok(
  browserApi.includes("shellx_browser_resolve_session_grant") &&
    browserUi.includes("resolveBrowserSessionGrant"),
  "Browser prompt cards should use the Tauri-only session grant resolver",
);
assert.ok(
  browserApi.includes("shellx_browser_open_vault_panel") &&
    browserUi.includes("openBrowserVaultPanel"),
  "Browser prompt cards should open the existing Vault panel through a native main-window bridge",
);
assert.ok(
  browserUi.includes("vaultPromptTaskId") &&
    browserUi.includes("scopedSessionGrants") &&
    browserUi.includes("scopedVaultDeposits"),
  "Browser prompt cards should be scoped to the active Browser task so stale prompts do not hide current task requests",
);

const browserRust = readFileSync("src-tauri/src/shellx_browser.rs", "utf8");
assert.ok(
  browserRust.includes("shellx_browser_resolve_session_grant"),
  "Browser registry should expose an operator-only Tauri session grant resolver",
);
assert.ok(
  browserRust.includes("shellx_browser_open_vault_panel"),
  "Browser registry should expose a Tauri bridge that opens the main Vault panel",
);

const debugApi = readFileSync("src-tauri/src/debug_api.rs", "utf8");
const debugApiBrowserSecurity = readFileSync("src-tauri/src/debug_api_browser_security.rs", "utf8");
assert.ok(
  [debugApi, debugApiBrowserSecurity].some((source) =>
    source.includes("browser session grant resolve is operator-only and unavailable over the Debug API"),
  ),
  "Debug API must remain unable to resolve sensitive session grants",
);

console.log("Vault approval prompt contract passed");
