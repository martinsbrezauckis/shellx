import { invoke } from "@tauri-apps/api/core";

function isVoiceChatEnabled(tabId: string | null): boolean {
  try {
    // Voice chat is explicitly per tab. The legacy global key is only a
    // migration artifact; reading it here can make TTS leak into a tab
    // where the user never enabled voice chat.
    if (!tabId) return false;
    return localStorage.getItem(`shellx.voiceChatMode.${tabId}`) === "1";
  } catch {
    return false;
  }
}

export function buildVoiceAwarePrompt(
  text: string,
  tabId: string | null,
): { prompt: string; voiceReplyExpected: boolean } {
  const voiceReplyExpected = isVoiceChatEnabled(tabId);
  // The frontend owns ordinary TTS-back. Keep this instruction natural
  // so providers do not explain the implementation during normal voice
  // conversation, while still allowing explicit diagnostic/tool requests.
  const prompt = voiceReplyExpected
    ? `[voice chat] Answer naturally as speech: concise, conversational, under about 6 sentences, no tables, no code blocks. Your final answer will be spoken automatically, so do not mention plain text, TTS, audio plumbing, or voice_tts unless the user asks you to diagnose voice mode. Do not call voice_tts for ordinary replies. If the user explicitly asks you to inspect, diagnose, or use tools, use the appropriate tools and then summarize the result in spoken-friendly text.\n\n${text}`
    : text;
  return { prompt, voiceReplyExpected };
}

// Retain the currently playing audio and its listeners until playback ends.
// Replacing a reply aborts and clears the older element before starting the
// new one, keeping the loop single-owner and prompt-tab scoped.
let activeVoiceAudio: HTMLAudioElement | null = null;
let activeVoiceAudioAbort: AbortController | null = null;

/**
 * Synthesize a completed voice-enabled turn, play it, and rearm capture.
 * Failures remain best-effort but are surfaced to the owning tab.
 */
export async function speakAndRearm(text: string, tabId: string | null): Promise<void> {
  try { console.info("voice-chat: speakAndRearm starting", { chars: text.length }); } catch { /* ignore */ }
  const dispatchRearm = () => {
    try {
      window.dispatchEvent(new CustomEvent("shellx:voice-chat-rearm", { detail: { tabId } }));
    } catch { /* ignore */ }
  };
  const surface = (msg: string) => {
    try {
      window.dispatchEvent(new CustomEvent("shellx:voice-chat-error", { detail: { msg, tabId } }));
    } catch { /* ignore */ }
    try { console.warn("voice-chat:", msg); } catch { /* ignore */ }
  };
  let response: { audio_data_url: string; ms_total: number };
  try {
    response = await invoke<{ audio_data_url: string; ms_total: number }>(
      "synthesize_voice",
      { text },
    );
    try {
      console.info("voice-chat: TTS bytes received", {
        ms: response.ms_total,
        urlLen: response.audio_data_url.length,
      });
    } catch { /* ignore */ }
  } catch (error) {
    const message = String((error as { message?: unknown })?.message ?? error);
    if (message.startsWith("STT_NO_KEY:")) {
      surface("TTS no credential — run `grok login` or add xai/api-key to vault. Voice chat stays ON; next turn will retry.");
    } else {
      surface(`TTS synthesize failed: ${message}`);
    }
    dispatchRearm();
    return;
  }
  try {
    if (activeVoiceAudio) {
      try { activeVoiceAudioAbort?.abort(); } catch { /* ignore */ }
      try { activeVoiceAudio.pause(); } catch { /* ignore */ }
      try { activeVoiceAudio.src = ""; } catch { /* ignore */ }
      activeVoiceAudio = null;
      activeVoiceAudioAbort = null;
    }
    const audio = new Audio(response.audio_data_url);
    const listenerAbort = new AbortController();
    activeVoiceAudio = audio;
    activeVoiceAudioAbort = listenerAbort;
    let rearmed = false;
    const rearmOnce = () => {
      if (rearmed) return;
      rearmed = true;
      try { listenerAbort.abort(); } catch { /* ignore */ }
      if (activeVoiceAudio === audio) {
        activeVoiceAudio = null;
        activeVoiceAudioAbort = null;
      }
      dispatchRearm();
    };
    audio.addEventListener("ended", () => {
      try { console.info("voice-chat: playback ended, re-arming"); } catch { /* ignore */ }
      rearmOnce();
    }, { once: true, signal: listenerAbort.signal });
    audio.addEventListener("error", (event) => {
      const code = (event.target as HTMLAudioElement)?.error?.code;
      surface(`TTS playback error (code=${code ?? "?"}) — audio decode/CSP issue. Voice chat stays ON.`);
      rearmOnce();
    }, { once: true, signal: listenerAbort.signal });
    await audio.play();
    try { console.info("voice-chat: audio.play() resolved"); } catch { /* ignore */ }
  } catch (error) {
    try { activeVoiceAudioAbort?.abort(); } catch { /* ignore */ }
    if (activeVoiceAudio) {
      try { activeVoiceAudio.pause(); } catch { /* ignore */ }
      try { activeVoiceAudio.src = ""; } catch { /* ignore */ }
      activeVoiceAudio = null;
    }
    activeVoiceAudioAbort = null;
    const message = String((error as { message?: unknown })?.message ?? error);
    surface(`TTS playback failed: ${message}. (If "NotAllowedError" — browser autoplay policy blocked it; click the page once to grant gesture.)`);
    dispatchRearm();
  }
}
