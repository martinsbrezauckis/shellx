/**
 * src/components/RightRail.tsx — right-rail tab container.
 * * Tab order: Tasks (default) | Tools | Git | Preview | Plan | Files.
 * Persisted to localStorage via TAB_KEY.
 * * - Tasks: TasksPanel — running background subprocesses scoped to the
 * active tab. Polling is mount-gated.
 * - Plan: PlanPane — reads grok's plan.md / goal.md scratchboard from disk
 * through bounded event-aware refreshes. Approval actions live in the modal.
 * - Files: FilesPane — git-aware tree rooted at the active tab's cwd.
 * * PreviewTarget is still exported for legacy file/URL preview callers;
 * WorkPreviewPanel is the right-rail live app preview surface.
 */
import { lazy, useCallback, useEffect, useMemo, useState, type JSX, type KeyboardEvent as ReactKeyboardEvent } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import pkg from "../../package.json";
import { onMouseUpAutoCopy } from "../lib/auto-copy-selection";
import { inTauri } from "../lib/tauri-bridge";
import { SafeMarkdownLink } from "../lib/markdown-links";
import { grokSearchCapabilities, shellxRuntimeCapabilities, type SearchCapability } from "../lib/session-capabilities";
import {
  summarizeUpdateDiagnostic,
  updateErrorIsQuiet,
  type UpdateDiagnosticInput,
} from "../lib/update-diagnostics";
import {
  getBuildReceipts,
  getBuildState,
  isBuildTerminalStatus,
  type BuildReceipt,
  type BuildRunState,
} from "../lib/build-run";
import {
  DEBUG_UPDATE_FIXTURE,
  DEBUG_UPDATE_CHECK_RECEIPT,
  DEBUG_UPDATE_INSTALL_RECEIPT,
  cleanUpdateNotes,
  firstUpdateNotesUrl,
  type DebugUpdateFixtureMode,
} from "../lib/update-notes";
import { TasksPanel } from "./TasksPanel";
import type { ConnectionPreset, ConnectionProviderScanEntry } from "./ConnectionPicker";
import type { AgentCliSetupFixture } from "./AgentCliSetupAssistant";
import { LazySurface } from "./LazySurface";
import { apiPost } from "../lib/debug-api";
import { DEBUG_AGENT_CLI_SETUP_PRESET } from "../lib/debug-agent-cli-setup-fixture";
import {
  normalizeShellxToolExposure,
  DEFAULT_SHELLX_TOOL_EXPOSURE,
  type ProviderId,
  type ProviderShellxToolExposure,
} from "../lib/provider-sessions";
import {
  CUT_TOOLING_FIXTURES,
  type CutToolingState,
  type CutToolingStatus,
} from "../lib/cut-tooling";
import { CutToolingRow } from "./CutToolingRow";
import {
  type ModelInstructionCard,
  type ModelInstructionCardsState,
} from "../lib/model-instruction-cards";
import { getModelInstructionCards } from "../lib/model-instruction-cards-api";
import type { WorkPreviewState } from "../lib/work-preview";
import type { RawEventFrame } from "../types/acp";
import type { DebugBuildRunCockpitFixture } from "../lib/debug-renderer-fixture";
import { RIGHT_RAIL_TABS, isRightTab, type RightTab } from "../lib/ui-navigation";
import { ShellIcon, TransportIcon, type ShellIconName } from "./icons";
import type { DebugRightRailGitLifecycleFixture } from "../lib/debug-right-rail-git-fixture";
import type { DebugProviderAction } from "../lib/debug-provider-action-fixture";
import { useEventAwarePolling, type PollCurrent } from "../lib/useEventAwarePolling";

const GitPane = lazy(() => import("./GitPane")
  .then((module) => ({ default: module.GitPane })));
const WorkPreviewPanel = lazy(() => import("./WorkPreviewPanel")
  .then((module) => ({ default: module.WorkPreviewPanel })));
const FilesPane = lazy(() => import("./FilesPane")
  .then((module) => ({ default: module.FilesPane })));
const AgentCliStatusCard = lazy(() => import("./AgentCliStatusCard")
  .then((module) => ({ default: module.AgentCliStatusCard })));
const BuildRunCockpit = lazy(() => import("./BuildRunCockpit")
  .then((module) => ({ default: module.BuildRunCockpit })));

export type { RightTab } from "../lib/ui-navigation";
export const RIGHT_RAIL_TAB_KEY = "shellX.rightTab.v2";
const LEGACY_RIGHT_RAIL_TAB_KEY = "grok-shell.rightTab";
const VERSION = (pkg as { version?: string }).version ?? "0.0.0";

const RIGHT_TAB_META: Record<RightTab, { label: string; icon: ShellIconName; title: string }> = {
  Tasks: {
    label: "Tasks",
    icon: "activity",
    title: "Tasks - running session work",
  },
  Tooling: {
    label: "Tools",
    icon: "plug",
    title: "Tools - session MCP and capability health",
  },
  Git: {
    label: "Git",
    icon: "git-branch",
    title: "Git - status, diffs, checkpoints, and worktrees",
  },
  Preview: {
    label: "Preview",
    icon: "app-window",
    title: "Preview - run and inspect generated web work",
  },
  Plan: {
    label: "Plan",
    icon: "file",
    title: "Plan - active build scratchboard and review",
  },
  Files: {
    label: "Files",
    icon: "folder",
    title: "Files - project browser",
  },
};

function readPersistedRightTab(): RightTab {
  try {
    const canonical = localStorage.getItem(RIGHT_RAIL_TAB_KEY);
    if (canonical !== null) {
      localStorage.removeItem(LEGACY_RIGHT_RAIL_TAB_KEY);
      if (isRightTab(canonical)) return canonical;
    }
    const legacy = localStorage.getItem(LEGACY_RIGHT_RAIL_TAB_KEY);
    if (legacy !== null) {
      localStorage.setItem(RIGHT_RAIL_TAB_KEY, legacy);
      localStorage.removeItem(LEGACY_RIGHT_RAIL_TAB_KEY);
      if (isRightTab(legacy)) return legacy;
    }
  } catch { /* no-op */ }
  return "Tasks";
}

function writePersistedRightTab(tab: RightTab): void {
  try {
    localStorage.setItem(RIGHT_RAIL_TAB_KEY, tab);
    localStorage.removeItem(LEGACY_RIGHT_RAIL_TAB_KEY);
  } catch { /* no-op */ }
}

type McpKind = "stdio" | "http" | "sse";
type McpTier = "s" | "a" | "b" | "c";

interface McpEntryStatus {
  id: string;
  name: string;
  tier: McpTier;
  kind: McpKind;
  description: string;
  category: string;
  vaultKeys: string[];
  installed: boolean;
  enabled: boolean;
  keysAvailable: boolean[];
  allKeysPresent: boolean;
}

interface MarketplaceHealthEntry {
  entryId: string;
  tabId: string;
  status: "running" | "missing" | "failed" | "disabled" | "available" | "checking";
  transportKey?: string;
  launcher: string;
  installHint: string | null;
  stderrTail: string | null;
  lastCheckMs: number;
}

interface SessionToolingSnapshot {
  tabId: string;
  session: {
    transport?: string;
    cwd?: string | null;
    agentCwd?: string | null;
    wslDistro?: string | null;
    sshHost?: string | null;
    sshPort?: number | null;
    sshKeyVaultRef?: string | null;
    sessionKind?: string | null;
    hasActiveChild?: boolean;
    hasActiveGrokChild?: boolean;
    hasActiveProviderChild?: boolean;
    hasProviderContext?: boolean;
    sessionId?: string | null;
    providerId?: ProviderId | null;
    providerRunId?: string | null;
    providerPhase?: string | null;
    providerTransportKey?: string | null;
    providerConversationId?: string | null;
  };
  desired: McpEntryStatus[];
  health: MarketplaceHealthEntry[];
  cut: CutToolingStatus;
}

type GrokEnvironmentStatus = "idle" | "pass" | "warn" | "fail";
type GrokMcpFailureCategory =
  | "healthy"
  | "authRequired"
  | "connectionFailed"
  | "commandMissing"
  | "handshakeFailed"
  | "failed";

export interface GrokEnvironmentSnapshot {
  tabId: string;
  status: GrokEnvironmentStatus;
  checkedAtMs: number;
  transport: string;
  cwd?: string | null;
  sessionId?: string | null;
  doctor?: {
    summary: {
      status: GrokEnvironmentStatus;
      healthyCount: number;
      failingCount: number;
      totalCount: number;
    };
    servers: Array<{
      name: string;
      transport: string;
      target: string;
      source: string;
      healthy: boolean;
      category: GrokMcpFailureCategory;
      detail?: string | null;
      hint?: string | null;
    }>;
  } | null;
  inspect?: {
    grokVersion?: string | null;
    projectTrusted: boolean;
    instructionCount: number;
    skillCount: number;
    pluginCount: number;
    mcpServerCount: number;
    lspServerCount: number;
  } | null;
  setup: {
    summary: {
      status: GrokEnvironmentStatus;
      readyCount: number;
      attentionCount: number;
      totalCount: number;
    };
    checks: Array<{
      id: string;
      label: string;
      status: GrokEnvironmentStatus;
      detail: string;
      command?: string | null;
      docs?: string | null;
    }>;
  };
  readiness: {
    summary: {
      status: GrokEnvironmentStatus;
      readyCount: number;
      attentionCount: number;
      totalCount: number;
    };
    checks: Array<{
      id: string;
      label: string;
      feature: string;
      status: GrokEnvironmentStatus;
      required: boolean;
      detail: string;
      command?: string | null;
      docs?: string | null;
    }>;
  };
  apiKeyHint: {
    preferredEnv: string;
    legacyEnv: string;
    preferredPresent: boolean;
    legacyPresent: boolean;
    detail: string;
  };
  trace: {
    available: boolean;
    sessionId?: string | null;
    detail: string;
  };
  error?: string | null;
}

const DEBUG_PROVIDER_ACTION_MCP_ENTRY: McpEntryStatus = {
  id: "shellx-release-provider-action",
  name: "ShellX release fixture",
  tier: "a",
  kind: "stdio",
  description: "Release-owned connector prompt fixture.",
  category: "release",
  vaultKeys: [],
  installed: true,
  enabled: true,
  keysAvailable: [],
  allKeysPresent: true,
};

const DEBUG_PROVIDER_ACTION_MCP_HEALTH: MarketplaceHealthEntry = {
  entryId: DEBUG_PROVIDER_ACTION_MCP_ENTRY.id,
  tabId: "release-provider-action",
  status: "missing",
  launcher: "shellx-release-provider-action-missing",
  installHint: null,
  stderrTail: null,
  lastCheckMs: 0,
};

const DEBUG_PROVIDER_ACTION_GROK_ENVIRONMENT: GrokEnvironmentSnapshot = {
  tabId: "release-provider-action",
  status: "warn",
  checkedAtMs: 0,
  transport: "local release fixture",
  cwd: "SHELLX_RELEASE_PROVIDER_ACTION_ENVIRONMENT_035",
  sessionId: "release-provider-action",
  doctor: null,
  inspect: {
    grokVersion: "release-fixture",
    projectTrusted: true,
    instructionCount: 1,
    skillCount: 1,
    pluginCount: 1,
    mcpServerCount: 1,
    lspServerCount: 0,
  },
  setup: {
    summary: { status: "warn", readyCount: 0, attentionCount: 1, totalCount: 1 },
    checks: [{
      id: "release-fixture",
      label: "Release fixture check",
      status: "warn",
      detail: "SHELLX_RELEASE_PROVIDER_ACTION_ENVIRONMENT_035",
    }],
  },
  readiness: {
    summary: { status: "warn", readyCount: 0, attentionCount: 1, totalCount: 1 },
    checks: [{
      id: "release-fixture",
      label: "Release fixture readiness",
      feature: "provider-action-lifecycle",
      status: "warn",
      required: false,
      detail: "SHELLX_RELEASE_PROVIDER_ACTION_ENVIRONMENT_035",
    }],
  },
  apiKeyHint: {
    preferredEnv: "XAI_API_KEY",
    legacyEnv: "GROK_API_KEY",
    preferredPresent: false,
    legacyPresent: false,
    detail: "No credential is used by the release fixture.",
  },
  trace: { available: false, detail: "Release fixture trace is intentionally unavailable." },
};

