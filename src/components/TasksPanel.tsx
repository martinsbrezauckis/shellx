/**
 * src/components/TasksPanel.tsx — #103 visible task manager.
 * .
 *
 * Role
 * A right-rail tab that surfaces ALL in-flight subprocesses the
 * shellX host has spawned: grok subprocesses (one per tab), ACP
 * terminals grok asked us to spawn via `terminal/*`, and user
 * terminals from the bottom-panel terminal tab. Future spawn
 * sources (host_mcp children, debug-api spawns) appear here
 * automatically once they land their own registry rows.
 *
 * Data flow
 * Polls the Rust `list_background_tasks` command every 500ms while
 * the panel is visible. Each row carries:
 * - taskId stable key + signal target
 * - origin "grok" | "acp_term" | "user_term" | "host_mcp"
 * - commandDisplay friendly cmd-line string
 * - pid, cpuPct, rssMb live metrics from one sysinfo pass per poll
 * - status "running" | "stopped" | "exited" | "killed"
 * - startedAtMs wall-clock spawn time
 * - recentOutputTail ≤1024 bytes of recent stdout/stderr
 * - tabId for grouping rows by tab in the UI
 *
 * Controls per row
 * - Pause → invoke task_pause (SIGSTOP on Unix; NtSuspendProcess on Windows).
 * - Resume → invoke task_resume (SIGCONT on Unix; NtResumeProcess on Windows).
 * - Kill → invoke task_kill (SIGTERM, then SIGKILL after 3s server-
 * side). Returns immediately; the renderer doesn't have
 * to wait the 3s.
 *
 * UI choices
 * Compact one-row-per-task layout grouped by origin. Auto-refresh
 * indicator + manual refresh button so users can confirm the panel
 * is live. Each row's tail expands inline on click.
 */
import { useCallback, useEffect, useRef, useState, type JSX } from "react";
import { invoke } from "@tauri-apps/api/core";
import { inTauri } from "../lib/tauri-bridge";
import { ShellIcon } from "./icons";

export interface TaskSnapshot {
  taskId: string;
  origin: "grok" | "acp_term" | "user_term" | "host_mcp" | string;
  commandDisplay: string;
  pid: number | null;
  cpuPct: number | null;
  rssMb: number | null;
  status: "running" | "stopped" | "exited" | "killed" | string;
  startedAtMs: number;
  recentOutputTail: string;
  tabId: string | null;
}

const POLL_MS = 500;
const SHOW_COMPLETED_KEY = "tasks-panel-show-completed";
const SHOW_ALL_TABS_KEY = "tasks-panel-show-all-tabs";

