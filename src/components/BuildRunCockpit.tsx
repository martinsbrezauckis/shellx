import { useState, type JSX } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  buildApprovalReadinessFromText,
  buildActionFailureMessage,
  buildStatusLabel,
  type BuildReceipt,
  type BuildReceiptKind,
  type BuildRunState,
} from "../lib/build-run";
import { inTauri } from "../lib/tauri-bridge";
import { ShellIcon, type ShellIconName } from "./icons";

interface BuildRunCockpitProps {
  activeTabId?: string | null;
  state: BuildRunState | null;
  receipts: BuildReceipt[];
  scratchboardText?: string;
  onChanged?: () => void;
}

type Gate = {
  key: string;
  label: string;
  required: boolean;
  satisfied: boolean;
  title: string;
};

function receiptIcon(kind: BuildReceiptKind): ShellIconName {
  if (kind === "fileWrite" || kind === "fileCopy" || kind === "fileDelete") return "file";
  if (kind === "agentStarted" || kind === "agentCompleted") return "activity";
  if (kind === "reviewCompleted" || kind === "verificationCompleted" || kind === "previewDiagnosed") return "check";
  if (kind === "checkpointCreated") return "git-branch";
  if (kind === "runHalted") return "square";
  if (kind === "blockerOpened" || kind === "completionRejected" || kind === "transportFailure") return "alert";
  if (kind === "completionAccepted") return "circle-check";
  return "circle";
}

function receiptKindLabel(kind: BuildReceiptKind): string {
  return kind.replace(/([A-Z])/g, " $1").replace(/^./, (s) => s.toUpperCase());
}

