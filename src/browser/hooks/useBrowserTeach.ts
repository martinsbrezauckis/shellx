import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  approveBrowserTeachDraftForOperator,
  listBrowserVaultKeys,
  prepareBrowserTeachDraftForOperator,
  prepareBrowserTeachTaskHandoffForOperator,
  rehearseBrowserTeachRecipeForOperator,
  reviseBrowserTeachDraftForOperator,
} from "../api";
import {
  browserTeachErrorMessage,
  browserTeachHasBlockingIssues,
  isBrowserTeachStaleError,
  isBrowserTeachUnavailableError,
  normalizeBrowserTeachApproval,
  normalizeBrowserTeachPreparedDraft,
  normalizeBrowserTeachRehearsal,
  normalizeBrowserTeachRevisionResponse,
  type BrowserTeachApproval,
  type BrowserTeachPreparedDraft,
  type BrowserTeachRehearsal,
  type BrowserTeachSourceCandidate,
  type BrowserTeachValueEdit,
} from "../browserTeach";
import { openTaskDraftFromBrowserTeach } from "../../lib/task-teach-handoff-bridge";
import {
  normalizeBrowserTeachTaskHandoff,
  type BrowserTeachTaskHandoff,
} from "../../lib/task-teach-handoff-events";

export type BrowserTeachPhase =
  | "idle"
  | "preparing"
  | "reviewReady"
  | "saving"
  | "stale"
  | "approving"
  | "approved"
  | "rehearsing"
  | "rehearsalReady"
  | "rehearsalBlocked"
  | "rehearsalFailed"
  | "preparingTaskDraft"
  | "taskDraftOpened"
  | "taskDraftFailed"
  | "unavailable"
  | "error";

export interface BrowserTeachValueEditState {
  label: string;
  literal: string;
}

interface BrowserTeachEditState {
  goal: string;
  values: Record<string, BrowserTeachValueEditState>;
  vaultBindings: Record<string, string>;
  ambiguityResolutions: string[];
}

interface BrowserTeachRetryRequest {
  kind: "prepare" | "save" | "approve" | "rehearse" | "taskDraft";
  source?: BrowserTeachSourceCandidate;
}

function editStateFor(draft: BrowserTeachPreparedDraft): BrowserTeachEditState {
  const bindingByValue = new Map(
    draft.revision.requiredVaultBindings.map((binding) => [binding.valueId, binding.bindingId ?? ""]),
  );
  return {
    goal: draft.revision.goal,
    values: Object.fromEntries(draft.revision.values.map((value) => [value.valueId, {
      label: value.label,
      literal: value.literal ?? "",
    }])),
    vaultBindings: Object.fromEntries(
      draft.revision.values
        .filter((value) => value.requiredVaultBinding)
        .map((value) => [value.valueId, bindingByValue.get(value.valueId) ?? ""]),
    ),
    ambiguityResolutions: [...draft.revision.ambiguityResolutions].sort(),
  };
}

function revisionValueEdits(draft: BrowserTeachPreparedDraft, edits: BrowserTeachEditState): BrowserTeachValueEdit[] {
  return draft.revision.values.flatMap((value) => {
    const edited = edits.values[value.valueId];
    if (!edited) return [];
    const next: BrowserTeachValueEdit = { valueId: value.valueId };
    if (edited.label !== value.label) next.label = edited.label;
    if (!value.requiredVaultBinding && edited.literal !== (value.literal ?? "")) next.literal = edited.literal;
    return Object.keys(next).length > 1 ? [next] : [];
  });
}

function isDraftDirty(draft: BrowserTeachPreparedDraft | null, edits: BrowserTeachEditState): boolean {
  if (!draft) return false;
  if (edits.goal !== draft.revision.goal) return true;
  if (revisionValueEdits(draft, edits).length > 0) return true;
  const expectedResolutions = [...draft.revision.ambiguityResolutions].sort();
  if (edits.ambiguityResolutions.join("\u0000") !== expectedResolutions.join("\u0000")) return true;
  return draft.revision.values
    .filter((value) => value.requiredVaultBinding)
    .some((value) => {
      const expected = draft.revision.requiredVaultBindings.find((binding) => binding.valueId === value.valueId)?.bindingId ?? "";
      return (edits.vaultBindings[value.valueId] ?? "").trim() !== expected;
    });
}

function safeVaultKeyIdentity(value: string): string | null {
  const trimmed = value.trim();
  return trimmed && trimmed.length <= 200 && !/[\u0000-\u001f\u007f]/.test(trimmed) ? trimmed : null;
}

function isRehearsalBlockedError(message: string): boolean {
  return /rehearsal requires|matching Teach approval receipt|exact approved recipe export receipt|recipe digest/i.test(message);
}

