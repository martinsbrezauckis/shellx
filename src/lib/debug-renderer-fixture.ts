import type { RawEventFrame } from "../types/acp";
import { appendBoundedRendererEvents } from "./bounded-event-store";
import type { BuildReceipt, BuildRunState } from "./build-run";
import { isDebugPermissionDecisionFrame } from "./debug-permission-decision-fixture";

export const DEBUG_RENDERER_EVENT_PROJECTIONS_FIXTURE = "event-projections";
export const DEBUG_CHAT_OUTPUT_LIFECYCLE_FIXTURE = "chat-output-lifecycle";
export const DEBUG_KEYBOARD_DIFF_LIFECYCLE_FIXTURE = "keyboard-diff-lifecycle";
export const OWNED_CHAT_CLIPBOARD_CODE = "const shellxClipboardFixture = true;";
export const DEBUG_BUILD_RUN_COCKPIT_FIXTURE = "build-run-cockpit-receipts";
const DEBUG_FIXTURE_META_KEY = "shellxDebugRendererFixture";

interface EventProjectionFixture {
  id: typeof DEBUG_RENDERER_EVENT_PROJECTIONS_FIXTURE;
  attachmentPath: string;
  imagePath: string;
  videoPath?: string;
  externalLinkUrl?: string;
}

interface ChatOutputLifecycleFixture {
  id: typeof DEBUG_CHAT_OUTPUT_LIFECYCLE_FIXTURE;
  action?: "clear";
  attachmentPath?: string;
  diffPath?: string;
}

interface KeyboardDiffLifecycleFixture {
  id: typeof DEBUG_KEYBOARD_DIFF_LIFECYCLE_FIXTURE;
  action?: "clear";
}

export interface DebugBuildRunCockpitFixture {
  fixtureOnly: true;
  scratchboardText: "";
  state: BuildRunState;
  receipts: BuildReceipt[];
}

/**
 * Resolve the fixed, renderer-only Build Run Cockpit receipt fixture used by
 * the installed UI driver. Its terminal run state exposes only the local
 * receipt disclosure: it cannot approve, reject, continue, stop, recheck, or
 * checkpoint a build and never creates a project, scratchboard, or provider.
 */
export function debugBuildRunCockpitFixture(
  command: unknown,
  tabId: string,
  now = Date.now(),
): DebugBuildRunCockpitFixture | null {
  if (!command || typeof command !== "object" || Array.isArray(command)) return null;
  const body = command as Record<string, unknown>;
  if (body.id !== DEBUG_BUILD_RUN_COCKPIT_FIXTURE) return null;
  const runId = `release-build-cockpit-${boundedToken(tabId, 96) ?? "default"}`;
  const receiptKinds: Array<BuildReceipt["kind"]> = [
    "runStarted",
    "planWritten",
    "planApproved",
    "agentStarted",
    "agentCompleted",
    "reviewCompleted",
    "verificationCompleted",
    "runHalted",
  ];
  const receipts = receiptKinds.map((kind, index): BuildReceipt => ({
    receiptId: `${runId}-receipt-${index + 1}`,
    runId,
    tabId,
    kind,
    createdAtMs: now - (receiptKinds.length - index) * 1_000,
    actor: "shellx-release-fixture",
    summary: `Owned ${kind} receipt ${index + 1}`,
    confidence: "trustedHost",
    data: { fixtureOnly: true, ordinal: index + 1 },
  }));
  const state: BuildRunState = {
    runId,
    tabId,
    objective: "Inspect the owned Build receipt disclosure",
    cwd: "",
    transportKind: "local",
    scratchboardPath: "",
    status: "halted",
    continuationsTotal: 0,
    noProgressCycles: 0,
    createdAtMs: now - 60_000,
    updatedAtMs: now,
    checkpointId: null,
    codeChanged: false,
    reviewRequired: false,
    reviewSatisfied: true,
    verificationRequired: false,
    verificationSatisfied: true,
    previewRequired: false,
    previewSatisfied: true,
    openBlocker: null,
    pendingOperatorNotes: [],
    lastReceiptId: receipts.at(-1)?.receiptId ?? null,
  };
  return { fixtureOnly: true, scratchboardText: "", state, receipts };
}

