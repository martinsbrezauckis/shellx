import { useCallback, useEffect, useMemo, useRef, useState, type JSX, type PointerEvent } from "react";
import { useModalFocus } from "../lib/useModalFocus";
import {
  createTaskManagerDraft,
  formatTaskLocalTime,
  isTaskProviderCatalogueFresh,
  normalizeTaskCandidates,
  normalizeTaskSchedule,
  parseTaskLocalTime,
  providerEditorDisabledReason,
  providerStatusLabel,
  taskProviderSelectionDisabledReason,
  taskProvidersForDisplay,
  taskReadyProviderRouteDisabledReason,
  taskDeviceTimezone,
  taskSaveDisabledReason,
  taskScheduleSummary,
  taskScheduleValidationReason,
  taskStateLabel,
  type TaskDefinitionDetail,
  type TaskDefinitionSummary,
  type TaskDuplicateRequest,
  type TaskManagerActionResult,
  type TaskManagerData,
  type TaskManagerDraft,
  type TaskManagerMode,
  type TaskManagerState,
  type TaskManagerStateFilter,
  type TaskOpenRunRequest,
  type TaskPauseRequest,
  type TaskProviderCatalogueRequest,
  type TaskRunRequest,
  type TaskResolveAttentionRequest,
  type TaskAttentionActionItem,
  type TaskCancelRunRequest,
  type TaskSchedule,
  type TaskTrigger,
  type TaskWeekday,
  type TaskDeleteRequest,
} from "../lib/task-manager-contract";
import { createTaskManagerSaveGuard } from "../lib/task-manager-save-guard";
import { taskAttentionPresentation, type TaskAttentionPresentation } from "../lib/task-manager-history-projection";
import {
  taskManagerDraftFromDetail,
  taskManagerDraftFromSummary,
  taskManagerDraftHandoffKey,
  taskManagerIncomingDraft,
} from "../lib/task-manager-draft-hydration";
import { ShellIcon } from "./icons";
import { TaskRunHistory } from "./TaskRunHistory";
import "./TaskManager.css";

export interface TaskManagerProps {
  open: boolean;
  mode: TaskManagerMode;
  data: TaskManagerData;
  initialDraft?: TaskManagerDraft;
  onClose: () => void;
  onSelectDefinition?: (definitionId: string) => void;
  onSave?: (draft: TaskManagerDraft) => Promise<TaskManagerActionResult> | TaskManagerActionResult;
  onRunNow?: (request: TaskRunRequest) => Promise<TaskManagerActionResult> | TaskManagerActionResult;
  onPause?: (request: TaskPauseRequest) => Promise<TaskManagerActionResult> | TaskManagerActionResult;
  onResume?: (request: TaskPauseRequest) => Promise<TaskManagerActionResult> | TaskManagerActionResult;
  onDuplicate?: (request: TaskDuplicateRequest) => Promise<TaskManagerActionResult> | TaskManagerActionResult;
  onDelete?: (request: TaskDeleteRequest) => Promise<TaskManagerActionResult> | TaskManagerActionResult;
  onOpenRun?: (request: TaskOpenRunRequest) => Promise<TaskManagerActionResult> | TaskManagerActionResult;
  onResolveAttention?: (request: TaskResolveAttentionRequest) => Promise<TaskManagerActionResult> | TaskManagerActionResult;
  onCancelRun?: (request: TaskCancelRunRequest) => Promise<TaskManagerActionResult> | TaskManagerActionResult;
  onOpenVault?: () => void;
  onRequestProviderCatalogue?: (
    request: TaskProviderCatalogueRequest,
  ) => Promise<TaskManagerActionResult> | TaskManagerActionResult;
}

const STATE_FILTERS: TaskManagerStateFilter[] = ["all", "needsAttention", "scheduled", "running", "paused", "recent"];
const ORDERED_STATES: TaskManagerState[] = ["needsAttention", "scheduled", "running", "paused", "recent"];

const EMPTY_DRAFT: TaskManagerDraft = {
  originRequestId: "task-manager-empty",
  originRevision: 1,
  name: "",
  instruction: "",
  environmentKey: "",
  schedule: {
    trigger: { kind: "manual" },
    timezone: taskDeviceTimezone(),
    missedRunPolicy: "skip",
    maxRunSeconds: 600,
    notificationPolicy: "attentionOnly",
  },
  enabled: false,
  candidates: [],
};

