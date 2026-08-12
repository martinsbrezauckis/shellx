import { useState, type JSX } from "react";

import { ShellIcon } from "../../components/icons";
import { browserTeachHasIncompleteNavigationReplacement, type BrowserTeachSourceSelection } from "../browserTeach";
import { type BrowserTeachPhase, useBrowserTeach } from "../hooks/useBrowserTeach";

type BrowserTeachController = ReturnType<typeof useBrowserTeach>;

interface TeachStatePresentation {
  id: string;
  label: string;
  detail: string;
  tone: "neutral" | "ready" | "warning" | "error" | "success" | "running";
}

function shortId(value: string): string {
  return value.length > 30 ? `${value.slice(0, 18)}…${value.slice(-8)}` : value;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KiB`;
}

function boundedMessage(message: string | null, fallback: string): string {
  const normalized = message?.trim();
  return normalized ? normalized.slice(0, 280) : fallback;
}

function phasePresentation(phase: BrowserTeachPhase, error: string | null): TeachStatePresentation | null {
  switch (phase) {
    case "preparing":
      return { id: "preparing", label: "Preparing review", detail: "Checking the selected recorded attempt and creating its reversible review draft.", tone: "running" };
    case "saving":
      return { id: "saving", label: "Saving revision", detail: "Writing one compare-and-swap revision for the current draft.", tone: "running" };
    case "stale":
      return { id: "stale", label: "Revision conflict", detail: boundedMessage(error, "This revision is no longer current. Reload before approving."), tone: "warning" };
    case "approving":
      return { id: "approving", label: "Approving recipe", detail: "Creating an Action Recipe V2 draft. This does not run or apply it.", tone: "running" };
    case "approved":
      return { id: "approved", label: "Approved as recipe", detail: "A draft recipe now exists. It has not been run or applied.", tone: "success" };
    case "rehearsing":
      return { id: "rehearsing", label: "Rehearsal running", detail: "Planning the approved recipe as a dry run with no Browser actions applied.", tone: "running" };
    case "rehearsalReady":
      return { id: "rehearsal-ready", label: "Rehearsal ready", detail: "The approved recipe produced a dry-run plan with no applied Browser steps.", tone: "success" };
    case "rehearsalBlocked":
      return { id: "rehearsal-blocked", label: "Rehearsal blocked", detail: boundedMessage(error, "The matching approval or export receipt is unavailable; no recipe was applied."), tone: "warning" };
    case "rehearsalFailed":
      return { id: "rehearsal-failed", label: "Rehearsal failed", detail: boundedMessage(error, "The recipe was not applied. Retry after checking the approved recipe receipt."), tone: "error" };
    case "unavailable":
      return { id: "unavailable", label: "Native runtime unavailable", detail: boundedMessage(error, "Browser Teach requires the active ShellX desktop runtime."), tone: "warning" };
    case "error":
      return { id: "error", label: "Teach review needs attention", detail: boundedMessage(error, "The last Teach action did not complete. The draft remains unchanged."), tone: "error" };
    case "idle":
    case "reviewReady":
      return null;
  }
}

function sourcePresentation(source: BrowserTeachSourceSelection): TeachStatePresentation {
  switch (source.kind) {
    case "noTask":
      return { id: "idle", label: "No recorded task", detail: "Record and complete a Browser task before teaching a workflow.", tone: "neutral" };
    case "loading":
      return { id: "checking", label: "Checking recorded attempts", detail: "Teach becomes available after a complete attempt is identified.", tone: "running" };
    case "recording":
      return { id: "recording", label: "Recording attempt", detail: "Teach will check the current task once the bounded recorder export finishes.", tone: "running" };
    case "noAttempt":
      return { id: "no-attempt", label: "No attempt recorded", detail: "Record one complete Browser attempt for this task before preparing a workflow.", tone: "neutral" };
    case "evidenceGapped":
      return {
        id: "evidence-gapped",
        label: "Source evidence is gapped",
        detail: `${source.candidate.gapCount} evidence gap${source.candidate.gapCount === 1 ? "" : "s"} and ${source.candidate.sanitizerLossCount} bounded value loss${source.candidate.sanitizerLossCount === 1 ? "" : "es"} prevent Teach preparation.`,
        tone: "warning",
      };
    case "ready":
      return { id: "ready", label: "Complete attempt ready", detail: "Prepare a reversible review draft from this exact recorded attempt.", tone: "ready" };
    case "unavailable":
      return { id: "evidence-unavailable", label: "Evidence unavailable", detail: boundedMessage(source.message, "The recorded attempt cannot be checked right now."), tone: "error" };
  }
}

function currentPresentation(source: BrowserTeachSourceSelection, teach: BrowserTeachController): TeachStatePresentation {
  const fromPhase = phasePresentation(teach.phase, teach.error);
  if (fromPhase) return fromPhase;
  if (teach.draft && teach.isDirty) {
    return { id: "dirty", label: "Unsaved revision", detail: "Save the edited values, Vault key identities, and issue resolutions before approval can continue.", tone: "warning" };
  }
  if (teach.draft) {
    return { id: "review-ready", label: "Review ready", detail: "Inspect the evidence-bound draft, resolve blockers, then save before explicit approval.", tone: "ready" };
  }
  return sourcePresentation(source);
}

function isBusy(phase: BrowserTeachPhase): boolean {
  return phase === "preparing" || phase === "saving" || phase === "approving" || phase === "rehearsing";
}

function saveDisabledReason(teach: BrowserTeachController): string {
  if (!teach.draft) return "Prepare a Teach draft first";
  if (teach.phase === "stale") return "Reload the current revision before saving another edit";
  if (isBusy(teach.phase)) return "Wait for the current Teach action to finish";
  if (!teach.isDirty) return "There are no unsaved revision edits";
  return "Save the current edits as a new compare-and-swap revision";
}

function approveDisabledReason(teach: BrowserTeachController): string {
  if (!teach.draft) return "Prepare and save a Teach draft first";
  if (isBusy(teach.phase)) return "Wait for the current Teach action to finish";
  if (teach.approval) return "This exact saved revision is already approved as a recipe";
  if (teach.isDirty) return "Save the edited revision before approval";
  if (!teach.draft.isCurrent) return "Reload the current revision before approval";
  if (teach.hasBlockingIssues) return "Resolve every blocking ambiguity and required Vault binding before approval";
  return "Create an Action Recipe V2 draft without running or applying it";
}

function rehearseDisabledReason(teach: BrowserTeachController): string {
  if (!teach.approval) return "Approve this exact saved revision as a recipe before rehearsal";
  if (isBusy(teach.phase)) return "Wait for the current Teach action to finish";
  if (teach.isDirty) return "Save and approve the edited revision before rehearsal";
  return "Plan this exact approved recipe as a dry run without applying Browser actions";
}

function approvalCorrelation(recipeId: string, approvalId: string, revisionId: string): string {
  return `ShellX Browser Teach approval\nRecipe: ${recipeId}\nApproval: ${approvalId}\nRevision: ${revisionId}`;
}

function rehearsalCorrelation(recipeId: string, receiptId: string, revisionId: string): string {
  return `ShellX Browser Teach rehearsal\nRecipe: ${recipeId}\nReceipt: ${receiptId}\nRevision: ${revisionId}`;
}

export function BrowserTeachReview({
  source,
  teach,
}: {
  source: BrowserTeachSourceSelection;
  teach: BrowserTeachController;
}): JSX.Element {
  const [copiedReceipt, setCopiedReceipt] = useState<"approval" | "rehearsal" | null>(null);
  const state = currentPresentation(source, teach);
  const draft = teach.draft;
  const busy = isBusy(teach.phase);
  const canEdit = Boolean(draft && !busy && teach.phase !== "stale");
  const canSave = Boolean(draft && teach.isDirty && !busy && teach.phase !== "stale");
  const canApprove = Boolean(draft && !teach.approval && !teach.isDirty && draft.isCurrent && !teach.hasBlockingIssues && !busy);
  const canRehearse = Boolean(teach.approval && !teach.isDirty && !busy);
  const sourceDetails = draft?.bundle.source;
  const issues = draft ? [...draft.bundle.ambiguities, ...draft.bundle.loss] : [];
  const resolvableIssueIds = new Set(draft?.bundle.ambiguities.map((issue) => issue.issueId) ?? []);
  const unresolvedBlockingIssues = issues.filter((issue) => issue.blocking && (!resolvableIssueIds.has(issue.issueId) || !teach.ambiguityResolutions.includes(issue.issueId)));
  const missingBindings = draft?.revision.values.filter((value) => value.requiredVaultBinding && !(teach.vaultBindings[value.valueId] ?? "").trim()).length ?? 0;
  const incompleteNavigationReplacement = draft && browserTeachHasIncompleteNavigationReplacement(draft) ? 1 : 0;
  const canRetry = teach.phase === "error" || teach.phase === "unavailable" || teach.phase === "rehearsalBlocked" || teach.phase === "rehearsalFailed";
  const canReloadStale = teach.phase === "stale" && source.kind === "ready";
  const copyReceiptCorrelation = (kind: "approval" | "rehearsal", correlation: string): void => {
    if (!navigator.clipboard) return;
    void navigator.clipboard.writeText(correlation).then(() => setCopiedReceipt(kind)).catch(() => undefined);
  };
  return (
    <section className="shellx-browser-teach-section" aria-labelledby="shellx-browser-teach-heading" data-debug-id="shellx-browser-teach-review">
      <header className="shellx-browser-teach-head">
        <div>
          <strong id="shellx-browser-teach-heading">Teach workflow</strong>
          <span>Review one complete recorder attempt before creating a recipe draft.</span>
        </div>
        {draft && <code title={draft.revision.revisionId}>r{draft.revision.revision}</code>}
      </header>

      <div
        className={`shellx-browser-teach-state ${state.tone}`}
        role={state.tone === "error" ? "alert" : "status"}
        aria-live="polite"
        data-debug-id={`shellx-browser-teach-state-${state.id}`}
        data-browser-teach-state={state.id}
      >
        <ShellIcon name={state.tone === "success" || state.tone === "ready" ? "check" : state.tone === "running" ? "loader" : state.tone === "warning" || state.tone === "error" ? "alert" : "history"} size={13} />
        <div>
          <strong>{state.label}</strong>
          <span>{state.detail}</span>
        </div>
        {canRetry && (
          <button type="button" className="shellx-browser-secondary" onClick={() => void teach.retry()} disabled={busy} data-debug-id="shellx-browser-teach-retry" data-shellx-release-observe="disabled title" title="Retry the last bounded Teach action">
            <ShellIcon name="refresh" size={12} />
            Retry
          </button>
        )}
        {canReloadStale && (
          <button type="button" className="shellx-browser-secondary" onClick={() => void teach.prepare(source.candidate)} disabled={busy} data-debug-id="shellx-browser-teach-reload-stale" data-shellx-release-observe="disabled title" title="Reload the current revision for this exact source attempt; unsaved local edits will be replaced">
            <ShellIcon name="refresh" size={12} />
            Reload current
          </button>
        )}
      </div>

      {sourceDetails && draft && (
        <div className="shellx-browser-teach-source" data-debug-id="shellx-browser-teach-source">
          <div><span>Source attempt</span><code title={sourceDetails.attemptId}>{shortId(sourceDetails.attemptId)}</code></div>
          <div><span>Source task</span><code title={sourceDetails.taskId}>{shortId(sourceDetails.taskId)}</code></div>
          <div><span>Source hash</span><code title={sourceDetails.sha256}>sha256 {sourceDetails.sha256.slice(0, 16)}…</code></div>
          <div><span>Source size</span><strong>{formatBytes(sourceDetails.bytes)}</strong></div>
          <div className="shellx-browser-teach-redaction" data-debug-id="shellx-browser-teach-redaction">
            <span>Redaction</span>
            <strong>Verified</strong>
            <small>Secrets, cookies, headers, queries, page bodies, and screenshots are omitted.</small>
          </div>
        </div>
      )}

      {draft && (
        <div className="shellx-browser-teach-review-body">
          <label className="shellx-browser-teach-goal">
            <span>Workflow goal</span>
            <textarea value={teach.goal} onChange={(event) => teach.updateGoal(event.currentTarget.value)} disabled={!canEdit} rows={3} maxLength={300} data-debug-id="shellx-browser-teach-goal" data-shellx-release-observe="value disabled" aria-describedby="shellx-browser-teach-goal-hint" />
            <small id="shellx-browser-teach-goal-hint">Saving creates one new revision; source steps remain evidence-bound.</small>
          </label>

          <div className="shellx-browser-teach-summary" data-debug-id="shellx-browser-teach-action-summary">
            <div><span>Reads</span><strong>{draft.revision.actionSummary.reads}</strong><small>{draft.revision.actionSummary.assertions} assertions</small></div>
            <div><span>Derives</span><strong>{draft.revision.actionSummary.derives}</strong><small>{draft.revision.actionSummary.decisionPoints} decision points</small></div>
            <div><span>Actions</span><strong>{draft.revision.actionSummary.actions}</strong><small>{draft.revision.actionSummary.blockingIssues} unresolved blockers</small></div>
          </div>

          <section className="shellx-browser-teach-blockers" data-debug-id="shellx-browser-teach-blocking" aria-label="Teach review blocking status">
            <div>
              <strong>{unresolvedBlockingIssues.length || missingBindings || incompleteNavigationReplacement ? "Blocking review issues" : "No blocking review issues"}</strong>
              <span>{unresolvedBlockingIssues.length} unresolved ambiguity or loss record{unresolvedBlockingIssues.length === 1 ? "" : "s"} · {incompleteNavigationReplacement} incomplete navigation replacement{incompleteNavigationReplacement === 1 ? "" : "s"} · {missingBindings} missing Vault binding{missingBindings === 1 ? "" : "s"}</span>
            </div>
            <span className={`shellx-browser-teach-blocking-status ${unresolvedBlockingIssues.length || missingBindings || incompleteNavigationReplacement ? "blocked" : "clear"}`}>{unresolvedBlockingIssues.length || missingBindings || incompleteNavigationReplacement ? "Approval blocked" : "Ready for approval"}</span>
          </section>

          {issues.length > 0 && (
            <section className="shellx-browser-teach-list-section" aria-labelledby="shellx-browser-teach-issues-heading">
              <div className="shellx-browser-teach-section-head"><strong id="shellx-browser-teach-issues-heading">Ambiguity and loss review</strong><span>{issues.length} recorded</span></div>
              <div className="shellx-browser-teach-issues" data-debug-id="shellx-browser-teach-issues">
                {issues.map((issue) => {
                  const resolvable = resolvableIssueIds.has(issue.issueId);
                  const resolved = resolvable && teach.ambiguityResolutions.includes(issue.issueId);
                  const issueClass = resolved ? "resolved" : issue.blocking ? "blocking" : "";
                  const issueLabel = !resolvable
                    ? "Source loss"
                    : resolved
                      ? issue.blocking ? "Resolved blocker" : "Resolved review"
                      : issue.blocking ? "Blocking" : "Review";
                  return (
                    <label key={issue.issueId} className={issueClass} data-debug-id={`shellx-browser-teach-issue-${issue.issueId}`}>
                      <input type="checkbox" checked={resolved} onChange={() => teach.toggleAmbiguityResolution(issue.issueId)} disabled={!canEdit || !resolvable} data-debug-id={`shellx-browser-teach-issue-action-${issue.issueId}`} data-teach-issue-kind={resolvable ? "resolvable" : "source-loss"} data-shellx-release-observe="checked disabled" />
                      <span><strong>{issueLabel} · {issue.code}</strong><small>{issue.detail}{resolvable ? "" : " This source loss cannot be acknowledged away."}</small></span>
                    </label>
                  );
                })}
              </div>
            </section>
          )}

          <section className="shellx-browser-teach-list-section" aria-labelledby="shellx-browser-teach-steps-heading">
            <div className="shellx-browser-teach-section-head"><strong id="shellx-browser-teach-steps-heading">Ordered steps</strong><span>{draft.revision.steps.length} source-ordered</span></div>
            <ol className="shellx-browser-teach-steps" data-debug-id="shellx-browser-teach-steps">
              {draft.revision.steps.map((step, index) => <li key={step.stepId} data-debug-id={`shellx-browser-teach-step-${step.stepId}`}><span>{index + 1}</span><code>{step.operation}</code><em>{step.classification}</em><small>{step.evidenceCount} evidence ref{step.evidenceCount === 1 ? "" : "s"}</small></li>)}
            </ol>
          </section>

          <section className="shellx-browser-teach-list-section" aria-labelledby="shellx-browser-teach-values-heading">
            <div className="shellx-browser-teach-section-head"><strong id="shellx-browser-teach-values-heading">Named values and Vault bindings</strong><span>{draft.revision.values.length} source-bound</span></div>
            <div className="shellx-browser-teach-values" data-debug-id="shellx-browser-teach-values">
              {draft.revision.values.map((value) => {
                const edit = teach.valueEdits[value.valueId] ?? { label: value.label, literal: value.literal ?? "" };
                return (
                  <div key={value.valueId} className="shellx-browser-teach-value-row" data-debug-id={`shellx-browser-teach-value-${value.valueId}`}>
                    <label className="shellx-browser-teach-value-field">
                      <span>Value</span>
                      <input value={edit.label} onChange={(event) => teach.updateValue(value.valueId, { label: event.currentTarget.value })} disabled={!canEdit} maxLength={120} aria-label={`Label for ${value.label}`} data-debug-id={`shellx-browser-teach-value-label-${value.valueId}`} data-shellx-release-observe="value disabled" />
                      <small>{value.evidenceCount} evidence ref{value.evidenceCount === 1 ? "" : "s"}</small>
                    </label>
                    <div className="shellx-browser-teach-value-kind">
                      <span>Kind</span>
                      <strong>{value.requiredVaultBinding ? "Vault binding" : value.kind}</strong>
                    </div>
                    {value.requiredVaultBinding ? (
                      <label className="shellx-browser-teach-value-field shellx-browser-teach-vault-select">
                        <span>Vault key identity</span>
                        <select value={teach.vaultBindings[value.valueId] ?? ""} onChange={(event) => teach.updateVaultBinding(value.valueId, event.currentTarget.value)} disabled={!canEdit || teach.vaultKeysLoading} data-debug-id={`shellx-browser-teach-vault-binding-${value.valueId}`} data-shellx-release-observe="value disabled"><option value="">Select key identity…</option>{teach.vaultKeys.map((key) => <option key={key} value={key}>{key}</option>)}</select>
                      </label>
                    ) : (
                      <label className="shellx-browser-teach-value-field">
                        <span>Literal value</span>
                        <input value={edit.literal} onChange={(event) => teach.updateValue(value.valueId, { literal: event.currentTarget.value })} disabled={!canEdit} maxLength={240} aria-label={`Literal for ${value.label}`} data-debug-id={`shellx-browser-teach-value-literal-${value.valueId}`} data-shellx-release-observe="value disabled" />
                      </label>
                    )}
                  </div>
                );
              })}
            </div>
            {teach.vaultKeysError && <div className="shellx-browser-teach-vault-error" role="status" data-debug-id="shellx-browser-teach-vault-unavailable">Vault key identities are unavailable; save can retain existing bindings, but missing bindings cannot be approved.</div>}
          </section>

          <div className="shellx-browser-teach-actions">
            <button type="button" className="shellx-browser-secondary" onClick={() => void teach.save()} disabled={!canSave} data-debug-id="shellx-browser-teach-save-draft" data-shellx-release-observe="disabled title" title={saveDisabledReason(teach)}><ShellIcon name="file" size={13} />{teach.phase === "saving" ? "Saving…" : "Save draft"}</button>
            <button type="button" className="shellx-browser-secondary" onClick={() => void teach.rehearse()} disabled={!canRehearse} data-debug-id="shellx-browser-teach-rehearse" data-shellx-release-observe="disabled title" title={rehearseDisabledReason(teach)}><ShellIcon name="play" size={13} />{teach.phase === "rehearsing" ? "Rehearsing…" : "Rehearse"}</button>
            <button type="button" className="shellx-browser-primary" onClick={() => void teach.approve()} disabled={!canApprove} data-debug-id="shellx-browser-teach-approve-recipe" data-shellx-release-observe="disabled title" title={approveDisabledReason(teach)}><ShellIcon name="check" size={13} />{teach.phase === "approving" ? "Approving…" : "Approve recipe"}</button>
          </div>

          {teach.approval && (() => {
            const correlation = approvalCorrelation(teach.approval.recipeId, teach.approval.approvalId, draft.revision.revisionId);
            return (
              <div className="shellx-browser-teach-receipt" role="status" data-debug-id="shellx-browser-teach-approval-receipt">
                <ShellIcon name="check" size={13} />
                <span title={correlation}><strong>Recipe approved</strong><small>Recipe {shortId(teach.approval.recipeId)} · approval {shortId(teach.approval.approvalId)}</small></span>
                <button type="button" className="shellx-browser-secondary shellx-browser-teach-receipt-copy" onClick={() => copyReceiptCorrelation("approval", correlation)} data-debug-id="shellx-browser-teach-copy-approval-receipt" title="Copy recipe, approval, and revision correlation"><ShellIcon name={copiedReceipt === "approval" ? "check" : "copy"} size={12} />{copiedReceipt === "approval" ? "Copied" : "Copy"}</button>
              </div>
            );
          })()}
          {teach.rehearsal && (() => {
            const correlation = rehearsalCorrelation(teach.rehearsal.recipeId, teach.rehearsal.receipt.receiptId, draft.revision.revisionId);
            return (
              <div className="shellx-browser-teach-receipt" role="status" data-debug-id="shellx-browser-teach-rehearsal-receipt">
                <ShellIcon name="check" size={13} />
                <span title={correlation}><strong>Dry run ready</strong><small>r{draft.revision.revision} · {teach.rehearsal.stepsPlanned} planned · {teach.rehearsal.stepsSkipped} skipped · 0 applied · receipt {shortId(teach.rehearsal.receipt.receiptId)}</small></span>
                <button type="button" className="shellx-browser-secondary shellx-browser-teach-receipt-copy" onClick={() => copyReceiptCorrelation("rehearsal", correlation)} data-debug-id="shellx-browser-teach-copy-rehearsal-receipt" title="Copy recipe, rehearsal receipt, and revision correlation"><ShellIcon name={copiedReceipt === "rehearsal" ? "check" : "copy"} size={12} />{copiedReceipt === "rehearsal" ? "Copied" : "Copy"}</button>
              </div>
            );
          })()}
        </div>
      )}
    </section>
  );
}
