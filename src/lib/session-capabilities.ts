import type { RawEventFrame } from "../types/acp";

export interface SearchCapability {
  id: "web_search" | "web_fetch" | "x_search" | "desktop_control" | "code_intelligence";
  name: string;
  toolName: string;
  source: "native" | "shellx";
  ready: boolean;
  description: string;
  unavailableHint: string;
}

export interface CapabilityContext {
  hasProviderContext?: boolean;
  providerId?: string | null;
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

export function extractProviderSessionToolNames(events: RawEventFrame[]): Set<string> {
  const names = new Set<string>();
  for (const event of events) {
    if (!event || event.kind !== "provider-session-event") continue;
    const payload = event.payload as any;
    if (payload?.kind !== "mcpTool" && payload?.kind !== "tool") continue;
    const text = typeof payload.text === "string" ? payload.text : "";
    const rawType = typeof payload.rawType === "string" ? payload.rawType : "";
    for (const value of [text, rawType]) {
      for (const token of value.split(/[^A-Za-z0-9_.:-]+/)) {
        const trimmed = token.trim();
        if (trimmed) names.add(trimmed);
      }
    }
  }
  return names;
}

export function hasProviderShellxMcpContext(
  events: RawEventFrame[],
  _context: CapabilityContext = {},
): boolean {
  const providerTools = extractProviderSessionToolNames(events);
  return [...providerTools].some((name) => {
    const lower = name.toLowerCase();
    return lower.includes("shellx-host") || lower.includes("shellx_host") || lower.includes("mcp__shellx");
  });
}

export function grokSearchCapabilities(
  events: RawEventFrame[],
  context: CapabilityContext = {},
): SearchCapability[] {
  const hasProviderContext =
    context.hasProviderContext === true &&
    Boolean(context.providerId) &&
    context.providerId !== "grok";
  const tools = hasProviderContext ? new Set<string>() : extractAdvertisedToolNames(events);
  const providerTools = hasProviderContext ? extractProviderSessionToolNames(events) : new Set<string>();
  const hasMcpBridge = tools.has("use_tool") && hasInitializedMcpBridge(events);
  const hasProviderMcp = hasProviderShellxMcpContext(events, context);
  const providerToolReady = (name: string): boolean => {
    const normalized = name.replace(/[-_]/g, "").toLowerCase();
    return [...providerTools].some((tool) =>
      tool.replace(/[-_]/g, "").toLowerCase() === normalized
    );
  };
  const webSearchReady = hasProviderContext ? providerToolReady("web_search") : tools.has("web_search");
  const webFetchReady = hasProviderContext ? providerToolReady("web_fetch") : tools.has("web_fetch");
  const xSearchReady = tools.has("grok-shell-host__x_search")
    || tools.has("x_search")
    || hasMcpBridge
    || hasProviderMcp;
  return [
    {
      id: "web_search",
      name: "Web Search",
      toolName: "web_search",
      source: "native",
      ready: webSearchReady,
      description: hasProviderContext
        ? "Provider-native web search when the selected provider exposes it in the ShellX stream."
        : "Native real-time web search with citations when the selected agent advertises it.",
      unavailableHint: hasProviderContext
        ? "No provider-native web_search call has appeared in this session yet."
        : "Waiting for the active agent to advertise web_search.",
    },
    {
      id: "web_fetch",
      name: "Web Fetch",
      toolName: "web_fetch",
      source: "native",
      ready: webFetchReady,
      description: hasProviderContext
        ? "Provider-native page fetch/browse when the selected provider exposes it in the ShellX stream."
        : "Native page fetch/browse tool when the selected agent advertises it.",
      unavailableHint: hasProviderContext
        ? "No provider-native web_fetch call has appeared in this session yet."
        : "Waiting for the active agent to advertise web_fetch.",
    },
    {
      id: "x_search",
      name: "X Search",
      toolName: hasProviderMcp ? "shellx-host-http -> x_search" : hasMcpBridge ? "use_tool -> x_search" : "grok-shell-host__x_search",
      source: "shellx",
      ready: xSearchReady,
      description: "ShellX host-MCP X post search via Grok OAuth.",
      unavailableHint: "Waiting for the active agent to initialize ShellX host MCP.",
    },
  ];
}

export function shellxRuntimeCapabilities(events: RawEventFrame[]): SearchCapability[] {
  const tools = extractAdvertisedToolNames(events);
  const providerTools = extractProviderSessionToolNames(events);
  const leafTools = [...tools, ...providerTools].map(toolLeafName);
  const desktopTools = leafTools.filter((name) => name.startsWith("desktop_"));
  const codeTools = leafTools.filter(isCodeIntelligenceTool);
  return [
    {
      id: "desktop_control",
      name: "Desktop Control",
      toolName: desktopTools[0] ?? "desktop_*",
      source: "shellx",
      ready: desktopTools.length > 0,
      description: "Desktop smoke/control tools for screenshots, app evidence, and keyboard or mouse automation.",
      unavailableHint: "Waiting for a desktop MCP server to advertise desktop_* tools.",
    },
    {
      id: "code_intelligence",
      name: "Code Intelligence",
      toolName: codeTools[0] ?? "lsp_*",
      source: "shellx",
      ready: codeTools.length > 0,
      description: "Language-aware tools for symbols, definitions, references, and diagnostics.",
      unavailableHint: "Waiting for an LSP/code-intelligence tool provider in this session.",
    },
  ];
}

function toolLeafName(name: string): string {
  const raw = name.split("__").pop() ?? name;
  return raw.trim();
}

function isCodeIntelligenceTool(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.startsWith("lsp_")
    || lower.includes("code_intelligence")
    || lower === "symbol_search"
    || lower === "find_references"
    || lower === "goto_definition";
}