export function TaskManager({
  open,
  mode,
  data,
  initialDraft,
  onClose,
  onSelectDefinition,
  onSave,
  onRunNow,
  onPause,
  onResume,
  onDuplicate,
  onDelete,
  onOpenRun,
  onResolveAttention,
  onCancelRun,
  onOpenVault,
  onRequestProviderCatalogue,
}: TaskManagerProps): JSX.Element | null {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const backdropStartedRef = useRef(false);
  const [stateFilter, setStateFilter] = useState<TaskManagerStateFilter>("all");
  const [search, setSearch] = useState("");
  const [projectFilter, setProjectFilter] = useState("all");
  const [environmentFilter, setEnvironmentFilter] = useState("all");
  const [providerFilter, setProviderFilter] = useState("all");
  const [selectedId, setSelectedId] = useState<string | undefined>(data.selectedDefinitionId);
  const [draft, setDraft] = useState<TaskManagerDraft>(() => createTaskManagerDraft(initialDraft ?? EMPTY_DRAFT));
  const [feedback, setFeedback] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [deleteArmed, setDeleteArmed] = useState(false);
  const saveGuardRef = useRef(createTaskManagerSaveGuard());
  useModalFocus(open, dialogRef, onClose);

  const exactSelectedDetail = data.selectedDefinition?.id === data.selectedDefinitionId
    ? data.selectedDefinition
    : undefined;
  const handoffKey = taskManagerDraftHandoffKey(
    mode,
    initialDraft,
    data.selectedDefinitionId,
    exactSelectedDetail,
  );

  useEffect(() => {
    if (!open) return;
    const source = taskManagerIncomingDraft({
      mode,
      initialDraft,
      currentDraft: draft,
      emptyDraft: EMPTY_DRAFT,
      selectedDefinitionId: data.selectedDefinitionId,
      selectedDefinition: exactSelectedDetail,
    });
    setDraft(createTaskManagerDraft(source));
    setSelectedId(mode === "create" ? undefined : data.selectedDefinitionId);
    setFeedback(null);
    setDeleteArmed(false);
  // The source identity, not object identity, is the draft replacement contract.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, handoffKey]);

  const requestCatalogue = useCallback(async (
    reason: TaskProviderCatalogueRequest["reason"],
    managesBusyState = true,
  ): Promise<boolean> => {
    if (!draft.environmentKey) {
      setFeedback("Select an environment before checking providers.");
      return false;
    }
    if (!onRequestProviderCatalogue) {
      setFeedback("Provider availability recheck is not connected.");
      return false;
    }
    if (managesBusyState) setBusyAction("recheck");
    try {
      const result = await onRequestProviderCatalogue({ environmentKey: draft.environmentKey, reason });
      setFeedback(result.detail ?? (result.accepted ? "Provider availability recheck requested." : result.disabledReason ?? "Provider availability was not rechecked."));
      return result.accepted;
    } catch (error) {
      setFeedback(`Provider availability recheck failed: ${messageForError(error)}`);
      return false;
    } finally {
      if (managesBusyState) setBusyAction(null);
    }
  }, [draft.environmentKey, onRequestProviderCatalogue]);

  useEffect(() => {
    if (!open || (mode === "edit" && !exactSelectedDetail) || !draft.environmentKey || data.providerCatalogueState.state === "checking") return;
    if (isTaskProviderCatalogueFresh(data.providerCatalogue, draft.environmentKey)) return;
    void requestCatalogue(mode === "create" ? "createOpened" : "manualRecheck");
  }, [data.providerCatalogue, data.providerCatalogueState.state, draft.environmentKey, exactSelectedDetail, mode, open, requestCatalogue]);

  const selectedSummary = useMemo(
    () => data.definitions.find((definition) => definition.id === selectedId),
    [data.definitions, selectedId],
  );
  const selectedDetail = exactSelectedDetail?.id === selectedId ? exactSelectedDetail : undefined;
  const persistedScheduleIsUnchanged = Boolean(selectedDetail && sameTaskSchedule(draft.schedule, selectedDetail.schedule));
  const selectedDetailPending = mode === "edit" && Boolean(selectedId) && !selectedDetail;
  const hasEditableDefinition = mode === "create" || Boolean(selectedSummary);
  const selectedAttention = selectedSummary ? taskAttentionPresentation(selectedSummary) : undefined;
  const listFilterOptions = useMemo(() => buildListFilterOptions(data.definitions), [data.definitions]);
  const filteredDefinitions = useMemo(
    () => filterDefinitions(data.definitions, { stateFilter, search, projectFilter, environmentFilter, providerFilter }),
    [data.definitions, environmentFilter, projectFilter, providerFilter, search, stateFilter],
  );
  const providerEditorReason = providerEditorDisabledReason(draft, data);
  const saveReason = selectedDetailPending
    ? "Loading the selected task's exact revision before saving."
    : taskSaveDisabledReason(draft, data);
  const currentEnvironment = data.environments.find((environment) => environment.key === draft.environmentKey);
  const catalogueMatchesEnvironment = isTaskProviderCatalogueFresh(data.providerCatalogue, draft.environmentKey);

  if (!open) return null;

  function selectDefinition(definition: TaskDefinitionSummary): void {
    setSelectedId(definition.id);
    setDeleteArmed(false);
    setFeedback(null);
    const detail = data.selectedDefinition?.id === definition.id ? data.selectedDefinition : undefined;
    if (detail) setDraft(createTaskManagerDraft(taskManagerDraftFromDetail(detail)));
    else {
      setDraft(createTaskManagerDraft(taskManagerDraftFromSummary(definition, draft.schedule)));
      setFeedback(`Loading the exact revision for “${definition.name}”.`);
    }
    onSelectDefinition?.(definition.id);
  }

  function changeEnvironment(environmentKey: string): void {
    setDraft((current) => createTaskManagerDraft(current, { environmentKey, candidates: [] }));
    setFeedback("Environment changed. The previous agent choices were cleared and availability will be checked again.");
    setDeleteArmed(false);
    if (!environmentKey) return;
    if (onRequestProviderCatalogue) {
      void Promise.resolve(onRequestProviderCatalogue({ environmentKey, reason: "environmentChanged" }))
        .then((result) => setFeedback(result.detail ?? (result.accepted ? "Checking provider availability for the selected environment." : result.disabledReason ?? "Provider availability was not rechecked.")))
        .catch((error) => setFeedback(`Provider availability recheck failed: ${messageForError(error)}`));
    } else {
      setFeedback("Environment changed. Provider availability recheck is not connected.");
    }
  }

  function toggleProvider(providerId: string): void {
    const alreadySelected = draft.candidates.some((candidate) => candidate.providerId === providerId);
    const disabledReason = taskProviderSelectionDisabledReason(draft, data, providerId, alreadySelected);
    if (disabledReason) {
      setFeedback(disabledReason);
      return;
    }
    setDraft((current) => {
      const existing = normalizeTaskCandidates(current.candidates);
      const index = existing.findIndex((candidate) => candidate.providerId === providerId);
      if (index === -1) {
        return createTaskManagerDraft(current, {
          candidates: [...existing, { providerId, modelMode: "providerDefault", order: existing.length + 1 }],
        });
      }
      return createTaskManagerDraft(current, { candidates: existing.filter((candidate) => candidate.providerId !== providerId) });
    });
  }

  function moveProvider(providerId: string, direction: -1 | 1): void {
    setDraft((current) => {
      const candidates = normalizeTaskCandidates(current.candidates);
      const currentIndex = candidates.findIndex((candidate) => candidate.providerId === providerId);
      const nextIndex = currentIndex + direction;
      if (currentIndex < 0 || nextIndex < 0 || nextIndex >= candidates.length) return current;
      const next = [...candidates];
      const displaced = next[nextIndex]!;
      next[nextIndex] = next[currentIndex]!;
      next[currentIndex] = displaced;
      return createTaskManagerDraft(current, { candidates: next });
    });
  }

  function changeModel(providerId: string, value: string): void {
    setDraft((current) => createTaskManagerDraft(current, {
      candidates: current.candidates.map((candidate) => candidate.providerId !== providerId ? candidate : value === "providerDefault"
        ? { ...candidate, modelMode: "providerDefault", modelId: undefined }
        : { ...candidate, modelMode: "verifiedModel", modelId: value }),
    }));
  }

  function removeWorkflowBinding(): void {
    setDraft((current) => ({
      ...current,
      context: current.context ? { ...current.context, workflow: undefined } : undefined,
    }));
    setFeedback("The reviewed Browser workflow was removed from this unsaved draft.");
  }

  function removeAttachmentReference(attachmentId: string): void {
    setDraft((current) => ({
      ...current,
      context: current.context ? {
        ...current.context,
        attachmentRefs: current.context.attachmentRefs
          .filter((attachment) => attachment.attachmentId !== attachmentId),
      } : undefined,
    }));
    setFeedback("The durable attachment was removed from this unsaved draft.");
  }

  function selectVaultGrant(keyId: string, grantId: string): void {
    setDraft((current) => ({
      ...current,
      context: current.context ? {
        ...current.context,
        vaultRequirements: (current.context.vaultRequirements ?? []).map((requirement) => (
          requirement.keyId === keyId
            ? { ...requirement, grantId: grantId || undefined }
            : requirement
        )),
      } : undefined,
    }));
  }

  function removeVaultRequirement(keyId: string): void {
    setDraft((current) => ({
      ...current,
      context: current.context ? {
        ...current.context,
        vaultRequirements: (current.context.vaultRequirements ?? [])
          .filter((requirement) => requirement.keyId !== keyId),
      } : undefined,
    }));
    setFeedback("The reviewed Vault requirement was removed from this unsaved draft.");
  }

  async function saveDraft(): Promise<void> {
    if (saveReason) {
      setFeedback(saveReason);
      return;
    }
    const save = onSave;
    if (!save) {
      setFeedback("Saving Task Manager revisions is not connected.");
      return;
    }
    if (saveGuardRef.current.isActive()) {
      setFeedback("A task revision save is already in progress.");
      return;
    }
    setBusyAction("save");
    try {
      // A paused definition still records an exact environment snapshot, so
      // Save always rechecks the selected logical environment. This is not a
      // provider start and does not make an old target identity look current.
      const outcome = await saveGuardRef.current.run(
        () => requestCatalogue("savePreflight", false),
        () => Promise.resolve(save(createTaskManagerDraft(draft, { schedule: normalizeTaskSchedule(draft.schedule) }))),
      );
      if (outcome.kind === "busy") {
        setFeedback("A task revision save is already in progress.");
        return;
      }
      if (outcome.kind === "preflightRejected") return;
      const result = outcome.value;
      setFeedback(result.detail ?? (result.accepted ? "Task revision saved." : result.disabledReason ?? "Task revision was not saved."));
    } catch (error) {
      setFeedback(`Task revision could not be saved: ${messageForError(error)}`);
    } finally {
      setBusyAction(null);
    }
  }

  async function runNow(): Promise<void> {
    const target = selectedDetail;
    const disabledReason = runDisabledReason(target, onRunNow, data);
    if (disabledReason) {
      setFeedback(disabledReason);
      return;
    }
    setBusyAction("run");
    try {
      if (!await requestCatalogue("runPreflight", false)) return;
      const result = await onRunNow!({
        definitionId: target!.id,
        revisionId: target!.revisionId,
        revisionHash: target!.revisionHash,
      });
      setFeedback(result.detail ?? (result.accepted ? "Run request accepted." : result.disabledReason ?? "Run request was not accepted."));
    } catch (error) {
      setFeedback(`Run request failed: ${messageForError(error)}`);
    } finally {
      setBusyAction(null);
    }
  }

  async function pauseOrResume(action: "pause" | "resume"): Promise<void> {
    const target = selectedDetail;
    const handler = action === "pause" ? onPause : onResume;
    if (!target || !handler) {
      setFeedback(target ? `${action === "pause" ? "Pausing" : "Resuming"} tasks is not connected.` : "Select a task first.");
      return;
    }
    setBusyAction(action);
    try {
      const result = await handler({ definitionId: target.id, revisionId: target.revisionId, action });
      setFeedback(result.detail ?? (result.accepted ? `Task ${action === "pause" ? "paused" : "resumed"}.` : result.disabledReason ?? `Task was not ${action}d.`));
    } catch (error) {
      setFeedback(`Task could not be ${action}d: ${messageForError(error)}`);
    } finally {
      setBusyAction(null);
    }
  }

  async function invokeSelectedAction(
    action: "duplicate" | "delete",
    handler: ((request: TaskDuplicateRequest | TaskDeleteRequest) => Promise<TaskManagerActionResult> | TaskManagerActionResult) | undefined,
  ): Promise<void> {
    const target = selectedDetail;
    if (!target || !handler) {
      setFeedback(target ? `${action === "duplicate" ? "Duplicating" : "Deleting"} tasks is not connected.` : "Select a task first.");
      return;
    }
    if (action === "delete" && !deleteArmed) {
      setDeleteArmed(true);
      setFeedback(`Delete “${target.name}”? Select Delete again to confirm.`);
      return;
    }
    setBusyAction(action);
    try {
      const result = await handler({ definitionId: target.id, revisionId: target.revisionId });
      setFeedback(result.detail ?? (result.accepted ? `Task ${action === "duplicate" ? "duplicated" : "deleted"}.` : result.disabledReason ?? `Task was not ${action}d.`));
      setDeleteArmed(false);
    } catch (error) {
      setFeedback(`Task could not be ${action}d: ${messageForError(error)}`);
    } finally {
      setBusyAction(null);
    }
  }

  async function openRun(conversationSessionId: string): Promise<void> {
    const target = selectedDetail ?? selectedSummary;
    if (!target || !onOpenRun) {
      setFeedback(target ? "Opening task runs is not connected." : "Select a task first.");
      return;
    }
    setBusyAction(`run-${conversationSessionId}`);
    try {
      const result = await onOpenRun({ definitionId: target.id, conversationSessionId });
      setFeedback(result.detail ?? (result.accepted ? "Run opened." : result.disabledReason ?? "Run could not be opened."));
    } catch (error) {
      setFeedback(`Run could not be opened: ${messageForError(error)}`);
    } finally {
      setBusyAction(null);
    }
  }

  async function resolveAttention(item: TaskAttentionActionItem): Promise<void> {
    const target = selectedDetail;
    if (!target || !onResolveAttention) {
      setFeedback(target ? "Acknowledging task attention is not connected." : "Select a task first.");
      return;
    }
    setBusyAction(`attention-${item.attentionId}`);
    try {
      const result = await onResolveAttention({
        definitionId: target.id,
        attentionId: item.attentionId,
        expectedOpenedAtMs: item.openedAtMs,
        aggregateOmittedCount: item.aggregateOmittedCount,
        aggregateUpdatedAtMs: item.aggregateUpdatedAtMs,
      });
      setFeedback(result.detail ?? (result.accepted ? "Attention acknowledged." : result.disabledReason ?? "Attention was not acknowledged."));
    } catch (error) {
      setFeedback(`Attention could not be acknowledged: ${messageForError(error)}`);
    } finally {
      setBusyAction(null);
    }
  }

  async function cancelRun(run: TaskDefinitionDetail["runHistory"][number]): Promise<void> {
    const target = selectedDetail;
    if (!target || !onCancelRun || !run.attemptId) {
      setFeedback(target ? "Cancelling this run is unavailable after its active attempt changed." : "Select a task first.");
      return;
    }
    setBusyAction(`cancel-${run.id}`);
    try {
      const result = await onCancelRun({
        definitionId: target.id,
        occurrenceId: run.id,
        attemptId: run.attemptId,
      });
      setFeedback(result.detail ?? (result.accepted ? "Cancellation requested." : result.disabledReason ?? "Run cancellation was not accepted."));
    } catch (error) {
      setFeedback(`Run cancellation failed: ${messageForError(error)}`);
    } finally {
      setBusyAction(null);
    }
  }

  function handleBackdropPointerDown(event: PointerEvent<HTMLDivElement>): void {
    backdropStartedRef.current = event.target === event.currentTarget;
  }

  function handleBackdropClick(event: React.MouseEvent<HTMLDivElement>): void {
    const startedOnBackdrop = backdropStartedRef.current;
    backdropStartedRef.current = false;
    if (startedOnBackdrop && event.target === event.currentTarget) onClose();
  }

  // Run now is intentionally absent until the root injects the real execution
  // coordinator. A disabled promise-shaped control would imply capability.
  const runReason = onRunNow ? runDisabledReason(selectedDetail, onRunNow, data) : undefined;
  const pauseTarget = selectedDetail;
  const pauseReason = !pauseTarget
    ? "Select a task before pausing it."
    : pauseTarget.state === "paused"
      ? "This task is already paused."
      : !onPause ? "Pausing tasks is not connected." : undefined;
  const resumeReason = pauseTarget?.state === "paused" ? (!onResume ? "Resuming tasks is not connected." : undefined) : "Only paused tasks can be resumed.";

  return (
    <div className="task-manager-backdrop" data-debug-id="task-manager-backdrop" onPointerDownCapture={handleBackdropPointerDown} onClick={handleBackdropClick}>
      <section ref={dialogRef} className="task-manager" data-debug-id="task-manager" role="dialog" aria-modal="true" aria-labelledby="task-manager-title" tabIndex={-1}>
        <header className="task-manager-header">
          <div>
            <p className="task-manager-eyebrow">Tasks</p>
            <h2 id="task-manager-title">{mode === "create" ? "Create task" : "Task Manager"}</h2>
            <p className="task-manager-subtitle">Instructions, schedules, agents, and run history.</p>
          </div>
          <button type="button" className="task-manager-icon-button" data-dialog-initial-focus="true" data-debug-id="task-manager-close" data-shellx-release-observe="focused title" onClick={onClose} aria-label="Close Task Manager" title="Close Task Manager (Esc)">
            <ShellIcon name="close" size={17} />
          </button>
        </header>

        <div className="task-manager-workspace">
          <aside className="task-manager-list" aria-label="Task definitions">
            <div className="task-manager-list-tools">
              <label className="task-manager-search-label" htmlFor="task-manager-search">Search tasks</label>
              <div className="task-manager-search-wrap">
                <ShellIcon name="search" size={15} />
                <input id="task-manager-search" data-debug-id="task-manager-search" data-shellx-release-observe="focused value" value={search} onChange={(event) => setSearch(event.currentTarget.value)} placeholder="Search tasks" />
              </div>
              <div className="task-manager-filters" role="group" aria-label="Task state filters">
                {STATE_FILTERS.map((filter) => (
              <button key={filter} type="button" data-debug-id={`task-manager-filter-${filter}`} data-shellx-release-observe="pressed" className={stateFilter === filter ? "selected" : ""} aria-pressed={stateFilter === filter} onClick={() => setStateFilter(filter)}>
                    {filter === "all" ? "All" : taskStateLabel(filter)}
                  </button>
                ))}
              </div>
              <div className="task-manager-bounded-filters" aria-label="Bounded task filters">
                <label>Project<select data-debug-id="task-manager-project-filter" data-shellx-release-observe="value" value={projectFilter} onChange={(event) => setProjectFilter(event.currentTarget.value)}><option value="all">All projects</option>{listFilterOptions.projects.map((project) => <option key={project} value={project}>{project}</option>)}</select></label>
                <label>Environment<select data-debug-id="task-manager-environment-filter" data-shellx-release-observe="value" value={environmentFilter} onChange={(event) => setEnvironmentFilter(event.currentTarget.value)}><option value="all">All environments</option>{listFilterOptions.environments.map((environment) => <option key={environment.key} value={environment.key}>{environment.label}</option>)}</select></label>
                <label>Agent<select data-debug-id="task-manager-provider-filter" data-shellx-release-observe="value" value={providerFilter} onChange={(event) => setProviderFilter(event.currentTarget.value)}><option value="all">All agents</option>{listFilterOptions.providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.label}</option>)}</select></label>
              </div>
            </div>
            <TaskList loadState={data.loadState} loadDetail={data.loadDetail} definitions={filteredDefinitions} selectedId={selectedId} onSelect={selectDefinition} />
          </aside>

          <main className="task-manager-inspector" aria-live="polite">
            {data.loadState === "error" ? (
              <EmptyInspector title="Tasks could not be loaded" detail={data.loadDetail ?? "Task definitions are unavailable. Reopen or retry from the connected task store."} />
            ) : selectedDetailPending ? (
              <EmptyInspector title="Loading task revision" detail="The selected task's immutable revision is being loaded before it can be changed or run." />
            ) : !hasEditableDefinition ? (
              <EmptyInspector title="Select a task" detail="Choose a saved task from the list. To create one, use the Task button below a chat so ShellX can keep its environment and working folder." />
            ) : (
              <>
                <section className="task-manager-section task-manager-definition" aria-labelledby="task-manager-definition-heading">
                  <div className="task-manager-section-heading">
                    <div>
                      <p className="task-manager-section-kicker">{mode === "create" ? "New task" : selectedSummary ? "Saved task" : "No task selected"}</p>
                      <h3 id="task-manager-definition-heading">Definition</h3>
                    </div>
                    {selectedAttention && <span className="task-manager-attention" data-debug-id="task-manager-attention" title={selectedAttention.detail} aria-label={`${selectedAttention.count} task occurrence${selectedAttention.count === 1 ? "" : "s"} need attention`}>Needs attention{selectedAttention.count > 1 ? ` · ${selectedAttention.count}` : ""}</span>}
                  </div>
                  {selectedAttention && <TaskAttentionCallout attention={selectedAttention} items={selectedDetail?.attentionItems ?? []} busyAction={busyAction} onResolve={onResolveAttention ? resolveAttention : undefined} />}
                  <div className="task-manager-field-grid">
                    <label>
                      <span>Name</span>
                      <input data-debug-id="task-manager-name" data-shellx-release-observe="value" value={draft.name} onChange={(event) => {
                        const name = event.currentTarget.value;
                        setDraft((current) => ({ ...current, name }));
                      }} placeholder="Name this task" />
                    </label>
                  </div>
                  <label className="task-manager-field-wide">
                    <span>Instruction</span>
                    <textarea data-debug-id="task-manager-instruction" data-shellx-release-observe="value" value={draft.instruction} onChange={(event) => {
                      const instruction = event.currentTarget.value;
                      setDraft((current) => ({ ...current, instruction }));
                    }} placeholder="Describe the work and its boundaries." rows={5} />
                  </label>
                  <label className="task-manager-field-wide">
                    <span>Success or no-change criteria <em>optional</em></span>
                    <input data-debug-id="task-manager-success-criteria" data-shellx-release-observe="value" value={draft.successCriteria ?? ""} onChange={(event) => {
                      const successCriteria = event.currentTarget.value || undefined;
                      setDraft((current) => ({ ...current, successCriteria }));
                    }} placeholder="What outcome should the run record?" />
                  </label>
                </section>

                {((draft.context?.attachmentRefs.length ?? 0) > 0 || draft.context?.workflow || (draft.context?.vaultRequirements?.length ?? 0) > 0) && (
                  <section className="task-manager-section task-manager-bindings" aria-labelledby="task-manager-bindings-heading" data-debug-id="task-manager-reviewed-bindings">
                    <div className="task-manager-section-heading">
                      <div>
                        <p className="task-manager-section-kicker">Exact operator-reviewed identities</p>
                        <h3 id="task-manager-bindings-heading">Inputs, workflow and Vault</h3>
                      </div>
                      {onOpenVault && <button type="button" className="task-manager-text-button" onClick={onOpenVault} data-debug-id="task-manager-open-vault"><ShellIcon name="lock" size={14} /> Open Vault</button>}
                    </div>
                    {(draft.context?.attachmentRefs ?? []).map((attachment) => (
                      <div className="task-manager-binding-row" key={attachment.attachmentId} data-debug-id="task-manager-attachment-binding">
                        <span><strong>Durable attachment</strong><small title={`${attachment.attachmentId} · ${attachment.digest ?? "missing digest"}`}>{shortId(attachment.attachmentId)} · {attachment.digest ? shortId(attachment.digest) : "missing digest"}</small></span>
                        <button type="button" className="task-manager-text-button" onClick={() => removeAttachmentReference(attachment.attachmentId)} data-debug-id="task-manager-remove-attachment">Remove</button>
                      </div>
                    ))}
                    {draft.context?.workflow && (
                      <div className="task-manager-binding-row" data-debug-id="task-manager-workflow-binding">
                        <span><strong>Browser workflow</strong><small title={draft.context.workflow.workflowId}>{shortId(draft.context.workflow.workflowId)} · {shortId(draft.context.workflow.digest)}</small></span>
                        <button type="button" className="task-manager-text-button" onClick={removeWorkflowBinding} data-debug-id="task-manager-remove-workflow">Remove</button>
                      </div>
                    )}
                    {(draft.context?.vaultRequirements ?? []).map((requirement) => {
                      const options = (data.vaultGrantOptions ?? []).filter((grant) => grant.keyId === requirement.keyId);
                      const selectedAvailable = !requirement.grantId || options.some((grant) => grant.grantId === requirement.grantId);
                      return <div className="task-manager-binding-row task-manager-vault-binding" key={requirement.keyId} data-debug-id="task-manager-vault-binding">
                        <span><strong>Vault key</strong><small title={requirement.keyId}>{requirement.keyId}</small></span>
                        <label><span>Mediated grant</span><select value={requirement.grantId ?? ""} onChange={(event) => selectVaultGrant(requirement.keyId, event.currentTarget.value)} data-debug-id="task-manager-vault-grant" data-task-vault-key={requirement.keyId} data-shellx-release-observe="value"><option value="">Select active grant…</option>{!selectedAvailable && <option value={requirement.grantId}>Saved grant unavailable</option>}{options.map((grant) => <option key={grant.grantId} value={grant.grantId}>{vaultGrantLabel(grant)}</option>)}</select></label>
                        <button type="button" className="task-manager-text-button" onClick={() => removeVaultRequirement(requirement.keyId)} data-debug-id="task-manager-remove-vault-requirement">Remove</button>
                      </div>;
                    })}
                    {data.vaultGrantState?.state === "unavailable" && <p className="task-manager-binding-note" role="status" data-debug-id="task-manager-vault-grants-unavailable">Active grant metadata is unavailable. The draft remains paused until every reviewed key has an active mediated grant.</p>}
                    {data.vaultGrantState?.state === "ready" && (draft.context?.vaultRequirements ?? []).some((requirement) => !(data.vaultGrantOptions ?? []).some((grant) => grant.keyId === requirement.keyId)) && <p className="task-manager-binding-note" role="status" data-debug-id="task-manager-vault-grant-required">Create an all-agents mediated grant in Vault, then reopen Tasks to select it.</p>}
                  </section>
                )}

                <TaskScheduleEditor
                  schedule={draft.schedule}
                  preservePastOnce={persistedScheduleIsUnchanged}
                  onChange={(schedule) => setDraft((current) => ({ ...current, schedule }))}
                />

                <section className="task-manager-section" aria-labelledby="task-manager-environment-heading">
                  <div className="task-manager-section-heading">
                    <div>
                      <p className="task-manager-section-kicker">Choose where it runs</p>
                      <h3 id="task-manager-environment-heading">Environment</h3>
                    </div>
                    <button type="button" className="task-manager-text-button" data-debug-id="task-manager-recheck" data-shellx-release-observe="disabled title" onClick={() => void requestCatalogue("manualRecheck")} disabled={busyAction === "recheck" || !draft.environmentKey || !onRequestProviderCatalogue} title={!draft.environmentKey ? "Select an environment first." : !onRequestProviderCatalogue ? "Provider availability recheck is not connected." : "Recheck availability for the selected environment"}>
                      <ShellIcon name={busyAction === "recheck" ? "loader" : "refresh"} size={14} /> {busyAction === "recheck" ? "Checking" : "Recheck"}
                    </button>
                  </div>
                  <label className="task-manager-environment-select">
                    <span>Run on</span>
                    <select data-debug-id="task-manager-environment" data-shellx-release-observe="value" value={draft.environmentKey} onChange={(event) => changeEnvironment(event.currentTarget.value)}>
                      <option value="">Select an environment</option>
                      {data.environments.map((environment) => <option key={environment.key} value={environment.key}>{environment.label}</option>)}
                    </select>
                  </label>
                  {currentEnvironment && <div>
                    <p className="task-manager-environment-context" data-debug-id="task-manager-environment-context">{environmentContext(currentEnvironment)}</p>
                    {currentEnvironment.cwdLabel && <details className="task-manager-provider-details" data-debug-id="task-manager-environment-working-folder"><summary>Working folder</summary><p><code>{currentEnvironment.cwdLabel}</code></p></details>}
                  </div>}
                </section>

                <section className="task-manager-section" aria-labelledby="task-manager-route-heading">
                  <div className="task-manager-section-heading">
                    <div>
                      <p className="task-manager-section-kicker">If one is unavailable, ShellX tries the next</p>
                      <h3 id="task-manager-route-heading">Agents</h3>
                    </div>
                    {catalogueMatchesEnvironment && <span className="task-manager-freshness" data-debug-id="task-manager-catalogue-freshness" title={`Scan snapshot ${data.providerCatalogue?.snapshotId}`}>Checked now</span>}
                  </div>
                  <ProviderRouteEditor draft={draft} data={data} catalogue={data.providerCatalogue} disabledReason={providerEditorReason} onToggle={toggleProvider} onMove={moveProvider} onModelChange={changeModel} />
                </section>

                {selectedDetail && <TaskRunHistory detail={selectedDetail} busyAction={busyAction} onOpenRun={openRun} connected={Boolean(onOpenRun)} onCancelRun={cancelRun} cancelConnected={Boolean(onCancelRun)} />}

                <section className="task-manager-section task-manager-policy" aria-label="Task policies">
                  <label className="task-manager-toggle-row">
                    <input data-debug-id="task-manager-enabled" data-shellx-release-observe="checked" type="checkbox" checked={draft.enabled} onChange={(event) => {
                      const enabled = event.currentTarget.checked;
                      setDraft((current) => ({ ...current, enabled }));
                    }} />
                    <span><strong>Enable task</strong><small>Enabled tasks can run manually or on schedule and need at least one ready agent.</small></span>
                  </label>
                  {selectedDetail && <div className="task-manager-policy-summary"><span>Permissions: {selectedDetail.permissionSummary}</span><span>Notifications: {selectedDetail.notificationSummary}</span>{selectedDetail.workflowSummary && <span>Workflow: {selectedDetail.workflowSummary}</span>}{selectedDetail.vaultSummary && <span>Vault: {selectedDetail.vaultSummary}</span>}</div>}
                </section>
              </>
            )}
          </main>
        </div>

        <footer className="task-manager-footer">
          <div className="task-manager-feedback" data-debug-id="task-manager-feedback" data-task-manager-feedback-state={feedback ? "action" : "hint"} role="status">{feedback ?? (hasEditableDefinition ? actionHint(saveReason, runReason, selectedSummary) : "Select a saved task, or create one from the Task button below a chat.")}</div>
          {hasEditableDefinition && <div className="task-manager-actions">
            <ActionButton label="Duplicate" icon="copy" onClick={() => void invokeSelectedAction("duplicate", onDuplicate)} disabled={!selectedDetail || !onDuplicate || busyAction !== null} reason={!selectedDetail ? "Select a task and load its exact revision to duplicate." : !onDuplicate ? "Duplicating tasks is not connected." : undefined} />
            <ActionButton label={deleteArmed ? "Confirm delete" : "Delete"} icon="trash" danger onClick={() => void invokeSelectedAction("delete", onDelete)} disabled={!selectedDetail || !onDelete || busyAction !== null} reason={!selectedDetail ? "Select a task and load its exact revision to delete." : !onDelete ? "Deleting tasks is not connected." : undefined} />
            <ActionButton label="Pause" icon="pause" onClick={() => void pauseOrResume("pause")} disabled={Boolean(pauseReason) || busyAction !== null} reason={pauseReason} />
            <ActionButton label="Resume" icon="play" onClick={() => void pauseOrResume("resume")} disabled={Boolean(resumeReason) || busyAction !== null} reason={resumeReason} />
            {onRunNow && <ActionButton label={busyAction === "run" ? "Starting" : "Run now"} icon={busyAction === "run" ? "loader" : "play"} primary onClick={() => void runNow()} disabled={Boolean(runReason) || busyAction !== null} reason={runReason} />}
            <ActionButton label={busyAction === "save" ? "Saving" : "Save revision"} icon={busyAction === "save" ? "loader" : "check"} primary onClick={() => void saveDraft()} disabled={Boolean(saveReason) || !onSave || busyAction !== null} reason={saveReason ?? (!onSave ? "Saving Task Manager revisions is not connected." : undefined)} />
          </div>}
        </footer>
      </section>
    </div>
  );
}

