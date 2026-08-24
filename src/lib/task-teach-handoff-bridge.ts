import { useEffect, useRef } from "react";
import { emitTo, listen } from "@tauri-apps/api/event";

import { inTauri } from "./tauri-bridge";
import {
  normalizeBrowserTeachTaskHandoff,
  TASK_TEACH_HANDOFF_EVENT,
  TASK_TEACH_HANDOFF_RESULT_EVENT,
  type BrowserTeachTaskHandoff,
} from "./task-teach-handoff-events";

const BROWSER_WINDOW_LABEL = "shellx-browser";

export function useBrowserTeachTaskHandoffBridge(
  openDraft: (handoff: BrowserTeachTaskHandoff) => Promise<void> | void,
): void {
  const openDraftRef = useRef(openDraft);
  useEffect(() => {
    openDraftRef.current = openDraft;
  }, [openDraft]);

  useEffect(() => {
    if (!inTauri()) return;
    let disposed = false;
    let stop: (() => void) | undefined;
    let tail = Promise.resolve();
    const settled = new Map<string, { ok: boolean; error?: string }>();
    const acknowledge = async (requestId: string, result: { ok: boolean; error?: string }): Promise<void> => {
      if (disposed) return;
      await emitTo(BROWSER_WINDOW_LABEL, TASK_TEACH_HANDOFF_RESULT_EVENT, {
        requestId,
        ...result,
      }).catch(() => undefined);
    };
    void listen<unknown>(TASK_TEACH_HANDOFF_EVENT, ({ payload }) => {
      const handoff = normalizeBrowserTeachTaskHandoff(payload);
      if (!handoff || disposed) return;
      tail = tail.then(async () => {
        const prior = settled.get(handoff.requestId);
        if (prior) {
          await acknowledge(handoff.requestId, prior);
          return;
        }
        let ok = false;
        let error: string | undefined;
        try {
          await openDraftRef.current(handoff);
          ok = true;
        } catch (cause) {
          const raw = cause instanceof Error ? cause.message : String(cause);
          error = raw.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 280)
            || "The Task draft could not be opened.";
        }
        const result = { ok, ...(error ? { error } : {}) };
        if (ok) {
          settled.set(handoff.requestId, result);
          if (settled.size > 64) {
            const oldestRequestId = settled.keys().next().value;
            if (typeof oldestRequestId === "string") settled.delete(oldestRequestId);
          }
        }
        await acknowledge(handoff.requestId, result);
      }).catch(() => undefined);
    }).then((unlisten) => {
      if (disposed) unlisten();
      else stop = unlisten;
    }).catch(() => undefined);
    return () => {
      disposed = true;
      stop?.();
    };
  }, []);
}
