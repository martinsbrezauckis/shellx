/**
 * src/App.tsx — top-level ShellX layout.
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
 * * The bounded `events[]` tail is the renderer source of truth for chat
 * content; `groupEvents` folds it into chat-bubble groups consumed by
 * ChatOutput. Complete transcripts remain in per-session JSONL on disk.
 * * Keyboard shortcuts: registry in `src/lib/shortcuts.ts`; HelpModal and
 * App.tsx both read from it. Bindings wired here:
 * ?            help
 * Esc          close any modal
 * ⌘K / Ctrl+K  command palette
 * ⌘T / ⌘W      new / close session tab
 * ⌘U           attach file picker
 * ⌘`           toggle Chat ↔ Terminal in bottom panel
 * ⌘,           open settings
 * j/k/y/n/e    per-hunk diff nav (handled inside ChatOutput)
 * * File attach: picker, OS drag/drop, pasted clipboard images/files, and
 * screenshots all route through the same classifier. Text files ≤64 KB inline
 * as embedded_context; images are recorded as thumbnail intent. The composer
 * shows removable chips while the wire prompt still gets `[attached: <path>]`
 * markers until grok advertises promptCapabilities.image.
 * * Sessions persist to ~/.shellx/sessions/<id>.jsonl one line per event;
 * Tauri command for the writer, debug-api for the read side.
 */
import { lazy, useCallback, useEffect, useMemo, useRef, useState, type JSX } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";

import "./App.css";

import { Header } from "./components/Header";
import type { AutonomyMode } from "./lib/autonomy";
import { composerDraftForTab, pruneComposerDrafts, updateComposerDraftForTab } from "./lib/composer-drafts";
import { LeftRail } from "./components/LeftRail";
import { ChatOutput } from "./components/ChatOutput";
import {
  BottomPanel,
  readPersistedBottomTab,
  type ComposerAttachmentKind,
  type ComposerAttachmentChip,
  type SlashCommandItem,
} from "./components/BottomPanel";
import { RightRail, type PreviewTarget } from "./components/RightRail";
import { SessionTabs, type SessionTab } from "./components/SessionTabs";
import type { PaletteAction } from "./components/CommandPalette";
// Defensive provider-permission surface retained for legacy sessions and
// release diagnostics. Normal ShellX sessions run provider-native Full Auto.
import { UpdateBanner } from "./components/UpdateBanner";
import type { DebugUpdateFixtureMode } from "./lib/update-notes";
import { DebugApiConnectionBanner } from "./components/DebugApiConnectionBanner";
import { SESSION_TABS_KEY, hydrateUserData, persistUserData, readUserDataLocalStorage, type UserDataKey } from "./lib/userStore";
import { GoalPlanReviewModal } from "./components/GoalPlanReviewModal";
import { BuildPlanReviewModal } from "./components/BuildPlanReviewModal";
import { DebugHighlightOverlay, type DebugHighlightRequest } from "./components/DebugHighlightOverlay";
import { normalizeDebugHighlightRequests, sameDebugHighlightRequests } from "./lib/debug-highlight-normalization";
import { SHELLX_SETUP_GUIDE_DISMISSED_EVENT, ShellxSetupGuide } from "./components/ShellxSetupGuide";
import { ShellIcon } from "./components/icons";
import { LazySurface } from "./components/LazySurface";
import { startReleaseTauriInvokeRelay } from "./lib/release-tauri-invoke-relay";
import { useModalFocus } from "./lib/useModalFocus";
import { useEventAwarePolling, type PollCurrent } from "./lib/useEventAwarePolling";
import type { HashItem } from "./components/HashAutocomplete";
import {
  readSettingsLocal,
  normalizeSettings,
  applyTheme,
  persistSettings,
  DEFAULT_SETTINGS,
  TAB_KEY as SETTINGS_TAB_KEY,
  type SettingsTab,
  type SettingsValues,
} from "./lib/settings";
import { useKeyboardShortcuts } from "./lib/shortcuts";
import {
  normalizeBottomTabPatch,
  normalizeComposerDebugMenu,
  normalizeDebugModal,
  normalizeRightTabPatch,
  type BottomTab,
  type ComposerDebugMenu,
  type DebugModalId,
  type RightTab,
} from "./lib/ui-navigation";
import { api, apiGet, apiPost, apiPostJson, debugApiBase, getDebugToken } from "./lib/debug-api";
import {
  DEBUG_UI_CONNECT_TIMEOUT_MS,
  DEBUG_UI_POLL_MS,
  debugUiPollDelay,
  debugUiPollingEnabled,
  debugUiRetryDelay,
  debugUiStateTargetsBrowser,
  type DebugUiConnectionStatus,
} from "./lib/debug-ui-connection";
import { inTauri } from "./lib/tauri-bridge";
import { openShellxDialog } from "./lib/shellx-dialog";
import {
  joinRemoteFolderPath,
  normalizeRemoteFolderPath,
  parentRemoteFolderPath,
} from "./lib/folder-path";
import { groupEvents } from "./lib/grouping";
import { useBrowserCoworkPromptBridge } from "./lib/use-browser-cowork-bridge";
import { useBrowserTeachTaskHandoffBridge } from "./lib/task-teach-handoff-bridge";
import {
  browserTeachTaskHandoffMatchesNativeState,
  type BrowserTeachTaskHandoff,
} from "./lib/task-teach-handoff-events";
import { extractSessionAttachments, extractSessionMedia } from "./lib/session-media";
import {
  extractSessionAssetRegistry,
  type SessionAssetItem,
} from "./lib/session-assets";
import {
  PendingLocalEventQueue,
  buildSessionLogWrites,
  localEventTabId,
} from "./lib/pending-local-events";
import { isTaskRuntimeTabId } from "./lib/task-runtime-tab";
import {
  appendBoundedRendererEvents,
  historyTruncationFrame,
  MAX_SESSION_LOG_REHYDRATION_LINES,
  withRendererEventTabId,
} from "./lib/bounded-event-store";
import { RendererEventBatcher } from "./lib/renderer-event-batcher";
import {
  applyDebugRendererFixture,
  debugBuildRunCockpitFixture,
  type DebugBuildRunCockpitFixture,
} from "./lib/debug-renderer-fixture";
import {
  debugRightRailGitLifecycleFixture,
  type DebugRightRailGitLifecycleFixture,
} from "./lib/debug-right-rail-git-fixture";
import {
  applyDebugPermissionDecisionFixtureEvents,
  debugPermissionDecisionFixture,
  type DebugPermissionDecisionFixture,
} from "./lib/debug-permission-decision-fixture";
import {
  DEBUG_AGENT_CLI_SETUP_PRESET,
  debugAgentCliSetupFixture,
  normalizeDebugAgentCliSetupFixtureMode,
  type DebugAgentCliSetupFixtureMode,
} from "./lib/debug-agent-cli-setup-fixture";
import {
  debugGoalPlanReviewFixture,
  normalizeDebugGoalPlanReviewFixtureMode,
  type DebugGoalPlanReviewFixtureMode,
} from "./lib/debug-goal-plan-review-fixture";
import { classifyComposerSubmission } from "./lib/acp-interjection";
import { extractAssistantTurnAfterIndex, getVoiceTurnToSpeak } from "./lib/voice-chat";
import { buildVoiceAwarePrompt, speakAndRearm } from "./lib/voice-chat-runtime";
import {
  addBuildOperatorNote,
  buildActionFailureMessage,
  getBuildState,
  isBuildTerminalStatus,
  parseBuildCommand,
  shouldQueuePromptAsBuildOperatorNote,
  startBuildMode,
} from "./lib/build-run";
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
import {
  resolvePreviewRoute,
  resolveShellxPreviewScreenshotPath,
  resolveSessionMarkdownArtifactPath,
  type PreviewCenterView,
} from "./lib/preview-center";
import {
  buildReconnectContinuityPrompt,
  buildSessionResumeTranscript,
  loadSessionIdForReconnect,
  reconnectContinuityUiText,
  type SessionResumeTranscript,
} from "./lib/session-continuity";
import { newestSessionTitleCandidates, titleOverrideForClosingTab } from "./lib/session-titles";
import {
  summarizeOutsideConnectorInbox,
  type OutsideConnector,
  type OutsideConnectorEvent,
  type OutsideConnectorInboxSummary,
} from "./lib/outside-connectors";
import {
  buildVaultRequestCenterItems,
  extractVaultPermissionRequests,
  loadDismissedVaultDepositIds,
  storeDismissedVaultDepositIds,
  vaultRequestSummaryText,
  type VaultRequestCenterAction,
  type VaultRequestCenterItem,
} from "./lib/vault-request-center";
import {
  useVaultRequestCenterState,
} from "./lib/useVaultRequestCenterState";
import type { BrowserSessionGrantPromptSource } from "./lib/vault-approval-prompts";
import type { VaultPanelIntent } from "./lib/vault-ui";
import { isTrustedShellxUserEvent, type ShellxUserEventLike } from "./lib/trusted-user-event";
import {
  agentDisplayName,
  isProviderAgent,
  normalizeAgentSelection,
  providerPermissionModeForAutonomy,
  type AgentId,
  type AgentSelection,
} from "./lib/agent-selection";
import {
  normalizeShellxToolExposure,
  providerExecutionTargetLabel,
  providerSessionGroupShape,
  shellxToolExposureForProviderStart,
  DEFAULT_SHELLX_TOOL_EXPOSURE,
  type ProviderExecutionTransport,
  type ProviderId,
  type ProviderShellxToolExposure,
} from "./lib/provider-sessions";
import {
  abortProviderSession,
  getProviderAdapterState,
  getProviderSessionState,
  startProviderSession,
} from "./lib/provider-session-api";
import {
  debugProviderActionFixture,
  dispatchDebugProviderAction,
  providerActionPromptMatches,
  type DebugProviderActionFixture,
  type DebugProviderActionReceipt,
} from "./lib/debug-provider-action-fixture";
import type { ConnectionPreset, ConnectionProviderScanEntry } from "./components/ConnectionPicker";
import {
  CONNECTION_PROVIDER_CAPABILITY_TTL_MS,
  providerScanStatus,
  scanConnectionProviderCapabilities,
} from "./lib/connection-provider-capabilities";
import {
  createTaskManagerController,
  type TaskManagerCurrentContext,
} from "./lib/task-manager-controller";
import {
  createBrowserTeachTaskDraft,
  createComposerTaskDraft,
  taskEnvironmentKey,
} from "./lib/task-manager-tauri-adapter";
import {
  parseTaskAttachmentPersistenceResponse,
  parseTaskAttachmentMaintenanceResponse,
  parseTaskAttachmentReclamationResponse,
  type TaskAttachmentReference as DurableTaskAttachmentReference,
} from "./lib/task-attachment-handoff";
import {
  taskDeviceTimezone,
  type TaskManagerActionResult,
  type TaskManagerData,
  type TaskManagerDraft,
  type TaskManagerMode,
} from "./lib/task-manager-contract";
import { taskAttentionCount } from "./lib/task-manager-history-projection";
import {
  debugTaskManagerFixtureData,
  normalizeDebugTaskManagerFixtureMode,
  updateDebugTaskManagerState,
  type DebugTaskManagerFixtureMode,
} from "./lib/task-manager-debug-fixture";
import {
  normalizeDebugCutToolingFixture,
  type CutToolingState,
} from "./lib/cut-tooling";

const Settings = lazy(() => import("./components/Settings")
  .then((module) => ({ default: module.Settings })));
const TaskManager = lazy(() => import("./components/TaskManager")
  .then((module) => ({ default: module.TaskManager })));
const CommandPalette = lazy(() => import("./components/CommandPalette")
  .then((module) => ({ default: module.CommandPalette })));
const AgentCliSetupDialog = lazy(() => import("./components/AgentCliSetupDialog.lazy"));
const HelpModal = lazy(() => import("./components/HelpModal")
  .then((module) => ({ default: module.HelpModal })));
const PluginsModal = lazy(() => import("./components/PluginsModal")
  .then((module) => ({ default: module.PluginsModal })));
const ConnectorInboxModal = lazy(() => import("./components/ConnectorInboxModal")
  .then((module) => ({ default: module.ConnectorInboxModal })));
const BuiltinDocModal = lazy(() => import("./components/BuiltinDocModal")
  .then((module) => ({ default: module.BuiltinDocModal })));
const PRCreateModal = lazy(() => import("./components/PRCreateModal")
  .then((module) => ({ default: module.PRCreateModal })));
const AttachmentMediaBoard = lazy(() => import("./components/AttachmentMediaBoard")
  .then((module) => ({ default: module.AttachmentMediaBoard })));
const PreviewCenter = lazy(() => import("./components/PreviewCenter")
  .then((module) => ({ default: module.PreviewCenter })));
const ActivityBrowserModal = lazy(() => import("./components/ActivityBrowserModal")
  .then((module) => ({ default: module.ActivityBrowserModal })));
const VaultPanel = lazy(() => import("./components/VaultPanel")
  .then((module) => ({ default: module.VaultPanel })));
import type { AcpCommand, RawEventFrame } from "./types/acp";

type Status = "Idle" | "Starting" | "Connected" | "Aborting" | "Error";

interface SessionJsonlTailResponse {
  lines: string[];
  omittedLines: number;
}

const RECONNECT_SESSION_LOG_TAIL_LINES = 1_200;

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
  "provider-session-event",
] as const;

const PANEL_SIZE_KEY_H = "shellX.panels.horizontal";
const PANEL_SIZE_KEY_V = "shellX.panels.vertical";
const LEGACY_PANEL_SIZE_KEY_H = "grok-shell.panels.horizontal";
const LEGACY_PANEL_SIZE_KEY_V = "grok-shell.panels.vertical";
const PANEL_AUTOSAVE_ID_H = "shellX-h";
const PANEL_AUTOSAVE_ID_MID_RIGHT = "shellX-mid-right";
const PANEL_AUTOSAVE_ID_V = "shellX-v5";
const LEGACY_PANEL_AUTOSAVE_IDS = [
  ["grok-shell-h", PANEL_AUTOSAVE_ID_H],
  ["grok-shell-mid-right", PANEL_AUTOSAVE_ID_MID_RIGHT],
  ["grok-shell-v5", PANEL_AUTOSAVE_ID_V],
] as const;
// localStorage namespace keys. Hoisted out of the App body so they don't
// re-allocate every render.
const PROJECTS_KEY = "shellX.projects.v1";
const SESSIONS_KEY = SESSION_TABS_KEY;
/* Cache for Grok's available_commands_update so the slash-autocomplete
 * popup populates immediately on Grok tabs, before the live Grok session
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

interface PendingComposerAttachments {
  text: PendingTextAttachment[];
  chips: ComposerAttachmentChip[];
}

function pendingAttachmentKey(tabId: string | null | undefined): string {
  return tabId ?? "__default__";
}

function vaultRequestActionRequiresTrustedUserEvent(action: VaultRequestCenterAction): boolean {
  return [
    "allowPermission",
    "denyPermission",
    "approveBrowserGrant",
    "denyBrowserGrant",
    "approveVaultGrant",
    "denyVaultGrant",
    "approveVaultAgentRequest",
    "denyVaultAgentRequest",
  ].includes(action.kind);
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

function normalizeDebugSurface(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim().toLowerCase() : null;
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
  /** Which agent answers the normal composer for this tab. Null/undefined means choose before first send. */
  agentId?: AgentSelection;
  /** Per-tab ShellX host-tool exposure for provider sessions. */
  shellxToolExposure?: ProviderShellxToolExposure;
  /** Branch name displayed in the Branch pill. */
  branchName?: string;
  /** Ahead-count shown as ↑N badge on the Branch pill. */
  branchAhead?: number;
  /** Set on first user prompt sent through this tab. Locks the
   * connection pill — once a grok subprocess is bound to this tab,
   * transport can't change mid-session; user must open a new tab. */
  firstMessageMs?: number;
  /** Temporary lock while provider preflight/start is in progress. */
  sessionLockPending?: boolean;
  /** Last visible provider target banner shown for this tab. */
  lastProviderTargetKey?: string;
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
    shellxToolExposure: DEFAULT_SHELLX_TOOL_EXPOSURE,
    branchName: undefined,
    branchAhead: undefined,
  };
}

function tabPatchChanges(tab: TabEntry, patch: Partial<TabEntry>): boolean {
  for (const key of Object.keys(patch) as Array<keyof TabEntry>) {
    if (tab[key] !== patch[key]) return true;
  }
  return false;
}

function scanCanRunAgent(scan: ConnectionProviderScanEntry[] | undefined, agentId: AgentId): boolean {
  return Boolean(scan?.some((entry) => entry.providerId === agentId && entry.canRun));
}

function agentForConnectionPreset(
  preset: ConnectionPreset,
  currentAgent: AgentSelection,
): AgentSelection {
  const scan = preset.providerScan ?? [];
  if (scan.length === 0) return currentAgent;
  if (currentAgent && scanCanRunAgent(scan, currentAgent)) return currentAgent;
  return null;
}

function inferredUnixHomeFromProviderScan(scan: ConnectionProviderScanEntry[] | undefined): string | null {
  for (const entry of scan ?? []) {
    const binary = entry.binary?.trim();
    if (!binary?.startsWith("/")) continue;
    const match = binary.match(/^\/(?:home\/[^/]+|Users\/[^/]+)(?:\/|$)/);
    if (match) return match[0].replace(/\/$/, "");
  }
  return null;
}

function sshUserFromHost(host: string | undefined): string | null {
  const raw = host?.trim();
  if (!raw) return null;
  const at = raw.indexOf("@");
  if (at <= 0) return null;
  const user = raw.slice(0, at).trim();
  return user && !user.includes("/") && !user.startsWith("-") ? user : null;
}

function providerScanLooksMac(scan: ConnectionProviderScanEntry[] | undefined): boolean {
  return Boolean((scan ?? []).some((entry) => {
    const binary = entry.binary?.trim() ?? "";
    return binary.startsWith("/Users/") || binary.startsWith("/opt/homebrew/");
  }));
}

function unixHomeUser(path: string): string | null {
  const match = path.match(/^\/(?:home|Users)\/([^/]+)(?:\/|$)/);
  const user = match?.[1]?.trim();
  return user && user !== "." && user !== ".." ? user : null;
}

function looksLikeHostLocalCwd(path: string): boolean {
  const trimmed = path.trim();
  return /^\\\\/.test(trimmed)
    || /^[A-Za-z]:[\\/]/.test(trimmed)
    || trimmed.startsWith("/mnt/");
}

function isUnixAbsoluteCwd(path: string): boolean {
  const trimmed = path.trim().replace(/\\/g, "/");
  return trimmed.startsWith("/") && !trimmed.startsWith("//");
}

function sshFallbackHomeForPreset(preset: ConnectionPreset): string | null {
  if (preset.transport.kind !== "ssh") return null;
  const user = sshUserFromHost(preset.transport.host);
  if (!user) return null;
  return providerScanLooksMac(preset.providerScan) || /mac/i.test(preset.label)
    ? `/Users/${user}`
    : `/home/${user}`;
}

function cwdForConnectionPreset(preset: ConnectionPreset, currentCwd: string): string {
  if (preset.transport.kind === "local") return currentCwd;
  const inferredHome = inferredUnixHomeFromProviderScan(preset.providerScan);
  if (inferredHome) return inferredHome;
  if (preset.transport.kind === "ssh") {
    const fallbackHome = sshFallbackHomeForPreset(preset);
    const current = currentCwd.trim();
    const currentHomeUser = unixHomeUser(current);
    const sshUser = sshUserFromHost(preset.transport.host);
    const staleUnixFamily = Boolean(fallbackHome?.startsWith("/Users/") && current.startsWith("/home/"))
      || Boolean(fallbackHome?.startsWith("/home/") && current.startsWith("/Users/"));
    const staleForSsh = !current
      || !isUnixAbsoluteCwd(current)
      || looksLikeHostLocalCwd(current)
      || staleUnixFamily
      || Boolean(currentHomeUser && sshUser && currentHomeUser !== sshUser);
    if (staleForSsh && fallbackHome) return fallbackHome;
  }
  return isUnixAbsoluteCwd(currentCwd) ? currentCwd : "/";
}

function currentLocalConnectionPreset(): ConnectionPreset {
  return {
    id: "",
    label: "Current local",
    transport: { kind: "local" },
    createdMs: 0,
    lastUsedMs: 0,
  };
}

function providerScanSignature(providers: ConnectionProviderScanEntry[] | undefined): string {
  return (providers ?? [])
    .map((provider) => [
      provider.providerId,
      provider.canRun ? "1" : "0",
      provider.status ?? "unknown",
      provider.binary ?? "",
      provider.version ?? "",
      provider.binarySha256 ?? "",
      String(provider.binaryBytes ?? ""),
      provider.targetKey ?? "",
      provider.detail ?? "",
      String(provider.checkedAtMs),
    ].join("|"))
    .sort()
    .join("\n");
}

function connectionTransportSignature(preset: ConnectionPreset): string {
  const transport = preset.transport;
  switch (transport.kind) {
    case "local":
      return ["local", transport.grokPath ?? ""].join("|");
    case "wsl":
      return ["wsl", transport.distro, transport.grokPath ?? ""].join("|");
    case "ssh":
      return [
        "ssh",
        transport.host,
        transport.port?.toString() ?? "",
        transport.keyVaultRef ?? "",
        transport.remoteGrokPath ?? "",
        transport.remoteRuntime ?? "posix",
        transport.wslDistro ?? "",
      ].join("|");
    case "ws_direct":
      return ["ws_direct", transport.url, transport.secretVaultRef ?? ""].join("|");
    case "ws_tunnel":
      return ["ws_tunnel", transport.url, transport.secretVaultRef ?? ""].join("|");
    case "tailscale":
      return ["tailscale", transport.tailnetHost, transport.port?.toString() ?? ""].join("|");
  }
}

function agentFromEventFrame(frame: RawEventFrame | undefined): AgentSelection {
  if (!frame) return null;
  if (frame.kind === "provider-session-event") {
    return normalizeAgentSelection((frame.payload as any)?.providerId);
  }
  if (frame.kind === "grok-acp-event") {
    return "grok";
  }
  return null;
}

function latestAgentFromEventFrames(frames: RawEventFrame[]): AgentSelection {
  for (let i = frames.length - 1; i >= 0; i--) {
    const agent = agentFromEventFrame(frames[i]);
    if (agent) return agent;
  }
  return null;
}

