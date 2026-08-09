/**
 * src/components/ConnectionPicker.tsx — saved-connection list popover
 * .
 *
 * Mounted from the composer connection chip; selecting a preset updates
 * the active tab's environment before the user chooses an agent/cwd.
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
 * Selecting a preset fires `onSelect(preset)` so the parent can thread
 * the environment into the next agent-session start. Editing fires
 * `onEdit(preset?)` so the parent can mount ConnectionEditor.
 */
import { useCallback, useEffect, useRef, useState, type CSSProperties, type JSX } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { inTauri } from "../lib/tauri-bridge";
import { agentDisplayName, type AgentId } from "../lib/agent-selection";

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
      remoteRuntime?: "posix" | "windows" | "windows_wsl";
      wslDistro?: string;
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
  providerScan?: ConnectionProviderScanEntry[];
}

export interface ConnectionProviderScanEntry {
  providerId: AgentId;
  canRun: boolean;
  status?: ConnectionProviderScanStatus;
  binary?: string;
  version?: string;
  binarySha256?: string;
  binaryBytes?: number;
  targetKey?: string;
  detail?: string;
  checkedAtMs: number;
}

export type ConnectionProviderScanStatus =
  | "ready"
  | "missing"
  | "versionFailed"
  | "identityFailed"
  | "targetUnavailable"
  | "authNeeded"
  | "canaryFailed"
  | "unknown";

export interface ConnectionProviderCapabilityTarget {
  key: string;
  transport: "local" | "wsl" | "ssh" | string;
  runtime: "posix" | "windows" | "windows_wsl" | "unsupported" | string;
  label: string;
  wslDistro?: string;
  sshHost?: string;
  sshPort?: number;
}

