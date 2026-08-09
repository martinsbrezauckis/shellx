/**
 * src/types/acp.ts
 *
 * TypeScript types for the events `acp.rs` emits to the renderer.
 * Provider extensions are grounded in real captures under `evidence/`;
 * standard events are also checked against the current ACP specification.
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
  | "current_mode_update"
  | "plan"
  | "session_summary_generated"
  | "session_info_update"
  | "verification_started"
  | "verification_completed"
  | "best_of_n_started"
  | "best_of_n_completed"
  | "model_auto_switched"
  | "task_backgrounded"
  | "subagent_spawned"
  | "subagent_progress"
  | "subagent_finished"
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

/** Inner `update` payload of a `session/update` notification. */
export interface SessionUpdatePayload {
  sessionUpdate: SessionUpdateKind;
 // chunk-style updates have a single content object (NOT an array)
  content?: AcpContent | AcpContent[];
 // tool_call-style
  toolCallId?: string;
  title?: string | null;
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
 // session_info_update
  updatedAt?: string | null;
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

export function parseRawEventFrame(value: unknown): RawEventFrame | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const t = Reflect.get(value, "t");
  const kind = Reflect.get(value, "kind");
  if (typeof t !== "number" || !Number.isFinite(t)) return null;
  if (typeof kind !== "string" || !kind.trim()) return null;
  return {
    t,
    kind,
    payload: Reflect.get(value, "payload"),
  };
}
