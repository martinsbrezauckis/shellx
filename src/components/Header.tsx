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
import { useCallback, type JSX } from "react";
import { invoke } from "@tauri-apps/api/core";
import { apiPostJson } from "../lib/debug-api";
import { FindPopover, type ChatHit } from "./FindPopover";
import { ShellIcon } from "./icons";

// brand-shellx.png is a tight crop of the source brand sheet — icon
// tile + "Shell X" wordmark, no subtitle. The tile/background blends
// into the header gradient (both near-black), so no transparent-PNG
// plumbing is needed. Module declaration lives in vite-env.d.ts.
import brandUrl from "../assets/brand-shellx.png?url";

export type AutonomyMode = "plan" | "acceptEdits" | "default" | "bypassPermissions";

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
  onOpenPlugins,
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
 /** Plugins icon opens the PluginsModal. */
  onOpenPlugins?: () => void;
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
 {/* Groks-working pill: running tasks with
 * origin ∈ {grok, host_mcp}. Hidden when 0. Reads as
 * "X tabs alive · Y groks busy" alongside the sessions pill. */}
        {typeof liveGrokCount === "number" && liveGrokCount > 0 && (
          <span
            className="hdr-live-badge hdr-grok-badge"
            title={`${liveGrokCount} grok${liveGrokCount === 1 ? "" : "s"} working (main + subagents)`}
            aria-label={`${liveGrokCount} groks working`}
          >
            <span className="hdr-live-dot grok-dot" />
            {liveGrokCount} working
          </span>
        )}
 {/* Plugins icon — opens PluginsModal */}
        {onOpenPlugins && (
          <button
            type="button"
            className="hdr-icon"
            onClick={onOpenPlugins}
            title="Plugins · MCP servers, connectors, skills"
            aria-label="Open plugins"
          >
            <ShellIcon name="plug" size={16} />
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
