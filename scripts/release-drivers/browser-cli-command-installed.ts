import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ShellxDebugApiConnection } from "../shellx-debug-paths";
import { cleanupOwnedBrowserLifecycle } from "../shellx-browser-test-cleanup";
import { runReleaseSurfaceDriverCli } from "../lib/release-surface-driver-cli";
import { resolveReleaseSurfaceRuntimeCandidate } from "../lib/release-surface-runtime-candidate";
import {
  releaseSurfaceControllerNodeArguments,
  resolveBoundReleaseSurfaceControllerFile,
} from "../lib/release-surface-controller-binding";
import {
  RELEASE_SURFACE_DRIVER_MANIFEST_SCHEMA,
  RELEASE_SURFACE_DRIVER_REPORT_SCHEMA,
  completionTimestamp,
  type ReleaseSurfaceDriverManifest,
  type ReleaseSurfaceDriverOutcome,
  type ReleaseSurfaceDriverReport,
  type ReleaseSurfaceDriverRequest,
} from "../lib/release-surface-driver-protocol";

const manifest: ReleaseSurfaceDriverManifest = {
  schema: RELEASE_SURFACE_DRIVER_MANIFEST_SCHEMA,
  id: "browser-cli-command-installed",
  kind: "browser-cli-command",
  runtimeBinding: "attested-process",
  invocationTransport: "process-cli",
  supportedFixtures: [
    "browser-cli:help-json",
    "browser-cli:installed-read-model",
    "browser-cli:flight-recorder-disposable-task",
    "browser-cli:disposable-local-page-task",
    "browser-cli:hidden-rendered-loopback",
  ],
  supportedCleanups: [
    "browser-cli:read-only",
    "browser-cli:close-owned-task-and-delete-run-profile",
    "browser-cli:destroy-hidden-renderer-and-delete-run-profile",
  ],
  supportedOracles: [
    "browser-cli:help:schema",
    "browser-cli:h:schema",
    "browser-cli:snapshot:schema",
    "browser-cli:tabs:schema",
    "browser-cli:locks:schema",
    "browser-cli:check:schema",
    "browser-cli:dialogs:schema",
    "browser-cli:flight-recorder-export:flight-recorder-effect",
    "browser-cli:workflow-evaluate:flight-recorder-effect",
    "browser-cli:click-ref:local-page-effect",
    "browser-cli:click-at:local-page-effect",
    "browser-cli:clear-site-data:local-page-effect",
    "browser-cli:extract:local-page-effect",
    "browser-cli:fill-ref:local-page-effect",
    "browser-cli:navigate:local-page-effect",
    "browser-cli:observe:local-page-effect",
    "browser-cli:run-steps:local-page-effect",
    "browser-cli:verify:local-page-effect",
    "browser-cli:wait-for:local-page-effect",
    "browser-cli:type-text:local-page-effect",
    "browser-cli:workflow-bookmarks:schema",
    "browser-cli:rendered-check:hidden-renderer-effect",
    "browser-cli:resolve-dialog:local-page-effect",
    "browser-cli:screenshot:artifact-effect",
    "browser-cli:trace-open:artifact-effect",
    "browser-cli:workflow-save:workflow-effect",
    "browser-cli:workflow-replay:workflow-effect",
  ],
  controllerFiles: ["scripts/shellx-browser-cli.ts"],
};
const HELP_COMMANDS = new Set(["help", "--help", "-h"]);
const READ_COMMANDS = new Set(["snapshot", "tabs", "locks", "check", "dialogs", "workflow-bookmarks"]);
const RENDERED_CHECK_COMMANDS = new Set(["rendered-check"]);
const FLIGHT_RECORDER_COMMANDS = new Set(["flight-recorder-export", "workflow-evaluate"]);
const ARTIFACT_COMMANDS = new Set(["screenshot", "trace-open"]);
const RECIPE_WORKFLOW_COMMANDS = new Set(["workflow-save", "workflow-replay"]);
const DIALOG_COMMANDS = new Set(["resolve-dialog"]);
const SITE_DATA_COMMANDS = new Set(["clear-site-data"]);
const LOCAL_PAGE_COMMANDS = new Set([
  "click-at", "click-ref", "extract", "fill-ref", "navigate", "observe", "run-steps", "type-text", "verify", "wait-for",
]);
const PIPELINE_COMMANDS = new Set([
  ...FLIGHT_RECORDER_COMMANDS, ...ARTIFACT_COMMANDS, ...RECIPE_WORKFLOW_COMMANDS,
  ...DIALOG_COMMANDS, ...SITE_DATA_COMMANDS, ...LOCAL_PAGE_COMMANDS,
]);
const DRIVER_TIMEOUT_MS = 30_000;

