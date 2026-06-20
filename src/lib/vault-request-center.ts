import type { RawEventFrame } from "../types/acp";
import { groupEvents, type PermissionGroup } from "./grouping";
import {
  buildVaultApprovalPrompts,
  type BrowserSessionGrantPromptSource,
  type BrowserVaultDepositPromptSource,
  type VaultApprovalPrompt,
  type VaultApprovalPromptTone,
} from "./vault-approval-prompts";

export const VAULT_REQUEST_CENTER_DISMISSED_DEPOSITS_KEY =
  "shellX.vaultRequestCenter.dismissedDeposits.v1";

export type VaultRequestCenterItemKind =
  | "sessionPermission"
  | "browserSessionGrant"
  | "browserVaultDeposit"
  | "vaultGrant";

export type VaultRequestCenterActionKind =
  | "allowPermission"
  | "denyPermission"
  | "focusSession"
  | "approveBrowserGrant"
  | "denyBrowserGrant"
  | "approveVaultGrant"
  | "denyVaultGrant"
  | "openVault"
  | "dismissDeposit";

export interface VaultRequestCenterAction {
  kind: VaultRequestCenterActionKind;
  label: string;
}

export interface VaultRequestCenterItem {
  id: string;
  kind: VaultRequestCenterItemKind;
  title: string;
  summary: string;
  detailLines: string[];
  createdAtMs: number;
  tone: VaultApprovalPromptTone;
  sourceLabel: string;
  requestId?: string;
  tabId?: string | null;
  tabTitle?: string | null;
  toolName?: string;
  grantId?: string;
  depositId?: string;
  primaryAction: VaultRequestCenterAction;
  secondaryAction?: VaultRequestCenterAction;
  tertiaryAction?: VaultRequestCenterAction;
}

export interface VaultSessionTabSource {
  tabId: string;
  title?: string | null;
}

export interface VaultSessionPermissionRequest {
  requestId: string;
  tabId: string | null;
  tabTitle: string | null;
  toolName: string;
  toolArgs: string;
  cwd?: string;
  createdAtMs: number;
}

export interface VaultRequestCenterInput {
  sessionPermissions?: VaultSessionPermissionRequest[];
  browserSessionGrants?: BrowserSessionGrantPromptSource[];
  browserVaultDeposits?: BrowserVaultDepositPromptSource[];
  vaultGrants?: VaultGrantPromptSource[];
  dismissedDepositIds?: ReadonlySet<string>;
}

export interface VaultGrantPromptSource {
  grantId: string;
  secretRef: string;
  actorScope: string;
  operation: string;
  createdAtMs?: number | null;
  expiresAtMs?: number | null;
  revoked: boolean;
  approved: boolean;
}

const VAULT_PERMISSION_KEYWORDS = [
  "vault",
  "secret",
  "credential",
  "password",
  "passkey",
  "browser_fill",
  "browser-fill",
  "browser fill",
  "profile",
  "email_code",
  "email-code",
  "email code",
  "agent_wallet",
  "agent-wallet",
  "agent wallet",
  "stripe",
  "oauth",
  "api key",
  "apikey",
  "token",
];

export function extractVaultPermissionRequests(
  events: readonly RawEventFrame[],
  tabs: readonly VaultSessionTabSource[],
): VaultSessionPermissionRequest[] {
  const tabSources =
    tabs.length > 0 ? tabs : [{ tabId: "default", title: "Session" }];
  const byRequestId = new Map<string, VaultSessionPermissionRequest>();

  for (const tab of tabSources) {
    const tabEvents = events.filter((event) => {
      const tabId = eventTabId(event);
      if (tabId === tab.tabId) return true;
      return tabSources.length === 1 && !tabId;
    });
    for (const group of groupEvents(tabEvents)) {
      if (group.kind !== "permission") continue;
      if (!group.pending) continue;
      if (!isVaultLikePermission(group)) continue;
      const existing = byRequestId.get(group.requestId);
      const createdAtMs = Number.isFinite(group.t) ? group.t : Date.now();
      if (existing && existing.createdAtMs >= createdAtMs) continue;
      byRequestId.set(group.requestId, {
        requestId: group.requestId,
        tabId: tab.tabId,
        tabTitle: cleanText(tab.title) || null,
        toolName: group.toolName,
        toolArgs: group.toolArgs,
        cwd: group.cwd,
        createdAtMs,
      });
    }
  }

  return Array.from(byRequestId.values()).sort((a, b) => b.createdAtMs - a.createdAtMs);
}

