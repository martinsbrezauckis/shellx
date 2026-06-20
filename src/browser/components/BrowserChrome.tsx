import type { DragEvent, FormEvent, JSX, MouseEvent } from "react";

import type { BrowserPageSecurityState, BrowserPersonalLockSettings, BrowserTab } from "../types";
import { ShellIcon } from "../../components/icons";

export type BrowserChromeHeaderMenuId = "history" | "save" | "ads" | "shields" | "downloads" | "vaultFill";

interface BrowserChromeProps {
  tabs: BrowserTab[];
  activeBrowserTab: BrowserTab | null;
  draggedTabId: string | null;
  tabLeases: Record<string, { leaseId: string; ownerAgentId: string; ownerRunId: string }>;
  busy: boolean;
  showRightSidebar: boolean;
  address: string;
  addressCopied: boolean;
  activeSecurityState: BrowserPageSecurityState;
  headerMenu: BrowserChromeHeaderMenuId | null;
  optionsOpen: boolean;
  bookmarkManagerOpen: boolean;
  canUseHistoryControls: boolean;
  canUseCurrentPage: boolean;
  transferIntentCount: number;
  activeTransferCount: number;
  vaultFillCount: number;
  headerProfileId: string;
  headerProfileDescription?: string | null;
  personalLock?: BrowserPersonalLockSettings | null;
  personalTabLocked: boolean;
  personalLockAttention: boolean;
  canHandOffActiveTab: boolean;
  canTakeBackActiveTab: boolean;
  chromeMenuPanel: JSX.Element | null;
  chromeMenuAlign: "align-left" | "align-right";
  browserProfileMarker: (profileId: string) => string;
  browserProfileShortLabel: (profileId: string) => string;
  browserTrustIcon: (security: BrowserPageSecurityState) => "lock" | "shield-alert" | "alert";
  browserTrustLabel: (security: BrowserPageSecurityState) => string;
  onSetDraggedTabId: (tabId: string | null) => void;
  onReorderTabs: (sourceTabId: string | null, targetTabId: string) => void;
  onFocusTab: (tab: BrowserTab) => void;
  onCloseTab: (tab: BrowserTab, event: MouseEvent<HTMLButtonElement>) => void;
  onNewTab: (profileId?: string) => void;
  onToggleLockActiveTab: () => void;
  onPersonalLockAction: (
    action: "lockNow" | "unlock",
    pin?: string,
    event?: MouseEvent<HTMLElement>,
  ) => void;
  onHandOffActiveTab: (event: MouseEvent<HTMLButtonElement>) => void;
  onTakeBackActiveTab: () => void;
  onShowRightSidebar: () => void;
  onSubmitAddress: (event: FormEvent<HTMLFormElement>) => void;
  onRunAction: (action: string) => void;
  onGoHome: () => void;
  onToggleHeaderMenu: (menu: BrowserChromeHeaderMenuId) => void;
  onSetAddressEditing: (editing: boolean) => void;
  onAddressChange: (address: string) => void;
  onCopyAddress: () => void;
  onBookmarkCurrent: () => void;
  onToggleBookmarksPanel: () => void;
  onToggleOptions: () => void;
}

