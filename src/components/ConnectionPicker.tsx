/**
 * src/components/ConnectionPicker.tsx — saved-connection list popover
 * .
 *
 * Mount in <PopoverRoot> next to .workspace chip in Header.tsx —
 * clicking the chip opens this list. Until then, importable but NOT
 * mounted in App.tsx — agent J's UI-polish work will mount it once
 * the layout converges.
 *
 * UX:
 * - Lists saved presets sorted by lastUsedMs DESC, then label ASC.
 * - Each row: status dot · label · transport icon · edit · delete.
 * The dot is grey by default and turns green/red after the user
 * hits Test on that row (latency cached client-side for the
 * lifetime of the popover).
 * - "+ New connection" opens <ConnectionEditor /> via the
 * parent-supplied `onEdit(undefined)` callback.
 *
 * Backend wiring:
 * - invoke("connections_list") → ConnectionPreset[]
 * - invoke("connections_test", {id}) → TestResult
 * - invoke("connections_delete", {id}) → boolean
 *
 * Activation pattern: the parent owns whether the picker is open.
 * Selecting a preset fires `onSelect(preset)` so the parent can
 * thread the id into the next start_grok_session call. Editing fires
 * `onEdit(preset?)` so the parent can mount ConnectionEditor.
 */
import { useCallback, useEffect, useRef, useState, type CSSProperties, type JSX } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { inTauri } from "../lib/tauri-bridge";

/* ------------------------------------------------------------------ */
/* Shared types — re-exported so ConnectionEditor can import without a */
/* circular dep on the picker. */
/* ------------------------------------------------------------------ */

export type TransportSpec =
  | { kind: "local"; grokPath?: string }
  | { kind: "wsl"; distro: string; grokPath: string }
  | {
      kind: "ssh";
      host: string;
      port?: number;
      keyVaultRef?: string;
      remoteGrokPath: string;
    }
 /* reserved variants — rendered as grey/disabled rows
     until the next phase wires them. */
  | { kind: "ws_direct"; url: string; secretVaultRef?: string }
  | { kind: "ws_tunnel"; url: string; secretVaultRef?: string }
  | { kind: "tailscale"; tailnetHost: string; port?: number };

export interface ConnectionPreset {
  id: string;
  label: string;
  transport: TransportSpec;
  createdMs: number;
  lastUsedMs: number;
}

export interface TestResult {
  reachable: boolean;
  latencyMs: number | null;
  error: string | null;
}

/* ------------------------------------------------------------------ */
/* Picker component */
/* ------------------------------------------------------------------ */

