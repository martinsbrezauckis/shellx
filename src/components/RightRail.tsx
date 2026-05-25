/**
 * src/components/RightRail.tsx — right-rail tab container.
 * * Tab order: Tasks (default) | Tools | Plan | Files. Persisted to localStorage
 * via TAB_KEY.
 * * - Tasks: TasksPanel — running background subprocesses scoped to the
 * active tab. Polling is mount-gated.
 * - Plan: PlanPane — reads grok's plan.md / goal.md scratchboard from disk
 * and re-fetches on each new event. Approval actions live in the modal.
 * - Files: FilesPane — git-aware tree rooted at the active tab's cwd.
 * * PreviewTarget is still exported for legacy callers; the right-rail
 * Preview tab has been replaced by the App-level FilePreviewModal.
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
import { grokSearchCapabilities, type SearchCapability } from "../lib/session-capabilities";
import {
  branchNameFromSource,
  gitDirtyTotal,
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
import { apiPost } from "../lib/debug-api";
import type { RawEventFrame } from "../types/acp";
import { ShellIcon, TransportIcon, type ShellIconName } from "./icons";

export type RightTab = "Tasks" | "Tooling" | "Git" | "Plan" | "Files";
const TAB_KEY = "grok-shell.rightTab";
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
  Plan: {
    label: "Plan",
    icon: "file",
    title: "Plan - active goal scratchboard and review",
  },
  Files: {
    label: "Files",
    icon: "folder",
    title: "Files - project browser",
  },
};

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
    hasActiveChild?: boolean;
    sessionId?: string | null;
  };
  desired: McpEntryStatus[];
  health: MarketplaceHealthEntry[];
}

export interface PreviewTarget {
  kind: "file" | "url" | "image" | "markdown" | "diff";
  path: string;
}

export function RightRail({
  preview,
  onPreviewClear,
  autonomy,
  onPreviewFile,
  events = [],
  cwd,
  activeTabId,
  prefetchedPlanText,
  requestedTab,
  requestedTabSeq,
  onOpenGoalReview,
  connectionLabel = "Local",
  connectionTransport = "local",
  sessionStatus = "Idle",
  onSendPromptToActiveTab,
}: {
  preview: PreviewTarget | null;
  onPreviewClear: () => void;
 /** Current autonomy mode — drives the Plan tab empty-state copy. */
  autonomy?: string;
 /** Click handler for FilesPane rows + future flink chips. */
  onPreviewFile?: (path: string) => void;
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
  sessionStatus?: string;
  onSendPromptToActiveTab?: (text: string) => void;
}): JSX.Element {
  const [tab, setTab] = useState<RightTab>(() => {
    try {
      const v = localStorage.getItem(TAB_KEY);
 // Legacy "Preview" stored from older installs falls through
 // to the new default "Tasks".
      if (v === "Tasks" || v === "Tooling" || v === "Git" || v === "Plan" || v === "Files") return v;
    } catch { /* no-op */ }
    return "Tasks";
  });

  useEffect(() => {
    try { localStorage.setItem(TAB_KEY, tab); } catch { /* no-op */ }
    void apiPost("/state/ui", { rightTab: tab }).catch(() => { /* no-op */ });
  }, [tab]);
  useEffect(() => {
    if (!requestedTab) return;
    setTab(requestedTab);
  }, [requestedTab, requestedTabSeq]);

  return (
    <aside className="right">
 {/* Tab order: Tasks (default) | Tools | Git | Plan | Files. Preview dropped. */}
      <div className="right-tabs tabs">
        {(Object.keys(RIGHT_TAB_META) as RightTab[]).map((rightTab) => {
          const meta = RIGHT_TAB_META[rightTab];
          return (
            <button
              key={rightTab}
              type="button"
              className={`tab ${tab === rightTab ? "active" : ""}`}
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
      {tab === "Tasks" && <TasksPanel activeTabId={activeTabId ?? null} />}
      {tab === "Tooling" && (
        <ToolingPane
          activeTabId={activeTabId ?? null}
          connectionLabel={connectionLabel}
          connectionTransport={connectionTransport}
          sessionStatus={sessionStatus}
          events={events}
          onSendPromptToActiveTab={onSendPromptToActiveTab}
        />
      )}
      {tab === "Git" && <GitPane activeTabId={activeTabId ?? null} cwd={cwd} />}
      {tab === "Plan"  && <PlanPane autonomy={autonomy} events={events} activeTabId={activeTabId} prefetchedPlanText={prefetchedPlanText} onPreviewFile={onPreviewFile ?? (() => {})} onOpenGoalReview={onOpenGoalReview} />}
      {tab === "Files" && <FilesPane cwd={cwd} onPreviewFile={onPreviewFile ?? (() => {})} />}
    </aside>
  );
}

/* ─────────────── Tools tab ─────────────── */

function ToolingPane({
  activeTabId,
  connectionLabel,
  connectionTransport,
  sessionStatus,
  onSendPromptToActiveTab,
  events,
}: {
  activeTabId: string | null;
  connectionLabel: string;
  connectionTransport: string;
  sessionStatus: string;
  events: RawEventFrame[];
  onSendPromptToActiveTab?: (text: string) => void;
}): JSX.Element {
  const [entries, setEntries] = useState<McpEntryStatus[]>([]);
  const [health, setHealth] = useState<Record<string, MarketplaceHealthEntry>>({});
  const [sessionInfo, setSessionInfo] = useState<SessionToolingSnapshot["session"] | null>(null);
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
  }, [activeTabId, connectionLabel, connectionTransport]);

  const desired = useMemo(
    () => entries.filter((entry) => entry.installed && entry.enabled),
    [entries],
  );
  const searchCapabilities = useMemo(() => grokSearchCapabilities(events), [events]);
  const readySearchCapabilities = searchCapabilities.filter((cap) => cap.ready).length;
  const hasConnectedEnvironment = sessionInfo?.hasActiveChild === true;
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
          <span>{desired.length} desired MCP{desired.length === 1 ? "" : "s"}</span>
        </div>
      </div>

      <UpdateDiagnosticsCard />

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
          <div className="tooling-section-label">Grok capabilities</div>
          <div className="tooling-list">
            {searchCapabilities.map((entry) => (
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

function CapabilityRow({ entry }: { entry: SearchCapability }): JSX.Element {
  const status = entry.ready
    ? { label: "ready here", className: "ok" }
    : { label: "waiting", className: "muted" };
  return (
    <div className="tooling-row tooling-row-capability">
      <div className="tooling-row-top">
        <span className="tooling-name">{entry.name}</span>
        <span className={`mp-kind mp-kind-${entry.source === "grok" ? "http" : "stdio"}`}>
          {entry.source === "grok" ? "GROK" : "HOST"}
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
  const actionPrompt = health?.status === "missing"
    ? (
        `Install the missing launcher for the ${entry.name} MCP connector in this ${connectionLabel} environment. ` +
        `The session Tools check reported ${health.launcher ? `\`${health.launcher}\`` : "the launcher"} missing. ` +
        "First inspect the environment and package manager, then ask before running installer commands."
      )
    : (
        `Check and fix the ${entry.name} MCP connector in this ${connectionLabel} environment. ` +
        "First inspect what is failing, then propose or run the safest config command only after permission."
      );

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
      {canRepair && (
        <div className="tooling-actions">
          <button
            type="button"
            className="mp-action-btn mp-action-btn-secondary"
            onClick={() => {
              onSendPromptToActiveTab?.(actionPrompt);
            }}
          >
            {actionLabel}
          </button>
        </div>
      )}
    </div>
  );
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

/* Walks one level under `cwd`, sorts dirs-first then alpha. Dir
 * click drills down via the local subpath stack; file click invokes
 * onPreviewFile with the absolute path. */
function FilesPane({
  cwd,
  onPreviewFile,
}: {
  cwd: string;
  onPreviewFile: (path: string) => void;
}): JSX.Element {
  const [subpath, setSubpath] = useState<string>("");
  const [entries, setEntries] = useState<FsEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fullPath = subpath ? `${cwd.replace(/\/$/, "")}/${subpath}` : cwd;

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setEntries(null);
    if (!cwd || !inTauri()) return;
    (async () => {
      try {
        const res = await invoke<FsEntry[]>("list_project_files", { path: fullPath });
        if (!cancelled) setEntries(res);
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
    })();
    return () => { cancelled = true; };
  }, [fullPath, cwd]);

 // Reset drill-down whenever the cwd changes (e.g. folder pill picks a new dir).
  useEffect(() => { setSubpath(""); }, [cwd]);

  const goUp = () => {
    if (!subpath) return;
    const segs = subpath.split("/").filter(Boolean);
    segs.pop();
    setSubpath(segs.join("/"));
  };
  const enterDir = (name: string) => {
    setSubpath(subpath ? `${subpath}/${name}` : name);
  };

  return (
    <div className="fileview">
      <div className="fv-head">
        <span className="fv-path" title={fullPath}>
          {subpath ? `…/${subpath}` : cwd.split("/").filter(Boolean).pop() ?? "/"}
        </span>
        {subpath && (
          <button type="button" className="fv-up" onClick={goUp} title="Up one level">
            <ShellIcon name="arrow-up" size={13} />
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
      {!error && entries && entries.map((e) => {
        const fullChild = `${fullPath.replace(/\/$/, "")}/${e.name}`;
        return (
        <div
          key={e.name}
          className={`fv-row ${e.kind}`}
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
          title={`${e.kind} · ${e.size} bytes${e.kind === "file" ? " · drag onto composer to attach" : ""}`}
          style={{ cursor: e.kind === "file" ? "grab" : "pointer" }}
        >
          <span className="fv-ic">
            <ShellIcon name={e.kind === "dir" ? "folder" : "file"} size={14} />
          </span>
          <span className="fv-name">{e.name}</span>
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
  prefetchedPlanText,
  onPreviewFile,
  onOpenGoalReview,
}: {
  autonomy?: string;
  events: { kind: string; payload?: unknown }[];
  activeTabId?: string | null;
 /** Pre-fetched plan.md text from App-level. Used as initial
 * planText so the pane renders immediately; the local fetch still
 * runs and may refresh to a newer body. */
  prefetchedPlanText?: string;
  onPreviewFile?: (path: string) => void;
  onOpenGoalReview?: () => void;
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

 /* #395: Goal-orchestrator scratchboard. When /goal is active
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
 // over the empty/markdown branch. grok-build's /goal long-horizon
 // flow ships its plan via this protocol path, NOT via a plan.md
 // file. Without this, /goal runs show "Plan view is empty" even
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
      ? (goalScratchboardPath?.split(/[\\\/]/).pop() ?? "goal.md")
      : hasEntries
        ? "goal steps"
        : "—";
  const planHeaderStatus = planActive
    ? "· active"
    : buildState
      ? `· build-mode · ${isBuildTerminalStatus(buildState.status) ? buildState.status : `${buildState.continuationsTotal} pushes`}`
      : goalActive
      ? `· goal-mode · ${goalContinuationsTotal} pushes`
      : hasEntries
        ? `· ${planEntries.length} steps`
        : (planFilePath || hasScratchboard ? "· last" : "· empty");

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
 {/* Goal-orchestrator status bar. Renders only when goal_mode
 * is on for the active tab. Polls the Rust orchestrator via
 * get_goal_state. */}
      <BuildRunCockpit
        activeTabId={activeTabId}
        state={buildState}
        receipts={buildReceipts}
        onChanged={() => setBuildRefreshSeq((n) => n + 1)}
      />
      <GoalStatusBar activeTabId={activeTabId} eventsLen={events.length} onOpenGoalReview={onOpenGoalReview} />
      <div className="plan">
        {planEmpty ? (
          <div className="plan-empty">
            {buildState ? (
              <>Build Mode is active. Waiting for the scratchboard to
              populate or for the next receipt from this run.</>
            ) : goalActive ? (
              <>Goal mode is active. grok hasn't emitted a structured plan yet
              (and hasn't written to the scratchboard at{" "}
              <code>{goalScratchboardPath?.split(/[\\\/]/).pop() ?? "goal.md"}</code>).
              The orchestrator has injected {goalContinuationsTotal} continuation
              {goalContinuationsTotal === 1 ? "" : "s"} so far — it'll keep
              pushing grok until either the goal completes or the per-turn
              timeout fires.</>
            ) : planActive ? (
              <>Plan mode is active — waiting for grok to write steps to{" "}
              <code>plan.md</code>. Use <code>enter_plan_mode</code> in
              the prompt, then describe the work; steps land here as
              grok writes them.</>
            ) : (
              <>Plan view is empty. Use <code>/goal &lt;objective&gt;</code> to
              start a long-horizon plan, or call <code>enter_plan_mode</code>{" "}
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
 * cwd) rendered as markdown. Active /goal sessions write
 * progress here even when grok doesn't emit ACP plan
 * entries. */
          <div className="plan-md" onMouseUp={onMouseUpAutoCopy}>
            {goalActive && (
              <div style={{
                fontSize: "var(--fs-ui-xs)", color: "var(--ink-3)",
                padding: "0 0 8px 0", letterSpacing: 0.04,
              }}>
                goal · {goalContinuationsTotal} continuation{goalContinuationsTotal === 1 ? "" : "s"} · scratchboard
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
      ? "Waiting for a complete phased plan in goal.md."
      : "Waiting for Grok to finish the plan turn.");
 // manual completion fallback. When grok says "all done" in
 // chat but never calls goal_complete, the orchestrator stays armed
 // and keeps injecting continuations. This button calls
 // mark_goal_complete which flips active=false without touching the
 // scratchboard, so the user can close the cycle manually.
  const onMarkComplete = (): void => {
    if (!activeTabId || !inTauri()) return;
    if (!window.confirm("Mark this goal as complete? The auto-continuation loop will stop. Use this when grok finished the work but didn't call the goal_complete tool itself.")) return;
    void invoke("mark_goal_complete", { tabId: activeTabId }).catch(() => {});
  };

  return (
    <>
      <div className="goal-status" title={`Goal: ${state.objective.slice(0, 200)}`}>
        <span className={`goal-status-pill goal-status-${statusLabel.toLowerCase().replace(/[^a-z]/g, "")}`}>
          <ShellIcon name="activity" size={13} />
          Goal {statusLabel}
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
              title="Mark goal as complete — stops the auto-continuation loop. Use when grok finished but didn't call the goal_complete tool itself."
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
