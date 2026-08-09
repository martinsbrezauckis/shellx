import { useCallback, useEffect, useRef, useState } from "react";

import {
  exportBrowserFlightRecorderForOperator,
  loadBrowserEvidenceForOperator,
} from "../api";
import {
  normalizeBrowserEvidenceSummary,
  normalizeBrowserFlightRecorderResult,
  type BrowserEvidenceSummary,
  type BrowserFlightRecorderResult,
} from "../browserEvidence";

export function useBrowserEvidence(enabled: boolean): {
  summary: BrowserEvidenceSummary | null;
  loading: boolean;
  recording: boolean;
  error: string | null;
  recordedAttempt: BrowserFlightRecorderResult | null;
  manualRefreshSequence: number;
  manualRefreshCompletedAtMs: number | null;
  refresh: () => Promise<void>;
  recordAttempt: (taskId: string) => Promise<void>;
} {
  const [summary, setSummary] = useState<BrowserEvidenceSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recordedAttempt, setRecordedAttempt] = useState<BrowserFlightRecorderResult | null>(null);
  const [manualRefreshSequence, setManualRefreshSequence] = useState(0);
  const [manualRefreshCompletedAtMs, setManualRefreshCompletedAtMs] = useState<number | null>(null);
  const requestRef = useRef(0);
  const loadEvidence = useCallback(async (): Promise<boolean> => {
    const request = requestRef.current + 1;
    requestRef.current = request;
    setLoading(true);
    setError(null);
    try {
      const response = await loadBrowserEvidenceForOperator(20);
      const next = normalizeBrowserEvidenceSummary(response);
      if (requestRef.current !== request) return false;
      setSummary(next);
      return true;
    } catch (cause) {
      if (requestRef.current === request) {
        setError(cause instanceof Error ? cause.message : "Browser evidence could not be loaded.");
      }
      return false;
    } finally {
      if (requestRef.current === request) setLoading(false);
    }
  }, []);
  const refresh = useCallback(async (): Promise<void> => {
    if (!await loadEvidence()) return;
    setManualRefreshSequence((sequence) => sequence + 1);
    setManualRefreshCompletedAtMs(Date.now());
  }, [loadEvidence]);
  useEffect(() => {
    if (enabled) void loadEvidence();
  }, [enabled, loadEvidence]);
  const recordAttempt = useCallback(async (taskId: string): Promise<void> => {
    const normalizedTaskId = taskId.trim();
    if (!normalizedTaskId) throw new Error("A current browser task is required to record an attempt.");
    setRecording(true);
    setError(null);
    try {
      const response = await exportBrowserFlightRecorderForOperator({
        taskId: normalizedTaskId,
        reason: "Manual Flight Recorder export from Browser Evidence panel",
      });
      setRecordedAttempt(normalizeBrowserFlightRecorderResult(response));
      await loadEvidence();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Browser attempt could not be recorded.");
    } finally {
      setRecording(false);
    }
  }, [loadEvidence]);
  return {
    summary,
    loading,
    recording,
    error,
    recordedAttempt,
    manualRefreshSequence,
    manualRefreshCompletedAtMs,
    refresh,
    recordAttempt,
  };
}
