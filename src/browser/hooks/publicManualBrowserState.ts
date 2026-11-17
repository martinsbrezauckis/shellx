import {
  isPublicManualPreview,
  isTrustedPublicManualParentMessage,
  notifyPublicManualPreviewReady,
  parsePublicManualPreviewRequest,
} from "../../lib/public-manual-preview";
import type {
  BrowserHeaderMenuId,
  BrowserRightPanelId,
  PublicManualBrowserStateOptions,
} from "./usePublicManualBrowserState";
import type { DebugHighlightRequest } from "../../components/DebugHighlightOverlay";

/** Install the bounded public-manual state receiver after React is mounted. */
export function installPublicManualBrowserState(options: PublicManualBrowserStateOptions): () => void {
  if (!isPublicManualPreview()) return () => undefined;
  const setHighlights = (globalThis as typeof globalThis & {
    __SHELLX_PUBLIC_MANUAL_SET_BROWSER_HIGHLIGHTS__?: (items: DebugHighlightRequest[]) => void;
  }).__SHELLX_PUBLIC_MANUAL_SET_BROWSER_HIGHLIGHTS__;
  let highlightSequence = 0;
  const onMessage = (event: MessageEvent): void => {
    if (!isTrustedPublicManualParentMessage(event)) return;
    const request = parsePublicManualPreviewRequest(event.data);
    if (!request || !request.stateId.startsWith("browser-")) return;
    const currentHighlightSequence = ++highlightSequence;
    setHighlights?.([]);

    options.setHeaderMenu(null);
    options.setOptionsOpen(false);
    options.setBookmarkManagerOpen(false);
    options.setBookmarkManageMode(false);
    options.setShowRightSidebar(true);
    options.setRightPanelTab("chat");

    const menuByState: Partial<Record<string, BrowserHeaderMenuId>> = {
      "browser-save-menu": "save",
      "browser-save-copy-jobs": "save",
      "browser-ads-menu": "ads",
      "browser-history": "history",
      "browser-downloads": "downloads",
    };
    const panelByState: Partial<Record<string, BrowserRightPanelId>> = {
      "browser-panel-requests": "requests",
      "browser-panel-actions": "actions",
      "browser-panel-evidence": "evidence",
      "browser-panel-errors": "errors",
    };
    const menu = menuByState[request.stateId];
    const panel = panelByState[request.stateId];
    if (menu) options.setHeaderMenu(menu);
    if (panel) options.setRightPanelTab(panel);
    if (request.stateId === "browser-options") options.setOptionsOpen(true);
    if (request.stateId === "browser-bookmarks" || request.stateId === "browser-bookmark-manager") {
      options.setBookmarkManagerOpen(true);
      options.setBookmarkManageMode(request.stateId === "browser-bookmark-manager");
    }

    const revealHighlight = (attempt: number): void => {
      if (currentHighlightSequence !== highlightSequence || !request.focusDebugId) return;
      const selector = `[data-debug-id="${request.focusDebugId}"]`;
      const target = document.querySelector<HTMLElement>(selector);
      if (!target && attempt < 4) {
        window.setTimeout(() => revealHighlight(attempt + 1), [100, 180, 320, 560][attempt]);
        return;
      }
      if (!target) return;
      const rect = target.getBoundingClientRect();
      if (rect.top < 0 || rect.left < 0 || rect.bottom > window.innerHeight || rect.right > window.innerWidth) {
        target.scrollIntoView({ block: "nearest", inline: "nearest" });
      }
      setHighlights?.([{
        id: "public-manual-selection",
        selector,
        label: request.highlightLabel ?? "Selected feature",
        color: request.highlightColor ?? "blue",
      }]);
    };
    window.setTimeout(() => revealHighlight(0), 100);
  };
  window.addEventListener("message", onMessage);
  notifyPublicManualPreviewReady();
  return () => window.removeEventListener("message", onMessage);
}
