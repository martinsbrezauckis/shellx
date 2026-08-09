import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";

import {
  BROWSER_COWORK_DISPATCH_RESULT_EVENT,
  BROWSER_COWORK_PROMPT_EVENT,
  normalizeBrowserCoworkPromptNotification,
  normalizeBrowserCoworkPromptEvent,
  type BrowserCoworkPromptEvent,
} from "./browser-cowork-events";
import { inTauri } from "./tauri-bridge";

export function useBrowserCoworkPromptBridge(
  dispatchPrompt: (request: BrowserCoworkPromptEvent) => Promise<boolean>,
): void {
  const dispatchPromptRef = useRef(dispatchPrompt);
  useEffect(() => {
    dispatchPromptRef.current = dispatchPrompt;
  }, [dispatchPrompt]);

  useEffect(() => {
    if (!inTauri()) return;
    let disposed = false;
    let stopListening: (() => void) | null = null;
    let dispatchTail = Promise.resolve();
    const claimAndDispatch = async (requestId: string) => {
      const claimed = await invoke<unknown>("shellx_browser_claim_cowork_prompt", { requestId })
        .catch(() => null);
      const request = normalizeBrowserCoworkPromptEvent(claimed);
      if (!request || disposed) return;
      let ok = false;
      let error: string | undefined;
      try {
        ok = await dispatchPromptRef.current(request);
        if (!ok) error = "The attached ShellX session did not accept the Browser prompt.";
      } catch (cause) {
        error = cause instanceof Error ? cause.message : String(cause);
      }
      if (disposed) return;
      await emit(BROWSER_COWORK_DISPATCH_RESULT_EVENT, {
        requestId: request.requestId,
        taskId: request.taskId,
        targetTabId: request.targetTabId,
        ok,
        ...(error ? { error } : {}),
      }).catch(() => undefined);
    };
    const enqueueClaim = (requestId: string) => {
      dispatchTail = dispatchTail
        .then(() => claimAndDispatch(requestId))
        .catch(() => undefined);
    };
    void listen<unknown>(BROWSER_COWORK_PROMPT_EVENT, ({ payload }) => {
      const notification = normalizeBrowserCoworkPromptNotification(payload);
      if (!notification || disposed) return;
      enqueueClaim(notification.requestId);
    }).then((stop) => {
      if (disposed) {
        stop();
        return;
      }
      stopListening = stop;
      void invoke("shellx_browser_replay_cowork_prompt_notifications").catch(() => undefined);
    }).catch(() => undefined);
    return () => {
      disposed = true;
      stopListening?.();
    };
  }, []);
}
