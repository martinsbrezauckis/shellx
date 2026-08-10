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
import {
  projectCollapseDefaults,
  reconcileProjectCollapse,
  toggleProjectCollapse,
} from "../lib/projectCollapse";
import { ShellIcon, TransportIcon, transportTitle } from "./icons";
import { RowActions } from "./RowActions";
import { useModalFocus } from "../lib/useModalFocus";

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

function isKeyboardContextMenu(key: string, shiftKey: boolean): boolean {
  return key === "ContextMenu" || (shiftKey && key === "F10");
}

function keyboardContextMenuPosition(element: HTMLElement): { x: number; y: number } {
  const rect = element.getBoundingClientRect();
  return { x: Math.max(8, rect.left + 16), y: Math.min(window.innerHeight - 8, rect.bottom) };
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
  let persisted: Record<string, unknown> = {};
  try {
    const raw = localStorage.getItem(PROJECTS_COLLAPSE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) persisted = parsed;
    }
  } catch { /* fallthrough */ }
  return projectCollapseDefaults(projects, persisted);
}

export function LeftRail({
  cwd,
  activeTabId,
  onPreviewFile: _onPreviewFile,
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
  const deleteDialogRef = useRef<HTMLDivElement | null>(null);
  useModalFocus(Boolean(projectDeleteCtx || sessionDeleteCtx), deleteDialogRef, () => {
    setProjectDeleteCtx(null);
    setSessionDeleteCtx(null);
  });

 // Persist collapse state on every change.
  useEffect(() => {
    if (!userDataReady) return;
    persistUserData(PROJECTS_COLLAPSE_KEY, collapse);
  }, [collapse, userDataReady]);

  useEffect(() => {
    if (!userDataReady) return;
    setCollapse((current) => reconcileProjectCollapse(projects, current, loadCollapseMap(projects)));
  }, [projects, userDataReady]);

  const toggleProject = (id: string) =>
    setCollapse((current) => toggleProjectCollapse(current, id));

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
  const sessionMenuRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!sessionCtx) return;
    const focusFrame = window.requestAnimationFrame(() => {
      sessionMenuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    });
    const onDoc = () => setSessionCtx(null);
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setSessionCtx(null); };
    window.addEventListener("mousedown", onDoc);
    window.addEventListener("keydown", onKey);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      window.removeEventListener("mousedown", onDoc);
      window.removeEventListener("keydown", onKey);
    };
  }, [sessionCtx]);
  const chatMenuRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!chatCtx) return;
    const focusFrame = window.requestAnimationFrame(() => {
      chatMenuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    });
    const onDoc = () => setChatCtx(null);
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setChatCtx(null); };
    window.addEventListener("mousedown", onDoc);
    window.addEventListener("keydown", onKey);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      window.removeEventListener("mousedown", onDoc);
      window.removeEventListener("keydown", onKey);
    };
  }, [chatCtx]);

  // Disk-backed project/session metadata hydrates asynchronously on boot.
  // Keep every mutating rail control out of the interaction tree until that
  // first read finishes; otherwise a very fast click can be overwritten by
  // the late hydration result.
  if (!userDataReady) {
    return (
      <aside
        className="left"
        data-user-data-ready="false"
        aria-busy="true"
      />
    );
  }

  return (
    <aside
      className="left"
      data-debug-id="left-rail"
      data-user-data-ready="true"
      aria-busy="false"
    >

 {/* Panel header — collapse-all toggle + project count + add button. */}
      <div className="left-hdr">
        <button
          type="button"
          className="left-collapse-all"
          onClick={() => setAllCollapsed((v) => !v)}
          title={allCollapsed ? "Expand all projects" : "Collapse all projects"}
          aria-expanded={!allCollapsed}
          data-shellx-release-observe="expanded"
        >
          <span style={{ display: "inline-block", width: 12, fontSize: 10, color: "var(--ink-3)" }}>
            <ShellIcon name={allCollapsed ? "chevron-right" : "chevron-down"} size={12} />
          </span>
          Projects <span className="ct">· {projects.length}</span>
        </button>
        <button
          type="button"
          className="plus-btn"
          data-debug-id="left-add-project"
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
            <div key={p.id} className="project-block" data-project-id={p.id}>
              <div
                className={`proj-row ${dragOverKey === p.id ? "drag-over" : ""}`}
                data-debug-id="left-project-row"
                data-project-id={p.id}
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
              >
                <button data-debug-id="surface-components-leftrail-3"
                  type="button"
                  className="pcaret"
                  onClick={() => toggleProject(p.id)}
                  title={isExpanded ? "Collapse project" : "Expand project"}
                  aria-label={`${isExpanded ? "Collapse" : "Expand"} ${p.name}`}
                  aria-expanded={isExpanded}
                >
                  <ShellIcon name={isExpanded ? "chevron-down" : "chevron-right"} size={12} />
                </button>
                {isRenaming ? (
                  <>
                    <span className="pico"><ShellIcon name="folder" size={14} /></span>
                    <input
                      ref={inputRef}
                      className="pname-input"
                      data-debug-id="left-project-rename-input"
                      data-shellx-release-observe="nonempty"
                      data-project-id={p.id}
                      type="text"
                      value={renameDraft}
                      onChange={(e) => setRenameDraft(e.target.value)}
                      onBlur={commitProjectRename}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") { e.preventDefault(); commitProjectRename(); }
                        else if (e.key === "Escape") { e.preventDefault(); cancelProjectRename(); }
                      }}
                      placeholder="Project name (empty = delete)"
                      style={{
                        flex: 1, background: "transparent",
                        border: "1px solid var(--ink-4)", borderRadius: 4,
                        color: "var(--ink-1)", font: "inherit",
                        padding: "1px 4px", outline: "none",
                      }}
                    />
                    <span className="pcount">{p.chats.length}</span>
                  </>
                ) : (
                  <button
                    type="button"
                    className="proj-row-main"
                    onClick={() => onClickProjectRow(p)}
                    onDoubleClick={(e) => {
                      e.preventDefault();
                      setRenamingProj(p.id);
                      setRenameDraft(p.name);
                    }}
                    title={`${isExpanded ? "Collapse" : "Expand"} ${p.name} — double-click to rename — drop a chat here to file it`}
                    aria-expanded={isExpanded}
                  >
                    <span className="pico"><ShellIcon name="folder" size={14} /></span>
                    <span className="pname">{p.name}</span>
                    <span className="pcount">{p.chats.length}</span>
                  </button>
                )}
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
                  className="chat-row"
                  data-tab-id={c.id}
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.setData(DRAG_TAB_MIME, c.id);
                    e.dataTransfer.effectAllowed = "move";
                  }}
                >
                  <button
                    type="button"
                    className="chat-row-main"
                    onClick={() => onClickChat(c.id, p.id, c.transport)}
                    onKeyDown={(e) => {
                      if (!isKeyboardContextMenu(e.key, e.shiftKey)) return;
                      e.preventDefault();
                      setChatCtx({ ...keyboardContextMenuPosition(e.currentTarget), tabId: c.id });
                    }}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setChatCtx({ x: e.clientX, y: e.clientY, tabId: c.id });
                    }}
                    title={`Open chat "${c.title}" — use Shift+F10 to move it, or drag it to another project`}
                  >
                    <span className="ttr" title={transportTitle(c.transport)}>
                      <TransportIcon value={c.transport} />
                    </span>
                    <span className="ctitle">{c.title}</span>
                  </button>
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
                  data-session-id={c.id}
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.setData(DRAG_SESSION_MIME, c.id);
                    e.dataTransfer.effectAllowed = "move";
                  }}
                >
 {/* Recorded transport emoji (falls back to 💬) so
 * project-filed past chats match the unfiled
 * past-chat list visually. */}
                  <button
                    type="button"
                    className="chat-row-main"
                    onClick={() => onOpenPastChat?.(c.id, c.title)}
                    onKeyDown={(e) => {
                      if (!isKeyboardContextMenu(e.key, e.shiftKey)) return;
                      e.preventDefault();
                      setSessionCtx({ ...keyboardContextMenuPosition(e.currentTarget), sessionId: c.id });
                    }}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setSessionCtx({ x: e.clientX, y: e.clientY, sessionId: c.id });
                    }}
                    title={`Reopen "${c.title}" — use Shift+F10 to move it, or drag it to another project`}
                  >
                    <span className="ttr" title={transportTitle(c.connectionTransport)}>
                      <TransportIcon value={c.connectionTransport} />
                    </span>
                    <span className="ctitle" style={{
                      overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                    }}>{c.title}</span>
                  </button>
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
              aria-expanded={!unfiledCollapsed}
              data-shellx-release-observe="expanded"
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
                data-tab-id={c.tabId}
 /* open-chat rows are draggable — drop on a
 * project assigns the live tab to that project. */
                draggable={!isRenamingThisChat}
                onDragStart={(e) => {
                  if (isRenamingThisChat) { e.preventDefault(); return; }
                  e.dataTransfer.setData(DRAG_TAB_MIME, c.tabId);
                  e.dataTransfer.effectAllowed = "move";
                }}
 /* double-click
 * removed — it conflicted with focus-tab single-click
 * timing and was unintuitive for past-chat reopen flow.
 * Rename is triggered by the hover-revealed ✎ icon. */
 /* Right-click → "Move to project ▸" menu. */
              >
                {isRenamingThisChat ? (
                  <>
                    <span className="ttr" title={transportTitle(c.connectionTransport)}>
                      <TransportIcon value={c.connectionTransport} />
                    </span>
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
                      placeholder="Chat title"
                      style={{
                        flex: 1, background: "transparent",
                        border: "1px solid var(--ink-4)", borderRadius: 4,
                        color: "var(--ink-1)", font: "inherit",
                        padding: "1px 4px", outline: "none",
                      }}
                    />
                  </>
                ) : (
                  <>
                    <button
                      type="button"
                      className="unfiled-row-main"
                      onClick={() => onFocusTab?.(c.tabId)}
                      onKeyDown={(e) => {
                        if (!isKeyboardContextMenu(e.key, e.shiftKey)) return;
                        e.preventDefault();
                        setChatCtx({ ...keyboardContextMenuPosition(e.currentTarget), tabId: c.tabId });
                      }}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        setChatCtx({ x: e.clientX, y: e.clientY, tabId: c.tabId });
                      }}
                      title={`Focus tab: ${c.title} — use Shift+F10 to move it, or drag it to another project`}
                    >
                      <span className="ttr" title={transportTitle(c.connectionTransport)}>
                        <TransportIcon value={c.connectionTransport} />
                      </span>
                      <span className="ctitle">{c.title || "(untitled)"}</span>
                    </button>
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
                data-debug-id="left-past-chats-toggle"
                onClick={() => setPastCollapsed((v) => !v)}
                title={pastCollapsed ? "Show past chats" : "Hide past chats"}
                aria-expanded={!pastCollapsed}
                data-shellx-release-observe="expanded"
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
                  data-debug-id="left-past-chat-row"
                  data-session-id={c.id}
 /* Synthetic ids (closed-*) carry no session file,
 * so we skip drag for them — same gate as the
 * context menu. */
                  draggable={!c.id.startsWith("closed-") && !isRenamingThisPast}
                  onDragStart={(e) => {
                    if (c.id.startsWith("closed-") || isRenamingThisPast) { e.preventDefault(); return; }
                    e.dataTransfer.setData(DRAG_SESSION_MIME, c.id);
                    e.dataTransfer.effectAllowed = "move";
                  }}
 /* Right-click → "Move to project ▸" menu without
 * opening the chat first. */
                >
 {/* Transport emoji (falls back to 💬 for legacy
 * entries) so closed sessions show Local / WSL /
 * SSH at a glance. */}
                  {isRenamingThisPast ? (
                    <>
                      <span className="ttr" title={transportTitle(c.connectionTransport)}>
                        <TransportIcon value={c.connectionTransport} />
                      </span>
                      <input
                        ref={inputRef}
                        className="ctitle-input"
                        data-debug-id="left-chat-rename-input"
                        data-session-id={c.id}
                        type="text"
                        value={renameDraft}
                        onChange={(e) => setRenameDraft(e.target.value)}
                        onBlur={commitPastRename}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") { e.preventDefault(); commitPastRename(); }
                          else if (e.key === "Escape") { e.preventDefault(); cancelPastRename(); }
                        }}
                        placeholder="Chat title"
                        style={{
                          flex: 1, background: "transparent",
                          border: "1px solid var(--ink-4)", borderRadius: 4,
                          color: "var(--ink-1)", font: "inherit",
                          padding: "1px 4px", outline: "none",
                        }}
                      />
                    </>
                  ) : (
                    <>
                      <button
                        type="button"
                        className="unfiled-row-main"
                        onClick={() => onOpenPastChat?.(c.id, c.title)}
                        onKeyDown={(e) => {
                          if (c.id.startsWith("closed-") || !isKeyboardContextMenu(e.key, e.shiftKey)) return;
                          e.preventDefault();
                          setSessionCtx({ ...keyboardContextMenuPosition(e.currentTarget), sessionId: c.id });
                        }}
                        onContextMenu={(e) => {
                          if (c.id.startsWith("closed-")) return;
                          e.preventDefault();
                          setSessionCtx({ x: e.clientX, y: e.clientY, sessionId: c.id });
                        }}
                        title={`Reopen "${c.title}" — ${c.connectionTransport ? `transport: ${c.connectionTransport} — ` : ""}${c.id.startsWith("closed-") ? "archived session" : "use Shift+F10 to move it, or drag it to another project"} (last touched ${new Date(c.mtime_ms).toLocaleString()})`}
                      >
                        <span className="ttr" title={transportTitle(c.connectionTransport)}>
                          <TransportIcon value={c.connectionTransport} />
                        </span>
                        <span className="ctitle" style={{
                          overflow: "hidden", textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}>{c.title}</span>
                      </button>
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
          ref={chatMenuRef}
          className="ctxmenu"
          role="menu"
          aria-label="Move chat to project"
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
            <button data-debug-id="surface-components-leftrail-15"
              type="button"
              role="menuitem"
              className="ctxmenu-action"
              key={p.id}
              onClick={() => {
                onAssignChatToProject?.(chatCtx.tabId, p.id);
                setChatCtx(null);
              }}
            >
              <ShellIcon name="folder" size={13} /> {p.name}
            </button>
          ))}
          <div role="separator" style={{ borderTop: "1px solid var(--hairline)", margin: "4px 0" }} />
          <button
            type="button"
            role="menuitem"
            className="ctxmenu-action secondary"
            onClick={() => {
              onAssignChatToProject?.(chatCtx.tabId, null);
              setChatCtx(null);
            }}
          >
            <ShellIcon name="close" size={13} /> Unfile (remove from project)
          </button>
        </div>
      )}

 {/* Past-chat context menu (sessionId-keyed) — same shape as
 * chatCtx but routes through onAssignSessionToProject. */}
      {sessionCtx && (
        <div
          ref={sessionMenuRef}
          className="ctxmenu"
          role="menu"
          aria-label="Move past chat to project"
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
            <button data-debug-id="surface-components-leftrail-17"
              type="button"
              role="menuitem"
              className="ctxmenu-action"
              key={p.id}
              onClick={() => {
                onAssignSessionToProject?.(sessionCtx.sessionId, p.id);
                setSessionCtx(null);
              }}
            >
              <ShellIcon name="folder" size={13} /> {p.name}
            </button>
          ))}
          <div role="separator" style={{ borderTop: "1px solid var(--hairline)", margin: "4px 0" }} />
          <button
            type="button"
            role="menuitem"
            className="ctxmenu-action secondary"
            onClick={() => {
              onAssignSessionToProject?.(sessionCtx.sessionId, null);
              setSessionCtx(null);
            }}
          >
            <ShellIcon name="close" size={13} /> Unfile (remove from project)
          </button>
        </div>
      )}

 {/* 3-option project-delete modal: marker-only / marker +
 * sessions / cancel. */}
      {projectDeleteCtx && onDeleteProject && (
        <div data-debug-id="surface-components-leftrail-19"
          className="modal-backdrop"
          onClick={() => setProjectDeleteCtx(null)}
        >
          <div data-debug-id="surface-components-leftrail-20"
            ref={deleteDialogRef}
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
                style={{ borderColor: "var(--fg-error)", color: "var(--fg-error)" }}
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
                data-dialog-initial-focus="true"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

 {/* Single-session delete confirmation modal. */}
      {sessionDeleteCtx && onDeleteSession && (
        <div data-debug-id="surface-components-leftrail-24"
          className="modal-backdrop"
          onClick={() => setSessionDeleteCtx(null)}
        >
          <div data-debug-id="surface-components-leftrail-25"
            ref={deleteDialogRef}
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
                style={{ borderColor: "var(--fg-error)", color: "var(--fg-error)" }}
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
                data-dialog-initial-focus="true"
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
    const query = new URLSearchParams();
    if (activeTabId) query.set("tabId", activeTabId);
    if (cwd.trim()) query.set("cwd", cwd.trim());
    const suffix = query.size > 0 ? `?${query.toString()}` : "";
    void api(`/state/github${suffix}`)
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
  const historyDisplayPath = "~/.shellx/sessions/";
 // Resolve the native location for the tooltip only. Keeping the compact
 // home-relative path in visible UI avoids exposing the operator's account
 // name or an isolated release-profile path in screenshots and screen shares.
  const [sessionLogPath, setSessionLogPath] = useState<string>(historyDisplayPath);
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
          minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        }}>{historyDisplayPath}</span>
      </div>
    </div>
  );
}
