/**
 * Focused review surface for long-horizon build plans.
 *
 * The right rail stays useful as a persistent scratchboard/status view, but
 * plan approval is a decision point. This modal opens when the orchestrator
 * reports that Grok has finished writing a ready-to-review plan.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { inTauri } from "../lib/tauri-bridge";
import { onMouseUpAutoCopy } from "../lib/auto-copy-selection";
import { fileDisplayName, SafeMarkdownLink } from "../lib/markdown-links";
import { ShellIcon } from "./icons";
import { useModalFocus } from "../lib/useModalFocus";
import { useEventAwarePolling, type PollCurrent } from "../lib/useEventAwarePolling";

export interface GoalState {
  active: boolean;
  objective: string;
  scratchboardPath?: string;
  continuationsTotal: number;
  startedAtMs: number;
  pausedByUser: boolean;
  haltedReason?: string | null;
  awaitingApproval?: boolean;
  planTurnCompleted?: boolean;
  approvalStatus?: { ready: boolean; reason?: string | null };
}

export interface GoalPlanReviewFixture {
  tabId: string;
  goal: GoalState;
  planText: string;
  editing?: boolean;
  editComment?: string;
}

interface GoalPlanReviewModalProps {
  activeTabId?: string | null;
  eventsLen: number;
  openRequestSeq?: number;
  fixture?: GoalPlanReviewFixture;
  onPreviewFile: (path: string) => void;
  onAccepted: () => void;
  onReviewLater: () => void;
}

function planFingerprint(text: string): string {
  return `${text.length}:${text.slice(0, 96)}:${text.slice(-96)}`;
}

function cleanPlanTitle(raw: string): string {
  return raw.replace(/^goal\s*:\s*/i, "").trim();
}

function planComparisonTokens(raw: string): Set<string> {
  const stop = new Set([
    "and", "the", "for", "with", "that", "this", "only", "into", "from",
    "project", "projects", "file", "files",
  ]);
  const normalized = cleanPlanTitle(raw)
    .toLowerCase()
    .replace(/goal\.md/g, "goalmd")
    .replace(/[^a-z0-9]+/g, " ");
  return new Set(
    normalized
      .split(/\s+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 2 && !stop.has(s)),
  );
}

function planTextsAreEquivalent(a: string, b: string): boolean {
  const aTokens = planComparisonTokens(a);
  const bTokens = planComparisonTokens(b);
  if (aTokens.size === 0 || bTokens.size === 0) return false;
  const [small, large] = aTokens.size <= bTokens.size ? [aTokens, bTokens] : [bTokens, aTokens];
  let shared = 0;
  for (const token of small) {
    if (large.has(token)) shared += 1;
  }
  return shared / small.size >= 0.75;
}

