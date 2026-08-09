import type {
  AgentCliSetupFixture,
} from "../components/AgentCliSetupAssistant";
import type { ConnectionPreset } from "../components/ConnectionPicker";

export type DebugAgentCliSetupFixtureMode =
  | "closed"
  | "cards"
  | "confirmation"
  | "status-card"
  | "live-status"
  | "live-setup"
  | "install-lifecycle"
  | "clipboard-cards"
  | "clipboard-confirmation";
export const OWNED_AGENT_CLI_CLIPBOARD_COMMAND = "fixture-command-is-never-executed";

export const DEBUG_AGENT_CLI_SETUP_PRESET: ConnectionPreset = {
  id: "release-surface-agent-cli-setup",
  label: "Release surface owned target",
  transport: { kind: "local" },
  createdMs: 0,
  lastUsedMs: 0,
};

const target = {
  label: DEBUG_AGENT_CLI_SETUP_PRESET.label,
  transport: "local",
  commandRunsOn: "Owned synthetic target",
};

function missingProvider(
  providerId: "grok" | "claude-code" | "codex-cli" | "antigravity-cli",
  displayName: string,
): AgentCliSetupFixture["state"]["providers"][number] {
  return {
    providerId,
    displayName,
    status: "missing",
    canRun: false,
    checkedAtMs: 0,
    installable: true,
    recommendedMethodId: `owned-synthetic-${providerId}`,
    installMethods: [{
      id: `owned-synthetic-${providerId}`,
      label: "Synthetic fixture only",
      command: OWNED_AGENT_CLI_CLIPBOARD_COMMAND,
      shell: "none",
      transportKinds: ["local"],
    }],
    docsUrl: "https://example.invalid/shellx-agent-cli-setup",
    officialSourceUrl: "https://example.invalid/shellx-agent-cli-source",
    lastVerifiedAt: "1970-01-01T00:00:00.000Z",
    authHint: "No authentication is used by this synthetic fixture.",
    detail: "Synthetic release-surface state; provider probing is disabled.",
  };
}

const state = {
  generatedAtMs: 0,
  target,
  providers: [missingProvider("grok", "Owned synthetic CLI")],
} satisfies AgentCliSetupFixture["state"];

const statusState = {
  generatedAtMs: 0,
  target,
  providers: [
    missingProvider("grok", "Owned synthetic Grok CLI"),
    missingProvider("claude-code", "Owned synthetic Claude Code"),
    missingProvider("codex-cli", "Owned synthetic Codex CLI"),
    missingProvider("antigravity-cli", "Owned synthetic Antigravity CLI"),
  ],
} satisfies AgentCliSetupFixture["state"];

const installLifecycleState = {
  generatedAtMs: 0,
  target,
  providers: [{
    ...missingProvider("codex-cli", "Owned Codex CLI npm target"),
    recommendedMethodId: "npm",
    installMethods: [{
      id: "npm",
      label: "npm global package",
      command: "npm install -g @openai/codex",
      shell: "posix-or-cmd",
      transportKinds: ["local"],
      requiresNode: true,
    }],
  }],
} satisfies AgentCliSetupFixture["state"];

const cardsFixture: AgentCliSetupFixture = { state };
const statusFixture: AgentCliSetupFixture = { state: statusState };

const confirmationFixture: AgentCliSetupFixture = {
  state,
  confirmation: {
    confirmationId: "release-surface-agent-cli-confirmation",
    providerId: "grok",
    displayName: "Owned synthetic CLI",
    methodId: "owned-synthetic",
    methodLabel: "Synthetic fixture only",
    command: OWNED_AGENT_CLI_CLIPBOARD_COMMAND,
    shell: "none",
    target,
    expectedBinaries: ["fixture-binary-is-never-resolved"],
    docsUrl: "https://example.invalid/shellx-agent-cli-setup",
    officialSourceUrl: "https://example.invalid/shellx-agent-cli-source",
    warning: "Synthetic fixture only. Every external and provider action is disabled.",
    requiresConfirmation: true,
    createdAtMs: 0,
  },
};

export function normalizeDebugAgentCliSetupFixtureMode(
  value: unknown,
): DebugAgentCliSetupFixtureMode | null {
  return value === "closed" || value === "cards" || value === "confirmation"
    || value === "status-card" || value === "live-status" || value === "live-setup"
    || value === "install-lifecycle"
    || value === "clipboard-cards" || value === "clipboard-confirmation"
    ? value
    : null;
}

export function debugAgentCliSetupFixture(
  mode: Extract<DebugAgentCliSetupFixtureMode, "cards" | "confirmation" | "status-card" | "install-lifecycle" | "clipboard-cards" | "clipboard-confirmation">,
): AgentCliSetupFixture {
  if (mode === "install-lifecycle") return { state: installLifecycleState, allowOwnedInstall: true };
  if (mode === "clipboard-cards") return { ...cardsFixture, allowOwnedClipboard: true };
  if (mode === "clipboard-confirmation") return { ...confirmationFixture, allowOwnedClipboard: true };
  if (mode === "cards") return { ...cardsFixture, allowOwnedExternal: true };
  if (mode === "confirmation") return { ...confirmationFixture, allowOwnedExternal: true };
  return statusFixture;
}
