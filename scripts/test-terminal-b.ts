/**
 * scripts/test-terminal-b.ts — P-Terminal-B evidence harness
 *
 * Exercises the two halves of the Phase B work end-to-end without
 * standing up a full Tauri instance:
 *
 *   1. **Grouping**: synthesize the wire-shape grok emits when it spawns
 *      a terminal via ACP — a `tool_call` with `content: [{type:
 *      "terminal", terminalId: "..."}]`, then a `tool_call_update` with
 *      a similar block — and assert `groupEvents()` lifts the
 *      terminalId onto the ToolGroup. Mirrors the
 *      `scripts/test-media-extraction.ts` style.
 *
 *   2. **Rust handlers via debug API (optional)**: when run with
 *      `--rust`, verifies a debug API is reachable and then skips with
 *      an explicit message. Terminal ACP handlers are not exposed as
 *      HTTP `/terminal/*` or `/invoke/*` routes yet; live terminal
 *      coverage belongs in the ACP driver, not this script.
 *
 * The grouping half runs as a pure-Node check (no Rust dependency). The
 * Rust half is gated behind `--rust` and skipped when the API isn't up.
 *
 * Run:
 *   pnpm tsx scripts/test-terminal-b.ts                 (grouping only)
 *   pnpm tsx scripts/test-terminal-b.ts --rust          (full + Rust)
 */
import { groupEvents } from "../src/lib/grouping";
import type { RawEventFrame } from "../src/types/acp";

const TID_1 = "gs-term-00000001";

// ─── helpers ───────────────────────────────────────────────────────

interface ToolCallContentBlock {
  type: string;
  terminalId?: string;
  text?: string;
}

function toolCallWithContent(
  toolCallId: string,
  content: ToolCallContentBlock[],
): RawEventFrame {
  return {
    t: Date.now(),
    kind: "grok-acp-event",
    payload: {
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "s1",
        update: {
          sessionUpdate: "tool_call",
          toolCallId,
          title: "Bash",
          kind: "Other",
          status: "InProgress",
          content,
        },
      },
    },
  };
}

function toolCallUpdateWithContent(
  toolCallId: string,
  content: ToolCallContentBlock[],
  status: string = "Completed",
): RawEventFrame {
  return {
    t: Date.now(),
    kind: "grok-acp-event",
    payload: {
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "s1",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId,
          title: "Bash",
          kind: "Other",
          status,
          content,
        },
      },
    },
  };
}

let pass = 0;
let fail = 0;
function expect(name: string, ok: boolean, detail?: string) {
  if (ok) {
    pass++;
    console.log("PASS", name);
  } else {
    fail++;
    console.log("FAIL", name, detail ?? "");
  }
}

// ─── 1. Grouping checks ────────────────────────────────────────────

function runGroupingChecks(): void {
  // 1a. terminalId on the initial tool_call.
  {
    const ev = toolCallWithContent("tc-1", [
      { type: "terminal", terminalId: TID_1 },
    ]);
    const groups = groupEvents([ev]);
    const tool = groups.find((g) => g.kind === "tool") as any;
    expect(
      "grouping: terminalId extracted from initial tool_call",
      tool?.terminalId === TID_1,
      `got terminalId=${tool?.terminalId}`,
    );
  }

  // 1b. terminalId arriving late on a tool_call_update.
  {
    const open = toolCallWithContent("tc-2", [
      { type: "text", text: "preparing shell" },
    ]);
    const upd = toolCallUpdateWithContent("tc-2", [
      { type: "terminal", terminalId: "gs-term-00000007" },
    ]);
    const groups = groupEvents([open, upd]);
    const tool = groups.find((g) => g.kind === "tool") as any;
    expect(
      "grouping: terminalId picked up from late tool_call_update",
      tool?.terminalId === "gs-term-00000007",
      `got terminalId=${tool?.terminalId}`,
    );
  }

  // 1c. Existing imagePath/videoPath behavior still works alongside.
  {
    const open = toolCallWithContent("tc-3", []);
    const upd: RawEventFrame = {
      t: Date.now(),
      kind: "grok-acp-event",
      payload: {
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "s1",
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "tc-3",
            title: "Bash",
            kind: "Other",
            status: "Completed",
            rawOutput: { type: "Text", text: "Generated /tmp/out.jpg" },
          },
        },
      },
    };
    const groups = groupEvents([open, upd]);
    const tool = groups.find((g) => g.kind === "tool") as any;
    expect(
      "grouping: imagePath extraction unaffected",
      tool?.imagePath === "/tmp/out.jpg",
      `got imagePath=${tool?.imagePath}`,
    );
  }

  // 1d. No terminal block → terminalId stays undefined.
  {
    const ev = toolCallWithContent("tc-4", [
      { type: "text", text: "no terminal here" },
    ]);
    const groups = groupEvents([ev]);
    const tool = groups.find((g) => g.kind === "tool") as any;
    expect(
      "grouping: no terminal block → terminalId undefined",
      tool?.terminalId === undefined,
      `got terminalId=${tool?.terminalId}`,
    );
  }

  // 1e. First terminal block wins when multiple are present (defensive).
  {
    const ev = toolCallWithContent("tc-5", [
      { type: "terminal", terminalId: "gs-term-FIRST" },
      { type: "terminal", terminalId: "gs-term-SECOND" },
    ]);
    const groups = groupEvents([ev]);
    const tool = groups.find((g) => g.kind === "tool") as any;
    expect(
      "grouping: first-wins when multiple terminal blocks present",
      tool?.terminalId === "gs-term-FIRST",
      `got terminalId=${tool?.terminalId}`,
    );
  }
}