interface GrokTraceExportResult {
  status: GrokEnvironmentStatus;
  sessionId: string;
  outputPath?: string | null;
  stdoutTail?: string | null;
  stderrTail?: string | null;
}

export interface PreviewTarget {
  kind: "file" | "url" | "image" | "markdown" | "diff";
  path: string;
  tabId?: string;
  sessionCwd?: string;
}

export function RightRail({
  autonomy,
  onPreviewFile,
  onAttachPaths,
  events = [],
  cwd,
  activeTabId,
  prefetchedPlanText,
  requestedTab,
  requestedTabSeq,
  onOpenGoalReview,
  connectionLabel = "Local",
  connectionTransport = "local",
  connectionId = null,
  sessionStatus = "Idle",
  onSendPromptToActiveTab,
  onTabChange,
  onWorkPreviewStateChange,
  workPreviewState,
  onOpenWorkPreview,
  onAskGrokToFixPreview,
  onConnectActiveTab,
  activeAgentId = null,
  debugBuildRunFixture = null,
  debugRightRailGitFixture = null,
  debugProviderAction = null,
  debugCutToolingFixture = null,
  debugClipboardFixture = null,
  debugUpdateFixture = "live",
  shellxToolExposure = DEFAULT_SHELLX_TOOL_EXPOSURE,
  onShellxToolExposureChange,
  onProviderScanUpdated,
  agentCliStatusFixture,
  agentCliStatusLive = false,
}: {
 /** Current autonomy mode — drives the Plan tab empty-state copy. */
  autonomy?: string;
 /** Click handler for FilesPane rows + future flink chips. */
  onPreviewFile?: (path: string) => void;
  onAttachPaths?: (paths: string[]) => void;
 /** ACP event stream — Tools derives advertised capabilities; PlanPane filters plan-events. */
  events?: RawEventFrame[];
 /** Active tab's cwd; FilesPane roots its tree here. */
  cwd: string;
 /** Active tab id, threaded into PlanPane so extractPlanState can
 * filter by _meta.tabId (defense-in-depth on top of App-level
 * eventsForActiveTab). */
  activeTabId?: string | null;
 /** Pre-fetched plan.md body populated at App level on each
 * `plan-event` arrival; used as PlanPane's initial planText so the
 * pane renders without waiting for its own fetch. */
  prefetchedPlanText?: string;
 /** Imperative tab request from App-level moments such as plan approval. */
  requestedTab?: RightTab | null;
  requestedTabSeq?: number;
  onOpenGoalReview?: () => void;
  connectionLabel?: string;
  connectionTransport?: string;
  connectionId?: string | null;
  sessionStatus?: string;
  onSendPromptToActiveTab?: (text: string) => void;
  onTabChange?: (tab: RightTab) => void;
  onWorkPreviewStateChange?: (state: WorkPreviewState) => void;
  workPreviewState?: WorkPreviewState;
  onOpenWorkPreview?: (state: WorkPreviewState) => void;
  onAskGrokToFixPreview?: (state: WorkPreviewState) => void;
  onConnectActiveTab?: (target?: { tabId?: string | null; cwd?: string | null }) => Promise<boolean> | boolean | void;
  activeAgentId?: string | null;
  debugBuildRunFixture?: DebugBuildRunCockpitFixture | null;
  debugRightRailGitFixture?: DebugRightRailGitLifecycleFixture | null;
  debugProviderAction?: DebugProviderAction | null;
  debugCutToolingFixture?: CutToolingState | null;
  debugClipboardFixture?: "tasks" | "work-preview" | null;
  debugUpdateFixture?: DebugUpdateFixtureMode;
  shellxToolExposure?: ProviderShellxToolExposure;
  onShellxToolExposureChange?: (mode: ProviderShellxToolExposure) => void;
  onProviderScanUpdated?: (preset: ConnectionPreset, providers: ConnectionProviderScanEntry[]) => void;
  agentCliStatusFixture?: AgentCliSetupFixture;
  agentCliStatusLive?: boolean;
}): JSX.Element {
  const [tab, setTab] = useState<RightTab>(readPersistedRightTab);

  useEffect(() => {
    writePersistedRightTab(tab);
    onTabChange?.(tab);
    void apiPost("/state/ui", { rightTab: tab }).catch(() => { /* no-op */ });
  }, [tab, onTabChange]);
  useEffect(() => {
    if (!requestedTab) return;
    setTab(requestedTab);
  }, [requestedTab, requestedTabSeq]);

  function handleTabKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>, current: RightTab): void {
    const index = RIGHT_RAIL_TABS.indexOf(current);
    let nextIndex: number | null = null;
    if (event.key === "ArrowRight") nextIndex = (index + 1) % RIGHT_RAIL_TABS.length;
    else if (event.key === "ArrowLeft") nextIndex = (index - 1 + RIGHT_RAIL_TABS.length) % RIGHT_RAIL_TABS.length;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = RIGHT_RAIL_TABS.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    const next = RIGHT_RAIL_TABS[nextIndex]!;
    setTab(next);
    window.requestAnimationFrame(() => {
      document.querySelector<HTMLButtonElement>(`[data-debug-id="right-tab-${next.toLowerCase()}"]`)?.focus();
    });
  }

  return (
    <aside className="right">
 {/* Tab order: Tasks (default) | Tools | Git | Preview | Plan | Files. */}
      <div className="right-tabs tabs" role="tablist" aria-label="Workspace side panels">
        {RIGHT_RAIL_TABS.map((rightTab) => {
          const meta = RIGHT_TAB_META[rightTab];
          return (
            <button
              key={rightTab}
              type="button"
              role="tab"
              aria-selected={tab === rightTab}
              tabIndex={tab === rightTab ? 0 : -1}
              className={`tab ${tab === rightTab ? "active" : ""}`}
              data-debug-id={`right-tab-${rightTab.toLowerCase()}`}
              onClick={() => setTab(rightTab)}
              onKeyDown={(event) => handleTabKeyDown(event, rightTab)}
              title={meta.title}
              aria-label={meta.title}
            >
              <ShellIcon name={meta.icon} size={15} />
              <span className="right-tab-label">{meta.label}</span>
            </button>
          );
        })}
      </div>

 {/* TasksPanel scopes by activeTabId so each session sees its
 * own subprocess rows. host-MCP subagents currently lack a
 * tabId and surface in an "Unattributed" section inside the
 * panel. */}
      {tab === "Tasks" && (
        <TasksPanel
          activeTabId={activeTabId ?? null}
          activeAgentId={activeAgentId ?? null}
          onAskAgent={onSendPromptToActiveTab}
          debugClipboardFixture={debugClipboardFixture === "tasks" ? "owned-safe" : null}
        />
      )}
      {tab === "Tooling" && (
        <ToolingPane
          activeTabId={activeTabId ?? null}
          cwd={cwd}
          connectionLabel={connectionLabel}
          connectionTransport={connectionTransport}
          connectionId={connectionId}
          sessionStatus={sessionStatus}
          events={events}
          activeAgentId={activeAgentId}
          shellxToolExposure={shellxToolExposure}
          onShellxToolExposureChange={onShellxToolExposureChange}
          onSendPromptToActiveTab={onSendPromptToActiveTab}
          onProviderScanUpdated={onProviderScanUpdated}
          agentCliStatusFixture={agentCliStatusFixture}
          agentCliStatusLive={agentCliStatusLive}
          debugFixture={debugRightRailGitFixture}
          debugProviderAction={debugProviderAction}
          debugCutToolingFixture={debugCutToolingFixture}
          debugUpdateFixture={debugUpdateFixture}
        />
      )}
      {tab === "Git" && (
        <LazySurface label="Git panel" variant="inline" onDismiss={() => setTab("Tasks")}>
          <GitPane
            activeTabId={activeTabId ?? null}
            cwd={cwd}
            debugFixture={debugRightRailGitFixture}
          />
        </LazySurface>
      )}
      {tab === "Preview" && (
        <LazySurface label="Preview panel" variant="inline" onDismiss={() => setTab("Tasks")}>
          <WorkPreviewPanel
            activeTabId={activeTabId ?? null}
            cwd={cwd}
            stateSnapshot={workPreviewState}
            onStateChange={onWorkPreviewStateChange}
            onOpenPreview={onOpenWorkPreview}
            onAskGrokToFix={onAskGrokToFixPreview}
            debugClipboardFixture={debugClipboardFixture === "work-preview" ? "owned-safe" : null}
          />
        </LazySurface>
      )}
      {tab === "Plan" && (
        <PlanPane
          autonomy={autonomy}
          events={events}
          activeTabId={activeTabId}
          activeCwd={cwd}
          activeAgentId={activeAgentId}
          prefetchedPlanText={prefetchedPlanText}
          onPreviewFile={onPreviewFile ?? (() => {})}
          onOpenGoalReview={onOpenGoalReview}
          sessionStatus={sessionStatus}
          onConnectActiveTab={onConnectActiveTab}
          debugBuildRunFixture={debugBuildRunFixture}
        />
      )}
      {tab === "Files" && (
        <LazySurface label="Files panel" variant="inline" onDismiss={() => setTab("Tasks")}>
          <FilesPane
            activeTabId={activeTabId ?? null}
            connectionId={connectionId ?? null}
            cwd={cwd}
            onPreviewFile={onPreviewFile ?? (() => {})}
            onAttachPaths={onAttachPaths}
          />
        </LazySurface>
      )}
    </aside>
  );
}

/* ─────────────── Tools tab ─────────────── */