export function applyDebugRendererFixture(
  current: readonly RawEventFrame[],
  command: unknown,
  tabId: string,
  now = Date.now(),
): RawEventFrame[] {
  const keyboardDiffFixture = normalizeKeyboardDiffLifecycleFixture(command);
  if (keyboardDiffFixture) {
    const baseline = current.filter((frame) => debugRendererFixtureId(frame) !== DEBUG_KEYBOARD_DIFF_LIFECYCLE_FIXTURE);
    if (keyboardDiffFixture.action === "clear") return baseline;
    return appendBoundedRendererEvents(baseline, keyboardDiffLifecycleFrames(tabId, now));
  }
  const chatOutputFixture = normalizeChatOutputLifecycleFixture(command);
  if (chatOutputFixture) {
    const baseline = current.filter((frame) => debugRendererFixtureId(frame) !== DEBUG_CHAT_OUTPUT_LIFECYCLE_FIXTURE);
    if (chatOutputFixture.action === "clear") return baseline;
    return appendBoundedRendererEvents(baseline, chatOutputLifecycleFrames(tabId, now, chatOutputFixture));
  }
  const baseline = current.filter((frame) => !isOwnedDebugRendererFrame(frame));
  if (command === "clear") return baseline;
  const fixture = normalizeEventProjectionFixture(command);
  if (!fixture) return Array.from(current);
  return appendBoundedRendererEvents(baseline, eventProjectionFrames(fixture, tabId, now));
}

export function isOwnedDebugRendererFrame(frame: RawEventFrame): boolean {
  if (isDebugPermissionDecisionFrame(frame)) return true;
  const fixtureId = debugRendererFixtureId(frame);
  return fixtureId === DEBUG_RENDERER_EVENT_PROJECTIONS_FIXTURE
    || fixtureId === DEBUG_CHAT_OUTPUT_LIFECYCLE_FIXTURE
    || fixtureId === DEBUG_KEYBOARD_DIFF_LIFECYCLE_FIXTURE;
}

function debugRendererFixtureId(frame: RawEventFrame): unknown {
  const payload = frame.payload as {
    _meta?: Record<string, unknown>;
    params?: { _meta?: Record<string, unknown> };
  } | null;
  return payload?._meta?.[DEBUG_FIXTURE_META_KEY]
    ?? payload?.params?._meta?.[DEBUG_FIXTURE_META_KEY];
}

function normalizeChatOutputLifecycleFixture(command: unknown): ChatOutputLifecycleFixture | null {
  if (!command || typeof command !== "object" || Array.isArray(command)) return null;
  const body = command as Record<string, unknown>;
  if (body.id !== DEBUG_CHAT_OUTPUT_LIFECYCLE_FIXTURE) return null;
  if (body.action !== undefined && body.action !== "clear") return null;
  const attachmentPath = boundedPath(body.attachmentPath);
  const diffPath = boundedPath(body.diffPath);
  if ((attachmentPath === null) !== (diffPath === null)) return null;
  return {
    id: DEBUG_CHAT_OUTPUT_LIFECYCLE_FIXTURE,
    ...(body.action === "clear" ? { action: "clear" as const } : {}),
    ...(attachmentPath && diffPath ? { attachmentPath, diffPath } : {}),
  };
}

function normalizeKeyboardDiffLifecycleFixture(command: unknown): KeyboardDiffLifecycleFixture | null {
  if (!command || typeof command !== "object" || Array.isArray(command)) return null;
  const body = command as Record<string, unknown>;
  if (body.id !== DEBUG_KEYBOARD_DIFF_LIFECYCLE_FIXTURE) return null;
  if (body.action !== undefined && body.action !== "clear") return null;
  return {
    id: DEBUG_KEYBOARD_DIFF_LIFECYCLE_FIXTURE,
    ...(body.action === "clear" ? { action: "clear" as const } : {}),
  };
}

