import type { DragEvent, JSX, PointerEvent } from "react";

import type {
  BrowserBookmark,
  BrowserBookmarkAgentWorkflow,
} from "../types";
import type { BrowserWorkflowPreviewSummary } from "../browserWorkflowPreview";
import {
  browserWorkflowBadgeLabel,
  browserWorkflowNeedsRefresh,
} from "../browserWorkflowPresentation";
import { ShellIcon } from "../../components/icons";
import "../browserWorkflows.css";

type BookmarkUrlResolver = (bookmark: { url?: string | null }) => string;

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
  workflowPreview: BrowserWorkflowPreviewSummary | null;
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

export default function BookmarkSidecar({
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
  workflowPreview,
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

  const renderWorkflowBadges = (workflow?: BrowserBookmarkAgentWorkflow | null): JSX.Element | null => {
    if (!workflow) return null;
    return (
      <span className="shellx-browser-bookmark-workflow-badges">
        <span className="shellx-browser-bookmark-workflow-badge">
          {browserWorkflowBadgeLabel(workflow)}
        </span>
        {browserWorkflowNeedsRefresh(workflow) && (
          <span className="shellx-browser-bookmark-refresh-badge">Refresh suggested</span>
        )}
      </span>
    );
  };

  const renderBookmarkListRow = (bookmark: BrowserBookmark, depth = 0): JSX.Element => {
    const url = bookmarkUrl(bookmark);
    const hasWorkflow = Boolean(bookmark.agentWorkflow?.recipePath?.trim());
    const children = bookmarkChildrenByParent.get(bookmark.bookmarkId) ?? [];
    const detail = bookmark.kind === "folder"
      ? `${children.length} item${children.length === 1 ? "" : "s"}`
      : bookmark.agentWorkflow?.goal?.trim() || url || bookmark.category;
    const content = (
      <>
        <ShellIcon name={hasWorkflow ? "play" : bookmark.kind === "folder" ? "folder" : "bookmark"} size={13} />
        <span>{bookmark.label}</span>
        <small>{detail}</small>
        {renderWorkflowBadges(bookmark.agentWorkflow)}
      </>
    );
    return (
      <div
        key={bookmark.bookmarkId}
        className="shellx-browser-bookmark-list-item"
        style={{ marginLeft: depth ? depth * 16 : 0 }}
      >
        {url || hasWorkflow ? (
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
    const hasWorkflow = Boolean(bookmark.agentWorkflow?.recipePath?.trim());
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
              {renderWorkflowBadges(bookmark.agentWorkflow)}
            </div>
          </div>
          <div className="shellx-browser-bookmark-row-actions">
            {(url || hasWorkflow) && (
              <button data-debug-id="surface-browser-components-bookmarksidecar-5"
                type="button"
                className="shellx-browser-bookmark-icon-action"
                onClick={() => onOpenBookmark(bookmark)}
                disabled={busy}
                title={hasWorkflow ? `Preview ${bookmark.label}` : `Open ${bookmark.label}`}
                aria-label={hasWorkflow ? `Preview ${bookmark.label}` : `Open ${bookmark.label}`}
              >
                <ShellIcon name={hasWorkflow ? "play" : "external-link"} size={13} />
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
    <aside
      id="shellx-browser-bookmark-manager-dock"
      className="shellx-browser-left-sidecar shellx-browser-bookmark-manager-dock shellx-browser-bookmark-sidecar"
      data-debug-id="shellx-browser-bookmark-manager-dock"
      aria-labelledby="shellx-browser-bookmarks-menu"
    >
      <div className="shellx-browser-bookmark-manager-head">
        <h2>{bookmarkManageMode ? "Bookmark manager" : "Bookmarks"}</h2>
        <button
          type="button"
          className="shellx-browser-icon-btn"
          onClick={() => onSetBookmarkManagerOpen(false)}
          data-debug-id="shellx-browser-bookmark-manager-close"
          title="Close bookmarks"
          aria-label="Close bookmarks"
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
              aria-pressed={!bookmarkManageMode}
              data-shellx-release-observe="pressed"
            >
              List
            </button>
            <button
              type="button"
              className={bookmarkManageMode ? "active" : ""}
              onClick={() => onSetBookmarkManageMode(true)}
              data-debug-id="shellx-browser-bookmark-manager-toggle"
              aria-pressed={bookmarkManageMode}
              data-shellx-release-observe="pressed"
            >
              Edit
            </button>
          </div>
        </div>
      </div>
      {workflowPreview && (
        <div
          className={`shellx-browser-workflow-preview ${workflowPreview.status === "error" ? "error" : ""}`}
          role="status"
          aria-live="polite"
          data-debug-id="shellx-browser-workflow-preview"
        >
          <strong>Workflow preview</strong>
          <span>
            {workflowPreview.status === "loading"
              ? "Checking the saved workflow without performing actions…"
              : workflowPreview.status === "error"
                ? "The workflow could not be safely previewed."
                : `${workflowPreview.stepsPlanned} planned · ${workflowPreview.stepsSkipped} live recovery · ${workflowPreview.decisionPoints} decisions`}
          </span>
        </div>
      )}
      {bookmarkManageMode ? (
        <section className="shellx-browser-bookmark-manager" data-debug-id="shellx-browser-bookmark-manager">
          <div className="shellx-browser-bookmark-editor">
            <input
              value={bookmarkDraftLabel}
              onChange={(event) => onDraftLabelChange(event.currentTarget.value)}
              placeholder="Name"
              aria-label="Bookmark name"
              data-debug-id="shellx-browser-bookmark-draft-label"
              data-shellx-release-observe="value"
            />
            <input
              value={bookmarkDraftUrl}
              onChange={(event) => onDraftUrlChange(event.currentTarget.value)}
              placeholder="https://example.com"
              aria-label="Bookmark URL"
              data-debug-id="shellx-browser-bookmark-draft-url"
              data-shellx-release-observe="value"
            />
            <select
              value={bookmarkDraftParentId}
              onChange={(event) => onDraftParentChange(event.currentTarget.value)}
              aria-label="Save new bookmark in"
              data-debug-id="shellx-browser-bookmark-draft-folder"
              data-shellx-release-observe="value"
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
