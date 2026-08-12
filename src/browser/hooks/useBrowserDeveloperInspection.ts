import { useCallback, useEffect, useMemo, useState } from "react";

import {
  approveBrowserDeveloperModeHostForOperator,
  disableBrowserDeveloperModeForOperator,
  exportBrowserHarForOperator,
  exportBrowserPerformanceForOperator,
  inspectBrowserPageForOperator,
} from "../api";
import {
  browserDeveloperInspectionUiState,
  normalizeBrowserDeveloperArtifactReceipt,
  normalizeBrowserDeveloperInspection,
  type BrowserDeveloperArtifactReceipt,
  type BrowserDeveloperInspectionResult,
  type BrowserDeveloperInspectionUiState,
} from "../browserDeveloperInspection";

type BrowserDeveloperAction = "inspect" | "approve" | "disable" | "har" | "performance" | null;

function messageFromCause(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message.trim() ? cause.message : fallback;
}

export function useBrowserDeveloperInspection(activeTaskId: string | null | undefined): {
  result: BrowserDeveloperInspectionResult | null;
  completedAtMs: number | null;
  state: BrowserDeveloperInspectionUiState;
  error: string | null;
  busyAction: BrowserDeveloperAction;
  artifacts: Partial<Record<BrowserDeveloperArtifactReceipt["kind"], BrowserDeveloperArtifactReceipt>>;
  inspect: () => Promise<void>;
  approveCurrentSite: () => Promise<void>;
  disableDeveloperMode: () => Promise<void>;
  exportHar: () => Promise<void>;
  exportPerformance: () => Promise<void>;
} {
  const taskId = activeTaskId?.trim() || null;
  const [result, setResult] = useState<BrowserDeveloperInspectionResult | null>(null);
  const [completedAtMs, setCompletedAtMs] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<BrowserDeveloperAction>(null);
  const [artifacts, setArtifacts] = useState<Partial<Record<BrowserDeveloperArtifactReceipt["kind"], BrowserDeveloperArtifactReceipt>>>({});

  useEffect(() => {
    setResult(null);
    setCompletedAtMs(null);
    setError(null);
    setBusyAction(null);
    setArtifacts({});
  }, [taskId]);

  const requireTask = useCallback((): string => {
    if (!taskId) throw new Error("Start or select a browser task before using Developer inspection.");
    return taskId;
  }, [taskId]);

  const inspect = useCallback(async (): Promise<void> => {
    const currentTaskId = requireTask();
    setBusyAction("inspect");
    setError(null);
    try {
      setResult(normalizeBrowserDeveloperInspection(await inspectBrowserPageForOperator({ taskId: currentTaskId })));
      setCompletedAtMs(Date.now());
    } catch (cause) {
      setResult(null);
      setCompletedAtMs(null);
      setError(messageFromCause(cause, "Developer inspection could not inspect the current page."));
    } finally {
      setBusyAction(null);
    }
  }, [requireTask]);

  const approveCurrentSite = useCallback(async (): Promise<void> => {
    const currentTaskId = requireTask();
    setBusyAction("approve");
    setError(null);
    try {
      await approveBrowserDeveloperModeHostForOperator({ taskId: currentTaskId, fullCdpAccess: true });
      setResult(normalizeBrowserDeveloperInspection(await inspectBrowserPageForOperator({ taskId: currentTaskId })));
      setCompletedAtMs(Date.now());
    } catch (cause) {
      setResult(null);
      setCompletedAtMs(null);
      setError(messageFromCause(cause, "Developer Mode could not be approved for the current site."));
    } finally {
      setBusyAction(null);
    }
  }, [requireTask]);

  const disableDeveloperMode = useCallback(async (): Promise<void> => {
    setBusyAction("disable");
    setError(null);
    try {
      await disableBrowserDeveloperModeForOperator();
      setResult(null);
      setCompletedAtMs(null);
      setArtifacts({});
    } catch (cause) {
      setError(messageFromCause(cause, "Developer Mode could not be disabled."));
    } finally {
      setBusyAction(null);
    }
  }, []);

  const exportArtifact = useCallback(async (kind: BrowserDeveloperArtifactReceipt["kind"]): Promise<void> => {
    const currentTaskId = requireTask();
    setBusyAction(kind);
    setError(null);
    try {
      const response = kind === "har"
        ? await exportBrowserHarForOperator({ taskId: currentTaskId, reason: "Browser Developer inspection HAR export" })
        : await exportBrowserPerformanceForOperator({ taskId: currentTaskId, reason: "Browser Developer inspection performance export" });
      const artifact = normalizeBrowserDeveloperArtifactReceipt(response, kind);
      setArtifacts((current) => ({ ...current, [kind]: artifact }));
    } catch (cause) {
      setError(messageFromCause(cause, `Browser ${kind === "har" ? "HAR" : "performance"} export could not be created.`));
    } finally {
      setBusyAction(null);
    }
  }, [requireTask]);

  const state = useMemo(
    () => browserDeveloperInspectionUiState(taskId, result, busyAction === "inspect", error !== null),
    [busyAction, error, result, taskId],
  );

  return {
    result,
    completedAtMs,
    state,
    error,
    busyAction,
    artifacts,
    inspect,
    approveCurrentSite,
    disableDeveloperMode,
    exportHar: () => exportArtifact("har"),
    exportPerformance: () => exportArtifact("performance"),
  };
}