function TaskAttentionCallout({ attention, items, busyAction, onResolve }: {
  attention: TaskAttentionPresentation;
  items: TaskAttentionActionItem[];
  busyAction: string | null;
  onResolve?: (item: TaskAttentionActionItem) => void;
}): JSX.Element {
  return <aside className="task-manager-attention-callout" data-debug-id="task-manager-attention-callout" role="region" aria-label={attention.title}>
    <ShellIcon name="alert" size={16} />
    <div>
      <strong>{attention.title}</strong><span>{attention.detail}</span>
      {items.length > 0 && <ol className="task-manager-attention-items">
        {items.map((item) => <li key={item.attentionId} data-debug-id="task-manager-attention-item">
          <span>{taskAttentionItemLabel(item)}</span>
          {onResolve && <button type="button" className="task-manager-text-button" data-debug-id="task-manager-acknowledge-attention" onClick={() => onResolve(item)} disabled={busyAction !== null}>{busyAction === `attention-${item.attentionId}` ? "Acknowledging" : "Acknowledge"}</button>}
        </li>)}
      </ol>}
    </div>
  </aside>;
}

function taskAttentionItemLabel(item: TaskAttentionActionItem): string {
  switch (item.source) {
    case "missedSchedule": return "A scheduled run needs review";
    case "occurrenceOutcomeUnknown": return "A run ended with an unknown outcome";
    case "providerTerminalFailed": return "A provider run failed";
    case "providerTerminalOutcomeUnknown": return "A provider outcome could not be confirmed";
    case "attentionLedgerSaturated": return `${item.aggregateOmittedCount ?? "Additional"} more attention records`;
  }
}

