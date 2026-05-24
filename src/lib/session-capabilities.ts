import type { RawEventFrame } from "../types/acp";

export interface SearchCapability {
  id: "web_search" | "web_fetch" | "x_search";
  name: string;
  toolName: string;
  source: "grok" | "shellx";
  ready: boolean;
  description: string;
  unavailableHint: string;
}

export function extractAdvertisedToolNames(events: RawEventFrame[]): Set<string> {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (!event || event.kind !== "grok-acp-event") continue;
    const update = (event.payload as any)?.params?.update;
    if (update?.sessionUpdate !== "available_commands_update") continue;

    const names = new Set<string>();
    const metaTools = update?._meta?.tools;
    if (Array.isArray(metaTools)) {
      for (const tool of metaTools) {
        if (typeof tool === "string" && tool.trim()) names.add(tool.trim());
      }
    }

    const commands = update?.availableCommands;
    if (Array.isArray(commands)) {
      for (const command of commands) {
        const name = typeof command === "string"
          ? command
          : typeof command?.name === "string"
            ? command.name
            : typeof command?.id === "string"
              ? command.id
              : null;
        if (name && name.trim()) names.add(name.trim());
      }
    }

    return names;
  }
  return new Set();
}

export function hasInitializedMcpBridge(events: RawEventFrame[]): boolean {
  return events.some((event) => {
    if (!event || event.kind !== "grok-acp-event") return false;
    const payload: any = event.payload;
    if (payload?.method !== "_x.ai/mcp_initialized") return false;
    const count = payload?.params?.mcpToolCount;
    return typeof count !== "number" || count > 0;
  });
}

export function grokSearchCapabilities(events: RawEventFrame[]): SearchCapability[] {
  const tools = extractAdvertisedToolNames(events);
  const hasMcpBridge = tools.has("use_tool") && hasInitializedMcpBridge(events);
  const xSearchReady = tools.has("grok-shell-host__x_search")
    || tools.has("x_search")
    || hasMcpBridge;
  return [
    {
      id: "web_search",
      name: "Web Search",
      toolName: "web_search",
      source: "grok",
      ready: tools.has("web_search"),
      description: "Grok native real-time web search with citations.",
      unavailableHint: "Waiting for Grok to advertise native web_search.",
    },
    {
      id: "web_fetch",
      name: "Web Fetch",
      toolName: "web_fetch",
      source: "grok",
      ready: tools.has("web_fetch"),
      description: "Grok native page fetch/browse tool.",
      unavailableHint: "Waiting for Grok to advertise native web_fetch.",
    },
    {
      id: "x_search",
      name: "X Search",
      toolName: hasMcpBridge ? "use_tool -> x_search" : "grok-shell-host__x_search",
      source: "shellx",
      ready: xSearchReady,
      description: "ShellX host-MCP X post search via Grok OAuth.",
      unavailableHint: "Waiting for Grok to initialize ShellX host MCP.",
    },
  ];
}
