import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type JSX, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import {
  buildActivityGraph,
  buildActivityTree,
  combineActivityTraces,
  filterActivityActions,
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
import {
  buildStatusLabel,
  getBuildReceipts,
  getBuildState,
  type BuildReceipt,
  type BuildRunState,
} from "../lib/build-run";
import { inTauri } from "../lib/tauri-bridge";
import { ShellIcon, type ShellIconName } from "./icons";

type ActivityView = "files" | "graph" | "evidence" | "timeline" | "summary";
type ActivityEvidenceSectionKey = "changes" | "reads" | "commands" | "git";
const ACTIVITY_GRAPH_WIDTH = 1000;
const ACTIVITY_GRAPH_HEIGHT = 560;

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
  const [activityQuery, setActivityQuery] = useState("");
  const [source, setSource] = useState<SessionActivitySource | null>(null);
  const [buildState, setBuildState] = useState<BuildRunState | null>(null);
  const [buildReceipts, setBuildReceipts] = useState<BuildReceipt[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set(["root:"]));
  const modalRef = useRef<HTMLDivElement | null>(null);
  const resizingActivityModalRef = useRef(false);
  const suppressBackdropClickRef = useRef(false);
  const suppressBackdropClickTimerRef = useRef<number | null>(null);
  const [modalSize, setModalSize] = useState({ width: 1180, height: 860 });

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
      setBuildState(null);
      setBuildReceipts([]);
      setErr(null);
      setLoading(false);
      setActivityQuery("");
      return;
    }
    let cancelled = false;
    setLoading(true);
    setErr(null);
    setSource(null);

    if (!inTauri()) {
      setLoading(false);
      setErr("Activity Browser needs the Tauri host to read session activity files.");
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

    if (tabId) {
      void getBuildState(tabId)
        .then((next) => {
          if (!cancelled) setBuildState(next);
        })
        .catch(() => {
          if (!cancelled) setBuildState(null);
        });
      void getBuildReceipts(tabId)
        .then((next) => {
          if (!cancelled) setBuildReceipts(next);
        })
        .catch(() => {
          if (!cancelled) setBuildReceipts([]);
        });
    } else {
      setBuildState(null);
      setBuildReceipts([]);
    }

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
  const hasBuildAudit = Boolean(buildState) || buildReceipts.length > 0;
  const filteredActions = useMemo(() => filterActivityActions(actions, activityQuery), [actions, activityQuery]);
  const activityQueryText = activityQuery.trim();
  const isActivityFiltered = activityQueryText.length > 0;
  const visibleActions = isActivityFiltered ? filteredActions : actions;
  const tree = useMemo(() => buildActivityTree(visibleActions, rootPath), [rootPath, visibleActions]);
  const graph = useMemo(() => buildActivityGraph(visibleActions, rootPath, { maxTargetNodes: 48 }), [rootPath, visibleActions]);
  const summary = useMemo(() => summarizeActivity(visibleActions), [visibleActions]);
  const actionCountLabel = isActivityFiltered ? `${visibleActions.length}/${actions.length} actions` : `${actions.length} actions`;

  useEffect(() => {
    if (!open || visibleActions.length === 0) return;
    const next = new Set<string>(["root:"]);
    for (const child of tree.children) {
      if (child.kind === "dir") next.add(child.id);
    }
    setExpanded(next);
  }, [open, tree, visibleActions.length]);

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
    const query = new URLSearchParams({ tabId });
    if (source?.sessionId) query.set("sessionId", source.sessionId);
    if (source?.cwd) query.set("sessionCwd", source.cwd);
    if (source?.transport) query.set("transport", source.transport);
    const searchInstruction = activityQueryText
      ? ` Focus on entries matching the current Trace search "${activityQueryText}".`
      : "";
    onAskAgent(
      `Use the ShellX debug API endpoint GET /state/session_activity?${query.toString()} and summarize this session's file, read/search, git, and terminal activity.${searchInstruction} Separate verified hunk records from observed tool calls and inferred terminal-command activity. Call out local/remote storage gaps.`,
    );
  }, [activityQueryText, onAskAgent, onClose, source, tabId]);

  const copySummary = useCallback(() => {
    const lines = [
      `Session activity: ${source?.sessionId ?? "(no session)"}`,
      `status: ${source?.status ?? "unknown"}`,
      `transport: ${source?.transport ?? "unknown"}`,
      `search: ${activityQueryText || "(none)"}`,
      `matching actions: ${visibleActions.length}/${actions.length}`,
      `actions: ${summary.total}`,
      `verified: ${summary.verified}`,
      `observed: ${summary.observed}`,
      `inferred: ${summary.inferred}`,
      `agent written: ${summary.agentWritten}`,
      `agent deleted: ${summary.agentDeleted}`,
      `reads: ${summary.read}`,
      `lists: ${summary.listed}`,
      `searches: ${summary.searched}`,
      `git: ${summary.git}`,
      `hunk source: ${source?.hunkRecordsPath ?? "(none)"}`,
      `update source: ${source?.updatesPath ?? "(none)"}`,
    ];
    try { void navigator.clipboard.writeText(lines.join("\n")); } catch { /* no-op */ }
  }, [actions.length, activityQueryText, source, summary, visibleActions.length]);

  const resizeActivityModal = useCallback((nextWidth: number, nextHeight: number) => {
    const maxWidth = Math.max(760, window.innerWidth - 64);
    const maxHeight = Math.max(520, window.innerHeight - 64);
    setModalSize({
      width: clamp(nextWidth, 760, maxWidth),
      height: clamp(nextHeight, 520, maxHeight),
    });
  }, []);

  const handleActivityModalResizePointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const target = event.currentTarget;
    try { target.setPointerCapture(event.pointerId); } catch { /* pointer capture is best effort */ }
    resizingActivityModalRef.current = true;
    suppressBackdropClickRef.current = true;
    if (suppressBackdropClickTimerRef.current !== null) {
      window.clearTimeout(suppressBackdropClickTimerRef.current);
      suppressBackdropClickTimerRef.current = null;
    }
    const rect = modalRef.current?.getBoundingClientRect();
    const startWidth = rect?.width ?? modalSize.width;
    const startHeight = rect?.height ?? modalSize.height;
    const startX = event.clientX;
    const startY = event.clientY;
    const onMove = (moveEvent: PointerEvent) => {
      moveEvent.preventDefault();
      resizeActivityModal(
        startWidth + moveEvent.clientX - startX,
        startHeight + moveEvent.clientY - startY,
      );
    };
    const finishResize = (upEvent?: PointerEvent) => {
      upEvent?.preventDefault();
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", finishResize);
      window.removeEventListener("pointercancel", finishResize);
      try {
        if (target.hasPointerCapture(event.pointerId)) target.releasePointerCapture(event.pointerId);
      } catch { /* pointer capture release is best effort */ }
      resizingActivityModalRef.current = false;
      suppressBackdropClickTimerRef.current = window.setTimeout(() => {
        suppressBackdropClickRef.current = false;
        suppressBackdropClickTimerRef.current = null;
      }, 250);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", finishResize, { once: true });
    window.addEventListener("pointercancel", finishResize, { once: true });
  }, [modalSize.height, modalSize.width, resizeActivityModal]);

  const handleBackdropClick = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    if (resizingActivityModalRef.current || suppressBackdropClickRef.current) {
      event.preventDefault();
      event.stopPropagation();
      suppressBackdropClickRef.current = false;
      if (suppressBackdropClickTimerRef.current !== null) {
        window.clearTimeout(suppressBackdropClickTimerRef.current);
        suppressBackdropClickTimerRef.current = null;
      }
      return;
    }
    onClose();
  }, [onClose]);

  useEffect(() => () => {
    if (suppressBackdropClickTimerRef.current !== null) {
      window.clearTimeout(suppressBackdropClickTimerRef.current);
    }
  }, []);

  const handleActivityModalResizeKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 64 : 24;
    if (event.key === "ArrowRight") {
      event.preventDefault();
      resizeActivityModal(modalSize.width + step, modalSize.height);
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      resizeActivityModal(modalSize.width - step, modalSize.height);
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      resizeActivityModal(modalSize.width, modalSize.height + step);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      resizeActivityModal(modalSize.width, modalSize.height - step);
    }
  }, [modalSize.height, modalSize.width, resizeActivityModal]);

  const modalStyle = useMemo(() => ({
    "--activity-modal-width": `${modalSize.width}px`,
    "--activity-modal-height": `${modalSize.height}px`,
  }) as CSSProperties, [modalSize.height, modalSize.width]);

  if (!open) return null;

  return (
    <div
      className="preview-backdrop"
      onClick={handleBackdropClick}
      role="dialog"
      aria-modal="true"
      aria-label="Activity Browser"
    >
      <div
        ref={modalRef}
        className="preview-modal activity-modal"
        style={modalStyle}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="preview-head">
          <span className="preview-fname" title={rootPath || undefined}>Activity Browser</span>
          <span className="preview-kind">trace</span>
          <span className="preview-lines">{actionCountLabel}</span>
          <div className="preview-mode-toggle" role="tablist" aria-label="Activity view">
            <button
              type="button"
              data-debug-id="activity-tab-files"
              className={view === "files" ? "active" : ""}
              onClick={() => setView("files")}
              aria-selected={view === "files"}
            >
              Files
            </button>
            <button
              type="button"
              data-debug-id="activity-tab-graph"
              className={view === "graph" ? "active" : ""}
              onClick={() => setView("graph")}
              aria-selected={view === "graph"}
            >
              Graph
            </button>
            <button
              type="button"
              data-debug-id="activity-tab-evidence"
              className={view === "evidence" ? "active" : ""}
              onClick={() => setView("evidence")}
              aria-selected={view === "evidence"}
            >
              Evidence
            </button>
            <button
              type="button"
              data-debug-id="activity-tab-timeline"
              className={view === "timeline" ? "active" : ""}
              onClick={() => setView("timeline")}
              aria-selected={view === "timeline"}
            >
              Timeline
            </button>
            <button
              type="button"
              data-debug-id="activity-tab-summary"
              className={view === "summary" ? "active" : ""}
              onClick={() => setView("summary")}
              aria-selected={view === "summary"}
            >
              Summary
            </button>
          </div>
          <label className="activity-search" title="Search Trace actions, paths, commands, queries, and evidence">
            <ShellIcon name="search" size={13} />
            <input
              type="search"
              data-debug-id="activity-search"
              value={activityQuery}
              placeholder="Search trace"
              disabled={actions.length === 0}
              onChange={(event) => setActivityQuery(event.currentTarget.value)}
              aria-label="Search Trace activity"
            />
            {activityQueryText && (
              <button
                type="button"
                data-debug-id="activity-search-clear"
                onClick={() => setActivityQuery("")}
                aria-label="Clear Trace search"
                title="Clear Trace search"
              >
                <ShellIcon name="close" size={12} />
              </button>
            )}
          </label>
          <button type="button" className="preview-close" onClick={onClose} aria-label="Close (Esc)" title="Close (Esc)">
            <ShellIcon name="close" size={14} />
          </button>
        </div>

        <div className="preview-body activity-body">
          {err && <div className="preview-err">{err}</div>}
          {loading && !err && <div className="preview-loading">Loading activity trace...</div>}

          {!loading && !err && source && !source.readable && hasBuildAudit && (
            <ActivityBuildAudit source={source} buildState={buildState} receipts={buildReceipts} />
          )}

          {!loading && !err && source && !source.readable && !hasBuildAudit && (
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
                <ActivityMeta label="Activity folder" value={source.scratchDir ?? "-"} />
                <ActivityMeta label="Hunk log" value={source.hunkRecordsPath ?? "-"} />
                <ActivityMeta label="Updates log" value={source.updatesPath ?? "-"} />
              </div>
            </div>
          )}

          {!loading && !err && source?.readable && actions.length > 0 && visibleActions.length === 0 && (
            <ActivitySearchEmpty query={activityQueryText} total={actions.length} />
          )}

          {!loading && !err && source?.readable && visibleActions.length > 0 && view === "files" && (
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

          {!loading && !err && source?.readable && visibleActions.length > 0 && view === "graph" && (
            <ActivityGraphView graph={graph} summary={summary} onOpenFile={openFile} />
          )}

          {!loading && !err && source?.readable && visibleActions.length > 0 && view === "evidence" && (
            <ActivityEvidenceView actions={visibleActions} summary={summary} onOpenFile={openFile} />
          )}

          {!loading && !err && source?.readable && visibleActions.length > 0 && view === "timeline" && (
            <ActivityTimeline actions={visibleActions} onOpenFile={openFile} />
          )}

          {!loading && !err && source?.readable && visibleActions.length > 0 && view === "summary" && (
            <ActivitySummaryView
              source={source}
              summary={summary}
              actions={visibleActions}
              buildState={buildState}
              buildReceipts={buildReceipts}
            />
          )}
        </div>

        <div className="preview-actions activity-actions">
          <button type="button" className="pact" onClick={copySummary} disabled={!source}>
            Copy summary
          </button>
          <button type="button" className="pact" onClick={askAgent} disabled={!tabId || !onAskAgent}>
            Ask agent
          </button>
        </div>
        <div
          className="activity-modal-resize-handle"
          role="separator"
          aria-label="Resize trace panel"
          tabIndex={0}
          onPointerDown={handleActivityModalResizePointerDown}
          onKeyDown={handleActivityModalResizeKeyDown}
        />
      </div>
    </div>
  );
}

interface GraphPoint {
  x: number;
  y: number;
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
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const shellRef = useRef<HTMLDivElement | null>(null);
  const baseLayout = useMemo(() => layoutActivityGraph(graph), [graph]);
  const [nodePositions, setNodePositions] = useState<Record<string, GraphPoint>>({});
  const layout = useMemo(() => applyGraphNodePositions(baseLayout, nodePositions), [baseLayout, nodePositions]);
  const [selectedId, setSelectedId] = useState("session:root");
  const [detailWidth, setDetailWidth] = useState(320);
  const selected = graph.nodes.find((node) => node.id === selectedId) ?? graph.nodes[0];
  const selectedActions = selected?.actions.slice(0, 6) ?? [];
  const hasCustomNodePositions = Object.keys(nodePositions).length > 0;

  useEffect(() => {
    if (!graph.nodes.some((node) => node.id === selectedId)) setSelectedId("session:root");
  }, [graph.nodes, selectedId]);

  const handleNodePointerMove = useCallback((
    nodeId: string,
    start: { x: number; y: number; clientX: number; clientY: number; scaleX: number; scaleY: number },
    moveEvent: PointerEvent,
  ) => {
    moveEvent.preventDefault();
    const x = clamp(start.x + (moveEvent.clientX - start.clientX) * start.scaleX, 56, ACTIVITY_GRAPH_WIDTH - 56);
    const y = clamp(start.y + (moveEvent.clientY - start.clientY) * start.scaleY, 42, ACTIVITY_GRAPH_HEIGHT - 42);
    setNodePositions((current) => ({
      ...current,
      [nodeId]: { x, y },
    }));
  }, []);

  const handleNodePointerDown = useCallback((nodeId: string, event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    const item = layout.byId.get(nodeId);
    const canvasRect = canvasRef.current?.getBoundingClientRect();
    if (!item || !canvasRect || canvasRect.width <= 0 || canvasRect.height <= 0) return;
    event.preventDefault();
    event.stopPropagation();
    setSelectedId(nodeId);
    const start = {
      x: item.x,
      y: item.y,
      clientX: event.clientX,
      clientY: event.clientY,
      scaleX: ACTIVITY_GRAPH_WIDTH / canvasRect.width,
      scaleY: ACTIVITY_GRAPH_HEIGHT / canvasRect.height,
    };
    const onMove = (moveEvent: PointerEvent) => handleNodePointerMove(nodeId, start, moveEvent);
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp, { once: true });
  }, [handleNodePointerMove, layout.byId]);

  const resizeGraphDetail = useCallback((nextWidth: number) => {
    const shellWidth = shellRef.current?.getBoundingClientRect().width ?? 900;
    const maxWidth = clamp(shellWidth - 360, 260, 640);
    setDetailWidth(clamp(nextWidth, 240, maxWidth));
  }, []);

  const handleGraphDetailResizePointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const startWidth = detailWidth;
    const startX = event.clientX;
    const onMove = (moveEvent: PointerEvent) => {
      moveEvent.preventDefault();
      resizeGraphDetail(startWidth - (moveEvent.clientX - startX));
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp, { once: true });
  }, [detailWidth, resizeGraphDetail]);

  const handleGraphDetailResizeKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 64 : 24;
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      resizeGraphDetail(detailWidth + step);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      resizeGraphDetail(detailWidth - step);
    }
  }, [detailWidth, resizeGraphDetail]);

  const graphShellStyle = useMemo(() => ({
    "--activity-graph-detail-width": `${detailWidth}px`,
  }) as CSSProperties, [detailWidth]);

  return (
    <div className="activity-graph-view">
      <ActivityStats summary={summary} />
      {graph.hiddenTargetCount > 0 && (
        <div className="activity-graph-overflow">
          Showing the {graph.targetCount - graph.hiddenTargetCount} busiest targets; {graph.hiddenTargetCount} quieter paths are hidden to keep the graph readable.
        </div>
      )}
      <div ref={shellRef} className="activity-graph-shell" style={graphShellStyle}>
        <div ref={canvasRef} className="activity-graph-canvas" aria-label="Session activity graph">
          <div className="activity-graph-legend" aria-label="Activity confidence legend">
            <span className="activity-graph-legend-item activity-graph-legend-verified"><i />Verified</span>
            <span className="activity-graph-legend-item activity-graph-legend-observed"><i />Observed</span>
            <span className="activity-graph-legend-item activity-graph-legend-inferred"><i />Inferred</span>
          </div>
          {hasCustomNodePositions && (
            <div className="activity-graph-controls">
              <button type="button" className="activity-graph-reset" onClick={() => setNodePositions({})} title="Reset graph layout" aria-label="Reset graph layout">
                <ShellIcon name="rotate" size={13} />
              </button>
            </div>
          )}
          <svg
            className="activity-graph-edges"
            viewBox={`0 0 ${ACTIVITY_GRAPH_WIDTH} ${ACTIVITY_GRAPH_HEIGHT}`}
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            {graph.edges.map((edge) => {
              const from = layout.byId.get(edge.from);
              const to = layout.byId.get(edge.to);
              if (!from || !to) return null;
              return (
                <path
                  key={edge.id}
                  className={`activity-graph-edge activity-graph-edge-${edge.confidence}`}
                  d={graphEdgePath(from, to)}
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
                style={{
                  left: `${(x / ACTIVITY_GRAPH_WIDTH) * 100}%`,
                  top: `${(y / ACTIVITY_GRAPH_HEIGHT) * 100}%`,
                }}
                title={node.relativePath || node.label}
                onClick={() => setSelectedId(node.id)}
                onPointerDown={(event) => handleNodePointerDown(node.id, event)}
              >
                <span className="activity-graph-node-icon" aria-hidden="true">
                  <ShellIcon name={graphNodeIconName(node)} size={14} />
                </span>
                <span className="activity-graph-node-kind">{graphNodeKindLabel(node)}</span>
                <span className="activity-graph-node-label">{node.label}</span>
                <span className="activity-graph-node-count">{node.count}</span>
              </button>
            );
          })}
        </div>
        <div
          className="activity-graph-detail-resizer"
          role="separator"
          aria-label="Resize graph details"
          aria-orientation="vertical"
          tabIndex={0}
          onPointerDown={handleGraphDetailResizePointerDown}
          onKeyDown={handleGraphDetailResizeKeyDown}
        />
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

function applyGraphNodePositions(layout: GraphLayout, nodePositions: Record<string, GraphPoint>): GraphLayout {
  const nodes = layout.nodes.map((item) => {
    const position = nodePositions[item.node.id];
    return position ? { ...item, x: position.x, y: position.y } : item;
  });
  return {
    nodes,
    byId: new Map(nodes.map((item) => [item.node.id, item])),
  };
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

function graphEdgePath(from: GraphLayoutNode, to: GraphLayoutNode): string {
  const dx = to.x - from.x;
  const bend = clamp(Math.abs(dx) * 0.42, 48, 180);
  const c1x = from.x + Math.sign(dx || 1) * bend;
  const c2x = to.x - Math.sign(dx || 1) * bend;
  return `M ${from.x.toFixed(1)} ${from.y.toFixed(1)} C ${c1x.toFixed(1)} ${from.y.toFixed(1)}, ${c2x.toFixed(1)} ${to.y.toFixed(1)}, ${to.x.toFixed(1)} ${to.y.toFixed(1)}`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
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

function graphNodeIconName(node: ActivityGraphNode): ShellIconName {
  if (node.kind === "session") return "trace";
  if (node.kind === "folder") return "folder";
  if (node.kind === "file") return "file";
  if (node.actionKind === "searched") return "search";
  if (node.actionKind === "listed") return "folder-open";
  if (node.actionKind === "read" || node.actionKind === "opened") return "file";
  if (node.actionKind === "written" || node.actionKind === "created") return "pencil";
  if (node.actionKind === "deleted") return "trash";
  if (node.actionKind === "git") return "git-branch";
  if (node.actionKind === "executed") return "terminal";
  return "activity";
}

function ActivitySearchEmpty({ query, total }: { query: string; total: number }): JSX.Element {
  return (
    <div className="activity-empty">
      <div className="activity-empty-title">No matching activity</div>
      <div className="activity-empty-detail">
        Search checked {total} actions across paths, commands, queries, tool names, sources, and timestamps for "{query}".
      </div>
    </div>
  );
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
        <ActivityMeta label="Activity folder" value={source.scratchDir ?? "-"} />
        <ActivityMeta label="Hunk log" value={source.hunkRecordsPath ?? "-"} />
        <ActivityMeta label="Updates log" value={source.updatesPath ?? "-"} />
      </div>
    </div>
  );
}

function ActivityBuildAudit({
  source,
  buildState,
  receipts,
}: {
  source: SessionActivitySource;
  buildState: BuildRunState | null;
  receipts: BuildReceipt[];
}): JSX.Element {
  return (
    <div className="activity-empty">
      <div className="activity-empty-title">Build receipt ledger available</div>
      <div className="activity-empty-detail">
        {source.note || "The file trace source is unavailable, but Build Mode receipts are still persisted for this tab."}
      </div>
      <div className="activity-source-grid">
        <ActivityMeta label="Trace status" value={activityStatusLabel(source.status)} rawValue={source.status} />
        <ActivityMeta label="Build status" value={buildStatusLabel(buildState?.status)} rawValue={buildState?.status} />
        <ActivityMeta label="Run" value={buildState?.runId ?? receipts[0]?.runId ?? "-"} />
        <ActivityMeta label="Receipts" value={String(receipts.length)} />
        <ActivityMeta label="Checkpoint" value={buildState?.checkpointId ?? "-"} />
        <ActivityMeta label="Workspace" value={buildState?.cwd ?? source.cwd ?? "-"} />
      </div>
      <BuildReceiptLedger receipts={receipts} />
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
    return "The agent wrote tool updates without hunk records, but none of those updates exposed file paths ShellX can classify yet.";
  }
  if (source.hunkRecordsJsonl.trim().length > 0) {
    return "The hunk log exists, but it did not contain parseable file records.";
  }
  if (source.updatesJsonl.trim().length > 0) {
    return "The agent updates log exists, but it did not contain file-path tool calls ShellX can classify yet.";
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
    case "no-agent-session-id":
    case "no-grok-session-id": return "No live agent session id";
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
      <ActivityStat label="Git" value={summary.git} />
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

function ActivityEvidenceView({
  actions,
  summary,
  onOpenFile,
}: {
  actions: ActivityAction[];
  summary: ReturnType<typeof summarizeActivity>;
  onOpenFile: (path: string) => void;
}): JSX.Element {
  const gridRef = useRef<HTMLDivElement | null>(null);
  const [columnSplit, setColumnSplit] = useState(50);
  const [rowSplit, setRowSplit] = useState(50);
  const [focusedSection, setFocusedSection] = useState<ActivityEvidenceSectionKey | null>(null);

  const resizeEvidenceColumn = useCallback((nextPercent: number) => {
    setColumnSplit(clamp(nextPercent, 28, 72));
  }, []);

  const resizeEvidenceRow = useCallback((nextPercent: number) => {
    setRowSplit(clamp(nextPercent, 26, 74));
  }, []);

  const handleEvidenceColumnResizePointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const rect = gridRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return;
    const target = event.currentTarget;
    try { target.setPointerCapture(event.pointerId); } catch { /* pointer capture is best effort */ }
    const onMove = (moveEvent: PointerEvent) => {
      moveEvent.preventDefault();
      resizeEvidenceColumn(((moveEvent.clientX - rect.left) / rect.width) * 100);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      try {
        if (target.hasPointerCapture(event.pointerId)) target.releasePointerCapture(event.pointerId);
      } catch { /* pointer capture release is best effort */ }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp, { once: true });
    window.addEventListener("pointercancel", onUp, { once: true });
  }, [resizeEvidenceColumn]);

  const handleEvidenceRowResizePointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const rect = gridRef.current?.getBoundingClientRect();
    if (!rect || rect.height <= 0) return;
    const target = event.currentTarget;
    try { target.setPointerCapture(event.pointerId); } catch { /* pointer capture is best effort */ }
    const onMove = (moveEvent: PointerEvent) => {
      moveEvent.preventDefault();
      resizeEvidenceRow(((moveEvent.clientY - rect.top) / rect.height) * 100);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      try {
        if (target.hasPointerCapture(event.pointerId)) target.releasePointerCapture(event.pointerId);
      } catch { /* pointer capture release is best effort */ }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp, { once: true });
    window.addEventListener("pointercancel", onUp, { once: true });
  }, [resizeEvidenceRow]);

  const handleEvidenceColumnResizeKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 8 : 4;
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      resizeEvidenceColumn(columnSplit - step);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      resizeEvidenceColumn(columnSplit + step);
    }
  }, [columnSplit, resizeEvidenceColumn]);

  const handleEvidenceRowResizeKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 8 : 4;
    if (event.key === "ArrowUp") {
      event.preventDefault();
      resizeEvidenceRow(rowSplit - step);
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      resizeEvidenceRow(rowSplit + step);
    }
  }, [resizeEvidenceRow, rowSplit]);

  const toggleFocusedSection = useCallback((section: ActivityEvidenceSectionKey) => {
    setFocusedSection((current) => current === section ? null : section);
  }, []);

  const gridStyle = useMemo(() => ({
    "--activity-evidence-left": `${columnSplit}fr`,
    "--activity-evidence-right": `${100 - columnSplit}fr`,
    "--activity-evidence-top": `${rowSplit}fr`,
    "--activity-evidence-bottom": `${100 - rowSplit}fr`,
  }) as CSSProperties, [columnSplit, rowSplit]);

  return (
    <div className="activity-evidence-view">
      <ActivityStats summary={summary} />
      <div
        ref={gridRef}
        className={[
          "activity-evidence-grid",
          focusedSection ? "activity-evidence-grid-focused" : "",
          focusedSection ? `activity-evidence-grid-focused-${focusedSection}` : "",
        ].filter(Boolean).join(" ")}
        style={gridStyle}
      >
        <ActivityEvidenceSection
          classSuffix="changes"
          title="Changes"
          detail="Created, edited, and deleted paths."
          actions={actions}
          kinds={["created", "written", "deleted"]}
          empty="No write evidence in this trace."
          onOpenFile={onOpenFile}
          isFocused={focusedSection === "changes"}
          isAnyFocused={focusedSection !== null}
          onToggleFocus={() => toggleFocusedSection("changes")}
        />
        <div
          className="activity-evidence-column-resizer"
          data-debug-id="activity-evidence-column-resizer"
          role="separator"
          aria-label="Resize evidence columns"
          aria-orientation="vertical"
          tabIndex={0}
          onPointerDown={handleEvidenceColumnResizePointerDown}
          onKeyDown={handleEvidenceColumnResizeKeyDown}
        />
        <ActivityEvidenceSection
          classSuffix="reads"
          title="Reads & Searches"
          detail="Files read, folders listed, and local searches."
          actions={actions}
          kinds={["searched", "listed", "opened", "read"]}
          empty="No read or search evidence in this trace."
          onOpenFile={onOpenFile}
          isFocused={focusedSection === "reads"}
          isAnyFocused={focusedSection !== null}
          onToggleFocus={() => toggleFocusedSection("reads")}
        />
        <div
          className="activity-evidence-row-resizer"
          data-debug-id="activity-evidence-row-resizer"
          role="separator"
          aria-label="Resize evidence rows"
          aria-orientation="horizontal"
          tabIndex={0}
          onPointerDown={handleEvidenceRowResizePointerDown}
          onKeyDown={handleEvidenceRowResizeKeyDown}
        />
        <ActivityEvidenceSection
          classSuffix="commands"
          title="Commands"
          detail="Terminal activity inferred from command text."
          actions={actions}
          kinds={["executed"]}
          empty="No command-only evidence in this trace."
          onOpenFile={onOpenFile}
          isFocused={focusedSection === "commands"}
          isAnyFocused={focusedSection !== null}
          onToggleFocus={() => toggleFocusedSection("commands")}
        />
        <ActivityEvidenceSection
          classSuffix="git"
          title="Git"
          detail="Commit, branch, status, and remote operations observed in the session."
          actions={actions}
          kinds={["git"]}
          empty="No git evidence in this trace."
          onOpenFile={onOpenFile}
          isFocused={focusedSection === "git"}
          isAnyFocused={focusedSection !== null}
          onToggleFocus={() => toggleFocusedSection("git")}
        />
      </div>
    </div>
  );
}

