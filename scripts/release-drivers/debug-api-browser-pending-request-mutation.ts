import { isDeepStrictEqual } from "node:util";
import type {
  ReleaseSurfaceDriverOutcome,
  ReleaseSurfaceDriverRequest,
} from "../lib/release-surface-driver-protocol";
import {
  cleanupDebugApiBrowserSettleFixture,
  prepareDebugApiBrowserSettleFixture,
} from "./debug-api-browser-settle-fixture";

const BROWSER_PENDING_REQUEST_MUTATIONS = new Set([
  "POST /browser/dialogs",
  "POST /browser/permissions",
  "POST /browser/session-grants/apply",
  "POST /browser/session-grants/request",
]);

const TIMEOUT_MS = 30_000;

type DebugApiConnection = { base: string; token: string };
type DriverAssignment = ReleaseSurfaceDriverRequest["assignments"][number];

type PendingRequestIdentity = {
  id: string;
  createdAtMs: number;
  createdRow: Record<string, unknown>;
  listPath: "/browser/dialogs?limit=1000" | "/browser/permissions?limit=1000" | "/browser/requests?limit=1000";
  listKey: "dialogs" | "permissions" | "sessionGrants";
  cancellationKind: "browserDialogCancelled" | "browserPermissionCancelled" | "browserSessionGrantCancelled";
  cancellationCountKey: "cancelledDialogs" | "cancelledPermissions" | "cancelledGrants";
};

export function isDebugApiBrowserPendingRequestMutation(name: string): boolean {
  return BROWSER_PENDING_REQUEST_MUTATIONS.has(name);
}

