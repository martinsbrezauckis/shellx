import { useEffect, type Dispatch, type SetStateAction } from "react";

import { updateBrowserDownloadFolder, browserApiPostJson } from "../api";
import {
  persistBrowserColorMode,
  persistBrowserDownloadFolder,
  persistBrowserHomeUrl,
} from "../browserPreferences";
import { readSettingsLocal } from "../../lib/settings";

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
  setHeaderMenu: (value: null) => void;
  setOpenToolbarFolderId: (value: null) => void;
  setOptionsOpen: (value: boolean) => void;
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
    setHeaderMenu,
    setOpenToolbarFolderId,
    setOptionsOpen,
  } = options;

  useEffect(() => {
    persistBrowserColorMode(colorMode);
  }, [colorMode]);

  useEffect(() => {
    persistBrowserHomeUrl(homeUrl);
  }, [homeUrl]);

  useEffect(() => {
    persistBrowserDownloadFolder(defaultDownloadFolder);
    void updateBrowserDownloadFolder(defaultDownloadFolder).then(() => refresh()).catch(() => undefined);
  }, [defaultDownloadFolder, refresh]);

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
      setOptionsOpen(false);
      setOpenToolbarFolderId(null);
    };
    window.addEventListener("pointerdown", closeFloatingMenus);
    window.addEventListener("keydown", closeWithEscape);
    return () => {
      window.removeEventListener("pointerdown", closeFloatingMenus);
      window.removeEventListener("keydown", closeWithEscape);
    };
  }, [setHeaderMenu, setOpenToolbarFolderId, setOptionsOpen]);

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
