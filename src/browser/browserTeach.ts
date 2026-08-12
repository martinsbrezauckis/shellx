import type { BrowserEvidenceRow, BrowserFlightRecorderResult } from "./browserEvidence";

export const BROWSER_TEACH_BUNDLE_SCHEMA = "sx.workflow-teach-bundle.v1";
export const BROWSER_TEACH_REVISION_SCHEMA = "sx.workflow-teach-revision.v1";

type JsonObject = Record<string, unknown>;

export type BrowserTeachStepClassification = "read" | "derive" | "action";

export interface BrowserTeachSourceCandidate {
  attemptId: string;
  taskId: string;
  createdAtMs: number;
  evidenceComplete: boolean;
  gapCount: number;
  sanitizerLossCount: number;
}

export type BrowserTeachSourceSelection =
  | { kind: "noTask" }
  | { kind: "loading" }
  | { kind: "recording" }
  | { kind: "noAttempt" }
  | { kind: "evidenceGapped"; candidate: BrowserTeachSourceCandidate }
  | { kind: "ready"; candidate: BrowserTeachSourceCandidate }
  | { kind: "unavailable"; message: string };

export interface BrowserTeachRedactionReceipt {
  sourceArtifactRedactionVerified: true;
  rawSecrets: false;
  cookies: false;
  headers: false;
  queryAndFragments: false;
  pageBodies: false;
  screenshots: false;
}

export interface BrowserTeachSourceIdentity {
  attemptId: string;
  taskId: string;
  browserTabId: string;
  bytes: number;
  sha256: string;
  createdAtMs: number;
  ownerSessionId: string;
  evidenceComplete: boolean;
}

export interface BrowserTeachReviewStep {
  stepId: string;
  sourceSequence: number;
  operation: string;
  classification: BrowserTeachStepClassification;
  valueIds: string[];
  evidenceCount: number;
}

export interface BrowserTeachReviewValue {
  valueId: string;
  label: string;
  kind: string;
  literal?: string;
  requiredVaultBinding: boolean;
  evidenceCount: number;
}

export interface BrowserTeachVaultBinding {
  valueId: string;
  bindingId?: string;
}

export interface BrowserTeachIssue {
  issueId: string;
  code: string;
  blocking: boolean;
  sourceSequence?: number;
  detail: string;
}

export interface BrowserTeachActionSummary {
  reads: number;
  derives: number;
  actions: number;
  assertions: number;
  decisionPoints: number;
  blockingIssues: number;
}

export interface BrowserTeachBundle {
  bundleId: string;
  sha256: string;
  bytes: number;
  source: BrowserTeachSourceIdentity;
  redactionReceipt: BrowserTeachRedactionReceipt;
  ambiguities: BrowserTeachIssue[];
  loss: BrowserTeachIssue[];
}

export interface BrowserTeachRevision {
  revisionId: string;
  revision: number;
  sha256: string;
  bundleId: string;
  bundleSha256: string;
  goal: string;
  steps: BrowserTeachReviewStep[];
  values: BrowserTeachReviewValue[];
  requiredVaultBindings: BrowserTeachVaultBinding[];
  requiredCapabilities: string[];
  ambiguityResolutions: string[];
  actionSummary: BrowserTeachActionSummary;
}

export interface BrowserTeachDraftSummary {
  draftId: string;
  bundleId: string;
  bundleSha256: string;
  taskId: string;
  browserTabId: string;
  attemptId: string;
  currentRevisionId: string;
  currentRevisionSha256: string;
  revision: number;
  stepCount: number;
  valueCount: number;
  blockingIssues: number;
  createdAtMs: number;
}

export interface BrowserTeachPreparedDraft {
  bundle: BrowserTeachBundle;
  revision: BrowserTeachRevision;
  draft: BrowserTeachDraftSummary;
  isCurrent: boolean;
}

export interface BrowserTeachPrepareRequest {
  attemptId: string;
}

export interface BrowserTeachValueEdit {
  valueId: string;
  label?: string;
  literal?: string;
}

export interface BrowserTeachReviseRequest {
  draftId: string;
  expectedRevisionId: string;
  expectedRevisionSha256: string;
  goal?: string;
  orderedStepIds?: string[];
  valueEdits?: BrowserTeachValueEdit[];
  vaultBindings?: BrowserTeachVaultBinding[];
  requiredCapabilities?: string[];
  ambiguityResolutions?: string[];
  revisionNote?: string;
}

