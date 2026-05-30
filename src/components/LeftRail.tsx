/**
 * src/components/LeftRail.tsx — left sidebar.
 * * Shows the Projects tree (with nested open + past chats), the
 * "Unfiled" / "Past chats" sections, and the GitHub strip + footer.
 * * Tree shape:
 * - Header: "Projects · N" + add icon (creates a new project)
 * - Per project: caret + folder icon + name + chat-count, click toggles collapse
 * - Chats nested under a project: status dot + transport + title
 * - "Open chats" section: tabs without a projectId
 * - "Past chats" section: on-disk sessions not assigned to any project
 * * Find + Plugins live in the top header. Files live in RightRail.
 * Collapse state persists under PROJECTS_COLLAPSE_KEY in localStorage.
 */
import { useEffect, useRef, useState, type JSX } from "react";
import { invoke } from "@tauri-apps/api/core";
import { api } from "../lib/debug-api";
import { PROJECTS_COLLAPSE_KEY, persistUserData } from "../lib/userStore";
import { ShellIcon, TransportIcon, transportTitle } from "./icons";
import { RowActions } from "./RowActions";

type ChatStatus = "run" | "done" | "idle" | "input";

interface ChatMeta {
  id: string;
  title: string;
  transport: string;
  status: ChatStatus;
}

interface ProjectMeta {
  id: string;
  name: string;
  chats: ChatMeta[];
}

// Projects flow in as a prop from App.tsx (localStorage-backed store);
// "Unfiled" is derived from open session tabs without a projectId.
// "Past chats" lists on-disk sessions surfaced via the
// list_stored_sessions Tauri command.

/** Minimal entry mirroring App.tsx TabEntry — kept local to avoid a
 * circular import. App passes only the fields used here. */
export interface OpenTabRow {
  tabId: string;
  title: string;
  projectId?: string;
  connectionTransport?: string;
  isActive: boolean;
  hasLiveSession: boolean;
}

/**
 * Read the per-project collapse map from localStorage, defaulting to
 * "first project expanded, rest collapsed". Forgiving on parse error —
 * any failure yields the default map.
 */
function loadCollapseMap(projects: ProjectMeta[]): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(PROJECTS_COLLAPSE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") return parsed;
    }
  } catch { /* fallthrough */ }
  const m: Record<string, boolean> = {};
  projects.forEach((p, i) => {
    m[p.id] = i !== 0; // first expanded, rest collapsed
  });
  return m;
}

