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
    out.push({
      t: entry.t,
      kind: "grok-acp-event",
      payload: entry.frame,
    });
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
      // Find the message and verify it equals "OK"
      const msg = groups.find((g) => g.kind === "message") as
        | { kind: "message"; text: string; chunkCount: number }
        | undefined;
      const okText = msg?.text.trim() === "OK";
      console.log(
        `  ${okText ? "✓" : "✗"} message text = "OK" (got: ${JSON.stringify(msg?.text)})`,
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

  header(passed ? "ALL PASSED" : "FAILURES");
  return passed ? 0 : 1;
}

process.exit(main());