export interface BrowserTeachApprovalRequest {
  draftId: string;
  revisionId: string;
  revisionSha256: string;
}

export interface BrowserTeachApproval {
  recipeId: string;
  recipeSha256: string;
  approvalId: string;
}

export interface BrowserTeachRehearsalRequest {
  recipeId: string;
  sha256: string;
}

export interface BrowserTeachRehearsal {
  recipeId: string;
  sha256: string;
  dryRun: true;
  stepsPlanned: number;
  stepsSkipped: number;
  stepsApplied: 0;
  receipt: {
    receiptId: string;
    kind: string;
    createdAtMs: number;
    sequence: number;
  };
}

function objectValue(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as JsonObject;
}

function stringValue(value: JsonObject, key: string, label: string, maxLength = 256): string {
  const result = value[key];
  if (typeof result !== "string" || !result.trim() || result.trim().length > maxLength) {
    throw new Error(`${label}.${key} is invalid.`);
  }
  return result.trim();
}

function optionalString(value: JsonObject, key: string, label: string, maxLength = 256): string | undefined {
  const result = value[key];
  if (result === undefined || result === null) return undefined;
  if (typeof result !== "string" || result.length > maxLength) throw new Error(`${label}.${key} is invalid.`);
  return result;
}

function numberValue(value: JsonObject, key: string, label: string): number {
  const result = value[key];
  if (typeof result !== "number" || !Number.isSafeInteger(result) || result < 0) {
    throw new Error(`${label}.${key} is invalid.`);
  }
  return result;
}

function booleanValue(value: JsonObject, key: string, label: string): boolean {
  const result = value[key];
  if (typeof result !== "boolean") throw new Error(`${label}.${key} is invalid.`);
  return result;
}

function boundedArray(value: JsonObject, key: string, label: string, maximum: number): unknown[] {
  const result = value[key];
  if (!Array.isArray(result) || result.length > maximum) throw new Error(`${label}.${key} is invalid or unbounded.`);
  return result;
}

function sha256Value(value: JsonObject, key: string, label: string): string {
  const sha256 = stringValue(value, key, label, 64).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error(`${label}.${key} is invalid.`);
  return sha256;
}

function oneOf<T extends string>(value: unknown, choices: readonly T[], label: string): T {
  if (typeof value === "string" && choices.includes(value as T)) return value as T;
  throw new Error(`${label} is invalid.`);
}

function identifier(value: unknown, label: string, maxLength = 240): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function displayCode(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(value)) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function normalizeRedactionReceipt(value: unknown): BrowserTeachRedactionReceipt {
  const receipt = objectValue(value, "Browser Teach bundle.redactionReceipt");
  const verified = booleanValue(receipt, "sourceArtifactRedactionVerified", "Browser Teach bundle.redactionReceipt");
  const rawSecrets = booleanValue(receipt, "rawSecrets", "Browser Teach bundle.redactionReceipt");
  const cookies = booleanValue(receipt, "cookies", "Browser Teach bundle.redactionReceipt");
  const headers = booleanValue(receipt, "headers", "Browser Teach bundle.redactionReceipt");
  const queryAndFragments = booleanValue(receipt, "queryAndFragments", "Browser Teach bundle.redactionReceipt");
  const pageBodies = booleanValue(receipt, "pageBodies", "Browser Teach bundle.redactionReceipt");
  const screenshots = booleanValue(receipt, "screenshots", "Browser Teach bundle.redactionReceipt");
  if (!verified || rawSecrets || cookies || headers || queryAndFragments || pageBodies || screenshots) {
    throw new Error("Browser Teach bundle has an unsafe redaction receipt.");
  }
  return {
    sourceArtifactRedactionVerified: true,
    rawSecrets: false,
    cookies: false,
    headers: false,
    queryAndFragments: false,
    pageBodies: false,
    screenshots: false,
  };
}

function normalizeSource(value: unknown): BrowserTeachSourceIdentity {
  const source = objectValue(value, "Browser Teach bundle.source");
  return {
    attemptId: identifier(source.attemptId, "Browser Teach bundle.source.attemptId", 200),
    taskId: identifier(source.taskId, "Browser Teach bundle.source.taskId", 200),
    browserTabId: identifier(source.browserTabId, "Browser Teach bundle.source.browserTabId", 200),
    bytes: numberValue(source, "bytes", "Browser Teach bundle.source"),
    sha256: sha256Value(source, "sha256", "Browser Teach bundle.source"),
    createdAtMs: numberValue(source, "createdAtMs", "Browser Teach bundle.source"),
    ownerSessionId: identifier(source.ownerSessionId, "Browser Teach bundle.source.ownerSessionId", 200),
    evidenceComplete: booleanValue(source, "evidenceComplete", "Browser Teach bundle.source"),
  };
}

