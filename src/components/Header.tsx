/**
 * src/components/Header.tsx — top header bar.
 * * Layout: brand · Find · spacer · live-pills · plugins · settings.
 * 64 px header height; type from --sans + --display tokens.
 */
import type { JSX } from "react";
import { FindPopover, type ChatHit } from "./FindPopover";
import {
  HeaderVaultRequestCenter,
  type HeaderVaultRequestCenterController,
} from "./HeaderVaultRequestCenter";
import { ShellIcon } from "./icons";
import type { ThemeMode } from "../lib/settings";
import type { OutsideConnectorInboxSummary } from "../lib/outside-connectors";
import type { VaultPanelIntent } from "../lib/vault-ui";

// brand-shellx.png is a tight crop of the source brand sheet — icon
// tile + "Shell X" wordmark, no subtitle. The tile/background blends
// into the header gradient (both near-black), so no transparent-PNG
// plumbing is needed. Module declaration lives in vite-env.d.ts.
import brandUrl from "../assets/brand-shellx.png?url";

export function Header({
  onOpenSettings,
  theme,
  onThemeToggle,
  onOpenPlugins,
  onOpenConnectorInbox,
  outsideConnectorInbox,
  vaultRequestCenter,
  vaultRequestCenterOpenSeq = 0,
  vaultRequestCenterCloseSeq = 0,
  debugClipboardFixture = null,
  onOpenVault,
  onOpenBrowser,
  onOpenTasks,
  taskAttentionCount = 0,
  onOpenChat,
  findCorpus,
  liveTabCount,
  liveGrokCount,
  onOpenAbout,
}: {
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
 /** Global approval requests from sessions, Browser, Vault, and future clients. */
  vaultRequestCenter?: HeaderVaultRequestCenterController;
  vaultRequestCenterOpenSeq?: number;
  vaultRequestCenterCloseSeq?: number;
  debugClipboardFixture?: "vault-password" | null;
 /** Opens the standalone ShellX Vault workspace. */
  onOpenVault?: (intent?: VaultPanelIntent) => void;
 /** Opens the ShellX-owned browser/runtime window. */
  onOpenBrowser?: () => void;
 /** Opens Task Manager. The badge is informational and never starts work. */
  onOpenTasks?: () => void;
 /** Bounded unresolved Task occurrences shown as 1..9+. */
  taskAttentionCount?: number;
 /** Click on the shellX brand logo opens the About modal
 * with GitHub link + report-bug shortcut. */
  onOpenAbout?: () => void;
 /** Find popover callback — navigates to a chat on selection. */
  onOpenChat?: (chatId: string) => void;
 /** Session-tab corpus for Find — each entry mirrors a live TabEntry. */
  findCorpus?: ChatHit[];
 /** Tabs with an active grok subprocess attached (hasActiveChild).
 * Rendered as a small badge; hidden when 0. */
  liveTabCount?: number;
 /** Running tasks with origin ∈ {grok, host_mcp} — main subprocess
 * plus any host-MCP subagents. Polled every 2 s in App.tsx. */
  liveGrokCount?: number;
}): JSX.Element {
  const showConnectorInbox = Boolean(
    onOpenConnectorInbox && outsideConnectorInbox?.shouldShowHeaderInbox,
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

      <div className="header-actions">
 {/* Token gauge and session artifacts live next to the chat title in App.tsx. */}
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
        {onOpenTasks && (
          <button
            type="button"
            className={`hdr-icon ${taskAttentionCount > 0 ? "attention" : ""}`}
            onClick={onOpenTasks}
            title={taskAttentionCount > 0
              ? `${taskAttentionCount} task occurrence${taskAttentionCount === 1 ? "" : "s"} need attention`
              : "Task Manager"}
            aria-label={taskAttentionCount > 0
              ? `Open Task Manager, ${taskAttentionCount} occurrence${taskAttentionCount === 1 ? "" : "s"} need attention`
              : "Open Task Manager"}
            data-debug-id="header-tasks"
            data-shellx-release-observe="focused title"
          >
            <ShellIcon name="clock" size={16} />
            {taskAttentionCount > 0 && (
              <span className="hdr-icon-badge" data-debug-id="header-tasks-attention">
                {taskAttentionCount > 9 ? "9+" : taskAttentionCount}
              </span>
            )}
          </button>
        )}
        {vaultRequestCenter && (
          <HeaderVaultRequestCenter
            controller={vaultRequestCenter}
            openSeq={vaultRequestCenterOpenSeq}
            closeSeq={vaultRequestCenterCloseSeq}
            debugClipboardFixture={debugClipboardFixture}
            onOpenVault={onOpenVault}
          />
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
            data-shellx-release-observe="pressed"
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
