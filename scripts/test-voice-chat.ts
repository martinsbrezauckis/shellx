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
import { buildVoiceAwarePrompt } from "../src/lib/voice-chat-runtime";
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

function providerEvent(tabId: string, kind: string, text: string | undefined, t: number): RawEventFrame {
  return {
    t,
    kind: "provider-session-event",
    payload: {
      tabId,
      runId: "run-provider-voice",
      providerId: "claude-code",
      kind,
      text,
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

console.log("\n=== voice chat: provider sessions speak text replies ===");
{
  const events: RawEventFrame[] = [
    promptEcho("tab-provider", true),
    providerEvent("tab-provider", "textDelta", "Claude", 1010),
    providerEvent("tab-provider", "textDelta", " reply.", 1020),
    providerEvent("tab-provider", "completed", undefined, 1030),
  ];
  const turn = getVoiceTurnToSpeak(events, "tab-provider", null);
  assert(turn?.text === "Claude reply.", "voice-enabled provider prompt returns provider text deltas");
}

console.log("\n=== voice chat: provider boundary fallback ===");
{
  const events: RawEventFrame[] = [
    providerEvent("tab-provider", "textDelta", "Old provider turn.", 900),
    { t: 1000, kind: "ui", payload: { _meta: { tabId: "tab-provider" }, text: "send boundary" } },
    providerEvent("tab-provider", "text", "New provider voice turn.", 1010),
  ];
  assert(
    extractAssistantTurnAfterIndex(events, "tab-provider", 1) === "New provider voice turn.",
    "fallback extracts provider text after the recorded prompt boundary",
  );
}

console.log("\n=== voice chat: provider tools are not spoken ===");
{
  const events: RawEventFrame[] = [
    promptEcho("tab-provider", true),
    providerEvent("tab-provider", "command", "powershell Get-ChildItem", 1010),
    providerEvent("tab-provider", "mcpTool", "shellx-host-http__send_prompt_to_provider", 1020),
    providerEvent("tab-provider", "raw", "{\"type\":\"debug\"}", 1030),
    providerEvent("tab-provider", "textDelta", "Only final speech.", 1040),
  ];
  assert(
    extractLastAssistantTurn(events, "tab-provider") === "Only final speech.",
    "provider command, MCP, and raw events stay out of TTS text",
  );
}

console.log("\n=== voice chat: prompt shaping remains tab scoped ===");
{
  const priorStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const enabled = new Set(["shellx.voiceChatMode.tab-voice"]);
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem(key: string): string | null {
        return enabled.has(key) ? "1" : null;
      },
    },
  });
  try {
    const voice = buildVoiceAwarePrompt("Explain the result", "tab-voice");
    assert(voice.voiceReplyExpected, "enabled tab records that a spoken reply is expected");
    assert(voice.prompt.startsWith("[voice chat]"), "enabled tab receives the bounded speech instruction");
    assert(voice.prompt.endsWith("Explain the result"), "voice instruction preserves the user prompt exactly");
    const silent = buildVoiceAwarePrompt("Keep text", "tab-text");
    assert(!silent.voiceReplyExpected && silent.prompt === "Keep text", "another tab remains plain text");
  } finally {
    if (priorStorage) Object.defineProperty(globalThis, "localStorage", priorStorage);
    else delete (globalThis as { localStorage?: unknown }).localStorage;
  }
}

console.log(`\n${failures === 0 ? "PASS" : "FAIL"} voice-chat tests`);
process.exit(failures === 0 ? 0 : 1);
