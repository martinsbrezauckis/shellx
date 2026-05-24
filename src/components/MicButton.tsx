/**
 * src/components/MicButton.tsx — STT push-to-talk (#75).
 *
 * Click-to-toggle (NOT press-and-hold — too finicky in a touchpad/laptop
 * setup) mic button for dictating prompts via xAI Grok STT. State machine:
 *
 * idle ──click──► recording ──click──► transcribing ──xAI 200──► idle
 * └──Esc/close───────► idle (recording dropped)
 * └──xAI err──► idle (+ toast)
 *
 * Audio capture uses MediaRecorder with whatever codec the WebView2
 * negotiates by default (Chromium → audio/webm;codecs=opus). On idle
 * release, the recorded Blob is read into a Uint8Array and passed to
 * the Rust `transcribe_audio_blob` command, which posts to api.x.ai
 * STT and returns the text.
 *
 * The transcript is INSERTED at the textarea cursor position (or
 * appended with a leading space if cursor sits in the middle of
 * existing text) via the `onTranscript` callback. The composer
 * remains in control of state — this component is read-only.
 *
 * Browser-only mode (no Tauri): the button stays present but click
 * shows "Voice transcription requires the Tauri runtime" inline.
 *
 * Mic permission: handled by the WebView2's standard getUserMedia
 * flow. First click prompts; subsequent clicks reuse the granted
 * permission. On denial we surface the browser's error message.
 */
import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type JSX } from "react";
import { invoke } from "@tauri-apps/api/core";
import { inTauri } from "../lib/tauri-bridge";
import { ShellIcon, type ShellIconName } from "./icons";

type MicState = "idle" | "recording" | "transcribing" | "error" | "no-key";

export interface MicButtonProps {
 /** Called with the recognized text on a successful transcription.
 * The caller decides whether to append, insert-at-cursor, or
 * replace the composer content. */
  onTranscript: (text: string) => void;
 /** Disabled when the parent is in a state that disallows voice
 * input (e.g. mid-send, no active session). */
  disabled?: boolean;
 /** tells the parent whenever recording state flips
 * so BottomPanel can relabel the Send button while the mic is hot
 * ("Send voice"). Saves the click of "stop recording" — Send now
 * doubles as stop+transcribe+send. */
  onRecordingChange?: (isRecording: boolean) => void;
 /**  voice mode. "talk" = STT-only (default, classic
 * push-to-talk). "voice-chat" = STT + (next phase) TTS-back; for
 * now the parent uses this to inject a per-prompt voice-format
 * hint to grok so it answers conversationally. */
  mode?: "talk" | "voice-chat";
 /** Visible label rendered alongside the icon. Empty = icon-only. */
  label?: string;
 /** Legacy idle glyph override. Kept for API compatibility; SVG icons render by mode. */
  idleIcon?: string;
 /** Optional start gate. Return false to keep the mic idle. */
  onBeforeStart?: () => boolean;
}

/** imperative handle so BottomPanel's Send can
 * stop+transcribe+resolve to the text in one round-trip. Parent
 * injects the transcript into the prompt + fires normal send. */
export interface MicButtonHandle {
 /** True iff currently capturing audio. */
  isRecording(): boolean;
 /** Drop the current recording without transcription. */
  cancel(): void;
 /** Stop recording, wait for STT, return the text. Empty string
 * if no audio captured; throws on STT_NO_KEY or network error. */
  stopAndAwaitText(): Promise<string>;
}

