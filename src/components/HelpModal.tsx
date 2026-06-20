/**
 * src/components/HelpModal.tsx — `?` help overlay (§15).
 *
 * Listed-bindings reference — sourced from `src/lib/shortcuts.ts` so it
 * never drifts from what App.tsx actually wires. Esc closes. Backdrop
 * click closes.
 */
import { useEffect, type JSX } from "react";
import { SHORTCUTS } from "../lib/shortcuts";

export function HelpModal({ onClose }: { onClose: () => void }): JSX.Element {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

 // Group shortcuts by `group` field so the modal renders in sections.
  const grouped = new Map<string, typeof SHORTCUTS>();
  for (const sc of SHORTCUTS) {
    const arr = grouped.get(sc.group) ?? [];
    arr.push(sc);
    grouped.set(sc.group, arr);
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
      >
        <h3>Keyboard shortcuts</h3>
        {Array.from(grouped.entries()).map(([group, items]) => (
          <div key={group} className="modal-section">
            <h4 style={{
              margin: "12px 0 6px",
              fontSize: "var(--fs-ui-xs)",
              letterSpacing: "0.14em",
              textTransform: "uppercase",
              color: "var(--ink-3)",
              fontWeight: 600,
            }}>{group}</h4>
            <div className="modal-grid">
              {items.map((s) => (
                <Row key={s.id} keys={s.keys} desc={s.desc} />
              ))}
            </div>
          </div>
        ))}
        <div className="modal-hint">
          Press <kbd style={{
            background: "var(--surface-2)",
            border: "1px solid var(--hairline-2)",
            padding: "2px 6px",
            borderRadius: 3,
            fontFamily: "var(--mono)",
            color: "var(--ink-2)",
            fontSize: 12,
          }}>Esc</kbd> to close.
        </div>
      </div>
    </div>
  );
}

function Row({ keys, desc }: { keys: string; desc: string }): JSX.Element {
  return (
    <>
      <kbd>{keys}</kbd>
      <span className="desc">{desc}</span>
    </>
  );
}
