import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const header = readFileSync(resolve(root, "src/components/Header.tsx"), "utf8");
const bottomPanel = readFileSync(resolve(root, "src/components/BottomPanel.tsx"), "utf8");
const app = readFileSync(resolve(root, "src/App.tsx"), "utf8");

for (const required of [
  'data-debug-id="header-tasks"',
  'data-debug-id="header-tasks-attention"',
  'taskAttentionCount > 9 ? "9+"',
  'aria-label={taskAttentionCount > 0',
]) {
  assert(header.includes(required), `Header must retain the bounded Tasks entry contract: ${required}`);
}

for (const required of [
  'data-debug-id="composer-create-task"',
  'title={createTaskDisabledReason ?? "Create a task from this conversation"}',
  'disabled={!onCreateTask || Boolean(createTaskDisabledReason)}',
  'onCreateTask={onCreateTask}',
  'createTaskDisabledReason={createTaskDisabledReason}',
]) {
  assert(bottomPanel.includes(required), `BottomPanel must retain the reviewed composer handoff: ${required}`);
}

assert(!header.includes("onRunTask"), "the header entry must never start Task execution");
assert(!bottomPanel.includes("task_provider_catalog"), "the composer must not scan providers directly");

for (const required of [
  "createTaskManagerController",
  'lazy(() => import("./components/TaskManager")',
  '<LazySurface label="Task Manager" onDismiss={closeTaskManager}>',
  "taskAttentionCount(taskManagerData.definitions)",
  "taskManagerOpenRef.current = taskManagerOpen",
  "taskManagerModeRef.current = taskManagerMode",
  'if (taskManagerOpenRef.current && taskManagerModeRef.current === "create") return;',
  "onOpenTasks={() => openTaskManager(\"edit\")}",
  "onCreateTask={createTaskFromComposer}",
  'setTaskManagerMode("edit")',
  "setTaskManagerInitialDraft(undefined)",
  '"tasks_persist_attachments"',
  '"tasks_reclaim_attachments"',
  '"tasks_maintain_attachments"',
  "parseTaskAttachmentPersistenceResponse",
  "parseTaskAttachmentReclamationResponse",
  "parseTaskAttachmentMaintenanceResponse",
  "taskAttachmentPersistenceInFlightRef.current",
  "attachmentRefs,",
  "<TaskManager",
  "onSave={debugTaskManagerFixtureMode",
  ": saveTaskManagerDraft}",
  ": (request) => taskManagerController.pause(request)}",
  ": (request) => taskManagerController.resume(request)}",
  ": (request) => taskManagerController.duplicate(request)}",
  ": (request) => taskManagerController.delete(request)}",
  ": (request) => taskManagerController.resolveAttention(request)}",
  ": (request) => taskManagerController.cancelRun(request)}",
  'onOpenRun={({ conversationSessionId }) =>',
  ": (request) => taskManagerController.requestProviderCatalogue(request)}",
]) assert(app.includes(required), `App must retain the bounded Task Manager wiring: ${required}`);
assert(!app.includes('import { TaskManager } from "./components/TaskManager"'), "Task Manager must remain outside the startup bundle");
assert(app.includes(": (request) => taskManagerController.runNow(request)}"), "run-now must use the integrated durable execution controller outside the isolated renderer fixture");
assert(app.includes("handleOpenChat(conversationSessionId)"), "open-run must use only the receipted provider conversation ID");
assert(app.indexOf('if (result.accepted)') < app.indexOf('pendingImportedTaskAttachmentsRef.current.length === 0'), "a successful create must enter the selected durable task before optional attachment cleanup returns");

console.log("Task entry controls passed: bounded attention, reviewed composer handoff, and durable Task execution wiring.");
