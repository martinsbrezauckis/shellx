/**
 * src/components/BottomPanel.tsx — bottom-panel tabs + prompt composer.
 * * Tabs: Chat (default) / Terminal / Logs / Stderr.
 * - Chat: prompt textarea + Attach + Send pill.
 * - Terminal: real xterm.js view backed by tauri-plugin-pty.
 * - Logs: raw event stream.
 * - Stderr: filtered grok-stderr events.
 * * Tab state is mirrored to localStorage. Counts come from the parent's
 * events[]. Prompt wiring: parent passes onSend(text); Enter sends,
 * Shift+Enter newline, ⌘U opens the file picker.
 */
import { useEffect, useLayoutEffect, useRef, useState, type JSX } from "react";
import { createPortal } from "react-dom";
import type { RawEventFrame } from "../types/acp";
import { HashAutocomplete, type HashItem } from "./HashAutocomplete";
import type { AutonomyMode } from "./Header";
import { ConnectionPicker, type ConnectionPreset } from "./ConnectionPicker";
import { ConnectionEditor } from "./ConnectionEditor";
import { BranchPicker } from "./BranchPicker";
// PTY-backed terminal view, keyed by activeTabId in the Rust registry.
// <TerminalView/> is also reused for attached ACP terminals when grok
// spawns terminal/* PTYs.
import { TerminalTab } from "./TerminalTab";
import { TerminalView } from "./TerminalView";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
// Push-to-talk dictation via xAI Grok STT.
import { MicButton, type MicButtonHandle } from "./MicButton";

export type BottomTab = "Chat" | "Terminal" | "Logs" | "Stderr";

const TAB_KEY = "grok-shell.bottomTab";
const VOICE_LEGACY_KEY = "shellx.voiceChatMode";
const VOICE_KEY_PREFIX = "shellx.voiceChatMode.";
const VOICE_OWNER_KEY = "shellx.voiceChatMode.activeTab";
interface VoiceSessionTab {
  tabId: string;
  title: string;
}

function readStoredVoiceMode(voiceKey: string): boolean {
  try {
    return localStorage.getItem(voiceKey) === "1";
  } catch {
    return false;
  }
}

function voiceKeyForTab(tabId: string): string {
  return `${VOICE_KEY_PREFIX}${tabId}`;
}

function findOpenVoiceOwner(
  activeTabId: string | null | undefined,
  openTabs: VoiceSessionTab[],
): VoiceSessionTab | null {
  const openById = new Map(openTabs.map((tab) => [tab.tabId, tab]));
  try {
    const owner = localStorage.getItem(VOICE_OWNER_KEY);
    if (owner && owner !== activeTabId) {
      const openOwner = openById.get(owner);
      const ownerStillEnabled = localStorage.getItem(voiceKeyForTab(owner)) === "1";
      if (openOwner && ownerStillEnabled) return openOwner;
      localStorage.setItem(voiceKeyForTab(owner), "0");
      localStorage.removeItem(VOICE_OWNER_KEY);
    }

    for (let i = localStorage.length - 1; i >= 0; i -= 1) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith(VOICE_KEY_PREFIX)) continue;
      if (localStorage.getItem(key) !== "1") continue;
      const tabId = key.slice(VOICE_KEY_PREFIX.length);
      if (!tabId || tabId === activeTabId) continue;
      const openOwner = openById.get(tabId);
      if (openOwner) {
        localStorage.setItem(VOICE_OWNER_KEY, tabId);
        return openOwner;
      }
 // Closed-tab stale state should not block the next voice session.
      localStorage.setItem(key, "0");
    }

 // Legacy pre-tab key must never turn a later tab on by accident.
    localStorage.removeItem(VOICE_LEGACY_KEY);
  } catch {
 /* localStorage can be unavailable in preview/test shells */
  }
  return null;
}

function activeVoiceOwnerLabel(owner: VoiceSessionTab): string {
  const title = owner.title?.trim();
  return title && title !== "new session" ? title : owner.tabId;
}

function clearClosedVoiceKeys(openTabs: VoiceSessionTab[]): void {
  try {
    const openIds = new Set(openTabs.map((tab) => tab.tabId));
    for (let i = localStorage.length - 1; i >= 0; i -= 1) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith(VOICE_KEY_PREFIX)) continue;
      const tabId = key.slice(VOICE_KEY_PREFIX.length);
      if (tabId && !openIds.has(tabId)) {
        localStorage.setItem(key, "0");
      }
    }
    const owner = localStorage.getItem(VOICE_OWNER_KEY);
    if (owner && !openIds.has(owner)) localStorage.removeItem(VOICE_OWNER_KEY);
  } catch {
 /* ignore */
  }
}

/**
 * render the composer's current prompt into a list of JSX nodes
 * that mark `/word` slash-command tokens with `<span class="slash-token">`.
 * * Rules (mirror BottomPanel's selectSlashItem regex):
 * - `/word` tokens at start of string OR right after whitespace.
 * - `/word` token = `/` + one or more [a-z0-9_-]; case-insensitive.
 * - Tokens NOT at a word-boundary (e.g. `/path/in/the/middle`) are
 * left as plain text so file paths don't paint orange.
 * * Output is consumed by the textarea-mirror overlay. We don't return
 * a single innerHTML string — using JSX nodes avoids any HTML-escaping
 * footguns when the prompt happens to contain `<` or `>`.
 * * Edge cases:
 * - Trailing newline gets a non-breaking space appended (textarea
 * contenteditable mirroring trick — without it the mirror's final
 * line collapses to 0 height and the textarea's caret appears in
 * the wrong row).
 */
export function highlightSlashTokens(text: string): React.ReactNode[] {
  if (text.length === 0) return [" "]; // empty: render nbsp to preserve line box
  const out: React.ReactNode[] = [];
 // Regex matches: (start-or-whitespace)(/word). Captures via non-capturing
 // alternation so we can split cleanly with .matchAll.
  const re = /(^|\s)(\/[a-z0-9_-]+)/gi;
  let lastIdx = 0;
  let key = 0;
  for (const m of text.matchAll(re)) {
    const matchStart = m.index ?? 0;
    const prefix = m[1] ?? ""; // leading whitespace or empty (start-of-string)
    const token = m[2] ?? ""; // /word
    if (token.length === 0) continue;
    const tokenStart = matchStart + prefix.length;
 // Push any text between the previous match and this token.
    if (tokenStart > lastIdx) {
      out.push(text.slice(lastIdx, tokenStart));
    }
    out.push(<span key={`slash-${key++}`} className="slash-token">{token}</span>);
    lastIdx = tokenStart + token.length;
  }
 // Tail.
  if (lastIdx < text.length) {
    out.push(text.slice(lastIdx));
  }
 // Trailing newline fix — see jsdoc.
  if (text.endsWith("\n")) out.push(" ");
  return out;
}

/**
 * Read the persisted bottom-tab on init. Exported so the parent
 * (App.tsx) can initialize its controlled state to match localStorage —
 * keeps the ⌘` toggle correct on first paint.
 */
export function readPersistedBottomTab(): BottomTab {
  try {
    const v = localStorage.getItem(TAB_KEY) as BottomTab | null;
    if (v === "Chat" || v === "Terminal" || v === "Logs" || v === "Stderr") return v;
  } catch { /* no-op */ }
  return "Chat";
}

