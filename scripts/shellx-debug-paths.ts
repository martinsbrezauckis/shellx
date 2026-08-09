import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ShellxDebugApiConnection {
  base: string;
  token: string;
}

export interface ShellxDebugApiConnectionOptions {
  base?: string | null;
  port?: string | null;
  token?: string | null;
  probePath?: string;
  timeoutMs?: number;
  homeCandidates?: string[];
}

interface ShellxDebugApiCandidate extends ShellxDebugApiConnection {
  source: string;
}

function wslWindowsShellxHomes(): string[] {
  const usersRoot = "/mnt/c/Users";
  let entries: string[];
  try {
    entries = readdirSync(usersRoot);
  } catch {
    return [];
  }
  return entries
    .filter((name) => !["All Users", "Default", "Default User", "Public"].includes(name))
    .map((name) => join(usersRoot, name, ".shellx"))
    .filter((dir) => existsSync(dir));
}

export function shellxHomeCandidates(): string[] {
  return [
    process.env.SHELLX_HOME,
    join(homedir(), ".shellx"),
    ...wslWindowsShellxHomes(),
  ].filter((entry): entry is string => Boolean(entry));
}

export function shellxDataPaths(file: string): string[] {
  return shellxHomeCandidates().map((dir) => join(dir, file));
}

function readFirst(paths: string[]): string | null {
  for (const path of paths) {
    if (!existsSync(path)) continue;
    const value = readFileSync(path, "utf8").trim();
    if (value) return value;
  }
  return null;
}

function tokenFromShellxHome(dir: string): string | null {
  return readFirst([
    join(dir, "debug.token"),
    join(dir, "shellxagent.token"),
  ]);
}

export function debugApiConnectionCandidates(
  options: ShellxDebugApiConnectionOptions = {},
): ShellxDebugApiCandidate[] {
  const homes = options.homeCandidates ?? shellxHomeCandidates();
  const explicitBase = options.base?.trim() || process.env.SHELLX_DEBUG_BASE?.trim() || null;
  const port = options.port?.trim() || process.env.SHELLX_DEBUG_PORT?.trim() || null;
  const explicitToken = options.token?.trim()
    || process.env.SHELLX_DEBUG_SECRET?.trim()
    || process.env.SHELLX_DEBUG_TOKEN?.trim()
    || null;

  if (explicitBase || port) {
    const base = explicitBase ?? `http://127.0.0.1:${port}`;
    if (explicitToken) return [{ base, token: explicitToken, source: "explicit" }];
    return homes
      .map((dir) => {
        const token = tokenFromShellxHome(dir);
        return token ? { base, token, source: dir } : null;
      })
      .filter((candidate): candidate is ShellxDebugApiCandidate => Boolean(candidate));
  }

  return homes
    .map((dir) => {
      const homePort = readFirst([join(dir, "debug-api.port")]);
      const token = tokenFromShellxHome(dir);
      if (!homePort || !token) return null;
      return {
        base: `http://127.0.0.1:${homePort}`,
        token,
        source: dir,
      };
    })
    .filter((candidate): candidate is ShellxDebugApiCandidate => Boolean(candidate));
}

async function debugApiCandidateReachable(
  candidate: ShellxDebugApiCandidate,
  probePath: string,
  timeoutMs: number,
): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${candidate.base}${probePath}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${candidate.token}` },
      signal: controller.signal,
    });
    const reachable = response.ok;
    // This probe cares only about the status. Explicitly release the response
    // body so Node/Undici cannot retain a keep-alive handle after a short-lived
    // release-gate CLI has finished its real request.
    await response.body?.cancel();
    return reachable;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

export async function resolveShellxDebugApiConnection(
  options: ShellxDebugApiConnectionOptions = {},
): Promise<ShellxDebugApiConnection> {
  const candidates = debugApiConnectionCandidates(options);
  if (candidates.length === 0) {
    throw new Error("ShellX Debug API port/token not found. Start ShellX or set SHELLX_DEBUG_BASE.");
  }
  const probePath = options.probePath ?? "/browser/state";
  const timeoutMs = options.timeoutMs ?? 1500;
  for (const candidate of candidates) {
    if (await debugApiCandidateReachable(candidate, probePath, timeoutMs)) {
      return { base: candidate.base, token: candidate.token };
    }
  }
  const tried = candidates.map((candidate) => `${candidate.base} (${candidate.source})`).join(", ");
  throw new Error(`No reachable ShellX Debug API candidate found. Tried: ${tried}`);
}
