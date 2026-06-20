import { useMemo, type JSX } from "react";

import { ShellIcon } from "../../components/icons";
import type { BrowserHistoryEntry } from "../types";

export type BrowserHistoryScope = "user" | "agent";
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
  onClearHistory: () => void;
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
  onClearHistory,
  onNavigateToUrl,
  onClose,
}: BrowserHistorySidecarProps): JSX.Element | null {
  const scopedHistory = historyScope === "user" ? userHistory : agentHistory;
  const filteredHistory = useMemo(
    () => scopedHistory.filter((entry) =>
      historyMatchesSearch(entry, historySearch) &&
      historyMatchesDateFilter(entry.visitedAtMs, historyDateFilter),
    ),
    [historyDateFilter, historySearch, scopedHistory],
  );

  if (!open) return null;

  return (
    <aside className="shellx-browser-left-sidecar shellx-browser-history-sidecar" data-debug-id="shellx-browser-history-sidecar">
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
          >
            User
          </button>
          <button
            type="button"
            className={historyScope === "agent" ? "active" : ""}
            onClick={() => onHistoryScopeChange("agent")}
            data-debug-id="shellx-browser-history-agent"
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
          />
          <select
            value={historyDateFilter}
            onChange={(event) => onHistoryDateFilterChange(event.currentTarget.value as BrowserHistoryDateFilter)}
            aria-label="History date filter"
            data-debug-id="shellx-browser-history-date-filter"
          >
            <option value="all">All dates</option>
            <option value="today">Today</option>
            <option value="yesterday">Yesterday</option>
            <option value="last7">Last 7 days</option>
          </select>
        </div>
        {historyEntries.length > 0 && (
          <button
            type="button"
            className="shellx-browser-utility-row"
            onClick={onClearHistory}
            disabled={busy}
            data-debug-id="shellx-browser-clear-history"
          >
            Clear history
          </button>
        )}
      </div>
      <section className="shellx-browser-history-list" data-debug-id="shellx-browser-history-list" aria-label="Browser history">
        {filteredHistory.map((entry) => (
          <button
            key={entry.historyId}
            type="button"
            className="shellx-browser-history-list-row"
            onClick={() => onNavigateToUrl(entry.url)}
            data-debug-id={`shellx-browser-history-${entry.historyId}`}
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
    </aside>
  );
}
