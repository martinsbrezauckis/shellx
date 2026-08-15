export const TASK_ENTRY_CONTROL_DRIVER_ID = "ui-control-task-entry-installed";
export const TASK_ENTRY_DEBUG_DRIVER_ID = "ui-debug-task-entry-installed";
export const TASK_ENTRY_FIXTURE = "ui:task-entry-owned-manager-handoff";
export const TASK_ENTRY_CLEANUP = "ui:clear-owned-task-manager-fixture-and-restore-app-view";
export const TASK_ENTRY_CONTROL_ORACLE = "ui:activation:task-entry-native-manager-handoff";
export const TASK_ENTRY_DEBUG_ORACLE = "ui:visible:task-entry-owned-state";

export const TASK_ENTRY_CONTROL_SURFACE_IDS = new Set([
  'ui-control:src/components/BottomPanel.tsx:[data-debug-id="composer-create-task"]@src/components/BottomPanel.tsx#17',
  'ui-control:src/components/Header.tsx:[data-debug-id="header-tasks"]@src/components/Header.tsx#3',
]);

export const TASK_ENTRY_DEBUG_SURFACE_IDS = new Set([
  "ui-debug-surface:composer-create-task@src/components/BottomPanel.tsx#14",
  "ui-debug-surface:header-tasks-attention@src/components/Header.tsx#3",
  "ui-debug-surface:header-tasks@src/components/Header.tsx#2",
]);
