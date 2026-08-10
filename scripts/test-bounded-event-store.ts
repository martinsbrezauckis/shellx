import assert from "node:assert/strict";

import {
  appendBoundedRendererEvents,
  compactRendererEvents,
  historyTruncationFrame,
  isRendererHistoryTruncationFrame,
  rendererEventScope,
  withRendererEventTabId,
} from "../src/lib/bounded-event-store";
import { groupEvents } from "../src/lib/grouping";
import { RendererEventBatcher } from "../src/lib/renderer-event-batcher";
import type { RawEventFrame } from "../src/types/acp";

function frame(tabId: string, index: number): RawEventFrame {
  return {
    t: index,
    kind: "ui",
    payload: { _meta: { tabId }, text: `event ${tabId}-${index}` },
  };
}

const small = [frame("tab-a", 1), frame("tab-a", 2)];
assert.deepEqual(compactRendererEvents(small, 8, 5), small);

const crowded = [
  ...Array.from({ length: 10 }, (_, index) => frame("tab-a", index)),
  ...Array.from({ length: 10 }, (_, index) => frame("tab-b", index + 20)),
];
const compacted = compactRendererEvents(crowded, 8, 5);
assert.equal(compacted.length, 8, "total renderer event budget includes truncation markers");
assert.equal(
  compacted.filter((event) => rendererEventScope(event) === "tab-a").length,
  4,
  "busy tabs receive an equal bounded share",
);
assert.equal(
  compacted.filter((event) => rendererEventScope(event) === "tab-b").length,
  4,
  "a newer busy tab cannot evict another tab's complete transcript tail",
);
assert.deepEqual(
  compacted
    .filter((event) => rendererEventScope(event) === "tab-a" && !isRendererHistoryTruncationFrame(event))
    .map((event) => event.t),
  [7, 8, 9],
  "the newest per-tab frames survive compaction in source order",
);

const tabAMarker = compacted.find(
  (event) => rendererEventScope(event) === "tab-a" && isRendererHistoryTruncationFrame(event),
);
assert.equal((tabAMarker?.payload as any)?.omittedEvents, 7);
assert.match((tabAMarker?.payload as any)?.text ?? "", /full transcript remains saved/);
assert.equal(groupEvents(tabAMarker ? [tabAMarker] : [])[0]?.kind, "ui");

const appended = appendBoundedRendererEvents(compacted, frame("tab-b", 31), 8, 5);
assert.equal(appended.length, 8);
assert.equal(
  appended.filter(isRendererHistoryTruncationFrame).length,
  2,
  "repeated compaction replaces rather than duplicates per-tab history markers",
);
assert.equal(
  (appended.find(
    (event) => rendererEventScope(event) === "tab-b" && isRendererHistoryTruncationFrame(event),
  )?.payload as any)?.omittedEvents,
  8,
  "history markers accumulate the number of frames removed from memory",
);

const sparseAndBusy = compactRendererEvents(
  [...Array.from({ length: 10 }, (_, index) => frame("tab-busy", index)), frame("tab-sparse", 20)],
  12,
  7,
);
assert.equal(
  sparseAndBusy.filter(
    (event) => rendererEventScope(event) === "tab-busy" && !isRendererHistoryTruncationFrame(event),
  ).length,
  6,
  "unused sparse-tab quota returns to a busy tab up to its per-tab ceiling",
);
assert.equal(
  sparseAndBusy.filter((event) => rendererEventScope(event) === "tab-sparse").length,
  1,
  "sparse tab history remains intact",
);

const nested: RawEventFrame = {
  t: 1,
  kind: "grok-acp-event",
  payload: { params: { _meta: { tabId: "tab-nested" } } },
};
assert.equal(rendererEventScope(nested), "tab-nested");
assert.equal(
  rendererEventScope(withRendererEventTabId({ t: 2, kind: "ui", payload: "untagged" }, "tab-active")),
  "tab-active",
  "untagged live frames remain visible after a second tab opens",
);
assert.equal(
  rendererEventScope(withRendererEventTabId(nested, "tab-wrong")),
  "tab-nested",
  "an emitter's explicit tab identity remains authoritative",
);

const explicitMarker = historyTruncationFrame("tab-c", 42, 500);
assert.equal(rendererEventScope(explicitMarker), "tab-c");
assert.equal(explicitMarker.t, 500);
assert.equal((explicitMarker.payload as any).omittedEvents, 42);

const scheduled = new Map<number, () => void>();
const cancelled: number[] = [];
const flushed: RawEventFrame[][] = [];
let nextHandle = 1;
const batcher = new RendererEventBatcher<RawEventFrame>(
  (batch) => flushed.push([...batch]),
  (flush) => {
    const handle = nextHandle++;
    scheduled.set(handle, flush);
    return handle;
  },
  (handle) => {
    cancelled.push(handle);
    scheduled.delete(handle);
  },
  3,
);
batcher.enqueue(frame("tab-a", 100));
batcher.enqueue(frame("tab-a", 101));
assert.equal(scheduled.size, 1, "a live burst owns one scheduled renderer commit");
assert.equal(batcher.pendingCount(), 2);
batcher.enqueue(frame("tab-a", 102));
assert.equal(flushed.length, 1, "the queue flushes immediately at its hidden-window bound");
assert.deepEqual(flushed[0]?.map((event) => event.t), [100, 101, 102], "batching preserves event order");
assert.equal(cancelled.length, 1, "threshold flush cancels its pending timer");
batcher.enqueue(frame("tab-b", 103));
const scheduledFlush = [...scheduled.values()][0];
assert(scheduledFlush, "a new partial batch schedules another commit");
scheduledFlush();
assert.deepEqual(flushed[1]?.map((event) => event.t), [103]);
batcher.dispose();
batcher.enqueue(frame("tab-b", 104));
assert.equal(batcher.pendingCount(), 0, "disposed renderer batches cannot update an unmounted app");

const stream = Array.from({ length: 1_000 }, (_, index) => frame(index % 2 ? "tab-a" : "tab-b", index));
let direct: RawEventFrame[] = [];
for (const event of stream) direct = appendBoundedRendererEvents(direct, event, 120, 70);
let coalesced: RawEventFrame[] = [];
for (let index = 0; index < stream.length; index += 64) {
  coalesced = appendBoundedRendererEvents(coalesced, stream.slice(index, index + 64), 120, 70);
}
assert.deepEqual(coalesced, direct, "coalesced commits preserve exact bounded-history semantics");

let highRateCommits = 0;
let highRateHandle = 0;
const highRateBatcher = new RendererEventBatcher<RawEventFrame>(
  () => { highRateCommits += 1; },
  () => { highRateHandle += 1; return highRateHandle; },
  () => undefined,
  128,
);
for (let index = 0; index < 2_048; index += 1) highRateBatcher.enqueue(frame("tab-stream", index));
assert.equal(highRateCommits, 16, "2,048 live frames require only 16 bounded renderer commits");
assert.equal(highRateBatcher.pendingCount(), 0);

console.log("test-bounded-event-store ok");
