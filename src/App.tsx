/**
 * src/App.tsx — top-level grok-shell layout.
 * * Layout:
 * ┌──────────────────────── top header ─────────────────────────┐
 * │ brand · cwd · spacer · autonomy · token gauge · ⚙           │
 * ├─────────┬──────────────────────────────────┬────────────────┤
 * │ left    │ session tabs                     │ right tabs     │
 * │ rail    ├──────────────────────────────────┤ Plan / Preview │
 * │ (proj/  │ masthead                         │                │
 * │  past   │ output (chat bubbles + tools)    │                │
 * │  chats) ├──────────────────────────────────┤                │
 * │         │ bottom tabs (Chat/Term/Media/Log)│                │
 * │         │ prompt input                     │                │
 * └─────────┴──────────────────────────────────┴────────────────┘
 * * react-resizable-panels handles the horizontal + vertical divisions;
 * sizes persist to localStorage and mirror to /panels for the debug driver.
 * * The `events[]` array is the single source of truth for chat content;
 * `groupEvents` folds it into chat-bubble groups consumed by ChatOutput.
 * RawLog is still the unfiltered verification surface in the Logs tab.
 * * Keyboard shortcuts: registry in `src/lib/shortcuts.ts`; HelpModal and
 * App.tsx both read from it. Bindings wired here:
 * ?            help
 * Esc          close any modal
 * ⌘K / Ctrl+K  command palette
 * ⌘T / ⌘W      new / close session tab
 * ⌘U           attach file picker
 * ⌘`           toggle Chat ↔ Terminal in bottom panel
 * ⌘,           open settings
 * ⇧Tab         cycle autonomy mode
 * j/k/y/n/e    per-hunk diff nav (handled inside ChatOutput)
 * * File attach: picker, OS drag/drop, pasted clipboard images/files, and
 * screenshots all route through the same classifier. Text files ≤64 KB inline
 * as embedded_context; images are recorded as thumbnail intent. The composer
 * shows removable chips while the wire prompt still gets `[attached: <path>]`
 * markers until grok advertises promptCapabilities.image.
 * * Sessions persist to ~/.shellx/sessions/<id>.jsonl one line per event;
 * Tauri command for the writer, debug-api for the read side.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";

import "./App.css";

import { Header, type AutonomyMode } from "./components/Header";
import type { ChatHit } from "./components/FindPopover";
import { LeftRail } from "./components/LeftRail";
import { ChatOutput } from "./components/ChatOutput";
import {
  BottomPanel,
  readPersistedBottomTab,
  type BottomTab,
  type ComposerAttachmentKind,
  type ComposerAttachmentChip,
} from "./components/BottomPanel";
import { RightRail, type PreviewTarget, type RightTab } from "./components/RightRail";
import { PreviewCenter } from "./components/PreviewCenter";
import { AttachmentMediaBoard } from "./components/AttachmentMediaBoard";
import { SessionTabs, type SessionTab } from "./components/SessionTabs";
import { HelpModal } from "./components/HelpModal";
import { CommandPalette, type PaletteAction } from "./components/CommandPalette";
import { PRCreateModal } from "./components/PRCreateModal";
// Synchronous Confirm-mode gate for `terminal/create`. Mounted
// unconditionally — visibility is driven by `permission-request` events
// from acp.rs.
import { PermissionModal } from "./components/PermissionModal";
import { VaultPanel } from "./components/VaultPanel";
import { UpdateBanner } from "./components/UpdateBanner";
import { PluginsModal } from "./components/PluginsModal";
import { ConnectorInboxModal } from "./components/ConnectorInboxModal";
import { TAB_KEY as SETTINGS_TAB_KEY } from "./components/Settings";
import { hydrateUserData, persistUserData } from "./lib/userStore";
import { ActivityBrowserModal } from "./components/ActivityBrowserModal";
import { BuiltinDocModal } from "./components/BuiltinDocModal";
import { GoalPlanReviewModal } from "./components/GoalPlanReviewModal";
import { ShellIcon } from "./components/icons";
import type { HashItem } from "./components/HashAutocomplete";
import {
  Settings,
  readSettingsLocal,
  normalizeSettings,
  applyTheme,
  persistSettings,
  DEFAULT_SETTINGS,
  type SettingsValues,
} from "./components/Settings";
import { useKeyboardShortcuts } from "./lib/shortcuts";
import { api, apiPost, apiPostJson, debugApiBase, getDebugToken } from "./lib/debug-api";
import { inTauri } from "./lib/tauri-bridge";
import { groupEvents } from "./lib/grouping";
import { extractSessionAttachments, extractSessionMedia } from "./lib/session-media";
import { PendingLocalEventQueue, localEventTabId } from "./lib/pending-local-events";
import { extractAssistantTurnAfterIndex, getVoiceTurnToSpeak } from "./lib/voice-chat";
import { getBuildState, isBuildTerminalStatus, parseBuildCommand, startBuildMode } from "./lib/build-run";
import {
  clearWorkPreviewBrowserEvents,
  diagnoseWorkPreview,
  emptyWorkPreviewState,
  getWorkPreviewBrowserEvents,
  getWorkPreviewState,
  startWorkPreview,
  workPreviewKindLabel,
  workPreviewStatusLabel,
  type WorkPreviewDiagnostic,
  type WorkPreviewState,
} from "./lib/work-preview";
import { resolvePreviewRoute, type PreviewCenterView } from "./lib/preview-center";
import {
  summarizeOutsideConnectorInbox,
  type OutsideConnector,
  type OutsideConnectorEvent,
  type OutsideConnectorInboxSummary,
} from "./lib/outside-connectors";
import type { AcpCommand, RawEventFrame } from "./types/acp";

type Status = "Idle" | "Starting" | "Connected" | "Aborting" | "Error";

// Tauri channels — allow-list consumed by the listener useEffect below.
// DO NOT add "session-update" (causes dup events).
const TAURI_CHANNELS = [
  "grok-acp-event",
  "tool-call",
  "grok-stderr",
  "session-aborted",
  "session-ended",
  "permission-request",
  "grok-extension",
  "max-context-detected",
  // Typed re-emit for EnterPlanMode / current_mode_update so the RightRail
  // Plan tab has a clean source independent of the generic firehose.
  "plan-event",
  // grok's initialize response — agentCapabilities dict. Re-emitted so the
  // attach pipeline can flip to binary image bytes once grok ships
  // promptCapabilities.image=true.
  "agent-capabilities",
  // Typed lifecycle events consumed by the inline status UI and
  // auth-unhealthy banner. Required for `listen()` to fire — the allow-list
  // here is the only subscription path.
  "prompt-complete",
  "auth-unhealthy",
  "build-event",
] as const;

const PANEL_SIZE_KEY_H = "grok-shell.panels.horizontal";
const PANEL_SIZE_KEY_V = "grok-shell.panels.vertical";
// localStorage namespace keys. Hoisted out of the App body so they don't
// re-allocate every render.
const PROJECTS_KEY = "shellX.projects.v1";
const SESSIONS_KEY = "grok-shell.session-tabs.v2";
/* Cache for grok's available_commands_update so the slash-autocomplete
 * popup populates immediately on startup, before the live grok session
 * has sent its first update. Refreshed on every available_commands_update. */
const SKILLS_CACHE_KEY = "shellX.skills.v1";
const VOICE_OWNER_KEY = "shellx.voiceChatMode.activeTab";
const VOICE_KEY_PREFIX = "shellx.voiceChatMode.";
const CONNECTOR_INBOX_SEEN_KEY = "shellx.connectorInbox.lastSeenMs.v1";
const DROPPED_ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;

interface PendingTextAttachment {
  path: string;
  content: string;
  mimeType: string;
}

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("file read failed"));
    reader.onload = () => {
      const value = typeof reader.result === "string" ? reader.result : "";
      const comma = value.indexOf(",");
      resolve(comma >= 0 ? value.slice(comma + 1) : value);
    };
    reader.readAsDataURL(file);
  });
}

const RIGHT_TAB_IDS: ReadonlySet<string> = new Set(["Tasks", "Tooling", "Git", "Preview", "Plan", "Files"]);
const BOTTOM_TAB_IDS: ReadonlySet<string> = new Set(["Chat", "Terminal", "Images", "Videos", "Logs", "Stderr"]);

function isRightTab(value: unknown): value is RightTab {
  return typeof value === "string" && RIGHT_TAB_IDS.has(value);
}

function isBottomTab(value: unknown): value is BottomTab {
  return typeof value === "string" && BOTTOM_TAB_IDS.has(value);
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  const mb = bytes / (1024 * 1024);
  if (mb >= 1) return `${mb.toFixed(mb >= 10 ? 0 : 1)} MB`;
  return `${(bytes / 1024).toFixed(0)} KB`;
}

function attachmentLabelFromPath(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  return normalized.split("/").filter(Boolean).pop() || path;
}

