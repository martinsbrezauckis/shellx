import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useMemo, useState, type JSX } from "react";
import {
  buildActivityGraph,
  buildActivityTree,
  combineActivityTraces,
  parseGrokUpdatesJsonl,
  parseHunkRecordsJsonl,
  summarizeActivity,
  totalCount,
  type ActivityAction,
  type ActivityActionCounts,
  type ActivityGraph,
  type ActivityGraphNode,
  type ActivityKind,
  type ActivityTreeNode,
} from "../lib/session-activity";
import { inTauri } from "../lib/tauri-bridge";
import { ShellIcon } from "./icons";

type ActivityView = "files" | "graph" | "timeline" | "summary";

interface SessionActivitySource {
  tabId: string;
  sessionId: string | null;
  cwd: string | null;
  transport: string;
  status: string;
  readable: boolean;
  scratchDir: string | null;
  hunkRecordsPath: string | null;
  hunkRecordsJsonl: string;
  updatesPath: string | null;
  updatesJsonl: string;
  note: string | null;
}

export function ActivityBrowserModal({
  open,
  tabId,
  sessionId,
  sessionCwd,
  transport,
  onClose,
  onPreviewFile,
  onAskAgent,
}: {
  open: boolean;
  tabId?: string | null;
  sessionId?: string | null;
  sessionCwd?: string | null;
  transport?: string | null;
  onClose: () => void;
  onPreviewFile?: (path: string) => void;
  onAskAgent?: (prompt: string) => void;
}): JSX.Element | null {
  const [view, setView] = useState<ActivityView>("files");
  const [source, setSource] = useState<SessionActivitySource | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set(["root:"]));

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  useEffect(() => {
    if (!open) {
      setSource(null);
      setErr(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setErr(null);
    setSource(null);

    if (!inTauri()) {
      setLoading(false);
      setErr("Activity Browser needs the Tauri host to read Grok session files.");
      return;
    }

    void invoke<SessionActivitySource>("read_session_activity_source", {
      tabId: tabId ?? undefined,
      sessionId: sessionId ?? undefined,
      sessionCwd: sessionCwd ?? undefined,
      transport: transport ?? undefined,
    })
      .then((next) => {
        if (!cancelled) setSource(next);
      })
      .catch((e) => {
        if (!cancelled) setErr(typeof e === "string" ? e : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [open, tabId, sessionId, sessionCwd, transport]);

  const rootPath = source?.cwd || sessionCwd || "";
  const trace = useMemo(() => {
    if (!source?.readable) return null;
    const hunkTrace = parseHunkRecordsJsonl(source.hunkRecordsJsonl, {
      rootPath,
      sourcePath: source.hunkRecordsPath ?? undefined,
    });
    const updateTrace = parseGrokUpdatesJsonl(source.updatesJsonl ?? "", {
      rootPath,
      sourcePath: source.updatesPath ?? undefined,
    });
    return combineActivityTraces([hunkTrace, updateTrace]);
  }, [rootPath, source]);

  const actions = trace?.actions ?? [];
  const tree = useMemo(() => buildActivityTree(actions, rootPath), [actions, rootPath]);
  const graph = useMemo(() => buildActivityGraph(actions, rootPath, { maxTargetNodes: 48 }), [actions, rootPath]);
  const summary = useMemo(() => summarizeActivity(actions), [actions]);

  useEffect(() => {
    if (!open || actions.length === 0) return;
    const next = new Set<string>(["root:"]);
    for (const child of tree.children) {
      if (child.kind === "dir") next.add(child.id);
    }
    setExpanded(next);
  }, [actions.length, open, tree]);

  const toggle = useCallback((id: string) => {
    setExpanded((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const openFile = useCallback((path: string) => {
    onClose();
    onPreviewFile?.(path);
  }, [onClose, onPreviewFile]);

  const askAgent = useCallback(() => {
    if (!tabId || !onAskAgent) return;
    onClose();
    onAskAgent(
      `Use the ShellX debug API endpoint GET /state/session_activity?tabId=${tabId} and summarize this session's file activity. Separate verified hunk records from observed tool calls and inferred terminal-command activity. Call out local/remote storage gaps.`,
    );
  }, [onAskAgent, onClose, tabId]);

  const copySummary = useCallback(() => {
    const lines = [
      `Session activity: ${source?.sessionId ?? "(no session)"}`,
      `status: ${source?.status ?? "unknown"}`,
      `transport: ${source?.transport ?? "unknown"}`,
      `actions: ${summary.total}`,
      `verified: ${summary.verified}`,
      `observed: ${summary.observed}`,
      `inferred: ${summary.inferred}`,
      `agent written: ${summary.agentWritten}`,
      `agent deleted: ${summary.agentDeleted}`,
      `reads: ${summary.read}`,
      `lists: ${summary.listed}`,
      `searches: ${summary.searched}`,
      `hunk source: ${source?.hunkRecordsPath ?? "(none)"}`,
      `update source: ${source?.updatesPath ?? "(none)"}`,
    ];
    try { void navigator.clipboard.writeText(lines.join("\n")); } catch { /* no-op */ }
  }, [source, summary]);

  if (!open) return null;

  return (
    <div
      className="preview-backdrop"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Activity Browser"
    >
      <div className="preview-modal activity-modal" onClick={(e) => e.stopPropagation()}>
        <div className="preview-head">
          <span className="preview-fname" title={rootPath || undefined}>Activity Browser</span>
          <span className="preview-kind">trace</span>
          <span className="preview-lines">{actions.length} actions</span>
          <div className="preview-mode-toggle" role="tablist" aria-label="Activity view">
            <button
              type="button"
              className={view === "files" ? "active" : ""}
              onClick={() => setView("files")}
              aria-selected={view === "files"}
            >
              Files
            </button>
            <button
              type="button"
              className={view === "graph" ? "active" : ""}
              onClick={() => setView("graph")}
              aria-selected={view === "graph"}
            >
              Graph
            </button>
            <button
              type="button"
              className={view === "timeline" ? "active" : ""}
              onClick={() => setView("timeline")}
              aria-selected={view === "timeline"}
            >
              Timeline
            </button>
            <button
              type="button"
              className={view === "summary" ? "active" : ""}
              onClick={() => setView("summary")}
              aria-selected={view === "summary"}
            >
              Summary
            </button>
          </div>
          <button type="button" className="preview-close" onClick={onClose} aria-label="Close (Esc)" title="Close (Esc)">
            <ShellIcon name="close" size={14} />
          </button>
        </div>

        <div className="preview-body activity-body">
          {err && <div className="preview-err">{err}</div>}
          {loading && !err && <div className="preview-loading">Loading activity trace...</div>}

          {!loading && !err && source && !source.readable && (
            <ActivityEmpty source={source} />
          )}

          {!loading && !err && source?.readable && actions.length === 0 && (
            <div className="activity-empty">
              <div className="activity-empty-title">No parseable file activity yet</div>
              <div className="activity-empty-detail">
                {emptyReadableDetail(source)}
              </div>
              <div className="activity-source-grid">
                <ActivityMeta label="Status" value={activityStatusLabel(source.status)} rawValue={source.status} />
                <ActivityMeta label="Transport" value={source.transport} />
                <ActivityMeta label="Session" value={source.sessionId ?? "-"} />
                <ActivityMeta label="Grok folder" value={source.scratchDir ?? "-"} />
                <ActivityMeta label="Hunk log" value={source.hunkRecordsPath ?? "-"} />
                <ActivityMeta label="Updates log" value={source.updatesPath ?? "-"} />
              </div>
            </div>
          )}

          {!loading && !err && source?.readable && actions.length > 0 && view === "files" && (
            <div className="activity-layout">
              <ActivityStats summary={summary} />
              <div className="activity-tree" role="tree" aria-label="Session activity file tree">
                <ActivityNodeRow
                  node={tree}
                  depth={0}
                  expanded={expanded}
                  onToggle={toggle}
                  onOpenFile={openFile}
                />
              </div>
            </div>
          )}

          {!loading && !err && source?.readable && actions.length > 0 && view === "graph" && (
            <ActivityGraphView graph={graph} summary={summary} onOpenFile={openFile} />
          )}

          {!loading && !err && source?.readable && actions.length > 0 && view === "timeline" && (
            <ActivityTimeline actions={actions} onOpenFile={openFile} />
          )}

          {!loading && !err && source?.readable && actions.length > 0 && view === "summary" && (
            <ActivitySummaryView source={source} summary={summary} actions={actions} />
          )}
        </div>

        <div className="preview-actions">
          <button type="button" className="pact" onClick={copySummary} disabled={!source}>
            Copy summary
          </button>
          <button type="button" className="pact" onClick={askAgent} disabled={!tabId || !onAskAgent}>
            Ask agent
          </button>
          <button type="button" className="pact" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

interface GraphLayoutNode {
  node: ActivityGraphNode;
  x: number;
  y: number;
}

interface GraphLayout {
  nodes: GraphLayoutNode[];
  byId: Map<string, GraphLayoutNode>;
}

function ActivityGraphView({
  graph,
  summary,
  onOpenFile,
}: {
  graph: ActivityGraph;
  summary: ReturnType<typeof summarizeActivity>;
  onOpenFile: (path: string) => void;
}): JSX.Element {
  const layout = useMemo(() => layoutActivityGraph(graph), [graph]);
  const [selectedId, setSelectedId] = useState("session:root");
  const selected = graph.nodes.find((node) => node.id === selectedId) ?? graph.nodes[0];
  const selectedActions = selected?.actions.slice(0, 6) ?? [];

  useEffect(() => {
    if (!graph.nodes.some((node) => node.id === selectedId)) setSelectedId("session:root");
  }, [graph.nodes, selectedId]);

  return (
    <div className="activity-graph-view">
      <ActivityStats summary={summary} />
      {graph.hiddenTargetCount > 0 && (
        <div className="activity-graph-overflow">
          Showing the {graph.targetCount - graph.hiddenTargetCount} busiest targets; {graph.hiddenTargetCount} quieter paths are hidden to keep the graph readable.
        </div>
      )}
      <div className="activity-graph-shell">
        <div className="activity-graph-canvas" aria-label="Session activity graph">
          <svg className="activity-graph-edges" viewBox="0 0 1000 560" aria-hidden="true">
            {graph.edges.map((edge) => {
              const from = layout.byId.get(edge.from);
              const to = layout.byId.get(edge.to);
              if (!from || !to) return null;
              return (
                <line
                  key={edge.id}
                  className={`activity-graph-edge activity-graph-edge-${edge.confidence}`}
                  x1={from.x}
                  y1={from.y}
                  x2={to.x}
                  y2={to.y}
                  strokeWidth={Math.min(6, 0.75 + Math.sqrt(edge.count))}
                />
              );
            })}
          </svg>
          {layout.nodes.map(({ node, x, y }) => {
            const dominant = dominantKind(node.counts);
            return (
              <button
                type="button"
                key={node.id}
                className={[
                  "activity-graph-node",
                  `activity-graph-node-${node.kind}`,
                  `activity-graph-node-${node.confidence}`,
                  dominant ? `activity-graph-node-${dominant}` : "",
                  selected?.id === node.id ? "selected" : "",
                ].filter(Boolean).join(" ")}
                style={{ left: `${x / 10}%`, top: `${y / 5.6}%` }}
                title={node.relativePath || node.label}
                onClick={() => setSelectedId(node.id)}
              >
                <span className="activity-graph-node-kind">{graphNodeKindLabel(node)}</span>
                <span className="activity-graph-node-label">{node.label}</span>
                <span className="activity-graph-node-count">{node.count}</span>
              </button>
            );
          })}
        </div>
        <div className="activity-graph-detail">
          {selected ? (
            <>
              <div className="activity-graph-detail-kicker">{graphNodeKindLabel(selected)}</div>
              <div className="activity-graph-detail-title" title={selected.relativePath || selected.label}>
                {selected.relativePath && selected.relativePath !== "." ? selected.relativePath : selected.label}
              </div>
              <div className="activity-graph-detail-row">
                <span>Confidence</span>
                <strong className={`activity-confidence activity-confidence-${selected.confidence}`}>{selected.confidence}</strong>
              </div>
              <div className="activity-graph-detail-row">
                <span>Actions</span>
                <strong>{selected.count}</strong>
              </div>
              <ActivityCountChips counts={selected.counts} />
              {selected.kind === "file" && selected.path && (
                <button type="button" className="pact activity-graph-open" onClick={() => onOpenFile(selected.path!)}>
                  Open file
                </button>
              )}
              <div className="activity-graph-recent">
                <span>Recent evidence</span>
                {selectedActions.length === 0 ? (
                  <code>-</code>
                ) : selectedActions.map((action) => (
                  <button
                    type="button"
                    key={action.id}
                    onClick={() => onOpenFile(action.path)}
                    title={action.path}
                  >
                    <span>{formatTime(action.timestampMs)}</span>
                    <strong>{action.kind}</strong>
                    <em>{action.relativePath || action.name}</em>
                  </button>
                ))}
              </div>
            </>
          ) : (
            <div className="activity-empty-detail">No graph node selected.</div>
          )}
        </div>
      </div>
    </div>
  );
}

function layoutActivityGraph(graph: ActivityGraph): GraphLayout {
  const byKind = {
    session: graph.nodes.filter((node) => node.kind === "session"),
    action: graph.nodes.filter((node) => node.kind === "action"),
    folder: graph.nodes.filter((node) => node.kind === "folder"),
    file: graph.nodes.filter((node) => node.kind === "file"),
  };
  const placed: GraphLayoutNode[] = [];

  for (const node of byKind.session) placed.push({ node, x: 500, y: 280 });
  placeRing(placed, byKind.action, 500, 280, 190, 118, -Math.PI / 2);
  placeRing(placed, byKind.folder, 500, 280, 330, 190, -Math.PI * 0.82);
  placeRing(placed, byKind.file, 500, 280, 430, 246, -Math.PI * 0.7);

  return {
    nodes: placed,
    byId: new Map(placed.map((item) => [item.node.id, item])),
  };
}

function placeRing(
  placed: GraphLayoutNode[],
  nodes: ActivityGraphNode[],
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  startAngle: number,
): void {
  const count = nodes.length;
  if (count === 0) return;
  nodes.forEach((node, index) => {
    const angle = startAngle + (Math.PI * 2 * index) / count;
    placed.push({
      node,
      x: cx + Math.cos(angle) * rx,
      y: cy + Math.sin(angle) * ry,
    });
  });
}

function graphNodeKindLabel(node: ActivityGraphNode): string {
  if (node.kind === "action") return node.actionKind ?? "action";
  return node.kind;
}

function ActivityEmpty({ source }: { source: SessionActivitySource }): JSX.Element {
  return (
    <div className="activity-empty">
      <div className="activity-empty-title">{emptyTitle(source.status)}</div>
      <div className="activity-empty-detail">{source.note || "No trusted activity source is available for this session."}</div>
      <div className="activity-source-grid">
        <ActivityMeta label="Status" value={activityStatusLabel(source.status)} rawValue={source.status} />
        <ActivityMeta label="Transport" value={source.transport} />
        <ActivityMeta label="Session" value={source.sessionId ?? "-"} />
        <ActivityMeta label="Grok folder" value={source.scratchDir ?? "-"} />
        <ActivityMeta label="Hunk log" value={source.hunkRecordsPath ?? "-"} />
        <ActivityMeta label="Updates log" value={source.updatesPath ?? "-"} />
      </div>
    </div>
  );
}

function emptyTitle(status: string): string {
  if (status === "remote-not-mirrored") return "Remote trace is not mirrored locally";
  if (status === "restored-transport-not-live") return "Trace needs a live transport";
  if (status === "missing-hunk-records" || status === "missing-activity-logs") return "No activity logs yet";
  if (status === "no-file-activity") return "No file activity yet";
  if (status === "updates-too-large") return "Updates log is too large";
  if (status === "no-session") return "No live session";
  return "Trace source unavailable";
}

function emptyReadableDetail(source: SessionActivitySource): string {
  if (source.status === "observed-updates-only") {
    return "Grok wrote tool updates without hunk records, but none of those updates exposed file paths ShellX can classify yet.";
  }
  if (source.hunkRecordsJsonl.trim().length > 0) {
    return "The Grok hunk log exists, but it did not contain parseable file records.";
  }
  if (source.updatesJsonl.trim().length > 0) {
    return "The Grok updates log exists, but it did not contain file-path tool calls ShellX can classify yet.";
  }
  return "No file activity records are available for this session yet.";
}

function activityStatusLabel(status: string): string {
  switch (status) {
    case "ready": return "Ready";
    case "observed-updates-only": return "Updates only";
    case "no-file-activity": return "No file activity";
    case "missing-activity-logs": return "No activity logs";
    case "updates-too-large": return "Updates too large";
    case "too-large": return "Hunk log too large";
    case "missing-hunk-records": return "No hunk records";
    case "restored-transport-not-live": return "Needs live transport";
    case "no-session": return "No live session";
    case "missing-cwd": return "Missing workspace";
    case "no-grok-session-id": return "No Grok session id";
    default: return status;
  }
}

function ActivityStats({ summary }: { summary: ReturnType<typeof summarizeActivity> }): JSX.Element {
  return (
    <div className="activity-stats">
      <ActivityStat label="Actions" value={summary.total} />
      <ActivityStat label="Verified" value={summary.verified} />
      <ActivityStat label="Observed" value={summary.observed} />
      <ActivityStat label="Inferred" value={summary.inferred} />
      <ActivityStat label="Agent writes" value={summary.agentWritten} />
      <ActivityStat label="Reads" value={summary.read} />
      <ActivityStat label="Search/list" value={summary.searched + summary.listed} />
    </div>
  );
}

function ActivityStat({ label, value }: { label: string; value: number }): JSX.Element {
  return (
    <div className="activity-stat">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function ActivityNodeRow({
  node,
  depth,
  expanded,
  onToggle,
  onOpenFile,
}: {
  node: ActivityTreeNode;
  depth: number;
  expanded: Set<string>;
  onToggle: (id: string) => void;
  onOpenFile: (path: string) => void;
}): JSX.Element {
  const isOpen = node.kind === "root" || expanded.has(node.id);
  const canExpand = node.children.length > 0;
  const dominant = dominantKind(node.counts);
  const rowTitle = node.kind === "root" ? node.path : node.relativePath;
  return (
    <>
      {node.kind !== "root" && (
        <div
          className={`activity-row activity-${dominant ?? "none"}`}
          style={{ paddingLeft: 12 + depth * 16 }}
          role="treeitem"
          aria-expanded={canExpand ? isOpen : undefined}
        >
          <button
            type="button"
            className="activity-twist"
            onClick={() => canExpand && onToggle(node.id)}
            disabled={!canExpand}
            aria-label={canExpand ? (isOpen ? "Collapse folder" : "Expand folder") : "File"}
          >
            {canExpand && <ShellIcon name={isOpen ? "chevron-down" : "chevron-right"} size={12} />}
          </button>
          <button
            type="button"
            className={`activity-name activity-name-${node.kind}`}
            title={rowTitle}
            onClick={() => node.kind === "file" ? onOpenFile(node.path) : onToggle(node.id)}
          >
            <span className="activity-glyph" aria-hidden="true">
              <ShellIcon name={node.kind === "dir" ? "folder" : "file"} size={13} />
            </span>
            <span>{node.name}</span>
          </button>
          <ActivityCountChips counts={node.counts} />
        </div>
      )}
      {isOpen && node.children.map((child) => (
        <ActivityNodeRow
          key={child.id}
          node={child}
          depth={node.kind === "root" ? depth : depth + 1}
          expanded={expanded}
          onToggle={onToggle}
          onOpenFile={onOpenFile}
        />
      ))}
    </>
  );
}

function ActivityTimeline({
  actions,
  onOpenFile,
}: {
  actions: ActivityAction[];
  onOpenFile: (path: string) => void;
}): JSX.Element {
  return (
    <div className="activity-timeline">
      {actions.map((action) => (
        <button
          type="button"
          key={action.id}
          className={`activity-event activity-${action.kind}`}
          onClick={() => onOpenFile(action.path)}
          title={action.path}
        >
          <span className="activity-event-time">{formatTime(action.timestampMs)}</span>
          <span className="activity-chip">{action.kind}</span>
          <span className={`activity-confidence activity-confidence-${action.confidence}`}>{action.confidence}</span>
          <span className="activity-actor">{action.actor}</span>
          <span className="activity-event-path">{action.relativePath}</span>
          <span className="activity-event-lines">{formatActionTail(action)}</span>
        </button>
      ))}
    </div>
  );
}

function ActivitySummaryView({
  source,
  summary,
  actions,
}: {
  source: SessionActivitySource;
  summary: ReturnType<typeof summarizeActivity>;
  actions: ActivityAction[];
}): JSX.Element {
  const newest = actions[actions.length - 1];
  const oldest = actions[0];
  return (
    <div className="activity-summary-view">
      <ActivityStats summary={summary} />
      <div className="activity-source-grid">
        <ActivityMeta label="Status" value={activityStatusLabel(source.status)} rawValue={source.status} />
        <ActivityMeta label="Transport" value={source.transport} />
        <ActivityMeta label="Session" value={source.sessionId ?? "-"} />
        <ActivityMeta label="Workspace" value={source.cwd ?? "-"} />
        <ActivityMeta label="Grok folder" value={source.scratchDir ?? "-"} />
        <ActivityMeta label="Hunk log" value={source.hunkRecordsPath ?? "-"} />
        <ActivityMeta label="Updates log" value={source.updatesPath ?? "-"} />
        <ActivityMeta label="First event" value={formatTime(oldest?.timestampMs)} />
        <ActivityMeta label="Last event" value={formatTime(newest?.timestampMs)} />
      </div>
    </div>
  );
}

function ActivityMeta({ label, value, rawValue }: { label: string; value: string; rawValue?: string }): JSX.Element {
  return (
    <div className="activity-meta">
      <span>{label}</span>
      <code title={rawValue ? `${value} (${rawValue})` : value}>{value}</code>
    </div>
  );
}

function ActivityCountChips({ counts }: { counts: ActivityActionCounts }): JSX.Element {
  if (totalCount(counts) === 0) return <span className="activity-counts" />;
  return (
    <span className="activity-counts">
      {countChip("searched", counts.searched)}
      {countChip("read", counts.read + counts.opened)}
      {countChip("written", counts.written + counts.created)}
      {countChip("deleted", counts.deleted)}
      {countChip("executed", counts.executed + counts.listed)}
    </span>
  );
}

function countChip(kind: ActivityKind, count: number): JSX.Element | null {
  if (count <= 0) return null;
  return <span key={kind} className={`activity-chip activity-chip-${kind}`}>{chipLabel(kind)} {count}</span>;
}

function chipLabel(kind: ActivityKind): string {
  if (kind === "searched") return "search";
  if (kind === "read") return "read";
  if (kind === "written") return "write";
  if (kind === "deleted") return "delete";
  if (kind === "executed") return "exec";
  return kind;
}

function dominantKind(counts: ActivityActionCounts): ActivityKind | null {
  const priority: ActivityKind[] = ["deleted", "written", "created", "read", "opened", "searched", "listed", "executed"];
  return priority.find((kind) => counts[kind] > 0) ?? null;
}

function formatTime(ms: number | undefined): string {
  if (!ms) return "-";
  try {
    return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  } catch {
    return "-";
  }
}

function formatLines(action: ActivityAction): string {
  const added = action.linesAdded ?? 0;
  const removed = action.linesRemoved ?? 0;
  if (added === 0 && removed === 0) return "";
  return `+${added} -${removed}`;
}

function formatActionTail(action: ActivityAction): string {
  const lines = formatLines(action);
  if (lines) return lines;
  if (action.query) return action.query;
  if (action.command) return "cmd";
  return action.source.replace("_", " ");
}
