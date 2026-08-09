/**
 * Focused review surface for Build Mode scratchboards.
 *
 * Build Mode has a persistent right-rail cockpit, but plan approval is a
 * decision point. This modal gives /build the same centered review surface as
 * the legacy long-horizon planner.
 */
import { useEffect, useMemo, useRef, useState, type JSX } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { inTauri } from "../lib/tauri-bridge";
import { onMouseUpAutoCopy } from "../lib/auto-copy-selection";
import { fileDisplayName, SafeMarkdownLink } from "../lib/markdown-links";
import {
  buildApprovalReadinessFromText,
  buildStatusLabel,
  getBuildState,
  type BuildRunState,
} from "../lib/build-run";
import { ShellIcon } from "./icons";
import { useModalFocus } from "../lib/useModalFocus";

interface BuildPlanReviewModalProps {
  activeTabId?: string | null;
  sessionCwd?: string;
  eventsLen: number;
  openRequestSeq?: number;
  closeRequestSeq?: number;
  /** Fixed renderer-only plan used by installed release verification. No
   * Build state, provider, project, clipboard, or navigation path is active. */
  debugFixture?: "owned-ready" | null;
  onPreviewFile: (path: string) => void;
  onAccepted: () => void;
  onReviewLater: () => void;
}

const OWNED_DEBUG_PLAN_TEXT = `# Build: Release-owned inert review

Status: AWAITING_APPROVAL

## Phase 1 — Verify the inert review lifecycle

- [ ] Verify UI wiring without provider work, build execution, fake success, placeholder behavior, or AI slop.
`;

function ownedDebugBuildState(tabId: string): BuildRunState {
  return {
    runId: "release-owned-inert-build-plan",
    tabId,
    objective: "Verify the inert Build plan review lifecycle",
    cwd: "/release-owned/inert-build-plan",
    transportKind: "release-fixture",
    scratchboardPath: "/release-owned/inert-build-plan/build.md",
    status: "awaitingApproval",
    approvedPlanHash: null,
    currentPhaseId: null,
    continuationsTotal: 0,
    noProgressCycles: 0,
    createdAtMs: 0,
    updatedAtMs: 0,
    approvedAtMs: null,
    lastContinuationAtMs: null,
    checkpointId: null,
    codeChanged: false,
    reviewRequired: false,
    reviewSatisfied: false,
    verificationRequired: false,
    verificationSatisfied: false,
    previewRequired: false,
    previewSatisfied: false,
    openBlocker: null,
    pendingOperatorNotes: [],
    lastReceiptId: null,
  };
}

