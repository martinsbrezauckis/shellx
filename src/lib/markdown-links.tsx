import { type JSX, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ShellIcon } from "../components/icons";

function isHttpUrl(href: unknown): href is string {
  return typeof href === "string" && /^https?:\/\//i.test(href);
}

function fileUrlToPath(href: string): string | null {
  if (!/^file:\/\//i.test(href)) return null;
  try {
    const url = new URL(href);
    const decoded = decodeURIComponent(url.pathname);
    if (url.hostname) return `\\\\${url.hostname}${decoded.replace(/\//g, "\\")}`;
    return decoded.replace(/^\/([A-Za-z]:[\\/])/, "$1");
  } catch {
    return null;
  }
}

function stripLineSuffix(path: string): string {
  return path.replace(/(?<!^)(?::\d+){1,2}$/, "");
}

function stripUrlSuffix(path: string): string {
  if (/^[A-Za-z]:[\\/]/.test(path)) return path.split(/[?#]/, 1)[0] ?? path;
  return path.split(/[?#]/, 1)[0] ?? path;
}

function decodeLocalPath(path: string): string {
  try {
    return decodeURI(path);
  } catch {
    return path;
  }
}

export function localHrefToPreviewPath(href: string): string {
  const raw = stripUrlSuffix(fileUrlToPath(href) ?? href);
  return decodeLocalPath(raw).replace(/^\/([A-Za-z]:[\\/])/, "$1");
}

export function isPreviewableFileHref(href: unknown): href is string {
  if (typeof href !== "string" || href.length === 0 || isHttpUrl(href)) return false;
  const candidate = stripLineSuffix(localHrefToPreviewPath(href));
  if (/^[a-z][a-z0-9+.-]*:/i.test(candidate) && !/^[A-Za-z]:[\\/]/.test(candidate)) return false;
  return /^(\.{0,2}\/|\/|[A-Za-z]:[\\/]|\\\\)/.test(candidate) ||
    /\.(md|markdown|txt|json|jsonl|toml|yaml|yml|ini|cfg|conf|env|log|csv|tsv|html|css|svg|png|jpg|jpeg|gif|webp|pdf|rs|ts|tsx|js|jsx|mjs|cjs|py|rb|go|java|kt|swift|c|h|hpp|cpp|sh|bash|zsh|fish|ps1|bat|cmd|nix|dockerfile|gitignore|gitattributes|lock)$/i.test(candidate);
}

export function fileDisplayName(path: string): string {
  const normalized = stripLineSuffix(localHrefToPreviewPath(path));
  return normalized.split(/[\\/]/).filter(Boolean).pop() ?? normalized;
}

export function resolveMarkdownPreviewHref(currentPath: string | undefined, href: string): string {
  const cleanHref = stripLineSuffix(localHrefToPreviewPath(href));
  if (!currentPath || /^([A-Za-z]:[\\/]|\/|\\\\)/.test(cleanHref)) return cleanHref;
  const sep = currentPath.includes("\\") ? "\\" : "/";
  const dir = currentPath.split(/[\\/]/).slice(0, -1).join(sep);
  const stripped = cleanHref.replace(/^\.\//, "");
  return normalizePreviewPath(dir ? `${dir}${sep}${stripped}` : stripped, sep);
}

function normalizePreviewPath(path: string, sep: "\\" | "/"): string {
  let prefix = "";
  let rest = path;

  const unc = /^([\\/]{2}[^\\/]+[\\/][^\\/]+)([\\/]|$)/.exec(rest);
  if (unc) {
    prefix = (unc[1] ?? "").replace(/[\\/]/g, sep) + sep;
    rest = rest.slice(unc[0].length);
  } else if (/^[A-Za-z]:[\\/]/.test(rest)) {
    prefix = rest.slice(0, 2) + sep;
    rest = rest.slice(3);
  } else if (/^[\\/]/.test(rest)) {
    prefix = sep;
    rest = rest.replace(/^[\\/]+/, "");
  }

  const parts: string[] = [];
  for (const part of rest.split(/[\\/]+/)) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (parts.length > 0 && parts[parts.length - 1] !== "..") {
        parts.pop();
      } else if (!prefix) {
        parts.push(part);
      }
      continue;
    }
    parts.push(part);
  }

  return prefix + parts.join(sep);
}

const PLAIN_FILE_EXT =
  "md|markdown|txt|json|jsonl|toml|yaml|yml|ini|cfg|conf|env|log|csv|tsv|html|htm|css|svg|png|jpg|jpeg|gif|webp|pdf|rs|ts|tsx|js|jsx|mjs|cjs|py|rb|go|java|kt|swift|c|h|hpp|cpp|sh|bash|zsh|fish|ps1|bat|cmd|nix|dockerfile|gitignore|gitattributes|lock";

const PLAIN_FILE_REF_RE = new RegExp(
  [
    String.raw`(?<![\]\(\w])`,
    String.raw`(`,
    String.raw`[A-Za-z]:[\\/][^\r\n\`"<>|]*?\.(${PLAIN_FILE_EXT})`,
    String.raw`|\\\\[^\r\n\`"<>|]*?\.(${PLAIN_FILE_EXT})`,
    String.raw`|/(?!/)[^\r\n\`"<>|]*?\.(${PLAIN_FILE_EXT})`,
    String.raw`|(?:\.{1,2}[\\/])?[A-Za-z0-9_.@()-][A-Za-z0-9_.@()\-\\/]*?\.(${PLAIN_FILE_EXT})`,
    String.raw`)`,
    String.raw`(?=$|[\s,.;:!?)}\]])`,
  ].join(""),
  "gi",
);

export function linkifyPreviewableFileRefs(markdown: string): string {
  const lines = markdown.split(/(\r?\n)/);
  let inFence = false;
  return lines
    .map((line) => {
      if (/^\s*```/.test(line)) {
        inFence = !inFence;
        return line;
      }
      if (inFence || !line.trim() || line.includes("](")) return line;
      return line.replace(PLAIN_FILE_REF_RE, (match) => {
        if (!isPreviewableFileHref(match)) return match;
        const escaped = match.replace(/\\/g, "\\\\").replace(/\]/g, "\\]");
        const href = encodeURI(match).replace(/\(/g, "%28").replace(/\)/g, "%29");
        return `[${escaped}](${href})`;
      });
    })
    .join("");
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
    const target = resolveMarkdownPreviewHref(currentPath, href);
    return (
      <button type="button" className="flink" onClick={() => onPreviewFile(target)}>
        <span className="ic">
          <ShellIcon name="chevron-right" size={12} />
        </span>
        <span className="name">{fileDisplayName(href)}</span>
        <span className="arr">
          <ShellIcon name="external-link" size={12} />
        </span>
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
