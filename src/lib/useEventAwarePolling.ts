import { useCallback, useEffect, useRef } from "react";

export type PollCurrent = () => boolean;

export interface EventAwarePollingOptions {
  enabled: boolean;
  scopeKey: string;
  eventRevision: number;
  intervalMs?: number;
  eventDelayMs?: number;
  poll: (isCurrent: PollCurrent) => Promise<void>;
}

/**
 * Keeps a stable polling loop while coalescing high-frequency renderer events
 * into one trailing refresh. The current-generation predicate prevents an
 * async result from an old tab/scope being applied after navigation.
 */
export function useEventAwarePolling({
  enabled,
  scopeKey,
  eventRevision,
  intervalMs,
  eventDelayMs = 180,
  poll,
}: EventAwarePollingOptions): () => Promise<void> {
  const pollRef = useRef(poll);
  const generationRef = useRef(0);
  const inFlightRef = useRef(false);
  const rerunRef = useRef(false);
  const eventRef = useRef({ scopeKey, eventRevision });

  useEffect(() => {
    pollRef.current = poll;
  }, [poll]);

  const run = useCallback(async (): Promise<void> => {
    if (!enabled) return;
    if (inFlightRef.current) {
      rerunRef.current = true;
      return;
    }
    inFlightRef.current = true;
    try {
      do {
        rerunRef.current = false;
        const generation = generationRef.current;
        const isCurrent = () => enabled && generation === generationRef.current;
        try {
          await pollRef.current(isCurrent);
        } catch {
          // Poll owners retain their prior error/empty-state behavior.
        }
      } while (rerunRef.current && enabled);
    } finally {
      inFlightRef.current = false;
    }
  }, [enabled]);

  useEffect(() => {
    generationRef.current += 1;
    rerunRef.current = false;
    if (!enabled) return;
    void run();
    const id = intervalMs === undefined
      ? null
      : window.setInterval(() => void run(), intervalMs);
    return () => {
      generationRef.current += 1;
      rerunRef.current = false;
      if (id !== null) window.clearInterval(id);
    };
  }, [enabled, intervalMs, run, scopeKey]);

  useEffect(() => {
    const previous = eventRef.current;
    eventRef.current = { scopeKey, eventRevision };
    if (!enabled || previous.scopeKey !== scopeKey || previous.eventRevision === eventRevision) return;
    const id = window.setTimeout(() => void run(), eventDelayMs);
    return () => window.clearTimeout(id);
  }, [enabled, eventDelayMs, eventRevision, run, scopeKey]);

  return run;
}