export const MicButton = forwardRef<MicButtonHandle, MicButtonProps>(function MicButton(
  { onTranscript, disabled, onRecordingChange, mode = "talk", label, idleIcon, onBeforeStart }: MicButtonProps,
  ref,
): JSX.Element {
  const [state, setState] = useState<MicState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const tickerRef = useRef<number | null>(null);

 // notify parent every time the recording flag flips
 // so the composer can re-label Send while we're hot.
  useEffect(() => {
    if (onRecordingChange) {
      onRecordingChange(state === "recording");
    }
  }, [state, onRecordingChange]);

 // Deferred-resolution box for stopAndAwaitText: BottomPanel installs
 // a resolver here during a recording; finalize resolves with the
 // transcribed text or rejects on STT_NO_KEY / network error.
  const awaitTextResolverRef = useRef<{
    resolve: (text: string) => void;
    reject: (err: Error) => void;
  } | null>(null);

 // Stop the live elapsed-time ticker when we leave the recording state.
  useEffect(() => {
    if (state !== "recording") {
      if (tickerRef.current != null) {
        window.clearInterval(tickerRef.current);
        tickerRef.current = null;
      }
      return;
    }
    setElapsed(0);
    const t0 = performance.now();
    tickerRef.current = window.setInterval(() => {
      setElapsed(Math.floor((performance.now() - t0) / 100) / 10);
    }, 100);
    return () => {
      if (tickerRef.current != null) {
        window.clearInterval(tickerRef.current);
        tickerRef.current = null;
      }
    };
  }, [state]);

 // Esc cancels an in-progress recording without transcribing.
  useEffect(() => {
    if (state !== "recording") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") cancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [state]);

  async function start(): Promise<void> {
    if (!inTauri()) {
      setError("Voice transcription requires the Tauri runtime.");
      setState("error");
      window.setTimeout(() => setState("idle"), 2500);
      return;
    }
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
 // If MediaRecorder construction throws (codec not supported,
 // iframe sandbox), we must release the live audio
 // stream right here — otherwise the mic indicator stays lit
 // and the next start leaks a second stream on top.
      let rec: MediaRecorder;
      try {
        rec = new MediaRecorder(stream);
      } catch (recErr: any) {
        stream.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
        throw new Error(`MediaRecorder init failed: ${recErr?.message ?? recErr}`);
      }
      recorderRef.current = rec;
      chunksRef.current = [];
      rec.ondataavailable = (ev) => {
        if (ev.data && ev.data.size > 0) chunksRef.current.push(ev.data);
      };
      rec.onstop = () => { void finalize(); };
      rec.start();
      setState("recording");
    } catch (err: any) {
 // Catch-all leak guard. getUserMedia can succeed
 // and the MediaRecorder constructor can still throw later in
 // the try block; this releases any partial stream allocation.
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
      }
      setError(`Mic permission: ${err?.message ?? err}`);
      setState("error");
      window.setTimeout(() => setState("idle"), 3000);
    }
  }

 // Cleanup on unmount. A route change / tab close
 // during an active recording previously left the microphone live;
 // this releases the device. cancel handles both the recorder
 // and the stream, so we can call it without checking state.
  useEffect(() => {
    return () => { cancel(); };
 // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function stop(): void {
    const rec = recorderRef.current;
    if (!rec) return;
    if (rec.state !== "inactive") rec.stop();
    setState("transcribing");
  }

  function cancel(): void {
    const rec = recorderRef.current;
    if (rec && rec.state !== "inactive") rec.stop();
    chunksRef.current = [];
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    recorderRef.current = null;
    setState("idle");
  }

  async function finalize(): Promise<void> {
    try {
      const chunks = chunksRef.current;
 // Stop the audio tracks (release mic indicator).
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
      }
      if (chunks.length === 0) {
        setState("idle");
        return;
      }
      const blob = new Blob(chunks, { type: recorderRef.current?.mimeType || "audio/webm" });
      const ab = await blob.arrayBuffer();
      const audioBytes = Array.from(new Uint8Array(ab));
      const res = await invoke<{ text: string; ms_total: number }>("transcribe_audio_blob", {
        audioBytes,
        mimeType: blob.type,
      });
      if (res.text && res.text.length > 0) {
        onTranscript(res.text);
      }
 // also resolve the imperative-handle promise so
 // BottomPanel's Send-while-recording flow can grab the text and
 // fire a real send right after.
      if (awaitTextResolverRef.current) {
        awaitTextResolverRef.current.resolve(res.text ?? "");
        awaitTextResolverRef.current = null;
      }
      setState("idle");
    } catch (err: any) {
      const msg = String(err?.message ?? err);
 // voice.rs returns "STT_NO_KEY: …" when no
 // xai/api-key is configured. We detect that prefix and stay in
 // the no-key sticky state so the user sees the explainer until
 // they fix it (instead of the generic 4.5s timeout error toast).
      if (msg.startsWith("STT_NO_KEY:")) {
        setError("No xAI credentials. Run `grok login` in a terminal (OAuth — recommended) OR add an `xai/api-key` in Settings → Vault. Voice uses xAI's Grok-STT (covered by your grok-build subscription via OAuth).");
        setState("no-key");
      } else {
        setError(msg);
        setState("error");
        window.setTimeout(() => setState("idle"), 4500);
      }
 // bubble up errors to the imperative-handle caller.
      if (awaitTextResolverRef.current) {
        awaitTextResolverRef.current.reject(err instanceof Error ? err : new Error(msg));
        awaitTextResolverRef.current = null;
      }
    } finally {
      chunksRef.current = [];
      recorderRef.current = null;
    }
  }

 // imperative API for BottomPanel's "Send button stops
 // and transcribes" flow.
  useImperativeHandle(
    ref,
    () => ({
      isRecording: () => state === "recording",
      cancel: () => cancel(),
      stopAndAwaitText: () => {
        return new Promise<string>((resolve, reject) => {
          if (state !== "recording") {
            resolve("");
            return;
          }
          awaitTextResolverRef.current = { resolve, reject };
          stop();
        });
      },
    }),
    [state],
  );

  function onClick(): void {
    if (disabled) return;
    if (state === "idle" || state === "error" || state === "no-key") {
      if (onBeforeStart && !onBeforeStart()) return;
      void start();
    }
    else if (state === "recording") stop();
 // "transcribing" click is a no-op; user waits for round-trip.
  }

 // SVG icon chosen by state and mode. This keeps the voice controls
 // visually stable across Windows, Linux, and macOS instead of relying
 // on platform emoji fonts.
  void idleIcon;
  const iconName: ShellIconName =
    state === "recording" ? "circle"
    : state === "transcribing" ? "activity"
    : state === "no-key" ? "lock"
    : mode === "voice-chat" ? "headphones"
    : "mic";
  const modeLabel = mode === "voice-chat" ? "Voice chat" : "Talk";
  const title =
    state === "recording" ? `Recording ${elapsed.toFixed(1)}s — click to stop, Esc to cancel`
    : state === "transcribing" ? "Transcribing via xAI Grok STT…"
    : state === "no-key" ? (error ?? "No xAI API key — add via Settings → Vault")
    : state === "error" ? error ?? "Voice error"
    : mode === "voice-chat"
      ? "Voice chat — STT + spoken reply playback"
      : "Talk — push-to-talk dictation (xAI Grok STT)";

  return (
    <button
      type="button"
      className={`mic-btn mic-${state} mic-mode-${mode}${label ? " mic-with-label" : ""}`}
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={title}
    >
      <span className="mic-ic"><ShellIcon name={iconName} size={14} /></span>
      {(label ?? modeLabel) && (
        <span className="mic-label">{label ?? modeLabel}</span>
      )}
      {state === "recording" && <span className="mic-timer">{elapsed.toFixed(1)}s</span>}
      {state === "error" && <span className="mic-err">!</span>}
      {state === "no-key" && <span className="mic-err">?</span>}
    </button>
  );
});