export function LeftRail({
  cwd,
  activeTabId,
  onPreviewFile: _onPreviewFile,
  onOpenProject,
  onOpenChat,
  projects = [],
  openTabs = [],
  onAddProject,
  onFocusTab,
  renamingProjectId,
  onRenameProject,
  onRenameChat,
  onAssignChatToProject,
  pastChats = [],
  onOpenPastChat,
  onRenamePastChat,
  onDeleteProject,
  pastChatsByProject = {},
  onAssignSessionToProject,
  onDeleteSession,
  userDataReady = true,
}: {
  cwd: string;
  activeTabId?: string | null;
  onPreviewFile: (path: string) => void;
  onOpenProject?: (projectId: string, projectName: string) => void;
  onOpenChat?: (chatId: string, projectId?: string, transport?: string) => void;
 /** Projects from App's localStorage-backed store. */
  projects?: ProjectMeta[];
 /** Open session tabs (visible in the tab strip). */
  openTabs?: OpenTabRow[];
 /** Create a name-only project. This is a UI grouping label, not a
 * folder binding. The new row enters rename mode if
 * `renamingProjectId` matches its id. */
  onAddProject?: () => void;
 /** Clicking an open-chat row focuses the matching tab. */
  onFocusTab?: (tabId: string) => void;
 /** Freshly-created project id that should open in inline rename. */
  renamingProjectId?: string | null;
 /** Persist a project rename. Empty string deletes. */
  onRenameProject?: (id: string, newName: string) => void;
 /** Persist an open-chat rename. */
  onRenameChat?: (tabId: string, newTitle: string) => void;
 /** Assign a chat tab to a project (null unfiles). */
  onAssignChatToProject?: (tabId: string, projectId: string | null) => void;
 /** Past chats — closed sessions on disk. */
  pastChats?: { id: string; title: string; mtime_ms: number; size: number; connectionTransport?: string }[];
 /** Re-open a past-chat row in a fresh tab. */
  onOpenPastChat?: (sessionId: string, title: string) => void;
 /** #391 — rename a past-chat row's title. App.tsx wires this to the
 * `rename_past_session` Tauri command which appends a `title-override`
 * line to the session JSONL, then calls refreshPastChats so the new
 * title shows immediately. Local-state optimistic update lives in
 * the App.tsx handler so the LeftRail stays presentational. */
  onRenamePastChat?: (sessionId: string, newTitle: string) => void;
 /** Delete a project. `deleteSessions=true` also unlinks the JSONL
 * files of chats filed under this project (via App's
 * delete_session_files invoke). `false` removes only the marker;
 * chats fall back into the "Past chats" unfiled section. */
  onDeleteProject?: (id: string, deleteSessions: boolean) => void;
 /** Past chats already assigned to a project, keyed by project id. */
  pastChatsByProject?: Record<string, { id: string; title: string; mtime_ms: number; connectionTransport?: string }[]>;
 /** Assign / unfile a past chat by sessionId without opening it. */
  onAssignSessionToProject?: (sessionId: string, projectId: string | null) => void;
 /** Permanently delete one session:
 * - "tab": close the tab and, if it has a sessionId, unlink JSONL.
 * - "past": unlink the JSONL only (no live tab to close).
 * App handles the actual delete_session_files invoke; LeftRail
 * just gates the call behind a confirm modal. */
  onDeleteSession?: (
    target: { kind: "tab"; tabId: string } | { kind: "past"; sessionId: string },
  ) => void;
  /** False during boot disk-hydration so first-render defaults do not
   * overwrite reinstall-safe project markings. */
  userDataReady?: boolean;
}): JSX.Element {
  const [collapse, setCollapse] = useState<Record<string, boolean>>(() => loadCollapseMap(projects));
  const [unfiledCollapsed, setUnfiledCollapsed] = useState(false);
  const [allCollapsed, setAllCollapsed] = useState(false);
 // Past-chats section open by default so closed history surfaces
 // immediately after the user closes a tab.
  const [pastCollapsed, setPastCollapsed] = useState(false);

 // 3-option project-delete confirmation modal. Setting this to a
 // context object opens it; null closes.
  const [projectDeleteCtx, setProjectDeleteCtx] = useState<
    null | { id: string; name: string; chatCount: number }
  >(null);

 // Single-session delete confirmation. For an open tab with no
 // JSONL yet we just close the tab without a disk write.
  const [sessionDeleteCtx, setSessionDeleteCtx] = useState<
    null | { kind: "tab"; tabId: string; title: string }
            | { kind: "past"; sessionId: string; title: string }
  >(null);

 // Persist collapse state on every change.
  useEffect(() => {
    if (!userDataReady) return;
    persistUserData(PROJECTS_COLLAPSE_KEY, collapse);
  }, [collapse, userDataReady]);

  useEffect(() => {
    if (!userDataReady) return;
    setCollapse(loadCollapseMap(projects));
  }, [projects, userDataReady]);

  const toggleProject = (id: string) =>
    setCollapse((m) => ({ ...m, [id]: !m[id] }));

  const onClickChat = (chatId: string, projectId?: string, transport?: string) => {
    onOpenChat?.(chatId, projectId, transport);
  };

 // derive unfiled open-tab rows from openTabs.
 // Tabs WITH a projectId belong under that project (future feature);
 // tabs WITHOUT belong under "Open chats" here. For now we show all
 // open tabs in Open chats so the user can navigate between them.
  const openChats = openTabs;

  const onClickProjectRow = (proj: ProjectMeta) => {
 /* row click now TOGGLES the project (expand to see
 * its filed chats), instead of spawning a new tab. Spawning a
 * new pre-scoped tab is still available via the context menu
 * or the dropdown — but the natural "click a project to open
 * it" gesture now does what users expect (reveal contents). */
    toggleProject(proj.id);
  };

 /* inline rename state — separate from collapse so the
 * input can grab focus and accept text without colliding with the
 * row click handler. Two flavors: project and chat. */
  const [renamingProj, setRenamingProj] = useState<string | null>(null);
  const [renamingChat, setRenamingChat] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
 // Auto-enter rename mode for a freshly-created project (driven by
 // App.tsx setting `renamingProjectId` immediately after handleAddProject).
  useEffect(() => {
    if (renamingProjectId && renamingProj !== renamingProjectId) {
      const p = projects.find((p) => p.id === renamingProjectId);
      if (p) {
        setRenamingProj(renamingProjectId);
        setRenameDraft(p.name);
      }
    }
  }, [renamingProjectId, projects, renamingProj]);
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if ((renamingProj || renamingChat) && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [renamingProj, renamingChat]);
  const commitProjectRename = () => {
    if (!renamingProj) return;
    onRenameProject?.(renamingProj, renameDraft);
    setRenamingProj(null);
    setRenameDraft("");
  };
  const cancelProjectRename = () => {
    setRenamingProj(null);
    setRenameDraft("");
  };
  const commitChatRename = () => {
    if (!renamingChat) return;
    onRenameChat?.(renamingChat, renameDraft);
    setRenamingChat(null);
    setRenameDraft("");
  };
  const cancelChatRename = () => {
    setRenamingChat(null);
    setRenameDraft("");
  };
 // Right-click context menu for assigning a chat tab to a project.
 // {x, y} is the absolute mouse position; closes on outside-click or Esc.
  const [chatCtx, setChatCtx] = useState<{ x: number; y: number; tabId: string } | null>(null);
 /* Drag-and-drop state. `dragOverKey` is the row currently being
 * hovered: a project id, or the sentinel "__unfiled__" for the
 * Unfiled header (drop here → assign null = remove from project).
 * DataTransfer uses two custom MIME types:
 * - application/x-shellx-tab → live open-tab id
 * - application/x-shellx-session → past-chat session id
 * Avoid text/plain to prevent drop-on-textarea side effects. */
  const [dragOverKey, setDragOverKey] = useState<string | null>(null);
  const DRAG_TAB_MIME = "application/x-shellx-tab";
  const DRAG_SESSION_MIME = "application/x-shellx-session";
 /** Pull a {tabId?, sessionId?} payload off a DataTransfer.
 * Returns null when neither shellX MIME is present. */
  const readDragPayload = (dt: DataTransfer): { tabId?: string; sessionId?: string } | null => {
    const tabId = dt.getData(DRAG_TAB_MIME);
    if (tabId) return { tabId };
    const sessionId = dt.getData(DRAG_SESSION_MIME);
    if (sessionId) return { sessionId };
    return null;
  };
 /** Type-only inspection during onDragOver. DataTransfer.getData is
 * unreadable on dragenter/dragover (security); only the types
 * list is exposed — so we gate `.drag-over` on that. */
  const isShellxDrag = (dt: DataTransfer): boolean => {
    const types = Array.from(dt.types);
    return types.includes(DRAG_TAB_MIME) || types.includes(DRAG_SESSION_MIME);
  };
 /** Commit a drop onto a project (or null = unfile). Routes the
 * payload to the right App callback by source row type. */
  const dropOntoProject = (payload: { tabId?: string; sessionId?: string }, projectId: string | null) => {
    if (payload.tabId) {
      onAssignChatToProject?.(payload.tabId, projectId);
    } else if (payload.sessionId) {
      onAssignSessionToProject?.(payload.sessionId, projectId);
    }
  };
 // Past-chat right-click context menu (sessionId-keyed, no live tab
 // required).
  const [sessionCtx, setSessionCtx] = useState<{ x: number; y: number; sessionId: string } | null>(null);
  useEffect(() => {
    if (!sessionCtx) return;
    const onDoc = () => setSessionCtx(null);
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setSessionCtx(null); };
    window.addEventListener("mousedown", onDoc);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDoc);
      window.removeEventListener("keydown", onKey);
    };
  }, [sessionCtx]);
  useEffect(() => {
    if (!chatCtx) return;
    const onDoc = () => setChatCtx(null);
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setChatCtx(null); };
    window.addEventListener("mousedown", onDoc);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDoc);
      window.removeEventListener("keydown", onKey);
    };
  }, [chatCtx]);

  return (
    <aside className="left">

 {/* Panel header — collapse-all toggle + project count + add button. */}
      <div className="left-hdr">
        <span
          onClick={() => setAllCollapsed((v) => !v)}
          style={{ cursor: "pointer", userSelect: "none" }}
          title={allCollapsed ? "Expand all projects" : "Collapse all projects"}
        >
          <span style={{ display: "inline-block", width: 12, fontSize: 10, color: "var(--ink-3)" }}>
            <ShellIcon name={allCollapsed ? "chevron-right" : "chevron-down"} size={12} />
          </span>
          Projects <span className="ct">· {projects.length}</span>
        </span>
        <button
          type="button"
          className="plus-btn"
          onClick={onAddProject}
          title="New project folder"
          aria-label="New project folder"
        >
          <ShellIcon name="plus" size={15} />
        </button>
      </div>

      <div className="left-body">
        {!allCollapsed && projects.map((p) => {
          const projCollapsed = collapse[p.id] !== false; // default true = collapsed
          const isExpanded = !projCollapsed;
          const isRenaming = renamingProj === p.id;
          return (
            <div key={p.id}>
              <div
                className={`proj-row ${dragOverKey === p.id ? "drag-over" : ""}`}
                onClick={isRenaming ? undefined : () => onClickProjectRow(p)}
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  e.preventDefault();
                  setRenamingProj(p.id);
                  setRenameDraft(p.name);
                }}
 /* Drop target for open-tab and past-chat drags.
 * onDragOver must preventDefault to enable drop; we
 * gate the .drag-over highlight on a shellX MIME so
 * unrelated drags don't paint the dashed border. */
                onDragOver={(e) => {
                  if (!isShellxDrag(e.dataTransfer)) return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = "move";
                  if (dragOverKey !== p.id) setDragOverKey(p.id);
                }}
                onDragLeave={(e) => {
 // Only clear when the cursor truly leaves the row;
 // dragleave fires for every child traversal.
                  const rel = e.relatedTarget as Node | null;
                  if (!rel || !(e.currentTarget as Node).contains(rel)) {
                    if (dragOverKey === p.id) setDragOverKey(null);
                  }
                }}
                onDrop={(e) => {
                  if (!isShellxDrag(e.dataTransfer)) return;
                  e.preventDefault();
                  const payload = readDragPayload(e.dataTransfer);
                  setDragOverKey(null);
                  if (payload) dropOntoProject(payload, p.id);
                }}
                title={isRenaming ? "" : `Open "${p.name}" in a new tab — double-click to rename — drop a chat here to file it`}
                style={{ cursor: isRenaming ? "text" : "pointer" }}
              >
                <span
                  className="pcaret"
                  onClick={(e) => { e.stopPropagation(); toggleProject(p.id); }}
                  title={isExpanded ? "Collapse project" : "Expand project"}
                  style={{ cursor: "pointer" }}
                >
                  <ShellIcon name={isExpanded ? "chevron-down" : "chevron-right"} size={12} />
                </span>
                <span className="pico"><ShellIcon name="folder" size={14} /></span>
                {isRenaming ? (
                  <input
                    ref={inputRef}
                    className="pname-input"
                    type="text"
                    value={renameDraft}
                    onChange={(e) => setRenameDraft(e.target.value)}
                    onBlur={commitProjectRename}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") { e.preventDefault(); commitProjectRename(); }
                      else if (e.key === "Escape") { e.preventDefault(); cancelProjectRename(); }
                    }}
                    onClick={(e) => e.stopPropagation()}
                    placeholder="Project name (empty = delete)"
                    style={{
                      flex: 1, background: "transparent",
                      border: "1px solid var(--ink-4)", borderRadius: 4,
                      color: "var(--ink-1)", font: "inherit",
                      padding: "1px 4px", outline: "none",
                    }}
                  />
                ) : (
                  <span className="pname">{p.name}</span>
                )}
                <span className="pcount">{p.chats.length}</span>
 {/* Project delete ✕ — visible on row hover. Opens the
 * confirmation modal so the user can pick "keep
 * chats" (drop label only) or "delete sessions"
 * (wipe filed JSONLs too). */}
                {!isRenaming && onDeleteProject && (
                  <button
                    type="button"
                    className="pdel"
                    onClick={(e) => {
                      e.stopPropagation();
                      const chatCount =
                        p.chats.length + (pastChatsByProject[p.id]?.length ?? 0);
                      setProjectDeleteCtx({ id: p.id, name: p.name, chatCount });
                    }}
                    title="Delete this project label"
                    aria-label="Delete project"
                    style={{
                      background: "transparent", border: "none",
                      color: "var(--ink-3)", cursor: "pointer",
                      padding: "0 6px", fontSize: 14, lineHeight: 1,
                    }}
                  >
                    <ShellIcon name="close" size={13} />
                  </button>
                )}
              </div>
              {isExpanded && p.chats.map((c) => (
 /* Project-nested live chats are draggable so the
 * user can move them between projects without
 * leaving the rail. Rendered as a div (not button)
 * because <button draggable> doesn't initiate drag
 * reliably in WebView2 (no dragstart fires). */
                <div
                  key={c.id}
                  role="button"
                  tabIndex={0}
                  className="chat-row"
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.setData(DRAG_TAB_MIME, c.id);
                    e.dataTransfer.effectAllowed = "move";
                  }}
                  onClick={() => onClickChat(c.id, p.id, c.transport)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onClickChat(c.id, p.id, c.transport);
                    }
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setChatCtx({ x: e.clientX, y: e.clientY, tabId: c.id });
                  }}
                  title={`Open chat "${c.title}" in a new tab — hover for edit, right-click or drag to move`}
                  style={{ cursor: "pointer" }}
                >
                  <span className="ttr" title={transportTitle(c.transport)}>
                    <TransportIcon value={c.transport} />
                  </span>
                  <span className="ctitle">{c.title}</span>
 {/* project-row rename + delete affordances.
 * Mirrors the unfiled/open-chat rows: hover-revealed
 * ✎ opens inline rename; 🗑 opens the delete modal.
 * CSS hides .row-edit / .row-del until row:hover. */}
                  <RowActions
                    onRename={onRenameChat ? () => {
                      setRenamingChat(c.id);
                      setRenameDraft(c.title || "");
                    } : undefined}
                    onDelete={onDeleteSession ? () => {
                      setSessionDeleteCtx({
                        kind: "tab",
                        tabId: c.id,
                        title: c.title || "",
                      });
                    } : undefined}
                    renameTitle="Rename chat"
                    deleteTitle="Delete this session"
                  />
                </div>
              ))}
 {/* Past chats filed under this project. Draggable —
 * drop on another project moves; drop on Unfiled
 * header unfiles. */}
              {isExpanded && (pastChatsByProject[p.id] ?? []).map((c) => (
                <div
                  key={`past-${c.id}`}
                  className="chat-row"
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.setData(DRAG_SESSION_MIME, c.id);
                    e.dataTransfer.effectAllowed = "move";
                  }}
                  onClick={() => onOpenPastChat?.(c.id, c.title)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setSessionCtx({ x: e.clientX, y: e.clientY, sessionId: c.id });
                  }}
                  title={`Reopen "${c.title}" — hover for edit, right-click to move — drag to file under another project`}
                  style={{ cursor: "pointer" }}
                >
 {/* Recorded transport emoji (falls back to 💬) so
 * project-filed past chats match the unfiled
 * past-chat list visually. */}
                  <span className="ttr" title={transportTitle(c.connectionTransport)}>
                    <TransportIcon value={c.connectionTransport} />
                  </span>
                  <span className="ctitle" style={{
                    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                  }}>{c.title}</span>
 {/* project past-chat affordances. Mirrors
 * the unfiled past-chat list (lines ~735-770). */}
                  <RowActions
                    onRename={onRenamePastChat ? () => {
                      setRenamingChat(c.id);
                      setRenameDraft(c.title || "");
                    } : undefined}
                    onDelete={onDeleteSession ? () => {
                      setSessionDeleteCtx({
                        kind: "past",
                        sessionId: c.id,
                        title: c.title || "",
                      });
                    } : undefined}
                    renameTitle="Rename chat"
                    deleteTitle="Delete this session"
                  />
                </div>
              ))}
            </div>
          );
        })}

 {/* Open chats — live session tabs without a projectId.
 * Row click focuses the matching tab. */}
        {openChats.length > 0 && (
          <>
 {/* Unfiled header is a drop target — dropping a dragged
 * chat here calls onAssign...(null) to remove it from
 * its current project. */}
            <button
              type="button"
              className={`unfiled-head ${dragOverKey === "__unfiled__" ? "drag-over" : ""}`}
              onClick={() => setUnfiledCollapsed((v) => !v)}
              onDragOver={(e) => {
                if (!isShellxDrag(e.dataTransfer)) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                if (dragOverKey !== "__unfiled__") setDragOverKey("__unfiled__");
              }}
              onDragLeave={(e) => {
                const rel = e.relatedTarget as Node | null;
                if (!rel || !(e.currentTarget as Node).contains(rel)) {
                  if (dragOverKey === "__unfiled__") setDragOverKey(null);
                }
              }}
              onDrop={(e) => {
                if (!isShellxDrag(e.dataTransfer)) return;
                e.preventDefault();
                const payload = readDragPayload(e.dataTransfer);
                setDragOverKey(null);
                if (payload) dropOntoProject(payload, null);
              }}
              title={unfiledCollapsed ? "Show open chats — drop here to unfile" : "Hide open chats — drop here to unfile"}
            >
              <span className="pcaret"><ShellIcon name={unfiledCollapsed ? "chevron-right" : "chevron-down"} size={12} /></span>
              Open chats · {openChats.length}
            </button>
            {!unfiledCollapsed && openChats.map((c) => {
              const isRenamingThisChat = renamingChat === c.tabId;
              return (
              <div
                key={c.tabId}
                className={`unfiled-row ${c.isActive ? "active" : ""}`}
 /* open-chat rows are draggable — drop on a
 * project assigns the live tab to that project. */
                draggable={!isRenamingThisChat}
                onDragStart={(e) => {
                  if (isRenamingThisChat) { e.preventDefault(); return; }
                  e.dataTransfer.setData(DRAG_TAB_MIME, c.tabId);
                  e.dataTransfer.effectAllowed = "move";
                }}
                onClick={isRenamingThisChat ? undefined : () => onFocusTab?.(c.tabId)}
 /* double-click
 * removed — it conflicted with focus-tab single-click
 * timing and was unintuitive for past-chat reopen flow.
 * Rename is triggered by the hover-revealed ✎ icon. */
 /* Right-click → "Move to project ▸" menu. */
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setChatCtx({ x: e.clientX, y: e.clientY, tabId: c.tabId });
                }}
                title={isRenamingThisChat ? "" : `Focus tab: ${c.title} — hover for edit, right-click or drag to move`}
                style={{ cursor: isRenamingThisChat ? "text" : "pointer" }}
              >
                <span className="ttr" title={transportTitle(c.connectionTransport)}>
                  <TransportIcon value={c.connectionTransport} />
                </span>
                {isRenamingThisChat ? (
                  <input
                    ref={inputRef}
                    className="ctitle-input"
                    type="text"
                    value={renameDraft}
                    onChange={(e) => setRenameDraft(e.target.value)}
                    onBlur={commitChatRename}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") { e.preventDefault(); commitChatRename(); }
                      else if (e.key === "Escape") { e.preventDefault(); cancelChatRename(); }
                    }}
                    onClick={(e) => e.stopPropagation()}
                    placeholder="Chat title"
                    style={{
                      flex: 1, background: "transparent",
                      border: "1px solid var(--ink-4)", borderRadius: 4,
                      color: "var(--ink-1)", font: "inherit",
                      padding: "1px 4px", outline: "none",
                    }}
                  />
                ) : (
                  <>
                    <span className="ctitle">{c.title || "(untitled)"}</span>
 {/* Hover-revealed edit pencil — clicks start
 * inline rename. Trash glyph opens the
 * session-delete modal. CSS hides .row-edit /
 * .row-del until row:hover. */}
                    <RowActions
                      onRename={onRenameChat ? () => {
                        setRenamingChat(c.tabId);
                        setRenameDraft(c.title || "");
                      } : undefined}
                      onDelete={onDeleteSession ? () => {
                        setSessionDeleteCtx({
                          kind: "tab",
                          tabId: c.tabId,
                          title: c.title || "",
                        });
                      } : undefined}
                      renameTitle="Rename chat"
                      deleteTitle="Delete this session"
                    />
                  </>
                )}
              </div>
              );
            })}
          </>
        )}

 {/* Past chats — closed sessions on disk. Renders all entries;
 * JSONLs are never deleted by drop_tab_session, so closing a
 * tab keeps the past chat visible. */}
        {pastChats.length > 0 && (() => {
          const closed = pastChats;
          if (closed.length === 0) return null;
          return (
            <>
              <button
                type="button"
                className="unfiled-head"
                onClick={() => setPastCollapsed((v) => !v)}
                title={pastCollapsed ? "Show past chats" : "Hide past chats"}
              >
                <span className="pcaret"><ShellIcon name={pastCollapsed ? "chevron-right" : "chevron-down"} size={12} /></span>
                Past chats · {closed.length}
              </button>
              {!pastCollapsed && closed.slice(0, 50).map((c) => {
 // #391 — share inline-rename state with the open-chat
 // rows. `renamingChat` holds either a tabId (open-chat
 // path) or a sessionId (past-chat path); the two
 // namespaces don't collide because a past chat is only
 // visible AFTER the live tab closed and its tabId is
 // gone. Synthetic 'closed-*' ids have no JSONL on disk
 // and so can't be renamed (no rename ✎ rendered).
                const canRenameThisPast =
                  !!onRenamePastChat && !c.id.startsWith("closed-");
                const isRenamingThisPast =
                  canRenameThisPast && renamingChat === c.id;
                const commitPastRename = () => {
                  const next = renameDraft.trim();
 // Reject empty so an accidental Enter on a cleared
 // input doesn't store an empty override line.
                  if (next.length > 0 && next !== c.title) {
                    onRenamePastChat?.(c.id, next);
                  }
                  setRenamingChat(null);
                  setRenameDraft("");
                };
                const cancelPastRename = () => {
                  setRenamingChat(null);
                  setRenameDraft("");
                };
                return (
                <div
                  key={c.id}
                  className="unfiled-row"
 /* Synthetic ids (closed-*) carry no session file,
 * so we skip drag for them — same gate as the
 * context menu. */
                  draggable={!c.id.startsWith("closed-") && !isRenamingThisPast}
                  onDragStart={(e) => {
                    if (c.id.startsWith("closed-") || isRenamingThisPast) { e.preventDefault(); return; }
                    e.dataTransfer.setData(DRAG_SESSION_MIME, c.id);
                    e.dataTransfer.effectAllowed = "move";
                  }}
                  onClick={isRenamingThisPast ? undefined : () => onOpenPastChat?.(c.id, c.title)}
 /* Right-click → "Move to project ▸" menu without
 * opening the chat first. */
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    if (c.id.startsWith("closed-")) return; // synthetic ids
                    setSessionCtx({ x: e.clientX, y: e.clientY, sessionId: c.id });
                  }}
                  title={isRenamingThisPast ? "" : `Reopen "${c.title}" — ${c.connectionTransport ? `transport: ${c.connectionTransport} — ` : ""}right-click or drag to move (last touched ${new Date(c.mtime_ms).toLocaleString()})`}
                  style={{ cursor: isRenamingThisPast ? "text" : "pointer" }}
                >
 {/* Transport emoji (falls back to 💬 for legacy
 * entries) so closed sessions show Local / WSL /
 * SSH at a glance. */}
                  <span className="ttr" title={transportTitle(c.connectionTransport)}>
                    <TransportIcon value={c.connectionTransport} />
                  </span>
                  {isRenamingThisPast ? (
                    <input
                      ref={inputRef}
                      className="ctitle-input"
                      type="text"
                      value={renameDraft}
                      onChange={(e) => setRenameDraft(e.target.value)}
                      onBlur={commitPastRename}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") { e.preventDefault(); commitPastRename(); }
                        else if (e.key === "Escape") { e.preventDefault(); cancelPastRename(); }
                      }}
                      onClick={(e) => e.stopPropagation()}
                      placeholder="Chat title"
                      style={{
                        flex: 1, background: "transparent",
                        border: "1px solid var(--ink-4)", borderRadius: 4,
                        color: "var(--ink-1)", font: "inherit",
                        padding: "1px 4px", outline: "none",
                      }}
                    />
                  ) : (
                    <>
                      <span className="ctitle" style={{
                        overflow: "hidden", textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}>{c.title}</span>
 {/* #391 — hover-revealed rename pencil and delete
 * trash. Pencil only when the host wired
 * onRenamePastChat AND the row maps to a real
 * JSONL (not synthetic closed-*). Trash only for
 * real JSONLs — synthetic ids have no file; the
 * archive entry rolls off after 30 days via
 * refreshPastChats GC. CSS hides both until the
 * row is hovered, matching the open-chat rows. */}
                      <RowActions
                        onRename={canRenameThisPast ? () => {
                          setRenamingChat(c.id);
                          setRenameDraft(c.title || "");
                        } : undefined}
                        onDelete={onDeleteSession && !c.id.startsWith("closed-") ? () => {
                          setSessionDeleteCtx({
                            kind: "past",
                            sessionId: c.id,
                            title: c.title || "",
                          });
                        } : undefined}
                        renameTitle="Rename chat"
                        deleteTitle="Delete this session"
                      />
                    </>
                  )}
                </div>
                );
              })}
            </>
          );
        })()}

        {projects.length === 0 && openChats.length === 0 && pastChats.length === 0 && (
          <div className="rail-empty">
            <div className="rail-empty-line">No projects yet.</div>
            <div className="rail-empty-hint">
              Click <strong>+</strong> above to create a project label
              for sorting your chats. Or just start a chat in the
              current cwd (<code>{cwd.replace(/^\/home\/[^/]+/, "~")}</code>).
            </div>
          </div>
        )}
      </div>

      <GitHubStrip cwd={cwd} activeTabId={activeTabId} />

      <LeftFooter />

 {/* Assign-to-project context menu. Anchored at the absolute
 * mouse position; clicks inside stopPropagation so the global
 * mousedown dismiss handler doesn't close it. */}
      {chatCtx && (
        <div
          className="ctxmenu"
          style={{
            position: "fixed", top: chatCtx.y, left: chatCtx.x, zIndex: 1000,
            background: "var(--surface)", border: "1px solid var(--hairline)",
            borderRadius: 6, padding: 4, minWidth: 200,
            boxShadow: "0 4px 16px rgba(0,0,0,0.4)",
          }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div style={{ fontSize: "var(--fs-ui-xs)", color: "var(--ink-3)", padding: "4px 10px 6px", letterSpacing: "0.06em", textTransform: "uppercase" }}>
            Move to project
          </div>
          {projects.length === 0 && (
            <div style={{ fontSize: 12, color: "var(--ink-3)", padding: "6px 10px" }}>
              No projects yet. Click + to create one.
            </div>
          )}
          {projects.map((p) => (
            <div
              key={p.id}
              onClick={() => {
                onAssignChatToProject?.(chatCtx.tabId, p.id);
                setChatCtx(null);
              }}
              style={{
                padding: "5px 10px", fontSize: "var(--fs-ui-sm)", cursor: "pointer",
                borderRadius: 4,
              }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.background = "var(--hairline)"; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.background = "transparent"; }}
            >
              <ShellIcon name="folder" size={13} /> {p.name}
            </div>
          ))}
          <div style={{ borderTop: "1px solid var(--hairline)", margin: "4px 0" }} />
          <div
            onClick={() => {
              onAssignChatToProject?.(chatCtx.tabId, null);
              setChatCtx(null);
            }}
            style={{
              padding: "5px 10px", fontSize: "var(--fs-ui-sm)", cursor: "pointer",
              borderRadius: 4, color: "var(--ink-2)",
            }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.background = "var(--hairline)"; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.background = "transparent"; }}
          >
            <ShellIcon name="close" size={13} /> Unfile (remove from project)
          </div>
        </div>
      )}

 {/* Past-chat context menu (sessionId-keyed) — same shape as
 * chatCtx but routes through onAssignSessionToProject. */}
      {sessionCtx && (
        <div
          className="ctxmenu"
          style={{
            position: "fixed", top: sessionCtx.y, left: sessionCtx.x, zIndex: 1000,
            background: "var(--surface)", border: "1px solid var(--hairline)",
            borderRadius: 6, padding: 4, minWidth: 200,
            boxShadow: "0 4px 16px rgba(0,0,0,0.4)",
          }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div style={{ fontSize: "var(--fs-ui-xs)", color: "var(--ink-3)", padding: "4px 10px 6px", letterSpacing: "0.06em", textTransform: "uppercase" }}>
            Move past chat to project
          </div>
          {projects.length === 0 && (
            <div style={{ fontSize: 12, color: "var(--ink-3)", padding: "6px 10px" }}>
              No projects yet. Click + to create one.
            </div>
          )}
          {projects.map((p) => (
            <div
              key={p.id}
              onClick={() => {
                onAssignSessionToProject?.(sessionCtx.sessionId, p.id);
                setSessionCtx(null);
              }}
              style={{
                padding: "5px 10px", fontSize: "var(--fs-ui-sm)", cursor: "pointer", borderRadius: 4,
              }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.background = "var(--hairline)"; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.background = "transparent"; }}
            >
              <ShellIcon name="folder" size={13} /> {p.name}
            </div>
          ))}
          <div style={{ borderTop: "1px solid var(--hairline)", margin: "4px 0" }} />
          <div
            onClick={() => {
              onAssignSessionToProject?.(sessionCtx.sessionId, null);
              setSessionCtx(null);
            }}
            style={{
              padding: "5px 10px", fontSize: "var(--fs-ui-sm)", cursor: "pointer",
              borderRadius: 4, color: "var(--ink-2)",
            }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.background = "var(--hairline)"; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.background = "transparent"; }}
          >
            <ShellIcon name="close" size={13} /> Unfile (remove from project)
          </div>
        </div>
      )}

 {/* 3-option project-delete modal: marker-only / marker +
 * sessions / cancel. */}
      {projectDeleteCtx && onDeleteProject && (
        <div
          className="modal-backdrop"
          onClick={() => setProjectDeleteCtx(null)}
        >
          <div
            className="modal proj-delete-modal"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="proj-del-title"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 id="proj-del-title">Delete project &ldquo;{projectDeleteCtx.name}&rdquo;?</h3>
            <p style={{ fontSize: "var(--fs-ui-sm)", color: "var(--ink-2)", marginTop: 0 }}>
              Project labels group chats in the sidebar. Choose how far
              the deletion should go.
            </p>
            <div className="proj-delete-actions">
              <button
                type="button"
                className="settings-pill"
                onClick={() => {
 // Default: marker-only. Chats fall back to Past chats.
                  onDeleteProject(projectDeleteCtx.id, false);
                  setProjectDeleteCtx(null);
                }}
                title={
                  projectDeleteCtx.chatCount === 0
                    ? "Remove the project label."
                    : `Remove the label only — the ${projectDeleteCtx.chatCount} chat(s) stay and reappear under "Past chats".`
                }
              >
                Delete marker only
              </button>
              <button
                type="button"
                className="settings-pill"
                style={{ borderColor: "var(--fg-error, #f55)", color: "var(--fg-error, #f55)" }}
                onClick={() => {
 // Wipe: marker + the underlying JSONL session files.
                  onDeleteProject(projectDeleteCtx.id, true);
                  setProjectDeleteCtx(null);
                }}
                title={`Delete the project label AND permanently remove ${projectDeleteCtx.chatCount} session file(s) from disk.`}
              >
                Delete marker + sessions ({projectDeleteCtx.chatCount})
              </button>
              <button
                type="button"
                className="settings-pill"
                onClick={() => setProjectDeleteCtx(null)}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

 {/* Single-session delete confirmation modal. */}
      {sessionDeleteCtx && onDeleteSession && (
        <div
          className="modal-backdrop"
          onClick={() => setSessionDeleteCtx(null)}
        >
          <div
            className="modal proj-delete-modal"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="sess-del-title"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 id="sess-del-title">Delete this session permanently?</h3>
            <p style={{ fontSize: "var(--fs-ui-sm)", color: "var(--ink-2)", marginTop: 0 }}>
              <strong>{sessionDeleteCtx.title || "(untitled)"}</strong>
              {" "}— this removes the session JSONL from disk. No undo.
            </p>
            <div className="proj-delete-actions">
              <button
                type="button"
                className="settings-pill"
                style={{ borderColor: "var(--fg-error, #f55)", color: "var(--fg-error, #f55)" }}
                onClick={() => {
                  if (sessionDeleteCtx.kind === "tab") {
                    onDeleteSession({ kind: "tab", tabId: sessionDeleteCtx.tabId });
                  } else {
                    onDeleteSession({ kind: "past", sessionId: sessionDeleteCtx.sessionId });
                  }
                  setSessionDeleteCtx(null);
                }}
              >
                Delete
              </button>
              <button
                type="button"
                className="settings-pill"
                onClick={() => setSessionDeleteCtx(null)}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </aside>
  );
}

/* ─────────────── GitHub strip + foot ─────────────── */

interface GhInfo {
  branch?: string;
  remote?: string;
  ahead?: number;
  behind?: number;
  staged?: string;
}

function GitHubStrip({ cwd, activeTabId }: { cwd: string; activeTabId?: string | null }): JSX.Element | null {
  const [info, setInfo] = useState<GhInfo | null>(null);
  useEffect(() => {
    const qs = activeTabId ? `?tabId=${encodeURIComponent(activeTabId)}` : "";
    void api(`/state/github${qs}`)
      .then((r) => r.json())
      .then((j: GhInfo) => setInfo(j))
      .catch(() => { /* debug API offline — leave empty */ });
  }, [cwd, activeTabId]);

 /* Honest empty state:
 * - hide entirely when neither branch nor remote is known
 * (cwd isn't in a git worktree);
 * - branch === "HEAD" is real detached-HEAD → "detached HEAD";
 * - missing upstream alongside a named branch reads "no upstream"
 * (git-correct, vs. the misleading "no remote"). */
  if (!info) return null;
  if (!info.branch && !info.remote) return null;

  const branchLabel = info.branch === "HEAD" ? "detached HEAD" : (info.branch ?? "no branch");
  const remoteLabel = info.remote ? shortRemote(info.remote) : "no upstream";

  return (
    <div className="gh-strip">
      <div className="git-line">
        <span className="gh-ic">
          <ShellIcon name="git-branch" size={13} />
        </span>
        <span className="branch">{branchLabel}</span>
        <span className="remote">{remoteLabel}</span>
      </div>
      <div className="gh-meta">
        {typeof info.ahead === "number" && info.ahead > 0 && (
          <span className="ahead">
            <ShellIcon name="arrow-up" size={11} />
            {info.ahead} AHEAD
          </span>
        )}
        {typeof info.behind === "number" && info.behind > 0 && (
          <span className="behind">
            <ShellIcon name="chevron-down" size={11} />
            {info.behind} BEHIND
          </span>
        )}
        {info.staged && <span className="changes">{info.staged}</span>}
      </div>
    </div>
  );
}

/**
 * Strip protocol + path, return "host/owner/repo".
 * Best-effort — falls through to the raw URL on unrecognised shapes.
 */
function shortRemote(remote: string): string {
 // ssh form: git@host:owner/repo[.git]
  const ssh = remote.match(/^[^@]+@([^:]+):(.+?)(?:\.git)?$/);
  if (ssh) return `${ssh[1]}/${ssh[2]}`;
 // https form: https://host/owner/repo[.git]
  const https = remote.match(/^https?:\/\/(?:[^@/]+@)?([^/]+)\/(.+?)(?:\.git)?$/);
  if (https) return `${https[1]}/${https[2]}`;
  return remote;
}

function LeftFooter(): JSX.Element {
 // Resolve the session-log path from get_home_dir so the displayed
 // path matches the running OS. Outside Tauri (browser preview) we
 // fall back to "~/.shellx/sessions/".
  const [sessionLogPath, setSessionLogPath] = useState<string>("~/.shellx/sessions/");
  useEffect(() => {
 // Live path resolution — only meaningful inside Tauri.
    if (typeof (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ === "undefined") return;
    void invoke<string>("get_home_dir")
      .then((home) => {
        const isWindows = home.includes("\\");
        const sep = isWindows ? "\\" : "/";
        setSessionLogPath(`${home}${sep}.shellx${sep}sessions${sep}`);
      })
      .catch(() => { /* keep fallback */ });
  }, []);

  return (
    <div className="left-foot">
      <div className="left-foot-row" style={{ color: "var(--ink-4)" }} title={sessionLogPath}>
        <span>history</span>
        <span className="v" style={{
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", direction: "rtl",
        }}>{sessionLogPath}</span>
      </div>
    </div>
  );
}
