import type { DragEvent, JSX, PointerEvent } from "react";

import type { BrowserBookmark, BrowserBookmarkToolbarItem } from "../types";
import { ShellIcon } from "../../components/icons";

type BookmarkUrlResolver = (bookmark: { url?: string | null }) => string;

interface BookmarkToolbarProps {
  bookmarkToolbar: BrowserBookmarkToolbarItem[];
  openToolbarFolder: BrowserBookmarkToolbarItem | null;
  openToolbarFolderId: string | null;
  bookmarkUrl: BookmarkUrlResolver;
  onNavigateToToolbarUrl: (url: string) => void;
  onSetOpenToolbarFolderId: (updater: string | null | ((current: string | null) => string | null)) => void;
}

export function BookmarkToolbar({
  bookmarkToolbar,
  openToolbarFolder,
  openToolbarFolderId,
  bookmarkUrl,
  onNavigateToToolbarUrl,
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
                onClick={() => {
                  const url = bookmarkUrl(item);
                  if (url) onNavigateToToolbarUrl(url);
                }}
                disabled={!bookmarkUrl(item)}
                data-debug-id={`shellx-browser-bookmark-toolbar-link-${item.bookmarkId}`}
                title={item.label}
              >
                <ShellIcon name="bookmark" size={14} />
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
            return (
              <button
                key={child.bookmarkId}
                type="button"
                onClick={() => {
                  if (!url) return;
                  onSetOpenToolbarFolderId(null);
                  onNavigateToToolbarUrl(url);
                }}
                disabled={!url}
                data-debug-id={`shellx-browser-bookmark-folder-child-${child.bookmarkId}`}
              >
                <ShellIcon name={child.kind === "folder" ? "folder" : "bookmark"} size={13} />
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

interface BookmarkSidecarProps {
  open: boolean;
  busy: boolean;
  bookmarkManageMode: boolean;
  bookmarks: BrowserBookmark[];
  rootBookmarks: BrowserBookmark[];
  bookmarkFolders: BrowserBookmark[];
  bookmarkChildrenByParent: Map<string, BrowserBookmark[]>;
  bookmarkDraftLabel: string;
  bookmarkDraftUrl: string;
  bookmarkDraftParentId: string;
  bookmarkDeleteId: string | null;
  bookmarkRenameDrafts: Record<string, string>;
  bookmarkUrlDrafts: Record<string, string>;
  draggedBookmarkId: string | null;
  bookmarkUrl: BookmarkUrlResolver;
  onOpenBookmark: (bookmark: BrowserBookmark) => void;
  onToggleBookmarkPin: (bookmark: BrowserBookmark) => void;
  onCreateFolder: () => void;
  onCreateLink: () => void;
  onDraftLabelChange: (label: string) => void;
  onDraftUrlChange: (url: string) => void;
  onDraftParentChange: (parentId: string) => void;
  onRenameDraftChange: (bookmarkId: string, label: string) => void;
  onResetRenameDraft: (bookmarkId: string) => void;
  onUrlDraftChange: (bookmarkId: string, url: string) => void;
  onResetUrlDraft: (bookmarkId: string) => void;
  onCommitRename: (bookmark: BrowserBookmark, label?: string) => void;
  onCommitUrl: (bookmark: BrowserBookmark, url?: string) => void;
  onDeleteBookmark: (bookmark: BrowserBookmark) => void;
  onDropBookmarkBefore: (event: DragEvent<HTMLElement>, target: BrowserBookmark) => void;
  onDropBookmarkIntoFolder: (event: DragEvent<HTMLElement>, folder: BrowserBookmark) => void;
  onStartBookmarkDrag: (event: DragEvent<HTMLElement>, bookmark: BrowserBookmark) => void;
  onStartBookmarkPointerDrag: (event: PointerEvent<HTMLButtonElement>, bookmark: BrowserBookmark) => void;
  onSetBookmarkManagerOpen: (open: boolean) => void;
  onSetBookmarkManageMode: (manage: boolean) => void;
}

export function BookmarkSidecar({
  open,
  busy,
  bookmarkManageMode,
  bookmarks,
  rootBookmarks,
  bookmarkFolders,
  bookmarkChildrenByParent,
  bookmarkDraftLabel,
  bookmarkDraftUrl,
  bookmarkDraftParentId,
  bookmarkDeleteId,
  bookmarkRenameDrafts,
  bookmarkUrlDrafts,
  draggedBookmarkId,
  bookmarkUrl,
  onOpenBookmark,
  onToggleBookmarkPin,
  onCreateFolder,
  onCreateLink,
  onDraftLabelChange,
  onDraftUrlChange,
  onDraftParentChange,
  onRenameDraftChange,
  onResetRenameDraft,
  onUrlDraftChange,
  onResetUrlDraft,
  onCommitRename,
  onCommitUrl,
  onDeleteBookmark,
  onDropBookmarkBefore,
  onDropBookmarkIntoFolder,
  onStartBookmarkDrag,
  onStartBookmarkPointerDrag,
  onSetBookmarkManagerOpen,
  onSetBookmarkManageMode,
}: BookmarkSidecarProps): JSX.Element | null {
  if (!open) return null;

  const renderBookmarkListRow = (bookmark: BrowserBookmark, depth = 0): JSX.Element => {
    const url = bookmarkUrl(bookmark);
    const children = bookmarkChildrenByParent.get(bookmark.bookmarkId) ?? [];
    const detail = bookmark.kind === "folder"
      ? `${children.length} item${children.length === 1 ? "" : "s"}`
      : url || bookmark.category;
    const content = (
      <>
        <ShellIcon name={bookmark.kind === "folder" ? "folder" : "bookmark"} size={13} />
        <span>{bookmark.label}</span>
        <small>{detail}</small>
      </>
    );
    return (
      <div
        key={bookmark.bookmarkId}
        className="shellx-browser-bookmark-list-item"
        style={{ marginLeft: depth ? depth * 16 : 0 }}
      >
        {url ? (
          <button
            type="button"
            className="shellx-browser-bookmark-list-row"
            onClick={() => onOpenBookmark(bookmark)}
            data-debug-id={`shellx-browser-bookmark-${bookmark.bookmarkId}`}
          >
            {content}
          </button>
        ) : (
          <div
            className="shellx-browser-bookmark-list-row folder"
            data-debug-id={`shellx-browser-bookmark-${bookmark.bookmarkId}`}
          >
            {content}
          </div>
        )}
        {children.length > 0 && (
          <div className="shellx-browser-bookmark-list-children">
            {children.map((child) => renderBookmarkListRow(child, depth + 1))}
          </div>
        )}
      </div>
    );
  };

  const renderBookmarkManagerRow = (bookmark: BrowserBookmark, depth = 0): JSX.Element => {
    const url = bookmarkUrl(bookmark);
    const children = bookmarkChildrenByParent.get(bookmark.bookmarkId) ?? [];
    const renameValue = bookmarkRenameDrafts[bookmark.bookmarkId] ?? bookmark.label;
    return (
      <div
        key={bookmark.bookmarkId}
        className={`shellx-browser-bookmark-manager-node ${draggedBookmarkId === bookmark.bookmarkId ? "dragging" : ""}`}
        style={{ marginLeft: depth ? depth * 12 : 0 }}
      >
        <div
          className="shellx-browser-bookmark-manager-row"
          data-debug-id={`shellx-browser-bookmark-manager-row-${bookmark.bookmarkId}`}
          data-bookmark-row-id={bookmark.bookmarkId}
          onDragOver={(event) => {
            event.preventDefault();
            event.dataTransfer.dropEffect = "move";
          }}
          onDrop={(event) => onDropBookmarkBefore(event, bookmark)}
        >
          <button
            type="button"
            className="shellx-browser-bookmark-drag"
            draggable={!busy}
            onDragStart={(event) => onStartBookmarkDrag(event, bookmark)}
            onPointerDown={(event) => onStartBookmarkPointerDrag(event, bookmark)}
            disabled={busy}
            title="Drag to sort"
            aria-label={`Drag ${bookmark.label}`}
            data-debug-id={`shellx-browser-bookmark-drag-${bookmark.bookmarkId}`}
          >
            <ShellIcon name="chevrons-right" size={12} />
          </button>
          <div
            className="shellx-browser-bookmark-row-main"
            onDragOver={bookmark.kind === "folder" ? (event) => {
              event.preventDefault();
              event.dataTransfer.dropEffect = "move";
            } : undefined}
            onDrop={bookmark.kind === "folder" ? (event) => onDropBookmarkIntoFolder(event, bookmark) : undefined}
            data-debug-id={`shellx-browser-bookmark-manager-open-${bookmark.bookmarkId}`}
            data-bookmark-folder-target-id={bookmark.kind === "folder" ? bookmark.bookmarkId : undefined}
          >
            <ShellIcon name={bookmark.kind === "folder" ? "folder" : "bookmark"} size={13} />
            <div className="shellx-browser-bookmark-row-fields">
              <input
                value={renameValue}
                onChange={(event) => onRenameDraftChange(bookmark.bookmarkId, event.currentTarget.value)}
                onBlur={(event) => onCommitRename(bookmark, event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.currentTarget.blur();
                  } else if (event.key === "Escape") {
                    onResetRenameDraft(bookmark.bookmarkId);
                    event.currentTarget.blur();
                  }
                }}
                disabled={busy}
                aria-label={`Rename ${bookmark.label}`}
                data-debug-id={`shellx-browser-bookmark-label-${bookmark.bookmarkId}`}
              />
              {bookmark.kind === "link" ? (
                <input
                  className="shellx-browser-bookmark-url-input"
                  value={bookmarkUrlDrafts[bookmark.bookmarkId] ?? url}
                  onChange={(event) => onUrlDraftChange(bookmark.bookmarkId, event.currentTarget.value)}
                  onBlur={(event) => onCommitUrl(bookmark, event.currentTarget.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.currentTarget.blur();
                    } else if (event.key === "Escape") {
                      onResetUrlDraft(bookmark.bookmarkId);
                      event.currentTarget.blur();
                    }
                  }}
                  disabled={busy}
                  aria-label={`Edit URL for ${bookmark.label}`}
                  data-debug-id={`shellx-browser-bookmark-url-${bookmark.bookmarkId}`}
                />
              ) : (
                <small>
                  {children.length} item{children.length === 1 ? "" : "s"}
                </small>
              )}
            </div>
          </div>
          <div className="shellx-browser-bookmark-row-actions">
            {url && (
              <button
                type="button"
                className="shellx-browser-bookmark-icon-action"
                onClick={() => onOpenBookmark(bookmark)}
                disabled={busy}
                title={`Open ${bookmark.label}`}
                aria-label={`Open ${bookmark.label}`}
              >
                <ShellIcon name="external-link" size={13} />
              </button>
            )}
            <button
              type="button"
              className="shellx-browser-bookmark-icon-action"
              onClick={() => onToggleBookmarkPin(bookmark)}
              disabled={busy || Boolean(bookmark.parentId)}
              title={bookmark.parentId ? "Move to top level to show in toolbar" : bookmark.toolbarPinned ? "Hide from toolbar" : "Show in toolbar"}
              aria-label={bookmark.parentId ? `Move ${bookmark.label} to top level before adding to toolbar` : bookmark.toolbarPinned ? `Hide ${bookmark.label}` : `Show ${bookmark.label} in toolbar`}
              data-debug-id={`shellx-browser-bookmark-pin-${bookmark.bookmarkId}`}
            >
              <ShellIcon name={bookmark.toolbarPinned ? "star" : "bookmark"} size={13} />
            </button>
            <button
              type="button"
              className="shellx-browser-bookmark-icon-action"
              onClick={() => onDeleteBookmark(bookmark)}
              disabled={busy}
              title={bookmarkDeleteId === bookmark.bookmarkId ? "Confirm delete" : "Delete"}
              aria-label={bookmarkDeleteId === bookmark.bookmarkId ? `Confirm delete ${bookmark.label}` : `Delete ${bookmark.label}`}
              data-debug-id={`shellx-browser-bookmark-delete-${bookmark.bookmarkId}`}
            >
              <ShellIcon name={bookmarkDeleteId === bookmark.bookmarkId ? "check" : "trash"} size={13} />
            </button>
          </div>
        </div>
        {children.length > 0 && (
          <div className="shellx-browser-bookmark-manager-children">
            {children.map((child) => renderBookmarkManagerRow(child, depth + 1))}
          </div>
        )}
      </div>
    );
  };

  return (
    <aside className="shellx-browser-left-sidecar shellx-browser-bookmark-manager-dock shellx-browser-bookmark-sidecar" data-debug-id="shellx-browser-bookmark-manager-dock">
      <div className="shellx-browser-bookmark-manager-head">
        <h2>{bookmarkManageMode ? "Bookmark manager" : "Bookmarks"}</h2>
        <button
          type="button"
          className="shellx-browser-icon-btn"
          onClick={() => onSetBookmarkManagerOpen(false)}
          data-debug-id="shellx-browser-bookmark-manager-close"
          title="Close bookmarks"
        >
          <ShellIcon name="close" size={14} />
        </button>
        <div className="shellx-browser-bookmark-manager-actions">
          <div className="shellx-browser-menu-tabs shellx-browser-bookmark-mode" aria-label="Bookmark view">
            <button
              type="button"
              className={!bookmarkManageMode ? "active" : ""}
              onClick={() => onSetBookmarkManageMode(false)}
              data-debug-id="shellx-browser-bookmark-list-mode"
            >
              List
            </button>
            <button
              type="button"
              className={bookmarkManageMode ? "active" : ""}
              onClick={() => onSetBookmarkManageMode(true)}
              data-debug-id="shellx-browser-bookmark-manager-toggle"
            >
              Edit
            </button>
          </div>
        </div>
      </div>
      {bookmarkManageMode ? (
        <section className="shellx-browser-bookmark-manager" data-debug-id="shellx-browser-bookmark-manager">
          <div className="shellx-browser-bookmark-editor">
            <input
              value={bookmarkDraftLabel}
              onChange={(event) => onDraftLabelChange(event.currentTarget.value)}
              placeholder="Name"
              aria-label="Bookmark name"
              data-debug-id="shellx-browser-bookmark-draft-label"
            />
            <input
              value={bookmarkDraftUrl}
              onChange={(event) => onDraftUrlChange(event.currentTarget.value)}
              placeholder="https://example.com"
              aria-label="Bookmark URL"
              data-debug-id="shellx-browser-bookmark-draft-url"
            />
            <select
              value={bookmarkDraftParentId}
              onChange={(event) => onDraftParentChange(event.currentTarget.value)}
              aria-label="Save new bookmark in"
              data-debug-id="shellx-browser-bookmark-draft-folder"
            >
              <option value="">Top level</option>
              {bookmarkFolders.map((folder) => (
                <option key={folder.bookmarkId} value={folder.bookmarkId}>
                  {folder.label}
                </option>
              ))}
            </select>
            <div className="shellx-browser-bookmark-editor-actions">
              <button type="button" className="shellx-browser-icon-btn" onClick={onCreateFolder} disabled={busy} title="New folder" aria-label="New folder">
                <ShellIcon name="folder" size={13} />
              </button>
              <button type="button" className="shellx-browser-icon-btn" onClick={onCreateLink} disabled={busy || !bookmarkDraftUrl.trim()} title="Add link" aria-label="Add link">
                <ShellIcon name="plus" size={13} />
              </button>
            </div>
          </div>
          <div className="shellx-browser-bookmark-manager-list">
            {rootBookmarks.map((bookmark) => renderBookmarkManagerRow(bookmark))}
            {bookmarks.length === 0 && <div className="shellx-browser-empty-state">No bookmarks yet</div>}
          </div>
        </section>
      ) : (
        <section className="shellx-browser-bookmark-browser" data-debug-id="shellx-browser-bookmark-list">
          <div className="shellx-browser-bookmark-list">
            {rootBookmarks.map((bookmark) => renderBookmarkListRow(bookmark))}
            {bookmarks.length === 0 && <div className="shellx-browser-empty-state">No bookmarks yet</div>}
          </div>
        </section>
      )}
    </aside>
  );
}
