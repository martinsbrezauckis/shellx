/**
 * src/lib/grouping.ts
 *
 * Pure event-stream → UI-group transformation. Used by the P4 center
 * pane to collapse the noisy raw stream (≈530 events/turn) into a
 * scan-friendly conversation view.
 *
 * Grouping rules (calibrated against `evidence/wire-shape.md`, NOT
 * against prior code's fake fixtures):
 * • Consecutive `agent_thought_chunk`s sharing the same `promptId`
 * collapse into ONE "thought" group with concatenated text.
 * • Same for `agent_message_chunk` → "message" group.
 * • `tool_call` opens a "tool" group keyed by `toolCallId`.
 * Subsequent `tool_call_update`s for that id update the group's
 * status + content (diff). `tool_call_delta_chunk`s are absorbed
 * pre-execution as args streaming — we show the assembled args on
 * the group, not 5 separate rows.
 * • `available_commands_update` → single "system" pill (latest wins).
 * • `session_summary_generated` → "system" pill with the summary text.
 * • Named `_x.ai/*` lifecycle events get dedicated groups; unhandled
 * vendor/ACP envelopes stay out of the chat surface.
 * • Stderr / lifecycle / permission / ui channel events → "system"
 * pill (one per event).
 *
 * Low-signal raw envelopes are dropped from the conversation view only.
 * The raw event ring/log panes keep the unfiltered stream for audit.
 *
 * Accumulation key is `promptId` from `_meta`, NOT a 15-second window.
 * The prior code's window heuristic was wrong (chunks can take longer
 * than 15s during reasoning; promptId is authoritative).
 */
import type { RawEventFrame, SessionUpdatePayload } from "../types/acp";
import { extractGeneratedMediaPath } from "./media-paths";

export type UiGroupKind =
  | "thought"
  | "message"
  | "tool"
  | "system"
  | "vendor"
  | "ui"
 /* Dedicated group kinds for the two lifecycle markers carried on
 * `_x.ai/*` vendor events. Distinct from the generic "system" pill
 * so ChatOutput can give them their own visual treatment
 * (turn-complete checkmark, MCP-init progress spinner). */
  | "marker"
  | "mcp-init"
 /* amber warning
 * chip rendered when grok detects it's stuck repeating a tool. */
  | "doom-loop"
  | "host-mcp-unreachable"
 /* issue #374 — in-chat permission pill that replaces (or augments)
 * the PermissionModal popup. Pending pill carries Allow / Allow-always
 * / Deny buttons; resolved pill shrinks to a one-line audit chip.
 * In bypassPermissions / always-approve modes the pill arrives
 * already-resolved (autoApproved=true on the wire) so the user gets
 * a passive audit trail of what grok did, with no buttons. */
  | "permission";

export interface UiGroupBase {
  id: string;
  kind: UiGroupKind;
  t: number;
 /** Range of underlying event indexes for "show raw" features. */
  sourceFirstIndex: number;
  sourceLastIndex: number;
}

export interface ThoughtGroup extends UiGroupBase {
  kind: "thought";
  promptId: string | undefined;
  text: string;
  chunkCount: number;
 /**
 * chunks keyed by `_meta.chunkId`
 * so out-of-order events still render correctly. Empirical: jsonl
 * shows chunkIds like `1,2,3,4,5,6,7,8,9,10,11,12,13,15,14,16,...`
 * — Tauri-emitter ordering across the wire is not strictly FIFO once
 * grok backpressure kicks in, and rehydration on tab-restore appends
 * older events AFTER live ones. `text` is now derived by sorting
 * this map and joining. `chunksById` is populated for any chunk that
 * carries a numeric `chunkId`; chunks without one fall back to the
 * legacy append-in-arrival-order semantics (none observed in current
 * grok-build 0.1.212 wire, but the fallback is cheap).
 */
  chunksById?: Map<number, string>;
}

export interface MessageGroup extends UiGroupBase {
  kind: "message";
  promptId: string | undefined;
  text: string;
  chunkCount: number;
 /** See ThoughtGroup.chunksById — same shape, same purpose (BUG-D fix). */
  chunksById?: Map<number, string>;
}

export interface ToolGroup extends UiGroupBase {
  kind: "tool";
  toolCallId: string;
  title: string;
  status: string;
  kindLabel: string;       // tool kind from _meta.updateParams.kind ("Other", "edit", …)
  argsJson: string;        // concatenated args from delta_chunks or rawInput
  diffPath?: string;
  diffOldText?: string;
  diffNewText?: string;
 /** image-gen result extracted from rawOutput.text or
 * content[].content.text. grok's image_gen tool writes the image
 * to disk and returns a Text result containing the absolute path
 * (e.g. "Successfully generated image and saved to /home/.../images/1.jpg").
 * We parse the path out so ToolCard can render it via SafeImg. */
  imagePath?: string;
 /** same pattern for video_gen — grok writes the MP4 to
 * the session's `videos/` subdir and returns the path either in the
 * rawOutput.text or as a raw `<video>` markdown blob in the assistant
 * message. ToolCard renders an inline `<video controls>` element. */
  videoPath?: string;
 /** when grok runs a shell command via the
 * ACP `terminal/*` surface, the corresponding tool_call (or any of its
 * subsequent tool_call_update events) carries a content block of
 * shape `{type: "terminal", terminalId: "gs-term-NNNNNNNN"}`. We
 * extract that id so ChatOutput can render a live xterm.js view
 * bound to it via <TerminalView terminalId attachOnly readOnly={false}/>.
 * The defense-in-depth scan (mirrors imagePath/videoPath) looks at both
 * the initial tool_call's `content` array AND every tool_call_update's
 * `content` — grok occasionally inserts the terminal block late. */
  terminalId?: string;
 /** when grok writes a `plan.md` (the right rail
 * PlanPane source), we ALSO want to surface the rendered markdown
 * in the chat output below the diff card. Populated when the
 * diff/write path ends in `/plan.md` — we take the new text from
 * either the diff or rawOutput.text and store it here so ToolCard
 * can render a ReactMarkdown block alongside the standard diff view.
 *
 * Distinct from `diffNewText` (which is the raw new content for
 * the diff renderer): `planMarkdown` is the SAME text but flagged
 * for markdown rendering. Kept as a separate field for clarity —
 * we don't want to render every diff as markdown. */
  planMarkdown?: string;
 /** Generic rawOutput.text body — captured for tool kinds whose
 * result is plain text (fs_read, bash/run_terminal_command stdout,
 * web_fetch HTML/markdown body, fs_list_dir listings, etc.). Renders
 * as a `<pre>` body below the args. Skipped when the output is
 * already represented as an image / video / diff / terminal.  * fix — previously this text was extracted only for image/video path
 * detection and then discarded; users saw "the tool ran" with no
 * visible result body. */
  toolText?: string;
  updateCount: number;     // how many tool_call_update events folded in
}

