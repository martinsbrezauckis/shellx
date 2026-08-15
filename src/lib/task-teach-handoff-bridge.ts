import { useEffect, useRef } from "react";
import { emitTo, listen } from "@tauri-apps/api/event";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";

import { inTauri } from "./tauri-bridge";
import {
  normalizeBrowserTeachTaskHandoff,
  normalizeBrowserTeachTaskHandoffResult,
  TASK_TEACH_HANDOFF_EVENT,
  TASK_TEACH_HANDOFF_RESULT_EVENT,
  type BrowserTeachTaskHandoff,
} from "./task-teach-handoff-events";

const MAIN_WINDOW_LABEL = "main";
const BROWSER_WINDOW_LABEL = "shellx-browser";
const HANDOFF_ACK_TIMEOUT_MS = 5_000;

export async function openTaskDraftFromBrowserTeach(
  handoff: BrowserTeachTaskHandoff,
): Promise<void> {
  if (!inTauri()) throw new Error("Create Task is available only inside ShellX desktop.");
  const exact = normalizeBrowserTeachTaskHandoff(handoff);
  if (!exact) throw new Error("Browser Teach returned an invalid Task handoff receipt.");
  const main = await WebviewWindow.getByLabel(MAIN_WINDOW_LABEL);
  if (!main) throw new Error("Open the main ShellX workspace before creating a Task draft.");

  let stop: (() => void) | undefined;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let pending = true;
  const result = new Promise<void>((resolve, reject) => {
    timeoutId = setTimeout(
      () => {
        if (!pending) return;
        pending = false;
        reject(new Error("The main ShellX workspace did not acknowledge the Task draft."));
      },
      HANDOFF_ACK_TIMEOUT_MS,
    );
    void listen<unknown>(TASK_TEACH_HANDOFF_RESULT_EVENT, ({ payload }) => {
      const ack = normalizeBrowserTeachTaskHandoffResult(payload);
      if (!pending || !ack || ack.requestId !== exact.requestId) return;
      pending = false;
      if (ack.ok) resolve();
      else reject(new Error(ack.error ?? "The main ShellX workspace did not accept the Task draft."));
    }).then((unlisten) => {
      if (!pending) {
        unlisten();
        return;
      }
      stop = unlisten;
      const fail = (cause: unknown): void => {
        if (!pending) return;
        pending = false;
        reject(cause);
      };
      void emitTo(MAIN_WINDOW_LABEL, TASK_TEACH_HANDOFF_EVENT, exact).catch(fail);
      void main.unminimize().then(() => main.show()).then(() => main.setFocus()).catch(() => undefined);
    }).catch((cause) => {
      if (!pending) return;
      pending = false;
      reject(cause);
    });
  });
  try {
    await result;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    stop?.();
  }
}

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