export function useBrowserTeach(activeTaskId?: string | null): {
  phase: BrowserTeachPhase;
  draft: BrowserTeachPreparedDraft | null;
  goal: string;
  valueEdits: Record<string, BrowserTeachValueEditState>;
  vaultBindings: Record<string, string>;
  ambiguityResolutions: string[];
  isDirty: boolean;
  hasBlockingIssues: boolean;
  approval: BrowserTeachApproval | null;
  rehearsal: BrowserTeachRehearsal | null;
  taskHandoff: BrowserTeachTaskHandoff | null;
  error: string | null;
  vaultKeys: string[];
  vaultKeysLoading: boolean;
  vaultKeysError: string | null;
  prepare: (source: BrowserTeachSourceCandidate) => Promise<void>;
  updateGoal: (goal: string) => void;
  updateValue: (valueId: string, patch: Partial<BrowserTeachValueEditState>) => void;
  updateVaultBinding: (valueId: string, bindingId: string) => void;
  toggleAmbiguityResolution: (issueId: string) => void;
  save: () => Promise<void>;
  approve: () => Promise<void>;
  rehearse: () => Promise<void>;
  createTaskDraft: () => Promise<void>;
  retry: () => Promise<void>;
} {
  const normalizedActiveTaskId = activeTaskId?.trim() ?? "";
  const [phase, setPhase] = useState<BrowserTeachPhase>("idle");
  const [draft, setDraft] = useState<BrowserTeachPreparedDraft | null>(null);
  const [edits, setEdits] = useState<BrowserTeachEditState>({ goal: "", values: {}, vaultBindings: {}, ambiguityResolutions: [] });
  const [approval, setApproval] = useState<BrowserTeachApproval | null>(null);
  const [rehearsal, setRehearsal] = useState<BrowserTeachRehearsal | null>(null);
  const [taskHandoff, setTaskHandoff] = useState<BrowserTeachTaskHandoff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [vaultKeys, setVaultKeys] = useState<string[]>([]);
  const [vaultKeysLoading, setVaultKeysLoading] = useState(false);
  const [vaultKeysError, setVaultKeysError] = useState<string | null>(null);
  const requestRef = useRef(0);
  const retryRequestRef = useRef<BrowserTeachRetryRequest | null>(null);

  const isDirty = useMemo(() => isDraftDirty(draft, edits), [draft, edits]);
  const hasBlockingIssues = useMemo(() => draft !== null && browserTeachHasBlockingIssues(draft), [draft]);

  useEffect(() => {
    requestRef.current += 1;
    retryRequestRef.current = null;
    setPhase("idle");
    setDraft(null);
    setEdits({ goal: "", values: {}, vaultBindings: {}, ambiguityResolutions: [] });
    setApproval(null);
    setRehearsal(null);
    setTaskHandoff(null);
    setError(null);
    setVaultKeys([]);
    setVaultKeysLoading(false);
    setVaultKeysError(null);
  }, [normalizedActiveTaskId]);

  const setFailure = useCallback((cause: unknown, fallback: string): void => {
    const message = browserTeachErrorMessage(cause, fallback);
    setError(message);
    if (isBrowserTeachStaleError(message)) {
      setPhase("stale");
    } else if (isBrowserTeachUnavailableError(message)) {
      setPhase("unavailable");
    } else {
      setPhase("error");
    }
  }, []);

  const loadVaultKeys = useCallback(async (request: number): Promise<void> => {
    setVaultKeysLoading(true);
    setVaultKeysError(null);
    try {
      const entries = await listBrowserVaultKeys();
      if (requestRef.current !== request) return;
      setVaultKeys([...new Set(entries.map((entry) => safeVaultKeyIdentity(entry.key)).filter((key): key is string => key !== null))].sort());
    } catch (cause) {
      if (requestRef.current === request) {
        setVaultKeys([]);
        setVaultKeysError(browserTeachErrorMessage(cause, "Vault key identities are unavailable."));
      }
    } finally {
      if (requestRef.current === request) setVaultKeysLoading(false);
    }
  }, []);

  const prepare = useCallback(async (source: BrowserTeachSourceCandidate): Promise<void> => {
    if (!normalizedActiveTaskId || source.taskId !== normalizedActiveTaskId) {
      setFailure(new Error("Select the matching browser task before preparing a Teach draft."), "Browser Teach source is unavailable.");
      return;
    }
    const request = requestRef.current + 1;
    requestRef.current = request;
    retryRequestRef.current = { kind: "prepare", source };
    setPhase("preparing");
    setError(null);
    setApproval(null);
    setRehearsal(null);
    setTaskHandoff(null);
    try {
      const response = await prepareBrowserTeachDraftForOperator({ attemptId: source.attemptId });
      const next = normalizeBrowserTeachPreparedDraft(response);
      if (requestRef.current !== request) return;
      if (next.bundle.source.taskId !== normalizedActiveTaskId || next.bundle.source.attemptId !== source.attemptId) {
        throw new Error("Browser Teach returned a different task or source attempt.");
      }
      setDraft(next);
      setEdits(editStateFor(next));
      if (!next.isCurrent) {
        setError("The prepared draft is no longer current. Reload the current revision before approval.");
        setPhase("stale");
      } else {
        setPhase("reviewReady");
      }
      if (next.revision.values.some((value) => value.requiredVaultBinding)) void loadVaultKeys(request);
    } catch (cause) {
      if (requestRef.current === request) setFailure(cause, "Browser Teach draft could not be prepared.");
    }
  }, [loadVaultKeys, normalizedActiveTaskId, setFailure]);

  const markEdited = useCallback((): void => {
    setApproval(null);
    setRehearsal(null);
    setTaskHandoff(null);
    if (phase !== "saving") setPhase("reviewReady");
  }, [phase]);

  const updateGoal = useCallback((goal: string): void => {
    setEdits((current) => ({ ...current, goal: goal.slice(0, 300) }));
    markEdited();
  }, [markEdited]);

  const updateValue = useCallback((valueId: string, patch: Partial<BrowserTeachValueEditState>): void => {
    setEdits((current) => ({
      ...current,
      values: {
        ...current.values,
        [valueId]: { label: current.values[valueId]?.label ?? "", literal: current.values[valueId]?.literal ?? "", ...patch },
      },
    }));
    markEdited();
  }, [markEdited]);

  const updateVaultBinding = useCallback((valueId: string, bindingId: string): void => {
    setEdits((current) => ({ ...current, vaultBindings: { ...current.vaultBindings, [valueId]: bindingId } }));
    markEdited();
  }, [markEdited]);

  const toggleAmbiguityResolution = useCallback((issueId: string): void => {
    setEdits((current) => ({
      ...current,
      ambiguityResolutions: current.ambiguityResolutions.includes(issueId)
        ? current.ambiguityResolutions.filter((value) => value !== issueId)
        : [...current.ambiguityResolutions, issueId].sort(),
    }));
    markEdited();
  }, [markEdited]);

  const save = useCallback(async (): Promise<void> => {
    if (!draft) return;
    const goal = edits.goal.trim();
    if (!goal) {
      setFailure(new Error("A workflow goal is required before saving the Teach draft."), "Browser Teach draft could not be saved.");
      return;
    }
    if (!draft.isCurrent) {
      setFailure(new Error("The saved revision is stale. Reload it before making another revision."), "Browser Teach revision is stale.");
      return;
    }
    const valueEdits = revisionValueEdits(draft, edits);
    const vaultBindings = draft.revision.values
      .filter((value) => value.requiredVaultBinding)
      .map((value) => ({ valueId: value.valueId, bindingId: edits.vaultBindings[value.valueId]?.trim() || undefined }));
    const ambiguityResolutions = [...edits.ambiguityResolutions].sort();
    if (!isDraftDirty(draft, edits)) {
      setPhase("reviewReady");
      return;
    }
    const request = requestRef.current + 1;
    requestRef.current = request;
    retryRequestRef.current = { kind: "save" };
    setPhase("saving");
    setError(null);
    try {
      const response = await reviseBrowserTeachDraftForOperator({
        draftId: draft.draft.draftId,
        expectedRevisionId: draft.revision.revisionId,
        expectedRevisionSha256: draft.revision.sha256,
        goal: goal === draft.revision.goal ? undefined : goal,
        valueEdits: valueEdits.length ? valueEdits : undefined,
        vaultBindings: vaultBindings.length ? vaultBindings : undefined,
        ambiguityResolutions: ambiguityResolutions.join("\u0000") === [...draft.revision.ambiguityResolutions].sort().join("\u0000") ? undefined : ambiguityResolutions,
      });
      const next = normalizeBrowserTeachRevisionResponse(response, draft.bundle);
      if (requestRef.current !== request) return;
      if (next.draft.draftId !== draft.draft.draftId || next.bundle.source.taskId !== normalizedActiveTaskId) {
        throw new Error("Browser Teach returned a revision for a different draft.");
      }
      setDraft(next);
      setEdits(editStateFor(next));
      setApproval(null);
      setRehearsal(null);
      setTaskHandoff(null);
      if (!next.isCurrent) {
        setError("The saved revision lost its current position. Reload it before approval.");
        setPhase("stale");
      } else {
        setPhase("reviewReady");
      }
    } catch (cause) {
      if (requestRef.current === request) setFailure(cause, "Browser Teach draft could not be saved.");
    }
  }, [draft, edits, normalizedActiveTaskId, setFailure]);

  const approve = useCallback(async (): Promise<void> => {
    if (!draft || isDirty || !draft.isCurrent || browserTeachHasBlockingIssues(draft)) return;
    const request = requestRef.current + 1;
    requestRef.current = request;
    retryRequestRef.current = { kind: "approve" };
    setPhase("approving");
    setError(null);
    try {
      const response = await approveBrowserTeachDraftForOperator({
        draftId: draft.draft.draftId,
        revisionId: draft.revision.revisionId,
        revisionSha256: draft.revision.sha256,
      });
      const next = normalizeBrowserTeachApproval(response);
      if (requestRef.current !== request) return;
      setApproval(next);
      setRehearsal(null);
      setTaskHandoff(null);
      setPhase("approved");
    } catch (cause) {
      if (requestRef.current === request) setFailure(cause, "Browser Teach recipe approval could not be completed.");
    }
  }, [draft, isDirty, setFailure]);

  const rehearse = useCallback(async (): Promise<void> => {
    if (!approval || !draft || isDirty) return;
    const request = requestRef.current + 1;
    requestRef.current = request;
    retryRequestRef.current = { kind: "rehearse" };
    setPhase("rehearsing");
    setError(null);
    try {
      const response = await rehearseBrowserTeachRecipeForOperator({
        recipeId: approval.recipeId,
        sha256: approval.recipeSha256,
      });
      const next = normalizeBrowserTeachRehearsal(response);
      if (requestRef.current !== request) return;
      if (next.recipeId !== approval.recipeId || next.sha256 !== approval.recipeSha256) {
        throw new Error("Browser Teach rehearsal returned a different recipe identity.");
      }
      setRehearsal(next);
      setTaskHandoff(null);
      setPhase("rehearsalReady");
    } catch (cause) {
      if (requestRef.current !== request) return;
      const message = browserTeachErrorMessage(cause, "Browser Teach rehearsal could not be completed.");
      setError(message);
      setPhase(isRehearsalBlockedError(message) ? "rehearsalBlocked" : "rehearsalFailed");
    }
  }, [approval, draft, isDirty]);

  const createTaskDraft = useCallback(async (): Promise<void> => {
    if (!approval || !rehearsal || !draft || isDirty || rehearsal.stepsSkipped !== 0) return;
    const request = requestRef.current + 1;
    requestRef.current = request;
    retryRequestRef.current = { kind: "taskDraft" };
    setPhase("preparingTaskDraft");
    setError(null);
    setTaskHandoff(null);
    try {
      const response = await prepareBrowserTeachTaskHandoffForOperator({
        draftId: draft.draft.draftId,
        revisionId: draft.revision.revisionId,
        revisionSha256: draft.revision.sha256,
        recipeId: approval.recipeId,
        recipeSha256: approval.recipeSha256,
        approvalId: approval.approvalId,
        rehearsalReceiptId: rehearsal.receipt.receiptId,
      });
      const handoff = normalizeBrowserTeachTaskHandoff(response);
      if (!handoff) throw new Error("Browser Teach returned an invalid Task handoff receipt.");
      if (requestRef.current !== request) return;
      await openTaskDraftFromBrowserTeach(handoff);
      if (requestRef.current !== request) return;
      setTaskHandoff(handoff);
      setPhase("taskDraftOpened");
    } catch (cause) {
      if (requestRef.current !== request) return;
      setError(browserTeachErrorMessage(cause, "The reviewed Task draft could not be opened."));
      setPhase("taskDraftFailed");
    }
  }, [approval, draft, isDirty, rehearsal]);

  const retry = useCallback(async (): Promise<void> => {
    const retryRequest = retryRequestRef.current;
    if (!retryRequest) return;
    if (retryRequest.kind === "prepare" && retryRequest.source) {
      await prepare(retryRequest.source);
    } else if (retryRequest.kind === "save") {
      await save();
    } else if (retryRequest.kind === "approve") {
      await approve();
    } else if (retryRequest.kind === "rehearse") {
      await rehearse();
    } else if (retryRequest.kind === "taskDraft") {
      await createTaskDraft();
    }
  }, [approve, createTaskDraft, prepare, rehearse, save]);

  return {
    phase,
    draft,
    goal: edits.goal,
    valueEdits: edits.values,
    vaultBindings: edits.vaultBindings,
    ambiguityResolutions: edits.ambiguityResolutions,
    isDirty,
    hasBlockingIssues,
    approval,
    rehearsal,
    taskHandoff,
    error,
    vaultKeys,
    vaultKeysLoading,
    vaultKeysError,
    prepare,
    updateGoal,
    updateValue,
    updateVaultBinding,
    toggleAmbiguityResolution,
    save,
    approve,
    rehearse,
    createTaskDraft,
    retry,
  };
}