export async function exerciseDebugApiBrowserPendingRequestMutation(
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
    observedEffect: "No exact owned Browser pending-request lifecycle was observed.",
  };
  let fixture: Awaited<ReturnType<typeof prepareDebugApiBrowserSettleFixture>> | null = null;
  try {
    if (!BROWSER_PENDING_REQUEST_MUTATIONS.has(assignment.surface.name)) {
      throw new Error(`unsupported Browser pending-request route ${assignment.surface.name}`);
    }
    fixture = await prepareDebugApiBrowserSettleFixture(connection);
    outcome.present = "pass";

    const grantApplication = assignment.surface.name === "POST /browser/session-grants/apply";
    const segment = request.sourceCommit.slice(0, 16);
    const created = assignment.surface.name === "POST /browser/dialogs"
      ? await createDialog(connection, fixture, segment)
      : assignment.surface.name === "POST /browser/permissions"
        ? await createPermission(connection, fixture, segment)
        : await createSessionGrant(connection, fixture, segment);
    if (!grantApplication) outcome.invoke = "pass";

    const pendingRows = await readPendingRows(connection, created.listPath, created.listKey);
    const pendingMatches = pendingRows.filter((row) => pendingRequestId(row) === created.id);
    if (pendingMatches.length !== 1
      || !isDeepStrictEqual(pendingMatches[0], created.createdRow)) {
      throw new Error("Browser pending-request readback omitted the exact owned pending row");
    }
    const createdReceipts = await readReceipts(connection);
    if (!createdReceipts.some((receipt) => receiptMatchesCreatedRequest(receipt, created.id, fixture!.taskId))) {
      throw new Error("Browser pending-request receipt did not read back by exact owned identity");
    }
    if (grantApplication) {
      const denied = await apiJsonResponse(connection, "POST", "/browser/session-grants/apply", {
        grantId: created.id,
        taskId: fixture.taskId,
      });
      outcome.invoke = "pass";
      if (denied.status !== 400) {
        throw new Error(`Browser session grant apply returned ${denied.status} instead of 400`);
      }
      verifyExactKeys(denied.body, ["error", "ok"], "Browser session grant apply denial");
      if (denied.body.ok !== false
        || denied.body.error !== `browser session grant '${created.id}' is not granted`) {
        throw new Error("Browser session grant apply returned the wrong ungranted-state denial");
      }
      const afterDeniedRows = await readPendingRows(connection, created.listPath, created.listKey);
      const afterDeniedMatches = afterDeniedRows.filter((row) => pendingRequestId(row) === created.id);
      if (afterDeniedMatches.length !== 1
        || !isDeepStrictEqual(afterDeniedMatches[0], created.createdRow)) {
        throw new Error("Browser session grant apply denial changed the exact requested grant");
      }
    }

    const finishReason = "releaseSurfacePendingRequestCleanup";
    const task = await apiJson(connection, "POST", "/browser/task/finish", {
      taskId: fixture.taskId,
      status: "completed",
      reason: finishReason,
      requestedBy: "shellx-release-driver",
    });
    if (task.taskId !== fixture.taskId || task.status !== "completed") {
      throw new Error("Browser pending-request task did not reach its exact terminal cleanup state");
    }

    const terminalRows = await readPendingRows(connection, created.listPath, created.listKey);
    const terminalMatches = terminalRows.filter((row) => pendingRequestId(row) === created.id);
    const terminal = terminalMatches[0];
    if (terminalMatches.length !== 1 || terminal?.status !== "cancelled"
      || !Number.isSafeInteger(terminal.resolvedAtMs)
      || Number(terminal.resolvedAtMs) < created.createdAtMs
      || !isDeepStrictEqual(terminal, {
        ...created.createdRow,
        status: "cancelled",
        resolvedAtMs: terminal.resolvedAtMs,
      })) {
      throw new Error("Browser pending-request task completion did not cancel the exact owned row");
    }
    const terminalReceipts = await readReceipts(connection);
    const cancellations = terminalReceipts.filter((receipt) => {
      if (receipt.kind !== created.cancellationKind || receipt.taskId !== fixture!.taskId
        || receipt.profileId !== "task-disposable") return false;
      const evidence = requireObject(receipt.evidence, "Browser pending-request cancellation receipt evidence");
      return evidence.status === "completed" && evidence.reason === finishReason
        && evidence[created.cancellationCountKey] === 1;
    });
    if (cancellations.length !== 1) {
      throw new Error("Browser pending-request cancellation receipt omitted its exact task and count");
    }

    outcome.effect = "pass";
    const subject = assignment.surface.name === "POST /browser/dialogs"
      ? "dialog"
      : assignment.surface.name === "POST /browser/permissions" ? "permission request" : "session grant request";
    outcome.observedEffect = grantApplication
      ? "POST /browser/session-grants/apply rejected one exact owned requested grant, preserved its pending row, then task completion cancelled that row with one matching cancellation receipt; terminal identities end with candidate teardown."
      : `${assignment.surface.name} created and read back one exact owned pending ${subject} plus its receipt, then task completion cancelled the same row with one matching cancellation receipt; terminal identities end with candidate teardown.`;
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

async function createDialog(
  connection: DebugApiConnection,
  fixture: Awaited<ReturnType<typeof prepareDebugApiBrowserSettleFixture>>,
  segment: string,
): Promise<PendingRequestIdentity> {
  const text = `SHELLX_RELEASE_BROWSER_DIALOG_${segment}`;
  const response = await apiJson(connection, "POST", "/browser/dialogs", {
    taskId: fixture.taskId,
    browserTabId: fixture.browserTabId,
    dialogType: "confirm",
    text,
    url: `${fixture.url}?release-private=${segment}#release-private`,
    requiresApproval: true,
  });
  verifyExactKeys(response, [
    "browserTabId", "createdAtMs", "dialogId", "dialogType", "profileId",
    "promptValueProvided", "receipt", "requiresApproval", "resolvedAtMs", "status",
    "taskId", "text", "url",
  ], "Browser dialog response");
  const id = requiredString(response.dialogId, "Browser dialogId");
  const createdAtMs = requiredPositiveInteger(response.createdAtMs, "Browser dialog createdAtMs");
  const receipt = verifyReceipt(response.receipt, "browserDialogRecorded", fixture.taskId, id, "dialogId");
  const evidence = requireObject(receipt.evidence, "Browser dialog receipt evidence");
  if (!id.startsWith("browser-dialog-") || response.taskId !== fixture.taskId
    || response.browserTabId !== fixture.browserTabId || response.profileId !== "task-disposable"
    || response.dialogType !== "confirm" || response.text !== text || response.url !== fixture.url
    || response.status !== "pending" || response.requiresApproval !== true
    || response.promptValueProvided !== false || response.resolvedAtMs !== null
    || evidence.browserTabId !== fixture.browserTabId || evidence.dialogType !== "confirm"
    || evidence.textBytes !== Buffer.byteLength(text) || evidence.url !== fixture.url
    || evidence.status !== "pending" || evidence.requiresApproval !== true) {
    throw new Error("Browser dialog response omitted its exact owned, sanitized pending state");
  }
  return {
    id, createdAtMs, createdRow: response,
    listPath: "/browser/dialogs?limit=1000",
    listKey: "dialogs",
    cancellationKind: "browserDialogCancelled",
    cancellationCountKey: "cancelledDialogs",
  };
}

async function createPermission(
  connection: DebugApiConnection,
  fixture: Awaited<ReturnType<typeof prepareDebugApiBrowserSettleFixture>>,
  segment: string,
): Promise<PendingRequestIdentity> {
  const url = new URL(fixture.url);
  const response = await apiJson(connection, "POST", "/browser/permissions", {
    taskId: fixture.taskId,
    browserTabId: fixture.browserTabId,
    permissionKind: "geolocation",
    url: `${fixture.url}?release-private=${segment}#release-private`,
    userInitiated: true,
    requiresApproval: true,
  });
  verifyExactKeys(response, [
    "browserTabId", "createdAtMs", "fragmentRetained", "origin", "path", "permissionId",
    "permissionKind", "profileId", "queryRetained", "receipt", "requiresApproval",
    "resolvedAtMs", "status", "taskId", "userInitiated",
  ], "Browser permission response");
  const id = requiredString(response.permissionId, "Browser permissionId");
  const createdAtMs = requiredPositiveInteger(response.createdAtMs, "Browser permission createdAtMs");
  const receipt = verifyReceipt(response.receipt, "browserPermissionRequested", fixture.taskId, id, "permissionId");
  const evidence = requireObject(receipt.evidence, "Browser permission receipt evidence");
  if (!id.startsWith("browser-permission-") || response.taskId !== fixture.taskId
    || response.browserTabId !== fixture.browserTabId || response.profileId !== "task-disposable"
    || response.permissionKind !== "geolocation" || response.origin !== url.origin
    || response.path !== url.pathname || response.queryRetained !== false || response.fragmentRetained !== false
    || response.userInitiated !== true || response.status !== "pending"
    || response.requiresApproval !== true || response.resolvedAtMs !== null
    || evidence.browserTabId !== fixture.browserTabId || evidence.permissionKind !== "geolocation"
    || evidence.origin !== url.origin || evidence.path !== url.pathname
    || evidence.queryRetained !== false || evidence.fragmentRetained !== false
    || evidence.userInitiated !== true || evidence.status !== "pending" || evidence.requiresApproval !== true) {
    throw new Error("Browser permission response omitted its exact owned, sanitized pending state");
  }
  return {
    id, createdAtMs, createdRow: response,
    listPath: "/browser/permissions?limit=1000",
    listKey: "permissions",
    cancellationKind: "browserPermissionCancelled",
    cancellationCountKey: "cancelledPermissions",
  };
}

async function createSessionGrant(
  connection: DebugApiConnection,
  fixture: Awaited<ReturnType<typeof prepareDebugApiBrowserSettleFixture>>,
  segment: string,
): Promise<PendingRequestIdentity> {
  const reason = `SHELLX_RELEASE_BROWSER_SESSION_GRANT_${segment}`;
  const response = await apiJson(connection, "POST", "/browser/session-grants/request", {
    taskId: fixture.taskId,
    fromProfileId: "personal",
    toProfileId: "task-disposable",
    reason,
    ttlSeconds: 300,
  });
  verifyExactKeys(response, [
    "appliedAtMs", "createdAtMs", "fromProfileId", "grantId", "reason", "resolvedAtMs",
    "status", "taskId", "toProfileId", "ttlSeconds",
  ], "Browser session grant response");
  const id = requiredString(response.grantId, "Browser session grantId");
  const createdAtMs = requiredPositiveInteger(response.createdAtMs, "Browser session grant createdAtMs");
  if (!id.startsWith("browser-grant-") || response.taskId !== fixture.taskId
    || response.fromProfileId !== "personal" || response.toProfileId !== "task-disposable"
    || response.reason !== reason || response.status !== "requested" || response.ttlSeconds !== 300
    || response.resolvedAtMs !== null || response.appliedAtMs !== null) {
    throw new Error("Browser session grant response omitted its exact owned requested state");
  }
  return {
    id, createdAtMs, createdRow: response,
    listPath: "/browser/requests?limit=1000",
    listKey: "sessionGrants",
    cancellationKind: "browserSessionGrantCancelled",
    cancellationCountKey: "cancelledGrants",
  };
}

async function readPendingRows(
  connection: DebugApiConnection,
  path: PendingRequestIdentity["listPath"],
  key: PendingRequestIdentity["listKey"],
): Promise<Array<Record<string, unknown>>> {
  const response = await apiJson(connection, "GET", path);
  if (key === "sessionGrants") {
    verifyExactKeys(response, ["dialogs", "permissions", "revision", "sessionGrants", "vaultDeposits"], "Browser request list");
  } else {
    verifyExactKeys(response, [key], `Browser ${key} list`);
  }
  return requireObjectArray(response[key], `Browser ${key} rows`);
}

async function readReceipts(connection: DebugApiConnection): Promise<Array<Record<string, unknown>>> {
  const response = await apiJson(connection, "GET", "/browser/receipts?limit=1000");
  verifyExactKeys(response, ["receipts"], "Browser receipt list");
  return requireObjectArray(response.receipts, "Browser receipts");
}

function receiptMatchesCreatedRequest(receipt: Record<string, unknown>, id: string, taskId: string): boolean {
  if (receipt.taskId !== taskId) return false;
  const evidence = requireObject(receipt.evidence, "Browser created-request receipt evidence");
  return evidence.dialogId === id || evidence.permissionId === id || evidence.grantId === id;
}

function verifyReceipt(
  value: unknown,
  kind: string,
  taskId: string,
  requestId: string,
  evidenceIdKey: string,
): Record<string, unknown> {
  const receipt = requireObject(value, "Browser pending-request receipt");
  verifyExactKeys(receipt, ["evidence", "kind", "profileId", "receiptId", "sequence", "summary", "t", "taskId"], "Browser pending-request receipt");
  const evidence = requireObject(receipt.evidence, "Browser pending-request receipt evidence");
  if (!requiredString(receipt.receiptId, "Browser pending-request receiptId")
    || receipt.kind !== kind || receipt.taskId !== taskId || receipt.profileId !== "task-disposable"
    || !Number.isSafeInteger(receipt.t) || Number(receipt.t) <= 0
    || !Number.isSafeInteger(receipt.sequence) || Number(receipt.sequence) <= 0
    || evidence[evidenceIdKey] !== requestId) {
    throw new Error("Browser pending-request receipt omitted its exact owned identity");
  }
  return receipt;
}

function pendingRequestId(value: Record<string, unknown>): unknown {
  return value.dialogId ?? value.permissionId ?? value.grantId;
}

async function apiJson(
  connection: DebugApiConnection,
  method: "GET" | "POST",
  path: string,
  body?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await apiJsonResponse(connection, method, path, body);
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`${method} ${path} failed ${response.status}: ${JSON.stringify(response.body).slice(0, 1_200)}`);
  }
  return response.body;
}

async function apiJsonResponse(
  connection: DebugApiConnection,
  method: "GET" | "POST",
  path: string,
  body?: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
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
  return {
    status: response.status,
    body: requireObject(text.trim() ? JSON.parse(text) : {}, `${method} ${path}`),
  };
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

function requiredPositiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) throw new Error(`${label} must be a positive integer`);
  return Number(value);
}

function verifyExactKeys(value: Record<string, unknown>, expected: string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new Error(`${label} keys changed: ${actual.join(", ")}`);
  }
}
