import { readFileSync } from "node:fs";

let failures = 0;
function assert(cond: boolean, label: string): void {
  console.log(`  ${cond ? "✓" : "✗"} ${label}`);
  if (!cond) failures += 1;
}

console.log("\n=== debug highlight overlay ===");

const appSource = readFileSync("src/App.tsx", "utf8");
const overlaySource = (() => {
  try {
    return readFileSync("src/components/DebugHighlightOverlay.tsx", "utf8");
  } catch {
    return "";
  }
})();
const cssSource = readFileSync("src/App.css", "utf8");
const bottomPanelSource = readFileSync("src/components/BottomPanel.tsx", "utf8");
const micButtonSource = readFileSync("src/components/MicButton.tsx", "utf8");
const debugApiSource = readFileSync("src-tauri/src/debug_api.rs", "utf8");
const apiDocs = readFileSync("docs/API.md", "utf8");
const surfaceSweep = readFileSync("scripts/test-debug-ui-surfaces.ts", "utf8");

assert(appSource.includes("debugHighlights"), "renderer receives debugHighlights patches");
assert(appSource.includes("<DebugHighlightOverlay"), "renderer mounts the debug highlight overlay");
assert(overlaySource.includes("getBoundingClientRect"), "overlay positions borders from real DOM rectangles");
assert(overlaySource.includes("ResizeObserver"), "overlay remeasures when target layout changes");
assert(overlaySource.includes("MutationObserver"), "overlay remeasures when target visibility changes");
assert(overlaySource.includes("debugHighlightResults"), "overlay reports resolved and missing targets");
assert(overlaySource.includes("measuredHighlightsKey"), "overlay tags measured results with the active highlight request key");
assert(overlaySource.includes("if (measuredHighlightsKey !== highlightsKey) return"), "overlay does not publish stale highlight measurements");
assert(overlaySource.includes("visibleViewportRect"), "overlay clips highlight borders to the visible viewport");
assert(overlaySource.includes("visibleRect"), "overlay reports the visible highlight rectangle");
assert(overlaySource.includes("clipped"), "overlay reports when highlights are clipped");
assert(cssSource.includes(".debug-highlight-overlay-root"), "overlay has dedicated CSS");
assert(bottomPanelSource.includes('data-debug-id="composer-send"'), "composer send button has a stable debug target id");
assert(
  bottomPanelSource.includes('debugId="composer-voice-chat"') && micButtonSource.includes("data-debug-id={debugId}"),
  "voice chat button has a stable debug target id",
);
assert(debugApiSource.includes("debugHighlights"), "debug API accepts debugHighlights UI patches");
assert(debugApiSource.includes("debugHighlightResults"), "debug API stores highlight resolution results");
assert(apiDocs.includes("debugHighlights?"), "API docs document debugHighlights");
assert(apiDocs.includes("visibleRect?"), "API docs document visible highlight rectangles");
assert(apiDocs.includes("clipped?"), "API docs document clipped highlight results");
assert(surfaceSweep.includes("debugHighlights"), "debug UI surface sweep captures highlight overlay");
assert(surfaceSweep.includes("SHELLX_DEBUG_SCREENSHOT_FULL"), "debug UI surface sweep can opt into full-screen screenshot fallback");

if (failures > 0) {
  console.error(`\n${failures} debug highlight check(s) failed.`);
  process.exit(1);
}

console.log("debug highlight overlay checks passed");
