import type { TaskManagerData, TaskManagerDraft, TaskProviderCatalogue } from "./task-manager-contract";

export const TASK_MANAGER_MANUAL_SAMPLE_NOW_MS = 1_786_112_400_000;

export const TASK_MANAGER_MANUAL_SAMPLE_CATALOGUE: TaskProviderCatalogue = {
  schemaVersion: "shellx.task-provider-catalog.v1",
  guidanceProvenance: {
    source: "bundled-model-instruction-cards",
    cardsVersion: "2026-08-11.1",
    cardsLastReviewed: "2026-08-11",
    reviewScope: "bundled-descriptive-guidance",
    availabilityAuthority: "fresh-exact-target-task-provider-catalog",
    nativeCapabilityEvidence: "requires-provider-specific-native-canary",
  },
  environmentKey: "local",
  snapshotId: "sha256:8e1a0af5b127e67dbf23547b7c5d3dc541096ef1c19559e2ce40fd667dc5cc90",
  generatedAtMs: TASK_MANAGER_MANUAL_SAMPLE_NOW_MS - 1_000,
  freshUntilMs: TASK_MANAGER_MANUAL_SAMPLE_NOW_MS + 60_000,
  target: { key: "local:linux", label: "This computer", transport: "local", runtime: "posix" },
  providers: [
    {
      providerId: "grok",
      label: "Grok",
      availability: { status: "ready", canRun: true, version: "grok 1.4.0", detail: "Ready on This computer.", checkedAtMs: TASK_MANAGER_MANUAL_SAMPLE_NOW_MS - 1_000 },
      capabilityGuidance: [{ id: "research", label: "Research guidance", level: "Guidance", sourceCardIds: ["grok-research"] }],
      models: [{ id: "grok-sample-fast", label: "Grok sample fast", source: "providerNative", verifiedAtMs: TASK_MANAGER_MANUAL_SAMPLE_NOW_MS - 1_000 }],
      defaultModelMode: "providerDefault",
    },
    {
      providerId: "codex-cli",
      label: "Codex CLI",
      availability: { status: "authNeeded", canRun: false, detail: "The CLI reported that this target needs authentication.", checkedAtMs: TASK_MANAGER_MANUAL_SAMPLE_NOW_MS - 1_000 },
      capabilityGuidance: [{ id: "code", label: "Code guidance", level: "Guidance", sourceCardIds: ["codex-cli"] }],
      models: [],
      defaultModelMode: "providerDefault",
    },
  ],
};

export const TASK_MANAGER_MANUAL_SAMPLE_DRAFT: TaskManagerDraft = {
  originRequestId: "composer-request-sample-001",
  originRevision: 1,
  name: "Review the weekly changelog",
  instruction: "Review the project changelog and report only material changes.",
  environmentKey: "local",
  schedule: {
    trigger: { kind: "weekdays", at: { hour: 9, minute: 0 } },
    timezone: "Europe/Riga",
    missedRunPolicy: "skip",
    maxRunSeconds: 600,
    notificationPolicy: "attentionOnly",
  },
  enabled: true,
  candidates: [{ providerId: "grok", modelMode: "providerDefault", order: 1 }],
};

