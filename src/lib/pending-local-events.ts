import type { RawEventFrame } from "../types/acp";

export type LocalEventPersist = (ev: RawEventFrame) => boolean | Promise<boolean>;

export const MAX_SESSION_LOG_WRITE_BYTES = 256 * 1024;

export interface SessionLogWrite {
  sessionId: string;
  line: string;
  frameCount: number;
}

/**
 * Collapse a renderer frame envelope into bounded per-session JSONL writes.
 * Per-session source order is stable even when frames from multiple tabs are
 * interleaved. Frames without a live session binding remain caller-owned.
 */
export function buildSessionLogWrites(
  events: readonly RawEventFrame[],
  sessionIdForEvent: (event: RawEventFrame) => string | null,
  maxBytes = MAX_SESSION_LOG_WRITE_BYTES,
): SessionLogWrite[] {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new Error("session log write budget must be a positive safe integer");
  }
  type SizedSessionLogWrite = SessionLogWrite & { bytes: number };
  const writesBySession = new Map<string, SizedSessionLogWrite[]>();
  const encoder = new TextEncoder();
  for (const event of events) {
    const sessionId = sessionIdForEvent(event);
    if (!sessionId) continue;
    const record = JSON.stringify(event);
    const recordBytes = encoder.encode(record).byteLength;
    const sessionWrites = writesBySession.get(sessionId) ?? [];
    const current = sessionWrites.at(-1);
    const combinedBytes = current ? current.bytes + 1 + recordBytes : recordBytes;
    if (!current || combinedBytes > maxBytes) {
      sessionWrites.push({ sessionId, line: record, frameCount: 1, bytes: recordBytes });
    } else {
      current.line += `\n${record}`;
      current.frameCount += 1;
      current.bytes = combinedBytes;
    }
    writesBySession.set(sessionId, sessionWrites);
  }
  return [...writesBySession.values()].flat().map((write) => ({
    sessionId: write.sessionId,
    line: write.line,
    frameCount: write.frameCount,
  }));
}

export function localEventTabId(ev: RawEventFrame, fallback: string | null): string | null {
  const payload: any = ev.payload;
  const tag = payload?._meta?.tabId
    ?? payload?.params?._meta?.tabId
    ?? null;
  return typeof tag === "string" && tag.length > 0 ? tag : fallback;
}

export class PendingLocalEventQueue {
  private readonly queues = new Map<string, RawEventFrame[]>();

  constructor(private readonly maxPerTab = 200) {}

  enqueue(tabId: string, ev: RawEventFrame): void {
    const queue = this.queues.get(tabId) ?? [];
    queue.push(ev);
    while (queue.length > this.maxPerTab) queue.shift();
    this.queues.set(tabId, queue);
  }

  pendingCount(tabId: string): number {
    return this.queues.get(tabId)?.length ?? 0;
  }

  async flush(
    tabId: string,
    persist: LocalEventPersist,
  ): Promise<{ persisted: number; remaining: number }> {
    const queue = this.queues.get(tabId);
    if (!queue || queue.length === 0) return { persisted: 0, remaining: 0 };

    const remaining: RawEventFrame[] = [];
    let persisted = 0;
    for (const ev of queue) {
      let ok = false;
      try {
        ok = await persist(ev);
      } catch {
        ok = false;
      }
      if (ok) {
        persisted += 1;
      } else {
        remaining.push(ev);
      }
    }

    if (remaining.length > 0) {
      this.queues.set(tabId, remaining);
    } else {
      this.queues.delete(tabId);
    }
    return { persisted, remaining: remaining.length };
  }
}
