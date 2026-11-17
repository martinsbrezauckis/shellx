import type { RawEventFrame } from "../types/acp";

export interface SessionJsonlPageCursor {
  beforeByte: number;
  sourceStamp: string;
  /** Opaque backend-minted capability; never derive one in the renderer. */
  token: string;
}

export interface SessionJsonlPageResponse {
  lines: string[];
  nextCursor: SessionJsonlPageCursor | null;
  sourceStamp: string;
  sourceBytes: number;
  omittedBytes: number;
  complete: boolean;
  /** Present when recovery omitted a known kind of unreadable source data. */
  omissionReasons?: string[];
  /** The backend is safely indexing delimiter-free legacy history. */
  recoveryState?: "indexing";
  /** Bytes examined during an indexing recovery response. */
  indexedBytes?: number;
}

export interface ParsedSessionHistoryPage {
  frames: RawEventFrame[];
  malformedLineCount: number;
}

export interface LoadedSessionHistoryPage {
  response: SessionJsonlPageResponse;
  parsed: ParsedSessionHistoryPage;
}

export const MAX_SESSION_HISTORY_PAGE_COUNT = 8;
export const SESSION_HISTORY_INDEXING_RETRY_DELAY_MS = 500;

export function isSessionHistoryIndexing(response: SessionJsonlPageResponse | null | undefined): boolean {
  return response?.recoveryState === "indexing";
}

/** Indexing is retried only while the last request remains healthy. */
export function sessionHistoryIndexingRetryDelay(
  response: SessionJsonlPageResponse | null | undefined,
  loading: boolean,
  error: string | null,
): number | null {
  return isSessionHistoryIndexing(response) && !loading && error === null
    ? SESSION_HISTORY_INDEXING_RETRY_DELAY_MS
    : null;
}

/** Keep recovery progress human-readable without exposing byte or cursor metadata. */
export function sessionHistoryIndexingProgressLabel(response: Pick<SessionJsonlPageResponse, "sourceBytes" | "indexedBytes">): string {
  const sourceBytes = Number.isFinite(response.sourceBytes) ? Math.max(0, response.sourceBytes) : 0;
  const indexedBytes = Number.isFinite(response.indexedBytes) ? Math.max(0, response.indexedBytes ?? 0) : 0;
  const percent = sourceBytes > 0
    ? Math.min(100, Math.floor((Math.min(indexedBytes, sourceBytes) / sourceBytes) * 100))
    : 0;
  return `Indexing delimiter-free legacy history ${percent}%…`;
}

/** Paged grouping cannot prove that a stream or tool lifecycle ends on this page. */
export function sessionHistoryPageMayContinueAcrossBoundary(frames: readonly RawEventFrame[]): boolean {
  return frames.some((frame) => {
    const payload = frame.payload as Record<string, unknown> | null;
    if (!payload) return false;
    const envelope = frame.kind === "session-update"
      ? payload.update
      : frame.kind === "grok-acp-event"
        ? payload
        : undefined;
    if (!envelope || typeof envelope !== "object") return false;
    const event = envelope as { method?: unknown; params?: { update?: { sessionUpdate?: unknown } } };
    if (event.method !== "session/update") return false;
    const updateKind = event.params?.update?.sessionUpdate;
    return updateKind === "agent_thought_chunk"
      || updateKind === "agent_message_chunk"
      || updateKind === "tool_call"
      || updateKind === "tool_call_delta_chunk"
      || updateKind === "tool_call_update";
  });
}

export interface SessionHistoryPageTarget {
  cursor: SessionJsonlPageCursor | null;
  pageIndex: number;
  cursorHistory?: Array<SessionJsonlPageCursor | null>;
  droppedNewerHistory?: boolean;
}

/**
 * Keep only page cursors, never accumulated pages. A known cursor is safe to
 * revisit. Once the window is full, moving older evicts its newest cursor;
 * the UI tells the operator that Reload is needed to return beyond that edge.
 */
export function olderSessionHistoryPageTarget(
  cursorHistory: readonly (SessionJsonlPageCursor | null)[],
  pageIndex: number,
  nextCursor: SessionJsonlPageCursor | null,
): SessionHistoryPageTarget | null {
  const knownCursor = cursorHistory[pageIndex + 1];
  if (knownCursor !== undefined) {
    return { cursor: knownCursor, pageIndex: pageIndex + 1 };
  }
  if (!nextCursor) return null;
  if (cursorHistory.length >= MAX_SESSION_HISTORY_PAGE_COUNT) {
    return {
      cursor: nextCursor,
      pageIndex: cursorHistory.length - 1,
      cursorHistory: [...cursorHistory.slice(1), nextCursor],
      droppedNewerHistory: true,
    };
  }
  return {
    cursor: nextCursor,
    pageIndex: pageIndex + 1,
    cursorHistory: [...cursorHistory, nextCursor],
  };
}

export function newerSessionHistoryPageTarget(
  cursorHistory: readonly (SessionJsonlPageCursor | null)[],
  pageIndex: number,
): SessionHistoryPageTarget | null {
  if (pageIndex <= 0) return null;
  const cursor = cursorHistory[pageIndex - 1];
  if (cursor === undefined) return null;
  return { cursor, pageIndex: pageIndex - 1 };
}

/**
 * JSONL remains the durable source, but the conversation surface only accepts
 * well-formed event frames. The caller can show the count without exposing a
 * raw malformed record or session metadata in the normal transcript view.
 */
export function parseSessionHistoryPage(lines: readonly string[]): ParsedSessionHistoryPage {
  const frames: RawEventFrame[] = [];
  let malformedLineCount = 0;
  for (const line of lines) {
    try {
      const value = JSON.parse(line) as Partial<RawEventFrame> | null;
      if (!value || typeof value.t !== "number" || !Number.isFinite(value.t) || typeof value.kind !== "string") {
        malformedLineCount += 1;
        continue;
      }
      frames.push(value as RawEventFrame);
    } catch {
      malformedLineCount += 1;
    }
  }
  return { frames, malformedLineCount };
}

/** The backend rejects a stale cursor rather than returning a mixed log. */
export function isSessionHistoryCursorInvalidation(error: unknown): boolean {
  const text = typeof error === "string" ? error : String(error);
  return /(?:cursor|source\s*stamp|session\s*log).*(?:changed|stale|invalid|mismatch)|(?:changed|stale|invalid|mismatch).*(?:cursor|source\s*stamp|session\s*log)/i.test(text);
}

export function sessionHistoryLoadError(error: unknown): string {
  if (isSessionHistoryCursorInvalidation(error)) {
    return "The session log changed while loading history. Reload history to avoid mixing records from different versions.";
  }
  return "Session history could not be loaded. Try again.";
}
