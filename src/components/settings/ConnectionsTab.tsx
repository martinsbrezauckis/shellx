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
import { useCallback, useEffect, useState, type JSX } from "react";
import { invoke } from "@tauri-apps/api/core";
import { inTauri } from "../../lib/tauri-bridge";
import type { ConnectionPreset } from "../ConnectionPicker";
import { ConnectionEditor } from "../ConnectionEditor";

export function ConnectionsTab(): JSX.Element {
  const [presets, setPresets] = useState<ConnectionPreset[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
 // Editor state: null = closed; {initial: undefined} = creating new;
 // {initial: preset} = editing existing.
  const [editing, setEditing] = useState<{ initial?: ConnectionPreset } | null>(null);

  const refresh = useCallback(async () => {
    if (!inTauri()) {
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
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const handleDelete = useCallback(async (preset: ConnectionPreset) => {
 // Simple confirm — connection presets are recoverable (re-add via
 // editor); typed-name gate would be overkill here.
    if (!window.confirm(
      `Delete connection "${preset.label}"? Existing tabs already ` +
      `connected via it stay live until you close them.`
    )) return;
    try {
      await invoke("connections_delete", { id: preset.id });
      await refresh();
    } catch (e) {
      setError(`Delete failed: ${e}`);
    }
  }, [refresh]);

  return (
    <div className="settings-tab-body">
      <div className="connections-header">
        <p className="settings-tab-hint">
          Saved transport presets used to launch a grok session. The
          same store is reachable from the connection pill in the
          composer footer — edits here are visible there.
        </p>
        <div style={{ display: "flex", gap: 8 }}>
          <button
            type="button"
            className="settings-pill"
            onClick={() => setEditing({ initial: undefined })}
            disabled={!inTauri()}
            title="Add a new connection preset"
          >
            + Add
          </button>
          <button
            type="button"
            className="settings-pill"
            onClick={() => void refresh()}
            disabled={busy}
          >
            {busy ? "…" : "Refresh"}
          </button>
        </div>
      </div>

      {error && <div role="alert" className="vault-error">{error}</div>}

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
              onDelete={() => void handleDelete(p)}
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
    <div className="connection-row" role="listitem">
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
      return `local${t.grokPath ? ` · ${t.grokPath}` : ""}`;
    case "wsl":
      return `wsl · ${t.distro}${t.grokPath ? ` · ${t.grokPath}` : ""}`;
    case "ssh":
      return `ssh · ${t.host}${t.port ? `:${t.port}` : ""}${
        t.remoteGrokPath ? ` · ${t.remoteGrokPath}` : ""
      }`;
    case "ws_direct":
    case "ws_tunnel":
      return `${t.kind} · ${t.url}`;
    case "tailscale":
      return `tailscale · ${t.tailnetHost}${t.port ? `:${t.port}` : ""}`;
    default:
      return JSON.stringify(t);
  }
}
