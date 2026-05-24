/**
 * src/components/FilePreviewModal.tsx — read-only file preview modal.
 *
 * Renders a file based on its extension:
 * - .md / .markdown → ReactMarkdown + remark-gfm
 * - .html / .htm → Code by default, optional sandboxed static output preview
 * - source code → ShikiHighlight (same renderer as RightRail)
 * - .png/.jpg/.jpeg/.gif/.webp/.svg → <img> via Tauri assetProtocol
 * - .mp4/.webm/.mov/.m4v/.mkv → <video> via Tauri assetProtocol
 * - .pdf → <iframe> with native PDF viewer (browser
 * preview mode falls back to text)
 * - everything else → <pre> with monospace text
 *
 * Content fetched via `read_text_file_for_path` (handles WSL UNC
 * translation). Images skip the read — asset:// renders directly.
 *
 * View-only by design. Bottom-bar actions: Close · Copy path · Copy
 * @mention for the composer.
 */
import { useCallback, useEffect, useMemo, useState, type JSX } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { onMouseUpAutoCopy } from "../lib/auto-copy-selection";
import { ShikiHighlight } from "./ShikiHighlight";
import { inTauri } from "../lib/tauri-bridge";
import { SafeMarkdownLink } from "../lib/markdown-links";
import { SafeImg, SafeVideo } from "./MediaPreview";
import {
  previewKindForPath,
  shouldReadTextForPreviewKind,
  type PreviewKind,
} from "../lib/file-preview-types";

