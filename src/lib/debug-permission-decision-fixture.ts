import type { RawEventFrame } from "../types/acp";
import { appendBoundedRendererEvents } from "./bounded-event-store";

export const DEBUG_PERMISSION_DECISION_FIXTURE = "permission-decision-lifecycle";
export const DEBUG_PERMISSION_FIXTURE_META_KEY = "shellxDebugRendererFixture";

export type DebugPermissionDecision =
  | "allow"
  | "allow_always"
  | "deny";

export type DebugPermissionAction =
  | "pill-allow"
  | "pill-always"
  | "pill-deny";

export interface DebugPermissionDecisionFixture {
  fixtureOnly: true;
  id: typeof DEBUG_PERMISSION_DECISION_FIXTURE;
  action: DebugPermissionAction;
  requestId: string;
  expectedDecision: DebugPermissionDecision | null;
  command: "shellx-owned-permission-check";
  args: readonly ["--fixture-only"];
  cwd: null;
  env: readonly [];
}

const ACTIONS: Record<
  DebugPermissionAction,
  Pick<
    DebugPermissionDecisionFixture,
    "expectedDecision"
  >
> = {
  "pill-allow": {
    expectedDecision: "allow",
  },
  "pill-always": {
    expectedDecision: "allow_always",
  },
  "pill-deny": {
    expectedDecision: "deny",
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
    requestId: "release-permission-" + action,
    expectedDecision: config.expectedDecision,
    command: "shellx-owned-permission-check",
    args: ["--fixture-only"],
    cwd: null,
    env: [],
  };
}

/**
 * Install or clear only the exact permission-pill fixture frames.
 */
export function applyDebugPermissionDecisionFixtureEvents(
  current: readonly RawEventFrame[],
  fixture: DebugPermissionDecisionFixture | null,
  tabId: string,
  now = Date.now(),
): RawEventFrame[] {
  const baseline = current.filter((frame) => !isDebugPermissionDecisionFrame(frame));
  if (!fixture) return baseline;
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