function extractPlanTitle(text: string, objective: string): string {
  const heading = text.match(/^\s*#\s+(.+?)\s*$/m)?.[1];
  const cleaned = heading ? cleanPlanTitle(heading) : "";
  return cleaned || objective.trim() || "Build plan";
}

function stripLeadingPlanTitle(text: string): string {
  return text
    .replace(/^\s*#\s+.+?\s*(?:\r?\n)+/, "")
    .replace(/^\s*Status\s*:\s*.+?\s*(?:\r?\n)+/i, "")
    .trimStart();
}

function extractPlanStatus(text: string): string {
  const status = text.match(/^\s*Status\s*:\s*(.+?)\s*$/im)?.[1]?.trim();
  return status ? status.replace(/_/g, " ").toLowerCase() : "awaiting approval";
}

export function GoalPlanReviewModal({
  activeTabId,
  eventsLen,
  openRequestSeq,
  fixture,
  onPreviewFile,
  onAccepted,
  onReviewLater,
}: GoalPlanReviewModalProps): JSX.Element | null {
  const [goal, setGoal] = useState<GoalState | null>(() => fixture?.goal ?? null);
  const [planText, setPlanText] = useState(() => fixture?.planText ?? "");
  const [readError, setReadError] = useState<string | null>(null);
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);
  const [approving, setApproving] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [rejectArmed, setRejectArmed] = useState(false);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [editing, setEditing] = useState(() => Boolean(fixture?.editing));
  const [editComment, setEditComment] = useState(() => fixture?.editComment ?? "");
  const [replanning, setReplanning] = useState(false);
  const editRef = useRef<HTMLTextAreaElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const effectiveTabId = fixture?.tabId ?? activeTabId;

  const goalPollingEnabled = !fixture && Boolean(effectiveTabId) && inTauri();
  const refreshGoal = useCallback(async (isCurrent: PollCurrent): Promise<void> => {
    if (!effectiveTabId) return;
    try {
      const next = await invoke<unknown>("get_goal_state", { tabId: effectiveTabId });
      if (!isCurrent()) return;
      if (!next || typeof next !== "object") {
        setGoal(null);
        return;
      }
      setGoal(next as GoalState);
    } catch {
      // Preserve the last state across a transient host read failure.
    }
  }, [effectiveTabId]);

  useEventAwarePolling({
    enabled: goalPollingEnabled,
    scopeKey: `goal-review:${effectiveTabId ?? "none"}`,
    eventRevision: eventsLen,
    intervalMs: 2500,
    poll: refreshGoal,
  });

  useEffect(() => {
    if (fixture) {
      setGoal(fixture.goal);
      return;
    }
    if (!goalPollingEnabled) setGoal(null);
  }, [fixture, goalPollingEnabled]);

  const scratchboardPath = goal?.scratchboardPath ?? "";
  const planReadEnabled = !fixture && Boolean(effectiveTabId && scratchboardPath && goal?.awaitingApproval);
  const refreshPlanText = useCallback(async (isCurrent: PollCurrent): Promise<void> => {
    if (!effectiveTabId || !scratchboardPath) return;
    try {
      const text = inTauri()
        ? await invoke<string>("read_text_file_for_path", {
            path: scratchboardPath,
            tabId: effectiveTabId,
          })
        : await fetch(convertFileSrc(scratchboardPath, "asset"))
            .then((response) => response.ok ? response.text() : Promise.reject(`HTTP ${response.status}`));
      if (!isCurrent()) return;
      setReadError(null);
      setPlanText((cur) => (cur === text ? cur : text));
    } catch (error) {
      if (isCurrent()) setReadError(String(error));
    }
  }, [effectiveTabId, scratchboardPath]);

  useEventAwarePolling({
    enabled: planReadEnabled,
    scopeKey: `goal-review-file:${effectiveTabId ?? "none"}:${scratchboardPath}:${goal?.approvalStatus?.ready ?? false}`,
    eventRevision: eventsLen,
    poll: refreshPlanText,
  });

  useEffect(() => {
    if (fixture) {
      setReadError(null);
      setPlanText(fixture.planText);
      return;
    }
    if (!planReadEnabled) {
      setPlanText("");
      setReadError(null);
    }
  }, [fixture, planReadEnabled]);

  useEffect(() => {
    if (!fixture) return;
    setEditing(Boolean(fixture.editing));
    setEditComment(fixture.editComment ?? "");
    setApproving(false);
    setRejecting(false);
    setRejectArmed(false);
    setActionMessage(null);
    setReplanning(false);
    setDismissedKey(null);
  }, [fixture]);

  useEffect(() => {
    if (!goal?.awaitingApproval) {
      setDismissedKey(null);
      setApproving(false);
      setRejecting(false);
      setRejectArmed(false);
      setActionMessage(null);
      setEditing(false);
      setEditComment("");
      setReplanning(false);
    }
  }, [goal?.awaitingApproval]);

  useEffect(() => { if (editing) editRef.current?.focus(); }, [editing]);

  const ready = Boolean(goal?.active && goal.awaitingApproval && goal.approvalStatus?.ready);
  const planKey = useMemo(
    () => effectiveTabId && scratchboardPath
      ? `${effectiveTabId}:${scratchboardPath}:${planFingerprint(planText)}`
      : null,
    [effectiveTabId, scratchboardPath, planText],
  );
  const open = ready && planKey !== null && dismissedKey !== planKey;
  useModalFocus(open, dialogRef, () => {
    if (editing) {
      setEditing(false);
      return;
    }
    if (planKey) setDismissedKey(planKey);
    onReviewLater();
  });

  useEffect(() => {
    if (openRequestSeq === undefined) return;
    setDismissedKey(null);
    setRejectArmed(false);
    setActionMessage(null);
  }, [openRequestSeq]);

  if (!open || !goal || !effectiveTabId) return null;

  const lineCount = planText ? planText.split("\n").length : 0;
  const phaseCount = (planText.match(/^##\s+Phase\b/gim) ?? []).length;
  const planTitle = extractPlanTitle(planText, goal.objective);
  const planStatus = extractPlanStatus(planText);
  const displayPlanText = stripLeadingPlanTitle(planText);
  const markdownText = displayPlanText.trim() ? displayPlanText : planText;
  const objectiveText = goal.objective.trim();
  const showObjective =
    objectiveText.length > 0 &&
    !planTextsAreEquivalent(objectiveText, planTitle);
  const waitingReason =
    goal.approvalStatus?.reason ??
    (goal.planTurnCompleted
      ? "Waiting for a complete phased build plan."
      : "Waiting for Grok to finish the plan turn.");

  const dismissToRail = (): void => {
    if (planKey) setDismissedKey(planKey);
    setRejectArmed(false);
    setActionMessage(null);
    onReviewLater();
  };

  const approve = (): void => {
    if (fixture || approving || rejecting || !inTauri()) return;
    setRejectArmed(false);
    setActionMessage(null);
    setApproving(true);
    void invoke<boolean>("approve_goal_plan", { tabId: effectiveTabId })
      .then((flipped) => {
        if (flipped) {
          if (planKey) setDismissedKey(planKey);
          onAccepted();
        } else {
          setActionMessage("The plan is no longer awaiting approval. Refresh the Goal state and try again.");
          setApproving(false);
        }
      })
      .catch((err) => {
        try { console.warn("approve_goal_plan failed:", err); } catch { /* noop */ }
        setActionMessage(String(err));
        setApproving(false);
      });
  };

  const requestEdit = (): void => {
    const comment = editComment.trim();
    if (fixture || !comment || replanning || !inTauri()) return;
    setRejectArmed(false);
    setActionMessage(null);
    setReplanning(true);
    void invoke<boolean>("request_goal_replan", { tabId: effectiveTabId, comment })
      .then((ok) => {
        if (ok) {
          if (planKey) setDismissedKey(planKey);
          setEditing(false);
          setEditComment("");
          onReviewLater();
        } else {
          setActionMessage("The active Goal is no longer waiting for plan feedback.");
          setReplanning(false);
        }
      })
      .catch((err) => {
        try { console.warn("request_goal_replan failed:", err); } catch { /* noop */ }
        setActionMessage(String(err));
        setReplanning(false);
      });
  };

  const reject = (): void => {
    if (fixture || rejecting || !inTauri()) return;
    if (!rejectArmed) {
      setRejectArmed(true);
      setActionMessage("Click Confirm reject to clear this Goal and its proposed plan.");
      return;
    }
    setRejecting(true);
    setRejectArmed(false);
    setActionMessage(null);
    void invoke("reject_goal_plan", { tabId: effectiveTabId })
      .then(() => {
        if (planKey) setDismissedKey(planKey);
      })
      .catch((err) => {
        try { console.warn("reject_goal_plan failed:", err); } catch { /* noop */ }
        setActionMessage(String(err));
        setRejecting(false);
      });
  };

  return (
    <div className="preview-backdrop">
      <div ref={dialogRef} data-debug-id="surface-components-goalplanreviewmodal-1" className="preview-modal plan-review-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label={`Review plan: ${planTitle}`}>
        <div className="plan-review-shell">
          <div className="plan-review-topbar">
            <div className="plan-review-kicker">Plan review</div>
            <button
              type="button"
              className="preview-close"
              onClick={dismissToRail}
              aria-label="Review later"
              title="Review later in the Plan tab"
            >
              <ShellIcon name="close" size={14} />
            </button>
          </div>
          <div className="plan-review-title-block">
            <h2 title={planTitle}>{planTitle}</h2>
            <div className="plan-review-meta">
              <span className="plan-review-chip">{planStatus}</span>
              <span>{fileDisplayName(scratchboardPath) || "build.md"}</span>
              {phaseCount > 0 && <span>{phaseCount} phases</span>}
              {lineCount > 0 && <span>{lineCount} lines</span>}
            </div>
            {showObjective && (
              <div className="plan-review-objective">
                <span>Objective</span>
                <p title={objectiveText}>{objectiveText}</p>
              </div>
            )}
          </div>
          <div
            className="preview-body preview-body-markdown plan-review-body"
            onMouseUp={fixture ? undefined : onMouseUpAutoCopy}
          >
            {readError ? (
              <div className="preview-err">{readError}</div>
            ) : planText.trim() ? (
              <div className="preview-md plan-review-md">
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  components={{
                    h1: ({ children }) => <h1 className="plan-md-title">{children}</h1>,
                    h2: ({ children }) => <h2 className="plan-md-section">{children}</h2>,
                    h3: ({ children }) => <h3 className="plan-md-subsection">{children}</h3>,
                    a: ({ href, children }) => (
                      <SafeMarkdownLink
                        href={href}
                        currentPath={scratchboardPath}
                        onPreviewFile={onPreviewFile}
                      >
                        {children}
                      </SafeMarkdownLink>
                    ),
                  }}
                >
                  {markdownText}
                </ReactMarkdown>
              </div>
            ) : (
              <div className="preview-loading">{waitingReason}</div>
            )}
          </div>
          {editing && (
            <div className="plan-review-edit">
              <div className="plan-review-edit-head">
                <span>Request changes</span>
              </div>
              <textarea
                ref={editRef}
                className="plan-edit-input"
                data-shellx-release-observe="value"
                value={editComment}
                onChange={(e) => setEditComment(e.target.value)}
                placeholder="What should Grok change about this plan? (Ctrl+Enter to submit)"
                rows={4}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                    e.preventDefault();
                    requestEdit();
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    e.stopPropagation();
                    setEditing(false);
                  }
                }}
              />
              <div className="plan-edit-actions">
                <button data-debug-id="surface-components-goalplanreviewmodal-4"
                  type="button"
                  className="pact plan-action plan-action-primary"
                  disabled={Boolean(fixture) || !editComment.trim() || replanning}
                  onClick={requestEdit}
                >
                  {replanning ? "Sending…" : "Send feedback"}
                </button>
                <button
                  type="button"
                  className="pact plan-action plan-action-quiet"
                  disabled={replanning}
                  onClick={() => {
                    setEditing(false);
                    setEditComment("");
                    setActionMessage(null);
                  }}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
          <div className="plan-review-actions">
            <button
              type="button"
              className="pact plan-action plan-action-quiet"
              disabled={approving || rejecting || replanning}
              onClick={dismissToRail}
            >
              Review later
            </button>
            {actionMessage && (
              <span className="goal-status-meta" role="status" title={actionMessage}>{actionMessage}</span>
            )}
            <div className="plan-review-action-spacer" />
            <button data-debug-id="surface-components-goalplanreviewmodal-7"
              type="button"
              className="pact plan-action plan-action-danger"
              data-shellx-release-observe="title disabled"
              title={rejectArmed
                ? "Confirm rejection and clear this Goal plan"
                : "Reject this Goal plan"}
              disabled={Boolean(fixture) || approving || rejecting || replanning}
              onClick={reject}
            >
              {rejecting ? "Rejecting…" : rejectArmed ? "Confirm reject" : "Reject"}
            </button>
            <button
              type="button"
              className={`pact plan-action plan-action-secondary ${editing ? "active" : ""}`}
              disabled={approving || rejecting || replanning}
              onClick={() => {
                setRejectArmed(false);
                setActionMessage(null);
                setEditing((v) => !v);
              }}
            >
              Request changes
            </button>
            <button data-debug-id="surface-components-goalplanreviewmodal-9"
              type="button"
              className="pact plan-action plan-action-primary"
              disabled={Boolean(fixture) || approving || rejecting || replanning}
              onClick={approve}
            >
              {approving ? "Approving…" : "Accept plan"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
