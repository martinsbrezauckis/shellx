import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";

import {
  BROWSER_COWORK_DISPATCH_RESULT_EVENT,
  normalizeBrowserCoworkDispatchResultEvent,
} from "../../lib/browser-cowork-events";
import { inTauri } from "../../lib/tauri-bridge";
import type { RawEventFrame } from "../../types/acp";
import { browserApiGet, sendBrowserCoworkPrompt, type BrowserCoworkPromptResponse } from "../api";
import {
  browserCoworkEventTabId,
  buildBrowserCoworkMessages,
  normalizeBrowserCoworkUiState,
  selectBrowserCoworkSession,
  type BrowserCoworkLocalPrompt,
  type BrowserCoworkMessage,
  type BrowserCoworkUiState,
} from "../browserCowork";
import type { BrowserAutonomy, BrowserTask } from "../types";

const MAX_SESSION_EVENTS = 1_500;
const COWORK_DISPATCH_TIMEOUT_MS = 65_000;

interface BrowserCoworkSendRequest {
  prompt: string;
  startUrl?: string | null;
  profileId?: string | null;
  autonomy?: BrowserAutonomy | null;
}

interface UseBrowserCoworkOptions {
  activeTask: BrowserTask | null;
  enabled: boolean;
}

interface UseBrowserCoworkResult {
  messages: BrowserCoworkMessage[];
  sessionLabel: string;
  canSend: boolean;
  onSessionEvent: (frame: RawEventFrame) => void;
  onUiState: (state: unknown) => void;
  sendPrompt: (request: BrowserCoworkSendRequest) => Promise<BrowserCoworkPromptResponse>;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? value as Record<string, unknown> : null;
}

function textSignature(value: unknown): string {
  if (typeof value !== "string") return "";
  return `${value.length}:${value.slice(0, 48)}:${value.slice(-16)}`;
}

function eventKey(frame: RawEventFrame): string {
  const payload = record(frame.payload);
  const params = record(payload?.params);
  const meta = record(payload?._meta) ?? record(params?._meta);
  const update = record(params?.update);
  const content = record(update?.content);
  return [
    frame.t,
    frame.kind,
    browserCoworkEventTabId(frame),
    meta?.eventId,
    meta?.promptId,
    meta?.chunkId,
    payload?.runId,
    payload?.kind,
    payload?.rawType,
    update?.sessionUpdate,
    update?.toolCallId,
    textSignature(payload?.text ?? content?.text),
  ].join(":");
}

function mergeSessionEvents(current: RawEventFrame[], incoming: RawEventFrame[]): RawEventFrame[] {
  const byKey = new Map(current.map((frame) => [eventKey(frame), frame]));
  for (const frame of incoming) byKey.set(eventKey(frame), frame);
  return [...byKey.values()]
    .sort((left, right) => left.t - right.t)
    .slice(-MAX_SESSION_EVENTS);
}