export interface SystemGroup extends UiGroupBase {
  kind: "system";
  icon: string;
  label: string;
  detail?: string;
}

export interface VendorGroup extends UiGroupBase {
  kind: "vendor";
  method: string;          // e.g. "_x.ai/mcp/init_progress"
  detail: string;
}

/**
 * turn-complete marker. Emitted when the
 * wire delivers `_x.ai/session/prompt_complete` (carries
 * `stopReason: "end_turn"` per the ACP audit §C). Rendered as a small
 * pill anchored to the END of the most recent prompt's group cluster.
 */
export interface MarkerGroup extends UiGroupBase {
  kind: "marker";
 /** "turn-complete" for now; extend if other lifecycle markers join. */
  marker: "turn-complete";
 /** Milliseconds elapsed since the turn's stream start, when known. */
  elapsedMs?: number;
 /** Stop reason from the event payload (typically "end_turn"). */
  stopReason?: string;
 /** PromptId of the turn this marker closes — useful for tests + DOM ids. */
  promptId?: string;
}

/**
 * MCP-init progress + ready group. Renders
 * as a top-of-chat status strip ("MCP init: 3/5 servers" while in
 * progress; "MCP servers ready · 5 tools" once finished).
 */
export interface McpInitGroup extends UiGroupBase {
  kind: "mcp-init";
  connected: number;
  total: number;
 /** True once `_x.ai/mcp_initialized` has fired. */
  ready: boolean;
 /** Tool count from the final `mcp_initialized` payload (when known). */
  mcpToolCount?: number;
 /** Total elapsed init time from the final payload (when known). */
  elapsedMs?: number;
}

/**
 * grok's anti-loop watchdog (4+ observed events
 * in the wire audit) emits `doom_loop_detected` under
 * `_x.ai/session_notification` when a tool has been repeated N times
 * without progress. We surface it as a small amber chip so the user
 * sees the warning inline in the chat instead of having to scrub the
 * raw event pane.
 *
 * Payload shape observed on the wire:
 * { message: string, is_warning: bool, repeat_count: number,
 * tool_names: string[] }
 */
export interface DoomLoopGroup extends UiGroupBase {
  kind: "doom-loop";
  message: string;
  repeatCount: number;
  toolNames: string[];
  isWarning: boolean;
}

/**
 * shellX synthetic warning emitted when Grok reports
 * `Transport closed` for one of the host MCP tools. This is more
 * actionable than a generic failed tool card because it means the
 * whole host-MCP channel is gone, so retries will not help until the
 * tab/session is reconnected.
 */
export interface HostMcpUnreachableGroup extends UiGroupBase {
  kind: "host-mcp-unreachable";
  message: string;
  repeatCount: number;
  toolName?: string;
  goalHalted: boolean;
}

/**
 * In-chat permission gate (issue #374). One PermissionGroup per
 * `session/request_permission` ACP request emitted by grok.
 *
 * Lifecycle:
 * • Inserted as `pending: true` on the first `permission-request`
 * event for the request_id / reqId.
 * • In bypassPermissions/auto modes the same event carries
 * `autoApproved: true` (or `autoDenied: true`) — we initialise the
 * group already-resolved so it renders as a passive audit chip.
 * • In confirm/acceptEdits mode the user clicks one of the pill
 * buttons; PermissionPill posts a synthetic `permission-resolved`
 * event into the events ring, which on the next groupEvents run
 * mutates the matching group to pending:false + decision + decisionAt.
 *
 * `toolName` / `toolArgs` / `cwd` are best-effort summaries pulled from
 * the ACP `params.toolCall` object (when present). Legacy
 * `terminal/create` payloads (request_id + command/args/cwd at the top
 * level) are also accepted so the existing modal-only wire is covered.
 */
export interface PermissionGroup extends UiGroupBase {
  kind: "permission";
 /** Stable id used to reconcile with `permission-resolved` follow-ups
 * and to invoke `resolve_permission_request(requestId, allow)`. */
  requestId: string;
 /** Display name for the tool grok wants to invoke. Falls back to the
 * raw method name (e.g. "terminal/create") when no toolCall info. */
  toolName: string;
 /** One-line preview of the args/command; truncated to keep the pill
 * compact. Full payload remains in the events ring for forensic view. */
  toolArgs: string;
 /** Working directory when the wire carries it; undefined otherwise. */
  cwd?: string;
 /** True while the user has not decided yet (and no auto-decision was
 * applied at emit time). */
  pending: boolean;
 /** Decision once resolved. "allow_always" maps to grok's allow_always
 * optionId; the Rust side picks the option for us. */
  decision?: "allow" | "allow_always" | "deny";
 /** Wall-clock ms when the decision was recorded. */
  decisionAt?: number;
 /** When the auto-decision came from the agent runtime (bypass / plan)
 * rather than a user click — drives the "✓ Auto-allowed" label. */
  autoDecision?: boolean;
 /** Free-form permission mode label from the wire (`bypassPermissions`
 * / `plan` / `default` / `acceptEdits` / …) — surfaced in the audit
 * chip so the user remembers why grok did/didn't pause. */
  permissionMode?: string;
}

