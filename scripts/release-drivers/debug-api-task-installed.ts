import { runReleaseSurfaceDriverCli } from "../lib/release-surface-driver-cli";
import {
  RELEASE_SURFACE_DRIVER_MANIFEST_SCHEMA,
  RELEASE_SURFACE_DRIVER_REPORT_SCHEMA,
  completionTimestamp,
  type ReleaseSurfaceDriverManifest,
  type ReleaseSurfaceDriverOutcome,
  type ReleaseSurfaceDriverReport,
  type ReleaseSurfaceDriverRequest,
} from "../lib/release-surface-driver-protocol";
import { resolveReleaseSurfaceRuntimeCandidate } from "../lib/release-surface-runtime-candidate";
import {
  TASK_DEBUG_API_SURFACES,
  assertIsolatedTaskReleaseProfile,
  localTaskProviderPreset,
  requireArray,
  requireRecord,
  taskDebugOracle,
  taskDraft,
  verifyTaskDefinition,
  verifyTaskError,
  verifyTaskProviderCatalogue,
  verifyTaskReceipts,
  verifyTaskRecord,
  verifyTaskState,
  type JsonRecord,
  type TaskDebugApiSurface,
  type TaskRecordFixture,
} from "./task-release-surface-fixture";

const FIXTURE = "debug-api:isolated-task-definition-lifecycle";
const CLEANUP = "debug-api:soft-delete-owned-task-and-candidate-teardown";

const manifest: ReleaseSurfaceDriverManifest = {
  schema: RELEASE_SURFACE_DRIVER_MANIFEST_SCHEMA,
  id: "debug-api-task-installed",
  kind: "debug-api-route",
  runtimeBinding: "attested-process",
  invocationTransport: "debug-api-direct",
  controllerFiles: ["scripts/release-drivers/task-release-surface-fixture.ts"],
  supportedFixtures: [FIXTURE],
  supportedCleanups: [CLEANUP],
  supportedOracles: TASK_DEBUG_API_SURFACES.map(taskDebugOracle),
};

type Connection = { base: string; token: string };
type ApiResult = { status: number; body: unknown };