export function BrowserChrome({
  tabs,
  activeBrowserTab,
  draggedTabId,
  tabLeases,
  busy,
  showRightSidebar,
  address,
  addressCopied,
  activeSecurityState,
  headerMenu,
  optionsOpen,
  bookmarkManagerOpen,
  canUseHistoryControls,
  canUseCurrentPage,
  transferIntentCount,
  activeTransferCount,
  vaultFillCount,
  headerProfileId,
  headerProfileDescription,
  personalLock,
  personalTabLocked,
  personalLockAttention,
  canHandOffActiveTab,
  canTakeBackActiveTab,
  chromeMenuPanel,
  chromeMenuAlign,
  browserProfileMarker,
  browserProfileShortLabel,
  browserTrustIcon,
  browserTrustLabel,
  onSetDraggedTabId,
  onReorderTabs,
  onFocusTab,
  onCloseTab,
  onNewTab,
  onToggleLockActiveTab,
  onPersonalLockAction,
  onHandOffActiveTab,
  onTakeBackActiveTab,
  onShowRightSidebar,
  onSubmitAddress,
  onRunAction,
  onGoHome,
  onToggleHeaderMenu,
  onSetAddressEditing,
  onAddressChange,
  onCopyAddress,
  onBookmarkCurrent,
  onToggleBookmarksPanel,
  onToggleOptions,
}: BrowserChromeProps): JSX.Element {
  const hasTransfers = transferIntentCount > 0;
  const hasVaultFillSuggestions = vaultFillCount > 0;
  const transferBadgeLabel = activeTransferCount > 0
    ? `${activeTransferCount} pending transfer${activeTransferCount === 1 ? "" : "s"}`
    : `${transferIntentCount} recorded transfer${transferIntentCount === 1 ? "" : "s"}`;
  const shieldsPanel = headerMenu === "shields" ? chromeMenuPanel : null;
  const dockedChromeMenuPanel = headerMenu === "shields" ? null : chromeMenuPanel;
  const personalLockEnabled = personalLock?.enabled === true;
  const personalLockLocked = personalLockEnabled && personalLock?.locked === true;
  const personalLockState = !personalLockEnabled ? "unconfigured" : personalLockLocked ? "locked" : "unlocked";

  return (
    <>
      <header className="shellx-browser-top">
        <div className="shellx-browser-tab-chrome">
          <div className="shellx-browser-brand">
            <ShellIcon name="browser-orbit" size={18} />
            <span>Agent</span>
          </div>
          <section className="shellx-browser-tab-strip" data-debug-id="shellx-browser-tab-strip">
            <div className="shellx-browser-tabs">
              {tabs.map((tab) => (
                <div
                  key={tab.browserTabId}
                  className={`shellx-browser-tab ${tab.browserTabId === activeBrowserTab?.browserTabId ? "active" : ""} ${draggedTabId === tab.browserTabId ? "dragging" : ""}`}
                  data-active={tab.browserTabId === activeBrowserTab?.browserTabId ? "true" : "false"}
                  title={tab.url ?? tab.browserTabId}
                  draggable={!busy}
                  onDragStart={(event: DragEvent<HTMLDivElement>) => {
                    onSetDraggedTabId(tab.browserTabId);
                    event.dataTransfer.effectAllowed = "move";
                    event.dataTransfer.setData("text/plain", tab.browserTabId);
                  }}
                  onDragOver={(event) => {
                    event.preventDefault();
                    event.dataTransfer.dropEffect = "move";
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    onReorderTabs(draggedTabId || event.dataTransfer.getData("text/plain"), tab.browserTabId);
                  }}
                  onDragEnd={() => onSetDraggedTabId(null)}
                >
                  <button
                    type="button"
                    className="shellx-browser-tab-main"
                    onClick={() => onFocusTab(tab)}
                    data-debug-id={`shellx-browser-tab-${tab.browserTabId}`}
                  >
                    <span>{tab.title || tab.url || "Blank tab"}</span>
                    <small>
                      <b className="shellx-browser-tab-profile-marker">{browserProfileMarker(tab.profileId)}</b>
                      {browserProfileShortLabel(tab.profileId)}
                      {tab.ownerKind === "delegatedToAgent" ? " · delegated" : tab.ownerKind === "agent" ? " · agent" : ""}
                      {tab.lock ? " · locked" : ""}
                    </small>
                  </button>
                  <button
                    type="button"
                    className="shellx-browser-tab-close"
                    onClick={(event) => onCloseTab(tab, event)}
                    disabled={busy || Boolean(tab.lock && !tabLeases[tab.browserTabId])}
                    data-debug-id={`shellx-browser-close-tab-${tab.browserTabId}`}
                    title="Close tab"
                    aria-label={`Close ${tab.title || tab.url || "tab"}`}
                  >
                    <ShellIcon name="close" size={12} />
                  </button>
                </div>
              ))}
              {tabs.length === 0 && <div className="shellx-browser-tab-empty">No tabs</div>}
            </div>
            <div className="shellx-browser-tab-actions">
              <button
                type="button"
                className="shellx-browser-icon-btn"
                onClick={() => onNewTab()}
                disabled={busy}
                data-debug-id="shellx-browser-new-tab"
                title="New tab"
              >
                <ShellIcon name="plus" size={15} />
              </button>
              <button
                type="button"
                className="shellx-browser-icon-btn"
                onClick={() => onNewTab("task-disposable")}
                disabled={busy}
                data-debug-id="shellx-browser-new-disposable-tab"
                title="New disposable tab"
              >
                <ShellIcon name="circle-x" size={15} />
              </button>
              <button
                type="button"
                className="shellx-browser-icon-btn"
                onClick={onToggleLockActiveTab}
                disabled={!activeBrowserTab || busy}
                data-debug-id="shellx-browser-lock-tab"
                title={activeBrowserTab?.lock ? "Unlock tab for this agent" : "Lock tab for this agent"}
              >
                <ShellIcon name={activeBrowserTab?.lock ? "lock" : "shield-alert"} size={15} />
              </button>
              <button
                type="button"
                className={`shellx-browser-icon-btn shellx-browser-personal-lock-btn ${personalLockState} ${personalLockLocked || optionsOpen ? "active" : ""} ${personalLockAttention ? "attention" : ""}`}
                onClick={(event) => {
                  if (!personalLockEnabled) {
                    onToggleOptions();
                    return;
                  }
                  onPersonalLockAction(personalLockLocked ? "unlock" : "lockNow", undefined, event);
                }}
                disabled={personalLockEnabled && busy && !personalLockLocked}
                data-debug-id="shellx-browser-personal-lock-toggle"
                data-lock-state={personalLockState}
                title={!personalLockEnabled ? "Set up Personal Browser Lock" : personalLockLocked ? "Unlock personal tabs" : "Lock personal tabs now"}
                aria-label={!personalLockEnabled ? "Set up Personal Browser Lock" : personalLockLocked ? "Unlock personal tabs" : "Lock personal tabs now"}
              >
                <ShellIcon name="lock" size={15} />
              </button>
              {canHandOffActiveTab && (
                <button
                  type="button"
                  className="shellx-browser-icon-btn"
                  onClick={onHandOffActiveTab}
                  disabled={busy}
                  data-debug-id="shellx-browser-handoff-tab"
                  title="Hand off this tab to the active agent task"
                >
                  <ShellIcon name="play" size={15} />
                </button>
              )}
              {canTakeBackActiveTab && (
                <button
                  type="button"
                  className="shellx-browser-icon-btn active"
                  onClick={onTakeBackActiveTab}
                  disabled={busy}
                  data-debug-id="shellx-browser-take-back-tab"
                  title="Take back this tab from the agent"
                >
                  <ShellIcon name="user" size={15} />
                </button>
              )}
              {!showRightSidebar && (
                <button
                  type="button"
                  className="shellx-browser-icon-btn"
                  onClick={onShowRightSidebar}
                  data-debug-id="shellx-browser-show-right-sidebar-button"
                  title="Show right panel"
                >
                  <ShellIcon name="chevrons-left" size={15} />
                </button>
              )}
            </div>
          </section>
        </div>
        <form className="shellx-browser-address-row" onSubmit={onSubmitAddress}>
          <button
            type="button"
            className="shellx-browser-icon-btn"
            onClick={() => onRunAction("goBack")}
            disabled={!canUseHistoryControls || busy}
            data-debug-id="shellx-browser-back"
            title="Back"
          >
            <ShellIcon name="chevron-left" size={15} />
          </button>
          <button
            type="button"
            className="shellx-browser-icon-btn"
            onClick={() => onRunAction("goForward")}
            disabled={!canUseHistoryControls || busy}
            data-debug-id="shellx-browser-forward"
            title="Forward"
          >
            <ShellIcon name="chevron-right" size={15} />
          </button>
          <button
            type="button"
            className="shellx-browser-icon-btn"
            onClick={() => onRunAction("reload")}
            disabled={!canUseHistoryControls || busy}
            data-debug-id="shellx-browser-reload"
            title="Reload"
          >
            <ShellIcon name="refresh" size={15} />
          </button>
          <button
            type="button"
            className="shellx-browser-icon-btn"
            onClick={onGoHome}
            disabled={busy}
            data-debug-id="shellx-browser-home"
            title="Home"
          >
            <ShellIcon name="home" size={15} />
          </button>
          <div className="shellx-browser-address-shell">
            <div className="shellx-browser-shields-wrap">
              <button
                type="button"
                className={`shellx-browser-trust-chip ${activeSecurityState.level}`}
                onClick={() => onToggleHeaderMenu("shields")}
                data-debug-id="shellx-browser-trust-chip"
                data-security-level={activeSecurityState.level}
                aria-expanded={headerMenu === "shields"}
                title={activeSecurityState.summary}
              >
                <ShellIcon name={browserTrustIcon(activeSecurityState)} size={12} />
                <span>{browserTrustLabel(activeSecurityState)}</span>
              </button>
              {shieldsPanel}
            </div>
            <input
              value={address}
              onFocus={() => onSetAddressEditing(true)}
              onBlur={() => onSetAddressEditing(false)}
              onChange={(event) => onAddressChange(event.target.value)}
              placeholder="https://example.com"
              data-debug-id="shellx-browser-address"
              aria-label="Browser address"
            />
            <button
              type="button"
              className="shellx-browser-address-copy"
              onClick={onCopyAddress}
              disabled={!canUseCurrentPage}
              data-debug-id="shellx-browser-copy-address"
              title="Copy address"
            >
              <ShellIcon name={addressCopied ? "check" : "copy"} size={13} />
            </button>
            <span
              className="shellx-browser-profile-marker"
              data-debug-id="shellx-browser-profile-marker"
              title={headerProfileDescription ?? browserProfileShortLabel(headerProfileId)}
            >
              {browserProfileMarker(headerProfileId)}
            </span>
          </div>
          <div className="shellx-browser-address-actions">
            <button
              type="button"
              className="shellx-browser-icon-btn"
              onClick={onBookmarkCurrent}
              disabled={busy || !canUseCurrentPage}
              data-debug-id="shellx-browser-bookmark-current"
              title="Bookmark current page"
            >
              <ShellIcon name="star" size={15} />
            </button>
            <div className="shellx-browser-header-menu-wrap">
              <button
                type="button"
                className={`shellx-browser-icon-btn shellx-browser-vault-fill-status ${hasVaultFillSuggestions ? "available" : ""}`}
                onClick={() => onToggleHeaderMenu("vaultFill")}
                disabled={busy || !canUseCurrentPage || !hasVaultFillSuggestions}
                data-debug-id="shellx-browser-vault-fill-menu"
                aria-expanded={headerMenu === "vaultFill"}
                title={hasVaultFillSuggestions ? `${vaultFillCount} Vault fill suggestion${vaultFillCount === 1 ? "" : "s"}` : "No matching Vault fill"}
              >
                <ShellIcon name="lock" size={15} />
                {hasVaultFillSuggestions && (
                  <span className="shellx-browser-vault-fill-badge" data-debug-id="shellx-browser-vault-fill-badge">
                    {vaultFillCount > 9 ? "9+" : vaultFillCount}
                  </span>
                )}
              </button>
            </div>
            <div className="shellx-browser-header-menu-wrap">
              <button
                type="button"
                className={`shellx-browser-icon-btn shellx-browser-download-icon-status ${activeTransferCount > 0 ? "pending" : hasTransfers ? "done" : ""}`}
                onClick={() => onToggleHeaderMenu("downloads")}
                data-debug-id="shellx-browser-downloads-menu"
                aria-expanded={headerMenu === "downloads"}
                title={hasTransfers ? `Downloads: ${transferBadgeLabel}` : "Downloads"}
              >
                <ShellIcon name="download" size={15} />
                {hasTransfers && (
                  <span className="shellx-browser-download-badge" data-debug-id="shellx-browser-downloads-badge">
                    {activeTransferCount > 0 ? activeTransferCount : transferIntentCount}
                  </span>
                )}
              </button>
            </div>
            <div className="shellx-browser-header-menu-wrap">
              <button
                type="button"
                className="shellx-browser-icon-btn"
                onClick={onToggleBookmarksPanel}
                data-debug-id="shellx-browser-bookmarks-menu"
                aria-expanded={bookmarkManagerOpen}
                title="Bookmarks"
              >
                <ShellIcon name="bookmark" size={15} />
              </button>
            </div>
            <div className="shellx-browser-header-menu-wrap">
              <button
                type="button"
                className="shellx-browser-icon-btn"
                onClick={() => onToggleHeaderMenu("history")}
                data-debug-id="shellx-browser-history-menu"
                aria-expanded={headerMenu === "history"}
                title="History"
              >
                <ShellIcon name="history" size={15} />
              </button>
            </div>
            <div className="shellx-browser-header-menu-wrap">
              <button
                type="button"
                className="shellx-browser-icon-btn"
                onClick={() => onToggleHeaderMenu("save")}
                data-debug-id="shellx-browser-save-page"
                aria-expanded={headerMenu === "save"}
                title="Save page"
              >
                <ShellIcon name="file" size={15} />
              </button>
            </div>
            <div className="shellx-browser-header-menu-wrap">
              <button
                type="button"
                className="shellx-browser-icon-btn"
                onClick={() => onToggleHeaderMenu("ads")}
                data-debug-id="shellx-browser-ad-filter"
                aria-expanded={headerMenu === "ads"}
                title="Ads filter"
              >
                <ShellIcon name="ban" size={15} />
              </button>
            </div>
            <div className="shellx-browser-options-wrap">
              <button
                type="button"
                className="shellx-browser-icon-btn"
                onClick={onToggleOptions}
                data-debug-id="shellx-browser-options"
                aria-expanded={optionsOpen}
                title="Browser options"
              >
                <ShellIcon name="settings" size={15} />
              </button>
            </div>
          </div>
        </form>
      </header>

      {dockedChromeMenuPanel && (
        <section className={`shellx-browser-chrome-menu-dock ${chromeMenuAlign}`} data-debug-id="shellx-browser-chrome-menu-dock">
          {dockedChromeMenuPanel}
        </section>
      )}
    </>
  );
}