export function TasksPanel({
  activeTabId,
  onAskAgent,
}: {
 /** when set, the panel filters out rows
 * whose tabId does NOT match. Current host_mcp children carry the
 * owning tab when shellX spawned them; legacy/null rows still fold into
 * the active tab for visibility. */
  activeTabId?: string | null;
 /** Optional bridge back into the active Grok tab. Used for "inspect
 * this task/output" without forcing the user to copy logs manually. */
  onAskAgent?: (prompt: string) => void;
} = {}): JSX.Element {
  const [tasks, setTasks] = useState<TaskSnapshot[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
 /* live filter input. Matches
 * case-insensitive against command_display + status + pid. Empty
 * = show all. Persisted only in component state (no localStorage
 * since the filter is a transient view tweak). */
  const [filter, setFilter] = useState<string>("");
 /* show-completed toggle. Default false so the
 * Tasks rail only shows live work — finished subagents auto-hide.
 * Persisted to localStorage so power users who like seeing the
 * history don't have to flip it every session. */
  const [showCompleted, setShowCompleted] = useState<boolean>(() => {
    try {
      return localStorage.getItem(SHOW_COMPLETED_KEY) === "1";
    } catch {
      return false;
    }
  });
  const [showAllTabs, setShowAllTabs] = useState<boolean>(() => {
    try {
      return localStorage.getItem(SHOW_ALL_TABS_KEY) === "1";
    } catch {
      return false;
    }
  });
  const [copiedReport, setCopiedReport] = useState(false);
  const onToggleShowCompleted = useCallback((next: boolean) => {
    setShowCompleted(next);
    try {
      localStorage.setItem(SHOW_COMPLETED_KEY, next ? "1" : "0");
    } catch { /* localStorage disabled — ignore */ }
  }, []);
  const onToggleShowAllTabs = useCallback((next: boolean) => {
    setShowAllTabs(next);
    try {
      localStorage.setItem(SHOW_ALL_TABS_KEY, next ? "1" : "0");
    } catch { /* localStorage disabled — ignore */ }
  }, []);
  const cancelledRef = useRef(false);

  const refresh = useCallback(async () => {
    if (!inTauri()) {
      setError("Background-tasks unavailable outside Tauri (browser preview).");
      return;
    }
    try {
      const rows = await invoke<TaskSnapshot[]>("list_background_tasks");
      if (!cancelledRef.current) {
        setTasks(rows);
        setError(null);
      }
    } catch (e) {
      if (!cancelledRef.current) setError(String(e));
    }
  }, []);

 /* Mount + poll. The cancelledRef sentinel prevents stale setState
 * from a still-in-flight invoke after unmount. */
  useEffect(() => {
    cancelledRef.current = false;
    void refresh();
    const id = window.setInterval(() => void refresh(), POLL_MS);
    return () => {
      cancelledRef.current = true;
      window.clearInterval(id);
    };
  }, [refresh]);

  async function handlePause(taskId: string) {
    setBusy(true);
    try {
      await invoke("task_pause", { taskId });
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  async function handleResume(taskId: string) {
    setBusy(true);
    try {
      await invoke("task_resume", { taskId });
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  async function handleKill(task: TaskSnapshot) {
    const terminalNoPid = isTerminalTask(task) && task.pid === null;
    const action = terminalNoPid
      ? "ShellX will drop this terminal record because no OS pid was reported."
      : isTerminalTask(task)
        ? "Terminal tasks are killed immediately and removed from the registry."
        : "Sends SIGTERM, then SIGKILL after 3s.";
    if (!window.confirm(`Kill task "${task.commandDisplay}"? ${action}`)) {
      return;
    }
    setBusy(true);
    try {
      await invoke("task_kill", { taskId: task.taskId });
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function handleCleanupMcpChildren() {
    if (!activeTabId) return;
    if (!window.confirm("Clean Host MCP child processes for this tab? Sends SIGTERM, then SIGKILL after 3s if needed.")) {
      return;
    }
    setBusy(true);
    try {
      await invoke<number>("cleanup_mcp_children_for_tab", { tabId: activeTabId });
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  function toggleExpanded(taskId: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(taskId)) next.delete(taskId);
      else next.add(taskId);
      return next;
    });
  }

 /* M filter: case-insensitive substring match on the
 * fields the user typically searches by. Applied before the
 * sectioning pass so section counts reflect the filtered view. */
  const filterLower = filter.trim().toLowerCase();
 /* hide finished tasks
 * (exited/killed) by default. The grey rows piled up over a
 * session, drowning out live work. Toggle below reveals them.
 * If the user has explicitly filtered for "exited" or "killed",
 * we honor that intent and skip the hide. */
  const userTypedTerminalState =
    filterLower.includes("exited")
    || filterLower.includes("killed")
    || filterLower.includes("stopped");
  const visibilityFilter = (t: TaskSnapshot): boolean => {
    if (showCompleted) return true;
    if (userTypedTerminalState) return true;
    return t.status === "running";
  };
  const searchFiltered = (filterLower === ""
    ? tasks
    : tasks.filter((t) =>
        t.commandDisplay.toLowerCase().includes(filterLower)
        || t.status.toLowerCase().includes(filterLower)
        || (t.pid !== null && String(t.pid).includes(filterLower)),
      )
  ).filter(visibilityFilter);

 /* scope by active session tab. Rows with a matching tabId pass.
 * Legacy/null rows are still folded into the active tab rather than
 * hidden so older session data remains visible. */
  const filteredTasks: TaskSnapshot[] = [];
  for (const t of searchFiltered) {
    if (showAllTabs || !activeTabId) {
      filteredTasks.push(t);
      continue;
    }
    if (t.tabId == null || t.tabId === activeTabId) {
      filteredTasks.push(t);
    }
 // else: belongs to another tab — hidden
  }

 /* Group rows by origin for the panel. The Rust side already returns
 * a stable order (grok → acp_term → user_term); we just walk it and
 * insert section headers as origin changes. */
  const sections: { origin: string; rows: TaskSnapshot[] }[] = [];
  for (const t of filteredTasks) {
    const last = sections[sections.length - 1];
    if (last && last.origin === t.origin) {
      last.rows.push(t);
    } else {
      sections.push({ origin: t.origin, rows: [t] });
    }
  }

  const scopedHostMcpCount = activeTabId
    ? filteredTasks.filter((t) =>
        t.origin === "host_mcp"
        && t.tabId === activeTabId
        && (t.status === "running" || t.status === "stopped"),
      ).length
    : 0;
  const health = summarizeTasks(filteredTasks);

  function copyVisibleReport(): void {
    try {
      void navigator.clipboard.writeText(buildTasksReport(filteredTasks, { activeTabId, showAllTabs, filter }));
      setCopiedReport(true);
      window.setTimeout(() => setCopiedReport(false), 1200);
    } catch {
      /* ignore */
    }
  }

  function askAboutVisibleTasks(): void {
    if (!onAskAgent || filteredTasks.length === 0) return;
    onAskAgent(buildTasksInspectionPrompt(filteredTasks, { activeTabId, showAllTabs, filter }));
  }

  return (
    <div
      className="tasks-pane"
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "stretch",
          gap: 8,
          padding: "8px 10px",
          borderBottom: "1px solid var(--border, #222)",
        }}
        >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <strong style={{ fontSize: "var(--right-heading-size, var(--fs-ui-sm))", whiteSpace: "nowrap" }}>Background Tasks</strong>
          <span style={{ flex: 1 }} />
          {filteredTasks.length > 0 && (
            <button
              type="button"
              onClick={copyVisibleReport}
              disabled={busy}
              title="Copy a compact report for visible tasks"
              style={{
                padding: "2px 8px",
                background: "transparent",
                border: "1px solid var(--border, #333)",
                color: "inherit",
                borderRadius: 4,
                fontSize: "var(--right-meta-size, var(--fs-ui-xs))",
                cursor: busy ? "wait" : "pointer",
              }}
            >
              <ShellIcon name={copiedReport ? "check" : "copy"} size={13} />
            </button>
          )}
          {onAskAgent && filteredTasks.length > 0 && (
            <button
              type="button"
              onClick={askAboutVisibleTasks}
              disabled={busy}
              title="Ask Grok to inspect the visible background tasks"
              style={{
                padding: "2px 8px",
                background: "transparent",
                border: "1px solid var(--border, #333)",
                color: "inherit",
                borderRadius: 4,
                fontSize: "var(--right-meta-size, var(--fs-ui-xs))",
                cursor: busy ? "wait" : "pointer",
              }}
            >
              <ShellIcon name="message" size={13} />
            </button>
          )}
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={busy}
            style={{
              padding: "2px 8px",
              background: "transparent",
              border: "1px solid var(--border, #333)",
              color: "inherit",
              borderRadius: 4,
              fontSize: "var(--right-meta-size, var(--fs-ui-xs))",
              cursor: busy ? "wait" : "pointer",
            }}
          >
            <ShellIcon name="refresh" size={13} />
          </button>
          {scopedHostMcpCount > 0 && (
            <button
              type="button"
              onClick={() => void handleCleanupMcpChildren()}
              disabled={busy}
              aria-label="Clean Host MCP children for this tab"
              title={`Clean ${scopedHostMcpCount} Host MCP child process${scopedHostMcpCount === 1 ? "" : "es"} for this tab`}
              style={{
                padding: "2px 8px",
                background: "transparent",
                border: "1px solid var(--fg-error, #f55)",
                color: "var(--fg-error, #f55)",
                borderRadius: 4,
                fontSize: "var(--right-meta-size, var(--fs-ui-xs))",
                cursor: busy ? "wait" : "pointer",
              }}
            >
              <ShellIcon name="trash" size={13} />
            </button>
          )}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
          <label
            style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: "var(--right-meta-size, var(--fs-ui-xs))", color: "var(--fg-muted, #888)", userSelect: "none", whiteSpace: "nowrap" }}
            title="Show tasks from every open session tab"
          >
            <input
              type="checkbox"
              checked={showAllTabs}
              onChange={(e) => onToggleShowAllTabs(e.target.checked)}
              style={{ margin: 0 }}
            />
            all tabs
          </label>
 {/* show-completed toggle. Off by default so the
 * rail only renders live (running) tasks — finished rows hide
 * as soon as the next poll sees them as exited/killed. */}
          <label
            style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: "var(--right-meta-size, var(--fs-ui-xs))", color: "var(--fg-muted, #888)", userSelect: "none", whiteSpace: "nowrap" }}
            title="Include finished (exited/killed) rows in the list"
          >
            <input
              type="checkbox"
              checked={showCompleted}
              onChange={(e) => onToggleShowCompleted(e.target.checked)}
              style={{ margin: 0 }}
            />
            completed
          </label>
 {/* M filter input . */}
          <input
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="filter…"
            aria-label="Filter tasks"
            style={{
              padding: "2px 6px",
              background: "transparent",
              border: "1px solid var(--border, #333)",
              color: "inherit",
              borderRadius: 4,
              fontSize: "var(--right-meta-size, var(--fs-ui-xs))",
              minWidth: 70,
              flex: 1,
            }}
          />
        </div>
      </div>
      {error && (
        <div
          role="alert"
          style={{
            color: "var(--fg-error, #f55)",
            fontSize: "var(--right-body-size, 13px)",
            padding: "6px 10px",
            background: "rgba(255, 85, 85, 0.05)",
            borderBottom: "1px solid var(--border, #222)",
          }}
        >
          {error}
        </div>
      )}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
          gap: 1,
          borderBottom: "1px solid var(--border, #222)",
          background: "var(--border, #222)",
        }}
      >
        <TaskMetric label="running" value={health.running} tone={health.running > 0 ? "ok" : "muted"} />
        <TaskMetric label="paused" value={health.stopped} tone={health.stopped > 0 ? "warn" : "muted"} />
        <TaskMetric label="issues" value={health.problem} tone={health.problem > 0 ? "err" : "muted"} />
        <TaskMetric label="quiet" value={health.quiet} tone={health.quiet > 0 ? "warn" : "muted"} />
      </div>
      <div style={{ flex: 1, overflow: "auto" }}>
        {tasks.length === 0 ? (
          <div style={{ padding: 16, fontSize: "var(--right-body-size, 13px)", color: "var(--fg-muted, #888)" }}>
            No live background tasks. Spawn a grok session or open a terminal to see them here.
          </div>
        ) : filteredTasks.length === 0 ? (
          <div style={{ padding: 16, fontSize: "var(--right-body-size, 13px)", color: "var(--fg-muted, #888)" }}>
            No tasks match this scope and filter.
          </div>
        ) : (
          <>
            {sections.map((sec) => (
              <div key={sec.origin}>
                <div
                  style={{
                    fontSize: "var(--right-meta-size, 11px)",
                    textTransform: "uppercase",
                    letterSpacing: 0.6,
                    padding: "6px 10px 2px",
                    color: "var(--fg-muted, #666)",
                  }}
                >
                  {originLabel(sec.origin)} ({sec.rows.length})
                </div>
                {sec.rows.map((t) => (
                  <TaskRow
                    key={t.taskId}
                    task={t}
                    expanded={expanded.has(t.taskId)}
                    busy={busy}
                    onToggle={() => toggleExpanded(t.taskId)}
                    onAskAgent={onAskAgent ? () => onAskAgent(buildTaskInspectionPrompt(t)) : undefined}
                    onPause={() => void handlePause(t.taskId)}
                    onResume={() => void handleResume(t.taskId)}
                    onKill={() => void handleKill(t)}
                  />
                ))}
              </div>
            ))}
 {/* "Unattributed subagents" section
 * dropped — rows are now folded into the active-tab list
 * above. See the comment near `filteredTasks` for the
 * reasoning. The host_mcp origin label still tags each
 * row so users can see at a glance which are grok's
 * subagents vs the user's own terminals. */}
          </>
        )}
      </div>
    </div>
  );
}

