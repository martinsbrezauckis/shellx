import type { RawEventFrame } from "../types/acp";
import { appendBoundedRendererEvents } from "./bounded-event-store";

export const DEBUG_PERMISSION_DECISION_FIXTURE = "permission-decision-lifecycle";
export const DEBUG_PERMISSION_FIXTURE_META_KEY = "shellxDebugRendererFixture";

export type DebugPermissionDecision =
  | "allow"
  | "allow_always"
  | "deny";

export type DebugPermissionAction =
  | "modal-markers"
  | "modal-backdrop-deny"
  | "modal-deny"
  | "modal-allow"
  | "pill-allow"
  | "pill-always"
  | "pill-deny";

export type DebugPermissionModalSource = "backdrop" | "deny" | "allow";

export interface DebugPermissionDecisionFixture {
  fixtureOnly: true;
  id: typeof DEBUG_PERMISSION_DECISION_FIXTURE;
  action: DebugPermissionAction;
  surface: "modal" | "pill";
  requestId: string;
  expectedDecision: DebugPermissionDecision | null;
  expectedModalSource: DebugPermissionModalSource | null;
  command: "shellx-owned-permission-check";
  args: readonly ["--fixture-only"];
  cwd: null;
  env: readonly [];
}

const ACTIONS: Record<
  DebugPermissionAction,
  Pick<
    DebugPermissionDecisionFixture,
    "surface" | "expectedDecision" | "expectedModalSource"
  >
> = {
  "modal-markers": {
    surface: "modal",
    expectedDecision: null,
    expectedModalSource: null,
  },
  "modal-backdrop-deny": {
    surface: "modal",
    expectedDecision: "deny",
    expectedModalSource: "backdrop",
  },
  "modal-deny": {
    surface: "modal",
    expectedDecision: "deny",
    expectedModalSource: "deny",
  },
  "modal-allow": {
    surface: "modal",
    expectedDecision: "allow",
    expectedModalSource: "allow",
  },
  "pill-allow": {
    surface: "pill",
    expectedDecision: "allow",
    expectedModalSource: null,
  },
  "pill-always": {
    surface: "pill",
    expectedDecision: "allow_always",
    expectedModalSource: null,
  },
  "pill-deny": {
    surface: "pill",
    expectedDecision: "deny",
    expectedModalSource: null,
  },
};

/**
 * Resolve one exact renderer-owned permission fixture. Unknown commands are
 * deliberately ignored so this seam cannot affect normal provider traffic.
 */
export function debugPermissionDecisionFixture(
  command: unknown,
): DebugPermissionDecisionFixture | null | undefined {
  if (!command || typeof command !== "object" || Array.isArray(command)) {
    return undefined;
  }
  const body = command as Record<string, unknown>;
  if (body.id !== DEBUG_PERMISSION_DECISION_FIXTURE) return undefined;
  if (body.action === "clear") return null;
  if (typeof body.action !== "string" || !(body.action in ACTIONS)) return undefined;
  const action = body.action as DebugPermissionAction;
  const config = ACTIONS[action];
  return {
    fixtureOnly: true,
    id: DEBUG_PERMISSION_DECISION_FIXTURE,
    action,
    surface: config.surface,
    requestId: "release-permission-" + action,
    expectedDecision: config.expectedDecision,
    expectedModalSource: config.expectedModalSource,
    command: "shellx-owned-permission-check",
    args: ["--fixture-only"],
    cwd: null,
    env: [],
  };
}

/**
 * Install or clear only the exact permission fixture frames. Modal fixtures
 * need no transcript event; pill fixtures use the real grouping projection.
 */
export function applyDebugPermissionDecisionFixtureEvents(
  current: readonly RawEventFrame[],
  fixture: DebugPermissionDecisionFixture | null,
  tabId: string,
  now = Date.now(),
): RawEventFrame[] {
  const baseline = current.filter((frame) => !isDebugPermissionDecisionFrame(frame));
  if (!fixture || fixture.surface !== "pill") return baseline;
  const meta = {
    tabId,
    [DEBUG_PERMISSION_FIXTURE_META_KEY]: DEBUG_PERMISSION_DECISION_FIXTURE,
  };
  const frame: RawEventFrame = {
    t: now,
    kind: "permission-request",
    payload: {
      _meta: meta,
      reqId: fixture.requestId,
      params: {
        _meta: meta,
        toolCall: {
          toolCallId: fixture.requestId,
          title: "Owned permission fixture",
          kind: "execute",
          rawInput: {
            command: fixture.command,
            args: fixture.args,
          },
        },
        options: [
          { optionId: "allow_once", kind: "allow_once" },
          { optionId: "allow_always", kind: "allow_always" },
          { optionId: "reject", kind: "reject" },
        ],
      },
    },
  };
  return appendBoundedRendererEvents(baseline, frame);
}

export function isDebugPermissionDecisionFrame(frame: RawEventFrame): boolean {
  const payload = frame.payload as {
    _meta?: Record<string, unknown>;
    params?: { _meta?: Record<string, unknown> };
  } | null;
  return payload?._meta?.[DEBUG_PERMISSION_FIXTURE_META_KEY] === DEBUG_PERMISSION_DECISION_FIXTURE
    || payload?.params?._meta?.[DEBUG_PERMISSION_FIXTURE_META_KEY] === DEBUG_PERMISSION_DECISION_FIXTURE;
}
