/**
 * src/components/settings/GeneralTab.tsx — "General" tab of Settings.
 *
 * Render-and-patch only: chat font size, density, theme. Persistence +
 * theme application live in Settings.tsx and arrive via `onPatch`.
 *
 * Legacy model/effort and daily-cap fields are intentionally ignored
 * when old settings files are read. GitHub MCP ships via the Plugins
 * marketplace and the PAT lives in vault at `github/pat`.
 */
import type { JSX } from "react";
import {
  FONT_PX_MAX,
  FONT_PX_MIN,
  FONT_PX_DEFAULT,
  type SettingsValues,
} from "../../lib/settings";
import { ShellIcon } from "../icons";
import { inTauri } from "../../lib/tauri-bridge";
import { openShellxDialog } from "../../lib/shellx-dialog";
import { AGENT_OPTIONS, normalizeAgentSelection } from "../../lib/agent-selection";

export function GeneralTab({
  s,
  onPatch,
}: {
  s: SettingsValues;
 /** Partial-patch callback — parent re-applies theme, persists, lifts. */
  onPatch: (p: Partial<SettingsValues>) => void;
}): JSX.Element {
  const tauriAvailable = inTauri();
  const chooseDownloadFolder = async (): Promise<void> => {
    if (!tauriAvailable) return;
    const selected = await openShellxDialog({ directory: true, multiple: false });
    const value = Array.isArray(selected) ? selected[0] : selected;
    if (typeof value === "string") {
      onPatch({ browserDownloadFolder: value });
    }
  };
  const patchBrowserDownloadFolder = (value: string): void => {
    onPatch({ browserDownloadFolder: value });
  };
  const chooseDefaultWorkingFolder = async (): Promise<void> => {
    if (!tauriAvailable) return;
    const selected = await openShellxDialog({
      directory: true,
      multiple: false,
      defaultPath: s.defaultWorkingFolder || undefined,
    });
    const value = Array.isArray(selected) ? selected[0] : selected;
    if (typeof value === "string") onPatch({ defaultWorkingFolder: value });
  };

  return (
    <div className="settings-tab-body">
      <h3>New sessions</h3>

      <div className="settings-row">
        <label className="settings-label" htmlFor="settings-default-agent">Agent</label>
        <div className="settings-field-stack">
          <select
            id="settings-default-agent"
            className="settings-select"
            value={s.defaultAgentId ?? ""}
            onChange={(event) => onPatch({
              defaultAgentId: normalizeAgentSelection(event.currentTarget.value),
            })}
            data-debug-id="settings-default-agent"
            data-shellx-release-observe="value"
          >
            <option value="">Choose each time</option>
            {AGENT_OPTIONS.map((agent) => (
              <option key={agent.id} value={agent.id}>{agent.label}</option>
            ))}
          </select>
          <p className="settings-inline-hint">
            Prefills the agent in new tabs. ShellX still checks that it is available before starting.
          </p>
        </div>
      </div>

      <div className="settings-row">
        <label className="settings-label">Starting folder</label>
        <div className="settings-field-stack">
          <div className="settings-font-row">
            <input
              className="settings-input"
              value={s.defaultWorkingFolder}
              readOnly
              placeholder="Use the last folder"
              data-debug-id="settings-default-working-folder"
              data-shellx-release-observe="value"
              aria-label="Default working folder for new sessions"
            />
            <button
              type="button"
              className="settings-pill"
              onClick={() => void chooseDefaultWorkingFolder()}
              disabled={!tauriAvailable}
              data-debug-id="settings-default-working-folder-choose"
              title="Choose the starting folder for new sessions"
            >
              <ShellIcon name="folder-open" size={13} />
              Choose
            </button>
            <button
              type="button"
              className="settings-pill"
              onClick={() => onPatch({ defaultWorkingFolder: "" })}
              disabled={!s.defaultWorkingFolder}
              data-debug-id="settings-default-working-folder-clear"
              title={s.defaultWorkingFolder
                ? "Reuse the last folder in new sessions"
                : "New sessions already reuse the last folder"}
            >
              Use last
            </button>
          </div>
          <p className="settings-inline-hint">
            Leave empty to reuse the last folder. This affects new tabs only.
          </p>
        </div>
      </div>

 {/* chat body font size. Drives --fs-body. */}
      <div className="settings-row">
        <label className="settings-label">Chat font size</label>
        <div className="settings-font-row">
          <input
            type="range"
            className="settings-range"
            min={FONT_PX_MIN}
            max={FONT_PX_MAX}
            step={1}
            value={s.chatFontPx}
            onChange={(e) => onPatch({ chatFontPx: Number(e.target.value) })}
            aria-label="Chat font size in pixels"
            data-shellx-release-observe="value"
          />
          <span className="settings-font-val">{s.chatFontPx}px</span>
          <button
            type="button"
            className="settings-pill"
            onClick={() => onPatch({ chatFontPx: FONT_PX_DEFAULT })}
            title="Reset to default"
          >
            reset
          </button>
        </div>
      </div>

      <div className="settings-row">
        <label className="settings-label">Density</label>
        <div className="settings-pills">
          {(["compact", "default", "comfortable"] as const).map((d) => (
            <button data-debug-id={`settings-density-${d}`}
              key={d}
              type="button"
              className={`settings-pill ${s.density === d ? "active" : ""}`}
              onClick={() => onPatch({ density: d })}
              aria-pressed={s.density === d}
              data-shellx-release-observe="pressed"
            >
              {d}
            </button>
          ))}
        </div>
      </div>

      <div className="settings-row">
        <label className="settings-label">Theme</label>
        <div className="settings-pills">
          <button
            aria-label="Use Black theme"
            type="button"
            className={`settings-pill ${s.theme === "black" ? "active" : ""}`}
            onClick={() => onPatch({ theme: "black" })}
            aria-pressed={s.theme === "black"}
            data-shellx-release-observe="pressed"
          >
            Black
          </button>
          <button
            aria-label="Use Black and warm theme"
            type="button"
            className={`settings-pill ${s.theme === "black_warm" ? "active" : ""}`}
            onClick={() => onPatch({ theme: "black_warm" })}
            aria-pressed={s.theme === "black_warm"}
            data-shellx-release-observe="pressed"
          >
            Black + warm
          </button>
          <button
            aria-label="Use Bright theme"
            type="button"
            className={`settings-pill ${s.theme === "bright" ? "active" : ""}`}
            onClick={() => onPatch({ theme: "bright" })}
            aria-pressed={s.theme === "bright"}
            data-shellx-release-observe="pressed"
          >
            Bright
          </button>
        </div>
      </div>

      <div className="settings-row">
        <label className="settings-label">Browser downloads</label>
        <div className="settings-field-stack">
          <div className="settings-font-row">
            <input
              className="settings-input"
              value={s.browserDownloadFolder}
              onInput={(event) => patchBrowserDownloadFolder(event.currentTarget.value)}
              onChange={(event) => patchBrowserDownloadFolder(event.currentTarget.value)}
              placeholder="Choose a default download folder"
              data-debug-id="settings-browser-download-folder"
              data-shellx-release-observe="value"
              aria-label="Browser default download folder"
            />
            <button
              type="button"
              className="settings-pill"
              onClick={() => void chooseDownloadFolder()}
              disabled={!tauriAvailable}
              data-debug-id="settings-browser-download-folder-choose"
              title="Choose default Browser download folder"
            >
              <ShellIcon name="folder-open" size={13} />
              Choose
            </button>
          </div>
          <p className="settings-inline-hint">
            Used by Browser page-save and download intents before a transfer is approved.
          </p>
        </div>
      </div>

 {/* gh-binary + GitHub-token rows removed.
 * shellX now ships the GitHub MCP server in the marketplace
 * (Plugins modal → Tier A → GitHub). PAT lives in the vault
 * under `github/pat`. No external `gh` binary required.
 * The debug API still honors a raw `githubGhBinary` key in
 * settings.json as an advanced compatibility escape hatch.
 */}
    </div>
  );
}
