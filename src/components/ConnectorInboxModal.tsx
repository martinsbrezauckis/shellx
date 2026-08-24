import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./ConnectorInboxModal.css";
import { ShellIcon } from "./icons";
import { inTauri } from "../lib/tauri-bridge";
import {
  CONNECTOR_PROVIDERS,
  filterOutsideConnectorEvents,
  outsideConnectorProviderLabel,
  outsideConnectorStatusLabel,
  summarizeOutsideConnectorInbox,
  type OutsideConnector,
  type OutsideConnectorEvent,
  type ProviderKind,
} from "../lib/outside-connectors";
import { useModalFocus } from "../lib/useModalFocus";

type InboxFilter = "all" | ProviderKind;

type ManualRefreshReceipt = {
  sequence: number;
  completedAtMs: number | null;
  connectorCount: number | null;
  eventCount: number | null;
  maxEventMs: number | null;
};

const EMPTY_MANUAL_REFRESH_RECEIPT: ManualRefreshReceipt = {
  sequence: 0,
  completedAtMs: null,
  connectorCount: null,
  eventCount: null,
  maxEventMs: null,
};

export function ConnectorInboxModal({
  open,
  onClose,
  onSeen,
}: {
  open: boolean;
  onClose: () => void;
  onSeen?: (seenMs: number) => void;
}): JSX.Element | null {
  const [connectors, setConnectors] = useState<OutsideConnector[]>([]);
  const [events, setEvents] = useState<OutsideConnectorEvent[]>([]);
  const [filter, setFilter] = useState<InboxFilter>("all");
  const [query, setQuery] = useState("");
  const [localDate, setLocalDate] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [manualRefreshReceipt, setManualRefreshReceipt] = useState<ManualRefreshReceipt>(EMPTY_MANUAL_REFRESH_RECEIPT);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  useModalFocus(open, dialogRef, onClose);

  const refresh = useCallback(async (source: "automatic" | "manual" = "automatic") => {
    if (!open) return;
    if (!inTauri()) {
      setError("Connector inbox is only available inside shellX.");
      return;
    }
    setBusy(true);
    try {
      const [list, recentEvents] = await Promise.all([
        invoke<OutsideConnector[]>("outside_connectors_list"),
        invoke<OutsideConnectorEvent[]>("outside_connectors_events", { limit: 100 }).catch(() => []),
      ]);
      setConnectors([...list].sort((a, b) => a.label.localeCompare(b.label)));
      setEvents(recentEvents);
      const latestEventMs = maxEventMs(recentEvents);
      onSeen?.(latestEventMs);
      if (source === "manual") {
        setManualRefreshReceipt((previous) => ({
          sequence: previous.sequence + 1,
          completedAtMs: Date.now(),
          connectorCount: list.length,
          eventCount: recentEvents.length,
          maxEventMs: latestEventMs,
        }));
      }
      setError(null);
    } catch (e) {
      setError(formatError(e));
    } finally {
      setBusy(false);
    }
  }, [open, onSeen]);

  useEffect(() => {
    if (!open) setManualRefreshReceipt(EMPTY_MANUAL_REFRESH_RECEIPT);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    void refresh();
  }, [open, refresh]);

  useEffect(() => {
    if (!open) return;
    const t = window.setInterval(() => void refresh(), 5000);
    return () => window.clearInterval(t);
  }, [open, refresh]);

  const summary = useMemo(
    () => summarizeOutsideConnectorInbox(connectors, events),
    [connectors, events],
  );

  const filteredEvents = useMemo(
    () => filterOutsideConnectorEvents(events, {
      provider: filter,
      query,
      localDate,
    }),
    [events, filter, query, localDate],
  );
  const hasFilters = filter !== "all" || query.trim().length > 0 || localDate.trim().length > 0;

  if (!open) return null;

  return (
    <div
      className="pmodal-backdrop"
      data-debug-id="connector-inbox-backdrop"
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        data-manual-focus-id="connector-inbox-modal"
        data-debug-id="surface-components-connectorinboxmodal-2"
        data-connector-inbox-manual-refresh-sequence={manualRefreshReceipt.sequence}
        data-connector-inbox-manual-refresh-completed-at-ms={manualRefreshReceipt.completedAtMs ?? ""}
        data-connector-inbox-manual-refresh-connector-count={manualRefreshReceipt.connectorCount ?? ""}
        data-connector-inbox-manual-refresh-event-count={manualRefreshReceipt.eventCount ?? ""}
        data-connector-inbox-manual-refresh-max-event-ms={manualRefreshReceipt.maxEventMs ?? ""}
        className="pmodal connector-inbox-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Connector inbox"
        tabIndex={-1}
      >
        <div className="pmodal-hdr">
          <span className="pmodal-title">Connector inbox</span>
          <span className="pmodal-sub">
            {summary.label} · {summary.eventCount} event{summary.eventCount === 1 ? "" : "s"}
          </span>
          <button
            type="button"
            className="pmodal-x"
            onClick={onClose}
            aria-label="Close connector inbox"
            title="Close"
          >
            <ShellIcon name="close" size={14} />
          </button>
        </div>

        <div className="pmodal-section connector-inbox-body">
          <div className="connector-inbox-toolbar">
            <div className="connector-inbox-tabs" role="tablist" aria-label="Connector inboxes">
              <InboxTab
                id="all"
                label="All"
                count={events.length}
                active={filter === "all"}
                onClick={() => setFilter("all")}
              />
              {CONNECTOR_PROVIDERS.map((provider) => (
                <InboxTab
                  key={provider}
                  id={provider}
                  label={outsideConnectorProviderLabel(provider)}
                  count={events.filter((event) => event.provider === provider).length}
                  active={filter === provider}
                  onClick={() => setFilter(provider)}
                />
              ))}
            </div>
            <button
              data-debug-id="surface-components-connectorinboxmodal-4"
              data-shellx-release-observe="disabled title"
              title={`Connector inbox refresh receipt · sequence=${manualRefreshReceipt.sequence} · completedAtMs=${manualRefreshReceipt.completedAtMs ?? "none"} · connectors=${manualRefreshReceipt.connectorCount ?? "none"} · events=${manualRefreshReceipt.eventCount ?? "none"} · maxEventMs=${manualRefreshReceipt.maxEventMs ?? "none"}`}
              type="button"
              className="settings-pill"
              onClick={() => void refresh("manual")}
              disabled={busy}
            >
              <ShellIcon name="refresh" size={13} />
              {busy ? "Refreshing" : "Refresh"}
            </button>
          </div>

          <div className="connector-inbox-filters" aria-label="Connector inbox filters">
            <label className="connector-inbox-search">
              <ShellIcon name="search" size={13} />
              <input
                className="settings-input connector-inbox-search-input"
                data-debug-id="connector-inbox-search-input"
                data-shellx-release-observe="value"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search messages, sender, target"
              />
            </label>
            <input
              className="settings-input connector-inbox-date"
              type="date"
              data-debug-id="connector-inbox-date-input"
              data-shellx-release-observe="value"
              value={localDate}
              onChange={(e) => setLocalDate(e.target.value)}
              aria-label="Filter connector inbox by date"
            />
            {hasFilters && (
              <button
                type="button"
                className="settings-pill"
                onClick={() => {
                  setFilter("all");
                  setQuery("");
                  setLocalDate("");
                }}
              >
                Clear
              </button>
            )}
            <span className="connector-inbox-filter-count">
              {filteredEvents.length} shown
            </span>
          </div>

          {error && <div className="connector-toast connector-toast-err">{error}</div>}

          {filteredEvents.length === 0 ? (
            <div className="connector-events-empty">
              No connector messages in this inbox.
            </div>
          ) : (
            <div className="connector-events-list connector-inbox-events" role="list">
              {filteredEvents.map((event) => (
                <ConnectorInboxEventRow key={event.id} event={event} />
              ))}
            </div>
          )}
        </div>

        <div className="pmodal-foot connector-inbox-foot">
          <span>
            {summary.inboxCount} inbox · {summary.rejectedCount} rejected
          </span>
          <button
            type="button"
            className="settings-pill"
            onClick={() => {
              openConnectorsSettings();
              onClose();
            }}
          >
            Connectors settings
          </button>
        </div>
      </div>
    </div>
  );
}