function ToolingPane({
  activeTabId,
  cwd,
  connectionLabel,
  connectionTransport,
  connectionId,
  sessionStatus,
  onSendPromptToActiveTab,
  events,
  activeAgentId,
  shellxToolExposure,
  onShellxToolExposureChange,
  onProviderScanUpdated,
  agentCliStatusFixture,
  agentCliStatusLive,
  debugFixture,
  debugProviderAction,
  debugCutToolingFixture,
  debugUpdateFixture,
}: {
  activeTabId: string | null;
  cwd: string;
  connectionLabel: string;
  connectionTransport: string;
  connectionId: string | null;
  sessionStatus: string;
  events: RawEventFrame[];
  activeAgentId?: string | null;
  shellxToolExposure: ProviderShellxToolExposure;
  onShellxToolExposureChange?: (mode: ProviderShellxToolExposure) => void;
  onSendPromptToActiveTab?: (text: string) => void;
  onProviderScanUpdated?: (preset: ConnectionPreset, providers: ConnectionProviderScanEntry[]) => void;
  agentCliStatusFixture?: AgentCliSetupFixture;
  agentCliStatusLive: boolean;
  debugFixture?: DebugRightRailGitLifecycleFixture | null;
  debugProviderAction?: DebugProviderAction | null;
  debugCutToolingFixture?: CutToolingState | null;
  debugUpdateFixture: DebugUpdateFixtureMode;
}): JSX.Element {
  const [entries, setEntries] = useState<McpEntryStatus[]>([]);
  const [health, setHealth] = useState<Record<string, MarketplaceHealthEntry>>({});
  const [sessionInfo, setSessionInfo] = useState<SessionToolingSnapshot["session"] | null>(null);
  const [connectionPreset, setConnectionPreset] = useState<ConnectionPreset | null>(null);
  const [cutStatus, setCutStatus] = useState<CutToolingStatus | null>(null);
  const [cutChecking, setCutChecking] = useState(false);
  const [cutOpening, setCutOpening] = useState(false);
  const [cutCheckSequence, setCutCheckSequence] = useState(0);
  const [cutActionError, setCutActionError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setEntries([]);
    setHealth({});
    setSessionInfo(null);
    setCutStatus(null);
    setCutChecking(false);
    setCutOpening(false);
    setCutCheckSequence(0);
    setCutActionError(null);
    setHasLoaded(false);
    setError(null);
    if (debugFixture || debugProviderAction || debugCutToolingFixture) {
      setHasLoaded(true);
      return;
    }
    if (agentCliStatusFixture || agentCliStatusLive) {
      setHasLoaded(true);
      return;
    }
    if (!activeTabId || !inTauri()) return;

    let cancelled = false;
    const refresh = async () => {
      setLoading(true);
      try {
        const snapshot = await invoke<SessionToolingSnapshot>("session_tooling_snapshot", { tabId: activeTabId });
        if (cancelled) return;
        const nextHealth: Record<string, MarketplaceHealthEntry> = {};
        for (const row of snapshot.health) {
          if (row.tabId === activeTabId) nextHealth[row.entryId] = row;
        }
        setEntries(snapshot.desired);
        setHealth(nextHealth);
        setSessionInfo(snapshot.session);
        setCutStatus(snapshot.cut);
        setHasLoaded(true);
        setError(null);
      } catch (e) {
        if (!cancelled) setError(typeof e === "string" ? e : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void refresh();
    const id = window.setInterval(() => void refresh(), 4000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [activeTabId, agentCliStatusFixture, agentCliStatusLive, connectionLabel, connectionTransport, connectionId, debugFixture, debugProviderAction, debugCutToolingFixture]);

  useEffect(() => {
    setConnectionPreset(null);
    if (debugFixture || debugProviderAction || debugCutToolingFixture) return;
    if (agentCliStatusFixture || agentCliStatusLive) return;
    if (!connectionId || !inTauri()) return;
    let cancelled = false;
    void invoke<ConnectionPreset[]>("connections_list")
      .then((presets) => {
        if (cancelled) return;
        setConnectionPreset(presets.find((preset) => preset.id === connectionId) ?? null);
      })
      .catch(() => {
        if (!cancelled) setConnectionPreset(null);
      });
    return () => {
      cancelled = true;
    };
  }, [agentCliStatusFixture, agentCliStatusLive, connectionId, debugFixture, debugProviderAction, debugCutToolingFixture]);

  const desired = useMemo(
    () => entries.filter((entry) => entry.installed && entry.enabled),
    [entries],
  );
  const searchCapabilities = useMemo(
    () => grokSearchCapabilities(events, {
      hasProviderContext: sessionInfo?.hasProviderContext === true,
      providerId: sessionInfo?.providerId ?? null,
    }),
    [events, sessionInfo?.hasProviderContext, sessionInfo?.providerId],
  );
  const readySearchCapabilities = searchCapabilities.filter((cap) => cap.ready).length;
  const runtimeCapabilities = useMemo(() => shellxRuntimeCapabilities(events), [events]);
  const readyRuntimeCapabilities = runtimeCapabilities.filter((cap) => cap.ready).length;
  const hasConnectedEnvironment =
    sessionInfo?.hasActiveChild === true ||
    sessionInfo?.hasActiveProviderChild === true ||
    sessionInfo?.hasProviderContext === true;
  const showGrokEnvironment = activeAgentId === "grok";
  const environmentLabel = hasLoaded
    ? (hasConnectedEnvironment ? sessionStatus : "awaiting session")
    : sessionStatus;
  const checkCutStatus = async (): Promise<void> => {
    if (debugCutToolingFixture || !activeTabId || cutChecking || cutOpening) return;
    setCutActionError(null);
    setCutChecking(true);
    setCutStatus((current) => current
      ? { ...current, ...CUT_TOOLING_FIXTURES.checking, target: current.target }
      : CUT_TOOLING_FIXTURES.checking);
    try {
      const snapshot = await invoke<SessionToolingSnapshot>("session_tooling_snapshot", { tabId: activeTabId });
      setCutStatus(snapshot.cut);
      setSessionInfo(snapshot.session);
      setCutCheckSequence((current) => current + 1);
    } catch (e) {
      setCutActionError(typeof e === "string" ? e : String(e));
    } finally {
      setCutChecking(false);
    }
  };
  const openCut = async (): Promise<void> => {
    if (debugCutToolingFixture || !activeTabId || cutOpening) return;
    setCutActionError(null);
    setCutOpening(true);
    try {
      const next = await invoke<CutToolingStatus>("cut_tooling_open", { tabId: activeTabId });
      setCutStatus(next);
    } catch (e) {
      setCutActionError(typeof e === "string" ? e : String(e));
    } finally {
      setCutOpening(false);
    }
  };

  if (debugFixture) {
    return (
      <div className="tooling-pane" data-right-rail-fixture="owned-read-only">
        <GrokEnvironmentCard
          activeTabId={activeTabId}
          cwd={cwd}
          sessionInfo={null}
          debugSnapshot={debugFixture.environmentSnapshot as unknown as GrokEnvironmentSnapshot}
        />
        <ModelInstructionCardsCard debugFixture={debugFixture} />
      </div>
    );
  }

  if (debugProviderAction === "right-rail-environment-ask") {
    return (
      <div className="tooling-pane" data-right-rail-provider-action-fixture="environment">
        <GrokEnvironmentCard
          activeTabId={activeTabId}
          cwd={cwd}
          sessionInfo={null}
          onSendPromptToActiveTab={onSendPromptToActiveTab}
          debugSnapshot={DEBUG_PROVIDER_ACTION_GROK_ENVIRONMENT}
        />
      </div>
    );
  }

  if (debugProviderAction === "right-rail-connector-action") {
    return (
      <div className="tooling-pane" data-right-rail-provider-action-fixture="connector">
        <div className="tooling-list">
          <ToolingRow
            entry={DEBUG_PROVIDER_ACTION_MCP_ENTRY}
            health={DEBUG_PROVIDER_ACTION_MCP_HEALTH}
            connectionLabel="release-owned local fixture"
            onSendPromptToActiveTab={onSendPromptToActiveTab}
          />
        </div>
      </div>
    );
  }

  if (agentCliStatusFixture || agentCliStatusLive) {
    return (
      <div className="tooling-pane">
        <LazySurface label="Agent CLI status" variant="inline">
          <AgentCliStatusCard
            activeTabId={activeTabId ?? "release-surface-agent-cli-status"}
            sessionInfo={null}
            connectionId={null}
            connectionTransport="local"
            connectionPreset={DEBUG_AGENT_CLI_SETUP_PRESET}
            fixture={agentCliStatusFixture}
          />
        </LazySurface>
      </div>
    );
  }

  if (!activeTabId) {
    return (
      <div className="rail-empty">
        <div className="rail-empty-line">No active session.</div>
        <div className="rail-empty-hint">Open or start a tab to inspect environment tooling.</div>
      </div>
    );
  }

  if (!inTauri()) {
    return (
      <div className="rail-empty">
        <div className="rail-empty-line">Tool checks need Tauri.</div>
        <div className="rail-empty-hint">This pane reads session-scoped MCP health from the desktop host.</div>
      </div>
    );
  }

  return (
    <div className="tooling-pane">
      <div className="tooling-head">
        <div className="tooling-title">Session Tools</div>
        <div className="tooling-meta">
          <span className="tooling-transport">
            <TransportIcon value={connectionTransport} size={12} />
            {connectionLabel}
          </span>
          <span className={!hasConnectedEnvironment && hasLoaded ? "muted" : ""}>{environmentLabel}</span>
          <span>{readySearchCapabilities}/{searchCapabilities.length} search</span>
          <span>{readyRuntimeCapabilities}/{runtimeCapabilities.length} advanced</span>
          <span>{desired.length} desired MCP{desired.length === 1 ? "" : "s"}</span>
        </div>
      </div>

      <UpdateDiagnosticsCard debugFixture={debugUpdateFixture} />

      <ShellXToolExposureCard
        mode={shellxToolExposure}
        onChange={onShellxToolExposureChange}
      />

      <CutToolingRow
        status={debugCutToolingFixture
          ? CUT_TOOLING_FIXTURES[debugCutToolingFixture]
          : cutStatus ?? CUT_TOOLING_FIXTURES.checking}
        checking={debugCutToolingFixture === "checking" || (!debugCutToolingFixture && (loading || cutChecking))}
        opening={cutOpening}
        checkSequence={cutCheckSequence}
        actionError={cutActionError}
        onCheck={checkCutStatus}
        onOpen={openCut}
      />

      {showGrokEnvironment && (
        <GrokEnvironmentCard
          activeTabId={activeTabId}
          cwd={cwd}
          sessionInfo={sessionInfo}
          onSendPromptToActiveTab={onSendPromptToActiveTab}
        />
      )}

      <LazySurface label="Agent CLI status" variant="inline">
        <AgentCliStatusCard
          activeTabId={activeTabId}
          sessionInfo={sessionInfo}
          connectionId={connectionId}
          connectionTransport={connectionTransport}
          connectionPreset={connectionPreset}
          onProviderScanUpdated={onProviderScanUpdated}
        />
      </LazySurface>

      <ModelInstructionCardsCard />

      {error && (
        <div className="rail-empty tooling-error">
          <div className="rail-empty-line">Tools snapshot failed.</div>
          <div className="rail-empty-hint"><code>{error}</code></div>
        </div>
      )}

      {!error && loading && !hasLoaded && desired.length === 0 && (
        <div className="rail-empty"><div className="rail-empty-line">Checking tools…</div></div>
      )}

      {!error && hasLoaded && !hasConnectedEnvironment && (
        <div className="rail-empty">
          <div className="rail-empty-line">Awaiting session.</div>
          <div className="rail-empty-hint">Connect this tab to local, WSL, or SSH; tool checks will run inside that environment.</div>
        </div>
      )}

      {!error && hasLoaded && hasConnectedEnvironment && (
        <>
          <div className="tooling-section-label">Search capabilities</div>
          <div className="tooling-list">
            {searchCapabilities.map((entry) => (
              <CapabilityRow key={entry.id} entry={entry} />
            ))}
          </div>
          <div className="tooling-section-label">Advanced capabilities</div>
          <div className="tooling-list">
            {runtimeCapabilities.map((entry) => (
              <CapabilityRow key={entry.id} entry={entry} />
            ))}
          </div>
        </>
      )}

      {!error && hasLoaded && hasConnectedEnvironment && desired.length === 0 && (
        <div className="rail-empty">
          <div className="rail-empty-line">No desired MCP connectors enabled.</div>
          <div className="rail-empty-hint">Use Plugins to choose global connectors, then this tab shows whether they work here.</div>
        </div>
      )}

      {!error && hasConnectedEnvironment && desired.length > 0 && (
        <div className="tooling-list">
          {desired.map((entry) => (
            <ToolingRow
              key={entry.id}
              entry={entry}
              health={health[entry.id]}
              connectionLabel={connectionLabel}
              onSendPromptToActiveTab={onSendPromptToActiveTab}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function openExternal(url: string): void {
  void invoke("open_url_in_browser", { url })
    .catch(() => {
      try { window.open(url, "_blank", "noopener,noreferrer"); } catch { /* ignore */ }
    });
}

const SHELLX_TOOL_EXPOSURE_OPTIONS: Array<{
  mode: ProviderShellxToolExposure;
  label: string;
  title: string;
}> = [
  {
    mode: "nativeFirst",
    label: "Native",
    title: "Use provider-native tools first; keep ShellX bridge tools available.",
  },
  {
    mode: "hostBridge",
    label: "Bridge",
    title: "Keep ShellX handoff, preview, asset, and receipt tools available.",
  },
  {
    mode: "hostFull",
    label: "Full",
    title: "Allow the full ShellX host-tool surface for this tab.",
  },
  {
    mode: "off",
    label: "Off",
    title: "Do not inject ShellX host MCP tools into new provider runs on this tab.",
  },
];

function ShellXToolExposureCard({
  mode,
  onChange,
}: {
  mode: ProviderShellxToolExposure;
  onChange?: (mode: ProviderShellxToolExposure) => void;
}): JSX.Element {
  const normalized = normalizeShellxToolExposure(mode);
  const status = normalized === "off"
    ? { label: "off", className: "muted" }
    : { label: formatToolExposureMode(normalized), className: "ok" };

  return (
    <div className="tooling-row shellx-tool-exposure">
      <div className="tooling-row-top">
        <span className="tooling-name">ShellX tools</span>
        <span className={`tooling-status ${status.className}`}>{status.label}</span>
      </div>
      <div className="tooling-detail">
        <div className="tool-exposure-segments" role="group" aria-label="ShellX tool exposure">
          {SHELLX_TOOL_EXPOSURE_OPTIONS.map((option) => (
            <button data-debug-id="surface-components-rightrail-2"
              key={option.mode}
              type="button"
              className={`tool-exposure-segment ${normalized === option.mode ? "active" : ""}`}
              title={option.title}
              aria-pressed={normalized === option.mode}
              data-shellx-tool-exposure={option.mode}
              data-shellx-release-observe="pressed"
              onClick={() => onChange?.(option.mode)}
              disabled={!onChange}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function UpdateDiagnosticsCard({
  debugFixture = "live",
}: {
  debugFixture?: DebugUpdateFixtureMode;
} = {}): JSX.Element {
  const [state, setState] = useState<UpdateDiagnosticInput>({
    currentVersion: VERSION,
    kind: "idle",
  });
  const [body, setBody] = useState<string>("");
  const [releaseReceipt, setReleaseReceipt] = useState<string | null>(null);

  async function checkForUpdates(): Promise<void> {
    if (debugFixture === "owned-check" || debugFixture === "owned-available") {
      setBody(DEBUG_UPDATE_FIXTURE.body);
      setState({
        currentVersion: VERSION,
        kind: "available",
        remoteVersion: DEBUG_UPDATE_FIXTURE.version,
        checkedAtMs: Number.MAX_SAFE_INTEGER,
      });
      setReleaseReceipt(DEBUG_UPDATE_CHECK_RECEIPT);
      return;
    }
    if (!inTauri()) return;
    setState((prev) => ({ ...prev, kind: "checking", errorMessage: null }));
    try {
      const { check } = await import("@tauri-apps/plugin-updater");
      const update = await check();
      const checkedAtMs = Date.now();
      if (update) {
        setBody(cleanUpdateNotes(update.body));
        setState({
          currentVersion: VERSION,
          kind: "available",
          remoteVersion: update.version,
          checkedAtMs,
        });
      } else {
        setBody("");
        setState({
          currentVersion: VERSION,
          kind: "current",
          checkedAtMs,
        });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setBody("");
      setState({
        currentVersion: VERSION,
        kind: "error",
        errorMessage: msg,
        checkedAtMs: Date.now(),
      });
    }
  }

  async function installUpdate(): Promise<void> {
    if (debugFixture === "owned-available") {
      setBody("");
      setState({ currentVersion: VERSION, kind: "current", checkedAtMs: Number.MAX_SAFE_INTEGER });
      setReleaseReceipt(DEBUG_UPDATE_INSTALL_RECEIPT);
      return;
    }
    setState((prev) => ({ ...prev, kind: "installing", progress: 0, errorMessage: null }));
    try {
      const [{ check }, { relaunch }] = await Promise.all([
        import("@tauri-apps/plugin-updater"),
        import("@tauri-apps/plugin-process"),
      ]);
      const update = await check();
      if (!update) {
        setState({ currentVersion: VERSION, kind: "current", checkedAtMs: Date.now() });
        return;
      }
      let total = 0;
      let downloaded = 0;
      await update.downloadAndInstall((evt) => {
        if (evt.event === "Started") total = evt.data.contentLength ?? 0;
        if (evt.event === "Progress") {
          downloaded += evt.data.chunkLength;
          if (total > 0) {
            setState((prev) => ({ ...prev, kind: "installing", progress: downloaded / total }));
          }
        }
      });
      await relaunch();
    } catch (e) {
      setState({
        currentVersion: VERSION,
        kind: "error",
        errorMessage: e instanceof Error ? e.message : String(e),
        checkedAtMs: Date.now(),
      });
    }
  }

  useEffect(() => {
    setReleaseReceipt(null);
    if (debugFixture === "owned-available") {
      setBody(DEBUG_UPDATE_FIXTURE.body);
      setState({
        currentVersion: VERSION,
        kind: "available",
        remoteVersion: DEBUG_UPDATE_FIXTURE.version,
        checkedAtMs: Number.MAX_SAFE_INTEGER,
      });
      return;
    }
    if (debugFixture === "owned-cleared") {
      setBody("");
      setState({ currentVersion: VERSION, kind: "idle" });
      return;
    }
    if (debugFixture === "owned-check") {
      setBody("");
      setState({ currentVersion: VERSION, kind: "idle" });
      return;
    }
    if (!inTauri()) return;
    void checkForUpdates();
  }, [debugFixture]);

  const summary = summarizeUpdateDiagnostic(state);
  const releaseNotesUrl = firstUpdateNotesUrl(body);
  const quietError = state.kind === "error" && updateErrorIsQuiet(state.errorMessage);

  return (
    <div
      className={`tooling-row update-diagnostic update-diagnostic-${summary.accent}`}
      data-release-update-receipt="right-rail"
      data-shellx-release-observe="title"
      title={releaseReceipt ?? "Update diagnostics"}
    >
      <div className="tooling-row-top">
        <span className="tooling-name">Update diagnostics</span>
        <span className={`tooling-status ${summary.accent === "bad" ? "bad" : summary.accent === "ok" ? "ok" : summary.accent === "warn" ? "warn" : "muted"}`}>
          {summary.statusLabel}
        </span>
      </div>
      <div className="tooling-detail">
        <div>{summary.detail}</div>
        <div>
          Host app <code>v{VERSION}</code>
          {state.checkedAtMs ? ` · checked ${new Date(state.checkedAtMs).toLocaleTimeString()}` : ""}
        </div>
        {quietError && <div className="tooling-issue">Updater endpoint is not advertising a usable release manifest right now.</div>}
      </div>
      <div className="tooling-actions">
        {releaseNotesUrl && (
          <button type="button" className="mp-action-btn mp-action-btn-secondary" onClick={() => openExternal(releaseNotesUrl)}>
            Notes
          </button>
        )}
        {state.kind === "available" && (
          <button
            type="button"
            data-release-update-control="right-rail-install"
            className="mp-action-btn mp-action-btn-primary"
            onClick={() => void installUpdate()}
          >
            Install
          </button>
        )}
        <button
          type="button"
          data-release-update-control="right-rail-check"
          className="mp-action-btn mp-action-btn-secondary"
          onClick={() => void checkForUpdates()}
          disabled={state.kind === "checking" || state.kind === "installing"}
        >
          <ShellIcon name="refresh" size={12} />
          Check
        </button>
      </div>
    </div>
  );
}

function GrokEnvironmentCard({
  activeTabId,
  cwd,
  sessionInfo,
  onSendPromptToActiveTab,
  debugSnapshot = null,
}: {
  activeTabId: string | null;
  cwd: string;
  sessionInfo: SessionToolingSnapshot["session"] | null;
  onSendPromptToActiveTab?: (text: string) => void;
  debugSnapshot?: GrokEnvironmentSnapshot | null;
}): JSX.Element {
  const [snapshot, setSnapshot] = useState<GrokEnvironmentSnapshot | null>(debugSnapshot ?? null);
  const [loading, setLoading] = useState(false);
  const [traceBusy, setTraceBusy] = useState(false);
  const [environmentRefreshSequence, setEnvironmentRefreshSequence] = useState(0);
  const [traceFixtureReceipt, setTraceFixtureReceipt] = useState<string | null>(null);
  const [copiedReport, setCopiedReport] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const refresh = async (force = false): Promise<void> => {
    if (debugSnapshot) {
      setSnapshot(debugSnapshot);
      if (force) setEnvironmentRefreshSequence((sequence) => sequence + 1);
      return;
    }
    if (!activeTabId || !inTauri()) return;
    setLoading(true);
    setMessage(null);
    try {
      const next = await invoke<GrokEnvironmentSnapshot>("grok_environment_snapshot", {
        tabId: activeTabId,
        force,
        cwd: cwd || null,
      });
      setSnapshot(next);
    } catch (e) {
      setMessage(typeof e === "string" ? e : String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (debugSnapshot) {
      setSnapshot(debugSnapshot);
      setMessage(null);
      setEnvironmentRefreshSequence(0);
      setTraceFixtureReceipt(null);
      return;
    }
    setSnapshot(null);
    setMessage(null);
    setEnvironmentRefreshSequence(0);
    setTraceFixtureReceipt(null);
    if (!activeTabId) return;
    void refresh(true);
  }, [activeTabId, cwd, debugSnapshot, sessionInfo?.hasActiveChild, sessionInfo?.sessionId]);

  const status = grokEnvironmentStatus(snapshot?.status ?? "idle");
  const failingServers = snapshot?.doctor?.servers.filter((server) => !server.healthy) ?? [];
  const setupSummary = snapshot?.setup?.summary;
  const setupChecks = snapshot?.setup?.checks.filter((check) => check.status !== "pass") ?? [];
  const readinessSummary = snapshot?.readiness?.summary;
  const readinessChecks = snapshot?.readiness?.checks.filter((check) => check.status !== "pass" && check.status !== "idle") ?? [];
  const inspect = snapshot?.inspect;
  const doctorSummary = snapshot?.doctor?.summary;
  const apiKeyHintText = snapshot ? actionableGrokApiKeyHint(snapshot) : null;

  async function exportTrace(): Promise<void> {
    if (!activeTabId || !snapshot?.trace.available) return;
    if (debugSnapshot) {
      setTraceFixtureReceipt("release fixture trace export boundary completed");
      return;
    }
    setTraceBusy(true);
    setMessage(null);
    try {
      const result = await invoke<GrokTraceExportResult>("grok_trace_export", { tabId: activeTabId });
      setMessage(
        result.outputPath
          ? `Trace saved: ${result.outputPath}`
          : result.stderrTail || result.stdoutTail || "Trace export finished.",
      );
    } catch (e) {
      setMessage(typeof e === "string" ? e : String(e));
    } finally {
      setTraceBusy(false);
    }
  }

  function askGrokAboutEnvironment(): void {
    if (!snapshot || !onSendPromptToActiveTab) return;
    onSendPromptToActiveTab(buildGrokEnvironmentInspectionPrompt(snapshot));
  }

  async function copyGrokEnvironmentReport(): Promise<void> {
    if (!snapshot) return;
    try {
      await navigator.clipboard.writeText(buildGrokEnvironmentReport(snapshot));
      setCopiedReport(true);
      window.setTimeout(() => setCopiedReport(false), 1200);
    } catch {
      /* ignore */
    }
  }

  return (
    <div className={`tooling-row update-diagnostic update-diagnostic-${status.accent}`}>
      <div className="tooling-row-top">
        <span className="tooling-name">Environment</span>
        <span className={`tooling-status ${status.className}`}>{status.label}</span>
      </div>
      <div className="tooling-detail">
        {!activeTabId && <div>No active tab.</div>}
        {activeTabId && !sessionInfo?.hasActiveChild && <div>Connect this tab to run environment diagnostics.</div>}
        {snapshot && (
          <>
            <div>
              {inspect?.grokVersion ? <code>Grok Build CLI v{inspect.grokVersion}</code> : "Session"}
              {doctorSummary
                ? ` · ${doctorSummary.healthyCount} healthy · ${doctorSummary.failingCount} failing · ${doctorSummary.totalCount} MCPs`
                : " · doctor unavailable"}
            </div>
            {inspect && (
              <div>
                {inspect.skillCount} skills · {inspect.pluginCount} plugins · {inspect.instructionCount} instructions · project{" "}
                {inspect.projectTrusted ? "trusted" : "not trusted"}
              </div>
            )}
            {setupSummary && (
              <div>
                Preview setup: {setupSummary.readyCount} ready · {setupSummary.attentionCount} needs setup · {setupSummary.totalCount} checks
              </div>
            )}
            {readinessSummary && (
              <div>
                Feature readiness: {readinessSummary.readyCount} ready · {readinessSummary.attentionCount} needs setup · {readinessSummary.totalCount} checks
              </div>
            )}
            {apiKeyHintText && <div>{apiKeyHintText}</div>}
            {snapshot.error && <div className="tooling-issue">{snapshot.error}</div>}
            {readinessChecks.slice(0, 4).map((check) => (
              <div className="tooling-issue" key={`readiness-${check.id}`}>
                {check.label}: {grokReadinessStatusLabel(check)}
                {" · "}
                {check.feature}
                {" · "}
                {check.detail}
                {check.command && (
                  <>
                    {" "}
                    Check: <code>{check.command}</code>
                  </>
                )}
              </div>
            ))}
            {setupChecks.slice(0, 3).map((check) => (
              <div className="tooling-issue" key={`setup-${check.id}`}>
                {check.label}: {grokSetupStatusLabel(check.status)}
                {" · "}
                {check.detail}
                {check.command && (
                  <>
                    {" "}
                    Command: <code>{check.command}</code>
                  </>
                )}
              </div>
            ))}
            {readinessChecks.length > 4 && (
              <div className="tooling-issue">+{readinessChecks.length - 4} more readiness issue{readinessChecks.length - 4 === 1 ? "" : "s"}.</div>
            )}
            {failingServers.slice(0, 4).map((server) => (
              <div className="tooling-issue" key={`${server.name}-${server.category}`}>
                {server.name}: {grokMcpCategoryLabel(server.category)}
                {server.detail ? ` · ${server.detail}` : ""}
              </div>
            ))}
            {failingServers.length > 4 && (
              <div className="tooling-issue">+{failingServers.length - 4} more failing MCP server{failingServers.length - 4 === 1 ? "" : "s"}.</div>
            )}
            <div>
              {snapshot.checkedAtMs ? `Checked ${new Date(snapshot.checkedAtMs).toLocaleTimeString()}` : ""}
              {snapshot.trace.available ? " · trace available" : ""}
            </div>
          </>
        )}
        {message && <div className="tooling-issue">{message}</div>}
      </div>
      <div className="tooling-actions">
        {snapshot && (
          <button
            type="button"
            className="mp-action-btn mp-action-btn-secondary"
            onClick={() => void copyGrokEnvironmentReport()}
            title="Copy environment diagnostic report"
          >
            <ShellIcon name={copiedReport ? "check" : "copy"} size={12} />
            Copy
          </button>
        )}
        {snapshot && onSendPromptToActiveTab && snapshot.status !== "pass" && (
          <button
            type="button"
            className="mp-action-btn mp-action-btn-secondary"
            onClick={askGrokAboutEnvironment}
            title="Ask the active agent to inspect this diagnostic snapshot"
          >
            <ShellIcon name="message" size={12} />
            Ask
          </button>
        )}
        <button
          type="button"
          data-release-environment-control="trace"
          data-shellx-release-observe="title"
          className="mp-action-btn mp-action-btn-secondary"
          onClick={() => void exportTrace()}
          disabled={!snapshot?.trace.available || traceBusy}
          title={traceFixtureReceipt ?? snapshot?.trace.detail ?? "No session id is available yet."}
        >
          <ShellIcon name="file" size={12} />
          Trace
        </button>
        <button data-debug-id="surface-components-rightrail-9"
          type="button"
          data-shellx-release-observe="title"
          className="mp-action-btn mp-action-btn-secondary"
          onClick={() => void refresh(true)}
          disabled={!activeTabId || loading}
          title={`Refresh environment — ${environmentRefreshSequence} manual refresh${environmentRefreshSequence === 1 ? "" : "es"} completed in this view`}
        >
          <ShellIcon name="refresh" size={12} />
          {loading ? "Checking" : "Refresh"}
        </button>
      </div>
    </div>
  );
}

function ModelInstructionCardsCard({
  debugFixture = null,
}: {
  debugFixture?: DebugRightRailGitLifecycleFixture | null;
}): JSX.Element {
  const [state, setState] = useState<ModelInstructionCardsState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [manualRefreshSequence, setManualRefreshSequence] = useState(0);

  async function refresh(showLoading = true): Promise<void> {
    if (showLoading) setLoading(true);
    if (debugFixture) {
      setState(debugFixture.modelInstructionCards);
      setError(null);
      setManualRefreshSequence((sequence) => sequence + 1);
      if (showLoading) setLoading(false);
      return;
    }
    try {
      const next = await getModelInstructionCards();
      setState(next);
      setError(null);
      setManualRefreshSequence((sequence) => sequence + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (showLoading) setLoading(false);
    }
  }

  useEffect(() => {
    setManualRefreshSequence(0);
    if (debugFixture) {
      setState(debugFixture.modelInstructionCards);
      setError(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      try {
        const next = await getModelInstructionCards();
        if (cancelled) return;
        setState(next);
        setError(null);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [debugFixture]);

  const cards = state?.cards ?? [];
  const categories = useMemo(() => summarizeCardCategories(cards), [cards]);
  const policy = state?.policy;
  const status = error
    ? { label: "unavailable", className: "warn" }
    : loading && !state
      ? { label: "checking", className: "muted" }
      : policy?.shellxMayAutoRoute === false && policy.defaultRouteMode === "explicitOnly"
        ? { label: "explicit only", className: "ok" }
        : { label: "review", className: "warn" };

  return (
    <div className="tooling-row model-cards">
      <div className="tooling-row-top">
        <span className="tooling-name">Model instruction cards</span>
        <span className={`tooling-status ${status.className}`}>{status.label}</span>
      </div>
      <div className="tooling-detail model-cards-body">
        {policy && (
          <>
            <div className="model-cards-policy">
              <span>{cards.length} cards</span>
              <span>routing {policy.defaultRouteMode}</span>
              <span>tools {formatToolExposureMode(policy.defaultToolExposureMode)}</span>
              <span>{policy.shellxMayAutoRoute ? "auto-route allowed" : "no silent fallback"}</span>
            </div>
            <div>{policy.fallbackRule}</div>
          </>
        )}
        {categories.length > 0 && (
          <div className="model-cards-groups" aria-label="Model instruction card categories">
            {categories.map((category) => (
              <span key={category}>{formatCardCategory(category)}</span>
            ))}
          </div>
        )}
        {cards.length > 0 && (
          <div className="model-cards-list">
            {cards.map((card) => (
              <ModelInstructionCardRow key={card.id} card={card} />
            ))}
          </div>
        )}
        {error && <div className="tooling-issue">{error}</div>}
        {!error && loading && !state && <div>Checking instruction cards...</div>}
      </div>
      <div className="tooling-actions">
        <button
          type="button"
          className="mp-action-btn mp-action-btn-secondary"
          data-shellx-release-control="model-cards-refresh"
          data-shellx-release-observe="title"
          title={`Refresh model instruction cards — ${manualRefreshSequence} manual refresh${manualRefreshSequence === 1 ? "" : "es"} completed in this view`}
          onClick={() => void refresh()}
          disabled={loading}
        >
          <ShellIcon name="refresh" size={12} />
          Refresh
        </button>
      </div>
    </div>
  );
}

function ModelInstructionCardRow({ card }: { card: ModelInstructionCard }): JSX.Element {
  return (
    <div className="model-card-row" title={card.fallbackRule}>
      <span className="model-card-name">{card.displayName}</span>
      <span className="model-card-provider">{card.providerId}</span>
      <span className="model-card-mode">{formatToolExposureMode(card.toolExposure.defaultMode)}</span>
      <span className="model-card-status">{formatCardStatus(card.status)}</span>
    </div>
  );
}

function summarizeCardCategories(cards: ModelInstructionCard[]): string[] {
  return [...new Set(cards.map((card) => card.category))].sort((a, b) => a.localeCompare(b));
}

function formatCardCategory(category: string): string {
  switch (category) {
    case "coding-agent":
      return "coding agents";
    case "media-generation":
      return "media generation";
    case "shellx-host-tool":
      return "ShellX host tools";
    default:
      return category.replace(/-/g, " ");
  }
}

function formatCardStatus(status: string): string {
  switch (status) {
    case "codex-routed":
      return "Codex routed";
    case "bundled":
      return "bundled";
    case "requires-shellx-bridge":
      return "bridge required";
    default:
      return status.replace(/-/g, " ");
  }
}

function formatToolExposureMode(mode: string): string {
  switch (mode) {
    case "nativeFirst":
      return "native first";
    case "hostBridge":
      return "host bridge";
    case "hostFull":
      return "host full";
    case "off":
      return "off";
    default:
      return mode.replace(/-/g, " ");
  }
}

function grokEnvironmentStatus(status: GrokEnvironmentStatus): {
  label: string;
  className: string;
  accent: "ok" | "warn" | "bad";
} {
  switch (status) {
    case "pass":
      return { label: "healthy", className: "ok", accent: "ok" };
    case "warn":
      return { label: "attention", className: "warn", accent: "warn" };
    case "fail":
      return { label: "needs attention", className: "bad", accent: "bad" };
    case "idle":
    default:
      return { label: "idle", className: "muted", accent: "warn" };
  }
}

function grokSetupStatusLabel(status: GrokEnvironmentStatus): string {
  switch (status) {
    case "fail":
      return "required";
    case "warn":
      return "recommended";
    case "idle":
      return "waiting";
    case "pass":
    default:
      return "ready";
  }
}

function grokReadinessStatusLabel(check: GrokEnvironmentSnapshot["readiness"]["checks"][number]): string {
  if (check.status === "fail") return check.required ? "missing required tool" : "missing optional tool";
  if (check.status === "warn") return check.required ? "needs setup" : "recommended";
  if (check.status === "idle") return "waiting";
  return "ready";
}

function grokMcpCategoryLabel(category: GrokMcpFailureCategory): string {
  switch (category) {
    case "authRequired":
      return "auth required";
    case "connectionFailed":
      return "connection failed";
    case "commandMissing":
      return "command missing";
    case "handshakeFailed":
      return "handshake failed";
    case "healthy":
      return "healthy";
    case "failed":
    default:
      return "failed";
  }
}

function buildGrokEnvironmentInspectionPrompt(snapshot: GrokEnvironmentSnapshot): string {
  const setupChecks = snapshot.setup.checks.filter((check) => check.status !== "pass");
  const readinessChecks = snapshot.readiness.checks.filter((check) => check.status !== "pass");
  const failingServers = snapshot.doctor?.servers.filter((server) => !server.healthy) ?? [];
  const apiKeyHint = actionableGrokApiKeyHint(snapshot);
  const setupBody = setupChecks.length > 0
    ? setupChecks.slice(0, 12).map((check) => {
        const command = check.command ? ` command=${check.command}` : "";
        const docs = check.docs ? ` docs=${check.docs}` : "";
        return `- ${check.label}: ${grokSetupStatusLabel(check.status)} - ${check.detail}${command}${docs}`;
      }).join("\n")
    : "(none)";
  const readinessBody = readinessChecks.length > 0
    ? readinessChecks.slice(0, 12).map((check) => {
        const command = check.command ? ` check=${check.command}` : "";
        const docs = check.docs ? ` docs=${check.docs}` : "";
        return `- ${check.label}: ${grokReadinessStatusLabel(check)} - feature=${check.feature} - ${check.detail}${command}${docs}`;
      }).join("\n")
    : "(none)";
  const failingBody = failingServers.length > 0
    ? failingServers.slice(0, 12).map((server) => {
        const detail = server.detail ? ` - ${server.detail}` : "";
        const hint = server.hint ? ` hint=${server.hint}` : "";
        return `- ${server.name}: ${grokMcpCategoryLabel(server.category)}${detail}${hint}`;
      }).join("\n")
    : "(none)";

  const lines = [
    "Inspect this shellX environment diagnostic snapshot and tell me the safest next action.",
    "",
    "Environment:",
    `- status: ${snapshot.status}`,
    `- transport: ${snapshot.transport}`,
    `- cwd: ${snapshot.cwd ?? "(none)"}`,
    `- session: ${snapshot.sessionId ?? "(none)"}`,
    `- Grok version: ${snapshot.inspect?.grokVersion ?? "(unknown)"}`,
    `- project trusted: ${snapshot.inspect?.projectTrusted ? "yes" : "no"}`,
    `- skills/plugins/instructions: ${snapshot.inspect?.skillCount ?? "?"}/${snapshot.inspect?.pluginCount ?? "?"}/${snapshot.inspect?.instructionCount ?? "?"}`,
    "",
    "Feature readiness needing attention:",
    readinessBody,
    "",
    "Setup checks needing attention:",
    setupBody,
    "",
    "Failing MCP servers:",
    failingBody,
    "",
    "Do not edit config, install packages, delete files, or rotate credentials unless I explicitly confirm. If a fix is needed, propose the exact command and explain the risk first.",
  ];

  if (apiKeyHint) {
    lines.splice(10, 0, "", "API key hint:", apiKeyHint);
  }

  return lines.join("\n");
}

export function buildGrokEnvironmentReport(snapshot: GrokEnvironmentSnapshot): string {
  const setupChecks = snapshot.setup.checks.filter((check) => check.status !== "pass");
  const readinessChecks = snapshot.readiness.checks.filter((check) => check.status !== "pass");
  const failingServers = snapshot.doctor?.servers.filter((server) => !server.healthy) ?? [];
  const apiKeyHint = actionableGrokApiKeyHint(snapshot);
  const setupBody = setupChecks.length > 0
    ? setupChecks.map((check) => {
        const command = check.command ? ` command="${check.command}"` : "";
        const docs = check.docs ? ` docs="${check.docs}"` : "";
        return `- ${check.label}: ${check.status} - ${check.detail}${command}${docs}`;
      }).join("\n")
    : "- none";
  const readinessBody = readinessChecks.length > 0
    ? readinessChecks.map((check) => {
        const command = check.command ? ` check="${check.command}"` : "";
        const docs = check.docs ? ` docs="${check.docs}"` : "";
        return `- ${check.label}: ${check.status} required=${check.required ? "true" : "false"} feature="${check.feature}" detail="${check.detail}"${command}${docs}`;
      }).join("\n")
    : "- none";
  const failingBody = failingServers.length > 0
    ? failingServers.map((server) => {
        const target = server.target ? ` target="${server.target}"` : "";
        const detail = server.detail ? ` detail="${server.detail}"` : "";
        const hint = server.hint ? ` hint="${server.hint}"` : "";
        return `- ${server.name}: ${server.category} transport=${server.transport}${target}${detail}${hint}`;
      }).join("\n")
    : "- none";

  const lines = [
    "shellX environment report",
    "",
    `status: ${snapshot.status}`,
    `checked_at: ${snapshot.checkedAtMs ? new Date(snapshot.checkedAtMs).toISOString() : "(unknown)"}`,
    `tab: ${snapshot.tabId}`,
    `transport: ${snapshot.transport}`,
    `cwd: ${snapshot.cwd ?? "(none)"}`,
    `session: ${snapshot.sessionId ?? "(none)"}`,
    `grok_version: ${snapshot.inspect?.grokVersion ?? "(unknown)"}`,
    `project_trusted: ${snapshot.inspect?.projectTrusted ? "true" : "false"}`,
    `skills: ${snapshot.inspect?.skillCount ?? "?"}`,
    `plugins: ${snapshot.inspect?.pluginCount ?? "?"}`,
    `instructions: ${snapshot.inspect?.instructionCount ?? "?"}`,
    `mcp_servers: ${snapshot.inspect?.mcpServerCount ?? "?"}`,
    `doctor_healthy: ${snapshot.doctor?.summary.healthyCount ?? "?"}`,
    `doctor_failing: ${snapshot.doctor?.summary.failingCount ?? "?"}`,
    `setup_ready: ${snapshot.setup.summary.readyCount}`,
    `setup_attention: ${snapshot.setup.summary.attentionCount}`,
    `readiness_ready: ${snapshot.readiness.summary.readyCount}`,
    `readiness_attention: ${snapshot.readiness.summary.attentionCount}`,
    "",
    "readiness_checks_needing_attention:",
    readinessBody,
    "",
    "setup_checks_needing_attention:",
    setupBody,
    "",
    "failing_mcp_servers:",
    failingBody,
    "",
    "trace:",
    snapshot.trace.detail,
    snapshot.error ? `\nerror:\n${snapshot.error}` : "",
  ];

  if (apiKeyHint) {
    lines.splice(18, 0, "", "api_key:", apiKeyHint);
  }

  return lines.join("\n");
}

function actionableGrokApiKeyHint(snapshot: GrokEnvironmentSnapshot): string | null {
  const hint = snapshot.apiKeyHint;
  if (!hint.preferredPresent && !hint.legacyPresent) return null;
  return hint.detail;
}

function CapabilityRow({ entry }: { entry: SearchCapability }): JSX.Element {
  const status = entry.ready
    ? { label: "ready here", className: "ok" }
    : { label: "waiting", className: "muted" };
  return (
    <div className="tooling-row tooling-row-capability">
      <div className="tooling-row-top">
        <span className="tooling-name">{entry.name}</span>
        <span className={`mp-kind mp-kind-${entry.source === "native" ? "http" : "stdio"}`}>
          {entry.source === "native" ? "NATIVE" : "HOST"}
        </span>
        <span className={`tooling-status ${status.className}`}>{status.label}</span>
      </div>
      <div className="tooling-detail">
        <div>{entry.description}</div>
        <div>Tool: <code>{entry.toolName}</code></div>
        {!entry.ready && <div className="tooling-issue">{entry.unavailableHint}</div>}
      </div>
    </div>
  );
}

function ToolingRow({
  entry,
  health,
  connectionLabel,
  onSendPromptToActiveTab,
}: {
  entry: McpEntryStatus;
  health?: MarketplaceHealthEntry;
  connectionLabel: string;
  onSendPromptToActiveTab?: (text: string) => void;
}): JSX.Element {
  const status = toolingStatus(entry, health);
  const issue = toolingIssue(entry, health);
  const canRepair = health?.status === "missing" || health?.status === "failed";
  const actionLabel = health?.status === "missing" ? "Install" : "Fix";
  const canAsk = Boolean(issue && onSendPromptToActiveTab);
  const actionPrompt = buildMcpToolingPrompt(entry, health, connectionLabel, issue);

  return (
    <div className="tooling-row">
      <div className="tooling-row-top">
        <span className="tooling-name">{entry.name}</span>
        <span className={`mp-kind mp-kind-${entry.kind}`}>{entry.kind.toUpperCase()}</span>
        <span className={`tooling-status ${status.className}`}>{status.label}</span>
      </div>
      <div className="tooling-detail">
        <div>{entry.description}</div>
        <div>
          Desired: enabled globally
          {entry.vaultKeys.length > 0 ? ` · keys ${entry.allKeysPresent ? "present" : "missing"}` : " · no key"}
        </div>
        {health?.launcher && <div>Launcher: <code>{health.launcher}</code></div>}
        {issue && <div className="tooling-issue">{issue}</div>}
      </div>
      {(canRepair || canAsk) && (
        <div className="tooling-actions">
          <button data-debug-id="surface-components-rightrail-11"
            type="button"
            className="mp-action-btn mp-action-btn-secondary"
            onClick={() => {
              onSendPromptToActiveTab?.(actionPrompt);
            }}
          >
            {canRepair ? actionLabel : "Ask"}
          </button>
        </div>
      )}
    </div>
  );
}

function buildMcpToolingPrompt(
  entry: McpEntryStatus,
  health: MarketplaceHealthEntry | undefined,
  connectionLabel: string,
  issue: string | null,
): string {
  if (health?.status === "missing") {
    return (
      `Install the missing launcher for the ${entry.name} MCP connector in this ${connectionLabel} environment. ` +
      `The session Tools check reported ${health.launcher ? `\`${health.launcher}\`` : "the launcher"} missing. ` +
      "First inspect the environment and package manager, then ask before running installer commands."
    );
  }
  if (health?.status === "failed") {
    return (
      `Check and fix the ${entry.name} MCP connector in this ${connectionLabel} environment. ` +
      "First inspect what is failing, then propose or run the safest config command only after permission.\n\n" +
      `Probe detail: ${issue ?? health.stderrTail ?? "(none)"}`
    );
  }
  return [
    `Inspect the ${entry.name} MCP connector in this ${connectionLabel} environment and tell me the safest next action.`,
    "",
    `Connector: ${entry.name}`,
    `Kind: ${entry.kind}`,
    `Category: ${entry.category}`,
    `Description: ${entry.description}`,
    `Vault keys: ${entry.vaultKeys.length > 0 ? entry.vaultKeys.join(", ") : "(none)"}`,
    `Keys present: ${entry.allKeysPresent ? "yes" : "no"}`,
    `Probe status: ${health?.status ?? "(waiting)"}`,
    `Launcher: ${health?.launcher ?? "(unknown)"}`,
    `Issue: ${issue ?? "(none)"}`,
    "",
    "Do not edit config, install packages, delete files, or rotate credentials unless I explicitly confirm. If a fix is needed, propose the exact command and explain the risk first.",
  ].join("\n");
}

function toolingStatus(
  entry: McpEntryStatus,
  health?: MarketplaceHealthEntry,
): { label: string; className: string } {
  if (!entry.allKeysPresent) return { label: "key needed", className: "warn" };
  if (!health) return { label: "waiting", className: "muted" };
  if (health.status === "running") return { label: "ready here", className: "ok" };
  if (health.status === "checking") return { label: "checking", className: "muted" };
  if (health.status === "missing") return { label: "missing tool", className: "warn" };
  if (health.status === "failed") return { label: "probe failed", className: "bad" };
  return { label: health.status, className: "muted" };
}

function toolingIssue(entry: McpEntryStatus, health?: MarketplaceHealthEntry): string | null {
  if (!entry.allKeysPresent) {
    const missing = entry.vaultKeys.filter((_, i) => !entry.keysAvailable[i]);
    return `Missing vault key${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}`;
  }
  if (!health) return "Waiting for this tab's environment probe.";
  if (health.status === "missing") return health.installHint ?? "Required launcher is not on this environment PATH.";
  if (health.status === "failed") return health.stderrTail ?? "Launcher probe failed.";
  if (health.status === "checking") return "Probe is running in the active tab environment.";
  return null;
}

// #366: dead code pruned: PreviewPane, FilesNode (recursive tree),
// inferKind, ImagePreview, MarkdownPreview, UrlPreview, CodePreview,
// ErrorPreview, useFileText (~200 LOC). The Preview tab was moved
// out of RightRail to App-level FilePreviewModal; these helpers became
// unreachable. Files tab now lives in FilesPane.tsx.


/* ─────────────── Plan ─────────────── */

interface GoalStatusState {
  active: boolean;
  objective: string;
  scratchboardPath?: string;
  continuationsTotal: number;
  startedAtMs: number;
  pausedByUser: boolean;
  haltedReason?: string;
  awaitingApproval?: boolean;
  planTurnCompleted?: boolean;
  approvalStatus?: { ready: boolean; reason?: string | null };
  approvedAtMs?: number;
}

function PlanPane({
  autonomy: _autonomy,
  events,
  activeTabId,
  activeCwd,
  activeAgentId,
  prefetchedPlanText,
  onPreviewFile,
  onOpenGoalReview,
  sessionStatus,
  onConnectActiveTab,
  debugBuildRunFixture,
}: {
  autonomy?: string;
  events: { kind: string; payload?: unknown }[];
  activeTabId?: string | null;
  activeCwd?: string;
  activeAgentId?: string | null;
 /** Pre-fetched plan.md text from App-level. Used as initial
 * planText so the pane renders immediately; the local fetch still
 * runs and may refresh to a newer body. */
  prefetchedPlanText?: string;
  onPreviewFile?: (path: string) => void;
  onOpenGoalReview?: () => void;
  sessionStatus: string;
  onConnectActiveTab?: (target?: { tabId?: string | null; cwd?: string | null }) => Promise<boolean> | boolean | void;
  debugBuildRunFixture: DebugBuildRunCockpitFixture | null;
}): JSX.Element {
 // Grok plan-mode wire:
 // 1. session/update with sessionUpdate=current_mode_update,
 // update.currentModeId="plan" → entered plan mode
 // 2. session/update with updateType=ToolCallUpdate,
 // update.rawOutput.type="EnterPlanMode",
 // update.rawOutput.Entered.plan_file_path="…/plan.md"
 // → grok confirmed entry; gives us the file to read.
 // 3. currentModeId="default" → exited plan mode
 // // Tauri's assetProtocol scope includes $HOME/.grok/sessions/**, so
 // the plan file is fetched via asset://. Event bursts schedule one
 // trailing refresh. The extractPlanState walk
 // is memoized on events identity to avoid a full rescan per render.
  const [planFilePath, modeId, planEntries] = useMemo(() => extractPlanState(events, activeTabId), [events, activeTabId]);
 // Seed planText from the App-level pre-fetch when available so the
 // pane renders immediately on tab switch.
  const [planText, setPlanText] = useState<string>(prefetchedPlanText ?? "");

 /* #395: Legacy goal-orchestrator scratchboard. When legacy /goal is active
 * the orchestrator opens a scratchboard at <cwd>/goal.md (fallback
 * <cwd>/plan.md). Grok inconsistently emits ACP `sessionUpdate:"plan"`
 * — sometimes it just writes markdown to the scratchboard and we
 * never see plan entries. PlanPane was empty in that case. Now we
 * poll get_goal_state to find scratchboardPath, fetch its contents,
 * and render as markdown as a fallback below ACP entries (or instead
 * of them when entries are absent). */
  const [goalState, setGoalState] = useState<GoalStatusState | null>(null);
  const [goalScratchboardText, setGoalScratchboardText] = useState<string>("");
  const goalActive = Boolean(goalState?.active);
  const goalContinuationsTotal = goalState?.continuationsTotal ?? 0;
  const goalScratchboardPath = goalState?.scratchboardPath ?? null;
  const [buildState, setBuildState] = useState<BuildRunState | null>(null);
  const [buildReceipts, setBuildReceipts] = useState<BuildReceipt[]>([]);
  const [buildScratchboardText, setBuildScratchboardText] = useState<string>("");
  const [buildRefreshSeq, setBuildRefreshSeq] = useState(0);
  const renderedBuildState = debugBuildRunFixture?.state ?? buildState;
  const renderedBuildReceipts = debugBuildRunFixture?.receipts ?? buildReceipts;
  const renderedBuildScratchboardText = debugBuildRunFixture?.scratchboardText ?? buildScratchboardText;
  const goalPollingEnabled = inTauri() && Boolean(activeTabId);
  const refreshGoalState = useCallback(async (isCurrent: PollCurrent): Promise<void> => {
    if (!activeTabId) return;
    try {
      const st = await invoke<unknown>("get_goal_state", { tabId: activeTabId }) as any;
      if (!isCurrent()) return;
      if (!st || !st.active) {
        setGoalState(null);
        setGoalScratchboardText("");
        return;
      }
      setGoalState(st as GoalStatusState);
    } catch {
      // Goal state is optional outside a compatible desktop host.
    }
  }, [activeTabId]);

  useEventAwarePolling({
    enabled: goalPollingEnabled,
    scopeKey: `goal:${activeTabId ?? "none"}`,
    eventRevision: events.length,
    intervalMs: 2500,
    poll: refreshGoalState,
  });

  useEffect(() => {
    if (goalPollingEnabled) return;
    setGoalState(null);
    setGoalScratchboardText("");
  }, [goalPollingEnabled]);

  const buildPollingEnabled = inTauri() && Boolean(activeTabId) && !debugBuildRunFixture;
  const refreshBuildState = useCallback(async (isCurrent: PollCurrent): Promise<void> => {
    if (!activeTabId) return;
    try {
      const st = await getBuildState(activeTabId);
      if (!isCurrent()) return;
      setBuildState(st);
      if (!st) {
        setBuildReceipts([]);
        return;
      }
      try {
        const rows = await getBuildReceipts(activeTabId);
        if (isCurrent()) setBuildReceipts(rows);
      } catch {
        if (isCurrent()) setBuildReceipts([]);
      }
    } catch {
      if (isCurrent()) {
        setBuildState(null);
        setBuildReceipts([]);
      }
    }
  }, [activeTabId]);

  useEventAwarePolling({
    enabled: buildPollingEnabled,
    scopeKey: `build:${activeTabId ?? "none"}:${debugBuildRunFixture ? "fixture" : "live"}`,
    eventRevision: events.length + buildRefreshSeq,
    intervalMs: 2500,
    poll: refreshBuildState,
  });

  useEffect(() => {
    if (debugBuildRunFixture) {
      setBuildState(null);
      setBuildReceipts([]);
      return;
    }
    if (!buildPollingEnabled) {
      setBuildState(null);
      setBuildReceipts([]);
    }
  }, [buildPollingEnabled, debugBuildRunFixture]);
  const refreshGoalScratchboard = useCallback(async (isCurrent: PollCurrent): Promise<void> => {
    if (!goalScratchboardPath) return;
    try {
      const text = inTauri()
        ? await invoke<string>("read_text_file_for_path", {
            path: goalScratchboardPath,
            tabId: activeTabId ?? undefined,
            sessionCwd: activeCwd,
          })
        : await fetch(convertFileSrc(goalScratchboardPath, "asset"))
            .then((response) => (response.ok ? response.text() : ""));
      if (isCurrent()) setGoalScratchboardText((cur) => (cur === text ? cur : text));
    } catch {
      if (isCurrent()) setGoalScratchboardText("");
    }
  }, [activeCwd, activeTabId, goalScratchboardPath]);

  useEventAwarePolling({
    enabled: Boolean(goalScratchboardPath),
    scopeKey: `goal-file:${activeTabId ?? "none"}:${goalScratchboardPath ?? "none"}:${activeCwd ?? ""}`,
    eventRevision: events.length,
    poll: refreshGoalScratchboard,
  });

  useEffect(() => {
    if (!goalScratchboardPath) setGoalScratchboardText("");
  }, [goalScratchboardPath]);

  const buildScratchboardPath = buildState?.scratchboardPath ?? null;
  const refreshBuildScratchboard = useCallback(async (isCurrent: PollCurrent): Promise<void> => {
    if (!buildScratchboardPath) return;
    try {
      const text = inTauri()
        ? await invoke<string>("read_text_file_for_path", {
            path: buildScratchboardPath,
            tabId: activeTabId ?? undefined,
            sessionCwd: activeCwd,
          })
        : await fetch(convertFileSrc(buildScratchboardPath, "asset"))
            .then((response) => (response.ok ? response.text() : ""));
      if (isCurrent()) setBuildScratchboardText((cur) => (cur === text ? cur : text));
    } catch {
      if (isCurrent()) setBuildScratchboardText("");
    }
  }, [activeCwd, activeTabId, buildScratchboardPath]);

  useEventAwarePolling({
    enabled: Boolean(buildScratchboardPath) && !debugBuildRunFixture,
    scopeKey: `build-file:${activeTabId ?? "none"}:${buildScratchboardPath ?? "none"}:${activeCwd ?? ""}`,
    eventRevision: events.length,
    poll: refreshBuildScratchboard,
  });

  useEffect(() => {
    if (debugBuildRunFixture) {
      setBuildScratchboardText(debugBuildRunFixture.scratchboardText);
      return;
    }
    if (!buildScratchboardPath) setBuildScratchboardText("");
  }, [buildScratchboardPath, debugBuildRunFixture]);

 // When App's cache updates with a fresher body, adopt it — but
 // only when non-empty, so an empty/undefined cache can't blank a
 // plan we already fetched ourselves.
  useEffect(() => {
    if (typeof prefetchedPlanText === "string" && prefetchedPlanText.length > 0) {
      setPlanText((cur) => (cur === prefetchedPlanText ? cur : prefetchedPlanText));
    }
  }, [prefetchedPlanText]);

  const refreshPlanFile = useCallback(async (isCurrent: PollCurrent): Promise<void> => {
    if (!planFilePath) return;
 /* WSL sessions emit Linux paths like /home/X/.grok/.../plan.md
 * that asset:// can't reach from a Windows host. The Tauri
 * `read_text_file_for_path` command translates to \\wsl$\<distro>\...
 * when the session has WSL config; falls back to asset:// in
 * browser-only mode.
 * Grok writes
 * plan.md AFTER emitting EnterPlanMode via a separate
 * fs/write_text_file call, so renderer events schedule one trailing,
 * bounded refresh instead of one filesystem read per stream frame. */
    try {
 // activeTabId lets the Rust handler look up the right tab's
 // wsl_distro / sshHost and UNC-translate plan_file_path.
 // Param is camelCase (`tabId`) per the handler's
 // #[allow(non_snake_case)] attribute.
      const text = inTauri()
        ? await invoke<string>("read_text_file_for_path", {
            path: planFilePath,
            tabId: activeTabId ?? undefined,
            sessionCwd: activeCwd,
          })
        : await fetch(convertFileSrc(planFilePath, "asset"))
            .then((response) => (response.ok ? response.text() : ""));
      if (isCurrent()) setPlanText((cur) => (cur === text ? cur : text));
    } catch {
      // Keep the latest readable plan while a remote path is unavailable.
    }
  }, [activeCwd, activeTabId, planFilePath]);

  useEventAwarePolling({
    enabled: Boolean(planFilePath),
    scopeKey: `plan-file:${activeTabId ?? "none"}:${planFilePath ?? "none"}:${activeCwd ?? ""}`,
    eventRevision: events.length,
    poll: refreshPlanFile,
  });

  useEffect(() => {
    if (!planFilePath) setPlanText("");
  }, [planFilePath]);

  const planActive = modeId === "plan";
 // entries from the ACP `plan` sessionUpdate take precedence
 // over the empty/markdown branch. The legacy /goal long-horizon
 // flow ships its plan via this protocol path, NOT via a plan.md
 // file. Without this, legacy /goal runs show "Plan view is empty" even
 // though the orchestrator has a structured plan in hand.
  const hasEntries = planEntries.length > 0;
  const hasBuildScratchboard = renderedBuildState !== null && renderedBuildScratchboardText.trim().length > 0;
  const hasScratchboard = goalActive && goalScratchboardText.trim().length > 0;
  const planEmpty = !hasEntries && !hasBuildScratchboard && !hasScratchboard && (!planFilePath || !planText.trim());
  const planHeaderName = planFilePath
    ? "plan.md"
    : hasBuildScratchboard
      ? (renderedBuildState?.scratchboardPath.split(/[\\\/]/).pop() ?? "build.md")
    : hasScratchboard
      ? (goalScratchboardPath?.split(/[\\\/]/).pop() ?? "build.md")
      : hasEntries
        ? "build steps"
        : "—";
  const planHeaderStatus = planActive
    ? "· active"
    : renderedBuildState
      ? `· build-mode · ${isBuildTerminalStatus(renderedBuildState.status) ? renderedBuildState.status : `${renderedBuildState.continuationsTotal} pushes`}`
      : goalActive
      ? `· build-mode · ${goalContinuationsTotal} pushes`
      : hasEntries
        ? `· ${planEntries.length} steps`
        : (planFilePath || hasScratchboard ? "· last" : "· empty");
  const activeAgentNoun = activeAgentId && activeAgentId !== "grok" ? "provider" : "agent";

  return (
    <>
      <div className="right-head">
        <span className="fname">
          {planHeaderName}
        </span>
        <span className="ftype">
          PLAN {planHeaderStatus}
        </span>
      </div>
 {/* Legacy goal-orchestrator status bar. Renders only when goal_mode
 * is on for the active tab and reuses PlanPane's bounded host state. */}
      {renderedBuildState && (
        <LazySurface label="Build Mode cockpit" variant="inline">
          <BuildRunCockpit
            activeTabId={activeTabId}
            state={renderedBuildState}
            receipts={renderedBuildReceipts}
            scratchboardText={renderedBuildScratchboardText}
            sessionConnected={sessionStatus === "Connected"}
            onConnectActiveTab={onConnectActiveTab}
            onChanged={() => setBuildRefreshSeq((n) => n + 1)}
          />
        </LazySurface>
      )}
      <GoalStatusBar
        activeTabId={activeTabId}
        state={goalState}
        onOpenGoalReview={onOpenGoalReview}
      />
      <div className="plan">
        {planEmpty ? (
          <div className="plan-empty">
            {renderedBuildState ? (
              <>Build Mode is active. Waiting for the scratchboard to
              populate or for the next receipt from this run.</>
            ) : goalActive ? (
              <>Build Mode is active. The {activeAgentNoun} hasn't emitted a structured plan yet
              (and hasn't written to the scratchboard at{" "}
              <code>{goalScratchboardPath?.split(/[\\\/]/).pop() ?? "build.md"}</code>).
              The orchestrator has injected {goalContinuationsTotal} continuation
              {goalContinuationsTotal === 1 ? "" : "s"} so far — it'll keep
              pushing the {activeAgentNoun} until either the build completes or the per-turn
              timeout fires.</>
            ) : planActive ? (
              <>Plan mode is active — waiting for the {activeAgentNoun} to write steps to{" "}
              <code>plan.md</code>. Use <code>enter_plan_mode</code> in
              the prompt, then describe the work; steps land here as
              the {activeAgentNoun} writes them.</>
            ) : (
              <>Plan view is empty. Use <code>/build &lt;objective&gt;</code> to
              start a long-horizon Build Mode run, or call <code>enter_plan_mode</code>{" "}
              in a prompt for a single-turn plan.</>
            )}
          </div>
        ) : hasEntries ? (
 /* ACP `plan` entries: structured checklist with
 * per-step status icon (• pending, ⟳ in_progress, ✓ done)
 * and an optional priority hint. Last snapshot wins (grok
 * re-emits the whole plan on every status change). */
          <div className="plan-entries" onMouseUp={onMouseUpAutoCopy}>
            {planEntries.map((entry, i) => {
              const status = entry.status ?? "pending";
              const icon =
                status === "completed" ? "check" :
                status === "in_progress" ? "loader" : "circle";
              return (
                <div key={i} className={`plan-entry plan-entry-${status}`}>
                  <span className={`plan-entry-glyph plan-entry-glyph-${status}`}>
                    <ShellIcon name={icon} size={14} />
                  </span>
                  <span className="plan-entry-content">{entry.content}</span>
                  {entry.priority && entry.priority !== "medium" && (
                    <span className={`plan-entry-prio plan-entry-prio-${entry.priority}`}>
                      {entry.priority}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        ) : hasBuildScratchboard ? (
 /* Build Mode scratchboard. Host receipts render above this block;
 * the markdown keeps Grok's manager plan and progress visible. */
          <div className="plan-md" onMouseUp={onMouseUpAutoCopy}>
            <div style={{
              fontSize: "var(--fs-ui-xs)", color: "var(--ink-3)",
              padding: "0 0 8px 0", letterSpacing: 0.04,
            }}>
              build · {renderedBuildState?.status ?? "unknown"} · {renderedBuildState?.continuationsTotal ?? 0} continuation{renderedBuildState?.continuationsTotal === 1 ? "" : "s"} · scratchboard
            </div>
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                a: ({ href, children }) => (
                  <SafeMarkdownLink href={href} onPreviewFile={onPreviewFile}>
                    {children}
                  </SafeMarkdownLink>
                ),
              }}
            >{renderedBuildScratchboardText}</ReactMarkdown>
          </div>
        ) : hasScratchboard ? (
 /* #395: Goal scratchboard (goal.md / plan.md under
 * cwd) rendered as markdown. Active legacy /goal sessions write
 * progress here even when grok doesn't emit ACP plan
 * entries. */
          <div className="plan-md" onMouseUp={onMouseUpAutoCopy}>
            {goalActive && (
              <div style={{
                fontSize: "var(--fs-ui-xs)", color: "var(--ink-3)",
                padding: "0 0 8px 0", letterSpacing: 0.04,
              }}>
                build · {goalContinuationsTotal} continuation{goalContinuationsTotal === 1 ? "" : "s"} · scratchboard
              </div>
            )}
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                a: ({ href, children }) => (
                  <SafeMarkdownLink href={href} onPreviewFile={onPreviewFile}>
                    {children}
                  </SafeMarkdownLink>
                ),
              }}
            >{goalScratchboardText}</ReactMarkdown>
          </div>
        ) : (
 /* plan.md is markdown (headings, lists, code fences) —
 * rendered via the shared ReactMarkdown + remarkGfm setup. */
          <div className="plan-md" onMouseUp={onMouseUpAutoCopy}>
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                a: ({ href, children }) => (
                  <SafeMarkdownLink href={href} onPreviewFile={onPreviewFile}>
                    {children}
                  </SafeMarkdownLink>
                ),
              }}
            >{planText}</ReactMarkdown>
          </div>
        )}
      </div>
    </>
  );
}

/* ─────────────── Goal status bar ─────────────── */

/**
 * Hard-enforcement goal-orchestrator status bar above the Plan
 * scratchboard/content. Reuses the parent Plan surface's bounded
 * `get_goal_state` snapshot and renders nothing when goal_mode is off.
 * * Tauri commands:
 * get_goal_state(tabId) → { active, objective, continuationsTotal,
 * startedAtMs, pausedByUser, ... }
 * pause_goal(tabId) → set pausedByUser=true
 * set_goal_mode(tabId, on=true, objective, cwd) → resume / arm
 */
function GoalStatusBar({
  activeTabId,
  state,
  onOpenGoalReview,
}: {
  activeTabId?: string | null;
  state: GoalStatusState | null;
  onOpenGoalReview?: () => void;
}): JSX.Element {
  if (!state || !state.active) return <></>;

  const elapsedMs = Date.now() - state.startedAtMs;
  const elapsedMin = Math.floor(elapsedMs / 60_000);
  const elapsedSec = Math.floor((elapsedMs % 60_000) / 1000);
  const elapsedStr = elapsedMin > 0 ? `${elapsedMin}m${elapsedSec}s` : `${elapsedSec}s`;

  const statusLabel = state.haltedReason
    ? `HALTED · ${state.haltedReason}`
    : state.awaitingApproval
      ? "AWAITING APPROVAL"
      : state.pausedByUser
        ? "PAUSED"
        : "ACTIVE";

  const onTogglePause = (): void => {
    if (!activeTabId || !inTauri()) return;
    if (state.pausedByUser) {
      void invoke("resume_goal", { tabId: activeTabId }).catch(() => {});
    } else {
      void invoke("pause_goal", { tabId: activeTabId }).catch(() => {});
    }
  };

  const approvalReady = state.approvalStatus?.ready === true;
  const approvalWaitingReason =
    state.approvalStatus?.reason ??
    (state.planTurnCompleted
      ? "Waiting for a complete phased build plan."
      : "Waiting for the agent to finish the plan turn.");
 // manual completion fallback. When grok says "all done" in
 // chat but never calls goal_complete, the orchestrator stays armed
 // and keeps injecting continuations. This button calls
 // mark_goal_complete which flips active=false without touching the
 // scratchboard, so the user can close the cycle manually.
  const onMarkComplete = (): void => {
    if (!activeTabId || !inTauri()) return;
    if (!window.confirm("Mark this build as complete? The auto-continuation loop will stop. Use this when the agent finished the work but did not call the completion tool itself.")) return;
    void invoke("mark_goal_complete", { tabId: activeTabId }).catch(() => {});
  };

  return (
    <>
      <div className="goal-status" title={`Build: ${state.objective.slice(0, 200)}`}>
        <span className={`goal-status-pill goal-status-${statusLabel.toLowerCase().replace(/[^a-z]/g, "")}`}>
          <ShellIcon name="activity" size={13} />
          Build {statusLabel}
        </span>
        <span className="goal-status-meta">
          {state.continuationsTotal} cont · {elapsedStr}
        </span>
        {state.awaitingApproval && !state.haltedReason && (
          <>
            {approvalReady ? (
              <button
                type="button"
                className="goal-status-btn goal-status-btn-approve"
                onClick={onOpenGoalReview}
                title="Open the focused plan review dialog."
              >
                Review plan
              </button>
            ) : (
              <span className="goal-status-meta" title={approvalWaitingReason}>
                planning…
              </span>
            )}
          </>
        )}
        {!state.awaitingApproval && !state.haltedReason && (
          <>
            <button
              type="button"
              className="goal-status-btn"
              onClick={onTogglePause}
              title={state.pausedByUser ? "Resume auto-continuation" : "Pause auto-continuation (only user can pause)"}
            >
              <ShellIcon name={state.pausedByUser ? "play" : "pause"} size={12} />
              <span>{state.pausedByUser ? "Resume" : "Pause"}</span>
            </button>
            <button
              type="button"
              className="goal-status-btn goal-status-btn-complete"
              onClick={onMarkComplete}
              title="Mark build as complete — stops the auto-continuation loop. Use when the agent finished but did not call the completion tool itself."
            >
              <ShellIcon name="check" size={12} />
              <span>Mark Complete</span>
            </button>
          </>
        )}
      </div>
    </>
  );
}

/**
 * Walk events forward for the most recent plan-mode state.
 * * Returns [planFilePath, modeId]:
 * planFilePath — string from the latest EnterPlanMode rawOutput,
 * null if plan mode never entered.
 * modeId — "plan" | "default" | undefined per the latest
 * current_mode_update event.
 */
/** Latest ACP `plan` sessionUpdate entries — render as a checklist in
 * PlanPane when present. */
export interface PlanEntry {
  content: string;
  priority?: "high" | "medium" | "low";
  status?: "pending" | "in_progress" | "completed";
}

function extractPlanState(
  events: { kind: string; payload?: unknown }[],
  activeTabId?: string | null,
): [string | null, string | undefined, PlanEntry[]] {
  let planFilePath: string | null = null;
  let modeId: string | undefined;
  let planEntries: PlanEntry[] = [];
  for (const ev of events) {
    const p: any = ev?.payload;
    if (!p) continue;
 // Defense-in-depth tab filter on top of App-level
 // eventsForActiveTab — any untagged plan event slipping through
 // shouldn't pollute another tab's PlanPane.
    const tag = p?._meta?.tabId ?? p?.params?._meta?.tabId ?? null;
    if (activeTabId && tag && tag !== activeTabId) continue;
    if (ev.kind === "plan-event") {
      if (p.kind === "enter_plan_mode" && typeof p.planFilePath === "string") {
        planFilePath = p.planFilePath;
      } else if (p.kind === "current_mode_update" && typeof p.modeId === "string") {
        modeId = p.modeId;
      } else if (p.kind === "plan_update" && Array.isArray(p.entries)) {
 // overwrite with the latest plan entries snapshot.
 // grok ships the WHOLE plan on every update, so last write wins.
        planEntries = p.entries;
      }
      continue;
    }
 // also catch the raw firehose `sessionUpdate:"plan"` form so
 // PlanPane renders even on older builds where the typed plan-event
 // re-emit isn't present yet (e.g. session restored from JSONL with
 // pre-typed-event chunks).
    if (p?.params?.update?.sessionUpdate === "plan" && Array.isArray(p?.params?.update?.entries)) {
      planEntries = p.params.update.entries;
    }
    const update = p?.params?.update;
    if (!update) continue;
    if (update.sessionUpdate === "current_mode_update" && typeof update.currentModeId === "string") {
      modeId = update.currentModeId;
    }
    if (update.sessionUpdate === "tool_call_update") {
      const raw = update.rawOutput;
      if (raw && raw.type === "EnterPlanMode" && raw.Entered?.plan_file_path) {
        planFilePath = raw.Entered.plan_file_path;
      }
    }
  }
  return [planFilePath, modeId, planEntries];
}

// #366: basename + truncMiddle helpers removed; only PreviewPane (now deleted) used them.
