import type {
  BrowserShieldAdTrackerMode,
  BrowserShieldCookieMode,
  BrowserShieldFingerprintingMode,
  BrowserShieldSettings,
  BrowserTabShieldState,
} from "../types";

interface BrowserShieldsPanelProps {
  busy: boolean;
  globalShields: BrowserShieldSettings | undefined;
  activeShieldState: BrowserTabShieldState;
  onUpdateGlobal: (patch: Partial<BrowserShieldSettings>) => void;
  onSaveSite: (patch?: Partial<BrowserTabShieldState>) => void;
  onResetSite: () => void;
}

export function BrowserShieldsPanel({
  busy,
  globalShields,
  activeShieldState,
  onUpdateGlobal,
  onSaveSite,
  onResetSite,
}: BrowserShieldsPanelProps) {
  return (
    <div
      id="shellx-browser-shields-panel"
      className="shellx-browser-header-popover shellx-browser-shields-panel"
      data-debug-id="shellx-browser-shields-panel"
      role="region"
      aria-labelledby="shellx-browser-trust-chip"
    >
      <h2>Shields</h2>
      <div className="shellx-browser-shields-status">
        <span>{activeShieldState.host ?? "Current page"}</span>
        <small>{activeShieldState.hasSiteOverride ? "Site override" : "Global defaults"}</small>
      </div>
      <label className="shellx-browser-toggle-row">
        <span>Protection</span>
        <input
          type="checkbox"
          checked={globalShields?.enabled ?? true}
          onChange={(event) => onUpdateGlobal({ enabled: event.currentTarget.checked })}
          data-debug-id="shellx-browser-shields-global-enabled"
          data-shellx-release-observe="checked"
        />
      </label>
      <label className="shellx-browser-field-row">
        <span>Ads and trackers</span>
        <select
          value={activeShieldState.effectiveAdTrackerMode}
          onChange={(event) => onSaveSite({ effectiveAdTrackerMode: event.currentTarget.value as BrowserShieldAdTrackerMode })}
          data-debug-id="shellx-browser-site-shields-ad-trackers"
          data-shellx-release-observe="value"
        >
          <option value="balanced">Balanced</option>
          <option value="strict">Strict</option>
          <option value="off">Off</option>
        </select>
      </label>
      <label className="shellx-browser-field-row">
        <span>Cookies</span>
        <select data-debug-id="surface-browser-components-browsershieldspanel-3"
          data-shellx-release-observe="value"
          value={activeShieldState.effectiveCookieMode}
          onChange={(event) => onSaveSite({ effectiveCookieMode: event.currentTarget.value as BrowserShieldCookieMode })}
        >
          <option value="blockThirdParty">Block third-party</option>
          <option value="allowAll">Allow all</option>
          <option value="blockAll">Block all</option>
        </select>
      </label>
      <label className="shellx-browser-field-row">
        <span>Fingerprinting</span>
        <select data-debug-id="surface-browser-components-browsershieldspanel-4"
          data-shellx-release-observe="value"
          value={activeShieldState.effectiveFingerprintingMode}
          onChange={(event) => onSaveSite({ effectiveFingerprintingMode: event.currentTarget.value as BrowserShieldFingerprintingMode })}
        >
          <option value="compatibility">Compatibility</option>
          <option value="strict">Strict</option>
        </select>
      </label>
      <label className="shellx-browser-toggle-row">
        <span>HTTPS upgrades</span>
        <input data-debug-id="surface-browser-components-browsershieldspanel-5"
          data-shellx-release-observe="checked"
          type="checkbox"
          checked={activeShieldState.httpsUpgradeEnabled}
          onChange={(event) => onSaveSite({ httpsUpgradeEnabled: event.currentTarget.checked })}
        />
      </label>
      <label className="shellx-browser-toggle-row">
        <span>Script blocking</span>
        <input
          type="checkbox"
          checked={activeShieldState.scriptBlockingEnabled}
          onChange={(event) => onSaveSite({ scriptBlockingEnabled: event.currentTarget.checked })}
          data-debug-id="shellx-browser-site-shields-script-blocking"
          data-shellx-release-observe="checked"
        />
      </label>
      <div className="shellx-browser-shields-actions">
        <button
          type="button"
          className="shellx-browser-menu-row"
          onClick={() => onSaveSite()}
          disabled={!activeShieldState.host || busy}
          data-debug-id="shellx-browser-site-shields-save"
          data-shellx-release-observe="disabled"
        >
          <span>Save for site</span>
        </button>
        <button
          type="button"
          className="shellx-browser-menu-row"
          onClick={onResetSite}
          disabled={!activeShieldState.hasSiteOverride || busy}
          data-debug-id="shellx-browser-site-shields-reset"
          data-shellx-release-observe="disabled"
        >
          <span>Reset site</span>
        </button>
      </div>
    </div>
  );
}
