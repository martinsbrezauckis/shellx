import { createServer, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { cleanupOwnedBrowserLifecycle } from "./shellx-browser-test-cleanup";
import { resolveShellxDebugApiConnection } from "./shellx-debug-paths";

interface BrowserTask {
  taskId: string;
}

interface BrowserState {
  tabs?: Array<{ browserTabId: string; taskId?: string | null }>;
}

interface BrowserRef {
  refId: string;
  label?: string | null;
  selector?: string | null;
  fingerprint?: string | null;
  domPath?: string | null;
  frameUrl?: string | null;
  frameId?: string | null;
  shadowPath?: string[];
  bounds?: { x: number; y: number; width: number; height: number } | null;
}

interface BrowserActionResponse {
  ok: boolean;
  status: string;
  extractedText?: string | null;
  observation?: {
    snapshotId?: string;
    text?: string;
    domSummary?: {
      sameOriginFrames?: number;
      crossOriginFrames?: number;
      openShadowRoots?: number;
      traversalTruncated?: boolean;
    };
    delta?: {
      fromSnapshotId: string;
      changed: boolean;
      addedRefCount: number;
      removedRefCount: number;
      updatedRefCount: number;
      addedRefIds: string[];
      removedRefIds: string[];
      updatedRefIds: string[];
      truncated: boolean;
    };
    refs?: BrowserRef[];
  };
  actionability?: {
    stable?: boolean;
    stabilityMs?: number;
    stabilitySamples?: number;
    fingerprintMatches?: boolean | null;
    failedChecks?: string[];
  };
  stepSummary?: { failedChecks?: string[]; recoveryHints?: string[] };
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`FAIL: ${message}`);
  console.log(`  PASS ${message}`);
}

async function api<T>(
  connection: { base: string; token: string },
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const response = await fetch(`${connection.base}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${connection.token}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path} failed (${response.status}): ${text}`);
  return (text ? JSON.parse(text) : {}) as T;
}

async function waitFor<T>(label: string, check: () => Promise<T | null>, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value !== null) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 180));
  }
  throw new Error(`${label} timed out${lastError instanceof Error ? `: ${lastError.message}` : ""}`);
}

