import { useEffect, useRef, type Dispatch, type SetStateAction } from "react";

export type BrowserHeaderMenuId = "history" | "save" | "ads" | "shields" | "downloads" | "vaultFill";
export type BrowserRightPanelId = "chat" | "requests" | "actions" | "evidence" | "errors";

export interface PublicManualBrowserStateOptions {
  setBookmarkManageMode: (value: boolean) => void;
  setBookmarkManagerOpen: Dispatch<SetStateAction<boolean>>;
  setHeaderMenu: Dispatch<SetStateAction<BrowserHeaderMenuId | null>>;
  setOptionsOpen: Dispatch<SetStateAction<boolean>>;
  setRightPanelTab: Dispatch<SetStateAction<BrowserRightPanelId>>;
  setShowRightSidebar: Dispatch<SetStateAction<boolean>>;
}

/** Keep the production Browser entry lean; manual-only state logic is lazy. */
export function usePublicManualBrowserState(options: PublicManualBrowserStateOptions): void {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  useEffect(() => {
    if (!import.meta.env.SHELLX_PUBLIC_MANUAL_BUILD && !import.meta.env.DEV) return;
    let cleanup: (() => void) | undefined;
    let disposed = false;
    void import("./publicManualBrowserState").then(({ installPublicManualBrowserState }) => {
      if (disposed) return;
      cleanup = installPublicManualBrowserState(optionsRef.current);
    });
    return () => {
      disposed = true;
      cleanup?.();
    };
  }, []);
}
