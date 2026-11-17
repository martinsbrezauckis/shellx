import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState, type JSX } from "react";

import {
  isSessionHistoryIndexing,
  newerSessionHistoryPageTarget,
  olderSessionHistoryPageTarget,
  parseSessionHistoryPage,
  sessionHistoryIndexingProgressLabel,
  sessionHistoryIndexingRetryDelay,
  sessionHistoryLoadError,
  type LoadedSessionHistoryPage,
  type SessionJsonlPageCursor,
  type SessionJsonlPageResponse,
} from "../lib/session-history-page";
import { inTauri } from "../lib/tauri-bridge";
import { useModalFocus } from "../lib/useModalFocus";
import { ShellIcon } from "./icons";

export type SessionHistoryPageRenderer = (
  page: LoadedSessionHistoryPage | null,
  onPreviewFile: (path: string) => void,
) => JSX.Element;

const SESSION_HISTORY_OMISSION_REASON_TEXT: Record<string, string> = {
  legacyBoundaryUnavailable: "This page starts inside delimiter-free legacy history. ShellX did not guess where a record begins; load older pages until a known boundary is reached.",
  recordTooLarge: "A stored record exceeded the safe page bound and is not shown.",
  malformedRecord: "A malformed stored history record is not shown.",
};

export function SessionHistoryOmissionNotices({
  reasons,
}: {
  reasons: readonly string[];
}): JSX.Element | null {
  if (reasons.length === 0) return null;
  return (
    <>
      {reasons.map((reason) => (
        <span
          className="session-history-warning"
          data-debug-id="session-history-omission-notice"
          key={reason}
        >
          {SESSION_HISTORY_OMISSION_REASON_TEXT[reason] ?? "Some stored history could not be shown safely."}
        </span>
      ))}
    </>
  );
}

