import type { ReleaseSurfaceItem } from "../lib/release-surface-inventory";

export const TASK_MANAGER_CONTROL_DRIVER_ID = "ui-control-task-manager-installed";
export const TASK_MANAGER_CONTROL_FIXTURE = "ui:task-manager-owned-native-control-lifecycle";
export const TASK_MANAGER_CONTROL_CLEANUP = "ui:clear-owned-task-manager-fixture-and-restore-app-view";
export const TASK_MANAGER_CONTROL_ORACLES = [
  "ui:activation:task-manager-native-state-transition",
  "ui:boolean-state-transition",
  "ui:choice-state-transition",
  "ui:disclosure-state-transition",
  "ui:value-state-transition",
] as const;

export const TASK_MANAGER_CONTROL_SURFACE_NAMES = new Set([
  "src/components/TaskManager.tsx:[data-debug-id^=\"task-manager-action-\"]",
  "src/components/TaskManager.tsx:[data-debug-id^=\"task-manager-definition-\"]",
  "src/components/TaskManager.tsx:[data-debug-id^=\"task-manager-model-\"]",
  "src/components/TaskManager.tsx:[data-debug-id^=\"task-manager-provider-\"][data-debug-id$=\"-move-down\"]",
  "src/components/TaskManager.tsx:[data-debug-id^=\"task-manager-provider-\"][data-debug-id$=\"-move-up\"]",
  "src/components/TaskManager.tsx:[data-debug-id^=\"task-manager-provider-\"][data-debug-id$=\"-remove\"]",
  "src/components/TaskManager.tsx:[data-debug-id^=\"task-manager-provider-\"][data-debug-id$=\"-toggle\"]",
  "src/components/TaskManager.tsx:[data-debug-id^=\"task-manager-weekday-\"]",
  "src/components/TaskManager.tsx:[data-debug-id=\"task-manager-acknowledge-attention\"]",
  "src/components/TaskManager.tsx:[data-debug-id=\"task-manager-backdrop\"]",
  "src/components/TaskManager.tsx:[data-debug-id=\"task-manager-close\"]",
  "src/components/TaskManager.tsx:[data-debug-id=\"task-manager-enabled\"]",
  "src/components/TaskManager.tsx:[data-debug-id=\"task-manager-environment-filter\"]",
  "src/components/TaskManager.tsx:[data-debug-id=\"task-manager-environment\"]",
  "src/components/TaskManager.tsx:[data-debug-id=\"task-manager-filter-all\"]",
  "src/components/TaskManager.tsx:[data-debug-id=\"task-manager-filter-needsAttention\"]",
  "src/components/TaskManager.tsx:[data-debug-id=\"task-manager-filter-paused\"]",
  "src/components/TaskManager.tsx:[data-debug-id=\"task-manager-filter-recent\"]",
  "src/components/TaskManager.tsx:[data-debug-id=\"task-manager-filter-running\"]",
  "src/components/TaskManager.tsx:[data-debug-id=\"task-manager-filter-scheduled\"]",
  "src/components/TaskManager.tsx:[data-debug-id=\"task-manager-instruction\"]",
  "src/components/TaskManager.tsx:[data-debug-id=\"task-manager-max-run-seconds\"]",
  "src/components/TaskManager.tsx:[data-debug-id=\"task-manager-missed-run-policy\"]",
  "src/components/TaskManager.tsx:[data-debug-id=\"task-manager-name\"]",
  "src/components/TaskManager.tsx:[data-debug-id=\"task-manager-notification-policy\"]",
  "src/components/TaskManager.tsx:[data-debug-id=\"task-manager-open-vault\"]",
  "src/components/TaskManager.tsx:[data-debug-id=\"task-manager-project-filter\"]",
  "src/components/TaskManager.tsx:[data-debug-id=\"task-manager-schedule-advanced\"]",
  "src/components/TaskManager.tsx:[data-debug-id=\"task-manager-provider-filter\"]",
  "src/components/TaskManager.tsx:[data-debug-id=\"task-manager-recheck\"]",
  "src/components/TaskManager.tsx:[data-debug-id=\"task-manager-remove-attachment\"]",
  "src/components/TaskManager.tsx:[data-debug-id=\"task-manager-remove-vault-requirement\"]",
  "src/components/TaskManager.tsx:[data-debug-id=\"task-manager-remove-workflow\"]",
  "src/components/TaskManager.tsx:[data-debug-id=\"task-manager-search\"]",
  "src/components/TaskManager.tsx:[data-debug-id=\"task-manager-success-criteria\"]",
  "src/components/TaskManager.tsx:[data-debug-id=\"task-manager-timezone\"]",
  "src/components/TaskManager.tsx:[data-debug-id=\"task-manager-trigger-kind\"]",
  "src/components/TaskManager.tsx:[data-debug-id=\"task-manager-trigger-month-day\"]",
  "src/components/TaskManager.tsx:[data-debug-id=\"task-manager-trigger-once\"]",
  "src/components/TaskManager.tsx:[data-debug-id=\"task-manager-trigger-time\"]",
  "src/components/TaskManager.tsx:[data-debug-id=\"task-manager-vault-grant\"]",
  "src/components/TaskRunHistory.tsx:[data-debug-id^=\"task-manager-cancel-run-\"]",
  "src/components/TaskRunHistory.tsx:[data-debug-id^=\"task-manager-open-run-\"]",
]);

export function supportsTaskManagerControl(surface: ReleaseSurfaceItem): boolean {
  return surface.kind === "ui-control" && TASK_MANAGER_CONTROL_SURFACE_NAMES.has(surface.name);
}

export function taskManagerControlOracle(surface: ReleaseSurfaceItem): typeof TASK_MANAGER_CONTROL_ORACLES[number] {
  if (surface.driverFamily === "disclosure") return "ui:disclosure-state-transition";
  if (surface.driverFamily === "toggle") return "ui:boolean-state-transition";
  if (surface.driverFamily === "choice") return "ui:choice-state-transition";
  if (surface.driverFamily === "text-entry") return "ui:value-state-transition";
  return "ui:activation:task-manager-native-state-transition";
}
