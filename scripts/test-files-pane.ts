import { readFileSync } from "node:fs";

const rightRail = readFileSync("src/components/RightRail.tsx", "utf8");
const css = readFileSync("src/App.css", "utf8");
const app = readFileSync("src/App.tsx", "utf8");

let failures = 0;
function assert(cond: boolean, label: string): void {
  console.log(`  ${cond ? "✓" : "✗"} ${label}`);
  if (!cond) failures += 1;
}

function cssRule(selector: string): string {
  const match = selector === ".fv-head"
    ? /\.fv-head\s*\{([\s\S]*?)\}/m.exec(css)
    : selector === ".fv-search"
      ? /\.fv-search\s*\{([\s\S]*?)\}/m.exec(css)
      : undefined;
  return match?.[1] ?? "";
}

console.log("\n=== files pane search and tab-scoped attachments ===");

const headRule = cssRule(".fv-head");
assert(headRule.includes("position: sticky"), "Files header stays pinned while file rows scroll");
assert(headRule.includes("top: 0"), "Files header sticks to the top of the files pane");
assert(cssRule(".fv-search").includes("display: inline-flex"), "Files header has an inline search control");
assert(rightRail.includes("const [fileQuery, setFileQuery]"), "Files pane stores a current-folder search query");
assert(rightRail.includes("visibleEntries") && rightRail.includes("trimmedFileQuery"), "Files pane filters visible rows by search text");
assert(rightRail.includes("No files match."), "Files pane renders an empty search result state");
assert(rightRail.includes("const [currentFolder, setCurrentFolder]"), "Files pane tracks an absolute current folder");
assert(rightRail.includes("parentFolderPath(currentFolder)"), "Files pane can move above the session cwd");
assert(rightRail.includes("resetFolderToCwd"), "Files pane exposes a reset-to-session-folder action");
assert(!rightRail.includes("const fullPath = subpath ? joinDisplayPath(cwd, subpath) : cwd"), "Files pane is not locked to cwd-relative subpaths");
assert(rightRail.includes("tabId: activeTabId ?? undefined"), "Files pane passes tab id for remote listings");

assert(app.includes("pendingAttachmentsByTab"), "pending composer attachments are keyed by tab");
assert(app.includes("clearPendingAttachmentsForTab(tid)"), "closing a tab clears its unsent pending attachments");
assert(app.includes("const targetTabId = activeTab?.tabId ?? activeTabId ?? null"), "drop/attach pipeline captures the target tab before async work");
assert(app.includes("updatePendingAttachmentsForTab(targetTabId"), "drop/attach pipeline writes pending chips to the target tab only");

console.log(`\n${failures === 0 ? "PASS" : "FAIL"} files pane tests`);
process.exit(failures === 0 ? 0 : 1);
