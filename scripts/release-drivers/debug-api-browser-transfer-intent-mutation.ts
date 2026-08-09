import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve, win32 } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type {
  ReleaseSurfaceDriverOutcome,
  ReleaseSurfaceDriverRequest,
} from "../lib/release-surface-driver-protocol";
import {
  cleanupDebugApiBrowserSettleFixture,
  prepareDebugApiBrowserSettleFixture,
} from "./debug-api-browser-settle-fixture";

const BROWSER_TRANSFER_INTENT_MUTATIONS = new Set([
  "POST /browser/downloads/complete",
  "POST /browser/downloads/request",
  "POST /browser/uploads/complete",
  "POST /browser/uploads/request",
]);

const TIMEOUT_MS = 30_000;

type DebugApiConnection = { base: string; token: string };
type DriverAssignment = ReleaseSurfaceDriverRequest["assignments"][number];

type TransferFileFixture = {
  apiDirectory: string;
  nodeDirectory: string;
  apiFile: string;
  nodeFile: string;
  fileName: string;
};

export function isDebugApiBrowserTransferIntentMutation(name: string): boolean {
  return BROWSER_TRANSFER_INTENT_MUTATIONS.has(name);
}

export async function exerciseDebugApiBrowserTransferIntentMutation(
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
    observedEffect: "No exact owned Browser transfer intent was observed.",
  };
  let browserFixture: Awaited<ReturnType<typeof prepareDebugApiBrowserSettleFixture>> | null = null;
  let fileFixture: TransferFileFixture | null = null;
  try {
    if (!BROWSER_TRANSFER_INTENT_MUTATIONS.has(assignment.surface.name)) {
      throw new Error(`unsupported Browser transfer intent route ${assignment.surface.name}`);
    }
    browserFixture = await prepareDebugApiBrowserSettleFixture(connection);
    fileFixture = prepareTransferFileFixture(request, assignment.surface.name);
    outcome.present = "pass";

    const upload = assignment.surface.name.includes("/browser/uploads/");
    const completion = assignment.surface.name.endsWith("/complete");
    const path = upload ? "/browser/uploads/request" : "/browser/downloads/request";
    const listPath = upload ? "/browser/uploads" : "/browser/downloads";
    const direction = upload ? "upload" : "download";
    const reason = `Final release owned Browser ${direction} intent proof`;
    const sourceUrl = `${browserFixture.url}release-owned-download.txt`;
    const destinationOrigin = new URL(browserFixture.url).origin;
    const response = await apiJson(connection, "POST", path, upload ? {
      taskId: browserFixture.taskId,
      browserTabId: browserFixture.browserTabId,
      filePath: fileFixture.apiFile,
      displayName: fileFixture.fileName,
      destinationOrigin,
      refId: "release-owned-upload-target",
      reason,
    } : {
      taskId: browserFixture.taskId,
      browserTabId: browserFixture.browserTabId,
      url: sourceUrl,
      fileName: fileFixture.fileName,
      destinationDir: fileFixture.apiDirectory,
      reason,
    });
    outcome.invoke = "pass";
    verifyTransferEntryKeys(response, `Browser ${direction} request response`);
    const transferId = requiredString(response.transferId, `Browser ${direction} transferId`);
    const receipt = requireObject(response.receipt, `Browser ${direction} request receipt`);
    const evidence = requireObject(receipt.evidence, `Browser ${direction} receipt evidence`);
    if (response.direction !== direction || response.status !== "requested"
      || response.taskId !== browserFixture.taskId || response.browserTabId !== browserFixture.browserTabId
      || response.displayName !== fileFixture.fileName || response.reason !== reason
      || !Number.isSafeInteger(response.requestedAtMs) || Number(response.requestedAtMs) <= 0
      || response.completedAtMs !== null || response.finalPath !== null || response.approvalId !== null
      || receipt.kind !== (upload ? "browserUploadRequested" : "browserDownloadRequested")
      || receipt.taskId !== browserFixture.taskId || evidence.transferId !== transferId
      || evidence.browserTabId !== browserFixture.browserTabId || evidence.status !== "requested") {
      throw new Error(`Browser ${direction} request omitted its exact owned intent identity`);
    }
    if (upload) {
      if (response.filePath !== null || response.destinationOrigin !== destinationOrigin
        || response.refId !== "release-owned-upload-target" || response.url !== null
        || evidence.displayName !== fileFixture.fileName || evidence.destinationOrigin !== destinationOrigin
        || evidence.refId !== "release-owned-upload-target") {
        throw new Error("Browser upload request disclosed a local source path or lost its destination intent");
      }
    } else if (response.url !== sourceUrl || response.destination !== fileFixture.apiDirectory
      || response.filePath !== null || evidence.url !== sourceUrl
      || evidence.displayName !== fileFixture.fileName || evidence.destination !== fileFixture.apiDirectory) {
      throw new Error("Browser download request did not retain its exact owned source and destination intent");
    }

    const list = await apiJson(connection, "GET", listPath);
    verifyExactKeys(list, [upload ? "uploads" : "downloads"], `Browser ${direction} list response`);
    const entries = requireObjectArray(list[upload ? "uploads" : "downloads"], `Browser ${direction} list`);
    const matches = entries.filter((entry) => entry.transferId === transferId);
    if (matches.length !== 1 || matches[0]?.status !== "requested"
      || matches[0]?.taskId !== browserFixture.taskId || matches[0]?.browserTabId !== browserFixture.browserTabId
      || !isDeepStrictEqual(matches[0], response)) {
      throw new Error(`Browser ${direction} list did not read back exactly one owned requested intent`);
    }
    const receipts = requireObjectArray(
      (await apiJson(connection, "GET", "/browser/receipts?limit=1000")).receipts,
      "Browser transfer receipt readback",
    );
    const receiptMatches = receipts.filter((candidate) => (
      candidate.receiptId === receipt.receiptId
      && candidate.kind === receipt.kind
      && requireObject(candidate.evidence, "Browser transfer readback evidence").transferId === transferId
    ));
    if (receiptMatches.length !== 1) {
      throw new Error(`Browser ${direction} receipt did not read back by exact owned transfer identity`);
    }
    if (completion) {
      const denied = await apiJsonResponse(connection, "POST", `/browser/${direction}s/complete`, {
        transferId,
        finalPath: fileFixture.apiFile,
        mimeType: upload ? "text/plain" : "application/octet-stream",
        bytes: 1,
        sha256: "a".repeat(64),
        sourceUrl,
        destination: upload ? destinationOrigin : fileFixture.apiDirectory,
        retentionReason: `Final release ${direction} completion approval-boundary proof`,
        approvalId: `shellx-release-ungranted-${direction}-approval`,
      });
      if (denied.status !== 400) {
        throw new Error(`Browser ${direction} completion returned ${denied.status} instead of 400`);
      }
      verifyExactKeys(denied.body, ["error", "ok"], `Browser ${direction} completion denial`);
      if (denied.body.ok !== false
        || denied.body.error !== "approvalId must reference a host-granted browser transfer approval") {
        throw new Error(`Browser ${direction} completion returned the wrong host-grant denial`);
      }
      const afterList = await apiJson(connection, "GET", listPath);
      const afterEntries = requireObjectArray(
        afterList[upload ? "uploads" : "downloads"],
        `Browser ${direction} list after denied completion`,
      );
      const afterMatches = afterEntries.filter((entry) => entry.transferId === transferId);
      if (afterMatches.length !== 1 || !isDeepStrictEqual(afterMatches[0], response)) {
        throw new Error(`Browser ${direction} completion denial changed the exact pending transfer`);
      }
      const afterReceipts = requireObjectArray(
        (await apiJson(connection, "GET", "/browser/receipts?limit=1000")).receipts,
        "Browser transfer receipt readback after denied completion",
      );
      if (afterReceipts.some((candidate) => {
        const evidence = requireObject(candidate.evidence, "Browser transfer denial receipt evidence");
        return evidence.transferId === transferId
          && candidate.kind === (upload ? "browserUploadCompleted" : "browserDownloadCompleted");
      })) {
        throw new Error(`Browser ${direction} completion denial emitted a false completion receipt`);
      }
    }
    outcome.effect = "pass";
    outcome.observedEffect = completion
      ? `${assignment.surface.name} rejected completion of one exact owned requested ${direction} without a host-granted approval, preserved the pending row, and emitted no false completion receipt; identities end with candidate teardown.`
      : `POST ${path} recorded and read back exactly one owned requested ${direction} intent plus its matching receipt without performing a transfer; identities end with candidate teardown.`;
  } catch (error) {
    outcome.error = error instanceof Error ? error.message : String(error);
  } finally {
    const errors: string[] = [];
    if (fileFixture) {
      const error = cleanupTransferFileFixture(fileFixture);
      if (error) errors.push(error);
    }
    if (browserFixture) {
      const error = await cleanupDebugApiBrowserSettleFixture(connection, browserFixture);
      if (error) errors.push(error);
    }
    if (errors.length > 0) {
      const cleanup = errors.join("; ");
      outcome.error = outcome.error ? `${outcome.error}; cleanup: ${cleanup}` : `cleanup: ${cleanup}`;
    } else {
      outcome.cleanup = "pass";
    }
  }
  return outcome;
}

