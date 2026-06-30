/**
 * src/components/Header.tsx — top header bar.
 * * Layout: brand · Find · spacer · autonomy chip · live-pills · plugins · settings.
 * 64 px header height; type from --sans + --display tokens.
 * * Autonomy chip maps UI label → grok --permission-mode value:
 * Confirm → default
 * Auto → bypassPermissions
 * * set_permission_mode is per-tab; the stored mode applies to the
 * NEXT session spawn — does not retroactively affect a running grok.
 */
import { useCallback, useEffect, useRef, useState, type JSX, type MouseEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { apiPostJson } from "../lib/debug-api";
import { FindPopover, type ChatHit } from "./FindPopover";
import { ShellIcon } from "./icons";
import { VaultPasswordGenerator } from "./VaultPasswordGenerator";
import { inTauri } from "../lib/tauri-bridge";
import type { ThemeMode } from "./Settings";
import type { OutsideConnectorInboxSummary } from "../lib/outside-connectors";
import type { VaultRequestCenterAction, VaultRequestCenterItem } from "../lib/vault-request-center";
import type { VaultPanelIntent } from "../lib/vault-ui";

// brand-shellx.png is a tight crop of the source brand sheet — icon
// tile + "Shell X" wordmark, no subtitle. The tile/background blends
// into the header gradient (both near-black), so no transparent-PNG
// plumbing is needed. Module declaration lives in vite-env.d.ts.
import brandUrl from "../assets/brand-shellx.png?url";

export type AutonomyMode = "plan" | "acceptEdits" | "default" | "bypassPermissions";

interface HeaderVaultStatus {
  mode?: string;
  unlocked?: boolean;
}

/**
 * Two-state autonomy chip. Only Confirm (`default`) and Auto
 * (`bypassPermissions`) emit grok-build flags; the legacy `plan` and
 * `acceptEdits` modes were silent no-ops and have been dropped. Those
 * legacy values are still accepted by the AutonomyMode type so existing
 * localStorage / connections.json entries can roundtrip — the setter
 * coerces them to "default" before sending.
 */
const AUTONOMY_OPTIONS: Array<{ label: string; mode: AutonomyMode; help: string }> = [
  { label: "Confirm", mode: "default", help: "Asks before every tool call" },
  { label: "Auto",    mode: "bypassPermissions", help: "Auto-approves everything (use with care)" },
];

export function Header({
  cwd,
  autonomy,
  totalTokens,
  maxTokens,
  onAutonomyChange,
  onWorkspaceClick,
  onOpenSettings,
  theme,
  onThemeToggle,
  onOpenPlugins,
  onOpenConnectorInbox,
  outsideConnectorInbox,
  vaultRequestCenter,
  vaultRequestCenterOpenSeq = 0,
  vaultRequestCenterCloseSeq = 0,
  onOpenVault,
  onOpenBrowser,
  onOpenChat,
  hideAutonomyDial,
  findCorpus,
  activeTabId,
  liveTabCount,
  liveGrokCount,
  onOpenAbout,
}: {
  cwd: string;
  autonomy: AutonomyMode;
  totalTokens: number;
  maxTokens: number;
  onAutonomyChange: (mode: AutonomyMode) => void;
  onWorkspaceClick: () => void;
  onOpenSettings?: () => void;
 /** Current ShellX chrome theme; used by the compact header toggle. */
  theme?: ThemeMode;
 /** Toggles between the default dark theme and the bright theme. */
  onThemeToggle?: () => void;
 /** Plugins icon opens the PluginsModal. */
  onOpenPlugins?: () => void;
 /** Connector inbox opens recent Telegram/Discord inbound events. */
  onOpenConnectorInbox?: () => void;
  outsideConnectorInbox?: OutsideConnectorInboxSummary;
 /** Global Vault requests from sessions, Browser, and future clients. */
  vaultRequestCenter?: {
    requests: VaultRequestCenterItem[];
    summaryText: string;
    onAction: (
      request: VaultRequestCenterItem,
      action: VaultRequestCenterAction,
      event?: MouseEvent<HTMLButtonElement>,
    ) => void;
  };
  vaultRequestCenterOpenSeq?: number;
  vaultRequestCenterCloseSeq?: number;
 /** Opens the standalone ShellX Vault workspace. */
  onOpenVault?: (intent?: VaultPanelIntent) => void;
 /** Opens the ShellX-owned browser/runtime window. */
  onOpenBrowser?: () => void;
 /** Click on the shellX brand logo opens the About modal
 * with GitHub link + report-bug shortcut. */
  onOpenAbout?: () => void;
 /** Find popover callback — navigates to a chat on selection. */
  onOpenChat?: (chatId: string) => void;
 /** Hide the in-header autonomy chip. The composer Action row carries
 * its own. Default false; App.tsx sets it true. */
  hideAutonomyDial?: boolean;
 /** Session-tab corpus for Find — each entry mirrors a live TabEntry. */
  findCorpus?: ChatHit[];
 /** Active tab; threaded into set_permission_mode so the registry
 * updates the right per-tab session. */
  activeTabId?: string | null;
 /** Tabs with an active grok subprocess attached (hasActiveChild).
 * Rendered as a small badge; hidden when 0. */
  liveTabCount?: number;
 /** Running tasks with origin ∈ {grok, host_mcp} — main subprocess
 * plus any host-MCP subagents. Polled every 2 s in App.tsx. */
  liveGrokCount?: number;
}): JSX.Element {
  const tokenPct = Math.min(100, (totalTokens / maxTokens) * 100);
  const showConnectorInbox = Boolean(
    onOpenConnectorInbox && outsideConnectorInbox?.shouldShowHeaderInbox,
  );
  const vaultRequests = vaultRequestCenter?.requests ?? [];
  const vaultRequestCountLabel =
    vaultRequests.length > 9 ? "9+" : vaultRequests.length > 0 ? String(vaultRequests.length) : "";
  const [vaultRequestsOpen, setVaultRequestsOpen] = useState(false);
  const [vaultPasswordGeneratorOpen, setVaultPasswordGeneratorOpen] = useState(false);
  const [vaultStatus, setVaultStatus] = useState<HeaderVaultStatus | null>(null);
  const vaultRequestRef = useRef<HTMLDivElement | null>(null);
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
    if (vaultRequestCenterOpenSeq > 0) {
      setVaultRequestsOpen(true);
    }
  }, [vaultRequestCenterOpenSeq]);

  useEffect(() => {
    if (vaultRequestCenterCloseSeq > 0) {
      setVaultRequestsOpen(false);
      setVaultPasswordGeneratorOpen(false);
    }
  }, [vaultRequestCenterCloseSeq]);

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
    if (vaultRequestsOpen) void refreshVaultStatus();
  }, [refreshVaultStatus, vaultRequestsOpen]);

  useEffect(() => {
    if (!vaultRequestsOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      const node = vaultRequestRef.current;
      if (!node) return;
      if (event.target instanceof Node && node.contains(event.target)) return;
      setVaultRequestsOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => window.removeEventListener("pointerdown", onPointerDown, true);
  }, [vaultRequestsOpen]);

  const setMode = useCallback(
    async (mode: AutonomyMode) => {
 // Update local state first so the UI stays responsive even if
 // Tauri invoke fails (browser preview, etc).
      onAutonomyChange(mode);
      try {
 // tabId routes the mode update into the right registry slot.
        await invoke("set_permission_mode", { mode, tabId: activeTabId ?? null });
      } catch (e) {
        console.warn("set_permission_mode failed:", e);
      }
 // Mirror to /autonomy so the debug API + cross-window observers
 // pick up the change. tabId here writes the SAME SessionRegistry
 // slot grok's terminal/create reads from. AGENT-B1: grok bakes
 // --always-approve into argv at spawn, so we can't flip mid-process.
 // The debug API returns appliesAfterReconnect:true when there's a
 // live child — surface a chat toast so the user knows the change
 // is pending until /abort + /connect.
      void apiPostJson<{ appliesAfterReconnect?: boolean }>("/autonomy", {
        mode,
        tabId: activeTabId ?? null,
      })
        .then((res) => {
          if (res?.appliesAfterReconnect) {
            try {
              window.dispatchEvent(
                new CustomEvent("shellx:autonomy-needs-reconnect", {
                  detail: { mode },
                }),
              );
            } catch { /* no-op */ }
          }
        })
        .catch(() => { /* debug API may be off */ });
    },
    [onAutonomyChange, activeTabId],
  );

  return (
    <header className="top">
      <button
        type="button"
        className="brand"
        onClick={() => onOpenAbout?.()}
        title="About shellX"
        aria-label="About shellX — version and source"
        style={{ background: "transparent", border: "none", cursor: "pointer", padding: 0 }}
      >
        <img src={brandUrl} alt="shellX" height={32} />
      </button>

 {/* CWD lives in the composer 📁 pill (per-tab); not duplicated
 * here. Find popover sits next to the brand. */}
      {onOpenChat && <FindPopover onOpenChat={onOpenChat} corpus={findCorpus} />}

      <div className="top-spacer" />

      <div className="dial-row">
        {!hideAutonomyDial && (
          <div className="dial" title="Autonomy mode">
            {AUTONOMY_OPTIONS.map((opt) => (
              <button
                key={opt.mode}
                type="button"
                className={`dial-opt ${autonomy === opt.mode ? "active" : ""}`}
                onClick={() => void setMode(opt.mode)}
                title={opt.help}
              >
                {opt.label}
              </button>
            ))}
          </div>
        )}
 {/* Token gauge lives next to the chat title (App.tsx
 * mid-head) so each tab shows its own usage. totalTokens /
 * maxTokens props are kept for back-compat but no longer
 * rendered here. SessionArtifactDownload also lives in the
 * mid-head — see App.tsx. */}
 {/* Live-tabs badge: open tabs with an active grok subprocess.
 * Hidden when 0. */}
        {typeof liveTabCount === "number" && liveTabCount > 0 && (
          <span
            className="hdr-live-badge"
            title={`${liveTabCount} session${liveTabCount === 1 ? "" : "s"} running`}
            aria-label={`${liveTabCount} live sessions`}
          >
            <span className="hdr-live-dot" />
            {liveTabCount} session{liveTabCount === 1 ? "" : "s"}
          </span>
        )}
 {/* Agent-working pill: running tasks with
 * origin ∈ {grok, host_mcp}. Hidden when 0. Reads as
 * "X tabs alive · Y agents busy" alongside the sessions pill. */}
        {typeof liveGrokCount === "number" && liveGrokCount > 0 && (
          <span
            className="hdr-live-badge hdr-grok-badge"
            title={`${liveGrokCount} agent${liveGrokCount === 1 ? "" : "s"} working (main + subagents)`}
            aria-label={`${liveGrokCount} agents working`}
          >
            <span className="hdr-live-dot grok-dot" />
            {liveGrokCount} working
          </span>
        )}
        {onOpenBrowser && (
          <button
            type="button"
            className="hdr-icon"
            onClick={onOpenBrowser}
            title="ShellX Browser"
            aria-label="Open ShellX Browser"
            data-debug-id="header-shellx-browser"
          >
            <ShellIcon name="browser-orbit" size={16} />
          </button>
        )}
        {vaultRequestCenter && (
          <div className="hdr-vault-request-wrap" ref={vaultRequestRef}>
            <button
              type="button"
              className={`hdr-icon hdr-vault-request-icon ${vaultStateClass} ${vaultRequests.length > 0 ? "attention" : ""}`}
              onClick={() => {
                setVaultRequestsOpen((open) => !open);
                setVaultPasswordGeneratorOpen(false);
              }}
              title={`${vaultStateLabel} · ${vaultRequestCenter.summaryText}`}
              aria-label="Open Vault Request Center"
              aria-expanded={vaultRequestsOpen}
              data-debug-id="header-vault-request-center"
            >
              <ShellIcon name="lock" size={16} />
              <span className="hdr-vault-state-dot" aria-hidden="true" />
              {vaultRequestCountLabel && (
                <span className="hdr-icon-badge">{vaultRequestCountLabel}</span>
              )}
            </button>
            {vaultRequestsOpen && (
              <div
                className="vault-request-popover"
                data-debug-id="vault-request-center-popover"
                role="dialog"
                aria-label="Vault Request Center"
              >
                <div className="vault-request-popover-head">
                  <div>
                    <div className="vault-request-popover-title">Vault Request Center</div>
                    <div className="vault-request-popover-subtitle">
                      {vaultRequestCenter.summaryText}
                    </div>
                  </div>
                  {onOpenVault && (
                    <div className="vault-request-quick-actions" aria-label="Vault quick actions">
                      <button
                        type="button"
                        className="vault-request-quick"
                        onClick={() => {
                          onOpenVault("overview");
                          setVaultRequestsOpen(false);
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
                          setVaultRequestsOpen(false);
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
                    onClose={() => setVaultPasswordGeneratorOpen(false)}
                  />
                ) : vaultRequests.length === 0 ? (
                  <div className="vault-request-empty">No pending Vault requests.</div>
                ) : (
                  <div className="vault-request-list">
                    {vaultRequests.slice(0, 8).map((request) => (
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
                            {request.detailLines.slice(0, 3).map((line, index) => (
                              <div key={`${request.id}-detail-${index}`}>{line}</div>
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
                                vaultRequestCenter.onAction(request, request.tertiaryAction!, event);
                                if (request.tertiaryAction!.kind === "focusSession") {
                                  setVaultRequestsOpen(false);
                                }
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
                              onClick={(event) => vaultRequestCenter.onAction(request, request.secondaryAction!, event)}
                            >
                              {request.secondaryAction.label}
                            </button>
                          )}
                          <button
                            type="button"
                            className="vault-request-action primary"
                            data-debug-id={`vault-request-action-${request.primaryAction.kind}`}
                            onClick={(event) => {
                              vaultRequestCenter.onAction(request, request.primaryAction, event);
                              if (request.primaryAction.kind === "openVault") {
                                setVaultRequestsOpen(false);
                              }
                            }}
                          >
                            {request.primaryAction.label}
                          </button>
                        </div>
                      </article>
                    ))}
                    {vaultRequests.length > 8 && (
                      <div className="vault-request-overflow">
                        {vaultRequests.length - 8} more pending
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
        {showConnectorInbox && outsideConnectorInbox && (
          <button
            type="button"
            className="hdr-icon hdr-inbox-icon"
            onClick={onOpenConnectorInbox}
            title={`${outsideConnectorInbox.label} · connector inbox`}
            aria-label="Open connector inbox"
          >
            <ShellIcon name="inbox" size={16} />
            {outsideConnectorInbox.badgeLabel && (
              <span className="hdr-icon-badge">{outsideConnectorInbox.badgeLabel}</span>
            )}
          </button>
        )}
 {/* Plugins icon — opens PluginsModal */}
        {onOpenPlugins && (
          <button
            type="button"
            className="hdr-icon"
            onClick={onOpenPlugins}
            title="Plugins · MCP servers and connectors"
            aria-label="Open plugins"
          >
            <ShellIcon name="plug" size={16} />
          </button>
        )}
        {onThemeToggle && (
          <button
            type="button"
            className={`hdr-icon hdr-theme-toggle ${theme === "bright" ? "active" : ""}`}
            onClick={onThemeToggle}
            title={theme === "bright" ? "Bright theme - click for dark" : "Dark theme - click for bright"}
            aria-label={theme === "bright" ? "Switch to dark theme" : "Switch to bright theme"}
            aria-pressed={theme === "bright"}
            data-debug-id="header-theme-toggle"
          >
            <ShellIcon name={theme === "bright" ? "sun" : "moon"} size={16} />
          </button>
        )}
        {onOpenSettings && (
          <button
            type="button"
            className="settings-cog"
            onClick={onOpenSettings}
            title="Settings (⌘,)"
            aria-label="Open settings"
          >
            <ShellIcon name="settings" size={16} />
          </button>
        )}
      </div>
    </header>
  );
}

// #366: shortCwd + formatTokens removed; CWD lives in the
// composer 📁 pill and per-tab token gauge is in mid-head, not here.