function ActivityEvidenceSection({
  classSuffix,
  title,
  detail,
  actions,
  kinds,
  empty,
  onOpenFile,
  isFocused,
  isAnyFocused,
  onToggleFocus,
}: {
  classSuffix: ActivityEvidenceSectionKey;
  title: string;
  detail: string;
  actions: ActivityAction[];
  kinds: ActivityKind[];
  empty: string;
  onOpenFile: (path: string) => void;
  isFocused: boolean;
  isAnyFocused: boolean;
  onToggleFocus: () => void;
}): JSX.Element {
  const groups = groupEvidenceActions(actions.filter((action) => kinds.includes(action.kind)));
  const debugId = {
    changes: "activity-evidence-section-changes",
    reads: "activity-evidence-section-reads",
    commands: "activity-evidence-section-commands",
    git: "activity-evidence-section-git",
  }[classSuffix];
  return (
    <section
      className={[
        "activity-evidence-section",
        `activity-evidence-section-${classSuffix}`,
        isFocused ? "activity-evidence-section-focused" : "",
        isAnyFocused && !isFocused ? "activity-evidence-section-dimmed" : "",
      ].filter(Boolean).join(" ")}
      data-debug-id={debugId}
    >
      <div className="activity-evidence-section-head">
        <div>
          <h3>{title}</h3>
          <p>{detail}</p>
        </div>
        <div className="activity-evidence-section-actions">
          <span>{groups.length}</span>
          <button
            type="button"
            className="activity-evidence-section-expand"
            data-debug-id={`activity-evidence-section-${classSuffix}-expand`}
            onClick={onToggleFocus}
            aria-pressed={isFocused}
            title={isFocused ? "Restore evidence grid" : `Expand ${title}`}
            aria-label={isFocused ? "Restore evidence grid" : `Expand ${title}`}
          >
            <ShellIcon name={isFocused ? "minimize" : "maximize"} size={12} />
          </button>
        </div>
      </div>
      {groups.length === 0 ? (
        <div className="activity-evidence-empty">{empty}</div>
      ) : (
        <div className="activity-evidence-list">
          {groups.slice(0, 18).map((group) => (
            <button
              type="button"
              key={group.key}
              className={`activity-evidence-row activity-evidence-row-${group.dominantKind}`}
              onClick={() => onOpenFile(group.path)}
              title={group.path}
            >
              <span className="activity-evidence-icon" aria-hidden="true">
                <ShellIcon name={evidenceIconName(group.dominantKind)} size={14} />
              </span>
              <span className="activity-evidence-main">
                <strong>{group.relativePath || group.name}</strong>
                <em>{formatEvidenceDetail(group)}</em>
              </span>
              <ActivityCountChips counts={group.counts} />
              <span className={`activity-confidence activity-confidence-${group.confidence}`}>{group.confidence}</span>
              <span className="activity-evidence-time">{formatTime(group.newestMs)}</span>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

interface ActivityEvidenceGroup {
  key: string;
  path: string;
  relativePath: string;
  name: string;
  counts: ActivityActionCounts;
  confidence: ActivityAction["confidence"];
  dominantKind: ActivityKind;
  newestMs?: number;
  newest?: ActivityAction;
  actions: ActivityAction[];
}

function groupEvidenceActions(actions: ActivityAction[]): ActivityEvidenceGroup[] {
  const groups = new Map<string, ActivityEvidenceGroup>();
  for (const action of actions) {
    const key = action.relativePath || action.path;
    const current = groups.get(key);
    if (!current) {
      const counts = emptyActivityCounts();
      counts[action.kind] = 1;
      groups.set(key, {
        key,
        path: action.path,
        relativePath: action.relativePath,
        name: action.name,
        counts,
        confidence: action.confidence,
        dominantKind: action.kind,
        newestMs: action.timestampMs,
        newest: action,
        actions: [action],
      });
      continue;
    }
    current.actions.push(action);
    current.counts[action.kind] += 1;
    current.confidence = mergeActivityConfidence(current.confidence, action.confidence);
    current.dominantKind = dominantKind(current.counts) ?? current.dominantKind;
    if ((action.timestampMs ?? 0) >= (current.newestMs ?? 0)) {
      current.newestMs = action.timestampMs;
      current.newest = action;
    }
  }
  return Array.from(groups.values()).sort((a, b) =>
    totalCount(b.counts) - totalCount(a.counts) ||
    (b.newestMs ?? 0) - (a.newestMs ?? 0) ||
    a.relativePath.localeCompare(b.relativePath)
  );
}

function emptyActivityCounts(): ActivityActionCounts {
  return {
    searched: 0,
    listed: 0,
    opened: 0,
    read: 0,
    written: 0,
    created: 0,
    deleted: 0,
    git: 0,
    executed: 0,
  };
}

function mergeActivityConfidence(
  a: ActivityAction["confidence"],
  b: ActivityAction["confidence"],
): ActivityAction["confidence"] {
  if (a === "verified" || b === "verified") return "verified";
  if (a === "observed" || b === "observed") return "observed";
  return "inferred";
}

function evidenceIconName(kind: ActivityKind): ShellIconName {
  if (kind === "searched") return "search";
  if (kind === "listed") return "folder-open";
  if (kind === "read" || kind === "opened") return "file";
  if (kind === "written" || kind === "created") return "pencil";
  if (kind === "deleted") return "trash";
  if (kind === "git") return "git-branch";
  if (kind === "executed") return "terminal";
  return "activity";
}

function formatEvidenceDetail(group: ActivityEvidenceGroup): string {
  const newest = group.newest;
  if (!newest) return `${totalCount(group.counts)} actions`;
  const query = newest.query?.trim();
  if (query) return `query: ${query}`;
  const command = newest.command?.trim();
  if (command) return command.length > 96 ? `${command.slice(0, 93)}...` : command;
  const source = newest.sourceType || newest.toolName || newest.source;
  return `${newest.kind} via ${source}`;
}

function ActivitySummaryView({
  source,
  summary,
  actions,
  buildState,
  buildReceipts,
}: {
  source: SessionActivitySource;
  summary: ReturnType<typeof summarizeActivity>;
  actions: ActivityAction[];
  buildState: BuildRunState | null;
  buildReceipts: BuildReceipt[];
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
        <ActivityMeta label="Activity folder" value={source.scratchDir ?? "-"} />
        <ActivityMeta label="Hunk log" value={source.hunkRecordsPath ?? "-"} />
        <ActivityMeta label="Updates log" value={source.updatesPath ?? "-"} />
        <ActivityMeta label="First event" value={formatTime(oldest?.timestampMs)} />
        <ActivityMeta label="Last event" value={formatTime(newest?.timestampMs)} />
      </div>
      {(buildState || buildReceipts.length > 0) && (
        <div className="activity-build-audit">
          <div className="activity-build-title">
            Build receipt ledger · {buildReceipts.length}
          </div>
          <div className="activity-source-grid">
            <ActivityMeta label="Build status" value={buildStatusLabel(buildState?.status)} rawValue={buildState?.status} />
            <ActivityMeta label="Run" value={buildState?.runId ?? buildReceipts[0]?.runId ?? "-"} />
            <ActivityMeta label="Checkpoint" value={buildState?.checkpointId ?? "-"} />
          </div>
          <BuildReceiptLedger receipts={buildReceipts} />
        </div>
      )}
    </div>
  );
}

function BuildReceiptLedger({ receipts }: { receipts: BuildReceipt[] }): JSX.Element {
  if (receipts.length === 0) return <div className="activity-empty-detail">No Build Mode receipts are available for this tab.</div>;
  return (
    <div className="build-receipts activity-build-receipts">
      {receipts.slice().reverse().map((receipt) => (
        <div key={receipt.receiptId} className={`build-receipt build-receipt-${receipt.confidence}`} title={receipt.summary}>
          <ShellIcon name="trace" size={12} />
          <span className="build-receipt-kind">{buildReceiptKindLabel(receipt.kind)}</span>
          <span className="build-receipt-summary">{receipt.summary}</span>
          <span className="build-receipt-time">{formatTime(receipt.createdAtMs)}</span>
        </div>
      ))}
    </div>
  );
}

function buildReceiptKindLabel(kind: string): string {
  return kind.replace(/([A-Z])/g, " $1").replace(/^./, (s) => s.toUpperCase());
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
      {countChip("git", counts.git)}
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
  if (kind === "git") return "git";
  if (kind === "executed") return "exec";
  return kind;
}

function dominantKind(counts: ActivityActionCounts): ActivityKind | null {
  const priority: ActivityKind[] = ["deleted", "written", "created", "git", "read", "opened", "searched", "listed", "executed"];
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
