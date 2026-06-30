import type { ChangeEvent, JSX, MouseEvent } from "react";

import { ShellIcon, type ShellIconName } from "../../components/icons";
import type {
  BrowserPersonalLockAuthMode,
  BrowserPersonalLockSettings,
  BrowserProfile,
  BrowserVisibleAdMode,
} from "../types";

export type BrowserColorMode = "system" | "light" | "dark";
export type BrowserEngineAutomationMode = "normal" | "backgroundOnly";
export type BrowserPageSaveKind =
  | "explain"
  | "screenshot"
  | "fullPageScreenshot"
  | "markdown"
  | "linksJson"
  | "snapshotJson"
  | "media"
  | "code"
  | "site";

interface BrowserOptionsMenuProps {
  colorMode: BrowserColorMode;
  homeUrl: string;
  profileId: string;
  profiles: BrowserProfile[];
  engineMode: BrowserEngineAutomationMode;
  configuredParallelAgents: string;
  showRightSidebar: boolean;
  personalLock?: BrowserPersonalLockSettings | null;
  personalLockPinDraft: string;
  profileLabel: (profile: BrowserProfile) => string;
  onColorModeChange: (mode: BrowserColorMode) => void;
  onHomeUrlChange: (url: string) => void;
  onProfileChange: (profileId: string) => void;
  onEngineModeChange: (mode: BrowserEngineAutomationMode) => void;
  onParallelAgentsChange: (configuredParallelAgents: string) => void;
  onShowRightSidebarChange: (show: boolean) => void;
  onPersonalLockPatch: (patch: {
    enabled?: boolean;
    timeoutMinutes?: number;
    authMode?: BrowserPersonalLockAuthMode;
    blurLockedTabs?: boolean;
    pauseDelegatedTabsWhenLocked?: boolean;
    lockOnSleep?: boolean;
    lockOnMinimize?: boolean;
    newPin?: string;
  }, event?: ChangeEvent<HTMLElement> | MouseEvent<HTMLElement>) => void;
  onPersonalLockAction: (
    action: "lockNow" | "unlock",
    pin?: string,
    event?: MouseEvent<HTMLElement>,
  ) => void;
  onPersonalLockPinDraftChange: (value: string) => void;
  onClose: () => void;
}

