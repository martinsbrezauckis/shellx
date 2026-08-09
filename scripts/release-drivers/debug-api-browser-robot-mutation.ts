import { existsSync, unlinkSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import type {
  ReleaseSurfaceDriverOutcome,
  ReleaseSurfaceDriverRequest,
} from "../lib/release-surface-driver-protocol";
import {
  prepareOwnedBrowserRecipeArtifact,
  type ArtifactIdentity,
} from "./debug-api-browser-evidence-artifact-mutation";
import {
  cleanupDebugApiBrowserSettleFixture,
  prepareDebugApiBrowserSettleFixture,
} from "./debug-api-browser-settle-fixture";

const BROWSER_ROBOT_MUTATIONS = new Set([
  "POST /browser/robots/schedule",
  "POST /browser/robots/run",
  "POST /browser/robots/cancel",
]);

const TIMEOUT_MS = 30_000;

type DebugApiConnection = { base: string; token: string };
type DriverAssignment = ReleaseSurfaceDriverRequest["assignments"][number];

export function isDebugApiBrowserRobotMutation(name: string): boolean {
  return BROWSER_ROBOT_MUTATIONS.has(name);
}

export async function exerciseDebugApiBrowserRobotMutation(
  connection: DebugApiConnection,
  request: ReleaseSurfaceDriverRequest,
  assignment: DriverAssignment,
): Promise<ReleaseSurfaceDriverOutcome> {
  const outcome: ReleaseSurfaceDriverOutcome = {
    id: assignment.surface.id,
    expectedEffect: assignment.expectedEffect,
    oracleId: assignment.oracleId,
    present: "fail",
    invoke: "fail",
    effect: "fail",
    cleanup: "fail",
    observedEffect: "No exact owned Browser robot lifecycle effect was observed.",
  };
  let fixture: Awaited<ReturnType<typeof prepareDebugApiBrowserSettleFixture>> | null = null;
  let recipeArtifact: ArtifactIdentity | null = null;
  let scheduledJobId: string | null = null;
  let jobTerminal = false;
  try {
    if (!BROWSER_ROBOT_MUTATIONS.has(assignment.surface.name)) {
      throw new Error(`unsupported Browser robot route ${assignment.surface.name}`);
    }
    fixture = await prepareDebugApiBrowserSettleFixture(connection);
    const recipe = await prepareOwnedBrowserRecipeArtifact(connection, request, fixture);
    recipeArtifact = recipe.artifact;
    const reason = `Final release owned Browser robot ${assignment.surface.name.split("/").at(-1)} proof`;
    const runAtMs = Date.now();
    const scheduled = await apiJson(connection, "POST", "/browser/robots/schedule", {
      taskId: fixture.taskId,
      browserTabId: fixture.browserTabId,
      recipePath: recipeArtifact.path,
      runAtMs,
      kind: "recipeReplay",
      reason,
    });
    scheduledJobId = verifyRobotJob(scheduled, {
      status: "scheduled",
      receiptKind: "browserRobotScheduled",
      attempts: 0,
      taskId: fixture.taskId,
      browserTabId: fixture.browserTabId,
      recipePath: recipeArtifact.path,
      reason,
      runAtMs,
    });
    outcome.present = "pass";

    let target = scheduled;
    if (assignment.surface.name === "POST /browser/robots/run") {
      target = await apiJson(connection, "POST", "/browser/robots/run", {
        jobId: scheduledJobId,
        dryRun: true,
      });
      verifyRobotJob(target, {
        jobId: scheduledJobId,
        status: "dryRunCompleted",
        receiptKind: "browserRobotRunCompleted",
        attempts: 1,
        taskId: fixture.taskId,
        browserTabId: fixture.browserTabId,
        recipePath: recipeArtifact.path,
        reason,
        runAtMs,
        expectedSteps: recipe.steps.length,
      });
      jobTerminal = true;
    } else if (assignment.surface.name === "POST /browser/robots/cancel") {
      target = await apiJson(connection, "POST", "/browser/robots/cancel", {
        jobId: scheduledJobId,
        reason: "Final release owned Browser robot cancel cleanup",
      });
      verifyRobotJob(target, {
        jobId: scheduledJobId,
        status: "cancelled",
        receiptKind: "browserRobotCancelled",
        attempts: 0,
        taskId: fixture.taskId,
        browserTabId: fixture.browserTabId,
        recipePath: recipeArtifact.path,
        reason,
        runAtMs,
        receiptReason: "Final release owned Browser robot cancel cleanup",
      });
      jobTerminal = true;
    }
    outcome.invoke = "pass";

    const robots = requireObjectArray(
      (await apiJson(connection, "GET", "/browser/robots?limit=1000")).robots,
      "Browser robot readback",
    );
    const matches = robots.filter((job) => job.jobId === scheduledJobId);
    if (matches.length !== 1 || !isDeepStrictEqual(matches[0], target)) {
      throw new Error("Browser robot directory did not read back the exact owned lifecycle state");
    }
    const targetReceipt = requireObject(target.receipt, "Browser robot target receipt");
    const receipts = requireObjectArray(
      (await apiJson(connection, "GET", "/browser/receipts?limit=1000")).receipts,
      "Browser robot receipt readback",
    );
    const receiptMatches = receipts.filter((receipt) => receipt.receiptId === targetReceipt.receiptId
      && receipt.kind === targetReceipt.kind
      && requireObject(receipt.evidence, "Browser robot readback receipt evidence").jobId === scheduledJobId);
    if (receiptMatches.length !== 1) {
      throw new Error("Browser robot receipt did not read back by exact owned job identity");
    }
    outcome.effect = "pass";
    outcome.observedEffect = assignment.surface.name === "POST /browser/robots/run"
      ? "POST /browser/robots/run dry-ran one exact SHA-256-verified recipe, completed one owned scheduled job with zero applied actions, and read back the matching terminal job and receipt; identities end with candidate teardown."
      : `${assignment.surface.name} completed and read back one exact owned ${assignment.surface.name.endsWith("schedule") ? "scheduled" : "cancelled"} recipe job plus its matching receipt; terminal identities end with candidate teardown.`;
  } catch (error) {
    outcome.error = error instanceof Error ? error.message : String(error);
  } finally {
    const errors: string[] = [];
    if (scheduledJobId && !jobTerminal) {
      try {
        const cancelled = await apiJson(connection, "POST", "/browser/robots/cancel", {
          jobId: scheduledJobId,
          reason: "Final release owned Browser robot schedule cleanup",
        });
        const cancelledId = verifyRobotJob(cancelled, {
          jobId: scheduledJobId,
          status: "cancelled",
          receiptKind: "browserRobotCancelled",
          attempts: 0,
          taskId: fixture?.taskId ?? "",
          browserTabId: fixture?.browserTabId ?? "",
          recipePath: recipeArtifact?.path ?? "",
          reason: requiredString(cancelled.reason, "Browser robot cleanup reason"),
          runAtMs: Number(cancelled.runAtMs),
          receiptReason: "Final release owned Browser robot schedule cleanup",
        });
        const robots = requireObjectArray(
          (await apiJson(connection, "GET", "/browser/robots?limit=1000")).robots,
          "Browser robot cleanup readback",
        );
        if (robots.filter((job) => job.jobId === cancelledId && job.status === "cancelled").length !== 1) {
          throw new Error("scheduled Browser robot did not reach its exact terminal cleanup state");
        }
        jobTerminal = true;
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (recipeArtifact) {
      try {
        if (!existsSync(recipeArtifact.nodePath)) throw new Error("owned Browser robot recipe disappeared before cleanup");
        unlinkSync(recipeArtifact.nodePath);
        if (existsSync(recipeArtifact.nodePath)) throw new Error("owned Browser robot recipe remained after exact deletion");
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (fixture) {
      const error = await cleanupDebugApiBrowserSettleFixture(connection, fixture);
      if (error) errors.push(error);
    }
    if (errors.length === 0) {
      outcome.cleanup = "pass";
    } else {
      const detail = errors.join(" | ");
      outcome.error = outcome.error ? `${outcome.error}; cleanup: ${detail}` : `cleanup: ${detail}`;
    }
  }
  return outcome;
}

function verifyRobotJob(
  value: Record<string, unknown>,
  expected: {
    jobId?: string;
    status: "scheduled" | "dryRunCompleted" | "cancelled";
    receiptKind: string;
    attempts: number;
    taskId: string;
    browserTabId: string;
    recipePath: string;
    reason: string;
    runAtMs: number;
    expectedSteps?: number;
    receiptReason?: string;
  },
): string {
  verifyExactKeys(value, [
    "attempts", "browserTabId", "createdAtMs", "jobId", "kind", "lastError", "reason",
    "receipt", "recipePath", "runAtMs", "status", "taskId", "updatedAtMs",
  ], "Browser robot job");
  const jobId = requiredString(value.jobId, "Browser robot jobId");
  const receipt = requireObject(value.receipt, "Browser robot receipt");
  const evidence = requireObject(receipt.evidence, "Browser robot receipt evidence");
  if ((expected.jobId && jobId !== expected.jobId) || value.status !== expected.status
    || value.kind !== "recipeReplay" || value.taskId !== expected.taskId
    || value.browserTabId !== expected.browserTabId || value.recipePath !== expected.recipePath
    || value.reason !== expected.reason || value.runAtMs !== expected.runAtMs
    || value.attempts !== expected.attempts || value.lastError !== null
    || !Number.isSafeInteger(value.createdAtMs) || Number(value.createdAtMs) <= 0
    || !Number.isSafeInteger(value.updatedAtMs) || Number(value.updatedAtMs) <= 0
    || Number(value.updatedAtMs) < Number(value.createdAtMs)
    || receipt.kind !== expected.receiptKind || receipt.taskId !== expected.taskId
    || evidence.jobId !== jobId || evidence.kind !== "recipeReplay"
    || evidence.browserTabId !== expected.browserTabId || evidence.recipePath !== expected.recipePath) {
    throw new Error(`Browser robot job did not match its exact owned ${expected.status} state`);
  }
  if (expected.status === "scheduled") {
    if (evidence.runAtMs !== expected.runAtMs || evidence.reason !== expected.reason) {
      throw new Error("Browser robot schedule receipt omitted its exact time or reason");
    }
  } else if (expected.status === "dryRunCompleted") {
    if (evidence.status !== "dryRunCompleted" || evidence.dryRun !== true
      || evidence.attempts !== 1 || evidence.stepsPlanned !== expected.expectedSteps
      || evidence.stepsApplied !== 0 || evidence.stepsSkipped !== 0
      || evidence.replayStatus !== "dryRunCompleted" || evidence.lastError !== null) {
      throw new Error("Browser robot run receipt did not prove the exact zero-action dry-run outcome");
    }
  } else if (evidence.reason !== expected.receiptReason) {
    throw new Error("Browser robot cancel receipt omitted its exact reason");
  }
  return jobId;
}

async function apiJson(
  connection: DebugApiConnection,
  method: "GET" | "POST",
  path: string,
  body?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await fetch(`${connection.base}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${connection.token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path} failed ${response.status}`);
  return requireObject(text.trim() ? JSON.parse(text) : {}, `${method} ${path}`);
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} did not return an object`);
  return value as Record<string, unknown>;
}

function requireObjectArray(value: unknown, label: string): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) throw new Error(`${label} did not return an array`);
  return value.map((entry, index) => requireObject(entry, `${label}[${index}]`));
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function verifyExactKeys(value: Record<string, unknown>, expected: string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new Error(`${label} keys changed: ${actual.join(", ")}`);
  }
}