export interface ConnectionProviderCapabilitySnapshot {
  schemaVersion: "shellx.provider-capability-snapshot.v2";
  generatedAtMs: number;
  freshUntilMs: number;
  target: ConnectionProviderCapabilityTarget;
  providers: ConnectionProviderScanEntry[];
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
  const [pendingDelete, setPendingDelete] = useState<ConnectionPreset | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const pickerContentRef = useRef<HTMLDivElement | null>(null);
  const deleteCancelRef = useRef<HTMLButtonElement | null>(null);
  const deleteConfirmRef = useRef<HTMLButtonElement | null>(null);

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
    else setPendingDelete(null);
  }, [open, refresh]);

  useEffect(() => {
    if (pendingDelete) {
      pickerContentRef.current?.setAttribute("inert", "");
      deleteCancelRef.current?.focus();
    } else {
      pickerContentRef.current?.removeAttribute("inert");
    }
  }, [pendingDelete]);

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
      if (e.key === "Escape") {
        if (pendingDelete) setPendingDelete(null);
        else onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDoc);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, onClose, pendingDelete]);

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
      await refresh();
    } catch (e) {
      setError(String(e));
    }
  }

  async function handleDelete(id: string) {
    if (pendingDelete?.id !== id) return;
    setPendingDelete(null);
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
      aria-label="Saved connections"
      style={{
        position: "fixed",
        left: coords.left,
        bottom: coords.bottom,
        width: coords.width,
      }}
    >
      <div ref={pickerContentRef} aria-hidden={pendingDelete ? true : undefined}>
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
                onDelete={() => setPendingDelete(p)}
              />
            ))}
          </ul>
        )}
      </div>
      {pendingDelete && (
        <div
          role="alertdialog"
          aria-modal="true"
          aria-label="Delete connection"
          aria-describedby="connection-delete-confirmation-copy"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              setPendingDelete(null);
              return;
            }
            if (event.key !== "Tab") return;
            const next = event.shiftKey ? deleteCancelRef.current : deleteConfirmRef.current;
            const wrap = event.shiftKey ? deleteConfirmRef.current : deleteCancelRef.current;
            if (document.activeElement === next) {
              event.preventDefault();
              wrap?.focus();
            }
          }}
          style={{
            position: "absolute",
            inset: 8,
            zIndex: 2,
            display: "flex",
            flexDirection: "column",
            justifyContent: "center",
            gap: 12,
            padding: 16,
            border: "1px solid var(--border)",
            borderRadius: 8,
            background: "var(--panel)",
            boxShadow: "0 12px 36px rgba(0,0,0,0.5)",
          }}
        >
          <strong style={{ overflowWrap: "anywhere" }}>Delete {pendingDelete.label}?</strong>
          <span id="connection-delete-confirmation-copy">This removes the saved preset from this device.</span>
          <span style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <button ref={deleteCancelRef} type="button" onClick={() => setPendingDelete(null)} style={btnStyle}>Cancel</button>
            <button
              ref={deleteConfirmRef}
              type="button"
              aria-label="Confirm delete connection"
              onClick={() => void handleDelete(pendingDelete.id)}
              style={{ ...btnStyle, color: "var(--danger)", borderColor: "var(--danger)" }}
            >
              Delete
            </button>
          </span>
        </div>
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
    : "var(--fg-muted)";
  const lastUsed = preset.lastUsedMs === 0
    ? "never"
    : new Date(preset.lastUsedMs).toLocaleString();
  const readyProviders = (preset.providerScan ?? []).filter((provider) => provider.canRun);
  const providerLabel = readyProviders.length > 0
    ? readyProviders.map((provider) => agentDisplayName(provider.providerId)).join(", ")
    : null;
  const transportLabel = preset.transport.kind === "ssh"
    ? preset.transport.remoteRuntime === "windows_wsl"
      ? `ssh / Windows + WSL ${preset.transport.wslDistro ?? ""}`.trim()
      : preset.transport.remoteRuntime === "windows"
        ? "ssh / Windows"
        : "ssh / POSIX"
    : preset.transport.kind;
  return (
    <li
      style={{
        display: "flex",
        gap: 8,
        alignItems: "center",
        padding: "8px 12px",
        borderBottom: "1px solid var(--border)",
        background: active ? "rgba(255,255,255,0.05)" : "transparent",
      }}
    >
      <button
        type="button"
        className="connection-row-main"
        onClick={onSelect}
        aria-current={active ? "true" : undefined}
        title={`Use ${preset.label}`}
      >
        <span
          aria-label={testResult?.reachable ? "reachable" : "untested or unreachable"}
          data-shellx-release-control="connection-test-receipt"
          title={testResult
            ? `Connection test · reachable=${testResult.reachable} · latencyMs=${testResult.latencyMs ?? "none"} · error=${testResult.error ? "present" : "none"}`
            : "Connection test · pending"}
          style={{
            width: 8,
            height: 8,
            borderRadius: 4,
            background: dot,
            flex: "0 0 auto",
          }}
        />
        <span className="connection-row-copy">
          <span style={{ fontSize: "var(--fs-ui-sm)" }}>{preset.label}</span>
          <span
            style={{
              fontSize: "var(--fs-ui-xs)",
              color: "var(--fg-muted)",
              fontFamily: "var(--mono, monospace)",
            }}
          >
            {transportLabel} · last used {lastUsed}
          </span>
          {providerLabel && (
            <span
              style={{
                fontSize: "var(--fs-ui-xs)",
                color: "var(--fg-muted)",
              }}
            >
              agents last seen: {providerLabel}
            </span>
          )}
        </span>
      </button>
      <span data-debug-id="surface-components-connectionpicker-3" style={{ display: "flex", gap: 4 }} onClick={(e) => e.stopPropagation()}>
        <button type="button" onClick={onTest} style={btnStyle}>
          Test
        </button>
        <button type="button" onClick={onEdit} style={btnStyle}>
          Edit
        </button>
        <button type="button" onClick={onDelete} style={btnStyle} aria-label={`Delete ${preset.label}`}>
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
  border: "1px solid var(--border)",
  color: "inherit",
  cursor: "pointer",
};
