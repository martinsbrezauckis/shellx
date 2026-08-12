import type { JSX } from "react";

import { ShellIcon } from "../../components/icons";
import type { BrowserEvidenceRow } from "../browserEvidence";
import { BrowserDeveloperInspection } from "./BrowserDeveloperInspection";
import { selectBrowserTeachSource } from "../browserTeach";
import { useBrowserEvidence } from "../hooks/useBrowserEvidence";
import { useBrowserTeach } from "../hooks/useBrowserTeach";
import "../browserEvidence.css";
import { BrowserTeachReview } from "./BrowserTeachReview";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KiB`;
}

function formatRecordedAt(value: number): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Unknown time" : date.toLocaleString();
}

function shortId(value: string): string {
  return value.length > 30 ? `${value.slice(0, 18)}…${value.slice(-8)}` : value;
}

function BrowserEvidenceReceipt({ row }: { row: BrowserEvidenceRow }): JSX.Element {
  const evaluation = row.kind === "browserEvaluationReportWritten";
  const identityId = row.identity.reportId ?? row.identity.attemptId ?? row.receiptId;
  const completeness = evaluation
    ? row.identity.evidenceComplete === true ? "Complete" : "Incomplete"
    : row.identity.evidenceComplete === true
      ? "Complete"
      : row.identity.evidenceComplete === false ? "Gapped" : "Recorded";
  const detail = evaluation
    ? `${row.identity.baselineAttempts ?? 0} baseline · ${row.identity.candidateAttempts ?? 0} candidate`
    : `${row.identity.events ?? 0} events · ${row.identity.receipts ?? 0} receipts`
      + `${row.identity.gapCount ? ` · ${row.identity.gapCount} gap${row.identity.gapCount === 1 ? "" : "s"}` : ""}`
      + `${row.identity.sanitizerLossCount ? ` · ${row.identity.sanitizerLossCount} bounded value${row.identity.sanitizerLossCount === 1 ? "" : "s"}` : ""}`;
  return (
    <article className={`shellx-browser-evidence-row ${evaluation ? "evaluation" : "attempt"}`}>
      <div className="shellx-browser-evidence-row-head">
        <span className="shellx-browser-evidence-kind">
          <ShellIcon name={evaluation ? "activity" : "history"} size={13} />
          {evaluation ? "Evaluation" : "Attempt"}
        </span>
        <span className={`shellx-browser-evidence-status ${completeness === "Gapped" ? "incomplete" : completeness.toLowerCase()}`}>{completeness}</span>
      </div>
      <strong title={identityId}>{shortId(identityId)}</strong>
      <div className="shellx-browser-evidence-metrics">
        {evaluation && row.identity.improvementRating && <span>Rating: {row.identity.improvementRating}</span>}
        <span>{detail}</span>
        <span>{formatBytes(row.identity.bytes)}</span>
      </div>
      <code title={row.identity.sha256}>sha256 {row.identity.sha256.slice(0, 16)}…</code>
      <small>{formatRecordedAt(row.recordedAtMs)}</small>
    </article>
  );
}

export function BrowserEvidencePanel({
  open,
  activeTaskId,
}: {
  open: boolean;
  activeTaskId?: string | null;
}): JSX.Element | null {
  const evidence = useBrowserEvidence(open);
  const rows = evidence.summary?.rows ?? [];
  const teachSource = selectBrowserTeachSource({
    activeTaskId,
    rows,
    recordedAttempt: evidence.recordedAttempt,
    loading: evidence.loading,
    recording: evidence.recording,
    error: evidence.error,
  });
  const teachTaskId = activeTaskId?.trim()
    || (teachSource.kind === "ready" || teachSource.kind === "evidenceGapped"
      ? teachSource.candidate.taskId
      : null);
  const teach = useBrowserTeach(teachTaskId);
  if (!open) return null;
  const teachPreparing = teach.phase === "preparing";
  const teachActionEnabled = teachSource.kind === "ready" && !teach.draft && !teachPreparing && teach.phase === "idle";
  const teachActionTitle = teach.draft
    ? "Review the current Teach draft below"
    : teachSource.kind === "noTask"
      ? "Record and complete a browser task first"
      : teachSource.kind === "loading"
        ? "Checking for a complete recorded attempt"
        : teachSource.kind === "recording"
          ? "Wait for the Flight Recorder export to finish"
          : teachSource.kind === "noAttempt"
            ? "Record one complete Browser attempt for the current task first"
            : teachSource.kind === "evidenceGapped"
              ? activeTaskId
                ? "The current task has only evidence-gapped attempts; record a complete attempt first"
                : "The most recent completed task has only evidence-gapped attempts; record a complete attempt first"
              : teachSource.kind === "unavailable"
                ? "Browser evidence is unavailable; retry once the native runtime is ready"
                : teach.phase === "error" || teach.phase === "unavailable"
                  ? "Use the bounded retry in Teach workflow before preparing another draft"
                  : teach.phase === "stale"
                    ? "Reload the current revision in Teach workflow before preparing another draft"
                    : activeTaskId
                      ? "Prepare a reversible review draft from this exact complete attempt"
                      : "Prepare a reversible review draft from the most recent complete recorded attempt";
  const durableRecovered = evidence.summary?.durableRecovered ?? 0;
  const durableIndexPartial = Boolean(
    evidence.summary?.durableScanFailed
      || evidence.summary?.durableScanTruncated
      || evidence.summary?.durableSkipped,
  );
  return (
    <section
      id="shellx-browser-panel-evidence"
      role="tabpanel"
      aria-labelledby="shellx-browser-right-tab-evidence"
      className="shellx-browser-evidence-panel shellx-browser-scroll-panel"
      data-debug-id="shellx-browser-evidence-panel"
      data-browser-evidence-manual-refresh-sequence={evidence.manualRefreshSequence}
      data-browser-evidence-manual-refresh-completed-at-ms={evidence.manualRefreshCompletedAtMs ?? ""}
    >
      <header className="shellx-browser-evidence-head">
        <div>
          <strong>Flight Recorder</strong>
          <span aria-live="polite">
            {evidence.loading
              ? "Loading identity receipts…"
              : `${rows.length} identity receipt${rows.length === 1 ? "" : "s"}${durableRecovered ? ` · ${durableRecovered} restored` : ""}`}
          </span>
        </div>
        <div className="shellx-browser-evidence-actions">
          <button
            type="button"
            className="shellx-browser-secondary"
            onClick={() => activeTaskId && void evidence.recordAttempt(activeTaskId)}
            disabled={!activeTaskId || evidence.recording || evidence.loading}
            data-debug-id="shellx-browser-evidence-record"
            data-shellx-release-observe="disabled title"
            title={activeTaskId ? "Export a bounded, redacted attempt for the current task" : "Start or select a browser task first"}
          >
            <ShellIcon name="history" size={13} />
            {evidence.recording ? "Recording…" : "Record attempt"}
          </button>
          <button
            type="button"
            className="shellx-browser-secondary"
            onClick={() => teachSource.kind === "ready" && void teach.prepare(teachSource.candidate)}
            disabled={!teachActionEnabled}
            data-debug-id="shellx-browser-evidence-teach-workflow"
            data-shellx-release-observe="disabled title"
            title={teachActionTitle}
          >
            <ShellIcon name="sparkles" size={13} />
            {teachPreparing ? "Preparing…" : "Teach workflow"}
          </button>
          <button
            type="button"
            className="shellx-browser-secondary"
            onClick={() => void evidence.refresh()}
            disabled={evidence.loading || evidence.recording}
            data-debug-id="shellx-browser-evidence-refresh"
            data-shellx-release-observe="disabled title"
            title={`Flight Recorder refresh receipt · sequence=${evidence.manualRefreshSequence} · completedAtMs=${evidence.manualRefreshCompletedAtMs ?? "none"}`}
          >
            <ShellIcon name="refresh" size={13} />
            Refresh
          </button>
        </div>
      </header>
      {evidence.recordedAttempt && !evidence.error && (
        <div className={`shellx-browser-evidence-recorded ${evidence.recordedAttempt.evidenceComplete ? "complete" : "incomplete"}`} role="status">
          <strong>{evidence.recordedAttempt.evidenceComplete ? "Attempt recorded" : "Attempt recorded with evidence gaps"}</strong>
          <span>
            {shortId(evidence.recordedAttempt.attemptId)} · {evidence.recordedAttempt.events} events · {evidence.recordedAttempt.gapCount} gaps
            {evidence.recordedAttempt.sanitizerLossCount ? ` · ${evidence.recordedAttempt.sanitizerLossCount} bounded values` : ""}
          </span>
        </div>
      )}
      {evidence.error && (
        <div className="shellx-browser-evidence-error" role="alert">
          <strong>Evidence unavailable</strong>
          <span>{evidence.error}</span>
        </div>
      )}
      <BrowserDeveloperInspection activeTaskId={activeTaskId} />
      <BrowserTeachReview source={teachSource} teach={teach} />
      {!evidence.error && durableIndexPartial && (
        <div className="shellx-browser-evidence-warning" role="status">
          Stored evidence is partially indexed. Current receipts remain available; older or invalid artifacts were omitted.
        </div>
      )}
      {!evidence.error && !evidence.loading && rows.length === 0 && (
        <div className="shellx-browser-empty-state" data-debug-id="shellx-browser-evidence-empty">
          No recorder attempts or evaluations yet. Current and stored exports appear here as bounded identity receipts.
        </div>
      )}
      {!evidence.error && rows.length > 0 && (
        <div className="shellx-browser-evidence-list">
          {rows.map((row) => <BrowserEvidenceReceipt key={row.receiptId} row={row} />)}
        </div>
      )}
    </section>
  );
}