function attachmentChipId(path: string): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}-${path}`;
}

function appendUniqueTextAttachments(
  existing: PendingTextAttachment[],
  incoming: PendingTextAttachment[],
): PendingTextAttachment[] {
  if (incoming.length === 0) return existing;
  const seen = new Set(existing.map((item) => item.path));
  const unique = incoming.filter((item) => {
    if (seen.has(item.path)) return false;
    seen.add(item.path);
    return true;
  });
  return unique.length > 0 ? [...existing, ...unique] : existing;
}

function attachmentWireTag(attachment: ComposerAttachmentChip): string {
  if (attachment.kind === "image") {
    return `[attached image: ${attachment.path}; inspect with vision_describe, not read_file]`;
  }
  return `[attached: ${attachment.path}]`;
}

function previewRepairPrompt(diagnostic: WorkPreviewDiagnostic): string {
  const issueLines = diagnostic.issues.length > 0
    ? diagnostic.issues
        .slice(0, 20)
        .map((issue, index) => `${index + 1}. [${issue.severity}/${issue.source}] ${issue.message}`)
        .join("\n")
    : "No explicit Preview Doctor issues were recorded, but the user asked for a preview repair pass.";
  const browserLines = diagnostic.browserEvents.length > 0
    ? diagnostic.browserEvents
        .slice(-12)
        .map((event, index) => `${index + 1}. [${event.level}] ${event.message}${event.source ? ` (${event.source})` : ""}`)
        .join("\n")
    : "No browser console/runtime events were captured by shellX.";
  const logLines = diagnostic.logs.length > 0
    ? diagnostic.logs
        .slice(-40)
        .map((line) => `[${line.stream}] ${line.line}`)
        .join("\n")
    : "No preview process logs were captured.";

  return [
    "Preview Doctor found a problem or the user requested a preview repair pass.",
    "",
    "Please fix the app/page so it renders correctly in shellX Work Preview. If a screenshot path is present, inspect it with vision_describe before deciding the UI is visually correct. After changing files, restart or refresh the preview and verify it visually before saying it is fixed.",
    "",
    "Preview context:",
    `- status: ${diagnostic.status}`,
    `- url: ${diagnostic.url ?? "(none)"}`,
    `- cwd: ${diagnostic.cwd ?? "(unknown)"}`,
    `- command: ${diagnostic.command ?? "(none)"}`,
    `- kind: ${workPreviewKindLabel(diagnostic.state.kind)}`,
    `- HTTP status: ${diagnostic.httpStatus ?? "(not fetched)"}`,
    `- response bytes: ${diagnostic.responseBytes ?? "(unknown)"}`,
    `- page title: ${diagnostic.title ?? "(none)"}`,
    `- screenshot: ${diagnostic.screenshotPath ?? "(not captured)"}`,
    `- screenshot viewport: ${
      diagnostic.screenshotWidth && diagnostic.screenshotHeight
        ? `${diagnostic.screenshotWidth}x${diagnostic.screenshotHeight}`
        : "(unknown)"
    }`,
    `- screenshot browser: ${diagnostic.screenshotBrowser ?? "(unknown)"}`,
    `- screenshot error: ${diagnostic.screenshotError ?? "(none)"}`,
    "",
    "Issues:",
    issueLines,
    "",
    "Browser/runtime events:",
    browserLines,
    "",
    "Preview logs:",
    logLines,
  ].join("\n");
}

interface TabEntry {
  /** Local tab id (uuid-ish). Distinct from grok's sessionId — the tab
   * adopts the live sessionId once one shows up. */
  tabId: string;
  /** grok session id once known. */
  sessionId: string | null;
  title: string;
  cwd: string;
  autonomy: AutonomyMode;
  /** Project name shown in the SCOPE row Project pill. */
  projectId?: string;
  /** Connection preset id (from connections.json). null = Local default. */
  connectionId?: string | null;
  /** Display label in the Connection pill — "Local", etc. */
  connectionLabel?: string;
  /** Transport-icon emoji on the session tab + connection pill. */
  connectionTransport?: string;
  /** Branch name displayed in the Branch pill. */
  branchName?: string;
  /** Ahead-count shown as ↑N badge on the Branch pill. */
  branchAhead?: number;
  /** Set on first user prompt sent through this tab. Locks the
   * connection pill — once a grok subprocess is bound to this tab,
   * transport can't change mid-session; user must open a new tab. */
  firstMessageMs?: number;
  /** True once the user has explicitly renamed this tab. Subsequent
   * `session_summary_generated` events from grok must not overwrite
   * it. Persists via SESSIONS_KEY localStorage. */
  titleLocked?: boolean;
  /** Per-tab Preview state. PreviewTarget shape is
   * { kind: "file" | "url"; path }. */
  preview?: PreviewTarget;
  /** Per-tab connection lifecycle status. Idle = no grok yet,
   * Starting = spawn in flight, Connected = grok responding,
   * Aborting = abort sent, Error = last command errored. */
  status?: Status;
  /** Per-tab prompt-in-flight flag. Toggles composer Send/Stop. */
  isSending?: boolean;
}

interface SessionConnectionMeta {
  connectionId?: string | null;
  connectionLabel?: string;
  connectionTransport?: string;
}

function newTabEntry(cwd: string, autonomy: AutonomyMode): TabEntry {
  // Cheap uuid — collision risk is irrelevant for a per-app tab id.
  const id = "tab-" + Math.random().toString(36).slice(2, 10);
  return {
    tabId: id,
    sessionId: null,
    title: "new session",
    cwd,
    autonomy,
    // Defaults: each tab starts on Local with no project or branch yet.
    projectId: undefined,
    connectionId: null,
    connectionLabel: "Local",
    connectionTransport: "local",
    branchName: undefined,
    branchAhead: undefined,
  };
}

function restorePersistedTabEntry(tab: TabEntry): TabEntry {
  return {
    ...tab,
    autonomy: tab.autonomy === "default"
      ? "bypassPermissions"
      : tab.autonomy,
    // These fields describe the current renderer/backend process, not
    // durable chat history. Persisting "Connected" across app restart
    // makes send() skip auto-connect and the backend returns
    // "No active session" for an otherwise valid reopened chat.
    status: "Idle",
    isSending: false,
  };
}

export default function App(): JSX.Element {
  // ─── Core state — events firehose + status ─────────────────────────────
  // Status is per-tab on TabEntry. Active tab's status surfaces via the
  // derived `activeTab` below.
  const [error, setError] = useState<string | null>(null);
  /* cwd defaults to empty; the bootstrap effect below fills it from
   * get_home_dir on first run. Persisted in localStorage. */
  const [cwd, setCwd] = useState<string>(() => {
    try { return localStorage.getItem("shellX.cwd.v1") ?? ""; }
    catch { return ""; }
  });
  /* Validate cwd ONCE at boot via a ref gate, so subsequent folder picks
   * don't re-run the probe + setCwd + LS rewrite and race the persist
   * effect. */
  const cwdValidated = useRef(false);
  // #435 — on app boot, copy on-disk personal-data keys (projects,
  // chat titles, session→project map, saved tabs, closed-tab history)
  // into localStorage IF localStorage doesn't already have them. This
  // is how a clean reinstall preserves user state: the on-disk file
  // at ~/.shellx/user-data.json survives, localStorage is empty, the
  // hydrate copies it in, and the UI sees its old session names +
  // projects. Runs once per page-load.
  const userDataHydrated = useRef(false);
  useEffect(() => {
    if (userDataHydrated.current) return;
    userDataHydrated.current = true;
    void hydrateUserData();
  }, []);
  useEffect(() => {
    if (cwdValidated.current) return;
    cwdValidated.current = true;
    if (!inTauri()) {
      if (!cwd) setCwd(typeof navigator !== "undefined" && /Win/.test(navigator.userAgent)
        ? "C:\\Users\\Public" : "/tmp");
      return;
    }
    let cancelled = false;
    (async () => {
      const probeOK = cwd
        ? await invoke("list_project_files", { path: cwd }).then(() => true).catch(() => false)
        : false;
      if (cancelled) return;
      if (probeOK) return; // current cwd is good — leave it alone.
      // Bad/empty cwd. Wipe stale localStorage entries pointing at it.
      try { localStorage.removeItem("shellX.cwd.v1"); } catch { /* no-op */ }
      try {
        const raw = localStorage.getItem(SESSIONS_KEY);
        if (raw) {
          const arr = JSON.parse(raw);
          if (Array.isArray(arr)) {
            const cleaned = arr.map((t: any) =>
              t && typeof t === "object" && t.cwd === cwd ? { ...t, cwd: "" } : t,
            );
            persistUserData(SESSIONS_KEY, cleaned);
          }
        }
      } catch { /* no-op */ }
      try {
        const home = await invoke<string>("get_home_dir");
        if (!cancelled && home && typeof home === "string") {
          setCwd(home);
          setTabs((prev) => prev.map((t) => ({ ...t, cwd: t.cwd || home })));
        }
      } catch { /* leave cwd empty; user picks via 📁 pill */ }
    })();
    return () => { cancelled = true; };
  }, [cwd]);
  // Persist cwd changes so the next launch starts where we left off.
  useEffect(() => {
    if (cwd) {
      try { localStorage.setItem("shellX.cwd.v1", cwd); } catch { /* no-op */ }
    }
  }, [cwd]);
  const [prompt, setPrompt] = useState<string>("");
  /**
   * Mirror of `prompt` consumed by async callbacks (for example mic-stop
   * transcribe flow) so they see the latest value rather than a
   * closure-captured stale one. Reading via `.current` is always current
   * at invocation time, regardless of which render created the function.
   */
  const promptRef = useRef<string>("");
  useEffect(() => { promptRef.current = prompt; }, [prompt]);

  /**
   * Header badge: count of running grok subprocesses + host-MCP
   * subagents. Polls `list_background_tasks` every 2 s and counts rows
   * with `origin ∈ {"grok","host_mcp"}` AND `status === "running"`.
   * Stops polling after 3 consecutive errors (browser-only / Rust panic)
   * so we don't spam.
   */
  const [liveGrokCount, setLiveGrokCount] = useState<number>(0);
  useEffect(() => {
    let cancelled = false;
    let consecutiveErrors = 0;
    const tick = async (): Promise<void> => {
      try {
        const rows = await invoke<Array<{ origin: string; status: string }>>(
          "list_background_tasks",
        );
        if (cancelled) return;
        const n = rows.filter(
          (r) => (r.origin === "grok" || r.origin === "host_mcp") && r.status === "running",
        ).length;
        setLiveGrokCount(n);
        consecutiveErrors = 0;
      } catch {
        consecutiveErrors += 1;
      }
    };
    void tick();
    const id = window.setInterval(() => {
      if (consecutiveErrors > 3) return;
      void tick();
    }, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);
  /**
   * Pending text-file inlines for the active composer. Each entry is
   * one file the user attached that classified as text on the Rust
   * sniff side. `send()` consumes the array and ships it as
   * `embeddedContext` to the Tauri `send_prompt` command. Binary and
   * image files don't appear here — they use the `[attached: <path>]`
   * tag-only path.
   */
  const [pendingAttachments, setPendingAttachments] = useState<PendingTextAttachment[]>([]);
  const [pendingAttachmentChips, setPendingAttachmentChips] = useState<ComposerAttachmentChip[]>([]);
  /**
   * Last-seen agentCapabilities dict from grok's initialize response.
   * Shape: { promptCapabilities: { image, embeddedContext, audio, ... } }.
   * Behavior doesn't change yet (image=false); we log on flip so the
   * binary-image path can be enabled when grok ships support.
   */
  const [agentCaps, setAgentCaps] = useState<Record<string, unknown> | null>(null);
  const [events, setEvents] = useState<RawEventFrame[]>([]);
  const eventsLenRef = useRef(0);
  useEffect(() => { eventsLenRef.current = events.length; }, [events.length]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const activeSessionIdRef = useRef<string | null>(null);
  useEffect(() => { activeSessionIdRef.current = activeSessionId; }, [activeSessionId]);

  /* Per-tab pre-fetched plan.md cache. On `plan-event` with
   * `kind === "enter_plan_mode"` we invoke `read_text_file_for_path`
   * immediately and stash the result here, so PlanPane has content ready
   * before its first render rather than waiting for its own effect deps
   * to change. Per-tab Map keeps multi-session correctness — switching
   * tabs never flashes a neighbor's plan. */
  const [planTextByTab, setPlanTextByTab] = useState<Map<string, string>>(
    () => new Map(),
  );
  const [rightRailRequest, setRightRailRequest] = useState<{ tab: RightTab; seq: number } | null>(null);
  const [workPreviewByTab, setWorkPreviewByTab] = useState<Map<string, WorkPreviewState>>(
    () => new Map(),
  );
  const [previewCenterOpen, setPreviewCenterOpen] = useState(false);
  const [previewCenterView, setPreviewCenterView] = useState<PreviewCenterView>("file");
  const [assetBoardOpen, setAssetBoardOpen] = useState(false);
  const [goalReviewRequestSeq, setGoalReviewRequestSeq] = useState(0);

  // ─── UI state ─────────────────────────────────────────────────────────
  // Autonomy default is "bypassPermissions". Key is v2 so any persisted
  // v1 entry (which could carry the old "default" Confirm mode) is
  // dropped on first read. Persisted "default" values upgrade to
  // bypassPermissions so installs from before the chip-cycle collapse
  // don't strand the user on Confirm-mode popups.
  const AUTONOMY_KEY = "shellX.autonomy.v2";
  const [autonomy, setAutonomy] = useState<AutonomyMode>(() => {
    try {
      localStorage.removeItem("shellX.autonomy.v1");
      const v = localStorage.getItem(AUTONOMY_KEY);
      if (v === "default") return "bypassPermissions";
      if (v === "plan" || v === "acceptEdits" || v === "bypassPermissions") {
        return v;
      }
    } catch { /* ignore */ }
    return "bypassPermissions";
  });
  useEffect(() => {
    try { localStorage.setItem(AUTONOMY_KEY, autonomy); } catch { /* ignore */ }
  }, [autonomy]);
  // Preview is per-tab on TabEntry; read from active tab, set via
  // updateActiveTab.
  const [helpOpen, setHelpOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // #360:  global "open Settings on a specific tab" listener.
  // PluginsModal's "Add key" CTA dispatches this so users land on the
  // Vault tab without a manual click trail. The detail.tab is written
  // to the Settings localStorage key BEFORE opening so the modal mounts
  // already pointing at the right tab.
  useEffect(() => {
    const handler = (e: Event) => {
      const ce = e as CustomEvent<{ tab?: string }>;
      const tab = ce.detail?.tab;
      if (tab) {
        try { localStorage.setItem("grok-shell.settingsTab.v1", tab); } catch { /* no-op */ }
      }
      setPluginsOpen(false);
      setSettingsOpen(true);
    };
    window.addEventListener("shellx:open-settings", handler);
    return () => window.removeEventListener("shellx:open-settings", handler);
  }, []);

  /* Issue #374 — synthetic-event bridge for PermissionPill (and any
   * future component that needs to inject a frame into the events ring
   * without going through Rust). PermissionPill dispatches a
   * `shellx:synthetic-event` with `{ kind, payload }` after the user
   * clicks Allow / Deny; we append to events so the next groupEvents()
   * run reconciles the matching PermissionGroup to pending:false.
   * * Stamping `t: Date.now()` keeps the chat row's timestamp accurate
   * (re-rendering doesn't reset it; the synthetic frame is a one-shot
   * event entry that grouping reads + drops). */
  useEffect(() => {
    const handler = (e: Event) => {
      const ce = e as CustomEvent<{ kind?: string; payload?: unknown }>;
      const kind = ce.detail?.kind;
      const payload = ce.detail?.payload;
      if (typeof kind !== "string" || !kind) return;
      const synthetic: RawEventFrame = {
        t: Date.now(),
        kind,
        payload,
      };
      setEvents((prev) => [...prev, synthetic]);
    };
    window.addEventListener("shellx:synthetic-event", handler);
    return () => window.removeEventListener("shellx:synthetic-event", handler);
  }, []);
  const [pluginsOpen, setPluginsOpen] = useState(false);
  const [connectorInboxOpen, setConnectorInboxOpen] = useState(false);
  const [outsideConnectorHeaderConnectors, setOutsideConnectorHeaderConnectors] = useState<OutsideConnector[]>([]);
  const [outsideConnectorHeaderEvents, setOutsideConnectorHeaderEvents] = useState<OutsideConnectorEvent[]>([]);
  const [connectorInboxLastSeenMs, setConnectorInboxLastSeenMs] = useState<number>(() => {
    try {
      const raw = localStorage.getItem(CONNECTOR_INBOX_SEEN_KEY);
      const parsed = raw ? Number(raw) : 0;
      return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
    } catch {
      return 0;
    }
  });
  const outsideConnectorInboxSummary = useMemo<OutsideConnectorInboxSummary>(
    () => summarizeOutsideConnectorInbox(
      outsideConnectorHeaderConnectors,
      outsideConnectorHeaderEvents,
      connectorInboxLastSeenMs,
    ),
    [outsideConnectorHeaderConnectors, outsideConnectorHeaderEvents, connectorInboxLastSeenMs],
  );
  const markConnectorInboxSeen = useCallback((seenMs: number) => {
    if (!Number.isFinite(seenMs) || seenMs <= 0) return;
    setConnectorInboxLastSeenMs((prev) => {
      const next = Math.max(prev, seenMs);
      if (next !== prev) {
        try { localStorage.setItem(CONNECTOR_INBOX_SEEN_KEY, String(next)); } catch { /* no-op */ }
      }
      return next;
    });
  }, []);
  useEffect(() => {
    if (!inTauri()) return;
    let cancelled = false;
    let consecutiveErrors = 0;
    const tick = async (): Promise<void> => {
      try {
        const [connectors, recentEvents] = await Promise.all([
          invoke<OutsideConnector[]>("outside_connectors_list"),
          invoke<OutsideConnectorEvent[]>("outside_connectors_events", { limit: 99 }).catch(() => []),
        ]);
        if (cancelled) return;
        setOutsideConnectorHeaderConnectors(connectors);
        setOutsideConnectorHeaderEvents(recentEvents);
        consecutiveErrors = 0;
      } catch {
        consecutiveErrors += 1;
      }
    };
    void tick();
    const id = window.setInterval(() => {
      if (consecutiveErrors > 3) return;
      void tick();
    }, 10000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);
  /* Header brand click → Settings → About is the single canonical
   * About surface. Write the tab key before opening; Settings re-reads
   * it on every open (see Settings.tsx). */
  const openAboutInSettings = useCallback(() => {
    try { localStorage.setItem(SETTINGS_TAB_KEY, "about"); } catch { /* ignore */ }
    setSettingsOpen(true);
  }, []);
  // Preview Center opened by ChatOutput clicks on file paths. Documents
  // stay read-only; runnable HTML routes through Work Preview.
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  const [activityOpen, setActivityOpen] = useState(false);
  // in-app docs (Features / Quick start) routed through a
  // global event from AboutTab. Avoids the cross-import dance and
  // keeps BuiltinDocModal mounted at App scope so it's reachable from
  // anywhere.
  const [builtinDocId, setBuiltinDocId] = useState<string | null>(null);
  useEffect(() => {
    const handler = (e: Event) => {
      const ce = e as CustomEvent<{ docId?: string }>;
      const id = ce.detail?.docId;
      if (typeof id === "string" && id.length > 0) setBuiltinDocId(id);
    };
    window.addEventListener("shellx:open-builtin-doc", handler);
    return () => window.removeEventListener("shellx:open-builtin-doc", handler);
  }, []);
  // #355:  voice-chat TTS error pipe. speakAndRearm dispatches
  // `shellx:voice-chat-error` with a human-readable message; we
  // surface it as a tagged ui event so the user sees the failure in
  // chat (silent failure was the original "voice mode is one-way"
  // symptom). The handler reads activeTabIdRef.current so the message
  // lands in the tab that's actually focused when TTS fails — not
  // the tab that was active when this listener mounted.
  useEffect(() => {
    const handler = (e: Event) => {
      const ce = e as CustomEvent<{ msg?: string; tabId?: string | null }>;
      const msg = ce.detail?.msg;
      if (typeof msg !== "string" || msg.length === 0) return;
      const tag = ce.detail?.tabId ?? activeTabIdRef.current ?? null;
      pushLocalEvent({
        t: Date.now(),
        kind: "ui",
        payload: tag
          ? { _meta: { tabId: tag }, text: `🔇 voice: ${msg}` }
          : `🔇 voice: ${msg}`,
      });
    };
    window.addEventListener("shellx:voice-chat-error", handler);
    return () => window.removeEventListener("shellx:voice-chat-error", handler);
  }, []);
  // AGENT-B1 — Header dispatches `shellx:autonomy-needs-reconnect` when
  // /autonomy returned appliesAfterReconnect:true on a live session.
  // Surface a tagged ui event so the user knows the mode change won't
  // take effect until /abort + /connect (grok bakes --always-approve
  // into argv at spawn; mid-process flip isn't possible).
  useEffect(() => {
    const handler = (e: Event) => {
      const ce = e as CustomEvent<{ mode?: string }>;
      const mode = ce.detail?.mode ?? "?";
      const tag = activeTabIdRef.current ?? null;
      pushLocalEvent({
        t: Date.now(),
        kind: "ui",
        payload: tag
          ? {
              _meta: { tabId: tag },
              text: `⚙ autonomy → ${mode} — change will apply after the next /abort + /connect on this tab.`,
            }
          : `⚙ autonomy → ${mode} — apply on reconnect.`,
      });
    };
    window.addEventListener("shellx:autonomy-needs-reconnect", handler);
    return () =>
      window.removeEventListener("shellx:autonomy-needs-reconnect", handler);
  }, []);
  // Expose a global opener so any UI can request preview without prop-
  // drilling, and DevTools can fire `shellxOpenFilePreview("C:\\path")` for
  // ad-hoc testing. Cleared on unmount so HMR doesn't leak stale closures.
  useEffect(() => {
    (window as unknown as { shellxOpenFilePreview?: (p: string) => void })
      .shellxOpenFilePreview = (p: string) => {
        if (typeof p === "string" && p.length > 0) handlePreviewFile(p);
      };
    return () => {
      delete (window as unknown as { shellxOpenFilePreview?: unknown })
        .shellxOpenFilePreview;
    };
  }, [handlePreviewFile]);
  const [prModalOpen, setPrModalOpen] = useState(false);
  /* VaultPanel — openable via the command palette
   * ("Open vault (secrets)"). No dedicated keyboard shortcut yet. */
  const [vaultOpen, setVaultOpen] = useState(false);
  const [maxTokens, setMaxTokens] = useState<number>(128_000);
  const [sessionTitle, setSessionTitle] = useState<string>("new session");
  // isSending is per-tab on TabEntry.
  const [bottomTab, setBottomTab] = useState<BottomTab>(readPersistedBottomTab);

  // ─── Settings (loaded from ~/.grok-shell/settings.json via debug API,
  // mirrored to localStorage so the renderer is responsive). ───────
  const [settings, setSettings] = useState<SettingsValues>(() => readSettingsLocal());
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [hashItems, setHashItems] = useState<HashItem[]>([]);

  /* Apply theme/density/font-size whenever settings change. chatFontPx
   * is listed so a persisted font size from localStorage is applied at
   * boot; the inline slider also calls applyTheme directly for live
   * changes. */
  useEffect(() => {
    applyTheme(settings);
  }, [settings.theme, settings.density, settings.chatFontPx]);

  // Pull canonical settings from disk via debug API once on mount.
  useEffect(() => {
    void api("/settings")
      .then((r) => r.ok ? r.json() : null)
      .then((j) => {
        if (j && typeof j === "object") {
          const merged = normalizeSettings({ ...DEFAULT_SETTINGS, ...settings, ...j });
          setSettings(merged);
          applyTheme(merged);
        }
      })
      .catch(() => { /* debug-api off, stay with localStorage */ });
  }, []);

  // ─── Session tab strip ────────────────────────────────────────────────
  const [tabs, setTabs] = useState<TabEntry[]>(() => {
    try {
      const raw = localStorage.getItem(SESSIONS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as TabEntry[];
        if (Array.isArray(parsed) && parsed.length > 0) {
          return parsed.map((t) => restorePersistedTabEntry(t));
        }
      }
    } catch { /* no-op */ }
    // Cold start: seed one tab with the standing autonomy default so the
    // session strip isn't a lonely "+" button.
    return [newTabEntry("", "bypassPermissions")];
  });
  const tabsRef = useRef<TabEntry[]>(tabs);
  useEffect(() => { tabsRef.current = tabs; }, [tabs]);
  /* activeTabId starts null and syncs via the effect below once `tabs`
   * is stable — reading `tabs[0]` directly in a sibling useState
   * initializer is racy under React 18 strict mode (the tabs initializer
   * runs twice with different random tabIds, so the captured id could
   * point at the discarded pass). Also persists across reloads. */
  const ACTIVE_TAB_KEY = "shellX.activeTab.v1";
  const [activeTabId, setActiveTabId] = useState<string | null>(() => {
    try { return localStorage.getItem(ACTIVE_TAB_KEY) || null; }
    catch { return null; }
  });
  useEffect(() => {
    // If saved active id doesn't exist among tabs, fall back to first.
    if (activeTabId && tabs.some((t) => t.tabId === activeTabId)) return;
    const first = tabs[0]?.tabId ?? null;
    if (first !== activeTabId) setActiveTabId(first);
  }, [tabs, activeTabId]);
  useEffect(() => {
    try {
      if (activeTabId) localStorage.setItem(ACTIVE_TAB_KEY, activeTabId);
      else localStorage.removeItem(ACTIVE_TAB_KEY);
    } catch { /* no-op */ }
    if (activeTabId) {
      void apiPost("/state/ui", { activeTabId }).catch(() => { /* debug API may be off */ });
    }
  }, [activeTabId]);

  // Lazy-load PR/issue list from debug-api once on mount + every 60s.
  useEffect(() => {
    async function refresh() {
      try {
        const qs = activeTabId ? `?tabId=${encodeURIComponent(activeTabId)}` : "";
        const r = await api(`/state/github/items${qs}`);
        if (!r.ok) return;
        const j = await r.json();
        const raw = Array.isArray(j?.items) ? j.items : [];
        const items: HashItem[] = raw
          .filter((x: any) => x && typeof x.number === "number")
          .map((x: any) => ({
            kind: x.kind === "pr" ? "pr" : "issue",
            number: x.number,
            title: String(x.title ?? ""),
            url: String(x.url ?? ""),
          }));
        setHashItems(items);
      } catch { /* debug api may be off */ }
    }
    void refresh();
    const id = window.setInterval(refresh, 60_000);
    return () => window.clearInterval(id);
  }, [activeTabId]);

  useEffect(() => {
    persistUserData(SESSIONS_KEY, tabs);
  }, [tabs]);

  // Reconcile restored tabs with the Rust registry for the current app
  // uptime. Most launches have no live children, so every restored tab
  // should stay Idle and auto-connect on first send. A webview reload
  // during development can leave a real child alive; in that case the
  // registry wins and the matching tab becomes Connected again.
  useEffect(() => {
    if (!inTauri()) return;
    let cancelled = false;
    void api("/state/sessions")
      .then((r) => r.ok ? r.json() : null)
      .then((j) => {
        if (cancelled || !j || !Array.isArray(j.tabs)) return;
        const liveByTab = new Map<string, any>();
        for (const row of j.tabs) {
          if (row && typeof row.tabId === "string") liveByTab.set(row.tabId, row);
        }
        setTabs((prev) => {
          let changed = false;
          const next = prev.map((t) => {
            const row = liveByTab.get(t.tabId);
            const hasChild = row?.hasActiveChild === true;
            const liveSid = typeof row?.sessionId === "string" ? row.sessionId : null;
            const patch: Partial<TabEntry> = {
              status: hasChild ? "Connected" : "Idle",
              isSending: false,
            };
            if (liveSid && liveSid !== t.sessionId) patch.sessionId = liveSid;
            const merged = { ...t, ...patch };
            if (
              merged.status !== t.status ||
              merged.isSending !== t.isSending ||
              merged.sessionId !== t.sessionId
            ) {
              changed = true;
            }
            return merged;
          });
          return changed ? next : prev;
        });
      })
      .catch(() => { /* debug API may still be starting; sanitized restore already covers restarts */ });
    return () => { cancelled = true; };
    // One-shot boot reconciliation. Later session lifecycle is event-driven.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ─── Projects (localStorage-backed; Rust ProjectStore is future work) ──
  interface StoredProject { id: string; name: string; path: string; }
  const [projects, setProjects] = useState<StoredProject[]>(() => {
    try {
      const raw = localStorage.getItem(PROJECTS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as StoredProject[];
        if (Array.isArray(parsed)) return parsed;
      }
    } catch { /* no-op */ }
    return [];
  });
  useEffect(() => {
    persistUserData(PROJECTS_KEY, projects);
  }, [projects]);

  /** Project is a UI sorting label only, not a folder binding.
   * Adding a project inserts a name-only entry and
   * enters rename mode immediately. `path` is kept for back-compat with
   * existing localStorage entries but is unused. */
  const [renamingProjectId, setRenamingProjectId] = useState<string | null>(null);
  const handleAddProject = useCallback((): void => {
    const id = `proj-${Math.random().toString(36).slice(2, 10)}`;
    setProjects((prev) => [...prev, { id, name: "New project", path: "" }]);
    setRenamingProjectId(id);
  }, []);

  const handleRenameProject = useCallback((id: string, newName: string): void => {
    const trimmed = newName.trim();
    if (!trimmed) {
      // Empty rename = delete (intuitive for inline edit).
      setProjects((prev) => prev.filter((p) => p.id !== id));
    } else {
      setProjects((prev) => prev.map((p) => (p.id === id ? { ...p, name: trimmed } : p)));
    }
    setRenamingProjectId(null);
  }, []);

  /** Rename a session tab. Open tabs get `title` + titleLocked set on
   * the TabEntry; closed sessions (sessionId-only) get an override
   * stored in localStorage keyed by sessionId so it survives reloads. */
  const CHAT_TITLES_KEY = "shellX.chatTitles.v1";
  const [chatTitleOverrides, setChatTitleOverrides] = useState<Record<string, string>>(() => {
    try {
      const raw = localStorage.getItem(CHAT_TITLES_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object") return parsed;
      }
    } catch { /* no-op */ }
    return {};
  });
  useEffect(() => {
    persistUserData(CHAT_TITLES_KEY, chatTitleOverrides);
  }, [chatTitleOverrides]);

  const handleRenameChat = useCallback((tabId: string, newTitle: string): void => {
    const trimmed = newTitle.trim();
    if (!trimmed) return;
    // Read tab fields BEFORE calling setters — under React 18 strict
    // mode the updater may be invoked twice and reading inside the
    // closure would capture stale values.
    const t0 = tabs.find((t) => t.tabId === tabId);
    const sessionId = t0?.sessionId ?? undefined;
    const renamedActive = t0?.tabId === activeTabId;
    setTabs((prev) =>
      prev.map((t) =>
        t.tabId === tabId
          // titleLocked is the canonical "user owns this title" signal;
          // the session_summary_generated handler skips locked tabs.
          ? { ...t, title: trimmed, titleLocked: true }
          : t,
      ),
    );
    if (sessionId) {
      // Persist the sessionId→title override so re-opening this past
      // chat in a fresh TabEntry still gets the renamed title.
      setChatTitleOverrides((prev) => ({ ...prev, [sessionId]: trimmed }));
    }
    // The mid-pane masthead reads from `sessionTitle` independently of
    // tab.title; sync it when the renamed tab is active.
    if (renamedActive) {
      setSessionTitle(trimmed);
    }
  }, [activeTabId, tabs]);

  /** Assign a tab to a project (or unfile). */
  const handleAssignChatToProject = useCallback((tabId: string, projectId: string | null): void => {
    setTabs((prev) => prev.map((t) =>
      t.tabId === tabId ? { ...t, projectId: projectId ?? undefined } : t,
    ));
  }, []);

  /** Assign a PAST chat (sessionId) to a project without opening it.
   * Stored as a sessionId→projectId localStorage map so the assignment
   * applies whether the session is open or only on disk. */
  const SESSION_PROJECTS_KEY = "shellX.sessionProjects.v1";
  const [sessionProjects, setSessionProjects] = useState<Record<string, string>>(() => {
    try {
      const raw = localStorage.getItem(SESSION_PROJECTS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object") return parsed;
      }
    } catch { /* no-op */ }
    return {};
  });
  useEffect(() => {
    persistUserData(SESSION_PROJECTS_KEY, sessionProjects);
  }, [sessionProjects]);
  const handleAssignSessionToProject = useCallback((sessionId: string, projectId: string | null): void => {
    setSessionProjects((prev) => {
      const next = { ...prev };
      if (projectId === null) delete next[sessionId];
      else next[sessionId] = projectId;
      return next;
    });
    // Also patch any open tab carrying this sessionId so the UI reacts
    // immediately without needing the row to be the active tab.
    setTabs((prev) => prev.map((t) =>
      t.sessionId === sessionId ? { ...t, projectId: projectId ?? undefined } : t,
    ));
  }, []);

  /** Past chats from disk — every jsonl in ~/.shellx/sessions/ is
   * surfaced in the left rail under "Past chats". Refreshed on mount
   * and after a new session id is bound to a tab. */
  // `cwd` recovered from the first session/new ACP frame in
  // the on-disk jsonl. Used by openPastSession to restore the tab's
  // cwd so file-preview path-scope checks don't reject paths under
  // the original session cwd ("not under session cwd '' ..." regression).
  interface StoredSession extends SessionConnectionMeta {
    id: string;
    title: string;
    mtime_ms: number;
    size: number;
    cwd?: string | null;
  }
  const [pastChats, setPastChats] = useState<StoredSession[]>([]);
  const refreshPastChats = useCallback(async () => {
    if (!inTauri()) return;
    try {
      const list = await invoke<StoredSession[]>("list_stored_sessions");
      setPastChats(list);
      /* Disk is canonical: when a closedTabs archive entry's sessionId
       * appears on disk, drop the archive entry. Also drop synthetic
       * 'closed-XXX' entries older than 30 days. */
      const onDiskIds = new Set(list.map((s) => s.id));
      const cutoffMs = Date.now() - 30 * 24 * 60 * 60 * 1000;
      setClosedTabs((prev) => prev.filter((c) => {
        if (c.sessionId && onDiskIds.has(c.sessionId)) return false;
        if (!c.sessionId && c.closedAtMs < cutoffMs) return false;
        return true;
      }));
    } catch { /* non-fatal */ }
  }, []);
  useEffect(() => { void refreshPastChats(); }, [refreshPastChats]);

  /** #391 — rename a past-chat session (no live tab).
   * Calls the `rename_past_session` Tauri command which atomically
   * appends a `title-override` line to the JSONL. Optimistic update:
   * we set `chatTitleOverrides[sessionId]` immediately so the LeftRail
   * shows the new title before the disk write returns, then refresh
   * pastChats so the canonical title from disk is what subsequent
   * list_stored_sessions sees. The localStorage-backed override map
   * also keeps the title sticky on the closedTabs synthetic rows. */
  const handleRenamePastChat = useCallback((sessionId: string, newTitle: string): void => {
    const trimmed = newTitle.trim();
    if (!trimmed) return;
    // Optimistic update — overrides live in localStorage so the new
    // title is durable even before the Tauri invoke completes.
    setChatTitleOverrides((prev) => ({ ...prev, [sessionId]: trimmed }));
    if (!inTauri()) return;
    invoke("rename_past_session", { sessionId, newTitle: trimmed })
      .then(() => { void refreshPastChats(); })
      .catch((e) => {
        // Surface the failure but keep the optimistic override —
        // user can retry. We don't roll back because the local title is
        // still what the user wanted; only the disk persistence failed.
        console.error("rename_past_session failed:", e);
      });
  }, [refreshPastChats]);

  /** Closed-tab history. Every closed tab is archived here even if it
   * never produced a JSONL (e.g. failed to connect). Merged with disk-
   * backed pastChats so tab closure always leaves a sidebar trace. */
  const CLOSED_TABS_KEY = "shellX.closedTabs.v1";
  interface ClosedTab {
    tabId: string;
    title: string;
    sessionId: string | null;
    closedAtMs: number;
    /** Transport-emoji remembered so past-chat rows in LeftRail can show
     * Local / WSL / SSH at a glance. Optional for back-compat. */
    connectionTransport?: string;
    connectionId?: string | null;
    connectionLabel?: string;
  }
  const [closedTabs, setClosedTabs] = useState<ClosedTab[]>(() => {
    try {
      const raw = localStorage.getItem(CLOSED_TABS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) return parsed as ClosedTab[];
      }
    } catch { /* no-op */ }
    return [];
  });
  useEffect(() => {
    persistUserData(CLOSED_TABS_KEY, closedTabs.slice(-100));
  }, [closedTabs]);
  const archiveClosedTab = useCallback((t: TabEntry) => {
    setClosedTabs((prev) => {
      // Drop any prior archive entry for this tab/sessionId so the most
      // recent close wins.
      const dedup = prev.filter((c) =>
        c.tabId !== t.tabId && (t.sessionId == null || c.sessionId !== t.sessionId),
      );
      return [...dedup, {
        tabId: t.tabId,
        title: t.title || "(untitled)",
        sessionId: t.sessionId,
        closedAtMs: Date.now(),
        connectionId: t.connectionId ?? null,
        connectionLabel: t.connectionLabel,
        connectionTransport: t.connectionTransport,
      }];
    });
  }, []);

  /** Patch the currently-active tab's entry (e.g. composer scope-pill
   * selections). No-op when no tab is active (cold start). */
  const updateActiveTab = useCallback((patch: Partial<TabEntry>) => {
    setTabs((prev) =>
      prev.map((t) => (t.tabId === activeTabId ? { ...t, ...patch } : t)),
    );
  }, [activeTabId]);

  /** Patch a tab by explicit id rather than "whichever is active now".
   * Async flows (connect/send/abort) capture their starting tabId and
   * use this helper so a mid-flight tab switch doesn't write state onto
   * the wrong tab. */
  const updateTabById = useCallback((tabId: string | null | undefined, patch: Partial<TabEntry>) => {
    if (!tabId) return;
    setTabs((prev) =>
      prev.map((t) => (t.tabId === tabId ? { ...t, ...patch } : t)),
    );
  }, []);

  // Active tab — convenience getter for read-only consumers.
  const activeTab = useMemo(
    () => tabs.find((t) => t.tabId === activeTabId) ?? null,
    [tabs, activeTabId],
  );
  const activeWorkPreviewState = useMemo(
    () => activeTabId
      ? workPreviewByTab.get(activeTabId) ?? emptyWorkPreviewState(activeTabId)
      : emptyWorkPreviewState("default"),
    [activeTabId, workPreviewByTab],
  );
  const workPreviewTabIds = useMemo(() => tabs.map((t) => t.tabId), [tabs]);
  const workPreviewTabIdsKey = workPreviewTabIds.join("\u0000");

  useEffect(() => {
    if (!inTauri() || workPreviewTabIds.length === 0) return;
    let cancelled = false;

    const refreshWorkPreview = async () => {
      const states = await Promise.all(
        workPreviewTabIds.map((tabId) =>
          getWorkPreviewState(tabId).catch(() => null),
        ),
      );
      if (cancelled) return;
      try {
        setWorkPreviewByTab((prev) => {
          const next = new Map(prev);
          let changed = false;
          const liveTabIds = new Set(workPreviewTabIds);
          for (const tabId of Array.from(next.keys())) {
            if (!liveTabIds.has(tabId)) {
              next.delete(tabId);
              changed = true;
            }
          }
          for (const state of states) {
            if (!state) continue;
            const current = next.get(state.tabId);
            if (
              current?.status !== state.status ||
              current?.url !== state.url ||
              current?.kind !== state.kind ||
              current?.updatedAtMs !== state.updatedAtMs
            ) {
              next.set(state.tabId, state);
              changed = true;
            }
          }
          return changed ? next : prev;
        });
      } catch {
        /* Work preview is optional; the right rail surfaces manual errors. */
      }
    };

    void refreshWorkPreview();
    const anyRunningPreview = workPreviewTabIds.some((tabId) => {
      const state = workPreviewByTab.get(tabId);
      return state?.status === "running" || state?.status === "starting";
    });
    const pollMs = anyRunningPreview
      ? 2000
      : 5000;
    const id = window.setInterval(() => void refreshWorkPreview(), pollMs);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [workPreviewTabIdsKey, workPreviewByTab]);

  /** Active tab's lifecycle status (Idle if no tab). Header, footer and
   * composer all read this derived value rather than a singleton. */
  const status: Status = activeTab?.status ?? "Idle";
  const isSending: boolean = activeTab?.isSending ?? false;

  // ─── Derived state ────────────────────────────────────────────────────
  /* Filter the global events ring to those tagged with the active
   * tabId via `_meta.tabId`.
   * * Multi-tab cross-leak hardening (#390):
   * - Tag present + matches activeTabId → SHOW.
   * - Tag present + matches a different OPEN tab → DROP (other tab owns it).
   * - Tag present + matches NO OPEN tab → DROP. Orphan events from a
   * closed-and-archived tab (whose tabId is no longer in `tabs`) used
   * to fall through here when the value happened to equal the active
   * tabId, but more importantly any event with a stale or corrupted
   * tag now gets dropped instead of leaking into the active view.
   * This is the "strict mode" called out in the bug brief.
   * - Tag absent → only show when there's exactly one tab (back-compat
   * with any untagged emitter). With multiple tabs, drop so an
   * untagged event can't leak into every tab. */
  const knownTabIds = useMemo(
    () => new Set(tabs.map((t) => t.tabId)),
    [tabs],
  );
  const eventsForActiveTab = useMemo(() => {
    if (!activeTabId) return events;
    return events.filter((ev) => {
      const tag = (ev as any)?.payload?._meta?.tabId
        ?? (ev as any)?.payload?.params?._meta?.tabId
        ?? (ev as any)?._meta?.tabId
        ?? null;
      if (tag == null) return tabs.length <= 1;
      if (tag === activeTabId) return true;
      // Tag present and != activeTabId. Whether it matches another known
      // tab or none, it doesn't belong in the active view. Drop.
      // (knownTabIds reference kept for the dep so future refinements
      // that need it don't have to refactor the closure.)
      void knownTabIds;
      return false;
    });
  }, [events, activeTabId, tabs.length, knownTabIds]);
  const groups = useMemo(() => groupEvents(eventsForActiveTab), [eventsForActiveTab]);
  const sessionMedia = useMemo(() => extractSessionMedia(groups), [groups]);
  const sessionAttachments = useMemo(() => extractSessionAttachments(groups), [groups]);

  // Per-tab token count: scans only the active tab's events so each
  // session's gauge reflects its own usage.
  const totalTokens = useMemo(() => {
    for (let i = eventsForActiveTab.length - 1; i >= 0; i--) {
      const e = eventsForActiveTab[i];
      if (!e || e.kind !== "grok-acp-event") continue;
      const tt = (e.payload as any)?.params?._meta?.totalTokens;
      if (typeof tt === "number") return tt;
    }
    return 0;
  }, [eventsForActiveTab]);

  /* Skills (from latest available_commands_update event) with a
   * localStorage cache. Without the cache, fresh startup leaves the
   * slash-autocomplete popup empty for ~1-2 s until grok sends the
   * first update; persisting the last known list (sub-KB after JSON +
   * gzip) lets the popup populate immediately and refresh from events
   * once they arrive. */
  const skills = useMemo<AcpCommand[]>(() => {
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (!e || e.kind !== "grok-acp-event") continue;
      const su = (e.payload as any)?.params?.update;
      if (su?.sessionUpdate === "available_commands_update") {
        const list = Array.isArray(su.availableCommands) ? su.availableCommands : [];
        if (list.length > 0) {
          try { localStorage.setItem(SKILLS_CACHE_KEY, JSON.stringify(list)); } catch { /* ignore */ }
        }
        return list;
      }
    }
    // Fallback: last cached list from a previous session. Stale entries
    // are fine — the next available_commands_update overwrites them.
    try {
      const raw = localStorage.getItem(SKILLS_CACHE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) return parsed;
      }
    } catch { /* ignore */ }
    return [];
  }, [events]);
  const visibleSlashCommands = useMemo<AcpCommand[]>(() => {
    const normalize = (name: string): string => name.replace(/^\/+/, "");
    const filtered = skills.filter((s) => normalize(s.name) !== "goal");
    if (filtered.some((s) => normalize(s.name) === "build")) return filtered;
    return [
      {
        name: "build",
        description: "shellX Build Mode: plan, implement, review, verify, and complete with receipts.",
        input: { hint: "<objective>" },
        _meta: { scope: "shellx" },
      },
      ...filtered,
    ];
  }, [skills]);

  // Session title from session_summary_generated events. For each tab,
  // pick the newest summary in the current events snapshot and apply it
  // unless the tab is locked (titleLocked = user-owned). Backgrounded
  // tabs are updated too — focus is not required. wouldChange guards
  // bail out cleanly when nothing would actually move, breaking the
  // [events, tabs, ...] dependency loop.
  useEffect(() => {
    // Per-tab newest summary in this events snapshot.
    const newest = new Map<string, { t: number; summary: string }>();
    for (const e of events) {
      const p: any = e?.payload;
      const inner = p?.params?.update;
      if (inner?.sessionUpdate !== "session_summary_generated") continue;
      if (typeof inner.session_summary !== "string") continue;
      const evtTab = p?._meta?.tabId ?? activeTabId ?? "default";
      const prev = newest.get(evtTab);
      if (!prev || e.t > prev.t) {
        newest.set(evtTab, { t: e.t, summary: inner.session_summary });
      }
    }
    if (newest.size === 0) return;
    // Pre-compute whether any tab would actually change; bail early if
    // not, otherwise setTabs(prev => prev.map(...)) always returns a
    // new array and re-fires the effect via the `tabs` dep — infinite
    // cycle.
    let wouldChange = false;
    let activeTabApplied: string | null = null;
    for (const t of tabs) {
      const candidate = newest.get(t.tabId);
      if (!candidate) continue;
      if (t.titleLocked) continue;
      const sid = t.sessionId ?? undefined;
      const override = sid ? chatTitleOverrides[sid] : undefined;
      const finalTitle = override ?? candidate.summary;
      const titleChanged = t.title !== finalTitle;
      const lockChanged = override ? !t.titleLocked : false;
      if (titleChanged || lockChanged) {
        wouldChange = true;
        if (t.tabId === activeTabId) activeTabApplied = finalTitle;
      } else if (t.tabId === activeTabId && finalTitle !== sessionTitle) {
        // Tab unchanged, but masthead state needs catching up.
        activeTabApplied = finalTitle;
      }
    }
    if (wouldChange) {
      setTabs((prev) =>
        prev.map((t) => {
          const candidate = newest.get(t.tabId);
          if (!candidate) return t;
          if (t.titleLocked) return t;
          const sid = t.sessionId ?? undefined;
          const override = sid ? chatTitleOverrides[sid] : undefined;
          const finalTitle = override ?? candidate.summary;
          if (t.title === finalTitle && (override ? t.titleLocked : true)) {
            return t;
          }
          return {
            ...t,
            title: finalTitle,
            titleLocked: override ? true : t.titleLocked,
          };
        }),
      );
    }
    if (activeTabApplied !== null && activeTabApplied !== sessionTitle) {
      setSessionTitle(activeTabApplied);
    }
  }, [events, activeTabId, tabs, chatTitleOverrides, sessionTitle]);

  // Keep the mid-pane masthead in sync with the active tab's title on
  // tab switch. Without this the H1 would show whichever title the
  // session_summary handler or rename last set, regardless of which
  // tab is now active.
  useEffect(() => {
    if (!activeTabId) return;
    const active = tabs.find((t) => t.tabId === activeTabId);
    if (!active) return;
    if (active.title && active.title !== sessionTitle) {
      setSessionTitle(active.title);
    }
  }, [activeTabId, tabs, sessionTitle]);

  // Scan for _x.ai/models/update events → availableModels.
  useEffect(() => {
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (!e || e.kind !== "grok-acp-event") continue;
      const p: any = e.payload;
      if (p?.method === "_x.ai/models/update") {
        const list = p?.params?.availableModels;
        if (Array.isArray(list)) {
          const names = list.map((m: any) =>
            typeof m === "string"
              ? m
              : typeof m?.modelId === "string"
                ? m.modelId
                : typeof m?.id === "string"
                  ? m.id
                  : typeof m?.name === "string"
                    ? m.name
                    : null,
          ).filter((x: string | null): x is string => typeof x === "string");
          if (names.length > 0) setAvailableModels(names);
          return;
        }
      }
    }
  }, [events]);

  // ─── Subscribe to Tauri event channels ────────────────────────────────
  // Per-tab disk-persist routing. The Rust SessionRegistry runs N grok
  // subprocesses concurrently; each event carries _meta.tabId. Map:
  // event._meta.tabId -> tabSessionByTab[tabId] -> sessionId -> jsonl
  // Events without a tab tag fall back to the active tab's sessionId
  // for back-compat with single-session emitters.
  const tabSessionByTab = useRef<Map<string, string>>(new Map());
  const sessionConnectionMetaWritten = useRef<Set<string>>(new Set());
  /* Tracks which sessionIds have already been rehydrated so a listener
   * re-run doesn't re-load the same jsonl into events[] or emit a noisy
   * "rehydrated N events" line on every switch. */
  const rehydratedSessionIds = useRef<Set<string>>(new Set());
  // activeTabId and persist are read via refs inside the listener
  // callback so the outer useEffect can run ONCE on mount. Without
  // this, every tab switch would tear down ~10 channel subscriptions
  // and re-register them, dropping any events emitted in the gap.
  const activeTabIdRef = useRef<string | null>(activeTabId);
  useEffect(() => { activeTabIdRef.current = activeTabId; }, [activeTabId]);

  useEffect(() => {
    if (!inTauri()) return;
    let socket: WebSocket | null = null;
    let closed = false;
    let retryTimer: number | null = null;
    const connectedAfterMs = Date.now() - 500;

    const applyPatch = (patch: unknown) => {
      if (!patch || typeof patch !== "object") return;
      const p = patch as Record<string, unknown>;
      if (isRightTab(p.rightTab)) {
        setRightRailRequest((cur) => ({ tab: p.rightTab as RightTab, seq: (cur?.seq ?? 0) + 1 }));
      }
      if (isBottomTab(p.bottomTab)) {
        setBottomTab(p.bottomTab);
      }
      if (typeof p.activeTabId === "string" && tabsRef.current.some((t) => t.tabId === p.activeTabId)) {
        setActiveTabId(p.activeTabId);
      }
    };

    const connect = async () => {
      try {
        const [base, token] = await Promise.all([debugApiBase(), getDebugToken()]);
        if (closed) return;
        const url = `${base.replace(/^http/, "ws")}/events?token=${encodeURIComponent(token)}`;
        socket = new WebSocket(url);
        socket.onmessage = (event) => {
          try {
            const frame = JSON.parse(String(event.data)) as RawEventFrame;
            if (frame.kind !== "debug-ui-state-patch") return;
            if (typeof frame.t === "number" && frame.t < connectedAfterMs) return;
            const payload = frame.payload as { patch?: unknown } | null;
            applyPatch(payload?.patch);
          } catch {
            /* ignore malformed debug stream frames */
          }
        };
        socket.onclose = () => {
          if (closed) return;
          retryTimer = window.setTimeout(() => void connect(), 2000);
        };
      } catch {
        if (!closed) retryTimer = window.setTimeout(() => void connect(), 4000);
      }
    };

    void connect();
    return () => {
      closed = true;
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      socket?.close();
    };
  }, []);

  // #355:  TTS-back dedupe guard. The completion useEffect can
  // fire from EITHER the typed `prompt-complete` event (Path A) OR a
  // grok-acp-event carrying stopReason (Path B). Without this guard,
  // when Path B fires first (acp-event arrives before the typed
  // prompt-complete), Path A never re-fires for the same turn (the
  // useEffect's `isSending` early-out trips because Path B already
  // set isSending=false), and TTS never plays. Fix: trigger TTS from
  // BOTH paths but key the dedupe on "tab + last prompt-echo index"
  // so we never speak the same turn twice. Cleared implicitly when a
  // new "→ prompt:" ui event lands (its index becomes the new key).
  const lastSpokenTurnRef = useRef<string | null>(null);
  const voicePendingTurnRef = useRef<Map<string, { startIndex: number; turnKey: string }>>(new Map());
  const processedPromptCompletionsRef = useRef<Set<string>>(new Set());
  const processedPromptCompletionOrderRef = useRef<string[]>([]);
  const rememberPromptCompletion = useCallback((completionKey: string): boolean => {
    if (processedPromptCompletionsRef.current.has(completionKey)) return false;
    processedPromptCompletionsRef.current.add(completionKey);
    processedPromptCompletionOrderRef.current.push(completionKey);
    while (processedPromptCompletionOrderRef.current.length > 200) {
      const old = processedPromptCompletionOrderRef.current.shift();
      if (old) processedPromptCompletionsRef.current.delete(old);
    }
    return true;
  }, []);

  const persist = useCallback(async (ev: RawEventFrame): Promise<boolean> => {
    const tag = (ev as any)?.payload?._meta?.tabId
      ?? (ev as any)?.payload?.params?._meta?.tabId
      ?? null;
    const tabKey: string | null = tag ?? activeTabIdRef.current ?? null;
    if (!tabKey) return false;
    const sid = tabSessionByTab.current.get(tabKey)
      ?? tabsRef.current.find((t) => t.tabId === tabKey)?.sessionId
      ?? (tabKey === activeTabIdRef.current ? activeSessionIdRef.current ?? undefined : undefined);
    if (!sid) return false;  // session not yet established for this tab
    try {
      await invoke("append_session_log", { sessionId: sid, line: JSON.stringify(ev) });
      return true;
    } catch { /* writer may not be ready or invalid path; non-fatal */ }
    return false;
  }, []);
  const persistRef = useRef(persist);
  useEffect(() => { persistRef.current = persist; }, [persist]);
  const pendingLocalEvents = useRef(new PendingLocalEventQueue());
  const pendingLocalFlushTimers = useRef<Map<string, number>>(new Map());

  /* One-shot rehydration on mount. Empty deps + a Set ref dedupe
   * already-loaded sessionIds so this doesn't re-append on tab switch.
   * * Cross-tab leak hardening (#390): we KNOWN-tab-normalize each event's
   * `_meta.tabId`. The jsonl-on-disk tag could be from a tab that no
   * longer exists (e.g. closed, archived, or renamed). With the strict
   * filter above, such events would be dropped instead of routed to the
   * tab now claiming this sessionId. We rewrite to `tab.tabId` (the
   * tab adopting the session on this mount) so the events surface in the
   * correct view. We also write `params._meta.tabId` to mirror
   * openPastSession's deeper tagging — the filter falls back through both
   * paths, so being consistent here means future filter refinements (e.g.
   * matching against `payload.params._meta.tabId` first) don't surprise
   * the rehydration path. */
  useEffect(() => {
    if (typeof (window as any).__TAURI_INTERNALS__ === "undefined") return;
    const openTabIds = new Set(tabs.map((t) => t.tabId));
    void (async () => {
      for (const tab of tabs) {
        if (!tab.sessionId || rehydratedSessionIds.current.has(tab.sessionId)) continue;
        rehydratedSessionIds.current.add(tab.sessionId);
        try {
          const lines = await invoke<string[]>("read_session_jsonl", { sessionId: tab.sessionId });
          const recovered: RawEventFrame[] = [];
          for (const line of lines) {
            try {
              const ev = JSON.parse(line) as RawEventFrame;
              const p: any = ev.payload;
              if (p && typeof p === "object") {
                if (!p._meta) p._meta = {};
                // Adopt the existing tabId only if it still names an
                // open tab. A stale tag (from a closed tab that wrote
                // this jsonl in a prior session) would otherwise survive
                // and route the event to nowhere under the strict
                // filter — defeating rehydration for legitimate reopen
                // flows. Overwriting to `tab.tabId` is the safe default
                // because rehydration runs per (tab, sessionId) and the
                // tab claiming this jsonl owns its events on this mount.
                const existing = typeof p._meta.tabId === "string" ? p._meta.tabId : null;
                if (!existing || !openTabIds.has(existing)) {
                  p._meta.tabId = tab.tabId;
                }
                if (p.params && typeof p.params === "object") {
                  if (!p.params._meta) p.params._meta = {};
                  const existingInner = typeof p.params._meta.tabId === "string"
                    ? p.params._meta.tabId
                    : null;
                  if (!existingInner || !openTabIds.has(existingInner)) {
                    p.params._meta.tabId = tab.tabId;
                  }
                }
              }
              recovered.push(ev);
            } catch { /* skip malformed line */ }
          }
          if (recovered.length > 0) {
            setEvents((prev) => [...prev, ...recovered]);
            console.info(`[shellX] rehydrated ${recovered.length} events from ${tab.sessionId}.jsonl into ${tab.tabId.slice(0, 8)}`);
          }
        } catch { /* non-fatal */ }
      }
    })();
    // Mount-only. Tabs gaining a sessionId AFTER mount get their
    // events through the live listener instead.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    // Skip listener wiring outside the Tauri webview — `listen()` would
    // throw because the IPC bridge isn't on `window.__TAURI_INTERNALS__`.
    // In plain browser preview (Vite/Playwright) the app still renders;
    // only the event-driven parts (live grok messages) stay dark.
    const inTauri = typeof (window as any).__TAURI_INTERNALS__ !== "undefined";
    if (!inTauri) {
      pushUiEvent("· running outside Tauri (Vite-only / browser preview) — event listeners skipped");
      return;
    }

    const unlisteners: Array<Promise<UnlistenFn>> = TAURI_CHANNELS.map((ch) =>
      listen<unknown>(ch, (event) => {
        const ev: RawEventFrame = {
          t: Date.now(),
          kind: ch,
          payload: event.payload,
        };
        setEvents((prev) => [...prev, ev]);
        // Read persist + activeTabId via refs so the callback never
        // closes over stale values. The outer useEffect has [] deps.
        void persistRef.current(ev);
        const currentActiveTab = activeTabIdRef.current;
        const sid = extractSessionId(event.payload);
        if (sid) {
          // Route the (tabId, sessionId) binding into tabSessionByTab
          // so persist() can find the right jsonl path. _meta.tabId is
          // authoritative; untagged events fall back to active tab.
          const tag = (ev as any)?.payload?._meta?.tabId
            ?? (ev as any)?.payload?.params?._meta?.tabId
            ?? currentActiveTab
            ?? null;
          if (tag) {
            tabSessionByTab.current.set(tag, sid);
            flushPendingLocalEvents(tag);
            if (!sessionConnectionMetaWritten.current.has(sid)) {
              sessionConnectionMetaWritten.current.add(sid);
              const tab = tabsRef.current.find((t) => t.tabId === tag);
              if (tab) {
                const metaLine: RawEventFrame = {
                  t: Date.now(),
                  kind: "ui",
                  payload: {
                    _meta: { tabId: tag, kind: "connection-metadata" },
                    connectionId: tab.connectionId ?? null,
                    connectionLabel: tab.connectionLabel ?? "Local",
                    connectionTransport: tab.connectionTransport ?? "local",
                    cwd: tab.cwd,
                  },
                };
                void invoke("append_session_log", {
                  sessionId: sid,
                  line: JSON.stringify(metaLine),
                }).catch(() => { /* best-effort metadata only */ });
              }
            }
            // Adopt the sid into the tab record — the right tab may
            // not be active when the event arrives. A restored past
            // chat may already carry its archived sessionId; when it
            // reconnects, replace that archived id with the new live
            // ACP session id so subsequent logs and UI badges follow
            // the process that is actually running now.
            setTabs((prev) => prev.map((t) =>
              t.tabId === tag && (t.sessionId !== sid || t.status !== "Connected")
                ? { ...t, sessionId: sid, status: "Connected" }
                : t,
            ));
            if (tag === currentActiveTab) setActiveSessionId(sid);
          }
        }
        /* plan.md pre-fetch on EnterPlanMode. The typed `plan-event`
         * channel carries `{ kind: "enter_plan_mode", planFilePath }`;
         * we invoke `read_text_file_for_path` immediately and stash the
         * result in planTextByTab so PlanPane has content ready before
         * its first render. Errors are swallowed — plan.md may not
         * exist yet (grok writes it after the tool_call); PlanPane's
         * own fallback fetch retries on the next event. */
        if (ch === "plan-event") {
          const p: any = event.payload;
          if (p && p.kind === "enter_plan_mode" && typeof p.planFilePath === "string") {
            const path = p.planFilePath as string;
            const tag = (p?._meta?.tabId ?? p?.params?._meta?.tabId ?? activeTabIdRef.current) as string | null;
            if (tag) {
              void invoke<string>("read_text_file_for_path", { path, tabId: tag })
                .then((text) => {
                  if (typeof text !== "string") return;
                  setPlanTextByTab((prev) => {
                    // Skip identity churn if the same body re-arrives.
                    if (prev.get(tag) === text) return prev;
                    const next = new Map(prev);
                    next.set(tag, text);
                    return next;
                  });
                })
                .catch(() => { /* plan.md may not exist yet — fallback fetch retries */ });
            }
          }
        }
        if (ch === "session-ended" || ch === "session-aborted") {
          // Route the lifecycle update to the tab the event belongs
          // to (per _meta.tabId), not the currently-active tab.
          const tagged = (event.payload as any)?._meta?.tabId
            ?? (event.payload as any)?.params?._meta?.tabId
            ?? activeTabIdRef.current;
          updateTabById(tagged, { status: "Idle", isSending: false });
        }
        if (ch === "max-context-detected") {
          const max = (event.payload as any)?.maxContextLength;
          if (typeof max === "number") setMaxTokens(max);
        }
        if (ch === "agent-capabilities") {
          /* Cap watcher: log promptCapabilities so we can spot the
           * day grok flips image=true and the binary PromptParts path
           * needs enabling in handleAttach. */
          const caps = (event.payload as any)?.agentCapabilities;
          if (caps && typeof caps === "object") {
            setAgentCaps(caps as Record<string, unknown>);
            const promptCaps = (caps as any).promptCapabilities;
            if (promptCaps?.image === true) {
              console.info(
                "[cap-watcher] grok now advertises promptCapabilities.image=true — " +
                "switch handleAttach to build binary image PromptParts.",
              );
            } else {
              console.info(
                "[cap-watcher] promptCapabilities snapshot:",
                JSON.stringify(promptCaps ?? {}),
              );
            }
          }
        }
      }),
    );
    return () => {
      void Promise.all(unlisteners).then((fns) => fns.forEach((fn) => fn()));
    };
    // Registered ONCE on mount; activeTabId + persist read via refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Detect prompt completion → isSending=false + maybe TTS-back.
  // This must be event-driven per tab, not gated by the active tab's
  // current `isSending` value. If React has already settled the active
  // tab to idle, or completion arrives for a background/recovered tab,
  // Grok's text can render while automatic voice playback is skipped.
  // Process each completion event once; `lastSpokenTurnRef` still
  // dedupes the two completion surfaces for the same assistant turn.
  useEffect(() => {
    if (events.length === 0) return;
    // Scan recent events for any completion signal — covers both
    // event kinds and the case where the typed event arrives last.
    const tail = events.slice(-50);
    // TTS-back trigger shared by both completion paths. Keyed by
    // (tab, last prompt-echo index) so the same turn never speaks
    // twice even when Path A and Path B both fire (or fire across
    // separate useEffect invocations after isSending settles).
    const maybeFireTTS = (taggedTab: string | null) => {
      // Playback is keyed to the prompt echo's voiceReplyExpected flag.
      // Re-reading localStorage here caused a regression where Grok got
      // the [voice mode] prompt but completion-time TTS was skipped.
      let turn = getVoiceTurnToSpeak(events, taggedTab, lastSpokenTurnRef.current);
      if (!turn) {
        const pendingKey = taggedTab ?? "__default__";
        const pending = voicePendingTurnRef.current.get(pendingKey);
        if (pending && lastSpokenTurnRef.current !== pending.turnKey) {
          const text = extractAssistantTurnAfterIndex(events, taggedTab, pending.startIndex);
          if (text.trim()) {
            turn = { turnKey: pending.turnKey, text };
          }
        }
      }
      if (!turn) {
        try { console.info("voice-chat: TTS skipped — no completed voice-enabled turn for tab", taggedTab); } catch { /* noop */ }
        return;
      }
      try { console.info("voice-chat: TTS firing", { tab: taggedTab, chars: turn.text.length, turnKey: turn.turnKey }); } catch { /* noop */ }
      lastSpokenTurnRef.current = turn.turnKey;
      voicePendingTurnRef.current.delete(taggedTab ?? "__default__");
      void speakAndRearm(turn.text, taggedTab);
    };
    for (let i = tail.length - 1; i >= 0; i--) {
      const e = tail[i];
      if (!e) continue;
      const payload = e.payload as any;
      // Path A: typed `prompt-complete` event.
      // Payload shape: { _meta:{tabId}, elapsedMs, kind:'prompt_complete', stopReason?, ... }.
      if (e.kind === "prompt-complete") {
        const tagged = payload?._meta?.tabId ?? activeTabId;
        const completionKey = [
          e.kind,
          tagged ?? "",
          payload?.sessionId ?? "",
          payload?.promptId ?? "",
          payload?.stopReason ?? "",
          e.t,
        ].join(":");
        if (!rememberPromptCompletion(completionKey)) continue;
        updateTabById(tagged, { isSending: false });
        // #355:  voice-chat TTS-back. When voiceChatMode is on,
        // pull the assistant turn's text from the event stream and
        // synthesize it via xAI TTS, then play through an audio
        // element. After playback ends, re-arm the mic for continuous
        // conversation.
        maybeFireTTS(tagged);
        return;
      }
      // Path B: grok-acp-event with stopReason.
      if (e.kind === "grok-acp-event") {
        const sr = payload?.params?.stopReason
                ?? payload?.params?.update?.stopReason
                ?? payload?.params?._meta?.stopReason;
        if (sr) {
          const tagged = payload?._meta?.tabId
            ?? payload?.params?._meta?.tabId
            ?? activeTabId;
          const completionKey = [
            e.kind,
            payload?.method ?? "",
            tagged ?? "",
            payload?.params?.sessionId ?? "",
            payload?.params?.promptId ?? "",
            sr,
            e.t,
          ].join(":");
          if (!rememberPromptCompletion(completionKey)) continue;
          updateTabById(tagged, { isSending: false });
          // TTS-back also fires from Path B (the grok-acp completion
          // marker). When the typed `prompt-complete` lands after the
          // acp event, Path A would otherwise re-fire TTS for the
          // same turn — `lastSpokenTurnRef` guards against the double.
          maybeFireTTS(tagged);
        }
      }
    }
  }, [events, activeTabId]);

  // ─── Actions ──────────────────────────────────────────────────────────
  /**
   * Per-tab in-flight guard for connect(). Synchronous ref-based gate so
   * two rapid clicks can't both race past the `status === "Idle"`
   * closure read and both fire `start_grok_session` (which would
   * overwrite the Rust-side `self.child` and orphan the first grok).
   * Keyed by tabId so a failed spawn in tab A never blocks tab B.
   */
  const spawnInFlight = useRef<Set<string>>(new Set());
  type ConnectTarget = {
    tabId?: string | null;
    cwd?: string | null;
    connectionId?: string | null;
    autonomy?: AutonomyMode | null;
  };
  async function connect(target: ConnectTarget = {}): Promise<boolean> {
    const targetTab = target.tabId
      ? tabsRef.current.find((t) => t.tabId === target.tabId) ?? null
      : activeTab;
    const myTabId = target.tabId ?? targetTab?.tabId ?? null;
    if (myTabId && spawnInFlight.current.has(myTabId)) {
      pushUiEvent(`· connect[${myTabId}]: another spawn already in flight for this tab, skipping`);
      return false;
    }
    if (!inTauri()) {
      pushUiEvent("· connect: skipped (browser preview, no Tauri IPC bridge)");
      updateTabById(myTabId, { status: "Idle" });
      return false;
    }
    if (myTabId) spawnInFlight.current.add(myTabId);
    setError(null);
    updateTabById(myTabId, { status: "Starting" });
    /* Use the active tab's cwd; fall back to the app-level cwd when
     * the tab has not been folder-picked yet. The tab-scoped cwd is
     * the canonical working directory once a tab is active. */
    const spawnCwd =
      (target.cwd && target.cwd.trim())
        ? target.cwd
        : (targetTab?.cwd && targetTab.cwd.trim())
          ? targetTab.cwd
          : cwd;
    if (!spawnCwd) {
      pushUiEvent("✗ connect: no folder set. Pick one via the 📁 pill below.");
      updateTabById(myTabId, { status: "Error" });
      if (myTabId) spawnInFlight.current.delete(myTabId);
      return false;
    }
    pushUiEvent(`→ connect ${spawnCwd}`);
    try {
      // Push the active autonomy BEFORE spawning grok.
      // set_permission_mode only applies to the NEXT spawn (acp.rs
      // composes --always-approve at spawn time), so order matters.
      const spawnAutonomy = target.autonomy ?? targetTab?.autonomy ?? autonomy;
      try {
        await invoke("set_permission_mode", { mode: spawnAutonomy, tabId: myTabId });
      } catch { /* non-fatal — falls back to "default" / Confirm */ }
      const result = await invoke<string>("start_grok_session", {
        cwd: spawnCwd,
        wslDistro: null,
        wslGrokPath: null,
        mcpServers: null,
        connectionId: target.connectionId !== undefined
          ? target.connectionId
          : targetTab?.connectionId ?? null,
        tabId: myTabId,
      });
      pushUiEvent(`✓ ${result}`);
      updateTabById(myTabId, { status: "Connected" });
      // Fetch max tokens once initialize lands.
      try {
        const max = await invoke<number>("get_detected_max_tokens", {
          tabId: myTabId,
        });
        if (typeof max === "number" && max > 0) setMaxTokens(max);
      } catch { /* non-fatal */ }
      return true;
    } catch (err: any) {
      setError(String(err));
      updateTabById(myTabId, { status: "Error" });
      pushUiEvent(`✗ ${err}`);
      return false;
    } finally {
      if (myTabId) spawnInFlight.current.delete(myTabId);
    }
  }

  async function send(): Promise<void> {
    // Read via promptRef so stale-closure callers (e.g. mic-stop
    // transcribe flow) still see the latest composer value.
    const currentPrompt = promptRef.current;
    const queuedAttachmentChips = pendingAttachmentChips;
    if (!currentPrompt.trim() && queuedAttachmentChips.length === 0) return;
    // `/pr` slash opens the PR-create modal instead of sending to
    // grok. Whole-word `/pr` at the start only.
    const stripped = currentPrompt.trim();
    if (stripped === "/pr" || stripped.startsWith("/pr ")) {
      setPrModalOpen(true);
      setPrompt("");
      return;
    }
    if (stripped === "/pause" || stripped === "/resume" || stripped === "/stop") {
      const myTabId = activeTab?.tabId ?? null;
      if (!myTabId) {
        pushUiEvent(`✗ ${stripped} needs an active tab`);
        return;
      }
      try {
        const activeBuild = await getBuildState(myTabId).catch(() => null);
        if (activeBuild && !isBuildTerminalStatus(activeBuild.status)) {
          if (stripped === "/pause") {
            await invoke("pause_build", { tabId: myTabId });
            pushUiEvent("◎ build paused");
          } else if (stripped === "/resume") {
            await invoke("resume_build", { tabId: myTabId });
            pushUiEvent("◎ build resumed");
          } else {
            await invoke("halt_build", {
              tabId: myTabId,
              summary: "Stopped manually from shellX composer",
            });
            pushUiEvent("◎ build stopped");
          }
        } else if (stripped === "/pause") {
          await invoke("pause_goal", { tabId: myTabId });
          pushUiEvent("◎ build paused");
        } else if (stripped === "/resume") {
          await invoke("resume_goal", { tabId: myTabId });
          pushUiEvent("◎ build resumed");
        } else {
          await invoke("set_goal_mode", {
            tabId: myTabId,
            on: false,
            objective: null,
            cwd: activeTab?.cwd ?? cwd,
          });
          pushUiEvent("◎ build stopped");
        }
        setPrompt("");
      } catch (err: any) {
        setError(`${stripped} failed: ${err}`);
      }
      return;
    }
    const buildObjective = parseBuildCommand(currentPrompt);
    if (buildObjective !== null) {
      const usedLegacyGoalCommand = stripped === "/goal" || stripped.startsWith("/goal ");
      if (!buildObjective) {
        pushUiEvent("✗ /build requires an objective: /build <what to accomplish>");
        return;
      }
      const myTabId = activeTab?.tabId ?? null;
      if (!myTabId) {
        pushUiEvent("✗ /build needs an active tab — connect first");
        return;
      }
      if (activeTab && activeTab.status !== "Connected") {
        pushUiEvent(`→ auto-connect (build-mode start)`);
        const connected = await connect();
        if (!connected) {
          setError("Auto-connect failed");
          return;
        }
      }
      const activeCwd = activeTab?.cwd ?? cwd;
      try {
        const started = await startBuildMode(myTabId, buildObjective, activeCwd);
        if (usedLegacyGoalCommand) {
          pushUiEvent("→ starting /build");
        }
        pushUiEvent(`◎ build mode: ${buildObjective}`);
        setRightRailRequest({ tab: "Plan", seq: Date.now() });
        setPrompt("");
        void sendPromptText(started.kickoffPrompt, myTabId);
      } catch (err: any) {
        setError(`start_build_mode failed: ${err}`);
      }
      return;
    }
    setError(null);
    const myTabId = activeTab?.tabId ?? null;
    // Auto-connect-then-send: if the tab has no live grok session
    // (just reopened a past chat, or never connected), spawn one
    // first so the user's prompt isn't lost on a fresh empty session.
    if (activeTab && activeTab.status !== "Connected") {
      pushUiEvent(`→ auto-connect (resume-then-send)`);
      const connected = await connect();
      if (!connected) {
        setError("Auto-connect failed");
        return;
      }
      // The local `activeTab` capture doesn't observe the post-connect
      // status update from setTabs; we fall through and trust the Rust
      // side. The catch below surfaces failure.
    }
    const attachmentTags = queuedAttachmentChips
      .map(attachmentWireTag)
      .join(" ");
    const visiblePrompt = currentPrompt.trim().length > 0
      ? currentPrompt
      : "Attached file(s)";
    const txt = [currentPrompt.trim().length > 0 ? currentPrompt : "Please inspect the attached file(s).", attachmentTags]
      .filter((part) => part.trim().length > 0)
      .join("\n\n");
    const { prompt: effectivePrompt, voiceReplyExpected } =
      buildVoiceAwarePrompt(txt, myTabId);
    if (voiceReplyExpected) {
      voicePendingTurnRef.current.set(myTabId ?? "__default__", {
        startIndex: eventsLenRef.current,
        turnKey: `${myTabId ?? ""}::voice::${Date.now()}`,
      });
    }
    updateTabById(myTabId, { isSending: true });
    /* Drain pending attachments. Text inlines ship via
     * `embeddedContext`; all attachments are echoed as renderer-only
     * chips while the wire payload keeps stable `[attached: ...]`
     * markers for grok. */
    const ec = pendingAttachments.length > 0
      ? pendingAttachments.map((a) => ({
          content: a.content,
          mimeType: a.mimeType,
          path: a.path,
        }))
      : null;
    const echoedAttachments = queuedAttachmentChips.map((attachment) => ({
      path: attachment.path,
      label: attachment.label,
      kind: attachment.kind,
    }));
    pushPromptEcho(visiblePrompt, myTabId, voiceReplyExpected, echoedAttachments);
    // Stamp first-message timestamp so the composer's connection pill
    // locks on the next render. updateActiveTab is patch-style so this
    // is a no-op on subsequent sends.
    if (activeTab && !activeTab.firstMessageMs) {
      updateActiveTab({ firstMessageMs: Date.now() });
    }
    setPrompt("");
    setPendingAttachments([]);
    setPendingAttachmentChips([]);
    // Keep the primary composer send path and the internal helper path
    // on the same voice-mode contract. The helper already prepended the
    // "[voice mode]" instruction and attached `voiceReplyExpected`; the
    // normal user send path did neither, so Grok could ignore the
    // intended frontend TTS-back flow and call host `voice_tts`
    // directly. That split is exactly how "voice reply exists but the
    // second turn did not play" shows up in practice.
    try {
      await invoke<string>("send_prompt", {
        prompt: effectivePrompt,
        tabId: myTabId,
        embeddedContext: ec,
        voiceReplyExpected,
      });
    } catch (err: any) {
      voicePendingTurnRef.current.delete(myTabId ?? "__default__");
      setError(String(err));
      pushUiEvent(`✗ ${err}`);
      updateTabById(myTabId, { isSending: false });
    }
  }

  /* Send a specific text to a specific tab WITHOUT mutating the App-
   * level composer state. The composer `prompt` state is shared
   * across tabs, so routing internal action prompts through setPrompt
   * would leak the text into every tab and the closure-captured send()
   * would bail on stale `prompt`. Callers capture tabId at click time so a mid-flight
   * tab switch lands the prompt on the originating tab. Slash-command
   * interception is skipped — this path is for structured prompts. */
  async function sendPromptText(text: string, tabId: string | null): Promise<void> {
    if (!text.trim()) return;
    setError(null);
    updateTabById(tabId, { isSending: true });
    /* Echo as a tagged ui event so the user sees what was sent in the
     * correct tab — same path as send() uses for the "→ prompt:" line. */
    const { prompt: effective, voiceReplyExpected } =
      buildVoiceAwarePrompt(text, tabId);
    if (voiceReplyExpected) {
      voicePendingTurnRef.current.set(tabId ?? "__default__", {
        startIndex: eventsLenRef.current,
        turnKey: `${tabId ?? ""}::voice::${Date.now()}`,
      });
    }
    pushPromptEcho(text, tabId, voiceReplyExpected);
    try {
      // also attach `voiceReplyExpected: true` on the outgoing
      // ACP envelope's `_meta` block. The host-MCP
      // serverInfo.instructions advertise this flag to grok; without
      // setting it the documented behavior never activated and the
      // text-prefix was doing all the work alone. Both signals reach
      // grok now (text prefix tells the LLM how to format, meta flag
      // is structured signal for any future host-side routing).
      await invoke<string>("send_prompt", {
        prompt: effective,
        tabId,
        voiceReplyExpected,
      });
    } catch (err: any) {
      voicePendingTurnRef.current.delete(tabId ?? "__default__");
      setError(String(err));
      pushLocalEvent({
        t: Date.now(), kind: "ui",
        payload: tabId ? { _meta: { tabId }, text: `✗ ${err}` } : `✗ ${err}`,
      });
      updateTabById(tabId, { isSending: false });
    }
  }

  async function abort(): Promise<void> {
    const myTabId = activeTab?.tabId ?? null;
    updateTabById(myTabId, { status: "Aborting" });
    try {
      await invoke<string>("abort_session", { tabId: myTabId });
      pushUiEvent("⏹ abort sent");
    } catch (err: any) {
      setError(String(err));
    } finally {
      updateTabById(myTabId, { status: "Idle", isSending: false });
    }
  }

  function pushLocalEvent(ev: RawEventFrame): void {
    setEvents((prev) => [...prev, ev]);
    if (ev.kind === "ui") {
      void persistRef.current(ev).then((ok) => {
        if (ok) return;
        const tabId = localEventTabId(ev, activeTabIdRef.current);
        if (!tabId) return;
        pendingLocalEvents.current.enqueue(tabId, ev);
        schedulePendingLocalFlush(tabId, 250);
      });
    }
  }

  function schedulePendingLocalFlush(tabId: string, delayMs: number): void {
    if (pendingLocalFlushTimers.current.has(tabId)) return;
    const timer = window.setTimeout(() => {
      pendingLocalFlushTimers.current.delete(tabId);
      flushPendingLocalEvents(tabId);
    }, delayMs);
    pendingLocalFlushTimers.current.set(tabId, timer);
  }

  function flushPendingLocalEvents(tabId: string): void {
    void pendingLocalEvents.current.flush(tabId, persistRef.current);
  }

  function pushUiEvent(text: string): void {
    /* Tag ui events with the active tab id. The eventsForActiveTab
     * filter drops untagged events when tabs > 1; wrapping the text
     * with _meta.tabId routes it to the originating tab. */
    const tag = activeTabId ?? null;
    pushLocalEvent({
      t: Date.now(),
      kind: "ui",
      payload: tag
        ? { _meta: { tabId: tag }, text }
        : text,
    });
  }

  function pushPromptEcho(
    text: string,
    tabId: string | null,
    voiceReplyExpected: boolean,
    attachments: Array<{ path: string; label: string; kind: ComposerAttachmentKind }> = [],
  ): void {
    pushLocalEvent({
      t: Date.now(),
      kind: "ui",
      payload: tabId
        ? { _meta: { tabId, voiceReplyExpected }, text: `→ prompt: ${text}`, attachments }
        : { _meta: { voiceReplyExpected }, text: `→ prompt: ${text}`, attachments },
    });
  }

  function handleAutonomyChange(mode: AutonomyMode): void {
    void setAutonomyAndPersist(mode);
  }

  /**
   * Workspace chip → directory picker via Tauri's dialog plugin.
   * Falls back to window.prompt when the plugin isn't reachable
   * (browser preview, dialog permission denied).
   */
  async function handleWorkspaceClick(): Promise<void> {
    try {
      const selected = await openDialog({
        directory: true,
        multiple: false,
        defaultPath: cwd,
      });
      if (typeof selected === "string" && selected.trim()) {
        setCwd(selected);
        pushUiEvent(`→ cwd set to ${selected}`);
      }
    } catch (err: any) {
      // Fallback (e.g. dialog plugin not registered).
      const next = window.prompt("Set cwd:", cwd);
      if (next && next.trim()) setCwd(next.trim());
      console.warn("workspace picker fallback:", err);
    }
  }

  /**
   * Attach files via the OS dialog and route each one through the
   * right path. The classifier lives Rust-side (`read_text_file_if_text`):
   * - Text + ≤64 KB → inline as `embedded_context` (queued in
   * `pendingAttachments`; `send()` ships them as `embeddedContext`).
   * - Image extension → render as image attachment chips. Wire form
   * stays `[attached: <path>]` while grok advertises
   * promptCapabilities.image=false; the cap-watcher will flip the path
   * once grok ships binary support.
   * - Binary or oversize → tag-only.
   * * The composer displays removable chips; send() adds hidden
   * `[attached: <path>]` markers to the wire prompt so grok has a
   * stable file reference.
   */
  async function handleAttach(): Promise<void> {
    let selected: string | string[] | null;
    try {
      selected = await openDialog({ multiple: true, defaultPath: cwd });
    } catch (err: any) {
      pushUiEvent(`✗ attach picker failed: ${err}`);
      return;
    }
    if (!selected) return;
    const rawPaths = Array.isArray(selected) ? selected : [selected];
    if (rawPaths.length === 0) return;
    await processAttachedPaths(rawPaths);
  }

  async function handleAttachScreenshot(): Promise<void> {
    if (!inTauri()) {
      pushUiEvent("✗ screenshot attach requires the shellX desktop app");
      return;
    }
    try {
      const screenshotPath = await invoke<string>("capture_app_screenshot_to_file");
      await processAttachedPaths([screenshotPath], { copyIntoScope: false });
    } catch (err) {
      pushUiEvent(`✗ screenshot attach failed: ${err}`);
    }
  }

  /**
   * Drag-and-drop attach pipeline. Shared between the dialog branch
   * above and the composer's drop handler (BottomPanel.onAttachPaths)
   * so both surfaces run the same in-scope copy + text/image
   * classification + state updates.
   */
  async function processAttachedPaths(
    rawPaths: string[],
    options: { copyIntoScope?: boolean } = {},
  ): Promise<void> {
    if (rawPaths.length === 0) return;
    // Files outside the active tab's cwd are copied into the scope
    // folder so grok can resolve them locally.
    // The Rust side enforces a home-tree boundary on the copy.
    const scopeDir = (activeTab?.cwd ?? cwd).replace(/[/\\]+$/, "");
    // Windows path comparison is case-insensitive; POSIX is case-
    // sensitive in spec but filename-case collisions are rare enough
    // that lowercase-everywhere is a safe heuristic.
    const isWin = typeof navigator !== "undefined" && /Win/i.test(navigator.platform);
    const norm = (s: string) => {
      const slashed = s.replace(/\\/g, "/");
      return isWin ? slashed.toLowerCase() : slashed;
    };
    const scopeNorm = norm(scopeDir);
    const copyIntoScope = options.copyIntoScope ?? true;
    const finalPaths: string[] = [];
    for (const p of rawPaths) {
      const pNorm = norm(p);
      const inScope = pNorm === scopeNorm || pNorm.startsWith(scopeNorm + "/");
      if (inScope) {
        finalPaths.push(p);
      } else if (copyIntoScope && inTauri()) {
        try {
          const copied = await invoke<string>("copy_to_scope", {
            src: p,
            destDir: scopeDir,
          });
          pushUiEvent(`→ copied ${p} → ${copied}`);
          finalPaths.push(copied);
        } catch (err) {
          pushUiEvent(`✗ copy_to_scope failed for ${p}: ${err}`);
          // Fall back to the original path so grok at least sees the
          // tag (it just won't resolve relative to cwd).
          finalPaths.push(p);
        }
      } else {
        // Browser-mode preview — no Tauri invoke. Pass through.
        finalPaths.push(p);
      }
    }
    /* Classify each finalPath into one of three buckets:
     * - text + ≤64KB → pendingAttachments (becomes embedded_context
     * on next send())
     * - image extension → attachment chip with image thumbnail metadata
     * - everything else → tag-only.
     */
    const imageExts = new Set(["jpg", "jpeg", "png", "gif", "webp", "bmp", "svg"]);
    const newTextAttachments: PendingTextAttachment[] = [];
    const classificationByPath = new Map<string, ComposerAttachmentKind>();
    let inlinedCount = 0;
    let imageCount = 0;
    for (const p of finalPaths) {
      const lastDot = p.lastIndexOf(".");
      const ext = lastDot >= 0 ? p.slice(lastDot + 1).toLowerCase() : "";
      if (imageExts.has(ext)) {
        classificationByPath.set(p, "image");
      }
    }
    if (inTauri()) {
      for (const p of finalPaths) {
        const lastDot = p.lastIndexOf(".");
        const ext = lastDot >= 0 ? p.slice(lastDot + 1).toLowerCase() : "";
        if (imageExts.has(ext)) {
          imageCount += 1;
          continue;
        }
        try {
          const r = await invoke<{ kind: "text"; content: string } | { kind: "binary" }>(
            "read_text_file_if_text",
            { path: p, maxBytes: 64 * 1024 },
          );
          if (r && r.kind === "text") {
            // Pick a coarse MIME from extension; grok uses it as a hint.
            const mime =
              ext === "md" ? "text/markdown" :
              ext === "json" ? "application/json" :
              ext === "py" ? "text/x-python" :
              ext === "ts" || ext === "tsx" ? "text/x-typescript" :
              ext === "rs" ? "text/x-rust" :
              ext === "go" ? "text/x-go" :
              ext === "yaml" || ext === "yml" ? "text/yaml" :
              ext === "toml" ? "text/toml" :
              ext === "html" ? "text/html" :
              ext === "css" ? "text/css" :
              ext === "sh" ? "application/x-sh" :
              ext === "sql" ? "application/sql" :
              ext === "csv" ? "text/csv" :
              ext === "xml" ? "application/xml" :
              "text/plain";
            newTextAttachments.push({ path: p, content: r.content, mimeType: mime });
            classificationByPath.set(p, "text");
            inlinedCount += 1;
          }
        } catch (err) {
          // Best-effort: if the sniff fails, fall back to tag-only.
          console.warn("[attach] read_text_file_if_text failed for", p, err);
        }
      }
    }
    if (newTextAttachments.length > 0) {
      setPendingAttachments((prev) => appendUniqueTextAttachments(prev, newTextAttachments));
    }
    const chips: ComposerAttachmentChip[] = finalPaths.map((p) => {
      const kind = classificationByPath.get(p) ?? "file";
      return {
        id: attachmentChipId(p),
        path: p,
        label: attachmentLabelFromPath(p),
        kind,
        inlined: kind === "text",
      };
    });
    setPendingAttachmentChips((prev) => {
      const seen = new Set(prev.map((chip) => chip.path));
      const unique = chips.filter((chip) => {
        if (seen.has(chip.path)) return false;
        seen.add(chip.path);
        return true;
      });
      return unique.length > 0 ? [...prev, ...unique] : prev;
    });
    const detailBits: string[] = [];
    detailBits.push(`${finalPaths.length} file(s)`);
    if (inlinedCount > 0) detailBits.push(`${inlinedCount} inlined`);
    if (imageCount > 0) detailBits.push(`${imageCount} image(s) — UX preview only, wire stays tag-only`);
    pushUiEvent(`→ attached ${detailBits.join(", ")}`);
  }

  function removePendingAttachment(id: string): void {
    const attachment = pendingAttachmentChips.find((chip) => chip.id === id);
    if (!attachment) return;
    setPendingAttachmentChips((prev) => prev.filter((chip) => chip.id !== id));
    setPendingAttachments((prev) => prev.filter((item) => item.path !== attachment.path));
  }

  useEffect(() => {
    if (!inTauri()) return;
    let unsubscribe: UnlistenFn | null = null;
    void listen<{ paths?: string[]; source?: string }>("shellx:external-attachments", (event) => {
      const paths = Array.isArray(event.payload?.paths)
        ? event.payload.paths.filter((path): path is string => typeof path === "string" && path.trim().length > 0)
        : [];
      if (paths.length === 0) return;
      setBottomTab("Chat");
      const source = event.payload?.source === "startup" || event.payload?.source === "single-instance"
        ? "Send to shellX"
        : "desktop file handoff";
      void processAttachedPaths(paths).then(() => {
        pushUiEvent(`→ ${source} delivered ${paths.length} file(s) to the composer`);
      });
    }).then((fn) => {
      unsubscribe = fn;
    }).catch((err) => {
      pushUiEvent(`✗ Send to shellX listener failed: ${err}`);
    });
    return () => {
      if (unsubscribe) unsubscribe();
    };
    // Re-register when the active cwd changes so Send to shellX copies
    // external files into the current tab's scope, not a stale folder.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab?.cwd, cwd]);

  async function processDroppedAttachmentFiles(files: File[]): Promise<void> {
    if (files.length === 0) return;
    if (!inTauri()) {
      pushUiEvent("✗ drop/paste attach requires the shellX desktop app");
      return;
    }
    const scopeDir = (activeTab?.cwd ?? cwd).replace(/[/\\]+$/, "");
    const savedPaths: string[] = [];
    let skipped = 0;
    for (const file of files) {
      const label = file.name?.trim() || "clipboard image";
      if (file.size > DROPPED_ATTACHMENT_MAX_BYTES) {
        skipped += 1;
        pushUiEvent(
          `✗ skipped ${label}: ${formatBytes(file.size)} exceeds paste/drop cap ${formatBytes(DROPPED_ATTACHMENT_MAX_BYTES)}`,
        );
        continue;
      }
      try {
        const dataBase64 = await readFileAsBase64(file);
        const saved = await invoke<string>("save_dropped_attachment_to_scope", {
          filename: label,
          mimeType: file.type || null,
          dataBase64,
          destDir: scopeDir,
        });
        savedPaths.push(saved);
      } catch (err) {
        skipped += 1;
        pushUiEvent(`✗ attach failed for ${label}: ${err}`);
      }
    }
    if (savedPaths.length > 0) {
      await processAttachedPaths(savedPaths, { copyIntoScope: false });
    }
    if (skipped > 0 && savedPaths.length === 0) {
      pushUiEvent(`✗ no pasted/dropped files attached (${skipped} skipped)`);
    }
  }

  function handlePreviewFile(path: string): void {
    // Route chat/file links into Preview Center. Plain documents stay in
    // read-only file preview; standalone HTML launches Work Preview so
    // generated pages run with scripts instead of the safe source viewer.
    if (typeof path !== "string" || path.length === 0) return;
    const tabCwd = tabs.find((t) => t.tabId === activeTabId)?.cwd?.trim() ?? "";
    const route = resolvePreviewRoute({
      path,
      cwd: tabCwd,
      canRunWorkPreview: inTauri(),
    });
    if (!route.ok) {
      pushUiEvent(`✗ ${route.reason}`);
      return;
    }
    const abs = route.path;
    setPreviewPath(abs);
    if (route.view === "work" && route.workRoot && route.workEntry) {
      const tabId = activeTabId ?? "default";
      const optimistic: WorkPreviewState = {
        ...emptyWorkPreviewState(tabId),
        cwd: route.workRoot,
        kind: "staticHtml",
        status: "starting",
        updatedAtMs: Date.now(),
      };
      setWorkPreviewByTab((prev) => {
        const next = new Map(prev);
        next.set(tabId, optimistic);
        return next;
      });
      setPreviewCenterView("work");
      setPreviewCenterOpen(true);
      updateActiveTab({ preview: { kind: "url", path: abs } });
      void apiPost("/preview", { kind: "url", path: abs }).catch(() => { /* debug api may be off */ });
      void startWorkPreview({
        tabId,
        cwd: route.workRoot,
        kind: "static",
        entry: route.workEntry,
      })
        .then((state) => {
          clearWorkPreviewBrowserEvents(state.tabId);
          setWorkPreviewByTab((prev) => {
            const next = new Map(prev);
            next.set(state.tabId, state);
            return next;
          });
          setPreviewCenterView("work");
          setPreviewCenterOpen(true);
        })
        .catch((err) => {
          pushUiEvent(`✗ preview failed for ${abs}: ${err instanceof Error ? err.message : String(err)}`);
          setPreviewCenterView("file");
          setPreviewCenterOpen(true);
        });
      return;
    }
    setPreviewCenterView("file");
    setPreviewCenterOpen(true);
    updateActiveTab({ preview: { kind: "file", path: abs } });
    void apiPost("/preview", { kind: "file", path: abs }).catch(() => { /* debug api may be off */ });
  }

  async function handleAskGrokToFixPreview(state: WorkPreviewState): Promise<void> {
    const tabId = state.tabId || activeTabId || "default";
    setPreviewCenterView("work");
    setPreviewCenterOpen(true);
    try {
      const diagnostic = await diagnoseWorkPreview({
        tabId,
        browserEvents: getWorkPreviewBrowserEvents(tabId, {
          url: state.url,
          sinceMs: state.startedAtMs,
        }),
      });
      await sendPromptText(previewRepairPrompt(diagnostic), tabId);
      pushUiEvent(
        diagnostic.ok
          ? "◎ Preview Doctor report sent to Grok"
          : `◎ Preview Doctor found ${diagnostic.issues.length} issue(s); report sent to Grok`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      pushUiEvent(`✗ Preview Doctor failed: ${message}`);
      await sendPromptText(
        [
          "shellX Preview Doctor could not complete, but the user asked to repair the current preview.",
          "",
          `Preview URL: ${state.url ?? "(none)"}`,
          `Project: ${state.cwd ?? activeTab?.cwd ?? cwd}`,
          `Command: ${state.command ?? "(none)"}`,
          `Error from Preview Doctor: ${message}`,
          "",
          "Inspect the app, run the preview checks you can access, fix the issue, and verify the preview before reporting success.",
        ].join("\n"),
        tabId,
      );
    }
  }

  /** ⌘T: spawn a new tab. */
  function handleNewTab(): void {
    const t = newTabEntry(cwd, autonomy);
    setTabs((prev) => {
      // Soft-warn at 10/20/50 tabs — each grok subprocess holds
      // ~150-300 MB once active. No hard cap.
      const newCount = prev.length + 1;
      if (newCount === 10 || newCount === 20 || newCount === 50) {
        pushUiEvent(
          `! ${newCount} tabs open — each grok subprocess uses 150-300 MB RAM. ` +
          `Consider closing tabs you're done with.`,
        );
      }
      return [...prev, t];
    });
    setActiveTabId(t.tabId);
    if (status === "Idle" || status === "Error") {
      void connect({
        tabId: t.tabId,
        cwd: t.cwd,
        connectionId: t.connectionId ?? null,
        autonomy: t.autonomy,
      });
    }
  }

  /**
   * Open a NEW tab pre-scoped to the given project. Inherits the
   * active tab's connection/branch if any; otherwise defaults to a
   * fresh Local tab from newTabEntry.
   */
  function handleOpenProject(projectId: string, projectName: string): void {
    const t = newTabEntry(cwd, autonomy);
    t.title = projectName;
    t.projectId = projectId;
    // Inherit connection/branch from current active tab for continuity.
    if (activeTab?.connectionId !== undefined) t.connectionId = activeTab.connectionId;
    if (activeTab?.connectionLabel)            t.connectionLabel = activeTab.connectionLabel;
    if (activeTab?.connectionTransport)        t.connectionTransport = activeTab.connectionTransport;
    if (activeTab?.branchName)                 t.branchName = activeTab.branchName;
    setTabs((prev) => [...prev, t]);
    setActiveTabId(t.tabId);
    if (status === "Idle" || status === "Error") {
      void connect({
        tabId: t.tabId,
        cwd: t.cwd,
        connectionId: t.connectionId ?? null,
        autonomy: t.autonomy,
      });
    }
  }

  /**
   * Open an EXISTING chat in a new tab. Pre-scopes the tab to the
   * chat's project (if any) and transport icon so the strip emoji
   * matches the source chat. The session id binds later via the
   * standard listener path.
   */
  function handleOpenChat(chatId: string, projectId?: string, transport?: string): void {
    // bug fix: clicking a project-filed chat row spawned a brand-
    // new tab + fresh grok session (with a fresh sessionId). follow-
    // up: harden dedupe — the chatId can be EITHER (a) an open tab's
    // `tabId`, (b) the open tab's `sessionId` (after session/new), or
    // (c) a past-chat sessionId from disk. Without the sessionId branch
    // an open tab with sessionId == chatId fell through to
    // `openPastSession`, which appends another tab → live duplicate
    // ("tests" appearing twice in history + open). Also: dedupe inside
    // `openPastSession` is the secondary guard for the rare case where
    // a past-chat click races a live re-spawn.
    const byTabId = tabs.find((t) => t.tabId === chatId);
    if (byTabId) {
      setActiveTabId(byTabId.tabId);
      return;
    }
    const bySessionId = chatId ? tabs.find((t) => t.sessionId === chatId) : undefined;
    if (bySessionId) {
      setActiveTabId(bySessionId.tabId);
      return;
    }
    // Past chat by sessionId — rehydrate from the on-disk jsonl. Look
    // up the title from pastChats / closedTabs so the tab strip shows
    // the right label until session_summary_generated arrives.
    const past = pastChats.find((c) => c.id === chatId);
    const closed = closedTabs.find((c) => c.sessionId === chatId);
    const title = past?.title ?? closed?.title ?? chatId;
    console.info("[App] open past chat:", chatId, "project:", projectId, "title:", title);
    void openPastSession(chatId, title, { connectionTransport: transport });
  }

  /**
   * Open a PAST (on-disk) session in a fresh tab and rehydrate its
   * events from the jsonl. Shared by LeftRail's onOpenPastChat and the
   * FindPopover "Open in new tab" button.
   */
  async function openPastSession(
    id: string,
    title: string,
    fallbackMeta?: SessionConnectionMeta,
  ): Promise<void> {
    // dedupe: if a tab with this sessionId is already open,
    // focus it instead of creating another. Closes the "tests" session
    // duplication path where past-chat rows and live tabs both carried
    // the same id but different handlers, so the click side could
    // accumulate copies.
    if (id) {
      const existing = tabs.find((t) => t.sessionId === id);
      if (existing) {
        setActiveTabId(existing.tabId);
        return;
      }
    }
    // recover the original cwd from the past-chat record (Rust
    // `list_stored_sessions` extracts it from the first session/new
    // frame in the jsonl). Without this, the new tab gets `cwd=""`
    // and file-preview rejects every path with "not under session cwd
    // '' ..." — same surface as #352.
    const past = pastChats.find((c) => c.id === id);
    const closed = closedTabs.find((c) => c.sessionId === id);
    const recoveredCwd = past?.cwd && past.cwd.length > 0 ? past.cwd : cwd;
    const t = newTabEntry(recoveredCwd, autonomy);
    t.sessionId = id;
    t.connectionId = past?.connectionId ?? closed?.connectionId ?? fallbackMeta?.connectionId ?? null;
    t.connectionLabel =
      past?.connectionLabel ?? closed?.connectionLabel ?? fallbackMeta?.connectionLabel
      ?? (t.connectionId ? "Saved connection" : "Local");
    t.connectionTransport =
      past?.connectionTransport ?? closed?.connectionTransport ?? fallbackMeta?.connectionTransport
      ?? "local";
    // Apply any user rename override and set titleLocked up-front so
    // the session_summary_generated handler can't clobber the renamed
    // title during the rehydration replay.
    // ALSO lock the title for reopened past sessions even
    // without an explicit user override. The summary was already
    // computed and stored; replaying the rehydrated events would
    // re-fire `session_summary_generated` and the handler would
    // re-title the tab. Past
    // sessions are finalized — their title shouldn't move.
    const override = chatTitleOverrides[id];
    t.title = override ?? title;
    t.titleLocked = true;
    setTabs((prev) => [...prev, t]);
    setActiveTabId(t.tabId);
    // Synthetic 'closed-XXX' ids have no on-disk jsonl.
    if (!id || id.startsWith("closed-")) return;
    // Explicit user-click reopen: do NOT dedupe by sessionId. Each tab
    // gets a fresh tabId, so re-loading and rewriting _meta.tabId
    // gives a clean per-tab event slice. The boot-time rehydration
    // dedupe set stays intact for the background listener.
    if (!inTauri()) return;
    try {
      const lines = await invoke<string[]>("read_session_jsonl", { sessionId: id });
      const recovered: RawEventFrame[] = [];
      for (const line of lines) {
        try {
          const ev = JSON.parse(line) as RawEventFrame;
          const p: any = ev.payload;
          if (p && typeof p === "object") {
            if (!p._meta) p._meta = {};
            p._meta.tabId = t.tabId;
            if (p.params && typeof p.params === "object") {
              if (!p.params._meta) p.params._meta = {};
              p.params._meta.tabId = t.tabId;
            }
          }
          recovered.push(ev);
        } catch { /* skip malformed */ }
      }
      if (recovered.length > 0) {
        setEvents((prev) => [...prev, ...recovered]);
      }
    } catch { /* non-fatal */ }
  }

  /** ⌘W: close the active tab. */
  function handleCloseTab(idToClose?: string): void {
    const tid = idToClose ?? activeTabId;
    if (!tid) return;
    const closingSessionId = tabs.find((t) => t.tabId === tid)?.sessionId ?? null;
    tabSessionByTab.current.delete(tid);
    if (closingSessionId) rehydratedSessionIds.current.delete(closingSessionId);
    try {
      if (localStorage.getItem(VOICE_OWNER_KEY) === tid) {
        localStorage.removeItem(VOICE_OWNER_KEY);
      }
      localStorage.setItem(`${VOICE_KEY_PREFIX}${tid}`, "0");
    } catch { /* ignore voice-state cleanup */ }
    setTabs((prev) => {
      const idx = prev.findIndex((t) => t.tabId === tid);
      if (idx < 0) return prev;
      const closing = prev[idx];
      // Archive the tab into closedTabs so the sidebar's Past Chats
      // list still shows it even if it never produced a jsonl (failed
      // to connect). Empty/untitled tabs are skipped.
      if (closing && (closing.title || closing.sessionId)) {
        archiveClosedTab(closing);
      }
      const next = prev.filter((t) => t.tabId !== tid);
      if (tid === activeTabId) {
        const fallback = next[idx] ?? next[idx - 1] ?? null;
        setActiveTabId(fallback ? fallback.tabId : null);
      }
      return next;
    });
    /* Sequence abort → drop → refresh with await so abort_session
     * doesn't recreate a registry slot just after drop removed it
     * (and drop doesn't race a still-in-flight abort). */
    void (async () => {
      if (tid === activeTabId && (status === "Connected" || status === "Aborting")) {
        try { await invoke("abort_session", { tabId: tid }); } catch { /* non-fatal */ }
      }
      if (inTauri()) {
        try { await invoke<boolean>("drop_tab_session", { tabId: tid }); }
        catch (err) { pushUiEvent(`drop_tab_session(${tid}) failed: ${err}`); }
      }
      void refreshPastChats();
    })();
  }

  function handleActivateTab(id: string): void {
    setActiveTabId(id);
  }

  function toggleTerminalTab(): void {
    setBottomTab((t) => (t === "Terminal" ? "Chat" : "Terminal"));
  }

  function handleSettingsChange(s: SettingsValues): void {
    setSettings(s);
    applyTheme(s);
    persistSettings(s);
  }

  function closeAllModals(): void {
    // The useKeyboardShortcuts hook listens in CAPTURE phase +
    // stopPropagation, so the central registry's Esc handler runs
    // BEFORE any local modal's own Esc listener. Every modal's open
    // flag must reset here or the modal stays open on Esc.
    setHelpOpen(false);
    setPaletteOpen(false);
    setSettingsOpen(false);
    setPluginsOpen(false);
    setPrModalOpen(false);
    setVaultOpen(false);
    setAssetBoardOpen(false);
  }

  // ─── Keyboard shortcuts via the central registry ──────────────────────
  // App.tsx wires action ids → handlers; HelpModal renders the same
  // registry's labels so they never drift.
  useKeyboardShortcuts({
    help: () => setHelpOpen((v) => !v),
    escape: () => closeAllModals(),
    palette: () => setPaletteOpen(true),
    settings: () => setSettingsOpen(true),
    "toggle-terminal": toggleTerminalTab,
    "new-session": handleNewTab,
    "close-session": () => handleCloseTab(),
    attach: () => { void handleAttach(); },
    "cycle-autonomy": () => void setAutonomyAndPersist(cycleAutonomy(autonomy)),
    // j/k/y/n/e are handled inside ChatOutput (per-card focus). Leave
    // them un-mapped here so the registry's skipInInput logic doesn't
    // block focus-aware behavior.
  });

  // ─── Build PaletteAction list ─────────────────────────────────────────
  const paletteActions = useMemo<PaletteAction[]>(() => {
    const acts: PaletteAction[] = [
      { id: "act-connect",  label: "Connect grok session", hint: cwd, group: "Action", run: () => void connect() },
      { id: "act-abort",    label: "Abort current session", group: "Action", run: () => void abort() },
      { id: "act-new",      label: "New session tab (⌘T)", group: "Action", run: handleNewTab },
      { id: "act-close",    label: "Close current tab (⌘W)", group: "Action", run: () => handleCloseTab() },
      { id: "act-settings", label: "Open settings (⌘,)", group: "Action", run: () => setSettingsOpen(true) },
      {
        id: "act-desktop-integrations",
        label: "Desktop integrations",
        hint: "Send files to shellX",
        group: "Action",
        run: () => {
          try { localStorage.setItem(SETTINGS_TAB_KEY, "desktop"); } catch { /* ignore */ }
          setSettingsOpen(true);
        },
      },
      { id: "act-attach",   label: "Attach file (⌘U)", group: "Action", run: () => void handleAttach() },
      { id: "act-attach-screenshot", label: "Attach app screenshot", group: "Action", run: () => void handleAttachScreenshot() },
      {
        id: "act-asset-board",
        label: "Attachment and media board",
        hint: `${pendingAttachmentChips.length + sessionAttachments.length} attached · ${sessionMedia.images.length} images · ${sessionMedia.videos.length} videos`,
        group: "Action",
        run: () => setAssetBoardOpen(true),
      },
      {
        id: "act-open-work-preview",
        label: "Open Work Preview",
        hint: activeWorkPreviewState.url ?? workPreviewStatusLabel(activeWorkPreviewState.status),
        group: "Action",
        run: () => {
          setRightRailRequest({ tab: "Preview", seq: Date.now() });
          setPreviewCenterView("work");
          setPreviewCenterOpen(true);
        },
      },
      ...(activeWorkPreviewState.url || activeWorkPreviewState.status === "failed"
        ? [{
            id: "act-preview-doctor",
            label: "Ask Grok to fix current preview",
            hint: activeWorkPreviewState.url ?? activeWorkPreviewState.error ?? "Preview Doctor",
            group: "Action" as const,
            run: () => void handleAskGrokToFixPreview(activeWorkPreviewState),
          }]
        : []),
      { id: "act-toggle-term", label: "Toggle Chat / Terminal (⌘`)", group: "Action", run: toggleTerminalTab },
      { id: "act-pr", label: "Create pull request (/pr)", group: "Action", run: () => setPrModalOpen(true) },
      { id: "act-vault", label: "Open vault (secrets)", group: "Action", run: () => setVaultOpen(true) },
      { id: "act-help",     label: "Show keyboard shortcuts (?)", group: "Action", run: () => setHelpOpen(true) },
      // `plan` and `acceptEdits` modes were silent no-ops in
      // grok-build's ACP transport and are coerced to "default" at the
      // bridge layer. Drop them from the command palette so users
      // don't see options that don't do anything.
      { id: "act-auto-confirm", label: "Autonomy: Confirm (default)", group: "Action", run: () => void setAutonomyAndPersist("default") },
      { id: "act-auto-auto",    label: "Autonomy: Auto (bypassPermissions)", group: "Action", run: () => void setAutonomyAndPersist("bypassPermissions") },
    ];
    return acts;
  }, [activeWorkPreviewState, cwd, pendingAttachmentChips.length, sessionAttachments.length, sessionMedia.images.length, sessionMedia.videos.length, status]);

  async function setAutonomyAndPersist(mode: AutonomyMode): Promise<void> {
    setAutonomy(mode);
    updateActiveTab({ autonomy: mode });
    try { await invoke("set_permission_mode", { mode, tabId: activeTab?.tabId ?? null }); } catch { /* non-fatal */ }
    try {
      const res = await apiPostJson<{ appliesAfterReconnect?: boolean }>("/autonomy", {
        mode,
        tabId: activeTabIdRef.current ?? activeTab?.tabId ?? null,
      });
      if (res?.appliesAfterReconnect) {
        window.dispatchEvent(
          new CustomEvent("shellx:autonomy-needs-reconnect", {
            detail: { mode },
          }),
        );
      }
    } catch { /* debug API may be off */ }
  }

  function insertSlashIntoPrompt(name: string): void {
    setPrompt((p) => (p && !p.endsWith(" ") ? `${p} /${name} ` : `/${name} `));
    setBottomTab("Chat");
  }

  function appendTextToPrompt(text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    setPrompt((p) => {
      const current = p.trim();
      return current.length > 0 ? `${current}\n\n${trimmed}` : trimmed;
    });
    setBottomTab("Chat");
  }

  // Session tab strip — reads per-tab status from each TabEntry so an
  // inactive tab whose grok is still streaming renders as "run", not
  // "idle".
  const sessionTabs: SessionTab[] = tabs.map((t) => {
    const tabStatus = t.status ?? "Idle";
    const tabSending = t.isSending ?? false;
    return {
      id: t.tabId,
      title: t.title,
      status: tabSending
        ? "run"
        : (tabStatus === "Connected" ? "done" : "idle"),
      transport: t.connectionTransport,
      preview: Boolean(workPreviewByTab.get(t.tabId)?.url),
      previewLabel: workPreviewByTab.get(t.tabId)?.kind
        ? `${workPreviewKindLabel(workPreviewByTab.get(t.tabId)?.kind ?? null)} preview`
        : "Open preview",
    };
  });
  const voiceSessionTabs = useMemo(
    () => tabs.map((t) => ({ tabId: t.tabId, title: t.title || "new session" })),
    [tabs],
  );

  // Panel sizes — persisted via react-resizable-panels autoSaveId,
  // mirrored to /panels for the debug driver.
  const handleHorizontalLayout = (sizes: number[]) => {
    try { localStorage.setItem(PANEL_SIZE_KEY_H, JSON.stringify(sizes)); } catch { /* no-op */ }
    void apiPost("/panels", {
      horizontal: sizes,
      vertical: readLocal(PANEL_SIZE_KEY_V, [62, 38]),
    }).catch(() => { /* no-op */ });
  };
  const handleVerticalLayout = (sizes: number[]) => {
    try { localStorage.setItem(PANEL_SIZE_KEY_V, JSON.stringify(sizes)); } catch { /* no-op */ }
    void apiPost("/panels", {
      horizontal: readLocal(PANEL_SIZE_KEY_H, [18, 56, 26]),
      vertical: sizes,
    }).catch(() => { /* no-op */ });
  };

  // Auto-connect on first mount: intentionally NOT wired. Connect must
  // be explicit (workspace chip click or the first send via auto-
  // connect-then-send) to avoid surprise spawns.

  // Two-weight masthead: split title at the last space; trail is dimmer.
  const { titleMain, titleTrail } = splitTitleForMasthead(sessionTitle);

  // Pre-compute drafts for the PR modal. Title from session summary;
  // body = last 30 assistant chunks + tool-call list; transcript
  // appendix = full ui event log.
  const prDraftTitle = sessionTitle === "new session" ? "" : sessionTitle.slice(0, 70);
  const prDraftBody = useMemo(() => {
    // Pull assistant text + tool kinds.
    const assistantText: string[] = [];
    const toolCalls: string[] = [];
    for (const e of events) {
      if (e.kind !== "grok-acp-event") continue;
      const p = e.payload as any;
      const up = p?.params?.update;
      if (up?.sessionUpdate === "agent_message_chunk") {
        const c = up.content;
        const txt = Array.isArray(c) ? c[0]?.text : c?.text;
        if (typeof txt === "string") assistantText.push(txt);
      }
      if (up?.sessionUpdate === "tool_call") {
        const k = up.kind ?? p?.params?._meta?.updateParams?.kind ?? "tool";
        const title = up.title ?? "";
        toolCalls.push(`- ${k}${title ? `: ${title}` : ""}`);
      }
    }
    const summary = assistantText.join("").trim().slice(0, 1200);
    const tools = toolCalls.slice(0, 30).join("\n") || "_(no tool calls captured)_";
    return `## Summary\n\n${summary || "_(empty)_"}\n\n## Tool calls\n\n${tools}\n\n## Test plan\n\n_Describe how the change was verified (tests run, scenarios walked, transports covered)._`;
  }, [events]);
  const prTranscript = useMemo(
    () => events.slice(-200)
      .map((e) => `[${new Date(e.t).toISOString()}] ${e.kind} ${JSON.stringify(e.payload).slice(0, 200)}`)
      .join("\n"),
    [events],
  );

  return (
    <div className="shell">
      <UpdateBanner />
      <Header
        cwd={cwd}
        autonomy={autonomy}
        totalTokens={totalTokens}
        maxTokens={maxTokens}
        onAutonomyChange={handleAutonomyChange}
        onWorkspaceClick={() => void handleWorkspaceClick()}
        onOpenSettings={() => setSettingsOpen(true)}
        onOpenPlugins={() => setPluginsOpen(true)}
        onOpenConnectorInbox={() => setConnectorInboxOpen(true)}
        outsideConnectorInbox={outsideConnectorInboxSummary}
        onOpenAbout={openAboutInSettings}
        hideAutonomyDial={true}
        /* tabId routes the per-tab set_permission_mode invoke. */
        activeTabId={activeTabId}
        /* Live-sessions badge: count of tabs with a live grok
         * subprocess attached. sessionId is durable history; status is
         * reconciled against the current Rust registry on boot. */
        liveTabCount={tabs.filter((t) => t.status === "Connected").length}
        /* "Groks working" pill: count of grok subprocesses +
         * host-MCP subagents in running state. Polled from
         * list_background_tasks every 2 s above. */
        liveGrokCount={liveGrokCount}
        /* Find searches the live session-tab corpus. Each open tab
         * becomes a ChatHit so Cmd+K + the header Find popover
         * surface real work-in-progress. JSONL content search lands
         * once /sessions/search ships. */
        findCorpus={tabs.map((t) => ({
          id: t.tabId,
          title: t.title || "(untitled)",
          transport: t.connectionTransport ?? "local",
          project: t.projectId ?? "—",
          ageLabel: "open",
          status: t.status === "Connected" ? "run" : "idle",
        }))}
        onOpenChat={(id) => {
          /* Two-tier dispatch:
           * 1. If `id` matches an OPEN tab's tabId → focus it.
           * 2. Otherwise treat `id` as a sessionId and open the
           * past session in a fresh tab via openPastSession. */
          const openTab = tabs.find((t) => t.tabId === id);
          if (openTab) {
            setActiveTabId(openTab.tabId);
            return;
          }
          // Look up title from pastChats / closedTabs / hit's own id.
          const past = pastChats.find((c) => c.id === id);
          const closed = closedTabs.find((c) => c.sessionId === id);
          const title = past?.title ?? closed?.title ?? id;
          void openPastSession(id, title);
        }}
      />

      {error && <div className="error-banner">{error}</div>}

      <ClipboardCopiedToast />

      <div className="shell-body">
        <PanelGroup
          direction="horizontal"
          autoSaveId="grok-shell-h"
          onLayout={handleHorizontalLayout}
        >
          <Panel defaultSize={18} minSize={12} maxSize={36}>
            {/* LeftRail = Projects + Past chats. Project + chat clicks
                open new session tabs via handleOpenProject /
                handleOpenChat. A tab belongs to project p when
                t.projectId === p.id OR (for past chats)
                sessionProjects[t.sessionId] === p.id. */}
            <LeftRail
              cwd={cwd}
              activeTabId={activeTabId}
              onPreviewFile={handlePreviewFile}
              onOpenProject={handleOpenProject}
              onOpenChat={handleOpenChat}
              projects={projects.map((p) => ({
                id: p.id,
                name: p.name,
                chats: tabs
                  .filter((t) =>
                    t.projectId === p.id ||
                    (t.sessionId != null && sessionProjects[t.sessionId] === p.id),
                  )
                  .map((t) => ({
                    id: t.tabId,
                    title: t.title || "(untitled)",
                    transport: t.connectionTransport ?? "local",
                    status: (t.isSending ? "run" : (t.status === "Connected" ? "done" : "idle")) as "run" | "done" | "idle" | "input",
                  })),
              }))}
              openTabs={tabs
                .filter((t) => {
                  if (t.projectId) return false;
                  if (t.sessionId != null && sessionProjects[t.sessionId]) return false;
                  return true;
                })
                .map((t) => ({
                  tabId: t.tabId,
                  title: t.title || "(untitled)",
                  projectId: t.projectId,
                  connectionTransport: t.connectionTransport,
                  isActive: t.tabId === activeTabId,
                  hasLiveSession: t.status === "Connected",
                }))}
              onAddProject={() => handleAddProject()}
              onFocusTab={(tabId) => setActiveTabId(tabId)}
              /* Name-only inline rename for projects + chats.
               * Right-click → Move to project. */
              renamingProjectId={renamingProjectId}
              onRenameProject={handleRenameProject}
              onRenameChat={handleRenameChat}
              onAssignChatToProject={handleAssignChatToProject}
              /* Past chats: disk-backed pastChats merged with the
               * closedTabs archive (failed-connect tabs without a
               * sessionId still surface). Project-filed entries are
               * surfaced under that project's row instead, so this
               * list becomes the unfiled bucket. */
              pastChats={(() => {
                // Build sessionId→transport from closedTabs so
                // disk-listed past chats can show the right emoji
                // even when we don't have their TabEntry in memory.
                const metaBySessionId = new Map<string, SessionConnectionMeta>();
                for (const c of closedTabs) {
                  if (c.sessionId) {
                    metaBySessionId.set(c.sessionId, {
                      connectionId: c.connectionId,
                      connectionLabel: c.connectionLabel,
                      connectionTransport: c.connectionTransport,
                    });
                  }
                }
                // Apply chatTitleOverrides so a renamed live tab's
                // title sticks even on its closed/past-chat row.
                const titleFor = (id: string, fallback: string): string =>
                  chatTitleOverrides[id] ?? fallback;
                const out: (StoredSession & SessionConnectionMeta)[] = [];
                const seen = new Set<string>();
                for (const c of pastChats) {
                  if (seen.has(c.id)) continue;
                  if (sessionProjects[c.id]) continue;
                  seen.add(c.id);
                  const meta = metaBySessionId.get(c.id);
                  out.push({
                    ...c,
                    title: titleFor(c.id, c.title),
                    connectionId: c.connectionId ?? meta?.connectionId,
                    connectionLabel: c.connectionLabel ?? meta?.connectionLabel,
                    connectionTransport: c.connectionTransport ?? meta?.connectionTransport,
                  });
                }
                for (const c of closedTabs) {
                  const id = c.sessionId ?? `closed-${c.tabId}`;
                  if (seen.has(id)) continue;
                  if (c.sessionId && sessionProjects[c.sessionId]) continue;
                  seen.add(id);
                  out.push({
                    id,
                    title: titleFor(id, c.title),
                    mtime_ms: c.closedAtMs,
                    size: 0,
                    connectionId: c.connectionId,
                    connectionLabel: c.connectionLabel,
                    connectionTransport: c.connectionTransport,
                  });
                }
                out.sort((a, b) => b.mtime_ms - a.mtime_ms);
                return out;
              })()}
              /* Past chats assigned to a project — surfaced under
               * that project's row alongside its open tabs. */
              pastChatsByProject={Object.fromEntries(
                projects.map((p) => {
                  // Same title override + transport plumbing as
                  // pastChats above, scoped to project p.
                  const metaBySessionId = new Map<string, SessionConnectionMeta>();
                  for (const c of closedTabs) {
                    if (c.sessionId) {
                      metaBySessionId.set(c.sessionId, {
                        connectionId: c.connectionId,
                        connectionLabel: c.connectionLabel,
                        connectionTransport: c.connectionTransport,
                      });
                    }
                  }
                  const titleFor = (id: string, fallback: string): string =>
                    chatTitleOverrides[id] ?? fallback;
                  // fix: exclude past chats whose sessionId is
                  // already represented by a live open tab. Without
                  // this filter, clicking a past-chat-in-project
                  // spawns a new tab with the same sessionId; the
                  // live tab matches `sessionProjects[X]===p.id` and
                  // renders inside `p.chats[]`, AND the past row
                  // ALSO stays in pastChatsByProject — same name
                  // appears twice in the project. The live tab is the canonical
                  // surface; hide the past row while the tab is
                  // open.
                  const openSessionIds = new Set(
                    tabs.map((t) => t.sessionId).filter((s): s is string => !!s),
                  );
                  const items: {
                    id: string;
                    title: string;
                    mtime_ms: number;
                    connectionId?: string | null;
                    connectionLabel?: string;
                    connectionTransport?: string;
                  }[] = [];
                  const seen = new Set<string>();
                  for (const c of pastChats) {
                    if (
                      sessionProjects[c.id] === p.id
                      && !seen.has(c.id)
                      && !openSessionIds.has(c.id)
                    ) {
                      seen.add(c.id);
                      const meta = metaBySessionId.get(c.id);
                      items.push({
                        id: c.id,
                        title: titleFor(c.id, c.title),
                        mtime_ms: c.mtime_ms,
                        connectionId: c.connectionId ?? meta?.connectionId,
                        connectionLabel: c.connectionLabel ?? meta?.connectionLabel,
                        connectionTransport: c.connectionTransport ?? meta?.connectionTransport,
                      });
                    }
                  }
                  for (const c of closedTabs) {
                    if (
                      c.sessionId
                      && sessionProjects[c.sessionId] === p.id
                      && !seen.has(c.sessionId)
                      && !openSessionIds.has(c.sessionId)
                    ) {
                      seen.add(c.sessionId);
                      items.push({
                        id: c.sessionId,
                        title: titleFor(c.sessionId, c.title),
                        mtime_ms: c.closedAtMs,
                        connectionId: c.connectionId,
                        connectionLabel: c.connectionLabel,
                        connectionTransport: c.connectionTransport,
                      });
                    }
                  }
                  items.sort((a, b) => b.mtime_ms - a.mtime_ms);
                  return [p.id, items];
                }),
              )}
              onAssignSessionToProject={handleAssignSessionToProject}
              onOpenPastChat={async (id, title) => {
                await openPastSession(id, title);
              }}
              onRenamePastChat={handleRenamePastChat}
              onDeleteProject={(id, deleteSessions) => {
                /* Two branches:
                 * - marker-only: drop the project entry + strip
                 * sessionProjects entries pointing at it so
                 * chats don't end up "ghost-filed".
                 * - marker + sessions: also unlink the JSONLs of
                 * every chat filed under this project. Live tabs
                 * are closed first so the registry slot is
                 * released before disk unlink. */
                const filedSessionIds = Object.entries(sessionProjects)
                  .filter(([, pid]) => pid === id)
                  .map(([sid]) => sid);
                const filedOpenTabs = tabs.filter((t) => t.projectId === id);
                if (deleteSessions) {
                  // Close live tabs first so the grok subprocess is
                  // killed before we touch its JSONL.
                  for (const t of filedOpenTabs) {
                    if (inTauri()) {
                      void invoke("drop_tab_session", { tabId: t.tabId }).catch(() => {});
                    }
                  }
                  setTabs((prev) => prev.filter((t) => t.projectId !== id));
                  // Collect every sessionId we know about for this
                  // project — sessionProjects map + sessionIds of open
                  // tabs (which may not be in the map yet).
                  const idsToDelete = new Set<string>(filedSessionIds);
                  for (const t of filedOpenTabs) {
                    if (t.sessionId) idsToDelete.add(t.sessionId);
                  }
                  if (idsToDelete.size > 0 && inTauri()) {
                    void invoke<string[]>("delete_session_files", {
                      ids: Array.from(idsToDelete),
                    })
                      .then(() => { void refreshPastChats(); })
                      .catch((e) => {
                        console.warn("delete_session_files failed:", e);
                      });
                    // Also remove from closedTabs — disk is canonical.
                    setClosedTabs((prev) =>
                      prev.filter((c) => !c.sessionId || !idsToDelete.has(c.sessionId)),
                    );
                  }
                }
                // Always: drop the marker + strip sessionProjects
                // entries pointing at it so chats unfile cleanly.
                setProjects((prev) => prev.filter((p) => p.id !== id));
                setSessionProjects((prev) => {
                  const next: Record<string, string> = {};
                  for (const [sid, pid] of Object.entries(prev)) {
                    if (pid !== id) next[sid] = pid;
                  }
                  return next;
                });
                if (!deleteSessions) {
                  // Open tabs filed under this project get unfiled
                  // (so they appear under "Open chats" instead of
                  // a phantom project that no longer exists).
                  setTabs((prev) =>
                    prev.map((t) =>
                      t.projectId === id ? { ...t, projectId: undefined } : t,
                    ),
                  );
                }
              }}
              onDeleteSession={(target) => {
                /* Single-session permanent delete — LeftRail 🗑 icon. */
                if (target.kind === "tab") {
                  const t = tabs.find((tt) => tt.tabId === target.tabId);
                  if (!t) return;
                  const sessionId = t.sessionId;
                  if (inTauri()) {
                    void invoke("drop_tab_session", { tabId: t.tabId }).catch(() => {});
                  }
                  setTabs((prev) => prev.filter((tt) => tt.tabId !== target.tabId));
                  if (sessionId && inTauri()) {
                    void invoke<string[]>("delete_session_files", { ids: [sessionId] })
                      .then(() => void refreshPastChats())
                      .catch((e) => console.warn("delete_session_files failed:", e));
                    setClosedTabs((prev) =>
                      prev.filter((c) => c.sessionId !== sessionId),
                    );
                  }
                  return;
                }
                // past — sessionId-only
                if (inTauri()) {
                  void invoke<string[]>("delete_session_files", {
                    ids: [target.sessionId],
                  })
                    .then(() => void refreshPastChats())
                    .catch((e) => console.warn("delete_session_files failed:", e));
                  setClosedTabs((prev) =>
                    prev.filter((c) => c.sessionId !== target.sessionId),
                  );
                  setPastChats((prev) => prev.filter((c) => c.id !== target.sessionId));
                }
              }}
            />
          </Panel>
          <PanelResizeHandle />

          {/* mid+right wrapped so the SessionTabs row sits on top of
            * both but NOT over the left rail. Inside:
            * - SessionTabs (flex shrink 0)
            * - .mid-right-body — inner horizontal PanelGroup with
            * mid | right rail.
            */}
          <Panel defaultSize={82} minSize={50}>
            <div className="mid-right-wrap">
              <SessionTabs
                sessions={sessionTabs}
                activeId={activeTabId}
                onActivate={handleActivateTab}
                onNew={handleNewTab}
                onClose={handleCloseTab}
                onOpenPreview={(tabId) => {
                  setActiveTabId(tabId);
                  setPreviewCenterView("work");
                  setPreviewCenterOpen(true);
                }}
                /* Inline rename from the tab strip — mirrors the
                 * LeftRail double-click-to-rename UX. */
                onRename={handleRenameChat}
              />
              <div className="mid-right-body">
                <PanelGroup
                  direction="horizontal"
                  autoSaveId="grok-shell-mid-right"
                >
                  <Panel defaultSize={68} minSize={30}>
                    <main className="mid">
                      <PanelGroup
                        direction="vertical"
                        /* 0.1.29 — bumped v4 → v5 because the composer is
                         * now a three-row working surface. Give it enough
                         * default space at the app's normal startup size,
                         * not only when the window is maximized on 4K. */
                        autoSaveId="grok-shell-v5"
                        onLayout={handleVerticalLayout}
                      >
                <Panel defaultSize={62} minSize={30}>
                    <div className="mid-pane-body">
                        <div className="mid-head">
                          <h2 title={sessionTitle}>
                            {titleMain}
                            {titleTrail && <span className="trail">{titleTrail}</span>}
                          </h2>
                          {/* Per-session token gauge — placed beside the
                           * chat title so every tab shows its own usage.
                           * totalTokens (active tab's latest
                           * _meta.totalTokens) and maxTokens (detected
                           * context-window cap) are tab-scoped. */}
                          <div
                            className="tok mid-head-tok"
                            title={`Context window: ${totalTokens.toLocaleString()} of ${maxTokens.toLocaleString()} (${maxTokens > 0 ? ((totalTokens / maxTokens) * 100).toFixed(1) : "0"}%)`}
                          >
                            <strong>{formatTokens(totalTokens)}</strong>
                            {" / "}
                            {formatTokens(maxTokens, true)}
                            <span className="tok-bar">
                              <span
                                className="tok-bar-fill"
                                style={{
                                  width: `${Math.min(100, (totalTokens / Math.max(maxTokens, 1)) * 100)}%`,
                                }}
                              />
                            </span>
                          </div>
                          {/* Per-session download button: archives the
                           * ACTIVE tab's cwd + grok scratch. Disabled
                           * when no session is active. */}
                          <SessionArtifactDownload
                            activeTabId={activeTabId}
                            cwd={activeTab?.cwd ?? ""}
                          />
                        </div>
                        <ChatOutput
                          groups={groups}
                          onPreviewFile={handlePreviewFile}
                          // tabId forward so inline
                          // <TerminalView attachOnly/> binds to the right
                          // ACP-origin PTY in the registry.
                          tabId={activeTabId ?? undefined}
                        />
                  </div>
                </Panel>
                <PanelResizeHandle />
                <Panel defaultSize={38} minSize={34} maxSize={70}>
                  <BottomPanel
                    prompt={prompt}
                    onPromptChange={setPrompt}
                    /* `send` auto-connects when status !== "Connected"
                     * so past-chat reopens don't drop the prompt. */
                    onSend={send}
                    onAbort={abort}
                    isSending={isSending}
                    connected={status === "Connected"}
                    /* Keys the Terminal tab's PTY per-session. */
                    activeTabId={activeTabId}
                    voiceSessionTabs={voiceSessionTabs}
                    /* Filter to the active tab's events so the
                     * Logs/Stderr tabs don't mix all tabs. */
                    events={eventsForActiveTab}
                    groups={groups}
                    tab={bottomTab}
                    onTabChange={setBottomTab}
                    onAttach={() => void handleAttach()}
                    onAttachScreenshot={() => void handleAttachScreenshot()}
                    attachments={pendingAttachmentChips}
                    onRemoveAttachment={removePendingAttachment}
                    /* Drag-and-drop attach from the right-rail Files
                     * tab — same pipeline as the dialog branch. */
                    onAttachPaths={(paths) => void processAttachedPaths(paths)}
                    onAttachFiles={(files) => void processDroppedAttachmentFiles(files)}
                    onPreviewFile={handlePreviewFile}
                    onOpenActivity={() => setActivityOpen(true)}
                    onOpenAssetBoard={() => setAssetBoardOpen(true)}
                    hashItems={hashItems}
                    skills={visibleSlashCommands.map((s: any) => ({ name: s.name, description: s.description }))}
                    autonomy={autonomy}
                    onAutonomyChange={handleAutonomyChange}
                    /* Scope pills: connection/branch/cwd are per-tab
                     * on TabEntry; App is the source of truth and
                     * updates activeTab on the callbacks below. The
                     * "scope" pill shows the cwd basename (FOLDER,
                     * not project — project lives separately on
                     * TabEntry.projectId and is managed via LeftRail). */
                    scopeProject={
                      (activeTab?.cwd ?? cwd).split("/").filter(Boolean).pop() ?? "(no folder)"
                    }
                    /* Full cwd path — threaded down to BranchPicker so
                     * `git for-each-ref` runs against the right repo. */
                    activeCwd={activeTab?.cwd ?? cwd}
                    /* Folder-pill click → Tauri folder picker. Updates
                     * ONLY the active tab's cwd; does not create a
                     * project. */
                    onPickProject={async () => {
                      try {
                        const selected = await openDialog({
                          directory: true,
                          multiple: false,
                          defaultPath: activeTab?.cwd ?? cwd,
                        });
                        if (!selected || typeof selected !== "string") return;
                        updateActiveTab({ cwd: selected });
                        setCwd(selected);
                      } catch (err) {
                        pushUiEvent(`✗ pick-folder failed: ${err}`);
                      }
                    }}
                    /* Lock the connection pill once the first message
                     * has been sent. Transport changes belong in a
                     * fresh tab after that point. */
                    connectionLocked={Boolean(activeTab?.firstMessageMs)}
                    scopeConnection={activeTab?.connectionLabel ?? "Local"}
                    scopeConnectionTransport={activeTab?.connectionTransport ?? "local"}
                    scopeBranch={activeTab?.branchName ?? "—"}
                    scopeBranchAhead={activeTab?.branchAhead}
                    onSelectConnection={(preset) => {
                      const t = preset.transport.kind;
                      updateActiveTab({
                        connectionId: preset.id,
                        connectionLabel: preset.label,
                        connectionTransport: t === "ws_tunnel" ? "cloud" : t,
                      });
                    }}
                    onSelectBranch={(name) => updateActiveTab({ branchName: name })}
                    onCreateWorktree={() => {
                      /* Worktree creation is not on the v1 roadmap.
                       * The handler is kept (required by BranchPicker
                       * types) but intentionally no-ops. */
                    }}
                  />
                </Panel>
              </PanelGroup>
            </main>
                  </Panel>
                  <PanelResizeHandle />

                  <Panel defaultSize={32} minSize={15} maxSize={60}>
                    <RightRail
                      preview={activeTab?.preview ?? null}
                      onPreviewClear={() => updateActiveTab({ preview: undefined })}
                      autonomy={autonomy}
                      /* Wire Files-tab clicks through to App's preview
                       * pipeline. Filter to active-tab events so
                       * PlanPane parses only this tab's plan_proposed
                       * shapes. */
                      onPreviewFile={handlePreviewFile}
                      onAttachPaths={(paths) => {
                        setBottomTab("Chat");
                        void processAttachedPaths(paths);
                      }}
                      events={eventsForActiveTab}
                      cwd={activeTab?.cwd ?? cwd}
                      activeTabId={activeTabId}
                      /* Pre-fetched plan.md for the active tab so
                       * PlanPane has content ready on its first
                       * render after EnterPlanMode. Undefined falls
                       * back to PlanPane's own fetch path. */
                      prefetchedPlanText={
                        activeTabId ? planTextByTab.get(activeTabId) : undefined
                      }
                      requestedTab={rightRailRequest?.tab ?? null}
                      requestedTabSeq={rightRailRequest?.seq}
                      onOpenGoalReview={() => setGoalReviewRequestSeq((seq) => seq + 1)}
                      connectionLabel={activeTab?.connectionLabel ?? "Local"}
                      connectionTransport={activeTab?.connectionTransport ?? "local"}
                      sessionStatus={activeTab?.status ?? "Idle"}
                      onSendPromptToActiveTab={(text) => void sendPromptText(text, activeTabId)}
                      onWorkPreviewStateChange={(state) => {
                        setWorkPreviewByTab((prev) => {
                          const next = new Map(prev);
                          next.set(state.tabId, state);
                          return next;
                        });
                      }}
                      onOpenWorkPreview={(state) => {
                        setWorkPreviewByTab((prev) => {
                          const next = new Map(prev);
                          next.set(state.tabId, state);
                          return next;
                        });
                        setPreviewCenterView("work");
                        setPreviewCenterOpen(true);
                      }}
                      onAskGrokToFixPreview={(state) => void handleAskGrokToFixPreview(state)}
                    />
                  </Panel>
                </PanelGroup>
              </div>
            </div>
          </Panel>
        </PanelGroup>
      </div>

      {/* Status pills + event count live in the header / mid-head.
       * No global footer strip. */}

      {helpOpen && <HelpModal onClose={() => setHelpOpen(false)} />}
      {/* Mounted at App level so any tab's pending Confirm prompt
       * can pop the dialog. Listens for `permission-request` events
       * with `scope: "terminal/create"` + a `request_id` field.
       * *  Issue #374 — the in-chat PermissionPill is now the canonical
       * surface; the modal is gated by the `permissionUx` setting so
       * Confirm-mode users can opt out of the focus-stealing popup
       * while still seeing pills in the chat (which double as the
       * audit trail). Default is "pill" only; legacy "modal" keeps
       * the popup; "both" shows both surfaces. */}
      {settings.permissionUx !== "pill" && <PermissionModal />}
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        actions={paletteActions}
        skills={visibleSlashCommands}
        insertSlash={insertSlashIntoPrompt}
      />
      <Settings
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        initial={settings}
        onChange={handleSettingsChange}
      />
      <PluginsModal
        open={pluginsOpen}
        onClose={() => setPluginsOpen(false)}
        activeTabId={activeTabId}
      />
      <ConnectorInboxModal
        open={connectorInboxOpen}
        onClose={() => setConnectorInboxOpen(false)}
        onSeen={markConnectorInboxSeen}
      />
      <AttachmentMediaBoard
        open={assetBoardOpen}
        attachments={pendingAttachmentChips}
        sessionAttachments={sessionAttachments}
        images={sessionMedia.images}
        videos={sessionMedia.videos}
        tabId={activeTabId}
        sessionCwd={activeTab?.cwd ?? cwd}
        onClose={() => setAssetBoardOpen(false)}
        onAttach={() => void handleAttach()}
        onAttachScreenshot={() => void handleAttachScreenshot()}
        onRemoveAttachment={removePendingAttachment}
        onPreviewFile={handlePreviewFile}
        onInsertPrompt={appendTextToPrompt}
      />
      <BuiltinDocModal
        docId={builtinDocId}
        onClose={() => setBuiltinDocId(null)}
      />
      <PreviewCenter
        open={previewCenterOpen}
        view={previewCenterView}
        filePath={previewPath}
        tabId={activeTabId}
        sessionCwd={activeTab?.cwd ?? cwd}
        workState={activeWorkPreviewState}
        onClose={() => setPreviewCenterOpen(false)}
        onViewChange={setPreviewCenterView}
        onPreviewFile={handlePreviewFile}
        onRunWorkPreview={handlePreviewFile}
        onAskGrokToFix={(state) => void handleAskGrokToFixPreview(state)}
      />
      <ActivityBrowserModal
        open={activityOpen}
        tabId={activeTabId}
        sessionId={activeTab?.sessionId ?? null}
        sessionCwd={activeTab?.cwd ?? cwd}
        transport={activeTab?.connectionTransport ?? "local"}
        onClose={() => setActivityOpen(false)}
        onPreviewFile={handlePreviewFile}
        onAskAgent={(text) => void sendPromptText(text, activeTabId)}
      />
      <GoalPlanReviewModal
        activeTabId={activeTabId}
        eventsLen={eventsForActiveTab.length}
        openRequestSeq={goalReviewRequestSeq}
        onPreviewFile={handlePreviewFile}
        onAccepted={() => {
          setRightRailRequest((cur) => ({ tab: "Plan", seq: (cur?.seq ?? 0) + 1 }));
        }}
        onReviewLater={() => {
          setRightRailRequest((cur) => ({ tab: "Plan", seq: (cur?.seq ?? 0) + 1 }));
        }}
      />
      <PRCreateModal
        open={prModalOpen}
        onClose={() => setPrModalOpen(false)}
        defaultBase="main"
        defaultTitle={prDraftTitle}
        defaultBody={prDraftBody}
        transcriptAppendix={prTranscript}
        activeTabId={activeTabId}
        onCreated={(url) => {
          pushUiEvent(url ? `→ PR opened ↗ ${url}` : "→ PR created");
        }}
      />
      {/* VaultPanel — opened via Cmd+K palette → "Open vault
       * (secrets)". Self-renders only when open=true. */}
      <VaultPanel open={vaultOpen} onClose={() => setVaultOpen(false)} />
    </div>
  );
}

