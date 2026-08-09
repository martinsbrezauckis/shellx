export interface BrowserWorkflowPreviewSummary {
  bookmarkId: string;
  status: "loading" | "ready" | "error";
  stepsPlanned: number;
  stepsSkipped: number;
  decisionPoints: number;
}

function boundedCount(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? Math.min(value, 1_000)
    : 0;
}

export function parseBrowserWorkflowPreview(
  bookmarkId: string,
  value: unknown,
): BrowserWorkflowPreviewSummary {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Workflow preview response is invalid.");
  }
  const result = value as Record<string, unknown>;
  if (result.ok !== true || result.dryRun !== true) {
    throw new Error("Workflow preview did not remain in dry-run mode.");
  }
  return {
    bookmarkId,
    status: "ready",
    stepsPlanned: boundedCount(result.stepsPlanned),
    stepsSkipped: boundedCount(result.stepsSkipped),
    decisionPoints: Array.isArray(result.decisionPoints)
      ? Math.min(result.decisionPoints.length, 1_000)
      : 0,
  };
}
