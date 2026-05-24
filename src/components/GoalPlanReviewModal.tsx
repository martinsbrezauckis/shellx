/**
 * Focused review surface for /goal plans.
 *
 * The right rail stays useful as a persistent scratchboard/status view, but
 * plan approval is a decision point. This modal opens when the orchestrator
 * reports that Grok has finished writing a ready-to-review plan.
 */
import { useEffect, useMemo, useRef, useState, type JSX } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { inTauri } from "../lib/tauri-bridge";
import { onMouseUpAutoCopy } from "../lib/auto-copy-selection";
import { fileDisplayName, SafeMarkdownLink } from "../lib/markdown-links";

interface GoalState {
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

interface GoalPlanReviewModalProps {
  activeTabId?: string | null;
  eventsLen: number;
  openRequestSeq?: number;
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
  return cleaned || objective.trim() || "Goal plan";
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
  onPreviewFile,
  onAccepted,
  onReviewLater,
}: GoalPlanReviewModalProps): JSX.Element | null {
  const [goal, setGoal] = useState<GoalState | null>(null);
  const [planText, setPlanText] = useState("");
  const [readError, setReadError] = useState<string | null>(null);
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);
  const [approving, setApproving] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editComment, setEditComment] = useState("");
  const [replanning, setReplanning] = useState(false);
  const editRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (!activeTabId || !inTauri()) {
      setGoal(null);
      return;
    }
    let cancelled = false;
    const fetchState = () => {
      void invoke<unknown>("get_goal_state", { tabId: activeTabId })
        .then((s) => {
          if (cancelled) return;
          if (!s || typeof s !== "object") {
            setGoal(null);
            return;
          }
          setGoal(s as GoalState);
        })
        .catch(() => {});
    };
    fetchState();
    const id = window.setInterval(fetchState, 2500);
    return () => { cancelled = true; window.clearInterval(id); };
  }, [activeTabId, eventsLen]);

  const scratchboardPath = goal?.scratchboardPath ?? "";
  useEffect(() => {
    if (!activeTabId || !scratchboardPath || !goal?.awaitingApproval) {
      setPlanText("");
      setReadError(null);
      return;
    }
    let cancelled = false;
    const setText = (text: string) => {
      if (cancelled) return;
      setReadError(null);
      setPlanText((cur) => (cur === text ? cur : text));
    };
    if (inTauri()) {
      void invoke<string>("read_text_file_for_path", {
        path: scratchboardPath,
        tabId: activeTabId,
      }).then(setText).catch((e) => {
        if (!cancelled) setReadError(String(e));
      });
    } else {
      fetch(convertFileSrc(scratchboardPath, "asset"))
        .then((r) => (r.ok ? r.text() : Promise.reject(`HTTP ${r.status}`)))
        .then(setText)
        .catch((e) => { if (!cancelled) setReadError(String(e)); });
    }
    return () => { cancelled = true; };
  }, [activeTabId, scratchboardPath, goal?.awaitingApproval, goal?.approvalStatus?.ready, eventsLen]);

  useEffect(() => {
    if (!goal?.awaitingApproval) {
      setDismissedKey(null);
      setApproving(false);
      setRejecting(false);
      setEditing(false);
      setEditComment("");
      setReplanning(false);
    }
  }, [goal?.awaitingApproval]);

  useEffect(() => { if (editing) editRef.current?.focus(); }, [editing]);

  const ready = Boolean(goal?.active && goal.awaitingApproval && goal.approvalStatus?.ready);
  const planKey = useMemo(
    () => activeTabId && scratchboardPath
      ? `${activeTabId}:${scratchboardPath}:${planFingerprint(planText)}`
      : null,
    [activeTabId, scratchboardPath, planText],
  );
  const open = ready && planKey !== null && dismissedKey !== planKey;

  useEffect(() => {
    if (openRequestSeq === undefined) return;
    setDismissedKey(null);
  }, [openRequestSeq]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      if (editing) {
        setEditing(false);
        return;
      }
      if (planKey) setDismissedKey(planKey);
      onReviewLater();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, editing, planKey, onReviewLater]);

  if (!open || !goal || !activeTabId) return null;

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
      ? "Waiting for a complete phased plan in goal.md."
      : "Waiting for Grok to finish the plan turn.");

  const dismissToRail = (): void => {
    if (planKey) setDismissedKey(planKey);
    onReviewLater();
  };

  const approve = (): void => {
    if (approving || rejecting || !inTauri()) return;
    setApproving(true);
    void invoke<boolean>("approve_goal_plan", { tabId: activeTabId })
      .then((flipped) => {
        if (flipped) {
          if (planKey) setDismissedKey(planKey);
          onAccepted();
        } else {
          setApproving(false);
        }
      })
      .catch((err) => {
        try { console.warn("approve_goal_plan failed:", err); } catch { /* noop */ }
        setApproving(false);
      });
  };

  const requestEdit = (): void => {
    const comment = editComment.trim();
    if (!comment || replanning || !inTauri()) return;
    setReplanning(true);
    void invoke<boolean>("request_goal_replan", { tabId: activeTabId, comment })
      .then((ok) => {
        if (ok) {
          if (planKey) setDismissedKey(planKey);
          setEditing(false);
          setEditComment("");
          onReviewLater();
        } else {
          setReplanning(false);
        }
      })
      .catch((err) => {
        try { console.warn("request_goal_replan failed:", err); } catch { /* noop */ }
        setReplanning(false);
      });
  };

  const reject = (): void => {
    if (rejecting || !inTauri()) return;
    if (!window.confirm("Reject the proposed plan and clear goal mode?")) return;
    setRejecting(true);
    void invoke("reject_goal_plan", { tabId: activeTabId })
      .then(() => {
        if (planKey) setDismissedKey(planKey);
      })
      .catch((err) => {
        try { console.warn("reject_goal_plan failed:", err); } catch { /* noop */ }
        setRejecting(false);
      });
  };

  return (
    <div className="preview-backdrop" role="dialog" aria-modal="true" aria-label={`Review plan: ${planTitle}`}>
      <div className="preview-modal plan-review-modal" onClick={(e) => e.stopPropagation()}>
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
              ✕
            </button>
          </div>
          <div className="plan-review-title-block">
            <h2 title={planTitle}>{planTitle}</h2>
            <div className="plan-review-meta">
              <span className="plan-review-chip">{planStatus}</span>
              <span>{fileDisplayName(scratchboardPath) || "goal.md"}</span>
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
          <div className="preview-body preview-body-markdown plan-review-body" onMouseUp={onMouseUpAutoCopy}>
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
                <button
                  type="button"
                  className="pact plan-action plan-action-primary"
                  disabled={!editComment.trim() || replanning}
                  onClick={requestEdit}
                >
                  {replanning ? "Sending…" : "Send feedback"}
                </button>
                <button
                  type="button"
                  className="pact plan-action plan-action-quiet"
                  disabled={replanning}
                  onClick={() => { setEditing(false); setEditComment(""); }}
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
            <div className="plan-review-action-spacer" />
            <button
              type="button"
              className="pact plan-action plan-action-danger"
              disabled={approving || rejecting || replanning}
              onClick={reject}
            >
              {rejecting ? "Rejecting…" : "Reject"}
            </button>
            <button
              type="button"
              className={`pact plan-action plan-action-secondary ${editing ? "active" : ""}`}
              disabled={approving || rejecting || replanning}
              onClick={() => setEditing((v) => !v)}
            >
              Request changes
            </button>
            <button
              type="button"
              className="pact plan-action plan-action-primary"
              disabled={approving || rejecting || replanning}
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