/* ─────────────── Helpers ─────────────── */

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

function buildVoiceAwarePrompt(
  text: string,
  tabId: string | null,
): { prompt: string; voiceReplyExpected: boolean } {
  const voiceReplyExpected = isVoiceChatEnabled(tabId);
  // The frontend owns ordinary TTS-back. Keep this instruction natural
  // so Grok does not explain the implementation ("plain text", "TTS")
  // during normal voice conversation, while still allowing explicit
  // diagnostic/tool requests.
  const prompt = voiceReplyExpected
    ? `[voice chat] Answer naturally as speech: concise, conversational, under about 6 sentences, no tables, no code blocks. Your final answer will be spoken automatically, so do not mention plain text, TTS, audio plumbing, or voice_tts unless the user asks you to diagnose voice mode. Do not call voice_tts for ordinary replies. If the user explicitly asks you to inspect, diagnose, or use tools, use the appropriate tools and then summarize the result in spoken-friendly text.\n\n${text}`
    : text;
  return { prompt, voiceReplyExpected };
}

// Keep the currently-playing voice-chat audio alive until playback
// finishes. A local `const audio = new Audio(...)` inside
// speakAndRearm() can fall out of JS reach immediately after
// `audio.play()` resolves; browsers often keep playing anyway, but that
// is not a contract worth betting the voice loop on. Holding one
// module-scoped reference also lets us stop an older reply cleanly
// before starting a newer one.
let activeVoiceAudio: HTMLAudioElement | null = null;
let activeVoiceAudioAbort: AbortController | null = null;

