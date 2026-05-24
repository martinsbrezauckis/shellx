/**
 * src/components/FindPopover.tsx — header Find input + chat-results popover.
 *
 * Lives next to the brand in the top header. On focus a popover opens
 * below showing matching CHATS (plugin search is in the Plugins modal;
 * file search is in the right-rail Files tab). Row click only selects
 * — the explicit "Open in new tab" button (or Enter) loads the chat.
 * Disk hits fetch a context snippet via /sessions/<id>/snippet?q=…;
 * 404 falls back to the ChatHit's own .snippet.
 *
 * Keyboard:
 * ⌘K / ⌃K focus input
 * ↑ / ↓ navigate
 * ⏎ open selected
 * Tab focus the Open button (preview pane)
 * Esc clear selection; blur if already cleared
 */
import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from "react";
import { api } from "../lib/debug-api";
import { ShellIcon, TransportIcon } from "./icons";

export interface ChatHit {
  id: string;
  title: string;
 /** stable transport id; legacy emoji values are still normalized by TransportIcon */
  transport: string;
 /** project name (or "—" for unfiled) */
  project: string;
 /** human-readable "12 min ago" / "2d" */
  ageLabel: string;
 /** status dot color */
  status: "run" | "done" | "idle" | "input";
}

/**
 * Search the live session-tab `corpus` supplied by the parent. Full-
 * content JSONL search lives behind a future `/sessions/search?q=…`
 * Rust route; until then this matches against open-tab titles only.
 *
 * @internal — exported for unit tests.
 */
export function searchChats(q: string, corpus: ChatHit[] = []): ChatHit[] {
  if (!q.trim()) return corpus.slice(0, 8);
  const needle = q.toLowerCase();
  return corpus
    .map((c) => ({ c, idx: c.title.toLowerCase().indexOf(needle) }))
    .filter((x) => x.idx >= 0)
    .sort((a, b) => a.idx - b.idx || a.c.title.localeCompare(b.c.title))
    .slice(0, 8)
    .map((x) => x.c);
}

/**
 * Render `text` with the substring `q` highlighted in <mark>.
 * Case-insensitive match; returns a stable JSX fragment.
 */
function highlight(text: string, q: string): JSX.Element {
  if (!q.trim()) return <>{text}</>;
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, i)}
      <mark>{text.slice(i, i + q.length)}</mark>
      {text.slice(i + q.length)}
    </>
  );
}

/**
 * The Find component itself. Renders an `<input>` styled as a search chip
 * + an absolutely-positioned popover on focus. Self-contained — parent
 * only needs to pass an `onOpenChat(id)` callback.
 */
