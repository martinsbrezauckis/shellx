import {
  cleanupDebugApiBrowserSettleFixture,
  prepareDebugApiBrowserSettleFixture,
  type DebugApiBrowserSettleFixture,
} from "./debug-api-browser-settle-fixture";
import { existsSync, lstatSync, rmSync } from "node:fs";

type DebugApiConnection = { base: string; token: string };

export type BrowserTeachEvidenceFixture = {
  browser: DebugApiBrowserSettleFixture;
  attemptId: string;
  flightArtifactPath: string;
};

export type BrowserTeachDraftIdentity = {
  draftId: string;
  revisionId: string;
  revisionSha256: string;
};

const TEACH_CALLER_ID = "release-surface-browser-teach-agent";

export function browserTeachCallerId(): string {
  return TEACH_CALLER_ID;
}

export async function prepareBrowserTeachEvidenceFixture(
  connection: DebugApiConnection,
  callerSessionId: string | null,
): Promise<BrowserTeachEvidenceFixture> {
  const browser = await prepareDebugApiBrowserSettleFixture(connection, { callerSessionId });
  try {
    const input = await apiJson(connection, "POST", "/browser/action", {
      action: "fillRef",
      taskId: browser.taskId,
      browserTabId: browser.browserTabId,
      selector: "#shellx-release-teach-input",
      value: "owned-teach-fixture-input",
    }, callerSessionId);
    const receipt = requireRecord(input.receipt, "Browser Teach input receipt");
    if (input.ok !== true || input.status !== "applied" || input.taskId !== browser.taskId
      || receipt.kind !== "browserEngineActionApplied" || receipt.taskId !== browser.taskId
      || JSON.stringify(input).includes("owned-teach-fixture-input")) {
      throw new Error("Browser Teach fixture did not record one redacted owned input action before Flight Recorder export");
    }
    const flight = await apiJson(connection, "POST", "/browser/flight-recorder/export", {
      taskId: browser.taskId,
      browserTabId: browser.browserTabId,
      suiteId: "release-surface-browser-teach",
      group: "baseline",
      attemptIndex: 0,
    }, callerSessionId);
    const attemptId = requiredString(flight.attemptId, "Browser Teach evidence attemptId");
    const flightArtifactPath = requiredString(flight.path, "Browser Teach evidence artifact path");
    if (flight.taskId !== browser.taskId || flight.browserTabId !== browser.browserTabId
      || flight.evidenceComplete !== true || !isSha256(flight.sha256)
      || !Number.isSafeInteger(flight.bytes) || Number(flight.bytes) <= 0) {
      throw new Error("Browser Teach evidence omitted its exact owned complete Flight Recorder receipt");
    }
    const completed = await apiJson(connection, "POST", "/browser/task/finish", {
      taskId: browser.taskId,
      status: "completed",
      reason: "release-surface-browser-teach-evidence-ready",
    }, callerSessionId);
    if (completed.taskId !== browser.taskId || completed.status !== "completed") {
      throw new Error("Browser Teach fixture did not complete its exact evidence-owning task");
    }
    return { browser, attemptId, flightArtifactPath };
  } catch (error) {
    await cleanupDebugApiBrowserSettleFixture(connection, browser);
    throw error;
  }
}