function TaskList({ loadState, loadDetail, definitions, selectedId, onSelect }: {
  loadState: TaskManagerData["loadState"];
  loadDetail?: string;
  definitions: TaskDefinitionSummary[];
  selectedId?: string;
  onSelect: (definition: TaskDefinitionSummary) => void;
}): JSX.Element {
  if (loadState === "loading") return <div className="task-manager-list-state" data-debug-id="task-manager-loading"><ShellIcon name="loader" size={16} /> Loading task definitions…</div>;
  if (loadState === "error") return <div className="task-manager-list-state is-error" data-debug-id="task-manager-list-error"><ShellIcon name="alert" size={16} /> {loadDetail ?? "Task definitions are unavailable."}</div>;
  if (definitions.length === 0) return <div className="task-manager-list-state" data-debug-id="task-manager-empty">No tasks match this view. Change the filters, or create one from the Task button below a chat.</div>;
  const groups = groupDefinitions(definitions);
  return <div className="task-manager-definition-list">{groups.map((group) => (
    <section key={group.state} aria-labelledby={`task-manager-group-${group.state}`}>
      <h3 id={`task-manager-group-${group.state}`}>{taskStateLabel(group.state)}</h3>
      {group.definitions.map((definition) => {
        const attention = taskAttentionPresentation(definition);
        return <button key={definition.id} type="button" data-debug-id={`task-manager-definition-${definition.id}`} data-shellx-release-observe="title" className={`task-manager-definition-row ${definition.id === selectedId ? "selected" : ""}`} onClick={() => onSelect(definition)} aria-current={definition.id === selectedId ? "true" : undefined} title={attention ? `${definition.name} · ${attention.title}` : definition.name} aria-label={attention ? `${definition.name}. ${attention.title}.` : definition.name}>
          <span className={`task-manager-state-dot state-${definition.state}`} aria-hidden="true" />
          <span className="task-manager-definition-copy"><strong>{definition.name}</strong><small>{definition.scheduleSummary}</small><small>{definition.environmentLabel} · {definition.providerRouteSummary}</small>{attention && <em>{attention.title}</em>}</span>
        </button>;
      })}
    </section>
  ))}</div>;
}