export function ConnectionPicker({
  open,
  activeId,
  onSelect,
  onEdit,
  onClose,
}: {
  open: boolean;
  activeId?: string | null;
  onSelect: (preset: ConnectionPreset) => void;
 /** Called with `undefined` to create new, or with the preset to edit. */
  onEdit: (preset?: ConnectionPreset) => void;
  onClose: () => void;
}): JSX.Element | null {
  const [presets, setPresets] = useState<ConnectionPreset[]>([]);
  const [testCache, setTestCache] = useState<Record<string, TestResult>>({});
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const refresh = useCallback(async () => {
 // invoke throws outside Tauri (no __TAURI_INTERNALS__ → no IPC
 // bridge). Show the empty state silently rather than a red banner.
    if (!inTauri()) {
      setPresets([]);
      setError(null);
      return;
    }
    try {
      const list = await invoke<ConnectionPreset[]>("connections_list");
      setPresets(list);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    if (open) refresh();
  }, [open, refresh]);

 // Outside-click dismiss. Declared BEFORE the early `if (!open)
 // return null;` so hook order stays stable; the handler itself
 // gates on `open` and is a no-op when closed.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
 // Don't close on clicks inside the picker root.
      if (rootRef.current && rootRef.current.contains(t)) return;
 // Don't close on clicks on the pill that toggled us open —
 // otherwise the pill's onClick would immediately re-open us.
      if (t.closest('[data-picker-anchor="connection"]')) return;
      onClose();
    };
    window.addEventListener("mousedown", onDoc);
 // Bubble-phase Esc handler — fires after App's closeAllModals so
 // local picker state can close cleanly.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDoc);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

 // Portaled picker — compute pill rect and anchor the bottom edge at
 // (pill_top - 6) so it grows upward. Escapes the .bottom-body
 // overflow:auto and react-resizable-panels clip.
  const [coords, setCoords] = useState<{ left: number; bottom: number; width: number } | null>(null);
  useEffect(() => {
    if (!open) { setCoords(null); return; }
    const anchor = document.querySelector('[data-picker-anchor="connection"]');
    if (!anchor) return;
    const r = anchor.getBoundingClientRect();
    setCoords({
      left: r.left,
      bottom: window.innerHeight - r.top + 6,
      width: 360,
    });
  }, [open]);

  if (!open || !coords) return null;

  const sorted = [...presets].sort((a, b) => {
    if (b.lastUsedMs !== a.lastUsedMs) return b.lastUsedMs - a.lastUsedMs;
    return a.label.localeCompare(b.label);
  });

  async function handleTest(id: string) {
    try {
      const r = await invoke<TestResult>("connections_test", { id });
      setTestCache((prev) => ({ ...prev, [id]: r }));
    } catch (e) {
      setError(String(e));
    }
  }

  async function handleDelete(id: string) {
    if (!window.confirm("Delete this connection preset?")) return;
    try {
      await invoke("connections_delete", { id });
      await refresh();
    } catch (e) {
      setError(String(e));
    }
  }

  return createPortal(
    <div
      ref={rootRef}
      className="connection-picker-pop"
      role="dialog"
      aria-modal="true"
      aria-label="Saved connections"
      style={{
        position: "fixed",
        left: coords.left,
        bottom: coords.bottom,
        width: coords.width,
      }}
    >
      <div className="bp-head">
        <span>Connections</span>
        <button
          type="button"
          onClick={() => onEdit(undefined)}
          className="cp-new"
          title="Add a new connection"
        >
          + New
        </button>
      </div>
      {error && (
        <div role="alert" className="cp-error">{error}</div>
      )}
      {sorted.length === 0 ? (
        <div className="cp-empty">No saved connections. Click + New to add one.</div>
      ) : (
        <ul className="cp-list">
          {sorted.map((p) => (
            <ConnectionRow
              key={p.id}
              preset={p}
              active={p.id === activeId}
              testResult={testCache[p.id]}
              onSelect={() => { onSelect(p); onClose(); }}
              onTest={() => handleTest(p.id)}
              onEdit={() => onEdit(p)}
              onDelete={() => handleDelete(p.id)}
            />
          ))}
        </ul>
      )}
    </div>,
    document.body,
  );
}

function ConnectionRow({
  preset,
  active,
  testResult,
  onSelect,
  onTest,
  onEdit,
  onDelete,
}: {
  preset: ConnectionPreset;
  active: boolean;
  testResult: TestResult | undefined;
  onSelect: () => void;
  onTest: () => void;
  onEdit: () => void;
  onDelete: () => void;
}): JSX.Element {
  const dot = testResult
    ? testResult.reachable
      ? "#5b5"
      : "#c55"
    : "var(--fg-muted, #555)";
  const lastUsed = preset.lastUsedMs === 0
    ? "never"
    : new Date(preset.lastUsedMs).toLocaleString();
  return (
    <li
      style={{
        display: "flex",
        gap: 8,
        alignItems: "center",
        padding: "8px 12px",
        borderBottom: "1px solid var(--border, #222)",
        background: active ? "rgba(255,255,255,0.05)" : "transparent",
        cursor: "pointer",
      }}
      onClick={onSelect}
    >
      <span
        aria-label={testResult?.reachable ? "reachable" : "untested or unreachable"}
        style={{
          width: 8,
          height: 8,
          borderRadius: 4,
          background: dot,
          flex: "0 0 auto",
        }}
      />
      <div style={{ flex: "1 1 auto", display: "flex", flexDirection: "column", gap: 2 }}>
        <span style={{ fontSize: "var(--fs-ui-sm)" }}>{preset.label}</span>
        <span
          style={{
            fontSize: "var(--fs-ui-xs)",
            color: "var(--fg-muted, #888)",
            fontFamily: "var(--mono, monospace)",
          }}
        >
          {preset.transport.kind} · last used {lastUsed}
        </span>
      </div>
      <span style={{ display: "flex", gap: 4 }} onClick={(e) => e.stopPropagation()}>
        <button onClick={onTest} style={btnStyle}>
          Test
        </button>
        <button onClick={onEdit} style={btnStyle}>
          Edit
        </button>
        <button onClick={onDelete} style={btnStyle}>
          ×
        </button>
      </span>
    </li>
  );
}

const btnStyle: CSSProperties = {
  fontSize: "var(--fs-ui-xs)",
  padding: "2px 6px",
  background: "transparent",
  border: "1px solid var(--border, #333)",
  color: "inherit",
  cursor: "pointer",
};
