import type { ConnectionPreset } from "../components/ConnectionPicker";
import { scanTaskProviderCatalog } from "./task-provider-catalog";
import type {
  TaskDefinitionDetail,
  TaskManagerActionResult,
  TaskManagerData,
  TaskManagerDraft,
  TaskPauseRequest,
  TaskProviderCatalogueRequest,
  TaskVaultGrantOption,
  TaskDeleteRequest,
  TaskDuplicateRequest,
  TaskRunRequest,
  TaskResolveAttentionRequest,
  TaskCancelRunRequest,
} from "./task-manager-contract";
import {
  draftToTaskStoreDraft,
  recordToTaskDefinitionDetail,
  taskEnvironmentKey,
  taskEnvironmentOption,
  toTaskProviderCatalogue,
  type TaskManagerEnvironment,
  type TaskStoreDefinition,
  type TaskStoreDraft,
  type TaskStoreRecord,
  type TaskStoreReceipt,
  type TaskStoreStateProjection,
} from "./task-manager-tauri-adapter";

export interface TaskManagerInvoke {
  <T>(command: string, args?: Record<string, unknown>): Promise<T>;
}

/** Current tab context is a source for a reviewed draft, not a provider route. */
export interface TaskManagerCurrentContext {
  localPreset: ConnectionPreset;
  activeConnectionId: string | null;
  canonicalCwd: string;
  projectId?: string;
  projectLabel?: string;
}

export interface TaskManagerControllerOptions {
  invoke: TaskManagerInvoke;
  onData: (data: TaskManagerData) => void;
  scanProviderCatalogue?: (preset: ConnectionPreset) => ReturnType<typeof scanTaskProviderCatalog>;
}

interface TaskRunNowResponse {
  occurrenceId: string;
  disposition: "queued";
}

const TASK_OCCURRENCE_ID = /^task-occurrence:v1:[a-f0-9]{64}$/;

const EMPTY_DATA: TaskManagerData = {
  loadState: "loading",
  environments: [],
  providerCatalogueState: { state: "idle" },
  definitions: [],
  vaultGrantOptions: [],
  vaultGrantState: { state: "loading" },
};

interface RawVaultGrantSummary {
  grantId: unknown;
  secretRef: unknown;
  actorScope: unknown;
  operation: unknown;
  origin?: unknown;
  expiresAtMs?: unknown;
  revoked: unknown;
  approved: unknown;
}

/**
 * The only renderer-side Tauri boundary for durable Task definitions. It
 * owns logical preset identity and attaches it to the target-bound catalogue
 * returned by Rust. Run now submits only an exact immutable revision to the
 * durable native queue; this controller never starts a provider directly.
 */
export class TaskManagerController {
  private readonly invoke: TaskManagerInvoke;
  private readonly onData: (data: TaskManagerData) => void;
  private readonly scanProviderCatalogue: (preset: ConnectionPreset) => ReturnType<typeof scanTaskProviderCatalog>;
  private data: TaskManagerData = EMPTY_DATA;
  private environments = new Map<string, TaskManagerEnvironment>();
  private records = new Map<string, TaskStoreRecord>();
  private receipts = new Map<string, TaskStoreReceipt[]>();
  private projections = new Map<string, TaskStoreStateProjection>();
  private loadGeneration = 0;
  private catalogueGeneration = 0;
  private selectionGeneration = 0;

  constructor(options: TaskManagerControllerOptions) {
    this.invoke = options.invoke;
    this.onData = options.onData;
    this.scanProviderCatalogue = options.scanProviderCatalogue ?? scanTaskProviderCatalog;
  }

  snapshot(): TaskManagerData {
    return this.data;
  }

