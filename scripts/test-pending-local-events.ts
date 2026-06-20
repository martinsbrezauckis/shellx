/**
 * Regression tests for local UI-event persistence around auto-connect.
 *
 * User prompt echoes are renderer-only `ui` frames. During auto-connect the
 * echo can be emitted before Rust has reported the ACP session id for the
 * tab; those frames must wait and flush later or they disappear after restart.
 */
import { PendingLocalEventQueue, localEventTabId } from "../src/lib/pending-local-events";
import type { RawEventFrame } from "../src/types/acp";

let failures = 0;
function assert(cond: boolean, label: string): void {
  console.log(`  ${cond ? "✓" : "✗"} ${label}`);
  if (!cond) failures += 1;
}

function ui(tabId: string, text: string): RawEventFrame {
  return {
    t: Date.now(),
    kind: "ui",
    payload: { _meta: { tabId }, text },
  };
}

console.log("\n=== pending local events: tab extraction ===");
{
  assert(localEventTabId(ui("tab-a", "hello"), null) === "tab-a", "extracts tab id from ui meta");
  assert(localEventTabId({ t: 1, kind: "ui", payload: "legacy" }, "active") === "active", "falls back to active tab");
}

console.log("\n=== pending local events: flush after session binding ===");
{
  const queue = new PendingLocalEventQueue(5);
  const first = ui("tab-a", "→ prompt: first");
  const second = ui("tab-a", "→ prompt: second");
  queue.enqueue("tab-a", first);
  queue.enqueue("tab-a", second);

  const persisted: RawEventFrame[] = [];
  let hasSession = false;
  let result = await queue.flush("tab-a", async (ev) => {
    if (!hasSession) return false;
    persisted.push(ev);
    return true;
  });
  assert(result.persisted === 0 && result.remaining === 2, "keeps events when no session id exists");

  hasSession = true;
  result = await queue.flush("tab-a", async (ev) => {
    persisted.push(ev);
    return true;
  });
  assert(result.persisted === 2 && result.remaining === 0, "flushes after session id exists");
  assert(persisted[0] === first && persisted[1] === second, "preserves event order");
}

console.log("\n=== pending local events: bounded queue ===");
{
  const queue = new PendingLocalEventQueue(2);
  queue.enqueue("tab-a", ui("tab-a", "one"));
  queue.enqueue("tab-a", ui("tab-a", "two"));
  queue.enqueue("tab-a", ui("tab-a", "three"));
  assert(queue.pendingCount("tab-a") === 2, "caps per-tab queue");
}

console.log(`\n${failures === 0 ? "PASS" : "FAIL"} pending local event tests`);
process.exit(failures === 0 ? 0 : 1);