function TaskScheduleEditor({ schedule, preservePastOnce, onChange }: {
  schedule: TaskSchedule;
  preservePastOnce: boolean;
  onChange: (schedule: TaskSchedule) => void;
}): JSX.Element {
  const trigger = schedule.trigger;
  const time = localTimeForTrigger(trigger);
  const validationReason = preservePastOnce && trigger.kind === "once" && trigger.atMs <= Date.now()
    ? undefined
    : taskScheduleValidationReason(schedule);
  const summary = validationReason ? `Schedule needs correction: ${validationReason}` : taskScheduleSummary(schedule);

  function updateTriggerKind(kind: TaskTrigger["kind"]): void {
    onChange({ ...schedule, trigger: triggerForKind(kind, trigger) });
  }

  function updateTime(value: string): void {
    const at = parseTaskLocalTime(value) ?? { hour: 24, minute: 0 };
    if (!("at" in trigger)) return;
    onChange({ ...schedule, trigger: { ...trigger, at } });
  }

  function toggleWeekday(weekday: TaskWeekday): void {
    if (trigger.kind !== "weekly") return;
    const weekdays = trigger.weekdays.includes(weekday)
      ? trigger.weekdays.filter((value) => value !== weekday)
      : [...trigger.weekdays, weekday];
    onChange({ ...schedule, trigger: { ...trigger, weekdays } });
  }

  return <section className="task-manager-section task-manager-schedule" aria-labelledby="task-manager-schedule-heading">
    <div className="task-manager-section-heading">
      <div>
        <p className="task-manager-section-kicker">Choose when this task runs</p>
        <h3 id="task-manager-schedule-heading">Schedule</h3>
      </div>
      <output className={`task-manager-schedule-summary ${validationReason ? "is-invalid" : ""}`} data-debug-id="task-manager-schedule-summary">{summary}</output>
    </div>
    <div className="task-manager-schedule-grid">
      <label><span>Run</span><select data-debug-id="task-manager-trigger-kind" data-shellx-release-observe="value" value={trigger.kind} onChange={(event) => updateTriggerKind(event.currentTarget.value as TaskTrigger["kind"])}><option value="manual">Only when I start it</option><option value="once">Once</option><option value="daily">Daily</option><option value="weekdays">Weekdays</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option></select>{trigger.kind === "manual" && <small>Use Run now whenever you want this task to start.</small>}</label>
      {trigger.kind === "once" && <label><span>Date and time</span><input data-debug-id="task-manager-trigger-once" data-shellx-release-observe="value" type="datetime-local" value={onceInputValue(trigger.atMs)} onChange={(event) => onChange({ ...schedule, trigger: { kind: "once", atMs: atMsFromDateTimeInput(event.currentTarget.value) } })} /><small>Uses this computer's clock.</small></label>}
      {time && <label><span>Time</span><input data-debug-id="task-manager-trigger-time" data-shellx-release-observe="value" type="time" value={formatTaskLocalTime(time)} onChange={(event) => updateTime(event.currentTarget.value)} /><small>Uses this computer's clock.</small></label>}
      {trigger.kind === "monthly" && <label><span>Day of month</span><input data-debug-id="task-manager-trigger-month-day" data-shellx-release-observe="value" type="number" min="1" max="31" step="1" value={trigger.day} onChange={(event) => onChange({ ...schedule, trigger: { ...trigger, day: event.currentTarget.valueAsNumber || 0 } })} /></label>}
    </div>
    {trigger.kind === "weekly" && <fieldset className="task-manager-weekday-set"><legend>Weekdays</legend><div>{TASK_WEEKDAYS.map(({ id, label }) => <button key={id} type="button" data-debug-id={`task-manager-weekday-${id}`} data-shellx-release-observe="pressed" className={trigger.weekdays.includes(id) ? "selected" : ""} aria-pressed={trigger.weekdays.includes(id)} onClick={() => toggleWeekday(id)}>{label}</button>)}</div></fieldset>}
    <details className="task-manager-schedule-advanced">
      <summary data-debug-id="task-manager-schedule-advanced" data-release-driver-family="disclosure">Advanced timing and notifications</summary>
      <div className="task-manager-schedule-grid task-manager-schedule-policy">
        {trigger.kind !== "manual" && trigger.kind !== "once" && <label><span>Keep this timezone</span><input data-debug-id="task-manager-timezone" data-shellx-release-observe="value" value={schedule.timezone} onChange={(event) => onChange({ ...schedule, timezone: event.currentTarget.value })} placeholder={taskDeviceTimezone()} /><small>ShellX detected this automatically. Change it only when the task should follow another location.</small></label>}
        {trigger.kind !== "manual" && <label><span>If ShellX missed a run</span><select data-debug-id="task-manager-missed-run-policy" data-shellx-release-observe="value" value={schedule.missedRunPolicy} onChange={(event) => onChange({ ...schedule, missedRunPolicy: event.currentTarget.value as TaskSchedule["missedRunPolicy"] })}><option value="skip">Skip it</option><option value="runOnceWhenAvailable">Run once when ShellX opens</option><option value="needsAttention">Ask me</option></select></label>}
        <label><span>Stop after</span><input data-debug-id="task-manager-max-run-seconds" data-shellx-release-observe="value" type="number" min="1" step="1" value={Math.max(1, Math.round(schedule.maxRunSeconds / 60))} onChange={(event) => onChange({ ...schedule, maxRunSeconds: (event.currentTarget.valueAsNumber || 0) * 60 })} /><small>Minutes</small></label>
        <label><span>Notify me</span><select data-debug-id="task-manager-notification-policy" data-shellx-release-observe="value" value={schedule.notificationPolicy} onChange={(event) => onChange({ ...schedule, notificationPolicy: event.currentTarget.value as TaskSchedule["notificationPolicy"] })}><option value="none">Never</option><option value="attentionOnly">Only when I need to act</option><option value="everyTerminalResult">After every result</option></select></label>
      </div>
    </details>
  </section>;
}

function ProviderRouteEditor({ draft, data, catalogue, disabledReason, onToggle, onMove, onModelChange }: {
  draft: TaskManagerDraft;
  data: Pick<TaskManagerData, "providerCatalogue" | "providerCatalogueState">;
  catalogue: TaskManagerData["providerCatalogue"];
  disabledReason?: string;
  onToggle: (providerId: string) => void;
  onMove: (providerId: string, direction: -1 | 1) => void;
  onModelChange: (providerId: string, value: string) => void;
}): JSX.Element {
  if (!catalogue) return <div className="task-manager-route-notice" data-debug-id="task-manager-provider-empty">Agent availability has not been checked for this environment yet.</div>;
  if (disabledReason) return <div className="task-manager-route-notice" data-debug-id="task-manager-provider-guard"><ShellIcon name="alert" size={15} /> {disabledReason}</div>;
  const active = normalizeTaskCandidates(draft.candidates);
  const providersForDisplay = taskProvidersForDisplay(catalogue.providers, active);
  return <div className="task-manager-provider-list" data-debug-id="task-manager-provider-list">{providersForDisplay.map((provider) => {
    const candidate = active.find((item) => item.providerId === provider.providerId);
    const activeIndex = active.findIndex((item) => item.providerId === provider.providerId);
    const isReady = provider.availability.status === "ready" && provider.availability.canRun;
    const suggestedFromChat = draft.context?.agentSuggestion === provider.providerId;
    const clickReason = taskProviderSelectionDisabledReason(draft, data, provider.providerId, Boolean(candidate));
    const showModelChoice = Boolean(candidate) && (provider.models.length > 0 || candidate?.modelMode === "verifiedModel");
    return <article key={provider.providerId} className={`task-manager-provider ${candidate ? "is-active" : ""} ${!isReady ? "is-unavailable" : ""}`} data-debug-id={`task-manager-provider-${provider.providerId}`}>
      <button type="button" className="task-manager-provider-select" data-debug-id={`task-manager-provider-${provider.providerId}-toggle`} data-shellx-release-observe="pressed disabled title" onClick={() => onToggle(provider.providerId)} disabled={Boolean(clickReason)} title={clickReason ?? (candidate ? `Remove ${provider.label} from this task` : `Add ${provider.label} to this task`)} aria-pressed={Boolean(candidate)}>
        <span className="task-manager-provider-title"><strong title={provider.providerId}>{candidate && <b aria-label={`Agent order ${candidate.order}`}>{candidate.order}</b>}{provider.label}</strong>{suggestedFromChat && <small><em className="task-manager-provider-suggestion" data-debug-id={`task-manager-provider-${provider.providerId}-suggested`} title="Suggested by the originating chat; select it explicitly to add it to this task.">Suggested from chat</em></small>}</span>
        <span className={`task-manager-provider-status status-${provider.availability.status}`}>{providerStatusLabel(provider.availability.status)}</span>
      </button>
      {!isReady && <p>{provider.availability.detail}</p>}
      {isReady && (Boolean(provider.availability.version) || Boolean(provider.availability.detail) || provider.capabilityGuidance.length > 0) && <details className="task-manager-provider-details"><summary>Details</summary><p><code>{provider.providerId}{provider.availability.version ? ` · ${provider.availability.version}` : ""}</code>{provider.availability.detail ? ` · ${provider.availability.detail}` : ""}</p>{provider.capabilityGuidance.length > 0 && <div className="task-manager-guidance">{provider.capabilityGuidance.map((capability) => <span key={capability.id} title={`Capability guidance from ${capability.sourceCardIds.join(", ")}`}>{capability.label} <em>{capability.level}</em></span>)}</div>}</details>}
      {candidate && <div className={`task-manager-provider-route-controls ${showModelChoice ? "" : "is-order-only"}`}>
        {showModelChoice && <label><span>Model</span><select data-debug-id={`task-manager-model-${provider.providerId}`} data-shellx-release-observe="value" value={candidate.modelMode === "verifiedModel" ? candidate.modelId : "providerDefault"} onChange={(event) => onModelChange(provider.providerId, event.currentTarget.value)}><option value="providerDefault">Automatic</option>{candidate.modelMode === "verifiedModel" && !provider.models.some((model) => model.id === candidate.modelId) && <option value={candidate.modelId}>{candidate.modelId} · saved</option>}{provider.models.map((model) => <option key={model.id} value={model.id}>{model.label} · verified</option>)}</select></label>}
        <div className="task-manager-order-controls" aria-label={`${provider.label} agent order`}><button type="button" data-debug-id={`task-manager-provider-${provider.providerId}-move-up`} data-shellx-release-observe="disabled title" onClick={() => onMove(provider.providerId, -1)} disabled={activeIndex <= 0} title={activeIndex <= 0 ? "Already first." : `Move ${provider.label} up`}><ShellIcon name="arrow-up" size={14} /> Move up</button><button type="button" data-debug-id={`task-manager-provider-${provider.providerId}-move-down`} data-shellx-release-observe="disabled title" onClick={() => onMove(provider.providerId, 1)} disabled={activeIndex === active.length - 1} title={activeIndex === active.length - 1 ? "Already last." : `Move ${provider.label} down`}><ShellIcon name="arrow-up" size={14} /> Move down</button><button type="button" data-debug-id={`task-manager-provider-${provider.providerId}-remove`} data-shellx-release-observe="title" onClick={() => onToggle(provider.providerId)} title={`Remove ${provider.label}`}><ShellIcon name="close" size={14} /> Remove</button></div>
      </div>}
    </article>;
  })}</div>;
}

function EmptyInspector({ title, detail }: { title: string; detail: string }): JSX.Element {
  return <div className="task-manager-empty-inspector"><ShellIcon name="alert" size={20} /><h3>{title}</h3><p>{detail}</p></div>;
}

function ActionButton({ label, icon, onClick, disabled, reason, primary = false, danger = false }: { label: string; icon: Parameters<typeof ShellIcon>[0]["name"]; onClick: () => void; disabled: boolean; reason?: string; primary?: boolean; danger?: boolean }): JSX.Element {
  return <button type="button" data-debug-id={`task-manager-action-${label.toLowerCase().replaceAll(" ", "-")}`} data-shellx-release-observe="disabled focused title" className={`task-manager-action-button ${primary ? "is-primary" : ""} ${danger ? "is-danger" : ""}`} onClick={onClick} disabled={disabled} title={disabled ? reason ?? "This action is unavailable." : label}><ShellIcon name={icon} size={14} /> {label}</button>;
}

function filterDefinitions(definitions: TaskDefinitionSummary[], filters: {
  stateFilter: TaskManagerStateFilter;
  search: string;
  projectFilter: string;
  environmentFilter: string;
  providerFilter: string;
}): TaskDefinitionSummary[] {
  const query = filters.search.trim().toLowerCase();
  return definitions.filter((definition) => (
    (filters.stateFilter === "all" || definition.state === filters.stateFilter)
    && (filters.projectFilter === "all" || definition.projectLabel === filters.projectFilter)
    && (filters.environmentFilter === "all" || definition.environmentKey === filters.environmentFilter)
    && (filters.providerFilter === "all" || definition.providerIds.includes(filters.providerFilter))
    && (!query || [definition.name, definition.instructionPreview, definition.environmentLabel, definition.projectLabel, definition.providerRouteSummary, definition.scheduleSummary].filter(Boolean).join(" ").toLowerCase().includes(query))
  ));
}

function buildListFilterOptions(definitions: TaskDefinitionSummary[]): {
  projects: string[];
  environments: Array<{ key: string; label: string }>;
  providers: Array<{ id: string; label: string }>;
} {
  const projects = [...new Set(definitions.map((definition) => definition.projectLabel).filter((label): label is string => Boolean(label)))].sort();
  const environments = uniqueBy(definitions.map((definition) => ({ key: definition.environmentKey, label: definition.environmentLabel })), (environment) => environment.key)
    .sort((left, right) => left.label.localeCompare(right.label));
  const providers = uniqueBy(definitions.flatMap((definition) => definition.providerIds.map((id) => ({ id, label: providerLabel(id) }))), (provider) => provider.id)
    .sort((left, right) => left.label.localeCompare(right.label));
  return { projects, environments, providers };
}

function uniqueBy<T>(values: T[], keyFor: (value: T) => string): T[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = keyFor(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function providerLabel(providerId: string): string {
  return providerId.replaceAll("-", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function sameTaskSchedule(left: TaskSchedule, right: TaskSchedule): boolean {
  return left.timezone === right.timezone
    && left.missedRunPolicy === right.missedRunPolicy
    && left.maxRunSeconds === right.maxRunSeconds
    && left.notificationPolicy === right.notificationPolicy
    && JSON.stringify(left.trigger) === JSON.stringify(right.trigger);
}

function shortId(value: string): string {
  return value.length > 32 ? `${value.slice(0, 18)}…${value.slice(-8)}` : value;
}

function vaultGrantLabel(grant: NonNullable<TaskManagerData["vaultGrantOptions"]>[number]): string {
  const operation = grant.operation === "profileFill" ? "Profile fill"
    : grant.operation === "emailCodeRead" ? "Email code"
      : grant.operation === "agentWalletUse" ? "Agent wallet" : "Browser fill";
  return `${operation}${grant.origin ? ` · ${grant.origin}` : ""} · ${shortId(grant.grantId)}`;
}

function groupDefinitions(definitions: TaskDefinitionSummary[]): Array<{ state: Exclude<TaskManagerStateFilter, "all">; definitions: TaskDefinitionSummary[] }> {
  const groups = new Map<Exclude<TaskManagerStateFilter, "all">, TaskDefinitionSummary[]>();
  for (const state of ORDERED_STATES) groups.set(state, []);
  for (const definition of definitions) groups.get(definition.state)?.push(definition);
  return ORDERED_STATES.map((state) => ({ state, definitions: groups.get(state) ?? [] })).filter((group) => group.definitions.length > 0);
}

function runDisabledReason(target: TaskDefinitionDetail | undefined, handler: TaskManagerProps["onRunNow"], data: TaskManagerData): string | undefined {
  if (!target) return "Select a task before running it now.";
  if (!handler) return "Run now is unavailable until the Task execution coordinator is integrated.";
  if (!target.enabled) return "Enable and save this task before running it now.";
  if (target.state === "running") return "This task already has a running occurrence.";
  return taskReadyProviderRouteDisabledReason(target, data);
}

function actionHint(saveReason: string | undefined, runReason: string | undefined, selected: TaskDefinitionSummary | undefined): string {
  if (saveReason) return saveReason;
  if (runReason && selected) return runReason;
  return "All changes remain a draft until Save revision confirms durable storage.";
}

function environmentContext(environment: TaskManagerData["environments"][number]): string {
  const connection = environment.transport === "local" ? "Uses this chat's working folder" : "Saved connection";
  const runtime = ["native", "posix"].includes(environment.runtime.toLowerCase()) ? undefined : environment.runtime;
  return [connection, runtime, environment.projectLabel].filter(Boolean).join(" · ");
}

function messageForError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const TASK_WEEKDAYS: Array<{ id: TaskWeekday; label: string }> = [
  { id: "monday", label: "Mon" },
  { id: "tuesday", label: "Tue" },
  { id: "wednesday", label: "Wed" },
  { id: "thursday", label: "Thu" },
  { id: "friday", label: "Fri" },
  { id: "saturday", label: "Sat" },
  { id: "sunday", label: "Sun" },
];

function localTimeForTrigger(trigger: TaskTrigger): { hour: number; minute: number } | undefined {
  return "at" in trigger ? trigger.at : undefined;
}

function triggerForKind(kind: TaskTrigger["kind"], previous: TaskTrigger): TaskTrigger {
  const at = localTimeForTrigger(previous) ?? { hour: 9, minute: 0 };
  switch (kind) {
    case "manual": return { kind };
    case "once": return { kind, atMs: previous.kind === "once" && previous.atMs > 0 ? previous.atMs : nextWholeHourMs() };
    case "daily": return { kind, at };
    case "weekdays": return { kind, at };
    case "weekly": return { kind, at, weekdays: previous.kind === "weekly" && previous.weekdays.length > 0 ? previous.weekdays : ["monday"] };
    case "monthly": return { kind, at, day: previous.kind === "monthly" ? previous.day : 1 };
  }
}

function onceInputValue(atMs: number): string {
  if (!Number.isFinite(atMs) || atMs <= 0) return "";
  const value = new Date(atMs);
  const timezoneOffsetMs = value.getTimezoneOffset() * 60_000;
  return new Date(value.getTime() - timezoneOffsetMs).toISOString().slice(0, 16);
}

function atMsFromDateTimeInput(value: string): number {
  const atMs = new Date(value).getTime();
  return Number.isFinite(atMs) ? atMs : 0;
}

function nextWholeHourMs(): number {
  const now = Date.now();
  return Math.ceil((now + 3_600_000) / 3_600_000) * 3_600_000;
}