  async load(context: TaskManagerCurrentContext): Promise<TaskManagerData> {
    const generation = ++this.loadGeneration;
    // A catalogue is target-bound to the environment map that produced it.
    // Discard any in-flight result before replacing the logical environments.
    ++this.catalogueGeneration;
    this.publish({
      ...this.data,
      loadState: "loading",
      loadDetail: undefined,
      providerCatalogue: undefined,
      providerCatalogueState: { state: "idle" },
      vaultGrantState: { state: "loading" },
    });
    try {
      const presets = await this.invoke<ConnectionPreset[]>("connections_list");
      if (generation !== this.loadGeneration) return this.data;
      const environments = buildEnvironments(presets, context);
      // T1 returns the exact current definition/revision pair so list rows
      // cannot be rendered from a guessed or separately fetched revision.
      const grants = this.invoke<RawVaultGrantSummary[]>("shellx_vault_list_grants")
        .then((rows) => ({ options: normalizeTaskVaultGrants(rows), state: { state: "ready" as const } }))
        .catch(() => ({
          options: [] as TaskVaultGrantOption[],
          state: { state: "unavailable" as const, detail: "Vault grant metadata is unavailable." },
        }));
      const [records, projections, vaultGrants] = await Promise.all([
        this.invoke<TaskStoreRecord[]>("tasks_list"),
        this.invoke<TaskStoreStateProjection[]>("tasks_list_states"),
        grants,
      ]);
      if (generation !== this.loadGeneration) return this.data;
      this.environments = environments;
      this.records = new Map(records.map((record) => [record.definition.taskId, record]));
      this.projections = new Map(projections.map((projection) => [projection.taskId, projection]));
      // `tasks_list` carries the durable definition/revision pair. Receipts
      // are bounded and loaded only when someone selects that definition.
      this.receipts = new Map();
      const details = records.map((record) => recordToTaskDefinitionDetail(
        record,
        [],
        this.environments,
        this.projections.get(record.definition.taskId),
      ));
      this.publish({
        loadState: details.length === 0 ? "empty" : "ready",
        environments: [...this.environments.values()].map(taskEnvironmentOption),
        providerCatalogue: undefined,
        providerCatalogueState: { state: "idle" },
        vaultGrantOptions: vaultGrants.options,
        vaultGrantState: vaultGrants.state,
        definitions: details,
        selectedDefinitionId: undefined,
        selectedDefinition: undefined,
      });
    } catch (error) {
      if (generation !== this.loadGeneration) return this.data;
      this.publish({
        ...this.data,
        loadState: "error",
        loadDetail: message(error),
        environments: [...this.environments.values()].map(taskEnvironmentOption),
      });
    }
    return this.data;
  }

  async selectDefinition(definitionId: string): Promise<void> {
    const generation = ++this.selectionGeneration;
    this.publish({ ...this.data, selectedDefinitionId: definitionId, selectedDefinition: undefined });
    try {
      const [record, receipts, projection] = await Promise.all([
        this.invoke<TaskStoreRecord>("tasks_get", { request: { taskId: definitionId } }),
        this.invoke<TaskStoreReceipt[]>("tasks_list_receipts", { request: { taskId: definitionId, limit: 128 } }),
        this.invoke<TaskStoreStateProjection>("tasks_get_state", { request: { taskId: definitionId } }),
      ]);
      if (generation !== this.selectionGeneration) return;
      this.records.set(definitionId, record);
      this.receipts.set(definitionId, receipts);
      this.projections.set(definitionId, projection);
    } catch (error) {
      if (generation !== this.selectionGeneration) return;
      this.publish({ ...this.data, loadDetail: message(error) });
      return;
    }
    this.rebuildSelected(definitionId);
  }

  async requestProviderCatalogue(request: TaskProviderCatalogueRequest): Promise<TaskManagerActionResult> {
    const generation = ++this.catalogueGeneration;
    const environment = this.environments.get(request.environmentKey);
    if (!environment) {
      return { accepted: false, disabledReason: "The selected logical environment is no longer saved. Reload connections before rechecking providers." };
    }
    const environmentLabel = taskEnvironmentOption(environment).label;
    this.publish({
      ...this.data,
      providerCatalogueState: { state: "checking", detail: `Checking ${environmentLabel}.` },
    });
    try {
      const raw = await this.scanProviderCatalogue(environment.preset);
      if (generation !== this.catalogueGeneration || this.environments.get(request.environmentKey) !== environment) {
        return { accepted: false, disabledReason: "A newer environment selection superseded this availability check." };
      }
      const catalogue = toTaskProviderCatalogue(raw, environment.key);
      this.publish({
        ...this.data,
        providerCatalogue: catalogue,
        providerCatalogueState: { state: "ready", detail: `Checked ${environmentLabel}.` },
      });
      const readyAgents = catalogue.providers.filter((provider) => provider.availability.canRun).length;
      return { accepted: true, detail: `Checked ${environmentLabel}; ${readyAgents} agent${readyAgents === 1 ? "" : "s"} ready.` };
    } catch (error) {
      if (generation !== this.catalogueGeneration || this.environments.get(request.environmentKey) !== environment) {
        return { accepted: false, disabledReason: "A newer environment selection superseded this availability check." };
      }
      const detail = message(error);
      this.publish({ ...this.data, providerCatalogueState: { state: "error", detail } });
      return { accepted: false, disabledReason: detail };
    }
  }

