export interface ReconnectContinuityState {
  status?: string | null;
  sessionId?: string | null;
}

export interface ReconnectContinuityContext {
  priorSessionId?: string | null;
  cwd?: string | null;
}

export function shouldAddReconnectContinuityNote(state: ReconnectContinuityState): boolean {
  return Boolean(state.sessionId && state.status !== "Connected");
}

export function loadSessionIdForReconnect(state: ReconnectContinuityState): string | null {
  return shouldAddReconnectContinuityNote(state) ? state.sessionId ?? null : null;
}

export function reconnectContinuityUiText(priorSessionId?: string | null): string {
  const suffix = priorSessionId ? ` (${priorSessionId})` : "";
  return `→ loading previous Grok session${suffix}`;
}

export function buildReconnectContinuityPrompt(
  userPrompt: string,
  context: ReconnectContinuityContext,
): string {
  const prior = context.priorSessionId?.trim() || "unknown";
  const cwd = context.cwd?.trim() || "unknown";
  return [
    "[shellX reconnect continuity]",
    `The previous Grok process ended before this prompt. Previous session id: ${prior}.`,
    `Current working directory: ${cwd}.`,
    "Treat this as a continuation of the visible ShellX transcript. If the user's prompt is ambiguous, ask a clarifying question before taking tool actions.",
    "In a Windows desktop context, \"Paint\" usually means Microsoft Paint. Do not use image_gen or image_edit unless the user explicitly asks to generate or edit an image.",
    "",
    userPrompt,
  ].join("\n");
}
