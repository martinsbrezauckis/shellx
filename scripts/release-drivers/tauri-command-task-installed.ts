import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
import { ReleaseSurfaceTauriInvokeSession } from "../lib/release-surface-tauri-invoke-client";
import {
  TASK_TAURI_COMMANDS,
  assertIsolatedTaskReleaseProfile,
  localTaskProviderPreset,
  requireArray,
  requireRecord,
  taskDraft,
  taskTauriOracle,
  verifyTaskDefinition,
  verifyTaskProviderCatalogue,
  verifyTaskReceipts,
  verifyTaskRecord,
  verifyTaskState,
  type JsonRecord,
  type TaskRecordFixture,
  type TaskTauriCommand,
} from "./task-release-surface-fixture";

const FIXTURE = "tauri:isolated-task-command-lifecycle";
const CLEANUP = "tauri:soft-delete-owned-task-reclaim-attachment-and-candidate-teardown";

const manifest: ReleaseSurfaceDriverManifest = {
  schema: RELEASE_SURFACE_DRIVER_MANIFEST_SCHEMA,
  id: "tauri-command-task-installed",
  kind: "tauri-command",
  runtimeBinding: "attested-process",
  invocationTransport: "debug-api-direct",
  controllerFiles: [
    "scripts/lib/release-surface-tauri-invoke-client.ts",
    "scripts/release-drivers/task-release-surface-fixture.ts",
  ],
  supportedFixtures: [FIXTURE],
  supportedCleanups: [CLEANUP],
  supportedOracles: TASK_TAURI_COMMANDS.map(taskTauriOracle),
};

const RUN_REFUSAL = "Task occurrence is terminal or requires attention; do not rerun it automatically.";
const CANCEL_REFUSAL = "That Task attempt is no longer active. Reload its run history.";
const ATTENTION_REFUSAL = "Task definition was not found.";
const CUT_REFUSAL = "ShellX Cut needs an active ShellX desktop-host context.";

