import {
  buildActivityGraph,
  buildActivityTree,
  combineActivityTraces,
  filterActivityActions,
  parseGrokUpdatesJsonl,
  parseHunkRecordsJsonl,
  summarizeActivity,
} from "../src/lib/session-activity";
import { readFileSync } from "node:fs";
import { readRustModuleFamily } from "./read-rust-module-family";

let failures = 0;
function assert(cond: boolean, label: string): void {
  console.log(`  ${cond ? "✓" : "✗"} ${label}`);
  if (!cond) failures += 1;
}

console.log("\n=== session activity trace ===");

const jsonl = [
  JSON.stringify({
    hunkId: "h1",
    filePath: "/home/user/project/src/App.tsx",
    hunkStart: 10,
    hunkEnd: 24,
    linesAdded: 12,
    linesRemoved: 2,
    authorType: "agent",
    authorId: "agent-1",
    agentId: "agent-1",
    sessionId: "s1",
    timestamp: "2026-05-24T00:34:36.622900542Z",
    promptIndex: 3,
    sourceType: "agentEdit",
    eventType: "added",
  }),
  "{not json",
  JSON.stringify({
    hunkId: "h2",
    filePath: "/home/user/project/docs/notes.md",
    hunkStart: 1,
    hunkEnd: 3,
    linesAdded: 0,
    linesRemoved: 3,
    authorType: "human",
    sessionId: "s1",
    timestamp: "2026-05-24T00:35:01.000Z",
    promptIndex: 3,
    sourceType: "external",
    eventType: "deleted",
  }),
].join("\n");

const trace = parseHunkRecordsJsonl(jsonl, {
  rootPath: "/home/user/project",
  sourcePath: "/home/user/.grok/sessions/%2Fhome%2Fuser%2Fproject/s1/hunk_records.jsonl",
});

assert(trace.actions.length === 2, "skips invalid JSON lines and keeps valid hunk records");
assert(trace.actions[0]?.kind === "written", "maps agent hunks to written activity");
assert(trace.actions[0]?.confidence === "verified", "agentEdit hunks are verified");
assert(trace.actions[0]?.actor === "agent", "keeps agent actor");
assert(trace.actions[1]?.kind === "deleted", "maps deleted hunks to delete activity");
assert(trace.actions[1]?.actor === "human", "keeps external human actor");
assert(trace.source.readable === true, "marks readable hunk source");
assert(trace.source.recordsRead === 2, "counts parsed records");
assert(trace.source.recordsSkipped === 1, "counts skipped records");

const summary = summarizeActivity(trace.actions);
assert(summary.agentWritten === 1, "summarizes agent writes");
assert(summary.humanDeleted === 1, "summarizes human deletes separately");
assert(summary.verified === 1, "summarizes verified records");

const tree = buildActivityTree(trace.actions, "/home/user/project");
const src = tree.children.find((node) => node.name === "src");
const app = src?.children.find((node) => node.name === "App.tsx");
assert(src?.counts.written === 1, "aggregates write count to parent folder");
assert(app?.counts.written === 1, "stores write count on file node");
assert(app?.actions[0]?.relativePath === "src/App.tsx", "computes relative path from root");

