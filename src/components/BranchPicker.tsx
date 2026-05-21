/**
 * src/components/BranchPicker.tsx — git branch dropdown for the
 * composer's Scope-row branch pill.
 *
 *  wired via the `git_branches` Tauri command (Rust calls
 * `git for-each-ref` and returns name + isCurrent + upstream). On select,
 * fires `onSelect(name)` so the parent can persist `scopeBranch` to the
 * active tab. Worktree CTA stays explicit no-op for v1; the prop is
 * kept for forward-compat.
 *
 * Keyboard: Esc closes, Arrow/Home/End moves selection, Enter picks.
 */
import { useCallback, useEffect, useRef, useState, type JSX } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";

export interface BranchInfo {
 /** Short name. "master", "feature/foo", "origin/main" etc. */
  name: string;
 /** True for the currently-checked-out branch. */
  current: boolean;
 /** True for remote branches (origin/, upstream/, ...). Used for grouping. */
  remote: boolean;
 /** Commits ahead of the tracked upstream. Undefined when unknown. */
  ahead?: number;
 /** Commits behind the tracked upstream. Undefined when unknown. */
  behind?: number;
}

export function BranchPicker({
  open,
  onClose,
  onSelect,
  activeName,
  cwd,
  activeTabId,
}: {
  open: boolean;
 /** Currently-checked-out branch — used to render the active marker. */
  activeName?: string;
 /** Called when user picks a branch — sets scopeBranch on active tab. */
  onSelect: (name: string) => void;
 /** "+ Create worktree from branch" CTA — kept for forward-compat;
 * parent's handler is intentionally a no-op for v1. */
  onCreateWorktree: (sourceBranch: string) => void;
  onClose: () => void;
 /** Working dir to pass to `git for-each-ref`. Falls back to "." if absent. */
  cwd?: string;
 /** Active shellX tab; lets the backend run git on Local / WSL / SSH. */
  activeTabId?: string | null;
}): JSX.Element | null {
  const [branches, setBranches] = useState<{ name: string; isCurrent: boolean; isRemote?: boolean; upstream: string | null }[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const res = await invoke<{ branches: { name: string; isCurrent: boolean; isRemote?: boolean; upstream: string | null }[] }>(
          "git_branches",
          { cwd: cwd ?? ".", tabId: activeTabId ?? null },
        );
        if (!cancelled) {
          const next = res.branches ?? [];
          setBranches(next);
          const current = next.findIndex((b) => b.isCurrent);
          setActiveIndex(current >= 0 ? current : 0);
        }
      } catch (e: unknown) {
        if (!cancelled) setError(typeof e === "string" ? e : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [open, cwd, activeTabId]);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setActiveIndex((i) => Math.min(Math.max(i, 0), Math.max(branches.length - 1, 0)));
  }, [branches.length]);

 // Click-outside dismiss. Skip the pill that toggled us open so the
 // pill's onClick doesn't immediately re-open the picker after the
 // mousedown closes it. The `[data-picker-anchor="branch"]` attribute
 // identifies the trigger.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (rootRef.current && rootRef.current.contains(t)) return;
      if (t.closest('[data-picker-anchor="branch"]')) return;
      onClose();
    };
    window.addEventListener("mousedown", onDoc);
    return () => window.removeEventListener("mousedown", onDoc);
  }, [open, onClose]);

 // Keyboard nav captured globally while the portaled popover is open.
  const onKey = useCallback((e: KeyboardEvent) => {
    if (!open) return;
    if (e.key === "Escape") { e.preventDefault(); onClose(); return; }
    if (branches.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, branches.length - 1));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
      return;
    }
    if (e.key === "Home") {
      e.preventDefault();
      setActiveIndex(0);
      return;
    }
    if (e.key === "End") {
      e.preventDefault();
      setActiveIndex(branches.length - 1);
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const selected = branches[activeIndex];
      if (selected) {
        onSelect(selected.name);
        onClose();
      }
    }
  }, [activeIndex, branches, onClose, onSelect, open]);
  useEffect(() => {
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onKey]);

 // Portaled to document.body with fixed-position coordinates from
 // the pill's bounding rect. Escapes the .bottom-body overflow:auto
 // and react-resizable-panels overflow:hidden clips. Anchor the
 // picker's BOTTOM edge at (pill_top - 6px) so it grows upward.
  const [coords, setCoords] = useState<{ left: number; bottom: number; width: number } | null>(null);
  useEffect(() => {
    if (!open) { setCoords(null); return; }
    const anchor = document.querySelector('[data-picker-anchor="branch"]');
    if (!anchor) return;
    const r = anchor.getBoundingClientRect();
    setCoords({
      left: r.left,
      bottom: window.innerHeight - r.top + 6,
      width: 380,
    });
  }, [open]);

  if (!open || !coords) return null;

  return createPortal(
    <div
      ref={rootRef}
      className="branch-picker branch-picker--portal"
      role="listbox"
      style={{
        position: "fixed",
        left: coords.left,
        bottom: coords.bottom,
        width: coords.width,
      }}
    >
      <div className="bp-head">
        <span>Branches</span>
        {activeName && <span style={{ opacity: 0.6, marginLeft: 8 }}>· current: {activeName}</span>}
      </div>
      <div className="bp-section" style={{ maxHeight: 320, overflowY: "auto", padding: 4 }}>
        {loading && <div style={{ padding: 12, opacity: 0.6 }}>Loading…</div>}
        {error && <div style={{ padding: 12, color: "#d97757", fontSize: 12 }}>{error}</div>}
        {!loading && !error && branches.length === 0 && (
          <div style={{ padding: 12, opacity: 0.7, fontStyle: "italic" }}>
            No branches found in <code>{cwd ?? "."}</code>.
          </div>
        )}
        {!loading && !error && branches.map((b, index) => (
          <button
            key={b.name}
            type="button"
            role="option"
            aria-selected={index === activeIndex}
            className="bp-row"
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              width: "100%",
              padding: "6px 10px",
              background: "transparent",
              border: "none",
              color: "var(--ink)",
              textAlign: "left",
              cursor: "pointer",
              fontFamily: "var(--mono)",
              fontSize: 12,
              outline: index === activeIndex ? "1px solid var(--accent)" : "none",
            }}
            onMouseEnter={() => setActiveIndex(index)}
            onClick={() => { onSelect(b.name); onClose(); }}
          >
            <span style={{ width: 10, opacity: b.isCurrent ? 1 : 0 }}>{b.isCurrent ? "●" : ""}</span>
            <span style={{ flex: 1 }}>{b.name}</span>
            {b.isRemote && <span style={{ opacity: 0.5, fontSize: "var(--fs-ui-xs)" }}>remote</span>}
            {b.upstream && <span style={{ opacity: 0.5, fontSize: "var(--fs-ui-xs)" }}>{b.upstream}</span>}
          </button>
        ))}
      </div>
      <div className="bp-foot">
        <span><kbd>Esc</kbd> close</span>
      </div>
    </div>,
    document.body,
  );
}
