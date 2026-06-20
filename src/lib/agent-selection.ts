import type { AutonomyMode } from "../components/Header";
import type { ProviderId, ProviderPermissionMode } from "./provider-sessions";

export type AgentId = "grok" | ProviderId;
export type AgentSelection = AgentId | null;

export interface AgentOption {
  id: AgentId;
  label: string;
  shortLabel: string;
  detail: string;
  kind: "native" | "provider";
}

export const AGENT_OPTIONS: AgentOption[] = [
  {
    id: "grok",
    label: "Grok",
    shortLabel: "Grok",
    detail: "Default ShellX chat, media tools, build flow, and Grok-native commands.",
    kind: "native",
  },
  {
    id: "claude-code",
    label: "Claude Code",
    shortLabel: "Claude",
    detail: "Run Claude Code CLI in this tab and stream the result into chat.",
    kind: "provider",
  },
  {
    id: "codex-cli",
    label: "Codex CLI",
    shortLabel: "Codex",
    detail: "Run Codex CLI in this tab with ShellX host tooling injected.",
    kind: "provider",
  },
  {
    id: "antigravity-cli",
    label: "Antigravity",
    shortLabel: "Antigravity",
    detail: "Run Antigravity CLI when available on this transport.",
    kind: "provider",
  },
];

export function normalizeAgentId(value: unknown): AgentId {
  return AGENT_OPTIONS.some((option) => option.id === value)
    ? value as AgentId
    : "grok";
}

export function normalizeAgentSelection(value: unknown): AgentSelection {
  return AGENT_OPTIONS.some((option) => option.id === value)
    ? value as AgentId
    : null;
}

export function agentDisplayName(agentId: AgentId | string | null | undefined): string {
  return AGENT_OPTIONS.find((option) => option.id === agentId)?.label
    ?? (typeof agentId === "string" && agentId.trim() ? agentId : "Unknown agent");
}

export function agentShortLabel(agentId: AgentId | string | null | undefined): string {
  return AGENT_OPTIONS.find((option) => option.id === agentId)?.shortLabel
    ?? (typeof agentId === "string" && agentId.trim() ? agentId : "Unknown");
}

export function agentSelectionShortLabel(agentId: AgentSelection): string {
  return agentId ? agentShortLabel(agentId) : "Choose";
}

export function isProviderAgent(agentId: AgentId): agentId is ProviderId {
  return agentId !== "grok";
}

export function providerPermissionModeForAutonomy(
  autonomy: AutonomyMode | null | undefined,
): ProviderPermissionMode {
  return autonomy === "bypassPermissions" ? "bypassPermissions" : "default";
}
