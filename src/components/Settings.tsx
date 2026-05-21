/**
 * src/components/Settings.tsx — tabbed Settings dialog.
 *
 * Tab strip is sticky; active body scrolls underneath. The active tab
 * persists under `grok-shell.settingsTab.v1`.
 *
 * Tabs:
 * - General — model, effort, font, density, theme, caps, gh
 * (./settings/GeneralTab.tsx)
 * - Vault — encrypted-secret CRUD (./settings/VaultTab.tsx).
 * Values lazy-load per key via POST /vault/get and
 * are masked in the edit form.
 * - Connections — read-only saved transport presets
 * (./settings/ConnectionsTab.tsx). Edit still
 * happens in the workspace-pill popover.
 * - Shellx agent — per-tab agent toggles (./settings/ShellxagentTab.tsx).
 * - About — version + tip commit + links
 * (./settings/AboutTab.tsx).
 *
 * Public exports consumed by App.tsx: Settings, HardCapModal,
 * SettingsValues, readSettingsLocal, persistSettings, applyTheme,
 * DEFAULT_SETTINGS, FONT_PX_* constants.
 */
import { useEffect, useState, type JSX } from "react";
import { apiPost } from "../lib/debug-api";
import { GeneralTab } from "./settings/GeneralTab";
import { VaultTab } from "./settings/VaultTab";
import { ConnectionsTab } from "./settings/ConnectionsTab";
import { AboutTab } from "./settings/AboutTab";
import { ShellxagentTab } from "./settings/ShellxagentTab";
import { DataTab } from "./settings/DataTab";

export type DensityMode = "compact" | "default" | "comfortable";
export type ThemeMode = "black" | "black_warm";
export type EffortMode = "low" | "medium" | "high" | "xhigh" | "max";

/**
 * Issue #374 — surface mode for ACP permission requests in Confirm
 * autonomy. `"pill"` (default) renders the in-chat PermissionPill only,
 * `"modal"` keeps the legacy popup, `"both"` shows the pill (canonical
 * audit trail) AND the modal (visual interrupt). Public-release users
 * land on `"pill"` because the modal is too intrusive for casual use.
 */
export type PermissionUxMode = "modal" | "pill" | "both";

export interface SettingsValues {
 //  dead fields removed: model, effort, dailyCapUsd,
 // hardCapModalAtPct, githubGhBinary, githubTokenPresent. They had no
 // UI consumers and were lingering in localStorage. Old persisted
 // values are simply ignored on read; SettingsValues only carries the
 // fields the UI actually renders.
  density: DensityMode;
  theme: ThemeMode;
 /** chat body font size in px. Drives the --fs-body
 * CSS token; affects message text + composer textarea + all
 * `font-size: var(--fs-body)` consumers. Range 12-26px; default
 * matches the existing token value (19px) so installs without the
 * setting render unchanged. */
  chatFontPx: number;
 /** Permission UX surface. See PermissionUxMode JSDoc. */
  permissionUx: PermissionUxMode;
}

export const FONT_PX_MIN = 12;
export const FONT_PX_MAX = 26;
export const FONT_PX_DEFAULT = 19;

export const DEFAULT_SETTINGS: SettingsValues = {
  density: "default",
  theme: "black",
  chatFontPx: FONT_PX_DEFAULT,
  permissionUx: "pill",
};

const STORAGE_KEY = "grok-shell.settings.v1";
export const TAB_KEY = "grok-shell.settingsTab.v1";

export type SettingsTab = "general" | "vault" | "connections" | "shellxagent" | "data" | "about";
const ALL_TABS: SettingsTab[] = ["general", "vault", "connections", "shellxagent", "data", "about"];

function readActiveTab(): SettingsTab {
  try {
    const raw = localStorage.getItem(TAB_KEY) as SettingsTab | null;
    if (raw && ALL_TABS.includes(raw)) return raw;
  } catch { /* ignore */ }
  return "general";
}
function writeActiveTab(t: SettingsTab): void {
  try { localStorage.setItem(TAB_KEY, t); } catch { /* ignore */ }
}

export function normalizeSettings(raw: unknown): SettingsValues {
  const obj = raw && typeof raw === "object" ? raw as Partial<SettingsValues> : {};
  const density: DensityMode =
    obj.density === "compact" || obj.density === "comfortable" || obj.density === "default"
      ? obj.density
      : DEFAULT_SETTINGS.density;
  const theme: ThemeMode =
    obj.theme === "black_warm" || obj.theme === "black"
      ? obj.theme
      : DEFAULT_SETTINGS.theme;
  const permissionUx: PermissionUxMode =
    obj.permissionUx === "modal" || obj.permissionUx === "both" || obj.permissionUx === "pill"
      ? obj.permissionUx
      : DEFAULT_SETTINGS.permissionUx;
  const chatFontPx =
    typeof obj.chatFontPx === "number" && Number.isFinite(obj.chatFontPx)
      ? Math.max(FONT_PX_MIN, Math.min(FONT_PX_MAX, Math.round(obj.chatFontPx)))
      : DEFAULT_SETTINGS.chatFontPx;
  return { density, theme, chatFontPx, permissionUx };
}

/** Read settings from localStorage (sync), falling back to defaults. */
export function readSettingsLocal(): SettingsValues {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return normalizeSettings(JSON.parse(raw));
  } catch { /* ignore */ }
  return { ...DEFAULT_SETTINGS };
}

