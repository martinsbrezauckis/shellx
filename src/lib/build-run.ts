import { invoke } from "@tauri-apps/api/core";

export type BuildRunStatus =
  | "draft"
  | "awaitingApproval"
  | "active"
  | "paused"
  | "blocked"
  | "transportFailed"
  | "budgetLimited"
  | "complete"
  | "halted";

export type BuildReceiptKind =
  | "runStarted"
  | "promptSent"
  | "runHalted"
  | "planWritten"
  | "planApproved"
  | "planRejected"
  | "checkpointCreated"
  | "fileWrite"
  | "fileDelete"
  | "fileCopy"
  | "commandObserved"
  | "agentStarted"
  | "agentCompleted"
  | "reviewCompleted"
  | "verificationCompleted"
  | "previewDiagnosed"
  | "blockerOpened"
  | "blockerResolved"
  | "completionRequested"
  | "completionAccepted"
  | "completionRejected"
  | "transportFailure";

export type BuildReceiptConfidence = "trustedHost" | "observedAcp" | "modelDeclared";

export interface BuildRunState {
  runId: string;
  tabId: string;
  objective: string;
  cwd: string;
  transportKind: string;
  scratchboardPath: string;
  status: BuildRunStatus;
  approvedPlanHash?: string | null;
  currentPhaseId?: string | null;
  continuationsTotal: number;
  noProgressCycles: number;
  createdAtMs: number;
  updatedAtMs: number;
  approvedAtMs?: number | null;
  lastContinuationAtMs?: number | null;
  checkpointId?: string | null;
  codeChanged: boolean;
  reviewRequired: boolean;
  reviewSatisfied: boolean;
  verificationRequired: boolean;
  verificationSatisfied: boolean;
  previewRequired?: boolean;
  previewSatisfied?: boolean;
  openBlocker?: string | null;
  lastReceiptId?: string | null;
}

export interface BuildReceipt {
  receiptId: string;
  runId: string;
  tabId: string;
  kind: BuildReceiptKind;
  createdAtMs: number;
  actor: string;
  summary: string;
  confidence: BuildReceiptConfidence;
  data: unknown;
}

export interface BuildStartResponse {
  state: BuildRunState;
  kickoffPrompt: string;
}

export interface BuildApprovalReadiness {
  ready: boolean;
  reason: string;
}

export function parseBuildCommand(prompt: string): string | null {
  const trimmed = prompt.trimStart();
  if (trimmed === "/build") return "";
  if (trimmed.startsWith("/build ")) return trimmed.slice(7).trim();
  if (trimmed === "/goal") return "";
  if (trimmed.startsWith("/goal ")) return trimmed.slice(6).trim();
  return null;
}

export function isBuildTerminalStatus(status: BuildRunStatus | undefined): boolean {
  return status === "complete" || status === "halted" || status === "transportFailed";
}

export function isBuildVisible(state: BuildRunState | null | undefined): state is BuildRunState {
  return Boolean(state && !isBuildTerminalStatus(state.status));
}

export function buildStatusLabel(status: BuildRunStatus | undefined): string {
  switch (status) {
    case "awaitingApproval": return "Awaiting approval";
    case "active": return "Active";
    case "paused": return "Paused";
    case "blocked": return "Blocked";
    case "transportFailed": return "Transport failed";
    case "budgetLimited": return "Budget limited";
    case "complete": return "Complete";
    case "halted": return "Halted";
    case "draft": return "Draft";
    default: return "Inactive";
  }
}

export function buildActionFailureMessage(action: string): string {
  return `Build action ${action} is not available for this run. Reconnect or start a fresh /build run.`;
}

export function buildApprovalReadinessFromText(text: string | null | undefined): BuildApprovalReadiness {
  const body = (text ?? "").trim();
  if (!body) {
    return { ready: false, reason: "Waiting for Grok to write the Build Mode scratchboard." };
  }
  if (body.includes("_grok is drafting the build plan")) {
    return { ready: false, reason: "Grok is still drafting the Build Mode plan." };
  }
  if (!/^Status:\s*AWAITING_APPROVAL\s*$/im.test(body)) {
    return { ready: false, reason: "Waiting for top-level Status: AWAITING_APPROVAL." };
  }
  if (!/^##\s+Phase\b/im.test(body)) {
    return { ready: false, reason: "Waiting for phased plan sections." };
  }
  if (!/^\s*-\s+\[\s\]/m.test(body)) {
    return { ready: false, reason: "Waiting for unchecked build steps." };
  }
  const lower = body.toLowerCase();
  const hasSlopGate =
    lower.includes("ai slop") &&
    lower.includes("wiring") &&
    lower.includes("fake success") &&
    (lower.includes("placeholder") || lower.includes("mock"));
  if (!hasSlopGate) {
    return { ready: false, reason: "Waiting for the AI slop / wiring audit gate." };
  }
  return { ready: true, reason: "Build plan is ready for review." };
}

export async function startBuildMode(tabId: string, objective: string, cwd: string): Promise<BuildStartResponse> {
  return invoke<BuildStartResponse>("start_build_mode", { tabId, objective, cwd });
}

export async function getBuildState(tabId: string): Promise<BuildRunState | null> {
  return invoke<BuildRunState | null>("get_build_state", { tabId });
}

export async function getBuildReceipts(tabId: string): Promise<BuildReceipt[]> {
  return invoke<BuildReceipt[]>("get_build_receipts", { tabId });
}
