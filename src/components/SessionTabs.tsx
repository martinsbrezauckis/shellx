/**
 * src/components/SessionTabs.tsx — middle pane session tab strip.
 *
 * each tab has a fixed max-width with mid-ellipsis truncation,
 * the strip itself is a horizontal-scrolling rail with «/» arrows when
 * overflow occurs, and a ▾ dropdown at the right end shows every open
 * session with its status indicator for fast switching.
 *
 * double-click any tab title to rename
 * in-place. Enter commits, Esc cancels. Mirrors the LeftRail rename UX
 * so the user can rename from either surface and the change syncs.
 */
import { useEffect, useLayoutEffect, useRef, useState, type JSX } from "react";

export interface SessionTab {
  id: string;
  title: string;
  status: "run" | "done" | "input" | "idle";
  transport?: string;
}

/** Mid-ellipsis truncation. "very long session title" → "very lo…title". */
function truncTitle(s: string, max = 28): string {
  if (s.length <= max) return s;
  const half = Math.floor((max - 1) / 2);
  return s.slice(0, half) + "…" + s.slice(s.length - half);
}

function statusLabel(status: SessionTab["status"]): string {
  switch (status) {
    case "run": return "running";
    case "done": return "complete";
    case "input": return "needs input";
    case "idle": return "idle";
  }
}