  async save(draft: TaskManagerDraft): Promise<TaskManagerActionResult> {
    try {
      const existing = draft.taskId ? this.records.get(draft.taskId) : undefined;
      if (draft.taskId && !existing) throw new Error("The selected Task revision is no longer loaded. Reload it before saving.");
      const environment = this.environments.get(draft.environmentKey);
      const payload = draftToTaskStoreDraft(draft, this.data.providerCatalogue, environment, existing?.revision);
      let record: TaskStoreRecord;
      if (draft.taskId) {
        if (!draft.revisionId || !draft.revisionHash) throw new Error("The selected Task revision has no CAS identity. Reload it before saving.");
        record = await this.invoke<TaskStoreRecord>("tasks_revise", {
          request: {
            taskId: draft.taskId,
            precondition: { expectedRevisionId: draft.revisionId, expectedRevisionHash: draft.revisionHash },
            draft: payload,
          },
        });
      } else {
        record = await this.invoke<TaskStoreRecord>("tasks_create", {
          request: { draft: payload, paused: !draft.enabled },
        });
      }
      // T1 intentionally keeps pause/resume outside revise. Reconcile the
      // reviewed enabled choice only after its revision CAS has succeeded.
      if (record.definition.paused === draft.enabled) {
        const command = draft.enabled ? "tasks_resume" : "tasks_pause";
        const definition = await this.invoke<TaskStoreDefinition>(command, { request: { taskId: record.definition.taskId } });
        record = { ...record, definition };
      }
      this.records.set(record.definition.taskId, record);
      this.receipts.set(record.definition.taskId, await this.invoke<TaskStoreReceipt[]>("tasks_list_receipts", {
        request: { taskId: record.definition.taskId, limit: 128 },
      }));
      this.projections.set(record.definition.taskId, await this.invoke<TaskStoreStateProjection>("tasks_get_state", {
        request: { taskId: record.definition.taskId },
      }));
      this.rebuildSelected(record.definition.taskId);
      return { accepted: true, detail: `Saved revision ${record.definition.currentRevisionId}.` };
    } catch (error) {
      return { accepted: false, disabledReason: message(error) };
    }
  }

  async runNow(request: TaskRunRequest): Promise<TaskManagerActionResult> {
    try {
      const response = await this.invoke<TaskRunNowResponse>("tasks_run_now", {
        request: {
          taskId: request.definitionId,
          revisionId: request.revisionId,
          revisionHash: request.revisionHash,
        },
      });
      if (response.disposition !== "queued" || !TASK_OCCURRENCE_ID.test(response.occurrenceId)) {
        throw new Error("ShellX returned an invalid Task queue receipt.");
      }
      await this.selectDefinition(request.definitionId);
      return {
        accepted: true,
        detail: `Run queued with receipt ${shortIdentity(response.occurrenceId)}.`,
      };
    } catch (error) {
      return { accepted: false, disabledReason: message(error) };
    }
  }

  async resolveAttention(request: TaskResolveAttentionRequest): Promise<TaskManagerActionResult> {
    try {
      const aggregate = request.aggregateOmittedCount !== undefined
        || request.aggregateUpdatedAtMs !== undefined;
      if (aggregate) {
        if (!Number.isInteger(request.aggregateOmittedCount) || request.aggregateOmittedCount! <= 0
          || !Number.isFinite(request.aggregateUpdatedAtMs) || request.aggregateUpdatedAtMs! <= 0) {
          throw new Error("The attention summary changed. Reload it before acknowledging.");
        }
        await this.invoke("tasks_resolve_attention_overflow", {
          request: {
            taskId: request.definitionId,
            expectedAttentionId: request.attentionId,
            expectedOmittedCount: request.aggregateOmittedCount,
            expectedUpdatedAtMs: request.aggregateUpdatedAtMs,
          },
        });
      } else {
        await this.invoke("tasks_resolve_attention", {
          request: {
            taskId: request.definitionId,
            attentionId: request.attentionId,
            expectedOpenedAtMs: request.expectedOpenedAtMs,
          },
        });
      }
      await this.selectDefinition(request.definitionId);
      return { accepted: true, detail: "Attention acknowledged with a durable resolution receipt." };
    } catch (error) {
      return { accepted: false, disabledReason: message(error) };
    }
  }

