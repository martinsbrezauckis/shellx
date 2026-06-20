import {
  buildReconnectContinuityPrompt,
  buildSessionResumeTranscript,
  loadSessionIdForReconnect,
  reconnectContinuityUiText,
  shouldAddReconnectContinuityNote,
} from "../src/lib/session-continuity";
import type { RawEventFrame } from "../src/types/acp";

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
  console.log(`  ✓ ${message}`);
}

console.log("\n=== session reconnect continuity ===");

assert(
  shouldAddReconnectContinuityNote({
    status: "Idle",
    sessionId: "019e-old",
  }),
  "disconnected tab with an existing session gets a reconnect continuity note",
);

assert(
  loadSessionIdForReconnect({
    status: "Idle",
    sessionId: "019e-old",
  }) === "019e-old",
  "disconnected tab with an existing session loads the same Grok session id",
);

assert(
  !shouldAddReconnectContinuityNote({
    status: "Idle",
    sessionId: null,
  }),
  "never-connected idle tab does not get a reconnect continuity note",
);

assert(
  !shouldAddReconnectContinuityNote({
    status: "Connected",
    sessionId: "019e-live",
  }),
  "connected tab does not get a reconnect continuity note",
);

const prompt = buildReconnectContinuityPrompt("show me how you work with paint", {
  priorSessionId: "019e-old",
  cwd: "C:\\Users\\FixtureUser",
});

assert(prompt.includes("019e-old"), "continuity prompt names the prior session id");
assert(prompt.includes("load its native previous session"), "continuity prompt explains native Grok session resume");
assert(
  prompt.includes("loaded session memory as the primary conversation continuity source"),
  "continuity prompt treats provider-native resume as primary",
);
assert(prompt.includes("Previous session log"), "continuity prompt points to the previous session log");
assert(
  prompt.includes("ask a clarifying question"),
  "continuity prompt tells Grok to clarify ambiguous continuation prompts",
);
assert(
  prompt.includes("Microsoft Paint"),
  "continuity prompt treats Paint as a Windows app before image generation",
);
assert(
  prompt.endsWith("show me how you work with paint"),
  "continuity prompt preserves the exact user prompt at the end",
);

const uiText = reconnectContinuityUiText("019e-old");
assert(uiText.includes("loading previous Grok session"), "UI note says the previous Grok session is loading");
assert(uiText.includes("019e-old"), "UI note includes the prior session id");

function raw(frame: RawEventFrame): string {
  return JSON.stringify(frame);
}

function ui(text: string, t: number): string {
  return raw({
    t,
    kind: "ui",
    payload: { _meta: { tabId: "tab-a" }, text },
  });
}

function message(text: string, t: number, promptId = "p1", chunkId = 1): string {
  return raw({
    t,
    kind: "session-update",
    payload: {
      update: {
        method: "session/update",
        params: {
          _meta: { tabId: "tab-a", promptId, chunkId },
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text },
          },
        },
      },
    },
  });
}

function tool(title: string, status: string, t: number, id: string): string {
  return raw({
    t,
    kind: "session-update",
    payload: {
      update: {
        method: "session/update",
        params: {
          _meta: {
            tabId: "tab-a",
            promptId: `prompt-${id}`,
            updateParams: { status, kind: "Other" },
          },
          update: {
            sessionUpdate: "tool_call",
            toolCallId: id,
            title,
            rawInput: { query: "status" },
          },
        },
      },
    },
  });
}

const transcript = buildSessionResumeTranscript([
  ui("→ connect C:\\Users\\FixtureUser\\paint", 1),
  ui("→ prompt: Fix the Paint clone and keep working from current files.", 2),
  message("I found the toolbar issue and started wiring the brush state.", 3),
  tool("fs_write_text_file", "success", 4, "call-write-1"),
  ui("✗ Build Transport failed", 5),
], { tailLines: 20, maxChars: 5000 });

assert(transcript.text.includes("User: Fix the Paint clone"), "resume transcript includes user prompt echoes");
assert(transcript.text.includes("Assistant: I found the toolbar issue"), "resume transcript includes assistant messages");
assert(transcript.text.includes("Tool: fs_write_text_file [success]"), "resume transcript includes tool summaries");
assert(transcript.text.includes("ShellX error: ✗ Build Transport failed"), "resume transcript keeps actionable errors");
assert(!transcript.text.includes("→ connect"), "resume transcript drops low-signal connect noise");

const loopLines: string[] = [
  ui("→ prompt: Continue the large build", 10),
  message("Entering verification cycle.", 11, "loop", 1),
];
for (let i = 0; i < 6; i += 1) {
  loopLines.push(tool("Reviewer Agent", "success", 20 + i * 2, `review-${i}`));
  loopLines.push(tool("Verifier Agent", "success", 21 + i * 2, `verify-${i}`));
}
loopLines.push(message("I should return to implementation now.", 99, "after-loop", 1));

const compressed = buildSessionResumeTranscript(loopLines, {
  tailLines: 40,
  maxChars: 5000,
  loopThreshold: 3,
});
assert(
  compressed.text.includes("compressed") && compressed.compressedLoopLineCount > 0,
  "resume transcript compresses repeated reviewer/verifier loops",
);
assert(
  compressed.text.includes("Assistant: I should return to implementation now."),
  "resume transcript keeps context after the compressed loop",
);

const promptWithTail = buildReconnectContinuityPrompt("continue", {
  priorSessionId: "019e-old",
  cwd: "C:\\Users\\FixtureUser",
  sessionLogPath: "~/.shellx/sessions/019e-old.jsonl",
  resumeTranscript: compressed,
});
assert(promptWithTail.includes("<previous_session_tail>"), "continuity prompt injects normalized transcript tail");
assert(
  promptWithTail.includes("build scratchboards") && promptWithTail.includes("authoritative"),
  "continuity prompt tells agent current state is authoritative",
);
assert(promptWithTail.endsWith("continue"), "continuity prompt keeps current user prompt at the end");

console.log("\nPASS session reconnect continuity tests");
