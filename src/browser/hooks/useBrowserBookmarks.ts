import { useMemo, useRef, useState, type DragEvent, type PointerEvent } from "react";

import { browserApiDeleteJson, browserApiPostJson } from "../api";
import type { BrowserBookmark, BrowserBookmarkToolbarItem } from "../types";
import { bookmarkUrl, compareBookmarksForPanel } from "../browserPresentation";
import type { BrowserWorkflowPreviewSummary } from "../browserWorkflowPreview";

interface BrowserBookmarksOptions {
  actionContext: () => Record<string, unknown>;
  activeTaskId: string | null;
  bookmarkToolbar: BrowserBookmarkToolbarItem[];
  bookmarks: BrowserBookmark[];
  busy: boolean;
  currentPageTitle: string;
  currentPageUrl: string;
  onCloseManager: () => void;
  onOpenManager: () => void;
  onNavigateToUrl: (url: string) => void;
  runBusy: (action: () => Promise<void>) => Promise<void>;
  setError: (message: string | null) => void;
}

export function useBrowserBookmarks(options: BrowserBookmarksOptions) {
  const {
    actionContext,
    activeTaskId,
    bookmarkToolbar,
    bookmarks,
    busy,
    currentPageTitle,
    currentPageUrl,
    onCloseManager,
    onOpenManager,
    onNavigateToUrl,
    runBusy,
    setError,
  } = options;
  const pointerDragRef = useRef<{ bookmarkId: string; startX: number; startY: number } | null>(null);
  const [bookmarkManageMode, setBookmarkManageMode] = useState(false);
  const [bookmarkDraftLabel, setBookmarkDraftLabel] = useState("");
  const [bookmarkDraftUrl, setBookmarkDraftUrl] = useState("");
  const [bookmarkDraftParentId, setBookmarkDraftParentId] = useState("");
  const [bookmarkDeleteId, setBookmarkDeleteId] = useState<string | null>(null);
  const [bookmarkRenameDrafts, setBookmarkRenameDrafts] = useState<Record<string, string>>({});
  const [bookmarkUrlDrafts, setBookmarkUrlDrafts] = useState<Record<string, string>>({});
  const [draggedBookmarkId, setDraggedBookmarkId] = useState<string | null>(null);
  const [workflowPreview, setWorkflowPreview] = useState<BrowserWorkflowPreviewSummary | null>(null);

  const bookmarkFolders = useMemo(
    () => bookmarks.filter((bookmark) => bookmark.kind === "folder"),
    [bookmarks],
  );
  const rootBookmarks = useMemo(
    () => bookmarks.filter((bookmark) => !bookmark.parentId).slice().sort(compareBookmarksForPanel),
    [bookmarks],
  );
  const bookmarkChildrenByParent = useMemo(() => {
    const next = new Map<string, BrowserBookmark[]>();
    for (const bookmark of bookmarks) {
      if (!bookmark.parentId) continue;
      const children = next.get(bookmark.parentId) ?? [];
      children.push(bookmark);
      next.set(bookmark.parentId, children);
    }
    for (const children of next.values()) children.sort(compareBookmarksForPanel);
    return next;
  }, [bookmarks]);

  const nextBookmarkOrder = (parentId: string | null) => bookmarks
    .filter((bookmark) => (bookmark.parentId ?? null) === parentId)
    .length;

  const bookmarkCurrent = () => {
    void runBusy(async () => {
      await browserApiPostJson("/browser/action", {
        ...actionContext(),
        ...(activeTaskId ? { taskId: activeTaskId } : {}),
        action: "bookmarkCurrent",
        url: currentPageUrl,
        value: currentPageTitle,
      });
    });
  };

  const createBookmarkFolder = () => {
    const label = bookmarkDraftLabel.trim() || "New folder";
    const parentId = bookmarkDraftParentId || null;
    void runBusy(async () => {
      await browserApiPostJson("/browser/bookmarks", {
        label,
        kind: "folder",
        parentId,
        toolbarPinned: false,
        toolbarOrder: nextBookmarkOrder(parentId),
      });
      setBookmarkDraftLabel("");
      setBookmarkDeleteId(null);
    });
  };

  const createBookmarkLink = () => {
    const label = bookmarkDraftLabel.trim();
    const url = bookmarkDraftUrl.trim();
    if (!url) {
      setError("Bookmark link needs a URL.");
      return;
    }
    const parentId = bookmarkDraftParentId || null;
    void runBusy(async () => {
      await browserApiPostJson("/browser/bookmarks", {
        label: label || url,
        kind: "link",
        url,
        parentId,
        toolbarPinned: false,
        toolbarOrder: nextBookmarkOrder(parentId),
      });
      setBookmarkDraftLabel("");
      setBookmarkDraftUrl("");
      setBookmarkDraftParentId("");
      setBookmarkDeleteId(null);
    });
  };

  const updateBookmarkRenameDraft = (bookmarkId: string, label: string) => {
    setBookmarkRenameDrafts((current) => ({ ...current, [bookmarkId]: label }));
  };

  const updateBookmarkUrlDraft = (bookmarkId: string, url: string) => {
    setBookmarkUrlDrafts((current) => ({ ...current, [bookmarkId]: url }));
  };

  const resetBookmarkRenameDraft = (bookmarkId: string) => {
    setBookmarkRenameDrafts((current) => {
      const next = { ...current };
      delete next[bookmarkId];
      return next;
    });
  };

  const resetBookmarkUrlDraft = (bookmarkId: string) => {
    setBookmarkUrlDrafts((current) => {
      const next = { ...current };
      delete next[bookmarkId];
      return next;
    });
  };

  const commitBookmarkRename = (bookmark: BrowserBookmark, nextLabel?: string) => {
    const label = (nextLabel ?? bookmarkRenameDrafts[bookmark.bookmarkId] ?? bookmark.label).trim();
    if (!label || label === bookmark.label) {
      resetBookmarkRenameDraft(bookmark.bookmarkId);
      return;
    }
    void runBusy(async () => {
      await browserApiPostJson("/browser/bookmarks", {
        bookmarkId: bookmark.bookmarkId,
        label,
        kind: bookmark.kind,
        url: bookmark.url ?? null,
        category: bookmark.category,
        toolbarPinned: bookmark.toolbarPinned,
        toolbarOrder: bookmark.toolbarOrder ?? null,
      });
      setBookmarkDeleteId(null);
      resetBookmarkRenameDraft(bookmark.bookmarkId);
    });
  };

  const commitBookmarkUrl = (bookmark: BrowserBookmark, nextUrl?: string) => {
    if (bookmark.kind !== "link") return;
    const currentUrl = bookmarkUrl(bookmark);
    const url = (nextUrl ?? bookmarkUrlDrafts[bookmark.bookmarkId] ?? currentUrl).trim();
    if (!url) {
      setError("Bookmark link needs a URL.");
      resetBookmarkUrlDraft(bookmark.bookmarkId);
      return;
    }
    if (url === currentUrl) {
      resetBookmarkUrlDraft(bookmark.bookmarkId);
      return;
    }
    void runBusy(async () => {
      await browserApiPostJson("/browser/bookmarks", {
        bookmarkId: bookmark.bookmarkId,
        label: bookmark.label,
        kind: "link",
        url,
        category: bookmark.category,
        toolbarPinned: bookmark.toolbarPinned,
        toolbarOrder: bookmark.toolbarOrder ?? null,
      });
      setBookmarkDeleteId(null);
      resetBookmarkUrlDraft(bookmark.bookmarkId);
    });
  };

  const toggleBookmarkPin = (bookmark: BrowserBookmark) => {
    void runBusy(async () => {
      await browserApiPostJson("/browser/bookmarks/reorder", {
        items: [{
          bookmarkId: bookmark.bookmarkId,
          parentId: bookmark.parentId ?? null,
          toolbarPinned: !bookmark.toolbarPinned,
          toolbarOrder: bookmark.toolbarPinned ? null : bookmarkToolbar.length,
        }],
      });
      setBookmarkDeleteId(null);
    });
  };

  const reorderBookmarkIntoParent = (
    bookmarkId: string,
    parentId: string | null,
    beforeBookmarkId?: string | null,
  ) => {
    if (!bookmarkId || bookmarkId === beforeBookmarkId) return;
    const source = bookmarks.find((bookmark) => bookmark.bookmarkId === bookmarkId);
    if (!source || parentId === source.bookmarkId) return;
    const siblings = bookmarks
      .filter((bookmark) => (bookmark.parentId ?? "") === (parentId ?? "") && bookmark.bookmarkId !== bookmarkId)
      .slice()
      .sort(compareBookmarksForPanel);
    const targetIndex = beforeBookmarkId
      ? siblings.findIndex((bookmark) => bookmark.bookmarkId === beforeBookmarkId)
      : -1;
    const ordered = siblings.slice();
    ordered.splice(targetIndex >= 0 ? targetIndex : ordered.length, 0, { ...source, parentId });
    void runBusy(async () => {
      await browserApiPostJson("/browser/bookmarks/reorder", {
        items: ordered.map((bookmark, index) => ({
          bookmarkId: bookmark.bookmarkId,
          parentId,
          toolbarPinned: parentId ? false : bookmark.toolbarPinned,
          toolbarOrder: index,
        })),
      });
      setBookmarkDeleteId(null);
      setDraggedBookmarkId(null);
    });
  };

  const dropBookmarkBefore = (event: DragEvent<HTMLElement>, target: BrowserBookmark) => {
    event.preventDefault();
    const bookmarkId = draggedBookmarkId || event.dataTransfer.getData("text/plain");
    if (bookmarkId) reorderBookmarkIntoParent(bookmarkId, target.parentId ?? null, target.bookmarkId);
  };

  const dropBookmarkIntoFolder = (event: DragEvent<HTMLElement>, folder: BrowserBookmark) => {
    event.preventDefault();
    event.stopPropagation();
    const bookmarkId = draggedBookmarkId || event.dataTransfer.getData("text/plain");
    if (bookmarkId && bookmarkId !== folder.bookmarkId) {
      reorderBookmarkIntoParent(bookmarkId, folder.bookmarkId, null);
    }
  };

  function cancelBookmarkPointerDrag() {
    pointerDragRef.current = null;
    window.removeEventListener("pointerup", finishBookmarkPointerDrag);
    window.removeEventListener("pointercancel", cancelBookmarkPointerDrag);
    setDraggedBookmarkId(null);
  }

  function finishBookmarkPointerDrag(event: globalThis.PointerEvent) {
    const drag = pointerDragRef.current;
    pointerDragRef.current = null;
    if (!drag) return;
    window.removeEventListener("pointerup", finishBookmarkPointerDrag);
    window.removeEventListener("pointercancel", cancelBookmarkPointerDrag);
    const moved = Math.abs(event.clientX - drag.startX) + Math.abs(event.clientY - drag.startY);
    const target = document.elementFromPoint(event.clientX, event.clientY);
    const folderTarget = target?.closest("[data-bookmark-folder-target-id]") as HTMLElement | null;
    if (folderTarget) {
      const parentId = folderTarget.dataset.bookmarkFolderTargetId || null;
      if (parentId !== drag.bookmarkId) {
        reorderBookmarkIntoParent(drag.bookmarkId, parentId, null);
        return;
      }
    }
    const rowTarget = target?.closest("[data-bookmark-row-id]") as HTMLElement | null;
    const targetBookmarkId = rowTarget?.dataset.bookmarkRowId ?? null;
    if (moved > 4 && targetBookmarkId && targetBookmarkId !== drag.bookmarkId) {
      const targetBookmark = bookmarks.find((bookmark) => bookmark.bookmarkId === targetBookmarkId);
      if (targetBookmark) {
        reorderBookmarkIntoParent(drag.bookmarkId, targetBookmark.parentId ?? null, targetBookmark.bookmarkId);
        return;
      }
    }
    setDraggedBookmarkId(null);
  }

  const startBookmarkDrag = (event: DragEvent<HTMLElement>, bookmark: BrowserBookmark) => {
    if (busy) {
      event.preventDefault();
      return;
    }
    setDraggedBookmarkId(bookmark.bookmarkId);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", bookmark.bookmarkId);
  };

  const startBookmarkPointerDrag = (event: PointerEvent<HTMLButtonElement>, bookmark: BrowserBookmark) => {
    if (busy) {
      event.preventDefault();
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    pointerDragRef.current = {
      bookmarkId: bookmark.bookmarkId,
      startX: event.clientX,
      startY: event.clientY,
    };
    setDraggedBookmarkId(bookmark.bookmarkId);
    window.removeEventListener("pointerup", finishBookmarkPointerDrag);
    window.removeEventListener("pointercancel", cancelBookmarkPointerDrag);
    window.addEventListener("pointerup", finishBookmarkPointerDrag);
    window.addEventListener("pointercancel", cancelBookmarkPointerDrag);
  };

  const previewWorkflow = (bookmark: BrowserBookmark | BrowserBookmarkToolbarItem) => {
    const recipePath = bookmark.agentWorkflow?.recipePath?.trim();
    if (!recipePath) return false;
    onOpenManager();
    setWorkflowPreview({
      bookmarkId: bookmark.bookmarkId,
      status: "loading",
      stepsPlanned: 0,
      stepsSkipped: 0,
      decisionPoints: 0,
    });
    void runBusy(async () => {
      try {
        const response = await browserApiPostJson<unknown>("/browser/recipes/replay", {
          recipePath,
          dryRun: true,
          reason: "ShellX operator previewed a saved Browser workflow",
        });
        const { parseBrowserWorkflowPreview } = await import("../browserWorkflowPreview");
        setWorkflowPreview(parseBrowserWorkflowPreview(bookmark.bookmarkId, response));
      } catch {
        setWorkflowPreview({
          bookmarkId: bookmark.bookmarkId,
          status: "error",
          stepsPlanned: 0,
          stepsSkipped: 0,
          decisionPoints: 0,
        });
      }
    });
    return true;
  };

  const openBookmark = (bookmark: BrowserBookmark | BrowserBookmarkToolbarItem) => {
    if (previewWorkflow(bookmark)) return;
    const url = bookmarkUrl(bookmark);
    if (!url) return;
    onCloseManager();
    onNavigateToUrl(url);
  };

  const deleteBookmark = (bookmark: BrowserBookmark) => {
    if (bookmarkDeleteId !== bookmark.bookmarkId) {
      setBookmarkDeleteId(bookmark.bookmarkId);
      return;
    }
    void runBusy(async () => {
      await browserApiDeleteJson(`/browser/bookmarks/${encodeURIComponent(bookmark.bookmarkId)}`);
      setBookmarkDeleteId(null);
    });
  };

  return {
    bookmarkChildrenByParent,
    bookmarkCurrent,
    bookmarkDeleteId,
    bookmarkDraftLabel,
    bookmarkDraftParentId,
    bookmarkDraftUrl,
    bookmarkFolders,
    bookmarkManageMode,
    bookmarkRenameDrafts,
    bookmarkUrlDrafts,
    commitBookmarkRename,
    commitBookmarkUrl,
    createBookmarkFolder,
    createBookmarkLink,
    deleteBookmark,
    draggedBookmarkId,
    dropBookmarkBefore,
    dropBookmarkIntoFolder,
    openBookmark,
    resetBookmarkRenameDraft,
    resetBookmarkUrlDraft,
    rootBookmarks,
    setBookmarkDraftLabel,
    setBookmarkDraftParentId,
    setBookmarkDraftUrl,
    setBookmarkManageMode,
    startBookmarkDrag,
    startBookmarkPointerDrag,
    toggleBookmarkPin,
    updateBookmarkRenameDraft,
    updateBookmarkUrlDraft,
    workflowPreview,
  };
}
