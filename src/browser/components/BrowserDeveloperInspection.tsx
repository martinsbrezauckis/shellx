import type { JSX } from "react";

import { ShellIcon } from "../../components/icons";
import { isTrustedShellxUserEvent } from "../../lib/trusted-user-event";
import {
  developerInspectionHasLoss,
  type BrowserDeveloperArtifactReceipt,
  type BrowserDeveloperInspectionSnapshot,
  type BrowserDeveloperInspectionUiState,
} from "../browserDeveloperInspection";
import { useBrowserDeveloperInspection } from "../hooks/useBrowserDeveloperInspection";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(bytes < 10_240 ? 1 : 0)} KiB`;
}

function formatTime(value: number): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Unknown time" : date.toLocaleString();
}

function shortId(value: string): string {
  return value.length > 28 ? `${value.slice(0, 16)}…${value.slice(-8)}` : value;
}

function stateCopy(state: BrowserDeveloperInspectionUiState, error: string | null, resultError: string | null): { title: string; detail: string } {
  switch (state) {
    case "no-task": return { title: "No current task", detail: "Start or select a Browser task before inspecting a page." };
    case "loading": return { title: "Inspecting page", detail: "Collecting bounded native Browser evidence…" };
    case "native-engine-unavailable": return { title: "Native engine unavailable", detail: resultError ?? "The current task has no available native Browser engine." };
    case "developer-mode-required": return { title: "Developer Mode required", detail: "This page requires an operator-approved Browser Developer Mode session." };
    case "empty-clean": return { title: "No issues found", detail: "The bounded checks and summaries returned cleanly." };
    case "partial": return { title: "Partial inspection", detail: "Some requested evidence was withheld or truncated; inspect the loss counts below." };
    case "failed": return { title: "Inspection failed", detail: resultError ?? error ?? "Developer inspection could not be completed." };
    case "success": return { title: "Inspection ready", detail: "Bounded native evidence is available for the current page." };
    default: return { title: "Ready to inspect", detail: "Inspect the current task page through the native Browser engine." };
  }
}

function actionTitle(state: BrowserDeveloperInspectionUiState, action: "inspect" | "har" | "performance"): string {
  if (state === "no-task") return "Start or select a browser task first";
  if (state === "loading") return "Wait for the current inspection to finish";
  if (action === "inspect") return "Inspect the current page with bounded, sanitized native Browser evidence";
  return `Export a private sanitized ${action === "har" ? "HAR" : "performance"} artifact; only its receipt identity is shown here`;
}

function countSummary(counts: Record<string, number>): string {
  const entries = Object.entries(counts).filter(([, value]) => value > 0);
  return entries.length ? entries.slice(0, 4).map(([key, value]) => `${key} ${value}`).join(" · ") : "None";
}

function Receipt({ artifact }: { artifact: BrowserDeveloperArtifactReceipt }): JSX.Element {
  return (
    <div className="shellx-browser-developer-artifact" data-debug-id={`shellx-browser-developer-${artifact.kind}-receipt`}>
      <strong>{artifact.kind === "har" ? "HAR" : "Performance"} receipt</strong>
      <span title={`${artifact.receiptId} · ${artifact.bytes} B · sha256 ${artifact.sha256}`} data-shellx-release-observe="title">{shortId(artifact.receiptId)} · {formatBytes(artifact.bytes)} · sha256 {artifact.sha256.slice(0, 16)}…</span>
    </div>
  );
}

function InspectionSummary({ inspection, completedAtMs }: { inspection: BrowserDeveloperInspectionSnapshot; completedAtMs: number | null }): JSX.Element {
  const loss = developerInspectionHasLoss(inspection);
  const visibleIssues = inspection.issues.slice(0, 12);
  const visibleResources = inspection.performance.resourceAggregates.slice(0, 4);
  return (
    <div className="shellx-browser-developer-summary" data-debug-id="shellx-browser-developer-summary">
      <div className="shellx-browser-developer-identity" data-debug-id="shellx-browser-developer-last-inspected">
        <strong>{inspection.document.title || "Missing"}</strong>
        <span>{inspection.inspected.origin ?? "Sanitized origin withheld"}{inspection.inspected.path ?? ""}</span>
        <small>task {inspection.inspected.taskId ? shortId(inspection.inspected.taskId) : "withheld"} · tab {inspection.inspected.browserTabId ? shortId(inspection.inspected.browserTabId) : "withheld"} · UI received {completedAtMs === null ? "unknown time" : formatTime(completedAtMs)} · {formatBytes(inspection.serializedBytes)}</small>
      </div>
      <dl className="shellx-browser-developer-metrics" data-debug-id="shellx-browser-developer-page-summary">
        <div><dt>Document</dt><dd>{inspection.document.readyState}</dd></div>
        <div><dt>Viewport</dt><dd>{inspection.document.viewport.width}×{inspection.document.viewport.height}</dd></div>
        <div><dt>Language</dt><dd>{inspection.document.language || "Missing"}</dd></div>
        <div><dt>Headings</dt><dd>{inspection.document.headingCount}</dd></div>
      </dl>
      <div className="shellx-browser-developer-streams">
        <section data-debug-id="shellx-browser-developer-console-summary">
          <strong>Console</strong>
          <span>{countSummary(inspection.console.severityCounts)}</span>
          <small>{inspection.console.recent.length} sanitized recent line{inspection.console.recent.length === 1 ? "" : "s"}</small>
        </section>
        <section data-debug-id="shellx-browser-developer-network-summary">
          <strong>Network</strong>
          <span>{countSummary(inspection.network.outcomeCounts)}</span>
          <small>{inspection.network.recent.length} sanitized request row{inspection.network.recent.length === 1 ? "" : "s"}</small>
        </section>
        <section data-debug-id="shellx-browser-developer-performance-summary">
          <strong>Performance</strong>
          <span>{inspection.performance.navigation ? `load ${inspection.performance.navigation.loadMs} ms` : "Navigation timing unavailable"}</span>
          <small>{visibleResources.length ? visibleResources.map((resource) => `${resource.resourceType} ${resource.count}`).join(" · ") : "No resource aggregates"}</small>
        </section>
      </div>
      <section className="shellx-browser-developer-issues" data-debug-id="shellx-browser-developer-issues" aria-label="Developer inspection issues">
        <div className="shellx-browser-developer-section-head">
          <strong>Issues</strong>
          <span>{inspection.issues.length}{inspection.truncation.issuesOmitted ? ` shown · ${inspection.truncation.issuesOmitted} omitted` : " found"}</span>
        </div>
        {visibleIssues.length === 0 ? (
          <p className="shellx-browser-developer-clean" data-debug-id="shellx-browser-developer-clean">No deterministic issues found.</p>
        ) : (
          <ol>
            {visibleIssues.map((issue) => (
              <li key={issue.issueId} className={`severity-${issue.severity}`}>
                <span>{issue.severity}</span>
                <div><strong>{issue.category}</strong><p>{issue.evidence}</p><small>{issue.remediation}</small></div>
              </li>
            ))}
          </ol>
        )}
      </section>
      {loss && (
        <div className="shellx-browser-developer-partial" data-debug-id="shellx-browser-developer-partial" role="status">
          Partial evidence: {inspection.truncation.consoleOmitted} console line{inspection.truncation.consoleOmitted === 1 ? "" : "s"}, {inspection.truncation.networkOmitted} network row{inspection.truncation.networkOmitted === 1 ? "" : "s"}, {inspection.truncation.resourceAggregatesOmitted} resource aggregate{inspection.truncation.resourceAggregatesOmitted === 1 ? "" : "s"}, and {inspection.truncation.sanitizationLosses} sanitized value{inspection.truncation.sanitizationLosses === 1 ? "" : "s"} withheld or truncated.
        </div>
      )}
    </div>
  );
}

export function BrowserDeveloperInspection({ activeTaskId }: { activeTaskId?: string | null }): JSX.Element {
  const developer = useBrowserDeveloperInspection(activeTaskId);
  const resultError = developer.result?.status === "inspected" ? null : developer.result?.error ?? null;
  const state = stateCopy(developer.state, developer.error, resultError);
  const inspection = developer.result?.status === "inspected" ? developer.result : null;
  const controlsDisabled = developer.busyAction !== null || developer.state === "no-task";
  return (
    <section className="shellx-browser-developer" aria-labelledby="shellx-browser-developer-heading" aria-busy={developer.busyAction !== null} data-debug-id="shellx-browser-developer-inspection">
      <div className="shellx-browser-developer-head">
        <div>
          <strong id="shellx-browser-developer-heading">Developer inspection</strong>
          <span>Current-page evidence from the native Browser engine</span>
        </div>
        <div className="shellx-browser-developer-actions">
          <button type="button" className="shellx-browser-secondary" onClick={() => void developer.inspect()} disabled={controlsDisabled} title={actionTitle(developer.state, "inspect")} data-debug-id="shellx-browser-developer-inspect">
            <ShellIcon name="search" size={13} />
            {developer.busyAction === "inspect" ? "Inspecting…" : "Inspect page"}
          </button>
          <button type="button" className="shellx-browser-secondary" onClick={() => void developer.exportHar()} disabled={controlsDisabled} title={actionTitle(developer.state, "har")} data-debug-id="shellx-browser-developer-export-har">
            <ShellIcon name="download" size={13} />
            {developer.busyAction === "har" ? "Exporting…" : "Export HAR"}
          </button>
          <button type="button" className="shellx-browser-secondary" onClick={() => void developer.exportPerformance()} disabled={controlsDisabled} title={actionTitle(developer.state, "performance")} data-debug-id="shellx-browser-developer-export-performance">
            <ShellIcon name="activity" size={13} />
            {developer.busyAction === "performance" ? "Exporting…" : "Export performance"}
          </button>
        </div>
      </div>
      <div className={`shellx-browser-developer-state state-${developer.state}`} data-debug-id={`shellx-browser-developer-state-${developer.state}`} role={developer.state === "failed" ? "alert" : "status"} aria-live="polite">
        <strong>{state.title}</strong>
        <span>{state.detail}</span>
      </div>
      {developer.state === "developer-mode-required" && (
        <div className="shellx-browser-developer-access" data-debug-id="shellx-browser-developer-access-required">
          <div>
            <strong>Allow Developer Mode for this site</strong>
            <span>Enables full CDP access for the current Browser host. Developer inspection still returns only its fixed, sanitized evidence model.</span>
          </div>
          <button
            type="button"
            className="shellx-browser-secondary shellx-browser-developer-permission-action"
            onClick={(event) => {
              if (isTrustedShellxUserEvent(event)) void developer.approveCurrentSite();
            }}
            disabled={developer.busyAction !== null}
            data-debug-id="shellx-browser-developer-approve-current-site"
            data-shellx-release-observe="disabled title"
            title="Approve Browser Developer Mode and full CDP access for the current site"
          >
            <ShellIcon name="check" size={13} />
            {developer.busyAction === "approve" ? "Approving…" : "Allow current site"}
          </button>
        </div>
      )}
      {inspection && <InspectionSummary inspection={inspection} completedAtMs={developer.completedAtMs} />}
      {inspection && (
        <div className="shellx-browser-developer-access active" data-debug-id="shellx-browser-developer-access-active">
          <div>
            <strong>Developer Mode active</strong>
            <span>This site is approved for full CDP access. Turn it off to clear all approved Browser hosts.</span>
          </div>
          <button
            type="button"
            className="shellx-browser-secondary"
            onClick={(event) => {
              if (isTrustedShellxUserEvent(event)) void developer.disableDeveloperMode();
            }}
            disabled={developer.busyAction !== null}
            data-debug-id="shellx-browser-developer-disable-mode"
            data-shellx-release-observe="disabled title"
            title="Disable Browser Developer Mode and clear every approved host"
          >
            <ShellIcon name="ban" size={13} />
            {developer.busyAction === "disable" ? "Turning off…" : "Turn off and clear"}
          </button>
        </div>
      )}
      <div className="shellx-browser-developer-artifacts" data-debug-id="shellx-browser-developer-artifacts">
        <span>Exports are private sanitized artifacts. This panel shows receipt identity, bytes, and hash prefix only.</span>
        {developer.artifacts.har && <Receipt artifact={developer.artifacts.har} />}
        {developer.artifacts.performance && <Receipt artifact={developer.artifacts.performance} />}
      </div>
    </section>
  );
}
