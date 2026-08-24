import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { inTauri } from "../lib/tauri-bridge";
import type { ManualMainSurface } from "../lib/manual-surface-handoff";

export const MANUAL_OPEN_EVENT = "shellx:manual-open";

interface PendingManualOpen {
  featureId: string;
  sequence: number;
}

export type ManualSurfaceHandoffResult =
  | { kind: "shown"; featureId: string }
  | { kind: "unsupported"; featureId: string }
  | { kind: "focus-missing"; featureId: string }
  | { kind: "receiver-error" };

/**
 * Drain the Rust-owned last-wins queue after listener registration and every
 * subsequent event. The renderer does not consume URL arguments directly,
 * which keeps the static public-link boundary separate from UI resolution.
 */
export function useManualSurfaceHandoff({
  reveal,
  onResult,
}: {
  reveal: (surface: ManualMainSurface) => Promise<boolean>;
  onResult: (result: ManualSurfaceHandoffResult) => void;
}): void {
  const revealRef = useRef(reveal);
  const resultRef = useRef(onResult);
  revealRef.current = reveal;
  resultRef.current = onResult;

  useEffect(() => {
    if (!inTauri()) return;
    let disposed = false;
    let draining = false;
    let requestedWhileDraining = false;
    let unlisten: UnlistenFn | undefined;

    const drain = async (): Promise<void> => {
      if (draining) {
        requestedWhileDraining = true;
        return;
      }
      draining = true;
      try {
        do {
          requestedWhileDraining = false;
          while (!disposed) {
            let pending: PendingManualOpen | null;
            try {
              pending = await invoke<PendingManualOpen | null>("manual_deep_link_take_pending_main");
            } catch {
              resultRef.current({ kind: "receiver-error" });
              return;
            }
            if (!pending) break;
            const { resolveManualMainSurface } = await import("../lib/manual-surface-handoff");
            const surface = resolveManualMainSurface(pending.featureId);
            if (!surface) {
              resultRef.current({ kind: "unsupported", featureId: pending.featureId });
              continue;
            }
            const focused = await revealRef.current(surface);
            resultRef.current(focused
              ? { kind: "shown", featureId: pending.featureId }
              : { kind: "focus-missing", featureId: pending.featureId });
          }
        } while (!disposed && requestedWhileDraining);
      } finally {
        draining = false;
      }
    };

    void listen(MANUAL_OPEN_EVENT, () => { void drain(); }).then((listener) => {
      // React Strict Mode can clean up this effect before Tauri finishes
      // registering the asynchronous listener. Do not leak that listener or
      // drain a queue from an already-disposed renderer instance.
      if (disposed) {
        listener();
        return;
      }
      unlisten = listener;
      // Cold-start queue: this runs only after the event listener has been
      // registered, so a launch racing this call sets requestedWhileDraining.
      void drain();
    }).catch(() => resultRef.current({ kind: "receiver-error" }));

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);
}