export default function SessionHistoryViewer({
  sessionId,
  onPreviewFile,
  onClose,
  renderPage,
}: {
  sessionId?: string;
  onPreviewFile: (path: string) => void;
  onClose: () => void;
  /** Keeps the read-only transcript in ChatOutput and avoids a lazy-import cycle. */
  renderPage: SessionHistoryPageRenderer;
}): JSX.Element {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const requestIdRef = useRef(0);
  const sourceStampRef = useRef<string | null>(null);
  const [page, setPage] = useState<LoadedSessionHistoryPage | null>(null);
  const [cursorHistory, setCursorHistory] = useState<Array<SessionJsonlPageCursor | null>>([null]);
  const [pageIndex, setPageIndex] = useState(0);
  const [retainedFirstPageNumber, setRetainedFirstPageNumber] = useState(1);
  const [droppedNewerHistory, setDroppedNewerHistory] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const closeModal = useCallback(() => onClose(), [onClose]);
  useModalFocus(true, dialogRef, closeModal);

  const loadPage = useCallback(async (
    cursor: SessionJsonlPageCursor | null,
    nextPageIndex: number,
    nextCursorHistory?: Array<SessionJsonlPageCursor | null>,
    resetSourceStamp = false,
    didDropNewerHistory = false,
  ): Promise<void> => {
    if (!sessionId) {
      setError("This chat does not have durable session history yet.");
      return;
    }
    if (!inTauri()) {
      setError("Full session history needs the ShellX desktop host.");
      return;
    }
    const requestId = ++requestIdRef.current;
    const expectedSourceStamp = resetSourceStamp
      ? null
      : sourceStampRef.current ?? cursor?.sourceStamp ?? null;
    setLoading(true);
    setError(null);
    try {
      const response = await invoke<SessionJsonlPageResponse>("read_session_jsonl_page", {
        sessionId,
        cursor,
      });
      if (requestId !== requestIdRef.current) return;
      if (!response || typeof response.sourceStamp !== "string" || !Array.isArray(response.lines)) {
        throw new Error("The history reader returned an invalid page.");
      }
      const recoveryIsIndexing = isSessionHistoryIndexing(response);
      if (recoveryIsIndexing && (
        response.lines.length !== 0
        || response.nextCursor !== null
        || response.complete
        || response.omittedBytes !== 0
        || (response.omissionReasons?.length ?? 0) !== 0
      )) {
        throw new Error("The history reader returned an invalid indexing response.");
      }
      if (expectedSourceStamp && response.sourceStamp !== expectedSourceStamp) {
        setError("The session log changed while loading history. Reload history to avoid mixing records from different versions.");
        return;
      }
      sourceStampRef.current = response.sourceStamp;
      setPage({ response, parsed: parseSessionHistoryPage(response.lines) });
      setPageIndex(nextPageIndex);
      if (nextCursorHistory) setCursorHistory(nextCursorHistory);
      if (didDropNewerHistory) {
        setDroppedNewerHistory(true);
        setRetainedFirstPageNumber((current) => current + 1);
      }
    } catch (cause) {
      if (requestId === requestIdRef.current) setError(sessionHistoryLoadError(cause));
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }, [sessionId]);

  const reloadHistory = useCallback(() => {
    requestIdRef.current += 1;
    sourceStampRef.current = null;
    setPage(null);
    setPageIndex(0);
    setRetainedFirstPageNumber(1);
    setDroppedNewerHistory(false);
    setCursorHistory([null]);
    void loadPage(null, 0, [null], true);
  }, [loadPage]);

  useEffect(() => {
    reloadHistory();
    return () => { requestIdRef.current += 1; };
  }, [reloadHistory, sessionId]);

  const isIndexing = isSessionHistoryIndexing(page?.response);
  const currentCursor = cursorHistory[pageIndex] ?? null;
  const indexingRetryDelay = sessionHistoryIndexingRetryDelay(page?.response, loading, error);
  useEffect(() => {
    if (indexingRetryDelay === null) return;
    const requestId = requestIdRef.current;
    const retry = window.setTimeout(() => {
      if (requestId === requestIdRef.current) {
        void loadPage(currentCursor, pageIndex);
      }
    }, indexingRetryDelay);
    return () => window.clearTimeout(retry);
  }, [currentCursor, indexingRetryDelay, loadPage, pageIndex]);

  const loadOlder = useCallback(() => {
    if (!page || loading || isIndexing) return;
    const target = olderSessionHistoryPageTarget(
      cursorHistory,
      pageIndex,
      page.response.nextCursor,
    );
    if (!target) return;
    void loadPage(target.cursor, target.pageIndex, target.cursorHistory, false, target.droppedNewerHistory);
  }, [cursorHistory, isIndexing, loadPage, loading, page, pageIndex]);

  const loadNewer = useCallback(() => {
    if (loading || isIndexing) return;
    const target = newerSessionHistoryPageTarget(cursorHistory, pageIndex);
    if (!target) return;
    void loadPage(target.cursor, target.pageIndex);
  }, [cursorHistory, isIndexing, loadPage, loading, pageIndex]);

  const previewFromHistory = useCallback((path: string) => {
    onClose();
    onPreviewFile(path);
  }, [onClose, onPreviewFile]);

  const canLoadOlder = Boolean(
    !isIndexing
    && page
    && olderSessionHistoryPageTarget(cursorHistory, pageIndex, page.response.nextCursor),
  );
  const hasUnreadableBytes = Boolean(!isIndexing && page && (page.response.omittedBytes > 0 || !page.response.complete));
  const hasMalformedLines = Boolean(!isIndexing && page && page.parsed.malformedLineCount > 0);
  const omissionReasons = isIndexing ? [] : page?.response.omissionReasons ?? [];

  return (
    <div
      className="session-history-backdrop"
      data-debug-id="session-history-backdrop"
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        className="session-history-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Full session history"
        aria-describedby="session-history-description"
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="session-history-header">
          <div>
            <h2>Full session history</h2>
            <p id="session-history-description">
              Page {retainedFirstPageNumber + pageIndex}. Earlier and newer pages reload from the durable session log.
            </p>
          </div>
          <button
            type="button"
            className="session-history-close"
            data-dialog-initial-focus="true"
            data-shellx-release-observe="focused"
            onClick={onClose}
            aria-label="Close full session history"
            title="Close (Esc)"
          >
            <ShellIcon name="close" size={16} />
          </button>
        </header>

        <div className="session-history-status" role="status" aria-live="polite">
          {loading && !isIndexing ? "Loading history page…" : null}
          {isIndexing && page ? (
            <span className="session-history-indexing">
              {sessionHistoryIndexingProgressLabel(page.response)}
            </span>
          ) : null}
          {error ? <span className="session-history-error">{error}</span> : null}
          {hasUnreadableBytes ? (
            <span className="session-history-warning">
              This page has unreadable stored history{page && page.response.omittedBytes > 0 ? ` (${page.response.omittedBytes} bytes omitted)` : ""}.
            </span>
          ) : null}
          {hasMalformedLines ? (
            <span className="session-history-warning">
              {page!.parsed.malformedLineCount} stored record{page!.parsed.malformedLineCount === 1 ? " was" : "s were"} not shown.
            </span>
          ) : null}
          <SessionHistoryOmissionNotices reasons={omissionReasons} />
        </div>

        <div className="session-history-body">
          {isIndexing ? (
            <div className="session-history-empty" role="status">
              ShellX is preparing this legacy history page safely.
            </div>
          ) : renderPage(page, previewFromHistory)}
        </div>

        <footer className="session-history-footer">
          <button type="button" data-shellx-release-observe="disabled" onClick={loadNewer} disabled={loading || isIndexing || pageIndex === 0}>
            Newer page
          </button>
          <button type="button" onClick={reloadHistory} disabled={loading}>
            Reload history
          </button>
          <button type="button" data-shellx-release-observe="disabled" onClick={loadOlder} disabled={loading || isIndexing || !canLoadOlder}>
            Older page
          </button>
          {page && !isIndexing && !page.response.nextCursor && pageIndex === cursorHistory.length - 1 ? (
            <span className="session-history-end">Oldest readable page</span>
          ) : null}
          {droppedNewerHistory && pageIndex === 0 ? (
            <span className="session-history-end">Newer history before this retained window requires Reload history.</span>
          ) : null}
        </footer>
      </div>
    </div>
  );
}
