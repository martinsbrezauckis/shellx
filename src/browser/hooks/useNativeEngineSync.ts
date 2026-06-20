import { useEffect, type RefObject } from "react";

import { syncBrowserEngine } from "../api";

interface UseNativeEngineSyncInput {
  enabled: boolean;
  slotRef: RefObject<HTMLElement | null>;
  activeEngineId: string | null;
  activeBrowserTabId: string | null;
  profileId: string;
  url: string | null;
  dependencies: readonly unknown[];
  onError: (message: string) => void;
}

export function useNativeEngineSync(input: UseNativeEngineSyncInput): void {
  const {
    enabled,
    slotRef,
    activeEngineId,
    activeBrowserTabId,
    profileId,
    url,
    dependencies,
    onError,
  } = input;

  useEffect(() => {
    if (!enabled) return;
    const slot = slotRef.current;
    if (!slot) return;
    let disposed = false;
    let frame: number | null = null;
    let retryTimer: number | null = null;

    const syncNativeEngine = () => {
      if (disposed) return;
      const rect = slot.getBoundingClientRect();
      if (rect.width < 16 || rect.height < 16) return;
      void syncBrowserEngine({
        engineId: activeEngineId,
        browserTabId: activeBrowserTabId,
        profileId,
        url,
        preserveExistingPage: true,
        bounds: {
          x: rect.left,
          y: rect.top,
          width: rect.width,
          height: rect.height,
        },
      }).catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes("retry sync shortly")) {
          retryTimer = window.setTimeout(scheduleSync, 250);
          return;
        }
        onError(message);
      });
    };

    const scheduleSync = () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(syncNativeEngine);
    };

    const observer = new ResizeObserver(scheduleSync);
    observer.observe(slot);
    window.addEventListener("resize", scheduleSync);
    scheduleSync();

    return () => {
      disposed = true;
      if (frame !== null) window.cancelAnimationFrame(frame);
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      observer.disconnect();
      window.removeEventListener("resize", scheduleSync);
    };
  }, [enabled, slotRef, activeEngineId, activeBrowserTabId, profileId, url, onError, ...dependencies]);
}