export interface UiTextGroup extends UiGroupBase {
  kind: "ui";
  text: string;
 /**
 * when the renderer attached image files, the user
 * bubble carries thumbnail chips next to the text. Paths point at the
 * picked image files (already in scope by handleAttach's copy_to_scope
 * pre-step). Rendering uses SafeImg's asset:// + base64 fallback
 * chain — same one that handles WSL paths from a Windows host. Empty
 * / undefined for normal ui events.
 */
  thumbs?: string[];
}

export type UiGroup =
  | ThoughtGroup
  | MessageGroup
  | ToolGroup
  | SystemGroup
  | VendorGroup
  | UiTextGroup
  | MarkerGroup
  | McpInitGroup
  | DoomLoopGroup
  | HostMcpUnreachableGroup
  | PermissionGroup;

export function groupEvents(events: RawEventFrame[]): UiGroup[] {
  const groups: UiGroup[] = [];
 // Index of the currently-open chunk group per promptId+kind so we can
 // append to it instead of starting a new group.
  let lastChunk:
    | {
        kind: "thought" | "message";
        promptId: string | undefined;
        index: number;
      }
    | null = null;
 // toolCallId → index into groups[] for the open tool card.
 //
 // the raw toolCallId is NOT globally unique
 // across grok turns. Within one turn grok appends `-0`/`-1`/`-2` to
 // disambiguate parallel calls (see evidence/session-005.jsonl), but
 // across turns the suffix resets — so two prompts in a row can both
 // emit `call-abc-0`. The previous Map keyed on raw toolCallId let the
 // second turn's tool_call overwrite the first turn's entry, leaving
 // the first turn's still-in-flight tool stuck in "Pending" status with
 // its later tool_call_updates routed to the second turn's group.
 //
 // Fix: namespace by promptId. `keyFor` below produces
 // `${promptId}::${toolCallId}` when meta has a promptId, falling back
 // to the raw id otherwise (for events without _meta, mostly tests).
  const toolIndex = new Map<string, number>();
  const keyFor = (
    toolCallId: string,
    promptId: string | undefined
  ): string =>
    typeof promptId === "string" && promptId.length > 0
      ? `${promptId}::${toolCallId}`
      : toolCallId;
 // Pending arguments_delta concatenation per tool_index from delta_chunks.
  const pendingArgs = new Map<number, string>();

 // ─── Coalescing state for repetitive low-signal events ───
 // MCP init shows up as 12+ `_x.ai/mcp/init_progress` events ({0/11},
 // {1/11}, ..., {11/11}) plus a final `_x.ai/mcp_initialized`. Render as
 // a single live-updating pill that tracks "starting N/total → ready".
  let mcpProgressGroupIndex: number | null = null;
 // available_commands_update fires multiple times per session with the
 // same count after MCP servers come online. Only push a new pill when
 // the count actually changes.
  let lastCommandsCount: number | null = null;
 // Stderr lines from grok are mostly MCP worker auth failures. Bucket
 // those into a single "N MCP servers failed auth" pill; keep raw rows
 // for everything else.
  let mcpAuthErrorGroupIndex: number | null = null;
  let mcpAuthErrorCount = 0;

 /* track per-promptId stream-start so
 * the MarkerGroup for prompt_complete can stamp its elapsedMs.
 * Captured from every event's `_meta.streamStartMs` — first-write-wins
 * per promptId; the wire keeps the same value for every chunk in the
 * turn (per ACP audit §B). */
  const streamStartByPromptId = new Map<string, number>();

 /* issue #374 — requestId → groups[] index for PermissionGroup so a
 * follow-up `permission-resolved` synthetic event (dispatched by
 * PermissionPill after the user clicks Allow / Deny) can mutate the
 * existing pill to its resolved state instead of pushing a duplicate
 * row. Also lets a late autoApproved/autoDenied re-emit upgrade a
 * pending pill in place. */
  const permissionIndex = new Map<string, number>();

  let seq = 0;
  const nextId = (): string => {
    seq += 1;
    return `g${seq}`;
  };

  events.forEach((ev, evIdx) => {
    const unwrapped = unwrapForGrouping(ev);
    if (!unwrapped) return;
    const { method, sessionUpdate, update, meta } = unwrapped;

 /* cache streamStartMs per promptId. Captured BEFORE
 * any dispatch so the prompt_complete branch can read it back. ACP
 * carries this on every chunk event for the turn — we only need the
 * first one. */
    if (
      typeof meta?.promptId === "string" &&
      typeof meta?.streamStartMs === "number" &&
      !streamStartByPromptId.has(meta.promptId)
    ) {
      streamStartByPromptId.set(meta.promptId, meta.streamStartMs);
    }

 // ─── thought / message chunk accumulation ───
    if (
      method === "session/update" &&
      (sessionUpdate === "agent_thought_chunk" ||
        sessionUpdate === "agent_message_chunk")
    ) {
      const kind: "thought" | "message" =
        sessionUpdate === "agent_thought_chunk" ? "thought" : "message";
      const promptId =
        typeof meta?.promptId === "string" ? meta.promptId : undefined;
      const text = extractText(update) ?? "";
 // chunkId is grok's monotonic per-turn
 // sequence number. Use it to keep accumulation order-independent
 // — wire ordering is NOT FIFO when grok backpressures or when
 // rehydration replays older jsonl events into the live stream.
 // Fallback `null` means "no chunkId on this event" (legacy / hand-
 // crafted events); we still append in arrival order for those.
      const chunkId =
        typeof meta?.chunkId === "number" ? meta.chunkId : null;

      if (
        lastChunk &&
        lastChunk.kind === kind &&
        lastChunk.promptId === promptId
      ) {
        const g = groups[lastChunk.index] as ThoughtGroup | MessageGroup;
        if (chunkId !== null) {
 // Sorted-by-chunkId path. Inserting into the Map then rebuilding
 // `text` from a sorted iteration is O(N log N) per chunk, with
 // N typically ≤ 200 — well under one frame's budget. The
 // map lazily initialises on first chunkId-bearing event so
 // legacy groups created without one still work.
          if (!g.chunksById) g.chunksById = new Map();
 // De-dup: if the same chunkId arrives twice (replay from jsonl
 // rehydration), the second insert silently replaces the first
 // with the same content. No double-append.
          g.chunksById.set(chunkId, text);
          const sortedIds = Array.from(g.chunksById.keys()).sort((a, b) => a - b);
          g.text = sortedIds.map((id) => g.chunksById!.get(id) ?? "").join("");
        } else {
 // Legacy fallback: append in arrival order. Preserves prior
 // behavior for any event source without a chunkId.
          g.text += text;
        }
        g.chunkCount += 1;
        g.sourceLastIndex = evIdx;
        return;
      }
 // seed chunksById on the first chunk of a new
 // group when chunkId is available. Without this, only the
 // second-and-onward chunks would be sorted (first chunk would
 // be in `text` but missing from the map), and one out-of-order
 // delivery of the SECOND chunk could clobber the FIRST.
      const seedMap = chunkId !== null
        ? new Map<number, string>([[chunkId, text]])
        : undefined;
      const grp: ThoughtGroup | MessageGroup =
        kind === "thought"
          ? {
              id: nextId(),
              kind: "thought",
              t: ev.t,
              promptId,
              text,
              chunkCount: 1,
              sourceFirstIndex: evIdx,
              sourceLastIndex: evIdx,
              chunksById: seedMap,
            }
          : {
              id: nextId(),
              kind: "message",
              t: ev.t,
              promptId,
              text,
              chunkCount: 1,
              sourceFirstIndex: evIdx,
              sourceLastIndex: evIdx,
              chunksById: seedMap,
            };
      groups.push(grp);
      lastChunk = { kind, promptId, index: groups.length - 1 };
      return;
    }

 // ─── tool_call_delta_chunk → accumulate args + (maybe) preview row ───
    if (
      method === "_x.ai/session_notification" &&
      sessionUpdate === "tool_call_delta_chunk"
    ) {
 // Resets chunk accumulator so a subsequent message chunk starts fresh.
      lastChunk = null;
      const idx = typeof update?.tool_index === "number" ? update.tool_index : 0;
      const delta =
        typeof update?.arguments_delta === "string"
          ? update.arguments_delta
          : "";
      pendingArgs.set(idx, (pendingArgs.get(idx) ?? "") + delta);
      return;
    }

 // ─── tool_call (open) ───
    if (
      method === "session/update" &&
      sessionUpdate === "tool_call" &&
      typeof update?.toolCallId === "string"
    ) {
      lastChunk = null;
      const id = update.toolCallId;
      const rawInput = update.rawInput;
      const argsJson =
        rawInput != null
          ? safeJson(rawInput)
          : (pendingArgs.get(0) ?? "");
      const status = meta?.updateParams?.status ?? "Pending";
      const kindLabel = meta?.updateParams?.kind ?? "?";
      const grp: ToolGroup = {
        id: nextId(),
        kind: "tool",
        t: ev.t,
        toolCallId: id,
        title:
          typeof update.title === "string" ? update.title : "tool",
        status,
        kindLabel,
        argsJson,
        updateCount: 0,
        sourceFirstIndex: evIdx,
        sourceLastIndex: evIdx,
      };
 // defense-in-depth scan for a {type:"terminal",
 // terminalId} block on the initial tool_call. Grok usually emits
 // it on the first tool_call_update, but inline-on-open is allowed
 // by the ACP spec and seen in test captures.
      const tid = extractTerminalId((update as any)?.content);
      if (tid) grp.terminalId = tid;
      groups.push(grp);
 // index with promptId-namespaced key so
 // two prompts that both emit `call-XXX-0` don't overwrite each
 // other's entry. Falls back to raw id when promptId is missing.
      toolIndex.set(keyFor(id, meta?.promptId), groups.length - 1);
      return;
    }

 // ─── tool_call_update (upsert by toolCallId) ───
    if (
      method === "session/update" &&
      sessionUpdate === "tool_call_update" &&
      typeof update?.toolCallId === "string"
    ) {
      const id = update.toolCallId;
      const key = keyFor(id, meta?.promptId);
      const i = toolIndex.get(key);
      if (i == null) {
 // Out-of-order: synthesize a new tool group.
        const grp: ToolGroup = {
          id: nextId(),
          kind: "tool",
          t: ev.t,
          toolCallId: id,
          title:
            typeof update.title === "string" ? update.title : "tool",
          status: typeof update.status === "string" ? update.status : "?",
          kindLabel:
            typeof update.kind === "string"
              ? update.kind
              : meta?.updateParams?.kind ?? "?",
          argsJson: "",
          updateCount: 1,
          sourceFirstIndex: evIdx,
          sourceLastIndex: evIdx,
        };
        groups.push(grp);
        toolIndex.set(key, groups.length - 1);
      } else {
        const g = groups[i] as ToolGroup;
        if (typeof update.status === "string") g.status = update.status;
        if (typeof update.title === "string") g.title = update.title;
        if (typeof update.kind === "string") g.kindLabel = update.kind;
        const diff = pickDiff(update);
        if (diff) {
          g.diffPath = diff.path;
          g.diffOldText = diff.oldText;
          g.diffNewText = diff.newText;
 /* when grok writes plan.md, store the
 * new text under `planMarkdown` so ChatOutput can render a
 * markdown card below the diff. The PlanPane (right rail)
 * already does this for the right rail — we mirror it in
 * the chat output so reviewers don't have to context-switch
 * to read what was written. */
          if (isPlanPath(diff.path)) {
            g.planMarkdown = diff.newText;
          }
        }
 /* if the path arrived via rawOutput.text
 * instead of the diff content block (some grok variants emit
 * fs/write_text_file with just rawInput.path + rawOutput.text),
 * extract the new content from rawOutput.text and stash it
 * here. Best-effort — rawOutput.text often holds the full
 * file body, occasionally a status message. We only stash
 * when the tool's path/title ends in plan.md AND the body
 * looks markdown-ish (contains a heading or list marker). */
        if (!g.planMarkdown) {
          const rawIn: any = (update as any)?.rawInput;
          const rawOut: any = (update as any)?.rawOutput;
          const pathHint = typeof rawIn?.path === "string" ? rawIn.path
                          : typeof rawIn?.file_path === "string" ? rawIn.file_path
                          : typeof g.title === "string" ? g.title : "";
          if (isPlanPath(pathHint) && typeof rawOut?.text === "string" && looksMarkdown(rawOut.text)) {
            g.planMarkdown = rawOut.text;
          }
        }
 /* image_gen tool returns a Text result containing
 * "Successfully generated image and saved to /path/.../N.jpg".
 * Extract the path so ToolCard can render the image inline.
 * same routine for video_gen — grok writes
 * "/path/.../videos/N.mp4" and the assistant message contains a
 * raw <video src="..."> markdown block that ReactMarkdown strips. */
        {
          const texts: string[] = [];
          const raw = (update as any)?.rawOutput;
          if (raw && typeof raw === "object" && typeof raw.text === "string") texts.push(raw.text);
          const content = (update as any)?.content;
          if (Array.isArray(content)) {
            for (const c of content) {
              const t = c?.content?.text ?? c?.text;
              if (typeof t === "string") texts.push(t);
            }
          }
          for (const t of texts) {
            if (!g.imagePath) g.imagePath = extractGeneratedMediaPath(t, "image");
            if (!g.videoPath) g.videoPath = extractGeneratedMediaPath(t, "video");
          }
 /* also capture the plain-text body so fs_read / bash /
 * web_fetch / fs_list_dir results actually surface in the
 * chat card. Concatenate all text fragments seen across
 * tool_call_update events into `toolText`; the renderer
 * decides whether to show the pre body based on the OTHER
 * kind-fields (image/video/diff/terminal take precedence). */
          if (texts.length > 0) {
            const joined = texts.join("\n").trim();
            if (joined.length > 0) {
              g.toolText = g.toolText ? `${g.toolText}\n${joined}` : joined;
            }
          }
        }
 // extract terminalId from a `{type: "terminal",
 // terminalId}` content block. Same defense-in-depth scan as
 // imagePath/videoPath above. Tolerates the block arriving on
 // any tool_call_update, not just the initial tool_call.
        if (!g.terminalId) {
          const tid = extractTerminalId((update as any)?.content);
          if (tid) g.terminalId = tid;
        }
        g.updateCount += 1;
        g.sourceLastIndex = evIdx;
      }
      return;
    }

 // ─── available_commands_update → coalesce same-count repeats ───
 // The agent emits this whenever the command set could have changed
 // (MCP servers connecting, skills loading), often with identical
 // payloads back-to-back. Only push a new pill when the count differs.
    if (
      method === "session/update" &&
      sessionUpdate === "available_commands_update"
    ) {
      const n =
        Array.isArray((update as any)?.availableCommands)
          ? (update as any).availableCommands.length
          : 0;
      if (n === lastCommandsCount) {
 // Suppress dup — keep the existing pill, just absorb the source range.
 // (No mutation of past group needed; raw event still in right pane.)
        return;
      }
      lastCommandsCount = n;
      groups.push({
        id: nextId(),
        kind: "system",
        t: ev.t,
        icon: "≡",
        label: `${n} commands available`,
        sourceFirstIndex: evIdx,
        sourceLastIndex: evIdx,
      });
      return;
    }

 // ─── session_summary_generated ───
    if (
      method === "_x.ai/session_notification" &&
      sessionUpdate === "session_summary_generated"
    ) {
      const summary =
        typeof (update as any)?.session_summary === "string"
          ? (update as any).session_summary
          : "";
      groups.push({
        id: nextId(),
        kind: "system",
        t: ev.t,
        icon: "✎",
        label: summary || "summary",
        sourceFirstIndex: evIdx,
        sourceLastIndex: evIdx,
      });
      return;
    }

 // ─── MCP init progress: coalesce 12+ events into one live pill ───
 // Wire emits a flood of `_x.ai/mcp/init_progress` {connected, total}
 // events as each MCP server starts, plus a final `_x.ai/mcp_initialized`.
 // Render as a single McpInitGroup that updates in place.
 //
 // split off into its own group kind
 // (was "system" pill). Renderer can now place an explicit progress
 // strip at the top of the chat tab and update fields directly
 // instead of regenerating a label string per event.
    if (
      method === "_x.ai/mcp/init_progress" ||
      method === "_x.ai/mcp_initialized"
    ) {
      const p = (ev.payload as any)?.params ?? {};
      const total = typeof p.total === "number" ? p.total : 0;
      const connected = typeof p.connected === "number" ? p.connected : total;
      const isReady = method === "_x.ai/mcp_initialized";
      const toolCount =
        isReady && typeof p.mcpToolCount === "number" ? p.mcpToolCount : undefined;
      const elapsedMs =
        isReady && typeof p.elapsedMs === "number" ? p.elapsedMs : undefined;
      if (mcpProgressGroupIndex == null) {
        const grp: McpInitGroup = {
          id: nextId(),
          kind: "mcp-init",
          t: ev.t,
          connected: connected ?? 0,
          total: total ?? 0,
          ready: isReady,
          mcpToolCount: toolCount,
          elapsedMs,
          sourceFirstIndex: evIdx,
          sourceLastIndex: evIdx,
        };
        groups.push(grp);
        mcpProgressGroupIndex = groups.length - 1;
      } else {
        const g = groups[mcpProgressGroupIndex] as McpInitGroup;
        if (typeof connected === "number") g.connected = connected;
        if (typeof total === "number" && total > 0) g.total = total;
        if (isReady) g.ready = true;
        if (typeof toolCount === "number") g.mcpToolCount = toolCount;
        if (typeof elapsedMs === "number") g.elapsedMs = elapsedMs;
        g.sourceLastIndex = evIdx;
      }
      return;
    }

 /* ─── prompt_complete → MarkerGroup ───────────────────────────────
 * when a turn ends, grok fires
 * `_x.ai/session/prompt_complete` carrying { stopReason, agentResult }.
 * Render as a small turn-complete pill with elapsedMs from cached
 * `streamStartMs` of the same promptId. */
    if (method === "_x.ai/session/prompt_complete") {
      const params = (ev.payload as any)?.params ?? {};
      const stopReason =
        typeof params.stopReason === "string" ? params.stopReason : undefined;
      const promptId =
        typeof meta?.promptId === "string" ? meta.promptId : undefined;
      const startMs = promptId ? streamStartByPromptId.get(promptId) : undefined;
      const elapsedMs = typeof startMs === "number"
        ? Math.max(0, ev.t - startMs)
        : undefined;
      const grp: MarkerGroup = {
        id: nextId(),
        kind: "marker",
        t: ev.t,
        marker: "turn-complete",
        elapsedMs,
        stopReason,
        promptId,
        sourceFirstIndex: evIdx,
        sourceLastIndex: evIdx,
      };
      groups.push(grp);
 // Reset chunk accumulator — next turn starts a fresh message group.
      lastChunk = null;
      return;
    }

 // ─── doom_loop_detected ) ───
 // Grok's anti-loop watchdog. Surface as a dedicated chip so the
 // user notices that the agent is stuck repeating a tool. The
 // event arrives as an `_x.ai/session_notification` whose inner
 // update.sessionUpdate === "doom_loop_detected".
    if (
      method === "_x.ai/session_notification" &&
      sessionUpdate === "doom_loop_detected"
    ) {
      const u: any = update ?? {};
      const toolNames = Array.isArray(u.tool_names)
        ? u.tool_names.filter((s: unknown): s is string => typeof s === "string")
        : [];
      groups.push({
        id: nextId(),
        kind: "doom-loop",
        t: ev.t,
        message: typeof u.message === "string" ? u.message : "stuck loop detected",
        repeatCount: typeof u.repeat_count === "number" ? u.repeat_count : 0,
        toolNames,
        isWarning: u.is_warning !== false,
        sourceFirstIndex: evIdx,
        sourceLastIndex: evIdx,
      });
      return;
    }

 // ─── host_mcp_unreachable ───
 // shellX emits this synthetic `_x.ai/session_notification` when
 // a host-MCP tool fails with `Transport closed`. Surface it as a
 // dedicated chip because it usually means an orchestrated build
 // lost its host bridge and the user must reconnect/restart the tab.
    if (
      method === "_x.ai/session_notification" &&
      sessionUpdate === "host_mcp_unreachable"
    ) {
      const u: any = update ?? {};
      groups.push({
        id: nextId(),
        kind: "host-mcp-unreachable",
        t: ev.t,
        message:
          typeof u.message === "string"
            ? u.message
            : "host-MCP transport is unreachable",
        repeatCount: typeof u.repeat_count === "number" ? u.repeat_count : 0,
        toolName: typeof u.tool_name === "string" ? u.tool_name : undefined,
        goalHalted: u.goal_halted === true,
        sourceFirstIndex: evIdx,
        sourceLastIndex: evIdx,
      });
      return;
    }

 // ─── _x.ai/* flat vendor events — hard filter ───
    if (method && method.startsWith("_x.ai/")) {
 // Drop every `_x.ai/*` method not handled by a named branch
 // above. The raw event still lands in the events ring so the
 // Logs / Stderr tabs preserve the verbatim stream, but the chat
 // surface stays clean. Add a named branch above for any future
 // value-add vendor event; this catch-all remains a hard filter.
      return;
    }

 // ─── Channel-driven non-ACP events ───
    if (ev.kind === "grok-stderr") {
      const line = String((ev.payload as any)?.line ?? "");
 // Bucket MCP worker auth failures — extremely common at session
 // start (one per unauthenticated MCP server), useless individually.
 // Roll up into a single counted pill; the raw lines are still in
 // the right pane for forensic detail.
      if (
        /worker quit with fatal: Transport channel closed,\s*when Auth/i.test(line)
      ) {
        mcpAuthErrorCount += 1;
        if (mcpAuthErrorGroupIndex == null) {
          groups.push({
            id: nextId(),
            kind: "system",
            t: ev.t,
            icon: "⚠",
            label: `${mcpAuthErrorCount} MCP server(s) failed auth`,
            detail: "(raw stderr in right pane)",
            sourceFirstIndex: evIdx,
            sourceLastIndex: evIdx,
          });
          mcpAuthErrorGroupIndex = groups.length - 1;
        } else {
          const g = groups[mcpAuthErrorGroupIndex] as SystemGroup;
          g.label = `${mcpAuthErrorCount} MCP server(s) failed auth`;
          g.sourceLastIndex = evIdx;
        }
        return;
      }
 // stop pushing every
 // generic stderr line into the chat. grok-build emits routine
 // tracing-format ERROR/WARN lines (ANSI-colored, timestamped)
 // that clutter the user's conversation surface. The BottomPanel
 // → Stderr tab already renders ALL stderr lines with line-by-line
 // detail (StderrView at BottomPanel.tsx:1117); the user goes
 // there when they actually need forensic detail. Keeping only
 // the MCP-auth rollup above as an in-chat signal because that
 // one is actionable + counted, not a wall of log noise.
      return;
    }
    if (ev.kind === "session-ended" || ev.kind === "session-aborted") {
      groups.push({
        id: nextId(),
        kind: "system",
        t: ev.t,
        icon: "⏹",
        label: ev.kind,
        detail: safeJson(ev.payload),
        sourceFirstIndex: evIdx,
        sourceLastIndex: evIdx,
      });
      return;
    }
    if (ev.kind === "permission-request") {
      const p: any = ev.payload ?? {};
 // Wire shape A (session/request_permission registry path):
 // { reqId, params: { toolCall: {...}, options: [...] }, autoApproved?, autoDenied?, permissionMode? }
 // Wire shape B (legacy terminal/create modal):
 // { request_id, scope: "terminal/create", command, args, cwd, env, autoApproved?, autoDenied?, permissionMode? }
      const requestId: string =
        typeof p.reqId === "string"
          ? p.reqId
          : typeof p.request_id === "string"
            ? p.request_id
            : "";
      if (!requestId) {
 // No request_id — fall back to a generic system pill so the
 // event is at least visible in the chat surface.
        groups.push({
          id: nextId(),
          kind: "system",
          t: ev.t,
          icon: "⚠",
          label: "permission requested",
          detail: safeJson(ev.payload),
          sourceFirstIndex: evIdx,
          sourceLastIndex: evIdx,
        });
        return;
      }
 // Derive toolName / toolArgs / cwd from whichever shape arrived.
      const params = p.params ?? p;
      const toolCall = params?.toolCall ?? params?.tool_call ?? null;
      let toolName = "";
      let toolArgs = "";
      let cwd: string | undefined;
      if (toolCall && typeof toolCall === "object") {
        toolName =
          (typeof toolCall.title === "string" && toolCall.title) ||
          (typeof toolCall.kind === "string" && toolCall.kind) ||
          (typeof toolCall.toolCallId === "string" && toolCall.toolCallId) ||
          "tool";
        const argsObj =
          (toolCall as any).rawInput ??
          (toolCall as any).args ??
          (toolCall as any).input ??
          null;
        if (argsObj && typeof argsObj === "object") {
          const s = safeJson(argsObj);
          toolArgs = s.length > 200 ? s.slice(0, 200) + "…" : s;
        }
      }
 // terminal/create legacy payload (no toolCall) — read command/args/cwd
 // off the top-level so terminal-modal events also get a useful pill.
      if (!toolName) {
        const scope = typeof params.scope === "string" ? params.scope : "";
        if (scope === "terminal/create" || typeof params.command === "string") {
          toolName = scope || "terminal/create";
          const cmd = typeof params.command === "string" ? params.command : "";
          const args = Array.isArray(params.args) ? params.args.map(String) : [];
          const joined = [cmd, ...args].filter(Boolean).join(" ");
          toolArgs = joined.length > 200 ? joined.slice(0, 200) + "…" : joined;
        }
      }
      if (!toolName) toolName = "tool";
      if (typeof params.cwd === "string" && params.cwd.length > 0) {
        cwd = params.cwd;
      }
      const autoApproved = p.autoApproved === true;
      const autoDenied = p.autoDenied === true;
      const permissionMode =
        typeof p.permissionMode === "string" ? p.permissionMode : undefined;
      const initialPending = !(autoApproved || autoDenied);
 // Reconcile with a previous emit for the same requestId. Rust
 // emits twice in some paths (once to register the request, once
 // again with autoApproved/autoDenied set). When the second arrives
 // we upgrade the existing pending pill in place rather than
 // pushing a duplicate row.
      const existingIdx = permissionIndex.get(requestId);
      if (existingIdx !== undefined) {
        const g = groups[existingIdx] as PermissionGroup;
        if (autoApproved || autoDenied) {
          g.pending = false;
          g.decision = autoApproved ? "allow" : "deny";
          g.decisionAt = ev.t;
          g.autoDecision = true;
          if (permissionMode) g.permissionMode = permissionMode;
        }
        g.sourceLastIndex = evIdx;
        return;
      }
      const grp: PermissionGroup = {
        id: nextId(),
        kind: "permission",
        t: ev.t,
        requestId,
        toolName,
        toolArgs,
        cwd,
        pending: initialPending,
        decision: autoApproved ? "allow" : autoDenied ? "deny" : undefined,
        decisionAt: initialPending ? undefined : ev.t,
        autoDecision: !initialPending,
        permissionMode,
        sourceFirstIndex: evIdx,
        sourceLastIndex: evIdx,
      };
      groups.push(grp);
      permissionIndex.set(requestId, groups.length - 1);
      return;
    }
 /* issue #374 — synthetic event posted by PermissionPill after the
 * user clicks Allow / Allow-always / Deny. Carries the same
 * requestId so we can mutate the matching PermissionGroup to its
 * resolved state. */
    if (ev.kind === "permission-resolved") {
      const p: any = ev.payload ?? {};
      const requestId =
        typeof p.requestId === "string"
          ? p.requestId
          : typeof p.reqId === "string"
            ? p.reqId
            : typeof p.request_id === "string"
              ? p.request_id
              : "";
      const decisionRaw =
        typeof p.decision === "string" ? p.decision : undefined;
      const decision: PermissionGroup["decision"] | undefined =
        decisionRaw === "allow" || decisionRaw === "allow_always" || decisionRaw === "deny"
          ? decisionRaw
          : undefined;
      const idx = requestId ? permissionIndex.get(requestId) : undefined;
      if (idx !== undefined) {
        const g = groups[idx] as PermissionGroup;
        g.pending = false;
        if (decision) g.decision = decision;
        g.decisionAt = typeof p.decisionAt === "number" ? p.decisionAt : ev.t;
        g.autoDecision = false;
        g.sourceLastIndex = evIdx;
      }
      return;
    }
    if (ev.kind === "max-context-detected") {
      groups.push({
        id: nextId(),
        kind: "system",
        t: ev.t,
        icon: "⊞",
        label: `max context ${(ev.payload as any)?.maxContextLength}`,
        sourceFirstIndex: evIdx,
        sourceLastIndex: evIdx,
      });
      return;
    }
    if (ev.kind === "ui") {
 /* ui payload is either a bare string (legacy) OR
 * { _meta, text } (tagged so eventsForActiveTab can route it).
 * Extract the text field when present, else stringify the whole
 * payload as before.
 *
 * an additional shape is
 * { _meta: { kind: "attach-thumbs" }, thumbs: [path, ...] }
 * emitted by App.send when the user sent a message with image
 * attachments. We surface the paths on the UiTextGroup so the
 * UserBubble renders thumbnail chips alongside the text. The
 * `text` field is empty for thumb-only frames so the chip row
 * stands alone above any subsequent prompt echo. */
      const p: any = ev.payload;
      if (p && typeof p === "object" && p?._meta?.kind === "connection-metadata") {
        return;
      }
      const text = (p && typeof p === "object" && typeof p.text === "string")
        ? p.text
        : (p && typeof p === "object" && p?._meta?.kind === "attach-thumbs")
          ? ""
          : (p && typeof p === "object")
            ? ""
            : String(p);
      if (text.length === 0 && !(p && typeof p === "object" && Array.isArray(p.thumbs))) {
        return;
      }
      const thumbs: string[] | undefined =
        (p && typeof p === "object" && Array.isArray(p.thumbs))
          ? (p.thumbs.filter((x: unknown): x is string => typeof x === "string"))
          : undefined;
      groups.push({
        id: nextId(),
        kind: "ui",
        t: ev.t,
        text,
        thumbs,
        sourceFirstIndex: evIdx,
        sourceLastIndex: evIdx,
      });
      return;
    }

 // typed envelope
 // events that the chat surface has no use for. These are emitted on
 // dedicated Tauri channels and consumed by named UI components (mic
 // state, Plan tab, attach-cap watcher, auth banner). Folding any of
 // them into the "?" system pill below pollutes the conversation
 // with raw JSON debug rows. The events ring + Logs tab in
 // BottomPanel still capture every event for forensic detail.
 //
 // The set below intentionally mirrors the typed-channel allow-list
 // in App.tsx (TAURI_CHANNELS) MINUS the kinds that already have
 // explicit chat-render branches above (grok-stderr, session-ended,
 // session-aborted, permission-request, max-context-detected, ui).
    const NON_CHAT_TYPED_KINDS = new Set<string>([
      "prompt-complete",
      "auth-unhealthy",
      "session-summary-generated",
      "agent-capabilities",
      "plan-event",
      "build-event",
      "tool-call",
      "grok-extension",
    ]);
    if (NON_CHAT_TYPED_KINDS.has(ev.kind)) {
      return;
    }

 // Generic ACP envelopes are useful for trace/debug panes, but they
 // should not fall through into the chat as raw JSON `?` pills. Every
 // value-add ACP shape has an explicit branch above; anything left here
 // is intentionally hidden from the conversation surface.
    if (ev.kind === "grok-acp-event" || ev.kind === "session-update") {
      return;
    }

 // ─── unrecognized: fold into system pill ───
    groups.push({
      id: nextId(),
      kind: "system",
      t: ev.t,
      icon: "?",
      label: ev.kind,
      detail: safeJson(ev.payload).slice(0, 200),
      sourceFirstIndex: evIdx,
      sourceLastIndex: evIdx,
    });
  });

  return groups;
}