// ─── 2. Optional Rust-side checks via debug API ────────────────────

interface DebugRpcCall {
  method: string;
  params: any;
}

async function rustSmoke(): Promise<void> {
  // The debug API token + port live in `~/.shellx/` (or env). Resolve
  // both at startup; when this script runs from WSL against a
  // Windows-hosted shellX instance, fall back to
  // `/mnt/c/Users/<user>/.shellx`. Still honor the legacy
  // DEBUG_API_URL override.
  //
  // Port: read `~/.shellx/debug-api.port` (server publishes the bound
  //   port atomically after a successful bind). Default 5757.
  // Token: read `~/.shellx/shellxagent.token` (32-char hex bearer).
  //   Required on every endpoint except /health.
  const { existsSync, readFileSync, readdirSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { homedir } = await import("node:os");
  const readFileOrEmpty = (p: string): string => {
    try {
      return readFileSync(p, "utf8").trim();
    } catch {
      return "";
    }
  };
  const shellxHome = (name: string): string => {
    const native = join(homedir(), ".shellx", name);
    if (existsSync(native)) return native;
    for (const winUser of [
      process.env.WIN_USER,
      process.env.USERNAME,
      process.env.USER,
    ].filter((v): v is string => Boolean(v && v.trim()))) {
      const wslMounted = `/mnt/c/Users/${winUser}/.shellx/${name}`;
      if (existsSync(wslMounted)) return wslMounted;
    }
    try {
      for (const entry of readdirSync("/mnt/c/Users", { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const wslMounted = `/mnt/c/Users/${entry.name}/.shellx/${name}`;
        if (existsSync(wslMounted)) return wslMounted;
      }
    } catch {
      // fall through to the native path below
    }
    return native;
  };
  const portFromFile = Number(readFileOrEmpty(shellxHome("debug-api.port")));
  const port = Number.isFinite(portFromFile) && portFromFile > 0 ? portFromFile : 5757;
  const baseUrl = process.env.DEBUG_API_URL ?? `http://127.0.0.1:${port}`;
  const token =
    process.env.GROK_SHELL_DEBUG_SECRET ??
    readFileOrEmpty(shellxHome("shellxagent.token")) ??
    "";
  const authHeaders: Record<string, string> = token
    ? { Authorization: `Bearer ${token}` }
    : {};

  // Probe — if no debug API, skip cleanly without failing.
  try {
    const probe = await fetch(`${baseUrl}/health`, { method: "GET" });
    if (!probe.ok) {
      console.log("SKIP rust-smoke: debug-api unhealthy");
      return;
    }
  } catch (e) {
    console.log("SKIP rust-smoke: debug-api unreachable (", String(e), ")");
    return;
  }

  console.log(
    "SKIP rust-smoke: terminal ACP handlers are not exposed on the debug API",
  );
}

// ─── main ──────────────────────────────────────────────────────────

(async () => {
  runGroupingChecks();
  if (process.argv.includes("--rust")) {
    await rustSmoke();
  }
  console.log(`\n${pass}/${pass + fail} cases pass`);
  process.exit(fail > 0 ? 1 : 0);
})();
