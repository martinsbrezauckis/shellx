import type { RawEventFrame } from "../types/acp";

export type LocalEventPersist = (ev: RawEventFrame) => boolean | Promise<boolean>;

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