export function BottomPanel({
  prompt,
  onPromptChange,
  onSend,
  onAbort,
  isSending,
  connected,
  events,
 // controlled tab — parent owns the state so ⌘`
 // can flip Chat ↔ Terminal globally. When `tab` is undefined the
 // component falls back to its own state (preserves old callers).
  tab: controlledTab,
  onTabChange,
 // attach button receives a real handler from
 // parent (file picker via tauri-plugin-dialog).
  onAttach,
  onAttachScreenshot,
 // drag-and-drop from the right-rail Files
 // tab. App routes to the same processAttachedPaths pipeline the
 // dialog uses.
  onAttachPaths,
 // PR/issue list for `#N` autocomplete.
  hashItems = [],
 // grok's available_commands — drives "/" autocomplete in PromptComposer.
  skills = [],
  activeCwd,
 // Autonomy chip lives in the composer action row.
  autonomy,
  onAutonomyChange,
 // Model label/effort badges in the action row.
  modelLabel,
  modelEffort,
 // Scope-row labels (project / connection / branch).
  scopeProject,
  scopeConnection,
  scopeConnectionTransport,
  scopeBranch,
  scopeBranchAhead,
 // Composer is a controlled component for scope state — selections
 // fire callbacks up to App.tsx which updates the active TabEntry.
 // Optional for callers that don't route through App.
  onSelectConnection,
  onSelectBranch,
  onCreateWorktree,
  onPickProject,
  connectionLocked,
 // Active session tab id; keys the PTY per-tab in the Rust registry.
 // Null falls back to the Terminal placeholder so a homeless PTY
 // can't leak.
  activeTabId,
  voiceSessionTabs = [],
}: {
  prompt: string;
  onPromptChange: (s: string) => void;
  onSend: () => void;
  onAbort: () => void;
  isSending: boolean;
  connected: boolean;
  events: RawEventFrame[];
  tab?: BottomTab;
  onTabChange?: (t: BottomTab) => void;
  onAttach?: () => void;
  onAttachScreenshot?: () => void;
 /** same as onAttach but with explicit paths
 * (no dialog). Wired from App.processAttachedPaths. */
  onAttachPaths?: (paths: string[]) => void;
  hashItems?: HashItem[];
 /** grok's slash commands from `available_commands_update`
 * events. Each `{name, description?}` becomes an autocomplete entry
 * when the user starts typing `/` at the prompt's caret. */
  skills?: { name: string; description?: string }[];
 /** Active tab's cwd — forwarded to BranchPicker for git_branches. */
  activeCwd?: string;
  autonomy?: AutonomyMode;
  onAutonomyChange?: (mode: AutonomyMode) => void;
  modelLabel?: string;
  modelEffort?: string;
  scopeProject?: string;
  scopeConnection?: string;
  scopeConnectionTransport?: string;
  scopeBranch?: string;
  scopeBranchAhead?: number;
  onSelectConnection?: (preset: ConnectionPreset) => void;
  onSelectBranch?: (name: string) => void;
  onCreateWorktree?: (sourceBranch: string) => void;
 /** clicking the project scope-pill opens a folder picker
 * and binds the choice to the active tab. */
  onPickProject?: () => void;
 /** True once the active tab has sent its first message.
 * The connection pill becomes read-only and transport changes must
 * happen in a fresh tab so session routing stays stable. */
  connectionLocked?: boolean;
 /** active session tab id; null when no tab exists yet
 * (e.g. boot before any session has been opened). When null the
 * Terminal tab shows the placeholder rather than spawning a
 * homeless PTY. */
  activeTabId?: string | null;
  voiceSessionTabs?: VoiceSessionTab[];
}): JSX.Element {
  const [localTab, setLocalTab] = useState<BottomTab>(readPersistedBottomTab);
  const tab = controlledTab ?? localTab;
  const setTab = (next: BottomTab) => {
    if (onTabChange) onTabChange(next);
    else setLocalTab(next);
  };

  useEffect(() => {
    try { localStorage.setItem(TAB_KEY, tab); } catch { /* no-op */ }
  }, [tab]);

 /** Defer Terminal mount until the user clicks the Terminal tab.
 * Once shown, TerminalView stays mounted across tab switches so
 * xterm.js state survives. Lazy first-mount avoids running
 * pty_create against a zero-size hidden container on every boot. */
  const terminalEverShown = useRef<boolean>(tab === "Terminal");
  if (tab === "Terminal") terminalEverShown.current = true;

  const stderrCount = events.filter((e) => e.kind === "grok-stderr").length;

  return (
    <div className="bottom-panel">
      <div className="bottom-tabs">
        <button
          type="button"
          className={`btab ${tab === "Chat" ? "active" : ""}`}
          onClick={() => setTab("Chat")}
        >
          Chat
        </button>
        <button
          type="button"
          className={`btab ${tab === "Terminal" ? "active" : ""}`}
          onClick={() => setTab("Terminal")}
        >
          <span className="bdot" />
          Terminal
        </button>
        <button
          type="button"
          className={`btab ${tab === "Logs" ? "active" : ""}`}
          onClick={() => setTab("Logs")}
        >
          Logs <span className="bcnt">{events.length}</span>
        </button>
        <button
          type="button"
          className={`btab ${tab === "Stderr" ? "active" : ""}`}
          onClick={() => setTab("Stderr")}
        >
          Stderr{" "}
          <span
            className="bcnt"
            style={stderrCount > 0
              ? { color: "var(--warn)", borderColor: "rgba(212,166,76,.4)" }
              : undefined}
          >
            {stderrCount}
          </span>
        </button>
        <span className="bottom-tabs-spacer" />
      </div>

      <div className="bottom-body">
        {tab === "Chat" && (
          <PromptComposer
            prompt={prompt}
            onPromptChange={onPromptChange}
            onSend={onSend}
            onAbort={onAbort}
            isSending={isSending}
            connected={connected}
            onAttach={onAttach}
            onAttachScreenshot={onAttachScreenshot}
            onAttachPaths={onAttachPaths}
            hashItems={hashItems}
            skills={skills}
            activeCwd={activeCwd}
            autonomy={autonomy}
            onAutonomyChange={onAutonomyChange}
            modelLabel={modelLabel}
            modelEffort={modelEffort}
            scopeProject={scopeProject}
            scopeConnection={scopeConnection}
            scopeConnectionTransport={scopeConnectionTransport}
            scopeBranch={scopeBranch}
            scopeBranchAhead={scopeBranchAhead}
            onSelectConnection={onSelectConnection}
            onSelectBranch={onSelectBranch}
            onCreateWorktree={onCreateWorktree}
            onPickProject={onPickProject}
            connectionLocked={connectionLocked}
            activeTabId={activeTabId}
            voiceSessionTabs={voiceSessionTabs}
          />
        )}
 {/* Terminal MUST stay mounted
 * across tab switches. Conditional render unmounted the PTY tree
 * → cleanup invoked pty_kill → child shell died → re-mount on
 * tab return spawned a fresh shell at default cwd. Users were
 * losing their working directory + scrollback every time they
 * peeked at Chat/Logs/Stderr. Fix: render unconditionally, gate
 * VISIBILITY via inline display style. Logs/Stderr are cheap
 * and stateless so they stay conditional. */}
        {activeTabId
          ? (terminalEverShown.current && (
            <div className="terminal-mount" style={{ display: tab === "Terminal" ? "flex" : "none", flexDirection: "column", flex: 1, minHeight: 0 }}>
              <BottomTerminalSurface sessionTabId={activeTabId} />
            </div>
          ))
          : (tab === "Terminal" && <TerminalPlaceholder />)}
        {tab === "Logs"     && <LogsView events={events} />}
        {tab === "Stderr"   && <StderrView events={events} />}
      </div>
    </div>
  );
}

