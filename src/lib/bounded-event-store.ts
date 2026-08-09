import type { RawEventFrame } from "../types/acp";

export const MAX_RENDERER_EVENT_FRAMES = 12_000;
export const MAX_RENDERER_EVENTS_PER_SCOPE = 6_000;
export const MAX_SESSION_LOG_REHYDRATION_LINES = 6_000;

const HISTORY_MARKER_KIND = "renderer-history-truncated";
const UNTAGGED_SCOPE = "__shellx_untagged__";

interface HistoryMarkerPayload {
  _meta: { tabId?: string; kind: typeof HISTORY_MARKER_KIND };
  text: string;
  omittedEvents: number;
  omittedBeforeMs: number;
}

interface MarkerState {
  omittedEvents: number;
  omittedBeforeMs: number;
}

export function rendererEventScope(frame: RawEventFrame): string | null {
  const payload = frame.payload as {
    _meta?: { tabId?: unknown };
    params?: { _meta?: { tabId?: unknown } };
  } | null;
  const direct = payload?._meta?.tabId;
  if (typeof direct === "string" && direct.trim()) return direct;
  const nested = payload?.params?._meta?.tabId;
  if (typeof nested === "string" && nested.trim()) return nested;
  const frameMeta = (frame as RawEventFrame & { _meta?: { tabId?: unknown } })._meta?.tabId;
  return typeof frameMeta === "string" && frameMeta.trim() ? frameMeta : null;
}

/** Bind an otherwise untagged live frame to the tab active at ingest time. */
export function withRendererEventTabId(
  frame: RawEventFrame,
  fallbackTabId: string | null,
): RawEventFrame {
  if (rendererEventScope(frame) || !fallbackTabId?.trim()) return frame;
  return {
    ...frame,
    _meta: { tabId: fallbackTabId },
  } as RawEventFrame & { _meta: { tabId: string } };
}

export function historyTruncationFrame(
  tabId: string | null,
  omittedEvents: number,
  omittedBeforeMs: number,
): RawEventFrame {
  const safeCount = Math.max(1, Math.floor(omittedEvents));
  const safeBeforeMs = Number.isFinite(omittedBeforeMs) ? omittedBeforeMs : Date.now();
  const payload: HistoryMarkerPayload = {
    _meta: { kind: HISTORY_MARKER_KIND },
    text: `· Earlier activity is hidden from this in-memory view (${safeCount.toLocaleString()} events); the full transcript remains saved in the session log.`,
    omittedEvents: safeCount,
    omittedBeforeMs: safeBeforeMs,
  };
  if (tabId) payload._meta.tabId = tabId;
  return {
    t: safeBeforeMs,
    kind: "ui",
    payload,
  };
}

export function isRendererHistoryTruncationFrame(frame: RawEventFrame): boolean {
  const payload = frame.payload as Partial<HistoryMarkerPayload> | null;
  return frame.kind === "ui" && payload?._meta?.kind === HISTORY_MARKER_KIND;
}

export function appendBoundedRendererEvents(
  current: readonly RawEventFrame[],
  incoming: RawEventFrame | readonly RawEventFrame[],
  maxTotal = MAX_RENDERER_EVENT_FRAMES,
  maxPerScope = MAX_RENDERER_EVENTS_PER_SCOPE,
): RawEventFrame[] {
  const next = Array.isArray(incoming) ? incoming : [incoming];
  return compactRendererEvents([...current, ...next], maxTotal, maxPerScope);
}

