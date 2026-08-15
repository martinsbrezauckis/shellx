export const TASK_TEACH_HANDOFF_EVENT = "shellx:task-teach-handoff";
export const TASK_TEACH_HANDOFF_RESULT_EVENT = "shellx:task-teach-handoff-result";

export interface BrowserTeachTaskHandoffRequest {
  draftId: string;
  revisionId: string;
  revisionSha256: string;
  recipeId: string;
  recipeSha256: string;
  approvalId: string;
  rehearsalReceiptId: string;
}

export interface BrowserTeachTaskHandoff {
  requestId: string;
  workflowId: string;
  workflowDigest: string;
  goal: string;
  ownerSessionId: string;
  browserTaskId: string;
  browserTabId: string;
  requiredVaultKeyIds: string[];
  requiredCapabilities: string[];
  receipt: {
    receiptId: string;
    kind: "browserTeachTaskHandoffPrepared";
    createdAtMs: number;
    sequence: number;
  };
}

export interface BrowserTeachTaskHandoffResult {
  requestId: string;
  ok: boolean;
  error?: string;
}

type JsonObject = Record<string, unknown>;

function objectValue(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

function boundedText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const clean = value.trim();
  if (!clean || clean.length > max || /[\u0000-\u001f\u007f]/.test(clean)) return null;
  return clean;
}

function identifier(value: unknown, max = 256): string | null {
  const clean = boundedText(value, max);
  return clean && /^[a-zA-Z0-9_.:-]+$/.test(clean) ? clean : null;
}

function sha256Id(value: unknown): string | null {
  const clean = boundedText(value, 71)?.toLowerCase();
  return clean && /^sha256:[a-f0-9]{64}$/.test(clean) ? clean : null;
}

function boundedList(value: unknown, maxItems: number): string[] | null {
  if (!Array.isArray(value) || value.length > maxItems) return null;
  const items = value.map((item) => boundedText(item, 256));
  if (items.some((item) => item === null)) return null;
  const unique = [...new Set(items as string[])];
  return unique.length === items.length ? unique : null;
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function normalizeBrowserTeachTaskHandoff(value: unknown): BrowserTeachTaskHandoff | null {
  const row = objectValue(value);
  const receipt = objectValue(row?.receipt);
  if (!row || !receipt) return null;
  const requestId = identifier(row.requestId);
  const workflowId = identifier(row.workflowId);
  const workflowDigest = sha256Id(row.workflowDigest);
  const goal = boundedText(row.goal, 300);
  const ownerSessionId = identifier(row.ownerSessionId);
  const browserTaskId = identifier(row.browserTaskId);
  const browserTabId = identifier(row.browserTabId);
  const requiredVaultKeyIds = boundedList(row.requiredVaultKeyIds, 16);
  const requiredCapabilities = boundedList(row.requiredCapabilities, 24);
  const receiptId = identifier(receipt.receiptId);
  const kind = boundedText(receipt.kind, 64);
  const createdAtMs = nonNegativeInteger(receipt.createdAtMs);
  const sequence = nonNegativeInteger(receipt.sequence);
  if (!requestId || !workflowId || !workflowDigest || !goal || !ownerSessionId
    || !browserTaskId || !browserTabId || !requiredVaultKeyIds || !requiredCapabilities
    || !receiptId || kind !== "browserTeachTaskHandoffPrepared"
    || createdAtMs === null || sequence === null) return null;
  return {
    requestId,
    workflowId,
    workflowDigest,
    goal,
    ownerSessionId,
    browserTaskId,
    browserTabId,
    requiredVaultKeyIds,
    requiredCapabilities,
    receipt: { receiptId, kind, createdAtMs, sequence },
  };
}

export function normalizeBrowserTeachTaskHandoffResult(
  value: unknown,
): BrowserTeachTaskHandoffResult | null {
  const row = objectValue(value);
  const requestId = identifier(row?.requestId);
  if (!row || !requestId || typeof row.ok !== "boolean") return null;
  const error = row.error === undefined ? undefined : boundedText(row.error, 280) ?? undefined;
  if (row.ok === false && !error) return null;
  return { requestId, ok: row.ok, error };
}

/**
 * Rebinds a renderer event to the exact native receipt, Browser task owner,
 * and durable workflow bookmark before the main workspace opens a draft.
 */
export function browserTeachTaskHandoffMatchesNativeState(
  handoff: BrowserTeachTaskHandoff,
  value: unknown,
): boolean {
  const exact = normalizeBrowserTeachTaskHandoff(handoff);
  const state = objectValue(value);
  if (!exact || !state || !Array.isArray(state.receipts)
    || !Array.isArray(state.tasks) || !Array.isArray(state.bookmarks)) return false;
  const taskOwned = state.tasks.some((value) => {
    const task = objectValue(value);
    return task?.taskId === exact.browserTaskId && task.ownerSessionId === exact.ownerSessionId;
  });
  const bookmarkPresent = state.bookmarks.some((value) => {
    const bookmark = objectValue(value);
    return bookmark?.bookmarkId === exact.workflowId;
  });
  const matchingReceipts = state.receipts.filter((value) => {
    const receipt = objectValue(value);
    const evidence = objectValue(receipt?.evidence);
    return receipt?.receiptId === exact.receipt.receiptId
      && receipt.kind === exact.receipt.kind
      && receipt.taskId === exact.browserTaskId
      && receipt.t === exact.receipt.createdAtMs
      && receipt.sequence === exact.receipt.sequence
      && evidence?.requestId === exact.requestId
      && evidence.workflowId === exact.workflowId
      && evidence.workflowDigest === exact.workflowDigest
      && evidence.goal === exact.goal
      && evidence.ownerSessionId === exact.ownerSessionId
      && evidence.browserTabId === exact.browserTabId
      && exactStringArray(evidence.requiredVaultKeyIds, exact.requiredVaultKeyIds)
      && exactStringArray(evidence.requiredCapabilities, exact.requiredCapabilities)
      && evidence.source === "shellx-browser-teach";
  });
  return taskOwned && bookmarkPresent && matchingReceipts.length === 1;
}

function exactStringArray(value: unknown, expected: string[]): boolean {
  return Array.isArray(value) && value.length === expected.length
    && value.every((item, index) => item === expected[index]);
}
