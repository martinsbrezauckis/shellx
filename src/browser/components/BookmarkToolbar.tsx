import type { JSX } from "react";

import type { BrowserBookmark, BrowserBookmarkToolbarItem } from "../types";
import { ShellIcon } from "../../components/icons";

type BookmarkUrlResolver = (bookmark: { url?: string | null }) => string;

interface BookmarkToolbarProps {
  bookmarkToolbar: BrowserBookmarkToolbarItem[];
  openToolbarFolder: BrowserBookmarkToolbarItem | null;
  openToolbarFolderId: string | null;
  bookmarkUrl: BookmarkUrlResolver;
  onOpenToolbarBookmark: (bookmark: BrowserBookmarkToolbarItem | BrowserBookmark) => void;
  onSetOpenToolbarFolderId: (updater: string | null | ((current: string | null) => string | null)) => void;
}

export function BookmarkToolbar({
  bookmarkToolbar,
  openToolbarFolder,
  openToolbarFolderId,
  bookmarkUrl,
  onOpenToolbarBookmark,
  onSetOpenToolbarFolderId,
}: BookmarkToolbarProps): JSX.Element | null {
  if (bookmarkToolbar.length === 0 && !openToolbarFolder) return null;

  return (
    <>
      {bookmarkToolbar.length > 0 && (
        <nav className="shellx-browser-bookmark-toolbar" data-debug-id="shellx-browser-bookmark-toolbar" aria-label="Bookmark toolbar">
          {bookmarkToolbar.map((item) =>
            item.kind === "folder" ? (
              <div key={item.bookmarkId} className="shellx-browser-bookmark-folder">
                <button
                  type="button"
                  className={openToolbarFolderId === item.bookmarkId ? "active" : ""}
                  onClick={() => onSetOpenToolbarFolderId((current) => (current === item.bookmarkId ? null : item.bookmarkId))}
                  data-debug-id={`shellx-browser-bookmark-folder-${item.bookmarkId}`}
                  title={item.label}
                  aria-expanded={openToolbarFolderId === item.bookmarkId}
                >
                  <ShellIcon name="folder" size={14} />
                  <span>{item.label}</span>
                </button>
              </div>
            ) : (
              <button
                key={item.bookmarkId}
                type="button"
                className="shellx-browser-bookmark-toolbar-link"
                onClick={() => onOpenToolbarBookmark(item)}
                disabled={!bookmarkUrl(item) && !item.agentWorkflow?.recipePath?.trim()}
                data-debug-id={`shellx-browser-bookmark-toolbar-link-${item.bookmarkId}`}
                title={item.label}
              >
                <ShellIcon name={item.agentWorkflow?.recipePath ? "play" : "bookmark"} size={14} />
                <span>{item.label}</span>
              </button>
            ),
          )}
        </nav>
      )}

      {openToolbarFolder && (
        <section
          className="shellx-browser-bookmark-folder-menu shellx-browser-bookmark-folder-menu-dock"
          data-debug-id={`shellx-browser-bookmark-folder-menu-${openToolbarFolder.bookmarkId}`}
          aria-label={`${openToolbarFolder.label} bookmarks`}
        >
          {openToolbarFolder.children.map((child) => {
            const url = bookmarkUrl(child);
            const hasWorkflow = Boolean(child.agentWorkflow?.recipePath?.trim());
            return (
              <button
                key={child.bookmarkId}
                type="button"
                onClick={() => {
                  if (!url && !hasWorkflow) return;
                  onSetOpenToolbarFolderId(null);
                  onOpenToolbarBookmark(child);
                }}
                disabled={!url && !hasWorkflow}
                data-debug-id={`shellx-browser-bookmark-folder-child-${child.bookmarkId}`}
              >
                <ShellIcon name={hasWorkflow ? "play" : child.kind === "folder" ? "folder" : "bookmark"} size={13} />
                <span>{child.label}</span>
              </button>
            );
          })}
          {openToolbarFolder.children.length === 0 && <div className="shellx-browser-empty-state">Empty folder</div>}
        </section>
      )}
    </>
  );
}
