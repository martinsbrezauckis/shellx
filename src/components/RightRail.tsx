/**
 * src/components/RightRail.tsx — right-rail tab container.
 * * Tab order: Tasks (default) | Tools | Git | Preview | Plan | Files.
 * Persisted to localStorage via TAB_KEY.
 * * - Tasks: TasksPanel — running background subprocesses scoped to the
 * active tab. Polling is mount-gated.
 * - Plan: PlanPane — reads grok's plan.md / goal.md scratchboard from disk
 * and re-fetches on each new event. Approval actions live in the modal.
 * - Files: FilesPane — git-aware tree rooted at the active tab's cwd.
 * * PreviewTarget is still exported for legacy file/URL preview callers;
 * WorkPreviewPanel is the right-rail live app preview surface.
 */
import { useEffect, useMemo, useState, type JSX } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import pkg from "../../package.json";
import { onMouseUpAutoCopy } from "../lib/auto-copy-selection";
import { ShikiHighlight } from "./ShikiHighlight";
import { inTauri } from "../lib/tauri-bridge";
import { SafeMarkdownLink } from "../lib/markdown-links";
import { grokSearchCapabilities, shellxRuntimeCapabilities, type SearchCapability } from "../lib/session-capabilities";
import {
  branchNameFromSource,
  gitDirtyTotal,
  gitRepoScopeLabel,
  gitStatusSummary,
  normalizeGitDiffScope,
  type GitCheckpointResponse,
  type GitDiffResponse,
  type GitDiffScope,
  type GitSessionStatus,
  type GitWorktreeResponse,
} from "../lib/git-workflows";
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
import { cleanUpdateNotes, firstUpdateNotesUrl } from "../lib/update-notes";
import { TasksPanel } from "./TasksPanel";
import { BuildRunCockpit } from "./BuildRunCockpit";
import { WorkPreviewPanel } from "./WorkPreviewPanel";
import type { ConnectionPreset, ConnectionProviderScanEntry } from "./ConnectionPicker";
import { AgentCliSetupDialog } from "./AgentCliSetupAssistant";
import { apiPost } from "../lib/debug-api";
import {
  getProviderAdapterState,
  normalizeShellxToolExposure,
  providerDisplayName,
  DEFAULT_SHELLX_TOOL_EXPOSURE,
  type ProviderAdapterSummary,
  type ProviderExecutionTransport,
  type ProviderId,
  type ProviderShellxToolExposure,
} from "../lib/provider-sessions";
import {
  getModelInstructionCards,
  type ModelInstructionCard,
  type ModelInstructionCardsState,
} from "../lib/model-instruction-cards";
import type { WorkPreviewState } from "../lib/work-preview";
import type { RawEventFrame } from "../types/acp";
import { ShellIcon, TransportIcon, type ShellIconName } from "./icons";

export type RightTab = "Tasks" | "Tooling" | "Git" | "Preview" | "Plan" | "Files";
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

function isRightTab(value: string): value is RightTab {
  return value === "Tasks" || value === "Tooling" || value === "Git" || value === "Preview" || value === "Plan" || value === "Files";
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
}

type GrokEnvironmentStatus = "idle" | "pass" | "warn" | "fail";
type GrokMcpFailureCategory =
  | "healthy"
  | "authRequired"
  | "connectionFailed"
  | "commandMissing"
  | "handshakeFailed"
  | "failed";

interface GrokEnvironmentSnapshot {
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

interface GrokTraceExportResult {
  status: GrokEnvironmentStatus;
  sessionId: string;
  outputPath?: string | null;
  stdoutTail?: string | null;
  stderrTail?: string | null;
}

const PROVIDER_IDS: ProviderId[] = ["codex-cli", "claude-code", "antigravity-cli"];
type AgentCliId = "grok" | ProviderId;
const AGENT_CLI_IDS: AgentCliId[] = ["grok", "claude-code", "codex-cli", "antigravity-cli"];

export interface PreviewTarget {
  kind: "file" | "url" | "image" | "markdown" | "diff";
  path: string;
  tabId?: string;
  sessionCwd?: string;
}

export function RightRail({
  preview,
  onPreviewClear,
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
  onOpenWorkPreview,
  onAskGrokToFixPreview,
  onConnectActiveTab,
  activeAgentId = null,
  shellxToolExposure = DEFAULT_SHELLX_TOOL_EXPOSURE,
  onShellxToolExposureChange,
  onProviderScanUpdated,
}: {
  preview: PreviewTarget | null;
  onPreviewClear: () => void;
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
  onOpenWorkPreview?: (state: WorkPreviewState) => void;
  onAskGrokToFixPreview?: (state: WorkPreviewState) => void;
  onConnectActiveTab?: (target?: { tabId?: string | null; cwd?: string | null }) => Promise<boolean> | boolean | void;
  activeAgentId?: string | null;
  shellxToolExposure?: ProviderShellxToolExposure;
  onShellxToolExposureChange?: (mode: ProviderShellxToolExposure) => void;
  onProviderScanUpdated?: (preset: ConnectionPreset, providers: ConnectionProviderScanEntry[]) => void;
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

  return (
    <aside className="right">
 {/* Tab order: Tasks (default) | Tools | Git | Preview | Plan | Files. */}
      <div className="right-tabs tabs">
        {(Object.keys(RIGHT_TAB_META) as RightTab[]).map((rightTab) => {
          const meta = RIGHT_TAB_META[rightTab];
          return (
            <button
              key={rightTab}
              type="button"
              className={`tab ${tab === rightTab ? "active" : ""}`}
              data-debug-id={`right-tab-${rightTab.toLowerCase()}`}
              onClick={() => setTab(rightTab)}
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
        />
      )}
      {tab === "Git" && <GitPane activeTabId={activeTabId ?? null} cwd={cwd} />}
      {tab === "Preview" && (
        <WorkPreviewPanel
          activeTabId={activeTabId ?? null}
          cwd={cwd}
          onStateChange={onWorkPreviewStateChange}
          onOpenPreview={onOpenWorkPreview}
          onAskGrokToFix={onAskGrokToFixPreview}
        />
      )}
      {tab === "Plan"  && <PlanPane autonomy={autonomy} events={events} activeTabId={activeTabId} activeCwd={cwd} activeAgentId={activeAgentId} prefetchedPlanText={prefetchedPlanText} onPreviewFile={onPreviewFile ?? (() => {})} onOpenGoalReview={onOpenGoalReview} sessionStatus={sessionStatus} onConnectActiveTab={onConnectActiveTab} />}
      {tab === "Files" && (
        <FilesPane
          activeTabId={activeTabId ?? null}
          connectionId={connectionId ?? null}
          cwd={cwd}
          onPreviewFile={onPreviewFile ?? (() => {})}
          onAttachPaths={onAttachPaths}
        />
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
}): JSX.Element {
  const [entries, setEntries] = useState<McpEntryStatus[]>([]);
  const [health, setHealth] = useState<Record<string, MarketplaceHealthEntry>>({});
  const [sessionInfo, setSessionInfo] = useState<SessionToolingSnapshot["session"] | null>(null);
  const [connectionPreset, setConnectionPreset] = useState<ConnectionPreset | null>(null);
  const [loading, setLoading] = useState(false);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setEntries([]);
    setHealth({});
    setSessionInfo(null);
    setHasLoaded(false);
    setError(null);
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
  }, [activeTabId, connectionLabel, connectionTransport, connectionId]);

  useEffect(() => {
    setConnectionPreset(null);
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
  }, [connectionId]);

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

      <UpdateDiagnosticsCard />

      <ShellXToolExposureCard
        mode={shellxToolExposure}
        onChange={onShellxToolExposureChange}
      />

      {showGrokEnvironment && (
        <GrokEnvironmentCard
          activeTabId={activeTabId}
          cwd={cwd}
          sessionInfo={sessionInfo}
          onSendPromptToActiveTab={onSendPromptToActiveTab}
        />
      )}

      <ProviderEnvironmentCard
        activeTabId={activeTabId}
        sessionInfo={sessionInfo}
        connectionTransport={connectionTransport}
        connectionPreset={connectionPreset}
        onProviderScanUpdated={onProviderScanUpdated}
      />

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
            <button
              key={option.mode}
              type="button"
              className={`tool-exposure-segment ${normalized === option.mode ? "active" : ""}`}
              title={option.title}
              aria-pressed={normalized === option.mode}
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

function UpdateDiagnosticsCard(): JSX.Element {
  const [state, setState] = useState<UpdateDiagnosticInput>({
    currentVersion: VERSION,
    kind: "idle",
  });
  const [body, setBody] = useState<string>("");

  async function checkForUpdates(): Promise<void> {
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
    if (!inTauri()) return;
    void checkForUpdates();
  }, []);

  const summary = summarizeUpdateDiagnostic(state);
  const releaseNotesUrl = firstUpdateNotesUrl(body);
  const quietError = state.kind === "error" && updateErrorIsQuiet(state.errorMessage);

  return (
    <div className={`tooling-row update-diagnostic update-diagnostic-${summary.accent}`}>
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
          <button type="button" className="mp-action-btn mp-action-btn-primary" onClick={() => void installUpdate()}>
            Install
          </button>
        )}
        <button
          type="button"
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
}: {
  activeTabId: string | null;
  cwd: string;
  sessionInfo: SessionToolingSnapshot["session"] | null;
  onSendPromptToActiveTab?: (text: string) => void;
}): JSX.Element {
  const [snapshot, setSnapshot] = useState<GrokEnvironmentSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [traceBusy, setTraceBusy] = useState(false);
  const [copiedReport, setCopiedReport] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const refresh = async (force = false): Promise<void> => {
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
    setSnapshot(null);
    setMessage(null);
    if (!activeTabId) return;
    void refresh(true);
  }, [activeTabId, cwd, sessionInfo?.hasActiveChild, sessionInfo?.sessionId]);

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
          className="mp-action-btn mp-action-btn-secondary"
          onClick={() => void exportTrace()}
          disabled={!snapshot?.trace.available || traceBusy}
          title={snapshot?.trace.detail ?? "No session id is available yet."}
        >
          <ShellIcon name="file" size={12} />
          Trace
        </button>
        <button
          type="button"
          className="mp-action-btn mp-action-btn-secondary"
          onClick={() => void refresh(true)}
          disabled={!activeTabId || loading}
        >
          <ShellIcon name="refresh" size={12} />
          {loading ? "Checking" : "Refresh"}
        </button>
      </div>
    </div>
  );
}

