import type { BrowserEvidenceSummary } from "./browserEvidence";

/** Representative evidence used only by the generated public manual build. */
export const PUBLIC_MANUAL_EVIDENCE: BrowserEvidenceSummary = {
  rows: [
    {
      receiptId: "manual-attempt-receipt",
      kind: "browserFlightRecorderExported",
      taskId: "manual-task",
      recordedAtMs: Date.UTC(2026, 7, 24, 11, 58, 0),
      identity: {
        attemptId: "manual-attempt-shellx-home",
        taskId: "manual-task",
        bytes: 18_420,
        sha256: "4e68f7f424bfb5eb84b71a7687a1f69d987bb1695d2c64f479623a5c2f62119d",
        events: 14,
        receipts: 5,
        gapCount: 0,
        redactionCount: 1,
        redactionMarkers: [{
          replacement: "[possible API token]",
          reason: "possible API token",
          ruleId: "sx.redaction.possible-api-token.v1",
          scope: "event.summary",
          originalBytes: 44,
        }],
        sanitizerLossCount: 1,
        sanitizerFidelityLossCount: 1,
        evidenceComplete: true,
      },
    },
    {
      receiptId: "manual-evaluation-receipt",
      kind: "browserEvaluationReportWritten",
      taskId: "manual-task",
      recordedAtMs: Date.UTC(2026, 7, 24, 11, 59, 0),
      identity: {
        reportId: "manual-evaluation-shellx-home",
        taskId: "manual-task",
        bytes: 9_216,
        sha256: "e8458e90f7c121013ac8c82eb905746e8f30817ed4ef8c99bed6308ede230a16",
        baselineAttempts: 1,
        candidateAttempts: 1,
        improvementScore: 0.92,
        improvementRating: "strong",
        evidenceComplete: true,
      },
    },
  ],
  callerScoped: true,
  durableRecovered: 0,
  durableScanTruncated: false,
  durableScanFailed: false,
  durableSkipped: 0,
  schemas: {
    attempt: "shellx.browser-flight-recorder.v1",
    evaluation: "shellx.browser-evaluation.v1",
    ratingPolicy: "shellx.browser-evaluation-rating.v1",
  },
};