export function compactRendererEvents(
  events: readonly RawEventFrame[],
  maxTotal = MAX_RENDERER_EVENT_FRAMES,
  maxPerScope = MAX_RENDERER_EVENTS_PER_SCOPE,
): RawEventFrame[] {
  const totalLimit = Math.max(2, Math.floor(maxTotal));
  const perScopeLimit = Math.max(2, Math.min(totalLimit, Math.floor(maxPerScope)));
  const markerByScope = new Map<string, MarkerState>();
  const data: Array<{ event: RawEventFrame; scope: string; sourceIndex: number }> = [];
  const dataCountByScope = new Map<string, number>();

  events.forEach((event, sourceIndex) => {
    const scope = rendererEventScope(event) ?? UNTAGGED_SCOPE;
    if (isRendererHistoryTruncationFrame(event)) {
      const payload = event.payload as Partial<HistoryMarkerPayload> | null;
      const omittedEvents = Number(payload?.omittedEvents);
      const omittedBeforeMs = Number(payload?.omittedBeforeMs);
      const previous = markerByScope.get(scope);
      markerByScope.set(scope, {
        omittedEvents:
          (previous?.omittedEvents ?? 0) +
          (Number.isFinite(omittedEvents) && omittedEvents > 0 ? Math.floor(omittedEvents) : 1),
        omittedBeforeMs: Math.min(
          previous?.omittedBeforeMs ?? Number.POSITIVE_INFINITY,
          Number.isFinite(omittedBeforeMs) ? omittedBeforeMs : event.t,
        ),
      });
      return;
    }
    data.push({ event, scope, sourceIndex });
    dataCountByScope.set(scope, (dataCountByScope.get(scope) ?? 0) + 1);
  });

  const scopes = new Set<string>([...dataCountByScope.keys(), ...markerByScope.keys()]);
  const hasOverflow =
    events.length > totalLimit ||
    [...dataCountByScope.values()].some((count) => count > perScopeLimit);
  if (!hasOverflow && markerByScope.size === 0) return Array.from(events);
  if (scopes.size === 0) return [];

  const markerCapacity = scopes.size;
  const dataCapacity = Math.max(1, totalLimit - markerCapacity);
  const desiredByScope = new Map(
    [...scopes].map((scope) => [
      scope,
      Math.min(perScopeLimit - 1, dataCountByScope.get(scope) ?? 0),
    ]),
  );
  const quotaByScope = fairScopeQuotas(desiredByScope, dataCapacity);
  const keptCountByScope = new Map<string, number>();
  const keptSourceIndices = new Set<number>();

  for (let index = data.length - 1; index >= 0; index -= 1) {
    const entry = data[index];
    if (!entry) continue;
    const keptForScope = keptCountByScope.get(entry.scope) ?? 0;
    if (keptForScope >= (quotaByScope.get(entry.scope) ?? 0)) continue;
    keptCountByScope.set(entry.scope, keptForScope + 1);
    keptSourceIndices.add(entry.sourceIndex);
  }

  for (const scope of scopes) {
    const dropped = (dataCountByScope.get(scope) ?? 0) - (keptCountByScope.get(scope) ?? 0);
    if (dropped <= 0) continue;
    const previous = markerByScope.get(scope);
    markerByScope.set(scope, {
      omittedEvents: (previous?.omittedEvents ?? 0) + dropped,
      omittedBeforeMs: previous?.omittedBeforeMs ?? firstEventTimeForScope(data, scope),
    });
  }

  const insertedMarkers = new Set<string>();
  const compacted: RawEventFrame[] = [];
  for (const entry of data) {
    if (!keptSourceIndices.has(entry.sourceIndex)) continue;
    const marker = markerByScope.get(entry.scope);
    if (marker && !insertedMarkers.has(entry.scope)) {
      compacted.push(historyTruncationFrame(
        entry.scope === UNTAGGED_SCOPE ? null : entry.scope,
        marker.omittedEvents,
        marker.omittedBeforeMs,
      ));
      insertedMarkers.add(entry.scope);
    }
    compacted.push(entry.event);
  }
  return compacted;
}

function fairScopeQuotas(
  desiredByScope: ReadonlyMap<string, number>,
  capacity: number,
): Map<string, number> {
  const quotas = new Map<string, number>();
  const sorted = [...desiredByScope.entries()].sort((left, right) => left[1] - right[1]);
  let remaining = Math.max(0, capacity);
  let remainingScopes = sorted.length;
  for (const [scope, desired] of sorted) {
    const equalShare = remainingScopes > 0 ? Math.floor(remaining / remainingScopes) : 0;
    const quota = Math.min(desired, equalShare);
    quotas.set(scope, quota);
    remaining -= quota;
    remainingScopes -= 1;
  }
  return quotas;
}

function firstEventTimeForScope(
  data: ReadonlyArray<{ event: RawEventFrame; scope: string }>,
  scope: string,
): number {
  return data.find((entry) => entry.scope === scope)?.event.t ?? Date.now();
}