function normalizeStep(value: unknown, index: number): BrowserTeachReviewStep {
  const step = objectValue(value, `Browser Teach step ${index + 1}`);
  const evidenceRefs = boundedArray(step, "evidenceRefs", `Browser Teach step ${index + 1}`, 256);
  return {
    stepId: identifier(step.stepId, `Browser Teach step ${index + 1}.stepId`),
    sourceSequence: numberValue(step, "sourceSequence", `Browser Teach step ${index + 1}`),
    operation: displayCode(step.operation, `Browser Teach step ${index + 1}.operation`),
    classification: oneOf(step.classification, ["read", "derive", "action"] as const, `Browser Teach step ${index + 1}.classification`),
    valueIds: boundedArray(step, "valueRefs", `Browser Teach step ${index + 1}`, 64)
      .map((valueId, valueIndex) => identifier(valueId, `Browser Teach step ${index + 1}.valueRefs ${valueIndex + 1}`)),
    evidenceCount: evidenceRefs.length,
  };
}

function normalizeValue(value: unknown, index: number): BrowserTeachReviewValue {
  const namedValue = objectValue(value, `Browser Teach value ${index + 1}`);
  return {
    valueId: identifier(namedValue.valueId, `Browser Teach value ${index + 1}.valueId`),
    label: stringValue(namedValue, "label", `Browser Teach value ${index + 1}`, 120),
    kind: displayCode(namedValue.kind, `Browser Teach value ${index + 1}.kind`),
    literal: optionalString(namedValue, "literal", `Browser Teach value ${index + 1}`, 240),
    requiredVaultBinding: booleanValue(namedValue, "requiredVaultBinding", `Browser Teach value ${index + 1}`),
    evidenceCount: boundedArray(namedValue, "sourceEvidenceRefs", `Browser Teach value ${index + 1}`, 256).length,
  };
}

function normalizeBinding(value: unknown, index: number): BrowserTeachVaultBinding {
  const binding = objectValue(value, `Browser Teach Vault binding ${index + 1}`);
  return {
    valueId: identifier(binding.valueId, `Browser Teach Vault binding ${index + 1}.valueId`),
    bindingId: optionalString(binding, "bindingId", `Browser Teach Vault binding ${index + 1}`, 200),
  };
}

function normalizeIssue(value: unknown, index: number, kind: string): BrowserTeachIssue {
  const issue = objectValue(value, `Browser Teach ${kind} ${index + 1}`);
  const sourceSequence = issue.sourceSequence === undefined || issue.sourceSequence === null
    ? undefined
    : numberValue(issue, "sourceSequence", `Browser Teach ${kind} ${index + 1}`);
  return {
    issueId: identifier(issue.issueId, `Browser Teach ${kind} ${index + 1}.issueId`),
    code: displayCode(issue.code, `Browser Teach ${kind} ${index + 1}.code`),
    blocking: booleanValue(issue, "blocking", `Browser Teach ${kind} ${index + 1}`),
    sourceSequence,
    detail: stringValue(issue, "detail", `Browser Teach ${kind} ${index + 1}`, 240),
  };
}

function normalizeActionSummary(value: unknown): BrowserTeachActionSummary {
  const summary = objectValue(value, "Browser Teach revision.actionSummary");
  return {
    reads: numberValue(summary, "reads", "Browser Teach revision.actionSummary"),
    derives: numberValue(summary, "derives", "Browser Teach revision.actionSummary"),
    actions: numberValue(summary, "actions", "Browser Teach revision.actionSummary"),
    assertions: numberValue(summary, "assertions", "Browser Teach revision.actionSummary"),
    decisionPoints: numberValue(summary, "decisionPoints", "Browser Teach revision.actionSummary"),
    blockingIssues: numberValue(summary, "blockingIssues", "Browser Teach revision.actionSummary"),
  };
}

