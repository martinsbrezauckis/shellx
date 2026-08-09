export const BROWSER_COWORK_PROMPT_EVENT = "shellx:browser-cowork-prompt";
export const BROWSER_COWORK_DISPATCH_RESULT_EVENT = "shellx:browser-cowork-dispatch-result";

export interface BrowserCoworkPromptNotification {
  requestId: string;
}

export interface BrowserCoworkPromptEvent {
  requestId: string;
  taskId: string;
  browserTabId: string;
  targetTabId: string;
  prompt: string;
  visiblePrompt: string;
  createdTask: boolean;
}

export interface BrowserCoworkDispatchResultEvent {
  requestId: string;
  taskId: string;
  targetTabId: string;
  ok: boolean;
  error?: string;
}

function nonEmptyString(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const clean = value.trim();
  return clean && clean.length <= maxLength ? clean : null;
}

export function normalizeBrowserCoworkPromptNotification(
  value: unknown,
): BrowserCoworkPromptNotification | null {
  if (!value || typeof value !== "object") return null;
  const requestId = nonEmptyString((value as Record<string, unknown>).requestId, 128);
  return requestId ? { requestId } : null;
}

export function normalizeBrowserCoworkPromptEvent(value: unknown): BrowserCoworkPromptEvent | null {
  if (!value || typeof value !== "object") return null;
  const event = value as Record<string, unknown>;
  const requestId = nonEmptyString(event.requestId, 128);
  const taskId = nonEmptyString(event.taskId, 128);
  const browserTabId = nonEmptyString(event.browserTabId, 128);
  const targetTabId = nonEmptyString(event.targetTabId, 128);
  const prompt = nonEmptyString(event.prompt, 64_000);
  const visiblePrompt = nonEmptyString(event.visiblePrompt, 32_000);
  if (!requestId || !taskId || !browserTabId || !targetTabId || !prompt || !visiblePrompt) return null;
  return {
    requestId,
    taskId,
    browserTabId,
    targetTabId,
    prompt,
    visiblePrompt,
    createdTask: event.createdTask === true,
  };
}

export function normalizeBrowserCoworkDispatchResultEvent(
  value: unknown,
): BrowserCoworkDispatchResultEvent | null {
  if (!value || typeof value !== "object") return null;
  const event = value as Record<string, unknown>;
  const requestId = nonEmptyString(event.requestId, 128);
  const taskId = nonEmptyString(event.taskId, 128);
  const targetTabId = nonEmptyString(event.targetTabId, 128);
  if (!requestId || !taskId || !targetTabId || typeof event.ok !== "boolean") return null;
  const error = nonEmptyString(event.error, 2_000) ?? undefined;
  return { requestId, taskId, targetTabId, ok: event.ok, error };
}
