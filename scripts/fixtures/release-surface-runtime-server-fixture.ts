import { createServer, type IncomingMessage } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const token = readFileSync(requiredArg(args, "--token-file"), "utf8").trim();
const statePath = requiredArg(args, "--state-out");
const instanceId = requiredArg(args, "--instance-id");
const requestedProcessId = requiredArg(args, "--process-id");
const processId = requestedProcessId === "self" ? process.pid : Number(requestedProcessId);
if (!Number.isSafeInteger(processId) || processId <= 0) throw new Error("--process-id must be self or a positive integer");
const version = requiredArg(args, "--version");
const sourceCommit = requiredArg(args, "--source-commit");
let flightTaskId = "fixture-flight-task-private";
let flightTabId = "fixture-flight-tab-private";
let flightTaskStartCount = 0;
let flightTaskActive = false;
let flightTabOpen = false;
let flightExportCount = 0;
let coordinateClicked = false;
let coordinateInputValue = "";
let workflowBookmarkActive = false;
let dialogArmed = false;
let ownedDialogActive = false;
let siteDataSeeded = false;

const server = createServer(async (request, response) => {
  if (request.headers.authorization !== `Bearer ${token}`) {
    response.writeHead(401).end();
    return;
  }
  const address = server.address();
  if (!address || typeof address === "string") {
    response.writeHead(503).end();
    return;
  }
  if (request.url === "/browser/state") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      profiles: [{ profileId: "release-fixture", name: "Release fixture", isolation: "disposable" }],
      tabs: [{
        browserTabId: "fixture-browser-tab-0001",
        engineId: "fixture-engine-0001",
        status: "ready",
        taskId: "fixture-browser-task-0001",
        lock: { owner: "fixture-browser-task-0001", mode: "exclusive" },
      }, ...(flightTabOpen ? [{
        browserTabId: flightTabId,
        engineId: "fixture-flight-engine-private",
        status: "ready",
        taskId: flightTaskId,
        lock: null,
      }] : [])],
      tasks: [
        { taskId: "fixture-browser-task-0001", status: "ready" },
        ...(flightTaskActive ? [{ taskId: flightTaskId, status: "running" }] : []),
      ],
      windowOpen: false,
      engine: { mounted: false, status: "idle" },
    }));
    return;
  }
  if (request.url === "/browser/tabs") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      tabs: [{
        browserTabId: "fixture-browser-tab-0001",
        engineId: "fixture-engine-0001",
        status: "ready",
        taskId: "fixture-browser-task-0001",
        lock: { owner: "fixture-browser-task-0001", mode: "exclusive" },
      }],
    }));
    return;
  }
  if (request.url?.startsWith("/browser/check?")) {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      schema: "shellx/browser-quiet-check@1",
      ok: true,
      mode: "quiet",
      effects: {
        uiMutation: false,
        windowOpened: false,
        taskCreated: false,
        engineMounted: false,
        receiptEmitted: false,
      },
      summary: { activeTab: null, activeTask: null },
      settle: { settled: true, tabStatus: "idle", engineLoadStatus: "idle" },
    }));
    return;
  }
  if (request.url?.startsWith("/browser/dialogs?")) {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      dialogs: [{
        dialogId: "fixture-dialog-0001",
        taskId: "fixture-browser-task-0001",
        browserTabId: "fixture-browser-tab-0001",
        dialogType: "beforeunload",
        text: "Synthetic release fixture dialog",
        status: "pending",
        requiresApproval: true,
        promptValueProvided: false,
        createdAtMs: 1_795_891_200_000,
        resolvedAtMs: null,
        receipt: { receiptId: "fixture-dialog-receipt-0001" },
      }, ...(ownedDialogActive ? [{
        dialogId: "fixture-owned-beforeunload-private",
        taskId: flightTaskId,
        browserTabId: flightTabId,
        dialogType: "beforeunload",
        text: "fixture-private-beforeunload-text",
        status: "pending",
        requiresApproval: true,
        promptValueProvided: false,
        createdAtMs: 1_795_891_200_001,
        resolvedAtMs: null,
        receipt: { receiptId: "fixture-owned-dialog-receipt-private" },
      }] : [])],
    }));
    return;
  }
  if (request.url === "/browser/bookmarks" && request.method === "GET") {
    return json(response, 200, {
      bookmarks: [{
        bookmarkId: "fixture-workflow-bookmark-private",
        label: "Synthetic release workflow",
        url: "https://fixture.invalid/private-workflow",
        category: "workflow",
        agentWorkflow: {
          siteKey: "fixture.invalid",
          taskType: "login",
          target: "release-fixture",
          surface: "account",
          aliases: ["fixture-alias-private"],
          permissionsNeeded: ["browser.navigate"],
          secretKinds: ["password"],
          recipeId: "fixture-recipe-private",
          recipePath: "/fixture/private/workflow.json",
          goal: "fixture-private-workflow-goal",
          steps: [{ action: "navigate", url: "https://fixture.invalid/private-workflow" }],
          health: "healthy",
          driftStatus: "current",
        },
      }],
    });
  }
  if (request.url === "/browser/rendered-check" && request.method === "POST") {
    const body = await readJsonBody(request);
    const target = typeof body.url === "string" ? new URL(body.url) : null;
    if (!target || target.protocol !== "http:" || target.hostname !== "127.0.0.1" || !target.port) {
      return json(response, 400, { error: "rendered-check fixture requires an owned loopback target" });
    }
    const rendered = await fetch(target, { signal: AbortSignal.timeout(5_000) });
    const renderedText = rendered.ok ? await rendered.text() : "";
    if (!renderedText.includes("Flight Recorder baseline ready")) {
      return json(response, 500, { error: "rendered-check fixture target was not served while the CLI was active" });
    }
    return json(response, 200, {
      schema: "shellx/browser-rendered-check@1",
      ok: true,
      status: "passed",
      evidence: {
        textMatched: true,
        titleMatched: true,
        selectorMatched: true,
        selectorCount: 1,
        finalUrl: "http://127.0.0.1/flight-recorder",
      },
      effects: {
        visibleWindowOpened: false,
        browserTaskCreated: false,
        browserTabCreated: false,
        receiptEmitted: false,
        hiddenRendererCreated: true,
        hiddenRendererDestroyed: true,
        profilePersisted: false,
      },
    });
  }
  if (request.url === "/browser/task/start" && request.method === "POST") {
    await readJsonBody(request);
    if (flightTaskStartCount > 0) {
      flightTaskId = `fixture-flight-task-${flightTaskStartCount}-private`;
      flightTabId = `fixture-flight-tab-${flightTaskStartCount}-private`;
    }
    flightTaskStartCount += 1;
    flightTaskActive = true;
    flightTabOpen = true;
    coordinateClicked = false;
    coordinateInputValue = "";
    dialogArmed = false;
    ownedDialogActive = false;
    siteDataSeeded = false;
    return json(response, 200, {
      taskId: flightTaskId,
      browserTabId: flightTabId,
      ownerSessionId: "fixture-owner-private",
      status: "running",
    });
  }
  if (request.url?.startsWith("/browser/settle?") && request.method === "GET") {
    return json(response, 200, { settled: true, taskId: flightTaskId, browserTabId: flightTabId });
  }
  if (request.url === "/browser/action" && request.method === "POST") {
    const body = await readJsonBody(request);
    const action = String(body.action ?? "");
    if (action === "clickAt" && body.x === 100 && body.y === 62) coordinateClicked = true;
    if (action === "clickRef" && body.selector === "#arm-dialog") dialogArmed = true;
    if (action === "clickRef" && body.selector === "#seed-site-data") siteDataSeeded = true;
    if (action === "clearSiteData") siteDataSeeded = false;
    if (action === "typeText" && body.x === 100 && body.y === 140) {
      coordinateInputValue = String(body.value ?? "");
    }
    const coordinateWaitFailed = action === "waitFor"
      && body.value === "Coordinate click ready"
      && !coordinateClicked;
    const beforeunloadBlocked = action === "navigate"
      && String(body.url ?? "").includes("dialog-target=1")
      && dialogArmed;
    if (beforeunloadBlocked) ownedDialogActive = true;
    const siteDataWaitFailed = action === "waitFor"
      && ((body.value === "Site data still seeded" && !siteDataSeeded)
        || (body.value === "Site data cleared" && siteDataSeeded));
    return json(response, 200, {
      ok: !coordinateWaitFailed && !beforeunloadBlocked && !siteDataWaitFailed,
      status: coordinateWaitFailed || siteDataWaitFailed ? "notFound" : beforeunloadBlocked ? "approvalRequired" : "applied",
      ...(action === "clearSiteData" ? { message: "site application data recovery applied: fixture origin storage cleared" } : {}),
      taskId: flightTaskId,
      browserTabId: flightTabId,
      ...(action === "navigate" ? { currentUrl: body.url } : {}),
      ...(action === "observe" ? {
        observation: {
          url: "http://127.0.0.1/fixture-private-page",
          refs: [{ refId: "fixture-private-button-ref", selector: "#advance" }],
          formFields: [
            { refId: "fixture-private-input-ref", selector: "#name", value: "" },
            { refId: "fixture-private-coordinate-input-ref", selector: "#coordinate-input", value: coordinateInputValue },
          ],
        },
      } : {}),
      ...(action === "extractText" ? { extractedText: "Action target ready — fixture-private-page-text" } : {}),
      ...(action === "verify" ? { verification: { passed: true, key: body.key } } : {}),
      ...(action === "captureScreenshot" ? {
        screenshot: {
          path: "/fixture/private/screenshot.png",
          bytes: 2_048,
          sha256: "e".repeat(64),
          width: 800,
          height: 600,
          source: "fixture-private-screenshot-source",
        },
        receipt: { kind: "browserScreenshotCaptured", receiptId: "fixture-screenshot-receipt-private" },
      } : {}),
    });
  }
  if (request.url === "/browser/trace/export" && request.method === "POST") {
    await readJsonBody(request);
    return json(response, 200, {
      traceId: "browser-trace-fixture-private",
      taskId: flightTaskId,
      browserTabId: flightTabId,
      path: "/fixture/private/trace.json",
      bytes: 4_096,
      sha256: "f".repeat(64),
      source: "fixture-private-trace-source",
      createdAtMs: 1_795_891_200_000,
      receipt: { kind: "browserTraceBundleExported", receiptId: "fixture-trace-receipt-private" },
    });
  }
  if (request.url === "/browser/dialogs/resolve" && request.method === "POST") {
    const body = await readJsonBody(request);
    if (!ownedDialogActive || body.dialogId !== "fixture-owned-beforeunload-private"
      || body.taskId !== flightTaskId || body.action !== "dismiss") {
      return json(response, 409, { ok: false, error: "fixture owned dialog mismatch" });
    }
    ownedDialogActive = false;
    return json(response, 200, {
      dialogId: "fixture-owned-beforeunload-private",
      taskId: flightTaskId,
      browserTabId: flightTabId,
      dialogType: "beforeunload",
      text: "fixture-private-beforeunload-text",
      status: "dismissed",
      requiresApproval: true,
      promptValueProvided: false,
      createdAtMs: 1_795_891_200_001,
      resolvedAtMs: 1_795_891_200_002,
      receipt: { kind: "browserDialogResolved", receiptId: "fixture-dialog-resolved-receipt-private" },
    });
  }
  if (request.url === "/browser/recipes/export" && request.method === "POST") {
    await readJsonBody(request);
    return json(response, 200, {
      recipeId: "fixture-workflow-recipe-private",
      taskId: flightTaskId,
      browserTabId: flightTabId,
      path: "/fixture/private/workflow-recipe.json",
      bytes: 5_120,
      sha256: "9".repeat(64),
      steps: 4,
      source: "fixture-private-recipe-source",
      createdAtMs: 1_795_891_200_000,
      receipt: { kind: "browserRecipeExported", receiptId: "fixture-recipe-receipt-private" },
    });
  }
  if (request.url === "/browser/bookmarks" && request.method === "POST") {
    await readJsonBody(request);
    workflowBookmarkActive = true;
    return json(response, 200, {
      ok: true,
      bookmark: {
        bookmarkId: "fixture-saved-workflow-bookmark-private",
        label: "fixture-private-workflow-label",
        kind: "link",
      },
      receipt: { kind: "browserBookmarkSaved", receiptId: "fixture-bookmark-receipt-private" },
    });
  }
  if (request.url === "/browser/recipes/replay" && request.method === "POST") {
    await readJsonBody(request);
    return json(response, 200, {
      ok: true,
      status: "dryRunCompleted",
      taskId: flightTaskId,
      browserTabId: flightTabId,
      stepsPlanned: 4,
      stepsApplied: 0,
      stepsSkipped: 0,
      skippedSteps: [],
      stepResults: [],
      decisionPoints: [],
      dryRun: true,
      receipt: { kind: "browserRecipeReplayCompleted", receiptId: "fixture-replay-receipt-private" },
    });
  }
  if (request.url === "/browser/bookmarks/fixture-saved-workflow-bookmark-private" && request.method === "DELETE") {
    if (!workflowBookmarkActive) return json(response, 409, { ok: false, error: "fixture workflow bookmark is not active" });
    workflowBookmarkActive = false;
    return json(response, 200, {
      ok: true,
      receipt: { kind: "browserBookmarkDeleted", receiptId: "fixture-bookmark-delete-receipt-private" },
    });
  }
  if (request.url === "/browser/flight-recorder/export" && request.method === "POST") {
    const body = await readJsonBody(request);
    const index = flightExportCount++;
    return json(response, 200, {
      attemptId: `fixture-attempt-${index}-private`,
      taskId: String(body.taskId ?? flightTaskId),
      browserTabId: flightTabId,
      path: `/fixture/private/attempt-${index}.json`,
      bytes: 512 + index,
      sha256: (index === 0 ? "a" : "b").repeat(64),
      events: 2 + index,
      receipts: 1 + index,
      evidenceComplete: true,
    });
  }
  if (request.url === "/browser/evaluations" && request.method === "POST") {
    const body = await readJsonBody(request);
    const attempts = Array.isArray(body.attempts) ? body.attempts : [];
    const attemptTaskIds = new Set(attempts.map((attempt) => (
      attempt && typeof attempt === "object" ? String((attempt as Record<string, unknown>).taskId ?? "") : ""
    )));
    if (attempts.length > 1 && attemptTaskIds.size !== attempts.length) {
      return json(response, 400, { error: "browser evaluation requires a distinct Browser task per attempt" });
    }
    return json(response, 200, {
      reportId: "fixture-evaluation-report-private",
      path: "/fixture/private/evaluation.json",
      bytes: 1024,
      sha256: "c".repeat(64),
      evidenceDigest: "d".repeat(64),
      evidenceComplete: attempts.length === 2,
      attempts: attempts.length,
      improvementRating: "candidate-better",
    });
  }
  if (request.url === "/browser/task/finish" && request.method === "POST") {
    const body = await readJsonBody(request);
    flightTaskActive = false;
    return json(response, 200, { ok: true, taskId: String(body.taskId ?? flightTaskId), status: "aborted" });
  }
  if (request.url === "/browser/tabs/close" && request.method === "POST") {
    const body = await readJsonBody(request);
    flightTabOpen = false;
    return json(response, 200, { ok: true, browserTabId: String(body.browserTabId ?? flightTabId) });
  }
  if (request.url === "/browser/tabs/unlock" && request.method === "POST") {
    const body = await readJsonBody(request);
    return json(response, 200, { ok: true, browserTabId: String(body.browserTabId ?? flightTabId) });
  }
  if (request.url === "/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      ok: true,
      processId,
      instanceId,
      appVersion: version,
      buildCommit: sourceCommit,
      debugApiVersion: "1.2.0",
      debugApiPort: address.port,
    }));
    return;
  }
  response.writeHead(404).end();
});

server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture server has no TCP address");
  writeFileSync(statePath, `${JSON.stringify({ port: address.port, processId })}\n`, { encoding: "utf8", flag: "wx" });
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => server.close(() => process.exit(0)));
}

function requiredArg(values: string[], name: string): string {
  const index = values.indexOf(name);
  const value = index >= 0 ? values[index + 1] : values.find((entry) => entry.startsWith(`${name}=`))?.slice(name.length + 1);
  if (!value?.trim()) throw new Error(`${name} is required`);
  return value;
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return {};
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("fixture request body must be an object");
  return value as Record<string, unknown>;
}

function json(response: import("node:http").ServerResponse, status: number, body: Record<string, unknown>): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}