async function execute(request: ReleaseSurfaceDriverRequest): Promise<ReleaseSurfaceDriverReport> {
  const startedAt = new Date().toISOString();
  const needsInstalledApp = request.assignments.some((assignment) => (
    READ_COMMANDS.has(assignment.surface.name)
      || RENDERED_CHECK_COMMANDS.has(assignment.surface.name)
      || PIPELINE_COMMANDS.has(assignment.surface.name)
  ));
  const connection = needsInstalledApp ? await resolveInstalledCandidate(request) : null;
  const renderedCheckAssignments = request.assignments.filter((assignment) => RENDERED_CHECK_COMMANDS.has(assignment.surface.name));
  const renderedCheckOutcomes = renderedCheckAssignments.length
    ? await exerciseRenderedCheck(renderedCheckAssignments, connection, request)
    : [];
  const pipelineAssignments = request.assignments.filter((assignment) => PIPELINE_COMMANDS.has(assignment.surface.name));
  const pipelineOutcomes = pipelineAssignments.length
    ? await exerciseFlightRecorderPipeline(pipelineAssignments, connection, request)
    : [];
  const pipelineById = new Map(
    [...renderedCheckOutcomes, ...pipelineOutcomes].map((outcome) => [outcome.id, outcome]),
  );
  const outcomes: ReleaseSurfaceDriverOutcome[] = [];
  for (const assignment of request.assignments) {
    outcomes.push(
      pipelineById.get(assignment.surface.id)
        ?? await exerciseCommand(assignment, connection, request),
    );
  }
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

async function exerciseRenderedCheck(
  assignments: ReleaseSurfaceDriverRequest["assignments"],
  connection: ShellxDebugApiConnection | null,
  request: ReleaseSurfaceDriverRequest,
): Promise<ReleaseSurfaceDriverOutcome[]> {
  const outcomes = assignments.map((assignment): ReleaseSurfaceDriverOutcome => ({
    id: assignment.surface.id,
    expectedEffect: assignment.expectedEffect,
    oracleId: assignment.oracleId,
    present: "pass",
    invoke: "fail",
    effect: "fail",
    cleanup: "fail",
    observedEffect: "No installed hidden-renderer effect was observed.",
  }));
  let fixture: { url: string; close: () => Promise<void> } | null = null;
  try {
    if (!connection) throw new Error("rendered-check requires an installed candidate");
    fixture = await startFlightRecorderFixture();
    const queryMarker = `release-rendered-${randomUUID()}`;
    const url = new URL(fixture.url);
    url.searchParams.set("private", queryMarker);
    const result = await runCli([
      "rendered-check", url.toString(),
      "--expect-text", "Flight Recorder baseline ready",
      "--title-includes", "ShellX release Flight Recorder",
      "--selector", "#advance",
      "--expected-domains", "127.0.0.1",
    ], connection, request);
    if (JSON.stringify(result).includes(queryMarker)) {
      throw new Error("rendered-check returned private URL query data");
    }
    verifyRenderedCheck(result);
    for (const outcome of outcomes) {
      outcome.invoke = "pass";
      outcome.effect = "pass";
      outcome.observedEffect = "rendered-check matched text, title, and selector in one isolated hidden renderer, destroyed it, and left visible Browser state unchanged; URL and page data were not retained.";
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    for (const outcome of outcomes) outcome.error = detail;
  } finally {
    let cleanupError: string | null = null;
    if (fixture) {
      try {
        await fixture.close();
      } catch (error) {
        cleanupError = error instanceof Error ? error.message : String(error);
      }
    }
    for (const outcome of outcomes) {
      if (!cleanupError) {
        outcome.cleanup = "pass";
      } else {
        outcome.error = outcome.error ? `${outcome.error}; cleanup: ${cleanupError}` : `cleanup: ${cleanupError}`;
      }
    }
  }
  return outcomes;
}

function verifyRenderedCheck(result: Record<string, unknown>): void {
  if (result.schema !== "shellx/browser-rendered-check@1" || result.ok !== true || result.status !== "passed") {
    throw new Error("rendered-check omitted its passing typed result");
  }
  const evidence = requireObject(result.evidence, "rendered-check.evidence");
  if (evidence.textMatched !== true || evidence.titleMatched !== true
    || evidence.selectorMatched !== true || evidence.selectorCount !== 1) {
    throw new Error("rendered-check did not match the exact loopback expectations");
  }
  const effects = requireObject(result.effects, "rendered-check.effects");
  if (effects.visibleWindowOpened !== false || effects.browserTaskCreated !== false
    || effects.browserTabCreated !== false || effects.receiptEmitted !== false
    || effects.hiddenRendererCreated !== true || effects.hiddenRendererDestroyed !== true
    || effects.profilePersisted !== false) {
    throw new Error("rendered-check did not prove isolated hidden-renderer cleanup");
  }
}

async function exerciseFlightRecorderPipeline(
  assignments: ReleaseSurfaceDriverRequest["assignments"],
  connection: ShellxDebugApiConnection | null,
  request: ReleaseSurfaceDriverRequest,
): Promise<ReleaseSurfaceDriverOutcome[]> {
  const outcomes = assignments.map((assignment): ReleaseSurfaceDriverOutcome => ({
    id: assignment.surface.id,
    expectedEffect: assignment.expectedEffect,
    oracleId: assignment.oracleId,
    present: "pass",
    invoke: "fail",
    effect: "fail",
    cleanup: "fail",
    observedEffect: "No installed Browser CLI pipeline effect was observed.",
  }));
  const outcomeFor = (command: string) => outcomes.find((outcome) => outcome.id === `browser-cli-command:${command}`);
  let fixture: { url: string; close: () => Promise<void> } | null = null;
  let taskId: string | null = null;
  const taskIds: string[] = [];
  let tempRoot: string | null = null;
  const bookmarkIds: string[] = [];
  const previousCallerId = process.env.SHELLX_HOST_MCP_TAB_ID;
  process.env.SHELLX_HOST_MCP_TAB_ID = `release-browser-cli-${randomUUID()}`;
  try {
    if (!connection) throw new Error("Flight Recorder CLI workflow requires an installed candidate");
    fixture = await startFlightRecorderFixture();
    const task = await apiJson(connection, "POST", "/browser/task/start", {
      goal: "Final surface Browser CLI Flight Recorder proof",
      startUrl: fixture.url,
      profileId: "task-disposable",
      autonomy: "assistedAutonomous",
      expectedDomains: ["127.0.0.1"],
    });
    taskId = requiredString(task.taskId, "Browser task start.taskId");
    taskIds.push(taskId);
    const settled = await apiJson(connection, "GET", `/browser/settle?taskId=${encodeURIComponent(taskId)}&timeoutMs=${DRIVER_TIMEOUT_MS}`);
    if (settled.settled !== true) throw new Error("disposable Flight Recorder task did not settle");
    for (const command of [
      "navigate", "observe", "fill-ref", "click-ref", "click-at", "type-text",
      "wait-for", "extract", "verify", "run-steps", "screenshot", "trace-open",
    ]) {
      const outcome = outcomeFor(command);
      if (!outcome) continue;
      const result = await runCli(localPageCommandArgs(command, taskId, fixture.url), connection, request);
      outcome.invoke = "pass";
      outcome.observedEffect = await verifyLocalPageCommand(command, result, taskId, fixture.url, connection, request);
      outcome.effect = "pass";
    }
    const saveOutcome = outcomeFor("workflow-save");
    const replayOutcome = outcomeFor("workflow-replay");
    if (saveOutcome || replayOutcome) {
      const label = `Release workflow ${randomUUID()}`;
      const saved = await runCli([
        "workflow-save", "--task", taskId, "--label", label,
        "--task-type", "release-proof", "--target", "browser-cli",
        "--url", fixture.url, "--site", "127.0.0.1",
      ], connection, request);
      const savedIdentity = verifyWorkflowSave(saved, taskId);
      bookmarkIds.push(savedIdentity.bookmarkId);
      if (saveOutcome) {
        saveOutcome.invoke = "pass";
        saveOutcome.effect = "pass";
        saveOutcome.observedEffect = "workflow-save exported one non-empty redacted recipe and created one exact owned workflow bookmark; labels, IDs, paths, URLs, and recipe content were not retained.";
      }
      if (replayOutcome) {
        const replay = await runCli([
          "workflow-replay", "--recipe-path", savedIdentity.recipePath, "--task", taskId,
        ], connection, request);
        verifyWorkflowReplay(replay, taskId);
        replayOutcome.invoke = "pass";
        replayOutcome.effect = "pass";
        replayOutcome.observedEffect = "workflow-replay completed a bounded dry-run plan for the exact owned recipe and task; recipe path and step content were not retained.";
      }
    }
    const siteDataOutcome = outcomeFor("clear-site-data");
    if (siteDataOutcome) {
      const seeded = await apiJson(connection, "POST", "/browser/action", {
        action: "clickRef", taskId, selector: "#seed-site-data", timeoutMs: DRIVER_TIMEOUT_MS,
      });
      if (seeded.ok !== true) throw new Error("owned site-data fixture could not be seeded");
      await runCli(["navigate", `${fixture.url}?site-data-check=1`, "--task", taskId], connection, request);
      const before = await runCli(["wait-for", "text", "Site data still seeded", "--task", taskId], connection, request);
      if (before.ok !== true) throw new Error("owned site-data fixture did not retain the pre-clear sentinel");
      const cleared = await runCli(["clear-site-data", "--task", taskId], connection, request);
      if (cleared.ok !== true || cleared.taskId !== taskId || cleared.status !== "applied"
        || !String(cleared.message ?? "").includes("site application data recovery applied")) {
        throw new Error("clear-site-data omitted its exact owned-task recovery result");
      }
      await apiJson(connection, "GET", `/browser/settle?taskId=${encodeURIComponent(taskId)}&timeoutMs=${DRIVER_TIMEOUT_MS}`);
      const after = await runCli(["wait-for", "text", "Site data cleared", "--task", taskId], connection, request);
      if (after.ok !== true) throw new Error("clear-site-data did not remove the owned origin-storage sentinel");
      siteDataOutcome.invoke = "pass";
      siteDataOutcome.effect = "pass";
      siteDataOutcome.observedEffect = "clear-site-data removed one exact owned origin-storage sentinel, preserved task ownership, and reloaded the loopback page; storage keys, URL, and page content were not retained.";
    }
    const dialogOutcome = outcomeFor("resolve-dialog");
    if (dialogOutcome) {
      const armed = await apiJson(connection, "POST", "/browser/action", {
        action: "clickRef", taskId, selector: "#arm-dialog", timeoutMs: DRIVER_TIMEOUT_MS,
      });
      if (armed.ok !== true) throw new Error("owned beforeunload fixture could not be armed");
      await runCli(["navigate", `${fixture.url}?dialog-target=1`, "--task", taskId], connection, request);
      const dialogs = await runCli(["dialogs", "--limit", "20"], connection, request);
      const pending = (Array.isArray(dialogs.dialogs) ? dialogs.dialogs : [])
        .map((value) => requireObject(value, "resolve-dialog pending dialog"))
        .find((value) => value.taskId === taskId && value.dialogType === "beforeunload" && value.status === "pending");
      if (!pending) throw new Error("owned beforeunload fixture did not publish a pending dialog");
      const dialogId = requiredString(pending.dialogId, "resolve-dialog dialogId");
      const resolved = await runCli([
        "resolve-dialog", dialogId, "--task", taskId, "--action", "dismiss",
      ], connection, request);
      verifyResolvedDialog(resolved, taskId, dialogId);
      dialogOutcome.invoke = "pass";
      dialogOutcome.effect = "pass";
      dialogOutcome.observedEffect = "resolve-dialog discovered and dismissed one exact task-owned beforeunload dialog with its resolution receipt; dialog ID, text, URL, and receipt content were not retained.";
    }
    await apiJson(connection, "POST", "/browser/action", {
      action: "waitFor", taskId, key: "text", value: "Flight Recorder baseline ready", timeoutMs: DRIVER_TIMEOUT_MS,
    });
    await apiJson(connection, "POST", "/browser/action", { action: "observe", taskId, maxPayloadBytes: 3_000 });

    const suiteId = `release-flight-${randomUUID()}`;
    const exportOutcome = outcomeFor("flight-recorder-export");
    const baselineRaw = exportOutcome
      ? await runCli(["flight-recorder-export", "--task", taskId, "--suite", suiteId, "--group", "baseline", "--attempt-index", "0"], connection, request)
      : await apiJson(connection, "POST", "/browser/flight-recorder/export", {
        taskId, suiteId, group: "baseline", attemptIndex: 0, reason: "Final surface baseline setup",
      });
    if (exportOutcome) exportOutcome.invoke = "pass";
    const baseline = artifactIdentity(baselineRaw, "baseline Flight Recorder export");
    if (exportOutcome) {
      exportOutcome.effect = "pass";
      exportOutcome.observedEffect = "Browser CLI exported one bounded baseline attempt with a valid SHA-256 identity; task, path, and receipt content were not retained.";
    }

    const evaluateOutcome = outcomeFor("workflow-evaluate");
    if (evaluateOutcome) {
      const candidateTask = await apiJson(connection, "POST", "/browser/task/start", {
        goal: "Final surface Browser CLI Flight Recorder candidate proof",
        startUrl: fixture.url,
        profileId: "task-disposable",
        autonomy: "assistedAutonomous",
        expectedDomains: ["127.0.0.1"],
      });
      const candidateTaskId = requiredString(candidateTask.taskId, "Browser candidate task start.taskId");
      if (candidateTaskId === taskId) {
        throw new Error("workflow evaluation fixture reused its baseline Browser task");
      }
      taskIds.push(candidateTaskId);
      const candidateSettled = await apiJson(
        connection,
        "GET",
        `/browser/settle?taskId=${encodeURIComponent(candidateTaskId)}&timeoutMs=${DRIVER_TIMEOUT_MS}`,
      );
      if (candidateSettled.settled !== true) throw new Error("disposable candidate Flight Recorder task did not settle");
      await apiJson(connection, "POST", "/browser/action", {
        action: "clickRef", taskId: candidateTaskId, selector: "#advance", timeoutMs: DRIVER_TIMEOUT_MS,
      });
      await apiJson(connection, "POST", "/browser/action", {
        action: "waitFor", taskId: candidateTaskId, key: "text", value: "Flight Recorder candidate ready", timeoutMs: DRIVER_TIMEOUT_MS,
      });
      await apiJson(connection, "POST", "/browser/action", {
        action: "verify", taskId: candidateTaskId, key: "text", value: "Flight Recorder candidate ready",
      });
      const candidate = artifactIdentity(await apiJson(connection, "POST", "/browser/flight-recorder/export", {
        taskId: candidateTaskId, suiteId, group: "candidate", attemptIndex: 1, reason: "Final surface candidate setup",
      }), "candidate Flight Recorder export");
      tempRoot = mkdtempSync(join(tmpdir(), "shellx-release-flight-recorder-"));
      const attemptsPath = join(tempRoot, "attempts.json");
      writeFileSync(attemptsPath, `${JSON.stringify([
        evaluationAttempt(baseline, "baseline", 2),
        evaluationAttempt(candidate, "candidate", 3),
      ])}\n`, { encoding: "utf8", mode: 0o600 });
      const report = await runCli([
        "workflow-evaluate", "--suite", suiteId, "--evaluated-at-ms", String(Date.now()),
        "--task", taskId, "--attempts-file", attemptsPath,
      ], connection, request);
      evaluateOutcome.invoke = "pass";
      verifyEvaluation(report);
      evaluateOutcome.effect = "pass";
      evaluateOutcome.observedEffect = "Browser CLI bound two exact attempt identities into one evidence-complete evaluation with a valid SHA-256 report; identities and report content were not retained.";
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    for (const outcome of outcomes) {
      if (outcome.effect !== "pass") outcome.error = detail;
    }
  } finally {
    const cleanupErrors: string[] = [];
    if (connection) {
      for (const bookmarkId of bookmarkIds) {
        try {
          const deleted = await apiJson(connection, "DELETE", `/browser/bookmarks/${encodeURIComponent(bookmarkId)}`);
          if (deleted.ok !== true) cleanupErrors.push(`workflow bookmark ${bookmarkId} was not deleted`);
        } catch (error) {
          cleanupErrors.push(error instanceof Error ? error.message : String(error));
        }
      }
    }
    if (connection && taskIds.length > 0) {
      try {
        const cleanup = await cleanupOwnedBrowserLifecycle(
          (method, path, body) => apiJson(connection, method, path, body),
          { taskIds, label: "final-surface-browser-cli-flight-recorder" },
        );
        if (cleanup.errors.length) cleanupErrors.push(...cleanup.errors);
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (fixture) {
      try {
        await fixture.close();
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (tempRoot) {
      try {
        rmSync(tempRoot, { recursive: true, force: true });
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (previousCallerId === undefined) delete process.env.SHELLX_HOST_MCP_TAB_ID;
    else process.env.SHELLX_HOST_MCP_TAB_ID = previousCallerId;
    for (const outcome of outcomes) {
      if (cleanupErrors.length === 0) {
        outcome.cleanup = "pass";
      } else {
        const cleanupDetail = cleanupErrors.join(" | ");
        outcome.error = outcome.error ? `${outcome.error}; cleanup: ${cleanupDetail}` : `cleanup: ${cleanupDetail}`;
      }
    }
  }
  return outcomes;
}

function runCli(
  args: string[],
  connection: ShellxDebugApiConnection,
  request: ReleaseSurfaceDriverRequest,
): Promise<Record<string, unknown>> {
  const browserCliPath = resolveBoundReleaseSurfaceControllerFile({
    rootDir: process.cwd(),
    binding: request.controller,
    relativePath: "scripts/shellx-browser-cli.ts",
  });
  return new Promise((resolveRun, rejectRun) => {
    execFile(process.execPath, releaseSurfaceControllerNodeArguments(browserCliPath, args), {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: DRIVER_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
      env: {
        ...process.env,
        SHELLX_DEBUG_BASE: connection.base,
        SHELLX_DEBUG_TOKEN: connection.token,
      },
    }, (error, stdout, stderr) => {
      if (error) {
        rejectRun(new Error((stderr || stdout).trim() || error.message));
        return;
      }
      try {
        const line = stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean).at(-1);
        const parsed: unknown = line ? JSON.parse(line) : null;
        resolveRun(requireObject(parsed, `Browser CLI ${args[0]} output`));
      } catch (parseError) {
        rejectRun(parseError);
      }
    });
  });
}

function artifactIdentity(artifact: Record<string, unknown>, label: string): Record<string, unknown> {
  const sha256 = requiredString(artifact.sha256, `${label}.sha256`);
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error(`${label} returned an invalid SHA-256 identity`);
  return {
    attemptId: requiredString(artifact.attemptId, `${label}.attemptId`),
    taskId: requiredString(artifact.taskId, `${label}.taskId`),
    path: requiredString(artifact.path, `${label}.path`),
    bytes: nonNegativeNumber(artifact.bytes, `${label}.bytes`),
    sha256,
    events: nonNegativeNumber(artifact.events, `${label}.events`),
    receipts: nonNegativeNumber(artifact.receipts, `${label}.receipts`),
  };
}

function evaluationAttempt(identity: Record<string, unknown>, group: "baseline" | "candidate", steps: number): Record<string, unknown> {
  return {
    attemptId: identity.attemptId,
    group,
    taskId: identity.taskId,
    status: "passed",
    durationMs: 1,
    steps,
    safetyViolations: 0,
    artifactPath: identity.path,
    artifactBytes: identity.bytes,
    artifactSha256: identity.sha256,
  };
}

function verifyEvaluation(report: Record<string, unknown>): void {
  if (report.evidenceComplete !== true || report.attempts !== 2) {
    throw new Error("workflow evaluation did not bind two evidence-complete attempts");
  }
  requiredString(report.reportId, "workflow evaluation.reportId");
  requiredString(report.path, "workflow evaluation.path");
  nonNegativeNumber(report.bytes, "workflow evaluation.bytes");
  const sha256 = requiredString(report.sha256, "workflow evaluation.sha256");
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error("workflow evaluation returned an invalid SHA-256 identity");
  requiredString(report.evidenceDigest, "workflow evaluation.evidenceDigest");
}

async function apiJson(
  connection: ShellxDebugApiConnection,
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const callerId = browserCliCallerId();
  const response = await fetch(`${connection.base}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${connection.token}`,
      Connection: "close",
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(callerId ? { "x-shellx-mcp-caller-id": callerId } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(DRIVER_TIMEOUT_MS),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path} failed ${response.status}: ${text.slice(0, 1_200)}`);
  return requireObject(text.trim() ? JSON.parse(text) : {}, `${method} ${path}`);
}

function browserCliCallerId(): string | null {
  const value = process.env.SHELLX_HOST_MCP_TAB_ID?.trim() ?? "";
  return value && value.length <= 200 ? value : null;
}

function verifyWorkflowSave(
  result: Record<string, unknown>,
  taskId: string,
): { bookmarkId: string; recipePath: string } {
  if (result.ok !== true) throw new Error("workflow-save omitted its success envelope");
  const recipe = requireObject(result.recipe, "workflow-save.recipe");
  if (recipe.taskId !== taskId || !Number.isSafeInteger(recipe.steps) || Number(recipe.steps) <= 0) {
    throw new Error("workflow-save did not export a non-empty recipe for the exact owned task");
  }
  verifyBoundedArtifact(recipe, "workflow-save recipe");
  const recipeReceipt = requireObject(recipe.receipt, "workflow-save recipe.receipt");
  if (recipeReceipt.kind !== "browserRecipeExported") throw new Error("workflow-save omitted its recipe receipt");
  const bookmarkResponse = requireObject(result.bookmark, "workflow-save.bookmark response");
  if (bookmarkResponse.ok !== true) throw new Error("workflow-save did not create its owned bookmark");
  const bookmark = requireObject(bookmarkResponse.bookmark, "workflow-save.bookmark");
  return {
    bookmarkId: requiredString(bookmark.bookmarkId, "workflow-save bookmark.bookmarkId"),
    recipePath: requiredString(recipe.path, "workflow-save recipe.path"),
  };
}

function verifyWorkflowReplay(result: Record<string, unknown>, taskId: string): void {
  if (result.ok !== true) throw new Error("workflow-replay omitted its success envelope");
  const summary = requireObject(result.summary, "workflow-replay.summary");
  if (summary.taskId !== taskId || summary.dryRun !== true
    || !Number.isSafeInteger(summary.stepsPlanned) || Number(summary.stepsPlanned) <= 0) {
    throw new Error("workflow-replay did not produce a bounded dry-run plan for the exact task");
  }
  const replay = requireObject(result.replay, "workflow-replay.replay");
  const receipt = requireObject(replay.receipt, "workflow-replay receipt");
  if (receipt.kind !== "browserRecipeReplayCompleted") throw new Error("workflow-replay omitted its completion receipt");
}

function verifyResolvedDialog(result: Record<string, unknown>, taskId: string, dialogId: string): void {
  if (result.dialogId !== dialogId || result.taskId !== taskId || result.dialogType !== "beforeunload"
    || result.status !== "dismissed" || result.resolvedAtMs === null || result.resolvedAtMs === undefined) {
    throw new Error("resolve-dialog did not dismiss the exact owned beforeunload dialog");
  }
  const receipt = requireObject(result.receipt, "resolve-dialog.receipt");
  if (receipt.kind !== "browserDialogResolved") throw new Error("resolve-dialog omitted its resolution receipt");
}

async function startFlightRecorderFixture(): Promise<{ url: string; close: () => Promise<void> }> {
  const sockets = new Set<Socket>();
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (request.method !== "GET" || pathname !== "/flight-recorder") {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    response.end("<!doctype html><title>ShellX release Flight Recorder</title><style>body{margin:0}main{padding:220px 24px 24px}#coordinate-button{position:fixed;left:40px;top:40px;width:180px;height:44px}#coordinate-input{position:fixed;left:40px;top:120px;width:220px;height:40px}</style><main><h1>Flight Recorder baseline ready</h1><label>Name <input id='name' /></label><button id='advance' onclick=\"document.querySelector('#status').textContent='Action target ready — Flight Recorder candidate ready'\">Advance candidate</button><button id='arm-dialog' onclick=\"window.addEventListener('beforeunload',event=>{event.preventDefault();event.returnValue='';});this.textContent='Dialog armed'\">Arm dialog</button><button id='seed-site-data' onclick=\"localStorage.setItem('shellx-release-site-data','owned');sessionStorage.setItem('shellx-release-site-session','owned');document.querySelector('#site-data-status').textContent='Site data seeded'\">Seed site data</button><p id='site-data-status'>Site data empty</p><p id='status'>Baseline state</p><button id='coordinate-button' onclick=\"document.querySelector('#coordinate-status').textContent='Coordinate click ready'\">Coordinate button</button><input id='coordinate-input' aria-label='Coordinate input' /><p id='coordinate-status'>Coordinate idle</p></main><script>if(new URL(location.href).searchParams.has('site-data-check'))document.querySelector('#site-data-status').textContent=localStorage.getItem('shellx-release-site-data')?'Site data still seeded':'Site data cleared';</script>");
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Flight Recorder fixture did not bind");
  return {
    url: `http://127.0.0.1:${address.port}/flight-recorder`,
    close: () => closeServer(server, sockets),
  };
}

function localPageCommandArgs(command: string, taskId: string, url: string): string[] {
  const task = ["--task", taskId];
  switch (command) {
    case "navigate": return [command, url, ...task];
    case "observe": return [command, ...task];
    case "click-at": return [command, "100", "62", ...task];
    case "fill-ref": return [command, "#name", "Release input", ...task];
    case "click-ref": return [command, "#advance", ...task];
    case "wait-for": return [command, "text", "Action target ready", ...task];
    case "type-text": return [command, "100", "140", "Coordinate input value", ...task];
    case "extract": return [command, "text", "--selector", "main", ...task];
    case "verify": return [command, "text", "Action target ready", ...task];
    case "run-steps": return [
      command,
      ...task,
      "--steps-json",
      JSON.stringify([
        { action: "waitFor", key: "text", value: "Action target ready" },
        { action: "verify", key: "text", value: "Action target ready" },
      ]),
    ];
    case "screenshot": return [command, "--full-page", ...task];
    case "trace-open": return [command, ...task, "--reason", "Final surface owned trace proof"];
    default: throw new Error(`missing local-page Browser CLI args for ${command}`);
  }
}

async function verifyLocalPageCommand(
  command: string,
  result: Record<string, unknown>,
  taskId: string,
  url: string,
  connection: ShellxDebugApiConnection,
  request: ReleaseSurfaceDriverRequest,
): Promise<string> {
  if (command === "run-steps") {
    if (result.ok !== true || result.taskId !== taskId || result.stepsPlanned !== 2
      || result.stepsRun !== 2 || result.stepsSucceeded !== 2 || result.stepsFailed !== 0) {
      throw new Error("run-steps did not complete both exact owned-page steps");
    }
    return "run-steps completed two bounded actions on the owned page; task and page data were not retained.";
  }
  if (command === "trace-open") {
    if (result.taskId !== taskId || !requiredString(result.traceId, "trace-open.traceId").startsWith("browser-trace-")) {
      throw new Error("trace-open did not bind its artifact to the exact owned Browser task");
    }
    verifyBoundedArtifact(result, "trace-open");
    const receipt = requireObject(result.receipt, "trace-open.receipt");
    if (receipt.kind !== "browserTraceBundleExported") throw new Error("trace-open omitted its exact receipt kind");
    return "trace-open exported one bounded redacted trace with a valid SHA-256 identity; task, path, and trace content were not retained.";
  }
  if (result.ok !== true || result.taskId !== taskId) {
    throw new Error(`${command} did not return the exact owned Browser task success envelope`);
  }
  if (command === "navigate" && result.currentUrl !== url) {
    throw new Error("navigate did not reach the exact loopback fixture URL");
  }
  if (command === "observe" && (!result.observation || typeof result.observation !== "object")) {
    throw new Error("observe omitted its typed page observation");
  }
  if (command === "extract" && (typeof result.extractedText !== "string" || !result.extractedText.includes("Action target ready"))) {
    throw new Error("extract omitted the exact post-action page text");
  }
  if (command === "verify") {
    const verification = result.verification && typeof result.verification === "object"
      ? result.verification as Record<string, unknown>
      : null;
    if (!verification || verification.passed !== true) throw new Error("verify omitted its passing typed verification");
  }
  if (command === "screenshot") {
    const screenshot = requireObject(result.screenshot, "screenshot artifact");
    verifyBoundedArtifact(screenshot, "screenshot");
    if (!Number.isSafeInteger(screenshot.width) || Number(screenshot.width) <= 0
      || !Number.isSafeInteger(screenshot.height) || Number(screenshot.height) <= 0) {
      throw new Error("screenshot omitted positive image dimensions");
    }
    const receipt = requireObject(result.receipt, "screenshot.receipt");
    if (receipt.kind !== "browserScreenshotCaptured") throw new Error("screenshot omitted its exact receipt kind");
    return "screenshot captured one bounded owned-page image with positive dimensions and a valid SHA-256 identity; task, path, URL, and image content were not retained.";
  }
  if (command === "click-at") {
    const proof = await runCli(["wait-for", "text", "Coordinate click ready", "--task", taskId], connection, request);
    if (proof.ok !== true || proof.taskId !== taskId) {
      throw new Error("click-at did not trigger the exact owned coordinate button");
    }
  }
  if (command === "type-text") {
    const proof = await runCli(["observe", "--task", taskId], connection, request);
    const observation = requireObject(proof.observation, "type-text follow-up observation");
    const fields = Array.isArray(observation.formFields) ? observation.formFields : [];
    const field = fields.map((value) => requireObject(value, "type-text form field"))
      .find((value) => value.selector === "#coordinate-input");
    if (!field || field.value !== "Coordinate input value") {
      throw new Error("type-text did not insert text into the exact owned coordinate input");
    }
  }
  return `${command} returned its exact successful owned-page effect; task, URL, observation, and page content were not retained.`;
}

function verifyBoundedArtifact(value: Record<string, unknown>, label: string): void {
  requiredString(value.path, `${label}.path`);
  if (!Number.isSafeInteger(value.bytes) || Number(value.bytes) <= 0) {
    throw new Error(`${label} omitted a positive byte count`);
  }
  const sha256 = requiredString(value.sha256, `${label}.sha256`);
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error(`${label} returned an invalid SHA-256 identity`);
}

async function closeServer(server: Server, sockets: Set<Socket>): Promise<void> {
  for (const socket of sockets) socket.destroy();
  await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function nonNegativeNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(`${label} must be a non-negative number`);
  return value;
}

async function resolveInstalledCandidate(request: ReleaseSurfaceDriverRequest): Promise<ShellxDebugApiConnection> {
  return await resolveReleaseSurfaceRuntimeCandidate(request);
}

async function exerciseCommand(
  assignment: ReleaseSurfaceDriverRequest["assignments"][number],
  connection: ShellxDebugApiConnection | null,
  request: ReleaseSurfaceDriverRequest,
): Promise<ReleaseSurfaceDriverOutcome> {
  const outcome: ReleaseSurfaceDriverOutcome = {
    id: assignment.surface.id,
    expectedEffect: assignment.expectedEffect,
    oracleId: assignment.oracleId,
    present: "fail",
    invoke: "fail",
    effect: "fail",
    cleanup: "pass",
    observedEffect: "No CLI usage result was observed.",
  };
  try {
    const command = assignment.surface.name;
    if (!HELP_COMMANDS.has(command) && !READ_COMMANDS.has(command)) {
      throw new Error(`browser CLI read fixture does not support ${command}`);
    }
    if (READ_COMMANDS.has(command) && !connection) throw new Error(`browser CLI ${command} requires an installed candidate`);
    outcome.present = "pass";
    const browserCliPath = resolveBoundReleaseSurfaceControllerFile({
      rootDir: process.cwd(),
      binding: request.controller,
      relativePath: "scripts/shellx-browser-cli.ts",
    });
    const result = await new Promise<{ stdout: string }>((resolveRun, rejectRun) => {
      execFile(process.execPath, releaseSurfaceControllerNodeArguments(browserCliPath, [command]), {
        cwd: process.cwd(),
        encoding: "utf8",
        timeout: 10_000,
        maxBuffer: 16 * 1024 * 1024,
        env: connection ? {
          ...process.env,
          SHELLX_DEBUG_BASE: connection.base,
          SHELLX_DEBUG_TOKEN: connection.token,
        } : process.env,
      }, (error, stdout, stderr) => {
        if (error) rejectRun(new Error((stderr || stdout).trim() || error.message));
        else resolveRun({ stdout });
      });
    });
    outcome.invoke = "pass";
    const body = JSON.parse(result.stdout) as Record<string, unknown>;
    const effect = verifyCommandBody(command, body);
    outcome.effect = "pass";
    outcome.observedEffect = effect;
  } catch (error) {
    outcome.error = error instanceof Error ? error.message : String(error);
  }
  return outcome;
}

function verifyCommandBody(command: string, body: Record<string, unknown>): string {
  if (HELP_COMMANDS.has(command)) {
    if (!Array.isArray(body.usage) || body.usage.length < 20 || !body.usage.every((row) => typeof row === "string")) {
      throw new Error("CLI help did not return the complete structured usage array");
    }
    return `${command} returned ${body.usage.length} structured Browser CLI usage rows.`;
  }
  if (command === "snapshot") {
    const counts: Record<string, number> = {};
    for (const key of ["profiles", "tabs", "tasks"]) {
      if (!Array.isArray(body[key])) throw new Error(`snapshot omitted the ${key} array`);
      counts[key] = body[key].length;
    }
    if (typeof body.windowOpen !== "boolean" || !body.engine || typeof body.engine !== "object") {
      throw new Error("snapshot omitted Browser window or engine state");
    }
    return `snapshot returned ${counts.tabs} tab(s), ${counts.tasks} task(s), and ${counts.profiles} profile(s).`;
  }
  if (command === "tabs") {
    if (!Array.isArray(body.tabs)) throw new Error("tabs command omitted its tabs array");
    for (const tab of body.tabs) {
      const item = tab && typeof tab === "object" ? tab as Record<string, unknown> : null;
      if (!item || typeof item.browserTabId !== "string" || !item.browserTabId
        || typeof item.engineId !== "string" || !item.engineId
        || typeof item.status !== "string" || !item.status) {
        throw new Error("tabs command returned an entry without stable identity and status");
      }
    }
    return `tabs returned ${body.tabs.length} stable tab snapshot${body.tabs.length === 1 ? "" : "s"}.`;
  }
  if (command === "locks") {
    if (!Array.isArray(body.locks)) throw new Error("locks command omitted its locks array");
    for (const lock of body.locks) {
      const item = lock && typeof lock === "object" ? lock as Record<string, unknown> : null;
      if (!item || typeof item.browserTabId !== "string" || !item.browserTabId
        || !item.lock || typeof item.lock !== "object") {
        throw new Error("locks command returned an entry without a tab and lock record");
      }
    }
    return `locks returned ${body.locks.length} active lock record${body.locks.length === 1 ? "" : "s"}.`;
  }
  if (command === "check") {
    if (body.schema !== "shellx/browser-quiet-check@1" || body.ok !== true || body.mode !== "quiet") {
      throw new Error("check command omitted its exact quiet-check identity");
    }
    const effects = body.effects && typeof body.effects === "object"
      ? body.effects as Record<string, unknown>
      : null;
    if (!effects || ["uiMutation", "windowOpened", "taskCreated", "engineMounted", "receiptEmitted"]
      .some((key) => effects[key] !== false)) {
      throw new Error("check command did not prove its zero-mutation quiet effects");
    }
    const settle = body.settle && typeof body.settle === "object"
      ? body.settle as Record<string, unknown>
      : null;
    if (!body.summary || typeof body.summary !== "object" || !settle || settle.settled !== true) {
      throw new Error("check command omitted its Browser summary or settled result");
    }
    return "check returned a settled, zero-mutation Browser quiet-check receipt.";
  }
  if (command === "dialogs") {
    if (!Array.isArray(body.dialogs)) throw new Error("dialogs command omitted its dialogs array");
    for (const dialog of body.dialogs) {
      const item = dialog && typeof dialog === "object" ? dialog as Record<string, unknown> : null;
      if (!item || typeof item.dialogId !== "string" || !item.dialogId
        || typeof item.dialogType !== "string" || !item.dialogType
        || typeof item.status !== "string" || !item.status
        || typeof item.requiresApproval !== "boolean"
        || !Number.isSafeInteger(item.createdAtMs)) {
        throw new Error("dialogs command returned an entry without stable identity, status, and approval metadata");
      }
    }
    return `dialogs returned ${body.dialogs.length} bounded dialog record${body.dialogs.length === 1 ? "" : "s"}.`;
  }
  if (command === "workflow-bookmarks") {
    if (body.ok !== true || !Number.isSafeInteger(body.count) || Number(body.count) < 0
      || !Array.isArray(body.workflows) || body.workflows.length !== body.count) {
      throw new Error("workflow-bookmarks omitted its bounded workflow collection");
    }
    for (const workflow of body.workflows) {
      const item = requireObject(workflow, "workflow-bookmarks workflow");
      requiredString(item.bookmarkId, "workflow-bookmarks workflow.bookmarkId");
      requiredString(item.taskType, "workflow-bookmarks workflow.taskType");
      requiredString(item.target, "workflow-bookmarks workflow.target");
      if (!Array.isArray(item.permissionsNeeded) || !Array.isArray(item.secretKinds)) {
        throw new Error("workflow-bookmarks workflow omitted bounded permission metadata");
      }
    }
    return `workflow-bookmarks returned ${body.workflows.length} bounded workflow descriptor${body.workflows.length === 1 ? "" : "s"}; workflow contents were not retained.`;
  }
  throw new Error(`browser CLI verifier does not support ${command}`);
}

runReleaseSurfaceDriverCli(manifest, execute).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