function normalizeBundle(value: unknown): BrowserTeachBundle {
  const bundle = objectValue(value, "Browser Teach bundle");
  if (stringValue(bundle, "schemaVersion", "Browser Teach bundle", 64) !== BROWSER_TEACH_BUNDLE_SCHEMA) {
    throw new Error("Browser Teach bundle schema is unsupported.");
  }
  boundedArray(bundle, "steps", "Browser Teach bundle", 100).map(normalizeStep);
  boundedArray(bundle, "values", "Browser Teach bundle", 64).map(normalizeValue);
  return {
    bundleId: identifier(bundle.bundleId, "Browser Teach bundle.bundleId"),
    sha256: sha256Value(bundle, "sha256", "Browser Teach bundle"),
    bytes: numberValue(bundle, "bytes", "Browser Teach bundle"),
    source: normalizeSource(bundle.source),
    redactionReceipt: normalizeRedactionReceipt(bundle.redactionReceipt),
    ambiguities: boundedArray(bundle, "ambiguities", "Browser Teach bundle", 64).map((issue, index) => normalizeIssue(issue, index, "ambiguity")),
    loss: boundedArray(bundle, "loss", "Browser Teach bundle", 64).map((issue, index) => normalizeIssue(issue, index, "loss")),
  };
}

function normalizeRevision(value: unknown): BrowserTeachRevision {
  const revision = objectValue(value, "Browser Teach revision");
  if (stringValue(revision, "schemaVersion", "Browser Teach revision", 64) !== BROWSER_TEACH_REVISION_SCHEMA) {
    throw new Error("Browser Teach revision schema is unsupported.");
  }
  return {
    revisionId: identifier(revision.revisionId, "Browser Teach revision.revisionId"),
    revision: numberValue(revision, "revision", "Browser Teach revision"),
    sha256: sha256Value(revision, "sha256", "Browser Teach revision"),
    bundleId: identifier(revision.bundleId, "Browser Teach revision.bundleId"),
    bundleSha256: sha256Value(revision, "bundleSha256", "Browser Teach revision"),
    goal: stringValue(revision, "goal", "Browser Teach revision", 300),
    steps: boundedArray(revision, "steps", "Browser Teach revision", 100).map(normalizeStep),
    values: boundedArray(revision, "values", "Browser Teach revision", 64).map(normalizeValue),
    requiredVaultBindings: boundedArray(revision, "requiredVaultBindings", "Browser Teach revision", 64).map(normalizeBinding),
    requiredCapabilities: boundedArray(revision, "requiredCapabilities", "Browser Teach revision", 8)
      .map((capability, index) => displayCode(capability, `Browser Teach required capability ${index + 1}`)),
    ambiguityResolutions: boundedArray(revision, "ambiguityResolutions", "Browser Teach revision", 64)
      .map((issueId, index) => identifier(issueId, `Browser Teach ambiguity resolution ${index + 1}`)),
    actionSummary: normalizeActionSummary(revision.actionSummary),
  };
}

function normalizeDraftSummary(value: unknown): BrowserTeachDraftSummary {
  const draft = objectValue(value, "Browser Teach draft");
  return {
    draftId: identifier(draft.draftId, "Browser Teach draft.draftId"),
    bundleId: identifier(draft.bundleId, "Browser Teach draft.bundleId"),
    bundleSha256: sha256Value(draft, "bundleSha256", "Browser Teach draft"),
    taskId: identifier(draft.taskId, "Browser Teach draft.taskId", 200),
    browserTabId: identifier(draft.browserTabId, "Browser Teach draft.browserTabId", 200),
    attemptId: identifier(draft.attemptId, "Browser Teach draft.attemptId", 200),
    currentRevisionId: identifier(draft.currentRevisionId, "Browser Teach draft.currentRevisionId"),
    currentRevisionSha256: sha256Value(draft, "currentRevisionSha256", "Browser Teach draft"),
    revision: numberValue(draft, "revision", "Browser Teach draft"),
    stepCount: numberValue(draft, "stepCount", "Browser Teach draft"),
    valueCount: numberValue(draft, "valueCount", "Browser Teach draft"),
    blockingIssues: numberValue(draft, "blockingIssues", "Browser Teach draft"),
    createdAtMs: numberValue(draft, "createdAtMs", "Browser Teach draft"),
  };
}