/**
 * #355:  voice-chat TTS-back + auto-rearm. Calls the Rust
 * `synthesize_voice` Tauri command with the assistant's spoken text,
 * gets back a `data:audio/mpeg;base64,...` URL, plays it through an
 * `<audio>` element, then fires a `shellx:voice-chat-rearm` event so
 * BottomPanel can restart the 🎧 mic for the next conversational
 * turn. Best-effort: if TTS fails, log + skip; the user's voice mode
 * stays on for the next prompt.
 */
async function speakAndRearm(text: string, tabId: string | null): Promise<void> {
  // Surface every TTS step to the WebView console + a `ui` event the
  // user can see in chat. Silent failure was making "voice chat is
  // one-way" hard to diagnose (was it: empty turn text? Tauri command
  // missing? no API key? autoplay blocked? CSP block on data: URL?).
  // Each failure mode now writes a distinct line so a glance at the
  // chat log identifies which step broke.
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
  let res: { audio_data_url: string; ms_total: number };
  try {
    res = await invoke<{ audio_data_url: string; ms_total: number }>(
      "synthesize_voice",
      { text },
    );
    try { console.info("voice-chat: TTS bytes received", { ms: res.ms_total, urlLen: res.audio_data_url.length }); } catch { /* ignore */ }
  } catch (err) {
    const msg = String((err as any)?.message ?? err);
    if (msg.startsWith("STT_NO_KEY:")) {
      surface("TTS no credential — run `grok login` or add xai/api-key to vault. Voice chat stays ON; next turn will retry.");
    } else {
      surface(`TTS synthesize failed: ${msg}`);
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
    const audio = new Audio(res.audio_data_url);
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
    audio.addEventListener("error", (e) => {
      // Playback-side error (decode failure, network for non-data
      // URLs, CSP). audio.error.code is 1=ABORTED 2=NETWORK 3=DECODE
      // 4=SRC_NOT_SUPPORTED.
      const code = (e.target as HTMLAudioElement)?.error?.code;
      surface(`TTS playback error (code=${code ?? "?"}) — audio decode/CSP issue. Voice chat stays ON.`);
      rearmOnce();
    }, { once: true, signal: listenerAbort.signal });
    // .play() returns a promise that rejects on autoplay-policy
    // block. WebView2 typically allows autoplay in installed apps,
    // but the rejection path here surfaces the failure so we don't
    // sit in silence.
    await audio.play();
    try { console.info("voice-chat: audio.play() resolved"); } catch { /* ignore */ }
  } catch (err) {
    try { activeVoiceAudioAbort?.abort(); } catch { /* ignore */ }
    if (activeVoiceAudio) {
      try { activeVoiceAudio.pause(); } catch { /* ignore */ }
      try { activeVoiceAudio.src = ""; } catch { /* ignore */ }
      activeVoiceAudio = null;
    }
    activeVoiceAudioAbort = null;
    const msg = String((err as any)?.message ?? err);
    surface(`TTS playback failed: ${msg}. (If "NotAllowedError" — browser autoplay policy blocked it; click the page once to grant gesture.)`);
    dispatchRearm();
  }
}

function extractSessionId(payload: unknown): string | undefined {
  if (payload == null || typeof payload !== "object") return undefined;
  const p = payload as any;
  return (
    p?.params?.sessionId ??
    p?.update?.sessionId ??
    p?.sessionId ??
    undefined
  );
}

function cycleAutonomy(mode: AutonomyMode): AutonomyMode {
  // Cycle is just default (Confirm) ↔ bypassPermissions (Auto). The
  // legacy `plan` and `acceptEdits` modes were silent no-ops and have
  // been dropped; stale localStorage values coerce to default rather
  // than stranding the user on a no-op state.
  const order: AutonomyMode[] = ["default", "bypassPermissions"];
  const coerced: AutonomyMode = mode === "plan" || mode === "acceptEdits" ? "default" : mode;
  const i = order.indexOf(coerced);
  if (i < 0) return "bypassPermissions";
  const next = order[(i + 1) % order.length];
  return next ?? "bypassPermissions";
}

function readLocal<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (raw == null) return fallback;
    return JSON.parse(raw) as T;
  } catch { return fallback; }
}

