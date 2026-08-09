/**
 * Settings -> Desktop.
 *
 * Host OS integration toggles that make shellX reachable from the normal
 * desktop workflow. "Send files to shellX" installs HKCU-only context menu
 * entries plus a SendTo shortcut; no admin rights required.
 */
import { useCallback, useEffect, useState, type JSX } from "react";
import { invoke } from "@tauri-apps/api/core";
import { inTauri } from "../../lib/tauri-bridge";
import { ShellIcon } from "../icons";

interface DesktopIntegrationStatus {
  supported: boolean;
  os: string;
  explorerContextMenuInstalled: boolean;
  sendToShortcutInstalled: boolean;
  message: string;
}

const DEFAULT_STATUS: DesktopIntegrationStatus = {
  supported: false,
  os: "unknown",
  explorerContextMenuInstalled: false,
  sendToShortcutInstalled: false,
  message: "Desktop integration status has not been checked yet.",
};

export function DesktopTab(): JSX.Element {
  const [status, setStatus] = useState<DesktopIntegrationStatus>(DEFAULT_STATUS);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [manualRefreshReceipt, setManualRefreshReceipt] = useState({ sequence: 0, completedAtMs: 0 });

  const refresh = useCallback(async (manual = false) => {
    if (!inTauri()) {
      setStatus({
        ...DEFAULT_STATUS,
        message: "Desktop integrations require the shellX desktop app.",
      });
      return;
    }
    setBusy(true);
    try {
      setStatus(await invoke<DesktopIntegrationStatus>("desktop_integration_status"));
      setError(null);
      if (manual) {
        setManualRefreshReceipt((current) => ({
          sequence: current.sequence + 1,
          completedAtMs: Date.now(),
        }));
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => { void refresh(false); }, [refresh]);

  const install = useCallback(async () => {
    if (!inTauri()) return;
    setBusy(true);
    try {
      setStatus(await invoke<DesktopIntegrationStatus>("desktop_integration_install_windows_context_menu"));
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  const remove = useCallback(async () => {
    if (!inTauri()) return;
    setBusy(true);
    try {
      setStatus(await invoke<DesktopIntegrationStatus>("desktop_integration_remove_windows_context_menu"));
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  const installed = status.explorerContextMenuInstalled || status.sendToShortcutInstalled;

  return (
    <div className="settings-tab-body">
      <p className="settings-tab-hint">
        Send files to shellX lets selected files enter the active shellX composer
        as attachments, using the same classifier as drag, paste, and Attach.
      </p>

      <div className="settings-row">
        <label className="settings-label">Send files to shellX</label>
        <span
          className="settings-suffix"
          data-desktop-integration-status={installed ? "installed" : "absent"}
          data-shellx-release-observe="title"
          title={`Desktop integration state: supported=${status.supported ? "yes" : "no"}; os=${status.os}; installed=${installed ? "yes" : "no"}`}
        >
          <ShellIcon
            name={installed ? "check" : status.supported ? "circle" : "ban"}
            size={13}
          />
          {status.message}
        </span>
        <div style={{ display: "flex", gap: 8 }}>
          <button data-debug-id="surface-components-settings-desktoptab-1"
            data-desktop-integration-action="refresh"
            data-shellx-release-observe="disabled title"
            title={`Refresh desktop integration status; sequence=${manualRefreshReceipt.sequence}; completedAtMs=${manualRefreshReceipt.completedAtMs}`}
            type="button"
            className="settings-pill"
            onClick={() => void refresh(true)}
            disabled={busy || !inTauri()}
          >
            {busy ? "…" : "Refresh"}
          </button>
          {status.supported && (installed ? (
            <button
              data-desktop-integration-action="remove"
              type="button"
              className="settings-pill settings-pill-danger"
              onClick={() => void remove()}
              disabled={busy || !status.supported}
            >
              Remove
            </button>
          ) : (
            <button
              data-desktop-integration-action="install"
              type="button"
              className="settings-pill"
              onClick={() => void install()}
              disabled={busy || !status.supported}
            >
              Install
            </button>
          ))}
        </div>
      </div>

      <div className="settings-row">
        <label className="settings-label">Installed parts</label>
        <div className="settings-pills">
          <span
            className={`settings-pill ${status.explorerContextMenuInstalled ? "active" : ""}`}
            data-desktop-integration-part="explorer-context-menu"
          >
            Context menu
          </span>
          <span
            className={`settings-pill ${status.sendToShortcutInstalled ? "active" : ""}`}
            data-desktop-integration-part="send-to-shortcut"
          >
            SendTo shortcut
          </span>
        </div>
        <span className="settings-readonly" data-desktop-integration-os={status.os}>{status.os}</span>
      </div>

      {error && <div role="alert" className="vault-error">{error}</div>}
    </div>
  );
}
