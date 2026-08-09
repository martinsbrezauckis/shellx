import {
  newestSessionTitleCandidates,
  titleOverrideForClosingTab,
} from "../src/lib/session-titles";

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
  console.log(`  ✓ ${message}`);
}

console.log("\n=== session title persistence ===");

const override = titleOverrideForClosingTab(
  {
    sessionId: "019e-old",
    title: "Improve ShellX",
    titleLocked: true,
  },
  {},
);

assert(override?.sessionId === "019e-old", "locked renamed tab returns its session id");
assert(override?.title === "Improve ShellX", "locked renamed tab returns its user title");

assert(
  titleOverrideForClosingTab(
    {
      sessionId: "019e-old",
      title: "Improve ShellX",
      titleLocked: false,
    },
    {},
  ) === null,
  "unlocked automatic titles are not persisted as user overrides",
);

assert(
  titleOverrideForClosingTab(
    {
      sessionId: null,
      title: "Unsaved rename",
      titleLocked: true,
    },
    {},
  ) === null,
  "tabs without a session id cannot write a session title override",
);

assert(
  titleOverrideForClosingTab(
    {
      sessionId: "019e-old",
      title: "Improve ShellX",
      titleLocked: true,
    },
    { "019e-old": "Improve ShellX" },
  ) === null,
  "already-persisted title overrides are not rewritten",
);

const titleCandidates = newestSessionTitleCandidates([
  {
    t: 10,
    payload: {
      _meta: { tabId: "tab-grok" },
      method: "_x.ai/session_notification",
      params: { update: { sessionUpdate: "session_summary_generated", session_summary: "Old summary" } },
    },
  },
  {
    t: 20,
    payload: {
      _meta: { tabId: "tab-grok" },
      method: "_x.ai/session_notification",
      params: { update: { sessionUpdate: "session_summary_generated", session_summary: "Current summary" } },
    },
  },
  {
    t: 30,
    payload: {
      _meta: { tabId: "tab-acp" },
      method: "session/update",
      params: { update: { sessionUpdate: "session_info_update", title: "Portable ACP title" } },
    },
  },
]);
assert(
  titleCandidates.get("tab-grok")?.title === "Current summary",
  "newest Grok summary wins for its tab",
);
assert(
  titleCandidates.get("tab-acp")?.title === "Portable ACP title",
  "standard ACP session_info_update supplies live titles",
);
assert(
  newestSessionTitleCandidates([{
    t: 40,
    payload: {
      method: "session/update",
      params: { update: { sessionUpdate: "session_info_update", title: null } },
    },
  }], "fallback-tab").get("fallback-tab")?.title === "new session",
  "standard ACP title clearing restores the neutral session title",
);

console.log("\nPASS session title persistence tests");