async function execute(request: ReleaseSurfaceDriverRequest): Promise<ReleaseSurfaceDriverReport> {
  const startedAt = new Date().toISOString();
  const connection = await resolveReleaseSurfaceRuntimeCandidate(request);
  assertExactAssignments(request);
  const effects = new Map<TaskDebugApiSurface, string>();
  let task: TaskRecordFixture | null = null;
  let agentTaskId: string | null = null;
  let lifecycleError: string | null = null;
  let cleanupError: string | null = null;
  try {
    const profileRoot = assertIsolatedTaskReleaseProfile(request);
    const catalogueResponse = await api(connection, "POST", "/tasks/provider-catalog", {
      preset: localTaskProviderPreset(),
    });
    expectStatus(catalogueResponse, 200, "POST /tasks/provider-catalog");
    const catalogue = verifyTaskProviderCatalogue(catalogueResponse.body);
    effects.set(
      "POST /tasks/provider-catalog",
      "The installed Debug API live-scanned the exact local target into four normalized providers with one fresh opaque snapshot and no binary, credential, or model claims.",
    );

    const uiResponse = await api(connection, "GET", "/state/ui");
    expectStatus(uiResponse, 200, "GET /state/ui for agent Task");
    const ui = requireRecord(uiResponse.body, "GET /state/ui for agent Task");
    const openTabs = requireArray(ui.openTabs, "GET /state/ui openTabs").map((value) => requireRecord(value, "GET /state/ui open tab"));
    const activeTabId = typeof ui.activeTabId === "string" ? ui.activeTabId : "";
    const sourceTab = openTabs.find((tab) => tab.tabId === activeTabId && typeof tab.cwd === "string" && tab.cwd)
      ?? openTabs.find((tab) => typeof tab.tabId === "string" && tab.tabId && typeof tab.cwd === "string" && tab.cwd);
    if (!sourceTab) throw new Error("POST /tasks/agent requires one exact open ShellX conversation with a working folder");
    const callerTabId = String(sourceTab.tabId);
    const agentTaskName = `Agent-created Task ${request.sourceCommit.slice(0, 12)}`;
    const agentCreated = await api(connection, "POST", "/tasks/agent", {
      action: "create",
      userApproved: true,
      name: agentTaskName,
      instruction: "Inspect only the isolated release fixture and record no external change.",
      successCriteria: "Persist one reviewable Task definition without starting a provider.",
      noChangeCriteria: "No provider starts and no external state changes.",
      trigger: { kind: "manual" },
      maxRunMinutes: 10,
      notificationPolicy: "none",
    }, { "X-ShellX-MCP-Caller-ID": callerTabId });
    expectStatus(agentCreated, 201, "POST /tasks/agent");
    const agentEnvelope = requireRecord(agentCreated.body, "POST /tasks/agent");
    const agentSummary = requireRecord(agentEnvelope.task, "POST /tasks/agent task");
    if (agentEnvelope.ok !== true || agentEnvelope.disposition !== "created"
      || typeof agentSummary.taskId !== "string" || !agentSummary.taskId
      || agentSummary.name !== agentTaskName || agentSummary.enabled !== true
      || agentSummary.runTimeLimitMinutes !== 10
      || !Array.isArray(agentSummary.workers) || agentSummary.workers.length !== 1
      || agentEnvelope.run !== null) {
      throw new Error("POST /tasks/agent did not return its exact approved create-without-run receipt");
    }
    agentTaskId = String(agentSummary.taskId);
    const agentListed = await api(connection, "GET", "/tasks");
    expectStatus(agentListed, 200, "GET /tasks after agent create");
    const agentRows = requireArray(requireRecord(agentListed.body, "GET /tasks after agent create").tasks, "GET /tasks agent rows");
    if (agentRows.length !== 1) throw new Error("POST /tasks/agent did not persist exactly one reviewable Task");
    verifyTaskRecord(agentRows[0], agentTaskName, false, 1);
    const removeAgentTask = await api(connection, "DELETE", `/tasks/${encodeURIComponent(agentTaskId)}`);
    expectStatus(removeAgentTask, 204, "DELETE agent-created Task");
    agentTaskId = null;
    effects.set(
      "POST /tasks/agent",
      "The installed Debug API accepted explicit current-conversation approval, derived the exact open-tab environment and one freshly ready worker, persisted one reviewable Task, started no provider, and removed only that owned fixture Task.",
    );

    const initialDraft = taskDraft(request, profileRoot, catalogue, 1);
    const created = await api(connection, "POST", "/tasks", { draft: initialDraft, paused: true });
    expectStatus(created, 201, "POST /tasks");
    task = verifyTaskRecord(requireRecord(created.body, "POST /tasks").task, String(initialDraft.name), true, 1);
    effects.set(
      "POST /tasks",
      "The installed Debug API persisted one paused, provider-neutral Task definition and immutable revision in the isolated candidate profile.",
    );

    const listed = await api(connection, "GET", "/tasks");
    expectStatus(listed, 200, "GET /tasks");
    const listedTasks = requireArray(requireRecord(listed.body, "GET /tasks").tasks, "GET /tasks tasks");
    if (listedTasks.length !== 1) throw new Error("GET /tasks did not return exactly the owned active Task");
    verifyTaskRecord(listedTasks[0], task.definition.name, true, 1);
    effects.set("GET /tasks", "The installed Debug API listed exactly the owned active Task and its immutable current revision.");

    const states = await api(connection, "GET", "/tasks/states");
    expectStatus(states, 200, "GET /tasks/states");
    const stateRows = requireArray(requireRecord(states.body, "GET /tasks/states").states, "GET /tasks/states states");
    if (stateRows.length !== 1) throw new Error("GET /tasks/states did not return exactly one owned projection");
    verifyTaskState(stateRows[0], task);
    effects.set("GET /tasks/states", "The installed Debug API returned exactly one bounded paused state projection for the owned Task.");

    const resumed = await api(connection, "POST", taskPath(task, "/resume"));
    expectStatus(resumed, 200, "POST /tasks/:task_id/resume");
    verifyTaskDefinition(requireRecord(resumed.body, "Task resume").definition, task, false);
    effects.set("POST /tasks/:task_id/resume", "The installed Debug API resumed exactly the owned definition without changing its immutable revision.");

    const paused = await api(connection, "POST", taskPath(task, "/pause"));
    expectStatus(paused, 200, "POST /tasks/:task_id/pause");
    verifyTaskDefinition(requireRecord(paused.body, "Task pause").definition, task, true);
    effects.set("POST /tasks/:task_id/pause", "The installed Debug API paused exactly the owned definition without changing its immutable revision.");

    const revisedDraft = taskDraft(request, profileRoot, catalogue, 2);
    const revised = await api(connection, "POST", taskPath(task, "/revise"), {
      precondition: {
        expectedRevisionId: task.definition.currentRevisionId,
        expectedRevisionHash: task.definition.currentRevisionHash,
      },
      draft: revisedDraft,
    });
    expectStatus(revised, 200, "POST /tasks/:task_id/revise");
    task = verifyTaskRecord(requireRecord(revised.body, "Task revise").task, String(revisedDraft.name), true, 2);
    effects.set("POST /tasks/:task_id/revise", "The installed Debug API appended revision two under the exact revision-id and hash precondition.");

    const fetched = await api(connection, "GET", taskPath(task));
    expectStatus(fetched, 200, "GET /tasks/:task_id");
    verifyTaskRecord(requireRecord(fetched.body, "Task get").task, task.definition.name, true, 2);
    effects.set("GET /tasks/:task_id", "The installed Debug API fetched the exact owned definition and current revision-two CAS identity.");

    const state = await api(connection, "GET", taskPath(task, "/state"));
    expectStatus(state, 200, "GET /tasks/:task_id/state");
    verifyTaskState(requireRecord(state.body, "Task state").state, task);
    effects.set("GET /tasks/:task_id/state", "The installed Debug API returned the exact bounded state and empty run history for revision two.");

    const receipts = await api(connection, "GET", taskPath(task, "/receipts?limit=32"));
    expectStatus(receipts, 200, "GET /tasks/:task_id/receipts");
    verifyTaskReceipts(requireRecord(receipts.body, "Task receipts").receipts, task);
    effects.set("GET /tasks/:task_id/receipts", "The installed Debug API returned a bounded, increasing, hash-linked receipt tail for the owned definition lifecycle.");

    const attention = await api(connection, "GET", taskPath(task, "/attention?limit=24"));
    expectStatus(attention, 200, "GET /tasks/:task_id/attention");
    if (requireArray(requireRecord(attention.body, "Task attention").attention, "Task attention rows").length !== 0) {
      throw new Error("new paused Task unexpectedly exposed unresolved attention");
    }
    effects.set("GET /tasks/:task_id/attention", "The installed Debug API returned the exact empty unresolved-attention list for the new paused Task.");

    const run = await api(connection, "POST", taskPath(task, "/run"), {
      revisionId: task.definition.currentRevisionId,
      revisionHash: task.definition.currentRevisionHash,
    });
    expectStatus(run, 409, "POST /tasks/:task_id/run");
    verifyTaskError(run.body, "task_run_not_available");
    effects.set("POST /tasks/:task_id/run", "The installed Debug API refused a paused Task before creating an occurrence or dispatching any provider.");

    const cancel = await api(connection, "POST", "/tasks/runs/final-task-absent-occurrence/cancel", {
      attemptId: "final-task-absent-attempt",
    });
    expectStatus(cancel, 409, "POST /tasks/runs/:occurrence_id/cancel");
    verifyTaskError(cancel.body, "task_attempt_not_active");
    effects.set("POST /tasks/runs/:occurrence_id/cancel", "The installed Debug API rejected an inactive exact attempt without creating cancellation state.");

    const attentionResolve = await api(
      connection,
      "POST",
      taskPath(task, "/attention/final-task-absent-attention/resolve"),
      { expectedOpenedAtMs: 1 },
    );
    expectStatus(attentionResolve, 404, "POST /tasks/:task_id/attention/:attention_id/resolve");
    verifyTaskError(attentionResolve.body, "task_not_found");
    effects.set("POST /tasks/:task_id/attention/:attention_id/resolve", "The installed Debug API refused an absent attention identity without manufacturing an acknowledgement.");

    const overflowResolve = await api(
      connection,
      "POST",
      taskPath(task, "/attention/overflow/resolve"),
      {
        expectedAttentionId: "final-task-absent-overflow",
        expectedOmittedCount: 1,
        expectedUpdatedAtMs: 1,
      },
    );
    expectStatus(overflowResolve, 404, "POST /tasks/:task_id/attention/overflow/resolve");
    verifyTaskError(overflowResolve.body, "task_not_found");
    effects.set("POST /tasks/:task_id/attention/overflow/resolve", "The installed Debug API refused an absent overflow identity and count without clearing any attention state.");

    const deleted = await api(connection, "DELETE", taskPath(task));
    expectStatus(deleted, 204, "DELETE /tasks/:task_id");
    const afterDelete = await api(connection, "GET", "/tasks");
    expectStatus(afterDelete, 200, "GET /tasks after delete");
    if (requireArray(requireRecord(afterDelete.body, "Task list after delete").tasks, "Task list after delete rows")
      .some((value) => requireRecord(value, "Task list after delete row").definition
        && requireRecord(requireRecord(value, "Task list after delete row").definition, "Task list definition").taskId === task!.definition.taskId)) {
      throw new Error("DELETE /tasks/:task_id retained the owned active definition");
    }
    effects.set("DELETE /tasks/:task_id", "The installed Debug API soft-deleted exactly the owned Task and removed it from current Task projections.");
    task = null;
  } catch (error) {
    lifecycleError = error instanceof Error ? error.message : String(error);
  } finally {
    if (agentTaskId) {
      try {
        const response = await api(connection, "DELETE", `/tasks/${encodeURIComponent(agentTaskId)}`);
        if (response.status !== 204 && response.status !== 404) {
          throw new Error(`agent Task cleanup DELETE returned ${response.status}`);
        }
      } catch (error) {
        cleanupError = error instanceof Error ? error.message : String(error);
      }
    }
    if (task) {
      try {
        const response = await api(connection, "DELETE", taskPath(task));
        if (response.status !== 204 && response.status !== 404) {
          throw new Error(`cleanup DELETE returned ${response.status}`);
        }
      } catch (error) {
        cleanupError = error instanceof Error ? error.message : String(error);
      }
    }
  }

  const outcomes = request.assignments.map((assignment): ReleaseSurfaceDriverOutcome => {
    const name = assignment.surface.name as TaskDebugApiSurface;
    const observedEffect = effects.get(name);
    const error = [lifecycleError, cleanupError ? `cleanup: ${cleanupError}` : null]
      .filter(Boolean).join("; ");
    return {
      id: assignment.surface.id,
      expectedEffect: assignment.expectedEffect,
      oracleId: assignment.oracleId,
      present: observedEffect ? "pass" : "fail",
      invoke: observedEffect ? "pass" : "fail",
      effect: observedEffect ? "pass" : "fail",
      cleanup: cleanupError ? "fail" : "pass",
      observedEffect: observedEffect ?? "The isolated Task Debug API lifecycle did not reach this route.",
      ...(error ? { error } : {}),
    };
  });
  return report(request, startedAt, outcomes);
}

