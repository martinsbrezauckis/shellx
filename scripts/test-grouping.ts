/**
 * scripts/test-grouping.ts
 *
 * Sanity check for src/lib/grouping.ts against real captured wire from
 * P0. Loads evidence/session-NNN.jsonl, builds RawEventFrame[] (the
 * shape the React renderer accumulates), runs groupEvents, prints a
 * summary. PASS criteria are hand-coded against what we know each
 * session represents.
 *
 * Run:  pnpm tsx scripts/test-grouping.ts
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

import { groupEvents } from "../src/lib/grouping";
import type { RawEventFrame } from "../src/types/acp";

interface JsonlEntry {
  t: number;
  dir: "in" | "out" | "log" | "stderr";
  frame?: any;
  raw?: string;
  note?: string;
}

/**
 * Convert acp-driver's bidirectional JSONL into the RawEventFrame[]
 * shape the renderer accumulates. Only `dir: "in"` frames matter
 * (those are what the agent sent to us → what `acp.rs` would emit to
 * Tauri events). Maps each frame to a synthetic `grok-acp-event` row.
 */
function jsonlToFrames(path: string): RawEventFrame[] {
  const raw = readFileSync(path, "utf8");
  const out: RawEventFrame[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let entry: JsonlEntry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.dir !== "in" || !entry.frame) continue;
    if (
      typeof entry.frame.kind === "string" &&
      Object.prototype.hasOwnProperty.call(entry.frame, "payload")
    ) {
      out.push({
        t: typeof entry.frame.t === "number" ? entry.frame.t : entry.t,
        kind: entry.frame.kind,
        payload: entry.frame.payload,
      });
    } else {
      out.push({
        t: entry.t,
        kind: "grok-acp-event",
        payload: entry.frame,
      });
    }
  }
  return out;
}

function header(s: string): void {
  console.log("\n=== " + s + " ===");
}

function expectKind(
  groups: ReturnType<typeof groupEvents>,
  kind: string,
  minCount: number,
  label: string,
): boolean {
  const n = groups.filter((g) => g.kind === kind).length;
  const ok = n >= minCount;
  console.log(`  ${ok ? "✓" : "✗"} ${label}: ${n} (expected ≥ ${minCount})`);
  return ok;
}

