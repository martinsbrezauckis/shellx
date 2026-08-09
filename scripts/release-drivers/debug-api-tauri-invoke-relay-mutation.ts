import type {
  ReleaseSurfaceDriverOutcome,
  ReleaseSurfaceDriverRequest,
} from "../lib/release-surface-driver-protocol";

const ROUTES = new Set([
  "POST /release-test/tauri-invokes",
  "GET /release-test/tauri-invokes/:id",
  "DELETE /release-test/tauri-invokes/:id",
  "POST /release-test/tauri-invokes/:id/claim",
  "POST /release-test/tauri-invokes/:id/complete",
]);
const INVOKE_ID = /^rti-[0-9a-f]{32}$/;
const TIMEOUT_MS = 30_000;

type DebugApiConnection = { base: string; token: string };
type DriverAssignment = ReleaseSurfaceDriverRequest["assignments"][number];

export function isDebugApiTauriInvokeRelayMutation(name: string): boolean {
  return ROUTES.has(name);
}

export async function exerciseDebugApiTauriInvokeRelayMutation(
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
    observedEffect: "No isolated Tauri invoke relay lifecycle was observed.",
  };
  let invokeId: string | null = null;
  let removed = false;
  try {
    if (!isDebugApiTauriInvokeRelayMutation(assignment.surface.name)) {
      throw new Error(`unsupported release Tauri invoke route ${assignment.surface.name}`);
    }
    const started = await apiJson(connection, "POST", "/release-test/tauri-invokes", {
      command: "get_debug_port",
      args: {},
    });
    verifyExactKeys(started.body, ["id", "status"], "release Tauri invoke start response");
    if (started.status !== 202 || started.body.status !== "pending"
      || typeof started.body.id !== "string" || !INVOKE_ID.test(started.body.id)) {
      throw new Error("release Tauri invoke start did not return an exact pending invocation identity");
    }
    invokeId = started.body.id;
    outcome.present = "pass";

    const completed = await waitForCompletion(connection, invokeId);
    outcome.invoke = "pass";
    const expectedPort = Number(new URL(connection.base).port);
    if (completed.status !== "passed" || completed.value !== expectedPort) {
      throw new Error("release Tauri invoke did not return the attested candidate's exact Debug API port");
    }

    if (assignment.surface.name.startsWith("DELETE ")) {
      await removeInvoke(connection, invokeId, true);
      removed = true;
      await verifyInvokeAbsent(connection, invokeId);
    }
    outcome.effect = "pass";
    outcome.observedEffect = observedEffect(assignment.surface.name, invokeId, expectedPort);
  } catch (error) {
    outcome.error = error instanceof Error ? error.message : String(error);
  } finally {
    try {
      if (invokeId && !removed) {
        await removeInvoke(connection, invokeId, true);
        removed = true;
        await verifyInvokeAbsent(connection, invokeId);
      }
      if (!invokeId) throw new Error("release Tauri invoke cleanup had no owned identity");
      outcome.cleanup = "pass";
    } catch (error) {
      const cleanup = error instanceof Error ? error.message : String(error);
      outcome.error = outcome.error ? `${outcome.error}; cleanup: ${cleanup}` : `cleanup: ${cleanup}`;
    }
  }
  return outcome;
}

async function waitForCompletion(
  connection: DebugApiConnection,
  invokeId: string,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const response = await apiJson(connection, "GET", `/release-test/tauri-invokes/${invokeId}`);
    if (response.status !== 200) throw new Error(`release Tauri invoke poll returned ${response.status}`);
    const status = response.body.status;
    if (status === "passed") {
      verifyExactKeys(response.body, ["id", "status", "value"], "release Tauri invoke completed response");
      if (response.body.id !== invokeId) throw new Error("release Tauri invoke poll identity drifted");
      return response.body;
    }
    if (status === "failed") {
      throw new Error(`release Tauri invoke failed: ${String(response.body.error ?? "no bounded error")}`);
    }
    if (status !== "pending" && status !== "claimed") {
      throw new Error(`release Tauri invoke returned unknown status ${String(status)}`);
    }
    await delay(25);
  }
  throw new Error("release Tauri invoke did not complete before the bounded deadline");
}

async function removeInvoke(
  connection: DebugApiConnection,
  invokeId: string,
  expectedRemoved: boolean,
): Promise<void> {
  const response = await apiJson(connection, "DELETE", `/release-test/tauri-invokes/${invokeId}`);
  verifyExactKeys(response.body, ["removed"], "release Tauri invoke delete response");
  if (response.status !== 200 || response.body.removed !== expectedRemoved) {
    throw new Error("release Tauri invoke delete did not remove its exact owned record");
  }
}

async function verifyInvokeAbsent(connection: DebugApiConnection, invokeId: string): Promise<void> {
  const response = await apiJson(connection, "GET", `/release-test/tauri-invokes/${invokeId}`);
  verifyExactKeys(response.body, ["error", "message"], "release Tauri invoke absent response");
  if (response.status !== 404 || response.body.error !== "release_tauri_invoke_not_found") {
    throw new Error("release Tauri invoke record remained readable after exact deletion");
  }
}

async function apiJson(
  connection: DebugApiConnection,
  method: "GET" | "POST" | "DELETE",
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
  let parsed: unknown = {};
  try {
    parsed = text.trim() ? JSON.parse(text) : {};
  } catch {
    throw new Error(`${method} ${path} returned non-JSON status ${response.status}`);
  }
  return { status: response.status, body: requireObject(parsed, `${method} ${path}`) };
}

function observedEffect(name: string, invokeId: string, port: number): string {
  const routeEffect = name.includes("/claim")
    ? "the renderer claimed the nonce-bound command"
    : name.includes("/complete")
      ? "the renderer completed the claimed command"
      : name.startsWith("GET ")
        ? "the controller polled the terminal record"
        : name.startsWith("DELETE ")
          ? "the controller deleted the exact terminal record"
          : "the controller created one allowlisted command";
  return `${name} proved ${routeEffect} in lifecycle ${invokeId}; get_debug_port returned ${port}, and the exact record was removed before reporting success.`;
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} did not return an object`);
  }
  return value as Record<string, unknown>;
}

function verifyExactKeys(value: Record<string, unknown>, expected: string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new Error(`${label} keys changed: ${actual.join(", ")}`);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
