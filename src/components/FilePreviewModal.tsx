/**
 * src/components/FilePreviewModal.tsx — read-only file preview modal.
 *
 * Renders a file based on its extension:
 * - .md / .markdown → ReactMarkdown + remark-gfm
 * - source code → ShikiHighlight (same renderer as RightRail)
 * - .png/.jpg/.jpeg/.gif/.webp/.svg → <img> via Tauri assetProtocol
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

type Kind = "markdown" | "code" | "image" | "pdf" | "text" | "unknown";

/** Determine render branch from path extension. Defaults to text/code. */
function kindOf(path: string): Kind {
  const ext = path.toLowerCase().split(".").pop() ?? "";
  if (ext === "md" || ext === "markdown") return "markdown";
  if (
    ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico"].includes(ext)
  )
    return "image";
  if (ext === "pdf") return "pdf";
  if (
    [
      "ts", "tsx", "js", "jsx", "mjs", "cjs",
      "rs", "py", "go", "java", "kt", "swift",
      "json", "toml", "yaml", "yml", "xml",
      "css", "scss", "html", "vue", "svelte",
      "sh", "bash", "zsh", "fish", "ps1",
      "sql", "graphql", "proto", "lua", "rb",
      "c", "cc", "cpp", "h", "hpp", "cs", "php",
      "dockerfile", "makefile", "envfile",
    ].includes(ext)
  )
    return "code";
  if (["txt", "log", "csv", "tsv", "ini", "conf", "cfg"].includes(ext))
    return "text";
  return "unknown";
}

export function FilePreviewModal({
  open,
  path,
  onClose,
  onPreviewFile,
}: {
  open: boolean;
  path: string | null;
  onClose: () => void;
  onPreviewFile?: (path: string) => void;
}): JSX.Element | null {
  const [text, setText] = useState<string>("");
  const [loading, setLoading] = useState<boolean>(false);
  const [err, setErr] = useState<string | null>(null);

  const kind = useMemo<Kind>(() => (path ? kindOf(path) : "unknown"), [path]);

 // Esc closes. Click on backdrop closes. The modal body stops propagation.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); onClose(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

 // Fetch text content for text-like kinds. Images/PDFs skip this.
  useEffect(() => {
    if (!open || !path) { setText(""); setErr(null); return; }
    if (kind === "image" || kind === "pdf") return;
    let cancelled = false;
    setLoading(true);
    setErr(null);
    if (inTauri()) {
      void invoke<string>("read_text_file_for_path", { path })
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
  }, [open, path, kind]);

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

          {!loading && !err && (kind === "text" || kind === "unknown") && (
            <pre className="preview-text">{text}</pre>
          )}

          {!err && kind === "image" && (
            <div className="preview-image">
              {inTauri() ? (
                <img
                  src={convertFileSrc(path, "asset")}
                  alt={fname}
                  onError={() => setErr("Could not load image")}
                />
              ) : (
                <div className="preview-err">Image preview requires Tauri</div>
              )}
            </div>
          )}

          {!err && kind === "pdf" && (
            <div className="preview-pdf">
              {inTauri() ? (
                <iframe
                  src={convertFileSrc(path, "asset")}
                  title={fname}
                  className="preview-pdf-iframe"
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
