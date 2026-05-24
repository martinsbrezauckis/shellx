/**
 * src/components/BuiltinDocModal.tsx — in-app documentation viewer.
 *
 * Renders curated markdown docs from `src/lib/builtin-docs.ts`
 * (Features overview, Quick start). Sister modal to FilePreviewModal
 * but with no filesystem dependency — the docs ship as TypeScript
 * string constants inside the installer.
 *
 * Added after the About tab buttons were incorrectly routing built-in
 * docs through the filesystem-backed FilePreviewModal. This
 * modal sidesteps that scope check entirely.
 *
 * Same UX as FilePreviewModal: Esc to close, click backdrop to close,
 * markdown rendered with code-block copy + http-link → OS browser +
 * auto-copy-on-selection.
 */

import { useCallback, useEffect, useRef, useState, type JSX } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { BUILTIN_DOCS } from "../lib/builtin-docs";
import { onMouseUpAutoCopy } from "../lib/auto-copy-selection";
import { SafeMarkdownLink } from "../lib/markdown-links";
import { ShellIcon } from "./icons";

interface BuiltinDocModalProps {
 /** Doc id from BUILTIN_DOCS ("features" / "readme"). Null = closed. */
  docId: string | null;
  onClose: () => void;
}

export function BuiltinDocModal({ docId, onClose }: BuiltinDocModalProps): JSX.Element | null {
 // Esc closes
  useEffect(() => {
    if (!docId) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [docId, onClose]);

  if (!docId) return null;
  const doc = BUILTIN_DOCS[docId];
  if (!doc) {
 // Defensive — if a caller passes an unknown id, render an error
 // card instead of crashing. Bug here should be caught in dev.
    return (
      <div className="preview-backdrop" onClick={onClose} role="dialog" aria-modal="true">
        <div className="preview-modal" onClick={(e) => e.stopPropagation()}>
          <div className="preview-head">
            <span className="preview-fname">Unknown doc</span>
            <button type="button" className="preview-close" onClick={onClose}>
              <ShellIcon name="close" size={14} />
            </button>
          </div>
          <div className="preview-body">
            <div className="preview-err">No doc registered for id "{docId}".</div>
          </div>
        </div>
      </div>
    );
  }

  const lineCount = doc.body.split("\n").length;

  return (
    <div className="preview-backdrop" onClick={onClose} role="dialog" aria-modal="true" aria-label={doc.title}>
      <div className="preview-modal" onClick={(e) => e.stopPropagation()}>
        <div className="preview-head">
          <span className="preview-fname" title={doc.id}>{doc.title}</span>
          <span className="preview-kind">in-app docs</span>
          <span className="preview-lines">{lineCount} lines</span>
          <button
            type="button"
            className="preview-close"
            onClick={onClose}
            aria-label="Close (Esc)"
            title="Close (Esc)"
          >
            <ShellIcon name="close" size={14} />
          </button>
        </div>
        <div className="preview-body preview-body-markdown" onMouseUp={onMouseUpAutoCopy}>
          <div className="preview-md">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                pre: (props) => <DocCodeBlock {...props} />,
                a: ({ href, children }) => <SafeMarkdownLink href={href}>{children}</SafeMarkdownLink>,
              }}
            >
              {doc.body}
            </ReactMarkdown>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Reuses the same wrapper pattern as ChatOutput's CopyableCodeBlock —
 * floating Copy button top-right + check flash on success. Lives here
 * instead of being imported to keep the doc-modal self-contained. */
function DocCodeBlock({ children }: { children?: React.ReactNode }): JSX.Element {
  const preRef = useRef<HTMLPreElement | null>(null);
  const [copied, setCopied] = useState(false);
  const handleCopy = useCallback(() => {
    const txt = preRef.current?.innerText ?? "";
    if (!txt) return;
    try {
      void navigator.clipboard.writeText(txt);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch { /* clipboard unavailable */ }
  }, []);
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
        <ShellIcon name={copied ? "check" : "copy"} size={13} />
      </button>
    </div>
  );
}