function originLabel(o: string): string {
  switch (o) {
    case "grok": return "Grok subprocesses";
    case "acp_term": return "ACP terminals";
    case "user_term": return "User terminals";
    case "host_mcp": return "Host MCP children";
    default: return o;
  }
}

interface TaskHealthSummary {
  running: number;
  stopped: number;
  exited: number;
  killed: number;
  problem: number;
  quiet: number;
}

function TaskMetric({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "ok" | "warn" | "err" | "muted";
}): JSX.Element {
  const color =
    tone === "ok" ? "var(--ok)" :
    tone === "warn" ? "var(--warn)" :
    tone === "err" ? "var(--err)" :
    "var(--fg-muted, #888)";
  return (
    <div
      style={{
        minWidth: 0,
        display: "grid",
        gap: 2,
        padding: "7px 8px",
        background: "var(--bg, #0a0a0a)",
      }}
    >
      <span style={{ color, fontFamily: "var(--mono, monospace)", fontSize: 13, fontWeight: 700 }}>
        {value}
      </span>
      <span style={{ color: "var(--fg-muted, #888)", fontSize: "var(--right-meta-size, var(--fs-ui-xs))", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {label}
      </span>
    </div>
  );
}

function summarizeTasks(tasks: TaskSnapshot[]): TaskHealthSummary {
  const summary: TaskHealthSummary = {
    running: 0,
    stopped: 0,
    exited: 0,
    killed: 0,
    problem: 0,
    quiet: 0,
  };
  for (const task of tasks) {
    if (task.status === "running") summary.running += 1;
    if (task.status === "stopped") summary.stopped += 1;
    if (task.status === "exited") summary.exited += 1;
    if (task.status === "killed") summary.killed += 1;
    if (taskLooksProblematic(task)) summary.problem += 1;
    if (taskLooksQuiet(task)) summary.quiet += 1;
  }
  return summary;
}

function taskLooksProblematic(task: TaskSnapshot): boolean {
  if (task.status === "killed" || task.status === "stopped") return true;
  if (task.status !== "running" && task.status !== "exited") return true;
  return outputLooksProblematic(task.recentOutputTail);
}

function taskLooksQuiet(task: TaskSnapshot): boolean {
  if (task.status !== "running") return false;
  if (task.recentOutputTail.trim().length > 0) return false;
  return Date.now() - task.startedAtMs > 10 * 60_000;
}

function outputLooksProblematic(output: string): boolean {
  return /\b(error|failed|fatal|panic|exception|traceback|permission denied|not found|timed out|timeout)\b/i.test(output);
}

function isTerminalTask(task: TaskSnapshot): boolean {
  return task.origin === "user_term" || task.origin === "acp_term";
}

interface TaskRowProps {
  task: TaskSnapshot;
  expanded: boolean;
  busy: boolean;
  onToggle: () => void;
  onAskAgent?: () => void;
  onPause: () => void;
  onResume: () => void;
  onKill: () => void;
}

function TaskRow({
  task,
  expanded,
  busy,
  onToggle,
  onAskAgent,
  onPause,
  onResume,
  onKill,
}: TaskRowProps): JSX.Element {
  const isRunning = task.status === "running";
  const isStopped = task.status === "stopped";
  const isDead = task.status === "exited" || task.status === "killed";
  const canKill = !busy && !isDead && (task.pid !== null || isTerminalTask(task));
  const [copiedOutput, setCopiedOutput] = useState(false);

  function copyOutput(): void {
    if (!task.recentOutputTail.trim()) return;
    try {
      void navigator.clipboard.writeText(task.recentOutputTail);
      setCopiedOutput(true);
      window.setTimeout(() => setCopiedOutput(false), 1200);
    } catch {
      /* ignore */
    }
  }

 /* Status color cue. Aligns with the system pill colors used elsewhere
 * (.tool-hdr .run/.done/.fail classes). Stopped uses a muted amber to
 * distinguish it from "exited" which is grey. */
  const statusColor =
    task.status === "running" ? "var(--ok, #4ade80)" :
    task.status === "stopped" ? "#fbbf24" :
    task.status === "exited"  ? "var(--fg-muted, #888)" :
    "var(--fg-error, #f55)";

  return (
    <div
      style={{
        borderBottom: "1px solid var(--border, #222)",
        padding: "6px 10px",
        opacity: isDead ? 0.55 : 1,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: "var(--right-body-size, 13px)" }}>
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          style={{
            width: 16,
            background: "transparent",
            border: "none",
            color: "var(--fg-muted, #888)",
            cursor: "pointer",
            padding: 0,
          }}
        >
          <ShellIcon name={expanded ? "chevron-down" : "chevron-right"} size={12} />
        </button>
        <span
          aria-label={`status ${task.status}`}
          title={task.status}
          style={{
            display: "inline-block",
            width: 8,
            height: 8,
            borderRadius: 4,
            background: statusColor,
            flexShrink: 0,
          }}
        />
        <span
          style={{
            fontFamily: "var(--mono, monospace)",
            fontSize: "var(--right-body-size, 13px)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            flex: 1,
          }}
          title={task.commandDisplay}
        >
          {task.commandDisplay}
        </span>
        <span style={{ fontSize: "var(--right-meta-size, var(--fs-ui-xs))", color: "var(--fg-muted, #888)", flexShrink: 0 }}>
          {task.pid !== null ? `pid ${task.pid}` : "no pid"}
        </span>
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          marginLeft: 24,
          marginTop: 3,
          fontSize: "var(--right-meta-size, var(--fs-ui-xs))",
          color: "var(--fg-muted, #888)",
        }}
      >
        <span>{task.tabId ? `tab ${task.tabId.slice(0, 8)}` : "—"}</span>
        <span>·</span>
        <span>{task.cpuPct !== null ? `${task.cpuPct.toFixed(1)}% CPU` : "— CPU"}</span>
        <span>·</span>
        <span>{task.rssMb !== null ? `${task.rssMb} MB` : "— MB"}</span>
        <span>·</span>
        <span>{fmtAge(task.startedAtMs)}</span>
        <span style={{ flex: 1 }} />
        {onAskAgent && (
          <button
            type="button"
            onClick={onAskAgent}
            disabled={busy}
            title="Ask Grok to inspect this background task and its latest output"
            style={btnStyle}
          >
            <ShellIcon name="message" size={12} /> Ask
          </button>
        )}
        {task.recentOutputTail.trim().length > 0 && (
          <button
            type="button"
            onClick={copyOutput}
            disabled={busy}
            title="Copy this task's latest output"
            style={btnStyle}
          >
            <ShellIcon name={copiedOutput ? "check" : "copy"} size={12} /> Copy
          </button>
        )}
 {/*  Windows now uses NtSuspendProcess /
            NtResumeProcess (dynamically resolved from ntdll), so the
            userAgent guard is gone. Both platforms run native code. */}
        {isRunning && (
          <button
            type="button"
            onClick={onPause}
            disabled={busy || task.pid === null}
            title="Pause (SIGSTOP on Unix, NtSuspendProcess on Windows)"
            style={btnStyle}
          >
            <ShellIcon name="pause" size={12} /> Pause
          </button>
        )}
        {isStopped && (
          <button
            type="button"
            onClick={onResume}
            disabled={busy || task.pid === null}
            title="Resume (SIGCONT on Unix, NtResumeProcess on Windows)"
            style={btnStyle}
          >
            <ShellIcon name="play" size={12} /> Resume
          </button>
        )}
        {!isDead && (
          <button
            type="button"
            onClick={onKill}
            disabled={!canKill}
            title={isTerminalTask(task) ? "Kill terminal and remove its task row" : "Kill (SIGTERM then SIGKILL after 3s)"}
            style={{ ...btnStyle, borderColor: "var(--fg-error, #f55)", color: "var(--fg-error, #f55)" }}
          >
            <ShellIcon name="close" size={12} /> Kill
          </button>
        )}
      </div>
      {expanded && task.recentOutputTail && (
        <pre
          style={{
            marginLeft: 24,
            marginTop: 4,
            padding: 6,
            fontSize: "var(--right-code-size, 12px)",
            lineHeight: 1.35,
            background: "var(--bg-elev, #0d0d0d)",
            border: "1px solid var(--border, #222)",
            borderRadius: 4,
            maxHeight: 200,
            overflow: "auto",
            whiteSpace: "pre-wrap",
            wordBreak: "break-all",
          }}
        >
          {task.recentOutputTail}
        </pre>
      )}
      {expanded && !task.recentOutputTail && (
        <div
          style={{
            marginLeft: 24,
            marginTop: 4,
            fontSize: "var(--right-meta-size, var(--fs-ui-xs))",
            color: "var(--fg-muted, #666)",
            fontStyle: "italic",
          }}
        >
          (no output captured)
        </div>
      )}
    </div>
  );
}

