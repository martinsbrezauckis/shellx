import { useCallback, useEffect, useRef, useState, type JSX, type MouseEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { inTauri } from "../lib/tauri-bridge";
import type { VaultRequestCenterAction, VaultRequestCenterItem } from "../lib/vault-request-center";
import type { VaultPanelIntent } from "../lib/vault-ui";
import { ShellIcon } from "./icons";
import { VaultPasswordGenerator } from "./VaultPasswordGenerator";

interface HeaderVaultStatus {
  mode?: string;
  unlocked?: boolean;
}

export interface HeaderVaultRequestCenterController {
  requests: VaultRequestCenterItem[];
  summaryText: string;
  onAction: (
    request: VaultRequestCenterItem,
    action: VaultRequestCenterAction,
    event?: MouseEvent<HTMLButtonElement>,
  ) => void;
}

export function HeaderVaultRequestCenter({
  controller,
  openSeq = 0,
  closeSeq = 0,
  debugClipboardFixture = null,
  onOpenVault,
}: {
  controller: HeaderVaultRequestCenterController;
  openSeq?: number;
  closeSeq?: number;
  debugClipboardFixture?: "vault-password" | null;
  onOpenVault?: (intent?: VaultPanelIntent) => void;
}): JSX.Element {
  const requests = controller.requests;
  const requestCountLabel =
    requests.length > 9 ? "9+" : requests.length > 0 ? String(requests.length) : "";
  const [open, setOpen] = useState(false);
  const [vaultPasswordGeneratorOpen, setVaultPasswordGeneratorOpen] = useState(false);
  const [vaultStatus, setVaultStatus] = useState<HeaderVaultStatus | null>(null);
  const ref = useRef<HTMLDivElement | null>(null);
  const vaultStateClass =
    vaultStatus?.unlocked === true ? "vault-open" : vaultStatus ? "vault-closed" : "vault-unknown";
  const vaultStateLabel =
    vaultStatus?.unlocked === true ? "Vault unlocked" : vaultStatus ? "Vault locked" : "Vault status unknown";

  const refreshVaultStatus = useCallback(async () => {
    try {
      setVaultStatus(await invoke<HeaderVaultStatus>("vault_status"));
    } catch {
      setVaultStatus(null);
    }
  }, []);

  useEffect(() => {
    if (openSeq > 0) setOpen(true);
  }, [openSeq]);

  useEffect(() => {
    if (closeSeq > 0) {
      setOpen(false);
      setVaultPasswordGeneratorOpen(false);
    }
  }, [closeSeq]);

  useEffect(() => {
    void refreshVaultStatus();
    const timer = window.setInterval(() => void refreshVaultStatus(), 10000);
    const onChanged = () => void refreshVaultStatus();
    window.addEventListener("shellx:vault-status-changed", onChanged);
    let disposed = false;
    let unlisten: UnlistenFn | null = null;
    if (inTauri()) {
      void listen("shellx:vault-status-invalidated", () => {
        void refreshVaultStatus();
      })
        .then((fn) => {
          if (disposed) {
            fn();
            return;
          }
          unlisten = fn;
        })
        .catch(() => {});
    }
    return () => {
      disposed = true;
      unlisten?.();
      window.clearInterval(timer);
      window.removeEventListener("shellx:vault-status-changed", onChanged);
    };
  }, [refreshVaultStatus]);

  useEffect(() => {
    if (open) void refreshVaultStatus();
  }, [open, refreshVaultStatus]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const node = ref.current;
      if (!node) return;
      if (event.target instanceof Node && node.contains(event.target)) return;
      setOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => window.removeEventListener("pointerdown", onPointerDown, true);
  }, [open]);

  return (
    <div className="hdr-vault-request-wrap" ref={ref}>
      <button
        type="button"
        className={`hdr-icon hdr-vault-request-icon ${vaultStateClass} ${requests.length > 0 ? "attention" : ""}`}
        onClick={() => {
          setOpen((current) => !current);
          setVaultPasswordGeneratorOpen(false);
        }}
        title={`${vaultStateLabel} · ${controller.summaryText}`}
        aria-label="Open requests"
        aria-expanded={open}
        aria-controls="vault-request-center-popover"
        data-debug-id="header-vault-request-center"
      >
        <ShellIcon name="lock" size={16} />
        <span className="hdr-vault-state-dot" aria-hidden="true" />
        {requestCountLabel && (
          <span className="hdr-icon-badge">{requestCountLabel}</span>
        )}
      </button>
      {open && (
        <div
          className="vault-request-popover"
          id="vault-request-center-popover"
          data-debug-id="vault-request-center-popover"
          role="region"
          aria-label="Requests"
        >
          <div className="vault-request-popover-head">
            <div>
              <div className="vault-request-popover-title">Requests</div>
              <div className="vault-request-popover-subtitle">
                {controller.summaryText}
              </div>
            </div>
            {onOpenVault && (
              <div className="vault-request-quick-actions" aria-label="Vault quick actions">
                <button
                  type="button"
                  className="vault-request-quick"
                  onClick={() => {
                    onOpenVault("overview");
                    setOpen(false);
                  }}
                  title="Open ShellX Vault"
                  data-debug-id="vault-request-open-vault"
                >
                  <ShellIcon name="lock" size={13} />
                  <span>Open</span>
                </button>
                <button
                  type="button"
                  className="vault-request-quick"
                  onClick={() => {
                    onOpenVault("newSecret");
                    setOpen(false);
                  }}
                  title="Add a Vault secret"
                  data-debug-id="vault-request-new-secret"
                >
                  <ShellIcon name="plus" size={13} />
                  <span>Secret</span>
                </button>
                <button
                  type="button"
                  className="vault-request-quick"
                  onClick={() => {
                    setVaultPasswordGeneratorOpen(true);
                  }}
                  title="Generate a password"
                  data-debug-id="vault-request-generate-password"
                >
                  <ShellIcon name="sparkles" size={13} />
                  <span>Generate</span>
                </button>
              </div>
            )}
          </div>
          {vaultPasswordGeneratorOpen ? (
            <VaultPasswordGenerator
              title="Password generator"
              debugFixture={debugClipboardFixture}
              onClose={() => setVaultPasswordGeneratorOpen(false)}
            />
          ) : requests.length === 0 ? (
            <div className="vault-request-empty">No pending requests.</div>
          ) : (
            <div className="vault-request-list">
              {requests.slice(0, 8).map((request) => (
                <article
                  key={request.id}
                  className={`vault-request-card tone-${request.tone}`}
                  data-debug-id="vault-request-center-item"
                  data-request-id={request.id}
                >
                  <div className="vault-request-card-head">
                    <span className="vault-request-source">{request.sourceLabel}</span>
                    <span className="vault-request-title">{request.title}</span>
                  </div>
                  <div className="vault-request-summary" title={request.summary}>
                    {request.summary}
                  </div>
                  {request.detailLines.length > 0 && (
                    <div className="vault-request-details">
                      {request.detailLines.slice(0, request.kind === "vaultAgentRequest" ? 6 : 3).map((line, index) => (
                        <div key={`${request.id}-detail-${index}`} title={line}>{line}</div>
                      ))}
                    </div>
                  )}
                  <div className="vault-request-actions">
                    {request.tertiaryAction && (
                      <button
                        type="button"
                        className="vault-request-action ghost"
                        data-debug-id={`vault-request-action-${request.tertiaryAction.kind}`}
                        onClick={(event) => {
                          controller.onAction(request, request.tertiaryAction!, event);
                          if (request.tertiaryAction!.kind === "focusSession") setOpen(false);
                        }}
                      >
                        {request.tertiaryAction.label}
                      </button>
                    )}
                    {request.secondaryAction && (
                      <button
                        type="button"
                        className="vault-request-action secondary"
                        data-debug-id={`vault-request-action-${request.secondaryAction.kind}`}
                        onClick={(event) => controller.onAction(request, request.secondaryAction!, event)}
                      >
                        {request.secondaryAction.label}
                      </button>
                    )}
                    <button
                      type="button"
                      className="vault-request-action primary"
                      data-debug-id={`vault-request-action-${request.primaryAction.kind}`}
                      onClick={(event) => {
                        controller.onAction(request, request.primaryAction, event);
                        if (request.primaryAction.kind === "openVault") setOpen(false);
                      }}
                    >
                      {request.primaryAction.label}
                    </button>
                  </div>
                </article>
              ))}
              {requests.length > 8 && (
                <div className="vault-request-overflow">
                  {requests.length - 8} more pending
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
