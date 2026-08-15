import type {
  ReleaseSurfaceDriverOutcome,
  ReleaseSurfaceDriverRequest,
} from "../lib/release-surface-driver-protocol";
import {
  cleanupDebugApiBrowserSettleFixture,
  debugApiBrowserSettleRequestPath,
  prepareDebugApiBrowserSettleFixture,
  verifyDebugApiBrowserSettleJson,
} from "./debug-api-browser-settle-fixture";

const BROWSER_LIFECYCLE_MUTATIONS = new Set([
  "POST /browser/action",
  "POST /browser/cdp/execute",
  "POST /browser/task/start",
  "POST /browser/task/finish",
  "POST /browser/task/control",
  "POST /browser/tabs/close",
  "POST /browser/tabs/heartbeat",
  "POST /browser/tabs/lock",
  "POST /browser/tabs/focus",
  "POST /browser/tabs/open",
  "POST /browser/tabs/reorder",
  "POST /browser/tabs/unlock",
]);

type DebugApiConnection = { base: string; token: string };
type DriverAssignment = ReleaseSurfaceDriverRequest["assignments"][number];

export function isDebugApiBrowserLifecycleMutation(name: string): boolean {
  return BROWSER_LIFECYCLE_MUTATIONS.has(name);
}

export async function exerciseDebugApiBrowserLifecycleMutation(
  connection: DebugApiConnection,
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
    observedEffect: "No owned Browser lifecycle effect was observed.",
  };
  let fixture: Awaited<ReturnType<typeof prepareDebugApiBrowserSettleFixture>> | null = null;
  let leaseId: string | null = null;
  let secondaryTabId: string | null = null;
  const ownerAgentId = "shellx-release-driver";
  const ownerRunId = "final-surface-browser-lock";
  try {
    if (!BROWSER_LIFECYCLE_MUTATIONS.has(assignment.surface.name)) {
      throw new Error(`unsupported owned Browser lifecycle route ${assignment.surface.name}`);
    }
    fixture = await prepareDebugApiBrowserSettleFixture(connection);
    outcome.present = "pass";
    if (assignment.surface.name === "POST /browser/tabs/focus"
      || assignment.surface.name === "POST /browser/tabs/reorder") {
      const opened = await apiJson(connection, "POST", "/browser/tabs/open", {
        taskId: fixture.taskId,
        profileId: "task-disposable",
        url: fixture.url,
        expectedDomains: ["127.0.0.1"],
      });
      const openedTab = requireObject(opened.tab, "Browser secondary tab setup");
      secondaryTabId = requiredString(openedTab.browserTabId, "Browser secondary tab setup id");
      if (opened.ok !== true || openedTab.taskId !== fixture.taskId || secondaryTabId === fixture.browserTabId) {
        throw new Error("Browser secondary tab setup did not create one exact owned tab");
      }
    }
    if (assignment.surface.name === "POST /browser/tabs/heartbeat"
      || assignment.surface.name === "POST /browser/tabs/unlock") {
      const locked = await apiJson(connection, "POST", "/browser/tabs/lock", {
        browserTabId: fixture.browserTabId,
        ownerAgentId,
        ownerRunId,
        ttlSeconds: 10,
        scope: "exclusive",
      });
      const lock = requireObject(requireObject(locked.tab, "Browser tab lock setup tab").lock, "Browser tab lock setup");
      leaseId = requiredString(lock.leaseId, "Browser tab lock setup leaseId");
      if (locked.ok !== true || lock.ownerAgentId !== ownerAgentId || lock.ownerRunId !== ownerRunId) {
        throw new Error("Browser tab lock setup did not return its exact owned lease");
      }
    }
    if (assignment.surface.name === "POST /browser/action") {
      const body = await apiJson(connection, "POST", "/browser/action", {
        action: "verify",
        taskId: fixture.taskId,
        browserTabId: fixture.browserTabId,
        key: "text",
        value: "Owned Browser settle fixture ready",
        timeoutMs: 30_000,
      });
      const verification = requireObject(body.verification, "Browser action verification");
      const receipt = requireObject(body.receipt, "Browser action receipt");
      if (body.ok !== true || body.taskId !== fixture.taskId || body.currentUrl !== fixture.url
        || verification.passed !== true || receipt.kind !== "browserVerificationPassed"
        || receipt.taskId !== fixture.taskId) {
        throw new Error("Browser action did not complete its exact owned-page text verification");
      }
      const safeObservation = await apiJson(connection, "POST", "/browser/action", {
        action: "observe",
        taskId: fixture.taskId,
        browserTabId: fixture.browserTabId,
        maxPayloadBytes: 3_000,
      });
      if (safeObservation.ok !== true || safeObservation.status !== "observed") {
        throw new Error("Browser action did not establish the safe-page prompt-guard baseline");
      }
      const navigation = await apiJson(connection, "POST", "/browser/action", {
        action: "navigate",
        taskId: fixture.taskId,
        browserTabId: fixture.browserTabId,
        url: fixture.promptGuardUrl,
        timeoutMs: 30_000,
      });
      if (navigation.ok !== true || navigation.status !== "applied"
        || navigation.currentUrl !== fixture.promptGuardUrl) {
        throw new Error("Browser prompt-guard fixture navigation did not apply from a classified safe page");
      }
      const hostileFixture = { ...fixture, url: fixture.promptGuardUrl };
      const hostileSettle = await apiJson(
        connection,
        "GET",
        debugApiBrowserSettleRequestPath("/browser/settle", hostileFixture),
      );
      verifyDebugApiBrowserSettleJson("/browser/settle", hostileSettle, hostileFixture);
      const hostileObservation = await apiJson(connection, "POST", "/browser/action", {
        action: "observe",
        taskId: fixture.taskId,
        browserTabId: fixture.browserTabId,
        maxPayloadBytes: 6_000,
      });
      const observation = requireObject(hostileObservation.observation, "Browser prompt-guard observation");
      const target = requireObjectArray(observation.refs, "Browser prompt-guard refs")
        .find((candidate) => candidate.testId === "do-not-tell-the-user");
      const targetRefId = requiredString(target?.refId, "Browser prompt-guard target refId");
      const blocked = await apiJson(connection, "POST", "/browser/action", {
        action: "clickRef",
        taskId: fixture.taskId,
        browserTabId: fixture.browserTabId,
        refId: targetRefId,
        timeoutMs: 30_000,
      });
      const blockedReceipt = requireObject(blocked.receipt, "Browser prompt-guard blocked receipt");
      const evidence = requireObject(blockedReceipt.evidence, "Browser prompt-guard blocked evidence");
      const channels = requireStringArray(evidence.channelIds, "Browser prompt-guard channels");
      for (const channel of ["visibleText", "hiddenContent", "accessibility", "domAttribute", "toolResult"]) {
        if (!channels.includes(channel)) throw new Error(`Browser prompt guard omitted ${channel} evidence`);
      }
      const serializedReceipt = JSON.stringify(blockedReceipt);
      if (blocked.ok !== false || blocked.status !== "blocked"
        || blocked.requiredApproval !== "promptInjectionReview"
        || blockedReceipt.kind !== "browserPromptInjectionBlocked"
        || evidence.inboundContentVerdict !== "block" || evidence.proposedActionVerdict !== "block"
        || evidence.rawPageContentRetained !== false || evidence.rawActionArgumentsRetained !== false
        || serializedReceipt.includes("SHELLX_PROMPT_GUARD_PRIVATE_8D7C2A")
        || serializedReceipt.includes("send credentials")) {
        throw new Error("Browser prompt guard did not return its bounded pre-effect block contract");
      }
    } else if (assignment.surface.name === "POST /browser/cdp/execute") {
      const body = await apiJson(connection, "POST", "/browser/cdp/execute", {
        taskId: fixture.taskId,
        browserTabId: fixture.browserTabId,
        method: "Runtime.evaluate",
        expression: "document.title",
        reason: "Final release proof that CDP remains operator-gated",
      });
      const receipt = requireObject(body.receipt, "Browser CDP denial receipt");
      const result = requireObject(body.result, "Browser CDP denial result");
      if (body.ok !== false || body.status !== "blocked" || body.method !== "Runtime.evaluate"
        || body.taskId !== fixture.taskId || body.browserTabId !== fixture.browserTabId
        || body.currentUrl !== fixture.url || body.requiredApproval !== "browserDeveloperModeApproval"
        || body.resultRedacted !== false || body.durationMs !== 0 || result.blocked !== true
        || receipt.kind !== "browserCdpAccessRequested" || receipt.taskId !== fixture.taskId) {
        throw new Error("Browser CDP executor did not return its exact operator-approval denial contract");
      }
    } else if (assignment.surface.name === "POST /browser/task/finish") {
      const body = await apiJson(connection, "POST", "/browser/task/finish", {
        taskId: fixture.taskId,
        status: "completed",
        reason: "releaseSurfaceLifecycleProof",
        requestedBy: "shellx-release-driver",
      });
      if (body.taskId !== fixture.taskId || body.status !== "completed") {
        throw new Error("Browser task finish returned the wrong owned terminal task state");
      }
    } else if (assignment.surface.name === "POST /browser/task/control") {
      const body = await apiJson(connection, "POST", "/browser/task/control", {
        taskId: fixture.taskId,
        action: "pause",
        reason: "releaseSurfaceLifecycleProof",
        requestedBy: "shellx-release-driver",
      });
      const task = requireObject(body.task, "Browser task control task");
      if (body.ok !== true || body.action !== "pause" || body.status !== "paused"
        || task.taskId !== fixture.taskId || task.status !== "paused") {
        throw new Error("Browser task control returned the wrong owned paused task state");
      }
    } else if (assignment.surface.name === "POST /browser/tabs/close") {
      const body = await apiJson(connection, "POST", "/browser/tabs/close", {
        browserTabId: fixture.browserTabId,
      });
      const tab = requireObject(body.tab, "Browser tab close tab");
      if (body.ok !== true || tab.browserTabId !== fixture.browserTabId || tab.status !== "closed") {
        throw new Error("Browser tab close returned the wrong owned tab state");
      }
    } else if (assignment.surface.name === "POST /browser/tabs/lock") {
      const body = await apiJson(connection, "POST", "/browser/tabs/lock", {
        browserTabId: fixture.browserTabId,
        ownerAgentId,
        ownerRunId,
        ttlSeconds: 30,
        scope: "exclusive",
      });
      const tab = requireObject(body.tab, "Browser tab lock tab");
      const lock = requireObject(tab.lock, "Browser tab lock");
      leaseId = requiredString(lock.leaseId, "Browser tab lock leaseId");
      if (body.ok !== true || tab.browserTabId !== fixture.browserTabId
        || lock.ownerAgentId !== ownerAgentId || lock.ownerRunId !== ownerRunId
        || lock.scope !== "exclusive") {
        throw new Error("Browser tab lock returned the wrong exact owned lease");
      }
    } else if (assignment.surface.name === "POST /browser/tabs/heartbeat") {
      const body = await apiJson(connection, "POST", "/browser/tabs/heartbeat", {
        browserTabId: fixture.browserTabId,
        leaseId,
        ownerAgentId,
        ownerRunId,
        ttlSeconds: 30,
      });
      const tab = requireObject(body.tab, "Browser tab heartbeat tab");
      const lock = requireObject(tab.lock, "Browser tab heartbeat lock");
      if (body.ok !== true || tab.browserTabId !== fixture.browserTabId || lock.leaseId !== leaseId
        || lock.ownerAgentId !== ownerAgentId || lock.ownerRunId !== ownerRunId
        || !Number.isFinite(lock.heartbeatAtMs) || !Number.isFinite(lock.expiresAtMs)
        || Number(lock.expiresAtMs) - Number(lock.heartbeatAtMs) !== 30_000) {
        throw new Error("Browser tab heartbeat did not refresh the exact owned lease to its requested TTL");
      }
    } else if (assignment.surface.name === "POST /browser/tabs/unlock") {
      const body = await apiJson(connection, "POST", "/browser/tabs/unlock", {
        browserTabId: fixture.browserTabId,
        leaseId,
        ownerAgentId,
        ownerRunId,
        force: false,
      });
      const tab = requireObject(body.tab, "Browser tab unlock tab");
      if (body.ok !== true || tab.browserTabId !== fixture.browserTabId || tab.lock !== null) {
        throw new Error("Browser tab unlock did not remove the exact owned lease");
      }
      leaseId = null;
    } else if (assignment.surface.name === "POST /browser/tabs/open") {
      const body = await apiJson(connection, "POST", "/browser/tabs/open", {
        taskId: fixture.taskId,
        profileId: "task-disposable",
        url: fixture.url,
        expectedDomains: ["127.0.0.1"],
      });
      const tab = requireObject(body.tab, "Browser tab open tab");
      secondaryTabId = requiredString(tab.browserTabId, "Browser tab open id");
      if (body.ok !== true || tab.taskId !== fixture.taskId || tab.profileId !== "task-disposable"
        || secondaryTabId === fixture.browserTabId) {
        throw new Error("Browser tab open did not create one exact additional owned tab");
      }
    } else if (assignment.surface.name === "POST /browser/tabs/focus") {
      const body = await apiJson(connection, "POST", "/browser/tabs/focus", {
        browserTabId: fixture.browserTabId,
      });
      const tab = requireObject(body.tab, "Browser tab focus tab");
      if (body.ok !== true || tab.browserTabId !== fixture.browserTabId) {
        throw new Error("Browser tab focus did not select the exact original owned tab");
      }
    } else if (assignment.surface.name === "POST /browser/tabs/reorder") {
      if (!secondaryTabId) throw new Error("Browser tab reorder is missing its secondary owned tab");
      const body = await apiJson(connection, "POST", "/browser/tabs/reorder", {
        browserTabIds: [secondaryTabId, fixture.browserTabId],
      });
      const tabs = requireObjectArray(body.tabs, "Browser tab reorder response");
      if (body.ok !== true || tabs[0]?.browserTabId !== secondaryTabId
        || tabs[1]?.browserTabId !== fixture.browserTabId) {
        throw new Error("Browser tab reorder response did not put the two exact owned tabs first");
      }
    }
    outcome.invoke = "pass";
    const state = await apiJson(connection, "GET", "/browser/state");
    const tasks = requireObjectArray(state.tasks, "Browser lifecycle tasks");
    const tabs = requireObjectArray(state.tabs, "Browser lifecycle tabs");
    const task = tasks.find((candidate) => candidate.taskId === fixture!.taskId);
    const tab = tabs.find((candidate) => candidate.browserTabId === fixture!.browserTabId);
    const secondaryTab = secondaryTabId
      ? tabs.find((candidate) => candidate.browserTabId === secondaryTabId)
      : null;
    const expectedStatus = assignment.surface.name === "POST /browser/task/finish"
      ? "completed"
      : assignment.surface.name === "POST /browser/task/control" ? "paused"
        : assignment.surface.name === "POST /browser/tabs/close" ? "aborted" : "running";
    const expectsTab = assignment.surface.name !== "POST /browser/tabs/close";
    const expectsLock = assignment.surface.name === "POST /browser/tabs/lock"
      || assignment.surface.name === "POST /browser/tabs/heartbeat";
    const expectedActiveTabId = assignment.surface.name === "POST /browser/tabs/focus"
      ? fixture.browserTabId
      : assignment.surface.name === "POST /browser/tabs/open" ? secondaryTabId : null;
    if (!task || task.status !== expectedStatus
      || (assignment.surface.name === "POST /browser/tabs/close" && task.statusReason !== "lastTabClosed")
      || Boolean(tab) !== expectsTab
      || (expectsTab && Boolean(tab?.lock) !== expectsLock)
      || (secondaryTabId && !secondaryTab)
      || (expectedActiveTabId && state.activeBrowserTabId !== expectedActiveTabId)
      || (assignment.surface.name === "POST /browser/tabs/reorder"
        && tabs.findIndex((candidate) => candidate.browserTabId === secondaryTabId)
          >= tabs.findIndex((candidate) => candidate.browserTabId === fixture!.browserTabId))) {
      throw new Error("Browser lifecycle state omitted the exact owned task or tab transition");
    }
    outcome.effect = "pass";
    outcome.observedEffect = assignment.surface.name === "POST /browser/cdp/execute"
      ? "POST /browser/cdp/execute returned the exact browserDeveloperModeApproval denial and receipt for an owned loopback task without evaluating the requested expression; task, tab, and URL identities end with candidate teardown."
      : assignment.surface.name === "POST /browser/action"
        ? "POST /browser/action verified a benign owned page, then blocked an exact hostile visible/hidden/accessibility/DOM/tool-target fixture before its click with bounded redacted prompt-guard evidence; task, tab, and URLs end with candidate teardown."
      : `${assignment.surface.name} completed its exact owned Browser task/tab transition against a loopback-only page; task, tab, and URL identities were not retained.`;
  } catch (error) {
    outcome.error = error instanceof Error ? error.message : String(error);
  } finally {
    if (fixture) {
      let unlockCleanupError: string | null = null;
      let secondaryTabCleanupError: string | null = null;
      if (leaseId) {
        try {
          await apiJson(connection, "POST", "/browser/tabs/unlock", {
            browserTabId: fixture.browserTabId,
            leaseId,
            ownerAgentId,
            ownerRunId,
            force: false,
          });
          leaseId = null;
        } catch (error) {
          unlockCleanupError = error instanceof Error ? error.message : String(error);
        }
      }
      if (secondaryTabId) {
        try {
          const closed = await apiJson(connection, "POST", "/browser/tabs/close", {
            browserTabId: secondaryTabId,
          });
          if (closed.ok !== true || requireObject(closed.tab, "secondary tab cleanup").browserTabId !== secondaryTabId) {
            throw new Error("secondary Browser tab cleanup returned the wrong tab");
          }
          secondaryTabId = null;
        } catch (error) {
          secondaryTabCleanupError = error instanceof Error ? error.message : String(error);
        }
      }
      const cleanupError = await cleanupDebugApiBrowserSettleFixture(connection, fixture);
      const cleanupDetail = [
        unlockCleanupError ? `unlock: ${unlockCleanupError}` : null,
        secondaryTabCleanupError ? `secondary tab: ${secondaryTabCleanupError}` : null,
        cleanupError,
      ]
        .filter((value): value is string => Boolean(value))
        .join(" | ");
      if (cleanupDetail) {
        outcome.error = outcome.error ? `${outcome.error}; cleanup: ${cleanupDetail}` : `cleanup: ${cleanupDetail}`;
      } else {
        outcome.cleanup = "pass";
      }
    }
  }
  return outcome;
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
    signal: AbortSignal.timeout(30_000),
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

function requireStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`${label} did not return a string array`);
  }
  return value;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value;
}
