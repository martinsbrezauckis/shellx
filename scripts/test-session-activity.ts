import {
  buildActivityGraph,
  buildActivityTree,
  combineActivityTraces,
  parseGrokUpdatesJsonl,
  parseHunkRecordsJsonl,
  summarizeActivity,
} from "../src/lib/session-activity";

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
          text: "Image generated and saved to \\\\?\\C:\\Users\\User\\.grok\\sessions\\C%3A%5CUsers%5CUser\\sid\\images\\1.jpg.",
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
          text: "Video generated and saved to \\\\?\\C:\\Users\\User\\.grok\\sessions\\C%3A%5CUsers%5CUser\\sid\\videos\\1.mp4.",
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
assert(updateTrace.actions.length === 9, "parses path-bearing tool updates");
assert(updateTrace.actions.some((a) => a.kind === "read" && a.relativePath === "src/App.tsx"), "parses ReadFile as read");
assert(updateTrace.actions.some((a) => a.kind === "listed" && a.relativePath === "src"), "parses ListDir as listed");
assert(updateTrace.actions.some((a) => a.kind === "searched" && a.relativePath === "src"), "parses Grep as searched");
assert(updateTrace.actions.some((a) => a.kind === "read" && a.confidence === "inferred" && a.relativePath === "src/lib/session-activity.ts"), "infers sed command reads");
assert(updateTrace.actions.some((a) => a.kind === "created" && a.path === "C:\\Users\\User\\.grok\\sessions\\C%3A%5CUsers%5CUser\\sid\\images\\1.jpg"), "parses generated image output as created file trace without decoding Grok cwd segment");
assert(updateTrace.actions.some((a) => a.kind === "created" && a.path === "C:\\Users\\User\\.grok\\sessions\\C%3A%5CUsers%5CUser\\sid\\videos\\1.mp4"), "parses generated video output as created file trace without decoding Grok cwd segment");
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

console.log(`\n${failures === 0 ? "PASS" : "FAIL"} session activity tests`);
process.exit(failures === 0 ? 0 : 1);
