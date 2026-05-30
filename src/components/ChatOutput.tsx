/**
 * src/components/ChatOutput.tsx — middle pane chat output.
 *
 * Renders the UiGroup[] produced by `groupEvents` in
 * `src/lib/grouping.ts`. ChatOutput is a pure presentation layer; it
 * does NOT regroup events — that pipeline is locked (tests against
 * real evidence/*.jsonl).
 *
 * Auto-scrolls on new events with sticky-bottom behavior. File-link
 * chips inside assistant messages call onPreviewFile, which opens the
 * FilePreviewModal at App level.
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState, type JSX } from "react";
import { onMouseUpAutoCopy } from "../lib/auto-copy-selection";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { linkifyPreviewableFileRefs, SafeMarkdownLink } from "../lib/markdown-links";
import { TerminalView } from "./TerminalView";
import { SafeImg, SafeVideo } from "./MediaPreview";
import { ShellIcon, type ShellIconName } from "./icons";
import type {
  DoomLoopGroup,
  HostMcpUnreachableGroup,
  MarkerGroup,
  McpInitGroup,
  MessageGroup,
  SystemGroup,
  ThoughtGroup,
  ToolGroup,
  UiGroup,
  UiAttachment,
  UiTextGroup,
  VendorGroup,
} from "../lib/grouping";
import { PermissionPill } from "./PermissionPill";

/* tabId is the active session's tab_id; forwarded to inline
 * <TerminalView attachOnly/> so it binds to the right ACP-origin PTY
 * in the TerminalRegistry. Falls back to "default" to match the
 * Rust-side `tab_id.unwrap_or("default")` convention. */