function formatTokens(n: number, _verbose?: boolean): string {
  // _verbose currently unused; future hook for "524288" vs "524k" rendering
  if (n < 1000) return String(n);
  const k = n / 1000;
  return k >= 100 ? `${Math.round(k)}k` : `${k.toFixed(1)}k`;
}

/**
 * Per-session download button placed next to the chat title. Archives
 * the ACTIVE tab's workspace + grok scratch as a zip. Disabled when no
 * session is active (no cwd yet).
 */
function SessionArtifactDownload({
  activeTabId,
  cwd,
}: {
  activeTabId: string | null;
  cwd: string;
}): JSX.Element {
  // Disabled state: button is dim and shows a tooltip explaining why.
  // We consider "no session active" = no activeTabId OR no cwd assigned
  // to the active tab. The archive command can't produce a meaningful
  // zip without a cwd to walk.
  const disabled = !activeTabId || !cwd;
  return (
    <button
      type="button"
      className="hdr-icon mid-head-dl"
      disabled={disabled}
      onClick={async () => {
        if (disabled) return;
        try {
          const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
          const defaultName = `shellx-session-${stamp}.zip`;
          const target = await saveDialog({
            defaultPath: defaultName,
            filters: [{ name: "Zip archive", extensions: ["zip"] }],
          });
          if (!target) return; // user cancelled
          const summary = await invoke<{
            path: string;
            files: number;
            skipped: number;
            bytes_in: number;
            bytes_out: number;
          }>("archive_session_artifacts", {
            tabId: activeTabId,
            savePath: target,
          });
          const mb = (summary.bytes_out / 1024 / 1024).toFixed(1);
          alert(
            `Saved ${summary.files} files (${summary.skipped} skipped) → ${mb} MB\n${summary.path}`,
          );
        } catch (e) {
          alert(`Download failed: ${String(e)}`);
        }
      }}
      title={disabled
        ? "no session active"
        : "Download this session's artifacts (workspace + grok scratch) as a zip"}
      aria-label="Download session artifacts"
    >
      ⬇
    </button>
  );
}