async function startFixture(): Promise<{ url: string; close: () => Promise<void> }> {
  const crossSockets = new Set<Socket>();
  const crossServer = createServer((_, response) => {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    response.end('<!doctype html><title>Cross origin frame</title><button aria-label="Cross origin target">Cross origin target</button>');
  });
  crossServer.on("connection", (socket) => {
    crossSockets.add(socket);
    socket.on("close", () => crossSockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    crossServer.once("error", reject);
    crossServer.listen(0, "127.0.0.1", resolve);
  });
  const crossPort = (crossServer.address() as AddressInfo).port;
  const crossUrl = `http://127.0.0.1:${crossPort}/cross.html`;
  const frameHtml = `<!doctype html>
<html><head><meta charset="utf-8"><title>Same origin frame</title></head>
<body>
  <button id="frame-target" aria-label="Frame target">Frame target</button>
  <input id="frame-input" aria-label="Frame input">
  <script>
    document.getElementById("frame-target").addEventListener("click", () => {
      parent.document.getElementById("result").textContent = "Frame target clicked";
    });
    document.getElementById("frame-input").addEventListener("input", (event) => {
      parent.document.getElementById("result").textContent = "Frame input: " + event.target.value;
    });
  </script>
</body></html>`;
  const html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8"><title>ShellX stable ref fixture</title>
    <style>
      @keyframes move-target { from { transform: translateX(0); } to { transform: translateX(180px); } }
      #moving-target.moving { animation: move-target 550ms linear; }
      #same-frame { display: block; margin: 16px 0 16px 160px; width: 360px; height: 120px; }
      #cross-frame { width: 260px; height: 80px; }
      #shadow-host { display: block; margin: 16px 0; }
    </style>
  </head>
  <body>
    <button id="stable-target" aria-label="Stable target">Stable target</button>
    <button id="stale-target" aria-label="Stale target version one">Stale target v1</button>
    <button id="replace-target">Replace target</button>
    <button id="start-motion">Start motion</button>
    <button id="moving-target" aria-label="Moving target">Moving target</button>
    <div id="table-wrap" tabindex="0" aria-label="Fixture table"><table><tbody><tr><td>Alpha</td><td>Beta</td></tr></tbody></table></div>
    <div id="shadow-host"></div>
    <iframe id="same-frame" src="/frame.html" title="Same origin fixture"></iframe>
    <iframe id="cross-frame" src="${crossUrl}" title="Cross origin fixture"></iframe>
    <output id="result">Waiting</output>
    <script>
      const shadow = document.getElementById("shadow-host").attachShadow({ mode: "open" });
      shadow.innerHTML = '<button>Shadow decoy</button><button>Shadow target</button><input id="shadow-input" aria-label="Shadow input">';
      shadow.querySelectorAll("button")[1].addEventListener("click", () => {
        document.getElementById("result").textContent = "Shadow target clicked";
      });
      shadow.getElementById("shadow-input").addEventListener("input", (event) => {
        document.getElementById("result").textContent = "Shadow input: " + event.target.value;
      });
      document.getElementById("stable-target").addEventListener("click", () => {
        document.getElementById("result").textContent = "Stable target clicked";
      });
      document.getElementById("stale-target").addEventListener("click", () => {
        document.getElementById("result").textContent = "Old target clicked";
      });
      document.getElementById("replace-target").addEventListener("click", () => {
        const replacement = document.createElement("button");
        replacement.id = "stale-target";
        replacement.setAttribute("aria-label", "Stale target version two");
        replacement.textContent = "Stale target v2";
        replacement.addEventListener("click", () => {
          document.getElementById("result").textContent = "Fresh target clicked";
        });
        document.getElementById("stale-target").replaceWith(replacement);
      });
      const movingTarget = document.getElementById("moving-target");
      let motionStartedAt = 0;
      document.getElementById("start-motion").addEventListener("click", () => {
        movingTarget.classList.remove("moving");
        void movingTarget.offsetWidth;
        motionStartedAt = performance.now();
        movingTarget.classList.add("moving");
      });
      movingTarget.addEventListener("animationend", () => {
        movingTarget.classList.remove("moving");
      });
      movingTarget.addEventListener("click", () => {
        const visuallyMoving = motionStartedAt > 0 && performance.now() - motionStartedAt < 550;
        document.getElementById("result").textContent = visuallyMoving
          ? "Moving target clicked during animation"
          : "Moving target clicked after animation";
      });
    </script>
  </body>
</html>`;
  const sockets = new Set<Socket>();
  const server = createServer((request, response) => {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    response.end(request.url === "/frame.html" ? frameHtml : html);
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/`,
    close: async () => {
      await closeServer(server, sockets);
      await closeServer(crossServer, crossSockets);
    },
  };
}