export function BrowserOptionsMenu({
  colorMode,
  homeUrl,
  profileId,
  profiles,
  engineMode,
  configuredParallelAgents,
  showRightSidebar,
  personalLock,
  personalLockPinDraft,
  profileLabel,
  onColorModeChange,
  onHomeUrlChange,
  onProfileChange,
  onEngineModeChange,
  onParallelAgentsChange,
  onShowRightSidebarChange,
  onPersonalLockPatch,
  onPersonalLockAction,
  onPersonalLockPinDraftChange,
  onClose,
}: BrowserOptionsMenuProps): JSX.Element {
  const lockEnabled = personalLock?.enabled === true;
  const lockActive = personalLock?.locked === true;
  const pinMode = personalLock?.authMode === "pinOnly";
  return (
    <aside className="shellx-browser-left-sidecar shellx-browser-options-sidecar" data-debug-id="shellx-browser-options-sidecar">
      <div className="shellx-browser-options-head">
        <h2>Browser settings</h2>
        <button type="button" className="shellx-browser-icon-btn" onClick={onClose} data-debug-id="shellx-browser-options-close" title="Close Browser settings">
          <ShellIcon name="circle-x" size={15} />
        </button>
      </div>
      <div className="shellx-browser-options-body">
        <section className="shellx-browser-options-section">
          <h3>Appearance</h3>
          <label>
            <span>Color mode</span>
            <select
              value={colorMode}
              onChange={(event) => onColorModeChange(event.target.value as BrowserColorMode)}
              data-debug-id="shellx-browser-color-mode"
            >
              <option value="system">System</option>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </select>
          </label>
        </section>

        <section className="shellx-browser-options-section">
          <h3>Homepage</h3>
          <label className="shellx-browser-home-setting">
            <span>Homepage</span>
            <input
              type="url"
              value={homeUrl}
              onChange={(event) => onHomeUrlChange(event.target.value)}
              data-debug-id="shellx-browser-homepage"
              aria-label="Browser homepage"
            />
          </label>
        </section>

        <section className="shellx-browser-options-section">
          <h3>Profile</h3>
          <label>
            <span>Default profile</span>
            <select
              value={profileId}
              onChange={(event) => onProfileChange(event.target.value)}
              data-debug-id="shellx-browser-profile-select"
              aria-label="Browser profile"
            >
              {profiles.map((profile) => (
                <option key={profile.profileId} value={profile.profileId}>
                  {profileLabel(profile)}
                </option>
              ))}
            </select>
          </label>
        </section>

        <section className="shellx-browser-options-section">
          <h3>Panels</h3>
          <label>
            <input
              type="checkbox"
              checked={showRightSidebar}
              onChange={(event) => onShowRightSidebarChange(event.target.checked)}
              data-debug-id="shellx-browser-toggle-right-sidebar"
            />
            <span>Right sidebar</span>
          </label>
        </section>

        <section className="shellx-browser-options-section">
          <h3>Personal Browser Lock</h3>
          <div className="shellx-browser-personal-lock-status" data-debug-id="shellx-browser-personal-lock-status">
            <span>{!lockEnabled ? "Off" : lockActive ? "Locked" : "Unlocked"}</span>
            <button
              type="button"
              className={`settings-pill ${lockEnabled && !lockActive ? "active" : ""}`}
              onClick={(event) => {
                if (!lockEnabled) {
                  onPersonalLockPatch({ enabled: true }, event);
                } else {
                  onPersonalLockAction(lockActive ? "unlock" : "lockNow", personalLockPinDraft, event);
                }
              }}
              disabled={lockEnabled && pinMode && lockActive && personalLock?.pinConfigured && !personalLockPinDraft.trim()}
              data-debug-id={!lockEnabled ? "shellx-browser-personal-enable-now" : lockActive ? "shellx-browser-personal-unlock-now" : "shellx-browser-personal-lock-now"}
            >
              {!lockEnabled ? "Enable" : lockActive ? "Unlock" : "Lock now"}
            </button>
          </div>
          <label>
            <input
              type="checkbox"
              checked={lockEnabled}
              onChange={(event) => onPersonalLockPatch({ enabled: event.target.checked }, event)}
              data-debug-id="shellx-browser-personal-lock-enabled"
            />
            <span>Lock personal tabs after inactivity</span>
          </label>
          <label>
            <span>Timeout</span>
            <select
              value={personalLock?.timeoutMinutes ?? 30}
              onChange={(event) => onPersonalLockPatch({ timeoutMinutes: Number(event.target.value) }, event)}
              data-debug-id="shellx-browser-personal-lock-timeout"
              aria-label="Personal Browser Lock timeout"
            >
              <option value={5}>5 minutes</option>
              <option value={15}>15 minutes</option>
              <option value={30}>30 minutes</option>
              <option value={60}>60 minutes</option>
            </select>
          </label>
          <label>
            <span>Unlock method</span>
            <select
              value={personalLock?.authMode ?? "deviceAuthPreferred"}
              onChange={(event) => onPersonalLockPatch({ authMode: event.target.value as BrowserPersonalLockAuthMode }, event)}
              data-debug-id="shellx-browser-personal-lock-auth-mode"
              aria-label="Personal Browser Lock unlock method"
            >
              <option value="deviceAuthPreferred">Device auth preferred</option>
              <option value="pinOnly">Session PIN</option>
            </select>
          </label>
          {pinMode && (
            <label className="shellx-browser-home-setting">
              <span>{personalLock?.pinConfigured ? "PIN" : "Set PIN"}</span>
              <input
                type="password"
                value={personalLockPinDraft}
                onChange={(event) => onPersonalLockPinDraftChange(event.target.value)}
                data-debug-id="shellx-browser-personal-lock-pin"
                aria-label="Personal Browser Lock PIN"
              />
            </label>
          )}
          {pinMode && (
            <button
              type="button"
              className="settings-pill"
              onClick={(event) => onPersonalLockPatch({ newPin: personalLockPinDraft }, event)}
              disabled={personalLockPinDraft.trim().length < 4}
              data-debug-id="shellx-browser-personal-lock-set-pin"
            >
              {personalLock?.pinConfigured ? "Update PIN" : "Set PIN"}
            </button>
          )}
          <label>
            <input
              type="checkbox"
              checked={personalLock?.blurLockedTabs !== false}
              onChange={(event) => onPersonalLockPatch({ blurLockedTabs: event.target.checked }, event)}
              disabled={!lockEnabled}
              data-debug-id="shellx-browser-personal-lock-blur"
            />
            <span>Cover locked personal tabs</span>
          </label>
          <label>
            <input
              type="checkbox"
              checked={personalLock?.pauseDelegatedTabsWhenLocked !== false}
              onChange={(event) => onPersonalLockPatch({ pauseDelegatedTabsWhenLocked: event.target.checked }, event)}
              disabled={!lockEnabled}
              data-debug-id="shellx-browser-personal-lock-pause-delegated"
            />
            <span>Pause delegated tabs when locked</span>
          </label>
          <label>
            <input
              type="checkbox"
              checked={personalLock?.lockOnSleep !== false}
              onChange={(event) => onPersonalLockPatch({ lockOnSleep: event.target.checked }, event)}
              disabled={!lockEnabled}
              data-debug-id="shellx-browser-personal-lock-sleep"
            />
            <span>Lock after system sleep</span>
          </label>
          <label>
            <input
              type="checkbox"
              checked={personalLock?.lockOnMinimize === true}
              onChange={(event) => onPersonalLockPatch({ lockOnMinimize: event.target.checked }, event)}
              disabled={!lockEnabled}
              data-debug-id="shellx-browser-personal-lock-minimize"
            />
            <span>Lock when minimized</span>
          </label>
        </section>

        <section className="shellx-browser-options-section">
          <h3>Agent engines</h3>
          <label>
            <span>Mode</span>
            <select
              value={engineMode}
              onChange={(event) => onEngineModeChange(event.target.value as BrowserEngineAutomationMode)}
              data-debug-id="shellx-browser-engine-mode"
              aria-label="Browser engine mode"
            >
              <option value="normal">Normal</option>
              <option value="backgroundOnly">Background only</option>
            </select>
          </label>
          <label>
            <span>Parallel agents</span>
            <select
              value={configuredParallelAgents}
              onChange={(event) => onParallelAgentsChange(event.target.value)}
              data-debug-id="shellx-browser-parallel-agents"
              aria-label="Parallel browser agents"
            >
              <option value="auto">Auto</option>
              <option value="1">1</option>
              <option value="2">2</option>
              <option value="3">3</option>
              <option value="4">4</option>
            </select>
          </label>
        </section>

      </div>
    </aside>
  );
}

