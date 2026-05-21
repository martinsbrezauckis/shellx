/**
 * Regression tests for voice-chat turn selection.
 *
 * These are plain tsx tests like the other script-level checks. The
 * important contract: once a prompt was sent with voiceReplyExpected,
 * completion-time playback is tied to that prompt event. It must not
 * silently depend on a later localStorage read, because that is how a
 * voice-prefixed Grok reply can arrive as text only.
 */
import {
  extractAssistantTurnAfterIndex,
  extractLastAssistantTurn,
  getVoiceTurnToSpeak,
} from "../src/lib/voice-chat";
import type { RawEventFrame } from "../src/types/acp";

let failures = 0;
function assert(cond: boolean, label: string): void {
  console.log(`  ${cond ? "✓" : "✗"} ${label}`);
  if (!cond) failures += 1;
}

function promptEcho(tabId: string, voiceReplyExpected: boolean, text = "hello"): RawEventFrame {
  return {
    t: 1000,
    kind: "ui",
    payload: {
      _meta: { tabId, voiceReplyExpected },
      text: `→ prompt: ${text}`,
    },
  };
}

function assistantChunk(tabId: string, text: string, t: number): RawEventFrame {
  return {
    t,
    kind: "grok-acp-event",
    payload: {
      _meta: { tabId },
      method: "session/update",
      params: {
        _meta: { tabId },
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text },
        },
      },
    },
  };
}

console.log("\n=== voice chat: prompt-scoped playback gate ===");
{
  const events: RawEventFrame[] = [
    promptEcho("tab-a", true),
    assistantChunk("tab-a", "Hello", 1010),
    assistantChunk("tab-a", " there.", 1020),
  ];
  const turn = getVoiceTurnToSpeak(events, "tab-a", null);
  assert(turn?.text === "Hello there.", "voice-enabled prompt returns assistant text");
  assert(turn?.turnKey === "tab-a::0", "turn key uses the prompt echo index");
}

console.log("\n=== voice chat: non-voice prompt stays silent ===");
{
  const events: RawEventFrame[] = [
    promptEcho("tab-a", false),
    assistantChunk("tab-a", "Text only.", 1010),
  ];
  const turn = getVoiceTurnToSpeak(events, "tab-a", null);
  assert(turn === null, "non-voice prompt does not trigger TTS");
}

console.log("\n=== voice chat: tab isolation and markdown cleanup ===");
{
  const events: RawEventFrame[] = [
    promptEcho("tab-a", true),
    assistantChunk("tab-b", "Wrong tab.", 1010),
    assistantChunk("tab-a", "Use `code` and [link](https://example.com).", 1020),
  ];
  assert(
    extractLastAssistantTurn(events, "tab-a") === "Use code and link.",
    "extractor keeps only matching tab and strips speech-hostile markdown",
  );
}

console.log("\n=== voice chat: explicit send boundary fallback ===");
{
  const events: RawEventFrame[] = [
    assistantChunk("tab-a", "Old turn.", 900),
    { t: 1000, kind: "ui", payload: { _meta: { tabId: "tab-a" }, text: "local marker without voice flag" } },
    assistantChunk("tab-a", "New", 1010),
    assistantChunk("tab-a", " voice turn.", 1020),
  ];
  assert(
    extractAssistantTurnAfterIndex(events, "tab-a", 1) === "New voice turn.",
    "fallback extracts only chunks after the recorded prompt boundary",
  );
}

console.log(`\n${failures === 0 ? "PASS" : "FAIL"} voice-chat tests`);
process.exit(failures === 0 ? 0 : 1);
