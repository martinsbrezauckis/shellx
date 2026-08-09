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

function providerCapabilities(capabilities: string[]): RawEventFrame {
  return {
    t: Date.now(),
    kind: "provider-session-event",
    payload: {
      tabId: "tab-antigravity",
      runId: "run-antigravity",
      providerId: "antigravity-cli",
      kind: "raw",
      rawType: "init",
      capabilities,
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
  const events = [providerCapabilities(["search_web", "generate_image", "call_mcp_tool"])];
  const names = extractProviderSessionToolNames(events);
  assert(names.has("search_web"), "extracts provider-advertised native search capability");
  assert(names.has("generate_image"), "extracts provider-advertised native image generation capability");
  assert(names.has("call_mcp_tool"), "extracts provider-advertised MCP capability before first use");

  const caps = grokSearchCapabilities(events, {
    hasProviderContext: true,
    providerId: "antigravity-cli",
  });
  assert(caps.find((cap) => cap.id === "web_search")?.ready === true, "Antigravity search_web advertises native web search readiness");
  assert(caps.find((cap) => cap.id === "web_search")?.toolName === "search_web", "provider capability reports the advertised web-search alias");
  assert(caps.find((cap) => cap.id === "web_fetch")?.ready === false, "missing Antigravity page-fetch capability remains unavailable");
  assert(caps.find((cap) => cap.id === "x_search")?.ready === false, "generic MCP capability does not imply ShellX X-search readiness");
}

{
  const caps = grokSearchCapabilities(
    [providerCapabilities(["read_url_content"])],
    { hasProviderContext: true, providerId: "antigravity-cli" },
  );
  assert(caps.find((cap) => cap.id === "web_fetch")?.ready === true, "Antigravity read_url_content advertises native fetch readiness");
  assert(caps.find((cap) => cap.id === "web_fetch")?.toolName === "read_url_content", "provider capability reports the advertised page-fetch alias");
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
  const caps = shellxRuntimeCapabilities([
    providerCapabilities([
      "generate_image",
      "browser_click_element",
      "invoke_subagent",
      "code_search",
    ]),
  ]);
  const image = caps.find((cap) => cap.id === "image_generation");
  const browser = caps.find((cap) => cap.id === "browser_control");
  const subagents = caps.find((cap) => cap.id === "subagents");
  const codeIntel = caps.find((cap) => cap.id === "code_intelligence");
  assert(image?.ready === true && image.source === "native", "provider catalog exposes native image generation readiness");
  assert(image?.toolName === "generate_image", "native image generation reports its exact advertised tool");
  assert(browser?.ready === true && browser.source === "native", "provider catalog exposes native Browser control readiness");
  assert(subagents?.ready === true && subagents.source === "native", "provider catalog exposes native subagent readiness");
  assert(codeIntel?.ready === true && codeIntel.source === "native", "provider catalog exposes native code-search readiness");
  assert(caps.find((cap) => cap.id === "desktop_control")?.ready === false, "Browser tools do not imply host desktop control");
}

{
  const caps = shellxRuntimeCapabilities([
    providerMcpTool("mcp__shellx-host-http__generate_image"),
    providerMcpTool("mcp__shellx-host-http__browser_read"),
  ]);
  assert(caps.find((cap) => cap.id === "image_generation")?.ready === false, "ShellX-prefixed tools do not masquerade as provider-native image generation");
  assert(caps.find((cap) => cap.id === "browser_control")?.ready === false, "ShellX Browser gateway does not masquerade as provider-native Browser control");
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