interface BrowserPageSaveMenuProps {
  busy: boolean;
  canSavePage: boolean;
  onRequestPageSave: (kind: BrowserPageSaveKind, event: MouseEvent<HTMLButtonElement>) => void;
}

export function BrowserPageSaveMenu({ busy, canSavePage, onRequestPageSave }: BrowserPageSaveMenuProps): JSX.Element {
  const disabled = busy || !canSavePage;
  const pageActions: Array<{ kind: BrowserPageSaveKind; debugId: string; icon: ShellIconName; label: string; detail: string }> = [
    {
      kind: "explain",
      debugId: "shellx-browser-explain-page",
      icon: "sparkles",
      label: "Explain page",
      detail: "Ask the Browser agent to explain this page.",
    },
  ];
  const localActions: Array<{ kind: BrowserPageSaveKind; debugId: string; icon: ShellIconName; label: string; detail: string }> = [
    {
      kind: "fullPageScreenshot",
      debugId: "shellx-browser-save-fullpage-screenshot",
      icon: "camera",
      label: "Full-page screenshot",
      detail: "PNG of the full scrolling page.",
    },
    {
      kind: "screenshot",
      debugId: "shellx-browser-save-screenshot",
      icon: "image",
      label: "Window screenshot",
      detail: "PNG of the visible Browser window.",
    },
    {
      kind: "markdown",
      debugId: "shellx-browser-save-markdown",
      icon: "file",
      label: "Markdown",
      detail: "Readable page text as a local .md file.",
    },
    {
      kind: "linksJson",
      debugId: "shellx-browser-save-links",
      icon: "link",
      label: "Links JSON",
      detail: "Visible links found in the rendered page.",
    },
    {
      kind: "snapshotJson",
      debugId: "shellx-browser-save-snapshot",
      icon: "trace",
      label: "Snapshot bundle",
      detail: "Markdown, links, screenshot metadata.",
    },
  ];
  const queuedActions: Array<{ kind: BrowserPageSaveKind; debugId: string; icon: ShellIconName; label: string; detail: string }> = [
    {
      kind: "media",
      debugId: "shellx-browser-save-media",
      icon: "video",
      label: "Queue media copy",
      detail: "Images, video, audio.",
    },
    {
      kind: "code",
      debugId: "shellx-browser-save-code",
      icon: "terminal",
      label: "Queue code copy",
      detail: "HTML, CSS, scripts.",
    },
    {
      kind: "site",
      debugId: "shellx-browser-save-site",
      icon: "folder",
      label: "Queue site copy",
      detail: "Offline copy job.",
    },
  ];

  return (
    <div className="shellx-browser-header-popover shellx-browser-save-popover shellx-browser-docked-popover">
      <h2>Save page</h2>
      <section className="shellx-browser-save-section">
        <h3>Page actions</h3>
        {pageActions.map((action) => (
          <button
            key={action.kind}
            type="button"
            className="shellx-browser-menu-row"
            onClick={(event) => onRequestPageSave(action.kind, event)}
            disabled={disabled}
            data-debug-id={action.debugId}
          >
            <ShellIcon name={action.icon} size={13} />
            <span>{action.label}</span>
            <small>{action.detail}</small>
          </button>
        ))}
      </section>
      <section className="shellx-browser-save-section">
        <h3>Local artifacts</h3>
        {localActions.map((action) => (
          <button
            key={action.kind}
            type="button"
            className="shellx-browser-menu-row"
            onClick={(event) => onRequestPageSave(action.kind, event)}
            disabled={disabled}
            data-debug-id={action.debugId}
          >
            <ShellIcon name={action.icon} size={13} />
            <span>{action.label}</span>
            <small>{action.detail}</small>
          </button>
        ))}
      </section>
      <section className="shellx-browser-save-section">
        <h3>Copy jobs</h3>
        {queuedActions.map((action) => (
          <button
            key={action.kind}
            type="button"
            className="shellx-browser-menu-row"
            onClick={(event) => onRequestPageSave(action.kind, event)}
            disabled={disabled}
            data-debug-id={action.debugId}
          >
            <ShellIcon name={action.icon} size={13} />
            <span>{action.label}</span>
            <small>{action.detail}</small>
          </button>
        ))}
      </section>
    </div>
  );
}

