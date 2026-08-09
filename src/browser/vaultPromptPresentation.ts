import type { ShellIconName } from "../components/icons";
import type { VaultApprovalPrompt } from "../lib/vault-approval-prompts";

export function vaultPromptIcon(prompt: VaultApprovalPrompt): ShellIconName {
  switch (prompt.kind) {
    case "sessionGrant":
      return "lock";
    case "vaultDeposit":
      return "inbox";
    case "credentialFill":
    case "profileFill":
      return "user";
    case "emailCodeRead":
      return "message";
    case "agentWalletUse":
      return "shield-alert";
  }
}

export function vaultPromptDebugSuffix(prompt: VaultApprovalPrompt): string {
  return prompt.id.replace(/[^a-z0-9_-]/gi, "-");
}

export function vaultPromptEntityId(prompt: VaultApprovalPrompt, prefix: string): string {
  return prompt.id.startsWith(prefix) ? prompt.id.slice(prefix.length) : "";
}