function restorePersistedTabEntry(tab: TabEntry): TabEntry {
  const restoredAgent = normalizeAgentSelection(tab.agentId);
  const idleUntouchedNewTab =
    !tab.sessionId &&
    !tab.firstMessageMs &&
    (!tab.title || tab.title === "new session");
  return {
    ...tab,
    agentId: idleUntouchedNewTab ? null : restoredAgent,
    shellxToolExposure: normalizeShellxToolExposure(tab.shellxToolExposure),
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
  const panelStorageMigrated = useRef(false);
  if (!panelStorageMigrated.current) {
    panelStorageMigrated.current = true;
    migratePanelStorage();
  }

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
  const cwdRef = useRef(cwd);
  useEffect(() => { cwdRef.current = cwd; }, [cwd]);
  /* Validate cwd ONCE at boot via a ref gate, so subsequent folder picks
   * don't re-run the probe + setCwd + LS rewrite and race the persist
   * effect. */
  const cwdValidated = useRef(false);
  // #435 — personal data hydrates asynchronously from
  // ~/.shellx/user-data.json. First-render defaults must not write back
  // until that hydrate completes, otherwise a clean WebView-data reinstall
  // can overwrite the durable project/session markings with empty state.
  const userDataHydrated = useRef(false);
  const [personalDataReady, setPersonalDataReady] = useState(false);
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
        const raw = readUserDataLocalStorage(SESSIONS_KEY);
        if (raw) {
          const arr = JSON.parse(raw);
          if (Array.isArray(arr)) {
            const cleaned = arr.map((t: any) =>
              t && typeof t === "object" && t.cwd === cwd ? { ...t, cwd: "" } : t,
            );
            if (personalDataReady) {
              persistUserData(SESSIONS_KEY, cleaned);
            } else {
              try { localStorage.setItem(SESSIONS_KEY, JSON.stringify(cleaned)); } catch { /* no-op */ }
            }
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
  }, [cwd, personalDataReady]);
  // Persist cwd changes so the next launch starts where we left off.
  useEffect(() => {
    if (cwd) {
      try { localStorage.setItem("shellX.cwd.v1", cwd); } catch { /* no-op */ }
    }
  }, [cwd]);
  const [promptByTab, setPromptByTab] = useState<Record<string, string>>({});
  const promptByTabRef = useRef<Record<string, string>>({});
  useEffect(() => { promptByTabRef.current = promptByTab; }, [promptByTab]);

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
  const [pendingAttachmentsByTab, setPendingAttachmentsByTab] = useState<Record<string, PendingComposerAttachments>>({});
  const [events, setEvents] = useState<RawEventFrame[]>([]);
  const persistLiveBatchRef = useRef<(batch: readonly RawEventFrame[]) => void>(() => undefined);
  const liveEventBatcherRef = useRef<RendererEventBatcher<RawEventFrame> | null>(null);
  const enqueueLiveEvent = useCallback((event: RawEventFrame): void => {
    if (!liveEventBatcherRef.current) {
      liveEventBatcherRef.current = new RendererEventBatcher(
        (batch) => {
          setEvents((current) => appendBoundedRendererEvents(current, batch));
          persistLiveBatchRef.current(batch);
        },
        (flush) => window.setTimeout(flush, 16),
        (handle) => window.clearTimeout(handle),
      );
    }
    liveEventBatcherRef.current.enqueue(event);
  }, []);
  const flushLiveEvents = useCallback((): void => {
    liveEventBatcherRef.current?.flush();
  }, []);
  useEffect(() => () => {
    liveEventBatcherRef.current?.flush();
    liveEventBatcherRef.current?.dispose();
    liveEventBatcherRef.current = null;
  }, []);
  const [debugBuildRunFixture, setDebugBuildRunFixture] = useState<DebugBuildRunCockpitFixture | null>(null);
  const [debugRightRailGitFixture, setDebugRightRailGitFixture] =
    useState<DebugRightRailGitLifecycleFixture | null>(null);
  const [debugPermissionFixture, setDebugPermissionDecisionFixture] =
    useState<DebugPermissionDecisionFixture | null>(null);
  const [debugProviderAction, setDebugProviderAction] =
    useState<DebugProviderActionFixture | null>(null);
  const [debugProviderActionReceipt, setDebugProviderActionReceipt] =
    useState<DebugProviderActionReceipt | null>(null);
  const [debugUpdateFixture, setDebugUpdateFixture] =
    useState<DebugUpdateFixtureMode>("live");
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
  const [remoteFolderPicker, setRemoteFolderPicker] = useState<RemoteFolderPickerRequest | null>(null);
  const [goalReviewRequestSeq, setGoalReviewRequestSeq] = useState(0);
  const [buildReviewRequestSeq, setBuildReviewRequestSeq] = useState(0);
  const [buildReviewCloseSeq, setBuildReviewCloseSeq] = useState(0);
  const [debugHighlights, setDebugHighlights] = useState<DebugHighlightRequest[]>([]);
  const [agentCliSetupFixtureMode, setAgentCliSetupFixtureMode] =
    useState<DebugAgentCliSetupFixtureMode>("closed");
  const [goalPlanReviewFixtureMode, setGoalPlanReviewFixtureMode] =
    useState<DebugGoalPlanReviewFixtureMode>("closed");
  const [debugUiConnectionStatus, setDebugUiConnectionStatus] = useState<DebugUiConnectionStatus>("connecting");
  const [debugUiConnectionFixture, setDebugUiConnectionFixture] =
    useState<DebugUiConnectionStatus | null>(null);
  const [releaseTestRendererCrash, setReleaseTestRendererCrash] = useState(false);
  const [releaseTestLazySurface, setReleaseTestLazySurface] =
    useState<"error" | "recovered" | null>(null);
  const [releaseTestVoiceRecording, setReleaseTestVoiceRecording] = useState(false);
  const [releaseTestExternalEffectBoundary, setReleaseTestExternalEffectBoundary] =
    useState<"pr-create" | "artifact-archive" | null>(null);

  // ─── UI state ─────────────────────────────────────────────────────────
  // Autonomy default is "bypassPermissions". Key is v2 so any persisted
  // v1 entry (which could carry the old interactive permission mode) is
  // dropped on first read. Persisted "default" values upgrade to
  // bypassPermissions so installs from before the chip-cycle collapse
  // don't strand the user on obsolete permission popups.
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
  const openSettingsTab = useCallback((tab: SettingsTab) => {
    try { localStorage.setItem(SETTINGS_TAB_KEY, tab); } catch { /* ignore */ }
    setSettingsOpen(true);
  }, []);
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
        try { localStorage.setItem(SETTINGS_TAB_KEY, tab); } catch { /* no-op */ }
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
      flushLiveEvents();
      setEvents((prev) => appendBoundedRendererEvents(prev, synthetic));
    };
    window.addEventListener("shellx:synthetic-event", handler);
    return () => window.removeEventListener("shellx:synthetic-event", handler);
  }, []);
  const [pluginsOpen, setPluginsOpen] = useState(false);
  const [debugPluginsFixture, setDebugPluginsFixture] = useState<"owned-safe" | "owned-production" | null>(null);
  const [debugConnectorsFixture, setDebugConnectorsFixture] = useState<"owned-safe" | null>(null);
  const [debugBuildPlanFixture, setDebugBuildPlanFixture] = useState<"owned-ready" | null>(null);
  const [debugShellxagentFixture, setDebugShellxagentFixture] = useState<"owned-safe" | null>(null);
  const [debugCutToolingFixture, setDebugCutToolingFixture] = useState<CutToolingState | null>(null);
  const [debugClipboardFixture, setDebugClipboardFixture] = useState<
    "tasks" | "vault-draft" | "vault-password" | "shellxagent-token" | "work-preview" | null
  >(null);
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
    openSettingsTab("about");
  }, [openSettingsTab]);
  // Preview Center opened by ChatOutput clicks on file paths. Documents
  // stay read-only; runnable HTML routes through Work Preview.
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  const [previewFileContext, setPreviewFileContext] = useState<{
    tabId?: string | null;
    sessionCwd?: string | null;
  } | null>(null);
  const handlePreviewFileImpl = useRef<(path: string) => void>(() => {});
  const handlePreviewFile = useCallback((path: string): void => {
    handlePreviewFileImpl.current(path);
  }, []);
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
  const [vaultPanelIntent, setVaultPanelIntent] = useState<VaultPanelIntent>("overview");
  const [vaultPanelIntentSeq, setVaultPanelIntentSeq] = useState(0);
  const pendingVaultPanelAckIdsRef = useRef<Set<string>>(new Set());
  const [vaultRequestCenterOpenSeq, setVaultRequestCenterOpenSeq] = useState(0);
  const [vaultRequestCenterCloseSeq, setVaultRequestCenterCloseSeq] = useState(0);
  const {
    state: browserVaultRequestState,
    setState: setBrowserVaultRequestState,
    refresh: refreshBrowserVaultRequests,
  } = useVaultRequestCenterState();
  const [dismissedVaultDepositIds, setDismissedVaultDepositIds] = useState<Set<string>>(
    () => loadDismissedVaultDepositIds(),
  );
  const openVaultPanel = useCallback((intent: VaultPanelIntent = "overview") => {
    setVaultPanelIntent(intent);
    setVaultPanelIntentSeq((seq) => seq + 1);
    setVaultOpen(true);
  }, []);

  useEffect(() => {
    if (!inTauri()) return;
    let unlisten: UnlistenFn | null = null;
    let disposed = false;
    void listen<{ requestId?: unknown }>("shellx:open-vault-panel", ({ payload }) => {
      const requestId = typeof payload?.requestId === "string" ? payload.requestId.trim() : "";
      if (requestId.startsWith("vault-panel-open-") && requestId.length <= 128) {
        pendingVaultPanelAckIdsRef.current.add(requestId);
      }
      openVaultPanel("overview");
    })
      .then((fn) => {
        if (disposed) {
          fn();
          return;
        }
        unlisten = fn;
      })
      .catch((err) => console.warn("[App] shellx:open-vault-panel listener failed:", err));
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [openVaultPanel]);
  useEffect(() => {
    if (!vaultOpen || !inTauri() || pendingVaultPanelAckIdsRef.current.size === 0) return;
    const requestIds = [...pendingVaultPanelAckIdsRef.current];
    for (const requestId of requestIds) pendingVaultPanelAckIdsRef.current.delete(requestId);
    for (const requestId of requestIds) {
      void emit("shellx:vault-panel-opened", { requestId }).catch((err) => {
        pendingVaultPanelAckIdsRef.current.add(requestId);
        console.warn("[App] shellx:vault-panel-opened acknowledgement failed:", err);
      });
    }
  }, [vaultOpen, vaultPanelIntentSeq]);
  const [maxTokens, setMaxTokens] = useState<number>(128_000);
  const [sessionTitle, setSessionTitle] = useState<string>("new session");
  // isSending is per-tab on TabEntry.
  const [bottomTab, setBottomTab] = useState<BottomTab>(readPersistedBottomTab);
  const [debugComposerMenuRequest, setDebugComposerMenuRequest] = useState<{
    menu: ComposerDebugMenu;
    seq: number;
  } | null>(null);
  useEffect(() => {
    void apiPost("/state/ui", { bottomTab, source: "renderer" }).catch(() => { /* debug API may be off */ });
  }, [bottomTab]);

  // ─── Settings (loaded from ~/.shellx/settings.json via debug API,
  // mirrored to localStorage so the renderer is responsive). ───────
  const [settings, setSettings] = useState<SettingsValues>(() => readSettingsLocal());
  const [hashItems, setHashItems] = useState<HashItem[]>([]);
  const [taskManagerData, setTaskManagerData] = useState<TaskManagerData>({
    loadState: "loading",
    environments: [],
    providerCatalogueState: { state: "idle" },
    definitions: [],
  });
  const [debugTaskManagerFixtureMode, setDebugTaskManagerFixtureMode] =
    useState<DebugTaskManagerFixtureMode | null>(null);
  const debugTaskManagerFixtureModeRef = useRef<DebugTaskManagerFixtureMode | null>(null);
  const taskManagerControllerRef = useRef<ReturnType<typeof createTaskManagerController> | null>(null);
  if (!taskManagerControllerRef.current) {
    taskManagerControllerRef.current = createTaskManagerController({
      invoke: <T,>(command: string, args?: Record<string, unknown>) => invoke<T>(command, args),
      onData: (data) => {
        if (!debugTaskManagerFixtureModeRef.current) setTaskManagerData(data);
      },
    });
  }
  const taskManagerController = taskManagerControllerRef.current;
  const [taskManagerOpen, setTaskManagerOpen] = useState(false);
  const [taskManagerMode, setTaskManagerMode] = useState<TaskManagerMode>("edit");
  const taskManagerOpenRef = useRef(taskManagerOpen);
  const taskManagerModeRef = useRef<TaskManagerMode>(taskManagerMode);
  taskManagerOpenRef.current = taskManagerOpen;
  taskManagerModeRef.current = taskManagerMode;
  const [taskManagerInitialDraft, setTaskManagerInitialDraft] = useState<TaskManagerDraft | undefined>();
  const [taskAttachmentPersistenceBusy, setTaskAttachmentPersistenceBusy] = useState(false);
  const taskAttachmentPersistenceInFlightRef = useRef(false);
  const pendingImportedTaskAttachmentsRef = useRef<DurableTaskAttachmentReference[]>([]);
  const taskAttachmentMaintenanceStartedRef = useRef(false);

  useEffect(() => {
    if (!inTauri() || taskAttachmentMaintenanceStartedRef.current) return;
    taskAttachmentMaintenanceStartedRef.current = true;
    let cancelled = false;
    void invoke<unknown>("tasks_maintain_attachments")
      .then((raw) => {
        if (cancelled) return;
        const result = parseTaskAttachmentMaintenanceResponse(raw);
        if (result.reclaimedAttachmentIds.length > 0) {
          pushUiEvent(`✓ reclaimed ${result.reclaimedAttachmentIds.length} stale Task attachment${result.reclaimedAttachmentIds.length === 1 ? "" : "s"}`);
        }
        if (result.pendingAttachmentIds.length > 0) {
          pushUiEvent(`◎ ${result.pendingAttachmentIds.length} stale Task attachment cleanup${result.pendingAttachmentIds.length === 1 ? " is" : "s are"} pending until the target is available`);
        }
      })
      .catch((error) => {
        if (!cancelled) pushUiEvent(`◎ Task attachment maintenance deferred: ${error}`);
      });
    return () => { cancelled = true; };
    // Startup maintenance is intentionally once per installed renderer boot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
      const raw = readUserDataLocalStorage(SESSIONS_KEY);
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
  const openTabsDebugKeyRef = useRef<string>("");
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
  const prompt = composerDraftForTab(promptByTab, activeTabId);
  const setPrompt = useCallback((next: string | ((current: string) => string)): void => {
    const targetTabId = activeTabId;
    setPromptByTab((drafts) => {
      const current = composerDraftForTab(drafts, targetTabId);
      const value = typeof next === "function" ? next(current) : next;
      return updateComposerDraftForTab(drafts, targetTabId, value);
    });
  }, [activeTabId]);
  useEffect(() => {
    // If saved active id doesn't exist among tabs, fall back to first.
    if (activeTabId && tabs.some((t) => t.tabId === activeTabId)) return;
    const first = tabs[0]?.tabId ?? null;
    if (first !== activeTabId) setActiveTabId(first);
  }, [tabs, activeTabId]);
  useEffect(() => {
    const liveTabIds = new Set(tabs.map((tab) => tab.tabId));
    setPromptByTab((drafts) => pruneComposerDrafts(drafts, liveTabIds));
  }, [tabs]);
  useEffect(() => {
    try {
      if (activeTabId) localStorage.setItem(ACTIVE_TAB_KEY, activeTabId);
      else localStorage.removeItem(ACTIVE_TAB_KEY);
    } catch { /* no-op */ }
    if (activeTabId) {
      void apiPost("/state/ui", { activeTabId, source: "renderer" }).catch(() => { /* debug API may be off */ });
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
    if (!personalDataReady) return;
    persistUserData(SESSIONS_KEY, tabs);
  }, [tabs, personalDataReady]);

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
    if (!personalDataReady) return;
    persistUserData(PROJECTS_KEY, projects);
  }, [projects, personalDataReady]);

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
    if (!personalDataReady) return;
    persistUserData(CHAT_TITLES_KEY, chatTitleOverrides);
  }, [chatTitleOverrides, personalDataReady]);

  const persistSessionTitleOverride = useCallback((sessionId: string, title: string): void => {
    const trimmed = title.trim();
    if (!sessionId || !trimmed) return;
    setChatTitleOverrides((prev) =>
      prev[sessionId] === trimmed ? prev : { ...prev, [sessionId]: trimmed },
    );
    if (!inTauri()) return;
    void invoke("rename_past_session", { sessionId, newTitle: trimmed })
      .catch((e) => {
        // The JSONL may not exist yet if the user renamed a tab before
        // its first persisted frame. The local override remains durable;
        // close/reconnect paths retry once the session file exists.
        console.error("rename_past_session failed:", e);
      });
  }, []);

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
      // chat in a fresh TabEntry still gets the renamed title. Also
      // write a JSONL title-override so list_stored_sessions does not
      // fall back to the raw session id after the tab closes.
      persistSessionTitleOverride(sessionId, trimmed);
    }
    // The mid-pane masthead reads from `sessionTitle` independently of
    // tab.title; sync it when the renamed tab is active.
    if (renamedActive) {
      setSessionTitle(trimmed);
    }
  }, [activeTabId, persistSessionTitleOverride, tabs]);

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
    if (!personalDataReady) return;
    persistUserData(SESSION_PROJECTS_KEY, sessionProjects);
  }, [sessionProjects, personalDataReady]);
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
    if (!personalDataReady) return;
    persistUserData(CLOSED_TABS_KEY, closedTabs.slice(-100));
  }, [closedTabs, personalDataReady]);

  useEffect(() => {
    if (userDataHydrated.current) return;
    userDataHydrated.current = true;
    let cancelled = false;

    const readArray = <T,>(key: UserDataKey): T[] | null => {
      try {
        const raw = readUserDataLocalStorage(key);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed as T[] : null;
      } catch {
        return null;
      }
    };
    const readObject = <T extends Record<string, unknown>>(key: UserDataKey): T | null => {
      try {
        const raw = readUserDataLocalStorage(key);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as T : null;
      } catch {
        return null;
      }
    };

    void hydrateUserData()
      .then(() => {
        if (cancelled) return;
        const restoredTabs = readArray<TabEntry>(SESSIONS_KEY);
        if (restoredTabs && restoredTabs.length > 0) {
          setTabs(restoredTabs.map((t) => restorePersistedTabEntry(t)));
        }
        setProjects(readArray<StoredProject>(PROJECTS_KEY) ?? []);
        setChatTitleOverrides(readObject<Record<string, string>>(CHAT_TITLES_KEY) ?? {});
        setSessionProjects(readObject<Record<string, string>>(SESSION_PROJECTS_KEY) ?? {});
        setClosedTabs(readArray<ClosedTab>(CLOSED_TABS_KEY) ?? []);
        setPersonalDataReady(true);
      })
      .catch(() => {
        if (!cancelled) setPersonalDataReady(true);
      });

    return () => { cancelled = true; };
  }, []);
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

  useEffect(() => {
    for (const tab of tabs) {
      const override = titleOverrideForClosingTab(tab, chatTitleOverrides);
      if (override) {
        persistSessionTitleOverride(override.sessionId, override.title);
      }
    }
  }, [chatTitleOverrides, persistSessionTitleOverride, tabs]);

  /** Patch the currently-active tab's entry (e.g. composer scope-pill
   * selections). No-op when no tab is active (cold start). */
  const updateActiveTab = useCallback((patch: Partial<TabEntry>) => {
    if (!activeTabId) return;
    setTabs((prev) => {
      let changed = false;
      const next = prev.map((t) => {
        if (t.tabId !== activeTabId) return t;
        if (!tabPatchChanges(t, patch)) return t;
        changed = true;
        return { ...t, ...patch };
      });
      return changed ? next : prev;
    });
  }, [activeTabId]);

  /** Patch a tab by explicit id rather than "whichever is active now".
   * Async flows (connect/send/abort) capture their starting tabId and
   * use this helper so a mid-flight tab switch doesn't write state onto
   * the wrong tab. */
  const updateTabById = useCallback((tabId: string | null | undefined, patch: Partial<TabEntry>) => {
    if (!tabId) return;
    setTabs((prev) => {
      let changed = false;
      const next = prev.map((t) => {
        if (t.tabId !== tabId) return t;
        if (!tabPatchChanges(t, patch)) return t;
        changed = true;
        return { ...t, ...patch };
      });
      return changed ? next : prev;
    });
  }, []);

  // Active tab — convenience getter for read-only consumers.
  const activeTab = useMemo(
    () => tabs.find((t) => t.tabId === activeTabId) ?? null,
    [tabs, activeTabId],
  );
  useEffect(() => {
    if (!activeTab) return;
    void apiPost("/state/ui", {
      activeTabId: activeTab.tabId,
      activeTab: {
        tabId: activeTab.tabId,
        cwd: activeTab.cwd ?? "",
        autonomy: activeTab.autonomy ?? autonomy,
        connectionId: activeTab.connectionId ?? null,
        connectionLabel: activeTab.connectionLabel ?? "Local",
        connectionTransport: activeTab.connectionTransport ?? "local",
        shellxToolExposure: normalizeShellxToolExposure(activeTab.shellxToolExposure),
      },
      source: "renderer",
    }).catch(() => { /* debug API may be off */ });
  }, [
    activeTab?.tabId,
    activeTab?.cwd,
    activeTab?.autonomy,
    autonomy,
    activeTab?.connectionId,
    activeTab?.connectionLabel,
    activeTab?.connectionTransport,
    activeTab?.shellxToolExposure,
  ]);
  useEffect(() => {
    const openTabs = tabs.map((t) => ({
      tabId: t.tabId,
      sessionId: t.sessionId,
      title: t.title,
      cwd: t.cwd,
      agentId: t.agentId ?? null,
      connectionId: t.connectionId ?? null,
      connectionLabel: t.connectionLabel ?? "Local",
      connectionTransport: t.connectionTransport ?? "local",
      projectId: t.projectId ?? null,
      branchName: t.branchName ?? null,
      status: t.status ?? "Idle",
      isSending: Boolean(t.isSending),
    }));
    const key = JSON.stringify(openTabs);
    if (openTabsDebugKeyRef.current === key) return;
    openTabsDebugKeyRef.current = key;
    void apiPost("/state/ui", { openTabs, source: "renderer" }).catch(() => { /* debug API may be off */ });
  }, [tabs]);
  const [activeConnectionPreset, setActiveConnectionPreset] = useState<ConnectionPreset | null>(null);
  const [activeProviderScanOverride, setActiveProviderScanOverride] = useState<{
    connectionId: string | null;
    transportSignature: string;
    providers: ConnectionProviderScanEntry[];
    freshUntilMs: number;
  } | null>(null);
  const [debugAgentPickerFixture, setDebugAgentPickerFixture] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setActiveConnectionPreset(null);
    void loadConnectionPreset(activeTab?.connectionId ?? null)
      .then((preset) => {
        if (!cancelled) setActiveConnectionPreset(preset);
      })
      .catch(() => {
        if (!cancelled) setActiveConnectionPreset(null);
      });
    return () => {
      cancelled = true;
    };
  }, [activeTab?.connectionId]);
  const activeAgentProviderScan = useMemo(() => {
    if (debugAgentPickerFixture) {
      return [{
        providerId: "codex-cli" as const,
        canRun: true,
        status: "ready" as const,
        binary: "shellx-release-owned-codex",
        version: "shellx-release-owned-codex 0.3.5",
        checkedAtMs: Number.MAX_SAFE_INTEGER,
      }];
    }
    const connectionId = activeTab?.connectionId ?? null;
    const transportSignature = activeConnectionPreset
      ? connectionTransportSignature(activeConnectionPreset)
      : connectionTransportSignature(currentLocalConnectionPreset());
    if (
      activeProviderScanOverride?.connectionId === connectionId &&
      activeProviderScanOverride.transportSignature === transportSignature &&
      activeProviderScanOverride.freshUntilMs > Date.now()
    ) {
      return activeProviderScanOverride.providers;
    }
    return [];
  }, [activeConnectionPreset, activeProviderScanOverride, activeTab?.connectionId, debugAgentPickerFixture]);
  useEffect(() => {
    if (!activeTab || !activeTab.connectionTransport || activeTab.connectionTransport === "local") return;
    const current = activeTab.cwd ?? "";
    if (isUnixAbsoluteCwd(current)) return;
    const next = activeConnectionPreset
      ? cwdForConnectionPreset(activeConnectionPreset, current)
      : "/";
    if (next !== current) {
      updateTabById(activeTab.tabId, { cwd: next });
    }
  }, [
    activeConnectionPreset,
    activeTab?.connectionId,
    activeTab?.connectionTransport,
    activeTab?.cwd,
    activeTab?.tabId,
    updateTabById,
  ]);
  const scanRequestKeys = useRef<Set<string>>(new Set());
  const completedAutoScanKeys = useRef<Map<string, number>>(new Map());
  const handleProviderScanUpdated = useCallback((preset: ConnectionPreset, providers: ConnectionProviderScanEntry[]) => {
    const connectionId = preset.id ? preset.id : null;
    const transportSignature = connectionTransportSignature(preset);
    const checkedAtMs = Math.max(0, ...providers.map((provider) => provider.checkedAtMs));
    const freshUntilMs = checkedAtMs + CONNECTION_PROVIDER_CAPABILITY_TTL_MS;
    const nextPreset: ConnectionPreset = { ...preset, providerScan: providers };
    setActiveProviderScanOverride({ connectionId, transportSignature, providers, freshUntilMs });
    setActiveConnectionPreset((prev) => {
      if (
        prev?.id === preset.id &&
        providerScanSignature(prev.providerScan) === providerScanSignature(providers)
      ) {
        return prev;
      }
      if (prev?.id === preset.id) return { ...prev, providerScan: providers };
      if (!prev && connectionId === null) return nextPreset;
      return prev;
    });

    const tab = tabsRef.current.find((entry) => entry.tabId === activeTabId);
    if (tab && !tab.firstMessageMs && (tab.connectionId ?? null) === connectionId) {
      const currentAgent = normalizeAgentSelection(tab.agentId);
      updateTabById(tab.tabId, {
        cwd: cwdForConnectionPreset(nextPreset, tab.cwd || cwd),
        agentId: agentForConnectionPreset(nextPreset, currentAgent),
      });
    }

    if (preset.id && inTauri()) {
      void invoke<ConnectionPreset>("connections_save", { preset: nextPreset })
        .then((saved) => {
          setActiveConnectionPreset((prev) => (prev?.id === saved.id ? saved : prev));
        })
        .catch((err) => {
          pushUiEvent(`✗ saving agent CLI scan failed for ${preset.label}: ${err}`);
        });
    }
  }, [activeTabId, cwd, updateTabById]);

  const scanConnectionProvidersForPreset = useCallback((
    preset: ConnectionPreset,
    options: { force?: boolean } = {},
  ) => {
    if (!inTauri()) return;
    if (!["local", "wsl", "ssh"].includes(preset.transport.kind)) return;
    const connectionId = preset.id ? preset.id : null;
    const requestKey = `${activeTabId ?? "no-tab"}:${connectionId ?? "local"}:${connectionTransportSignature(preset)}`;
    if (!options.force && (completedAutoScanKeys.current.get(requestKey) ?? 0) > Date.now()) return;
    if (scanRequestKeys.current.has(requestKey)) return;
    scanRequestKeys.current.add(requestKey);
    pushUiEvent(`→ scanning agent CLIs for ${preset.label}`);
    void scanConnectionProviderCapabilities(preset)
      .then((snapshot) => {
        handleProviderScanUpdated(preset, snapshot.providers);
        completedAutoScanKeys.current.set(requestKey, snapshot.freshUntilMs);
        const ready = snapshot.providers.filter((provider) => providerScanStatus(provider) === "ready").length;
        pushUiEvent(`✓ ${preset.label}: ${ready} agent CLI${ready === 1 ? "" : "s"} ready`);
      })
      .catch((err) => {
        pushUiEvent(`✗ agent CLI scan failed for ${preset.label}: ${err}`);
      })
      .finally(() => {
        scanRequestKeys.current.delete(requestKey);
      });
  }, [activeTabId, handleProviderScanUpdated]);

  useEffect(() => {
    if (!activeTab || !["local", "wsl", "ssh"].includes(activeTab.connectionTransport ?? "local")) return;
    if (activeTab.connectionId && activeConnectionPreset?.id !== activeTab.connectionId) return;
    const preset = activeConnectionPreset ?? currentLocalConnectionPreset();
    scanConnectionProvidersForPreset(preset);
    const refreshWhenVisible = () => {
      if (document.visibilityState !== "hidden") scanConnectionProvidersForPreset(preset);
    };
    window.addEventListener("focus", refreshWhenVisible);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      window.removeEventListener("focus", refreshWhenVisible);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [activeConnectionPreset, activeTab?.connectionId, activeTab?.connectionTransport, activeTab?.tabId, scanConnectionProvidersForPreset]);

  const activePendingAttachmentKey = pendingAttachmentKey(activeTabId);
  const pendingAttachments = pendingAttachmentsByTab[activePendingAttachmentKey]?.text ?? [];
  const pendingAttachmentChips = pendingAttachmentsByTab[activePendingAttachmentKey]?.chips ?? [];
  const taskManagerContextForTab = useCallback((tab: TabEntry | null | undefined): TaskManagerCurrentContext => {
    const projectId = tab?.projectId;
    const projectLabel = projectId ? projects.find((project) => project.id === projectId)?.name : undefined;
    return {
      localPreset: currentLocalConnectionPreset(),
      activeConnectionId: tab?.connectionId ?? null,
      canonicalCwd: tab?.cwd ?? cwd,
      projectId,
      projectLabel,
    };
  }, [cwd, projects]);
  const taskManagerCurrentContext = useCallback(
    (): TaskManagerCurrentContext => taskManagerContextForTab(activeTab),
    [activeTab?.connectionId, activeTab?.cwd, activeTab?.projectId, taskManagerContextForTab],
  );
  const taskComposerDisabledReason = useMemo(() => {
    if (!inTauri()) return "Create task requires the ShellX desktop app.";
    if (!activeTab) return "Create task needs an active chat tab.";
    if (taskManagerOpen) return "Finish or close the current Task draft before creating another one.";
    if (!(activeTab.cwd ?? cwd).trim()) return "Create task needs a resolved working folder for this tab.";
    if (activeTab.connectionId && !activeConnectionPreset) {
      return "The selected saved connection is unresolved. Choose it again before creating a task.";
    }
    if (taskAttachmentPersistenceBusy) return "Preparing durable Task attachments.";
    return undefined;
  }, [activeConnectionPreset, activeTab, cwd, taskAttachmentPersistenceBusy, taskManagerOpen]);
  const openTaskManager = useCallback((
    mode: TaskManagerMode,
    initialDraft?: TaskManagerDraft,
    context = taskManagerCurrentContext(),
  ): void => {
    setTaskManagerMode(mode);
    setTaskManagerInitialDraft(initialDraft);
    setTaskManagerOpen(true);
    if (!inTauri()) {
      setTaskManagerData((current) => ({
        ...current,
        loadState: "error",
        loadDetail: "Task definitions are available only in the ShellX desktop app.",
      }));
      return;
    }
    void taskManagerController.load(context);
  }, [taskManagerController, taskManagerCurrentContext]);
  async function reclaimImportedTaskAttachments(
    attachments: DurableTaskAttachmentReference[],
  ): Promise<void> {
    if (attachments.length === 0) return;
    const attachmentIds = attachments.map((attachment) => attachment.attachmentId);
    try {
      const raw = await invoke<unknown>("tasks_reclaim_attachments", {
        request: { attachmentIds },
      });
      const result = parseTaskAttachmentReclamationResponse(raw, attachmentIds);
      if (result.reclaimedAttachmentIds.length > 0) {
        pushUiEvent(`✓ reclaimed ${result.reclaimedAttachmentIds.length} unused Task attachment${result.reclaimedAttachmentIds.length === 1 ? "" : "s"}`);
      }
      if (result.pendingAttachmentIds.length > 0) {
        pushUiEvent(`◎ ${result.pendingAttachmentIds.length} Task attachment cleanup${result.pendingAttachmentIds.length === 1 ? " is" : "s are"} pending until the target is available`);
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      pushUiEvent(`◎ unused Task attachment cleanup remains pending: ${detail}`);
    }
  }
  function closeTaskManager(): void {
    const pending = pendingImportedTaskAttachmentsRef.current;
    pendingImportedTaskAttachmentsRef.current = [];
    setTaskManagerOpen(false);
    if (pending.length > 0) void reclaimImportedTaskAttachments(pending);
  }
  async function saveTaskManagerDraft(draft: TaskManagerDraft): Promise<TaskManagerActionResult> {
    const result = await taskManagerController.save(draft);
    if (result.accepted) {
      // A successfully created draft is now a durable selected definition.
      // Leave create mode so Run now, lifecycle actions, and exact revision
      // hydration operate on the record the controller just published.
      setTaskManagerMode("edit");
      setTaskManagerInitialDraft(undefined);
    }
    if (!result.accepted || pendingImportedTaskAttachmentsRef.current.length === 0) return result;
    const saved = new Set((draft.context?.attachmentRefs ?? []).map((attachment) => attachment.attachmentId));
    const unused = pendingImportedTaskAttachmentsRef.current
      .filter((attachment) => !saved.has(attachment.attachmentId));
    pendingImportedTaskAttachmentsRef.current = [];
    if (unused.length > 0) void reclaimImportedTaskAttachments(unused);
    return result;
  }
  function applyDebugTaskManagerAction(
    action: Parameters<typeof updateDebugTaskManagerState>[1],
    detail: string,
  ): TaskManagerActionResult {
    setTaskManagerData((current) => updateDebugTaskManagerState(current, action));
    return { accepted: true, detail };
  }
  const createTaskFromComposer = useCallback(async (): Promise<void> => {
    if (taskComposerDisabledReason || !activeTab || taskAttachmentPersistenceInFlightRef.current) return;
    const sourceTabId = activeTab.tabId;
    const sourceAttachmentPaths = pendingAttachmentChips.map((attachment) => attachment.path);
    const taskContext = taskManagerCurrentContext();
    let attachmentRefs: Array<{ attachmentId: string; digest?: string }> = [];
    if (sourceAttachmentPaths.length > 0) {
      taskAttachmentPersistenceInFlightRef.current = true;
      setTaskAttachmentPersistenceBusy(true);
      try {
        const raw = await invoke<unknown>("tasks_persist_attachments", {
          request: {
            connectionId: taskEnvironmentKey(activeTab.connectionId),
            canonicalCwd: taskContext.canonicalCwd,
            sources: sourceAttachmentPaths,
          },
        });
        const persisted = parseTaskAttachmentPersistenceResponse(raw, sourceAttachmentPaths.length);
        attachmentRefs = persisted.attachments;
        pendingImportedTaskAttachmentsRef.current = persisted.attachments.map((attachment) => ({ ...attachment }));
        pushUiEvent(`✓ prepared ${persisted.attachments.length} durable Task attachment${persisted.attachments.length === 1 ? "" : "s"}`);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        pushUiEvent(`✗ Task attachments were not prepared: ${detail}`);
        return;
      } finally {
        taskAttachmentPersistenceInFlightRef.current = false;
        setTaskAttachmentPersistenceBusy(false);
      }
    }
    if (tabsRef.current.every((tab) => tab.tabId !== sourceTabId)) {
      const unused = pendingImportedTaskAttachmentsRef.current;
      pendingImportedTaskAttachmentsRef.current = [];
      if (unused.length > 0) void reclaimImportedTaskAttachments(unused);
      pushUiEvent("✗ The source conversation closed before its Task draft was prepared.");
      return;
    }
    const timezone = taskDeviceTimezone();
    const initialDraft = createComposerTaskDraft({
      requestId: `composer-task-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      tabId: activeTab.tabId,
      sessionId: activeTab.sessionId ?? undefined,
      connectionKey: taskEnvironmentKey(activeTab.connectionId),
      canonicalCwd: taskContext.canonicalCwd,
      projectId: activeTab.projectId,
      agentSuggestion: activeTab.agentId ?? undefined,
      permissionMode: providerPermissionModeForAutonomy(activeTab.autonomy ?? autonomy),
      autonomyMode: activeTab.autonomy ?? autonomy,
      toolExposureIds: [normalizeShellxToolExposure(activeTab.shellxToolExposure)],
      attachmentRefs,
      visiblePrompt: prompt,
      suggestedName: activeTab.title === "new session" ? undefined : activeTab.title,
      timezone,
    });
    openTaskManager("create", initialDraft);
  }, [activeTab, autonomy, openTaskManager, pendingAttachmentChips, prompt, taskAttachmentPersistenceBusy, taskComposerDisabledReason, taskManagerCurrentContext]);
  const openBrowserTeachTaskDraft = useCallback(async (handoff: BrowserTeachTaskHandoff): Promise<void> => {
    const browserState = await invoke<unknown>("shellx_browser_state");
    if (!browserTeachTaskHandoffMatchesNativeState(handoff, browserState)) {
      throw new Error("The reviewed Browser workflow receipt is no longer current.");
    }
    const sourceTab = tabsRef.current.find((tab) => tab.tabId === handoff.ownerSessionId);
    if (!sourceTab) throw new Error("The ShellX session that recorded this workflow is no longer open.");
    const context = taskManagerContextForTab(sourceTab);
    if (!context.canonicalCwd.trim()) throw new Error("The source ShellX session has no resolved working folder.");
    const initialDraft = createBrowserTeachTaskDraft({
      requestId: handoff.requestId,
      tabId: sourceTab.tabId,
      sessionId: sourceTab.sessionId ?? undefined,
      connectionKey: taskEnvironmentKey(sourceTab.connectionId),
      canonicalCwd: context.canonicalCwd,
      projectId: sourceTab.projectId,
      agentSuggestion: sourceTab.agentId ?? undefined,
      permissionMode: providerPermissionModeForAutonomy(sourceTab.autonomy ?? autonomy),
      autonomyMode: sourceTab.autonomy ?? autonomy,
      toolExposureIds: [normalizeShellxToolExposure(sourceTab.shellxToolExposure)],
      attachmentRefs: [],
      visiblePrompt: handoff.goal,
      suggestedName: handoff.goal,
      timezone: taskDeviceTimezone(),
      workflow: { workflowId: handoff.workflowId, digest: handoff.workflowDigest },
      vaultKeyIds: handoff.requiredVaultKeyIds,
    });
    setActiveTabId(sourceTab.tabId);
    openTaskManager("create", initialDraft, context);
  }, [autonomy, openTaskManager, taskManagerContextForTab]);
  useBrowserTeachTaskHandoffBridge(openBrowserTeachTaskDraft);
  useEffect(() => {
    if (!inTauri()) return;
    void taskManagerController.load(taskManagerCurrentContext());
  }, [taskManagerController, taskManagerCurrentContext]);
  useEffect(() => {
    if (!inTauri()) return;
    let disposed = false;
    let unlistenTasks: UnlistenFn | undefined;
    void listen("tasks-updated", () => {
      if (disposed) return;
      if (taskManagerOpenRef.current && taskManagerModeRef.current === "create") return;
      const selectedDefinitionId = taskManagerController.snapshot().selectedDefinitionId;
      void taskManagerController.load(taskManagerCurrentContext()).then(() => {
        if (!disposed && selectedDefinitionId) {
          void taskManagerController.selectDefinition(selectedDefinitionId);
        }
      });
    }).then((unlisten) => {
      if (disposed) unlisten();
      else unlistenTasks = unlisten;
    }).catch(() => {
      /* The Task Manager can still refresh explicitly after each action. */
    });
    return () => {
      disposed = true;
      unlistenTasks?.();
    };
  }, [taskManagerController, taskManagerCurrentContext]);
  const updatePendingAttachmentsForTab = useCallback((
    tabId: string | null | undefined,
    updater: (current: PendingComposerAttachments) => PendingComposerAttachments,
  ) => {
    const key = pendingAttachmentKey(tabId);
    setPendingAttachmentsByTab((prev) => {
      const current = prev[key] ?? { text: [], chips: [] };
      const next = updater(current);
      if (next.text.length === 0 && next.chips.length === 0) {
        if (!(key in prev)) return prev;
        const copy = { ...prev };
        delete copy[key];
        return copy;
      }
      return { ...prev, [key]: next };
    });
  }, []);
  const clearPendingAttachmentsForTab = useCallback((tabId: string | null | undefined) => {
    const key = pendingAttachmentKey(tabId);
    setPendingAttachmentsByTab((prev) => {
      if (!(key in prev)) return prev;
      const copy = { ...prev };
      delete copy[key];
      return copy;
    });
  }, []);
  const activeWorkPreviewState = useMemo(
    () => {
      const tabId = previewFileContext?.tabId ?? activeTabId;
      return tabId
        ? workPreviewByTab.get(tabId) ?? emptyWorkPreviewState(tabId)
        : emptyWorkPreviewState("default");
    },
    [activeTabId, previewFileContext?.tabId, workPreviewByTab],
  );
  const rightRailWorkPreviewState = useMemo(
    () => activeTabId
      ? workPreviewByTab.get(activeTabId) ?? emptyWorkPreviewState(activeTabId)
      : emptyWorkPreviewState("default"),
    [activeTabId, workPreviewByTab],
  );
  const workPreviewTabIds = useMemo(() => {
    const ids = new Set<string>();
    for (const tab of tabs) ids.add(tab.tabId);
    if (activeTabId) ids.add(activeTabId);
    if (previewFileContext?.tabId) ids.add(previewFileContext.tabId);
    return Array.from(ids);
  }, [activeTabId, previewFileContext?.tabId, tabs]);
  const workPreviewTabIdsKey = workPreviewTabIds.join("\u0000");
  const [workPreviewPollingVisible, setWorkPreviewPollingVisible] = useState(
    () => document.visibilityState !== "hidden",
  );
  useEffect(() => {
    const onVisibilityChange = () => {
      setWorkPreviewPollingVisible(document.visibilityState !== "hidden");
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, []);
  const anyRunningPreview = workPreviewTabIds.some((tabId) => {
    const state = workPreviewByTab.get(tabId);
    return state?.status === "running" || state?.status === "starting";
  });
  const refreshWorkPreviews = useCallback(
    async (isCurrent: PollCurrent): Promise<void> => {
      const states = await Promise.all(
        workPreviewTabIds.map((tabId) =>
          getWorkPreviewState(tabId).catch(() => null),
        ),
      );
      if (!isCurrent()) return;
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
    },
    [workPreviewTabIdsKey],
  );
  useEventAwarePolling({
    enabled: inTauri() && workPreviewPollingVisible && workPreviewTabIds.length > 0,
    scopeKey: workPreviewTabIdsKey,
    eventRevision: 0,
    intervalMs: anyRunningPreview ? 2_000 : 5_000,
    poll: refreshWorkPreviews,
  });

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
  const sessionAssetRegistry = useMemo(
    () => extractSessionAssetRegistry(
      events,
      tabs.map((tab) => ({
        tabId: tab.tabId,
        sessionId: tab.sessionId,
        title: tab.title,
        cwd: tab.cwd,
        connectionLabel: tab.connectionLabel,
        connectionTransport: tab.connectionTransport,
      })),
    ),
    [events, tabs],
  );
  const sessionVaultPermissions = useMemo(
    () => extractVaultPermissionRequests(
      events,
      tabs.map((tab) => ({ tabId: tab.tabId, title: tab.title })),
    ),
    [events, tabs],
  );
  const vaultRequestItems = useMemo(
    () => buildVaultRequestCenterItems({
      sessionPermissions: sessionVaultPermissions,
      browserSessionGrants: browserVaultRequestState.sessionGrants ?? [],
      browserVaultDeposits: browserVaultRequestState.vaultDeposits ?? [],
      vaultGrants: browserVaultRequestState.vaultGrants ?? [],
      agentRequests: browserVaultRequestState.agentRequests ?? [],
      dismissedDepositIds: dismissedVaultDepositIds,
    }),
    [
      browserVaultRequestState.sessionGrants,
      browserVaultRequestState.vaultDeposits,
      browserVaultRequestState.vaultGrants,
      browserVaultRequestState.agentRequests,
      dismissedVaultDepositIds,
      sessionVaultPermissions,
    ],
  );
  const handleVaultRequestCenterAction = useCallback(
    (
      request: VaultRequestCenterItem,
      action: VaultRequestCenterAction,
      event?: ShellxUserEventLike,
    ) => {
      if (vaultRequestActionRequiresTrustedUserEvent(action) && !isTrustedShellxUserEvent(event)) {
        console.warn("[VaultRequestCenter] ignored untrusted human-only action:", action.kind);
        return;
      }
      if (action.kind === "focusSession") {
        if (request.tabId) setActiveTabId(request.tabId);
        return;
      }
      if (action.kind === "allowPermission" || action.kind === "denyPermission") {
        if (!request.requestId) return;
        const allow = action.kind === "allowPermission";
        void invoke<boolean>("resolve_permission_request", {
          requestId: request.requestId,
          allow,
        }).catch((err) => {
          console.warn("[VaultRequestCenter] permission resolve failed:", err);
        });
        const resolvedAt = Date.now();
        const synthetic: RawEventFrame = {
          t: resolvedAt,
          kind: "permission-resolved",
          payload: {
            requestId: request.requestId,
            decision: allow ? "allow" : "deny",
            decisionAt: resolvedAt,
            _meta: { tabId: request.tabId ?? activeTabIdRef.current ?? "default" },
          },
        };
        flushLiveEvents();
        setEvents((prev) => appendBoundedRendererEvents(prev, synthetic));
        return;
      }
      if (action.kind === "approveBrowserGrant" || action.kind === "denyBrowserGrant") {
        if (!request.grantId) return;
        const approved = action.kind === "approveBrowserGrant";
        const resolvedAt = Date.now();
        setBrowserVaultRequestState((current) => ({
          ...current,
          sessionGrants: (current.sessionGrants ?? []).map((grant) =>
            grant.grantId === request.grantId
              ? {
                  ...grant,
                  status: approved ? "granted" : "denied",
                  resolvedAtMs: resolvedAt,
                }
              : grant,
          ),
        }));
        void invoke<BrowserSessionGrantPromptSource>("shellx_browser_resolve_session_grant", {
          grantId: request.grantId,
          approved,
        })
          .catch((err) => {
            console.warn("[VaultRequestCenter] browser grant resolve failed:", err);
          })
          .finally(() => void refreshBrowserVaultRequests());
        return;
      }
      if (action.kind === "approveVaultGrant" || action.kind === "denyVaultGrant") {
        if (!request.grantId) return;
        const approved = action.kind === "approveVaultGrant";
        setBrowserVaultRequestState((current) => ({
          ...current,
          vaultGrants: (current.vaultGrants ?? []).map((grant) =>
            grant.grantId === request.grantId
              ? {
                  ...grant,
                  approved: approved ? true : grant.approved,
                  revoked: approved ? grant.revoked : true,
                }
              : grant,
          ),
        }));
        const command = approved ? "shellx_vault_approve_grant" : "shellx_vault_revoke_grant";
        void invoke(command, { grantId: request.grantId })
          .catch((err) => {
            console.warn("[VaultRequestCenter] vault grant resolve failed:", err);
          })
          .finally(() => void refreshBrowserVaultRequests());
        return;
      }
      if (
        action.kind === "approveVaultAgentRequest" ||
        action.kind === "denyVaultAgentRequest"
      ) {
        if (!request.agentRequestId || !request.expectedDigest) return;
        setBrowserVaultRequestState((current) => ({
          ...current,
          agentRequests: (current.agentRequests ?? []).filter(
            (candidate) => candidate.requestId !== request.agentRequestId,
          ),
        }));
        const command = action.kind === "approveVaultAgentRequest"
          ? "shellx_vault_agent_request_approve"
          : "shellx_vault_agent_request_deny";
        void invoke(command, {
          requestId: request.agentRequestId,
          expectedDigest: request.expectedDigest,
        })
          .catch((err) => {
            console.warn("[VaultRequestCenter] Vault agent request resolve failed:", err);
          })
          .finally(() => void refreshBrowserVaultRequests());
        return;
      }
      if (action.kind === "openVault") {
        openVaultPanel("overview");
        if (request.depositId) {
          setDismissedVaultDepositIds((current) => {
            const next = new Set(current);
            next.add(request.depositId!);
            storeDismissedVaultDepositIds(next);
            return next;
          });
        }
        return;
      }
      if (action.kind === "dismissDeposit") {
        if (!request.depositId) return;
        setDismissedVaultDepositIds((current) => {
          const next = new Set(current);
          next.add(request.depositId!);
          storeDismissedVaultDepositIds(next);
          return next;
        });
      }
    },
    [openVaultPanel, refreshBrowserVaultRequests],
  );
  const vaultRequestCenter = useMemo(
    () => ({
      requests: vaultRequestItems,
      summaryText: vaultRequestSummaryText(vaultRequestItems),
      onAction: handleVaultRequestCenterAction,
    }),
    [handleVaultRequestCenterAction, vaultRequestItems],
  );

  const latestAgentForActiveTab = useMemo(
    () => latestAgentFromEventFrames(eventsForActiveTab),
    [eventsForActiveTab],
  );
  const selectedAgentForTab = normalizeAgentSelection(activeTab?.agentId);
  const activeAgentForChat =
    latestAgentForActiveTab ?? selectedAgentForTab;
  const activeAgentForControls = selectedAgentForTab ?? activeAgentForChat;
  const activeAgentForTokens = activeAgentForControls;

  // Per-tab token count: Grok events can be shown against Grok's detected
  // context window. Provider CLI token totals are provider-reported usage
  // only; ShellX does not know their active model window yet.
  const totalTokens = useMemo(() => {
    for (let i = eventsForActiveTab.length - 1; i >= 0; i--) {
      const e = eventsForActiveTab[i];
      if (!e) continue;
      if (e.kind === "provider-session-event") {
        if (!activeAgentForTokens || activeAgentForTokens === "grok") continue;
        const tt = (e.payload as any)?.totalTokens;
        if (typeof tt === "number") return tt;
        continue;
      }
      if (activeAgentForTokens !== "grok") continue;
      if (e.kind !== "grok-acp-event") continue;
      const tt = (e.payload as any)?.params?._meta?.totalTokens;
      if (typeof tt === "number") return tt;
    }
    return 0;
  }, [activeAgentForTokens, eventsForActiveTab]);
  const tokenTitle = !activeAgentForTokens
    ? "Choose an agent to see token usage."
    : activeAgentForTokens === "grok"
      ? `Context window: ${totalTokens.toLocaleString()} of ${maxTokens.toLocaleString()} (${maxTokens > 0 ? ((totalTokens / maxTokens) * 100).toFixed(1) : "0"}%)`
      : `${agentDisplayName(activeAgentForTokens)} token usage: ${totalTokens.toLocaleString()} provider-reported tokens. Context window is not reported by this provider.`;

  /* Grok slash commands from the active tab's latest
   * available_commands_update event. Provider and unselected tabs must
   * not inherit stale Grok commands from another session. */
  const selectedAgentForSlash = activeAgentForControls;
  const skills = useMemo<AcpCommand[]>(() => {
    if (selectedAgentForSlash !== "grok") return [];
    for (let i = eventsForActiveTab.length - 1; i >= 0; i--) {
      const e = eventsForActiveTab[i];
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
  }, [eventsForActiveTab, selectedAgentForSlash]);
  const visibleSlashCommands = useMemo<AcpCommand[]>(() => {
    const normalize = (name: string): string => name.replace(/^\/+/, "");
    const shellxCommands: AcpCommand[] = [
      {
        name: "commands",
        description: "Open shellX command search with actions and available agent commands.",
        input: null,
        _meta: { scope: "shellx" },
      },
    ];
    if (selectedAgentForSlash !== "grok") return shellxCommands;
    const filtered = skills.filter((s) => normalize(s.name) !== "goal");
    const withShellxCommands = [...shellxCommands, ...filtered];
    if (withShellxCommands.some((s) => normalize(s.name) === "build")) return withShellxCommands;
    return [
      {
        name: "build",
        description: "shellX Build Mode: plan, implement, review, verify, and complete with receipts.",
        input: { hint: "<objective>" },
        _meta: { scope: "shellx" },
      },
      ...withShellxCommands,
    ];
  }, [selectedAgentForSlash, skills]);

  // Session title from Grok summaries or standard ACP metadata updates. For
  // each tab, pick the newest title in the current events snapshot and apply it
  // unless the tab is locked (titleLocked = user-owned). Backgrounded
  // tabs are updated too — focus is not required. wouldChange guards
  // bail out cleanly when nothing would actually move, breaking the
  // [events, tabs, ...] dependency loop.
  useEffect(() => {
    const newest = newestSessionTitleCandidates(events, activeTabId ?? "default");
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
      const finalTitle = override ?? candidate.title;
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
          const finalTitle = override ?? candidate.title;
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
    // DEBUG_UI_CONNECTION_OWNER_START
    let socket: WebSocket | null = null;
    let closed = false;
    let connectTimer: number | null = null;
    let retryTimer: number | null = null;
    let recentPollTimer: number | null = null;
    let statePollTimer: number | null = null;
    let nativeStatePollTimer: number | null = null;
    let nativeStatePollErrorReported = false;
    let unlistenDebugUiPatch: UnlistenFn | null = null;
    let retryAttempt = 0;
    let connectionStatus: DebugUiConnectionStatus = "connecting";
    const connectedAfterMs = Date.now() - 500;
    let lastDebugUiPatchMs = connectedAfterMs;
    let lastAppliedUiRevision: number | null = null;

    const applyPatch = (patch: unknown) => {
      if (!patch || typeof patch !== "object") return;
      const p = patch as Record<string, unknown>;
      if (normalizeDebugSurface(p.debugSurface) === "browser") return;
      const rightTabPatch = normalizeRightTabPatch(p.rightTab);
      if (rightTabPatch) {
        setRightRailRequest((cur) => ({ tab: rightTabPatch, seq: (cur?.seq ?? 0) + 1 }));
      }
      const bottomTabPatch = normalizeBottomTabPatch(p.bottomTab);
      if (bottomTabPatch) {
        setBottomTab(bottomTabPatch);
      }
      if (typeof p.activeTabId === "string" && tabsRef.current.some((t) => t.tabId === p.activeTabId)) {
        setActiveTabId(p.activeTabId);
      }
      if (p.activeTab && typeof p.activeTab === "object") {
        const tabPatch = p.activeTab as Record<string, unknown>;
        const requestedTabId = typeof tabPatch.tabId === "string" ? tabPatch.tabId : activeTabIdRef.current;
        const nextCwd = typeof tabPatch.cwd === "string" ? tabPatch.cwd.trim() : "";
        const nextPatch: Partial<TabEntry> = {};
        if (nextCwd) nextPatch.cwd = nextCwd;
        if ("connectionId" in tabPatch) {
          nextPatch.connectionId = typeof tabPatch.connectionId === "string" ? tabPatch.connectionId : null;
        }
        if (typeof tabPatch.connectionLabel === "string") {
          nextPatch.connectionLabel = tabPatch.connectionLabel.trim() || "Local";
        }
        if (typeof tabPatch.connectionTransport === "string") {
          nextPatch.connectionTransport = tabPatch.connectionTransport.trim() || "local";
        }
        if (requestedTabId && Object.keys(nextPatch).length > 0 && tabsRef.current.some((t) => t.tabId === requestedTabId)) {
          setTabs((prev) =>
            prev.map((t) => (t.tabId === requestedTabId ? { ...t, ...nextPatch } : t)),
          );
          if (requestedTabId === activeTabIdRef.current && nextCwd) {
            setCwd(nextCwd);
          }
        }
      }
      if (p.preview && typeof p.preview === "object") {
        const target = p.preview as Record<string, unknown>;
        const path = typeof target.path === "string" ? target.path.trim() : "";
        if (path) {
          const rawKind = typeof target.kind === "string" ? target.kind : "file";
          const kind: PreviewTarget["kind"] =
            rawKind === "url" || rawKind === "image" || rawKind === "markdown" || rawKind === "diff"
              ? rawKind
              : "file";
          const requestedTabId = typeof target.tabId === "string" ? target.tabId.trim() : "";
          const requestedSessionCwd = typeof target.sessionCwd === "string" ? target.sessionCwd.trim() : "";
          const active = tabsRef.current.find((t) => t.tabId === activeTabIdRef.current)
            ?? tabsRef.current[0]
            ?? null;
          const requestedTab = requestedTabId
            ? tabsRef.current.find((t) => t.tabId === requestedTabId) ?? null
            : null;
          const tabId = requestedTabId || active?.tabId || activeTabIdRef.current || null;
          const sessionCwd = requestedSessionCwd || requestedTab?.cwd || active?.cwd || cwdRef.current;
          setPreviewPath(path);
          setPreviewFileContext({ tabId, sessionCwd });
          if (kind !== "url") {
            setPreviewCenterView("file");
          }
          if (tabId) {
            setTabs((prev) =>
              prev.map((t) => (t.tabId === tabId ? { ...t, preview: { kind, path } } : t)),
            );
          }
        }
      }
      if (p.clearPreview === true) {
        setPreviewPath(null);
        setPreviewFileContext(null);
        setTabs((prev) => prev.map((tab) => ({ ...tab, preview: undefined })));
      }
      const debugAttachPaths = Array.isArray(p.debugAttachPaths)
        ? p.debugAttachPaths
            .filter((path): path is string => typeof path === "string" && path.trim().length > 0)
            .map((path) => path.trim().slice(0, 4096))
            .slice(0, 8)
        : [];
      if (debugAttachPaths.length > 0) {
        void processAttachedPaths(debugAttachPaths, { copyIntoScope: false });
      }
      const debugRemoveAttachmentPaths = Array.isArray(p.debugRemoveAttachmentPaths)
        ? new Set(p.debugRemoveAttachmentPaths
            .filter((path): path is string => typeof path === "string" && path.trim().length > 0)
            .map((path) => path.trim().slice(0, 4096))
            .slice(0, 8))
        : null;
      if (debugRemoveAttachmentPaths && debugRemoveAttachmentPaths.size > 0) {
        updatePendingAttachmentsForTab(activeTabIdRef.current, (current) => ({
          text: current.text.filter((item) => !debugRemoveAttachmentPaths.has(item.path)),
          chips: current.chips.filter((chip) => !debugRemoveAttachmentPaths.has(chip.path)),
        }));
      }
      if (Object.prototype.hasOwnProperty.call(p, "debugRendererFixture")) {
        const fixtureTabId = activeTabIdRef.current ?? tabsRef.current[0]?.tabId ?? "default";
        const providerActionFixture = debugProviderActionFixture(p.debugRendererFixture);
        if (providerActionFixture !== undefined) {
          setDebugProviderAction(providerActionFixture);
          setDebugProviderActionReceipt(null);
          if (providerActionFixture?.action === "activity-ask-agent") {
            setActivityOpen(true);
          } else if (providerActionFixture?.action.startsWith("tasks-")) {
            setRightRailRequest((cur) => ({ tab: "Tasks", seq: (cur?.seq ?? 0) + 1 }));
          } else if (providerActionFixture?.action.startsWith("work-preview-")) {
            setRightRailRequest((cur) => ({ tab: "Preview", seq: (cur?.seq ?? 0) + 1 }));
          } else if (providerActionFixture?.action.startsWith("right-rail-")) {
            setRightRailRequest((cur) => ({ tab: "Tooling", seq: (cur?.seq ?? 0) + 1 }));
          }
        } else {
        const permissionDecisionFixture = debugPermissionDecisionFixture(
          p.debugRendererFixture,
        );
        if (permissionDecisionFixture !== undefined) {
          setDebugPermissionDecisionFixture(permissionDecisionFixture);
          flushLiveEvents();
          setEvents((current) => applyDebugPermissionDecisionFixtureEvents(
            current,
            permissionDecisionFixture,
            fixtureTabId,
          ));
        } else {
          const rightRailGitFixture = debugRightRailGitLifecycleFixture(
            p.debugRendererFixture,
            fixtureTabId,
          );
          if (rightRailGitFixture !== undefined) {
            setDebugRightRailGitFixture(rightRailGitFixture);
          } else {
            flushLiveEvents();
            setEvents((current) => applyDebugRendererFixture(
              current,
              p.debugRendererFixture,
              fixtureTabId,
            ));
            setDebugBuildRunFixture(debugBuildRunCockpitFixture(
              p.debugRendererFixture,
              fixtureTabId,
            ));
            if (p.debugRendererFixture === "clear") {
              setDebugRightRailGitFixture(null);
              setDebugPermissionDecisionFixture(null);
            }
          }
        }
        }
      }
      if (p.debugHashItems === "owned") {
        setHashItems([{
          kind: "issue",
          number: 735,
          title: "Owned autocomplete fixture",
          url: "https://example.invalid/shellx/issues/735",
        }]);
      } else if (p.debugHashItems === "clear") {
        setHashItems([]);
      }
      if (p.debugUiConnectionFixture === "disconnected") {
        setDebugUiConnectionFixture("disconnected");
      } else if (p.debugUiConnectionFixture === "clear") {
        setDebugUiConnectionFixture(null);
      }
      if (p.releaseTestRendererCrash === true) {
        setReleaseTestRendererCrash(true);
      }
      if (p.releaseTestLazySurface === "owned-error") {
        setReleaseTestLazySurface("error");
      } else if (p.releaseTestLazySurface === "clear") {
        setReleaseTestLazySurface(null);
      }
      if (p.releaseTestLegacyAutonomy === "legacy-default") {
        setAutonomy("default");
        const targetTabId = activeTabIdRef.current;
        if (targetTabId) {
          setTabs((current) => current.map((tab) => (
            tab.tabId === targetTabId ? { ...tab, autonomy: "default" } : tab
          )));
        }
      }
      if (p.releaseTestVoiceCapture === "recording") {
        setReleaseTestVoiceRecording(true);
      } else if (p.releaseTestVoiceCapture === "clear") {
        setReleaseTestVoiceRecording(false);
      }
      if (p.releaseTestExternalEffectBoundary === "pr-create"
        || p.releaseTestExternalEffectBoundary === "artifact-archive") {
        setReleaseTestExternalEffectBoundary(p.releaseTestExternalEffectBoundary);
      } else if (p.releaseTestExternalEffectBoundary === "clear") {
        setReleaseTestExternalEffectBoundary(null);
      }
      const agentCliSetupFixturePatch = normalizeDebugAgentCliSetupFixtureMode(
        p.agentCliSetupFixture,
      );
      if (agentCliSetupFixturePatch) {
        setAgentCliSetupFixtureMode(agentCliSetupFixturePatch);
      }
      if (p.debugAgentPickerFixture === "owned-ready") {
        setDebugAgentPickerFixture(true);
      } else if (p.debugAgentPickerFixture === "clear") {
        setDebugAgentPickerFixture(false);
      }
      if (p.debugUpdateFixture === "owned-check" || p.debugUpdateFixture === "owned-available") {
        setDebugUpdateFixture(p.debugUpdateFixture);
      } else if (p.debugUpdateFixture === "clear") {
        setDebugUpdateFixture("owned-cleared");
      }
      if (p.debugPluginsFixture === "owned-safe") {
        setDebugPluginsFixture("owned-safe");
      } else if (p.debugPluginsFixture === "owned-production") {
        setDebugPluginsFixture("owned-production");
      } else if (p.debugPluginsFixture === "clear") {
        setDebugPluginsFixture(null);
      }
      if (p.debugConnectorsFixture === "owned-safe") {
        setDebugConnectorsFixture("owned-safe");
      } else if (p.debugConnectorsFixture === "clear") {
        setDebugConnectorsFixture(null);
      }
      const goalPlanReviewFixturePatch = normalizeDebugGoalPlanReviewFixtureMode(
        p.goalPlanReviewFixture,
      );
      if (goalPlanReviewFixturePatch) {
        setGoalPlanReviewFixtureMode(goalPlanReviewFixturePatch);
      }
      const taskManagerFixturePatch = normalizeDebugTaskManagerFixtureMode(
        p.debugTaskManagerFixture,
      );
      if (taskManagerFixturePatch === "clear") {
        debugTaskManagerFixtureModeRef.current = null;
        setDebugTaskManagerFixtureMode(null);
        setTaskManagerOpen(false);
      } else if (taskManagerFixturePatch) {
        debugTaskManagerFixtureModeRef.current = taskManagerFixturePatch;
        setDebugTaskManagerFixtureMode(taskManagerFixturePatch);
        setTaskManagerData(debugTaskManagerFixtureData(taskManagerFixturePatch));
        setTaskManagerMode("edit");
        setTaskManagerInitialDraft(undefined);
        setTaskManagerOpen(true);
      }
      if (p.debugBuildPlanFixture === "owned-ready") {
        setDebugBuildPlanFixture("owned-ready");
      } else if (p.debugBuildPlanFixture === "clear") {
        setDebugBuildPlanFixture(null);
      }
      if (p.debugShellxagentFixture === "owned-safe") {
        setDebugShellxagentFixture("owned-safe");
      } else if (p.debugShellxagentFixture === "clear") {
        setDebugShellxagentFixture(null);
      }
      const cutToolingFixturePatch = normalizeDebugCutToolingFixture(p.debugCutToolingFixture);
      if (cutToolingFixturePatch === "clear") {
        setDebugCutToolingFixture(null);
      } else if (cutToolingFixturePatch) {
        setDebugCutToolingFixture(cutToolingFixturePatch);
      }
      if (p.debugClipboardFixture === "tasks"
        || p.debugClipboardFixture === "vault-draft"
        || p.debugClipboardFixture === "vault-password"
        || p.debugClipboardFixture === "shellxagent-token"
        || p.debugClipboardFixture === "work-preview") {
        setDebugClipboardFixture(p.debugClipboardFixture);
      } else if (p.debugClipboardFixture === "clear") {
        setDebugClipboardFixture(null);
      }
      const openModalPatch = normalizeDebugModal(p.openModal);
      if (openModalPatch) {
        openDebugModal(openModalPatch);
      }
      if (p.vaultRequestCenterOpen === true) {
        setVaultRequestCenterOpenSeq((seq) => seq + 1);
      } else if (p.vaultRequestCenterOpen === false) {
        setVaultRequestCenterCloseSeq((seq) => seq + 1);
      }
      if (typeof p.setupGuideDismissed === "boolean") {
        window.dispatchEvent(new CustomEvent(SHELLX_SETUP_GUIDE_DISMISSED_EVENT, {
          detail: { dismissed: p.setupGuideDismissed },
        }));
      }
      if (p.refreshPastChats === true) {
        void refreshPastChats();
      }
      const composerMenuPatch = normalizeComposerDebugMenu(p.composerMenu);
      if (composerMenuPatch) {
        setBottomTab("Chat");
        setDebugComposerMenuRequest((cur) => ({
          menu: composerMenuPatch,
          seq: (cur?.seq ?? 0) + 1,
        }));
      }
      const debugClickPatch = p.debugClick ?? p.clickSelector;
      if (debugClickPatch) runDebugClickSelector(debugClickPatch);
      const debugInputPatch = p.debugInput;
      if (debugInputPatch) runDebugInputSelector(debugInputPatch);
      const debugDragPatch = p.debugDrag;
      if (debugDragPatch) runDebugDragSelector(debugDragPatch);
      const debugHighlightsPatch = normalizeDebugHighlightRequests(p.debugHighlights);
      if (debugHighlightsPatch) {
        setDebugHighlights((prev) => sameDebugHighlightRequests(prev, debugHighlightsPatch) ? prev : debugHighlightsPatch);
      }
      const cwdPickerPatch = p.cwdPicker;
      if (cwdPickerPatch) {
        if (typeof cwdPickerPatch === "object" && cwdPickerPatch !== null && (cwdPickerPatch as Record<string, unknown>).open === false) {
          setRemoteFolderPicker(null);
          return;
        }
        const picker = typeof cwdPickerPatch === "object" && cwdPickerPatch !== null
          ? cwdPickerPatch as Record<string, unknown>
          : {};
        const isolated = picker.isolated === true;
        const requestedTabId = isolated
          ? null
          : typeof picker.tabId === "string" ? picker.tabId : activeTabIdRef.current;
        const tab = isolated
          ? null
          : requestedTabId
          ? tabsRef.current.find((entry) => entry.tabId === requestedTabId) ?? null
          : tabsRef.current.find((entry) => entry.tabId === activeTabIdRef.current) ?? null;
        const transport = tab?.connectionTransport ?? "local";
        const initialPath = typeof picker.path === "string" && picker.path.trim()
          ? picker.path
          : tab?.cwd ?? cwdRef.current;
        setRemoteFolderPicker({
          tabId: tab?.tabId ?? requestedTabId ?? null,
          connectionId: isolated
            ? null
            : typeof picker.connectionId === "string" ? picker.connectionId : tab?.connectionId ?? null,
          initialPath: initialPath || "/",
          label: typeof picker.label === "string" && picker.label.trim()
            ? picker.label.trim()
            : tab?.connectionLabel ?? (transport === "local" ? "Local" : transport.toUpperCase()),
        });
      }
    };
    const transientPatchFromEvent = (patch: unknown): Record<string, unknown> => {
      if (!patch || typeof patch !== "object") return {};
      const p = patch as Record<string, unknown>;
      const transient: Record<string, unknown> = {};
      for (const key of [
        "openModal",
        "composerMenu",
        "debugClick",
        "debugInput",
        "debugDrag",
        "debugSurface",
        "debugHighlights",
        "clickSelector",
        "cwdPicker",
        "vaultRequestCenterOpen",
        "setupGuideDismissed",
        "refreshPastChats",
        "clearPreview",
        "debugAttachPaths",
        "debugRemoveAttachmentPaths",
        "debugRendererFixture",
        "debugHashItems",
        "debugUiConnectionFixture",
        "releaseTestRendererCrash",
        "releaseTestLazySurface",
        "releaseTestLegacyAutonomy",
        "releaseTestVoiceCapture",
        "releaseTestExternalEffectBoundary",
        "agentCliSetupFixture",
        "debugAgentPickerFixture",
        "debugUpdateFixture",
        "debugPluginsFixture",
        "debugConnectorsFixture",
        "goalPlanReviewFixture",
        "debugTaskManagerFixture",
        "debugBuildPlanFixture",
        "debugShellxagentFixture",
        "debugCutToolingFixture",
        "debugClipboardFixture",
      ]) {
        if (Object.prototype.hasOwnProperty.call(p, key)) transient[key] = p[key];
      }
      return transient;
    };
    const uiRevisionFromState = (state: Record<string, unknown>): number | null =>
      typeof state.uiRevision === "number" && Number.isFinite(state.uiRevision)
        ? state.uiRevision
        : null;
    const debugUiPatchSource = (patch: unknown): string => {
      if (!patch || typeof patch !== "object") return "";
      const source = (patch as Record<string, unknown>).source;
      return typeof source === "string" ? source.trim().toLowerCase() : "";
    };
    const isRendererDebugUiSourceValue = (source: string): boolean =>
      source === "renderer" || source.startsWith("renderer-");
    const isRendererDebugUiPatch = (patch: unknown): boolean =>
      isRendererDebugUiSourceValue(debugUiPatchSource(patch));
    const applyAuthoritativeUiState = (state: Record<string, unknown>, eventPatch?: unknown) => {
      const revision = uiRevisionFromState(state);
      if (revision !== null) lastAppliedUiRevision = revision;
      applyPatch({ ...state, ...transientPatchFromEvent(eventPatch) });
    };
    const readAuthoritativeUiState = async (): Promise<Record<string, unknown>> => {
      try {
        return await invoke<Record<string, unknown>>("debug_ui_snapshot");
      } catch {
        return apiGet<Record<string, unknown>>("/state/ui");
      }
    };
    const applyAuthoritativeUiPatch = (
      eventPatch: unknown,
      eventState?: Record<string, unknown> | null,
    ) => {
      if (eventState) {
        const revision = uiRevisionFromState(eventState);
        if (revision !== null && revision === lastAppliedUiRevision) return;
        applyAuthoritativeUiState(eventState, eventPatch);
        return;
      }
      void readAuthoritativeUiState()
        .then((state) => {
          if (closed) return;
          const revision = uiRevisionFromState(state);
          if (revision !== null && revision === lastAppliedUiRevision) return;
          applyAuthoritativeUiState(state, eventPatch);
        })
        .catch(() => {
          if (!closed) applyPatch(eventPatch);
        });
    };
    const publishConnectionStatus = (status: DebugUiConnectionStatus) => {
      connectionStatus = status;
      if (!closed) {
        setDebugUiConnectionStatus((current) => current === status ? current : status);
      }
    };
    const clearConnectTimer = () => {
      if (connectTimer !== null) window.clearTimeout(connectTimer);
      connectTimer = null;
    };
    const stopFallbackPolling = () => {
      if (recentPollTimer !== null) window.clearTimeout(recentPollTimer);
      if (statePollTimer !== null) window.clearTimeout(statePollTimer);
      recentPollTimer = null;
      statePollTimer = null;
    };
    const pollRecentEvents = async (): Promise<void> => {
      if (closed || !debugUiPollingEnabled(connectionStatus)) return;
      try {
        const frames = await apiGet<RawEventFrame[]>(
          `/events/recent?limit=80&since=${encodeURIComponent(String(lastDebugUiPatchMs))}`,
        );
        if (closed || !debugUiPollingEnabled(connectionStatus)) return;
        for (const frame of frames) {
          if (frame.kind !== "debug-ui-state-patch") continue;
          const payload = frame.payload as { patch?: unknown; state?: Record<string, unknown> } | null;
          if (isRendererDebugUiPatch(payload?.patch)) continue;
          if (typeof frame.t === "number" && frame.t <= lastDebugUiPatchMs) continue;
          if (typeof frame.t === "number") lastDebugUiPatchMs = frame.t;
          applyAuthoritativeUiPatch(payload?.patch, payload?.state);
        }
      } catch {
        /* WebSocket health owns reconnect state; this poll only covers dropped frames. */
      } finally {
        if (!closed && debugUiPollingEnabled(connectionStatus)) {
          recentPollTimer = window.setTimeout(() => void pollRecentEvents(), debugUiPollDelay(connectionStatus));
        }
      }
    };
    const pollUiState = async (): Promise<void> => {
      if (closed || !debugUiPollingEnabled(connectionStatus)) return;
      try {
        const state = await readAuthoritativeUiState();
        if (closed || !debugUiPollingEnabled(connectionStatus)) return;
        const revision = uiRevisionFromState(state);
        if (revision !== null && revision !== lastAppliedUiRevision && !debugUiStateTargetsBrowser(state)) {
          applyAuthoritativeUiState(state);
        }
      } catch {
        /* WebSocket health owns reconnect state; this is an authoritative-state fallback. */
      } finally {
        if (!closed && debugUiPollingEnabled(connectionStatus)) {
          statePollTimer = window.setTimeout(() => void pollUiState(), debugUiPollDelay(connectionStatus));
        }
      }
    };
    const startFallbackPolling = () => {
      stopFallbackPolling();
      if (!debugUiPollingEnabled(connectionStatus)) return;
      const delay = debugUiPollDelay(connectionStatus);
      recentPollTimer = window.setTimeout(() => void pollRecentEvents(), delay);
      statePollTimer = window.setTimeout(() => void pollUiState(), delay);
    };
    const pollNativeUiState = async (): Promise<void> => {
      if (closed) return;
      try {
        const state = await invoke<Record<string, unknown>>("debug_ui_snapshot");
        if (closed) return;
        nativeStatePollErrorReported = false;
        const revision = uiRevisionFromState(state);
        if (
          !debugUiStateTargetsBrowser(state)
          && (revision === null || revision !== lastAppliedUiRevision)
        ) {
          applyAuthoritativeUiState(state);
        }
      } catch (error) {
        if (!nativeStatePollErrorReported) {
          nativeStatePollErrorReported = true;
          void apiPostJson("/state/ui", {
            source: "renderer-native-poll-error",
            debugSurface: "app",
            debugActionResults: [{
              action: "nativeStatePoll",
              status: "failed",
              message: String(error).slice(0, 500),
            }],
          }).catch(() => undefined);
        }
      } finally {
        if (!closed) nativeStatePollTimer = window.setTimeout(() => void pollNativeUiState(), DEBUG_UI_POLL_MS);
      }
    };
    const scheduleReconnect = () => {
      if (closed) return;
      stopFallbackPolling();
      publishConnectionStatus("disconnected");
      startFallbackPolling();
      if (retryTimer !== null) return;
      const delay = debugUiRetryDelay(retryAttempt);
      retryAttempt += 1;
      retryTimer = window.setTimeout(() => {
        retryTimer = null;
        void connect();
      }, delay);
    };
    const connect = async () => {
      if (closed) return;
      if (socket?.readyState === WebSocket.OPEN || socket?.readyState === WebSocket.CONNECTING) return;
      if (retryTimer !== null) {
        window.clearTimeout(retryTimer);
        retryTimer = null;
      }
      if (connectionStatus !== "disconnected" || retryAttempt === 0) {
        publishConnectionStatus("connecting");
      }
      try {
        const [base, token] = await Promise.all([debugApiBase(), getDebugToken()]);
        if (closed) return;
        const url = `${base.replace(/^http/, "ws")}/events?token=${encodeURIComponent(token)}`;
        const nextSocket = new WebSocket(url);
        socket = nextSocket;
        clearConnectTimer();
        connectTimer = window.setTimeout(() => {
          if (closed || socket !== nextSocket || nextSocket.readyState !== WebSocket.CONNECTING) return;
          nextSocket.onclose = null;
          nextSocket.onerror = null;
          socket = null;
          nextSocket.close();
          scheduleReconnect();
        }, DEBUG_UI_CONNECT_TIMEOUT_MS);
        nextSocket.onopen = () => {
          if (closed || socket !== nextSocket) return;
          clearConnectTimer();
          retryAttempt = 0;
          publishConnectionStatus("connected");
          startFallbackPolling();
          void readAuthoritativeUiState()
            .then((state) => {
              if (!closed && socket === nextSocket) applyAuthoritativeUiState(state);
            })
            .catch(() => {
              /* The status-gated poll retries authoritative state while the socket stays healthy. */
            });
        };
        nextSocket.onmessage = (event) => {
          try {
            const frame = JSON.parse(String(event.data)) as RawEventFrame;
            if (frame.kind !== "debug-ui-state-patch") return;
            const payload = frame.payload as { patch?: unknown; state?: Record<string, unknown> } | null;
            if (isRendererDebugUiPatch(payload?.patch)) return;
            if (typeof frame.t === "number" && frame.t <= lastDebugUiPatchMs) return;
            if (typeof frame.t === "number") lastDebugUiPatchMs = frame.t;
            applyAuthoritativeUiPatch(payload?.patch, payload?.state);
          } catch {
            /* ignore malformed debug stream frames */
          }
        };
        nextSocket.onclose = () => {
          if (socket !== nextSocket) return;
          clearConnectTimer();
          socket = null;
          scheduleReconnect();
        };
        nextSocket.onerror = () => {
          /* onclose is the single reconnect owner, avoiding duplicate retry timers. */
        };
      } catch {
        socket = null;
        scheduleReconnect();
      }
    };
    const reconnectNow = () => {
      if (closed) return;
      retryAttempt = 0;
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      retryTimer = null;
      clearConnectTimer();
      stopFallbackPolling();
      const previous = socket;
      socket = null;
      if (previous) {
        previous.onclose = null;
        previous.close();
      }
      void connect();
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible" && connectionStatus !== "connected") reconnectNow();
    };

    void pollNativeUiState();
    try {
      void listen<{ patch?: unknown; state?: Record<string, unknown> }>("debug-ui-state-patch", (event) => {
        if (closed || isRendererDebugUiPatch(event.payload?.patch)) return;
        applyAuthoritativeUiPatch(event.payload?.patch, event.payload?.state);
      }).then((unlisten) => {
        if (closed) unlisten();
        else unlistenDebugUiPatch = unlisten;
      }).catch(() => {
        /* Snapshot polling remains available when native event setup fails. */
      });
    } catch {
      /* A missing event bridge must not prevent native snapshot polling. */
    }
    void connect();
    window.addEventListener("shellx:debug-api-retry", reconnectNow);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      closed = true;
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      clearConnectTimer();
      stopFallbackPolling();
      if (nativeStatePollTimer !== null) window.clearTimeout(nativeStatePollTimer);
      window.removeEventListener("shellx:debug-api-retry", reconnectNow);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      unlistenDebugUiPatch?.();
      socket?.close();
    };
    // DEBUG_UI_CONNECTION_OWNER_END
  }, []);

  if (releaseTestRendererCrash) {
    throw new Error("SHELLX_RELEASE_TEST_RENDERER_CRASH_035");
  }

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
    while (processedPromptCompletionOrderRef.current.length > 512) {
      const old = processedPromptCompletionOrderRef.current.shift();
      if (old) processedPromptCompletionsRef.current.delete(old);
    }
    return true;
  }, []);

  const sessionIdForEvent = useCallback((ev: RawEventFrame): string | null => {
    const tag = (ev as any)?.payload?._meta?.tabId
      ?? (ev as any)?.payload?.params?._meta?.tabId
      ?? (ev as any)?._meta?.tabId
      ?? null;
    const tabKey: string | null = tag ?? activeTabIdRef.current ?? null;
    if (!tabKey) return null;
    if (isTaskRuntimeTabId(tabKey)) return null;
    return tabSessionByTab.current.get(tabKey)
      ?? tabsRef.current.find((t) => t.tabId === tabKey)?.sessionId
      ?? (tabKey === activeTabIdRef.current ? activeSessionIdRef.current : null)
      ?? null;
  }, []);
  const sessionLogWriteChainRef = useRef<Promise<void>>(Promise.resolve());
  const persistFrames = useCallback((frames: readonly RawEventFrame[]): Promise<number> => {
    const writes = buildSessionLogWrites(frames, sessionIdForEvent);
    if (writes.length === 0) return Promise.resolve(0);
    const frameCount = writes.reduce((total, write) => total + write.frameCount, 0);
    const task = sessionLogWriteChainRef.current.then(async () => {
      for (const write of writes) {
        await invoke("append_session_log", { sessionId: write.sessionId, line: write.line });
      }
    });
    sessionLogWriteChainRef.current = task.catch(() => undefined);
    return task.then(() => frameCount);
  }, [sessionIdForEvent]);
  persistLiveBatchRef.current = (batch) => {
    void persistFrames(batch).catch(() => undefined);
  };
  const persist = useCallback(async (ev: RawEventFrame): Promise<boolean> => {
    try {
      return await persistFrames([ev]) === 1;
    } catch { /* writer may not be ready or invalid path; non-fatal */ }
    return false;
  }, [persistFrames]);
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
          const tail = await invoke<SessionJsonlTailResponse>("read_session_jsonl_tail", {
            sessionId: tab.sessionId,
            limit: MAX_SESSION_LOG_REHYDRATION_LINES,
          });
          const recovered: RawEventFrame[] = [];
          for (const line of tail.lines) {
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
          if (tail.omittedLines > 0) {
            recovered.unshift(historyTruncationFrame(
              tab.tabId,
              tail.omittedLines,
              recovered[0]?.t ?? Date.now(),
            ));
          }
          if (recovered.length > 0) {
            flushLiveEvents();
            setEvents((prev) => appendBoundedRendererEvents(prev, recovered));
            console.info(`[shellX] rehydrated ${recovered.length} bounded events from ${tab.sessionId}.jsonl into ${tab.tabId.slice(0, 8)}`);
          }
        } catch { /* non-fatal */ }
      }
    })();
    // Mount-only. Tabs gaining a sessionId AFTER mount get their
    // events through the live listener instead.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let disposed = false;
    let unlisten: UnlistenFn | null = null;
    void startReleaseTauriInvokeRelay()
      .then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      })
      .catch(() => {
        // Production instances still register the native listener, but every
        // relay claim fails closed unless the backend is an isolated profile.
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    // Skip listener wiring outside the Tauri webview — `listen()` would
    // throw because the IPC bridge isn't on `window.__TAURI_INTERNALS__`.
    // In plain browser preview (Vite/Playwright) the app still renders;
    // only the event-driven parts (live grok messages) stay dark.
    const inTauri = typeof (window as any).__TAURI_INTERNALS__ !== "undefined";
    if (!inTauri) {
      return;
    }

    const unlisteners: Array<Promise<UnlistenFn>> = TAURI_CHANNELS.map((ch) =>
      listen<unknown>(ch, (event) => {
        const currentActiveTab = activeTabIdRef.current;
        const ev = withRendererEventTabId({
          t: Date.now(),
          kind: ch,
          payload: event.payload,
        }, currentActiveTab);
        enqueueLiveEvent(ev);
        // Read activeTabId via a ref so this mount-only callback never closes
        // over stale tab state. Persistence is queued by the renderer batch.
        const sid = extractSessionId(event.payload);
        if (sid) {
          // Route the (tabId, sessionId) binding into tabSessionByTab
          // so persist() can find the right jsonl path. _meta.tabId is
          // authoritative; untagged events fall back to active tab.
          const tag = (ev as any)?.payload?._meta?.tabId
            ?? (ev as any)?.payload?.params?._meta?.tabId
            ?? currentActiveTab
            ?? null;
          if (tag && !isTaskRuntimeTabId(tag)) {
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
                flushLiveEvents();
                void persistFrames([metaLine]).catch(() => { /* best-effort metadata only */ });
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
    // One state commit can now contain up to 128 coalesced native frames.
    // Scan twice that bound and process every unseen completion in source
    // order so two tabs finishing in the same batch cannot hide each other.
    const tail = events.slice(-256);
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
    for (let i = 0; i < tail.length; i++) {
      const e = tail[i];
      if (!e) continue;
      const payload = e.payload as any;
      if (e.kind === "provider-session-event") {
        const kind = payload?.kind;
        if (kind === "completed" || kind === "failed" || kind === "aborted") {
          const tagged = payload?.tabId ?? activeTabId;
          const completionKey = [
            e.kind,
            tagged ?? "",
            payload?.runId ?? "",
            kind,
            e.t,
          ].join(":");
          if (!rememberPromptCompletion(completionKey)) continue;
          updateTabById(tagged, { isSending: false });
          if (kind === "completed") maybeFireTTS(tagged);
          continue;
        }
      }
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
        continue;
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
    loadSessionId?: string | null;
  };
  async function connect(target: ConnectTarget = {}): Promise<boolean> {
    const targetTab = target.tabId
      ? tabsRef.current.find((t) => t.tabId === target.tabId) ?? null
      : activeTab;
    const myTabId = target.tabId ?? targetTab?.tabId ?? null;
    const targetAgent = normalizeAgentSelection(targetTab?.agentId);
    if (!targetAgent) {
      const msg = "Choose an agent before connecting.";
      setError(msg);
      pushUiEvent(`✗ ${msg}`);
      return false;
    }
    if (isProviderAgent(targetAgent)) {
      const msg = `${agentDisplayName(targetAgent)} starts when you send a prompt. Connect is for Grok sessions.`;
      setError(msg);
      pushUiEvent(`✗ ${msg}`);
      return false;
    }
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
    const loadSessionId = target.loadSessionId !== undefined
      ? target.loadSessionId
      : loadSessionIdForReconnect({
          status: targetTab?.status,
          sessionId: targetTab?.sessionId ?? null,
        });
    pushUiEvent(loadSessionId ? reconnectContinuityUiText(loadSessionId) : `→ connect ${spawnCwd}`);
    try {
      // Push the active autonomy BEFORE spawning grok.
      // set_permission_mode only applies to the NEXT spawn (acp.rs
      // composes --always-approve at spawn time), so order matters.
      const spawnAutonomy = target.autonomy ?? targetTab?.autonomy ?? autonomy;
      try {
        await invoke("set_permission_mode", { mode: spawnAutonomy, tabId: myTabId });
      } catch { /* non-fatal — native spawn also defaults to Full Auto */ }
      const result = await invoke<string>("start_grok_session", {
        cwd: spawnCwd,
        wslDistro: null,
        wslGrokPath: null,
        mcpServers: null,
        connectionId: target.connectionId !== undefined
          ? target.connectionId
          : targetTab?.connectionId ?? null,
        tabId: myTabId,
        loadSessionId,
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

  async function loadConnectionPreset(connectionId: string | null | undefined): Promise<ConnectionPreset | null> {
    if (!connectionId || !inTauri()) return null;
    try {
      const presets = await invoke<ConnectionPreset[]>("connections_list");
      return presets.find((preset) => preset.id === connectionId) ?? null;
    } catch {
      return null;
    }
  }

  async function resolveProviderExecutionForTab(tab: TabEntry): Promise<{
    transport: ProviderExecutionTransport;
    wslDistro?: string;
    sshHost?: string;
    sshPort?: number;
    sshKeyVaultRef?: string;
    sshRemoteRuntime?: "posix" | "windows" | "windows_wsl";
    sshWslDistro?: string;
    preset: ConnectionPreset | null;
  }> {
    const preset = await loadConnectionPreset(tab.connectionId ?? null);
    if (tab.connectionTransport === "wsl") {
      const distro = preset?.transport.kind === "wsl"
        ? preset.transport.distro?.trim()
        : "";
      if (!distro) {
        throw new Error("This tab is WSL, but no saved WSL distro was found. Open the connection picker, edit this connection, then scan agents.");
      }
      return { transport: "wsl", wslDistro: distro, preset };
    }
    if (!tab.connectionTransport || tab.connectionTransport === "local") {
      return { transport: "local", preset };
    }
    if (tab.connectionTransport === "ssh") {
      const sshHost = preset?.transport.kind === "ssh"
        ? preset.transport.host?.trim()
        : "";
      if (!sshHost) {
        throw new Error("This tab is SSH, but no saved SSH host was found. Open the connection picker, edit this connection, then scan agents.");
      }
      return {
        transport: "ssh",
        sshHost,
        sshPort: preset?.transport.kind === "ssh" ? preset.transport.port : undefined,
        sshKeyVaultRef: preset?.transport.kind === "ssh" ? preset.transport.keyVaultRef : undefined,
        sshRemoteRuntime: preset?.transport.kind === "ssh" ? preset.transport.remoteRuntime ?? "posix" : undefined,
        sshWslDistro: preset?.transport.kind === "ssh" ? preset.transport.wslDistro : undefined,
        preset,
      };
    }
    throw new Error(`${tab.connectionTransport.toUpperCase()} provider execution is not wired yet. Use Local, WSL, or SSH for provider CLI tabs.`);
  }

  async function preflightProviderForTab(
    tab: TabEntry,
    providerId: ProviderId,
  ): Promise<{
    transport: ProviderExecutionTransport;
    wslDistro?: string;
    sshHost?: string;
    sshPort?: number;
    sshKeyVaultRef?: string;
    sshRemoteRuntime?: "posix" | "windows" | "windows_wsl";
    sshWslDistro?: string;
    storedConversationId?: string;
  }> {
    const execution = await resolveProviderExecutionForTab(tab);
    if (execution.transport === "ssh") {
      const state = await getProviderAdapterState({
        transport: execution.transport,
        sshHost: execution.sshHost,
        sshPort: execution.sshPort,
        sshKeyVaultRef: execution.sshKeyVaultRef,
        sshRemoteRuntime: execution.sshRemoteRuntime,
        sshWslDistro: execution.sshWslDistro,
      });
      const adapter = state.providers.find((provider) => provider.providerId === providerId);
      if (!adapter?.canRun) {
        const lastSeen = execution.preset?.providerScan?.find((provider) => provider.providerId === providerId);
        const lastSeenText = lastSeen
          ? ` Last saved scan found ${lastSeen.version ?? lastSeen.binary ?? "an entry"}${lastSeen.canRun ? " as runnable" : " but not runnable"}.`
          : "";
        const targetLabel = providerExecutionTargetLabel({
          transport: execution.transport,
          sshHost: execution.sshHost,
          sshRemoteRuntime: execution.sshRemoteRuntime,
          sshWslDistro: execution.sshWslDistro,
        });
        throw new Error(
          `${agentDisplayName(providerId)} is not available in ${targetLabel}.${lastSeenText} Rescan the connection or use Set up CLIs for that exact environment. Native Windows and Windows + WSL have separate CLI installations and path frames.`,
        );
      }
      const sessionState = await getProviderSessionState(tab.tabId, {
        transport: execution.transport,
        sshHost: execution.sshHost,
        sshPort: execution.sshPort,
        sshKeyVaultRef: execution.sshKeyVaultRef,
        sshRemoteRuntime: execution.sshRemoteRuntime,
        sshWslDistro: execution.sshWslDistro,
      });
      return {
        transport: execution.transport,
        sshHost: execution.sshHost,
        sshPort: execution.sshPort,
        sshKeyVaultRef: execution.sshKeyVaultRef,
        sshRemoteRuntime: execution.sshRemoteRuntime,
        sshWslDistro: execution.sshWslDistro,
        storedConversationId: sessionState.storedConversations?.[providerId],
      };
    }
    const state = await getProviderAdapterState({
      transport: execution.transport,
      wslDistro: execution.wslDistro,
    });
    const adapter = state.providers.find((provider) => provider.providerId === providerId);
    if (!adapter?.canRun) {
      const lastSeen = execution.preset?.providerScan?.find((provider) => provider.providerId === providerId && provider.canRun);
      const lastSeenText = lastSeen
        ? ` It was last seen as ${lastSeen.version ?? lastSeen.binary ?? "installed"} on ${new Date(lastSeen.checkedAtMs).toLocaleString()}.`
        : "";
      throw new Error(
        `${agentDisplayName(providerId)} is not available in ${execution.transport === "wsl" ? `WSL ${execution.wslDistro}` : "Local"}.${lastSeenText} Rescan the connection or fix the CLI path/PATH in that environment.`,
      );
    }
    const sessionState = await getProviderSessionState(tab.tabId, {
      transport: execution.transport,
      wslDistro: execution.wslDistro,
    });
    return {
      transport: execution.transport,
      wslDistro: execution.wslDistro,
      storedConversationId: sessionState.storedConversations?.[providerId],
    };
  }

  async function sendProviderPromptForTab(
    tab: TabEntry,
    providerId: ProviderId,
    text: string,
    visibleText: string = text,
    attachments: Array<{ path: string; label: string; kind: ComposerAttachmentKind }> = [],
  ): Promise<boolean> {
    const tabId = tab.tabId;
    if (!text.trim()) return false;
    const { prompt: effectivePrompt, voiceReplyExpected } =
      buildVoiceAwarePrompt(text, tabId);
    if (voiceReplyExpected) {
      voicePendingTurnRef.current.set(tabId ?? "__default__", {
        startIndex: eventsLenRef.current,
        turnKey: `${tabId ?? ""}::voice::${Date.now()}`,
      });
    }
    updateTabById(tabId, { isSending: true, sessionLockPending: true });
    pushPromptEcho(visibleText, tabId, voiceReplyExpected, attachments);
    try {
      const providerExecution = await preflightProviderForTab(tab, providerId);
      const providerTarget = providerExecution.transport === "wsl"
        ? `WSL ${providerExecution.wslDistro}`
        : providerExecution.transport === "ssh"
          ? `SSH ${providerExecution.sshHost}${providerExecution.sshPort ? `:${providerExecution.sshPort}` : ""}`
          : "Local";
      const providerTargetKey = `${providerId}:${providerTarget}`;
      if (!tab.firstMessageMs || tab.lastProviderTargetKey !== providerTargetKey) {
        pushUiEventForTab(`→ ${agentDisplayName(providerId)} on ${providerTarget}`, tabId);
      }
      const shellxToolExposure = shellxToolExposureForProviderStart(tab.shellxToolExposure);
      const started = await startProviderSession({
        tabId,
        providerId,
        cwd: tab.cwd ?? cwd,
        prompt: effectivePrompt,
        timeoutMs: 3_600_000,
        persistSession: true,
        resume: Boolean(providerExecution.storedConversationId),
        providerConversationId: providerExecution.storedConversationId,
        permissionMode: providerPermissionModeForAutonomy(tab.autonomy),
        ...shellxToolExposure,
        transport: providerExecution.transport,
        wslDistro: providerExecution.wslDistro,
        sshHost: providerExecution.sshHost,
        sshPort: providerExecution.sshPort,
        sshKeyVaultRef: providerExecution.sshKeyVaultRef,
        sshRemoteRuntime: providerExecution.sshRemoteRuntime,
        sshWslDistro: providerExecution.sshWslDistro,
      });
      const startedPatch: Partial<TabEntry> = {
        sessionLockPending: false,
        lastProviderTargetKey: providerTargetKey,
      };
      if (started.run.cwd && started.run.cwd.trim()) {
        startedPatch.cwd = started.run.cwd;
        startedPatch.connectionTransport = started.run.transport;
      }
      if (!tab.firstMessageMs) {
        startedPatch.firstMessageMs = Date.now();
      }
      updateTabById(tabId, startedPatch);
      return true;
    } catch (err: any) {
      voicePendingTurnRef.current.delete(tabId ?? "__default__");
      setError(String(err));
      pushUiEventForTab(`✗ ${err}`, tabId);
      updateTabById(tabId, { isSending: false, sessionLockPending: false });
      return false;
    }
  }

  async function send(): Promise<void> {
    // Bind the text to the same tab whose provider, cwd, and attachments are
    // about to be used. A tab switch can no longer lend another tab's draft
    // to this send path.
    const composerTabId = activeTab?.tabId ?? null;
    const currentPrompt = composerDraftForTab(promptByTabRef.current, composerTabId);
    const queuedAttachmentChips = pendingAttachmentChips;
    if (!currentPrompt.trim() && queuedAttachmentChips.length === 0) return;
    const submission = classifyComposerSubmission({
      isSending,
      selectedAgent: normalizeAgentSelection(activeTab?.agentId),
      status,
      text: currentPrompt,
      attachmentCount: queuedAttachmentChips.length,
    });
    if (submission.mode === "blocked") {
      setError(submission.message);
      return;
    }
    if (submission.mode === "interject") {
      const tabId = activeTab?.tabId ?? null;
      setError(null);
      try {
        await invoke<string>("interject_prompt", { text: currentPrompt, tabId });
        pushPromptEcho(currentPrompt, tabId, false);
        pushUiEventForTab("◎ steering queued", tabId);
        setPrompt("");
      } catch (err: any) {
        setError(String(err));
        pushUiEventForTab(`✗ steering failed: ${err}`, tabId);
      }
      return;
    }
    // `/pr` slash opens the PR-create modal instead of sending to
    // grok. Whole-word `/pr` at the start only.
    const stripped = currentPrompt.trim();
    if (stripped === "/pr" || stripped.startsWith("/pr ")) {
      setPrModalOpen(true);
      setPrompt("");
      return;
    }
    if (stripped === "/commands") {
      setPaletteOpen(true);
      pushUiEvent("◎ command search opened");
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
            if (activeBuild.status === "active") {
              await invoke("pause_build", { tabId: myTabId });
              pushUiEvent("◎ build paused");
            } else {
              pushUiEvent(`✗ ${buildActionFailureMessage("pause")}`);
            }
          } else if (stripped === "/resume") {
            const needsBuildReconnect = activeTab?.status !== "Connected";
            if (activeBuild.status === "paused" || activeBuild.status === "transportFailed" || (activeBuild.status === "active" && needsBuildReconnect)) {
              if (needsBuildReconnect) {
                pushUiEvent("→ reconnect build session");
                const connected = await connect({ tabId: myTabId, cwd: activeBuild.cwd });
                if (!connected) {
                  setError("Auto-connect failed");
                  return;
                }
              }
              await invoke("resume_build", { tabId: myTabId });
              pushUiEvent("◎ build resumed");
            } else {
              pushUiEvent(`✗ ${buildActionFailureMessage("resume")}`);
            }
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
        pushUiEvent(usedLegacyGoalCommand
          ? "✗ /goal requires an objective: /goal <what to accomplish> (legacy alias of /build)"
          : "✗ /build requires an objective: /build <what to accomplish>");
        return;
      }
      const myTabId = activeTab?.tabId ?? null;
      if (!myTabId) {
        pushUiEvent("✗ /build needs an active tab — connect first");
        return;
      }
      const selectedAgentForBuild = normalizeAgentSelection(activeTab?.agentId);
      if (selectedAgentForBuild !== "grok") {
        const msg = selectedAgentForBuild
          ? `/build is currently available for Grok sessions. Selected agent: ${agentDisplayName(selectedAgentForBuild)}.`
          : "Choose Grok before starting /build.";
        setError(msg);
        pushUiEvent(`✗ ${msg}`);
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
    const attachmentTags = queuedAttachmentChips
      .map(attachmentWireTag)
      .join(" ");
    const visiblePrompt = currentPrompt.trim().length > 0
      ? currentPrompt
      : "Attached file(s)";
    let txt = [currentPrompt.trim().length > 0 ? currentPrompt : "Please inspect the attached file(s).", attachmentTags]
      .filter((part) => part.trim().length > 0)
      .join("\n\n");
    const echoedAttachments = queuedAttachmentChips.map((attachment) => ({
      path: attachment.path,
      label: attachment.label,
      kind: attachment.kind,
    }));
    if (myTabId) {
      const activeBuild = await getBuildState(myTabId).catch(() => null);
      if (shouldQueuePromptAsBuildOperatorNote(activeBuild)) {
        try {
          await addBuildOperatorNote(myTabId, txt);
          pushOperatorNoteEcho(visiblePrompt, myTabId, echoedAttachments);
          pushUiEvent("◎ operator note queued for next build continuation");
          setRightRailRequest({ tab: "Plan", seq: Date.now() });
          setPrompt("");
          clearPendingAttachmentsForTab(myTabId);
        } catch (err: any) {
          setError(`operator note failed: ${err}`);
          pushUiEvent(`✗ operator note failed: ${err}`);
        }
        return;
      }
    }
    const selectedAgent = normalizeAgentSelection(activeTab?.agentId);
    if (!selectedAgent) {
      const msg = "Choose an agent before sending.";
      setError(msg);
      pushUiEvent(`✗ ${msg}`);
      return;
    }
    if (debugProviderAction?.action === "composer-send") {
      setPrompt("");
      clearPendingAttachmentsForTab(myTabId);
      await sendPromptText(txt, myTabId, visiblePrompt);
      return;
    }
    if (activeTab && myTabId && isProviderAgent(selectedAgent)) {
      const providerTextContext = pendingAttachments.length > 0
        ? pendingAttachments
            .map((attachment) => [
              `Attached text file: ${attachment.path}`,
              `MIME: ${attachment.mimeType}`,
              attachment.content,
            ].join("\n"))
            .join("\n\n---\n\n")
        : "";
      const providerPrompt = providerTextContext
        ? `${txt}\n\nAttached text context:\n\n${providerTextContext}`
        : txt;
      setPrompt("");
      clearPendingAttachmentsForTab(myTabId);
      await sendProviderPromptForTab(
        activeTab,
        selectedAgent,
        providerPrompt,
        visiblePrompt,
        echoedAttachments,
      );
      return;
    }
    // Auto-connect-then-send: if the tab has no live grok session
    // (just reopened a past chat, or never connected), spawn one
    // first so the user's prompt isn't lost on a fresh empty session.
    let reconnectSessionId: string | null = null;
    if (activeTab && activeTab.status !== "Connected") {
      const loadSessionId = loadSessionIdForReconnect({
        status: activeTab.status,
        sessionId: activeTab.sessionId,
      });
      reconnectSessionId = loadSessionId;
      if (!loadSessionId) pushUiEvent(`→ auto-connect (new session)`);
      const connected = await connect();
      if (!connected) {
        setError("Auto-connect failed");
        return;
      }
      // The local `activeTab` capture doesn't observe the post-connect
      // status update from setTabs; we fall through and trust the Rust
      // side. The catch below surfaces failure.
    }
    if (reconnectSessionId) {
      txt = await buildReconnectPromptWithSessionTail(
        txt,
        reconnectSessionId,
        activeTab?.cwd ?? cwd,
      );
    }
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
    pushPromptEcho(visiblePrompt, myTabId, voiceReplyExpected, echoedAttachments);
    // Stamp first-message timestamp so the composer's connection pill
    // locks on the next render. updateActiveTab is patch-style so this
    // is a no-op on subsequent sends.
    if (activeTab && !activeTab.firstMessageMs) {
      updateActiveTab({ firstMessageMs: Date.now() });
    }
    setPrompt("");
    clearPendingAttachmentsForTab(myTabId);
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

  /* Send a specific text to a specific tab WITHOUT mutating that tab's
   * user-authored composer draft. Callers capture tabId at click time so a mid-flight
   * tab switch lands the prompt on the originating tab. Slash-command
   * interception is skipped — this path is for structured prompts. */
  async function sendPromptText(
    text: string,
    tabId: string | null,
    visibleText: string = text,
  ): Promise<boolean> {
    if (!text.trim()) return false;
    if (debugProviderAction) {
      if (!providerActionPromptMatches(debugProviderAction.action, text)) {
        const msg = `Release provider fixture rejected a prompt for ${debugProviderAction.action}.`;
        setError(msg);
        pushUiEventForTab(`✗ ${msg}`, tabId);
        return false;
      }
      setError(null);
      try {
        const receipt = await dispatchDebugProviderAction(debugProviderAction, text);
        setDebugProviderActionReceipt(receipt);
        pushUiEventForTab(`◎ release provider action ${receipt.action} completed`, tabId);
        return true;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
        pushUiEventForTab(`✗ ${msg}`, tabId);
        return false;
      }
    }
    const targetTab = tabId
      ? tabsRef.current.find((t) => t.tabId === tabId) ?? null
      : activeTab;
    const selectedAgent = normalizeAgentSelection(targetTab?.agentId);
    if (!selectedAgent) {
      const msg = "Choose an agent before sending.";
      setError(msg);
      pushUiEventForTab(`✗ ${msg}`, tabId ?? targetTab?.tabId ?? null);
      return false;
    }
    if (targetTab && isProviderAgent(selectedAgent)) {
      return await sendProviderPromptForTab(targetTab, selectedAgent, text, visibleText);
    }
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
    pushPromptEcho(visibleText, tabId, voiceReplyExpected);
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
      return true;
    } catch (err: any) {
      voicePendingTurnRef.current.delete(tabId ?? "__default__");
      setError(String(err));
      pushLocalEvent({
        t: Date.now(), kind: "ui",
        payload: tabId ? { _meta: { tabId }, text: `✗ ${err}` } : `✗ ${err}`,
      });
      updateTabById(tabId, { isSending: false });
      return false;
    }
  }

  useBrowserCoworkPromptBridge((request) => (
    sendPromptText(request.prompt, request.targetTabId, request.visiblePrompt)
  ));

  async function buildReconnectPromptWithSessionTail(
    userPrompt: string,
    priorSessionId: string,
    reconnectCwd: string | null | undefined,
  ): Promise<string> {
    let resumeTranscript: SessionResumeTranscript | null = null;
    try {
      const tail = await invoke<SessionJsonlTailResponse>("read_session_jsonl_tail", {
        sessionId: priorSessionId,
        limit: RECONNECT_SESSION_LOG_TAIL_LINES,
      });
      resumeTranscript = buildSessionResumeTranscript(tail.lines, {
        omittedRawLines: tail.omittedLines,
      });
    } catch {
      // The prompt still carries the previous session id and log hint.
    }
    return buildReconnectContinuityPrompt(userPrompt, {
      priorSessionId,
      cwd: reconnectCwd ?? cwd,
      sessionLogPath: `~/.shellx/sessions/${priorSessionId}.jsonl`,
      resumeTranscript,
    });
  }

  async function abort(): Promise<void> {
    const myTabId = activeTab?.tabId ?? null;
    const targetTab = myTabId
      ? tabsRef.current.find((t) => t.tabId === myTabId) ?? activeTab
      : activeTab;
    const selectedAgent = normalizeAgentSelection(targetTab?.agentId);
    updateTabById(myTabId, { status: "Aborting" });
    try {
      if (targetTab && selectedAgent && isProviderAgent(selectedAgent)) {
        let target: {
          transport?: ProviderExecutionTransport;
          wslDistro?: string;
          sshHost?: string;
          sshPort?: number;
        } = {};
        try {
          const execution = await resolveProviderExecutionForTab(targetTab);
          target = {
            transport: execution.transport,
            wslDistro: execution.wslDistro,
            sshHost: execution.sshHost,
            sshPort: execution.sshPort,
          };
        } catch {
          // Fall back to tab-only abort; the registry can still find the
          // active run for normal one-provider tabs.
        }
        const result = await abortProviderSession(myTabId ?? targetTab.tabId, undefined, target);
        pushUiEventForTab(result.aborted ? "⏹ provider abort sent" : "· no active provider run to abort", myTabId);
      } else {
        await invoke<string>("abort_session", { tabId: myTabId });
        pushUiEvent("⏹ abort sent");
      }
    } catch (err: any) {
      setError(String(err));
    } finally {
      updateTabById(myTabId, { status: "Idle", isSending: false });
    }
  }

  function pushLocalEvent(ev: RawEventFrame): void {
    flushLiveEvents();
    setEvents((prev) => appendBoundedRendererEvents(prev, ev));
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

  function pushUiEventForTab(text: string, tabId: string | null): void {
    pushLocalEvent({
      t: Date.now(),
      kind: "ui",
      payload: tabId
        ? { _meta: { tabId }, text }
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

  function pushOperatorNoteEcho(
    text: string,
    tabId: string | null,
    attachments: Array<{ path: string; label: string; kind: ComposerAttachmentKind }> = [],
  ): void {
    pushLocalEvent({
      t: Date.now(),
      kind: "ui",
      payload: tabId
        ? { _meta: { tabId, operatorNote: true }, text: `→ operator note: ${text}`, attachments }
        : { _meta: { operatorNote: true }, text: `→ operator note: ${text}`, attachments },
    });
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
      selected = await openShellxDialog({ multiple: true, defaultPath: cwd });
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
    const targetTabId = activeTab?.tabId ?? activeTabId ?? null;
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
      updatePendingAttachmentsForTab(targetTabId, (current) => ({
        ...current,
        text: appendUniqueTextAttachments(current.text, newTextAttachments),
      }));
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
    updatePendingAttachmentsForTab(targetTabId, (current) => {
      const seen = new Set(current.chips.map((chip) => chip.path));
      const unique = chips.filter((chip) => {
        if (seen.has(chip.path)) return false;
        seen.add(chip.path);
        return true;
      });
      return unique.length > 0 ? { ...current, chips: [...current.chips, ...unique] } : current;
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
    updatePendingAttachmentsForTab(activeTabId, (current) => ({
      text: current.text.filter((item) => item.path !== attachment.path),
      chips: current.chips.filter((chip) => chip.id !== id),
    }));
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

  const openPreviewFileWithContext = (
    path: string,
    context: { tabId?: string | null; sessionCwd?: string | null } = {},
  ): void => {
    // Route chat/file links into Preview Center. Plain documents stay in
    // read-only file preview; standalone HTML launches Work Preview so
    // generated pages run with scripts instead of the safe source viewer.
    if (typeof path !== "string" || path.length === 0) return;
    const contextTab = context.tabId
      ? tabs.find((t) => t.tabId === context.tabId) ?? null
      : null;
    const active = contextTab ?? tabs.find((t) => t.tabId === activeTabId) ?? null;
    const contextCwd = context.sessionCwd?.trim();
    const tabCwd = contextCwd && contextCwd.length > 0 ? contextCwd : active?.cwd?.trim() ?? "";
    const previewTabId = context.tabId ?? active?.tabId ?? activeTabId ?? "default";
    const previewInput = resolveSessionMarkdownArtifactPath(path, {
      cwd: tabCwd,
      sessionId: active?.sessionId ?? null,
    }) ?? resolveShellxPreviewScreenshotPath(path, {
      cwd: tabCwd,
      tabId: active?.tabId ?? activeTabId,
    }) ?? path;
    const route = resolvePreviewRoute({
      path: previewInput,
      cwd: tabCwd,
      canRunWorkPreview: inTauri(),
    });
    if (!route.ok) {
      pushUiEvent(`✗ ${route.reason}`);
      return;
    }
    const abs = route.path;
    setPreviewPath(abs);
    setPreviewFileContext({ tabId: previewTabId, sessionCwd: tabCwd });
    if (route.view === "work" && route.workRoot && route.workEntry) {
      const tabId = previewTabId;
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
      updateTabById(previewTabId, { preview: { kind: "url", path: abs } });
      const previewDebugTarget = {
        kind: "url",
        path: abs,
        tabId: previewTabId,
        sessionCwd: tabCwd,
      };
      void apiPost("/preview", previewDebugTarget).catch(() => { /* debug api may be off */ });
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
    updateTabById(previewTabId, { preview: { kind: "file", path: abs } });
    const previewDebugTarget = {
      kind: "file",
      path: abs,
      tabId: previewTabId,
      sessionCwd: tabCwd,
    };
    void apiPost("/preview", previewDebugTarget).catch(() => { /* debug api may be off */ });
  };

  handlePreviewFileImpl.current = (path: string): void => {
    openPreviewFileWithContext(path);
  };

  function handlePreviewAsset(asset: SessionAssetItem): void {
    openPreviewFileWithContext(asset.path, {
      tabId: asset.sourceTabId,
      sessionCwd: asset.sourceCwd,
    });
  }

  async function importAssetToActiveScope(asset: SessionAssetItem): Promise<string | null> {
    if (!inTauri()) {
      pushUiEvent("✗ asset import requires the shellX desktop app");
      return null;
    }
    const targetTab = tabs.find((t) => t.tabId === activeTabId) ?? activeTab;
    const destDir = (targetTab?.cwd ?? cwd).trim().replace(/[/\\]+$/, "");
    if (!destDir) {
      pushUiEvent("✗ asset import needs an active folder");
      return null;
    }
    try {
      const imported = await invoke<string>("copy_asset_to_scope", {
        src: asset.path,
        destDir,
        sourceTabId: asset.sourceTabId,
        targetTabId: targetTab?.tabId ?? activeTabId ?? null,
        sourceSessionCwd: asset.sourceCwd ?? null,
        targetSessionCwd: targetTab?.cwd ?? cwd,
      });
      pushUiEvent(`→ imported asset ${asset.title} → ${imported}`);
      return imported;
    } catch (err) {
      pushUiEvent(`✗ asset import failed for ${asset.title}: ${err}`);
      return null;
    }
  }

  async function handleAttachAsset(asset: SessionAssetItem): Promise<void> {
    const imported = await importAssetToActiveScope(asset);
    if (!imported) return;
    await processAttachedPaths([imported], { copyIntoScope: false });
    setBottomTab("Chat");
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
          ? "◎ Preview Doctor report sent to the active agent"
          : `◎ Preview Doctor found ${diagnostic.issues.length} issue(s); report sent to the active agent`,
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

  function handleOpenShellxBrowser(): void {
    if (!inTauri()) {
      pushUiEvent("✗ ShellX Browser requires the desktop app");
      return;
    }
    void invoke("shellx_browser_open_window", { startUrl: null }).catch((err) => {
      pushUiEvent(`✗ ShellX Browser open failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  /** ⌘T: open a new idle tab. */
  function handleNewTab(): void {
    const t = newTabEntry(cwd, autonomy);
    setTabs((prev) => {
      // Soft-warn at 10/20/50 tabs: active agent subprocesses can be heavy.
      // No hard cap.
      const newCount = prev.length + 1;
      if (newCount === 10 || newCount === 20 || newCount === 50) {
        pushUiEvent(
          `! ${newCount} tabs open - each active agent session can use substantial RAM. ` +
          `Consider closing tabs you're done with.`,
        );
      }
      return [...prev, t];
    });
    setActiveTabId(t.tabId);
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
      const tail = await invoke<SessionJsonlTailResponse>("read_session_jsonl_tail", {
        sessionId: id,
        limit: MAX_SESSION_LOG_REHYDRATION_LINES,
      });
      const recovered: RawEventFrame[] = [];
      for (const line of tail.lines) {
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
      if (tail.omittedLines > 0) {
        recovered.unshift(historyTruncationFrame(
          t.tabId,
          tail.omittedLines,
          recovered[0]?.t ?? Date.now(),
        ));
      }
      if (recovered.length > 0) {
        flushLiveEvents();
        setEvents((prev) => appendBoundedRendererEvents(prev, recovered));
        const inferredAgent = latestAgentFromEventFrames(recovered);
        if (inferredAgent) {
          updateTabById(t.tabId, { agentId: inferredAgent });
        }
      }
    } catch { /* non-fatal */ }
  }

  /** ⌘W: close the active tab. */
  function handleCloseTab(idToClose?: string): void {
    const tid = idToClose ?? activeTabId;
    if (!tid) return;
    const closingTab = tabs.find((t) => t.tabId === tid);
    const closingSessionId = closingTab?.sessionId ?? null;
    const titleOverride = closingTab
      // Closing is the last cheap chance to write the JSONL
      // title-override. Retry even when the localStorage override is
      // already present because the earlier live rename may have run
      // before the session file existed.
      ? titleOverrideForClosingTab(closingTab, {})
      : null;
    if (titleOverride) {
      persistSessionTitleOverride(titleOverride.sessionId, titleOverride.title);
    }
    tabSessionByTab.current.delete(tid);
    if (closingSessionId) rehydratedSessionIds.current.delete(closingSessionId);
    clearPendingAttachmentsForTab(tid);
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
      const pristineNewTab = closing
        && closing.sessionId == null
        && !closing.firstMessageMs
        && (!closing.title || closing.title === "new session");
      if (closing && !pristineNewTab && (closing.title || closing.sessionId)) {
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

  function handleThemeToggle(): void {
    handleSettingsChange({
      ...settings,
      theme: settings.theme === "bright" ? "black" : "bright",
    });
  }

  function closeAllModals(closeBuildReview = true): void {
    // The useKeyboardShortcuts hook listens in capture phase, so the
    // central registry's Esc handler runs before local bubble listeners.
    // It deliberately does not stop propagation. Every modal's open flag
    // must reset here or the modal stays open after the shared handler.
    setHelpOpen(false);
    setPaletteOpen(false);
    setSettingsOpen(false);
    setPluginsOpen(false);
    setConnectorInboxOpen(false);
    setPrModalOpen(false);
    setVaultOpen(false);
    setAssetBoardOpen(false);
    setPreviewCenterOpen(false);
    setActivityOpen(false);
    setRemoteFolderPicker(null);
    setBuiltinDocId(null);
    setAgentCliSetupFixtureMode("closed");
    setGoalPlanReviewFixtureMode("closed");
    if (closeBuildReview) {
      setBuildReviewCloseSeq((seq) => seq + 1);
    }
  }

  function openDebugModal(id: DebugModalId): void {
    closeAllModals(id !== "buildPlanReview");
    if (id === "close") return;
    if (id === "activity") {
      setActivityOpen(true);
      return;
    }
    if (id === "assets") {
      setAssetBoardOpen(true);
      return;
    }
    if (id === "buildPlanReview") {
      setBuildReviewRequestSeq((seq) => seq + 1);
      return;
    }
    if (id === "connectorInbox") {
      setConnectorInboxOpen(true);
      return;
    }
    if (id === "help") {
      setHelpOpen(true);
      return;
    }
    if (id === "palette") {
      setPaletteOpen(true);
      return;
    }
    if (id === "plugins") {
      setPluginsOpen(true);
      return;
    }
    if (id === "preview" || id === "workPreview") {
      setPreviewCenterView(id === "workPreview" ? "work" : "file");
      setPreviewCenterOpen(true);
      return;
    }
    if (id === "pr") {
      setPrModalOpen(true);
      return;
    }
    if (id === "settings") {
      setSettingsOpen(true);
      return;
    }
    if (id === "vault") {
      openVaultPanel("overview");
    }
  }

  type DebugClickTarget = { selector: string; index: number; text: string | null };

  function normalizeDebugClickTarget(payload: unknown): DebugClickTarget | null {
    let selector: string | null = null;
    let index = 0;
    let text: string | null = null;
    if (typeof payload === "string") {
      selector = payload;
    } else if (payload && typeof payload === "object") {
      const body = payload as Record<string, unknown>;
      if (typeof body.selector === "string") selector = body.selector;
      if (typeof body.index === "number" && Number.isFinite(body.index)) {
        index = Math.max(0, Math.floor(body.index));
      }
      if (typeof body.text === "string" && body.text.length > 0) text = body.text;
    }
    return selector ? { selector, index, text } : null;
  }

  function findDebugClickElement(target: DebugClickTarget): HTMLElement | null {
    const candidates = Array.from(document.querySelectorAll(target.selector))
      .filter((node): node is HTMLElement => node instanceof HTMLElement);
    return target.text
      ? candidates.find((node) => node.textContent?.includes(target.text ?? "")) ?? null
      : candidates[target.index] ?? null;
  }

  function dispatchDebugClick(target: HTMLElement): void {
    target.scrollIntoView({ block: "center", inline: "center" });
    if (
      target instanceof HTMLButtonElement ||
      target instanceof HTMLAnchorElement ||
      target instanceof HTMLInputElement ||
      target instanceof HTMLSelectElement ||
      target instanceof HTMLTextAreaElement
    ) {
      target.click();
      return;
    }
    target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
    target.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
    target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
  }

  function reportDebugActionResult(result: Record<string, unknown>): void {
    void apiPost("/state/ui", {
      debugSurface: "app",
      debugActionResults: [result],
      source: "renderer-debug-action",
    }).catch(() => {
      /* debug action receipts are best-effort diagnostics only */
    });
  }

  function attemptDebugClickSelector(target: DebugClickTarget, deadlineMs: number): void {
    window.requestAnimationFrame(() => {
      const element = findDebugClickElement(target);
      if (element) {
        const rect = element.getBoundingClientRect();
        reportDebugActionResult({
          action: "debugClick",
          selector: target.selector,
          status: "clicked",
          tagName: element.tagName,
          text: (element.textContent ?? "").trim().slice(0, 120),
          rect: {
            left: Math.round(rect.left * 10) / 10,
            top: Math.round(rect.top * 10) / 10,
            width: Math.round(rect.width * 10) / 10,
            height: Math.round(rect.height * 10) / 10,
          },
        });
        dispatchDebugClick(element);
        return;
      }
      if (Date.now() < deadlineMs) {
        window.setTimeout(() => attemptDebugClickSelector(target, deadlineMs), 50);
        return;
      }
      reportDebugActionResult({
        action: "debugClick",
        selector: target.selector,
        status: "missing",
      });
    });
  }

  function runDebugClickSelector(payload: unknown): void {
    const target = normalizeDebugClickTarget(payload);
    if (!target) return;
    attemptDebugClickSelector(target, Date.now() + 2_000);
  }

  function runDebugDragSelector(payload: unknown): void {
    if (!payload || typeof payload !== "object") return;
    const body = payload as Record<string, unknown>;
    const selector = typeof body.selector === "string" ? body.selector : null;
    if (!selector) return;
    const index = typeof body.index === "number" && Number.isFinite(body.index)
      ? Math.max(0, Math.floor(body.index))
      : 0;
    const matchText = typeof body.text === "string" && body.text.length > 0 ? body.text : null;
    const dx = typeof body.dx === "number" && Number.isFinite(body.dx) ? body.dx : 0;
    const dy = typeof body.dy === "number" && Number.isFinite(body.dy) ? body.dy : 0;
    const steps = typeof body.steps === "number" && Number.isFinite(body.steps)
      ? clampNumber(Math.floor(body.steps), 1, 20)
      : 6;
    window.requestAnimationFrame(() => {
      const candidates = Array.from(document.querySelectorAll(selector))
        .filter((node): node is HTMLElement => node instanceof HTMLElement);
      const target = matchText
        ? candidates.find((node) => node.textContent?.includes(matchText))
        : candidates[index];
      if (!target) return;
      target.scrollIntoView({ block: "center", inline: "center" });
      const rect = target.getBoundingClientRect();
      const startX = typeof body.startX === "number" && Number.isFinite(body.startX) ? body.startX : rect.left + rect.width / 2;
      const startY = typeof body.startY === "number" && Number.isFinite(body.startY) ? body.startY : rect.top + rect.height / 2;
      const endX = typeof body.endX === "number" && Number.isFinite(body.endX) ? body.endX : startX + dx;
      const endY = typeof body.endY === "number" && Number.isFinite(body.endY) ? body.endY : startY + dy;
      dispatchDebugPointer(target, "pointerdown", startX, startY, true);
      for (let step = 1; step <= steps; step += 1) {
        const t = step / steps;
        dispatchDebugPointer(window, "pointermove", startX + (endX - startX) * t, startY + (endY - startY) * t, true);
      }
      dispatchDebugPointer(window, "pointerup", endX, endY, false);
    });
  }

  function dispatchDebugPointer(target: Window | HTMLElement, type: string, clientX: number, clientY: number, pressed: boolean): void {
    const init = {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX,
      clientY,
      button: 0,
      buttons: pressed ? 1 : 0,
    };
    const event = typeof PointerEvent === "function"
      ? new PointerEvent(type, { ...init, pointerId: 1, pointerType: "mouse", isPrimary: true })
      : new MouseEvent(type, init);
    target.dispatchEvent(event);
  }

  function clampNumber(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
  }

  function runDebugInputSelector(payload: unknown): void {
    if (!payload || typeof payload !== "object") return;
    const body = payload as Record<string, unknown>;
    const selector = typeof body.selector === "string" ? body.selector : null;
    if (!selector) return;
    const index = typeof body.index === "number" && Number.isFinite(body.index)
      ? Math.max(0, Math.floor(body.index))
      : 0;
    const matchText = typeof body.text === "string" && body.text.length > 0 ? body.text : null;
    const value = typeof body.value === "string" ? body.value : "";
    const append = body.append === true;
    const key = typeof body.key === "string" && body.key.length > 0
      ? body.key
      : body.enter === true
        ? "Enter"
        : null;
    window.requestAnimationFrame(() => {
      const candidates = Array.from(document.querySelectorAll(selector))
        .filter((node): node is HTMLElement => node instanceof HTMLElement);
      const target = matchText
        ? candidates.find((node) => node.textContent?.includes(matchText))
        : candidates[index];
      if (!target) return;
      target.scrollIntoView({ block: "center", inline: "center" });
      target.focus();
      const next = append && "value" in target
        ? `${String((target as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement).value ?? "")}${value}`
        : value;
      if (target instanceof HTMLInputElement) {
        setNativeInputValue(target, next);
      } else if (target instanceof HTMLTextAreaElement) {
        setNativeTextAreaValue(target, next);
      } else if (target instanceof HTMLSelectElement) {
        setNativeSelectValue(target, next);
      } else if (target.isContentEditable) {
        target.textContent = next;
        target.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
      }
      target.dispatchEvent(new Event("change", { bubbles: true }));
      if (key) {
        target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
        target.dispatchEvent(new KeyboardEvent("keyup", { key, bubbles: true, cancelable: true }));
      }
    });
  }

  function setNativeInputValue(input: HTMLInputElement, value: string): void {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, value);
    input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
  }

  function setNativeTextAreaValue(textarea: HTMLTextAreaElement, value: string): void {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    setter?.call(textarea, value);
    textarea.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
  }

  function setNativeSelectValue(select: HTMLSelectElement, value: string): void {
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
    setter?.call(select, value);
    select.dispatchEvent(new Event("input", { bubbles: true }));
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
    // j/k/y/n/e are handled inside ChatOutput (per-card focus). Leave
    // them un-mapped here so the registry's skipInInput logic doesn't
    // block focus-aware behavior.
  });

  // ─── Build PaletteAction list ─────────────────────────────────────────
  const paletteActions = useMemo<PaletteAction[]>(() => {
    const acts: PaletteAction[] = [
      { id: "act-connect",  label: "Connect agent session", hint: cwd, group: "Action", run: () => void connect() },
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
            label: "Ask active agent to fix current preview",
            hint: activeWorkPreviewState.url ?? activeWorkPreviewState.error ?? "Preview Doctor",
            group: "Action" as const,
            run: () => void handleAskGrokToFixPreview(activeWorkPreviewState),
          }]
        : []),
      { id: "act-toggle-term", label: "Toggle Chat / Terminal (⌘`)", group: "Action", run: toggleTerminalTab },
      { id: "act-pr", label: "Create pull request (/pr)", group: "Action", run: () => setPrModalOpen(true) },
      { id: "act-vault", label: "Open vault (secrets)", group: "Action", run: () => openVaultPanel("overview") },
      { id: "act-help",     label: "Show keyboard shortcuts (?)", group: "Action", run: () => setHelpOpen(true) },
      // Confirm/plan/accept-edits are not reliable cross-provider user modes.
      // Keep the normal ShellX workflow fixed to Full Auto; legacy/internal
      // values remain accepted at the transport boundary only for migration
      // and release diagnostics.
      { id: "act-auto-auto",    label: "Autonomy: Auto (bypassPermissions)", group: "Action", run: () => void setAutonomyAndPersist("bypassPermissions") },
    ];
    return acts;
  }, [activeWorkPreviewState, cwd, openVaultPanel, pendingAttachmentChips.length, sessionAttachments.length, sessionMedia.images.length, sessionMedia.videos.length, status]);

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

  function handleShellxToolExposureChange(mode: ProviderShellxToolExposure): void {
    updateActiveTab({ shellxToolExposure: normalizeShellxToolExposure(mode) });
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
      vertical: readLocalMigrated(PANEL_SIZE_KEY_V, LEGACY_PANEL_SIZE_KEY_V, [62, 38]),
    }).catch(() => { /* no-op */ });
  };
  const handleVerticalLayout = (sizes: number[]) => {
    try { localStorage.setItem(PANEL_SIZE_KEY_V, JSON.stringify(sizes)); } catch { /* no-op */ }
    void apiPost("/panels", {
      horizontal: readLocalMigrated(PANEL_SIZE_KEY_H, LEGACY_PANEL_SIZE_KEY_H, [18, 56, 26]),
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
      if (e.kind === "provider-session-event") {
        const shape = providerSessionGroupShape(e.payload);
        if (shape?.kind === "message") {
          assistantText.push(shape.text);
        } else if (shape?.kind === "tool") {
          toolCalls.push(`- ${shape.label}${shape.detail ? `: ${shape.detail}` : ""}`);
        }
        continue;
      }
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
      <UpdateBanner debugFixture={debugUpdateFixture} />
      <Header
        onOpenSettings={() => setSettingsOpen(true)}
        theme={settings.theme}
        onThemeToggle={handleThemeToggle}
        onOpenPlugins={() => setPluginsOpen(true)}
        onOpenConnectorInbox={() => setConnectorInboxOpen(true)}
        outsideConnectorInbox={outsideConnectorInboxSummary}
        vaultRequestCenter={vaultRequestCenter}
        vaultRequestCenterOpenSeq={vaultRequestCenterOpenSeq}
        vaultRequestCenterCloseSeq={vaultRequestCenterCloseSeq}
        debugClipboardFixture={debugClipboardFixture === "vault-password" ? "vault-password" : null}
        onOpenVault={openVaultPanel}
        onOpenBrowser={handleOpenShellxBrowser}
        onOpenTasks={() => openTaskManager("edit")}
        taskAttentionCount={taskAttentionCount(taskManagerData.definitions)}
        onOpenAbout={openAboutInSettings}
        /* Live-sessions badge: count of tabs with a live grok
         * subprocess attached. sessionId is durable history; status is
         * reconciled against the current Rust registry on boot. */
        liveTabCount={tabs.filter((t) => t.status === "Connected").length}
        /* "Agents working" pill: count of grok subprocesses +
         * host-MCP subagents in running state. Polled from
         * list_background_tasks every 2 s above. */
        liveGrokCount={liveGrokCount}
        /* Find searches the live session-tab corpus. Each open tab
         * becomes a ChatHit so the header Find popover can surface
         * real work-in-progress. JSONL content search lands
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

      {error && <div className="error-banner" role="alert" aria-live="assertive">{error}</div>}

      <DebugApiConnectionBanner
        status={debugUiConnectionFixture ?? debugUiConnectionStatus}
        onRetry={() => {
          setDebugUiConnectionFixture(null);
          window.dispatchEvent(new Event("shellx:debug-api-retry"));
        }}
      />

      <ClipboardCopiedToast />

      <ShellxSetupGuide
        settings={settings}
        requestCount={vaultRequestItems.length}
        agentsConfigured={activeAgentProviderScan.some((provider) => providerScanStatus(provider) === "ready")}
        onOpenVault={openVaultPanel}
        onOpenBrowser={handleOpenShellxBrowser}
        onOpenRequests={() => setVaultRequestCenterOpenSeq((seq) => seq + 1)}
        onOpenAgentSetup={() => setAgentCliSetupFixtureMode("live-setup")}
        onOpenSettingsTab={openSettingsTab}
      />

      <div className="shell-body">
        <PanelGroup
          direction="horizontal"
          autoSaveId={PANEL_AUTOSAVE_ID_H}
          onLayout={handleHorizontalLayout}
        >
          <Panel defaultSize={18} minSize={12} maxSize={36}>
            {/* LeftRail = Projects + Past chats. Project + chat clicks
                open existing sessions via handleOpenChat. A tab belongs to
                project p when
                t.projectId === p.id OR (for past chats)
                sessionProjects[t.sessionId] === p.id. */}
            <LeftRail
              cwd={activeTab?.cwd ?? cwd}
              activeTabId={activeTabId}
              onPreviewFile={handlePreviewFile}
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
              userDataReady={personalDataReady}
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
                  autoSaveId={PANEL_AUTOSAVE_ID_MID_RIGHT}
                >
                  <Panel defaultSize={68} minSize={30}>
                    <main className="mid">
                      <PanelGroup
                        direction="vertical"
                        /* 0.1.29 — bumped v4 → v5 because the composer is
                         * now a three-row working surface. Give it enough
                         * default space at the app's normal startup size,
                         * not only when the window is maximized on 4K. */
                        autoSaveId={PANEL_AUTOSAVE_ID_V}
                        onLayout={handleVerticalLayout}
                      >
                <Panel defaultSize={62} minSize={30}>
                    <div className="mid-pane-body">
                        <div className="mid-head">
                          <h2 title={sessionTitle}>
                            {titleMain}
                            {titleTrail && <span className="trail">{titleTrail}</span>}
                          </h2>
                          {/* Per-session token gauge. Provider CLIs report
                           * usage without a ShellX-known context window, so
                           * only Grok tabs render the denominator/bar. */}
                          <div
                            className="tok mid-head-tok"
                            title={tokenTitle}
                          >
                            <strong>{formatTokens(totalTokens)}</strong>
                            {activeAgentForTokens === "grok" ? (
                              <>
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
                              </>
                            ) : activeAgentForTokens ? (
                              <span className="tok-provider-label">provider tokens</span>
                            ) : (
                              <span className="tok-provider-label">no agent</span>
                            )}
                          </div>
                          <SessionArtifactDownload
                            activeTabId={activeTabId}
                            cwd={activeTab?.cwd ?? ""}
                            agentId={activeAgentForControls}
                            releaseTestBoundary={releaseTestExternalEffectBoundary === "artifact-archive"}
                          />
                        </div>
                        <ChatOutput
                          groups={groups}
                          onPreviewFile={handlePreviewFile}
                          // Session identity for attachment and media previews.
                          tabId={activeTabId ?? undefined}
                          assistantFallbackLabel={agentDisplayName(activeAgentForChat ?? "grok")}
                          debugPermissionFixture={debugPermissionFixture}
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
                    onCreateTask={createTaskFromComposer}
                    createTaskDisabledReason={taskComposerDisabledReason}
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
                    skills={visibleSlashCommands.map((s): SlashCommandItem => ({
                      name: s.name,
                      description: s.description,
                      input: s.input,
                      _meta: s._meta,
                    }))}
	                    agentId={activeAgentForControls}
	                    onAgentChange={(agentId) => {
	                      if (status === "Connected" || activeTab?.firstMessageMs || activeTab?.sessionLockPending) return;
	                      updateActiveTab({ agentId });
	                    }}
                    agentProviderScan={activeAgentProviderScan}
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
                        const pickerTransport = activeTab?.connectionTransport ?? "local";
                        if (pickerTransport !== "local") {
                          const current = activeTab?.cwd ?? cwd;
                          setRemoteFolderPicker({
                            tabId: activeTabId ?? null,
                            connectionId: activeTab?.connectionId ?? null,
                            initialPath: current || "/",
                            label: activeTab?.connectionLabel ?? pickerTransport.toUpperCase(),
                          });
                          return;
                        }
                        const selected = await openShellxDialog({
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
	                    connectionLocked={Boolean(activeTab?.firstMessageMs || activeTab?.sessionLockPending)}
                    debugOpenMenu={debugComposerMenuRequest?.menu ?? null}
                    debugOpenMenuSeq={debugComposerMenuRequest?.seq}
                    releaseTestVoiceRecording={releaseTestVoiceRecording}
                    scopeConnection={activeTab?.connectionLabel ?? "Local"}
                    scopeConnectionId={activeTab?.connectionId ?? null}
                    scopeConnectionTransport={activeTab?.connectionTransport ?? "local"}
                    scopeBranch={activeTab?.branchName ?? "—"}
                    scopeBranchAhead={activeTab?.branchAhead}
	                    onSelectConnection={(preset) => {
	                      if (activeTab?.firstMessageMs || activeTab?.sessionLockPending) return;
	                      const t = preset.transport.kind;
                      const nextTransport = t === "ws_tunnel" ? "cloud" : t;
                      const currentAgent = normalizeAgentSelection(activeTab?.agentId);
                      setActiveConnectionPreset(preset);
                      setActiveProviderScanOverride(null);
                      const nextPatch: Partial<TabEntry> = {
                        connectionId: preset.id,
                        connectionLabel: preset.label,
                        connectionTransport: nextTransport,
                      };
                      if (!activeTab?.firstMessageMs) {
                        nextPatch.cwd = cwdForConnectionPreset(preset, activeTab?.cwd ?? cwd);
                        nextPatch.agentId = agentForConnectionPreset(preset, currentAgent);
                      }
                      updateActiveTab({
                        ...nextPatch,
                      });
                      scanConnectionProvidersForPreset(preset);
                    }}
                    onSelectBranch={(name) => updateActiveTab({ branchName: name })}
                  />
                </Panel>
              </PanelGroup>
            </main>
                  </Panel>
                  <PanelResizeHandle />

                  <Panel defaultSize={32} minSize={15} maxSize={60}>
                    <RightRail
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
                      connectionId={activeTab?.connectionId ?? null}
                      sessionStatus={activeTab?.status ?? "Idle"}
                      activeAgentId={activeAgentForControls}
                      debugBuildRunFixture={debugBuildRunFixture}
                      debugRightRailGitFixture={debugRightRailGitFixture}
                      debugProviderAction={debugProviderAction?.action ?? null}
                      debugCutToolingFixture={debugCutToolingFixture}
                      debugClipboardFixture={debugClipboardFixture === "tasks"
                        ? "tasks"
                        : debugClipboardFixture === "work-preview" ? "work-preview" : null}
                      debugUpdateFixture={debugUpdateFixture}
                      shellxToolExposure={activeTab?.shellxToolExposure ?? DEFAULT_SHELLX_TOOL_EXPOSURE}
                      onShellxToolExposureChange={handleShellxToolExposureChange}
                      onProviderScanUpdated={handleProviderScanUpdated}
                      agentCliStatusFixture={
                        agentCliSetupFixtureMode === "status-card"
                          ? debugAgentCliSetupFixture("status-card")
                          : undefined
                      }
                      agentCliStatusLive={agentCliSetupFixtureMode === "live-status"}
                      onSendPromptToActiveTab={(text) => void sendPromptText(text, activeTabId)}
                      onConnectActiveTab={(target) => connect({
                        tabId: target?.tabId ?? activeTab?.tabId ?? null,
                        cwd: target?.cwd ?? activeTab?.cwd ?? cwd,
                      })}
                      onWorkPreviewStateChange={(state) => {
                        setWorkPreviewByTab((prev) => {
                          const next = new Map(prev);
                          next.set(state.tabId, state);
                          return next;
                        });
                      }}
                      workPreviewState={rightRailWorkPreviewState}
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

      {taskManagerOpen && (
        <LazySurface label="Task Manager" onDismiss={closeTaskManager}>
          <TaskManager
            open
            mode={taskManagerMode}
            data={taskManagerData}
            initialDraft={taskManagerInitialDraft}
            onClose={closeTaskManager}
            onSelectDefinition={(definitionId) => {
              if (debugTaskManagerFixtureMode) {
                setTaskManagerData((current) => {
                  const selected = current.selectedDefinition?.id === definitionId
                    ? current.selectedDefinition
                    : undefined;
                  return { ...current, selectedDefinitionId: definitionId, selectedDefinition: selected };
                });
              } else {
                void taskManagerController.selectDefinition(definitionId);
              }
            }}
            onSave={debugTaskManagerFixtureMode
              ? () => ({ accepted: true, detail: "Owned Task fixture revision saved." })
              : saveTaskManagerDraft}
            onRunNow={debugTaskManagerFixtureMode
              ? () => applyDebugTaskManagerAction("runNow", "Owned Task fixture run queued.")
              : (request) => taskManagerController.runNow(request)}
            onResolveAttention={debugTaskManagerFixtureMode
              ? () => applyDebugTaskManagerAction("resolveAttention", "Owned Task fixture attention acknowledged.")
              : (request) => taskManagerController.resolveAttention(request)}
            onCancelRun={debugTaskManagerFixtureMode
              ? () => applyDebugTaskManagerAction("cancel", "Owned Task fixture cancellation requested.")
              : (request) => taskManagerController.cancelRun(request)}
            onOpenVault={() => openVaultPanel("overview")}
            onPause={debugTaskManagerFixtureMode
              ? () => applyDebugTaskManagerAction("pause", "Owned Task fixture paused.")
              : (request) => taskManagerController.pause(request)}
            onResume={debugTaskManagerFixtureMode
              ? () => applyDebugTaskManagerAction("resume", "Owned Task fixture resumed.")
              : (request) => taskManagerController.resume(request)}
            onDuplicate={debugTaskManagerFixtureMode
              ? () => applyDebugTaskManagerAction("duplicate", "Owned Task fixture duplicated.")
              : (request) => taskManagerController.duplicate(request)}
            onDelete={debugTaskManagerFixtureMode
              ? () => applyDebugTaskManagerAction("delete", "Owned Task fixture deleted.")
              : (request) => taskManagerController.delete(request)}
            onOpenRun={({ conversationSessionId }) => {
              if (debugTaskManagerFixtureMode) {
                return { accepted: true, detail: `Owned Task fixture conversation ${conversationSessionId} opened.` };
              }
              handleOpenChat(conversationSessionId);
              closeTaskManager();
              return { accepted: true, detail: "Run opened in its provider conversation." };
            }}
            onRequestProviderCatalogue={debugTaskManagerFixtureMode
              ? () => ({ accepted: true, detail: "Owned provider catalogue refreshed." })
              : (request) => taskManagerController.requestProviderCatalogue(request)}
          />
        </LazySurface>
      )}

      {helpOpen && (
        <LazySurface label="Help" onDismiss={() => setHelpOpen(false)}>
          <HelpModal onClose={() => setHelpOpen(false)} />
        </LazySurface>
      )}
      {(agentCliSetupFixtureMode === "cards"
        || agentCliSetupFixtureMode === "confirmation"
        || agentCliSetupFixtureMode === "live-setup"
        || agentCliSetupFixtureMode === "install-lifecycle"
        || agentCliSetupFixtureMode === "clipboard-cards"
        || agentCliSetupFixtureMode === "clipboard-confirmation") && (
        <LazySurface
          label="Agent CLI Setup Assistant"
          onDismiss={() => setAgentCliSetupFixtureMode("closed")}
        >
          <AgentCliSetupDialog
            preset={agentCliSetupFixtureMode === "live-setup"
              ? activeConnectionPreset ?? currentLocalConnectionPreset()
              : DEBUG_AGENT_CLI_SETUP_PRESET}
            onClose={() => setAgentCliSetupFixtureMode("closed")}
            fixture={agentCliSetupFixtureMode === "live-setup"
              ? undefined
              : debugAgentCliSetupFixture(agentCliSetupFixtureMode)}
            onSetupChanged={agentCliSetupFixtureMode === "live-setup"
              ? (providers) => handleProviderScanUpdated(
                  activeConnectionPreset ?? currentLocalConnectionPreset(),
                  providers,
                )
              : undefined}
          />
        </LazySurface>
      )}
      {paletteOpen && (
        <LazySurface label="Command Palette" onDismiss={() => setPaletteOpen(false)}>
          <CommandPalette
            open
            onClose={() => setPaletteOpen(false)}
            actions={paletteActions}
            skills={visibleSlashCommands}
            insertSlash={insertSlashIntoPrompt}
          />
        </LazySurface>
      )}
      {settingsOpen && (
        <LazySurface label="Settings" onDismiss={() => setSettingsOpen(false)}>
          <Settings
            open
            onClose={() => setSettingsOpen(false)}
            initial={settings}
            onChange={handleSettingsChange}
            debugShellxagentFixture={debugShellxagentFixture}
            debugClipboardFixture={debugClipboardFixture === "shellxagent-token"
              ? "shellxagent-token"
              : debugClipboardFixture === "vault-draft" ? "vault-draft" : null}
            connectorsDebugFixture={debugConnectorsFixture}
            debugUpdateFixture={debugUpdateFixture}
          />
        </LazySurface>
      )}
      {pluginsOpen && (
        <LazySurface label="Plugins" onDismiss={() => setPluginsOpen(false)}>
          <PluginsModal
            open
            onClose={() => setPluginsOpen(false)}
            activeTabId={activeTabId}
            debugFixture={debugPluginsFixture}
          />
        </LazySurface>
      )}
      {connectorInboxOpen && (
        <LazySurface label="Connector inbox" onDismiss={() => setConnectorInboxOpen(false)}>
          <ConnectorInboxModal
            open
            onClose={() => setConnectorInboxOpen(false)}
            onSeen={markConnectorInboxSeen}
          />
        </LazySurface>
      )}
      {assetBoardOpen && (
        <LazySurface label="Asset board" onDismiss={() => setAssetBoardOpen(false)}>
          <AttachmentMediaBoard
            open
            attachments={pendingAttachmentChips}
            sessionAttachments={sessionAttachments}
            images={sessionMedia.images}
            videos={sessionMedia.videos}
            sessionAssets={sessionAssetRegistry.all}
            activeTabId={activeTabId}
            tabId={activeTabId}
            sessionCwd={activeTab?.cwd ?? cwd}
            onClose={() => setAssetBoardOpen(false)}
            onAttach={() => void handleAttach()}
            onAttachScreenshot={() => void handleAttachScreenshot()}
            onRemoveAttachment={removePendingAttachment}
            onPreviewFile={handlePreviewFile}
            onPreviewAsset={handlePreviewAsset}
            onImportAsset={(asset) => void importAssetToActiveScope(asset)}
            onAttachAsset={(asset) => void handleAttachAsset(asset)}
            onInsertPrompt={appendTextToPrompt}
          />
        </LazySurface>
      )}
      {builtinDocId && (
        <LazySurface label="Documentation" onDismiss={() => setBuiltinDocId(null)}>
          <BuiltinDocModal
            docId={builtinDocId}
            onClose={() => setBuiltinDocId(null)}
          />
        </LazySurface>
      )}
      {previewCenterOpen && (
        <LazySurface label="Preview center" onDismiss={() => setPreviewCenterOpen(false)}>
          <PreviewCenter
            open
            view={previewCenterView}
            filePath={previewPath}
            tabId={previewFileContext?.tabId ?? activeTabId}
            sessionCwd={previewFileContext?.sessionCwd ?? activeTab?.cwd ?? cwd}
            workState={activeWorkPreviewState}
            onClose={() => setPreviewCenterOpen(false)}
            onViewChange={setPreviewCenterView}
            onPreviewFile={handlePreviewFile}
            onRunWorkPreview={handlePreviewFile}
            onAskGrokToFix={(state) => void handleAskGrokToFixPreview(state)}
            debugProviderAction={debugProviderAction?.action ?? null}
          />
        </LazySurface>
      )}
      {activityOpen && (
        <LazySurface label="Activity browser" onDismiss={() => setActivityOpen(false)}>
          <ActivityBrowserModal
            open
            tabId={activeTabId}
            sessionId={activeTab?.sessionId ?? null}
            sessionCwd={activeTab?.cwd ?? cwd}
            transport={activeTab?.connectionTransport ?? "local"}
            onClose={() => setActivityOpen(false)}
            onPreviewFile={handlePreviewFile}
            onAskAgent={(text) => void sendPromptText(text, activeTabId)}
          />
        </LazySurface>
      )}
      <BuildPlanReviewModal
        activeTabId={activeTabId}
        sessionCwd={activeTab?.cwd ?? cwd}
        eventsLen={eventsForActiveTab.length}
        openRequestSeq={buildReviewRequestSeq}
        closeRequestSeq={buildReviewCloseSeq}
        debugFixture={debugBuildPlanFixture}
        onPreviewFile={handlePreviewFile}
        onAccepted={() => {
          setRightRailRequest((cur) => ({ tab: "Plan", seq: (cur?.seq ?? 0) + 1 }));
        }}
        onReviewLater={() => {
          setRightRailRequest((cur) => ({ tab: "Plan", seq: (cur?.seq ?? 0) + 1 }));
        }}
      />
      <GoalPlanReviewModal
        activeTabId={activeTabId}
        eventsLen={eventsForActiveTab.length}
        openRequestSeq={goalReviewRequestSeq}
        fixture={goalPlanReviewFixtureMode === "closed"
          ? undefined
          : debugGoalPlanReviewFixture(goalPlanReviewFixtureMode)}
        onPreviewFile={handlePreviewFile}
        onAccepted={() => {
          if (goalPlanReviewFixtureMode !== "closed") {
            setGoalPlanReviewFixtureMode("closed");
            return;
          }
          setRightRailRequest((cur) => ({ tab: "Plan", seq: (cur?.seq ?? 0) + 1 }));
        }}
        onReviewLater={() => {
          if (goalPlanReviewFixtureMode !== "closed") {
            setGoalPlanReviewFixtureMode("closed");
            return;
          }
          setRightRailRequest((cur) => ({ tab: "Plan", seq: (cur?.seq ?? 0) + 1 }));
        }}
      />
      <RemoteFolderPickerModal
        request={remoteFolderPicker}
        onClose={() => setRemoteFolderPicker(null)}
        onSelect={(path) => {
          updateActiveTab({ cwd: path });
          setRemoteFolderPicker(null);
        }}
      />
      {prModalOpen && (
        <LazySurface label="Pull request" onDismiss={() => setPrModalOpen(false)}>
          <PRCreateModal
            open
            onClose={() => setPrModalOpen(false)}
            defaultBase="main"
            defaultTitle={prDraftTitle}
            defaultBody={prDraftBody}
            transcriptAppendix={prTranscript}
            activeTabId={activeTabId}
            onCreated={(url) => {
              pushUiEvent(url ? `→ PR opened ↗ ${url}` : "→ PR created");
            }}
            releaseTestBoundary={releaseTestExternalEffectBoundary === "pr-create"}
          />
        </LazySurface>
      )}
      {/* VaultPanel — opened via Cmd+K palette → "Open vault
       * (secrets)". Self-renders only when open=true. */}
      {vaultOpen && (
        <LazySurface label="Vault" onDismiss={() => setVaultOpen(false)}>
          <VaultPanel
            open
            intent={vaultPanelIntent}
            intentSeq={vaultPanelIntentSeq}
            onClose={() => setVaultOpen(false)}
          />
        </LazySurface>
      )}
      {releaseTestLazySurface && (
        <LazySurface
          label="Release recovery fixture"
          onDismiss={() => setReleaseTestLazySurface(null)}
          onRetry={() => setReleaseTestLazySurface("recovered")}
        >
          {releaseTestLazySurface === "error" ? (
            <ReleaseLazySurfaceFailure />
          ) : (
            <output data-shellx-release-control="lazy-surface-recovered">
              Lazy surface recovered
            </output>
          )}
        </LazySurface>
      )}
      <DebugHighlightOverlay surface="app" highlights={debugHighlights} />
      {debugProviderActionReceipt && (
        <output
          data-shellx-release-control="provider-action-receipt"
          data-shellx-release-observe="title"
          title={`Provider action receipt — ${debugProviderActionReceipt.action} — ${debugProviderActionReceipt.promptSha256}`}
          style={{ position: "fixed", right: 12, bottom: 12, zIndex: 120, maxWidth: 420 }}
        >
          Provider action completed: {debugProviderActionReceipt.action}
        </output>
      )}
    </div>
  );
}

function ReleaseLazySurfaceFailure(): never {
  throw new Error("SHELLX_RELEASE_LAZY_SURFACE_OWNED_ERROR");
}

interface RemoteFolderPickerRequest {
  tabId: string | null;
  connectionId: string | null;
  initialPath: string;
  label: string;
}

interface RemoteFolderEntry {
  name: string;
  kind: "dir" | "file";
  size: number;
  git_status: string | null;
}

function RemoteFolderPickerModal({
  request,
  onClose,
  onSelect,
}: {
  request: RemoteFolderPickerRequest | null;
  onClose: () => void;
  onSelect: (path: string) => void;
}): JSX.Element | null {
  const [path, setPath] = useState("/");
  const [draftPath, setDraftPath] = useState("/");
  const [entries, setEntries] = useState<RemoteFolderEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  useModalFocus(Boolean(request), dialogRef, onClose);

  useEffect(() => {
    if (!request) return;
    const initial = normalizeRemoteFolderPath(request.initialPath || "/");
    setPath(initial);
    setDraftPath(initial);
    setEntries(null);
    setError(null);
  }, [request?.initialPath, request?.tabId]);

  useEffect(() => {
    if (!request) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setEntries(null);
    void invoke<RemoteFolderEntry[]>("list_project_files", {
      path,
      tabId: request.tabId ?? undefined,
      connectionId: request.connectionId ?? undefined,
      includeHidden: true,
    })
      .then((rows) => {
        if (!cancelled) {
          setError(null);
          setEntries(rows.filter((entry) => entry.kind === "dir"));
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setEntries(null);
          setError(String(err));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [request?.tabId, request?.connectionId, path]);

  if (!request) return null;

  const parent = parentRemoteFolderPath(path);
  const goToDraft = (): void => {
    const next = normalizeRemoteFolderPath(draftPath);
    if (!next) return;
    setPath(next);
    setDraftPath(next);
  };
  const draftNormalized = normalizeRemoteFolderPath(draftPath || path);
  const canUsePath = !loading && !error && entries !== null && draftNormalized === path;
  const folders = (entries ?? []).slice().sort((a, b) => a.name.localeCompare(b.name));

  return (
    <div
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 80,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "rgba(0,0,0,0.48)",
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Remote folder picker"
        style={{
          width: "min(680px, calc(100vw - 32px))",
          maxHeight: "min(620px, calc(100vh - 48px))",
          display: "flex",
          flexDirection: "column",
          background: "var(--bg-elev)",
          color: "var(--fg)",
          border: "1px solid var(--border)",
          borderRadius: 8,
          boxShadow: "0 24px 80px rgba(0,0,0,0.45)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "10px 12px",
            borderBottom: "1px solid var(--border)",
          }}
        >
          <ShellIcon name="folder-open" size={16} />
          <strong style={{ fontSize: "var(--fs-ui-sm)" }}>Remote Folder</strong>
          <span style={{ color: "var(--fg-muted)", fontSize: "var(--fs-ui-xs)" }}>
            {request.label}
          </span>
          <span style={{ flex: 1 }} />
          <button
            type="button"
            className="mp-action-btn mp-action-btn-secondary"
            data-debug-id="remote-cwd-close"
            onClick={onClose}
            aria-label="Close remote folder picker"
          >
            <ShellIcon name="close" size={13} />
          </button>
        </div>
        <div style={{ display: "flex", gap: 8, padding: 12, borderBottom: "1px solid var(--border)" }}>
          <input
            data-debug-id="remote-cwd-input"
            data-shellx-release-observe="value"
            value={draftPath}
            onChange={(e) => setDraftPath(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") goToDraft();
            }}
            aria-label="Remote folder path"
            style={{
              flex: 1,
              minWidth: 0,
              padding: "6px 8px",
              background: "var(--bg)",
              color: "inherit",
              border: "1px solid var(--border)",
              borderRadius: 4,
              fontFamily: "var(--mono, monospace)",
              fontSize: "var(--fs-ui-sm)",
            }}
          />
          <button
            type="button"
            className="mp-action-btn mp-action-btn-secondary"
            data-debug-id="remote-cwd-go"
            onClick={goToDraft}
          >
            Go
          </button>
          <button
            type="button"
            className="mp-action-btn"
            data-debug-id="remote-cwd-use"
            data-shellx-release-observe="disabled"
            onClick={() => onSelect(path)}
            disabled={!canUsePath}
            title={canUsePath ? "Use this folder" : "Press Go and wait for a valid folder before using it"}
          >
            Use
          </button>
        </div>
        <div style={{ display: "flex", gap: 8, padding: "8px 12px", borderBottom: "1px solid var(--border)" }}>
          <button
            type="button"
            className="mp-action-btn mp-action-btn-secondary"
            data-debug-id="remote-cwd-up"
            onClick={() => {
              if (!parent) return;
              setPath(parent);
              setDraftPath(parent);
            }}
            disabled={!parent}
            aria-label="Up one folder level"
          >
            <ShellIcon name="arrow-up" size={13} />
          </button>
          <code style={{ fontSize: "var(--fs-ui-xs)", color: "var(--fg-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {path}
          </code>
        </div>
        {error && (
          <div style={{ padding: "8px 12px", color: "var(--fg-error)", fontSize: "var(--fs-ui-sm)", borderBottom: "1px solid var(--border)" }}>
            {error}
          </div>
        )}
        <div style={{ flex: 1, minHeight: 220, overflow: "auto", padding: 8 }}>
          {loading ? (
            <div style={{ padding: 12, color: "var(--fg-muted)", fontSize: "var(--fs-ui-sm)" }}>
              Loading folders...
            </div>
          ) : folders.length === 0 ? (
            <>
              {parent && (
                <button
                  type="button"
                  data-debug-id="remote-cwd-parent"
                  onClick={() => {
                    setPath(parent);
                    setDraftPath(parent);
                  }}
                  style={{
                    width: "100%",
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "7px 8px",
                    background: "transparent",
                    color: "inherit",
                    border: 0,
                    borderRadius: 4,
                    textAlign: "left",
                    cursor: "pointer",
                  }}
                >
                  <ShellIcon name="arrow-up" size={14} />
                  <span>..</span>
                </button>
              )}
              <div style={{ padding: 12, color: "var(--fg-muted)", fontSize: "var(--fs-ui-sm)" }}>
                No subfolders found.
              </div>
            </>
          ) : (
            <>
              {parent && (
                <button
                  type="button"
                  data-debug-id="remote-cwd-parent"
                  onClick={() => {
                    setPath(parent);
                    setDraftPath(parent);
                  }}
                  style={{
                    width: "100%",
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "7px 8px",
                    background: "transparent",
                    color: "inherit",
                    border: 0,
                    borderRadius: 4,
                    textAlign: "left",
                    cursor: "pointer",
                  }}
                >
                  <ShellIcon name="arrow-up" size={14} />
                  <span>..</span>
                </button>
              )}
              {folders.map((entry) => {
                const next = joinRemoteFolderPath(path, entry.name);
                return (
                  <button
                    key={entry.name}
                    type="button"
                    data-debug-id="remote-cwd-folder"
                    onClick={() => {
                      setPath(next);
                      setDraftPath(next);
                    }}
                    style={{
                      width: "100%",
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      padding: "7px 8px",
                      background: "transparent",
                      color: "inherit",
                      border: 0,
                      borderRadius: 4,
                      textAlign: "left",
                      cursor: "pointer",
                    }}
                  >
                    <ShellIcon name="folder" size={14} />
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {entry.name}
                    </span>
                  </button>
                );
              })}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/* ─────────────── Helpers ─────────────── */

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

function readLocalMigrated<T>(key: string, legacyKey: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (raw != null) return JSON.parse(raw) as T;
    const legacy = localStorage.getItem(legacyKey);
    if (legacy == null) return fallback;
    localStorage.setItem(key, legacy);
    localStorage.removeItem(legacyKey);
    return JSON.parse(legacy) as T;
  } catch { return fallback; }
}

function migratePanelStorage(): void {
  try {
    migrateLocalStorageKey(PANEL_SIZE_KEY_H, LEGACY_PANEL_SIZE_KEY_H);
    migrateLocalStorageKey(PANEL_SIZE_KEY_V, LEGACY_PANEL_SIZE_KEY_V);
    for (const [legacyId, currentId] of LEGACY_PANEL_AUTOSAVE_IDS) {
      migratePanelAutosaveId(currentId, legacyId);
    }
  } catch { /* localStorage may be unavailable in preview/test shells */ }
}

function migrateLocalStorageKey(currentKey: string, legacyKey: string): void {
  if (localStorage.getItem(currentKey) != null) {
    localStorage.removeItem(legacyKey);
    return;
  }
  const legacy = localStorage.getItem(legacyKey);
  if (legacy == null) return;
  localStorage.setItem(currentKey, legacy);
  localStorage.removeItem(legacyKey);
}

function migratePanelAutosaveId(currentId: string, legacyId: string): void {
  const candidates: Array<readonly [string, string]> = [
    [`react-resizable-panels:${legacyId}`, `react-resizable-panels:${currentId}`],
    [`react-resizable-panels:${legacyId}:layout`, `react-resizable-panels:${currentId}:layout`],
    [`react-resizable-panels:layout:${legacyId}`, `react-resizable-panels:layout:${currentId}`],
  ];
  for (const [legacyKey, currentKey] of candidates) {
    migrateLocalStorageKey(currentKey, legacyKey);
  }
}

function formatTokens(n: number, _verbose?: boolean): string {
  // _verbose currently unused; future hook for "524288" vs "524k" rendering
  if (n < 1000) return String(n);
  const k = n / 1000;
  return k >= 100 ? `${Math.round(k)}k` : `${k.toFixed(1)}k`;
}

/**
 * Per-session download button placed next to the chat title. Archives
 * the active Grok tab's workspace + scratch as a zip. Disabled when no
 * Grok session is active (no cwd yet).
 */
function SessionArtifactDownload({
  activeTabId,
  cwd,
  agentId,
  releaseTestBoundary = false,
}: {
  activeTabId: string | null;
  cwd: string;
  agentId: AgentSelection;
  releaseTestBoundary?: boolean;
}): JSX.Element | null {
  const [releaseReceipt, setReleaseReceipt] = useState<string | null>(null);
  useEffect(() => {
    if (!releaseTestBoundary) setReleaseReceipt(null);
  }, [releaseTestBoundary]);
  if (agentId !== "grok" && !releaseTestBoundary) return null;
  // Disabled state: button is dim and shows a tooltip explaining why.
  // We consider "no session active" = no activeTabId OR no cwd assigned
  // to the active tab. The archive command can't produce a meaningful
  // zip without a cwd to walk.
  const disabledReason = !releaseTestBoundary && (!activeTabId || !cwd)
    ? "no session active"
    : "";
  const disabled = disabledReason.length > 0;
  return (
    <button
      type="button"
      className="hdr-icon mid-head-dl"
      data-shellx-release-observe="title"
      disabled={disabled}
      onClick={async () => {
        if (disabled) return;
        if (releaseTestBoundary) {
          setReleaseReceipt("release fixture artifact archive stopped before save picker");
          return;
        }
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
      title={releaseReceipt ?? (disabled
        ? disabledReason
        : "Download this Grok session's artifacts (workspace + scratch) as a zip")}
      aria-label="Download Grok session artifacts"
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