async function execute(request: ReleaseSurfaceDriverRequest): Promise<ReleaseSurfaceDriverReport> {
  const startedAt = new Date().toISOString();
  const connection = await resolveReleaseSurfaceRuntimeCandidate(request);
  assertExactAssignments(request);
  const relay = new ReleaseSurfaceTauriInvokeSession(connection);
  const effects = new Map<TaskTauriCommand, string>();
  let task: TaskRecordFixture | null = null;
  let attachmentId: string | null = null;
  let ownedInputPath: string | null = null;
  let lifecycleError: string | null = null;
  let cleanupError: string | null = null;

  try {
    const profileRoot = assertIsolatedTaskReleaseProfile(request);
    const catalogue = verifyTaskProviderCatalogue(await relay.invoke("task_provider_catalog", {
      preset: localTaskProviderPreset(),
    }));
    effects.set(
      "task_provider_catalog",
      "The installed Tauri command live-scanned the exact local target into four normalized providers with fresh opaque evidence and no credential or binary paths.",
    );

    const initialDraft = taskDraft(request, profileRoot, catalogue, 1);
    task = verifyTaskRecord(await relay.invoke("tasks_create", {
      request: { draft: initialDraft, paused: true },
    }), String(initialDraft.name), true, 1);
    effects.set("tasks_create", "The installed Tauri command persisted one paused Task and immutable revision in the isolated candidate profile.");

    const listed = requireArray(await relay.invoke("tasks_list", {}), "tasks_list result");
    if (listed.length !== 1) throw new Error("tasks_list did not return exactly the owned active Task");
    verifyTaskRecord(listed[0], task.definition.name, true, 1);
    effects.set("tasks_list", "The installed Tauri command listed exactly the owned active Task and its current immutable revision.");

    const states = requireArray(await relay.invoke("tasks_list_states", {}), "tasks_list_states result");
    if (states.length !== 1) throw new Error("tasks_list_states did not return exactly the owned Task projection");
    verifyTaskState(states[0], task);
    effects.set("tasks_list_states", "The installed Tauri command returned exactly one bounded paused state projection for the owned Task.");

    const resumed = await relay.invoke("tasks_resume", { request: { taskId: task.definition.taskId } });
    verifyTaskDefinition(resumed, task, false);
    effects.set("tasks_resume", "The installed Tauri command resumed exactly the owned definition without changing its immutable revision.");

    const paused = await relay.invoke("tasks_pause", { request: { taskId: task.definition.taskId } });
    verifyTaskDefinition(paused, task, true);
    effects.set("tasks_pause", "The installed Tauri command paused exactly the owned definition without changing its immutable revision.");

    const revisedDraft = taskDraft(request, profileRoot, catalogue, 2);
    task = verifyTaskRecord(await relay.invoke("tasks_revise", {
      request: {
        taskId: task.definition.taskId,
        precondition: {
          expectedRevisionId: task.definition.currentRevisionId,
          expectedRevisionHash: task.definition.currentRevisionHash,
        },
        draft: revisedDraft,
      },
    }), String(revisedDraft.name), true, 2);
    effects.set("tasks_revise", "The installed Tauri command appended revision two under the exact revision-id and hash precondition.");

    verifyTaskRecord(await relay.invoke("tasks_get", {
      request: { taskId: task.definition.taskId },
    }), task.definition.name, true, 2);
    effects.set("tasks_get", "The installed Tauri command fetched the exact owned definition and current revision-two CAS identity.");

    verifyTaskState(await relay.invoke("tasks_get_state", {
      request: { taskId: task.definition.taskId },
    }), task);
    effects.set("tasks_get_state", "The installed Tauri command returned the exact bounded state and empty run history for revision two.");

    verifyTaskReceipts(await relay.invoke("tasks_list_receipts", {
      request: { taskId: task.definition.taskId, limit: 32 },
    }), task);
    effects.set("tasks_list_receipts", "The installed Tauri command returned a bounded, increasing, hash-linked receipt tail for the owned lifecycle.");

    const attention = requireArray(await relay.invoke("tasks_list_open_attention", {
      request: { taskId: task.definition.taskId, limit: 24 },
    }), "tasks_list_open_attention result");
    if (attention.length !== 0) throw new Error("new paused Task unexpectedly exposed attention");
    effects.set("tasks_list_open_attention", "The installed Tauri command returned the exact empty unresolved-attention list for the new paused Task.");

    await requireExactFailure(relay, "tasks_run_now", {
      request: {
        taskId: task.definition.taskId,
        revisionId: task.definition.currentRevisionId,
        revisionHash: task.definition.currentRevisionHash,
      },
    }, RUN_REFUSAL);
    effects.set("tasks_run_now", "The installed Tauri command refused a paused Task before creating an occurrence or dispatching any provider.");

    await requireExactFailure(relay, "tasks_cancel_run", {
      request: {
        occurrenceId: "final-task-absent-occurrence",
        attemptId: "final-task-absent-attempt",
      },
    }, CANCEL_REFUSAL);
    effects.set("tasks_cancel_run", "The installed Tauri command rejected an inactive exact attempt without creating cancellation state.");

    await requireExactFailure(relay, "tasks_resolve_attention", {
      request: {
        taskId: task.definition.taskId,
        attentionId: "final-task-absent-attention",
        expectedOpenedAtMs: 1,
      },
    }, ATTENTION_REFUSAL);
    effects.set("tasks_resolve_attention", "The installed Tauri command refused an absent exact attention identity without manufacturing an acknowledgement.");

    await requireExactFailure(relay, "tasks_resolve_attention_overflow", {
      request: {
        taskId: task.definition.taskId,
        expectedAttentionId: "final-task-absent-overflow",
        expectedOmittedCount: 1,
        expectedUpdatedAtMs: 1,
      },
    }, ATTENTION_REFUSAL);
    effects.set("tasks_resolve_attention_overflow", "The installed Tauri command refused an absent overflow identity and count without clearing attention state.");

    await requireFailureContaining(relay, "cut_tooling_open", {
      tabId: "final-task-absent-cut-tab",
    }, CUT_REFUSAL);
    effects.set("cut_tooling_open", "The installed Tauri command refused the absent desktop-host context before probing or launching ShellX Cut.");

    ownedInputPath = join(profileRoot, ".shellx", `task-release-input-${request.sourceCommit.slice(0, 12)}.txt`);
    writeFileSync(ownedInputPath, "ShellX final Task attachment receipt fixture.\n", {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    const persisted = requireRecord(await relay.invoke("tasks_persist_attachments", {
      request: {
        connectionId: "local",
        canonicalCwd: profileRoot,
        sources: [ownedInputPath],
      },
    }), "tasks_persist_attachments result");
    const attachments = requireArray(persisted.attachments, "persisted Task attachments");
    const attachmentReceipts = requireArray(persisted.receipts, "persisted Task attachment receipts");
    if (persisted.targetKey !== catalogue.target.key || attachments.length !== 1 || attachmentReceipts.length !== 1) {
      throw new Error("tasks_persist_attachments lost its exact target or one-file receipt");
    }
    const attachment = requireRecord(attachments[0], "persisted Task attachment");
    const attachmentReceipt = requireRecord(attachmentReceipts[0], "persisted Task attachment receipt");
    attachmentId = String(attachment.attachmentId ?? "");
    if (!attachmentId || attachmentReceipt.attachmentId !== attachmentId
      || !/^sha256:[a-f0-9]{64}$/.test(String(attachment.digest ?? ""))
      || attachmentReceipt.digest !== attachment.digest
      || attachmentReceipt.targetKey !== catalogue.target.key
      || attachmentReceipt.sizeBytes !== 46) {
      throw new Error("tasks_persist_attachments returned an invalid redacted digest receipt");
    }
    effects.set("tasks_persist_attachments", "The installed Tauri command copied one owned file into the exact local Task target and returned only digest-bound, path-redacted identities.");

    const reclaimed = requireRecord(await relay.invoke("tasks_reclaim_attachments", {
      request: { attachmentIds: [attachmentId] },
    }), "tasks_reclaim_attachments result");
    requireExactStringList(reclaimed.selectedAttachmentIds, [attachmentId], "selected attachments");
    requireExactStringList(reclaimed.reclaimedAttachmentIds, [attachmentId], "reclaimed attachments");
    requireExactStringList(reclaimed.pendingAttachmentIds, [], "pending attachments");
    attachmentId = null;
    effects.set("tasks_reclaim_attachments", "The installed Tauri command reclaimed exactly the unreferenced owned import and reported no pending deletion.");

    const maintained = requireRecord(await relay.invoke("tasks_maintain_attachments", {}), "tasks_maintain_attachments result");
    requireExactStringList(maintained.selectedAttachmentIds, [], "maintained selected attachments");
    requireExactStringList(maintained.reclaimedAttachmentIds, [], "maintained reclaimed attachments");
    requireExactStringList(maintained.pendingAttachmentIds, [], "maintained pending attachments");
    effects.set("tasks_maintain_attachments", "The installed Tauri command ran bounded attachment maintenance and proved no stale owned import remained.");

    await relay.invoke("tasks_delete", { request: { taskId: task.definition.taskId } });
    const afterDelete = requireArray(await relay.invoke("tasks_list", {}), "tasks_list after delete");
    if (afterDelete.some((value) => requireRecord(requireRecord(value, "Task list row").definition, "Task list definition").taskId === task!.definition.taskId)) {
      throw new Error("tasks_delete retained the owned active definition");
    }
    effects.set("tasks_delete", "The installed Tauri command soft-deleted exactly the owned Task and removed it from current Task projections.");
    task = null;
  } catch (error) {
    lifecycleError = error instanceof Error ? error.message : String(error);
  } finally {
    const cleanupErrors: string[] = [];
    if (attachmentId) {
      try {
        await relay.invoke("tasks_reclaim_attachments", { request: { attachmentIds: [attachmentId] } });
      } catch (error) {
        cleanupErrors.push(`attachment: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (task) {
      try {
        await relay.invoke("tasks_delete", { request: { taskId: task.definition.taskId } });
      } catch (error) {
        cleanupErrors.push(`task: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (ownedInputPath) {
      try {
        rmSync(ownedInputPath, { force: true });
      } catch (error) {
        cleanupErrors.push(`input: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    try {
      await relay.cleanup();
    } catch (error) {
      cleanupErrors.push(`relay: ${error instanceof Error ? error.message : String(error)}`);
    }
    cleanupError = cleanupErrors.length > 0 ? cleanupErrors.join("; ") : null;
  }

  const outcomes = request.assignments.map((assignment): ReleaseSurfaceDriverOutcome => {
    const name = assignment.surface.name as TaskTauriCommand;
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
      observedEffect: observedEffect ?? "The isolated Task Tauri lifecycle did not reach this command.",
      ...(error ? { error } : {}),
    };
  });
  return report(request, startedAt, outcomes);
}

function assertExactAssignments(request: ReleaseSurfaceDriverRequest): void {
  const names = request.assignments.map((assignment) => assignment.surface.name).sort();
  const expected = [...TASK_TAURI_COMMANDS].sort();
  if (JSON.stringify(names) !== JSON.stringify(expected)) {
    throw new Error(`Task Tauri driver requires exactly ${expected.length} command assignments`);
  }
  for (const assignment of request.assignments) {
    const name = assignment.surface.name as TaskTauriCommand;
    if (assignment.fixtureId !== FIXTURE || assignment.cleanupId !== CLEANUP
      || assignment.oracleId !== taskTauriOracle(name)) {
      throw new Error(`Task Tauri assignment drifted: ${assignment.surface.id}`);
    }
  }
}

async function requireExactFailure(
  relay: ReleaseSurfaceTauriInvokeSession,
  command: TaskTauriCommand,
  args: JsonRecord,
  expected: string,
): Promise<void> {
  const error = await relay.invokeExpectFailure(command, args);
  if (error !== expected) throw new Error(`${command} returned a different bounded refusal: ${error}`);
}

async function requireFailureContaining(
  relay: ReleaseSurfaceTauriInvokeSession,
  command: TaskTauriCommand,
  args: JsonRecord,
  expected: string,
): Promise<void> {
  const error = await relay.invokeExpectFailure(command, args);
  if (!error.includes(expected)) throw new Error(`${command} returned a different bounded refusal: ${error}`);
}

function requireExactStringList(value: unknown, expected: string[], label: string): void {
  const rows = requireArray(value, label);
  if (rows.some((row) => typeof row !== "string") || JSON.stringify(rows) !== JSON.stringify(expected)) {
    throw new Error(`${label} did not match its exact expected identities`);
  }
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