function preparedDraft(bundle: BrowserTeachBundle, revision: BrowserTeachRevision, draft: BrowserTeachDraftSummary): BrowserTeachPreparedDraft {
  if (revision.bundleId !== bundle.bundleId || revision.bundleSha256 !== bundle.sha256) {
    throw new Error("Browser Teach revision is not bound to its source bundle.");
  }
  if (draft.bundleId !== bundle.bundleId || draft.bundleSha256 !== bundle.sha256
    || draft.taskId !== bundle.source.taskId || draft.browserTabId !== bundle.source.browserTabId || draft.attemptId !== bundle.source.attemptId) {
    throw new Error("Browser Teach draft summary does not match its source bundle.");
  }
  if (draft.stepCount !== revision.steps.length || draft.valueCount !== revision.values.length || draft.revision !== revision.revision) {
    throw new Error("Browser Teach draft summary does not match its revision.");
  }
  return {
    bundle,
    revision,
    draft,
    isCurrent: revision.revisionId === draft.currentRevisionId && revision.sha256 === draft.currentRevisionSha256,
  };
}

export function normalizeBrowserTeachPreparedDraft(value: unknown): BrowserTeachPreparedDraft {
  const response = objectValue(value, "Browser Teach prepare response");
  return preparedDraft(normalizeBundle(response.bundle), normalizeRevision(response.revision), normalizeDraftSummary(response.draft));
}

export function normalizeBrowserTeachRevisionResponse(value: unknown, bundle: BrowserTeachBundle): BrowserTeachPreparedDraft {
  const response = objectValue(value, "Browser Teach revise response");
  return preparedDraft(bundle, normalizeRevision(response.revision), normalizeDraftSummary(response.draft));
}

export function normalizeBrowserTeachApproval(value: unknown): BrowserTeachApproval {
  const response = objectValue(value, "Browser Teach approval response");
  const recipe = objectValue(response.recipe, "Browser Teach approval response.recipe");
  const approval = objectValue(response.approval, "Browser Teach approval response.approval");
  return {
    recipeId: identifier(recipe.recipeId, "Browser Teach approval response.recipe.recipeId"),
    recipeSha256: sha256Value(recipe, "sha256", "Browser Teach approval response.recipe"),
    approvalId: identifier(approval.approvalId, "Browser Teach approval response.approval.approvalId"),
  };
}

export function normalizeBrowserTeachRehearsal(value: unknown): BrowserTeachRehearsal {
  const response = objectValue(value, "Browser Teach rehearsal response");
  const dryRun = booleanValue(response, "dryRun", "Browser Teach rehearsal response");
  const stepsApplied = numberValue(response, "stepsApplied", "Browser Teach rehearsal response");
  if (!dryRun || stepsApplied !== 0) {
    throw new Error("Browser Teach rehearsal must be a dry run with no applied steps.");
  }
  const receipt = objectValue(response.receipt, "Browser Teach rehearsal response.receipt");
  return {
    recipeId: identifier(response.recipeId, "Browser Teach rehearsal response.recipeId"),
    sha256: sha256Value(response, "sha256", "Browser Teach rehearsal response"),
    dryRun: true,
    stepsPlanned: numberValue(response, "stepsPlanned", "Browser Teach rehearsal response"),
    stepsSkipped: numberValue(response, "stepsSkipped", "Browser Teach rehearsal response"),
    stepsApplied: 0,
    receipt: {
      receiptId: identifier(receipt.receiptId, "Browser Teach rehearsal response.receipt.receiptId"),
      kind: displayCode(receipt.kind, "Browser Teach rehearsal response.receipt.kind"),
      createdAtMs: numberValue(receipt, "createdAtMs", "Browser Teach rehearsal response.receipt"),
      sequence: numberValue(receipt, "sequence", "Browser Teach rehearsal response.receipt"),
    },
  };
}

export function browserTeachHasBlockingIssues(draft: BrowserTeachPreparedDraft): boolean {
  const resolutions = new Set(draft.revision.ambiguityResolutions);
  const unresolvedIssue = draft.bundle.ambiguities
    .some((issue) => issue.blocking && !resolutions.has(issue.issueId));
  const blockingLoss = draft.bundle.loss.some((issue) => issue.blocking);
  const missingBinding = draft.revision.values
    .filter((value) => value.requiredVaultBinding)
    .some((value) => !draft.revision.requiredVaultBindings.some((binding) => binding.valueId === value.valueId && Boolean(binding.bindingId?.trim())));
  return unresolvedIssue || blockingLoss || missingBinding || browserTeachHasIncompleteNavigationReplacement(draft);
}