function ChatOutputView({
  groups,
  onPreviewFile,
  tabId,
}: {
  groups: UiGroup[];
  onPreviewFile: (path: string) => void;
 /** Forwarded to inline <TerminalView/> for ACP-origin terminals. */
  tabId?: string;
}): JSX.Element {
  const endRef = useRef<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
 // #387 redo of #372 — sticky-bottom auto-scroll based on EXPLICIT user
 // intent, not derived from `scrollTop`.
 //
 // Why the first cut broke: streaming chunks add height to `scrollHeight`
 // before React's auto-scroll `useEffect` fires `scrollIntoView`. In that
 // gap, the browser's scroll event sees `distFromBottom = newHeight -
 // oldScrollTop - clientHeight`, which is large → `pinnedBottom = false`
 // → the "↓ Jump to latest" pill flickered in on every chunk even when
 // the user was already at the bottom. The user could click it, but a
 // millisecond later another chunk arrived and the pill re-appeared.
 //
 // New approach: a separate `userScrolledUpRef` is flipped to `true`
 // ONLY when a wheel-up / PageUp / ArrowUp / touchmove-up actually
 // comes from the user. The scroll event then decides:
 // - distFromBottom < 8 px → user is at the very bottom; clear flag,
 // re-pin.
 // - distFromBottom > 200 px AND flag set → user genuinely scrolled
 // away; show pill.
 // - everything in between → leave state alone (content-add bounce
 // doesn't trip the pill).
  const [pinnedBottom, setPinnedBottom] = useState(true);
  const userScrolledUpRef = useRef(false);

 // Wheel / keyboard / touch listeners drive the "user intent" signal.
 // We attach once on the container; React's onScroll prop is reserved
 // for the position-check below.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const markUserScrolledUp = () => { userScrolledUpRef.current = true; };
    const onWheel = (e: WheelEvent) => { if (e.deltaY < 0) markUserScrolledUp(); };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowUp" || e.key === "PageUp" || e.key === "Home") {
        markUserScrolledUp();
      }
    };
    let touchStartY = 0;
    const onTouchStart = (e: TouchEvent) => { touchStartY = e.touches[0]?.clientY ?? 0; };
    const onTouchMove = (e: TouchEvent) => {
      const y = e.touches[0]?.clientY ?? 0;
      if (y > touchStartY + 8) markUserScrolledUp();
    };
    el.addEventListener("wheel", onWheel, { passive: true });
    el.addEventListener("keydown", onKey);
    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: true });
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("keydown", onKey);
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
    };
  }, []);

  const onScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
 // At-bottom anchor: 8 px tolerance handles sub-pixel rounding.
    if (distFromBottom < 8) {
      userScrolledUpRef.current = false;
      setPinnedBottom(true);
      return;
    }
 // Only mark un-pinned if the user explicitly scrolled away AND
 // they're meaningfully far from the bottom. The 200 px buffer
 // absorbs content-add bounce (a single chunk rarely exceeds ~150 px).
    if (userScrolledUpRef.current && distFromBottom > 200) {
      setPinnedBottom(false);
    }
  }, []);

  useEffect(() => {
    if (!pinnedBottom) return;
    endRef.current?.scrollIntoView({ behavior: "auto", block: "end" });
  }, [groups.length, pinnedBottom]);

 /* The diff-nav keybinding hint (j/k/y/n/e) renders once at the
 * bottom of the chat output, gated on "any diff group visible".
 * The useMemo must run BEFORE the `groups.length === 0` early
 * return — otherwise the hook count would flip between renders
 * and React throws "Rendered more hooks than during the previous
 * render", taking the whole tree down. */
  const hasAnyDiff = useMemo(
    () => groups.some((g) => g.kind === "tool" && typeof (g as ToolGroup).diffPath === "string" && (g as ToolGroup).diffPath!.length > 0),
    [groups],
  );

  if (groups.length === 0) {
    return (
      <div className="output">
        <div className="output-empty">
          No events yet. Use the prompt input below — events render here as
          chat bubbles + tool cards.
          <div className="output-empty-tips">
            <span className="oe-tip"><kbd>Ctrl</kbd>+<kbd>K</kbd> search</span>
            <span className="oe-tip"><kbd>/</kbd> commands</span>
            <span className="oe-tip"><kbd>@</kbd> attach</span>
          </div>
        </div>
      </div>
    );
  }

 // Render each group as its own row. A "turn-card" grouping (one
 // user bubble + one assistant bubble per prompt) would be a later
 // refinement.
  const ttabId = tabId ?? "default";

 /* Defense-in-depth dedupe for parallel media_gen calls. When grok
 * fires 2+ image_gen/video_gen tool_calls that all write the same
 * output path, suppress the duplicate <SafeImg>/<SafeVideo> and
 * render a "↻ duplicate of earlier" pill so the user doesn't see
 * the same image twice. The card itself still renders for audit. */
  const seenImage = new Set<string>();
  const seenVideo = new Set<string>();
  const duplicates = new Map<string, { image?: boolean; video?: boolean }>();
 // Normalize paths before the Set check so a slash-style path
 // (C:/x.jpg) from one tool and a backslash-style path (C:\x.jpg)
 // from a sibling don't bypass the dedupe. Windows drive-letter
 // paths lowercase; POSIX paths stay case-sensitive.
  const normalizePath = (p: string): string => {
    const slashed = p.replace(/\\/g, "/");
 // Drive-letter Windows path: lowercase since NTFS is case-insensitive.
    if (/^[a-zA-Z]:\//.test(slashed)) return slashed.toLowerCase();
    return slashed;
  };
  for (const g of groups) {
    if (g.kind !== "tool") continue;
    const tg = g as ToolGroup;
    const flags: { image?: boolean; video?: boolean } = {};
    if (tg.imagePath) {
      const key = normalizePath(tg.imagePath);
      if (seenImage.has(key)) flags.image = true;
      else seenImage.add(key);
    }
    if (tg.videoPath) {
      const key = normalizePath(tg.videoPath);
      if (seenVideo.has(key)) flags.video = true;
      else seenVideo.add(key);
    }
    if (flags.image || flags.video) duplicates.set(g.id, flags);
  }

  return (
    <div
      className="output"
      ref={containerRef}
      onScroll={onScroll}
      onMouseUp={onMouseUpAutoCopy}
    >
      {groups.map((g) => (
        <Row
          key={g.id}
          group={g}
          onPreviewFile={onPreviewFile}
          tabId={ttabId}
          duplicateMedia={duplicates.get(g.id)}
        />
      ))}
      <div ref={endRef} />
 {/* When the user scrolls up to read, surface
 * an explicit "↓ jump to latest" affordance instead of forcing
 * them back down on every new chunk. Click re-pins to bottom. */}
      {!pinnedBottom && (
        <button
          type="button"
          className="jump-to-latest"
          onClick={() => {
            setPinnedBottom(true);
            endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
          }}
          style={{
            position: "sticky",
            bottom: 12,
            alignSelf: "center",
            marginLeft: "auto",
            marginRight: "auto",
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            padding: "4px 12px",
            borderRadius: 999,
            background: "var(--card-bg, rgba(0,0,0,0.7))",
            color: "var(--ink)",
            border: "1px solid var(--hairline, rgba(255,255,255,0.18))",
            font: "11px var(--sans)",
            cursor: "pointer",
            zIndex: 5,
          }}
        >
          <ShellIcon name="chevron-down" size={13} />
          <span>Jump to latest</span>
        </button>
      )}
      {hasAnyDiff && (
 // Inline footer (not sticky) so the chat doesn't scroll
 // under an opaque keybinding strip.
        <div
          className="diff-hint diff-hint-footer"
          style={{
            fontSize: "var(--fs-ui-xs)",
            color: "var(--ink-3)",
            padding: "6px 12px",
            background: "transparent",
            borderTop: "1px solid var(--hairline)",
            textAlign: "center",
            marginTop: 8,
          }}
        >
          focus a hunk · <kbd>j</kbd>/<kbd>k</kbd> next/prev · <kbd>y</kbd>/<kbd>n</kbd> accept/reject · <kbd>e</kbd> editor
        </div>
      )}
    </div>
  );
}