const updatesJsonl = [
  JSON.stringify({
    timestamp: 1779582876,
    method: "session/update",
    params: {
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "read-1",
        title: "read_file",
        rawInput: { target_file: "src/App.tsx" },
      },
    },
  }),
  JSON.stringify({
    timestamp: 1779582877,
    method: "session/update",
    params: {
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "list-1",
        title: "List `src`",
        rawInput: { variant: "ListDir", target_directory: "src" },
      },
    },
  }),
  JSON.stringify({
    timestamp: 1779582878,
    method: "session/update",
    params: {
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "grep-1",
        title: "grep",
        rawInput: { pattern: "Activity", path: "src" },
      },
    },
  }),
  JSON.stringify({
    timestamp: 1779582879,
    method: "session/update",
    params: {
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "bash-1",
        title: "Execute `sed -n '1,20p' src/lib/session-activity.ts`",
        rawInput: {
          variant: "Bash",
          command: "sed -n '1,20p' src/lib/session-activity.ts",
          is_background: false,
        },
      },
    },
  }),
  JSON.stringify({
    timestamp: 17795828795,
    method: "session/update",
    params: {
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "git-1",
        title: "Execute `git commit -m trace-evidence`",
        rawInput: {
          variant: "Bash",
          command: "git commit -m trace-evidence",
          is_background: false,
        },
      },
    },
  }),
  JSON.stringify({
    timestamp: 17795828796,
    method: "session/update",
    params: {
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "git-redir",
        title: "Execute `git rev-parse --show-toplevel 2>/dev/null; git status --short`",
        rawInput: {
          variant: "Bash",
          command: "git rev-parse --show-toplevel 2>/dev/null; git status --short",
          is_background: false,
        },
      },
    },
  }),
  JSON.stringify({
    timestamp: 1779582876,
    method: "session/update",
    params: {
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "write-dupe",
        title: "Write `src/App.tsx`",
        rawInput: { variant: "Write", filePath: "src/App.tsx" },
      },
    },
  }),
  JSON.stringify({
    timestamp: 1779582880,
    method: "session/update",
    params: {
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "img-1",
        title: "image_gen",
        status: "completed",
        rawOutput: {
          type: "Text",
          text: "Image generated and saved to \\\\?\\C:\\Users\\FixtureUser\\.grok\\sessions\\C%3A%5CUsers%5CFixtureUser\\sid\\images\\1.jpg.",
        },
      },
    },
  }),
  JSON.stringify({
    timestamp: 1779582881,
    method: "session/update",
    params: {
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "vid-1",
        title: "video_gen",
        status: "completed",
        rawOutput: {
          type: "Text",
          text: "Video generated and saved to \\\\?\\C:\\Users\\FixtureUser\\.grok\\sessions\\C%3A%5CUsers%5CFixtureUser\\sid\\videos\\1.mp4.",
        },
      },
    },
  }),
  JSON.stringify({
    timestamp: 1779582882,
    method: "session/update",
    params: {
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "img-wsl",
        title: "image_gen",
        status: "completed",
        rawOutput: {
          type: "Text",
          text: "Image generated and saved to /home/user/.grok/sessions/%2Fhome%2Fuser%2Fproject/sid/images/1.jpg.",
        },
      },
    },
  }),
  JSON.stringify({
    timestamp: 1779582883,
    method: "session/update",
    params: {
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "vid-ssh",
        title: "video_gen",
        status: "completed",
        rawOutput: {
          type: "Text",
          text: "Video generated and saved to /home/deploy/.grok/sessions/%2Fsrv%2Fapp/sid/videos/1.mp4.",
        },
      },
    },
  }),
  JSON.stringify({
    timestamp: 1779582884,
    method: "session/update",
    params: {
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "tool-inventory",
        title: "search_tool",
        status: "completed",
        rawOutput: {
          type: "Text",
          text: "Tool docs: Path must end in .png/.jpg/.jpeg/.webp/.gif/.bmp before reading arbitrary non-image files.",
        },
      },
    },
  }),
].join("\n");