function InboxTab({
  id,
  label,
  count,
  active,
  onClick,
}: {
  id: InboxFilter;
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}): JSX.Element {
  return (
    <button data-debug-id="surface-components-connectorinboxmodal-9"
      type="button"
      role="tab"
      aria-selected={active}
      data-shellx-release-observe="selected"
      className={`connector-inbox-tab ${active ? "active" : ""}`}
      onClick={onClick}
      data-inbox={id}
    >
      <span>{label}</span>
      <span className="connector-inbox-tab-count">{count}</span>
    </button>
  );
}

function ConnectorInboxEventRow({ event }: { event: OutsideConnectorEvent }): JSX.Element {
  const when = new Date(event.createdMs).toLocaleString();
  return (
    <div className="connector-event-row" role="listitem">
      <div className="connector-event-main">
        <div className="connector-row-title">
          <span className="connection-label">{event.connectorLabel}</span>
          <span className={`connector-state connector-event-${event.status}`}>
            {outsideConnectorStatusLabel(event.status)}
          </span>
          <span className="connection-kind">{outsideConnectorProviderLabel(event.provider)}</span>
        </div>
        <span className="connection-target">{event.textPreview || event.externalPreview}</span>
        <span className="connector-route">
          sender {event.senderId}
          {event.conversationId ? ` · chat ${event.conversationId}` : ""}
          {event.guildId ? ` · guild ${event.guildId}` : ""}
          {` · ${event.target}`}
        </span>
        {event.reason && <span className="connector-error">{event.reason}</span>}
      </div>
      <div className="connection-row-meta">
        <span className="connection-last-used">{when}</span>
      </div>
    </div>
  );
}

function openConnectorsSettings(): void {
  window.dispatchEvent(new CustomEvent("shellx:open-settings", { detail: { tab: "connectors" } }));
}

function formatError(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function maxEventMs(events: OutsideConnectorEvent[]): number {
  return events.reduce((max, event) => Math.max(max, event.createdMs), 0);
}
