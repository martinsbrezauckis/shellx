type JsonObject = Record<string, unknown>;

export type BrowserEvidenceKind = "browserFlightRecorderExported" | "browserEvaluationReportWritten";

export interface BrowserEvidenceIdentity {
  attemptId?: string;
  reportId?: string;
  taskId?: string;
  bytes: number;
  sha256: string;
  events?: number;
  receipts?: number;
  droppedEvents?: number;
  droppedReceipts?: number;
  retentionDroppedEvents?: number;
  retentionDroppedReceipts?: number;
  sanitizerLossCount?: number;
  gapCount?: number;
  baselineAttempts?: number;
  candidateAttempts?: number;
  safetyViolationDelta?: number;
  improvementScore?: number;
  improvementRating?: string;
  evidenceComplete?: boolean;
}

export interface BrowserEvidenceRow {
  receiptId: string;
  kind: BrowserEvidenceKind;
  taskId?: string;
  recordedAtMs: number;
  identity: BrowserEvidenceIdentity;
}

export interface BrowserEvidenceSummary {
  rows: BrowserEvidenceRow[];
  callerScoped: boolean;
  durableRecovered: number;
  durableScanTruncated: boolean;
  durableScanFailed: boolean;
  durableSkipped: number;
  schemas: {
    attempt: string;
    evaluation: string;
    ratingPolicy: string;
  };
}

export interface BrowserFlightRecorderResult {
  attemptId: string;
  taskId?: string;
  bytes: number;
  sha256: string;
  events: number;
  receipts: number;
  gapCount: number;
  sanitizerLossCount: number;
  evidenceComplete: boolean;
  createdAtMs: number;
}

function objectValue(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as JsonObject;
}

function stringValue(value: JsonObject, key: string, label: string): string {
  const result = value[key];
  if (typeof result !== "string" || !result.trim()) throw new Error(`${label}.${key} is invalid.`);
  return result;
}

function optionalString(value: JsonObject, key: string, label: string): string | undefined {
  const result = value[key];
  if (result === undefined || result === null) return undefined;
  if (typeof result !== "string" || !result.trim()) throw new Error(`${label}.${key} is invalid.`);
  return result;
}

function numberValue(value: JsonObject, key: string, label: string): number {
  const result = value[key];
  if (typeof result !== "number" || !Number.isFinite(result) || result < 0) {
    throw new Error(`${label}.${key} is invalid.`);
  }
  return result;
}

function optionalNumber(value: JsonObject, key: string, label: string): number | undefined {
  const result = value[key];
  if (result === undefined || result === null) return undefined;
  if (typeof result !== "number" || !Number.isFinite(result)) throw new Error(`${label}.${key} is invalid.`);
  return result;
}

function optionalBoolean(value: JsonObject, key: string, label: string): boolean | undefined {
  const result = value[key];
  if (result === undefined || result === null) return undefined;
  if (typeof result !== "boolean") throw new Error(`${label}.${key} is invalid.`);
  return result;
}

function booleanValue(value: JsonObject, key: string, label: string): boolean {
  const result = value[key];
  if (typeof result !== "boolean") throw new Error(`${label}.${key} is invalid.`);
  return result;
}

function evidenceKind(value: unknown, label: string): BrowserEvidenceKind {
  if (value === "browserFlightRecorderExported" || value === "browserEvaluationReportWritten") return value;
  throw new Error(`${label}.kind is not a supported recorder receipt.`);
}