function safeTeachNavigationLiteral(value: string | undefined): boolean {
  if (!value || value.length > 240 || value.toLowerCase().includes("[redacted-path]")) return false;
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    const privatePath = /(?:^|\/)\.shellx(?:\/|$)|(?:^|\/)browser-artifacts(?:\/|$)|%2f(?:\.shellx|browser-artifacts)/i.test(parsed.pathname);
    return (parsed.protocol === "http:" || parsed.protocol === "https:")
      && Boolean(host)
      && !parsed.username
      && !parsed.password
      && !parsed.search
      && !parsed.hash
      && !privatePath;
  } catch {
    return false;
  }
}

export function browserTeachHasIncompleteNavigationReplacement(draft: BrowserTeachPreparedDraft): boolean {
  const resolved = new Set(draft.revision.ambiguityResolutions);
  return draft.bundle.ambiguities
    .filter((issue) => issue.code === "redactedNavigationPath" && resolved.has(issue.issueId) && issue.sourceSequence !== undefined)
    .some((issue) => {
      const valueIds = draft.revision.steps
        .find((step) => step.operation === "navigate" && step.sourceSequence === issue.sourceSequence)
        ?.valueIds ?? [];
      return !valueIds.some((valueId) => safeTeachNavigationLiteral(draft.revision.values.find((value) => value.valueId === valueId)?.literal));
    });
}

function candidateFromEvidenceRow(row: BrowserEvidenceRow): BrowserTeachSourceCandidate | null {
  if (row.kind !== "browserFlightRecorderExported" || !row.taskId || !row.identity.attemptId) return null;
  return {
    attemptId: row.identity.attemptId,
    taskId: row.taskId,
    createdAtMs: row.recordedAtMs,
    evidenceComplete: row.identity.evidenceComplete === true,
    gapCount: row.identity.gapCount ?? 0,
    sanitizerLossCount: row.identity.sanitizerLossCount ?? 0,
  };
}

function candidateFromRecordedAttempt(recordedAttempt: BrowserFlightRecorderResult | null): BrowserTeachSourceCandidate | null {
  if (!recordedAttempt?.taskId) return null;
  return {
    attemptId: recordedAttempt.attemptId,
    taskId: recordedAttempt.taskId,
    createdAtMs: recordedAttempt.createdAtMs,
    evidenceComplete: recordedAttempt.evidenceComplete,
    gapCount: recordedAttempt.gapCount,
    sanitizerLossCount: recordedAttempt.sanitizerLossCount,
  };
}

export function selectBrowserTeachSource({
  activeTaskId,
  rows,
  recordedAttempt,
  loading,
  recording,
  error,
}: {
  activeTaskId?: string | null;
  rows: BrowserEvidenceRow[];
  recordedAttempt: BrowserFlightRecorderResult | null;
  loading: boolean;
  recording: boolean;
  error: string | null;
}): BrowserTeachSourceSelection {
  const taskId = activeTaskId?.trim();
  if (recording) return { kind: "recording" };
  if (error) return { kind: "unavailable", message: error };
  if (loading) return { kind: "loading" };
  const candidates = [
    ...rows.map(candidateFromEvidenceRow),
    candidateFromRecordedAttempt(recordedAttempt),
  ]
    .filter((candidate): candidate is BrowserTeachSourceCandidate => candidate !== null && (!taskId || candidate.taskId === taskId))
    .sort((left, right) => right.createdAtMs - left.createdAtMs);
  const complete = candidates.find((candidate) => candidate.evidenceComplete);
  if (complete) return { kind: "ready", candidate: complete };
  if (candidates[0]) return { kind: "evidenceGapped", candidate: candidates[0] };
  return taskId ? { kind: "noAttempt" } : { kind: "noTask" };
}

export function browserTeachErrorMessage(cause: unknown, fallback: string): string {
  const candidate = typeof cause === "string"
    ? cause
    : cause instanceof Error
      ? cause.message
      : cause && typeof cause === "object" && "message" in cause && typeof cause.message === "string"
        ? cause.message
        : fallback;
  const normalize = (value: string): string => value
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return (normalize(candidate) || normalize(fallback) || "Browser Teach action failed.").slice(0, 280);
}

export function isBrowserTeachStaleError(message: string): boolean {
  return /\bstale\b|revision[ _-]*(?:conflict|mismatch)|compare[ _-]*and[ _-]*swap/i.test(message);
}

export function isBrowserTeachUnavailableError(message: string): boolean {
  return /\bunavailable\b|only inside the ShellX desktop app|native(?: engine| runtime)?/i.test(message);
}
