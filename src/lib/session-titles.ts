export interface SessionTitleTab {
  sessionId?: string | null;
  title?: string | null;
  titleLocked?: boolean | null;
}

export interface SessionTitleOverride {
  sessionId: string;
  title: string;
}

export interface SessionTitleEvent {
  t: number;
  payload?: unknown;
}

export interface SessionTitleCandidate {
  t: number;
  title: string;
}

export function newestSessionTitleCandidates(
  events: readonly SessionTitleEvent[],
  fallbackTabId = "default",
): Map<string, SessionTitleCandidate> {
  const newest = new Map<string, SessionTitleCandidate>();
  for (const event of events) {
    const payload = event?.payload as any;
    const update = payload?.params?.update;
    const kind = update?.sessionUpdate;
    const title = kind === "session_summary_generated"
      ? update?.session_summary
      : kind === "session_info_update"
        ? update?.title === null
          ? "new session"
          : update?.title
        : null;
    if (typeof title !== "string" || !title.trim()) continue;
    const tabId = payload?._meta?.tabId ?? fallbackTabId;
    const previous = newest.get(tabId);
    if (!previous || event.t > previous.t) {
      newest.set(tabId, { t: event.t, title: title.trim() });
    }
  }
  return newest;
}

export function titleOverrideForClosingTab(
  tab: SessionTitleTab,
  existingOverrides: Record<string, string>,
): SessionTitleOverride | null {
  const sessionId = tab.sessionId?.trim();
  const title = tab.title?.trim();
  if (!sessionId || !title || !tab.titleLocked) return null;
  if (existingOverrides[sessionId] === title) return null;
  return { sessionId, title };
}
