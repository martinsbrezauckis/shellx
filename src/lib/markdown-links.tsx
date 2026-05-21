import { type JSX, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";

function isHttpUrl(href: unknown): href is string {
  return typeof href === "string" && /^https?:\/\//i.test(href);
}

export function isPreviewableFileHref(href: unknown): href is string {
  if (typeof href !== "string" || href.length === 0 || isHttpUrl(href)) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) && !/^[A-Za-z]:[\\/]/.test(href)) return false;
  return /^(\.{0,2}\/|\/|[A-Za-z]:[\\/]|\\\\)/.test(href) ||
    /\.(md|markdown|txt|json|jsonl|toml|yaml|yml|ini|cfg|conf|env|log|csv|tsv|html|css|svg|png|jpg|jpeg|gif|webp|pdf|rs|ts|tsx|js|jsx|mjs|cjs|py|rb|go|java|kt|swift|c|h|hpp|cpp|sh|bash|zsh|fish|ps1|bat|cmd|nix|dockerfile|gitignore|gitattributes|lock)$/i.test(href);
}

export function fileDisplayName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

function resolveMarkdownFileHref(currentPath: string | undefined, href: string): string {
  if (!currentPath || /^([A-Za-z]:[\\/]|\/|\\\\)/.test(href)) return href;
  const sep = currentPath.includes("\\") ? "\\" : "/";
  const dir = currentPath.split(/[\\/]/).slice(0, -1).join(sep);
  const stripped = href.replace(/^\.\//, "");
  return dir ? `${dir}${sep}${stripped}` : stripped;
}

export function SafeMarkdownLink({
  href,
  children,
  currentPath,
  onPreviewFile,
}: {
  href?: string;
  children?: ReactNode;
  currentPath?: string;
  onPreviewFile?: (path: string) => void;
}): JSX.Element {
  if (onPreviewFile && isPreviewableFileHref(href)) {
    const target = resolveMarkdownFileHref(currentPath, href);
    return (
      <button type="button" className="flink" onClick={() => onPreviewFile(target)}>
        <span className="ic">▸</span>
        <span className="name">{fileDisplayName(href)}</span>
        <span className="arr">↗</span>
      </button>
    );
  }
  if (!isHttpUrl(href)) return <span>{children}</span>;
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      onClick={(e) => {
        e.preventDefault();
        try { void invoke("open_url_in_browser", { url: href }); } catch { /* browser-mode */ }
      }}
    >
      {children}
    </a>
  );
}
