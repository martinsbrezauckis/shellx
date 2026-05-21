import type { RawEventFrame } from "../types/acp";

export interface VoiceTurnToSpeak {
  turnKey: string;
  text: string;
}

function eventTabId(ev: RawEventFrame): string | null {
  const payload: any = ev.payload;
  return payload?._meta?.tabId ?? payload?.params?._meta?.tabId ?? null;
}

function promptMeta(ev: RawEventFrame): any {
  const payload: any = ev.payload;
  return payload?._meta ?? null;
}

function isPromptEcho(ev: RawEventFrame, tabId: string | null): boolean {
  const payload: any = ev.payload;
  return ev.kind === "ui" &&
    typeof payload?.text === "string" &&
    payload.text.startsWith("→ prompt:") &&
    eventTabId(ev) === tabId;
}

function latestPromptEchoIndex(events: RawEventFrame[], tabId: string | null): number {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev && isPromptEcho(ev, tabId)) return i;
  }
  return -1;
}

/**
 * Pull the assistant turn's plain text from the event stream. Walks
 * back to the latest prompt marker for this tab, aggregates every
 * agent_message_chunk since then, strips speech-hostile markdown, and
 * returns an empty string when nothing usable exists.
 */
export function extractLastAssistantTurn(events: RawEventFrame[], tabId: string | null): string {
  return sanitizeSpokenText(collectAssistantChunks(events, tabId, 0, true));
}

/**
 * Pull assistant text that arrived after a known prompt-send boundary.
 * This is the robust voice-chat path: the send handler records the
 * event count before dispatching the prompt, so completion-time TTS no
 * longer depends on a local "→ prompt:" echo being present in events[].
 */
export function extractAssistantTurnAfterIndex(
  events: RawEventFrame[],
  tabId: string | null,
  startIndex: number,
): string {
  return sanitizeSpokenText(collectAssistantChunks(
    events,
    tabId,
    Math.max(0, startIndex + 1),
    false,
  ));
}

function collectAssistantChunks(
  events: RawEventFrame[],
  tabId: string | null,
  startIndex: number,
  stopAtPromptEcho: boolean,
): string {
  if (events.length === 0) return "";
  const chunks: string[] = [];
  for (let i = events.length - 1; i >= startIndex; i--) {
    const e = events[i];
    if (!e) continue;
    if (stopAtPromptEcho && isPromptEcho(e, tabId)) break;

    if (e.kind !== "grok-acp-event") continue;
    const taggedTab = eventTabId(e);
    if (taggedTab && taggedTab !== tabId) continue;
    const payload: any = e.payload;
    if (payload?.method !== "session/update") continue;
    const upd = payload?.params?.update;
    if (upd?.sessionUpdate !== "agent_message_chunk") continue;

    const content = upd?.content;
    if (Array.isArray(content)) {
      for (const c of content) {
        if (typeof c?.text === "string") chunks.unshift(c.text);
      }
    } else if (typeof content?.text === "string") {
      chunks.unshift(content.text);
    }
  }

  return chunks.join("");
}

function sanitizeSpokenText(rawText: string): string {
  let raw = rawText;
  raw = raw.replace(/```[\s\S]*?```/g, " (code block omitted) ");
  raw = raw.replace(/`([^`]+)`/g, "$1");
  raw = raw.replace(/!\[.*?\]\(.*?\)/g, " (image) ");
  raw = raw.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
  raw = raw.replace(/[*_#>]+/g, "");
  return raw.trim();
}

/**
 * Decide whether the latest completed turn should be spoken. The gate
 * is the prompt echo's `voiceReplyExpected` flag, not a fresh
 * localStorage read at completion time. The prompt event is the durable
 * record of what mode the outgoing prompt actually used.
 */
export function getVoiceTurnToSpeak(
  events: RawEventFrame[],
  tabId: string | null,
  lastSpokenTurn: string | null,
): VoiceTurnToSpeak | null {
  const promptEchoIdx = latestPromptEchoIndex(events, tabId);
  if (promptEchoIdx < 0) return null;
  const prompt = events[promptEchoIdx];
  if (!prompt) return null;
  if (promptMeta(prompt)?.voiceReplyExpected !== true) return null;

  const turnKey = `${tabId ?? ""}::${promptEchoIdx}`;
  if (lastSpokenTurn === turnKey) return null;

  const text = extractLastAssistantTurn(events, tabId);
  if (!text || text.trim().length === 0) return null;
  return { turnKey, text };
}