function ModelInstructionCardsCard(): JSX.Element {
  const [state, setState] = useState<ModelInstructionCardsState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function refresh(showLoading = true): Promise<void> {
    if (showLoading) setLoading(true);
    try {
      const next = await getModelInstructionCards();
      setState(next);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (showLoading) setLoading(false);
    }
  }

  useEffect(() => {
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
  }, []);

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

function ProviderEnvironmentCard({
  activeTabId,
  sessionInfo,
  connectionTransport,
  connectionPreset,
  onProviderScanUpdated,
}: {
  activeTabId: string | null;
  sessionInfo: SessionToolingSnapshot["session"] | null;
  connectionTransport: string;
  connectionPreset: ConnectionPreset | null;
  onProviderScanUpdated?: (preset: ConnectionPreset, providers: ConnectionProviderScanEntry[]) => void;
}): JSX.Element {
  const [adapters, setAdapters] = useState<ProviderAdapterSummary[]>([]);
  const [agentScan, setAgentScan] = useState<ConnectionProviderScanEntry[]>(
    connectionPreset?.providerScan ?? [],
  );
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [setupDialogOpen, setSetupDialogOpen] = useState(false);
  const [setupProviderId, setSetupProviderId] = useState<AgentCliId | null>(null);
  const providerExecution = providerExecutionForSession(
    sessionInfo,
    connectionTransport,
    connectionPreset,
  );
  const persistedAgentScanSignature = providerScanSignature(connectionPreset?.providerScan);

  async function refreshProviderState(): Promise<void> {
    if (!activeTabId) {
      setAdapters([]);
      return;
    }
    const adapterState = await getProviderAdapterState(providerExecution);
    setAdapters(adapterState.providers);
  }

  async function refreshAgentCliScan(): Promise<void> {
    const preset = agentScanPresetForSession(connectionPreset, providerExecution);
    if (!preset) {
      setAgentScan(connectionPreset?.providerScan ?? []);
      return;
    }
    const providers = await invoke<ConnectionProviderScanEntry[]>("connection_provider_scan", { preset });
    setAgentScan(providers);
    onProviderScanUpdated?.(preset, providers);
  }

  async function refreshProviderEnvironment(showLoading = true): Promise<void> {
    if (showLoading) setLoading(true);
    try {
      await Promise.all([refreshProviderState(), refreshAgentCliScan()]);
      setMessage(null);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      if (showLoading) setLoading(false);
    }
  }

  useEffect(() => {
    setAgentScan(connectionPreset?.providerScan ?? []);
  }, [connectionPreset?.id, persistedAgentScanSignature]);

  useEffect(() => {
    setMessage(null);
    if (!activeTabId) return;
    let cancelled = false;
    const refreshState = async () => {
      try {
        const adapterState = await getProviderAdapterState(providerExecution);
        if (cancelled) return;
        setAdapters(adapterState.providers);
      } catch (e) {
        if (!cancelled) setMessage(e instanceof Error ? e.message : String(e));
      }
    };
    void refreshState();
    const id = window.setInterval(() => void refreshState(), 3500);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [
    activeTabId,
    providerExecution.transport,
    providerExecution.wslDistro,
    providerExecution.sshHost,
    providerExecution.sshPort,
    providerExecution.sshKeyVaultRef,
    providerExecution.unsupportedTransport,
    connectionPreset?.id,
  ]);

  const readyCount = AGENT_CLI_IDS.filter((id) =>
    agentCliCanRun(id, agentScan, adapters),
  ).length;
  const cardStatus = loading
    ? { label: "checking", className: "muted" }
    : readyCount > 0
      ? { label: `${readyCount}/${AGENT_CLI_IDS.length} ready`, className: "ok" }
      : { label: "missing", className: "warn" };
  const providerTargetLabel = providerExecution.unsupportedTransport
    ? providerExecution.unsupportedTransport.toUpperCase()
    : providerExecution.transport === "wsl"
      ? `WSL ${providerExecution.wslDistro ?? "unknown"}`
      : providerExecution.transport === "ssh"
        ? `SSH ${providerExecution.sshHost ?? "unknown"}`
      : "Local";
  const providerTargetHint = providerExecution.unsupportedTransport
    ? " · agent CLI checks support local, WSL, and SSH targets"
    : providerExecution.transport === "wsl" && !providerExecution.wslDistro
      ? " · reconnect WSL tab to resolve distro"
      : providerExecution.transport === "ssh" && !providerExecution.sshHost
          ? " · reconnect SSH tab to resolve host"
      : "";
  const setupPreset = agentScanPresetForSession(connectionPreset, providerExecution);
  const setupMissingProviderId = setupPreset
    ? AGENT_CLI_IDS.find((id) => !agentCliCanRun(id, agentScan, adapters)) ?? null
    : null;

  return (
    <div className="tooling-row provider-runner">
      <div className="tooling-row-top">
        <span className="tooling-name">Agent CLIs</span>
        <span className={`tooling-status ${cardStatus.className}`}>{cardStatus.label}</span>
      </div>
      <div className="tooling-detail provider-runner-body">
        <div>
          Target:{" "}
          <code>{providerTargetLabel}</code>
          {providerTargetHint}
        </div>
        <div className="provider-adapter-list">
          {AGENT_CLI_IDS.map((id) => {
            const scan = agentScan.find((item) => item.providerId === id);
            const adapter = id === "grok"
              ? undefined
              : adapters.find((item) => item.providerId === id);
            const status = agentCliStatus(scan, adapter, loading);
            return (
              <div key={id} className="provider-adapter-row">
                <span className={`provider-adapter-dot ${status.className}`} />
                <span className="provider-adapter-main">
                  <strong>{agentCliDisplayName(id)}</strong>
                  <span>{agentCliDetail(id, scan, adapter, loading)}</span>
                </span>
                {!agentCliCanRun(id, agentScan, adapters) && setupPreset && (
                  <button
                    type="button"
                    className="provider-adapter-setup"
                    data-debug-id={`agent-cli-setup-open-${id}`}
                    onClick={() => {
                      setSetupProviderId(id);
                      setSetupDialogOpen(true);
                    }}
                  >
                    Set up
                  </button>
                )}
              </div>
            );
          })}
        </div>
        {setupDialogOpen && setupPreset && (
          <AgentCliSetupDialog
            preset={setupPreset}
            initialProviderId={setupProviderId ?? undefined}
            missingOnly={!setupProviderId}
            onClose={() => {
              setSetupDialogOpen(false);
              setSetupProviderId(null);
            }}
            onSetupChanged={(providers) => {
              setAgentScan(providers);
              onProviderScanUpdated?.(setupPreset, providers);
            }}
          />
        )}
        {message && <div className="tooling-issue">{message}</div>}
      </div>
      <div className="tooling-actions provider-runner-actions">
        {setupMissingProviderId && (
          <button
            type="button"
            className="mp-action-btn mp-action-btn-secondary"
            data-debug-id="agent-cli-setup-open-missing"
            onClick={() => {
              setSetupProviderId(null);
              setSetupDialogOpen(true);
            }}
          >
            <ShellIcon name="plus" size={12} />
            Set up
          </button>
        )}
        <button
          type="button"
          className="mp-action-btn mp-action-btn-secondary"
          onClick={() => void refreshProviderEnvironment()}
          disabled={!activeTabId || loading}
        >
          <ShellIcon name="refresh" size={12} />
          Refresh
        </button>
      </div>
    </div>
  );
}

function providerExecutionForSession(
  sessionInfo: SessionToolingSnapshot["session"] | null,
  connectionTransport: string,
  connectionPreset: ConnectionPreset | null,
): {
  transport: ProviderExecutionTransport;
  wslDistro: string | null;
  sshHost: string | null;
  sshPort?: number;
  sshKeyVaultRef: string | null;
  unsupportedTransport: string | null;
} {
  const hasSessionContext =
    sessionInfo?.hasActiveChild === true ||
    sessionInfo?.hasActiveProviderChild === true ||
    sessionInfo?.hasProviderContext === true;
  if (sessionInfo?.transport === "wsl" && hasSessionContext) {
    const distro = typeof sessionInfo.wslDistro === "string" && sessionInfo.wslDistro.trim()
      ? sessionInfo.wslDistro.trim()
      : null;
    return { transport: "wsl", wslDistro: distro, sshHost: null, sshKeyVaultRef: null, unsupportedTransport: null };
  }
  if (sessionInfo?.transport === "ssh" && hasSessionContext) {
    const host = typeof sessionInfo.sshHost === "string" && sessionInfo.sshHost.trim()
      ? sessionInfo.sshHost.trim()
      : connectionPreset?.transport.kind === "ssh"
        ? connectionPreset.transport.host.trim()
        : null;
    return {
      transport: "ssh",
      wslDistro: null,
      sshHost: host,
      sshPort: typeof sessionInfo.sshPort === "number"
        ? sessionInfo.sshPort
        : connectionPreset?.transport.kind === "ssh"
          ? connectionPreset.transport.port
          : undefined,
      sshKeyVaultRef: typeof sessionInfo.sshKeyVaultRef === "string" && sessionInfo.sshKeyVaultRef.trim()
        ? sessionInfo.sshKeyVaultRef.trim()
        : connectionPreset?.transport.kind === "ssh"
          ? connectionPreset.transport.keyVaultRef ?? null
          : null,
      unsupportedTransport: null,
    };
  }
  if (sessionInfo?.transport === "local" && hasSessionContext) {
    return { transport: "local", wslDistro: null, sshHost: null, sshKeyVaultRef: null, unsupportedTransport: null };
  }
  if (
    sessionInfo?.hasActiveChild &&
    sessionInfo.transport &&
    !["none", "local", "ssh"].includes(sessionInfo.transport)
  ) {
    return { transport: "local", wslDistro: null, sshHost: null, sshKeyVaultRef: null, unsupportedTransport: sessionInfo.transport };
  }
  if (connectionPreset?.transport.kind === "wsl") {
    return {
      transport: "wsl",
      wslDistro: connectionPreset.transport.distro?.trim() || null,
      sshHost: null,
      sshKeyVaultRef: null,
      unsupportedTransport: null,
    };
  }
  if (connectionPreset?.transport.kind === "ssh") {
    return {
      transport: "ssh",
      wslDistro: null,
      sshHost: connectionPreset.transport.host?.trim() || null,
      sshPort: connectionPreset.transport.port,
      sshKeyVaultRef: connectionPreset.transport.keyVaultRef ?? null,
      unsupportedTransport: null,
    };
  }
  if (connectionPreset?.transport.kind && connectionPreset.transport.kind !== "local") {
    return {
      transport: "local",
      wslDistro: null,
      sshHost: null,
      sshKeyVaultRef: null,
      unsupportedTransport: connectionPreset.transport.kind,
    };
  }
  if (connectionTransport === "wsl") {
    return { transport: "wsl", wslDistro: null, sshHost: null, sshKeyVaultRef: null, unsupportedTransport: null };
  }
  if (connectionTransport === "ssh") {
    return { transport: "ssh", wslDistro: null, sshHost: null, sshKeyVaultRef: null, unsupportedTransport: null };
  }
  if (connectionTransport && connectionTransport !== "local") {
    return { transport: "local", wslDistro: null, sshHost: null, sshKeyVaultRef: null, unsupportedTransport: connectionTransport };
  }
  return { transport: "local", wslDistro: null, sshHost: null, sshKeyVaultRef: null, unsupportedTransport: null };
}

function agentScanPresetForSession(
  connectionPreset: ConnectionPreset | null,
  execution: {
    transport: ProviderExecutionTransport;
    wslDistro: string | null;
    sshHost: string | null;
    sshPort?: number;
    sshKeyVaultRef: string | null;
    unsupportedTransport: string | null;
  },
): ConnectionPreset | null {
  if (connectionPreset && ["local", "wsl", "ssh"].includes(connectionPreset.transport.kind)) {
    return connectionPreset;
  }
  if (execution.unsupportedTransport) return null;
  if (execution.transport === "local") {
    return {
      id: "",
      label: "Current local",
      transport: { kind: "local" },
      createdMs: 0,
      lastUsedMs: 0,
    };
  }
  if (execution.transport === "wsl" && execution.wslDistro) {
    return {
      id: "",
      label: `WSL ${execution.wslDistro}`,
      transport: { kind: "wsl", distro: execution.wslDistro, grokPath: "" },
      createdMs: 0,
      lastUsedMs: 0,
    };
  }
  if (execution.transport === "ssh" && execution.sshHost) {
    return {
      id: "",
      label: `SSH ${execution.sshHost}`,
      transport: {
        kind: "ssh",
        host: execution.sshHost,
        port: execution.sshPort,
        keyVaultRef: execution.sshKeyVaultRef ?? undefined,
        remoteGrokPath: "grok",
      },
      createdMs: 0,
      lastUsedMs: 0,
    };
  }
  return null;
}

function providerScanSignature(scan: ConnectionProviderScanEntry[] | undefined): string {
  return (scan ?? [])
    .map((provider) => [
      provider.providerId,
      provider.canRun ? "1" : "0",
      provider.binary ?? "",
      provider.version ?? "",
    ].join("|"))
    .sort()
    .join("\n");
}

function agentCliCanRun(
  id: AgentCliId,
  scan: ConnectionProviderScanEntry[],
  adapters: ProviderAdapterSummary[],
): boolean {
  const scanned = scan.find((item) => item.providerId === id);
  if (scanned) return scanned.canRun;
  if (id === "grok") return false;
  return Boolean(adapters.find((item) => item.providerId === id)?.canRun);
}

function agentCliDisplayName(id: AgentCliId): string {
  if (id === "grok") return "Grok Build CLI";
  return providerDisplayName(id);
}

function agentCliStatus(
  scan: ConnectionProviderScanEntry | undefined,
  adapter: ProviderAdapterSummary | undefined,
  loading: boolean,
): { label: string; className: string } {
  if (scan) return scan.canRun ? { label: "ready", className: "ok" } : { label: "missing", className: "warn" };
  return providerAdapterStatus(adapter, loading);
}

function agentCliDetail(
  id: AgentCliId,
  scan: ConnectionProviderScanEntry | undefined,
  adapter: ProviderAdapterSummary | undefined,
  loading: boolean,
): string {
  if (scan) {
    return scan.canRun
      ? scan.version ?? scan.binary ?? "ready"
      : "missing CLI";
  }
  if (id === "grok") return loading ? "checking" : "not scanned";
  if (adapter) {
    return `${adapter.streamKind} - ${adapter.version ?? adapter.binary ?? "installed"}${adapter.canRun ? "" : " - missing CLI"}`;
  }
  return loading ? "checking" : "not scanned";
}

function providerAdapterStatus(
  adapter: ProviderAdapterSummary | undefined,
  loading: boolean,
): { label: string; className: string } {
  if (loading || !adapter) return { label: "checking", className: "muted" };
  if (adapter.canRun) return { label: "ready", className: "ok" };
  return { label: "missing", className: "warn" };
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

function buildGrokEnvironmentReport(snapshot: GrokEnvironmentSnapshot): string {
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
          <button
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

/* ─────────────── Git tab ─────────────── */

function GitPane({
  activeTabId,
  cwd,
}: {
  activeTabId: string | null;
  cwd: string;
}): JSX.Element {
  const [status, setStatus] = useState<GitSessionStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [diffScope, setDiffScope] = useState<GitDiffScope>("head");
  const [diff, setDiff] = useState<GitDiffResponse | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [actionMessage, setActionMessage] = useState<string | null>(null);

  const refresh = async (): Promise<void> => {
    if (!activeTabId || !inTauri()) return;
    setLoading(true);
    try {
      const next = await invoke<GitSessionStatus>("git_session_status", {
        cwd: cwd || null,
        tabId: activeTabId,
      });
      setStatus(next);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  const loadDiff = async (scopeInput: GitDiffScope): Promise<void> => {
    if (!activeTabId || !inTauri()) return;
    const scope = normalizeGitDiffScope(scopeInput);
    setDiffScope(scope);
    setDiffLoading(true);
    try {
      const next = await invoke<GitDiffResponse>("git_session_diff", {
        cwd: cwd || null,
        tabId: activeTabId,
        scope,
      });
      setDiff(next);
    } catch (e) {
      setDiff({
        ok: false,
        scope,
        repoRoot: status?.repoRoot ?? null,
        branch: status?.branch ?? null,
        diff: "",
        truncated: false,
        bytes: 0,
        lastError: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setDiffLoading(false);
    }
  };

  useEffect(() => {
    setStatus(null);
    setDiff(null);
    setError(null);
    setActionMessage(null);
    if (!activeTabId || !inTauri()) return;
    let cancelled = false;
    const tick = async () => {
      setLoading(true);
      try {
        const next = await invoke<GitSessionStatus>("git_session_status", {
          cwd: cwd || null,
          tabId: activeTabId,
        });
        if (!cancelled) {
          setStatus(next);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void tick();
    const id = window.setInterval(() => void tick(), 6000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [activeTabId, cwd]);

  async function createCheckpoint(): Promise<void> {
    if (!activeTabId) return;
    setActionMessage("Creating checkpoint...");
    try {
      const res = await invoke<GitCheckpointResponse>("git_session_create_checkpoint", {
        cwd: cwd || null,
        tabId: activeTabId,
        label: `Before review ${new Date().toLocaleString()}`,
      });
      if (!res.ok || !res.checkpoint) {
        setActionMessage(res.lastError || "Checkpoint failed.");
      } else {
        setActionMessage(`Checkpoint saved: ${res.checkpoint.label}`);
        await refresh();
      }
    } catch (e) {
      setActionMessage(e instanceof Error ? e.message : String(e));
    }
  }

  async function createWorktree(): Promise<void> {
    if (!activeTabId || !status?.ok) return;
    const sourceBranch = status.branch || "HEAD";
    const newBranch = branchNameFromSource(sourceBranch);
    setActionMessage(`Creating ${newBranch}...`);
    try {
      const res = await invoke<GitWorktreeResponse>("git_session_create_worktree", {
        cwd: cwd || null,
        tabId: activeTabId,
        sourceBranch,
        newBranch,
      });
      if (!res.ok) {
        setActionMessage(res.lastError || "Worktree creation failed.");
      } else {
        setActionMessage(`Worktree ready: ${res.worktreePath}`);
        await refresh();
      }
    } catch (e) {
      setActionMessage(e instanceof Error ? e.message : String(e));
    }
  }

  if (!activeTabId) {
    return (
      <div className="rail-empty">
        <div className="rail-empty-line">No active session.</div>
        <div className="rail-empty-hint">Open or start a tab to inspect repository state.</div>
      </div>
    );
  }

  if (!inTauri()) {
    return (
      <div className="rail-empty">
        <div className="rail-empty-line">Git checks need Tauri.</div>
        <div className="rail-empty-hint">The desktop backend runs git inside the active tab environment.</div>
      </div>
    );
  }

  const dirtyTotal = status?.ok ? gitDirtyTotal(status) : 0;
  const ready = status?.ok === true;

  return (
    <div className="git-pane">
      <div className="git-head">
        <div>
          <div className="git-title">Session Git</div>
          <div className="git-subtitle">{status ? gitStatusSummary(status) : "Checking repository..."}</div>
        </div>
        <button type="button" className="mp-action-btn mp-action-btn-secondary" onClick={() => void refresh()} disabled={loading}>
          <ShellIcon name="refresh" size={12} />
        </button>
      </div>

      {error && (
        <div className="rail-empty tooling-error">
          <div className="rail-empty-line">Git snapshot failed.</div>
          <div className="rail-empty-hint"><code>{error}</code></div>
        </div>
      )}

      {!error && loading && !status && (
        <div className="rail-empty"><div className="rail-empty-line">Checking git...</div></div>
      )}

      {!error && status && !status.ok && (
        <div className="rail-empty">
          <div className="rail-empty-line">No git repository detected.</div>
          <div className="rail-empty-hint"><code>{status.lastError ?? status.cwd}</code></div>
        </div>
      )}

      {ready && status && (
        <>
          <div className="git-card">
            <div className="git-row">
              <span>Repository</span>
              <code title={status.repoRoot ?? status.cwd}>{status.repoName ?? status.repoRoot ?? status.cwd}</code>
            </div>
            <div className="git-row">
              <span>Scope</span>
              <code title={status.repoCwd}>{gitRepoScopeLabel(status)}</code>
            </div>
            <div className="git-row">
              <span>Branch</span>
              <code>{status.branch ?? "detached"}</code>
            </div>
            <div className="git-row">
              <span>Transport</span>
              <span className="git-pill"><TransportIcon value={status.transport} size={12} /> {status.transport}</span>
            </div>
            {status.upstream && (
              <div className="git-row">
                <span>Upstream</span>
                <code>{status.upstream}</code>
              </div>
            )}
          </div>

          <div className="git-metrics" aria-label="Git change counters">
            <GitMetric label="Staged" value={status.staged} tone={status.staged ? "ok" : "muted"} />
            <GitMetric label="Unstaged" value={status.unstaged} tone={status.unstaged ? "warn" : "muted"} />
            <GitMetric label="Untracked" value={status.untracked} tone={status.untracked ? "warn" : "muted"} />
            <GitMetric label="Conflicts" value={status.conflicts} tone={status.conflicts ? "bad" : "muted"} />
          </div>

          <div className="git-actions">
            <button type="button" className="mp-action-btn mp-action-btn-primary" onClick={() => void loadDiff("head")}>
              <ShellIcon name="file" size={12} />
              Review diff
            </button>
            <button type="button" className="mp-action-btn mp-action-btn-secondary" onClick={() => void createCheckpoint()} disabled={loading}>
              <ShellIcon name="check" size={12} />
              Checkpoint
            </button>
            <button type="button" className="mp-action-btn mp-action-btn-secondary" onClick={() => void createWorktree()}>
              <ShellIcon name="git-branch" size={12} />
              Worktree
            </button>
          </div>

          {actionMessage && <div className="git-action-message">{actionMessage}</div>}

          <div className="tooling-section-label">Diff review</div>
          <div className="git-diff-tabs">
            {(["head", "working", "staged", "lastCommit"] as GitDiffScope[]).map((scope) => (
              <button
                key={scope}
                type="button"
                className={diffScope === scope ? "active" : ""}
                onClick={() => void loadDiff(scope)}
              >
                {scope === "lastCommit" ? "last commit" : scope}
              </button>
            ))}
          </div>
          {diffLoading && <div className="rail-empty"><div className="rail-empty-line">Loading diff...</div></div>}
          {diff && !diffLoading && (
            <div className="git-diff-box" onMouseUp={onMouseUpAutoCopy}>
              {!diff.ok && <div className="git-action-message bad">{diff.lastError ?? "Diff failed."}</div>}
              {diff.ok && diff.diff.trim().length === 0 && (
                <div className="rail-empty">
                  <div className="rail-empty-line">No changes in this scope.</div>
                  <div className="rail-empty-hint">{dirtyTotal === 0 ? "The worktree is clean." : "Try another diff scope."}</div>
                </div>
              )}
              {diff.ok && diff.diff.trim().length > 0 && (
                <ShikiHighlight code={diff.diff} path={`session-${diff.scope}.diff`} />
              )}
              {diff.truncated && <div className="git-action-message">Large diff truncated at rail preview limit.</div>}
            </div>
          )}

          <div className="tooling-section-label">Checkpoints</div>
          <div className="git-list">
            {status.checkpoints.length === 0 ? (
              <div className="git-muted">No local shellX checkpoints yet.</div>
            ) : status.checkpoints.slice(0, 5).map((cp) => (
              <div className="git-list-row" key={cp.id} title={cp.path}>
                <span>{cp.label}</span>
                <code>{new Date(cp.createdAtMs).toLocaleString()}</code>
              </div>
            ))}
          </div>

          <div className="tooling-section-label">Worktrees</div>
          <div className="git-list">
            {status.worktrees.length === 0 ? (
              <div className="git-muted">No git worktrees reported.</div>
            ) : status.worktrees.slice(0, 5).map((wt) => (
              <div className="git-list-row" key={wt.path} title={wt.path}>
                <span>{wt.branch ?? (wt.detached ? "detached" : "worktree")}</span>
                <code>{wt.path}</code>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function GitMetric({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "ok" | "warn" | "bad" | "muted";
}): JSX.Element {
  return (
    <div className={`git-metric git-metric-${tone}`}>
      <span>{value}</span>
      <small>{label}</small>
    </div>
  );
}

/* ─────────────── Files tab ─────────────── */

/**
 * Files panel — git-aware tree of the active project's worktree.
 * Backed by the `list_project_files` Tauri command (fs walk +
 * `git status --porcelain` respecting .gitignore). Click a file row
 * to invoke onPreviewFile; directories drill down into a relative
 * subpath kept in local state.
 */

type FileGit = "M" | "A" | "D" | "U" | null;

interface FileNode {
  name: string;
  kind: "dir" | "file";
  git?: FileGit;
  children?: FileNode[];
 /** UI-only — initial collapse state */
  defaultExpanded?: boolean;
}

interface FsEntry {
  name: string;
  kind: "dir" | "file";
  size: number;
  git_status: string | null;
}

function joinDisplayPath(base: string, child: string): string {
  const windowsStyle = /^[A-Za-z]:[\\/]/.test(base) || base.includes("\\");
  const sep = windowsStyle ? "\\" : "/";
  const normalizedChild = windowsStyle ? child.replace(/\//g, "\\") : child.replace(/\\/g, "/");
  return `${base.replace(/[\\/]$/, "")}${sep}${normalizedChild.replace(/^[\\/]/, "")}`;
}

function normalizeFolderPath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) return "";
  const windowsStyle = /^[A-Za-z]:[\\/]/.test(trimmed) || trimmed.startsWith("\\\\") || trimmed.includes("\\");
  if (!windowsStyle) {
    const normalized = trimmed.replace(/\\/g, "/").replace(/\/+/g, "/");
    if (normalized === "/") return "/";
    return normalized.replace(/\/+$/, "") || "/";
  }
  const normalized = trimmed.replace(/\//g, "\\");
  if (/^[A-Za-z]:\\?$/.test(normalized)) return `${normalized.slice(0, 2)}\\`;
  if (normalized.startsWith("\\\\")) {
    const parts = normalized.split("\\").filter(Boolean);
    if (parts.length <= 2) return `\\\\${parts.join("\\")}`;
    return `\\\\${parts.join("\\")}`.replace(/\\+$/, "");
  }
  return normalized.replace(/\\+$/, "");
}

function parentFolderPath(path: string): string | null {
  const normalized = normalizeFolderPath(path);
  if (!normalized) return null;
  const windowsStyle = /^[A-Za-z]:[\\/]/.test(normalized) || normalized.startsWith("\\\\") || normalized.includes("\\");
  if (!windowsStyle) {
    if (normalized === "/") return null;
    const idx = normalized.lastIndexOf("/");
    return idx <= 0 ? "/" : normalized.slice(0, idx);
  }
  if (/^[A-Za-z]:\\?$/.test(normalized)) return null;
  if (normalized.startsWith("\\\\")) {
    const parts = normalized.split("\\").filter(Boolean);
    if (parts.length <= 2) return null;
    return `\\\\${parts.slice(0, -1).join("\\")}`;
  }
  const idx = normalized.lastIndexOf("\\");
  if (idx < 0) return null;
  if (idx === 2 && /^[A-Za-z]:/.test(normalized)) return `${normalized.slice(0, 2)}\\`;
  return normalized.slice(0, idx);
}

function folderPathsEqual(a: string, b: string): boolean {
  const left = normalizeFolderPath(a);
  const right = normalizeFolderPath(b);
  const windowsStyle = /^[A-Za-z]:[\\/]/.test(left) || left.startsWith("\\\\") || left.includes("\\")
    || /^[A-Za-z]:[\\/]/.test(right) || right.startsWith("\\\\") || right.includes("\\");
  return windowsStyle ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function folderDisplayLabel(path: string, cwd: string): string {
  const folder = normalizeFolderPath(path);
  const root = normalizeFolderPath(cwd);
  if (!folder) return "/";
  if (folderPathsEqual(folder, root)) {
    const parts = folder.split(/[\\/]/).filter(Boolean);
    return parts.at(-1) ?? folder;
  }
  const windowsStyle = folder.includes("\\") || root.includes("\\");
  const sep = windowsStyle ? "\\" : "/";
  const comparableFolder = windowsStyle ? folder.toLowerCase() : folder;
  const comparableRoot = windowsStyle ? root.toLowerCase() : root;
  if (comparableRoot && comparableFolder.startsWith(`${comparableRoot}${sep}`)) {
    return `.../${folder.slice(root.length + 1).replace(/\\/g, "/")}`;
  }
  return folder;
}

/* Walks one level under the current folder, sorts dirs-first then alpha.
 * Dir click drills down by absolute path; file click invokes
 * onPreviewFile with the absolute path. */
function FilesPane({
  activeTabId,
  connectionId,
  cwd,
  onPreviewFile,
  onAttachPaths,
}: {
  activeTabId?: string | null;
  connectionId?: string | null;
  cwd: string;
  onPreviewFile: (path: string) => void;
  onAttachPaths?: (paths: string[]) => void;
}): JSX.Element {
  const [currentFolder, setCurrentFolder] = useState(() => normalizeFolderPath(cwd));
  const [entries, setEntries] = useState<FsEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(() => new Set());
  const [fileQuery, setFileQuery] = useState("");

  const fullPath = normalizeFolderPath(currentFolder || cwd);
  const cwdFolder = normalizeFolderPath(cwd);
  const parentFolder = parentFolderPath(currentFolder);
  const atSessionFolder = folderPathsEqual(currentFolder, cwd);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setEntries(null);
    if (!cwd || !inTauri()) return;
    (async () => {
      try {
        const res = await invoke<FsEntry[]>("list_project_files", {
          path: fullPath,
          tabId: activeTabId ?? undefined,
          connectionId: connectionId ?? undefined,
        });
        if (!cancelled) setEntries(res);
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
    })();
    return () => { cancelled = true; };
  }, [fullPath, cwd, activeTabId, connectionId]);

  // Reset drill-down whenever the cwd changes (e.g. folder pill picks a new dir).
  useEffect(() => {
    setCurrentFolder(normalizeFolderPath(cwd));
    setFileQuery("");
  }, [cwd]);
  useEffect(() => { setSelectedPaths(new Set()); }, [fullPath]);

  const goUp = () => {
    const parent = parentFolderPath(currentFolder);
    if (!parent) return;
    setCurrentFolder(parent);
    setFileQuery("");
  };
  const enterDir = (name: string) => {
    setCurrentFolder(joinDisplayPath(fullPath, name));
    setFileQuery("");
  };
  const resetFolderToCwd = () => {
    setCurrentFolder(cwdFolder);
    setFileQuery("");
  };
  const toggleSelected = (path: string): void => {
    setSelectedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };
  const attachPaths = (paths: string[]): void => {
    if (paths.length === 0 || !onAttachPaths) return;
    onAttachPaths(paths);
    setSelectedPaths(new Set());
  };
  const selectedCount = selectedPaths.size;
  const canAttach = Boolean(onAttachPaths);
  const trimmedFileQuery = fileQuery.trim().toLowerCase();
  const visibleEntries = useMemo(() => {
    if (!entries) return null;
    if (!trimmedFileQuery) return entries;
    return entries.filter((entry) => {
      const git = entry.git_status?.toLowerCase() ?? "";
      return entry.name.toLowerCase().includes(trimmedFileQuery) || git.includes(trimmedFileQuery);
    });
  }, [entries, trimmedFileQuery]);

  return (
    <div className="fileview">
      <div className="fv-head">
        <span className="fv-path" title={fullPath}>
          {folderDisplayLabel(fullPath, cwd)}
        </span>
        <label className="fv-search" title="Search current folder">
          <ShellIcon name="search" size={12} />
          <input
            type="search"
            data-debug-id="files-search-input"
            value={fileQuery}
            onChange={(event) => setFileQuery(event.target.value)}
            placeholder="Search"
            aria-label="Search current folder"
          />
        </label>
        {selectedCount > 0 && (
          <div className="fv-selection" aria-label={`${selectedCount} selected file${selectedCount === 1 ? "" : "s"}`}>
            <span>{selectedCount} selected</span>
            <button
              type="button"
              className="fv-action"
              onClick={() => attachPaths(Array.from(selectedPaths))}
              disabled={!canAttach}
              title={canAttach ? "Attach selected files to the composer" : "Attach handler unavailable"}
            >
              <ShellIcon name="paperclip" size={12} />
              Attach
            </button>
            <button
              type="button"
              className="fv-action fv-action-icon"
              onClick={() => setSelectedPaths(new Set())}
              title="Clear selected files"
              aria-label="Clear selected files"
            >
              <ShellIcon name="close" size={12} />
            </button>
          </div>
        )}
        {parentFolder && (
          <button type="button" className="fv-up" onClick={goUp} title="Up one level">
            <ShellIcon name="arrow-up" size={13} />
          </button>
        )}
        {!atSessionFolder && (
          <button type="button" className="fv-up" onClick={resetFolderToCwd} title="Back to session folder">
            <ShellIcon name="rotate" size={13} />
          </button>
        )}
      </div>
      {error && (
        <div className="rail-empty">
          <div className="rail-empty-line">Can't list files.</div>
          <div className="rail-empty-hint"><code>{error}</code></div>
        </div>
      )}
      {!error && entries === null && (
        <div className="rail-empty"><div className="rail-empty-line">Loading…</div></div>
      )}
      {!error && entries && entries.length === 0 && (
        <div className="rail-empty"><div className="rail-empty-line">Empty folder.</div></div>
      )}
      {!error && entries && entries.length > 0 && visibleEntries?.length === 0 && (
        <div className="rail-empty">
          <div className="rail-empty-line">No files match.</div>
          <div className="rail-empty-hint"><code>{fileQuery}</code></div>
        </div>
      )}
      {!error && visibleEntries && visibleEntries.map((e) => {
        const fullChild = joinDisplayPath(fullPath, e.name);
        const isSelected = selectedPaths.has(fullChild);
        return (
        <div
          key={e.name}
          className={`fv-row ${e.kind}${isSelected ? " selected" : ""}`}
          aria-selected={e.kind === "file" ? isSelected : undefined}
 /* File rows are draggable onto the composer. Custom MIME
 * `application/x-shellx-file` prevents unrelated drag
 * sources (browser address bar, etc.) from attaching.
 * Directories are non-draggable — folder attach has no
 * semantics in the current pipeline. */
          draggable={e.kind === "file"}
          onDragStart={(ev) => {
            if (e.kind !== "file") { ev.preventDefault(); return; }
            ev.dataTransfer.setData("application/x-shellx-file", fullChild);
            ev.dataTransfer.effectAllowed = "copy";
          }}
          onClick={() => {
            if (e.kind === "dir") enterDir(e.name);
            else onPreviewFile(fullChild);
          }}
          title={`${e.kind} · ${e.size} bytes${e.kind === "file" ? " · select, attach, or drag onto composer" : ""}`}
          style={{ cursor: e.kind === "file" ? "pointer" : "pointer" }}
        >
          {e.kind === "file" && (
            <button
              type="button"
              className={`fv-select ${isSelected ? "active" : ""}`}
              onClick={(ev) => {
                ev.stopPropagation();
                toggleSelected(fullChild);
              }}
              title={isSelected ? "Remove from selection" : "Select file"}
              aria-label={isSelected ? `Remove ${e.name} from selection` : `Select ${e.name}`}
            >
              <ShellIcon name={isSelected ? "check" : "square"} size={12} />
            </button>
          )}
          {e.kind === "dir" && <span className="fv-select-spacer" />}
          <span className="fv-ic">
            <ShellIcon name={e.kind === "dir" ? "folder" : "file"} size={14} />
          </span>
          <span className="fv-name">{e.name}</span>
          {e.kind === "file" && (
            <span className="fv-row-actions">
              <button
                type="button"
                className="fv-row-action"
                onClick={(ev) => {
                  ev.stopPropagation();
                  attachPaths([fullChild]);
                }}
                disabled={!canAttach}
                title={canAttach ? "Attach this file to the composer" : "Attach handler unavailable"}
                aria-label={`Attach ${e.name}`}
              >
                <ShellIcon name="paperclip" size={12} />
              </button>
            </span>
          )}
        </div>
        );
      })}
    </div>
  );
}


// #366: dead code pruned: PreviewPane, FilesNode (recursive tree),
// inferKind, ImagePreview, MarkdownPreview, UrlPreview, CodePreview,
// ErrorPreview, useFileText (~200 LOC). The Preview tab was moved
// out of RightRail to App-level FilePreviewModal in ; these
// helpers became unreachable. Files tab uses FilesPane (further
// down) which is a flat one-level walk via list_project_files.


/* ─────────────── Plan ─────────────── */

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
 // the plan file is fetched via asset://. Re-runs on every events
 // change (cheap; plan files are small). The extractPlanState walk
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
  const [goalScratchboardPath, setGoalScratchboardPath] = useState<string | null>(null);
  const [goalScratchboardText, setGoalScratchboardText] = useState<string>("");
  const [goalActive, setGoalActive] = useState<boolean>(false);
  const [goalContinuationsTotal, setGoalContinuationsTotal] = useState<number>(0);
  const [buildState, setBuildState] = useState<BuildRunState | null>(null);
  const [buildReceipts, setBuildReceipts] = useState<BuildReceipt[]>([]);
  const [buildScratchboardText, setBuildScratchboardText] = useState<string>("");
  const [buildRefreshSeq, setBuildRefreshSeq] = useState(0);
  useEffect(() => {
    if (!inTauri() || !activeTabId) return;
    let cancelled = false;
    const poll = () => {
      void invoke<unknown>("get_goal_state", { tabId: activeTabId })
        .then((st: any) => {
          if (cancelled) return;
          if (!st || !st.active) {
            setGoalActive(false);
            setGoalScratchboardPath(null);
            setGoalScratchboardText("");
            return;
          }
          setGoalActive(true);
          setGoalContinuationsTotal(st.continuationsTotal ?? 0);
          const p = st.scratchboardPath ?? null;
          setGoalScratchboardPath((cur) => (cur === p ? cur : p));
        })
        .catch(() => {});
    };
    poll();
 // Re-poll on every new event (cheap) so the scratchboard surfaces
 // promptly after a continuation injects + grok writes.
    const id = window.setInterval(poll, 2500);
    return () => { cancelled = true; window.clearInterval(id); };
  }, [activeTabId, events.length]);
  useEffect(() => {
    if (!inTauri() || !activeTabId) {
      setBuildState(null);
      setBuildReceipts([]);
      return;
    }
    let cancelled = false;
    const poll = () => {
      void getBuildState(activeTabId)
        .then((st) => {
          if (cancelled) return;
          setBuildState(st);
          if (!st) {
            setBuildReceipts([]);
            return;
          }
          void getBuildReceipts(activeTabId)
            .then((rows) => { if (!cancelled) setBuildReceipts(rows); })
            .catch(() => { if (!cancelled) setBuildReceipts([]); });
        })
        .catch(() => {
          if (!cancelled) {
            setBuildState(null);
            setBuildReceipts([]);
          }
        });
    };
    poll();
    const id = window.setInterval(poll, 2500);
    return () => { cancelled = true; window.clearInterval(id); };
  }, [activeTabId, events.length, buildRefreshSeq]);
  useEffect(() => {
    if (!goalScratchboardPath) { setGoalScratchboardText(""); return; }
    let cancelled = false;
    const set = (t: string) => {
      if (cancelled) return;
      setGoalScratchboardText((cur) => (cur === t ? cur : t));
    };
    if (inTauri()) {
      void invoke<string>("read_text_file_for_path", {
        path: goalScratchboardPath,
        tabId: activeTabId ?? undefined,
        sessionCwd: activeCwd,
      }).then(set).catch(() => set(""));
    } else {
      const url = convertFileSrc(goalScratchboardPath, "asset");
      fetch(url).then((r) => (r.ok ? r.text() : "")).then(set).catch(() => set(""));
    }
    return () => { cancelled = true; };
  }, [goalScratchboardPath, events.length, activeTabId]);
  useEffect(() => {
    const path = buildState?.scratchboardPath;
    if (!path) { setBuildScratchboardText(""); return; }
    let cancelled = false;
    const set = (t: string) => {
      if (cancelled) return;
      setBuildScratchboardText((cur) => (cur === t ? cur : t));
    };
    if (inTauri()) {
      void invoke<string>("read_text_file_for_path", {
        path,
        tabId: activeTabId ?? undefined,
        sessionCwd: activeCwd,
      }).then(set).catch(() => set(""));
    } else {
      const url = convertFileSrc(path, "asset");
      fetch(url).then((r) => (r.ok ? r.text() : "")).then(set).catch(() => set(""));
    }
    return () => { cancelled = true; };
  }, [buildState?.scratchboardPath, events.length, activeTabId]);

 // When App's cache updates with a fresher body, adopt it — but
 // only when non-empty, so an empty/undefined cache can't blank a
 // plan we already fetched ourselves.
  useEffect(() => {
    if (typeof prefetchedPlanText === "string" && prefetchedPlanText.length > 0) {
      setPlanText((cur) => (cur === prefetchedPlanText ? cur : prefetchedPlanText));
    }
  }, [prefetchedPlanText]);

  useEffect(() => {
    if (!planFilePath) { setPlanText(""); return; }
    let cancelled = false;
 /* WSL sessions emit Linux paths like /home/X/.grok/.../plan.md
 * that asset:// can't reach from a Windows host. The Tauri
 * `read_text_file_for_path` command translates to \\wsl$\<distro>\...
 * when the session has WSL config; falls back to asset:// in
 * browser-only mode.
 * * `events.length` is in the deps so we re-fetch on EVERY new
 * event, not just when planFilePath first appears. Grok writes
 * plan.md AFTER emitting EnterPlanMode via a separate
 * fs/write_text_file call, so the first fetch lands an empty
 * file; re-running on each event picks up content as soon as
 * grok writes it. The cancelled flag + setPlanText-only-if-
 * changed prevents render flicker. */
    const fetchAndSet = (t: string) => {
      if (cancelled) return;
      setPlanText((cur) => (cur === t ? cur : t));
    };
    if (inTauri()) {
 // activeTabId lets the Rust handler look up the right tab's
 // wsl_distro / sshHost and UNC-translate plan_file_path.
 // Param is camelCase (`tabId`) per the handler's
 // #[allow(non_snake_case)] attribute.
      void invoke<string>("read_text_file_for_path", {
        path: planFilePath,
        tabId: activeTabId ?? undefined,
        sessionCwd: activeCwd,
      })
        .then(fetchAndSet)
        .catch(() => {});
    } else {
      const url = convertFileSrc(planFilePath, "asset");
      fetch(url)
        .then((r) => (r.ok ? r.text() : ""))
        .then(fetchAndSet)
        .catch(() => {});
    }
    return () => { cancelled = true; };
  }, [planFilePath, events.length, activeTabId]);

  const planActive = modeId === "plan";
 // entries from the ACP `plan` sessionUpdate take precedence
 // over the empty/markdown branch. The legacy /goal long-horizon
 // flow ships its plan via this protocol path, NOT via a plan.md
 // file. Without this, legacy /goal runs show "Plan view is empty" even
 // though the orchestrator has a structured plan in hand.
  const hasEntries = planEntries.length > 0;
  const hasBuildScratchboard = buildState !== null && buildScratchboardText.trim().length > 0;
  const hasScratchboard = goalActive && goalScratchboardText.trim().length > 0;
  const planEmpty = !hasEntries && !hasBuildScratchboard && !hasScratchboard && (!planFilePath || !planText.trim());
  const planHeaderName = planFilePath
    ? "plan.md"
    : hasBuildScratchboard
      ? (buildState?.scratchboardPath.split(/[\\\/]/).pop() ?? "build.md")
    : hasScratchboard
      ? (goalScratchboardPath?.split(/[\\\/]/).pop() ?? "build.md")
      : hasEntries
        ? "build steps"
        : "—";
  const planHeaderStatus = planActive
    ? "· active"
    : buildState
      ? `· build-mode · ${isBuildTerminalStatus(buildState.status) ? buildState.status : `${buildState.continuationsTotal} pushes`}`
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
 * is on for the active tab. Polls the Rust orchestrator via
 * get_goal_state. */}
      <BuildRunCockpit
        activeTabId={activeTabId}
        state={buildState}
        receipts={buildReceipts}
        scratchboardText={buildScratchboardText}
        sessionConnected={sessionStatus === "Connected"}
        onConnectActiveTab={onConnectActiveTab}
        onChanged={() => setBuildRefreshSeq((n) => n + 1)}
      />
      <GoalStatusBar
        activeTabId={activeTabId}
        eventsLen={events.length}
        onOpenGoalReview={onOpenGoalReview}
      />
      <div className="plan">
        {planEmpty ? (
          <div className="plan-empty">
            {buildState ? (
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
              build · {buildState?.status ?? "unknown"} · {buildState?.continuationsTotal ?? 0} continuation{buildState?.continuationsTotal === 1 ? "" : "s"} · scratchboard
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
            >{buildScratchboardText}</ReactMarkdown>
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
 * scratchboard/content. Polls Tauri `get_goal_state` every 4 s or whenever the
 * events array grows. Renders nothing when goal_mode is off.
 * * Tauri commands:
 * get_goal_state(tabId) → { active, objective, continuationsTotal,
 * startedAtMs, pausedByUser, ... }
 * pause_goal(tabId) → set pausedByUser=true
 * set_goal_mode(tabId, on=true, objective, cwd) → resume / arm
 */
function GoalStatusBar({
  activeTabId,
  eventsLen,
  onOpenGoalReview,
}: {
  activeTabId?: string | null;
  eventsLen: number;
  onOpenGoalReview?: () => void;
}): JSX.Element {
  const [state, setState] = useState<
    | null
    | {
        active: boolean;
        objective: string;
        continuationsTotal: number;
        startedAtMs: number;
        pausedByUser: boolean;
        haltedReason?: string;
 // plan-approval gate. While true, the user is staring at
 // the proposed plan; the orchestrator hasn't injected anything
 // yet. Approve flips it to false; Reject clears the goal.
        awaitingApproval?: boolean;
        planTurnCompleted?: boolean;
        approvalStatus?: { ready: boolean; reason?: string | null };
        approvedAtMs?: number;
      }
  >(null);

 // Poll get_goal_state. Re-poll on activeTabId change, on each new
 // event arrival (prompt-complete is a likely trigger), and on a 4s
 // wall-clock interval to catch elapsed-time updates.
  useEffect(() => {
    if (!activeTabId) { setState(null); return; }
    let cancelled = false;
    const fetchState = () => {
      if (!inTauri()) return;
      void invoke<unknown>("get_goal_state", { tabId: activeTabId })
        .then((s) => {
          if (cancelled) return;
          if (!s || typeof s !== "object") { setState(null); return; }
          setState(s as any);
        })
        .catch(() => { /* command absent in dev / old builds: stay quiet */ });
    };
    fetchState();
    const id = window.setInterval(fetchState, 4000);
    return () => { cancelled = true; window.clearInterval(id); };
  }, [activeTabId, eventsLen]);

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