export async function cleanupBrowserTeachEvidenceFixture(
  connection: DebugApiConnection,
  fixture: BrowserTeachEvidenceFixture,
): Promise<string | null> {
  const errors: string[] = [];
  try {
    const stat = lstatSync(fixture.flightArtifactPath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error("Browser Teach evidence artifact was not one owned regular file");
    }
    rmSync(fixture.flightArtifactPath);
    if (existsSync(fixture.flightArtifactPath)) {
      throw new Error("Browser Teach evidence artifact remained after exact cleanup");
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  const browserCleanupError = await cleanupDebugApiBrowserSettleFixture(connection, fixture.browser);
  if (browserCleanupError) errors.push(browserCleanupError);
  return errors.length ? errors.join(" | ") : null;
}

export function teachPrepareRequest(fixture: BrowserTeachEvidenceFixture): Record<string, unknown> {
  return { attemptId: fixture.attemptId };
}

export function teachRevisionRequest(
  draft: BrowserTeachDraftIdentity,
): Record<string, unknown> {
  return {
    draftId: draft.draftId,
    expectedRevisionId: draft.revisionId,
    expectedRevisionSha256: draft.revisionSha256,
    goal: "Confirm owned Browser Teach release fixture",
    revisionNote: "release-surface-owned-fixture",
  };
}

export function verifyBrowserTeachPrepared(
  value: unknown,
  fixture: BrowserTeachEvidenceFixture,
): BrowserTeachDraftIdentity {
  const body = requireRecord(value, "Browser Teach prepare response");
  const bundle = requireRecord(body.bundle, "Browser Teach prepare bundle");
  const source = requireRecord(bundle.source, "Browser Teach prepare source");
  const revision = requireRecord(body.revision, "Browser Teach prepare revision");
  const draft = requireRecord(body.draft, "Browser Teach prepare draft");
  const draftId = requiredString(draft.draftId, "Browser Teach prepare draftId");
  const revisionId = requiredString(revision.revisionId, "Browser Teach prepare revisionId");
  const revisionSha256 = requiredSha256(revision.sha256, "Browser Teach prepare revision SHA-256");
  if (source.attemptId !== fixture.attemptId || source.taskId !== fixture.browser.taskId
    || source.browserTabId !== fixture.browser.browserTabId || source.evidenceComplete !== true
    || !isSha256(bundle.sha256) || revision.bundleId !== bundle.bundleId
    || revision.bundleSha256 !== bundle.sha256 || draft.taskId !== fixture.browser.taskId
    || draft.browserTabId !== fixture.browser.browserTabId || draft.attemptId !== fixture.attemptId
    || draft.currentRevisionId !== revisionId || draft.currentRevisionSha256 !== revisionSha256
    || draft.draftId !== draftId || !Number.isSafeInteger(draft.revision) || Number(draft.revision) !== 1) {
    throw new Error("Browser Teach prepare response omitted the exact task-owned immutable draft and current revision");
  }
  return { draftId, revisionId, revisionSha256 };
}

export function verifyBrowserTeachListed(
  value: unknown,
  fixture: BrowserTeachEvidenceFixture,
  draft: BrowserTeachDraftIdentity,
): void {
  const body = requireRecord(value, "Browser Teach drafts response");
  const drafts = requireArray(body.drafts, "Browser Teach drafts").map((entry) => requireRecord(entry, "Browser Teach draft"));
  const matching = drafts.filter((entry) => (
    entry.draftId === draft.draftId
    && entry.taskId === fixture.browser.taskId
    && entry.browserTabId === fixture.browser.browserTabId
    && entry.attemptId === fixture.attemptId
    && entry.currentRevisionId === draft.revisionId
    && entry.currentRevisionSha256 === draft.revisionSha256
  ));
  if (body.taskId !== fixture.browser.taskId || !Number.isSafeInteger(body.limit)
    || Number(body.limit) < 1 || matching.length !== 1) {
    throw new Error("Browser Teach drafts readback omitted the exact owner-scoped draft");
  }
}

export function verifyBrowserTeachRevised(
  value: unknown,
  fixture: BrowserTeachEvidenceFixture,
  previous: BrowserTeachDraftIdentity,
): BrowserTeachDraftIdentity {
  const body = requireRecord(value, "Browser Teach revise response");
  const revision = requireRecord(body.revision, "Browser Teach revised revision");
  const draft = requireRecord(body.draft, "Browser Teach revised draft");
  const revisionId = requiredString(revision.revisionId, "Browser Teach revised revisionId");
  const revisionSha256 = requiredSha256(revision.sha256, "Browser Teach revised revision SHA-256");
  if (revision.parentRevisionId !== previous.revisionId || revision.revision !== 2
    || revisionId === previous.revisionId || revisionSha256 === previous.revisionSha256
    || draft.draftId !== previous.draftId || draft.taskId !== fixture.browser.taskId
    || draft.browserTabId !== fixture.browser.browserTabId || draft.currentRevisionId !== revisionId
    || draft.currentRevisionSha256 !== revisionSha256 || draft.revision !== 2) {
    throw new Error("Browser Teach revise response omitted its exact compare-and-swap revision transition");
  }
  return { draftId: previous.draftId, revisionId, revisionSha256 };
}

export function verifyBrowserDeveloperModeDenial(
  value: unknown,
  fixture: BrowserTeachEvidenceFixture,
): void {
  const body = requireRecord(value, "Browser developer inspection response");
  const inspected = requireRecord(body.inspected, "Browser developer inspection target");
  const withheld = requireArray(body.withheldSections, "Browser developer inspection withheld sections");
  const truncation = requireRecord(body.truncation, "Browser developer inspection truncation");
  if (body.schemaVersion !== "sx.browserDeveloperInspection.v1" || body.ok !== false
    || body.status !== "blocked" || inspected.taskId !== fixture.browser.taskId
    || inspected.browserTabId !== fixture.browser.browserTabId || inspected.origin !== null
    || inspected.path !== null || truncation.developerModeRequired !== true
    || !["document", "console", "network", "performance", "issues"].every((section) => withheld.includes(section))) {
    throw new Error("Browser developer inspection did not preserve its fixed Developer Mode denial boundary");
  }
}

export async function apiJson(
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
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path} failed ${response.status}: ${text.slice(0, 1_200)}`);
  return requireRecord(text.trim() ? JSON.parse(text) : {}, `${method} ${path}`);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} did not return an object`);
  return value as Record<string, unknown>;
}

function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} did not return an array`);
  return value;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function requiredSha256(value: unknown, label: string): string {
  if (!isSha256(value)) throw new Error(`${label} must be a SHA-256 digest`);
  return value;
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
}
