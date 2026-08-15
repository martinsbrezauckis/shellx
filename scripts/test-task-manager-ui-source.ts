import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const source = readFileSync(resolve(root, "src/components/TaskManager.tsx"), "utf8");
const headerSource = readFileSync(resolve(root, "src/components/Header.tsx"), "utf8");
const css = readFileSync(resolve(root, "src/components/TaskManager.css"), "utf8");
const historySource = readFileSync(resolve(root, "src/components/TaskRunHistory.tsx"), "utf8");
const historyCss = readFileSync(resolve(root, "src/components/TaskRunHistory.css"), "utf8");
const contracts = readFileSync(resolve(root, "src/lib/task-manager-contract.ts"), "utf8");
const historyProjection = readFileSync(resolve(root, "src/lib/task-manager-history-projection.ts"), "utf8");
const hydration = readFileSync(resolve(root, "src/lib/task-manager-draft-hydration.ts"), "utf8");

for (const required of [
  "useModalFocus(open, dialogRef, onClose)",
  "originRequestId",
  "originRevision",
  "revisionHash",
  "Automatic",
  "task-manager-trigger-kind",
  "task-manager-trigger-once",
  "task-manager-trigger-time",
  "task-manager-weekday-${id}",
  "task-manager-trigger-month-day",
  "task-manager-timezone",
  "task-manager-missed-run-policy",
  "task-manager-max-run-seconds",
  "task-manager-notification-policy",
  "task-manager-schedule-summary",
  "Move up",
  "Move down",
  "Remove",
  "task-manager-project-filter",
  "task-manager-environment-filter",
  "task-manager-provider-filter",
  "Run now",
  "Save revision",
  "Confirm delete",
  "Open run",
  "Cancel run",
  "task-manager-provider-guard",
  "task-manager-action-",
  "TaskRunHistory",
  "task-manager-attention-callout",
  "task-manager-attention-item",
  "task-manager-reviewed-bindings",
  "task-manager-attachment-binding",
  "task-manager-remove-attachment",
  "task-manager-workflow-binding",
  "task-manager-vault-binding",
  "task-manager-open-vault",
  "task-manager-acknowledge-attention",
  "task-manager-run-result-evidence",
  "Acknowledge",
  "Suggested from chat",
  "agentSuggestion === provider.providerId",
  "taskProviderSelectionDisabledReason(draft, data",
  "task-manager-review",
  "task-manager-edit-details",
  "Edit details",
  "Back to review",
  "Run time limit",
  "Safety limit for one run, not the schedule.",
]) assert(`${source}\n${historySource}\n${hydration}`.includes(required), `TaskManager source must retain ${required}`);

assert(contracts.includes("Select an environment before choosing an agent."), "agent ordering must remain environment-first");
for (const copy of ["Only when I start it", "Uses this computer's clock.", "Advanced timing and notifications", "Choose where it runs", "Run on", "Uses this chat's working folder", "Working folder", "If one is unavailable, ShellX tries the next", "Enable task", "All agents", "Saved task"]) {
  assert(source.includes(copy), `Task Manager must retain end-user schedule/agent copy: ${copy}`);
}
for (const copy of ["Select a task", "use the Task button below a chat", "hasEditableDefinition && <div className=\"task-manager-actions\""]) {
  assert(source.includes(copy), `Task Manager must keep its no-selection manager state non-editable: ${copy}`);
}
assert(source.includes('trigger.kind !== "manual" && trigger.kind !== "once" && <label><span>Keep this timezone</span>'), "manual and one-time tasks must not show an irrelevant timezone field");
assert(source.includes("{environment.label}</option>"), "the environment selector must use user-owned names without appending transport jargon");
assert(source.includes('className="task-manager-provider-details"'), "technical agent versions and capability guidance must remain collapsed by default");
assert(source.includes('provider.models.length > 0 || candidate?.modelMode === "verifiedModel"'), "the model chooser must stay hidden when there is no real choice");
assert(!source.includes('`Revision ${selectedSummary.revisionId}`'), "raw revision identities must not be the saved-task heading");
assert(source.includes('preservePastOnce={persistedScheduleIsUnchanged}'), "an unchanged saved one-time schedule must remain readable after its due time");
assert(source.includes('preservePastOnce && trigger.kind === "once" && trigger.atMs <= Date.now()'), "only an exact persisted past one-time schedule may suppress the draft correction banner");
assert(source.includes('environment.transport === "local" ? "Uses this chat\'s working folder" : "Saved connection"'), "environment context must stay plain-language and secondary to the user-owned name");
assert(source.includes('data-debug-id="task-manager-environment-working-folder"'), "the exact working folder must remain available behind a collapsed disclosure");
assert(source.includes("taskProvidersForDisplay(catalogue.providers, active)"), "selected agent cards must render in the same order as their numbered fallback route");
assert(!/setDraft\(\(current\)[^\n]+event\.currentTarget/.test(source), "Task Manager state updaters must capture event values synchronously before React clears currentTarget");
assert(source.includes('data-debug-id="task-manager-schedule-advanced" data-release-driver-family="disclosure"'), "advanced schedule policy must stay behind an explicit inventoried native disclosure control");
assert(source.includes('(mode === "edit" && !exactSelectedDetail)'), "a selected saved task must automatically restore fresh provider availability after a post-save reload");
assert(source.includes('mode === "create" ? "createOpened" : "manualRecheck"'), "create drafts and selected saved tasks must use the bounded availability refresh reasons");
assert(contracts.includes("sha256:<64hex>"), "Task provider catalogues must retain their canonical SHA-256 snapshot identity");
assert(contracts.includes("The selected task revision has no hash; reload it before saving."), "edit saves must refuse a missing revision CAS hash");
assert(!/scheduleSummary\}\s+onChange/.test(source), "Schedule summaries must stay derived and read-only");
assert(source.includes('data-debug-id="task-manager-close" data-shellx-release-observe="focused title"'), "Task Manager Close must declare bounded focus observation");
assert(source.includes('data-debug-id="task-manager-search" data-shellx-release-observe="focused value"'), "Task Manager search must declare bounded focus observation");
assert(source.includes('data-shellx-release-observe="disabled focused title"'), "Task Manager footer actions must declare bounded focus observation");
assert(/data-debug-id="header-tasks"\s+data-shellx-release-observe="focused title"/.test(headerSource), "Task Manager opener must declare bounded focus observation");