function buildTaskInspectionPrompt(task: TaskSnapshot): string {
  const output = task.recentOutputTail.trim();
  return [
    "Inspect this shellX background task and tell me whether it is healthy, stuck, failed, or needs action.",
    "",
    "Task:",
    `- id: ${task.taskId}`,
    `- origin: ${task.origin}`,
    `- command: ${task.commandDisplay}`,
    `- pid: ${task.pid ?? "(none)"}`,
    `- status: ${task.status}`,
    `- tab: ${task.tabId ?? "(none)"}`,
    `- cpu: ${task.cpuPct !== null ? `${task.cpuPct.toFixed(1)}%` : "(unknown)"}`,
    `- memory: ${task.rssMb !== null ? `${task.rssMb} MB` : "(unknown)"}`,
    `- age: ${fmtAge(task.startedAtMs)}`,
    "",
    "Recent output:",
    output ? "```text\n" + output.slice(-6000) + "\n```" : "(no output captured)",
    "",
    "If this looks actionable, propose the exact next step. Do not kill or restart anything unless I explicitly ask.",
  ].join("\n");
}

function buildTasksInspectionPrompt(
  tasks: TaskSnapshot[],
  context: { activeTabId?: string | null; showAllTabs: boolean; filter: string },
): string {
  const health = summarizeTasks(tasks);
  const rows = tasks.slice(0, 30).map((task, index) => {
    const flags = [
      taskLooksProblematic(task) ? "attention" : null,
      taskLooksQuiet(task) ? "quiet" : null,
    ].filter(Boolean).join(", ") || "normal";
    return [
      `${index + 1}. ${task.commandDisplay}`,
      `   id=${task.taskId} origin=${task.origin} status=${task.status} pid=${task.pid ?? "none"} tab=${task.tabId ?? "none"} age=${fmtAge(task.startedAtMs)} cpu=${task.cpuPct !== null ? `${task.cpuPct.toFixed(1)}%` : "unknown"} rss=${task.rssMb !== null ? `${task.rssMb} MB` : "unknown"} flags=${flags}`,
      task.recentOutputTail.trim()
        ? `   output_tail=${JSON.stringify(task.recentOutputTail.trim().slice(-900))}`
        : "   output_tail=(none)",
    ].join("\n");
  }).join("\n");

  return [
    "Inspect the visible shellX background task set and tell me whether the system is healthy, stuck, failed, or needs action.",
    "",
    "Scope:",
    `- active tab: ${context.activeTabId ?? "(none)"}`,
    `- showing all tabs: ${context.showAllTabs ? "yes" : "no"}`,
    `- filter: ${context.filter.trim() || "(none)"}`,
    "",
    "Summary:",
    `- visible tasks: ${tasks.length}`,
    `- running: ${health.running}`,
    `- paused/stopped: ${health.stopped}`,
    `- exited: ${health.exited}`,
    `- killed: ${health.killed}`,
    `- needing attention: ${health.problem}`,
    `- quiet >10m: ${health.quiet}`,
    "",
    "Tasks:",
    rows || "(none)",
    "",
    "If this looks actionable, propose the exact next step. Do not kill, pause, resume, or restart anything unless I explicitly ask.",
  ].join("\n");
}

