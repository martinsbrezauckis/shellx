import assert from "node:assert/strict";

import {
  buildAgentOpsTimeline,
  renderAgentOpsTimelineSummary,
  type AgentOpsTimelineInput,
} from "../src/lib/agentops-timeline";

const input: AgentOpsTimelineInput = {
  generatedAt: "2026-06-06T12:00:00.000Z",
  session: {
    tabId: "tab-agentops",
    title: "AgentOps fixture",
    cwd: "/home/user/project",
  },
  activityActions: [
    {
      id: "a1",
      kind: "written",
      path: "/home/user/project/src/App.tsx",
      relativePath: "src/App.tsx",
      name: "App.tsx",
      actor: "agent",
      confidence: "verified",
      source: "hunk_record",
      timestampMs: 1_000,
      linesAdded: 12,
      linesRemoved: 2,
    },
  ],
  previewReceipts: [
    {
      schemaVersion: "shellx.preview.qa.v1",
      generatedAt: "2026-06-06T12:00:02.000Z",
      target: { tabId: "tab-agentops", label: "App preview", cwd: "/home/user/project", url: "http://127.0.0.1:5173/" },
      status: "warn",
      summary: { pass: 7, warn: 1, fail: 0 },
      checks: [
        { id: "screenshot-captured", label: "Screenshot evidence", status: "warn", evidence: ["Chrome not installed"] },
      ],
    },
  ],
};

const timeline = buildAgentOpsTimeline(input);
assert.equal(timeline.schemaVersion, "shellx.agentops.timeline.v1", "timeline has a stable schema");
assert.equal(timeline.session.tabId, "tab-agentops", "timeline carries session identity");
assert.equal(timeline.events.length, 2, "timeline includes activity and preview events");
assert.deepEqual(
  timeline.events.map((event) => event.kind),
  ["file_activity", "preview_qa"],
  "timeline events are ordered by timestamp",
);
assert.equal(timeline.summary.verified, 1, "timeline counts verified events");
assert.equal(timeline.summary.warn, 1, "timeline counts warning events");
assert.equal(timeline.summary.fail, 0, "timeline counts failed events");
assert(
  timeline.events.some((event) => event.title === "Preview QA: App preview" && event.status === "warn"),
  "preview receipt becomes a timeline event",
);

const summary = renderAgentOpsTimelineSummary(timeline);
assert(summary.includes("AgentOps Timeline"), "timeline summary has a title");
assert(summary.includes("Preview QA: App preview"), "timeline summary includes preview event");

console.log("test-agentops-timeline ok");
