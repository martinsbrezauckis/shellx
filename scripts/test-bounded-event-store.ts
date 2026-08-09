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

console.log("test-bounded-event-store ok");
