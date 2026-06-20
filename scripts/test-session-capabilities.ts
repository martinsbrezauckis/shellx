import {
  extractAdvertisedToolNames,
  extractProviderSessionToolNames,
  grokSearchCapabilities,
  hasInitializedMcpBridge,
  hasProviderShellxMcpContext,
  shellxRuntimeCapabilities,
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

function providerMcpTool(text: string): RawEventFrame {
  return {
    t: Date.now(),
    kind: "provider-session-event",
    payload: {
      tabId: "tab-a",
      runId: "run-a",
      providerId: "claude-code",
      kind: "mcpTool",
      text,
      rawType: "stream_event/content_block_start",
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
  const caps = grokSearchCapabilities([], { hasProviderContext: true, providerId: "codex-cli" });
  const xSearch = caps.find((cap) => cap.id === "x_search");
  assert(xSearch?.ready === false, "provider context alone does not imply ShellX host MCP readiness");
}

{
  const caps = grokSearchCapabilities(
    [
      toolsEvent(["web_search", "web_fetch", "grok-shell-host__x_search"]),
      providerMcpTool("mcp__shellx-host-http__x_search"),
    ],
    { hasProviderContext: true, providerId: "claude-code" },
  );
  assert(caps.find((cap) => cap.id === "web_search")?.ready === false, "provider sessions do not inherit Grok native web_search readiness");
  assert(caps.find((cap) => cap.id === "web_fetch")?.ready === false, "provider sessions do not inherit Grok native web_fetch readiness");
  assert(caps.find((cap) => cap.id === "x_search")?.ready === true, "provider sessions report ShellX X search readiness after an observed ShellX MCP tool");
  assert(caps.find((cap) => cap.id === "x_search")?.toolName === "shellx-host-http -> x_search", "provider x_search labels ShellX host MCP invocation shape");
}

{
  const events = [providerMcpTool("mcp__shellx-host-http__session_tooling")];
  const names = extractProviderSessionToolNames(events);
  assert(names.has("mcp__shellx-host-http__session_tooling"), "extracts provider MCP tool names");
  assert(hasProviderShellxMcpContext(events), "detects ShellX host MCP from provider tool events");
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

{
  const caps = shellxRuntimeCapabilities([
    toolsEvent([
      "shellx-host-http__desktop_mouse_drag",
      "shellx-host-http__desktop_screenshot",
      "shellx-host-http__lsp_definition",
    ]),
  ]);
  const desktop = caps.find((cap) => cap.id === "desktop_control");
  const codeIntel = caps.find((cap) => cap.id === "code_intelligence");
  assert(desktop?.ready === true, "desktop control reports ready when desktop tools are advertised");
  assert(codeIntel?.ready === true, "code intelligence reports ready when LSP tools are advertised");
}

{
  const caps = shellxRuntimeCapabilities([toolsEvent(["web_search"])]);
  assert(caps.every((cap) => !cap.ready), "advanced capabilities wait for advertised host tools");
}

{
  const caps = shellxRuntimeCapabilities([
    providerMcpTool("mcp__shellx-host-http__desktop_screenshot"),
    providerMcpTool("mcp__shellx-host-http__lsp_definition"),
  ]);
  assert(caps.find((cap) => cap.id === "desktop_control")?.ready === true, "desktop control reports ready from provider ShellX MCP tool events");
  assert(caps.find((cap) => cap.id === "code_intelligence")?.ready === true, "code intelligence reports ready from provider ShellX MCP tool events");
}

console.log(`\n${failures === 0 ? "PASS" : "FAIL"} session-capability tests`);
process.exit(failures === 0 ? 0 : 1);
