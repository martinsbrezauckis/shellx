import { useCallback, useEffect, useRef, useState, type JSX, type MouseEvent, type PointerEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import { VaultTab } from "./settings/VaultTab";
import { ShellIcon } from "./icons";
import { inTauri } from "../lib/tauri-bridge";
import type { VaultPanelIntent } from "../lib/vault-ui";
import { useModalFocus } from "../lib/useModalFocus";

interface VaultStatus {
  mode?: "unconfigured" | "legacyLimited" | "local" | "external";
  unlocked?: boolean;
  recoveryConfirmed?: boolean;
}

export function VaultPanel({
  open,
  intent = "overview",
  intentSeq = 0,
  onClose,
}: {
  open: boolean;
  intent?: VaultPanelIntent;
  intentSeq?: number;
  onClose: () => void;
}): JSX.Element | null {
  const backdropPointerStartedOnBackdrop = useRef(false);
  const dialogRef = useRef<HTMLElement | null>(null);
  const [status, setStatus] = useState<VaultStatus | null>(null);
  const [statusSeq, setStatusSeq] = useState(0);
  const [passphrase, setPassphrase] = useState("");
  const [unlocking, setUnlocking] = useState(false);
  const [locking, setLocking] = useState(false);
  const [unlockError, setUnlockError] = useState("");
  useModalFocus(open, dialogRef, onClose);

  const refreshStatus = useCallback(async () => {
    try {
      const next = await invoke<VaultStatus>("vault_status");
      setStatus(next);
      setStatusSeq((seq) => seq + 1);
      window.dispatchEvent(new CustomEvent("shellx:vault-status-changed"));
    } catch {
      setStatus(null);
    }
  }, []);

  const handleStatusChange = useCallback((next: VaultStatus) => {
    setStatus(next);
    window.dispatchEvent(new CustomEvent("shellx:vault-status-changed"));
  }, []);

  useEffect(() => {
    if (!open) return;
    void refreshStatus();
  }, [open, refreshStatus]);

  useEffect(() => {
    if (!open || !inTauri()) return;
    let disposed = false;
    let unlisten: UnlistenFn | null = null;
    void listen("shellx:vault-status-invalidated", () => {
      void refreshStatus();
    })
      .then((fn) => {
        if (disposed) {
          fn();
          return;
        }
        unlisten = fn;
      })
      .catch(() => {});
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [open, refreshStatus]);

  if (!open) return null;

  const vaultLocked = status?.unlocked !== true;
  const canQuickUnlock =
    vaultLocked &&
    status?.recoveryConfirmed === true &&
    passphrase.trim().length > 0 &&
    !unlocking;

  async function quickUnlock(): Promise<void> {
    if (!canQuickUnlock) return;
    setUnlocking(true);
    setUnlockError("");
    try {
      await invoke("shellx_vault_unlock", {
        request: {
          passphrase,
          keyfileJson: null,
          rememberDevice: false,
        },
      });
      setPassphrase("");
      await refreshStatus();
    } catch (error) {
      setUnlockError(error instanceof Error ? error.message : String(error));
    } finally {
      setUnlocking(false);
    }
  }

  async function lockVault(): Promise<void> {
    if (vaultLocked || locking) return;
    setLocking(true);
    setUnlockError("");
    try {
      await invoke("shellx_vault_lock");
      setPassphrase("");
      await refreshStatus();
    } catch (error) {
      setUnlockError(error instanceof Error ? error.message : String(error));
    } finally {
      setLocking(false);
    }
  }

  function handleBackdropPointerDown(event: PointerEvent<HTMLDivElement>): void {
    backdropPointerStartedOnBackdrop.current = event.target === event.currentTarget;
  }

  function handleBackdropClick(event: MouseEvent<HTMLDivElement>): void {
    const startedOnBackdrop = backdropPointerStartedOnBackdrop.current;
    backdropPointerStartedOnBackdrop.current = false;
    if (event.target !== event.currentTarget || !startedOnBackdrop) return;
    onClose();
  }

  return (
    <div data-debug-id="surface-components-vaultpanel-1"
      className="modal-backdrop vault-workspace-backdrop"
      onPointerDownCapture={handleBackdropPointerDown}
      onClick={handleBackdropClick}
    >
      <section
        ref={dialogRef}
        className="modal vault-modal vault-workspace-modal"
        data-debug-id="vault-workspace-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="vault-workspace-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="vault-workspace-titlebar">
          <div className="vault-workspace-title">
            <ShellIcon name="lock" size={16} />
            <div>
              <h2 id="vault-workspace-title">ShellX Vault</h2>
              <p>Secrets, profile cards, agent wallets, and approvals.</p>
            </div>
          </div>
          <div className="vault-workspace-statusbar">
            <span
              className={`vault-workspace-status ${status?.unlocked ? "unlocked" : "locked"}`}
              data-debug-id="vault-workspace-lock-status"
              title={status?.mode ?? "Vault status"}
            >
              {status?.unlocked ? "unlocked" : "locked"}
            </span>
            {status?.unlocked === true && (
              <button
                type="button"
                className="settings-pill vault-workspace-lock-button"
                data-debug-id="vault-workspace-lock"
                onClick={() => void lockVault()}
                disabled={locking}
                title="Lock Vault on this device"
              >
                <ShellIcon name="lock" size={13} />
                <span>{locking ? "Locking..." : "Lock"}</span>
              </button>
            )}
            {vaultLocked && status?.recoveryConfirmed === true && (
              <form
                className="vault-workspace-unlock"
                data-debug-id="vault-workspace-quick-unlock"
                onSubmit={(event) => {
                  event.preventDefault();
                  void quickUnlock();
                }}
              >
                <input
                  className="settings-input"
                  type="password"
                  value={passphrase}
                  onChange={(event) => setPassphrase(event.currentTarget.value)}
                  placeholder="Master passphrase"
                  autoComplete="current-password"
              aria-label="Vault master passphrase"
              data-shellx-release-observe="nonempty"
                />
                <button data-debug-id="surface-components-vaultpanel-5"
                  type="submit"
                  className={`settings-pill ${canQuickUnlock ? "active" : ""}`}
                  disabled={!canQuickUnlock}
                >
                  {unlocking ? "Unlocking..." : "Unlock"}
                </button>
              </form>
            )}
            {unlockError && <span className="vault-workspace-unlock-error">{unlockError}</span>}
          </div>
          <button
            type="button"
            className="settings-close"
            onClick={onClose}
            aria-label="Close"
            title="Close Vault"
          >
            <ShellIcon name="close" size={14} />
          </button>
        </div>
        <div className="vault-workspace-body">
          <VaultTab
            intent={intent}
            intentSeq={intentSeq}
            externalStatus={status}
            statusRefreshSeq={statusSeq}
            onStatusChange={handleStatusChange}
          />
        </div>
      </section>
    </div>
  );
}