/* ─────────────── Chat tab ─────────────── */

function PromptComposer({
  prompt,
  onPromptChange,
  onSend,
  onAbort,
  isSending,
  connected,
  onAttach,
  onAttachScreenshot,
  onAttachPaths,
  hashItems = [],
  skills = [],
  activeCwd,
  autonomy = "default",
  onAutonomyChange,
  modelLabel = "grok-build",
  modelEffort = "high",
  scopeProject = "grok-shell",
  scopeConnection = "Local · current worktree",
  scopeConnectionTransport = "💻",
  scopeBranch = "—",
  scopeBranchAhead,
  onSelectConnection: onSelectConnectionExt,
  onSelectBranch: onSelectBranchExt,
  onCreateWorktree: onCreateWorktreeExt,
  onPickProject,
  connectionLocked = false,
  activeTabId,
  voiceSessionTabs = [],
}: {
  prompt: string;
  onPromptChange: (s: string) => void;
  onSend: () => void;
  onAbort: () => void;
  isSending: boolean;
  connected: boolean;
  onAttach?: () => void;
  onAttachScreenshot?: () => void;
 /** drag-and-drop attach from Files tab. */
  onAttachPaths?: (paths: string[]) => void;
  hashItems?: HashItem[];
 /** grok's slash commands from `available_commands_update`
 * events. Each `{name, description?}` becomes an autocomplete entry
 * when the user starts typing `/` at the prompt's caret. */
  skills?: { name: string; description?: string }[];
 /** Active tab's cwd — forwarded to BranchPicker for git_branches. */
  activeCwd?: string;
  autonomy?: AutonomyMode;
  onAutonomyChange?: (mode: AutonomyMode) => void;
  modelLabel?: string;
  modelEffort?: string;
  scopeProject?: string;
  scopeConnection?: string;
  scopeConnectionTransport?: string;
  scopeBranch?: string;
  scopeBranchAhead?: number;
  onSelectConnection?: (preset: ConnectionPreset) => void;
  onSelectBranch?: (name: string) => void;
  onCreateWorktree?: (sourceBranch: string) => void;
  onPickProject?: () => void;
 /** locks the connection pill in read-only state. */
  connectionLocked?: boolean;
 /** audit fix — keys per-tab voiceChatMode storage so toggling
 * 🎧 in tab A doesn't bleed into tab B's mic loop. */
  activeTabId?: string | null;
  voiceSessionTabs?: VoiceSessionTab[];
}): JSX.Element {
  const taRef = useRef<HTMLTextAreaElement | null>(null);
 // imperative handle to MicButton so the Send button
 // can do stop+transcribe+send in one click while the mic is hot.
  const micRef = useRef<MicButtonHandle | null>(null);
  const voiceChatRef = useRef<MicButtonHandle | null>(null);
  const [micRecording, setMicRecording] = useState(false);
  const [voiceChatRecording, setVoiceChatRecording] = useState(false);
 // Voice chat mode is per tab, but only one open tab may own it at a
 // time. That prevents the mic auto-rearm loop from hopping between
 // sessions while still letting a spoken reply finish if the user
 // switches tabs mid-turn.
  const voiceKey = activeTabId ? `${VOICE_KEY_PREFIX}${activeTabId}` : VOICE_LEGACY_KEY;
  const [voiceChatMode, setVoiceChatMode] = useState<boolean>(() => readStoredVoiceMode(voiceKey));
  const [voiceWarning, setVoiceWarning] = useState<string | null>(null);
  const voiceWarningTimer = useRef<number | null>(null);
  const showVoiceWarning = (msg: string): void => {
    setVoiceWarning(msg);
    if (voiceWarningTimer.current != null) window.clearTimeout(voiceWarningTimer.current);
    voiceWarningTimer.current = window.setTimeout(() => setVoiceWarning(null), 5000);
  };
  useEffect(() => () => {
    if (voiceWarningTimer.current != null) window.clearTimeout(voiceWarningTimer.current);
  }, []);
  const guardVoiceStart = (): boolean => {
    const owner = findOpenVoiceOwner(activeTabId, voiceSessionTabs);
    if (!owner) {
      setVoiceWarning(null);
      return true;
    }
    showVoiceWarning(`Voice chat is already on in "${activeVoiceOwnerLabel(owner)}". Turn it off there before starting another voice session.`);
    return false;
  };
  const writeVoiceChatMode = (enabled: boolean): void => {
    setVoiceChatMode(enabled);
    try {
      if (enabled) {
        const owner = findOpenVoiceOwner(activeTabId, voiceSessionTabs);
        if (owner) {
          showVoiceWarning(`Voice chat is already on in "${activeVoiceOwnerLabel(owner)}". Turn it off there before starting another voice session.`);
          setVoiceChatMode(false);
          return;
        }
        if (activeTabId) localStorage.setItem(VOICE_OWNER_KEY, activeTabId);
        localStorage.removeItem(VOICE_LEGACY_KEY);
      } else if (!activeTabId || localStorage.getItem(VOICE_OWNER_KEY) === activeTabId) {
        localStorage.removeItem(VOICE_OWNER_KEY);
      }
      localStorage.setItem(voiceKey, enabled ? "1" : "0");
    } catch {
 /* ignore storage failures; the visible toggle still updates */
    }
  };
 // Re-load when the active tab changes so each tab's stored state is what
 // we render. This is intentionally not paired with a generic "persist on
 // voiceKey change" effect; that old pattern wrote tab A's ON state into
 // tab B during tab switches.
  useEffect(() => {
    clearClosedVoiceKeys(voiceSessionTabs);
    setVoiceChatMode(readStoredVoiceMode(voiceKey));
  }, [voiceKey, voiceSessionTabs]);
  const anyRecording = micRecording || voiceChatRecording;

 // #355: continuous voice-chat loop. App.tsx fires this
 // event after the AI's TTS playback finishes; we re-arm the 🎧
 // mic if voice-chat mode is still on. Without this, the user has
 // to manually press 🎧 again after every reply — defeating the
 // "conversation" model.
  useEffect(() => {
    const handler = (e: Event) => {
      const taggedTab = (e as CustomEvent<{ tabId?: string | null }>).detail?.tabId ?? null;
      if (taggedTab && taggedTab !== activeTabId) return;
      try {
        const owner = localStorage.getItem(VOICE_OWNER_KEY);
        if (owner && activeTabId && owner !== activeTabId) return;
      } catch { /* ignore */ }
      if (!voiceChatMode) return;
      if (!connected || isSending) return;
 // Best-effort: MicButton's imperative API doesn't expose
 // start yet (only stopAndAwaitText); we synthesize a click
 // on the rendered button instead. The ref's underlying button
 // is keyboard-focusable so .click reliably triggers onClick.
      const btn = document.querySelector('.mic-mode-voice-chat') as HTMLButtonElement | null;
      if (btn && !btn.disabled) {
        try { btn.click(); } catch { /* ignore */ }
      }
    };
    window.addEventListener("shellx:voice-chat-rearm", handler);
    return () => window.removeEventListener("shellx:voice-chat-rearm", handler);
  }, [activeTabId, voiceChatMode, connected, isSending]);

 /** Send behavior: if ANY mic (🎤 Talk OR 🎧 Voice chat) is
 * currently recording, stop it first, await the transcript (it
 * lands in `prompt` via onTranscript AND is returned directly from
 * stopAndAwaitText), then fire onSend after React has flushed
 * the prompt state.
 * * the prior implementation checked `prompt` after
 * the await, but `prompt` is captured at closure-creation time
 * (Send-button click), not freshly read — when Send fires before
 * any typed text exists, the closure value is "" and the post-await
 * check fails, so onSend never runs. The transcript lands in the
 * composer but no message is sent. Fix: trust the text returned by
 * stopAndAwaitText directly. If it's non-empty, the transcript
 * has been pushed to state (via the same onTranscript callback) AND
 * we know there's content to send.
 * * Voice-chat (🎧) generalization: the prior impl only handled
 * micRef. The voice-chat button uses voiceChatRef and was silently
 * unhandled by the Send-while-recording path, leaving the user
 * stuck if they pressed Send during a 🎧 capture. Both refs feed
 * the same imperative API, so we just pick whichever is hot. Only
 * one can be recording at a time (the buttons are mutex via the
 * `disabled={anyRecording && !this-one-recording}` prop). */
  const handleSend = (): void => {
 // Voice-chat (🎧) auto-sends from its own onTranscript handler —
 // pressing Send while 🎧 is recording just needs to stop+transcribe
 // and let the auto-send chain ship the message. Firing onSend
 // again here would double-submit. So for the 🎧 path we only
 // stop the recording (the auto-send in onTranscript carries it
 // through to grok).
    if (voiceChatRef.current?.isRecording()) {
      void voiceChatRef.current.stopAndAwaitText().catch(() => {
 /* finalize already surfaced the error UX */
      });
      return;
    }
 // 🎤 Talk path: stop, await transcript, then
 // fire onSend. (Talk does NOT auto-send from onTranscript — user
 // dictates and decides when to submit.)
    if (micRef.current?.isRecording()) {
      void (async () => {
        try {
          const transcribed = await micRef.current!.stopAndAwaitText();
 // wait one microtask for the prompt state flush
          await Promise.resolve();
 // and one tick because onTranscript uses setTimeout(0) internally
          await new Promise<void>((r) => setTimeout(r, 0));
 // Send if EITHER the freshly transcribed text is non-empty
 // OR the composer already had content before recording started
 // (latter captured in the stale closure `prompt`).
          if (transcribed.trim().length > 0 || prompt.trim().length > 0) {
            onSend();
          }
        } catch {
 /* finalize already surfaced the error UX; don't fire send */
        }
      })();
      return;
    }
    onSend();
  };
 /* mirror div sits BEHIND the textarea (textarea is transparent
 * on top). The mirror re-renders the same text with `<span
 * class="slash-token">` wrappers around any leading-position `/word`
 * tokens, giving syntax highlighting that a native <textarea> can't
 * deliver. Mirror inherits ALL geometry-affecting styles via CSS so
 * the highlighted spans align pixel-perfectly with the textarea text.
 * Reference: standard "textarea + invisible mirror" pattern (used by
 * VS Code's inline input overlay). */
  const mirrorRef = useRef<HTMLDivElement | null>(null);

 // Auto-grow up to max-height (CSS-clamped to 240px).
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "0px";
    ta.style.height = `${Math.min(ta.scrollHeight, 240)}px`;
 /* mirror tracks the textarea's height so the overlay fully
 * covers the typing area even when the textarea grows. */
    if (mirrorRef.current) {
      mirrorRef.current.style.height = ta.style.height;
    }
  }, [prompt]);

 /* keep mirror's scrollTop in sync with the textarea — when the
 * user types past max-height (240px) the textarea scrolls; the mirror
 * must scroll the same amount or the highlights drift off the visible
 * text. */
  const syncMirrorScroll = () => {
    const ta = taRef.current;
    const m = mirrorRef.current;
    if (!ta || !m) return;
    m.scrollTop = ta.scrollTop;
    m.scrollLeft = ta.scrollLeft;
  };

 // detect a `#` at the caret (or `#XYZ` token being
 // typed) and open the autocomplete. Triggers on the most-recent `#`
 // before the cursor with no spaces between it and the cursor.
  const [hashOpen, setHashOpen] = useState(false);
  const [hashQuery, setHashQuery] = useState("");
  const [hashAnchor, setHashAnchor] = useState<number | null>(null);

  function recomputeHashState(value: string, cursor: number) {
    const head = value.slice(0, cursor);
    const hashIdx = head.lastIndexOf("#");
    if (hashIdx < 0) {
      setHashOpen(false);
      setHashAnchor(null);
      return;
    }
    const fragment = head.slice(hashIdx + 1);
 // Open only if there's no whitespace AFTER the # (still being typed)
 // and the `#` is at start or after a separator.
    const prev = hashIdx === 0 ? " " : head[hashIdx - 1];
    if (!/[\s(\[]/.test(prev ?? " ")) {
      setHashOpen(false);
      return;
    }
    if (/\s/.test(fragment)) {
      setHashOpen(false);
      return;
    }
    setHashOpen(true);
    setHashQuery(fragment);
    setHashAnchor(hashIdx);
  }

 /* parallel `/` autocomplete. Triggers on most-recent
 * `/` before cursor with no whitespace after it, AND the `/` is
 * at start-of-prompt or preceded by whitespace (so `mkdir /path`
 * doesn't open the popup). */
  const [slashOpen, setSlashOpen] = useState(false);
  const [slashQuery, setSlashQuery] = useState("");
  const [slashAnchor, setSlashAnchor] = useState<number | null>(null);

  function recomputeSlashState(value: string, cursor: number) {
    const head = value.slice(0, cursor);
    const slashIdx = head.lastIndexOf("/");
    if (slashIdx < 0) { setSlashOpen(false); setSlashAnchor(null); return; }
    const fragment = head.slice(slashIdx + 1);
    const prev = slashIdx === 0 ? " " : head[slashIdx - 1];
    if (!/[\s(\[]/.test(prev ?? " ")) { setSlashOpen(false); return; }
    if (/\s/.test(fragment)) { setSlashOpen(false); return; }
    setSlashOpen(true);
    setSlashQuery(fragment);
    setSlashAnchor(slashIdx);
  }

  function onChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const v = e.target.value;
    onPromptChange(v);
    const cur = e.target.selectionStart ?? v.length;
    recomputeHashState(v, cur);
    recomputeSlashState(v, cur);
  }

  function selectSlashItem(name: string) {
    if (slashAnchor == null) return;
    const ta = taRef.current;
    const cursor = ta?.selectionStart ?? prompt.length;
    const before = prompt.slice(0, slashAnchor);
    const after = prompt.slice(cursor);
    const inserted = `/${name} `;
    const next = before + inserted + after;
    onPromptChange(next);
    setSlashOpen(false);
    setSlashAnchor(null);
    setTimeout(() => {
      if (ta) {
        ta.focus();
        const pos = (before + inserted).length;
        ta.setSelectionRange(pos, pos);
      }
    }, 0);
  }

 /* Filter skills by typed query, case-insensitive prefix-first then
 * substring. Cap at 10 visible. */
  const filteredSkills = (() => {
    if (!slashOpen) return [];
    const q = slashQuery.toLowerCase();
    return skills
      .map((s) => ({ s, idx: s.name.toLowerCase().indexOf(q) }))
      .filter((x) => x.idx >= 0)
      .sort((a, b) => a.idx - b.idx || a.s.name.localeCompare(b.s.name))
      .slice(0, 10)
      .map((x) => x.s);
  })();
  const [slashActiveIdx, setSlashActiveIdx] = useState(0);
  useEffect(() => { setSlashActiveIdx(0); }, [slashQuery, slashOpen]);

  function selectHashItem(it: HashItem) {
    if (hashAnchor == null) return;
    const ta = taRef.current;
    const cursor = ta?.selectionStart ?? prompt.length;
    const before = prompt.slice(0, hashAnchor);
    const after = prompt.slice(cursor);
    const inserted = `[#${it.number}: ${it.title}](${it.url}) `;
    const next = before + inserted + after;
    onPromptChange(next);
    setHashOpen(false);
    setHashAnchor(null);
 // Restore focus + cursor after the inserted text.
    setTimeout(() => {
      if (ta) {
        ta.focus();
        const pos = (before + inserted).length;
        ta.setSelectionRange(pos, pos);
      }
    }, 0);
  }

 // 2-state autonomy chip — Confirm (default, gate every write) vs
 // Auto (bypassPermissions, write-class tools run without prompting).
 // Label matches the command palette entries in App.tsx so the same
 // mode reads identically everywhere.
  const isAutoMode = autonomy === "bypassPermissions";
  const chipLabel = isAutoMode ? "Auto" : "Confirm";
  const toggleAutonomy = () => {
    if (!onAutonomyChange) return;
    onAutonomyChange(isAutoMode ? "default" : "bypassPermissions");
  };

 // Composer is a controlled component for scope. Pill labels come
 // from props (App's activeTab state); selections fire
 // onSelectConnection / onSelectBranch / onCreateWorktree callbacks
 // up to App which calls updateActiveTab. Local state holds only
 // the popover open/closed flags.
  const [connectionPickerOpen, setConnectionPickerOpen] = useState(false);
  const [branchPickerOpen, setBranchPickerOpen] = useState(false);
 /* ConnectionEditor mounts inline. `editorInitial` undefined =
 * create new; populated = edit existing. */
  const [connectionEditorOpen, setConnectionEditorOpen] = useState(false);
  const [connectionEditorInitial, setConnectionEditorInitial] = useState<ConnectionPreset | undefined>(undefined);
 // Bumped every time a preset is saved/deleted so ConnectionPicker
 // refetches its list.
  const [presetListVersion, setPresetListVersion] = useState(0);

  const onPickConnection = (preset: ConnectionPreset) => {
    setConnectionPickerOpen(false);
 // Honor connectionLocked here too — closes a race where the user
 // opened the picker before firstMessageMs got stamped, sent a
 // message via shortcut, then clicked a row (the pill's disabled
 // state alone doesn't block this code path).
    if (connectionLocked) {
      console.info("[Composer] connection swap ignored: locked after first message");
      return;
    }
    if (onSelectConnectionExt) onSelectConnectionExt(preset);
    else console.info("[Composer] connection picked (no handler):", preset.id);
  };
  const onPickBranch = (name: string) => {
    setBranchPickerOpen(false);
    if (onSelectBranchExt) onSelectBranchExt(name);
    else console.info("[Composer] branch picked (no handler):", name);
  };
  const onCreateWorktree = (sourceBranch: string) => {
    setBranchPickerOpen(false);
    if (onCreateWorktreeExt) onCreateWorktreeExt(sourceBranch);
    else console.info("[Composer] worktree create (no handler), from:", sourceBranch);
  };

 /* drag-and-drop attach. The Files tab puts
 * the file's absolute path under the shellX MIME type
 * `application/x-shellx-file` on dragstart. The composer accepts
 * drops of that type and routes via App's processAttachedPaths so
 * the file goes through the same in-scope-copy + classify + state
 * pipeline as the dialog path. */
  const ATTACH_MIME = "application/x-shellx-file";
  const [composerDragOver, setComposerDragOver] = useState(false);
  const isShellxFileDrag = (dt: DataTransfer): boolean => {
 // dataTransfer.types is read-only during dragenter/dragover —
 // dataTransfer.getData returns empty until drop. Use the types
 // list to gate the visual highlight without exposing path bytes.
    return Array.from(dt.types).includes(ATTACH_MIME);
  };

  return (
    <div className="prompt">
      <div
        className={`composer${composerDragOver ? " drag-over" : ""}`}
        onDragOver={(e) => {
          if (!isShellxFileDrag(e.dataTransfer)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
          if (!composerDragOver) setComposerDragOver(true);
        }}
        onDragLeave={(e) => {
          const rel = e.relatedTarget as Node | null;
          if (!rel || !(e.currentTarget as Node).contains(rel)) {
            if (composerDragOver) setComposerDragOver(false);
          }
        }}
        onDrop={(e) => {
          if (!isShellxFileDrag(e.dataTransfer)) return;
          e.preventDefault();
          setComposerDragOver(false);
          const path = e.dataTransfer.getData(ATTACH_MIME);
          if (!path) return;
          if (onAttachPaths) onAttachPaths([path]);
          else console.info("[Composer] file dropped (no handler):", path);
        }}>
 {/* textarea + mirror overlay for slash-command syntax
 * highlighting. The mirror is a read-only div behind the
 * textarea that re-renders the same text with `/word` tokens
 * wrapped in <span class="slash-token">. The textarea sits on
 * top with transparent text so all editing affordances
 * (cursor, IME, paste, undo, selection) remain native — only
 * the visible character colour is supplied by the mirror.
 * Geometry styles (font, padding, line-height, width) MUST
 * match between the two; see .composer-mirror in App.css. */}
        <div className="composer-input-wrap" style={{ position: "relative" }}>
          <div
            ref={mirrorRef}
            className="composer-input composer-mirror"
            aria-hidden="true"
          >
            {highlightSlashTokens(prompt)}
          </div>
          <textarea
            ref={taRef}
            className="composer-input composer-input-transparent"
            placeholder="Ask shellX — @ to mention files, / for slash-commands, # for PR/issue"
            value={prompt}
            onChange={onChange}
            onScroll={syncMirrorScroll}
            onKeyDown={(e) => {
 // slash autocomplete handles its own keys.
            if (slashOpen && filteredSkills.length > 0) {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setSlashActiveIdx((i) => Math.min(filteredSkills.length - 1, i + 1));
                return;
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                setSlashActiveIdx((i) => Math.max(0, i - 1));
                return;
              }
              if (e.key === "Enter" || e.key === "Tab") {
                e.preventDefault();
                const pick = filteredSkills[slashActiveIdx];
                if (pick) selectSlashItem(pick.name);
                return;
              }
              if (e.key === "Escape") { e.preventDefault(); setSlashOpen(false); return; }
            }
 // Let the # autocomplete handle keys first.
            if (hashOpen && (e.key === "ArrowUp" || e.key === "ArrowDown" ||
                e.key === "Enter" || e.key === "Tab" || e.key === "Escape")) {
              if (e.key === "Enter") { e.preventDefault(); return; }
              if (e.key === "Escape") { e.preventDefault(); setHashOpen(false); return; }
              return;
            }
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
 // route through handleSend so Enter-while-
 // recording also does stop+transcribe+send.
              handleSend();
            }
            if (e.key === "c" && e.ctrlKey && isSending) {
              e.preventDefault();
              onAbort();
            }
          }}
          rows={1}
        />
        </div>

 {/* Action row: attach + autonomy chip + status + mic + send. */}
        <div className="composer-action">
          <button
            type="button"
            className="attach-btn"
            title="Attach file (⌘U) — image, PDF, code, anything"
            onClick={onAttach}
            disabled={!onAttach}
          >
            <span className="plus">+</span>
            <span>Attach</span>
          </button>
          <button
            type="button"
            className="attach-btn"
            title="Attach a screenshot of this shellX window"
            onClick={onAttachScreenshot}
            disabled={!onAttachScreenshot}
          >
            <span className="plus">▣</span>
            <span>Screen</span>
          </button>

 {/* IDLE/CONNECTED status pill. Autonomy-chip moved to the
              scope-row (after BranchPicker) per the 2026-05-21 UX
              tweak — it sits with the other operator-mode buttons now,
              not in the action row. */}
          <span className="pill status-pill" title={connected ? "Connected to grok session" : "No active session"}>
            <span className={`pd ${connected ? "ok" : "idle"}`} />
            <span className="pill-label">{connected ? "CONNECTED" : "IDLE"}</span>
          </span>
          {voiceWarning && (
            <span className="voice-warning-chip" title={voiceWarning}>
              {voiceWarning}
            </span>
          )}

 {/* No inline model picker yet — model selection is via the
 * Settings modal until the inline picker ships. */}

          <span className="a-spacer" />

 {/* Keyboard hints collapsed into an inline `?` pill. The
 * popover renders via portal so the composer-actions flex
 * row doesn't lay out its children horizontally and the
 * bottom-panel's overflow:hidden ancestor doesn't clip. */}
          <HintPill />


 {/* #355: TWO rounded labeled voice buttons,
 * exclusive while recording. 🎤 Talk = STT-only dictation;
 * 🎧 Voice chat = STT + flips the voice-chat session flag
 * so subsequent prompts ask grok to answer conversationally.
 * `disabled={anyRecording && !this-one-recording}` makes them
 * mutually exclusive — only one can be hot at a time. */}
          <MicButton
            ref={micRef}
            mode="talk"
            label="Talk"
            onRecordingChange={setMicRecording}
            disabled={!connected || isSending || voiceChatRecording}
            onTranscript={(text) => {
              const ta = taRef.current;
              if (ta) {
                const sel = ta.selectionStart ?? prompt.length;
                const end = ta.selectionEnd ?? sel;
                const before = prompt.slice(0, sel);
                const after = prompt.slice(end);
                const pad = before.length > 0 && !/\s$/.test(before) ? " " : "";
                const next = before + pad + text + after;
                onPromptChange(next);
                setTimeout(() => {
                  ta.focus();
                  const pos = (before + pad + text).length;
                  ta.setSelectionRange(pos, pos);
                }, 0);
              } else {
                onPromptChange((prompt.length > 0 && !/\s$/.test(prompt) ? prompt + " " : prompt) + text);
              }
            }}
          />
          <MicButton
            ref={voiceChatRef}
            mode="voice-chat"
            label={voiceChatMode ? "Voice chat · ON" : "Voice chat"}
            onBeforeStart={guardVoiceStart}
            onRecordingChange={(rec) => {
              setVoiceChatRecording(rec);
 // Pressing the voice-chat mic flips the session-wide
 // mode on. (User can turn it off via /goal/abort or by
 // restarting the tab; a future build adds an explicit
 // toggle.) The mode persists across prompts so a
 // conversation feels continuous.
              if (rec) writeVoiceChatMode(true);
            }}
            disabled={!connected || isSending || micRecording}
            onTranscript={(text) => {
 // 🎧 voice-chat is round-trip mode: insert text into the
 // composer AND auto-fire onSend so a single click on the
 // mic both stops recording and submits. Without this,
 // users had to press Send (a 3rd click) to actually
 // ship the transcript — defeating the "voice chat"
 // promise. 🎤 Talk keeps the manual-Send semantics
 // (dictation; user picks when to send).
              const ta = taRef.current;
              if (ta) {
                const sel = ta.selectionStart ?? prompt.length;
                const end = ta.selectionEnd ?? sel;
                const before = prompt.slice(0, sel);
                const after = prompt.slice(end);
                const pad = before.length > 0 && !/\s$/.test(before) ? " " : "";
                const next = before + pad + text + after;
                onPromptChange(next);
                setTimeout(() => {
                  ta.focus();
                  const pos = (before + pad + text).length;
                  ta.setSelectionRange(pos, pos);
                }, 0);
              } else {
                onPromptChange((prompt.length > 0 && !/\s$/.test(prompt) ? prompt + " " : prompt) + text);
              }
 // Defer onSend until React flushes the prompt state
 // pushed by onPromptChange. Two ticks: the first allows
 // the parent's setState to commit; the second lets the
 // setTimeout(0) cursor-position chain above run before
 // we trigger send (send reads promptRef.current which
 // is updated by the App-level promptRef sync on the
 // same render).
              if (text.trim().length > 0) {
                setTimeout(() => onSend(), 50);
              }
            }}
          />
 {/* #415 voice chat off-toggle. The mic itself starts a NEW
              recording on click — it never turns the round-trip mode
              off. Once enabled, users had no way to stop TTS-back
              without restarting the tab (live feedback 2026-05-21).
              This sibling chip is rendered only when mode is ON and
              flips it OFF in one click. */}
          {voiceChatMode && (
            <button
              type="button"
              className="voice-off-chip"
              onMouseDown={(e) => {
                e.preventDefault();
                e.stopPropagation();
              }}
              onClick={() => {
                voiceChatRef.current?.cancel();
                setVoiceChatRecording(false);
                writeVoiceChatMode(false);
              }}
              title="Turn voice chat off"
              aria-label="Turn voice chat off and cancel active listening"
            >
              ✕
            </button>
          )}

          <button
            type="button"
            className="send-btn"
            onClick={isSending ? onAbort : handleSend}
 // while mic is recording, the Send button is
 // enabled even with empty prompt — its job is to stop the
 // recording AND send the transcribed text. Without this,
 // user couldn't tap Send first time before any text exists.
            disabled={!connected || (!isSending && !anyRecording && prompt.trim() === "")}
            title={
              isSending ? "Abort (Ctrl+C)"
              : anyRecording ? "Stop mic + transcribe + send"
              : "Send (Enter)"
            }
          >
            {isSending ? "Stop" : anyRecording ? "Send 🎙" : "Send"}
          </button>
        </div>

 {/* SCOPE row reordered to
 * connection · folder · branch — pick the location first
 * (Windows / WSL / SSH), then the folder. Mental model: you
 * decide where the session lives before you decide which
 * folder it operates against. (B will add the
 * full "folder browse disabled until remote is connected"
 * enforcement; this is the visual reorder only.) */}
        <div className="composer-scope">
          <div style={{ position: "relative" }}>
            <button
              type="button"
              className={`scope-pill ${connectionLocked ? "locked" : ""}`}
              data-picker-anchor="connection"
              title={connectionLocked
                ? "Connection locked after first message. Open a new tab (+) to use a different transport."
                : "Pick connection — Local / WSL / SSH / Tailscale"}
              onClick={() => { if (!connectionLocked) setConnectionPickerOpen((v) => !v); }}
              disabled={connectionLocked}
            >
              <span className="sico">{scopeConnectionTransport}</span>
              <span>{scopeConnection}</span>
              <span className="scaret">{connectionLocked ? "🔒" : "▾"}</span>
            </button>
            <ConnectionPicker
              key={presetListVersion}
              open={connectionPickerOpen}
              activeId={null}
              onSelect={onPickConnection}
              onEdit={(preset) => {
 // mount + open the editor with the chosen
 // preset (or undefined for "+ New"). On save, bump
 // presetListVersion to force the picker to refetch.
                setConnectionEditorInitial(preset);
                setConnectionEditorOpen(true);
                setConnectionPickerOpen(false);
              }}
              onClose={() => setConnectionPickerOpen(false)}
            />
            <ConnectionEditor
              open={connectionEditorOpen}
              initial={connectionEditorInitial}
              onSaved={(saved) => {
                setConnectionEditorOpen(false);
                setConnectionEditorInitial(undefined);
                setPresetListVersion((v) => v + 1);
 // Re-open the picker so user sees the new/updated entry.
                setConnectionPickerOpen(true);
 // Could also auto-select the saved preset — leave to user.
                void saved;
              }}
              onClose={() => {
                setConnectionEditorOpen(false);
                setConnectionEditorInitial(undefined);
              }}
            />
          </div>
 {/* folder pill moved AFTER
 * the connection pill so users pick location → folder in
 * the natural left-to-right reading order. The full
 * "disabled until remote is connected" enforcement is
 * B work (#207). */}
          <button
            type="button"
            className="scope-pill"
            title="Change project for this tab — opens a folder picker"
            onClick={() => onPickProject?.()}
            disabled={!onPickProject}
          >
            <span className="sico">📁</span>
            <span>{scopeProject}</span>
            <span className="scaret">▾</span>
          </button>
          <div style={{ position: "relative" }}>
            <button
              type="button"
              className="scope-pill"
              data-picker-anchor="branch"
              title="Pick branch — also offers +create worktree from branch"
              onClick={() => setBranchPickerOpen((v) => !v)}
            >
              <span className="sico">🌿</span>
              <span>{scopeBranch}</span>
              {typeof scopeBranchAhead === "number" && scopeBranchAhead > 0 && (
                <span className="ssub">↑{scopeBranchAhead}</span>
              )}
              <span className="scaret">▾</span>
            </button>
            <BranchPicker
              open={branchPickerOpen}
              activeName={scopeBranch}
              cwd={activeCwd}
              activeTabId={activeTabId}
              onSelect={onPickBranch}
              onCreateWorktree={onCreateWorktree}
              onClose={() => setBranchPickerOpen(false)}
            />
          </div>
 {/* Autonomy mode chip — moved here from .composer-action so
              it sits next to the scope/branch buttons in the same row.
              Height matched to scope-pill via `.scope-row .autonomy-chip`
              override in App.css. */}
          <button
            type="button"
            className={`autonomy-chip ${isAutoMode ? "danger" : ""}`}
            onClick={toggleAutonomy}
            title={
              isAutoMode
                ? "Currently Auto — grok auto-approves every tool execution. Click to switch to Confirm."
                : "Currently Confirm — grok prompts before destructive actions. Click to switch to Auto."
            }
            disabled={!onAutonomyChange}
          >
            <span className="adot" />
            <span>{chipLabel}</span>
            <span className="acaret">▾</span>
          </button>
        </div>

        <HashAutocomplete
          open={hashOpen}
          query={hashQuery}
          items={hashItems}
          onSelect={selectHashItem}
          onClose={() => setHashOpen(false)}
        />

 {/* slash command autocomplete popover. Anchored
 * above the composer; lists grok's available_commands_update
 * skills filtered by the typed query. Arrow keys + Enter
 * navigate/insert. Esc closes. */}
        {slashOpen && filteredSkills.length > 0 && (
          <div
            className="slash-pop"
            role="listbox"
            style={{
              position: "absolute",
              bottom: "100%",
              left: 0,
              right: "auto",
              minWidth: 320,
              maxWidth: 480,
              maxHeight: 320,
              overflowY: "auto",
              background: "var(--surface)",
              border: "1px solid var(--hairline)",
              borderRadius: 6,
              boxShadow: "0 8px 24px rgba(0,0,0,0.5)",
              marginBottom: 6,
              zIndex: 50,
            }}
          >
            <div style={{ fontSize: "var(--fs-ui-xs)", color: "var(--ink-3)", padding: "6px 10px", letterSpacing: "0.06em", textTransform: "uppercase", borderBottom: "1px solid var(--hairline)" }}>
              {filteredSkills.length} command{filteredSkills.length === 1 ? "" : "s"}
            </div>
            {filteredSkills.map((s, i) => (
              <div
                key={s.name}
                role="option"
                aria-selected={i === slashActiveIdx}
                onClick={() => selectSlashItem(s.name)}
                onMouseEnter={() => setSlashActiveIdx(i)}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 2,
                  padding: "6px 10px",
                  cursor: "pointer",
                  background: i === slashActiveIdx ? "var(--hairline)" : "transparent",
                }}
              >
                <span style={{ fontFamily: "var(--mono)", fontSize: "var(--fs-ui-sm)", color: "var(--ink)" }}>/{s.name}</span>
                {s.description && (
                  <span style={{ fontSize: "var(--fs-ui-xs)", color: "var(--ink-3)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {s.description}
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

 {/* old `.prompt-hint` row removed.
 * Keyboard hints now live in the inline `?` popover next to the
 * mic/send buttons (above). Saves ~30 px of vertical space and
 * keeps the meta-help discoverable on demand. */}
    </div>
  );
}

/* ─────────────── Terminal tab ─────────────── */

function TerminalPlaceholder(): JSX.Element {
  return (
    <div className="tab-placeholder">
      Open a session tab to get a shell. The Terminal binds to the active
      tab so each session has its own PTY; without a tab there's no home
      for the PTY.
    </div>
  );
}

/**
 * terminal surface for the bottom panel. Shows a small tab
 * strip with the user shell first, then one tab per ACP-origin PTY
 * grok has spawned via `terminal/create`. Selecting an ACP tab mounts
 * a read-write attached <TerminalView/> so the user can watch and
 * optionally interact with the agent's shell.
 * * `terminal-opened` events come from the Rust `acp_create` helper.
 * They include the terminalId minted by the TerminalRegistry plus a
 * truncated command preview to label the tab.
 */
interface AcpTerminalRef {
  terminalId: string;
  label: string;
}

function BottomTerminalSurface({
  sessionTabId,
}: {
  sessionTabId: string;
}): JSX.Element {
 // List of ACP-origin terminals associated with the current session.
 // Each one becomes a tab in the strip. We don't proactively remove
 // them on `terminal/release` — grok already saw the bytes and the
 // user may still want to scroll the xterm.js buffer. Press the [x]
 // button to dismiss a closed tab.
  const [acpTerms, setAcpTerms] = useState<AcpTerminalRef[]>([]);
  const [active, setActive] = useState<string>("user");

  useEffect(() => {
    let unl: UnlistenFn | null = null;
    let disposed = false;
    interface OpenedPayload {
      tabId: string;
      terminalId: string;
      origin: string;
      command: string;
      args?: string[];
    }
    (async () => {
      unl = await listen<OpenedPayload>("terminal-opened", (evt) => {
        const p = evt.payload;
 // Only react to terminals for our session tab.
        if (p.tabId !== sessionTabId) return;
        if (disposed) return;
 // Label uses the program + first arg for compact tab text.
        const label = (p.args && p.args.length > 0
          ? `${p.command} ${p.args[0]}`
          : p.command).slice(0, 24);
        setAcpTerms((prev) =>
          prev.some((t) => t.terminalId === p.terminalId)
            ? prev
            : [...prev, { terminalId: p.terminalId, label }],
        );
      });
    })();
    return () => {
      disposed = true;
      if (unl) unl();
    };
  }, [sessionTabId]);

 // When the session tab changes (different chat tab selected) reset.
  useEffect(() => {
    setAcpTerms([]);
    setActive("user");
  }, [sessionTabId]);

  function dismiss(terminalId: string) {
    setAcpTerms((prev) => prev.filter((t) => t.terminalId !== terminalId));
    setActive("user");
  }

  return (
    <div className="terminal-surface" style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {acpTerms.length > 0 && (
        <div
          className="terminal-substrip"
          style={{
            display: "flex",
            gap: 6,
            padding: "4px 8px",
            borderBottom: "1px solid rgba(255,255,255,0.08)",
            fontSize: "var(--fs-ui-xs)",
            color: "var(--ink-2)",
          }}
        >
          <button
            type="button"
            className={`substrip-tab ${active === "user" ? "active" : ""}`}
            onClick={() => setActive("user")}
            style={tabStyle(active === "user")}
          >
            shell
          </button>
          {acpTerms.map((t) => (
            <span key={t.terminalId} style={{ display: "inline-flex", alignItems: "center" }}>
              <button
                type="button"
                className={`substrip-tab ${active === t.terminalId ? "active" : ""}`}
                onClick={() => setActive(t.terminalId)}
                style={tabStyle(active === t.terminalId)}
                title={`ACP terminal ${t.terminalId}`}
              >
                <span style={{
                  background: "rgba(120,180,255,0.18)",
                  color: "#8fbcff",
                  fontSize: 9,
                  padding: "0 4px",
                  marginRight: 4,
                  borderRadius: 2,
                  letterSpacing: 0.5,
                }}>ACP</span>
                {t.label}
              </button>
              <button
                type="button"
                aria-label="close terminal tab"
                onClick={() => dismiss(t.terminalId)}
                style={{
                  marginLeft: 2,
                  background: "none",
                  border: "none",
                  color: "var(--ink-3)",
                  cursor: "pointer",
                  padding: "0 4px",
                }}
              >×</button>
            </span>
          ))}
        </div>
      )}
      <div style={{ flex: 1, minHeight: 0 }}>
        {active === "user"
          ? <TerminalTab tabId={sessionTabId} />
          : (() => {
              const t = acpTerms.find((x) => x.terminalId === active);
              if (!t) return <TerminalTab tabId={sessionTabId} />;
              return (
                <TerminalView
                  tabId={sessionTabId}
                  terminalId={t.terminalId}
                  attachOnly
                  readOnly={false}
                />
              );
            })()}
      </div>
    </div>
  );
}

function tabStyle(isActive: boolean): React.CSSProperties {
  return {
    background: isActive ? "rgba(255,255,255,0.08)" : "transparent",
    border: "1px solid rgba(255,255,255,0.08)",
    borderRadius: 3,
    color: isActive ? "var(--ink)" : "var(--ink-2)",
    cursor: "pointer",
    fontSize: "var(--fs-ui-xs)",
    padding: "2px 8px",
  };
}

/* ─────────────── Logs tab ─────────────── */

function LogsView({ events }: { events: RawEventFrame[] }): JSX.Element {
 // Show last 500 events. Auto-scroll to bottom on new events.
  const endRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "auto", block: "end" });
  }, [events.length]);
  const slice = events.slice(-500);
  return (
    <div className="logs-body">
      {slice.length === 0 && (
        <div className="tab-placeholder" style={{ padding: 0 }}>
          No events yet. Connect a session.
        </div>
      )}
      {slice.map((e, i) => (
        <div key={i} className="logs-line">
          <span className="lk">[{e.kind}]</span>
          <span className="lp">{summarize(e)}</span>
        </div>
      ))}
      <div ref={endRef} />
    </div>
  );
}

/* ─────────────── Stderr tab ─────────────── */

function StderrView({ events }: { events: RawEventFrame[] }): JSX.Element {
  const lines = events
    .filter((e) => e.kind === "grok-stderr")
    .slice(-500)
    .map((e) => String((e.payload as any)?.line ?? ""));
  if (lines.length === 0) {
    return (
      <div className="tab-placeholder">
        No stderr lines. (Stable session = clean stderr.)
      </div>
    );
  }
  return (
    <div className="stderr-body">
      {lines.map((line, i) => (
        <div key={i} className="stderr-line">{line}</div>
      ))}
    </div>
  );
}

function summarize(e: RawEventFrame): string {
  if (typeof e.payload === "string") return e.payload;
  if (e.payload && typeof e.payload === "object") {
    const p = e.payload as any;
    const m = p.method ?? p.params?.update?.sessionUpdate ?? "";
    const sid = p.params?.sessionId;
    const tag = m ? `${m}` : JSON.stringify(p).slice(0, 100);
    return sid ? `${tag} · ${sid.slice(0, 12)}…` : tag;
  }
  return String(e.payload);
}

/**
 * `?` pill that lists keyboard
 * shortcuts on hover/focus. The popover renders through a portal at
 * document.body so the composer-actions flex layout doesn't collapse
 * its children into a single row, and so the bottom-panel
 * overflow:hidden ancestor doesn't clip the popover that floats UP
 * above the button.
 * * Positioning: anchored to the pill's bounding rect via
 * getBoundingClientRect; recomputed on scroll, resize, and every
 * mount. `position: fixed` so scrolling the chat doesn't drag it.
 */
function HintPill(): JSX.Element {
  const pillRef = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState<{ left: number; top: number } | null>(null);
  const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
  const C = isMac ? "⌘" : "Ctrl+";

 // Compute anchored coords every time we open OR the viewport scrolls.
  const recompute = () => {
    const el = pillRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
 // Popover is right-aligned to the pill, floats above with 10 px gap.
 // We just set top + LEFT-ANCHOR-OF-RIGHT-EDGE; CSS uses `right: …`
 // via transform translateX(-100%) on a placeholder, but simpler:
 // anchor the popover's RIGHT edge to the pill's right edge.
    setCoords({ left: r.right, top: r.top });
  };

  useLayoutEffect(() => {
    if (!open) return;
    recompute();
    const onScroll = () => recompute();
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", recompute);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", recompute);
    };
  }, [open]);

  return (
    <>
      <button
        ref={pillRef}
        type="button"
        className="hint-pill"
        aria-label="Keyboard shortcuts"
        title="Keyboard shortcuts"
        tabIndex={-1}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
      >
        ?
      </button>
      {open && coords && createPortal(
        <div
          className="hint-popover-portal"
          role="tooltip"
          style={{
            position: "fixed",
 // Anchor popover's RIGHT edge to pill's right edge,
 // popover floats ABOVE with 10 px gap.
            left: coords.left,
            top: coords.top - 10,
            transform: "translate(-100%, -100%)",
            zIndex: 9999,
          }}
        >
          <div className="hint-line"><kbd>⏎</kbd> send</div>
          <div className="hint-line"><kbd>⇧⏎</kbd> newline</div>
          <div className="hint-line"><kbd>{C}K</kbd> palette</div>
          <div className="hint-line"><kbd>{C}T</kbd> new tab</div>
          <div className="hint-line"><kbd>{C}`</kbd> terminal</div>
          <div className="hint-line"><kbd>{C}U</kbd> attach</div>
          <div className="hint-line"><kbd>@</kbd> file · <kbd>#</kbd> PR/issue · <kbd>/</kbd> command</div>
          <div className="hint-line"><kbd>?</kbd> shortcuts</div>
        </div>,
        document.body,
      )}
    </>
  );
}
