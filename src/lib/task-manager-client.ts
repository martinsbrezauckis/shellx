import type {
  TaskDefinitionDetail,
  TaskDuplicateRequest,
  TaskManagerActionResult,
  TaskManagerData,
  TaskManagerDraft,
  TaskOpenRunRequest,
  TaskPauseRequest,
  TaskProviderCatalogueRequest,
  TaskRunRequest,
  TaskDeleteRequest,
} from "./task-manager-contract";

/**
 * The Task Manager is deliberately transport-injected. Rendering this module
 * never probes a provider, reads credentials, or invokes a native command.
 */
export interface TaskManagerTransport {
  load(): Promise<TaskManagerData>;
  requestProviderCatalogue(request: TaskProviderCatalogueRequest): Promise<TaskManagerActionResult>;
  save(draft: TaskManagerDraft): Promise<TaskManagerActionResult>;
  runNow(request: TaskRunRequest): Promise<TaskManagerActionResult>;
  pause(request: TaskPauseRequest): Promise<TaskManagerActionResult>;
  duplicate(request: TaskDuplicateRequest): Promise<TaskManagerActionResult>;
  delete(request: TaskDeleteRequest): Promise<TaskManagerActionResult>;
  openRun(request: TaskOpenRunRequest): Promise<TaskManagerActionResult>;
  getDefinition?(definitionId: string): Promise<TaskDefinitionDetail>;
}

export function createTaskManagerClient(transport: TaskManagerTransport): TaskManagerTransport {
  return transport;
}
