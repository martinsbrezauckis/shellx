import type { ActivityAction } from "./session-activity";
import type { PreviewQaReceipt, PreviewQaStatus } from "./preview-qa-studio";

export type AgentOpsTimelineEventKind =
  | "file_activity"
  | "preview_qa";

export type AgentOpsTimelineStatus = "verified" | "observed" | "inferred" | "warn" | "fail";

export interface AgentOpsTimelineSession {
  tabId: string;
  title?: string;
  cwd?: string | null;
}

export interface AgentOpsTimelineEvent {
  id: string;
  kind: AgentOpsTimelineEventKind;
  title: string;
  detail: string;
  status: AgentOpsTimelineStatus;
  timestampMs: number;
  sourceId: string;
  actor?: string;
  target?: string;
  data?: unknown;
}

export interface AgentOpsTimelineInput {
  generatedAt?: string;
  session: AgentOpsTimelineSession;
  activityActions?: ActivityAction[];
  previewReceipts?: PreviewQaReceipt[];
}

export interface AgentOpsTimeline {
  schemaVersion: "shellx.agentops.timeline.v1";
  generatedAt: string;
  session: AgentOpsTimelineSession;
  summary: {
    total: number;
    verified: number;
    observed: number;
    inferred: number;
    warn: number;
    fail: number;
  };
  events: AgentOpsTimelineEvent[];
}

export function buildAgentOpsTimeline(input: AgentOpsTimelineInput): AgentOpsTimeline {
  const events = [
    ...(input.activityActions ?? []).map(activityActionToTimelineEvent),
    ...(input.previewReceipts ?? []).map(previewReceiptToTimelineEvent),
  ].sort((a, b) => a.timestampMs - b.timestampMs || a.id.localeCompare(b.id));
  return {
    schemaVersion: "shellx.agentops.timeline.v1",
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    session: input.session,
    summary: summarizeTimelineEvents(events),
    events,
  };
}

export function renderAgentOpsTimelineSummary(timeline: AgentOpsTimeline): string {
  return [
    "AgentOps Timeline",
    "",
    `Session: ${timeline.session.title ?? timeline.session.tabId}`,
    `Cwd: ${timeline.session.cwd ?? "(unknown)"}`,
    `Events: ${timeline.summary.total}`,
    `Verified: ${timeline.summary.verified}`,
    `Observed: ${timeline.summary.observed}`,
    `Inferred: ${timeline.summary.inferred}`,
    `Warn: ${timeline.summary.warn}`,
    `Fail: ${timeline.summary.fail}`,
    "",
    "Recent events:",
    ...(timeline.events.length > 0
      ? timeline.events.map((event) => `- [${event.status}] ${event.title}: ${event.detail}`)
      : ["- none"]),
  ].join("\n");
}

function activityActionToTimelineEvent(action: ActivityAction): AgentOpsTimelineEvent {
  return {
    id: `activity:${action.id}`,
    kind: "file_activity",
    title: `${activityKindLabel(action.kind)} ${action.relativePath || action.name}`,
    detail: activityDetail(action),
    status: action.confidence,
    timestampMs: action.timestampMs ?? 0,
    sourceId: action.source,
    actor: action.actor,
    target: action.path,
    data: action,
  };
}

function previewReceiptToTimelineEvent(receipt: PreviewQaReceipt): AgentOpsTimelineEvent {
  return {
    id: `preview:${receipt.generatedAt}:${receipt.target.tabId}`,
    kind: "preview_qa",
    title: `Preview QA: ${receipt.target.label ?? receipt.target.tabId}`,
    detail: `${receipt.status}; ${receipt.summary.pass} pass, ${receipt.summary.warn} warn, ${receipt.summary.fail} fail`,
    status: previewStatusToTimelineStatus(receipt.status),
    timestampMs: Date.parse(receipt.generatedAt) || 0,
    sourceId: receipt.schemaVersion,
    actor: "shellx-preview-qa",
    target: receipt.target.url ?? receipt.target.cwd ?? receipt.target.tabId,
    data: receipt,
  };
}

function summarizeTimelineEvents(events: AgentOpsTimelineEvent[]): AgentOpsTimeline["summary"] {
  return {
    total: events.length,
    verified: events.filter((event) => event.status === "verified").length,
    observed: events.filter((event) => event.status === "observed").length,
    inferred: events.filter((event) => event.status === "inferred").length,
    warn: events.filter((event) => event.status === "warn").length,
    fail: events.filter((event) => event.status === "fail").length,
  };
}

function activityKindLabel(kind: ActivityAction["kind"]): string {
  switch (kind) {
    case "written":
      return "Wrote";
    case "created":
      return "Created";
    case "deleted":
      return "Deleted";
    case "read":
      return "Read";
    case "listed":
      return "Listed";
    case "searched":
      return "Searched";
    case "opened":
      return "Opened";
    case "executed":
      return "Executed";
    default:
      return kind;
  }
}

function activityDetail(action: ActivityAction): string {
  const edits = [
    typeof action.linesAdded === "number" ? `+${action.linesAdded}` : null,
    typeof action.linesRemoved === "number" ? `-${action.linesRemoved}` : null,
  ].filter(Boolean).join(" ");
  return [
    `${action.confidence} ${action.source}`,
    action.actor ? `actor=${action.actor}` : null,
    edits || null,
  ].filter(Boolean).join("; ");
}

function previewStatusToTimelineStatus(status: PreviewQaStatus): AgentOpsTimelineStatus {
  if (status === "fail") return "fail";
  if (status === "warn") return "warn";
  return "verified";
}
