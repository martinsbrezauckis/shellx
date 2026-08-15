import type { JSX } from "react";
import type { TaskDefinitionDetail, TaskRunHistoryEntry } from "../lib/task-manager-contract";
import {
  formatTaskReceiptTime,
  taskEnvironmentReceiptPresentation,
  taskResultEvidencePresentation,
  taskTraceEvidencePresentation,
  taskRunStatePresentation,
  taskTimelineForDisplay,
  taskTimelinePresentation,
} from "../lib/task-manager-history-projection";
import { ShellIcon } from "./icons";
import "./TaskRunHistory.css";

export function TaskRunHistory({
  detail,
  busyAction,
  onOpenRun,
  connected,
  onCancelRun,
  cancelConnected,
}: {
  detail: TaskDefinitionDetail;
  busyAction: string | null;
  onOpenRun: (runId: string) => void;
  connected: boolean;
  onCancelRun: (run: TaskRunHistoryEntry) => void;
  cancelConnected: boolean;
}): JSX.Element {
  return (
    <section className="task-manager-section task-manager-history" aria-labelledby="task-manager-history-heading">
      <div className="task-manager-section-heading">
        <div>
          <p className="task-manager-section-kicker">Append-only receipt chain</p>
          <h3 id="task-manager-history-heading">Run history</h3>
        </div>
      </div>
      {detail.runHistory.length === 0 ? (
        <p className="task-manager-muted">No runs have been recorded for this revision.</p>
      ) : (
        <ol className="task-manager-run-list">
          {detail.runHistory.map((run) => (
            <TaskRunTimeline
              key={run.id}
              run={run}
              busyAction={busyAction}
              onOpenRun={onOpenRun}
              connected={connected}
              onCancelRun={onCancelRun}
              cancelConnected={cancelConnected}
            />
          ))}
        </ol>
      )}
    </section>
  );
}

function TaskRunTimeline({
  run,
  busyAction,
  onOpenRun,
  connected,
  onCancelRun,
  cancelConnected,
}: {
  run: TaskRunHistoryEntry;
  busyAction: string | null;
  onOpenRun: (runId: string) => void;
  connected: boolean;
  onCancelRun: (run: TaskRunHistoryEntry) => void;
  cancelConnected: boolean;
}): JSX.Element {
  const state = taskRunStatePresentation(run.state);
  const timeline = taskTimelineForDisplay(run);
  const environmentReceipts = taskEnvironmentReceiptPresentation(run);
  const resultEvidence = taskResultEvidencePresentation(run);
  const traceEvidence = taskTraceEvidencePresentation(run);
  const traceEvidenceTime = formatTaskReceiptTime(traceEvidence?.occurredAtMs);
  const resultEvidenceTime = formatTaskReceiptTime(resultEvidence?.occurredAtMs);
  const timestamp = formatTaskReceiptTime(run.completedAtMs ?? run.startedAtMs);
  const receiptCount = Number.isInteger(run.receiptCount) && run.receiptCount! > 0 ? run.receiptCount : undefined;
  const title = `${state.label}${timestamp ? ` · ${timestamp}` : ""}`;
  const openableSessionId = run.conversationSessionId?.trim();
  const openDisabledReason = !connected
    ? "Opening task runs is not connected."
    : !openableSessionId
      ? "This occurrence has no recorded ShellX Task conversation."
      : undefined;
  const cancelDisabledReason = run.state !== "running"
    ? "Only an active run can be cancelled."
    : !cancelConnected
      ? "Cancelling task runs is not connected."
      : !run.attemptId
        ? "This run has no active attempt receipt."
        : undefined;

  return (
    <li className={`task-manager-run task-manager-run-${state.tone}`} data-debug-id={`task-manager-run-${run.id}`}>
      <div className="task-manager-run-heading">
        <div>
          <strong className={`task-manager-run-state state-${state.tone}`}>{state.label}</strong>
          {timestamp && <time dateTime={new Date(run.completedAtMs ?? run.startedAtMs!).toISOString()}>{timestamp}</time>}
        </div>
        <div className="task-manager-run-actions">
          {run.state === "running" && <button
            type="button"
            data-debug-id={`task-manager-cancel-run-${run.id}`}
            data-shellx-release-observe="disabled title"
            onClick={() => onCancelRun(run)}
            disabled={Boolean(cancelDisabledReason) || busyAction !== null}
            title={cancelDisabledReason ?? "Cancel this active run"}
            aria-label={`Cancel task run: ${title}`}
          >Cancel run <ShellIcon name="square" size={13} /></button>}
          <button
            type="button"
            data-debug-id={`task-manager-open-run-${run.id}`}
            data-shellx-release-observe="disabled title"
            onClick={() => openableSessionId && onOpenRun(openableSessionId)}
            disabled={Boolean(openDisabledReason) || busyAction !== null}
            title={openDisabledReason ?? "Open this run"}
            aria-label={`Open task run: ${title}`}
          >
            Open run <ShellIcon name="external-link" size={13} />
          </button>
        </div>
      </div>
      {receiptCount && <p className="task-manager-run-receipt-count">{receiptCount} receipt{receiptCount === 1 ? "" : "s"} recorded</p>}
      {environmentReceipts.length > 0 && (
        <dl className="task-manager-environment-receipts" aria-label="Task environment evidence">
          {environmentReceipts.map((receipt) => {
            const receivedAt = formatTaskReceiptTime(receipt.occurredAtMs);
            return <div key={receipt.kind} data-debug-id={`task-manager-run-environment-${receipt.kind}`}>
              <dt>{receipt.label}</dt>
              <dd>{receipt.detail}{receivedAt ? ` · ${receivedAt}` : ""}</dd>
            </div>;
          })}
        </dl>
      )}
      {traceEvidence && (
        <dl className="task-manager-environment-receipts" aria-label="Task conversation evidence">
          <div data-debug-id="task-manager-run-trace-evidence">
            <dt>{traceEvidence.label}</dt>
            <dd>
              {traceEvidence.detail}
              {traceEvidenceTime ? ` · ${traceEvidenceTime}` : ""}
            </dd>
          </div>
        </dl>
      )}
      {resultEvidence && (
        <dl className="task-manager-environment-receipts" aria-label="Task result evidence">
          <div data-debug-id="task-manager-run-result-evidence">
            <dt>{resultEvidence.label}</dt>
            <dd>
              {resultEvidence.detail}
              {resultEvidenceTime ? ` · ${resultEvidenceTime}` : ""}
            </dd>
          </div>
        </dl>
      )}
      {timeline.length === 0 ? (
        <p className="task-manager-run-empty">A compact receipt state is recorded for this occurrence.</p>
      ) : (
        <ol className="task-manager-receipt-timeline" aria-label="Receipt timeline">
          {timeline.map((entry) => {
            const presentation = taskTimelinePresentation(entry);
            const occurredAt = formatTaskReceiptTime(entry.occurredAtMs);
            return (
              <li key={entry.receiptId} className={`timeline-${presentation.tone}`} data-debug-id="task-manager-receipt">
                <span className="task-manager-timeline-dot" aria-hidden="true" />
                <div>
                  <strong>{presentation.label}</strong>
                  <small>{presentation.detail}</small>
                </div>
                {occurredAt && <time dateTime={new Date(entry.occurredAtMs).toISOString()}>{occurredAt}</time>}
              </li>
            );
          })}
        </ol>
      )}
    </li>
  );
}