for (const status of ["authNeeded", "targetUnavailable", "stale", "rateLimited", "identityFailed", "canaryFailed"]) {
  assert(contracts.includes(`"${status}"`), `provider status ${status} must be representable`);
}

assert(!source.includes("@tauri-apps/api"), "Task Manager must remain transport-injected; no direct native invoke boundary is allowed");
assert(!source.includes("invoke("), "Task Manager must not probe or run providers directly");
assert(source.includes("expectedOpenedAtMs: item.openedAtMs"), "attention acknowledgement must use the exact durable CAS timestamp");
assert(source.includes("aggregateOmittedCount: item.aggregateOmittedCount"), "attention saturation acknowledgement must retain its exact bounded count");
assert(source.includes("{onRunNow && <ActionButton"), "Run now must remain absent unless the root injects the durable execution coordinator");
assert(source.includes('const reviewingSavedTask = mode === "edit" && Boolean(selectedDetail) && !editingDetails;'), "saved Tasks must open in review mode instead of the full editor");
assert(source.includes("!reviewingSavedTask && <ActionButton"), "the review panel must not present an unchanged Save action");
assert(source.includes('candidates.map((candidate) => providerLabel(candidate.providerId)).join(" → ")'), "review mode must show agents in their real fallback order");
assert(source.includes('setEditingDetails(mode === "create")'), "new drafts must open editable while saved Tasks return to review mode");
assert(!source.includes("candidates: [{ providerId: draft.context?.agentSuggestion"), "a chat suggestion must never auto-activate a provider route");
assert(!source.includes("attentionReason}"), "Task Manager must not render unstructured attention diagnostics");
assert(!source.includes("providerRelativePath"), "Task Manager must not receive or render provider attachment paths");
assert(source.includes("data.vaultGrantOptions") && source.includes("requirement.grantId"), "Task Manager must bind reviewed Vault keys only to projected active grant identities");
assert(!historySource.includes("run.summary"), "Run history must not render unstructured backend summaries");
assert(!historySource.includes("run.disabledReason"), "Run history must not render unstructured disabled diagnostics");
assert(historySource.includes("onOpenRun(openableSessionId)"), "Open run must use only the exact receipted provider conversation identity");
assert(!historySource.includes("onOpenRun(run.id)"), "an occurrence ID must never be guessed as a provider conversation identity");
assert(historySource.includes("run.attemptId"), "cancellation must require the exact active attempt identity");
for (const required of ["TaskRunTimelineEntry", "freshExecutionScan", "savedDefinitionSnapshot", "resultEvidence", "browserFlightRecorder", "rejectedPreEffect", "MAX_TASK_TIMELINE_ENTRIES"]) {
  assert(`${contracts}\n${historyProjection}`.includes(required), `Task history contracts must retain ${required}`);
}
assert(hydration.includes("revisionHash"), "the edit handoff key must include the exact loaded revision hash");
for (const required of ["var(--surface)", "var(--ink)", "@media (max-width: 660px)", ":focus-visible"]) {
  assert(`${css}\n${historyCss}`.includes(required), `Task Manager CSS must retain ${required}`);
}
for (const required of [
  "@media (max-width: 960px)",
  ".task-manager-schedule-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }",
  ".task-manager-vault-binding { grid-template-columns: 1fr; }",
  ".task-manager-actions { width: 100%; }",
  ".task-manager-vault-binding > label { overflow: hidden; }",
  "max-width: 100%; min-height: 36px; overflow: hidden;",
]) assert(css.includes(required), `Task Manager narrow layout must retain ${required}`);

console.log("Task Manager UI source passed: focus/escape modal, environment-first route controls, ordered fallback, typed attention/history projection, injected execution boundary, narrow layout, and token-based focus styling.");