interface BrowserAdFilterMenuProps {
  busy: boolean;
  selectedAdMode: BrowserVisibleAdMode;
  onSetAdMode: (mode: BrowserVisibleAdMode) => void;
}

export function BrowserAdFilterMenu({ busy, selectedAdMode, onSetAdMode }: BrowserAdFilterMenuProps): JSX.Element {
  return (
    <div className="shellx-browser-header-popover shellx-browser-ad-popover shellx-browser-docked-popover">
      <h2>Ads filter</h2>
      <button
        type="button"
        className={`shellx-browser-menu-row ${selectedAdMode === "balanced" ? "active" : ""}`}
        onClick={() => onSetAdMode("balanced")}
        disabled={busy}
        data-debug-id="shellx-browser-ad-mode-balanced"
      >
        <span>Balanced</span>
        <small>Block common ad noise while preserving compatibility.</small>
      </button>
      <button
        type="button"
        className={`shellx-browser-menu-row ${selectedAdMode === "strict" ? "active" : ""}`}
        onClick={() => onSetAdMode("strict")}
        disabled={busy}
        data-debug-id="shellx-browser-ad-mode-strict"
      >
        <span>Strict</span>
        <small>Block matching ad and tracker requests before they load.</small>
      </button>
      <button
        type="button"
        className={`shellx-browser-menu-row ${selectedAdMode === "off" ? "active" : ""}`}
        onClick={() => onSetAdMode("off")}
        disabled={busy}
        data-debug-id="shellx-browser-ad-mode-off"
      >
        <span>Off</span>
        <small>Load the page without ShellX ad filtering.</small>
      </button>
    </div>
  );
}