function keyboardDiffLifecycleFrames(tabId: string, now: number): RawEventFrame[] {
  const meta = { tabId, [DEBUG_FIXTURE_META_KEY]: DEBUG_KEYBOARD_DIFF_LIFECYCLE_FIXTURE };
  const promptId = "release-keyboard-diff";
  return [
    {
      t: now,
      kind: "grok-acp-event",
      payload: {
        _meta: meta,
        method: "session/update",
        params: {
          _meta: { ...meta, promptId },
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "release-keyboard-diff-call",
            title: "Update release-keyboard-diff.txt",
            kind: "edit",
          },
        },
      },
    },
    {
      t: now + 1,
      kind: "grok-acp-event",
      payload: {
        _meta: meta,
        method: "session/update",
        params: {
          _meta: { ...meta, promptId },
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "release-keyboard-diff-call",
            title: "Update release-keyboard-diff.txt",
            kind: "edit",
            status: "completed",
            content: [{
              type: "diff",
              path: "release-keyboard-diff.txt",
              oldText: "old one\nold two\nold three",
              newText: [
                "@@ -1 +1 @@",
                "-old one",
                "+new one",
                "@@ -2 +2 @@",
                "-old two",
                "+new two",
                "@@ -3 +3 @@",
                "-old three",
                "+new three",
              ].join("\n"),
            }],
          },
        },
      },
    },
  ];
}

function normalizeEventProjectionFixture(command: unknown): EventProjectionFixture | null {
  if (!command || typeof command !== "object" || Array.isArray(command)) return null;
  const body = command as Record<string, unknown>;
  if (body.id !== DEBUG_RENDERER_EVENT_PROJECTIONS_FIXTURE) return null;
  const attachmentPath = boundedPath(body.attachmentPath);
  const imagePath = boundedPath(body.imagePath);
  const videoPath = boundedPath(body.videoPath);
  const externalLinkUrl = boundedExternalUrl(body.externalLinkUrl);
  return attachmentPath && imagePath
    ? {
        id: DEBUG_RENDERER_EVENT_PROJECTIONS_FIXTURE,
        attachmentPath,
        imagePath,
        ...(videoPath ? { videoPath } : {}),
        ...(externalLinkUrl ? { externalLinkUrl } : {}),
      }
    : null;
}

function boundedPath(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const path = value.trim();
  return path.length > 0 && path.length <= 4_096 ? path : null;
}

function boundedToken(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const token = value.trim();
  return token.length > 0 && token.length <= maxLength && /^[A-Za-z0-9._: -]+$/.test(token)
    ? token
    : null;
}

function boundedExternalUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2_048) return null;
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && url.username === "" && url.password === ""
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

function eventProjectionFrames(
  fixture: EventProjectionFixture,
  tabId: string,
  now: number,
): RawEventFrame[] {
  const meta = { tabId, [DEBUG_FIXTURE_META_KEY]: fixture.id };
  const acp = (offset: number, promptId: string, update: Record<string, unknown>): RawEventFrame => ({
    t: now + offset,
    kind: "grok-acp-event",
    payload: {
      _meta: meta,
      method: "session/update",
      params: { _meta: { ...meta, promptId }, update },
    },
  });
  const frames: RawEventFrame[] = [
    {
      t: now,
      kind: "ui",
      payload: {
        _meta: meta,
        text: "Owned release fixture attachment",
        attachments: [{
          path: fixture.attachmentPath,
          label: "Owned release fixture.txt",
          kind: "text",
        }],
      },
    },
    acp(1, "release-fixture-thought", {
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "Inspect the owned renderer fixture without invoking a provider." },
    }),
    acp(2, "release-fixture-diff", {
      sessionUpdate: "tool_call",
      toolCallId: "release-fixture-diff-call",
      title: "write_text_file",
      rawInput: { path: "shellx-final-owned.ts" },
    }),
    acp(3, "release-fixture-diff", {
      sessionUpdate: "tool_call_update",
      toolCallId: "release-fixture-diff-call",
      status: "completed",
      content: [{
        type: "diff",
        path: "shellx-final-owned.ts",
        oldText: "export const ready = false;\n",
        newText: "export const ready = true;\n",
      }],
    }),
    acp(4, "release-fixture-image", {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: `Generated image saved to ${fixture.imagePath}` },
    }),
    {
      t: now + 5,
      kind: "permission-request",
      payload: {
        _meta: meta,
        reqId: "release-fixture-permission",
        params: {
          toolCall: {
            toolCallId: "release-fixture-read",
            title: "Read owned fixture",
            rawInput: { path: fixture.attachmentPath },
          },
          options: ["allow_once", "allow_always", "reject_once"],
        },
      },
    },
  ];
  if (fixture.videoPath) {
    frames.push(acp(6, "release-fixture-video", {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: `Generated video saved to ${fixture.videoPath}` },
    }));
  }
  if (fixture.externalLinkUrl) {
    frames.push(acp(7, "release-fixture-external-link", {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: `[Owned release documentation](${fixture.externalLinkUrl})` },
    }));
  }
  return frames;
}