export function SessionTabs({
  sessions,
  activeId,
  onActivate,
  onNew,
  onClose,
  onRename,
}: {
  sessions: SessionTab[];
  activeId: string | null;
  onActivate: (id: string) => void;
  onNew: () => void;
  onClose: (id: string) => void;
 /** commit a new title for a tab. App.tsx wires this to
 * handleRenameChat which updates the TabEntry + persists the
 * override in chatTitleOverrides so grok's session_summary event
 * doesn't clobber the user's choice on its next emit. */
  onRename?: (id: string, newTitle: string) => void;
}): JSX.Element {
 /* inline rename state. `renamingId` is the tab currently
 * being renamed (null = none active). `draft` mirrors the input value.
 * Both reset on commit (Enter / blur) or cancel (Esc). */
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<string>("");
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (renamingId && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [renamingId]);
  const startRename = (id: string, currentTitle: string) => {
    setRenamingId(id);
    setDraft(currentTitle);
  };
  const commitRename = () => {
    if (renamingId && onRename) {
      const trimmed = draft.trim();
      if (trimmed) onRename(renamingId, trimmed);
    }
    setRenamingId(null);
  };
  const cancelRename = () => setRenamingId(null);
  const railRef = useRef<HTMLDivElement | null>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);
  const [dropdownOpen, setDropdownOpen] = useState(false);

 /* Re-measure overflow state on every relevant change: window resize,
 * sessions list change, scroll position change. */
  const measure = () => {
    const el = railRef.current;
    if (!el) return;
    setCanScrollLeft(el.scrollLeft > 1);
    setCanScrollRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
  };
 /* measure deps were only
 * `[sessions.length]`. Title rename, container resize, or any
 * width-changing event without a session count change left
 * canScrollLeft/Right stale. Now: re-measure on every sessions
 * change (any field, not just count) AND on the rail's own size
 * via ResizeObserver, AND on window resize. */
  useLayoutEffect(measure);
  useEffect(() => {
    const onResize = () => measure();
    window.addEventListener("resize", onResize);
    const el = railRef.current;
    let ro: ResizeObserver | null = null;
    if (el && typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(measure);
      ro.observe(el);
      for (const child of Array.from(el.children)) ro.observe(child as Element);
    }
    return () => {
      window.removeEventListener("resize", onResize);
      ro?.disconnect();
    };
  }, [sessions]);

 /* Scroll the active tab into view when activeId changes. */
  useEffect(() => {
    const el = railRef.current;
    if (!el || !activeId) return;
    const active = el.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(activeId)}"]`);
    if (active) active.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
  }, [activeId]);

  const scrollBy = (dx: number) => {
    const el = railRef.current;
    if (!el) return;
    el.scrollBy({ left: dx, behavior: "smooth" });
  };

 // Close dropdown on outside click / Esc.
  useEffect(() => {
    if (!dropdownOpen) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      const dd = document.querySelector(".stab-dropdown");
      if (dd && !dd.contains(t)) setDropdownOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setDropdownOpen(false); };
    window.addEventListener("mousedown", onDoc);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDoc);
      window.removeEventListener("keydown", onKey);
    };
  }, [dropdownOpen]);

  return (
    <div className="session-tabs">
      {canScrollLeft && (
        <button
          type="button"
          className="stab-nav stab-nav-left"
          onClick={() => scrollBy(-240)}
          title="Scroll tabs left"
          aria-label="Scroll left"
        >
          «
        </button>
      )}
      <div className="session-tabs-rail" ref={railRef} onScroll={measure}>
        {sessions.map((s, index) => {
          const isRenaming = renamingId === s.id;
          const sessionNo = index + 1;
          return (
          <div
            key={s.id}
            data-tab-id={s.id}
            className={`stab ${s.id === activeId ? "active" : ""}`}
            onClick={() => { if (!isRenaming) onActivate(s.id); }}
 /* div+role="button" needs an
 * explicit onKeyDown — Enter/Space activate, Delete/Bkspc
 * close. tabIndex=0 already there.
 * double-click
 * conflict with opening past sessions, switched to
 * hover-revealed ✏️ button. Keyboard: F2 still starts
 * rename for accessibility, but plain `r` was removed to
 * avoid stealing single-char input. */
            onKeyDown={(e) => {
              if (isRenaming) return;
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onActivate(s.id);
              } else if (e.key === "Delete" || e.key === "Backspace") {
                e.preventDefault();
                onClose(s.id);
              } else if (e.key === "F2" && onRename) {
                e.preventDefault();
                startRename(s.id, s.title || "");
              }
            }}
            title={isRenaming ? "" : `#${sessionNo} ${s.title}`}
            role="button"
            tabIndex={0}
          >
            {s.transport && <span className="ttr">{s.transport}</span>}
            <span
              className={`stab-num ${s.status}`}
              aria-label={`Session ${sessionNo}, ${statusLabel(s.status)}`}
              title={`Session ${sessionNo} · ${statusLabel(s.status)}`}
            >
              {sessionNo}
            </span>
            {isRenaming ? (
              <input
                ref={inputRef}
                className="stab-title stab-rename-input"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={commitRename}
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === "Enter") {
                    e.preventDefault();
                    commitRename();
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    cancelRename();
                  }
                }}
                aria-label="Rename session"
              />
            ) : (
              <span className="stab-title">{truncTitle(s.title || "(untitled)")}</span>
            )}
 {/* edit + delete revealed on
 * hover. Edit triggers inline rename; delete closes the tab.
 * CSS-only show/hide via .stab:hover .stab-actions so the
 * idle row stays uncluttered. */}
            {onRename && !isRenaming && (
              <span
                className="stab-edit"
                role="button"
                tabIndex={-1}
                onClick={(e) => { e.stopPropagation(); startRename(s.id, s.title || ""); }}
                title="Rename session (F2)"
                aria-label="Rename session"
              >
                ✎
              </span>
            )}
            <span
              className="sx"
              role="button"
              onClick={(e) => { e.stopPropagation(); onClose(s.id); }}
              title="Close session"
              aria-label="Close session"
            >
              ✕
            </span>
          </div>
          );
        })}
 {/* + button moved INTO the rail, immediately after
 * the last tab. Much more ergonomic — natural click target,
 * scrolls into view when many tabs overflow. */}
        <button
          type="button"
          className="stab-new"
          onClick={onNew}
          title="New session (⌘T)"
        >
          +
        </button>
      </div>
      {canScrollRight && (
        <button
          type="button"
          className="stab-nav stab-nav-right"
          onClick={() => scrollBy(240)}
          title="Scroll tabs right"
          aria-label="Scroll right"
        >
          »
        </button>
      )}
      <div className="stab-dropdown-wrap">
        <button
          type="button"
          className="stab-nav stab-dropdown-btn"
          onClick={() => setDropdownOpen((v) => !v)}
          title="All open sessions"
          aria-label="All sessions"
        >
          ▾
        </button>
        {dropdownOpen && (
          <div className="stab-dropdown" role="listbox">
            <div className="stab-dropdown-head">
              {sessions.length} {sessions.length === 1 ? "session" : "sessions"}
            </div>
            {sessions.map((s, index) => (
              <div
                key={s.id}
                className={`stab-dropdown-row ${s.id === activeId ? "active" : ""}`}
                onClick={() => { onActivate(s.id); setDropdownOpen(false); }}
                role="option"
                aria-selected={s.id === activeId}
                title={`#${index + 1} ${s.title}`}
              >
                <span
                  className={`stab-num ${s.status}`}
                  aria-label={`Session ${index + 1}, ${statusLabel(s.status)}`}
                >
                  {index + 1}
                </span>
                {s.transport && <span className="ttr">{s.transport}</span>}
                <span className="stab-dropdown-title">{s.title || "(untitled)"}</span>
                <span
                  className="sx"
                  role="button"
                  onClick={(e) => { e.stopPropagation(); onClose(s.id); }}
                  title="Close"
                >
                  ✕
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
