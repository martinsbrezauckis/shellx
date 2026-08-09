import type {
  ReleaseSurfaceDriverOutcome,
  ReleaseSurfaceDriverRequest,
} from "../lib/release-surface-driver-protocol";

const SURFACE_NAME = "POST /browser/open";
const START_URL = "about:blank";
const TIMEOUT_MS = 30_000;

type DebugApiConnection = { base: string; token: string };
type DriverAssignment = ReleaseSurfaceDriverRequest["assignments"][number];

export function isDebugApiBrowserWindowMutation(name: string): boolean {
  return name === SURFACE_NAME;
}

export async function exerciseDebugApiBrowserWindowMutation(
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
    observedEffect: "No installed Browser window open/focus effect was observed.",
  };
  try {
    if (assignment.surface.name !== SURFACE_NAME) {
      throw new Error(`unsupported Browser window route ${assignment.surface.name}`);
    }
    await apiJson(connection, "GET", "/browser/state");
    outcome.present = "pass";
    const opened = await apiJson(connection, "POST", "/browser/open", { startUrl: START_URL });
    outcome.invoke = "pass";
    verifyExactKeys(opened, ["ok", "receipt", "startUrl", "windowLabel"], "Browser window open response");
    const receipt = requireObject(opened.receipt, "Browser window open receipt");
    const evidence = requireObject(receipt.evidence, "Browser window open receipt evidence");
    if (opened.ok !== true || opened.windowLabel !== "shellx-browser" || opened.startUrl !== START_URL
      || receipt.kind !== "browserWindowOpened" || receipt.taskId !== null || receipt.profileId !== null
      || evidence.windowLabel !== "shellx-browser" || evidence.startUrl !== START_URL) {
      throw new Error("Browser window open response did not bind the exact native window and start URL receipt");
    }
    const state = await apiJson(connection, "GET", "/browser/state");
    if (state.windowOpen !== true || state.pendingStartUrl !== START_URL
      || requireObject(state.enginePool, "Browser engine pool").windowState !== "foreground") {
      throw new Error("Browser state did not confirm the opened foreground native window and pending start URL");
    }
    const receiptsBody = await apiJson(connection, "GET", "/browser/receipts?limit=1000");
    const receipts = requireObjectArray(receiptsBody.receipts, "Browser window receipt readback");
    const matches = receipts.filter((candidate) => candidate.receiptId === receipt.receiptId
      && candidate.kind === "browserWindowOpened"
      && requireObject(candidate.evidence, "Browser window receipt readback evidence").windowLabel === "shellx-browser");
    if (matches.length !== 1) throw new Error("Browser receipts did not read back the exact window-open receipt");
    outcome.effect = "pass";
    outcome.cleanup = "pass";
    outcome.observedEffect = "POST /browser/open opened or focused the installed ShellX Browser native window, bound about:blank to its exact receipt, and read back foreground window state; the visible window and monotonic receipt end with disposable candidate teardown.";
  } catch (error) {
    outcome.error = error instanceof Error ? error.message : String(error);
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
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path} failed ${response.status}: ${text.slice(0, 1_200)}`);
  return requireObject(text.trim() ? JSON.parse(text) : {}, `${method} ${path}`);
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} did not return an object`);
  }
  return value as Record<string, unknown>;
}

function requireObjectArray(value: unknown, label: string): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) throw new Error(`${label} did not return an array`);
  return value.map((entry, index) => requireObject(entry, `${label}[${index}]`));
}

function verifyExactKeys(value: Record<string, unknown>, expected: string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new Error(`${label} keys changed: ${actual.join(", ")}`);
  }
}