function unwrapForGrouping(ev: RawEventFrame): {
  method: string | undefined;
  sessionUpdate: string | undefined;
  update: SessionUpdatePayload | undefined;
  meta: Record<string, any> | undefined;
} | null {
 // grok-acp-event channel: payload = { method, params }
 // session-update channel: payload = { update: { method, params } } — re-wraps the acp event
  if (ev.kind === "grok-acp-event" && ev.payload && typeof ev.payload === "object") {
    const p = ev.payload as any;
    return {
      method: typeof p.method === "string" ? p.method : undefined,
      sessionUpdate: p?.params?.update?.sessionUpdate,
      update: p?.params?.update,
      meta: p?.params?._meta,
    };
  }
  if (ev.kind === "session-update" && ev.payload && typeof ev.payload === "object") {
    const inner = (ev.payload as any).update;
    if (inner && typeof inner === "object") {
      return {
        method: typeof inner.method === "string" ? inner.method : undefined,
        sessionUpdate: inner?.params?.update?.sessionUpdate,
        update: inner?.params?.update,
        meta: inner?.params?._meta,
      };
    }
  }
  return {
    method: undefined,
    sessionUpdate: undefined,
    update: undefined,
    meta: undefined,
  };
}

function extractText(update: SessionUpdatePayload | undefined): string | undefined {
  const c = update?.content;
  if (c && typeof c === "object" && !Array.isArray(c) && (c as any).type === "text") {
    return (c as any).text;
  }
  if (Array.isArray(c) && c.length > 0 && (c[0] as any).type === "text") {
    return (c[0] as any).text;
  }
  return undefined;
}

