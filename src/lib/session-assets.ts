import type { RawEventFrame } from "../types/acp";
import { groupEvents } from "./grouping";
import { extractSessionMedia, type SessionMediaItem, type SessionMediaKind } from "./session-media";

export interface SessionAssetSourceTab {
  tabId: string;
  sessionId?: string | null;
  title?: string | null;
  cwd?: string | null;
  connectionLabel?: string | null;
  connectionTransport?: string | null;
}

export interface SessionAssetItem extends SessionMediaItem {
  assetId: string;
  sourceTabId: string;
  sourceSessionId?: string | null;
  sourceTitle: string;
  sourceCwd?: string | null;
  sourceTransport?: string | null;
  sourceConnectionLabel?: string | null;
}

export interface SessionAssetRegistry {
  images: SessionAssetItem[];
  videos: SessionAssetItem[];
  all: SessionAssetItem[];
}

function eventTabId(ev: RawEventFrame): string | null {
  const payload: any = ev.payload;
  const tag = payload?._meta?.tabId
    ?? payload?.params?._meta?.tabId
    ?? (ev as any)?._meta?.tabId
    ?? null;
  return typeof tag === "string" && tag.trim().length > 0 ? tag : null;
}

function sourceTitle(tab: SessionAssetSourceTab): string {
  const title = tab.title?.trim();
  if (title && title !== "new session") return title;
  const cwd = tab.cwd?.trim();
  if (cwd) {
    const tail = cwd.replace(/[\\/]+$/, "").split(/[\\/]/).filter(Boolean).pop();
    if (tail) return tail;
  }
  return tab.sessionId || tab.tabId;
}

function assetKey(sourceTabId: string, item: SessionMediaItem): string {
  return `${sourceTabId}:${item.kind}:${item.path}`;
}

function toAsset(tab: SessionAssetSourceTab, item: SessionMediaItem): SessionAssetItem {
  return {
    ...item,
    assetId: assetKey(tab.tabId, item),
    id: assetKey(tab.tabId, item),
    sourceTabId: tab.tabId,
    sourceSessionId: tab.sessionId ?? null,
    sourceTitle: sourceTitle(tab),
    sourceCwd: tab.cwd ?? null,
    sourceTransport: tab.connectionTransport ?? null,
    sourceConnectionLabel: tab.connectionLabel ?? null,
  };
}

export function extractSessionAssetRegistry(
  events: RawEventFrame[],
  tabs: SessionAssetSourceTab[],
): SessionAssetRegistry {
  const knownTabs = new Map(tabs.map((tab) => [tab.tabId, tab]));
  const eventsByTab = new Map<string, RawEventFrame[]>();
  const singleTabId = tabs.length === 1 ? tabs[0]?.tabId : null;

  for (const ev of events) {
    const tag = eventTabId(ev) ?? singleTabId;
    if (!tag || !knownTabs.has(tag)) continue;
    const bucket = eventsByTab.get(tag) ?? [];
    bucket.push(ev);
    eventsByTab.set(tag, bucket);
  }

  const images: SessionAssetItem[] = [];
  const videos: SessionAssetItem[] = [];
  const seen = new Set<string>();

  const add = (target: SessionAssetItem[], tab: SessionAssetSourceTab, item: SessionMediaItem) => {
    const key = assetKey(tab.tabId, item);
    if (seen.has(key)) return;
    seen.add(key);
    target.push(toAsset(tab, item));
  };

  for (const tab of tabs) {
    const tabEvents = eventsByTab.get(tab.tabId) ?? [];
    if (tabEvents.length === 0) continue;
    const media = extractSessionMedia(groupEvents(tabEvents));
    for (const item of media.images) add(images, tab, item);
    for (const item of media.videos) add(videos, tab, item);
  }

  images.sort((a, b) => b.t - a.t);
  videos.sort((a, b) => b.t - a.t);
  const all = [...images, ...videos].sort((a, b) => b.t - a.t);
  return { images, videos, all };
}

export function splitAssetsByActiveTab(
  assets: SessionAssetItem[],
  activeTabId?: string | null,
): { current: SessionAssetItem[]; other: SessionAssetItem[] } {
  const current: SessionAssetItem[] = [];
  const other: SessionAssetItem[] = [];
  for (const asset of assets) {
    if (activeTabId && asset.sourceTabId === activeTabId) current.push(asset);
    else other.push(asset);
  }
  return { current, other };
}

export function mediaKindLabel(kind: SessionMediaKind): string {
  return kind === "image" ? "Image" : "Video";
}
