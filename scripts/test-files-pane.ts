import { readFileSync } from "node:fs";
import {
  joinFolderPath,
  joinRemoteFolderPath,
  normalizeFolderPath,
  normalizeRemoteFolderPath,
  parentFolderPath,
  parentRemoteFolderPath,
} from "../src/lib/folder-path";

const rightRail = readFileSync("src/components/RightRail.tsx", "utf8");
const filesPane = readFileSync("src/components/FilesPane.tsx", "utf8");
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
assert(
  rightRail.includes('lazy(() => import("./FilesPane")')
    && rightRail.includes("<FilesPane")
    && rightRail.includes("activeTabId={activeTabId ?? null}"),
  "Right rail lazy-loads the extracted Files pane with active-tab scope",
);
assert(filesPane.includes("const [fileQuery, setFileQuery]"), "Files pane stores a current-folder search query");
assert(filesPane.includes("visibleEntries") && filesPane.includes("trimmedFileQuery"), "Files pane filters visible rows by search text");
assert(filesPane.includes("No files match."), "Files pane renders an empty search result state");
assert(filesPane.includes("No session folder."), "Files pane distinguishes no session folder from a pending load");
assert(
  filesPane.includes("Files need the desktop host.")
    && filesPane.includes("cwdFolder && desktopHost && entries === null"),
  "Files pane discloses the desktop boundary instead of loading forever in a plain renderer",
);
assert(filesPane.includes("const [currentFolder, setCurrentFolder]"), "Files pane tracks an absolute current folder");
assert(filesPane.includes("parentFolderPath(currentFolder)"), "Files pane can move above the session cwd");
assert(filesPane.includes("resetFolderToCwd"), "Files pane exposes a reset-to-session-folder action");
assert(!filesPane.includes("const fullPath = subpath ? joinDisplayPath(cwd, subpath) : cwd"), "Files pane is not locked to cwd-relative subpaths");
assert(filesPane.includes("tabId: activeTabId ?? undefined"), "Files pane passes tab id for remote listings");
assert(normalizeFolderPath("C:/Users/Fixture/project/") === "C:\\Users\\Fixture\\project", "Windows folder paths retain native drive syntax");
assert(parentFolderPath("C:\\Users\\Fixture") === "C:\\Users", "Windows folder navigation computes a native parent");
assert(parentFolderPath("C:\\") === null, "Windows drive root has no parent");
assert(joinFolderPath("C:\\Users\\Fixture", "project") === "C:\\Users\\Fixture\\project", "Windows child folders retain native separators");
assert(parentFolderPath("\\\\server\\share") === null, "UNC share root has no parent");
assert(parentFolderPath("\\\\server\\share\\folder") === "\\\\server\\share", "UNC navigation does not escape the share");
assert(normalizeRemoteFolderPath("\\\\wsl.localhost\\Ubuntu-24.04\\home\\fixture") === "/home/fixture", "WSL UNC paths translate to the selected Linux runtime");
assert(normalizeRemoteFolderPath("C:\\Users\\Fixture") === "C:\\Users\\Fixture", "native Windows remote cwd is not rewritten as a POSIX path");
assert(parentRemoteFolderPath("C:\\Users\\Fixture") === "C:\\Users", "remote Windows parent navigation retains its drive");
assert(joinRemoteFolderPath("C:\\Users", "Fixture") === "C:\\Users\\Fixture", "remote Windows child navigation retains its drive");

assert(app.includes("pendingAttachmentsByTab"), "pending composer attachments are keyed by tab");
assert(app.includes("clearPendingAttachmentsForTab(tid)"), "closing a tab clears its unsent pending attachments");
assert(app.includes("const targetTabId = activeTab?.tabId ?? activeTabId ?? null"), "drop/attach pipeline captures the target tab before async work");
assert(app.includes("updatePendingAttachmentsForTab(targetTabId"), "drop/attach pipeline writes pending chips to the target tab only");

console.log(`\n${failures === 0 ? "PASS" : "FAIL"} files pane tests`);
process.exit(failures === 0 ? 0 : 1);
