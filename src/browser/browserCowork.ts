import { agentShortLabel, normalizeAgentSelection } from "../lib/agent-selection";
import { groupEvents } from "../lib/grouping";
import type { RawEventFrame } from "../types/acp";
import type { BrowserTask } from "./types";

const MAX_COWORK_MESSAGES = 60;
const MAX_TOOL_DETAIL_CHARS = 1_200;

export interface BrowserCoworkOpenTab {
  tabId: string;
  title: string;
  cwd?: string | null;
  agentId?: string | null;
  status?: string | null;
  isSending?: boolean;
}

export interface BrowserCoworkUiState {
  activeTabId: string | null;
  openTabs: BrowserCoworkOpenTab[];
}

export interface BrowserCoworkSession {
  tabId: string;
  title: string;
  agentId: string;
  agentLabel: string;
  status: string;
  isSending: boolean;
}

export interface BrowserCoworkMessage {
  id: string;
  role: "system" | "user" | "assistant" | "tool";
  label: string;
  text: string;
  t: number;
}

export interface BrowserCoworkLocalPrompt {
  id: string;
  taskId: string;
  text: string;
  t: number;
}

function cleanString(value: unknown, maxLength = 500): string | null {
  if (typeof value !== "string") return null;
  const clean = value.trim();
  return clean && clean.length <= maxLength ? clean : null;
}

export function normalizeBrowserCoworkUiState(value: unknown): BrowserCoworkUiState {
  if (!value || typeof value !== "object") return { activeTabId: null, openTabs: [] };
  const source = value as Record<string, unknown>;
  const openTabs = Array.isArray(source.openTabs)
    ? source.openTabs.flatMap((entry): BrowserCoworkOpenTab[] => {
        if (!entry || typeof entry !== "object") return [];
        const tab = entry as Record<string, unknown>;
        const tabId = cleanString(tab.tabId, 128);
        if (!tabId) return [];
        return [{
          tabId,
          title: cleanString(tab.title) ?? "Untitled session",
          cwd: cleanString(tab.cwd, 2_000),
          agentId: cleanString(tab.agentId, 64),
          status: cleanString(tab.status, 64),
          isSending: tab.isSending === true,
        }];
      })
    : [];
  const activeTabId = cleanString(source.activeTabId, 128);
  return { activeTabId, openTabs };
}

export function selectBrowserCoworkSession(
  state: BrowserCoworkUiState,
  task: BrowserTask | null,
): BrowserCoworkSession | null {
  const targetTabId = task?.ownerSessionId ?? state.activeTabId;
  if (!targetTabId) return null;
  const tab = state.openTabs.find((entry) => entry.tabId === targetTabId);
  const agentId = normalizeAgentSelection(tab?.agentId);
  if (!tab || !agentId) return null;
  return {
    tabId: tab.tabId,
    title: tab.title,
    agentId,
    agentLabel: agentShortLabel(agentId),
    status: tab.status ?? "Idle",
    isSending: tab.isSending === true,
  };
}

export function browserCoworkEventTabId(frame: RawEventFrame): string | null {
  if (!frame.payload || typeof frame.payload !== "object") return null;
  const payload = frame.payload as Record<string, unknown>;
  const meta = payload._meta && typeof payload._meta === "object"
    ? payload._meta as Record<string, unknown>
    : null;
  const params = payload.params && typeof payload.params === "object"
    ? payload.params as Record<string, unknown>
    : null;
  const paramsMeta = params?._meta && typeof params._meta === "object"
    ? params._meta as Record<string, unknown>
    : null;
  return cleanString(meta?.tabId, 128)
    ?? cleanString(paramsMeta?.tabId, 128)
    ?? cleanString(payload.tabId, 128);
}

function boundedText(value: string): string {
  const clean = value.trim();
  if (clean.length <= MAX_TOOL_DETAIL_CHARS) return clean;
  return `${clean.slice(0, MAX_TOOL_DETAIL_CHARS)}...`;
}

export function buildBrowserCoworkMessages(
  events: RawEventFrame[],
  task: BrowserTask | null,
  localPrompts: BrowserCoworkLocalPrompt[],
  session: BrowserCoworkSession | null,
): BrowserCoworkMessage[] {
  if (!session) {
    return [{
      id: "browser-cowork-no-session",
      role: "system",
      label: "ShellX",
      text: "Open or choose a ShellX agent tab in the main window to cowork in Browser.",
      t: 0,
    }];
  }
  if (!task) {
    return [{
      id: "browser-cowork-ready",
      role: "system",
      label: session.agentLabel,
      text: "Ready to start a visible Browser task.",
      t: 0,
    }];
  }

  const taskStart = task.createdAtMs || task.updatedAtMs;
  const scopedEvents = events.filter((frame) => (
    frame.t >= taskStart - 50
    && browserCoworkEventTabId(frame) === session.tabId
    && (frame.kind === "grok-acp-event" || frame.kind === "provider-session-event")
  ));
  const messages: BrowserCoworkMessage[] = [{
    id: `${task.taskId}-goal`,
    role: "user",
    label: "You",
    text: task.goal,
    t: taskStart,
  }];
  for (const prompt of localPrompts) {
    if (prompt.taskId !== task.taskId || !prompt.text.trim()) continue;
    messages.push({ id: prompt.id, role: "user", label: "You", text: prompt.text, t: prompt.t });
  }
  for (const group of groupEvents(scopedEvents)) {
    if (group.kind === "message" && group.text.trim()) {
      messages.push({
        id: `${task.taskId}-${group.id}`,
        role: "assistant",
        label: group.speakerLabel ?? session.agentLabel,
        text: group.text.trim(),
        t: group.t,
      });
    } else if (group.kind === "tool") {
      const detail = group.toolText?.trim();
      messages.push({
        id: `${task.taskId}-${group.id}`,
        role: "tool",
        label: group.title,
        text: boundedText(`${group.status}${detail ? `\n${detail}` : ""}`),
        t: group.t,
      });
    } else if (group.kind === "system" && group.label.trim()) {
      messages.push({
        id: `${task.taskId}-${group.id}`,
        role: "system",
        label: session.agentLabel,
        text: boundedText(`${group.label}${group.detail ? `: ${group.detail}` : ""}`),
        t: group.t,
      });
    }
  }
  return messages
    .sort((left, right) => left.t - right.t)
    .slice(-MAX_COWORK_MESSAGES);
}
