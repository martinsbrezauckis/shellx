import { useMemo, useRef, useState, type JSX } from "react";

import { ShellIcon } from "../../components/icons";
import { useModalFocus } from "../../lib/useModalFocus";
import type { BrowserHistoryClearStatus } from "../historyClear";
import {
  browserHistoryClearActionLabel,
  browserHistoryCountLabel,
  browserHistoryEntriesForScope,
  browserHistoryScopeCategory,
  browserHistoryScopeLabel,
  type BrowserHistoryClass,
  type BrowserHistoryScope as BrowserHistoryClearScope,
} from "../historyScope";
import type { BrowserHistoryEntry } from "../types";

export type BrowserHistoryScope = BrowserHistoryClass;
export type BrowserHistoryDateFilter = "all" | "today" | "yesterday" | "last7";
interface BrowserHistorySidecarProps {
  open: boolean;
  busy: boolean;
  historyScope: BrowserHistoryScope;
  historySearch: string;
  historyDateFilter: BrowserHistoryDateFilter;
  historyEntries: BrowserHistoryEntry[];
  userHistory: BrowserHistoryEntry[];
  agentHistory: BrowserHistoryEntry[];
  formatHistoryTime: (visitedAtMs: number) => string;
  onHistoryScopeChange: (scope: BrowserHistoryScope) => void;
  onHistorySearchChange: (value: string) => void;
  onHistoryDateFilterChange: (filter: BrowserHistoryDateFilter) => void;
  historyClearStatus: BrowserHistoryClearStatus | null;
  onClearHistory: (scope: BrowserHistoryClearScope) => Promise<boolean>;
  onNavigateToUrl: (url: string) => void;
  onClose: () => void;
}

function historyMatchesDateFilter(visitedAtMs: number, filter: BrowserHistoryDateFilter): boolean {
  if (filter === "all") return true;
  if (!Number.isFinite(visitedAtMs) || visitedAtMs <= 0) return false;
  const now = new Date();
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startYesterday = startToday - 24 * 60 * 60 * 1000;
  if (filter === "today") return visitedAtMs >= startToday;
  if (filter === "yesterday") return visitedAtMs >= startYesterday && visitedAtMs < startToday;
  return visitedAtMs >= startToday - 6 * 24 * 60 * 60 * 1000;
}

function historyMatchesSearch(entry: BrowserHistoryEntry, search: string): boolean {
  const query = search.trim().toLocaleLowerCase();
  if (!query) return true;
  return [entry.title ?? "", entry.url, entry.profileId]
    .some((value) => value.toLocaleLowerCase().includes(query));
}