function prepareTransferFileFixture(
  request: ReleaseSurfaceDriverRequest,
  surfaceName: string,
): TransferFileFixture {
  const segment = request.sourceCommit.slice(0, 16).replace(/[^a-f0-9]/g, "0");
  const direction = surfaceName.includes("uploads") ? "upload" : "download";
  const directoryName = `release-browser-${direction}-${segment}`;
  const fileName = `release-owned-${direction}-${segment}.txt`;
  const apiDirectory = siblingPath(request.runtime.debugTokenPath, directoryName, request.platform);
  const nodeDirectory = nodeReadablePath(apiDirectory, request.platform);
  const apiFile = platformJoin(apiDirectory, fileName, request.platform);
  const nodeFile = join(nodeDirectory, fileName);
  mkdirSync(nodeDirectory, { mode: 0o700 });
  try {
    writeFileSync(nodeFile, `ShellX release owned ${direction} transfer fixture ${segment}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    return { apiDirectory, nodeDirectory, apiFile, nodeFile, fileName };
  } catch (error) {
    if (existsSync(nodeFile)) unlinkSync(nodeFile);
    if (existsSync(nodeDirectory)) rmdirSync(nodeDirectory);
    throw error;
  }
}

function cleanupTransferFileFixture(fixture: TransferFileFixture): string | null {
  try {
    if (existsSync(fixture.nodeFile)) unlinkSync(fixture.nodeFile);
    if (existsSync(fixture.nodeDirectory)) rmdirSync(fixture.nodeDirectory);
    if (existsSync(fixture.nodeFile) || existsSync(fixture.nodeDirectory)) {
      throw new Error("owned Browser transfer file fixture remained after exact cleanup");
    }
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function siblingPath(
  tokenPath: string,
  name: string,
  platform: ReleaseSurfaceDriverRequest["platform"],
): string {
  if (platform === "windows-installed" && /^[A-Za-z]:[\\/]/.test(tokenPath)) {
    return win32.join(win32.dirname(tokenPath), name);
  }
  return join(dirname(tokenPath), name);
}

function platformJoin(
  parent: string,
  child: string,
  platform: ReleaseSurfaceDriverRequest["platform"],
): string {
  return platform === "windows-installed" && /^[A-Za-z]:[\\/]/.test(parent)
    ? win32.join(parent, child)
    : join(parent, child);
}

function nodeReadablePath(path: string, platform: ReleaseSurfaceDriverRequest["platform"]): string {
  if (platform !== "windows-installed" || process.platform === "win32" || !/^[A-Za-z]:[\\/]/.test(path)) {
    return resolve(path);
  }
  const result = spawnSync("wslpath", ["-u", path], { encoding: "utf8" });
  if (result.status !== 0 || !result.stdout.trim()) {
    throw new Error("unable to map the Browser transfer fixture path into WSL");
  }
  return resolve(result.stdout.trim());
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

function verifyTransferEntryKeys(value: Record<string, unknown>, label: string): void {
  verifyExactKeys(value, [
    "approvalId", "browserTabId", "bytes", "completedAtMs", "contentKind", "destination",
    "destinationOrigin", "direction", "displayName", "filePath", "finalPath", "mimeType",
    "reason", "receipt", "refId", "requestedAtMs", "retentionReason", "sha256", "sourceUrl",
    "status", "taskId", "transferId", "url",
  ], label);
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
