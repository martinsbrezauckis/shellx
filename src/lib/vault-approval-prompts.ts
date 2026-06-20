export type VaultApprovalPromptKind =
  | "sessionGrant"
  | "vaultDeposit"
  | "credentialFill"
  | "profileFill"
  | "emailCodeRead"
  | "agentWalletUse";

export type VaultApprovalPromptTone = "neutral" | "attention" | "danger" | "success";

export interface VaultPromptAction {
  kind: string;
  label: string;
}

export interface VaultApprovalPrompt {
  id: string;
  kind: VaultApprovalPromptKind;
  title: string;
  summary: string;
  detailLines: string[];
  status: string;
  tone: VaultApprovalPromptTone;
  createdAtMs: number;
  taskId?: string | null;
  primaryAction?: VaultPromptAction;
  secondaryAction?: VaultPromptAction;
}

export interface BrowserSessionGrantPromptSource {
  grantId: string;
  taskId?: string | null;
  fromProfileId: string;
  toProfileId: string;
  reason: string;
  status: string;
  ttlSeconds?: number | null;
  createdAtMs: number;
  resolvedAtMs?: number | null;
  appliedAtMs?: number | null;
}

export interface BrowserVaultDepositPromptSource {
  depositId: string;
  label: string;
  storageCommitHash: string;
  secretExposed: boolean;
  taskId?: string | null;
  sourceUrl?: string | null;
  createdAtMs?: number | null;
  serverReceipt?: { createdMs?: number | null } | null;
  receipt?: { t?: number | null } | null;
}

export interface VaultApprovalPromptInput {
  sessionGrants?: BrowserSessionGrantPromptSource[];
  vaultDeposits?: BrowserVaultDepositPromptSource[];
  dismissedDepositIds?: ReadonlySet<string>;
}

export function buildVaultApprovalPrompts(input: VaultApprovalPromptInput): VaultApprovalPrompt[] {
  const prompts: VaultApprovalPrompt[] = [];

  for (const grant of input.sessionGrants ?? []) {
    if (normalizeStatus(grant.status) !== "requested") continue;
    prompts.push(buildSessionGrantPrompt(grant));
  }

  for (const deposit of input.vaultDeposits ?? []) {
    if (input.dismissedDepositIds?.has(deposit.depositId)) continue;
    prompts.push(buildVaultDepositPrompt(deposit));
  }

  return prompts.sort((a, b) => {
    if (a.tone !== b.tone) return tonePriority(b.tone) - tonePriority(a.tone);
    return b.createdAtMs - a.createdAtMs;
  });
}

export function vaultPromptSummaryText(prompts: readonly VaultApprovalPrompt[]): string {
  if (prompts.length === 0) return "Vault ready";
  if (prompts.length === 1) return "1 Vault prompt";
  return `${prompts.length} Vault prompts`;
}

function buildSessionGrantPrompt(grant: BrowserSessionGrantPromptSource): VaultApprovalPrompt {
  const ttl = formatTtl(grant.ttlSeconds);
  const reason = cleanText(grant.reason) || "Agent requested temporary session access.";
  return {
    id: `session-grant:${grant.grantId}`,
    kind: "sessionGrant",
    title: "Approve session access",
    summary: reason,
    detailLines: [
      `${cleanText(grant.fromProfileId) || "source"} -> ${cleanText(grant.toProfileId) || "agent"}`,
      ttl ? `Allowed for ${ttl}` : "One-time grant",
      "ShellX shares session authority, not raw cookies.",
    ],
    status: "requested",
    tone: "attention",
    createdAtMs: grant.createdAtMs,
    taskId: grant.taskId ?? null,
    primaryAction: { kind: "approveSessionGrant", label: "Approve" },
    secondaryAction: { kind: "denySessionGrant", label: "Deny" },
  };
}

function buildVaultDepositPrompt(deposit: BrowserVaultDepositPromptSource): VaultApprovalPrompt {
  const label = cleanText(deposit.label) || "Saved credential";
  const origin = originFromUrl(deposit.sourceUrl);
  const lines = [
    origin ? `From ${origin}` : "Saved from browser",
    deposit.secretExposed ? "Review required: page exposed the value." : "Secret value stayed inside ShellX Vault.",
  ];
  if (deposit.taskId) lines.push(`Task ${cleanText(deposit.taskId)}`);

  return {
    id: `vault-deposit:${deposit.depositId}`,
    kind: "vaultDeposit",
    title: "Review saved credential",
    summary: label,
    detailLines: lines,
    status: deposit.secretExposed ? "needsReview" : "saved",
    tone: deposit.secretExposed ? "attention" : "neutral",
    createdAtMs: depositCreatedAtMs(deposit),
    taskId: deposit.taskId ?? null,
    primaryAction: { kind: "openVault", label: "Open Vault" },
    secondaryAction: { kind: "dismissDeposit", label: "Done" },
  };
}

function depositCreatedAtMs(deposit: BrowserVaultDepositPromptSource): number {
  for (const candidate of [deposit.createdAtMs, deposit.serverReceipt?.createdMs, deposit.receipt?.t]) {
    if (typeof candidate === "number" && Number.isFinite(candidate) && candidate > 0) return candidate;
  }
  return 0;
}

function normalizeStatus(value: string): string {
  return cleanText(value).toLowerCase();
}

function cleanText(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.trim().replace(/\s+/g, " ");
}

function formatTtl(seconds?: number | null): string | null {
  if (!Number.isFinite(seconds) || !seconds || seconds <= 0) return null;
  if (seconds < 60) return `${seconds} seconds`;
  if (seconds < 3600) {
    const minutes = Math.round(seconds / 60);
    return minutes === 1 ? "1 minute" : `${minutes} minutes`;
  }
  if (seconds < 86_400) {
    const hours = Math.round(seconds / 3600);
    return hours === 1 ? "1 hour" : `${hours} hours`;
  }
  const days = Math.round(seconds / 86_400);
  return days === 1 ? "1 day" : `${days} days`;
}

function originFromUrl(url?: string | null): string | null {
  const raw = cleanText(url);
  if (!raw) return null;
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
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
