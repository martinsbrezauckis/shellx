import { useEffect, useRef, type Dispatch, type SetStateAction } from "react";

import { updateBrowserDownloadFolder, browserApiPostJson } from "../api";
import { inTauri } from "../../lib/tauri-bridge";
import {
  persistBrowserColorMode,
  persistBrowserDownloadFolder,
  persistBrowserHomeUrl,
} from "../browserPreferences";
import { readSettingsLocal } from "../../lib/settings";
import { createDownloadFolderWriter } from "../downloadFolderPersistence";

interface BrowserShellEffectsOptions {
  activeTaskId: string | null;
  addressEditing: boolean;
  addressSourceUrl: string;
  colorMode: "system" | "light" | "dark";
  defaultDownloadFolder: string;
  homeUrl: string;
  refresh: () => Promise<void>;
  setAddress: (value: string) => void;
  setDefaultDownloadFolder: Dispatch<SetStateAction<string>>;
  setDownloadFolderError: (value: string | null) => void;
  setHeaderMenu: (value: null) => void;
  setOpenToolbarFolderId: (value: null) => void;
  setOptionsOpen: (value: boolean) => void;
  closeOptionsWithFocus: () => void;
}

export function useBrowserShellEffects(options: BrowserShellEffectsOptions): void {
  const {
    activeTaskId,
    addressEditing,
    addressSourceUrl,
    colorMode,
    defaultDownloadFolder,
    homeUrl,
    refresh,
    setAddress,
    setDefaultDownloadFolder,
    setDownloadFolderError,
    setHeaderMenu,
    setOpenToolbarFolderId,
    setOptionsOpen,
    closeOptionsWithFocus,
  } = options;
  const downloadFolderWriter = useRef<ReturnType<typeof createDownloadFolderWriter> | null>(null);
  if (!downloadFolderWriter.current) {
    downloadFolderWriter.current = createDownloadFolderWriter(updateBrowserDownloadFolder, persistBrowserDownloadFolder);
  }

  useEffect(() => {
    persistBrowserColorMode(colorMode);
  }, [colorMode]);

  useEffect(() => {
    persistBrowserHomeUrl(homeUrl);
  }, [homeUrl]);

  useEffect(() => {
    // The public manual and browser-only development preview have no desktop
    // registry to update. Avoid presenting their expected IPC refusal as a
    // user folder-validation error.
    if (!inTauri()) return;
    let current = true;
    setDownloadFolderError(null);
    const timer = window.setTimeout(() => {
      void downloadFolderWriter.current!(defaultDownloadFolder, () => current)
        .then((saved) => {
          // A refresh failure must not label an accepted folder as invalid.
          // The existing Browser event/poll subscription also refreshes state.
          if (saved && current) void refresh().catch(() => undefined);
        })
        .catch((error: unknown) => {
          if (current) setDownloadFolderError(`Download folder update failed: ${error instanceof Error ? error.message : String(error)}`);
        });
    }, 300);
    return () => { current = false; window.clearTimeout(timer); };
  }, [defaultDownloadFolder, refresh, setDownloadFolderError]);

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== "shellX.settings.v2") return;
      const folder = readSettingsLocal().browserDownloadFolder;
      setDefaultDownloadFolder((current) => current === folder ? current : folder);
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [setDefaultDownloadFolder]);

  useEffect(() => {
    if (!addressEditing) setAddress(addressSourceUrl);
  }, [addressEditing, addressSourceUrl, setAddress]);

  useEffect(() => {
    const closeFloatingMenus = (event: globalThis.PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target?.closest(".shellx-browser-bookmark-toolbar, .shellx-browser-bookmark-folder-menu-dock")) {
        setOpenToolbarFolderId(null);
      }
      if (target?.closest(".shellx-browser-shields-wrap, .shellx-browser-header-menu-wrap, .shellx-browser-options-wrap, .shellx-browser-chrome-menu-dock, .shellx-browser-left-sidecar")) return;
      setHeaderMenu(null);
      setOptionsOpen(false);
    };
    const closeWithEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setHeaderMenu(null);
      closeOptionsWithFocus();
      setOpenToolbarFolderId(null);
    };
    window.addEventListener("pointerdown", closeFloatingMenus);
    window.addEventListener("keydown", closeWithEscape);
    return () => {
      window.removeEventListener("pointerdown", closeFloatingMenus);
      window.removeEventListener("keydown", closeWithEscape);
    };
  }, [closeOptionsWithFocus, setHeaderMenu, setOpenToolbarFolderId, setOptionsOpen]);

  useEffect(() => {
    const recordUiError = (message: string, details: Record<string, unknown>) => {
      void browserApiPostJson("/browser/logs", {
        taskId: activeTaskId || undefined,
        level: "error",
        source: "shellx-browser-ui",
        message,
        details,
      }).catch(() => undefined);
    };
    const onError = (event: ErrorEvent) => recordUiError(event.message || "Browser UI script error", {
      filename: event.filename,
      line: event.lineno,
      column: event.colno,
    });
    const onUnhandledRejection = (event: PromiseRejectionEvent) => recordUiError(
      event.reason instanceof Error ? event.reason.message : String(event.reason),
      { reason: event.reason instanceof Error ? event.reason.stack : String(event.reason) },
    );
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onUnhandledRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onUnhandledRejection);
    };
  }, [activeTaskId]);
}
