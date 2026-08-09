import type {
  ReleaseSurfaceDriverOutcome,
  ReleaseSurfaceDriverRequest,
} from "../lib/release-surface-driver-protocol";

const SURFACE_NAME = "POST /vault/open-panel";
const HIGHLIGHT_ID = "final-surface-vault-open-panel";
const SELECTOR = "[data-debug-id='vault-workspace-modal']";
const TIMEOUT_MS = 30_000;

type DebugApiConnection = { base: string; token: string };
type DriverAssignment = ReleaseSurfaceDriverRequest["assignments"][number];

export function isDebugApiVaultOpenPanelMutation(name: string): boolean {
  return name === SURFACE_NAME;
}

export async function exerciseDebugApiVaultOpenPanelMutation(
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
    observedEffect: "No acknowledged visible Vault panel was observed.",
  };
  try {
    await postUi(connection, { openModal: "close", debugHighlights: [] });
    outcome.present = "pass";
    const opened = await apiJson(connection, "POST", "/vault/open-panel", {});
    outcome.invoke = "pass";
    verifyExactKeys(opened, ["ok"], "Vault panel open response");
    if (opened.ok !== true) throw new Error("Vault panel open route did not acknowledge success");
    await postUi(connection, {
      debugSurface: "app",
      debugHighlights: [{
        id: HIGHLIGHT_ID,
        selector: SELECTOR,
        label: "Vault workspace",
        color: "cyan",
      }],
    });
    const result = await waitForHighlight(connection, HIGHLIGHT_ID);
    const rect = requireObject(result.visibleRect ?? result.rect, "Vault panel visible rectangle");
    if (Number(rect.width) <= 0 || Number(rect.height) <= 0) {
      throw new Error("Vault panel acknowledgement resolved without a non-empty visible rectangle");
    }
    outcome.effect = "pass";
    outcome.observedEffect = `POST /vault/open-panel focused the installed main window, received the renderer's mounted-panel acknowledgement, and resolved the Vault workspace to a visible ${Number(rect.width)}x${Number(rect.height)} rectangle before exact modal cleanup.`;
  } catch (error) {
    outcome.error = error instanceof Error ? error.message : String(error);
  } finally {
    try {
      await postUi(connection, { openModal: "close", debugHighlights: [] });
      await waitForHighlightCleared(connection, HIGHLIGHT_ID);
      outcome.cleanup = "pass";
    } catch (error) {
      const cleanup = error instanceof Error ? error.message : String(error);
      outcome.error = outcome.error ? `${outcome.error}; cleanup: ${cleanup}` : `cleanup: ${cleanup}`;
    }
  }
  return outcome;
}

async function postUi(connection: DebugApiConnection, patch: Record<string, unknown>): Promise<void> {
  await apiJson(connection, "POST", "/state/ui", {
    source: "final-surface-vault-open-panel",
    ...patch,
  });
}

async function waitForHighlight(
  connection: DebugApiConnection,
  id: string,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const state = await apiJson(connection, "GET", "/state/ui");
    const bySurface = requireObject(state.debugHighlightResultsBySurface, "Vault highlight surface results");
    const results = requireObjectArray(bySurface.app, "Vault app highlight results");
    const match = results.find((candidate) => candidate.id === id);
    if (match?.status === "resolved") return match;
    if (match?.status === "missing" || match?.status === "invalid") {
      throw new Error(`Vault panel highlight ${match.status}: ${String(match.message ?? "no detail")}`);
    }
    await delay(50);
  }
  throw new Error("Vault panel did not resolve to a visible rectangle before timeout");
}

async function waitForHighlightCleared(connection: DebugApiConnection, id: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const state = await apiJson(connection, "GET", "/state/ui");
    const bySurface = requireObject(state.debugHighlightResultsBySurface, "Vault cleanup highlight results");
    const results = requireObjectArray(bySurface.app ?? [], "Vault cleanup app highlight results");
    if (!results.some((candidate) => candidate.id === id)) return;
    await delay(50);
  }
  throw new Error("Vault panel highlight remained after cleanup");
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

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