export function BrowserHistorySidecar({
  open,
  busy,
  historyScope,
  historySearch,
  historyDateFilter,
  historyEntries,
  userHistory,
  agentHistory,
  formatHistoryTime,
  onHistoryScopeChange,
  onHistorySearchChange,
  onHistoryDateFilterChange,
  historyClearStatus,
  onClearHistory,
  onNavigateToUrl,
  onClose,
}: BrowserHistorySidecarProps): JSX.Element | null {
  const [pendingClearScope, setPendingClearScope] = useState<BrowserHistoryClearScope | null>(null);
  const confirmationRef = useRef<HTMLDivElement | null>(null);
  const scopedHistory = historyScope === "user" ? userHistory : agentHistory;
  const pendingClearCount = pendingClearScope === null
    ? 0
    : browserHistoryEntriesForScope(pendingClearScope, historyEntries).length;
  useModalFocus(
    pendingClearScope !== null,
    confirmationRef,
    () => {
      if (!busy) setPendingClearScope(null);
    },
  );
  const filteredHistory = useMemo(
    () => scopedHistory.filter((entry) =>
      historyMatchesSearch(entry, historySearch) &&
      historyMatchesDateFilter(entry.visitedAtMs, historyDateFilter),
    ),
    [historyDateFilter, historySearch, scopedHistory],
  );

  const confirmClearHistory = async (scope: BrowserHistoryClearScope): Promise<void> => {
    if (busy) return;
    if (await onClearHistory(scope)) setPendingClearScope(null);
  };

  if (!open) return null;

  return (
    <aside
      id="shellx-browser-history-sidecar"
      className="shellx-browser-left-sidecar shellx-browser-history-sidecar"
      data-debug-id="shellx-browser-history-sidecar"
      aria-labelledby="shellx-browser-history-menu"
    >
      <div className="shellx-browser-history-head">
        <h2>History</h2>
        <button
          type="button"
          className="shellx-browser-icon-btn"
          onClick={onClose}
          data-debug-id="shellx-browser-history-close"
          title="Close history"
          aria-label="Close history"
        >
          <ShellIcon name="close" size={14} />
        </button>
        <div className="shellx-browser-menu-tabs shellx-browser-history-scope" aria-label="History scope">
          <button
            type="button"
            className={historyScope === "user" ? "active" : ""}
            onClick={() => onHistoryScopeChange("user")}
            data-debug-id="shellx-browser-history-user"
            aria-pressed={historyScope === "user"}
            data-shellx-release-observe="pressed"
          >
            User
          </button>
          <button
            type="button"
            className={historyScope === "agent" ? "active" : ""}
            onClick={() => onHistoryScopeChange("agent")}
            data-debug-id="shellx-browser-history-agent"
            aria-pressed={historyScope === "agent"}
            data-shellx-release-observe="pressed"
          >
            Agent
          </button>
        </div>
        <div className="shellx-browser-history-filters">
          <input
            type="search"
            value={historySearch}
            onChange={(event) => onHistorySearchChange(event.currentTarget.value)}
            placeholder="Search history"
            aria-label="Search history"
            data-debug-id="shellx-browser-history-search"
            data-shellx-release-observe="value"
          />
          <select
            value={historyDateFilter}
            onChange={(event) => onHistoryDateFilterChange(event.currentTarget.value as BrowserHistoryDateFilter)}
            aria-label="History date filter"
            data-debug-id="shellx-browser-history-date-filter"
            data-shellx-release-observe="value"
          >
            <option value="all">All dates</option>
            <option value="today">Today</option>
            <option value="yesterday">Yesterday</option>
            <option value="last7">Last 7 days</option>
          </select>
        </div>
        {historyClearStatus && (
          <div
            className={`shellx-browser-history-clear-status ${historyClearStatus.tone}`}
            data-debug-id="shellx-browser-history-clear-status"
            role={historyClearStatus.tone === "error" ? "alert" : "status"}
          >
            {historyClearStatus.message}
          </div>
        )}
        {historyEntries.length > 0 && (
          <div className="shellx-browser-history-actions" aria-label="Clear history">
            <button
              type="button"
              className="shellx-browser-utility-row shellx-browser-history-clear-scope"
              onClick={() => setPendingClearScope(historyScope)}
              disabled={busy || scopedHistory.length === 0}
              data-debug-id="shellx-browser-clear-history"
              data-history-scope={historyScope}
            >
              {browserHistoryClearActionLabel(historyScope)}
            </button>
            <button
              type="button"
              className="shellx-browser-utility-row shellx-browser-history-clear-all"
              onClick={() => setPendingClearScope("all")}
              disabled={busy || historyEntries.length === 0}
              data-debug-id="shellx-browser-clear-all-history"
              data-history-scope="all"
            >
              {browserHistoryClearActionLabel("all")}
            </button>
          </div>
        )}
      </div>
      <section className="shellx-browser-history-list" data-debug-id="shellx-browser-history-list" aria-label="Browser history">
        {filteredHistory.map((entry) => (
          <button
            key={entry.historyId}
            type="button"
            className="shellx-browser-history-list-row"
            onClick={() => onNavigateToUrl(entry.url)}
            data-debug-id={`shellx-browser-history-entry-${entry.historyId}`}
          >
            <ShellIcon name="history" size={13} />
            <span title={entry.title || "Untitled page"}>{entry.title || "Untitled page"}</span>
            <small className="shellx-browser-history-url" title={entry.url}>{entry.url}</small>
            <small>{formatHistoryTime(entry.visitedAtMs)} · {entry.profileId}</small>
          </button>
        ))}
        {scopedHistory.length === 0 && <div className="shellx-browser-empty-state">No {historyScope} history yet</div>}
        {scopedHistory.length > 0 && filteredHistory.length === 0 && <div className="shellx-browser-empty-state">No matching history</div>}
      </section>
      {pendingClearScope && (
        <div
          ref={confirmationRef}
          className="shellx-browser-history-confirmation"
          role="alertdialog"
          aria-modal="true"
          aria-busy={busy}
          aria-labelledby="shellx-browser-history-clear-title"
          aria-describedby="shellx-browser-history-clear-description"
          data-debug-id="shellx-browser-history-clear-confirmation"
          tabIndex={-1}
        >
          <div className="shellx-browser-history-confirmation-topbar">
            <span>Destructive action</span>
            <span>{browserHistoryScopeLabel(pendingClearScope)} scope</span>
          </div>
          <h3 id="shellx-browser-history-clear-title">
            {browserHistoryClearActionLabel(pendingClearScope)}?
          </h3>
          <p id="shellx-browser-history-clear-description">
            Remove {browserHistoryCountLabel(pendingClearScope, pendingClearCount)}.
          </p>
          <p className="shellx-browser-history-confirmation-category">
            Affected: {browserHistoryScopeCategory(pendingClearScope)}.
          </p>
          <div className="shellx-browser-history-confirmation-actions">
            <button
              type="button"
              className="shellx-browser-utility-row"
              data-dialog-initial-focus="true"
              onClick={() => setPendingClearScope(null)}
              disabled={busy}
              data-debug-id="shellx-browser-history-clear-cancel"
            >
              Cancel
            </button>
            <button
              type="button"
              className="shellx-browser-utility-row shellx-browser-history-confirm-danger"
              onClick={() => void confirmClearHistory(pendingClearScope)}
              disabled={busy || pendingClearCount === 0}
              data-debug-id="shellx-browser-history-clear-confirm"
              data-history-scope={pendingClearScope}
            >
              {busy ? `Clearing ${browserHistoryScopeLabel(pendingClearScope)} history…` : browserHistoryClearActionLabel(pendingClearScope)}
            </button>
          </div>
        </div>
      )}
    </aside>
  );
}
