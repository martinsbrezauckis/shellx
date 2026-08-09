import {
  clickReleaseSurfaceInstalledInputElement,
  observeReleaseSurfaceInstalledInputElement,
  waitForReleaseSurfaceInstalledInputElement,
  type ReleaseSurfaceInstalledInputSession,
} from "../lib/release-surface-installed-input-client";
import type {
  ReleaseSurfaceDriverOutcome,
  ReleaseSurfaceDriverRequest,
} from "../lib/release-surface-driver-protocol";

type Assignment = ReleaseSurfaceDriverRequest["assignments"][number];
type Connection = { base: string; token: string };

const KIND_CONTROLS = {
  "src/components/WorkPreviewPanel.tsx:[id=\"work-preview-kind-auto\"]": "auto",
  "src/components/WorkPreviewPanel.tsx:[id=\"work-preview-kind-static\"]": "static",
  "src/components/WorkPreviewPanel.tsx:[id=\"work-preview-kind-web\"]": "web",
  "src/components/WorkPreviewPanel.tsx:[id=\"work-preview-kind-expo\"]": "expo",
} as const;
const SELECTORS = {
  auto: "[id='work-preview-kind-auto']",
  static: "[id='work-preview-kind-static']",
  web: "[id='work-preview-kind-web']",
  expo: "[id='work-preview-kind-expo']",
} as const;
export const WORK_PREVIEW_KIND_FIXTURES = ["ui:work-preview-kind-auto-baseline"] as const;
export const WORK_PREVIEW_KIND_CLEANUPS = ["ui:restore-work-preview-kind-and-right-rail"] as const;

export function supportsWorkPreviewKindControl(assignment: Assignment): boolean {
  return assignment.surface.name in KIND_CONTROLS;
}

export async function exerciseWorkPreviewKindControl(
  connection: Connection,
  webdriver: ReleaseSurfaceInstalledInputSession,
  assignment: Assignment,
): Promise<ReleaseSurfaceDriverOutcome> {
  const outcome: ReleaseSurfaceDriverOutcome = {
    id: assignment.surface.id,
    expectedEffect: assignment.expectedEffect,
    oracleId: assignment.oracleId,
    present: "fail",
    invoke: "fail",
    effect: "fail",
    cleanup: "fail",
    observedEffect: "No native Work Preview kind selection was observed.",
  };
  const target = KIND_CONTROLS[assignment.surface.name as keyof typeof KIND_CONTROLS];
  let baselineRightTab: string | null = null;
  try {
    if (!target) throw new Error(`Work Preview kind driver does not support ${assignment.surface.name}`);
    const baseline = await apiJson(connection, "GET", "/state/ui");
    baselineRightTab = typeof baseline.rightTab === "string" ? baseline.rightTab : null;
    if (!baselineRightTab || baseline.openModal != null) {
      throw new Error("Work Preview kind fixture requires a quiescent restorable right rail");
    }
    await postUi(connection, { rightTab: "Preview", source: "final-surface-work-preview-kind" });
    const targetSelector = SELECTORS[target];
    const setup = target === "auto" ? "static" : "auto";
    await clickSelector(webdriver, SELECTORS[setup]);
    await waitForSelected(webdriver, SELECTORS[setup], true);
    const control = await waitForReleaseSurfaceInstalledInputElement(webdriver, targetSelector, {
      timeoutMs: 5_000,
      pollMs: 50,
    });
    outcome.present = "pass";
    await clickReleaseSurfaceInstalledInputElement(webdriver, control);
    outcome.invoke = "pass";
    await waitForSelected(webdriver, targetSelector, true);
    await waitForSelected(webdriver, SELECTORS[setup], false);
    outcome.effect = "pass";
    outcome.observedEffect = `A native WebDriver click selected the exact ${target} Work Preview start kind with matching aria-selected ownership.`;
  } catch (error) {
    outcome.error = error instanceof Error ? error.message : String(error);
  } finally {
    const cleanupErrors: string[] = [];
    try {
      const auto = await waitForReleaseSurfaceInstalledInputElement(webdriver, SELECTORS.auto, {
        timeoutMs: 5_000,
        pollMs: 50,
      });
      if (!(await selectedState(webdriver, SELECTORS.auto))) {
        await clickReleaseSurfaceInstalledInputElement(webdriver, auto);
      }
      await waitForSelected(webdriver, SELECTORS.auto, true);
    } catch (error) {
      cleanupErrors.push(`kind restore: ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      if (!baselineRightTab) throw new Error("right-rail baseline was unavailable");
      await postUi(connection, {
        rightTab: baselineRightTab,
        source: "final-surface-work-preview-kind-cleanup",
      });
      const restored = await apiJson(connection, "GET", "/state/ui");
      if (restored.rightTab !== baselineRightTab) throw new Error("right rail was not restored");
    } catch (error) {
      cleanupErrors.push(`right-rail restore: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (cleanupErrors.length === 0) outcome.cleanup = "pass";
    else {
      const detail = cleanupErrors.join("; ");
      outcome.error = outcome.error ? `${outcome.error}; cleanup: ${detail}` : `cleanup: ${detail}`;
    }
  }
  if ([outcome.present, outcome.invoke, outcome.effect, outcome.cleanup].includes("fail") && !outcome.error) {
    outcome.error = "Work Preview kind control did not satisfy every required verdict";
  }
  return outcome;
}

async function clickSelector(
  webdriver: ReleaseSurfaceInstalledInputSession,
  selector: string,
): Promise<void> {
  const control = await waitForReleaseSurfaceInstalledInputElement(webdriver, selector, {
    timeoutMs: 5_000,
    pollMs: 50,
  });
  await clickReleaseSurfaceInstalledInputElement(webdriver, control);
}

async function waitForSelected(
  webdriver: ReleaseSurfaceInstalledInputSession,
  selector: string,
  expected: boolean,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await selectedState(webdriver, selector) === expected) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  throw new Error(`${selector} did not reach aria-selected=${expected}`);
}

async function selectedState(
  webdriver: ReleaseSurfaceInstalledInputSession,
  selector: string,
): Promise<boolean> {
  const value = await observeReleaseSurfaceInstalledInputElement(webdriver, selector, ["selected"]);
  if (!value.present || !value.visible || typeof value.selected !== "boolean") {
    throw new Error(`${selector} returned no bounded selected state`);
  }
  return value.selected;
}

async function postUi(connection: Connection, body: Record<string, unknown>): Promise<void> {
  await apiJson(connection, "POST", "/state/ui", body);
}

async function apiJson(
  connection: Connection,
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
    signal: AbortSignal.timeout(5_000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path} failed ${response.status}: ${text.slice(0, 800)}`);
  const value = text.trim() ? JSON.parse(text) : {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${method} ${path} did not return an object`);
  }
  return value as Record<string, unknown>;
}
