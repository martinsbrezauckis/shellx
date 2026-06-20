import { existsSync, readFileSync } from "node:fs";
import { shellxDataPaths } from "./shellx-debug-paths";

type JsonObject = Record<string, unknown>;
type FlagValue = string | true;

interface ParsedArgs {
  command: string;
  positional: string[];
  flags: Record<string, FlagValue>;
}

interface DebugApiConnection {
  base: string;
  token: string;
}

function readFirst(paths: string[]): string | null {
  for (const path of paths) {
    if (!existsSync(path)) continue;
    const value = readFileSync(path, "utf8").trim();
    if (value) return value;
  }
  return null;
}

function readDebugApiConnection(flags: Record<string, FlagValue>): DebugApiConnection {
  const explicitBase = stringFlag(flags, "base") ?? process.env.SHELLX_DEBUG_BASE?.trim();
  const port = stringFlag(flags, "port")
    ?? process.env.SHELLX_DEBUG_PORT?.trim()
    ?? readFirst(shellxDataPaths("debug-api.port"));
  const token = stringFlag(flags, "token")
    ?? process.env.SHELLX_DEBUG_SECRET?.trim()
    ?? process.env.SHELLX_DEBUG_TOKEN?.trim()
    ?? readFirst(shellxDataPaths("shellxagent.token"))
    ?? readFirst(shellxDataPaths("debug.token"));

  if (!explicitBase && !port) {
    throw new Error("ShellX Debug API port not found. Start ShellX or set SHELLX_DEBUG_BASE.");
  }
  if (!token) {
    throw new Error("ShellX Debug API token not found. Start ShellX or set SHELLX_DEBUG_SECRET.");
  }
  return {
    base: explicitBase ?? `http://127.0.0.1:${port}`,
    token,
  };
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command = "help", ...rest] = argv;
  const positional: string[] = [];
  const flags: Record<string, FlagValue> = {};
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i] ?? "";
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const flag = arg.slice(2);
    const equalsAt = flag.indexOf("=");
    if (equalsAt >= 0) {
      flags[flag.slice(0, equalsAt)] = flag.slice(equalsAt + 1);
      continue;
    }
    const next = rest[i + 1];
    if (next && !next.startsWith("--")) {
      flags[flag] = next;
      i += 1;
    } else {
      flags[flag] = true;
    }
  }
  return { command, positional, flags };
}