function assertExactAssignments(request: ReleaseSurfaceDriverRequest): void {
  const names = request.assignments.map((assignment) => assignment.surface.name).sort();
  const expected = [...TASK_DEBUG_API_SURFACES].sort();
  if (JSON.stringify(names) !== JSON.stringify(expected)) {
    throw new Error(`Task Debug API driver requires exactly ${expected.length} route assignments`);
  }
  for (const assignment of request.assignments) {
    const name = assignment.surface.name as TaskDebugApiSurface;
    if (assignment.fixtureId !== FIXTURE || assignment.cleanupId !== CLEANUP
      || assignment.oracleId !== taskDebugOracle(name)) {
      throw new Error(`Task Debug API assignment drifted: ${assignment.surface.id}`);
    }
  }
}

async function api(
  connection: Connection,
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: JsonRecord,
  additionalHeaders: Record<string, string> = {},
): Promise<ApiResult> {
  const response = await fetch(`${connection.base}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${connection.token}`,
      ...additionalHeaders,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  let parsed: unknown = null;
  if (text.trim()) {
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`${method} ${path} returned non-JSON status ${response.status}`);
    }
  }
  return { status: response.status, body: parsed };
}

function expectStatus(result: ApiResult, expected: number, label: string): void {
  if (result.status !== expected) {
    throw new Error(`${label} returned ${result.status}, expected ${expected}: ${JSON.stringify(result.body)}`);
  }
}

function taskPath(task: TaskRecordFixture, suffix = ""): string {
  return `/tasks/${encodeURIComponent(task.definition.taskId)}${suffix}`;
}

function report(
  request: ReleaseSurfaceDriverRequest,
  startedAt: string,
  outcomes: ReleaseSurfaceDriverOutcome[],
): ReleaseSurfaceDriverReport {
  return {
    schema: RELEASE_SURFACE_DRIVER_REPORT_SCHEMA,
    mode: request.mode,
    driverId: request.driverId,
    driverKind: request.driverKind,
    platform: request.platform,
    sourceCommit: request.sourceCommit,
    version: request.version,
    inventoryDigest: request.inventoryDigest,
    artifactSha256: request.artifact.sha256,
    controller: request.controller,
    runtime: request.runtime,
    startedAt,
    completedAt: completionTimestamp(startedAt),
    outcomes,
  };
}

runReleaseSurfaceDriverCli(manifest, execute).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