export function buildVaultRequestCenterItems(input: VaultRequestCenterInput): VaultRequestCenterItem[] {
  const items: VaultRequestCenterItem[] = [];

  for (const permission of input.sessionPermissions ?? []) {
    items.push({
      id: `session-permission:${permission.requestId}`,
      kind: "sessionPermission",
      title: "Approve Vault access",
      summary: [permission.tabTitle, permission.toolName].filter(Boolean).join(" · "),
      detailLines: [
        permission.toolArgs,
        permission.cwd ? `cwd: ${permission.cwd}` : "",
      ].filter(Boolean),
      createdAtMs: permission.createdAtMs,
      tone: "attention",
      sourceLabel: "Session",
      requestId: permission.requestId,
      tabId: permission.tabId,
      tabTitle: permission.tabTitle,
      toolName: permission.toolName,
      primaryAction: { kind: "allowPermission", label: "Allow" },
      secondaryAction: { kind: "denyPermission", label: "Deny" },
      tertiaryAction: { kind: "focusSession", label: "Focus" },
    });
  }

  const browserPrompts = buildVaultApprovalPrompts({
    sessionGrants: input.browserSessionGrants,
    vaultDeposits: input.browserVaultDeposits,
    dismissedDepositIds: input.dismissedDepositIds,
  });

  for (const prompt of browserPrompts) {
    const item = requestFromBrowserPrompt(prompt);
    if (item) items.push(item);
  }

  for (const grant of input.vaultGrants ?? []) {
    if (grant.revoked || grant.approved) continue;
    items.push(requestFromPendingVaultGrant(grant));
  }

  return items.sort((a, b) => {
    if (a.tone !== b.tone) return tonePriority(b.tone) - tonePriority(a.tone);
    return b.createdAtMs - a.createdAtMs;
  });
}

function requestFromPendingVaultGrant(grant: VaultGrantPromptSource): VaultRequestCenterItem {
  const expires = formatGrantExpiry(grant.expiresAtMs);
  return {
    id: `vault-grant:${grant.grantId}`,
    kind: "vaultGrant",
    title: "Approve Vault grant",
    summary: cleanText(grant.secretRef) || "Vault secret",
    detailLines: [
      `Operation: ${formatGrantOperation(grant.operation)}`,
      `Scope: ${cleanText(grant.actorScope) || "unknown"}`,
      expires,
      "The agent can use this only after operator approval.",
    ].filter(Boolean),
    createdAtMs: Number.isFinite(grant.createdAtMs ?? NaN) ? Number(grant.createdAtMs) : 0,
    tone: "attention",
    sourceLabel: "Vault",
    grantId: grant.grantId,
    primaryAction: { kind: "approveVaultGrant", label: "Approve" },
    secondaryAction: { kind: "denyVaultGrant", label: "Deny" },
  };
}

export function vaultRequestSummaryText(requests: readonly VaultRequestCenterItem[]): string {
  if (requests.length === 0) return "Vault ready";
  if (requests.length === 1) return "1 Vault request";
  return `${requests.length} Vault requests`;
}

export function loadDismissedVaultDepositIds(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(VAULT_REQUEST_CENTER_DISMISSED_DEPOSITS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((value): value is string => typeof value === "string" && value.length > 0));
  } catch {
    return new Set();
  }
}

export function storeDismissedVaultDepositIds(ids: ReadonlySet<string>): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      VAULT_REQUEST_CENTER_DISMISSED_DEPOSITS_KEY,
      JSON.stringify(Array.from(ids).sort()),
    );
  } catch {
    // localStorage can be disabled in preview/test contexts.
  }
}