const updateTrace = parseGrokUpdatesJsonl(updatesJsonl, {
  rootPath: "/home/user/project",
  sourcePath: "/home/user/.grok/sessions/project/s1/updates.jsonl",
});
assert(updateTrace.actions.length === 11, "parses path-bearing tool updates");
assert(updateTrace.actions.some((a) => a.kind === "read" && a.relativePath === "src/App.tsx"), "parses ReadFile as read");
assert(updateTrace.actions.some((a) => a.kind === "listed" && a.relativePath === "src"), "parses ListDir as listed");
assert(updateTrace.actions.some((a) => a.kind === "searched" && a.relativePath === "src"), "parses Grep as searched");
assert(updateTrace.actions.some((a) => a.kind === "read" && a.confidence === "inferred" && a.relativePath === "src/lib/session-activity.ts"), "infers sed command reads");
assert(updateTrace.actions.some((a) => a.kind === "git" && a.command === "git commit -m trace-evidence"), "separates git commands from generic terminal activity");
assert(updateTrace.actions.some((a) => a.kind === "git" && a.command === "git rev-parse --show-toplevel 2>/dev/null; git status --short" && a.relativePath === ""), "keeps redirection-only git probes anchored to the repo");
assert(!updateTrace.actions.some((a) => a.relativePath.includes("2>/dev/null")), "does not treat shell redirections as file paths");
assert(updateTrace.actions.some((a) => a.kind === "created" && a.path === "C:\\Users\\FixtureUser\\.grok\\sessions\\C%3A%5CUsers%5CFixtureUser\\sid\\images\\1.jpg"), "parses generated image output as created file trace without decoding Grok cwd segment");
assert(updateTrace.actions.some((a) => a.kind === "created" && a.path === "C:\\Users\\FixtureUser\\.grok\\sessions\\C%3A%5CUsers%5CFixtureUser\\sid\\videos\\1.mp4"), "parses generated video output as created file trace without decoding Grok cwd segment");
assert(updateTrace.actions.some((a) => a.kind === "created" && a.path === "/home/user/.grok/sessions/%2Fhome%2Fuser%2Fproject/sid/images/1.jpg"), "parses WSL generated image output as created file trace");
assert(updateTrace.actions.some((a) => a.kind === "created" && a.path === "/home/deploy/.grok/sessions/%2Fsrv%2Fapp/sid/videos/1.mp4"), "parses SSH generated video output as created file trace");
assert(!updateTrace.actions.some((a) => a.kind === "created" && a.relativePath.includes(".jpg/.jpeg")), "does not treat tool inventory extension lists as generated media");

const combined = combineActivityTraces([trace, updateTrace]);
assert(
  combined.actions.filter((a) => a.kind === "written" && a.relativePath === "src/App.tsx").length === 1,
  "verified hunk write suppresses duplicate observed write",
);
assert(combined.actions.some((a) => a.source === "grok_update" && a.kind === "read"), "combined trace keeps update reads");

const graph = buildActivityGraph(combined.actions, "/home/user/project", { maxTargetNodes: 10 });
assert(graph.nodes.some((node) => node.kind === "session" && node.label === "project"), "activity graph includes session root");
assert(graph.nodes.some((node) => node.kind === "action" && node.actionKind === "written"), "activity graph includes write action node");
assert(graph.nodes.some((node) => node.kind === "action" && node.actionKind === "read"), "activity graph includes read action node");
assert(graph.nodes.some((node) => node.kind === "folder" && node.relativePath === "src"), "activity graph includes folder nodes");
assert(graph.nodes.some((node) => node.kind === "file" && node.relativePath === "src/App.tsx"), "activity graph includes file nodes");
assert(
  graph.edges.some((edge) => edge.from === "action:written" && edge.to === "folder:src" && edge.count === 1),
  "activity graph connects action kinds to folders with weighted edges",
);
assert(
  graph.edges.some((edge) => edge.from === "folder:src" && edge.to === "file:src/App.tsx" && edge.count >= 1),
  "activity graph connects folders to files with weighted edges",
);
assert(graph.hiddenTargetCount === 0, "activity graph reports no hidden targets when under cap");

