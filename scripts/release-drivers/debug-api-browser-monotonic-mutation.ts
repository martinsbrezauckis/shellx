import { isDeepStrictEqual } from "node:util";
import type {
  ReleaseSurfaceDriverOutcome,
  ReleaseSurfaceDriverRequest,
} from "../lib/release-surface-driver-protocol";
import {
  cleanupDebugApiBrowserSettleFixture,
  prepareDebugApiBrowserSettleFixture,
} from "./debug-api-browser-settle-fixture";

const BROWSER_MONOTONIC_MUTATIONS = new Set([
  "POST /browser/logs",
  "POST /browser/popups",
  "POST /browser/report",
]);

const TIMEOUT_MS = 30_000;

type DebugApiConnection = { base: string; token: string };
type DriverAssignment = ReleaseSurfaceDriverRequest["assignments"][number];

export function isDebugApiBrowserMonotonicMutation(name: string): boolean {
  return BROWSER_MONOTONIC_MUTATIONS.has(name);
}

export async function exerciseDebugApiBrowserMonotonicMutation(
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
    observedEffect: "No owned monotonic Browser mutation was observed.",
  };
  let fixture: Awaited<ReturnType<typeof prepareDebugApiBrowserSettleFixture>> | null = null;
  try {
    if (!BROWSER_MONOTONIC_MUTATIONS.has(assignment.surface.name)) {
      throw new Error(`unsupported monotonic Browser route ${assignment.surface.name}`);
    }
    const callerSessionId = assignment.surface.name === "POST /browser/logs"
      ? `release-browser-log-${request.sourceCommit.slice(0, 16)}`
      : null;
    fixture = await prepareDebugApiBrowserSettleFixture(connection, { callerSessionId });
    outcome.present = "pass";
    const segment = request.sourceCommit.slice(0, 16);
    if (assignment.surface.name === "POST /browser/logs") {
      const marker = `ShellX release browser log ${segment}`;
      const entry = await apiJson(connection, "POST", "/browser/logs", {
        taskId: fixture.taskId,
        level: "info",
        source: "shellx-release-surface",
        message: marker,
        url: fixture.url,
        line: 35,
        column: 1,
        details: { releaseSurface: true, secretValues: false },
      }, fixture.callerSessionId);
      outcome.invoke = "pass";
      verifyExactKeys(entry, [
        "column", "details", "level", "line", "logId", "message", "profileId", "sequence",
        "source", "t", "taskId", "url",
      ], "Browser log response");
      const logId = requiredString(entry.logId, "Browser logId");
      if (entry.taskId !== fixture.taskId || entry.profileId !== "task-disposable"
        || entry.level !== "info" || entry.source !== "agent-reported" || entry.message !== marker
        || entry.url !== fixture.url || entry.line !== 35 || entry.column !== 1
        || requireObject(entry.details, "Browser log details").releaseSurface !== true) {
        throw new Error("Browser log response omitted its exact bounded owned-task entry");
      }
      const logs = requireObjectArray(
        (await apiJson(connection, "GET", "/browser/logs?limit=1000")).logs,
        "Browser log readback",
      );
      const matches = logs.filter((candidate) => candidate.logId === logId && candidate.message === marker);
      if (matches.length !== 1 || matches[0]?.taskId !== fixture.taskId) {
        throw new Error("Browser logs did not read back exactly one owned entry");
      }
      const receipts = await readReceipts(connection);
      const receiptMatches = receipts.filter((receipt) => (
        receipt.kind === "browserConsoleLog"
        && receipt.taskId === fixture!.taskId
        && requireObject(receipt.evidence, "Browser log receipt evidence").logId === logId
      ));
      if (receiptMatches.length !== 1) throw new Error("Browser log receipt did not bind the exact owned entry");
      outcome.effect = "pass";
      outcome.observedEffect = "POST /browser/logs appended and read back exactly one bounded owned-task log plus its matching receipt; message and entry identities were not retained and the monotonic rows end at candidate teardown.";
    } else if (assignment.surface.name === "POST /browser/report") {
      const title = `ShellX release report ${segment}`;
      const bodyMarker = `SHELLX_RELEASE_BROWSER_REPORT_${segment}`;
      const report = await apiJson(connection, "POST", "/browser/report", {
        taskId: fixture.taskId,
        title,
        body: bodyMarker,
      });
      outcome.invoke = "pass";
      verifyExactKeys(report, ["receipt", "reportId", "title"], "Browser report response");
      const reportId = requiredString(report.reportId, "Browser reportId");
      const receipt = requireObject(report.receipt, "Browser report receipt");
      const evidence = requireObject(receipt.evidence, "Browser report receipt evidence");
      if (report.title !== title || receipt.kind !== "browserReportWritten" || receipt.taskId !== fixture.taskId
        || evidence.reportId !== reportId || evidence.title !== title
        || evidence.bodyBytes !== Buffer.byteLength(bodyMarker)) {
        throw new Error("Browser report response and receipt did not bind the exact owned bounded report");
      }
      const receipts = await readReceipts(connection);
      const matches = receipts.filter((candidate) => (
        candidate.receiptId === receipt.receiptId
        && candidate.kind === "browserReportWritten"
        && requireObject(candidate.evidence, "Browser report readback evidence").reportId === reportId
      ));
      if (matches.length !== 1) throw new Error("Browser receipts did not read back exactly one owned report receipt");
      outcome.effect = "pass";
      outcome.observedEffect = "POST /browser/report wrote exactly one bounded owned-task report receipt and read it back by exact identity; title, body, and receipt identities were not retained and the monotonic row ends at candidate teardown.";
    } else {
      const target = `${fixture.url}?invite=SHELLX_RELEASE_POPUP_${segment}#private-fragment`;
      const popup = await apiJson(connection, "POST", "/browser/popups", {
        taskId: fixture.taskId,
        browserTabId: fixture.browserTabId,
        openerUrl: fixture.url,
        targetUrl: target,
        disposition: "new-tab",
        requiresApproval: true,
      });
      outcome.invoke = "pass";
      verifyExactKeys(popup, [
        "browserTabId", "createdAtMs", "disposition", "fragmentRetained", "openerUrl",
        "origin", "path", "popupId", "profileId", "queryRetained", "receipt",
        "requiresApproval", "status", "targetUrl", "taskId",
      ], "Browser popup response");
      const popupId = requiredString(popup.popupId, "Browser popupId");
      const safeUrl = new URL(fixture.url);
      const receipt = requireObject(popup.receipt, "Browser popup receipt");
      const evidence = requireObject(receipt.evidence, "Browser popup receipt evidence");
      if (!popupId.startsWith("browser-popup-") || popup.taskId !== fixture.taskId
        || popup.browserTabId !== fixture.browserTabId || popup.profileId !== "task-disposable"
        || popup.openerUrl !== fixture.url || popup.targetUrl !== fixture.url
        || popup.origin !== safeUrl.origin || popup.path !== safeUrl.pathname
        || popup.queryRetained !== false || popup.fragmentRetained !== false
        || popup.disposition !== "new-tab" || popup.status !== "pendingApproval"
        || popup.requiresApproval !== true || !Number.isSafeInteger(popup.createdAtMs)
        || receipt.kind !== "browserPopupRecorded" || receipt.taskId !== fixture.taskId
        || evidence.popupId !== popupId || evidence.targetUrl !== fixture.url
        || evidence.queryRetained !== false || evidence.fragmentRetained !== false
        || evidence.disposition !== "new-tab" || evidence.status !== "pendingApproval"
        || evidence.requiresApproval !== true) {
        throw new Error("Browser popup response omitted its exact sanitized owned-task event and receipt");
      }
      const popups = requireObjectArray(
        (await apiJson(connection, "GET", "/browser/popups?limit=1000")).popups,
        "Browser popup readback",
      );
      const popupMatches = popups.filter((candidate) => candidate.popupId === popupId);
      if (popupMatches.length !== 1 || !isDeepStrictEqual(popupMatches[0], popup)) {
        throw new Error("Browser popup list did not read back the exact sanitized owned event");
      }
      const receipts = await readReceipts(connection);
      const receiptMatches = receipts.filter((candidate) => candidate.receiptId === receipt.receiptId
        && candidate.kind === "browserPopupRecorded" && candidate.taskId === fixture!.taskId);
      if (receiptMatches.length !== 1) throw new Error("Browser popup receipt did not read back by exact identity");
      outcome.effect = "pass";
      outcome.observedEffect = "POST /browser/popups recorded and read back exactly one approval-gated owned popup plus its receipt while stripping query and fragment data; URLs and identities were not retained and monotonic rows end at candidate teardown.";
    }
  } catch (error) {
    outcome.error = error instanceof Error ? error.message : String(error);
  } finally {
    if (fixture) {
      const cleanupError = await cleanupDebugApiBrowserSettleFixture(connection, fixture);
      if (cleanupError) {
        outcome.error = outcome.error ? `${outcome.error}; cleanup: ${cleanupError}` : `cleanup: ${cleanupError}`;
      } else {
        outcome.cleanup = "pass";
      }
    }
  }
  return outcome;
}

async function readReceipts(connection: DebugApiConnection): Promise<Array<Record<string, unknown>>> {
  const body = await apiJson(connection, "GET", "/browser/receipts?limit=1000");
  return requireObjectArray(body.receipts, "Browser receipt readback");
}

async function apiJson(
  connection: DebugApiConnection,
  method: "GET" | "POST",
  path: string,
  body?: Record<string, unknown>,
  callerSessionId?: string | null,
): Promise<Record<string, unknown>> {
  const response = await fetch(`${connection.base}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${connection.token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(callerSessionId ? { "x-shellx-mcp-caller-id": callerSessionId } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path} failed ${response.status}: ${text.slice(0, 1_200)}`);
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