/** Write to localStorage immediately, then fire-and-forget to debug API. */
export function persistSettings(s: SettingsValues): void {
  const normalized = normalizeSettings(s);
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized)); } catch { /* ignore */ }
 // C-NEW-1: route through apiPost wrapper for bearer-token auth.
 // The wrapper resolves the token via invoke('get_debug_token') which
 // reads ~/.shellx/shellxagent.token on the Rust side.
  void apiPost("/settings", normalized).catch(() => { /* debug api may be off */ });
}

/**
 * Apply density + theme to the document root so CSS rules can read them
 * without per-component plumbing.
 */
export function applyTheme(
  s: Pick<SettingsValues, "density" | "theme" | "chatFontPx">,
): void {
  const root = document.documentElement;
  root.setAttribute("data-density", s.density);
  root.setAttribute("data-theme", s.theme);
 /* override the --fs-body token at the document root so
 * every consumer (chat body, composer, .icode, etc.) reflows. Clamp
 * to the allowed range so a bogus persisted value can't shrink text
 * to 1px. --fs-body-md derives from chatFontPx (-2) so secondary body
 * stays roughly proportional. */
  const px = Math.max(FONT_PX_MIN, Math.min(FONT_PX_MAX, s.chatFontPx || FONT_PX_DEFAULT));
  root.style.setProperty("--fs-body", `${px}px`);
  root.style.setProperty("--fs-body-md", `${Math.max(13, px - 2)}px`);
 /* lift the slider to monospace stream displays
 * (Logs / Stderr / acp-terminal). Mono stays 1px under body so a
 * 19px chat reads at 18px mono — keeps the slider truly global.
 * xterm.js (user PTY + acp-terminal) reads chatFontPx directly and
 * calls term.options.fontSize, since xterm canvas can't subscribe
 * to CSS vars. */
  const monoPx = Math.max(11, px - 1);
  root.style.setProperty("--fs-mono", `${monoPx}px`);
 /* broadcast the mono size on a DOM event so xterm.js mounts
 * (TerminalView) can resize their canvas. CSS vars don't reach into
 * the xterm renderer, so this side channel is required. */
  try {
    window.dispatchEvent(new CustomEvent("shellx-font-change", {
      detail: { bodyPx: px, monoPx },
    }));
  } catch { /* SSR / no CustomEvent — non-fatal */ }
}

export function Settings({
  open,
  onClose,
  initial,
  onChange,
}: {
  open: boolean;
  onClose: () => void;
  initial: SettingsValues;
  onChange: (s: SettingsValues) => void;
}): JSX.Element | null {
  const [s, setS] = useState<SettingsValues>(initial);
  const [tab, setTab] = useState<SettingsTab>(() => readActiveTab());

 // Sync incoming changes (e.g. opened with refreshed initial values).
  useEffect(() => {
    if (open) setS(initial);
  }, [open, initial]);

 // Re-read the tab key from localStorage on every open, so external
 // callers (Header brand → "About") can switch the active tab simply
 // by writing TAB_KEY before they call setSettingsOpen(true). This is
 // load-bearing for routing the Header brand click into Settings →
 // About (one canonical About surface, not a competing modal).
  useEffect(() => {
    if (open) setTab(readActiveTab());
  }, [open]);

 // Esc closes
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

 // Persist active tab whenever it changes (not just on close — survives
 // crashes mid-session).
  useEffect(() => { writeActiveTab(tab); }, [tab]);

  if (!open) return null;

 /**
 * Partial-patch for SettingsValues. Re-applies theme + persists +
 * notifies App in a single hop so the General tab can stay dumb.
 */
  function patch(p: Partial<SettingsValues>): void {
    const next = { ...s, ...p };
    setS(next);
    applyTheme(next);
    persistSettings(next);
    onChange(next);
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal settings-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
      >
        <div className="settings-tabbar" role="tablist" aria-label="Settings sections">
          {ALL_TABS.map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={tab === t}
              className={`settings-tab ${tab === t ? "active" : ""}`}
              onClick={() => setTab(t)}
            >
              {tabLabel(t)}
            </button>
          ))}
          <div className="settings-tabbar-spacer" />
          <button
            type="button"
            className="settings-close"
            onClick={onClose}
            aria-label="Close settings"
            title="Close (Esc)"
          >
            ✕
          </button>
        </div>

        <div className="settings-tab-pane" role="tabpanel">
          {tab === "general" && (
            <GeneralTab s={s} onPatch={patch} />
          )}
          {tab === "vault" && <VaultTab />}
          {tab === "connections" && <ConnectionsTab />}
          {tab === "shellxagent" && <ShellxagentTab />}
          {tab === "data" && <DataTab />}
          {tab === "about" && <AboutTab />}
        </div>

        <div className="modal-hint">
          Press <kbd>Esc</kbd> to close. Changes save automatically.
        </div>
      </div>
    </div>
  );
}

function tabLabel(t: SettingsTab): string {
  switch (t) {
    case "general": return "General";
    case "vault": return "Vault";
    case "connections": return "Connections";
    case "shellxagent": return "shellXagent";
    case "data": return "Data";
    case "about": return "About";
  }
}

//  HardCapModal removed. The daily-cap UX was never
// shipped (no caller mounted it, no Rust 402 gate ever wired up). If
// usage caps return as a feature, restore from git history.
