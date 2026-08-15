/**
 * src/components/Settings.tsx — tabbed Settings dialog.
 *
 * Tab strip is sticky; active body scrolls underneath. The active tab
 * persists under `shellX.settingsTab.v2`.
 *
 * Tabs:
 * - General — chat font size, density, theme, and permission UX
 * (./settings/GeneralTab.tsx)
 * - Vault — encrypted-secret CRUD (./settings/VaultTab.tsx).
 * Values lazy-load per key via POST /vault/get and
 * are masked in the edit form.
 * - Connections — read-only saved transport presets
 * (./settings/ConnectionsTab.tsx). Edit still
 * happens in the workspace-pill popover.
 * - Desktop — host OS handoff integrations
 * (./settings/DesktopTab.tsx).
 * - Shellx agent — per-tab agent toggles (./settings/ShellxagentTab.tsx).
 * - About — version + tip commit + links
 * (./settings/AboutTab.tsx).
 *
 * Settings state and persistence live in ../lib/settings so Browser and
 * startup code do not pull every Settings tab into their initial bundle.
 */
import { useEffect, useRef, useState, type JSX, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent, type PointerEvent } from "react";
import "./Settings.css";
import {
  ALL_SETTINGS_TABS,
  applyTheme,
  persistSettings,
  persistSettingsTab,
  readSettingsTab,
  type SettingsTab,
  type SettingsValues,
} from "../lib/settings";
import { GeneralTab } from "./settings/GeneralTab";
import { VaultTab } from "./settings/VaultTab";
import { ConnectionsTab } from "./settings/ConnectionsTab";
import { ConnectorsTab, type ConnectorsDebugFixture } from "./settings/ConnectorsTab";
import { DesktopTab } from "./settings/DesktopTab";
import { AboutTab } from "./settings/AboutTab";
import { ShellxagentTab, type ShellxagentDebugFixture } from "./settings/ShellxagentTab";
import { DataTab } from "./settings/DataTab";
import { ShellIcon } from "./icons";
import { useModalFocus } from "../lib/useModalFocus";
import type { DebugUpdateFixtureMode } from "../lib/update-notes";

export function Settings({
  open,
  onClose,
  initial,
  onChange,
  debugShellxagentFixture = null,
  debugClipboardFixture = null,
  connectorsDebugFixture = null,
  debugUpdateFixture = "live",
}: {
  open: boolean;
  onClose: () => void;
  initial: SettingsValues;
  onChange: (s: SettingsValues) => void;
  debugShellxagentFixture?: ShellxagentDebugFixture;
  debugClipboardFixture?: "shellxagent-token" | "vault-draft" | null;
  connectorsDebugFixture?: ConnectorsDebugFixture | null;
  debugUpdateFixture?: DebugUpdateFixtureMode;
}): JSX.Element | null {
  const [s, setS] = useState<SettingsValues>(initial);
  const [tab, setTab] = useState<SettingsTab>(() => readSettingsTab());
  const backdropPointerStartedOnBackdrop = useRef(false);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  useModalFocus(open, dialogRef, onClose);

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
    if (open) setTab(readSettingsTab());
  }, [open]);

 // Persist active tab whenever it changes (not just on close — survives
 // crashes mid-session).
  useEffect(() => { persistSettingsTab(tab); }, [tab]);

  if (!open) return null;

  // The release driver can project the ShellX Agent tab without changing the
  // operator's persisted Settings selection. Its child fixture disables every
  // credential, clipboard, and file mutation while this override is active.
  const renderedTab: SettingsTab = debugShellxagentFixture === "owned-safe" || debugClipboardFixture === "shellxagent-token"
    ? "shellxagent"
    : debugClipboardFixture === "vault-draft"
      ? "vault"
    : connectorsDebugFixture === "owned-safe"
      ? "connectors"
      : tab;

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

  function handleSettingsBackdropPointerDown(event: PointerEvent<HTMLDivElement>): void {
    backdropPointerStartedOnBackdrop.current = event.target === event.currentTarget;
  }

  function handleSettingsBackdropClick(event: MouseEvent<HTMLDivElement>): void {
    const startedOnBackdrop = backdropPointerStartedOnBackdrop.current;
    backdropPointerStartedOnBackdrop.current = false;
    if (event.target !== event.currentTarget || !startedOnBackdrop) return;
    onClose();
  }

  function handleTabKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>, current: SettingsTab): void {
    const index = ALL_SETTINGS_TABS.indexOf(current);
    let nextIndex: number | null = null;
    if (event.key === "ArrowRight") nextIndex = (index + 1) % ALL_SETTINGS_TABS.length;
    else if (event.key === "ArrowLeft") nextIndex = (index - 1 + ALL_SETTINGS_TABS.length) % ALL_SETTINGS_TABS.length;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = ALL_SETTINGS_TABS.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    const next = ALL_SETTINGS_TABS[nextIndex]!;
    setTab(next);
    window.requestAnimationFrame(() => {
      dialogRef.current?.querySelector<HTMLButtonElement>(`#settings-tab-${next}`)?.focus();
    });
  }

  return (
    <div data-debug-id="surface-components-settings-1"
      className="modal-backdrop"
      onPointerDownCapture={handleSettingsBackdropPointerDown}
      onClick={handleSettingsBackdropClick}
    >
      <div
        ref={dialogRef}
        className="modal settings-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        tabIndex={-1}
      >
        <div className="settings-tabbar" role="tablist" aria-label="Settings sections">
          {ALL_SETTINGS_TABS.map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={renderedTab === t}
              aria-controls="settings-tab-panel"
              id={`settings-tab-${t}`}
              tabIndex={renderedTab === t ? 0 : -1}
              data-dialog-initial-focus={renderedTab === t ? "true" : undefined}
              className={`settings-tab ${renderedTab === t ? "active" : ""}`}
              data-debug-id={`settings-tab-${t}`}
              data-shellx-release-observe="selected"
              onClick={() => setTab(t)}
              onKeyDown={(event) => handleTabKeyDown(event, t)}
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
            <ShellIcon name="close" size={14} />
          </button>
        </div>

        <div
          className="settings-tab-pane"
          role="tabpanel"
          id="settings-tab-panel"
          aria-labelledby={`settings-tab-${renderedTab}`}
        >
  {renderedTab === "general" && (
            <GeneralTab s={s} onPatch={patch} />
          )}
          {renderedTab === "vault" && <VaultTab debugClipboardFixture={debugClipboardFixture === "vault-draft" ? "owned-safe" : null} />}
          {renderedTab === "connections" && <ConnectionsTab />}
          {renderedTab === "connectors" && <ConnectorsTab debugFixture={connectorsDebugFixture} />}
          {renderedTab === "desktop" && <DesktopTab />}
          {renderedTab === "shellxagent" && <ShellxagentTab debugFixture={debugClipboardFixture === "shellxagent-token" ? "owned-clipboard" : debugShellxagentFixture} />}
          {renderedTab === "data" && <DataTab />}
          {renderedTab === "about" && <AboutTab debugFixture={debugUpdateFixture} />}
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
    case "connectors": return "Connectors";
    case "desktop": return "Desktop";
    case "shellxagent": return "shellXagent";
    case "data": return "Data";
    case "about": return "About";
  }
}

//  HardCapModal removed. The daily-cap UX was never
// shipped (no caller mounted it, no Rust 402 gate ever wired up). If
// usage caps return as a feature, restore from git history.