const manyActions = Array.from({ length: 7 }, (_, i) => ({
  ...combined.actions[0]!,
  id: `many-${i}`,
  path: `/home/user/project/src/file-${i}.ts`,
  relativePath: `src/file-${i}.ts`,
  name: `file-${i}.ts`,
}));
const cappedGraph = buildActivityGraph(manyActions, "/home/user/project", { maxTargetNodes: 3 });
assert(cappedGraph.nodes.filter((node) => node.kind === "file").length === 3, "activity graph caps file nodes");
assert(cappedGraph.hiddenTargetCount === 4, "activity graph reports hidden target overflow");

const searchByPath = filterActivityActions(combined.actions, "src app");
assert(searchByPath.every((action) => action.relativePath.toLowerCase().includes("src/app")), "activity search matches path tokens");
assert(searchByPath.length >= 2, "activity search keeps all matching path evidence");
const searchByCommand = filterActivityActions(combined.actions, "git commit");
assert(searchByCommand.length === 1 && searchByCommand[0]?.kind === "git", "activity search matches command text");
const searchByQuery = filterActivityActions(combined.actions, "query activity");
assert(searchByQuery.length === 1 && searchByQuery[0]?.kind === "searched", "activity search matches search query text");
assert(filterActivityActions(combined.actions, "not-present-in-trace").length === 0, "activity search can produce an empty filtered trace");
assert(filterActivityActions(combined.actions, "  ").length === combined.actions.length, "blank activity search keeps the full trace");

