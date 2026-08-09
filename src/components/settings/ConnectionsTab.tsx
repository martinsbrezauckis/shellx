/**
 * src/components/settings/ConnectionsTab.tsx — CRUD for saved
 * connection presets, inline in the Settings dialog.
 *
 * Shares its data source (`invoke("connections_list")`) and editor
 * component (`ConnectionEditor`) with the composer's ConnectionPicker.
 * + Add mounts the editor; per-row Edit/Delete with optimistic
 * refresh after each mutation.
 *
 * The shared `ConnectionEditor` handles every transport variant
 * (Local / WSL / SSH) and the vault-key dropdown for SSH keys.
 */
import { useCallback, useEffect, useRef, useState, type JSX } from "react";
import { invoke } from "@tauri-apps/api/core";
import { inTauri } from "../../lib/tauri-bridge";
import type { ConnectionPreset } from "../ConnectionPicker";
import { ConnectionEditor } from "../ConnectionEditor";

export function ConnectionsTab(): JSX.Element {
  const [presets, setPresets] = useState<ConnectionPreset[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<ConnectionPreset | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const deleteCancelRef = useRef<HTMLButtonElement | null>(null);
  const deleteConfirmRef = useRef<HTMLButtonElement | null>(null);
 // Editor state: null = closed; {initial: undefined} = creating new;
 // {initial: preset} = editing existing.
  const [editing, setEditing] = useState<{ initial?: ConnectionPreset } | null>(null);
  const desktopConnectionsAvailable = inTauri();

  const refresh = useCallback(async () => {
    if (!desktopConnectionsAvailable) {
      setError("Connections unavailable outside Tauri (browser preview mode).");
      return;
    }
    setBusy(true);
    try {
      const list = await invoke<ConnectionPreset[]>("connections_list");
      setPresets(
        [...list].sort((a, b) => {
          if (b.lastUsedMs !== a.lastUsedMs) return b.lastUsedMs - a.lastUsedMs;
          return a.label.localeCompare(b.label);
        }),
      );
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }, [desktopConnectionsAvailable]);

  useEffect(() => { void refresh(); }, [refresh]);

  useEffect(() => {
    if (pendingDelete) {
      contentRef.current?.setAttribute("inert", "");
      deleteCancelRef.current?.focus();
    } else {
      contentRef.current?.removeAttribute("inert");
    }
  }, [pendingDelete]);

  const handleDelete = useCallback(async (preset: ConnectionPreset) => {
    if (pendingDelete?.id !== preset.id) return;
    setPendingDelete(null);
    try {
      await invoke("connections_delete", { id: preset.id });
      await refresh();
    } catch (e) {
      setError(`Delete failed: ${e}`);
    }
  }, [pendingDelete, refresh]);

  return (
    <div className="settings-tab-body" style={{ position: "relative" }}>
      <div ref={contentRef} aria-hidden={pendingDelete ? true : undefined}>
        <div className="connections-header">
        <p className="settings-tab-hint">
          Saved environments used to launch ShellX agent sessions. The
          same store is reachable from the connection pill in the
          composer footer — edits here are visible there.
        </p>
        <div style={{ display: "flex", gap: 8 }}>
          <button
            type="button"
            className="settings-pill"
            onClick={() => setEditing({ initial: undefined })}
            disabled={!desktopConnectionsAvailable}
            title="Add a new connection preset"
          >
            + Add
          </button>
          <button data-debug-id="surface-components-settings-connectionstab-2"
            type="button"
            className="settings-pill"
            onClick={() => void refresh()}
            disabled={busy || !desktopConnectionsAvailable}
          >
            {busy ? "…" : "Refresh"}
          </button>
        </div>
        </div>

      {error && (
        <div
          role={desktopConnectionsAvailable ? "alert" : "status"}
          className={desktopConnectionsAvailable ? "vault-error" : "vault-empty"}
        >
          {error}
        </div>
      )}

      {!error && presets.length === 0 && (
        <div className="vault-empty">
          No saved connections yet. Click <strong>+ Add</strong> to
          create one.
        </div>
      )}

      {presets.length > 0 && (
        <div className="connections-list" role="list">
          {presets.map((p) => (
            <ConnectionItem
              key={p.id}
              preset={p}
              onEdit={() => setEditing({ initial: p })}
              onDelete={() => setPendingDelete(p)}
            />
          ))}
        </div>
      )}

 {/* Add / edit modal — reuses the existing component the
          workspace-pill ConnectionPicker also mounts. */}
      <ConnectionEditor
        open={editing !== null}
        initial={editing?.initial}
        onSaved={async () => {
          setEditing(null);
          await refresh();
        }}
        onClose={() => setEditing(null)}
      />
      </div>

      {pendingDelete && (
        <div
          role="alertdialog"
          aria-modal="true"
          aria-label="Delete saved connection"
          aria-describedby="settings-connection-delete-confirmation-copy"
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
          <span id="settings-connection-delete-confirmation-copy">
            This removes the saved preset. Existing tabs using it stay live until you close them.
          </span>
          <span style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <button
              ref={deleteCancelRef}
              type="button"
              className="settings-pill"
              aria-label="Cancel delete connection"
              onClick={() => setPendingDelete(null)}
            >
              Cancel
            </button>
            <button
              ref={deleteConfirmRef}
              type="button"
              className="settings-pill settings-pill-danger"
              aria-label="Confirm delete saved connection"
              onClick={() => void handleDelete(pendingDelete)}
            >
              Delete
            </button>
          </span>
        </div>
      )}
    </div>
  );
}

function ConnectionItem({
  preset,
  onEdit,
  onDelete,
}: {
  preset: ConnectionPreset;
  onEdit: () => void;
  onDelete: () => void;
}): JSX.Element {
  const kind = preset.transport.kind;
  const target = describeTransport(preset.transport);
  const lastUsed = preset.lastUsedMs === 0
    ? "never"
    : new Date(preset.lastUsedMs).toLocaleString();
  return (
    <div className="connection-row" role="listitem" data-connection-id={preset.id}>
      <div className="connection-row-main">
        <span className="connection-label">{preset.label}</span>
        <span className="connection-target" title={target}>{target}</span>
      </div>
      <div className="connection-row-meta">
        <span className={`connection-kind connection-kind-${kind}`}>{kind}</span>
        <span className="connection-last-used">last used {lastUsed}</span>
        <button
          type="button"
          className="settings-pill"
          onClick={onEdit}
          title="Edit this connection"
        >
          Edit
        </button>
        <button
          type="button"
          className="settings-pill settings-pill-danger"
          onClick={onDelete}
          title="Delete this connection preset"
        >
          Delete
        </button>
      </div>
    </div>
  );
}

/**
 * Render a one-line description of the transport. Mirrors the format
 * used in ConnectionPicker's row meta line for consistency.
 */
function describeTransport(t: ConnectionPreset["transport"]): string {
  switch (t.kind) {
    case "local":
      return "local";
    case "wsl":
      return `wsl · ${t.distro}`;
    case "ssh":
      return `ssh · ${t.host}${t.port ? `:${t.port}` : ""}`;
    case "ws_direct":
    case "ws_tunnel":
      return `${t.kind} · ${t.url}`;
    case "tailscale":
      return `tailscale · ${t.tailnetHost}${t.port ? `:${t.port}` : ""}`;
    default:
      return JSON.stringify(t);
  }
}