  async cancelRun(request: TaskCancelRunRequest): Promise<TaskManagerActionResult> {
    try {
      await this.invoke("tasks_cancel_run", {
        request: {
          occurrenceId: request.occurrenceId,
          attemptId: request.attemptId,
        },
      });
      return { accepted: true, detail: "Cancellation requested; the terminal result will be receipted before the provider is stopped." };
    } catch (error) {
      return { accepted: false, disabledReason: message(error) };
    }
  }

  async pause(request: TaskPauseRequest): Promise<TaskManagerActionResult> {
    return this.setPaused(request.definitionId, true);
  }

  async resume(request: TaskPauseRequest): Promise<TaskManagerActionResult> {
    return this.setPaused(request.definitionId, false);
  }

  async duplicate(request: TaskDuplicateRequest): Promise<TaskManagerActionResult> {
    try {
      const source = this.records.get(request.definitionId);
      if (!source || source.revision.revisionId !== request.revisionId) {
        throw new Error("The selected Task revision changed. Reload it before duplicating.");
      }
      const record = await this.invoke<TaskStoreRecord>("tasks_create", {
        request: {
          draft: duplicateTaskStoreDraft(source),
          // A copied definition must always return to explicit operator review.
          paused: true,
        },
      });
      this.records.set(record.definition.taskId, record);
      this.receipts.set(record.definition.taskId, await this.invoke<TaskStoreReceipt[]>("tasks_list_receipts", {
        request: { taskId: record.definition.taskId, limit: 128 },
      }));
      this.projections.set(record.definition.taskId, await this.invoke<TaskStoreStateProjection>("tasks_get_state", {
        request: { taskId: record.definition.taskId },
      }));
      this.rebuildSelected(record.definition.taskId);
      return { accepted: true, detail: `Duplicated as paused task ${record.definition.taskId}.` };
    } catch (error) {
      return { accepted: false, disabledReason: message(error) };
    }
  }

  async delete(request: TaskDeleteRequest): Promise<TaskManagerActionResult> {
    try {
      await this.invoke<void>("tasks_delete", { request: { taskId: request.definitionId } });
      this.records.delete(request.definitionId);
      this.receipts.delete(request.definitionId);
      this.projections.delete(request.definitionId);
      this.rebuildSelected(undefined);
      return { accepted: true, detail: "Task deleted and recorded in its receipt chain." };
    } catch (error) {
      return { accepted: false, disabledReason: message(error) };
    }
  }

  private async setPaused(taskId: string, paused: boolean): Promise<TaskManagerActionResult> {
    try {
      const definition = await this.invoke<TaskStoreDefinition>(paused ? "tasks_pause" : "tasks_resume", {
        request: { taskId },
      });
      const record = this.records.get(taskId);
      if (record) this.records.set(taskId, { ...record, definition });
      this.receipts.set(taskId, await this.invoke<TaskStoreReceipt[]>("tasks_list_receipts", {
        request: { taskId, limit: 128 },
      }));
      this.projections.set(taskId, await this.invoke<TaskStoreStateProjection>("tasks_get_state", {
        request: { taskId },
      }));
      this.rebuildSelected(taskId);
      return { accepted: true, detail: paused ? "Task paused." : "Task resumed." };
    } catch (error) {
      return { accepted: false, disabledReason: message(error) };
    }
  }

  private rebuildSelected(selectedDefinitionId: string | undefined): void {
    const details = [...this.records.values()]
      .map((record) => recordToTaskDefinitionDetail(
        record,
        this.receipts.get(record.definition.taskId) ?? [],
        this.environments,
        this.projections.get(record.definition.taskId),
      ));
    this.publish({
      ...this.data,
      loadState: details.length === 0 ? "empty" : "ready",
      loadDetail: undefined,
      environments: [...this.environments.values()].map(taskEnvironmentOption),
      definitions: details,
      selectedDefinitionId,
      selectedDefinition: this.selectedDetail(details, selectedDefinitionId),
    });
  }

  private selectedDetail(details: TaskDefinitionDetail[], id: string | undefined): TaskDefinitionDetail | undefined {
    return id ? details.find((detail) => detail.id === id) : undefined;
  }

  private publish(data: TaskManagerData): void {
    this.data = data;
    this.onData(data);
  }
}

