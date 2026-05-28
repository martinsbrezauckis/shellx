export const CONNECTOR_PROVIDERS = ["telegram", "discord"] as const;
export type ProviderKind = (typeof CONNECTOR_PROVIDERS)[number];
export type DispatchMode = "inbox" | "autoPrompt";
export type ConnectorEventStatus = "inbox" | "autoPrompt" | "rejected" | "error";

export interface TelegramProvider {
  kind: "telegram";
  botTokenVaultKey: string;
  allowedChatIds: string[];
}

export interface DiscordProvider {
  kind: "discord";
  botTokenVaultKey: string;
  allowedTargetIds: string[];
}

export type ConnectorProvider = TelegramProvider | DiscordProvider;

export type ConnectorTarget =
  | { mode: "activeTab" }
  | { mode: "fixedTab"; tabId: string };

export interface OutsideConnector {
  id: string;
  label: string;
  enabled: boolean;
  provider: ConnectorProvider;
  target: ConnectorTarget;
  dispatchMode: DispatchMode;
  requireApproval: boolean;
  createdMs: number;
  updatedMs: number;
  lastTestMs?: number | null;
  lastError?: string | null;
}

export interface OutsideConnectorEvent {
  id: string;
  connectorId: string;
  connectorLabel: string;
  provider: ProviderKind;
  direction: "inbound" | "outbound" | "system";
  status: ConnectorEventStatus;
  senderId: string;
  conversationId?: string | null;
  guildId?: string | null;
  target: string;
  dispatchMode: DispatchMode;
  requireApproval: boolean;
  textPreview: string;
  externalPreview: string;
  reason?: string | null;
  createdMs: number;
}

export interface OutsideConnectorInboxSummary {
  enabledCount: number;
  eventCount: number;
  unreadCount: number;
  inboxCount: number;
  rejectedCount: number;
  shouldShowHeaderInbox: boolean;
  label: string;
  badgeLabel: string;
}

export type ConnectorSummaryInput = { enabled?: boolean; provider?: unknown };
export type ConnectorEventSummaryInput = { id?: string; status?: string | null; createdMs?: number | null };

export interface ConnectorEventFilterInput {
  id: string;
  connectorLabel?: string | null;
  provider: ProviderKind;
  status?: ConnectorEventStatus | string | null;
  senderId?: string | null;
  conversationId?: string | null;
  guildId?: string | null;
  target?: string | null;
  textPreview?: string | null;
  externalPreview?: string | null;
  reason?: string | null;
  createdMs: number;
}

export interface OutsideConnectorEventFilters {
  provider?: "all" | ProviderKind;
  query?: string;
  localDate?: string;
}

export function summarizeOutsideConnectorInbox(
  connectors: ConnectorSummaryInput[],
  events: ConnectorEventSummaryInput[],
  lastSeenMs = 0,
): OutsideConnectorInboxSummary {
  const connectorCount = connectors.length;
  const enabledCount = connectors.filter((connector) => connector.enabled === true).length;
  const eventCount = events.length;
  const unreadCount = events.filter((event) => typeof event.createdMs === "number" && event.createdMs > lastSeenMs).length;
  const inboxCount = events.filter((event) => event.status === "inbox").length;
  const rejectedCount = events.filter((event) => event.status === "rejected" || event.status === "error").length;
  const labelCount = enabledCount > 0 ? enabledCount : connectorCount;

  return {
    enabledCount,
    eventCount,
    unreadCount,
    inboxCount,
    rejectedCount,
    shouldShowHeaderInbox: connectorCount > 0 || eventCount > 0,
    label: labelCount === 0
      ? "No connectors"
      : `${labelCount} connector${labelCount === 1 ? "" : "s"}`,
    badgeLabel: unreadCount > 0 ? String(Math.min(unreadCount, 99)) : "",
  };
}

export function filterOutsideConnectorEvents<T extends ConnectorEventFilterInput>(
  events: T[],
  filters: OutsideConnectorEventFilters,
): T[] {
  const provider = filters.provider ?? "all";
  const query = filters.query?.trim().toLocaleLowerCase() ?? "";
  const localDate = filters.localDate?.trim() ?? "";

  return events.filter((event) => {
    if (provider !== "all" && event.provider !== provider) return false;
    if (localDate && localDateFromMs(event.createdMs) !== localDate) return false;
    if (!query) return true;
    return searchableEventText(event).includes(query);
  });
}

function searchableEventText(event: ConnectorEventFilterInput): string {
  return [
    event.connectorLabel,
    outsideConnectorProviderLabel(event.provider),
    event.status,
    event.senderId,
    event.conversationId,
    event.guildId,
    event.target,
    event.textPreview,
    event.externalPreview,
    event.reason,
  ]
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join(" ")
    .toLocaleLowerCase();
}

function localDateFromMs(ms: number): string {
  const date = new Date(ms);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function outsideConnectorProviderLabel(providerKind: ProviderKind): string {
  switch (providerKind) {
    case "telegram": return "Telegram";
    case "discord": return "Discord";
  }
}

export function connectorLabelForSave(providerKind: ProviderKind, existingLabel?: string | null): string {
  const trimmed = existingLabel?.trim();
  return trimmed || outsideConnectorProviderLabel(providerKind);
}

export function outsideConnectorStatusLabel(status: ConnectorEventStatus): string {
  switch (status) {
    case "inbox": return "inbox";
    case "autoPrompt": return "session";
    case "rejected": return "rejected";
    case "error": return "error";
  }
}
