/**
 * src/types/acp.ts
 *
 * TypeScript types for the events `acp.rs` emits to the renderer.
 * Derived from real captures in `evidence/session-NNN.jsonl`, not from
 * any ACP spec docs or prior project assumptions.
 *
 * Anchor for changes: if you find a wire shape this doesn't model,
 * grep the new event type in `evidence/wire-shape.md` first — if it's
 * not there, capture it before typing it.
 */

// ──────────────────────────── ACP wire frames ────────────────────────────

export type SessionUpdateKind =
  | "agent_thought_chunk"
  | "agent_message_chunk"
  | "tool_call"
  | "tool_call_update"
  | "tool_call_delta_chunk"
  | "available_commands_update"
  | "session_summary_generated"
 // Catch-all for future updates we haven't observed yet.
  | (string & {});

/** Content block inside a session/update.update.content (single object). */
export interface AcpContentText {
  type: "text";
  text: string;
}

export interface AcpContentDiff {
  type: "diff";
  path: string;
  oldText: string;
  newText: string;
  _meta?: { details?: unknown };
}

export interface AcpContentImage {
  type: "image";
  data?: string; // base64
  mimeType?: string;
}

export type AcpContent =
  | AcpContentText
  | AcpContentDiff
  | AcpContentImage
  | { type: string; [k: string]: unknown };

/**
 * `_meta` envelope. **Lives at `params._meta` (sibling of `update`)**,
 * NOT inside `update`. See `evidence/wire-shape.md` for samples.
 */
export interface AcpMeta {
  totalTokens?: number;
  eventId?: string;
  agentTimestampMs?: number;
  promptId?: string;
  streamStartMs?: number;
  turnStartMs?: number;
  updateType?: string;
  chunkId?: number;
 /**
 * For `tool_call` notifications, status/kind live here (not on `update`).
 * For `tool_call_update`, status is usually inline on `update`.
 */
  updateParams?: {
    toolCallId?: string;
    title?: string;
    kind?: string;
    status?: string;
  };
  [k: string]: unknown;
}

/** Inner `update` payload of a `session/update` notification. */
export interface SessionUpdatePayload {
  sessionUpdate: SessionUpdateKind;
 // chunk-style updates have a single content object (NOT an array)
  content?: AcpContent | AcpContent[];
 // tool_call-style
  toolCallId?: string;
  title?: string;
  status?: string;
  kind?: string;
  rawInput?: unknown;
  rawOutput?: unknown;
 // tool_call_delta_chunk uses snake_case for id
  tool_call_id?: string;
  tool_index?: number;
  name?: string;
  arguments_delta?: string;
 // available_commands_update
  availableCommands?: AcpCommand[];
 // session_summary_generated
  session_summary?: string;
 // locations on tool_call_update content
  locations?: unknown[];
 // Fallback for unmapped fields.
  [k: string]: unknown;
}

export interface AcpCommand {
  name: string;
  description: string;
  input: { hint?: string } | null;
  _meta?: {
    scope?: "user" | "system" | string;
    path?: string;
  };
}

// ──────────────────────────── Tauri events ────────────────────────────

/** Raw ACP frame as emitted on the "grok-acp-event" Tauri event. */
export interface GrokAcpEvent {
  type: "notification" | string;
  method: string; // "session/update", "_x.ai/...", "fs/read_text_file", etc.
  params: {
    sessionId?: string;
    update?: SessionUpdatePayload;
    [k: string]: unknown;
  };
}

/** "session-update" Tauri event — convenience wrap with .update set. */
export interface WrappedSessionUpdate {
  update: {
    sessionId?: string;
    update?: SessionUpdatePayload;
    [k: string]: unknown;
  };
}

export interface GrokStderr {
  line: string;
}

export interface ToolCallEvent {
  type: string;
  status?: "running" | "success" | "error" | string;
  path?: string;
  command?: string;
  stdout?: string;
  stderr?: string;
  [k: string]: unknown;
}

// ──────────────────────────── Debug API frames ────────────────────────────

/**
 * Frame shape on the /events WebSocket and /events/recent JSON. Mirrors
 * Rust's `debug_api::RawEvent` struct. Same shape regardless of which
 * Tauri channel the event came from.
 */
export interface RawEventFrame {
  t: number;
  kind: string; // "grok-acp-event" | "session-update" | "tool-call" | "grok-stderr" | …
  payload: unknown;
}

// ──────────────────────────── Helpers ────────────────────────────

/** Extract { method, sessionUpdate, contentText } from any frame. */
export function classifyFrame(frame: unknown): {
  method?: string;
  sessionUpdate?: string;
  textChunk?: string;
  promptId?: string;
  chunkId?: number;
  toolCallId?: string;
} {
  if (frame == null || typeof frame !== "object") return {};
  const p = frame as any;
  const method: string | undefined = p.method;
  const params = p.params;
  let update: SessionUpdatePayload | undefined;
  if (params && typeof params === "object" && params.update && typeof params.update === "object") {
    update = params.update as SessionUpdatePayload;
  }
  const su = update?.sessionUpdate;
  let textChunk: string | undefined;
  const c = update?.content;
  if (c && typeof c === "object" && !Array.isArray(c) && (c as any).type === "text") {
    textChunk = (c as AcpContentText).text;
  } else if (Array.isArray(c) && c.length > 0 && (c[0] as any).type === "text") {
    textChunk = (c[0] as AcpContentText).text;
  }
  return {
    method,
    sessionUpdate: typeof su === "string" ? su : undefined,
    textChunk,
    promptId: typeof p?.params?._meta?.promptId === "string"
      ? p.params._meta.promptId
      : undefined,
    chunkId: typeof p?.params?._meta?.chunkId === "number"
      ? p.params._meta.chunkId
      : undefined,
    toolCallId:
      typeof update?.toolCallId === "string"
        ? update.toolCallId
        : typeof update?.tool_call_id === "string"
          ? (update.tool_call_id as string)
          : undefined,
  };
}
