import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  browserCoworkEventTabId,
  buildBrowserCoworkMessages,
  normalizeBrowserCoworkUiState,
  selectBrowserCoworkSession,
} from "../src/browser/browserCowork";
import {
  normalizeBrowserCoworkPromptEvent,
  normalizeBrowserCoworkPromptNotification,
} from "../src/lib/browser-cowork-events";
import type { BrowserTask } from "../src/browser/types";
import type { RawEventFrame } from "../src/types/acp";

const uiState = normalizeBrowserCoworkUiState({
  activeTabId: "tab-active",
  openTabs: [
    { tabId: "tab-active", title: "Active", agentId: "grok", status: "Connected" },
    { tabId: "tab-owner", title: "Owner", agentId: "codex-cli", status: "Connected" },
  ],
});
const rustCoworkSource = readFileSync("src-tauri/src/shellx_browser_cowork.rs", "utf8");
const mainBridgeSource = readFileSync("src/lib/use-browser-cowork-bridge.ts", "utf8");
const browserHookSource = readFileSync("src/browser/hooks/useBrowserCowork.ts", "utf8");
assert(rustCoworkSource.includes("insert_pending_cowork_prompt(event)"));
assert(rustCoworkSource.includes(".remove(request_id)"));
assert(rustCoworkSource.includes("BrowserCoworkPromptNotification"));
assert(rustCoworkSource.includes("require_cowork_window(window.label(), BROWSER_WINDOW_LABEL"));
assert(rustCoworkSource.includes("shellx_browser_replay_cowork_prompt_notifications"));
assert(mainBridgeSource.includes("dispatchTail = dispatchTail"), "main bridge serializes queued cowork prompts");
assert(browserHookSource.includes("pendingDispatchTargetRef"), "Browser blocks duplicate sends until dispatch acknowledgement");
const task: BrowserTask = {
  taskId: "task-1",
  profileId: "agent",
  ownerActorId: "operator",
  ownerSurface: "browser",
  ownerSessionId: "tab-owner",
  goal: "Check the current page",
  status: "running",
  autonomy: "assistedAutonomous",
  currentUrl: "https://example.com",
  createdAtMs: 1_000,
  updatedAtMs: 1_100,
};

assert.deepEqual(normalizeBrowserCoworkPromptNotification({ requestId: "claim-1", prompt: "ignored" }), { requestId: "claim-1" });
assert.equal(normalizeBrowserCoworkPromptNotification({ prompt: "forged" }), null);
assert.equal(normalizeBrowserCoworkPromptEvent({ requestId: "claim-1" }), null, "a notification cannot substitute prompt text");

assert.equal(selectBrowserCoworkSession(uiState, null)?.tabId, "tab-active");
const ownerSession = selectBrowserCoworkSession(uiState, task);
assert.equal(ownerSession?.tabId, "tab-owner", "task owner session takes precedence over active tab");
assert.equal(ownerSession?.agentLabel, "Codex");
assert.equal(
  selectBrowserCoworkSession(normalizeBrowserCoworkUiState({ activeTabId: "tab-x", openTabs: [{ tabId: "tab-x", title: "No agent" }] }), null),
  null,
  "coworking requires a real ShellX agent selection",
);

const grokMessage = (tabId: string, text: string, t: number): RawEventFrame => ({
  t,
  kind: "grok-acp-event",
  payload: {
    method: "session/update",
    params: {
      _meta: { tabId, promptId: "prompt-1", chunkId: t },
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
    },
  },
});
const providerEvents: RawEventFrame[] = [
  { t: 900, kind: "provider-session-event", payload: { tabId: "tab-owner", runId: "old", providerId: "codex-cli", kind: "text", text: "stale" } },
  { t: 1_200, kind: "provider-session-event", payload: { tabId: "tab-other", runId: "other", providerId: "codex-cli", kind: "text", text: "wrong tab" } },
  { t: 1_300, kind: "provider-session-event", payload: { tabId: "tab-owner", runId: "run-1", providerId: "codex-cli", kind: "textDelta", text: "Actual " } },
  { t: 1_301, kind: "provider-session-event", payload: { tabId: "tab-owner", runId: "run-1", providerId: "codex-cli", kind: "textDelta", text: "answer" } },
  { t: 1_400, kind: "provider-session-event", payload: { tabId: "tab-owner", runId: "run-1", providerId: "codex-cli", kind: "command", text: "browser_check" } },
];
const messages = buildBrowserCoworkMessages(providerEvents, task, [{
  id: "follow-up",
  taskId: task.taskId,
  text: "Check one more thing",
  t: 1_250,
}], ownerSession);

assert(messages.some((message) => message.role === "assistant" && message.text === "Actual answer"));
assert(messages.some((message) => message.role === "tool" && message.text.includes("browser_check")));
assert(messages.some((message) => message.role === "user" && message.text === "Check one more thing"));
assert(!messages.some((message) => message.text.includes("stale") || message.text.includes("wrong tab")));
assert(!messages.some((message) => message.text.startsWith("Task is ")), "chat does not synthesize agent status replies");

const grok = grokMessage("tab-grok", "Visible Grok answer", 1_500);
assert.equal(browserCoworkEventTabId(grok), "tab-grok");
assert.equal(browserCoworkEventTabId(providerEvents[2]!), "tab-owner");
const grokTask = { ...task, ownerSessionId: "tab-grok" };
const grokSession = selectBrowserCoworkSession(normalizeBrowserCoworkUiState({
  activeTabId: "tab-grok",
  openTabs: [{ tabId: "tab-grok", title: "Grok", agentId: "grok" }],
}), grokTask);
assert(buildBrowserCoworkMessages([grok], grokTask, [], grokSession).some((message) => message.text === "Visible Grok answer"));

console.log("ShellX Browser cowork tests passed");
