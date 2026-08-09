export type ComposerDrafts = Readonly<Record<string, string>>;

export function composerDraftForTab(
  drafts: ComposerDrafts,
  tabId: string | null | undefined,
): string {
  return tabId ? drafts[tabId] ?? "" : "";
}

export function updateComposerDraftForTab(
  drafts: ComposerDrafts,
  tabId: string | null | undefined,
  next: string,
): Record<string, string> {
  if (!tabId) return drafts as Record<string, string>;
  const current = drafts[tabId] ?? "";
  if (current === next) return drafts as Record<string, string>;
  if (!next) {
    if (!(tabId in drafts)) return drafts as Record<string, string>;
    const copy = { ...drafts };
    delete copy[tabId];
    return copy;
  }
  return { ...drafts, [tabId]: next };
}

export function pruneComposerDrafts(
  drafts: ComposerDrafts,
  liveTabIds: ReadonlySet<string>,
): Record<string, string> {
  const stale = Object.keys(drafts).filter((tabId) => !liveTabIds.has(tabId));
  if (stale.length === 0) return drafts as Record<string, string>;
  const copy = { ...drafts };
  for (const tabId of stale) delete copy[tabId];
  return copy;
}
