export interface SessionTitleTab {
  sessionId?: string | null;
  title?: string | null;
  titleLocked?: boolean | null;
}

export interface SessionTitleOverride {
  sessionId: string;
  title: string;
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