export const ChatOutput = memo(ChatOutputView);
ChatOutput.displayName = "ChatOutput";

/**
 * Fenced code/command block wrapper with one-click copy. ReactMarkdown
 * surfaces a code fence as `<pre><code class="language-xxx">…</code></pre>`;
 * we wrap the whole pre with a positioned container and render a
 * floating Copy button in the top-right corner. Click → clipboard.
 *  command blocks copy with one tap.
 */
function CopyableCodeBlock({ children }: { children?: React.ReactNode }): JSX.Element {
  const preRef = useRef<HTMLPreElement | null>(null);
  const [copied, setCopied] = useState(false);
  const handleCopy = () => {
    const txt = preRef.current?.innerText ?? "";
    if (!txt) return;
    try {
      void navigator.clipboard.writeText(txt);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
 /* clipboard API unavailable — silently ignore */
    }
  };
  return (
    <div className="code-block-wrap" style={{ position: "relative" }}>
      <pre ref={preRef}>{children}</pre>
      <button
        type="button"
        className="code-copy-btn"
        onClick={handleCopy}
        title={copied ? "Copied" : "Copy to clipboard"}
        aria-label={copied ? "Copied" : "Copy to clipboard"}
      >
        <ShellIcon name={copied ? "check" : "copy"} size={14} />
      </button>
    </div>
  );
}

function Row({
  group,
  onPreviewFile,
  tabId,
  duplicateMedia,
}: {
  group: UiGroup;
  onPreviewFile: (path: string) => void;
  tabId: string;
 /** When set, this tool group's image/video matches an earlier
 * group's path — render a "duplicate" pill instead of the actual
 * <SafeImg>/<SafeVideo>. */
  duplicateMedia?: { image?: boolean; video?: boolean };
}): JSX.Element {
  switch (group.kind) {
    case "thought":
      return <ThoughtPill g={group} />;
    case "message":
      return <AssistantBubble g={group} onPreviewFile={onPreviewFile} tabId={tabId} />;
    case "tool":
      return (
        <ToolCard
          g={group}
          onPreviewFile={onPreviewFile}
          tabId={tabId}
          duplicateMedia={duplicateMedia}
        />
      );
    case "system":
      return <SystemPill g={group} />;
    case "vendor":
      return <VendorPill g={group} />;
    case "ui":
      return <UserBubble g={group} tabId={tabId} onPreviewFile={onPreviewFile} />;
    case "marker":
      return <TurnCompletePill g={group} />;
    case "mcp-init":
      return <McpInitPill g={group} />;
    case "doom-loop":
      return <DoomLoopChip g={group} />;
    case "host-mcp-unreachable":
      return <HostMcpUnreachableChip g={group} />;
    case "permission":
      return <PermissionPill g={group} tabId={tabId} />;
  }
}

/* ─────────────── turn-complete + MCP init pills ───────────────
 *
 * Compact pills:
 * - turn-complete: small green-tint "✓ turn complete · 3.2s".
 * - MCP-init: progress "MCP init: 3/5 servers" or ready
 * "MCP servers ready · 5 tools".
 * The grouping pipeline guarantees at most one McpInitGroup per chat
 * and one MarkerGroup per turn. */
function TurnCompletePill({ g }: { g: MarkerGroup }): JSX.Element {
  const elapsedLabel =
    typeof g.elapsedMs === "number" && g.elapsedMs > 0
      ? formatElapsed(g.elapsedMs)
      : null;
  return (
    <div
      className="row-pill marker turn-complete"
      style={{
        opacity: 0.85,
        fontSize: "var(--fs-ui-xs)",
        fontFamily: "var(--mono)",
        color: "var(--ok, #6cbf6c)",
      }}
      data-marker={g.marker}
      data-prompt-id={g.promptId}
    >
      <Time t={g.t} />
      <span className="pi" />
      <span className="label">
        <ShellIcon name="check" size={13} />
        turn complete
        {elapsedLabel ? <span style={{ marginLeft: 6, opacity: 0.75 }}>· {elapsedLabel}</span> : null}
        {g.stopReason && g.stopReason !== "end_turn"
          ? <span style={{ marginLeft: 6, opacity: 0.6 }}>({g.stopReason})</span>
          : null}
      </span>
    </div>
  );
}