function requestFromBrowserPrompt(prompt: VaultApprovalPrompt): VaultRequestCenterItem | null {
  if (prompt.kind === "sessionGrant") {
    const grantId = prompt.id.replace(/^session-grant:/, "");
    return {
      id: `browser-session-grant:${grantId}`,
      kind: "browserSessionGrant",
      title: prompt.title,
      summary: prompt.summary,
      detailLines: prompt.detailLines,
      createdAtMs: prompt.createdAtMs,
      tone: prompt.tone,
      sourceLabel: "Browser",
      grantId,
      primaryAction: { kind: "approveBrowserGrant", label: "Approve" },
      secondaryAction: { kind: "denyBrowserGrant", label: "Deny" },
    };
  }
  if (prompt.kind === "vaultDeposit") {
    const depositId = prompt.id.replace(/^vault-deposit:/, "");
    return {
      id: `browser-vault-deposit:${depositId}`,
      kind: "browserVaultDeposit",
      title: prompt.title,
      summary: prompt.summary,
      detailLines: prompt.detailLines,
      createdAtMs: prompt.createdAtMs,
      tone: prompt.tone,
      sourceLabel: "Browser",
      depositId,
      primaryAction: { kind: "openVault", label: "Open Vault" },
      secondaryAction: { kind: "dismissDeposit", label: "Done" },
    };
  }
  return null;
}

function isVaultLikePermission(group: PermissionGroup): boolean {
  const haystack = [
    group.toolName,
    group.toolArgs,
    group.cwd,
  ].filter(Boolean).join(" ").toLowerCase();
  return VAULT_PERMISSION_KEYWORDS.some((keyword) => haystack.includes(keyword));
}

function formatGrantOperation(operation: string): string {
  switch (operation) {
    case "Fill":
    case "fill":
      return "Browser fill";
    case "ProfileFill":
    case "profileFill":
      return "Profile fill";
    case "EmailCodeRead":
    case "emailCodeRead":
      return "Email code";
    case "AgentWalletUse":
    case "agentWalletUse":
      return "Agent wallet";
    case "ProviderUse":
    case "providerUse":
      return "Provider use";
    case "ConnectorUse":
    case "connectorUse":
      return "Connector use";
    case "InjectEnv":
    case "injectEnv":
      return "Inject env";
    case "Deposit":
    case "deposit":
      return "Deposit";
    case "RawReveal":
    case "rawReveal":
      return "Raw reveal";
    default:
      return cleanText(operation) || "Use";
  }
}

function formatGrantExpiry(expiresAtMs?: number | null): string {
  if (!expiresAtMs) return "No expiry";
  const remainingMs = expiresAtMs - Date.now();
  if (remainingMs <= 0) return "Expired";
  const minutes = Math.max(1, Math.ceil(remainingMs / 60000));
  if (minutes < 60) return `Expires in ${minutes}m`;
  const hours = Math.ceil(minutes / 60);
  return `Expires in ${hours}h`;
}

function eventTabId(event: RawEventFrame): string | null {
  const payload = event.payload;
  if (!payload || typeof payload !== "object") return null;
  const meta = (payload as { _meta?: unknown })._meta;
  if (meta && typeof meta === "object") {
    const tabId = (meta as { tabId?: unknown }).tabId;
    if (typeof tabId === "string" && tabId.length > 0) return tabId;
  }
  const params = (payload as { params?: unknown }).params;
  if (params && typeof params === "object") {
    const paramsMeta = (params as { _meta?: unknown })._meta;
    if (paramsMeta && typeof paramsMeta === "object") {
      const tabId = (paramsMeta as { tabId?: unknown }).tabId;
      if (typeof tabId === "string" && tabId.length > 0) return tabId;
    }
  }
  return null;
}

function cleanText(value: unknown): string {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
}

function tonePriority(tone: VaultApprovalPromptTone): number {
  switch (tone) {
    case "danger":
      return 4;
    case "attention":
      return 3;
    case "success":
      return 2;
    case "neutral":
      return 1;
  }
}
