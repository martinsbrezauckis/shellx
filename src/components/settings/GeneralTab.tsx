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
  type PermissionUxMode,
  type SettingsValues,
} from "../Settings";

export function GeneralTab({
  s,
  onPatch,
}: {
  s: SettingsValues;
 /** Partial-patch callback — parent re-applies theme, persists, lifts. */
  onPatch: (p: Partial<SettingsValues>) => void;
}): JSX.Element {
  return (
    <div className="settings-tab-body">
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
            <button
              key={d}
              type="button"
              className={`settings-pill ${s.density === d ? "active" : ""}`}
              onClick={() => onPatch({ density: d })}
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
            type="button"
            className={`settings-pill ${s.theme === "black" ? "active" : ""}`}
            onClick={() => onPatch({ theme: "black" })}
          >
            Black
          </button>
          <button
            type="button"
            className={`settings-pill ${s.theme === "black_warm" ? "active" : ""}`}
            onClick={() => onPatch({ theme: "black_warm" })}
          >
            Black + warm
          </button>
        </div>
      </div>

 {/* Permission UX surface (issue #374). Confirm autonomy mode emits
 * `session/request_permission` for every gated tool call; this
 * setting picks the visual surface used to gate them. "pill" is
 * the default for public-release users — in-chat chip with
 * Allow / Allow-always / Deny buttons that doesn't steal focus.
 * "modal" keeps the legacy interrupt popup. "both" shows the
 * modal AND the pill (the pill is also the audit trail).
 */}
      <div className="settings-row">
        <label className="settings-label">Permission UX</label>
        <div className="settings-pills">
          {(["pill", "modal", "both"] as const).map((m: PermissionUxMode) => (
            <button
              key={m}
              type="button"
              className={`settings-pill ${s.permissionUx === m ? "active" : ""}`}
              onClick={() => onPatch({ permissionUx: m })}
              title={
                m === "pill"
                  ? "In-chat chip only (default)"
                  : m === "modal"
                    ? "Popup modal only (legacy)"
                    : "Both chip and modal"
              }
            >
              {m === "pill" ? "Pill" : m === "modal" ? "Modal" : "Both"}
            </button>
          ))}
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