function normalizeIdentity(value: unknown, kind: BrowserEvidenceKind, label: string): BrowserEvidenceIdentity {
  const identity = objectValue(value, `${label}.evidence`);
  const sha256 = stringValue(identity, "sha256", `${label}.evidence`).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error(`${label}.evidence.sha256 is invalid.`);
  const attemptId = optionalString(identity, "attemptId", `${label}.evidence`);
  const reportId = optionalString(identity, "reportId", `${label}.evidence`);
  if (kind === "browserFlightRecorderExported" && !attemptId) throw new Error(`${label} has no attempt identity.`);
  if (kind === "browserEvaluationReportWritten" && !reportId) throw new Error(`${label} has no report identity.`);
  return {
    attemptId,
    reportId,
    taskId: optionalString(identity, "taskId", `${label}.evidence`),
    bytes: numberValue(identity, "bytes", `${label}.evidence`),
    sha256,
    events: optionalNumber(identity, "events", `${label}.evidence`),
    receipts: optionalNumber(identity, "receipts", `${label}.evidence`),
    droppedEvents: optionalNumber(identity, "droppedEvents", `${label}.evidence`),
    droppedReceipts: optionalNumber(identity, "droppedReceipts", `${label}.evidence`),
    retentionDroppedEvents: optionalNumber(identity, "retentionDroppedEvents", `${label}.evidence`),
    retentionDroppedReceipts: optionalNumber(identity, "retentionDroppedReceipts", `${label}.evidence`),
    sanitizerLossCount: optionalNumber(identity, "sanitizerLossCount", `${label}.evidence`),
    gapCount: optionalNumber(identity, "gapCount", `${label}.evidence`),
    baselineAttempts: optionalNumber(identity, "baselineAttempts", `${label}.evidence`),
    candidateAttempts: optionalNumber(identity, "candidateAttempts", `${label}.evidence`),
    safetyViolationDelta: optionalNumber(identity, "safetyViolationDelta", `${label}.evidence`),
    improvementScore: optionalNumber(identity, "improvementScore", `${label}.evidence`),
    improvementRating: optionalString(identity, "improvementRating", `${label}.evidence`),
    evidenceComplete: optionalBoolean(identity, "evidenceComplete", `${label}.evidence`),
  };
}

export function normalizeBrowserEvidenceSummary(value: unknown): BrowserEvidenceSummary {
  const summary = objectValue(value, "Browser evidence response");
  if (summary.ok !== true) throw new Error("Browser evidence response is not successful.");
  if (typeof summary.callerScoped !== "boolean") throw new Error("Browser evidence caller scope is invalid.");
  const schemas = objectValue(summary.schemas, "Browser evidence schemas");
  const recent = summary.recent;
  if (!Array.isArray(recent) || recent.length > 20) throw new Error("Browser evidence rows are invalid or unbounded.");
  const rows = recent.map((entry, index) => {
    const label = `Browser evidence row ${index + 1}`;
    const row = objectValue(entry, label);
    const kind = evidenceKind(row.kind, label);
    const recordedAtMs = numberValue(row, "t", label);
    return {
      receiptId: stringValue(row, "receiptId", label),
      kind,
      taskId: optionalString(row, "taskId", label),
      recordedAtMs,
      identity: normalizeIdentity(row.evidence, kind, label),
    };
  });
  return {
    rows,
    callerScoped: summary.callerScoped,
    durableRecovered: numberValue(summary, "durableRecovered", "Browser evidence response"),
    durableScanTruncated: booleanValue(summary, "durableScanTruncated", "Browser evidence response"),
    durableScanFailed: booleanValue(summary, "durableScanFailed", "Browser evidence response"),
    durableSkipped: numberValue(summary, "durableSkipped", "Browser evidence response"),
    schemas: {
      attempt: stringValue(schemas, "attempt", "Browser evidence schemas"),
      evaluation: stringValue(schemas, "evaluation", "Browser evidence schemas"),
      ratingPolicy: stringValue(schemas, "ratingPolicy", "Browser evidence schemas"),
    },
  };
}

export function normalizeBrowserFlightRecorderResult(value: unknown): BrowserFlightRecorderResult {
  const artifact = objectValue(value, "Browser Flight Recorder response");
  const sha256 = stringValue(artifact, "sha256", "Browser Flight Recorder response").toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(sha256)) {
    throw new Error("Browser Flight Recorder response.sha256 is invalid.");
  }
  return {
    attemptId: stringValue(artifact, "attemptId", "Browser Flight Recorder response"),
    taskId: optionalString(artifact, "taskId", "Browser Flight Recorder response"),
    bytes: numberValue(artifact, "bytes", "Browser Flight Recorder response"),
    sha256,
    events: numberValue(artifact, "events", "Browser Flight Recorder response"),
    receipts: numberValue(artifact, "receipts", "Browser Flight Recorder response"),
    gapCount: numberValue(artifact, "gapCount", "Browser Flight Recorder response"),
    sanitizerLossCount: numberValue(artifact, "sanitizerLossCount", "Browser Flight Recorder response"),
    evidenceComplete: booleanValue(artifact, "evidenceComplete", "Browser Flight Recorder response"),
    createdAtMs: numberValue(artifact, "createdAtMs", "Browser Flight Recorder response"),
  };
}