function formatAge(ms: number): string {
  const delta = Math.max(0, Date.now() - ms);
  const sec = Math.floor(delta / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  return `${Math.floor(min / 60)}h`;
}

export function BuildRunCockpit({
  activeTabId,
  state,
  receipts,
  scratchboardText,
  onChanged,
}: BuildRunCockpitProps): JSX.Element | null {
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [showAllReceipts, setShowAllReceipts] = useState(false);

  if (!state) return null;

  const runAction = async (name: string, fn: () => Promise<unknown>): Promise<void> => {
    if (!activeTabId || !inTauri()) return;
    setBusy(name);
    setMessage(null);
    try {
      const result = await fn();
      if (result === false) {
        setMessage(buildActionFailureMessage(name));
      }
      onChanged?.();
    } catch (err: any) {
      setMessage(String(err));
    } finally {
      setBusy(null);
    }
  };

  const gates: Gate[] = [
    {
      key: "checkpoint",
      label: "Checkpoint",
      required: state.codeChanged,
      satisfied: Boolean(state.checkpointId),
      title: state.checkpointId ? `Checkpoint ${state.checkpointId}` : "Required after code changes.",
    },
    {
      key: "review",
      label: "Review",
      required: state.reviewRequired,
      satisfied: state.reviewSatisfied,
      title: "Satisfied by a trusted reviewer Agent receipt.",
    },
    {
      key: "verification",
      label: "Verify",
      required: state.verificationRequired,
      satisfied: state.verificationSatisfied,
      title: "Satisfied by a trusted verifier Agent or observed verification receipt.",
    },
    {
      key: "preview",
      label: "Preview",
      required: Boolean(state.previewRequired),
      satisfied: Boolean(state.previewSatisfied),
      title: "Satisfied by a successful shellX Preview Doctor receipt.",
    },
  ];

  const hiddenReceiptCount = Math.max(0, receipts.length - 6);
  const visibleReceipts = (showAllReceipts ? receipts : receipts.slice(-6)).slice().reverse();
  const approvalReadiness = buildApprovalReadinessFromText(scratchboardText);
  const canApprove = state.status === "awaitingApproval" && approvalReadiness.ready;
  const waitingForPlan = state.status === "awaitingApproval" && !approvalReadiness.ready;
  const canPause = state.status === "active";
  const canResume = state.status === "paused";
  const canCheckpoint = state.status === "active" || state.status === "paused";
  const canStop = state.status !== "complete" && state.status !== "halted";
  const statusText = waitingForPlan ? "Planning" : buildStatusLabel(state.status);

  return (
    <div className="build-cockpit" title={state.objective}>
      <div className="build-cockpit-top">
        <span className={`build-status-pill build-status-${state.status}`}>
          <ShellIcon name={state.status === "paused" ? "pause" : state.status === "awaitingApproval" ? "pencil" : "activity"} size={13} />
          Build {statusText}
        </span>
        <span className="build-meta">
          {state.continuationsTotal} cont · {formatAge(state.createdAtMs)}
        </span>
      </div>

      <div className="build-objective">{state.objective}</div>

      <div className="build-gates" aria-label="Build gates">
        {gates.map((gate) => (
          <span
            key={gate.key}
            className={`build-gate ${gate.satisfied ? "build-gate-ok" : gate.required ? "build-gate-required" : "build-gate-optional"}`}
            title={gate.title}
          >
            <ShellIcon name={gate.satisfied ? "check" : gate.required ? "alert" : "circle"} size={12} />
            {gate.label}
          </span>
        ))}
      </div>

      <div className="build-actions">
        {waitingForPlan && (
          <span className="goal-status-meta" title={approvalReadiness.reason}>
            planning…
          </span>
        )}
        {canApprove && (
          <>
            <button
              type="button"
              className="goal-status-btn goal-status-btn-approve"
              disabled={busy !== null}
              onClick={() => void runAction("approve", () => invoke("approve_build_plan", { tabId: activeTabId }))}
              title="Approve the Build Mode scratchboard and start execution."
            >
              <ShellIcon name="check" size={12} />
              Approve
            </button>
            <button
              type="button"
              className="goal-status-btn"
              disabled={busy !== null}
              onClick={() => void runAction("reject", () => invoke("reject_build_plan", { tabId: activeTabId }))}
              title="Reject this Build Mode plan and halt the run."
            >
              <ShellIcon name="close" size={12} />
              Reject
            </button>
          </>
        )}
        {canPause && (
          <button
            type="button"
            className="goal-status-btn"
            disabled={busy !== null}
            onClick={() => void runAction("pause", () => invoke("pause_build", { tabId: activeTabId }))}
            title="Pause Build Mode auto-continuation."
          >
            <ShellIcon name="pause" size={12} />
            Pause
          </button>
        )}
        {canResume && (
          <button
            type="button"
            className="goal-status-btn"
            disabled={busy !== null}
            onClick={() => void runAction("resume", () => invoke("resume_build", { tabId: activeTabId }))}
            title="Resume Build Mode auto-continuation."
          >
            <ShellIcon name="play" size={12} />
            Resume
          </button>
        )}
        {canCheckpoint && (
          <button
            type="button"
            className="goal-status-btn"
            disabled={busy !== null}
            onClick={() => void runAction("checkpoint", () => invoke("git_session_create_checkpoint", {
              tabId: activeTabId,
              label: `Build ${state.runId.slice(0, 12)}`,
            }))}
            title="Create a local shellX git checkpoint and attach it to this Build Mode run."
          >
            <ShellIcon name="git-branch" size={12} />
            Checkpoint
          </button>
        )}
        {canStop && (
          <button
            type="button"
            className="goal-status-btn goal-status-btn-complete"
            disabled={busy !== null}
            onClick={() => void runAction("stop", () => invoke("halt_build", {
              tabId: activeTabId,
              summary: "Stopped manually from Build cockpit",
            }))}
            title="Stop Build Mode manually without accepting completion."
          >
            <ShellIcon name="square" size={12} />
            Stop
          </button>
        )}
      </div>

      {state.openBlocker && (
        <div className="build-message build-message-warn">
          <ShellIcon name="alert" size={12} />
          {state.openBlocker}
        </div>
      )}
      {message && <div className="build-message">{message}</div>}

      {visibleReceipts.length > 0 && (
        <div className="build-receipts">
          <div className="build-receipts-head">
            <span>
              Receipt ledger · {receipts.length}
            </span>
            {hiddenReceiptCount > 0 && (
              <button
                type="button"
                className="build-receipts-toggle"
                onClick={() => setShowAllReceipts((cur) => !cur)}
                title={showAllReceipts ? "Show latest receipts only" : "Show every receipt in this Build Mode run"}
              >
                <ShellIcon name={showAllReceipts ? "chevron-down" : "activity"} size={12} />
                {showAllReceipts ? "Latest" : `All ${receipts.length}`}
              </button>
            )}
          </div>
          {visibleReceipts.map((receipt) => (
            <div key={receipt.receiptId} className={`build-receipt build-receipt-${receipt.confidence}`} title={receipt.summary}>
              <ShellIcon name={receiptIcon(receipt.kind)} size={12} />
              <span className="build-receipt-kind">{receiptKindLabel(receipt.kind)}</span>
              <span className="build-receipt-summary">{receipt.summary}</span>
              <span className="build-receipt-time">{formatAge(receipt.createdAtMs)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