export function useBrowserCowork({
  activeTask,
  enabled,
}: UseBrowserCoworkOptions): UseBrowserCoworkResult {
  const [uiState, setUiState] = useState<BrowserCoworkUiState>({ activeTabId: null, openTabs: [] });
  const [sessionEvents, setSessionEvents] = useState<RawEventFrame[]>([]);
  const [localPrompts, setLocalPrompts] = useState<BrowserCoworkLocalPrompt[]>([]);
  const [dispatchErrors, setDispatchErrors] = useState<BrowserCoworkMessage[]>([]);
  const [dispatchPending, setDispatchPending] = useState(false);
  const pendingDispatchRef = useRef<string | true | null>(null);
  const pendingDispatchTargetRef = useRef<string | null>(null);
  const dispatchTimeoutRef = useRef<number | null>(null);
  const session = useMemo(
    () => selectBrowserCoworkSession(uiState, activeTask),
    [activeTask, uiState],
  );
  const sessionTabIdRef = useRef<string | null>(session?.tabId ?? null);
  useEffect(() => {
    sessionTabIdRef.current = session?.tabId ?? null;
  }, [session?.tabId]);

  const clearPendingDispatch = useCallback(() => {
    pendingDispatchRef.current = null;
    pendingDispatchTargetRef.current = null;
    setDispatchPending(false);
    if (dispatchTimeoutRef.current !== null) {
      window.clearTimeout(dispatchTimeoutRef.current);
      dispatchTimeoutRef.current = null;
    }
  }, []);
  useEffect(() => () => {
    pendingDispatchRef.current = null;
    pendingDispatchTargetRef.current = null;
    if (dispatchTimeoutRef.current !== null) window.clearTimeout(dispatchTimeoutRef.current);
  }, []);

  const refreshUiState = useCallback(async () => {
    const next = await browserApiGet<unknown>("/state/ui");
    setUiState(normalizeBrowserCoworkUiState(next));
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let timer: number | null = null;
    const poll = async () => {
      await refreshUiState().catch(() => undefined);
      if (!cancelled) timer = window.setTimeout(() => void poll(), 10_000);
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [enabled, refreshUiState]);

  useEffect(() => {
    if (!enabled || !session?.tabId || !activeTask) {
      setSessionEvents([]);
      return;
    }
    let cancelled = false;
    const path = `/events/recent?tabId=${encodeURIComponent(session.tabId)}&limit=1000`;
    void browserApiGet<RawEventFrame[]>(path)
      .then((events) => {
        if (!cancelled && Array.isArray(events)) setSessionEvents((current) => mergeSessionEvents(current, events));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [activeTask?.taskId, enabled, session?.tabId]);

  useEffect(() => {
    if (!inTauri()) return;
    const unlisten = listen<unknown>(BROWSER_COWORK_DISPATCH_RESULT_EVENT, ({ payload }) => {
      const result = normalizeBrowserCoworkDispatchResultEvent(payload);
      if (!result || result.targetTabId !== pendingDispatchTargetRef.current) return;
      const pendingRequestId = pendingDispatchRef.current;
      if (pendingRequestId !== true && pendingRequestId !== result.requestId) return;
      clearPendingDispatch();
      if (result.ok || result.targetTabId !== sessionTabIdRef.current) return;
      setDispatchErrors((current) => [...current, {
        id: `dispatch-${result.requestId}`,
        role: "system" as const,
        label: "ShellX",
        text: result.error ?? "The attached ShellX session did not accept the Browser prompt.",
        t: Date.now(),
      }].slice(-8));
    });
    return () => {
      void unlisten.then((stop) => stop());
    };
  }, [clearPendingDispatch]);

  const onSessionEvent = useCallback((frame: RawEventFrame) => {
    if (
      (frame.kind !== "grok-acp-event" && frame.kind !== "provider-session-event")
      || browserCoworkEventTabId(frame) !== sessionTabIdRef.current
    ) return;
    setSessionEvents((current) => mergeSessionEvents(current, [frame]));
  }, []);
  const onUiState = useCallback((state: unknown) => {
    setUiState(normalizeBrowserCoworkUiState(state));
  }, []);

  const sendPrompt = useCallback(async (
    request: BrowserCoworkSendRequest,
  ): Promise<BrowserCoworkPromptResponse> => {
    if (!session) throw new Error("Open or choose a ShellX agent tab in the main window first.");
    if (pendingDispatchRef.current !== null) {
      throw new Error("The previous Browser cowork message is still being attached to the ShellX session.");
    }
    if (activeTask && activeTask.status !== "running") {
      throw new Error(`Browser task is ${activeTask.status}; use its operator controls before sending.`);
    }
    pendingDispatchRef.current = true;
    pendingDispatchTargetRef.current = session.tabId;
    setDispatchPending(true);
    setDispatchErrors([]);
    let response: BrowserCoworkPromptResponse;
    try {
      response = await sendBrowserCoworkPrompt({
        taskId: activeTask?.taskId,
        targetTabId: session.tabId,
        prompt: request.prompt,
        startUrl: request.startUrl,
        profileId: request.profileId,
        autonomy: request.autonomy,
      });
    } catch (error) {
      clearPendingDispatch();
      throw error;
    }
    if (pendingDispatchRef.current === true) {
      pendingDispatchRef.current = response.requestId;
      dispatchTimeoutRef.current = window.setTimeout(() => {
        if (pendingDispatchRef.current !== response.requestId) return;
        clearPendingDispatch();
        if (response.targetTabId !== sessionTabIdRef.current) return;
        setDispatchErrors((current) => [...current, {
          id: `dispatch-timeout-${response.requestId}`,
          role: "system" as const,
          label: "ShellX",
          text: "The main ShellX session did not acknowledge this Browser message in time.",
          t: Date.now(),
        }].slice(-8));
      }, COWORK_DISPATCH_TIMEOUT_MS);
    }
    if (!response.createdTask) {
      setLocalPrompts((current) => [...current, {
        id: `prompt-${response.requestId}`,
        taskId: response.task.taskId,
        text: request.prompt.trim(),
        t: Date.now(),
      }].slice(-40));
    }
    void refreshUiState().catch(() => undefined);
    return response;
  }, [activeTask, clearPendingDispatch, refreshUiState, session]);

  const messages = useMemo(() => [
    ...buildBrowserCoworkMessages(sessionEvents, activeTask, localPrompts, session),
    ...dispatchErrors,
  ].sort((left, right) => left.t - right.t).slice(-60), [activeTask, dispatchErrors, localPrompts, session, sessionEvents]);
  const canSend = Boolean(
    session
    && !session.isSending
    && !dispatchPending
    && (!activeTask || activeTask.status === "running"),
  );
  return {
    messages,
    sessionLabel: session ? `${session.agentLabel} · ${session.title}` : "No ShellX agent tab",
    canSend,
    onSessionEvent,
    onUiState,
    sendPrompt,
  };
}
