import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { Socket } from "node:net";
import type {
  ReleaseSurfaceDriverOutcome,
  ReleaseSurfaceDriverRequest,
} from "../lib/release-surface-driver-protocol";

const TIMEOUT_MS = 30_000;

type DebugApiConnection = { base: string; token: string };
type DriverAssignment = ReleaseSurfaceDriverRequest["assignments"][number];

export async function exerciseDebugApiBrowserRenderedCheckMutation(
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
    observedEffect: "No isolated hidden-renderer result was observed.",
  };
  let fixture: Awaited<ReturnType<typeof startRenderedFixture>> | null = null;
  try {
    if (assignment.surface.name !== "POST /browser/rendered-check") {
      throw new Error(`unsupported hidden-renderer route ${assignment.surface.name}`);
    }
    const before = await apiJson(connection, "GET", "/browser/summary");
    fixture = await startRenderedFixture();
    outcome.present = "pass";
    const queryMarker = `release-rendered-${randomUUID()}`;
    const target = new URL(fixture.url);
    target.searchParams.set("private", queryMarker);
    const result = await apiJson(connection, "POST", "/browser/rendered-check", {
      url: target.toString(),
      expectText: "ShellX rendered release fixture ready",
      titleIncludes: "ShellX release rendered check",
      selector: "#ready",
      timeoutMs: 10_000,
      settleMs: 50,
      expectedDomains: ["127.0.0.1"],
    });
    outcome.invoke = "pass";
    if (JSON.stringify(result).includes(queryMarker)) {
      throw new Error("rendered-check returned private URL query data");
    }
    if (fixture.requestCount() < 1) throw new Error("hidden renderer never requested the owned loopback page");
    if (result.schema !== "shellx/browser-rendered-check@1" || result.ok !== true || result.status !== "passed") {
      throw new Error("rendered-check omitted its passing typed result");
    }
    const evidence = requireObject(result.evidence, "rendered-check evidence");
    if (evidence.textMatched !== true || evidence.titleMatched !== true
      || evidence.selectorMatched !== true || evidence.selectorCount !== 1) {
      throw new Error("rendered-check did not match the exact owned loopback expectations");
    }
    const effects = requireObject(result.effects, "rendered-check effects");
    if (effects.visibleWindowOpened !== false || effects.browserTaskCreated !== false
      || effects.browserTabCreated !== false || effects.receiptEmitted !== false
      || effects.hiddenRendererCreated !== true || effects.hiddenRendererDestroyed !== true
      || effects.profilePersisted !== false) {
      throw new Error("rendered-check did not prove isolated hidden-renderer destruction");
    }
    const after = await apiJson(connection, "GET", "/browser/summary");
    if (stableVisibleSummary(after) !== stableVisibleSummary(before)) {
      throw new Error("rendered-check changed the visible Browser summary");
    }
    outcome.effect = "pass";
    outcome.observedEffect = "POST /browser/rendered-check matched exact text, title, and selector in one isolated loopback hidden renderer, destroyed it, and left the visible Browser projection and counts unchanged; URL and page data were not retained.";
  } catch (error) {
    outcome.error = error instanceof Error ? error.message : String(error);
  } finally {
    if (fixture) {
      try {
        await closeRenderedFixture(fixture.server, fixture.sockets);
        outcome.cleanup = "pass";
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        outcome.error = outcome.error ? `${outcome.error}; cleanup: ${detail}` : `cleanup: ${detail}`;
      }
    }
  }
  return outcome;
}

function stableVisibleSummary(value: unknown): string {
  const summary = requireObject(value, "Browser visible summary");
  return JSON.stringify(Object.fromEntries(
    Object.entries(summary).filter(([key]) => key !== "revisions"),
  ));
}

async function startRenderedFixture(): Promise<{
  url: string;
  requestCount: () => number;
  server: Server;
  sockets: Set<Socket>;
}> {
  const sockets = new Set<Socket>();
  let requests = 0;
  const server = createServer((request, response) => {
    if (request.method !== "GET") {
      response.writeHead(405).end();
      return;
    }
    requests += 1;
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end("<!doctype html><title>ShellX release rendered check</title><main id='ready'>ShellX rendered release fixture ready</main>");
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("rendered-check fixture did not bind");
  return {
    url: `http://127.0.0.1:${address.port}/rendered-check`,
    requestCount: () => requests,
    server,
    sockets,
  };
}

async function closeRenderedFixture(server: Server, sockets: Set<Socket>): Promise<void> {
  for (const socket of sockets) socket.destroy();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
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
  if (!response.ok) throw new Error(`${method} ${path} failed ${response.status}: ${text.slice(0, 1_200)}`);
  return requireObject(text.trim() ? JSON.parse(text) : {}, `${method} ${path}`);
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} did not return an object`);
  return value as Record<string, unknown>;
}