/**
 * extract the first `{type: "terminal", terminalId: "..."}`
 * block from a tool_call's content array. Returns undefined when no
 * such block is present.
 *
 * The ACP `tool_call_content[]` array can carry many block types
 * ("text" | "image" | "diff" | "terminal" | ...). Grok will at most emit
 * one terminal block per tool_call (the matched terminalId comes back via
 * grok's own `terminal/output` polling), so we stop at the first match.
 */
function extractTerminalId(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  for (const b of content) {
    if (b && typeof b === "object" && (b as any).type === "terminal") {
      const tid = (b as any).terminalId;
      if (typeof tid === "string" && tid.length > 0) return tid;
    }
  }
  return undefined;
}

function pickDiff(update: SessionUpdatePayload | undefined): {
  path: string;
  oldText: string;
  newText: string;
} | undefined {
  const c = update?.content;
  if (!Array.isArray(c)) return undefined;
  for (const b of c) {
    if ((b as any)?.type === "diff") {
      const d = b as any;
      return {
        path: typeof d.path === "string" ? d.path : "",
        oldText: typeof d.oldText === "string" ? d.oldText : "",
        newText: typeof d.newText === "string" ? d.newText : "",
      };
    }
  }
  return undefined;
}

function summarizeVendorParams(ev: RawEventFrame): string {
  const p = (ev.payload as any)?.params;
  if (!p) return "";
 // Strip sessionId (every event has it; not interesting in summary).
  const { sessionId: _drop, ...rest } = p;
  return safeJson(rest).slice(0, 160);
}

function safeJson(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/**
 * true if the given path looks like grok's plan.md
 * artifact (the right-rail PlanPane source). Matches paths ending in
 * `/plan.md` or exactly `plan.md`. Case-insensitive to tolerate
 * Plan.md / PLAN.md variations grok occasionally emits.
 */
function isPlanPath(p: unknown): boolean {
  if (typeof p !== "string" || p.length === 0) return false;
  return /(^|[\\/])plan\.md$/i.test(p);
}

/**
 * cheap heuristic — does this string look like
 * markdown? Checks for any of: heading (# ...), bullet (- ...), or
 * fenced code block. Used to gate rawOutput.text → planMarkdown so we
 * don't render a non-markdown status string as a markdown card.
 */
function looksMarkdown(s: string): boolean {
  if (s.length === 0) return false;
  return /(^|\n)(#{1,6}\s|[-*]\s|```)/.test(s);
}