function stringFlag(flags: Record<string, FlagValue>, key: string): string | null {
  const value = flags[key];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function boolFlag(flags: Record<string, FlagValue>, key: string): boolean {
  const value = flags[key];
  if (value === true) return true;
  if (typeof value !== "string") return false;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function commonActionFields(flags: Record<string, FlagValue>): JsonObject {
  return cleanBody({
    browserTabId: stringFlag(flags, "tab") ?? stringFlag(flags, "browser-tab-id"),
    taskId: stringFlag(flags, "task") ?? stringFlag(flags, "task-id"),
    selector: stringFlag(flags, "selector"),
    lockLeaseId: stringFlag(flags, "lease") ?? stringFlag(flags, "lock-lease-id"),
    ownerAgentId: stringFlag(flags, "owner-agent") ?? stringFlag(flags, "owner-agent-id"),
    ownerRunId: stringFlag(flags, "owner-run") ?? stringFlag(flags, "owner-run-id"),
  });
}

function cleanBody(body: JsonObject): JsonObject {
  return Object.fromEntries(
    Object.entries(body).filter(([, value]) => value !== undefined && value !== null && value !== ""),
  );
}

async function callDebugApi<T>(
  connection: DebugApiConnection,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const response = await fetch(`${connection.base}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${connection.token}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const parsed = text.trim() ? JSON.parse(text) as unknown : {};
  if (!response.ok) {
    const message = typeof parsed === "object" && parsed && "error" in parsed
      ? String((parsed as { error?: unknown }).error)
      : text;
    throw new Error(`${method} ${path} failed with HTTP ${response.status}: ${message}`);
  }
  return parsed as T;
}

async function runCommand(parsed: ParsedArgs): Promise<unknown> {
  if (parsed.command === "help" || parsed.command === "--help" || parsed.command === "-h") {
    return { usage: usageLines() };
  }

  const connection = readDebugApiConnection(parsed.flags);
  switch (parsed.command) {
    case "snapshot":
      return callDebugApi(connection, "GET", "/browser/state");
    case "tabs":
      return callDebugApi(connection, "GET", "/browser/tabs");
    case "locks": {
      const tabs = await callDebugApi<{ tabs?: Array<JsonObject> }>(connection, "GET", "/browser/tabs");
      return {
        locks: (tabs.tabs ?? [])
          .filter((tab) => Boolean(tab.lock))
          .map((tab) => ({
            browserTabId: tab.browserTabId,
            taskId: tab.taskId,
            url: tab.url,
            lock: tab.lock,
          })),
      };
    }
    case "navigate": {
      const url = requiredPositional(parsed, 0, "url");
      return browserAction(connection, {
        ...commonActionFields(parsed.flags),
        action: "navigate",
        url,
      });
    }
    case "observe":
      return browserAction(connection, {
        ...commonActionFields(parsed.flags),
        action: "observe",
      });
    case "click-ref": {
      const refId = requiredPositional(parsed, 0, "refId");
      return browserAction(connection, {
        ...commonActionFields(parsed.flags),
        action: "clickRef",
        refId,
      });
    }
    case "fill-ref": {
      const refId = requiredPositional(parsed, 0, "refId");
      const value = requiredPositional(parsed, 1, "value");
      return browserAction(connection, {
        ...commonActionFields(parsed.flags),
        action: "fillRef",
        refId,
        value,
      });
    }
    case "fill-from-vault": {
      const refId = requiredPositional(parsed, 0, "refId");
      const grantId = requiredPositional(parsed, 1, "grantId");
      const secretRef = requiredPositional(parsed, 2, "secretRef");
      return browserAction(connection, {
        ...commonActionFields(parsed.flags),
        action: "fillFromVaultGrant",
        refId,
        grantId,
        secretRef,
      });
    }
    case "wait-for": {
      const key = requiredPositional(parsed, 0, "key");
      const value = requiredPositional(parsed, 1, "value");
      return browserAction(connection, {
        ...commonActionFields(parsed.flags),
        action: "waitFor",
        key,
        value,
      });
    }
    case "extract": {
      const format = requiredPositional(parsed, 0, "text|markdown");
      const action = format === "markdown" ? "extractMarkdown" : format === "text" ? "extractText" : null;
      if (!action) throw new Error("extract format must be text or markdown");
      return browserAction(connection, {
        ...commonActionFields(parsed.flags),
        action,
      });
    }
    case "verify": {
      const key = requiredPositional(parsed, 0, "key");
      const value = requiredPositional(parsed, 1, "value");
      return browserAction(connection, {
        ...commonActionFields(parsed.flags),
        action: "verify",
        key,
        value,
      });
    }
    case "screenshot":
      return browserAction(connection, {
        ...commonActionFields(parsed.flags),
        action: "captureScreenshot",
        fullPage: boolFlag(parsed.flags, "full-page") || boolFlag(parsed.flags, "fullPage"),
      });
    case "trace-open":
      return callDebugApi(connection, "POST", "/browser/trace/export", cleanBody({
        taskId: stringFlag(parsed.flags, "task") ?? stringFlag(parsed.flags, "task-id"),
        browserTabId: stringFlag(parsed.flags, "tab") ?? stringFlag(parsed.flags, "browser-tab-id"),
        reason: stringFlag(parsed.flags, "reason") ?? "ShellX Browser CLI trace-open",
      }));
    default:
      throw new Error(`Unknown ShellX Browser command: ${parsed.command}`);
  }
}

function browserAction(connection: DebugApiConnection, body: JsonObject): Promise<unknown> {
  return callDebugApi(connection, "POST", "/browser/action", body);
}

function requiredPositional(parsed: ParsedArgs, index: number, label: string): string {
  const value = parsed.positional[index]?.trim();
  if (!value) throw new Error(`${parsed.command} requires ${label}`);
  return value;
}

function usageLines(): string[] {
  return [
    "pnpm shellx-browser snapshot",
    "pnpm shellx-browser navigate https://example.com --tab <browserTabId>",
    "pnpm shellx-browser observe --tab <browserTabId>",
    "pnpm shellx-browser click-ref <refId> --task <taskId>",
    "pnpm shellx-browser fill-ref <refId> <value> --task <taskId>",
    "pnpm shellx-browser fill-from-vault <refId> <grantId> <secretRef> --task <taskId>",
    "pnpm shellx-browser wait-for text <value>",
    "pnpm shellx-browser extract markdown --selector main",
    "pnpm shellx-browser verify text <value>",
    "pnpm shellx-browser screenshot --full-page --task <taskId>",
    "pnpm shellx-browser tabs",
    "pnpm shellx-browser locks",
    "pnpm shellx-browser trace-open --task <taskId>",
  ];
}

function printResult(result: unknown, pretty: boolean): void {
  console.log(JSON.stringify(result, null, pretty ? 2 : 0));
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  const result = await runCommand(parsed);
  printResult(result, parsed.flags.pretty === true);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