export function FilePreviewModal({
  open,
  path,
  tabId,
  sessionCwd,
  onClose,
  onPreviewFile,
}: {
  open: boolean;
  path: string | null;
  tabId?: string | null;
  sessionCwd?: string | null;
  onClose: () => void;
  onPreviewFile?: (path: string) => void;
}): JSX.Element | null {
  const [text, setText] = useState<string>("");
  const [loading, setLoading] = useState<boolean>(false);
  const [err, setErr] = useState<string | null>(null);
  const [htmlMode, setHtmlMode] = useState<"code" | "preview">("code");

  const kind = useMemo<PreviewKind>(() => (path ? previewKindForPath(path) : "unknown"), [path]);

  useEffect(() => {
    setHtmlMode("code");
  }, [path]);

 // Esc closes. Click on backdrop closes. The modal body stops propagation.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); onClose(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

 // Fetch text content only for known text-like kinds. Binary or
 // unsupported formats must not be lossy-decoded into visual garbage.
  useEffect(() => {
    if (!open || !path) {
      setText("");
      setErr(null);
      setLoading(false);
      return;
    }
    if (!shouldReadTextForPreviewKind(kind)) {
      setText("");
      setErr(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setErr(null);
    if (inTauri()) {
      void invoke<string>("read_text_file_for_path", {
        path,
        tabId: tabId ?? undefined,
        sessionCwd: sessionCwd ?? undefined,
      })
        .then((t) => { if (!cancelled) setText(t); })
        .catch((e) => {
          if (!cancelled) setErr(typeof e === "string" ? e : String(e));
        })
        .finally(() => { if (!cancelled) setLoading(false); });
    } else {
 // Browser-mode fallback: try asset:// fetch
      fetch(convertFileSrc(path, "asset"))
        .then((r) => r.ok ? r.text() : Promise.reject(`HTTP ${r.status}`))
        .then((t) => { if (!cancelled) setText(t); })
        .catch((e) => { if (!cancelled) setErr(String(e)); })
        .finally(() => { if (!cancelled) setLoading(false); });
    }
    return () => { cancelled = true; };
  }, [open, path, kind, tabId, sessionCwd]);

  const onCopyPath = useCallback(() => {
    if (!path) return;
    try { void navigator.clipboard.writeText(path); } catch { /* no-op */ }
  }, [path]);

 // "Copy as @mention" — replaces the old "Send to chat" auto-prompt
 // which fired the meaningless string "Read the file at X and discuss
 // its contents briefly." That carried no actual intent; the user
 // wanted to *reference* the file, not have grok summarize a random
 // attachment. Now the button copies `@<absolute path>` to clipboard
 // so the user pastes it into the composer with their own question.
  const [copied, setCopied] = useState(false);
  const onCopyMention = useCallback(() => {
    if (!path) return;
    try { void navigator.clipboard.writeText(`@${path} `); } catch { /* no-op */ }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [path]);

  if (!open || !path) return null;

 // Filename for the header (basename only).
  const fname = path.split(/[\\/]/).pop() || path;
  const lineCount = text ? text.split("\n").length : 0;

  return (
    <div
      className="preview-backdrop"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={`Preview ${fname}`}
    >
      <div
        className="preview-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="preview-head">
          <span className="preview-fname" title={path}>{fname}</span>
          <span className="preview-kind">{kind}</span>
          {lineCount > 0 && <span className="preview-lines">{lineCount} lines</span>}
          {kind === "html" && (
            <div className="preview-mode-toggle" role="tablist" aria-label="HTML preview mode">
              <button
                type="button"
                className={htmlMode === "code" ? "active" : ""}
                onClick={() => setHtmlMode("code")}
                aria-selected={htmlMode === "code"}
              >
                Code
              </button>
              <button
                type="button"
                className={htmlMode === "preview" ? "active" : ""}
                onClick={() => setHtmlMode("preview")}
                aria-selected={htmlMode === "preview"}
              >
                Preview
              </button>
            </div>
          )}
          <button
            type="button"
            className="preview-close"
            onClick={onClose}
            aria-label="Close (Esc)"
            title="Close (Esc)"
          >
            ✕
          </button>
        </div>

        <div className={`preview-body preview-body-${kind}`} onMouseUp={onMouseUpAutoCopy}>
          {err && <div className="preview-err">{err}</div>}
          {loading && !err && <div className="preview-loading">Loading…</div>}

          {!loading && !err && kind === "markdown" && (
            <div className="preview-md">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                  a: ({ href, children }) => (
                    <SafeMarkdownLink
                      href={href}
                      currentPath={path}
                      onPreviewFile={onPreviewFile}
                    >
                      {children}
                    </SafeMarkdownLink>
                  ),
                }}
              >
                {text}
              </ReactMarkdown>
            </div>
          )}

          {!loading && !err && kind === "code" && (
            <ShikiHighlight code={text} path={path} />
          )}

          {!loading && !err && kind === "html" && (
            htmlMode === "preview" ? (
              <HtmlPreview html={text} title={fname} />
            ) : (
              <ShikiHighlight code={text} path={path} />
            )
          )}

          {!loading && !err && kind === "text" && (
            <pre className="preview-text">{text}</pre>
          )}

          {!loading && !err && kind === "unknown" && (
            <div className="preview-unsupported">
              <div className="preview-unsupported-title">Preview not supported</div>
              <div className="preview-unsupported-detail">
                This file type cannot be rendered safely inside shellX yet.
              </div>
            </div>
          )}

          {!err && kind === "image" && (
            <div className="preview-image">
              {inTauri() ? (
                <SafeImg
                  src={path}
                  alt={fname}
                  tabId={tabId ?? undefined}
                  sessionCwd={sessionCwd ?? undefined}
                  className="preview-image-img"
                />
              ) : (
                <div className="preview-err">Image preview requires Tauri</div>
              )}
            </div>
          )}

          {!err && kind === "video" && (
            <div className="preview-video">
              {inTauri() ? (
                <SafeVideo
                  src={path}
                  title={fname}
                  tabId={tabId ?? undefined}
                  sessionCwd={sessionCwd ?? undefined}
                  controls
                  className="preview-video-player"
                  preload="metadata"
                />
              ) : (
                <div className="preview-err">Video preview requires Tauri</div>
              )}
            </div>
          )}

          {!err && kind === "pdf" && (
            <div className="preview-pdf">
              {inTauri() ? (
                <PdfPreview
                  path={path}
                  title={fname}
                  tabId={tabId ?? undefined}
                  sessionCwd={sessionCwd ?? undefined}
                />
              ) : (
                <div className="preview-err">PDF preview requires Tauri</div>
              )}
            </div>
          )}
        </div>

        <div className="preview-actions">
          <button
            type="button"
            className="pact"
            onClick={onCopyPath}
            title="Copy absolute path to clipboard"
          >
            ⎘ Copy path
          </button>
          <button
            type="button"
            className="pact pact-edit"
            onClick={onCopyMention}
            title="Copies `@<path>` to clipboard. Paste into the composer to mention the file in your next prompt."
          >
            {copied ? "✓ Copied @mention" : "@ Copy as mention"}
          </button>
          <button
            type="button"
            className="pact"
            onClick={onClose}
            title="Close (Esc)"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

function HtmlPreview({ html, title }: { html: string; title: string }): JSX.Element {
  const srcDoc = useMemo(() => buildSafeHtmlPreviewDocument(html), [html]);
  return (
    <iframe
      srcDoc={srcDoc}
      title={`Rendered HTML preview: ${title}`}
      className="preview-html-iframe"
      sandbox=""
      referrerPolicy="no-referrer"
    />
  );
}

function PdfPreview({
  path,
  title,
  tabId,
  sessionCwd,
}: {
  path: string;
  title: string;
  tabId?: string;
  sessionCwd?: string;
}): JSX.Element {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let url: string | null = null;
    setBlobUrl(null);
    setErr(null);

    void invoke<string>("read_preview_file_as_data_url", { path, tabId, sessionCwd })
      .then((dataUrl) => {
        const blob = dataUrlToBlob(dataUrl);
        url = URL.createObjectURL(blob);
        if (cancelled) {
          URL.revokeObjectURL(url);
          return;
        }
        setBlobUrl(url);
      })
      .catch((e) => {
        if (!cancelled) setErr(typeof e === "string" ? e : String(e));
      });

    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [path, tabId, sessionCwd]);

  if (err) return <div className="preview-err">{err}</div>;
  if (!blobUrl) return <div className="preview-loading">Loading PDF…</div>;

  return (
    <iframe
      src={blobUrl}
      title={title}
      className="preview-pdf-iframe"
      referrerPolicy="no-referrer"
    />
  );
}

const HTML_PREVIEW_CSP = [
  "default-src 'none'",
  "script-src 'none'",
  "connect-src 'none'",
  "img-src data: blob:",
  "style-src 'unsafe-inline'",
  "font-src data:",
  "media-src data: blob:",
  "frame-src 'none'",
  "object-src 'none'",
  "worker-src 'none'",
  "manifest-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

const HTML_PREVIEW_HEAD = `<meta http-equiv="Content-Security-Policy" content="${HTML_PREVIEW_CSP}"><meta charset="utf-8"><style>html,body{min-height:100%;margin:0;background:#fff;color:#111;}body{box-sizing:border-box;}</style>`;

function buildSafeHtmlPreviewDocument(html: string): string {
  let styles = "";
  let body = html;
  if (typeof DOMParser !== "undefined") {
    const doc = new DOMParser().parseFromString(html, "text/html");
    doc
      .querySelectorAll("script, iframe, object, embed, link, base, meta[http-equiv]")
      .forEach((node) => node.remove());
    styles = Array.from(doc.head.querySelectorAll("style"))
      .map((node) => node.outerHTML)
      .join("\n");
    body = doc.body.innerHTML;
  } else {
    body = `<pre>${escapeHtml(html)}</pre>`;
  }
  return `<!doctype html><html><head>${HTML_PREVIEW_HEAD}${styles}</head><body>${body}</body></html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function dataUrlToBlob(dataUrl: string): Blob {
  const match = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(dataUrl);
  if (!match) throw new Error("invalid PDF data URL");
  const mime = match[1] ?? "application/octet-stream";
  const isBase64 = Boolean(match[2]);
  const body = match[3] ?? "";
  const binary = isBase64 ? atob(body) : decodeURIComponent(body);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: mime });
}
