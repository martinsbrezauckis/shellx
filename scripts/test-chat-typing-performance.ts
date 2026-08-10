import { readFileSync } from "node:fs";

const app = readFileSync("src/App.tsx", "utf8");
const chatOutput = readFileSync("src/components/ChatOutput.tsx", "utf8");
const eventBatcher = readFileSync("src/lib/renderer-event-batcher.ts", "utf8");
const testSuiteManifest = readFileSync("scripts/test-suite-manifest.mjs", "utf8");
const nativeListenerStart = app.indexOf("const unlisteners: Array<Promise<UnlistenFn>>");
const nativeListenerEnd = app.indexOf("return () => {", nativeListenerStart);
const nativeListener = app.slice(nativeListenerStart, nativeListenerEnd);

let failures = 0;
function assert(cond: boolean, label: string): void {
  console.log(`  ${cond ? "✓" : "✗"} ${label}`);
  if (!cond) failures += 1;
}

console.log("\n=== chat typing performance guards ===");

assert(
  /import\s+\{[^}]*\bmemo\b[^}]*\}\s+from\s+"react"/.test(chatOutput),
  "ChatOutput imports React memo",
);
assert(
  /export\s+const\s+ChatOutput\s*=\s*memo\(/.test(chatOutput),
  "ChatOutput is memoized so unchanged transcripts skip composer keystroke renders",
);
assert(
  /const\s+handlePreviewFile\s*=\s*useCallback\(/.test(app),
  "Preview file callback has stable identity for memoized chat rows",
);
assert(
  /handlePreviewFileImpl\.current\s*=/.test(app),
  "Stable preview callback dispatches through a current implementation ref",
);
assert(
  testSuiteManifest.includes('["tsx","scripts/test-chat-typing-performance.ts"]'),
  "typing performance guard runs in the canonical test suite",
);
assert(
  nativeListenerStart >= 0
    && nativeListenerEnd > nativeListenerStart
    && nativeListener.includes("enqueueLiveEvent(ev);")
    && !nativeListener.includes("setEvents("),
  "native stream frames use the coalesced renderer commit path",
);
assert(
  eventBatcher.includes("this.pending.length >= this.maxBatchSize")
    && eventBatcher.includes("this.pending.splice(0, this.pending.length)"),
  "renderer event batches have a bounded threshold and preserve queued order",
);
assert(
  app.includes("const tail = events.slice(-256);")
    && app.includes("for (let i = 0; i < tail.length; i++)"),
  "completion handling covers a full coalesced batch and processes it in source order",
);

console.log(`\n${failures === 0 ? "PASS" : "FAIL"} chat typing performance guards`);
process.exit(failures === 0 ? 0 : 1);
