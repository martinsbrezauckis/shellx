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
 * - Pause → invoke task_pause (SIGSTOP on Unix; Windows surfaces
 * an error popup — SuspendThread is not wired yet).
 * - Resume → invoke task_resume (SIGCONT on Unix; same Windows note).
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

export function TasksPanel({
  activeTabId,
}: {
 /** when set, the panel filters out rows
 * whose tabId does NOT match. Subagent rows (host_mcp origin) have
 * no tabId in the current registry — they appear in a separate
 * "Unattributed" section below the active-tab list with a one-line
 * note documenting the limitation. */
  activeTabId?: string | null;
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
      return localStorage.getItem("tasks-panel-show-completed") === "1";
    } catch {
      return false;
    }
  });
  const onToggleShowCompleted = useCallback((next: boolean) => {
    setShowCompleted(next);
    try {
      localStorage.setItem("tasks-panel-show-completed", next ? "1" : "0");
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
  async function handleKill(taskId: string, commandDisplay: string) {
    if (!window.confirm(`Kill task "${commandDisplay}"? Sends SIGTERM, then SIGKILL after 3s.`)) {
      return;
    }
    setBusy(true);
    try {
      await invoke("task_kill", { taskId });
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

 /* scope by active session tab. Rows with a
 * tabId matching activeTabId pass; rows with tabId=null are split
 * into the "unattributed" bucket (host_mcp subagents — see below).
 * If no activeTabId is set (no session active), don't filter — fall
 * back to global view so power users can still inspect everything. */
 /* folding
 * `tab_id == null` rows into the active-tab list rather than a
 * separate "Unattributed" section. The previous bucket confused
 * users — host-MCP subagents (Agent_spawn) almost always originate
 * from the currently active grok session, but the host_mcp child
 * process doesn't propagate the parent tab id into the subagent
 * registry yet (#10 known limitation). Treating null as "belongs to
 * active session" is correct in 99%+ of cases and removes a phantom
 * UI section. Real attribution fix needs `parent_tab_id` column in
 * host_subagents + thread tabId from MCP-Tab-Id header through
 * dispatch — filed separately. */
  const filteredTasks: TaskSnapshot[] = [];
  for (const t of searchFiltered) {
    if (!activeTabId) {
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
          alignItems: "center",
          gap: 8,
          padding: "8px 10px",
          borderBottom: "1px solid var(--border, #222)",
        }}
      >
        <strong style={{ fontSize: "var(--fs-ui-sm)" }}>Background Tasks</strong>
 {/* dropped the "X this session · Y total"
 * sub-label. Redundant noise: the same count is now visible
 * in the header pill ("X working"), and the panel itself
 * lists the rows below, so showing a separate count up here
 * just added clutter. */}
        <span style={{ flex: 1 }} />
 {/* show-completed toggle. Off by default so the
 * rail only renders live (running) tasks — finished rows hide
 * as soon as the next poll sees them as exited/killed. */}
        <label
          style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: "var(--fs-ui-xs)", color: "var(--fg-muted, #888)", userSelect: "none" }}
          title="Include finished (exited/killed) rows in the list"
        >
          <input
            type="checkbox"
            checked={showCompleted}
            onChange={(e) => onToggleShowCompleted(e.target.checked)}
            style={{ margin: 0 }}
          />
          show completed
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
            fontSize: "var(--fs-ui-xs)",
            width: 120,
          }}
        />
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
            fontSize: "var(--fs-ui-xs)",
            cursor: busy ? "wait" : "pointer",
          }}
        >
          ↻
        </button>
      </div>
      {error && (
        <div
          role="alert"
          style={{
            color: "var(--fg-error, #f55)",
            fontSize: 12,
            padding: "6px 10px",
            background: "rgba(255, 85, 85, 0.05)",
            borderBottom: "1px solid var(--border, #222)",
          }}
        >
          {error}
        </div>
      )}
      <div style={{ flex: 1, overflow: "auto" }}>
        {tasks.length === 0 ? (
          <div style={{ padding: 16, fontSize: 12, color: "var(--fg-muted, #888)" }}>
            No live background tasks. Spawn a grok session or open a terminal to see them here.
          </div>
        ) : (
          <>
            {sections.map((sec) => (
              <div key={sec.origin}>
                <div
                  style={{
                    fontSize: 10,
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
                    onPause={() => void handlePause(t.taskId)}
                    onResume={() => void handleResume(t.taskId)}
                    onKill={() => void handleKill(t.taskId, t.commandDisplay)}
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

interface TaskRowProps {
  task: TaskSnapshot;
  expanded: boolean;
  busy: boolean;
  onToggle: () => void;
  onPause: () => void;
  onResume: () => void;
  onKill: () => void;
}

function TaskRow({
  task,
  expanded,
  busy,
  onToggle,
  onPause,
  onResume,
  onKill,
}: TaskRowProps): JSX.Element {
  const isRunning = task.status === "running";
  const isStopped = task.status === "stopped";
  const isDead = task.status === "exited" || task.status === "killed";

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
      <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}>
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
          {expanded ? "▾" : "▸"}
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
            fontSize: 12,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            flex: 1,
          }}
          title={task.commandDisplay}
        >
          {task.commandDisplay}
        </span>
        <span style={{ fontSize: "var(--fs-ui-xs)", color: "var(--fg-muted, #888)", flexShrink: 0 }}>
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
          fontSize: "var(--fs-ui-xs)",
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
            ⏸ Pause
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
            ▶ Resume
          </button>
        )}
        {!isDead && (
          <button
            type="button"
            onClick={onKill}
            disabled={busy || task.pid === null}
            title="Kill (SIGTERM then SIGKILL after 3s)"
            style={{ ...btnStyle, borderColor: "var(--fg-error, #f55)", color: "var(--fg-error, #f55)" }}
          >
            ✕ Kill
          </button>
        )}
      </div>
      {expanded && task.recentOutputTail && (
        <pre
          style={{
            marginLeft: 24,
            marginTop: 4,
            padding: 6,
            fontSize: "var(--fs-ui-xs)",
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
            fontSize: "var(--fs-ui-xs)",
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

const btnStyle: React.CSSProperties = {
  padding: "2px 6px",
  fontSize: "var(--fs-ui-xs)",
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
