/**
 * src/components/HashAutocomplete.tsx — `#N` PR/issue autocomplete
 * .
 *
 * When the user types `#` in the prompt textarea, this popover opens
 * showing open PRs + issues fetched from
 * `gh pr list --json number,title,url`
 * `gh issue list --json number,title,url`
 * via the debug-api /state/github/items endpoint (added at the same
 * time as this component).
 *
 * The popover lives in App-level state — it's positioned at the
 * cursor location passed from the textarea (caret coords are
 * approximated via the textarea's bounding rect + scroll offset; an
 * exact mirror element would be overkill for this surface).
 *
 * On selection, inserts `[#N: <title>](<url>)` into the prompt.
 *
 * Filter logic: matches by number prefix OR title fuzzy substring.
 */
import { useEffect, useMemo, useState, type JSX } from "react";

export interface HashItem {
  kind: "pr" | "issue";
  number: number;
  title: string;
  url: string;
}

export function HashAutocomplete({
  open,
  query,
  items,
  onSelect,
  onClose,
}: {
  open: boolean;
 /** What the user typed AFTER the `#` (could be empty, or `123`, etc). */
  query: string;
  items: HashItem[];
  onSelect: (item: HashItem) => void;
  onClose: () => void;
}): JSX.Element | null {
  const [idx, setIdx] = useState(0);

  const filtered = useMemo(() => {
    if (!query) return items.slice(0, 20);
    const q = query.toLowerCase();
    const numMatch = items.filter((it) => String(it.number).startsWith(query));
    if (numMatch.length > 0) return numMatch.slice(0, 20);
    return items.filter((it) => it.title.toLowerCase().includes(q)).slice(0, 20);
  }, [items, query]);

  useEffect(() => {
    if (idx >= filtered.length) setIdx(Math.max(0, filtered.length - 1));
  }, [filtered.length, idx]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setIdx((i) => Math.min(filtered.length - 1, i + 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setIdx((i) => Math.max(0, i - 1));
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        const sel = filtered[idx];
        if (sel) {
          e.preventDefault();
          onSelect(sel);
        }
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, filtered, idx, onSelect, onClose]);

  if (!open) return null;

  return (
    <div className="hash-pop">
      {filtered.length === 0 ? (
        <div className="hash-empty">No matching PRs/issues.</div>
      ) : (
        filtered.map((it, i) => (
          <button
            key={`${it.kind}-${it.number}`}
            type="button"
            className={`hash-row ${i === idx ? "active" : ""}`}
            onMouseEnter={() => setIdx(i)}
            onClick={() => onSelect(it)}
          >
            <span className="hash-kind">{it.kind === "pr" ? "PR" : "ISSUE"}</span>
            <span className="hash-num">#{it.number}</span>
            <span className="hash-title">{it.title}</span>
          </button>
        ))
      )}
    </div>
  );
}
