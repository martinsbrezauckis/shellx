import { createServer } from "node:http";
import type { AddressInfo, Socket } from "node:net";

import { resolveShellxDebugApiConnection } from "./shellx-debug-paths";

type JsonObject = Record<string, unknown>;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`FAIL: ${message}`);
  console.log(`  ok ${message}`);
}

async function requestJson(
  connection: { base: string; token: string },
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<{ status: number; body: JsonObject }> {
  const response = await fetch(`${connection.base}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${connection.token}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await response.text();
  let parsed: unknown = {};
  if (text.trim()) {
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`${method} ${path} returned non-JSON status ${response.status}: ${text.slice(0, 500)}`);
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${method} ${path} returned an invalid JSON object`);
  }
  return { status: response.status, body: parsed as JsonObject };
}

async function startRenderedFixture(): Promise<{
  url: string;
  requestCount: () => number;
  close: () => Promise<void>;
}> {
  const sockets = new Set<Socket>();
  let requests = 0;
  const server = createServer((_request, response) => {
    requests += 1;
    response.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    });
    response.end(`<!doctype html>
<html>
  <head><meta charset="utf-8"><title>ShellX Render Check</title></head>
  <body>
    <main><h1>ShellX rendered fixture</h1><div id="ready">Pending</div></main>
    <script>
      setTimeout(() => {
        document.getElementById("ready").textContent = "Rendered ready";
      }, 350);
    </script>
  </body>
</html>`);
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}/`,
    requestCount: () => requests,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    },
  };
}

async function main(): Promise<void> {
  console.log("\n=== ShellX Browser hidden rendered-check live smoke ===");
  const connection = await resolveShellxDebugApiConnection({ probePath: "/browser/summary", timeoutMs: 2_000 });
  const fixture = await startRenderedFixture();
  const querySecret = "shellx-rendered-check-query-secret";

  try {
    const health = await requestJson(connection, "GET", "/health");
    assert(health.status === 200, "Debug API health responds");
    assert(health.body.browserProtocolVersion === "1.5.0", "Browser protocol 1.5.0 is active");
    assert(
      Array.isArray(health.body.browserFeatureFlags)
        && health.body.browserFeatureFlags.includes("hiddenRenderedCheck"),
      "hidden rendered-check capability is advertised",
    );

    const before = await requestJson(connection, "GET", "/browser/summary");
    assert(before.status === 200 && before.body.revisions !== null, "baseline Browser revisions are available");

    const target = new URL(fixture.url);
    target.searchParams.set("secret", querySecret);
    const result = await requestJson(connection, "POST", "/browser/rendered-check", {
      url: target.toString(),
      expectText: "Rendered ready",
      titleIncludes: "ShellX Render Check",
      selector: "#ready",
      timeoutMs: 10_000,
      settleMs: 50,
      expectedDomains: ["127.0.0.1"],
    });
    const evidence = result.body.evidence as JsonObject;
    const effects = result.body.effects as JsonObject;
    assert(fixture.requestCount() > 0, "offscreen renderer requests the fixture page");
    assert(
      result.status === 200,
      `rendered-check route succeeds; status=${result.status} body=${JSON.stringify(result.body).slice(0, 1_500)}`,
    );
    assert(
      result.body.schema === "shellx/browser-rendered-check@1"
        && result.body.ok === true
        && result.body.status === "passed",
      `rendered JavaScript expectations pass; body=${JSON.stringify(result.body).slice(0, 1_500)}`,
    );
    assert(
      evidence.textMatched === true
        && evidence.titleMatched === true
        && evidence.selectorMatched === true
        && evidence.selectorCount === 1,
      "response contains bounded match and selector-count evidence",
    );
    assert(!JSON.stringify(result.body).includes(querySecret), "response does not return URL query data");
    assert(
      effects.visibleWindowOpened === false
        && effects.browserTaskCreated === false
        && effects.browserTabCreated === false
        && effects.receiptEmitted === false,
      "rendered check leaves the visible cowork surface untouched",
    );
    assert(
      effects.hiddenRendererCreated === true
        && effects.hiddenRendererDestroyed === true
        && effects.profilePersisted === false,
      "InPrivate renderer is destroyed without profile persistence",
    );

    const after = await requestJson(connection, "GET", "/browser/summary");
    assert(
      JSON.stringify(after.body.revisions) === JSON.stringify(before.body.revisions),
      "hidden rendered check leaves Browser registry revisions unchanged",
    );

    const rejected = await requestJson(connection, "POST", "/browser/rendered-check", {
      url: fixture.url,
      expectText: "Rendered ready",
    });
    const rejectedError = rejected.body.error as JsonObject;
    assert(
      rejected.status === 400 && rejectedError.code === "browser_rendered_check_invalid",
      "private targets require an explicit expectedDomains scope",
    );
  } finally {
    await fixture.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