export const TASK_MANAGER_MANUAL_SAMPLE_DATA: TaskManagerData = {
  loadState: "ready",
  environments: [
    { key: "local", label: "This computer", transport: "local", runtime: "posix", projectLabel: "ShellX", cwdLabel: "/projects/shellx" },
    { key: "remote-windows", label: "Remote Windows", transport: "ssh", runtime: "Windows", projectLabel: "ShellX", cwdLabel: "C:\\Projects\\shellx" },
  ],
  providerCatalogue: TASK_MANAGER_MANUAL_SAMPLE_CATALOGUE,
  providerCatalogueState: { state: "ready" },
  selectedDefinitionId: "task-sample-001",
  definitions: [{
    id: "task-sample-001",
    revisionId: "revision-sample-001",
    revisionHash: "e65b5f7d55e0ae60a9a511b3d1f41bfb7a38e5fb7ee2974d70b55d0bfe7a3e5c",
    name: "Review the weekly changelog",
    instructionPreview: "Review the project changelog and report only material changes.",
    state: "needsAttention",
    enabled: true,
    environmentKey: "local",
    environmentLabel: "This computer",
    projectLabel: "ShellX",
    providerIds: ["grok"],
    providerRouteSummary: "Grok · Provider default",
    scheduleSummary: "Weekdays at 09:00 (Europe/Riga)",
    updatedAtMs: TASK_MANAGER_MANUAL_SAMPLE_NOW_MS - 5_000,
    attention: { kind: "outcomeUnknown", count: 2, updatedAtMs: TASK_MANAGER_MANUAL_SAMPLE_NOW_MS - 5_000 },
  }],
  selectedDefinition: {
    id: "task-sample-001",
    revisionId: "revision-sample-001",
    revisionHash: "e65b5f7d55e0ae60a9a511b3d1f41bfb7a38e5fb7ee2974d70b55d0bfe7a3e5c",
    name: "Review the weekly changelog",
    instructionPreview: "Review the project changelog and report only material changes.",
    instruction: "Review the project changelog and report only material changes.",
    state: "needsAttention",
    enabled: true,
    environmentKey: "local",
    environmentLabel: "This computer",
    projectLabel: "ShellX",
    providerIds: ["grok"],
    providerRouteSummary: "Grok · Provider default",
    scheduleSummary: "Weekdays at 09:00 (Europe/Riga)",
    updatedAtMs: TASK_MANAGER_MANUAL_SAMPLE_NOW_MS - 5_000,
    attention: { kind: "outcomeUnknown", count: 2, updatedAtMs: TASK_MANAGER_MANUAL_SAMPLE_NOW_MS - 5_000 },
    candidates: [{ providerId: "grok", modelMode: "providerDefault", order: 1 }],
    schedule: {
      trigger: { kind: "weekdays", at: { hour: 9, minute: 0 } },
      timezone: "Europe/Riga",
      missedRunPolicy: "skip",
      maxRunSeconds: 600,
      notificationPolicy: "attentionOnly",
    },
    permissionSummary: "Review before external effects",
    notificationSummary: "Notify on attention",
    workflowSummary: "workflow-sample-001",
    vaultSummary: "1 named requirement",
    draftContext: {
      connectionKey: "local",
      canonicalCwd: "/projects/shellx",
      projectId: "shellx",
      agentSuggestion: "grok",
      permissionMode: "default",
      autonomyMode: "default",
      toolExposureIds: ["nativeFirst"],
      attachmentRefs: [{
        attachmentId: "task-attachment:v1:1111111111111111111111111111111111111111111111111111111111111111",
        digest: "sha256:2222222222222222222222222222222222222222222222222222222222222222",
      }],
      workflow: {
        workflowId: "workflow-sample-001",
        digest: "sha256:3333333333333333333333333333333333333333333333333333333333333333",
      },
      vaultRequirements: [{ keyId: "vault-key-sample", grantId: "vault-grant-sample" }],
      concurrencyPolicy: { maxActiveRuns: 1 },
      retryPolicy: { maxAttempts: 1, idempotentObservationOnly: false },
      retentionPolicy: { maxReceipts: 128 },
    },
    attentionItems: [
      {
        attentionId: "attention-sample-outcome-unknown",
        source: "occurrenceOutcomeUnknown",
        occurrenceId: "run-sample-unknown",
        revisionId: "revision-sample-001",
        openedAtMs: TASK_MANAGER_MANUAL_SAMPLE_NOW_MS - 20_000,
      },
    ],
    runHistory: [
      {
        id: "run-sample-pending",
        state: "pending",
        startedAtMs: TASK_MANAGER_MANUAL_SAMPLE_NOW_MS - 70_000,
        receiptCount: 1,
        timeline: [{ receiptId: "receipt-pending", occurredAtMs: TASK_MANAGER_MANUAL_SAMPLE_NOW_MS - 70_000, kind: "occurrenceScheduled" }],
      },
      {
        id: "run-sample-running",
        state: "running",
        attemptId: "task-attempt:run-sample-running:1",
        startedAtMs: TASK_MANAGER_MANUAL_SAMPLE_NOW_MS - 60_000,
        receiptCount: 4,
        environmentEvidence: {
          savedDefinitionSnapshot: { snapshotId: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", capturedAtMs: TASK_MANAGER_MANUAL_SAMPLE_NOW_MS - 120_000 },
          freshExecutionScan: { snapshotId: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", generatedAtMs: TASK_MANAGER_MANUAL_SAMPLE_NOW_MS - 60_000, freshUntilMs: TASK_MANAGER_MANUAL_SAMPLE_NOW_MS },
        },
        timeline: [
          { receiptId: "receipt-running-scheduled", occurredAtMs: TASK_MANAGER_MANUAL_SAMPLE_NOW_MS - 60_000, kind: "occurrenceScheduled" },
          { receiptId: "receipt-running-claim", occurredAtMs: TASK_MANAGER_MANUAL_SAMPLE_NOW_MS - 59_000, kind: "occurrenceClaimed" },
          { receiptId: "receipt-running-route-1", occurredAtMs: TASK_MANAGER_MANUAL_SAMPLE_NOW_MS - 58_000, kind: "providerDecision", provider: { providerId: "grok", candidateOrder: 1, verdict: "rejectedPreEffect", reason: "rateLimitedBeforeStart" } },
          { receiptId: "receipt-running-route-2", occurredAtMs: TASK_MANAGER_MANUAL_SAMPLE_NOW_MS - 57_000, kind: "providerDecision", provider: { providerId: "codex-cli", candidateOrder: 2, verdict: "selected" } },
          { receiptId: "receipt-running-start", occurredAtMs: TASK_MANAGER_MANUAL_SAMPLE_NOW_MS - 56_000, kind: "committedStart", provider: { providerId: "codex-cli", candidateOrder: 2, verdict: "started" } },
        ],
      },
      {
        id: "run-sample-completed",
        state: "completed",
        conversationSessionId: "task-run-0123456789abcdef0123456789abcdef",
        startedAtMs: TASK_MANAGER_MANUAL_SAMPLE_NOW_MS - 50_000,
        completedAtMs: TASK_MANAGER_MANUAL_SAMPLE_NOW_MS - 40_000,
        receiptCount: 7,
        traceEvidence: {
          state: "complete",
          archiveSha256: "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
          archiveBytes: 4_096,
          recordCount: 9,
          providerEventCount: 5,
          droppedEventCount: 0,
          terminalMarkerPresent: true,
          recoveredAfterRestart: false,
          recordedAtMs: TASK_MANAGER_MANUAL_SAMPLE_NOW_MS - 39_500,
        },
        resultEvidence: {
          state: "complete",
          browserTaskCount: 1,
          exportedBrowserTaskCount: 1,
          recorderCount: 1,
          evaluationCount: 1,
          identities: [
            {
              kind: "browserFlightRecorder",
              evidenceId: "browser-attempt-sample",
              artifactSha256: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
              browserReceiptId: "browser-receipt-sample",
              evidenceComplete: true,
              createdAtMs: TASK_MANAGER_MANUAL_SAMPLE_NOW_MS - 39_000,
            },
            {
              kind: "browserEvaluation",
              evidenceId: "browser-evaluation-sample",
              artifactSha256: "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
              evidenceDigest: "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
              browserReceiptId: "browser-evaluation-receipt-sample",
              evidenceComplete: true,
              createdAtMs: TASK_MANAGER_MANUAL_SAMPLE_NOW_MS - 38_500,
            },
          ],
          recordedAtMs: TASK_MANAGER_MANUAL_SAMPLE_NOW_MS - 39_000,
        },
        timeline: [
          { receiptId: "receipt-completed", occurredAtMs: TASK_MANAGER_MANUAL_SAMPLE_NOW_MS - 40_000, kind: "terminal", provider: { providerId: "grok", candidateOrder: 1, verdict: "succeeded" } },
          { receiptId: "receipt-trace-evidence", occurredAtMs: TASK_MANAGER_MANUAL_SAMPLE_NOW_MS - 39_500, kind: "traceEvidence" },
          { receiptId: "receipt-result-evidence", occurredAtMs: TASK_MANAGER_MANUAL_SAMPLE_NOW_MS - 39_000, kind: "resultEvidence" },
        ],
      },
      {
        id: "run-sample-unknown",
        state: "outcomeUnknown",
        startedAtMs: TASK_MANAGER_MANUAL_SAMPLE_NOW_MS - 30_000,
        completedAtMs: TASK_MANAGER_MANUAL_SAMPLE_NOW_MS - 20_000,
        receiptCount: 4,
        timeline: [{ receiptId: "receipt-unknown", occurredAtMs: TASK_MANAGER_MANUAL_SAMPLE_NOW_MS - 20_000, kind: "terminal", provider: { providerId: "grok", candidateOrder: 1, verdict: "outcomeUnknown", reason: "outcomeUnknown" } }],
      },
      {
        id: "run-sample-missed",
        state: "missedNeedsAttention",
        completedAtMs: TASK_MANAGER_MANUAL_SAMPLE_NOW_MS - 5_000,
        receiptCount: 2,
        timeline: [
          { receiptId: "receipt-missed", occurredAtMs: TASK_MANAGER_MANUAL_SAMPLE_NOW_MS - 5_000, kind: "missedNeedsAttention" },
          { receiptId: "receipt-notification", occurredAtMs: TASK_MANAGER_MANUAL_SAMPLE_NOW_MS - 4_000, kind: "notification" },
        ],
      },
    ],
  },
  vaultGrantOptions: [{
    grantId: "vault-grant-sample",
    keyId: "vault-key-sample",
    operation: "fill",
    origin: "https://example.invalid",
    expiresAtMs: TASK_MANAGER_MANUAL_SAMPLE_NOW_MS + 600_000,
  }],
  vaultGrantState: { state: "ready" },
};

/**
 * Returns a fresh, local-only example for the public manual preview. It never
 * represents a saved task or reaches a provider, Vault, or native controller.
 */
export function taskManagerManualSampleData(): TaskManagerData {
  const data = structuredClone(TASK_MANAGER_MANUAL_SAMPLE_DATA);
  const now = Date.now();
  if (data.providerCatalogue) {
    data.providerCatalogue.generatedAtMs = now - 1_000;
    data.providerCatalogue.freshUntilMs = now + 60_000;
    for (const provider of data.providerCatalogue.providers) {
      provider.availability.checkedAtMs = now - 1_000;
    }
  }
  return data;
}

/** Updates only the local manual example after a visible control is used. */
export function updateTaskManagerManualSample(
  data: TaskManagerData,
  action: "pause" | "resume" | "cancel" | "resolveAttention" | "delete" | "duplicate" | "runNow",
): TaskManagerData {
  const next = structuredClone(data);
  const selected = next.selectedDefinition;
  if (!selected) return next;
  const updateSummary = (state: typeof selected.state, enabled = selected.enabled): void => {
    selected.state = state;
    selected.enabled = enabled;
    next.definitions = next.definitions.map((definition) => (
      definition.id === selected.id ? { ...definition, state, enabled } : definition
    ));
  };
  if (action === "pause") updateSummary("paused", selected.enabled);
  if (action === "resume") updateSummary("recent", selected.enabled);
  if (action === "cancel") {
    const running = selected.runHistory.find((run) => run.state === "running");
    if (running) {
      running.state = "outcomeUnknown";
      running.attemptId = undefined;
      running.completedAtMs = Date.now();
    }
  }
  if (action === "resolveAttention") {
    selected.attentionItems = [];
    selected.attention = undefined;
    next.definitions = next.definitions.map((definition) => (
      definition.id === selected.id ? { ...definition, attention: undefined, state: "recent" } : definition
    ));
    selected.state = "recent";
  }
  if (action === "delete") {
    next.definitions = next.definitions.filter((definition) => definition.id !== selected.id);
    next.selectedDefinition = undefined;
    next.selectedDefinitionId = undefined;
    next.loadState = next.definitions.length === 0 ? "empty" : "ready";
  }
  if (action === "duplicate") {
    const duplicateId = "task-manual-sample-copy";
    const duplicate = {
      ...selected,
      id: duplicateId,
      revisionId: "revision-manual-sample-copy-001",
      name: `Copy of ${selected.name}`,
      state: "paused" as const,
      enabled: false,
      runHistory: [],
      attentionItems: [],
      attention: undefined,
    };
    next.definitions = [...next.definitions, duplicate];
    next.selectedDefinitionId = duplicateId;
    next.selectedDefinition = duplicate;
  }
  if (action === "runNow") {
    selected.runHistory = [{
      id: "run-manual-sample-now",
      state: "pending",
      startedAtMs: Date.now(),
      receiptCount: 1,
      timeline: [{ receiptId: "receipt-manual-sample-run-now", occurredAtMs: Date.now(), kind: "occurrenceScheduled" }],
    }, ...selected.runHistory];
  }
  return next;
}