async function closeServer(server: Server, sockets: Set<Socket>): Promise<void> {
  for (const socket of sockets) socket.destroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function observeReady(
  connection: { base: string; token: string },
  taskId: string,
): Promise<BrowserActionResponse> {
  return await waitFor("Browser stable-ref fixture observation", async () => {
    const result = await api<BrowserActionResponse>(connection, "POST", "/browser/action", {
      taskId,
      action: "observe",
    });
    const refs = result.observation?.refs ?? [];
    return result.status === "applied"
      && refs.some((ref) => ref.selector === "#stale-target")
      && refs.some((ref) => ref.label === "Frame target")
      && refs.some((ref) => ref.label === "Shadow target")
      && (result.observation?.domSummary?.crossOriginFrames ?? 0) >= 1
      ? result
      : null;
  });
}

async function main(): Promise<void> {
  console.log("ShellX Browser native stable-ref smoke");
  const connection = await resolveShellxDebugApiConnection();
  const fixture = await startFixture();
  let ownedTaskId: string | null = null;

  try {
    await api(connection, "POST", "/browser/open", { startUrl: fixture.url });
    const task = await api<BrowserTask>(connection, "POST", "/browser/task/start", {
      goal: "Verify deterministic Browser refs and stale identity rejection",
      startUrl: fixture.url,
      profileId: "agent-work",
      expectedDomains: ["127.0.0.1"],
    });
    ownedTaskId = task.taskId;
    const first = await observeReady(connection, task.taskId);
    const firstStable = first.observation!.refs!.find((ref) => ref.selector === "#stable-target")!;
    const firstStale = first.observation!.refs!.find((ref) => ref.selector === "#stale-target")!;
    const tableWrapper = first.observation!.refs!.find((ref) => ref.selector === "#table-wrap")!;
    const movingTarget = first.observation!.refs!.find((ref) => ref.selector === "#moving-target")!;
    const frameTarget = first.observation!.refs!.find((ref) => ref.label === "Frame target")!;
    const frameInput = first.observation!.refs!.find((ref) => ref.label === "Frame input")!;
    const shadowTarget = first.observation!.refs!.find((ref) => ref.label === "Shadow target")!;
    const shadowInput = first.observation!.refs!.find((ref) => ref.label === "Shadow input")!;
    assert(Boolean(first.observation?.snapshotId), "first observation returns a snapshot id");
    assert(firstStable.refId.startsWith("dom-") && firstStable.fingerprint?.startsWith("fp-"), "observation returns opaque deterministic refs and fingerprints");
    assert(firstStable.domPath?.includes("button#stable-target"), "observation returns a bounded DOM path");
    assert(
      (first.observation?.domSummary?.sameOriginFrames ?? 0) >= 1
        && (first.observation?.domSummary?.openShadowRoots ?? 0) >= 1
        && first.observation?.domSummary?.traversalTruncated === false,
      "observation reports complete same-origin frame and open shadow traversal",
    );
    assert(
      (first.observation?.domSummary?.crossOriginFrames ?? 0) >= 1
        && !first.observation?.refs?.some((ref) => ref.label === "Cross origin target")
        && !first.observation?.text?.includes("Cross origin target"),
      "cross-origin frame is counted but not traversed",
    );
    assert(
      frameTarget.frameId !== "main"
        && frameTarget.frameUrl?.endsWith("/frame.html")
        && frameTarget.domPath?.includes("::frame")
        && (frameTarget.bounds?.x ?? 0) > 150,
      "same-origin frame ref carries scoped identity and top-viewport bounds",
    );
    assert(
      shadowTarget.frameId === "main" && (shadowTarget.shadowPath?.length ?? 0) >= 1,
      "open shadow ref carries its host path",
    );
    const tableExtract = await api<BrowserActionResponse>(connection, "POST", "/browser/action", {
      taskId: task.taskId,
      action: "extractTable",
      refId: tableWrapper.refId,
    });
    assert(tableExtract.status === "applied" && tableExtract.extractedText?.includes("Alpha"), "table extraction validates a container ref separately from its table descendant");

    const second = await observeReady(connection, task.taskId);
    const secondStable = second.observation!.refs!.find((ref) => ref.selector === "#stable-target")!;
    assert(secondStable.refId === firstStable.refId, "unchanged control keeps its ref across observations");
    assert(secondStable.fingerprint === firstStable.fingerprint, "unchanged control keeps its fingerprint across observations");
    assert(second.observation?.snapshotId === first.observation?.snapshotId, "unchanged observation keeps its content-aware snapshot id");
    assert(second.observation?.delta?.fromSnapshotId === first.observation?.snapshotId, "unchanged observation delta links to the prior snapshot");
    assert(second.observation?.delta?.changed === false, "unchanged observation reports changed:false");

    const frameClick = await api<BrowserActionResponse>(connection, "POST", "/browser/action", {
      taskId: task.taskId,
      action: "clickRef",
      refId: frameTarget.refId,
    });
    assert(frameClick.status === "applied", "same-origin frame ref is actionable");
    const frameFill = await api<BrowserActionResponse>(connection, "POST", "/browser/action", {
      taskId: task.taskId,
      action: "fillRef",
      refId: frameInput.refId,
      value: "frame-value",
    });
    assert(frameFill.status === "applied", "same-origin frame input accepts ref-based fill");
    const frameResult = await api<BrowserActionResponse>(connection, "POST", "/browser/action", {
      taskId: task.taskId,
      action: "verify",
      key: "text",
      value: "Frame input: frame-value",
    });
    assert(frameResult.status === "applied", "same-origin frame fill updates the shared visible page state");
    const shadowClick = await api<BrowserActionResponse>(connection, "POST", "/browser/action", {
      taskId: task.taskId,
      action: "clickRef",
      refId: shadowTarget.refId,
    });
    assert(shadowClick.status === "applied", "open shadow ref is actionable");
    const shadowFill = await api<BrowserActionResponse>(connection, "POST", "/browser/action", {
      taskId: task.taskId,
      action: "fillRef",
      refId: shadowInput.refId,
      value: "shadow-value",
    });
    assert(shadowFill.status === "applied", "open shadow input accepts ref-based fill");
    const nestedResult = await api<BrowserActionResponse>(connection, "POST", "/browser/action", {
      taskId: task.taskId,
      action: "verify",
      key: "text",
      value: "Shadow input: shadow-value",
    });
    assert(nestedResult.status === "applied", "nested ref actions update the shared visible page state");

    const replacement = await api<BrowserActionResponse>(connection, "POST", "/browser/action", {
      taskId: task.taskId,
      action: "clickRef",
      selector: "#replace-target",
    });
    assert(replacement.status === "applied", "fixture replaces the observed control");
    const staleVerify = await api<BrowserActionResponse>(connection, "POST", "/browser/action", {
      taskId: task.taskId,
      action: "verify",
      refId: firstStale.refId,
      key: "element",
    });
    assert(staleVerify.status === "staleRef" && staleVerify.ok === false, "verify rejects a changed observed identity");
    const staleClick = await api<BrowserActionResponse>(connection, "POST", "/browser/action", {
      taskId: task.taskId,
      action: "clickRef",
      refId: firstStale.refId,
      force: true,
    });
    assert(staleClick.status === "staleRef" && staleClick.ok === false, "old ref is rejected without acting after identity changes");
    assert(staleClick.actionability?.fingerprintMatches === false, "stale ref returns fingerprint mismatch evidence");
    assert(staleClick.stepSummary?.failedChecks?.includes("fingerprint") === true, "stale ref summary requires re-observation");

    const refreshed = await observeReady(connection, task.taskId);
    const refreshedStale = refreshed.observation!.refs!.find((ref) => ref.selector === "#stale-target")!;
    assert(refreshedStale.refId !== firstStale.refId, "changed semantic identity receives a replacement ref");
    assert(
      refreshed.observation?.delta?.changed === true
        && refreshed.observation.delta.removedRefIds.includes(firstStale.refId)
        && refreshed.observation.delta.addedRefIds.includes(refreshedStale.refId),
      "changed observation reports replacement refs",
    );
    const freshClick = await api<BrowserActionResponse>(connection, "POST", "/browser/action", {
      taskId: task.taskId,
      action: "clickRef",
      refId: refreshedStale.refId,
    });
    assert(freshClick.status === "applied", "replacement ref acts after a fresh observation");
    const startMotion = await api<BrowserActionResponse>(connection, "POST", "/browser/action", {
      taskId: task.taskId,
      action: "clickRef",
      selector: "#start-motion",
    });
    assert(startMotion.status === "applied", "fixture starts a bounded target animation");
    const movingClick = await api<BrowserActionResponse>(connection, "POST", "/browser/action", {
      taskId: task.taskId,
      action: "clickRef",
      refId: movingTarget.refId,
      timeoutMs: 3_000,
    });
    if (
      movingClick.status !== "applied"
      || movingClick.actionability?.stable !== true
      || (movingClick.actionability.stabilityMs ?? 0) < 120
      || (movingClick.actionability.stabilitySamples ?? 0) < 2
    ) {
      console.error("  moving target diagnostics", JSON.stringify({
        ok: movingClick.ok,
        status: movingClick.status,
        actionability: movingClick.actionability,
        stepSummary: movingClick.stepSummary,
      }));
    }
    assert(
      movingClick.status === "applied"
        && movingClick.actionability?.stable === true
        && (movingClick.actionability.stabilityMs ?? 0) >= 120
        && (movingClick.actionability.stabilitySamples ?? 0) >= 2,
      "moving target click waits until animation settles",
    );
    const movingResult = await api<BrowserActionResponse>(connection, "POST", "/browser/action", {
      taskId: task.taskId,
      action: "verify",
      key: "text",
      value: "Moving target clicked after animation",
    });
    assert(movingResult.status === "applied", "moving target is never clicked while animation is active");
  } finally {
    try {
      const current = await api<BrowserState>(connection, "GET", "/browser/state");
      await cleanupOwnedBrowserLifecycle(
        (method, path, body) => api(connection, method, path, body),
        {
          taskIds: ownedTaskId ? [ownedTaskId] : [],
          tabIds: (current.tabs ?? []).filter((tab) => tab.taskId === ownedTaskId).map((tab) => tab.browserTabId),
          label: "stable-refs-live",
        },
      );
    } finally {
      await fixture.close();
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