function cleanPlanTitle(raw: string): string {
  return raw
    .replace(/^\s*#+\s*/, "")
    .replace(/^Build:\s*/i, "")
    .trim();
}

function extractPlanTitle(text: string, objective: string): string {
  const heading = text.match(/^\s*#\s+(.+)$/m)?.[1];
  const cleaned = heading ? cleanPlanTitle(heading) : "";
  return cleaned || objective || "Build plan";
}

function stripLeadingPlanTitle(text: string): string {
  return text.replace(/^\s*#\s+.+(?:\r?\n)+/, "").trimStart();
}

function extractPlanStatus(text: string, state: BuildRunState | null): string {
  return text.match(/^\s*Status:\s*(.+?)\s*$/im)?.[1]?.trim() ?? buildStatusLabel(state?.status);
}

function planTextsAreEquivalent(a: string, b: string): boolean {
  const normalize = (v: string) => v.trim().toLowerCase().replace(/\s+/g, " ");
  return normalize(a) === normalize(b);
}

export function BuildPlanReviewModal({
  activeTabId,
  sessionCwd,
  eventsLen,
  openRequestSeq,
  closeRequestSeq,
  debugFixture,
  onPreviewFile,
  onAccepted,
  onReviewLater,
}: BuildPlanReviewModalProps): JSX.Element | null {
  const [state, setState] = useState<BuildRunState | null>(null);
  const [planText, setPlanText] = useState("");
  const [readError, setReadError] = useState<string | null>(null);
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  const [rejectArmed, setRejectArmed] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const lastCloseRequestSeq = useRef(closeRequestSeq);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const debugState = useMemo(
    () => debugFixture === "owned-ready" && activeTabId
      ? ownedDebugBuildState(activeTabId)
      : null,
    [activeTabId, debugFixture],
  );
  const effectiveState = debugState ?? state;
  const effectivePlanText = debugState ? OWNED_DEBUG_PLAN_TEXT : planText;

  useEffect(() => {
    if (debugFixture === "owned-ready") return;
    if (!activeTabId || !inTauri()) {
      setState(null);
      return;
    }
    let cancelled = false;
    const fetchState = () => {
      void getBuildState(activeTabId)
        .then((next) => {
          if (!cancelled) setState(next);
        })
        .catch(() => {
          if (!cancelled) setState(null);
        });
    };
    fetchState();
    const id = window.setInterval(fetchState, 2500);
    return () => { cancelled = true; window.clearInterval(id); };
  }, [activeTabId, eventsLen, debugFixture]);

  const scratchboardPath = effectiveState?.scratchboardPath ?? "";
  useEffect(() => {
    if (debugFixture === "owned-ready") {
      setReadError(null);
      return;
    }
    if (!activeTabId || !scratchboardPath) {
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
        sessionCwd,
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
  }, [activeTabId, sessionCwd, scratchboardPath, effectiveState?.status, eventsLen, debugFixture]);

  const approvalReadiness = buildApprovalReadinessFromText(effectivePlanText);
  const ready = Boolean(effectiveState && effectiveState.status === "awaitingApproval" && approvalReadiness.ready);
  const planKey = useMemo(
    () => activeTabId && scratchboardPath
      ? `${activeTabId}:${scratchboardPath}:${effectiveState?.runId ?? ""}`
      : null,
    [activeTabId, scratchboardPath, effectiveState?.runId],
  );
  const open = ready && planKey !== null && dismissedKey !== planKey;
  useModalFocus(open, dialogRef, dismissToRail);

  useEffect(() => {
    if (openRequestSeq === undefined) return;
    setDismissedKey(null);
    setActionError(null);
    setRejectArmed(false);
  }, [openRequestSeq]);

  useEffect(() => {
    if (closeRequestSeq === undefined) return;
    if (lastCloseRequestSeq.current === closeRequestSeq) return;
    lastCloseRequestSeq.current = closeRequestSeq;
    if (planKey) {
      setDismissedKey(planKey);
      setActionError(null);
      setRejectArmed(false);
    }
  }, [closeRequestSeq, planKey]);

  useEffect(() => {
    if (effectiveState?.status !== "awaitingApproval") {
      setBusy(null);
      setActionError(null);
      setRejectArmed(false);
    }
  }, [effectiveState?.status]);

  if (!open || !effectiveState || !activeTabId) return null;

  const lineCount = effectivePlanText ? effectivePlanText.split("\n").length : 0;
  const phaseCount = (effectivePlanText.match(/^##\s+Phase\b/gim) ?? []).length;
  const planTitle = extractPlanTitle(effectivePlanText, effectiveState.objective);
  const planStatus = extractPlanStatus(effectivePlanText, effectiveState);
  const displayPlanText = stripLeadingPlanTitle(effectivePlanText);
  const markdownText = displayPlanText.trim() ? displayPlanText : effectivePlanText;
  const objectiveText = effectiveState.objective.trim();
  const showObjective =
    objectiveText.length > 0 &&
    !planTextsAreEquivalent(objectiveText, planTitle);

  function dismissToRail(): void {
    if (planKey) setDismissedKey(planKey);
    setRejectArmed(false);
    onReviewLater();
  }

  function approve(): void {
    if (busy || debugFixture === "owned-ready" || !inTauri()) return;
    setRejectArmed(false);
    setBusy("approve");
    setActionError(null);
    void invoke<boolean>("approve_build_plan", { tabId: activeTabId })
      .then((flipped) => {
        if (flipped) {
          if (planKey) setDismissedKey(planKey);
          onAccepted();
        } else {
          setActionError("Build plan was not approved. Reconnect the session and try again.");
        }
      })
      .catch((err) => setActionError(String(err)))
      .finally(() => setBusy(null));
  }

  function reject(): void {
    if (busy || debugFixture === "owned-ready" || !inTauri()) return;
    if (!rejectArmed) {
      setRejectArmed(true);
      setActionError("Click Confirm reject to halt this Build Mode run.");
      return;
    }
    setBusy("reject");
    setRejectArmed(false);
    setActionError(null);
    void invoke<boolean>("reject_build_plan", { tabId: activeTabId })
      .then((rejected) => {
        if (rejected) {
          if (planKey) setDismissedKey(planKey);
          onReviewLater();
        } else {
          setActionError("Build plan was not rejected. It may no longer be awaiting approval.");
        }
      })
      .catch((err) => setActionError(String(err)))
      .finally(() => setBusy(null));
  }

  return (
    <div
      className="preview-backdrop"
      data-build-plan-debug-fixture={debugFixture === "owned-ready" ? "owned-ready" : undefined}
    >
      <div ref={dialogRef} data-debug-id="surface-components-buildplanreviewmodal-1" className="preview-modal plan-review-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label={`Review build plan: ${planTitle}`}>
        <div className="plan-review-shell">
          <div className="plan-review-topbar">
            <div className="plan-review-kicker">Build plan review</div>
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
              <div className="preview-loading">{approvalReadiness.reason}</div>
            )}
          </div>
          <div className="plan-review-actions">
            <button
              type="button"
              className="pact plan-action plan-action-quiet"
              disabled={busy !== null}
              onClick={dismissToRail}
            >
              Review later
            </button>
            {actionError && <span className="goal-status-meta" title={actionError}>{actionError}</span>}
            <div className="plan-review-action-spacer" />
            <button data-debug-id="surface-components-buildplanreviewmodal-4"
              type="button"
              className="pact plan-action plan-action-danger"
              data-shellx-release-observe="title disabled"
              title={rejectArmed
                ? "Confirm rejection and halt this Build Mode run"
                : "Reject this Build Mode plan"}
              disabled={busy !== null || debugFixture === "owned-ready"}
              onClick={reject}
            >
              {busy === "reject" ? "Rejecting..." : rejectArmed ? "Confirm reject" : "Reject"}
            </button>
            <button data-debug-id="surface-components-buildplanreviewmodal-5"
              type="button"
              className="pact plan-action plan-action-primary"
              disabled={busy !== null || debugFixture === "owned-ready"}
              onClick={approve}
            >
              {busy === "approve" ? "Approving..." : "Accept plan"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
