import {
  extractAdvertisedToolNames,
  grokSearchCapabilities,
  hasInitializedMcpBridge,
} from "../src/lib/session-capabilities";
import type { RawEventFrame } from "../src/types/acp";

let failures = 0;
function assert(cond: boolean, label: string): void {
  console.log(`  ${cond ? "✓" : "✗"} ${label}`);
  if (!cond) failures += 1;
}

function toolsEvent(tools: string[]): RawEventFrame {
  return {
    t: Date.now(),
    kind: "grok-acp-event",
    payload: {
      method: "session/update",
      params: {
        update: {
          sessionUpdate: "available_commands_update",
          _meta: { tools },
          availableCommands: [],
        },
      },
    },
  };
}

function mcpInitialized(count = 87): RawEventFrame {
  return {
    t: Date.now(),
    kind: "grok-acp-event",
    payload: {
      method: "_x.ai/mcp_initialized",
      params: { mcpToolCount: count },
      type: "notification",
    },
  };
}

console.log("\n=== session search capabilities ===");
{
  const names = extractAdvertisedToolNames([
    toolsEvent(["web_search", "web_fetch", "grok-shell-host__x_search"]),
  ]);
  assert(names.has("web_search"), "extracts native web_search");
  assert(names.has("web_fetch"), "extracts native web_fetch");
  assert(names.has("grok-shell-host__x_search"), "extracts ShellX host x_search");
}

{
  const caps = grokSearchCapabilities([
    toolsEvent(["web_search", "web_fetch", "grok-shell-host__x_search"]),
  ]);
  assert(caps.every((cap) => cap.ready), "all search capabilities report ready when tools are advertised");
}

{
  const caps = grokSearchCapabilities([toolsEvent(["web_search"])]);
  const xSearch = caps.find((cap) => cap.id === "x_search");
  assert(xSearch?.ready === false, "x_search waits until host MCP advertises the tool");
}

{
  const events = [
    toolsEvent(["web_search", "web_fetch", "use_tool"]),
    mcpInitialized(),
  ];
  const caps = grokSearchCapabilities(events);
  const xSearch = caps.find((cap) => cap.id === "x_search");
  assert(hasInitializedMcpBridge(events), "detects initialized MCP bridge");
  assert(xSearch?.ready === true, "x_search is ready through Grok use_tool bridge");
  assert(xSearch?.toolName === "use_tool -> x_search", "x_search labels bridged invocation shape");
}

console.log(`\n${failures === 0 ? "PASS" : "FAIL"} session-capability tests`);
process.exit(failures === 0 ? 0 : 1);