function duplicateTaskStoreDraft(record: TaskStoreRecord): TaskStoreDraft {
  const revision = record.revision;
  return {
    name: copiedTaskName(revision.name),
    instruction: revision.instruction,
    successCriteria: revision.successCriteria,
    noChangeCriteria: revision.noChangeCriteria,
    environment: { ...revision.environment },
    candidates: revision.candidates.map((candidate) => ({
      ...candidate,
      model: { ...candidate.model },
      capabilityRequirements: [...candidate.capabilityRequirements],
      optionRefs: candidate.optionRefs.map((option) => ({ ...option })),
    })),
    executionPolicy: {
      ...revision.executionPolicy,
      toolExposureIds: [...revision.executionPolicy.toolExposureIds],
    },
    attachmentRefs: revision.attachmentRefs.map((attachment) => ({ ...attachment })),
    workflow: revision.workflow ? { ...revision.workflow } : undefined,
    vaultRequirements: revision.vaultRequirements.map((requirement) => ({ ...requirement })),
    trigger: structuredClone(revision.trigger),
    timezone: revision.timezone,
    missedRunPolicy: revision.missedRunPolicy,
    concurrencyPolicy: { ...revision.concurrencyPolicy },
    timeoutPolicy: { ...revision.timeoutPolicy },
    retryPolicy: { ...revision.retryPolicy },
    notificationPolicy: revision.notificationPolicy,
    retentionPolicy: { ...revision.retentionPolicy },
    // A duplicate is a new operator action, not another artifact of the
    // conversation that originally created the source definition.
    origin: undefined,
  };
}

function copiedTaskName(name: string): string {
  return Array.from(`Copy of ${name.trim()}`).slice(0, 160).join("");
}

export function createTaskManagerController(options: TaskManagerControllerOptions): TaskManagerController {
  return new TaskManagerController(options);
}

function buildEnvironments(
  presets: ConnectionPreset[],
  context: TaskManagerCurrentContext,
): Map<string, TaskManagerEnvironment> {
  const environments = new Map<string, TaskManagerEnvironment>();
  environments.set("local", {
    key: "local",
    preset: context.localPreset,
    canonicalCwd: context.activeConnectionId ? undefined : context.canonicalCwd,
    projectId: context.activeConnectionId ? undefined : context.projectId,
    projectLabel: context.activeConnectionId ? undefined : context.projectLabel,
  });
  for (const preset of presets) {
    const key = taskEnvironmentKey(preset.id);
    if (environments.has(key)) continue;
    const active = key === taskEnvironmentKey(context.activeConnectionId);
    environments.set(key, {
      key,
      preset,
      canonicalCwd: active ? context.canonicalCwd : undefined,
      projectId: active ? context.projectId : undefined,
      projectLabel: active ? context.projectLabel : undefined,
    });
  }
  return environments;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function shortIdentity(value: string): string {
  return value.length > 18 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value;
}

export function normalizeTaskVaultGrants(
  rows: RawVaultGrantSummary[],
  nowMs = Date.now(),
): TaskVaultGrantOption[] {
  if (!Array.isArray(rows)) return [];
  const seen = new Set<string>();
  const operations = new Set(["fill", "profileFill", "emailCodeRead", "agentWalletUse"]);
  return rows.flatMap((row): TaskVaultGrantOption[] => {
    if (!row || typeof row !== "object" || row.approved !== true || row.revoked !== false) return [];
    const grantId = safeGrantText(row.grantId, 256);
    const keyId = safeGrantText(row.secretRef, 256);
    const operation = safeGrantText(row.operation, 32);
    const actorScope = safeGrantText(row.actorScope, 512);
    const expiresAtMs = row.expiresAtMs === null || row.expiresAtMs === undefined
      ? undefined
      : typeof row.expiresAtMs === "number" && Number.isSafeInteger(row.expiresAtMs)
        ? row.expiresAtMs
        : null;
    if (!grantId || !keyId || !operation || !actorScope || expiresAtMs === null
      || (expiresAtMs !== undefined && expiresAtMs <= nowMs)
      || !operations.has(operation) || seen.has(grantId)) return [];
    try {
      const scope = JSON.parse(actorScope) as { kind?: unknown };
      if (scope.kind !== "allShellxAgents") return [];
    } catch {
      return [];
    }
    const origin = row.origin === null || row.origin === undefined
      ? undefined
      : safeGrantText(row.origin, 512) ?? undefined;
    if (row.origin !== null && row.origin !== undefined && !origin) return [];
    seen.add(grantId);
    return [{
      grantId,
      keyId,
      operation: operation as TaskVaultGrantOption["operation"],
      origin,
      expiresAtMs,
    }];
  }).sort((left, right) => left.keyId.localeCompare(right.keyId) || left.grantId.localeCompare(right.grantId));
}

function safeGrantText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const clean = value.trim();
  return clean && clean.length <= max && !/[\u0000-\u001f\u007f]/.test(clean) ? clean : null;
}