function chatOutputLifecycleFrames(
  tabId: string,
  now: number,
  fixture: ChatOutputLifecycleFixture,
): RawEventFrame[] {
  const meta = { tabId, [DEBUG_FIXTURE_META_KEY]: DEBUG_CHAT_OUTPUT_LIFECYCLE_FIXTURE };
  const acp = (offset: number, update: Record<string, unknown>): RawEventFrame => ({
    t: now + offset,
    kind: "grok-acp-event",
    payload: {
      _meta: meta,
      method: "_x.ai/session_notification",
      params: { _meta: meta, update },
    },
  });
  const rows: RawEventFrame[] = Array.from({ length: 32 }, (_, index) => ({
    t: now + index,
    kind: "ui",
    payload: {
      _meta: meta,
      text: `Owned release renderer row ${String(index + 1).padStart(2, "0")} — deterministic scroll fixture`,
    },
  }));
  if (fixture.attachmentPath && fixture.diffPath) {
    rows.push(
      {
        t: now + 32,
        kind: "ui",
        payload: {
          _meta: meta,
          text: "Owned release ChatOutput attachment preview",
          attachments: [{
            path: fixture.attachmentPath,
            label: "release-chat-output-attachment.txt",
            kind: "text",
          }],
        },
      },
      {
        t: now + 33,
        kind: "grok-acp-event",
        payload: {
          _meta: meta,
          method: "session/update",
          params: {
            _meta: { ...meta, promptId: "release-chat-output-diff" },
            update: {
              sessionUpdate: "tool_call",
              toolCallId: "release-chat-output-diff-call",
              title: "write_text_file",
              rawInput: { path: fixture.diffPath },
            },
          },
        },
      },
      {
        t: now + 34,
        kind: "grok-acp-event",
        payload: {
          _meta: meta,
          method: "session/update",
          params: {
            _meta: { ...meta, promptId: "release-chat-output-diff" },
            update: {
              sessionUpdate: "tool_call_update",
              toolCallId: "release-chat-output-diff-call",
              status: "completed",
              content: [{
                type: "diff",
                path: fixture.diffPath,
                oldText: "export const preview = false;\n",
                newText: "export const preview = true;\n",
              }],
            },
          },
        },
      },
    );
  }
  rows.push(
    {
      t: now + 35,
      kind: "grok-acp-event",
      payload: {
        _meta: meta,
        method: "session/update",
        params: {
          _meta: { ...meta, promptId: "release-chat-output-thought" },
          update: {
            sessionUpdate: "agent_thought_chunk",
            content: { type: "text", text: "Owned renderer-only thought fixture." },
          },
        },
      },
    },
    acp(36, {
      sessionUpdate: "doom_loop_detected",
      message: "Owned renderer-only loop warning",
      is_warning: true,
      repeat_count: 4,
      tool_names: ["owned_fixture_tool"],
    }),
    acp(37, {
      sessionUpdate: "host_mcp_unreachable",
      message: "Owned renderer-only host MCP warning",
      repeat_count: 1,
      tool_name: "owned_fixture_tool",
      goal_halted: false,
    }),
    acp(36, {
      sessionUpdate: "agent_message_chunk",
      content: {
        type: "text",
        text: `\n\n\`\`\`ts\n${OWNED_CHAT_CLIPBOARD_CODE}\n\`\`\`\n`,
      },
    }),
  );
  return rows;
}