export function FindPopover({
  onOpenChat,
  corpus = [],
}: {
  onOpenChat: (chatId: string) => void;
 /** Real session-tab data injected by App.tsx — honest data. */
  corpus?: ChatHit[];
}): JSX.Element {
  const [q, setQ] = useState("");
  const [focused, setFocused] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);

 /* real content search via /sessions/search debug-api.
 * Owner reported the previous title-only search felt fake. Now the
 * popover shows two-tier results:
 * (1) Open-tab hits — match against the live tabs[] (corpus prop),
 * same as before. Fastest, zero round-trip.
 * (2) Disk hits — match against every ~/.shellx/sessions/*.jsonl
 * file via the new debug-api endpoint. Includes a snippet
 * highlighting where the match landed.
 *
 * Debounced 200ms to avoid hammering the API on every keystroke. */
  interface DiskHit {
    id: string;
    title: string;
    mtimeMs: number;
    matchCount: number;
    snippet: string;
  }
  const [diskHits, setDiskHits] = useState<DiskHit[]>([]);
  const [searching, setSearching] = useState(false);

 /* surface search errors so they're not silent. The
 * old version swallowed every failure (4xx, network error, parse
 * error) and set hits=[] — the user reported "search not working
 * after a whole day" because the popup just showed empty without
 * any hint as to WHY. Now `searchError` is rendered as a one-line
 * red note above the empty state. */
  const [searchError, setSearchError] = useState<string | null>(null);
  useEffect(() => {
    const needle = q.trim();
    if (!needle) { setDiskHits([]); setSearchError(null); return; }
    let cancelled = false;
    setSearching(true);
    setSearchError(null);
    const t = setTimeout(() => {
      void api(`/sessions/search?q=${encodeURIComponent(needle)}&limit=20`)
        .then(async (r) => {
          if (!r.ok) {
            const body = await r.text().catch(() => "");
            throw new Error(`HTTP ${r.status}${body ? `: ${body.slice(0, 120)}` : ""}`);
          }
          return r.json();
        })
        .then((j: { results?: DiskHit[] }) => {
          if (!cancelled) setDiskHits(j.results ?? []);
        })
        .catch((err) => {
          if (cancelled) return;
          setDiskHits([]);
          setSearchError(err instanceof Error ? err.message : String(err));
          console.warn("[shellX] /sessions/search failed:", err);
        })
        .finally(() => { if (!cancelled) setSearching(false); });
    }, 200);
    return () => { cancelled = true; clearTimeout(t); };
  }, [q]);

 // Combined for keyboard nav: open tabs first, then disk.
  type Combined = { kind: "open"; hit: ChatHit } | { kind: "disk"; hit: DiskHit };
 //  // `results` MUST be referentially stable when its content is stable.
 // Previously these three lines built a fresh array on every render —
 // so when a chat was streaming (corpus prop changing per chunk), the
 // preview effect's `[selectedIdx, results, q]` dep saw a new `results`
 // reference every render, cancelled the in-flight snippet fetch, and
 // the spinner got stuck because the `.finally` saw `cancelled=true`
 // and skipped the loading-false setter. useMemo'd content arrays +
 // a memoized combined array let identity stabilize as soon as the
 // user stops typing.
  const openTabHits = useMemo(() => searchChats(q, corpus), [q, corpus]);
  const filteredDiskHits = useMemo(() => {
    const openIds = new Set(openTabHits.map((h) => h.id));
    return diskHits.filter((h) => !openIds.has(h.id));
  }, [openTabHits, diskHits]);
  const results = useMemo<Combined[]>(
    () => [
      ...openTabHits.map((h) => ({ kind: "open" as const, hit: h })),
      ...filteredDiskHits.map((h) => ({ kind: "disk" as const, hit: h })),
    ],
    [openTabHits, filteredDiskHits],
  );

 // ⌘K / ⌃K focuses the input from anywhere on the page.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

 // Click-outside dismiss. Popover stays open while typing.
  useEffect(() => {
    if (!focused) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (
        inputRef.current && !inputRef.current.contains(t) &&
        popoverRef.current && !popoverRef.current.contains(t)
      ) {
        setFocused(false);
      }
    };
    window.addEventListener("mousedown", onDoc);
    return () => window.removeEventListener("mousedown", onDoc);
  }, [focused]);

 /* selection state — distinct from activeIdx.
 * - `activeIdx` highlights the row under arrow-key cursor (visual
 * hover-equivalent, drives "what would Enter open").
 * - `selectedIdx` is the row pinned to the preview pane. Set when
 * the user CLICKS a row or arrow-keys; null when the user pressed
 * Esc once to dismiss the preview without closing the popover.
 * Click → set both. Arrow → set both. Esc → clear selectedIdx first;
 * second Esc closes the popover (Esc-cascade). */
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null);
  const openBtnRef = useRef<HTMLButtonElement | null>(null);

 // Reset selection when query changes.
  useEffect(() => { setActiveIdx(0); setSelectedIdx(null); }, [q]);

 /* preview body for the right pane. Disk hits
 * try the new /sessions/<id>/snippet?q=... endpoint (which gives a
 * larger context window than the search response's tiny snippet).
 * If that endpoint 404s, gracefully fall back to the original
 * h.snippet on the result object — never block the UX on backend.
 * Open hits don't have an event corpus passed in, so we show a
 * neutral metadata block + a hint to open the tab.
 *
 * backend now returns JSON
 * { id, query, hits: [{ tMs, around }] }
 * instead of plain text. Each hit's `around` already contains
 * `<mark>…</mark>` around the match. We render up to 5 hits stacked
 * vertically, dangerouslySetInnerHTML on a sanitized subset (only
 * <mark> tags allowed via a simple escape-then-restore pass) so the
 * highlights survive without exposing the preview to general HTML
 * injection (the snippet content is operator-trusted but defense in
 * depth is cheap). */
  interface SnippetHit { tMs: number; around: string }
  const [previewBody, setPreviewBody] = useState<string>("");
  const [previewHits, setPreviewHits] = useState<SnippetHit[]>([]);
  const [previewLoading, setPreviewLoading] = useState(false);
  useEffect(() => {
 // every
 // early-return below MUST clear previewLoading. The previous code
 // only cleared it in the .finally of the disk-hit fetch — so if
 // the user clicked a disk hit (loading→true), then switched to an
 // open-tab hit OR cleared the query (which made selectedIdx null
 // or `entry` undefined), the early-return skipped the cleanup and
 // the spinner persisted forever. ALWAYS reset at the top.
    setPreviewLoading(false);
    if (selectedIdx == null) { setPreviewBody(""); setPreviewHits([]); return; }
    const entry = results[selectedIdx];
    if (!entry) { setPreviewBody(""); setPreviewHits([]); return; }
    if (entry.kind === "open") {
 // Open-tab preview: we don't have the in-memory events corpus
 // here (parent didn't pass it). Show a metadata block with a
 // pointer to the Open button. This is intentionally honest so the
 // preview never pretends to show content it does not have.
      const h = entry.hit;
      setPreviewHits([]);
      setPreviewBody(
        `Open chat in tab strip.\n` +
        `Title:     ${h.title}\n` +
        `Project:   ${h.project}\n` +
        `Status:    ${h.status}\n` +
        `Age:       ${h.ageLabel}\n` +
        `Transport: ${h.transport}\n\n` +
        `(Inline event preview not wired yet — click "Open in new tab" to view full history.)`,
      );
      return;
    }
 // Disk hit: try the snippet endpoint, fall back to h.snippet.
    const h = entry.hit;
    setPreviewLoading(true);
    setPreviewBody("");
    setPreviewHits([]);
    let cancelled = false;
    void api(`/sessions/${encodeURIComponent(h.id)}/snippet?q=${encodeURIComponent(q)}&ctxLines=4`)
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
 // Endpoint returns JSON; tolerate legacy text body for safety.
        const ct = r.headers.get("content-type") ?? "";
        if (ct.includes("application/json")) {
          return r.json() as Promise<{ hits?: SnippetHit[] }>;
        }
        return { hits: [] as SnippetHit[] };
      })
      .then((j) => {
        if (cancelled) return;
        const hits = Array.isArray(j?.hits) ? j.hits : [];
        if (hits.length === 0) {
          setPreviewBody(h.snippet || "(no matches in this session)");
        } else {
          setPreviewHits(hits);
        }
      })
      .catch(() => {
        if (!cancelled) setPreviewBody(h.snippet || "(no snippet available)");
      })
 // ALWAYS clear loading on settle, even if the closure
 // is stale. The previous `if (!cancelled)` guard left the spinner
 // permanently stuck when a re-render cancelled this closure before
 // the fetch returned (e.g. corpus updating during an active chat).
 // setPreviewLoading is idempotent; clearing it from a stale fetch
 // is harmless because the next effect run already sets it to true
 // at the top before kicking the new fetch.
      .finally(() => { setPreviewLoading(false); });
    return () => { cancelled = true; };
  }, [selectedIdx, results, q]);

 /**
 * Escape every HTML character in `s` EXCEPT for the `<mark>` /
 * `</mark>` tags emitted by the backend snippet handler. Returned
 * string is safe for dangerouslySetInnerHTML — the only retained
 * markup is the highlight wrapper. Cheaper than DOMPurify and the
 * grammar of allowed tags is fixed at one.
 */
  function escapeKeepMark(s: string): string {
 // Replace mark tags with sentinels, escape everything, then restore.
    const OPEN = "MARK_OPEN";
    const CLOSE = "MARK_CLOSE";
    const t = s.replace(/<mark>/g, OPEN).replace(/<\/mark>/g, CLOSE);
    const esc = t
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    return esc.replace(new RegExp(OPEN, "g"), "<mark>").replace(new RegExp(CLOSE, "g"), "</mark>");
  }

 /** shared open action — clears state and fires the prop. */
  const fireOpen = useCallback((entry: Combined) => {
    onOpenChat(entry.hit.id);
    setFocused(false);
    setQ("");
    setSelectedIdx(null);
  }, [onOpenChat]);

  const handleKey = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
 /* Esc-cascade — first Esc clears selection (preview pane
 * collapses), second Esc closes the popover entirely. */
      if (selectedIdx != null) {
        setSelectedIdx(null);
        return;
      }
      setFocused(false);
      inputRef.current?.blur();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIdx((i) => {
        const next = Math.min(results.length - 1, i + 1);
        setSelectedIdx(next);
        return next;
      });
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx((i) => {
        const next = Math.max(0, i - 1);
        setSelectedIdx(next);
        return next;
      });
    } else if (e.key === "Enter") {
      e.preventDefault();
      const entry = results[activeIdx];
      if (entry) fireOpen(entry);
    } else if (e.key === "Tab" && selectedIdx != null) {
 /* Tab focuses the Open button when a preview is showing,
 * so keyboard users can confirm without grabbing the mouse. */
      e.preventDefault();
      openBtnRef.current?.focus();
    }
  }, [results, activeIdx, selectedIdx, fireOpen]);

  return (
    <div className="find-wrap">
      <div className="find-bar" onClick={() => inputRef.current?.focus()}>
        <span className="find-ic">
          <ShellIcon name="search" size={13} />
        </span>
        <input
          ref={inputRef}
          type="text"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onFocus={() => setFocused(true)}
          onKeyDown={handleKey}
          placeholder="Search…"
          aria-label="Search sessions"
        />
 {/* drop the duplicate `⌘K` hint chip.
 * Was rendering as `⌘ <weird-glyph> K` because the keyboard
 * symbol got mojibake'd between font fallbacks. The Ctrl-K
 * binding still works (handleKey) — just no on-input chip. */}
      </div>

      {focused && (
 /* popover widens from 420px to ~720px when a preview is
 * showing. CSS handles the base width; we toggle .with-preview
 * for the wide variant. Inner layout is a flex row: results
 * list on the left (320px fixed), preview pane on the right
 * (fills remaining width). */
        <div
          ref={popoverRef}
          className={`find-popover ${selectedIdx != null ? "with-preview" : ""}`}
          role="listbox"
        >
          <div className="find-pop-head">
            <span>{q.trim() ? "Chats matching" : "Recent chats"}</span>
            {q.trim() && <span className="ct">"{q}"</span>}
            <span style={{ marginLeft: "auto", color: "var(--ink-3)" }}>
              {openTabHits.length} open · {filteredDiskHits.length} on disk
            </span>
          </div>

          <div className="find-pop-body">
 {/* List column */}
            <div
              className="find-list-col"
              style={{ flex: selectedIdx != null ? "0 0 320px" : "1 1 auto" }}
            >
 {/* surface backend search errors so we never
 * silently empty-state when the request actually failed. */}
              {searchError && q.trim() !== "" && (
                <div style={{ padding: "8px 14px", color: "var(--err)", fontSize: 12, fontFamily: "var(--mono)", borderBottom: "1px solid var(--hairline)" }}>
                  <ShellIcon name="alert" size={13} /> search: {searchError}
                </div>
              )}

              {results.length === 0 && !searching && !searchError && (
                <div style={{ padding: "16px 14px", color: "var(--ink-3)", fontSize: "var(--fs-ui-sm)" }}>
                  {corpus.length === 0 && q.trim() === ""
                    ? "No open sessions yet. Start a chat to populate this."
                    : `No sessions match "${q}".`}
                </div>
              )}
              {q.trim() === "" && (
                <div style={{ padding: "8px 14px 0", color: "var(--ink-4)", fontSize: "var(--fs-ui-xs)", letterSpacing: "0.06em" }}>
                  Type to search inside every chat's content — not just titles.
                </div>
              )}
              {searching && q.trim() !== "" && results.length === 0 && (
                <div style={{ padding: "12px 14px", color: "var(--ink-3)", fontSize: 12 }}>
                  · searching ~/.shellx/sessions/ ...
                </div>
              )}

              {results.map((entry, i) => {
 /* click no longer opens — it SELECTS (preview pane
 * loads). Double-click still acts as the legacy quick-open
 * for users who want the old behavior. */
                const onRowClick = () => { setActiveIdx(i); setSelectedIdx(i); };
                const onRowDouble = () => fireOpen(entry);
                if (entry.kind === "open") {
                  const h = entry.hit;
                  return (
                    <div
                      key={`open-${h.id}`}
                      className={`find-row ${i === activeIdx ? "active" : ""} ${i === selectedIdx ? "selected" : ""}`}
                      onClick={onRowClick}
                      onDoubleClick={onRowDouble}
                      onMouseEnter={() => setActiveIdx(i)}
                      role="option"
                      aria-selected={i === selectedIdx}
                    >
                      <span className={`csd ${h.status}`} />
                      <span className="ttr">
                        <TransportIcon value={h.transport} size={14} />
                      </span>
                      <span className="ftitle">{highlight(h.title, q)}</span>
                      <span className="fmeta">{h.project} · {h.ageLabel}</span>
                    </div>
                  );
                }
                const h = entry.hit;
                return (
                  <div
                    key={`disk-${h.id}`}
                    className={`find-row ${i === activeIdx ? "active" : ""} ${i === selectedIdx ? "selected" : ""}`}
                    onClick={onRowClick}
                    onDoubleClick={onRowDouble}
                    onMouseEnter={() => setActiveIdx(i)}
                    role="option"
                    aria-selected={i === selectedIdx}
                    title={h.snippet}
                  >
                    <span className="csd done" />
                    <span className="ttr">
                      <ShellIcon name="folder" size={14} />
                    </span>
                    <span className="ftitle" style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                      <span>{highlight(h.title, q)}</span>
                      <span style={{ fontSize: "var(--fs-ui-xs)", color: "var(--ink-3)", fontFamily: "var(--mono)" }}>
                        {highlight(h.snippet, q)}
                      </span>
                    </span>
                    <span className="fmeta">{h.matchCount} match{h.matchCount > 1 ? "es" : ""}</span>
                  </div>
                );
              })}
            </div>

 {/* Preview pane */}
            {selectedIdx != null && results[selectedIdx] && (
              <div
                className="find-preview"
                style={{
                  flex: "1 1 auto",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "8px 12px",
                    borderBottom: "1px solid var(--hairline)",
                    fontSize: 12,
                    color: "var(--ink-2)",
                  }}
                >
                  <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {results[selectedIdx].hit.title}
                  </span>
                  <button
                    ref={openBtnRef}
                    type="button"
                    onClick={() => {
                      const entry = results[selectedIdx];
                      if (entry) fireOpen(entry);
                    }}
                    style={{
                      background: "var(--orange)",
                      color: "#000",
                      border: "none",
                      borderRadius: 4,
                      padding: "4px 10px",
                      fontFamily: "var(--sans)",
                      fontSize: 12,
                      fontWeight: 600,
                      cursor: "pointer",
                      whiteSpace: "nowrap",
                    }}
                    title="Open this chat in a new tab (Enter)"
                  >
                    Open in new tab
                  </button>
                </div>
                <div
                  className="find-preview-body"
                  style={{
                    padding: "10px 12px",
                    fontFamily: "var(--mono)",
                    fontSize: 12,
                    color: "var(--ink-2)",
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                  }}
                >
                  {previewLoading
                    ? "· loading snippet…"
                    : previewHits.length > 0
                      ? (
 /* render up to 5 highlighted excerpts stacked
 * vertically. Each excerpt's `around` carries
 * <mark>…</mark> wrappers from the backend; escape
 * everything else to keep dangerouslySetInnerHTML
 * tight. */
                        <div>
                          {previewHits.map((h, idx) => (
                            <div
                              key={`hit-${idx}`}
                              style={{
                                marginBottom: idx < previewHits.length - 1 ? 10 : 0,
                                paddingBottom: idx < previewHits.length - 1 ? 8 : 0,
                                borderBottom: idx < previewHits.length - 1 ? "1px dashed var(--hairline)" : "none",
                              }}
                            >
 {/* eslint-disable-next-line react/no-danger */}
                              <span dangerouslySetInnerHTML={{ __html: escapeKeepMark(h.around) }} />
                            </div>
                          ))}
                        </div>
                      )
                      : previewBody}
                </div>
              </div>
            )}
          </div>

          <div className="find-pop-foot">
            <span><kbd>↑↓</kbd> navigate</span>
            <span><kbd>⏎</kbd> open</span>
            <span><kbd>Tab</kbd> open btn</span>
            <span><kbd>Esc</kbd> {selectedIdx != null ? "clear preview" : "close"}</span>
          </div>
        </div>
      )}
    </div>
  );
}
