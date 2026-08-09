import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type {
  ReleaseSurfaceDriverRequest,
} from "../lib/release-surface-driver-protocol";

export type DebugApiSessionFixture = {
  id: string;
  marker: string;
  title: string;
  path: string;
};

export function prepareDebugApiSessionFixture(
  request: ReleaseSurfaceDriverRequest,
  idSuffix?: string,
): DebugApiSessionFixture {
  const tokenPath = nodeReadablePath(request.runtime.debugTokenPath, request.platform);
  const sessionDir = join(dirname(tokenPath), "sessions");
  mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
  const commitSegment = request.sourceCommit.slice(0, 16).replace(/[^a-f0-9]/g, "0");
  const suffix = idSuffix?.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
  const id = `release_session_${commitSegment}${suffix ? `_${suffix}` : ""}`;
  const marker = `SHELLX_RELEASE_SESSION_CANARY_${commitSegment}`;
  const title = `Release session history ${commitSegment}`;
  const splitAt = Math.floor(marker.length / 2);
  const records = [
    {
      t: 1_000,
      payload: { params: { update: { sessionUpdate: "session_summary_generated", session_summary: title } } },
    },
    {
      t: 2_000,
      payload: { params: { update: { sessionUpdate: "agent_message_chunk", content: { text: marker.slice(0, splitAt) } } } },
    },
    {
      t: 2_001,
      payload: { params: { update: { sessionUpdate: "agent_message_chunk", content: { text: marker.slice(splitAt) } } } },
    },
  ];
  const path = join(sessionDir, `${id}.jsonl`);
  writeFileSync(path, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  return { id, marker, title, path };
}

export function cleanupDebugApiSessionFixture(fixture: DebugApiSessionFixture): string | null {
  try {
    if (existsSync(fixture.path)) rmSync(fixture.path);
    if (existsSync(fixture.path)) throw new Error("owned session JSONL remained after deletion");
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

export function isDebugApiSessionFixturePath(path: string): boolean {
  return path === "/sessions/history"
    || path === "/sessions/search"
    || path === "/sessions/history/:id"
    || path === "/sessions/:id/snippet";
}

export function debugApiSessionRequestPath(
  path: string,
  fixture: DebugApiSessionFixture | null,
): string {
  if (!isDebugApiSessionFixturePath(path)) return path;
  const owned = requireFixture(fixture);
  if (path === "/sessions/history") return path;
  if (path === "/sessions/search") {
    return `${path}?q=${encodeURIComponent(owned.marker)}&limit=1`;
  }
  if (path === "/sessions/history/:id") {
    return `/sessions/history/${encodeURIComponent(owned.id)}`;
  }
  return `/sessions/${encodeURIComponent(owned.id)}/snippet?q=${encodeURIComponent(owned.marker)}&ctxLines=2`;
}

export function verifyDebugApiSessionJson(
  path: string,
  value: unknown,
  fixture: DebugApiSessionFixture | null,
): string | null {
  if (!isDebugApiSessionFixturePath(path) || path === "/sessions/history/:id") return null;
  const owned = requireFixture(fixture);
  const body = requireObject(value, path);
  if (path === "/sessions/history") {
    const sessions = requireArray(body, "sessions", path).map((row) => requireObject(row, `${path}.session`));
    const match = sessions.find((row) => row.id === owned.id);
    if (!match || match.title !== owned.title || !Number.isSafeInteger(match.tMs)
      || !Number.isSafeInteger(match.sizeBytes) || Number(match.sizeBytes) <= 0) {
      throw new Error("session history omitted the exact owned session metadata");
    }
    return `Session history found one exact owned JSONL session among ${sessions.length} bounded row(s); identity and title were not retained.`;
  }
  if (path === "/sessions/search") {
    if (body.query !== owned.marker) throw new Error("session search did not preserve its exact query identity");
    const results = requireArray(body, "results", path).map((row) => requireObject(row, `${path}.result`));
    const match = results.find((row) => row.id === owned.id);
    if (!match || match.matchCount !== 1 || typeof match.snippet !== "string"
      || !match.snippet.includes(owned.marker)) {
      throw new Error("session search omitted the exact owned canary match");
    }
    return "Session search found one exact cross-event text canary with a bounded match count and snippet; query, identity, and content were not retained.";
  }
  if (body.id !== owned.id || body.query !== owned.marker) {
    throw new Error("session snippet did not preserve its exact owned request identity");
  }
  const hits = requireArray(body, "hits", path).map((row) => requireObject(row, `${path}.hit`));
  if (hits.length !== 1 || !Number.isSafeInteger(hits[0]!.tMs)
    || typeof hits[0]!.around !== "string" || !hits[0]!.around.includes(`<mark>${owned.marker}</mark>`)) {
    throw new Error("session snippet omitted the exact marked canary context");
  }
  return "Session snippet returned one timestamped, bounded marked context for the exact owned session; query, identity, and content were not retained.";
}

export function verifyDebugApiSessionHistory(
  body: string,
  fixture: DebugApiSessionFixture | null,
): string {
  const owned = requireFixture(fixture);
  const records = body.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
  if (records.length !== 3) throw new Error("raw session history did not return the exact owned JSONL records");
  const text = records.map((record) => {
    const payload = record.payload as Record<string, unknown> | undefined;
    const params = payload?.params as Record<string, unknown> | undefined;
    const update = params?.update as Record<string, unknown> | undefined;
    const content = update?.content as Record<string, unknown> | undefined;
    return typeof content?.text === "string" ? content.text : "";
  }).join("");
  const titleRecord = records.find((record) => {
    const payload = record.payload as Record<string, unknown> | undefined;
    const params = payload?.params as Record<string, unknown> | undefined;
    const update = params?.update as Record<string, unknown> | undefined;
    return update?.session_summary === owned.title;
  });
  if (text !== owned.marker || !titleRecord) {
    throw new Error("raw session history omitted the exact split canary or title record");
  }
  return "Raw session history returned exactly three normalized JSONL records with the owned title and split text canary; identity and content were not retained.";
}

export function verifyTauriSessionJsonl(
  command: "read_session_jsonl" | "read_session_jsonl_tail",
  value: unknown,
  fixture: DebugApiSessionFixture | null,
): string {
  const owned = requireFixture(fixture);
  if (command === "read_session_jsonl") {
    if (!Array.isArray(value) || value.some((line) => typeof line !== "string")) {
      throw new Error("read_session_jsonl did not return an array of JSONL records");
    }
    return verifyDebugApiSessionHistory(value.join("\n"), owned);
  }
  const body = requireObject(value, command);
  const lines = requireArray(body, "lines", command);
  if (body.omittedLines !== 1 || lines.length !== 2 || lines.some((line) => typeof line !== "string")) {
    throw new Error("read_session_jsonl_tail did not return the exact bounded two-record tail");
  }
  const text = lines.map((line) => {
    const record = JSON.parse(String(line)) as Record<string, unknown>;
    const payload = record.payload as Record<string, unknown> | undefined;
    const params = payload?.params as Record<string, unknown> | undefined;
    const update = params?.update as Record<string, unknown> | undefined;
    const content = update?.content as Record<string, unknown> | undefined;
    return typeof content?.text === "string" ? content.text : "";
  }).join("");
  if (text !== owned.marker) throw new Error("read_session_jsonl_tail omitted the exact split canary");
  return "Installed IPC returned the exact newest two JSONL records and one omitted-record count; identity and content were not retained.";
}

export function nodeReadablePath(
  path: string,
  platform: ReleaseSurfaceDriverRequest["platform"],
): string {
  if (platform !== "windows-installed" || process.platform === "win32" || !/^[A-Za-z]:[\\/]/.test(path)) {
    return resolve(path);
  }
  const result = spawnSync("wslpath", ["-u", path], { encoding: "utf8" });
  if (result.status !== 0 || !result.stdout.trim()) throw new Error("unable to map the Debug API token path for the session fixture");
  return resolve(result.stdout.trim());
}

function requireFixture(value: DebugApiSessionFixture | null): DebugApiSessionFixture {
  if (!value) throw new Error("owned session fixture is unavailable");
  return value;
}

function requireArray(body: Record<string, unknown>, key: string, path: string): unknown[] {
  const value = body[key];
  if (!Array.isArray(value)) throw new Error(`${path} did not return a ${key} array`);
  return value;
}

function requireObject(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} did not return an object`);
  return value as Record<string, unknown>;
}
