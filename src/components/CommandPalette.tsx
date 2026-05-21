/**
 * src/components/CommandPalette.tsx — ⌘K command palette (§15.1).
 *
 * Opens from anywhere (including inside the prompt input — ⌘K is a
 * universal binding). Lists:
 * 1. Grok-shell native actions (Connect, Abort, Open Preview, Toggle
 * Terminal, Switch Autonomy, Open Settings, New Session, Close
 * Session, Attach File).
 * 2. Every slash-command surfaced via the latest
 * `available_commands_update` event (passed in as `skills`).
 *
 * Fuzzy match: lightweight subsequence scoring — no external dep.
 * Enter executes the highlighted item, Esc closes, ↑/↓ moves selection.
 *
 * The palette is purely visual + dispatchy; the actual work lives in
 * the action handlers App.tsx passes through `actions` + the prompt
 * setter for `/skill` insertion.
 */
import { useEffect, useMemo, useRef, useState, type JSX } from "react";
import type { AcpCommand } from "../types/acp";

export interface PaletteAction {
 /** Stable id for the row, also used for keyboard nav. */
  id: string;
 /** Primary text rendered. */
  label: string;
 /** Secondary text (right-aligned). */
  hint?: string;
 /** Optional group label for grouping in the list. */
  group: "Action" | "Slash" | "Skill";
 /** Called when the row is activated. */
  run: () => void;
}

export function CommandPalette({
  open,
  onClose,
  actions,
  skills,
  insertSlash,
}: {
  open: boolean;
  onClose: () => void;
  actions: PaletteAction[];
  skills: AcpCommand[];
 /** Inserts `/name ` into the prompt input + focuses it. */
  insertSlash: (name: string) => void;
}): JSX.Element | null {
  const [q, setQ] = useState("");
  const [idx, setIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

 // Reset query on open/close so the palette is fresh each invocation.
  useEffect(() => {
    if (open) {
      setQ("");
      setIdx(0);
 // Defer focus to after paint so the input exists.
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

 // Build flat row list = actions + skills, then fuzzy-filter by q.
  const rows = useMemo<PaletteAction[]>(() => {
    const slashRows: PaletteAction[] = skills.map((s) => ({
      id: `skill:${s.name}`,
      label: `/${s.name}`,
      hint: s.description?.slice(0, 80) ?? "",
      group: "Slash",
      run: () => insertSlash(s.name),
    }));
    const all = [...actions, ...slashRows];
    if (!q.trim()) return all;
    const ranked = all
      .map((r) => ({ r, s: scoreFuzzy(q, r.label + " " + (r.hint ?? "")) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .map((x) => x.r);
    return ranked;
  }, [q, actions, skills, insertSlash]);

 // Clamp idx into the available range.
  useEffect(() => {
    if (idx >= rows.length) setIdx(Math.max(0, rows.length - 1));
  }, [rows.length, idx]);

  if (!open) return null;

  function handleKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setIdx((i) => Math.min(rows.length - 1, i + 1));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setIdx((i) => Math.max(0, i - 1));
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const row = rows[idx];
      if (row) {
        row.run();
        onClose();
      }
      return;
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="palette"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Command palette"
      >
        <input
          ref={inputRef}
          type="text"
          className="palette-input"
          placeholder="Type a command — actions and slash-commands"
          value={q}
          onChange={(e) => { setQ(e.target.value); setIdx(0); }}
          onKeyDown={handleKey}
        />
        <div className="palette-list">
          {rows.length === 0 && (
            <div className="palette-empty">No matches.</div>
          )}
          {rows.map((r, i) => (
            <button
              key={r.id}
              type="button"
              className={`palette-row ${i === idx ? "active" : ""}`}
              onMouseEnter={() => setIdx(i)}
              onClick={() => { r.run(); onClose(); }}
            >
              <span className="pgroup">{r.group}</span>
              <span className="plabel">{r.label}</span>
              {r.hint && <span className="phint">{r.hint}</span>}
            </button>
          ))}
        </div>
        <div className="palette-hint">
          <kbd>↑</kbd> <kbd>↓</kbd> navigate · <kbd>⏎</kbd> run · <kbd>Esc</kbd> close
        </div>
      </div>
    </div>
  );
}

/**
 * Lightweight fuzzy scoring: full substring = 100, all chars in order = 50,
 * else 0. Good enough for a few hundred entries without a dep.
 */
function scoreFuzzy(query: string, target: string): number {
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  if (!q) return 1;
  if (t.includes(q)) return 100 + (q.length / t.length) * 10;
 // subsequence
  let i = 0;
  for (let j = 0; j < t.length && i < q.length; j++) {
    if (t[j] === q[i]) i++;
  }
  return i === q.length ? 50 + (q.length / t.length) * 10 : 0;
}
