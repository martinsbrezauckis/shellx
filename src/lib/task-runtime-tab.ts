const TASK_RUNTIME_TAB_PATTERN = /^task-run-[0-9a-f]{32}$/i;

/**
 * Automatic Task tabs are backend-owned and already write one private ShellX
 * transcript. The renderer must not bind their provider session IDs into a
 * second archive or surface the hidden execution tab as a normal live tab.
 */
export function isTaskRuntimeTabId(value: unknown): value is string {
  return typeof value === "string" && TASK_RUNTIME_TAB_PATTERN.test(value);
}