function McpInitPill({ g }: { g: McpInitGroup }): JSX.Element {
  const label = g.ready
    ? `MCP servers ready · ${g.total || g.connected || "?"} servers${
        typeof g.mcpToolCount === "number" ? `, ${g.mcpToolCount} tools` : ""
      }${typeof g.elapsedMs === "number" ? ` · ${formatElapsed(g.elapsedMs)}` : ""}`
    : `MCP init: ${g.connected}/${g.total || "?"} servers`;
  return (
    <div
      className={`row-pill mcp-init${g.ready ? " ready" : " progress"}`}
      style={{
        fontFamily: "var(--mono)",
        fontSize: 12,
      }}
    >
      <Time t={g.t} />
      <span className="pi" />
      <span className="label">
        <ShellIcon name={g.ready ? "check" : "loader"} size={13} />
        {label}
      </span>
    </div>
  );
}

function formatElapsed(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m${s.toString().padStart(2, "0")}s`;
}

/* ─────────────── Bubbles ─────────────── */

function UserBubble({
  g,
  tabId,
  onPreviewFile,
}: {
  g: UiTextGroup;
  tabId?: string;
  onPreviewFile: (path: string) => void;
}): JSX.Element {
 // The "ui" channel carries user-typed prompts (from pushUiEvent).
 // We strip leading "→ prompt:" / "→ connect" prefixes for display.
  const text = g.text.replace(/^→ prompt:\s*/i, "");
  if (g.text.startsWith("→ connect") || g.text.startsWith("✓ ") || g.text.startsWith("⏹") || g.text.startsWith("✗")) {
 // Lifecycle ui events render as compact system pills.
    const status = uiEventStatus(g.text);
    return (
      <div className="row-pill system">
        <Time t={g.t} />
        <span className="pi" />
        <span className="label">
          <ShellIcon name={status.icon} size={13} />
          {status.label}
        </span>
      </div>
    );
  }
 /* Attachment chips are renderer-only echo metadata. The grok wire
 * still receives hidden `[attached: <path>]` markers until the ACP
 * image/file prompt capabilities are available. */
  const thumbs = g.thumbs ?? [];
  const fileAttachments = (g.attachments ?? [])
    .filter((attachment) => attachment.kind !== "image");
  return (
    <div className="turn turn-user">
      <div className="role user">
        <span className="dot" />
        YOU
        <span className="time">{fmtTime(g.t)}</span>
      </div>
      {thumbs.length > 0 && (
        <div
          className="attach-thumbs"
          style={{
            display: "flex",
            gap: 8,
            flexWrap: "wrap",
            marginBottom: text ? 6 : 0,
          }}
        >
          {thumbs.map((p) => (
            <AttachThumb key={p} path={p} tabId={tabId} />
          ))}
        </div>
      )}
      {fileAttachments.length > 0 && (
        <div
          className="attach-files"
          style={{
            display: "flex",
            gap: 6,
            flexWrap: "wrap",
            marginBottom: text ? 6 : 0,
          }}
        >
          {fileAttachments.map((attachment) => (
            <AttachmentFileChip
              key={`${attachment.kind ?? "file"}:${attachment.path}`}
              attachment={attachment}
              onPreviewFile={onPreviewFile}
            />
          ))}
        </div>
      )}
      {text && <div className="msg user">{text}</div>}
    </div>
  );
}

function AttachmentFileChip({
  attachment,
  onPreviewFile,
}: {
  attachment: UiAttachment;
  onPreviewFile: (path: string) => void;
}): JSX.Element {
  const label = attachment.label || baseName(attachment.path);
  const icon: ShellIconName = attachment.kind === "text" ? "file" : "paperclip";
  return (
    <button
      type="button"
      className="attach-file-chip"
      title={attachment.path}
      onClick={() => onPreviewFile(attachment.path)}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        maxWidth: 260,
        height: 28,
        padding: "0 9px",
        border: "1px solid var(--border, #2a2a2a)",
        borderRadius: 999,
        background: "var(--bg-elev, #111)",
        color: "var(--fg, #ddd)",
        cursor: "pointer",
        fontFamily: "var(--sans)",
        fontSize: "var(--fs-ui-xs)",
      }}
    >
      <ShellIcon name={icon} size={13} />
      <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {label}
      </span>
    </button>
  );
}

/**
 * One 80x80 image chip + filename + inert remove control. The ✕
 * button is visual parity with the Slack/Discord composer-chip pattern;
 * once a prompt is sent the attachment is part of immutable history.
 * Reuses SafeImg so WSL-bridge paths resolve via the Rust
 * `read_image_as_data_url` fallback.
 */
function AttachThumb({ path, tabId }: { path: string; tabId?: string }): JSX.Element {
  const name = baseName(path);
  return (
    <div
      className="attach-thumb"
      title={path}
      style={{
        display: "inline-flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 2,
        padding: 4,
        border: "1px solid var(--border, #2a2a2a)",
        borderRadius: 6,
        background: "var(--bg-elev, #111)",
        position: "relative",
        maxWidth: 96,
      }}
    >
      <div
        style={{
          width: 80,
          height: 80,
          overflow: "hidden",
          borderRadius: 4,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#000",
        }}
      >
        <SafeImg
          src={path}
          alt={name}
          tabId={tabId}
          style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "cover" }}
        />
      </div>
      <span
        style={{
          fontSize: "var(--fs-ui-xs)",
          maxWidth: 80,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          color: "var(--fg-muted, #999)",
        }}
      >
        {name}
      </span>
 {/*  removed the dead ✕ button. Attached files in
 * a sent message are immutable history; the ✕ was a visual
 * placeholder that looked tappable but did nothing. The chip
 * itself communicates the attachment fine without it. */}
    </div>
  );
}

function AssistantBubble({
  g,
  onPreviewFile,
  tabId,
}: {
  g: MessageGroup;
  onPreviewFile: (path: string) => void;
 /** Forwarded to SafeImg so WSL/SSH-rooted image URLs in assistant
 * output get UNC-translated by the Rust read_image_as_data_url
 * fallback. */
  tabId?: string;
}): JSX.Element {
  return (
    <div className="turn">
      <div className="role assistant">
        <span className="dot" />
        GROK
        <span className="time">{fmtTime(g.t)}</span>
 {/* Chunk count is intentionally absent — the stream renders
            character-by-character so a count adds nothing. The
            turn-complete marker is the useful signal. */}
      </div>
      <div className="msg assistant">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            img: ({ src, alt, ...rest }) => (
              <SafeImg src={src} alt={alt ?? ""} tabId={tabId} {...rest} />
            ),
 // Plain code chunks render as inline pills (.icode mockup style)
 // when they're short; longer ones fall through to <pre><code>.
            code: ({ children, className }) => {
              const text = String(children ?? "");
              if (!className && text.length <= 80 && !text.includes("\n")) {
                return <span className="icode">{text}</span>;
              }
              return <code className={className}>{children}</code>;
            },
 // fenced code/command blocks get a top-right Copy
 // button so one-click copy saves a select-all + Ctrl+C.
            pre: ({ children }) => <CopyableCodeBlock>{children}</CopyableCodeBlock>,
 // Auto-detect file references and render as flink chips so the
 // FilePreviewModal opens on click. Match either (a) a
 // filesystem-style absolute or relative path prefix, or
 // (b) a bare filename with a recognised file extension —
 // when grok writes "Created test.md" without a path, we
 // still want the click to open it (handlePreviewFile resolves
 // relative names against the active tab cwd).
            a: ({ href, children }) => {
              return <SafeMarkdownLink href={href} onPreviewFile={onPreviewFile}>{children}</SafeMarkdownLink>;
            },
          }}
        >
          {linkifyPreviewableFileRefs(g.text)}
        </ReactMarkdown>
      </div>
    </div>
  );
}

function ToolCard({
  g,
  onPreviewFile,
  tabId,
  duplicateMedia,
}: {
  g: ToolGroup;
  onPreviewFile: (path: string) => void;
 /** Session tab_id forwarded to inline <TerminalView/> so attach
 * binds to the right record. */
  tabId: string;
 /** When set, this card's image/video path duplicates an earlier
 * card; render a pill instead of the media. */
  duplicateMedia?: { image?: boolean; video?: boolean };
}): JSX.Element {
  const statusClass = normalizeStatus(g.status);
  const hasDiff = typeof g.diffPath === "string" && g.diffPath.length > 0;
 // An embedded ACP-origin PTY view renders when the tool_call (or
 // any update) carries a `{type:"terminal", terminalId}` block. The
 // view stays mounted across status transitions so the user can
 // keep watching output even after grok calls terminal/release —
 // xterm.js's internal buffer retains the visible bytes.
  const hasTerminal = typeof g.terminalId === "string" && g.terminalId.length > 0;
  return (
    <div className={`tool ${statusClass}`}>
      <div className="tool-hdr">
        <span className="tdot" />
        <span className="tname">{g.kindLabel || "tool"}</span>
        <span className="targ" title={g.argsJson}>{g.title || (g.argsJson ? truncate(g.argsJson, 80) : "")}</span>
        <span className="activity" aria-hidden="true">
          <span style={{ height: "30%" }} />
          <span style={{ height: "60%" }} />
          <span style={{ height: "45%" }} />
          <span style={{ height: "80%" }} />
          <span style={{ height: "70%" }} />
          <span style={{ height: "55%" }} />
          <span style={{ height: "90%" }} />
        </span>
        <span className="tstat">{g.status.toUpperCase()}</span>
      </div>
      {(g.argsJson || hasDiff || g.imagePath || g.videoPath || hasTerminal || g.toolText) && (
        <div className="tool-body">
          {g.argsJson && !hasDiff && !g.imagePath && !g.videoPath && !hasTerminal && (
            <pre>{truncate(g.argsJson, 1200)}</pre>
          )}
 {/* surface rawOutput.text for fs_read / bash /
 * web_fetch / fs_list_dir — previously these tool cards
 * showed args only, leaving the user blind to what the
 * tool actually returned. Skip when the result is already
 * represented as image / video / diff / terminal. 4 KB cap
 * keeps the bubble manageable; full content is reachable
 * via FilePreviewModal for file reads. */}
          {g.toolText && !hasDiff && !g.imagePath && !g.videoPath && !hasTerminal && (
            <pre className="tool-output">{truncate(g.toolText, 4096)}</pre>
          )}
          {hasDiff && (
            <DiffHunks
              path={g.diffPath ?? ""}
              oldText={g.diffOldText ?? ""}
              newText={g.diffNewText ?? ""}
              onOpen={onPreviewFile}
            />
          )}
 {/* When grok writes plan.md, render the new content as
 * markdown beneath the diff so reviewers can read it
 * inline without switching to the right-rail PlanPane. */}
          {g.planMarkdown && (
            <div className="plan-md tool-plan-md" style={{ padding: "8px 12px 4px", borderTop: "1px solid var(--hairline)" }}>
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                  code: ({ children, className }) => {
                    const text = String(children ?? "");
                    if (!className && text.length <= 80 && !text.includes("\n")) {
                      return <span className="icode">{text}</span>;
                    }
                    return <code className={className}>{children}</code>;
                  },
                  a: ({ href, children }) => (
                    <SafeMarkdownLink href={href} onPreviewFile={onPreviewFile}>
                      {children}
                    </SafeMarkdownLink>
                  ),
                }}
              >
                {g.planMarkdown}
              </ReactMarkdown>
            </div>
          )}
 {/* image_gen tool result rendered inline via SafeImg.
 * Compact pill replaces the image when this card
 * duplicates an earlier card's output path. */}
          {g.imagePath && duplicateMedia?.image ? (
            <div className="tool-image dup-media-pill" style={{ padding: "8px 12px", fontSize: 12, color: "var(--ink-3)", borderTop: "1px solid var(--hairline)" }}>
              <ShellIcon name="rotate" size={13} /> duplicate generation - same output path as earlier card
            </div>
          ) : g.imagePath ? (
            <div className="tool-image">
              <SafeImg
                src={g.imagePath}
                alt={`Generated: ${g.title || "image"}`}
                tabId={tabId}
              />
            </div>
          ) : null}
 {/* video_gen tool result rendered via SafeVideo. Same
 * asset:// → Rust-base64 fallback chain as SafeImg. */}
          {g.videoPath && duplicateMedia?.video ? (
            <div className="tool-video dup-media-pill" style={{ padding: "8px 12px", fontSize: 12, color: "var(--ink-3)", borderTop: "1px solid var(--hairline)" }}>
              <ShellIcon name="rotate" size={13} /> duplicate generation - same output path as earlier card
            </div>
          ) : g.videoPath ? (
            <div className="tool-video">
              <SafeVideo
                src={g.videoPath}
                title={`Generated: ${g.title || "video"}`}
                tabId={tabId}
              />
            </div>
          ) : null}
 {/* Live xterm.js view of the ACP-origin PTY. attachOnly
 * binds via pty_attach + pty-output events without
 * pty_create/pty_kill. Interactive so the user can type
 * into the agent's shell (e.g. REPL prompts). */}
          {hasTerminal && (
            <div className="tool-terminal">
              <TerminalView
                tabId={tabId}
                terminalId={g.terminalId!}
                attachOnly
                readOnly={false}
                initialRows={24}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Per-hunk diff navigation. Each hunk is focusable (tabIndex=0):
 * j/k → next/prev hunk in this card
 * y/n → toggle accepted/rejected (local visual state only — grok
 * already wrote the file via its `write` tool; this is audit
 * marking for a future review-trail surface)
 *
 * Splits old/new on `@@` hunk markers when present, otherwise treats
 * the whole diff as a single hunk. Empty oldText → "new file" hunk.
 */
function DiffHunks({
  path,
  oldText,
  newText,
  onOpen,
}: {
  path: string;
  oldText: string;
  newText: string;
  onOpen: (p: string) => void;
}): JSX.Element {
  const hunks = useMemo(() => splitHunks(oldText, newText), [oldText, newText]);
 // Local audit state — index → "accepted" | "rejected" | undefined.
  const [audit, setAudit] = useState<Record<number, "accepted" | "rejected">>({});
  const containerRef = useRef<HTMLDivElement | null>(null);

  function focusHunk(i: number) {
    const el = containerRef.current?.querySelectorAll<HTMLElement>("[data-hunk]")[i];
    el?.focus();
  }

 /** Per-card key handler — only acts when focus is on a hunk in THIS card. */
  function onKey(e: React.KeyboardEvent) {
    if (!containerRef.current) return;
    const focusedEl = document.activeElement as HTMLElement | null;
    if (!focusedEl || !containerRef.current.contains(focusedEl)) return;
    const idxAttr = focusedEl.getAttribute("data-hunk-idx");
    if (idxAttr == null) return;
    const i = parseInt(idxAttr, 10);
    if (!Number.isFinite(i)) return;
 // Diff nav keys never use modifiers.
    if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
    switch (e.key) {
      case "j":
        e.preventDefault();
        focusHunk(Math.min(i + 1, hunks.length - 1));
        break;
      case "k":
        e.preventDefault();
        focusHunk(Math.max(i - 1, 0));
        break;
      case "y":
        e.preventDefault();
        setAudit((a) => ({ ...a, [i]: a[i] === "accepted" ? undefined as any : "accepted" }));
        break;
      case "n":
        e.preventDefault();
        setAudit((a) => ({ ...a, [i]: a[i] === "rejected" ? undefined as any : "rejected" }));
        break;
 // 'e' (open-in-editor) is intentionally not bound — wire to a
 // real `open_in_editor` host command when that lands.
    }
  }

  return (
    <div className="tool-diff" ref={containerRef} onKeyDown={onKey}>
      <button
        type="button"
        className="diff-path"
        style={{ background: "transparent", border: "none", padding: 0, cursor: "pointer", color: "var(--ink)", font: "inherit" }}
        onClick={() => path && onOpen(path)}
      >
        {path}
      </button>
 {/* Hint renders once as a chat-output footer when any diff is
 * visible — see hasAnyDiff in <ChatOutput/>. */}
      {hunks.map((h, i) => {
        const state = audit[i];
        const cls = state === "accepted" ? "hunk accepted"
                  : state === "rejected" ? "hunk rejected"
                  : "hunk";
        return (
          <div
            key={i}
            className={cls}
            data-hunk
            data-hunk-idx={i}
            tabIndex={0}
            role="region"
            aria-label={`hunk ${i + 1} of ${hunks.length}`}
          >
            {h.old && <div className="diff-old">{`- ${truncate(h.old, 800)}`}</div>}
            <div className="diff-new">{`+ ${truncate(h.new, 4000)}`}</div>
          </div>
        );
      })}
    </div>
  );
}

interface Hunk { old: string; new: string }

/** Best-effort hunk split — gracefully degrades when no `@@` markers. */
function splitHunks(oldText: string, newText: string): Hunk[] {
 // If the new text looks like a unified-diff body, split on hunk headers.
  if (newText.includes("@@")) {
    const chunks = newText.split(/^(?=@@)/m).filter((c) => c.trim().length > 0);
    if (chunks.length > 1) return chunks.map((c) => ({ old: "", new: c }));
  }
 // Default: single hunk = the whole pair. Empty old = new file.
  return [{ old: oldText, new: newText }];
}

function ThoughtPill({ g }: { g: ThoughtGroup }): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <div className="row-pill thought">
      <Time t={g.t} />
      <span className="pi" />
 {/* Chunk count intentionally omitted — already visible in the
          toggled-open body. */}
      <span className="label">thought</span>
      <button type="button" className="toggle" onClick={() => setOpen((v) => !v)}>
        {open ? "hide" : "show"}
      </button>
      {open && <pre className="thought-body">{g.text}</pre>}
    </div>
  );
}

function SystemPill({ g }: { g: SystemGroup }): JSX.Element {
  return (
    <div className="row-pill system">
      <Time t={g.t} />
      <span className="pi" />
      <span className="label">
        <SystemIcon icon={g.icon} />
        {g.label}
      </span>
      {g.detail && <span className="detail">{truncate(g.detail, 120)}</span>}
    </div>
  );
}

function SystemIcon({ icon }: { icon?: string }): JSX.Element {
  const name: ShellIconName =
    icon === "✎" ? "pencil" :
    icon === "⚠" ? "alert" :
    icon === "⏹" ? "square" :
    icon === "⊞" ? "plus" :
    icon === "≡" ? "terminal" :
    "circle";
  return <ShellIcon name={name} size={13} />;
}

function uiEventStatus(text: string): { icon: ShellIconName; label: string } {
  if (text.startsWith("✓ ")) return { icon: "check", label: text.slice(2) };
  if (text.startsWith("✗ ")) return { icon: "alert", label: text.slice(2) };
  if (text.startsWith("⏹")) return { icon: "square", label: text.replace(/^⏹\s*/, "") };
  if (text.startsWith("→ connect")) return { icon: "link", label: text.replace(/^→\s*/, "") };
  return { icon: "circle", label: text };
}

/**
 * doom_loop_detected chip. Amber pill rendered when grok's anti-loop
 * watchdog flags repeated tool invocations. Click-to-dismiss; the
 * underlying event stays in events[] for the right-pane forensic view.
 * Has its own visual weight (not a SystemPill) because SystemPill's
 * "⚠" is saturated with boot-time noise and would be ignored.
 *
 * Wire shape (DoomLoopGroup):
 * { message, repeat_count, tool_names: [string], is_warning: bool }
 */
function DoomLoopChip({ g }: { g: DoomLoopGroup }): JSX.Element | null {
  const [dismissed, setDismissed] = useState(false);
  if (dismissed) return null;
  const toolList = g.toolNames.length > 0 ? g.toolNames.join(", ") : "(unknown)";
  const summary = `stuck loop: ${toolList} ×${g.repeatCount}`;
  return (
    <div
      className="row-pill doom-loop"
      onClick={() => setDismissed(true)}
      title={`${g.message} — click to dismiss`}
      style={{
        cursor: "pointer",
        background: "color-mix(in oklab, var(--warn, #f59e0b) 18%, transparent)",
        border: "1px solid var(--warn, #f59e0b)",
        color: "var(--ink)",
      }}
    >
      <Time t={g.t} />
      <span className="pi" />
      <span className="label" style={{ fontWeight: 500 }}>
        <ShellIcon name="alert" size={13} />
        {summary}
      </span>
      {g.message && g.message !== summary && (
        <span className="detail">{truncate(g.message, 120)}</span>
      )}
    </div>
  );
}

function HostMcpUnreachableChip({
  g,
}: {
  g: HostMcpUnreachableGroup;
}): JSX.Element | null {
  const [dismissed, setDismissed] = useState(false);
  if (dismissed) return null;
  const toolLabel = g.toolName ? ` · ${g.toolName}` : "";
  const haltedLabel = g.goalHalted ? " · goal halted" : "";
  return (
    <div
      className="row-pill host-mcp-unreachable"
      onClick={() => setDismissed(true)}
      title={`${g.message} — click to dismiss`}
      style={{
        cursor: "pointer",
        background: "color-mix(in oklab, var(--danger, #ef4444) 16%, transparent)",
        border: "1px solid var(--danger, #ef4444)",
        color: "var(--ink)",
      }}
    >
      <Time t={g.t} />
      <span className="pi" />
      <span className="label" style={{ fontWeight: 600 }}>
        <ShellIcon name="alert" size={13} />
        host-MCP unreachable{toolLabel}{haltedLabel}
      </span>
      {g.repeatCount > 1 && <span className="detail">repeat {g.repeatCount}</span>}
      {g.message && (
        <span className="detail">{truncate(g.message, 140)}</span>
      )}
    </div>
  );
}

function VendorPill({ g }: { g: VendorGroup }): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <div className="row-pill vendor">
      <Time t={g.t} />
      <span className="pi" />
      <span className="label">{g.method.replace(/^_x\.ai\//, "")}</span>
      <button type="button" className="toggle" onClick={() => setOpen((v) => !v)}>
        {open ? "hide" : "show"}
      </button>
      {open && <pre className="vendor-body">{g.detail}</pre>}
    </div>
  );
}

/* ─────────────── Helpers ─────────────── */

function Time({ t }: { t: number }): JSX.Element {
  return <span className="time">{fmtTime(t)}</span>;
}
function fmtTime(t: number): string {
  const d = new Date(t);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function pad(n: number): string {
  return String(n).padStart(2, "0");
}
function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}
function baseName(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? p;
}
function normalizeStatus(s: string): "run" | "done" | "fail" | "idle" {
  const v = s.toLowerCase();
  if (v.includes("complete") || v.includes("done") || v.includes("success")) return "done";
  if (v.includes("fail") || v.includes("error") || v.includes("denied")) return "fail";
  if (v.includes("pending") || v.includes("idle")) return "idle";
  return "run";
}