function summarize(groups: ReturnType<typeof groupEvents>): void {
  const counts = new Map<string, number>();
  for (const g of groups) counts.set(g.kind, (counts.get(g.kind) ?? 0) + 1);
  for (const [k, v] of Array.from(counts).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${v}  ${k}`);
  }
}

function main(): number {
  const base = join(__dirname, "..", "evidence");
  let passed = true;

  // session-003: short Q&A ("Reply with just OK")
  header("session-003 (short Q&A — reply 'OK')");
  {
    const fixture = join(base, "session-003.jsonl");
    if (!existsSync(fixture)) {
      console.log("  skipped: evidence/session-003.jsonl not present");
    } else {
      const frames = jsonlToFrames(fixture);
      const groups = groupEvents(frames);
      console.log(`  input frames: ${frames.length}`);
      console.log(`  output groups: ${groups.length}`);
      summarize(groups);
      passed = expectKind(groups, "thought", 1, "thought group(s)") && passed;
      passed = expectKind(groups, "message", 1, "message group(s)") && passed;
      // Find a completed assistant message. The checked-in fixture may be
      // replaced during manual ACP captures, so only assert that grouping
      // preserved visible assistant text.
      const msg = groups.find((g) => g.kind === "message") as
        | { kind: "message"; text: string; chunkCount: number }
        | undefined;
      const okText = (msg?.text.trim().length ?? 0) > 0;
      console.log(
        `  ${okText ? "✓" : "✗"} message text preserved (${msg?.text.trim().length ?? 0} chars)`,
      );
      passed = okText && passed;
      console.log(
        `  ✓ collapsed ${frames.length} raw events → ${groups.length} groups`,
      );
    }
  }

  // session-006: code-write task (3 tool calls, multi-thousand chunks)
  header("session-006 (write Python script — tool use)");
  {
    const fixture = join(base, "session-006.jsonl");
    if (!existsSync(fixture)) {
      console.log("  skipped: evidence/session-006.jsonl not present");
    } else {
      const frames = jsonlToFrames(fixture);
      const groups = groupEvents(frames);
      console.log(`  input frames: ${frames.length}`);
      console.log(`  output groups: ${groups.length}`);
      summarize(groups);
      passed =
        expectKind(groups, "thought", 1, "≥1 thought group(s)") && passed;
      passed =
        expectKind(groups, "message", 1, "≥1 message group(s)") && passed;
      passed = expectKind(groups, "tool", 2, "≥2 tool group(s)") && passed;
      // Verify at least one tool has a diff content block from the
      // tool_call_update event.
      const tools = groups.filter((g) => g.kind === "tool") as Array<
        { kind: "tool"; diffPath?: string; status: string; updateCount: number }
      >;
      const anyDiff = tools.some((t) => t.diffPath != null);
      console.log(
        `  ${anyDiff ? "✓" : "✗"} at least one tool group has a diff`,
      );
      passed = anyDiff && passed;
      const ratio = ((frames.length / Math.max(groups.length, 1)) | 0);
      console.log(
        `  ✓ collapsed ${frames.length} raw events → ${groups.length} groups (${ratio}x reduction)`,
      );
    }
  }

  header("synthetic host-MCP transport failure");
  {
    const frames: RawEventFrame[] = [
      {
        t: Date.now(),
        kind: "grok-acp-event",
        payload: {
          type: "notification",
          method: "_x.ai/session_notification",
          params: {
            update: {
              sessionUpdate: "host_mcp_unreachable",
              message: "host-MCP transport closed while running grok-shell-host__goal_complete",
              repeat_count: 1,
              tool_name: "grok-shell-host__goal_complete",
              goal_halted: true,
            },
          },
        },
      },
    ];
    const groups = groupEvents(frames);
    const g = groups[0] as
      | {
          kind: "host-mcp-unreachable";
          toolName?: string;
          goalHalted: boolean;
        }
      | undefined;
    const ok =
      groups.length === 1 &&
      g?.kind === "host-mcp-unreachable" &&
      g.toolName === "grok-shell-host__goal_complete" &&
      g.goalHalted;
    console.log(`  ${ok ? "✓" : "✗"} host-MCP unreachable chip grouped`);
    passed = ok && passed;
  }

  header("synthetic unhandled ACP envelope");
  {
    const frames: RawEventFrame[] = [
      {
        t: Date.now(),
        kind: "grok-acp-event",
        payload: {
          _meta: { tabId: "tab-test" },
          method: "session/debug_noise",
          params: { note: "low-signal internal event" },
        },
      },
    ];
    const groups = groupEvents(frames);
    const ok = groups.length === 0;
    console.log(`  ${ok ? "✓" : "✗"} unhandled ACP envelope hidden from chat`);
    passed = ok && passed;
  }

  header("synthetic metadata-only UI envelope");
  {
    const frames: RawEventFrame[] = [
      {
        t: Date.now(),
        kind: "ui",
        payload: {
          _meta: { tabId: "tab-test", kind: "connection-metadata" },
          connectionId: null,
          connectionLabel: "Local",
          connectionTransport: "local",
          cwd: "C:\\Users\\FixtureUser\\Documents\\demo",
        },
      },
    ];
    const groups = groupEvents(frames);
    const ok = groups.length === 0;
    console.log(`  ${ok ? "✓" : "✗"} metadata-only ui envelope hidden from chat`);
    passed = ok && passed;
  }

  header("synthetic build event envelope");
  {
    const frames: RawEventFrame[] = [
      {
        t: Date.now(),
        kind: "build-event",
        payload: {
          tabId: "tab-test",
          runId: "build-test",
          status: "active",
        },
      },
    ];
    const groups = groupEvents(frames);
    const ok = groups.length === 0;
    console.log(`  ${ok ? "✓" : "✗"} build-event envelope hidden from chat`);
    passed = ok && passed;
  }

  header("synthetic low-signal provider MCP probes");
  {
    const frames: RawEventFrame[] = [
      {
        t: Date.now(),
        kind: "provider-session-event",
        payload: {
          tabId: "provider-tab",
          runId: "run-1",
          providerId: "codex-cli",
          kind: "mcpTool",
          text: "mcp__shellx-host-http__shellx_health",
          rawType: "item.started/mcp_tool_call",
        },
      },
      {
        t: Date.now() + 1,
        kind: "provider-session-event",
        payload: {
          tabId: "provider-tab",
          runId: "run-1",
          providerId: "claude-code",
          kind: "mcpTool",
          text: "mcp__shellx-host-http__provider_sessions",
          rawType: "stream_event/content_block_start",
        },
      },
      {
        t: Date.now() + 2,
        kind: "provider-session-event",
        payload: {
          tabId: "provider-tab",
          runId: "run-1",
          providerId: "codex-cli",
          kind: "mcpTool",
          text: "shellx-host-http/tool-search",
          rawType: "item.started/mcp_tool_call",
        },
      },
      {
        t: Date.now() + 3,
        kind: "provider-session-event",
        payload: {
          tabId: "provider-tab",
          runId: "run-1",
          providerId: "claude-code",
          kind: "tool",
          text: "ToolSearch",
          rawType: "stream_event/content_block_start",
        },
      },
    ];
    const groups = groupEvents(frames);
    const ok = groups.length === 0;
    console.log(`  ${ok ? "✓" : "✗"} provider health/session/tool-search probes hidden from chat`);
    passed = ok && passed;
  }

  header("synthetic low-signal provider tools split message groups");
  {
    const frames: RawEventFrame[] = [
      {
        t: Date.now(),
        kind: "provider-session-event",
        payload: {
          tabId: "provider-tab",
          runId: "run-1",
          providerId: "claude-code",
          kind: "textDelta",
          text: "Loaded MCP tools. ",
        },
      },
      {
        t: Date.now() + 1,
        kind: "provider-session-event",
        payload: {
          tabId: "provider-tab",
          runId: "run-1",
          providerId: "claude-code",
          kind: "tool",
          text: "ToolSearch",
          rawType: "stream_event/content_block_start",
        },
      },
      {
        t: Date.now() + 2,
        kind: "provider-session-event",
        payload: {
          tabId: "provider-tab",
          runId: "run-1",
          providerId: "claude-code",
          kind: "textDelta",
          text: "Calling diagnostics now.",
        },
      },
    ];
    const groups = groupEvents(frames);
    const messages = groups.filter((group) => group.kind === "message") as Array<{ kind: "message"; text: string }>;
    const ok = messages.length === 2 &&
      messages[0]?.text === "Loaded MCP tools. " &&
      messages[1]?.text === "Calling diagnostics now.";
    console.log(`  ${ok ? "✓" : "✗"} hidden provider tools create a visible text boundary`);
    passed = ok && passed;
  }

  header("synthetic Grok command inventory hidden");
  {
    const frames: RawEventFrame[] = [
      {
        t: Date.now(),
        kind: "grok-acp-event",
        payload: {
          type: "notification",
          method: "session/update",
          params: {
            _meta: {
              promptId: "prompt-inventory",
              updateType: "AvailableCommandsUpdate",
              updateParams: { commandsCount: 322 },
            },
            update: {
              sessionUpdate: "available_commands_update",
              availableCommands: ["Shell", "Read", "shellx-host-http__session_tooling"],
              _meta: { tools: ["Shell", "Read", "shellx-host-http__session_tooling"] },
            },
          },
        },
      },
    ];
    const groups = groupEvents(frames);
    const ok = groups.length === 0;
    console.log(`  ${ok ? "✓" : "✗"} available_commands_update hidden from chat`);
    passed = ok && passed;
  }

  header("synthetic Grok low-signal host MCP tools hidden");
  {
    const frames: RawEventFrame[] = [
      {
        t: Date.now(),
        kind: "grok-acp-event",
        payload: {
          type: "notification",
          method: "session/update",
          params: {
            _meta: {
              promptId: "prompt-mcp",
              updateType: "ToolCall",
              updateParams: {
                status: "Pending",
                title: "shellx-host-http__provider_sessions",
                toolCallId: "call-provider-sessions",
              },
            },
            update: {
              sessionUpdate: "tool_call",
              title: "shellx-host-http__provider_sessions",
              toolCallId: "call-provider-sessions",
              rawInput: { tabId: "tab-a" },
            },
          },
        },
      },
      {
        t: Date.now() + 1,
        kind: "grok-acp-event",
        payload: {
          type: "notification",
          method: "session/update",
          params: {
            _meta: {
              promptId: "prompt-mcp",
              updateType: "ToolCallUpdate",
              updateParams: { status: "Completed", toolCallId: "call-provider-sessions" },
            },
            update: {
              sessionUpdate: "tool_call_update",
              status: "completed",
              toolCallId: "call-provider-sessions",
              rawOutput: {
                server_name: "shellx-host-http",
                tool_name: "provider_sessions",
                type: "MCP",
              },
            },
          },
        },
      },
      {
        t: Date.now() + 2,
        kind: "grok-acp-event",
        payload: {
          type: "notification",
          method: "session/update",
          params: {
            _meta: {
              promptId: "prompt-mcp",
              updateType: "ToolCallUpdate",
              updateParams: { status: "Completed", toolCallId: "call-search-tool" },
            },
            update: {
              sessionUpdate: "tool_call_update",
              status: "completed",
              toolCallId: "call-search-tool",
              rawOutput: {
                server_name: "shellx-host-http",
                tool_name: "tool_search",
                type: "MCP",
              },
            },
          },
        },
      },
    ];
    const groups = groupEvents(frames);
    const ok = groups.length === 0;
    console.log(`  ${ok ? "✓" : "✗"} Grok ShellX host-MCP probes hidden from chat`);
    passed = ok && passed;
  }

  header("synthetic Grok startup/status noise hidden");
  {
    const frames: RawEventFrame[] = [
      {
        t: Date.now(),
        kind: "max-context-detected",
        payload: { maxContextLength: 524288 },
      },
      {
        t: Date.now() + 1,
        kind: "grok-acp-event",
        payload: {
          type: "notification",
          method: "_x.ai/mcp/init_progress",
          params: { connected: 1, total: 8 },
        },
      },
      {
        t: Date.now() + 2,
        kind: "grok-acp-event",
        payload: {
          type: "notification",
          method: "_x.ai/mcp_initialized",
          params: { connected: 8, total: 8, mcpToolCount: 120 },
        },
      },
      {
        t: Date.now() + 3,
        kind: "grok-stderr",
        payload: {
          line: "worker quit with fatal: Transport channel closed, when Auth Required",
        },
      },
    ];
    const groups = groupEvents(frames);
    const ok = groups.length === 0;
    console.log(`  ${ok ? "✓" : "✗"} Grok startup/status diagnostics hidden from chat`);
    passed = ok && passed;
  }

  header("synthetic debug and host-MCP event hub noise hidden");
  {
    const frames: RawEventFrame[] = [
      {
        t: Date.now(),
        kind: "debug-ui-state-patch",
        payload: { patch: { rightTab: "Tooling" } },
      },
      {
        t: Date.now() + 1,
        kind: "host-mcp-tool-call",
        payload: { tool: "session_tooling", status: "completed" },
      },
    ];
    const groups = groupEvents(frames);
    const ok = groups.length === 0;
    console.log(`  ${ok ? "✓" : "✗"} debug/event-hub envelopes hidden from chat`);
    passed = ok && passed;
  }

  header("synthetic Grok MCP schema read hidden");
  {
    const frames: RawEventFrame[] = [
      {
        t: Date.now(),
        kind: "grok-acp-event",
        payload: {
          type: "notification",
          method: "session/update",
          params: {
            _meta: {
              promptId: "prompt-schema",
              updateType: "ToolCall",
              updateParams: {
                status: "Pending",
                title: "Read",
                toolCallId: "call-schema-read",
              },
            },
            update: {
              sessionUpdate: "tool_call",
              title: "Read",
              toolCallId: "call-schema-read",
              rawInput: {
                path: "/home/user/.grok/projects/app/mcps/shellx-host-http/tools/provider_sessions.json",
              },
            },
          },
        },
      },
      {
        t: Date.now() + 1,
        kind: "grok-acp-event",
        payload: {
          type: "notification",
          method: "session/update",
          params: {
            _meta: {
              promptId: "prompt-schema",
              updateType: "ToolCallUpdate",
              updateParams: { status: "Completed", toolCallId: "call-schema-read" },
            },
            update: {
              sessionUpdate: "tool_call_update",
              status: "completed",
              toolCallId: "call-schema-read",
              rawOutput: { text: "{ \"type\": \"object\" }" },
            },
          },
        },
      },
    ];
    const groups = groupEvents(frames);
    const ok = groups.length === 0;
    console.log(`  ${ok ? "✓" : "✗"} Grok MCP schema JSON read hidden from chat`);
    passed = ok && passed;
  }

  header("synthetic out-of-order Grok tool update keeps text");
  {
    const frames: RawEventFrame[] = [
      {
        t: Date.now(),
        kind: "grok-acp-event",
        payload: {
          type: "notification",
          method: "session/update",
          params: {
            _meta: {
              promptId: "prompt-out-of-order",
              updateType: "ToolCallUpdate",
              updateParams: { status: "Completed", toolCallId: "call-grep-only" },
            },
            update: {
              sessionUpdate: "tool_call_update",
              status: "completed",
              toolCallId: "call-grep-only",
              content: [
                {
                  type: "content",
                  content: { type: "text", text: "found 0 matches" },
                },
              ],
              rawOutput: { type: "GrepSearch" },
            },
          },
        },
      },
    ];
    const groups = groupEvents(frames);
    const tool = groups[0] as { kind: string; title?: string; toolText?: string } | undefined;
    const ok =
      groups.length === 1 &&
      tool?.kind === "tool" &&
      tool.title === "GrepSearch" &&
      tool.toolText === "found 0 matches";
    console.log(`  ${ok ? "✓" : "✗"} out-of-order update renders useful tool card`);
    passed = ok && passed;
  }

  header("synthetic provider stderr transport noise");
  {
    const frames: RawEventFrame[] = [
      {
        t: Date.now(),
        kind: "provider-session-event",
        payload: {
          tabId: "provider-tab",
          runId: "run-1",
          providerId: "codex-cli",
          kind: "raw",
          rawType: "stderr",
          text:
            '2026-06-04T03:23:10.647155Z ERROR rmcp::transport::worker: worker quit with fatal: Transport channel closed, when AuthRequired(AuthRequiredError { www_authenticate_header: "Bearer realm=\\"OAuth\\", resource_metadata=\\"https://mcp.cloudflare.com/.well-known/oauth-protected-resource/mcp\\", error=\\"invalid_token\\"" })',
        },
      },
      {
        t: Date.now(),
        kind: "provider-session-event",
        payload: {
          tabId: "provider-tab",
          runId: "run-1",
          providerId: "codex-cli",
          kind: "raw",
          rawType: "stderr",
          text: 'codex_memories_write::phase2: Phase 2 no changes',
        },
      },
    ];
    const groups = groupEvents(frames);
    const ok = groups.length === 0;
    console.log(`  ${ok ? "✓" : "✗"} provider stderr noise hidden from chat`);
    passed = ok && passed;
  }

  header(passed ? "ALL PASSED" : "FAILURES");
  return passed ? 0 : 1;
}

process.exit(main());