function buildTasksReport(
  tasks: TaskSnapshot[],
  context: { activeTabId?: string | null; showAllTabs: boolean; filter: string },
): string {
  const health = summarizeTasks(tasks);
  const taskLines = tasks.map((task) => {
    const flags = [
      taskLooksProblematic(task) ? "attention" : null,
      taskLooksQuiet(task) ? "quiet" : null,
    ].filter(Boolean).join(",");
    return [
      `- ${task.commandDisplay}`,
      `  id: ${task.taskId}`,
      `  origin: ${task.origin}`,
      `  status: ${task.status}`,
      `  pid: ${task.pid ?? "(none)"}`,
      `  tab: ${task.tabId ?? "(none)"}`,
      `  age: ${fmtAge(task.startedAtMs)}`,
      `  cpu: ${task.cpuPct !== null ? `${task.cpuPct.toFixed(1)}%` : "(unknown)"}`,
      `  memory: ${task.rssMb !== null ? `${task.rssMb} MB` : "(unknown)"}`,
      `  flags: ${flags || "normal"}`,
      task.recentOutputTail.trim()
        ? `  recent_output: ${task.recentOutputTail.trim().slice(-1000).replace(/\n/g, "\\n")}`
        : "  recent_output: (none)",
    ].join("\n");
  }).join("\n");

  return [
    "shellX background task report",
    "",
    `active_tab: ${context.activeTabId ?? "(none)"}`,
    `show_all_tabs: ${context.showAllTabs ? "true" : "false"}`,
    `filter: ${context.filter.trim() || "(none)"}`,
    `visible_tasks: ${tasks.length}`,
    `running: ${health.running}`,
    `paused: ${health.stopped}`,
    `exited: ${health.exited}`,
    `killed: ${health.killed}`,
    `attention: ${health.problem}`,
    `quiet_over_10m: ${health.quiet}`,
    "",
    "tasks:",
    taskLines || "(none)",
  ].join("\n");
}

const btnStyle: React.CSSProperties = {
  padding: "2px 6px",
  fontSize: "var(--right-meta-size, var(--fs-ui-xs))",
  background: "transparent",
  border: "1px solid var(--border, #333)",
  color: "inherit",
  borderRadius: 3,
  cursor: "pointer",
};

/**
 * Compact wall-clock-ago formatter for the spawn timestamp column.
 * Falls back to "—" when the stamp is unknown (0).
 */
function fmtAge(ms: number): string {
  if (!ms || ms <= 0) return "—";
  const diff = Date.now() - ms;
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
  return `${Math.floor(diff / 86_400_000)}d`;
}