function splitTitleForMasthead(title: string): { titleMain: string; titleTrail: string } {
  // Two-weight masthead pattern: split at the last word; the trailing
  // word renders dimmer. Most session summaries are 3-7 words so the
  // emphasis lands on the last word.
  const trimmed = title.trim();
  const i = trimmed.lastIndexOf(" ");
  if (i <= 0) return { titleMain: trimmed, titleTrail: "" };
  return {
    titleMain: trimmed.slice(0, i),
    titleTrail: trimmed.slice(i + 1),
  };
}

/**
 * ClipboardCopiedToast — listens for the custom `shellx:clipboard-copied`
 * window event (dispatched by `auto-copy-selection.ts` after a successful
 * `navigator.clipboard.writeText`). Renders a small bottom-center pill
 * "✓ Copied N chars" that fades after 1.2 s. Matches grok-build TUI's
 * copy-feedback affordance.
 * * Implementation notes:
 * - Event-driven, not state-driven from outside — keeps the toast
 * decoupled from the auto-copy site so future copy paths (code-block
 * button, plan-pane copy) can fire the same event for free.
 * - Single timer, reset on each event so a burst of copies extends one
 * visible toast rather than stacking.
 */
function ClipboardCopiedToast(): JSX.Element | null {
  const [chars, setChars] = useState<number | null>(null);
  useEffect(() => {
    let timer: number | null = null;
    const onCopied = (e: Event) => {
      const detail = (e as CustomEvent<{ chars: number }>).detail;
      setChars(detail?.chars ?? 0);
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => setChars(null), 1200);
    };
    window.addEventListener("shellx:clipboard-copied", onCopied);
    return () => {
      window.removeEventListener("shellx:clipboard-copied", onCopied);
      if (timer !== null) window.clearTimeout(timer);
    };
  }, []);
  if (chars === null) return null;
  return (
    <div className="copy-toast" role="status" aria-live="polite">
      <span className="copy-toast-icon">
        <ShellIcon name="check" size={14} />
      </span>
      <span>Copied {chars} char{chars === 1 ? "" : "s"}</span>
    </div>
  );
}