const activityModalSource = readFileSync(new URL("../src/components/ActivityBrowserModal.tsx", import.meta.url), "utf8");
const appCssSource = readFileSync(new URL("../src/App.css", import.meta.url), "utf8");
const appSource = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
const debugApiSource = readRustModuleFamily("src-tauri/src/debug_api.rs");
const debugApiDocs = readFileSync(new URL("../docs/public/API.md", import.meta.url), "utf8");
assert(activityModalSource.includes("activity-modal-resize-handle"), "activity browser exposes a modal resize handle");
assert(activityModalSource.includes("activity-graph-detail-resizer"), "activity graph exposes a detail panel resize handle");
assert(activityModalSource.includes('className="preview-actions activity-actions"'), "activity footer has trace-specific action styling");
assert(!/<div className="preview-actions activity-actions">[\s\S]*?onClick=\{onClose\}[\s\S]*?Close[\s\S]*?<\/div>/.test(activityModalSource), "activity footer does not put a Close button next to the resize handle");
assert(activityModalSource.includes("target.setPointerCapture(event.pointerId)"), "activity modal resize captures the pointer during drag");
assert(activityModalSource.includes("target.releasePointerCapture(event.pointerId)"), "activity modal resize releases pointer capture after drag");
assert(activityModalSource.includes("suppressBackdropClickRef"), "activity modal resize suppresses the synthetic backdrop click after drag");
assert(activityModalSource.includes("onClick={handleBackdropClick}"), "activity backdrop uses resize-aware close handling");
assert(activityModalSource.includes('data-debug-id="activity-tab-files"'), "activity browser Files tab has a stable debug selector");
assert(activityModalSource.includes('data-debug-id="activity-tab-graph"'), "activity browser Graph tab has a stable debug selector");
assert(activityModalSource.includes('data-debug-id="activity-tab-evidence"'), "activity browser Evidence tab has a stable debug selector");
assert(activityModalSource.includes('data-debug-id="activity-tab-timeline"'), "activity browser Timeline tab has a stable debug selector");
assert(activityModalSource.includes('data-debug-id="activity-tab-summary"'), "activity browser Summary tab has a stable debug selector");
assert(activityModalSource.includes('role="tab"') && activityModalSource.includes('aria-controls="activity-panel-files"'), "activity view buttons expose tab ownership semantics");
assert(activityModalSource.includes('role="tabpanel"') && activityModalSource.includes('aria-labelledby={`activity-tab-${view}`}'), "activity body exposes the selected tabpanel owner");
assert(activityModalSource.includes("ArrowRight") && activityModalSource.includes("ArrowLeft") && activityModalSource.includes("document.getElementById(`activity-tab-${next}`)?.focus()"), "activity tabs support roving keyboard navigation");
assert(activityModalSource.includes('data-debug-id="activity-search"'), "activity browser search has a stable debug selector");
assert(activityModalSource.includes("filterActivityActions"), "activity browser filters the condensed trace data");
assert(activityModalSource.includes("ActivityEvidenceView"), "activity browser exposes a readable evidence view");
assert(activityModalSource.includes("activity-evidence-section-reads"), "activity evidence view separates reads and searches");
assert(activityModalSource.includes("activity-evidence-section-git"), "activity evidence view separates git evidence");
assert(activityModalSource.includes("activity-evidence-column-resizer"), "activity evidence view exposes a column resize handle");
assert(activityModalSource.includes("activity-evidence-row-resizer"), "activity evidence view exposes a row resize handle");
assert(activityModalSource.includes("activity-evidence-section-expand"), "activity evidence sections can be brought forward");
assert(activityModalSource.includes("activity-graph-legend"), "activity graph includes a compact confidence legend");
assert(activityModalSource.includes("graphNodeIconName"), "activity graph nodes use explicit icons for kind/action");
assert(activityModalSource.includes('preserveAspectRatio="none"'), "activity graph edges scale to the same canvas coordinates as nodes");
assert(activityModalSource.includes("handleNodePointerMove"), "activity graph nodes can be repositioned with pointer drag");
assert(activityModalSource.includes("handleNodeKeyDown") && activityModalSource.includes('event.key === "ArrowDown"'), "activity graph nodes can be repositioned with keyboard arrows");
assert(activityModalSource.includes('data-shellx-release-observe="pressed focused"') && activityModalSource.includes("aria-pressed={selected?.id === node.id}"), "activity graph nodes expose accessible selection and focus state");
assert(activityModalSource.includes('data-shellx-release-observe="expanded disabled"') && activityModalSource.includes("aria-expanded={canExpand ? isOpen : undefined}"), "activity tree twist controls expose accessible disclosure state");
assert(appCssSource.includes(".activity-modal-resize-handle"), "activity browser resize handle is styled");
assert(appCssSource.includes(".activity-graph-detail-resizer"), "activity graph detail resize handle is styled");
assert(appCssSource.includes(".activity-graph-node-icon"), "activity graph node icons are styled");
assert(appCssSource.includes(".activity-graph-node-file::after"), "activity graph file nodes have a distinct file shape");
assert(appCssSource.includes(".activity-graph-node-folder .activity-graph-node-icon"), "activity graph folder nodes have a distinct icon treatment");
assert(appCssSource.includes(".activity-search"), "activity browser search is styled");
assert(appCssSource.includes(".activity-evidence-grid"), "activity evidence panels are styled");
assert(appCssSource.includes(".activity-evidence-column-resizer"), "activity evidence resize handles are styled");
assert(appCssSource.includes(".activity-evidence-grid-focused"), "activity evidence focused panel layout is styled");
assert(appCssSource.includes(".activity-actions .pact:last-child"), "activity footer does not auto-push the last action into the resize corner");
assert(appSource.includes("runDebugDragSelector"), "debug UI can synthesize pointer drags for graph/resize QA");
assert(appSource.includes("\"debugDrag\""), "debug drag command is relayed as a transient UI patch");
assert(debugApiSource.includes("debugDrag"), "debug API accepts debugDrag UI patches");
assert(debugApiDocs.includes("debugDrag?"), "debug API docs document debugDrag");
assert(debugApiDocs.includes("report: {"), "debug API docs document the derived activity report");
assert(debugApiDocs.includes("git: ActivityReportItem[]"), "debug API docs document the git activity report");
assert(debugApiDocs.includes("[data-debug-id='activity-search']"), "debug API docs document Activity Browser search");

console.log(`\n${failures === 0 ? "PASS" : "FAIL"} session activity tests`);
process.exit(failures === 0 ? 0 : 1);
