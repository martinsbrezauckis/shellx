export type GeneratedMediaKind = "image" | "video";

export function shouldScanGeneratedMediaOutput(title: string, kind: GeneratedMediaKind): boolean {
  const normalized = title.toLowerCase();
  if (/^\s*(search tools?|search_tool|tool_search|grep|read_file|list_dir|web_search|web_fetch)\b/.test(normalized)) {
    return false;
  }
  if (kind === "image") {
    return /\b(image|image_gen|image_edit|screenshot)\b/.test(normalized);
  }
  return /\b(video|video_gen|movie|clip)\b/.test(normalized);
}

export function stripWindowsExtendedPathPrefix(path: string): string {
  let out = path.trim();
  out = out.replace(/^\\\\\?\\UNC\\/i, "\\\\");
  out = out.replace(/^\\\\\?\\/i, "");
  out = out.replace(/^\/\/\?\/UNC\//i, "//");
  out = out.replace(/^\/\/\?\//i, "");
  return out;
}

export function normalizeRendererFilePath(path: string): string {
  let out = path.trim();
  out = out.replace(/^file:\/\/\/([A-Za-z]:[\\/])/, "$1");
  out = stripWindowsExtendedPathPrefix(out);
  return out;
}

export function extractGeneratedMediaPath(text: string, kind: GeneratedMediaKind): string | undefined {
  const patterns = kind === "image" ? IMAGE_PATH_PATTERNS : VIDEO_PATH_PATTERNS;
  for (const pattern of patterns) {
    const matches = pattern.global ? text.matchAll(pattern) : text.matchAll(new RegExp(pattern.source, `${pattern.flags}g`));
    for (const match of matches) {
      const raw = match?.[1];
      if (!raw) continue;
      const clean = cleanMediaPath(raw);
      if (looksLikeGeneratedMediaPath(clean, kind)) return clean;
    }
  }
  return undefined;
}

export function looksLikeStandaloneGeneratedMediaPathText(
  text: string,
  kind: GeneratedMediaKind,
): boolean {
  let trimmed = text.trim();
  while (
    trimmed.length >= 2 &&
    ((trimmed.startsWith("`") && trimmed.endsWith("`")) ||
      (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    trimmed = trimmed.slice(1, -1).trim();
  }
  const extracted = extractGeneratedMediaPath(trimmed, kind);
  if (!extracted) return false;
  return trimmed === extracted || normalizeRendererFilePath(trimmed) === extracted;
}

const IMAGE_PATH_PATTERNS = [
  /(?:src|href)=["']([^"'|`]+\.(jpe?g|png|gif|webp|bmp|svg|ico)(?:\?[^"'|`]*)?)["']/i,
  /\]\(([^)\n\r|`]+?\.(jpe?g|png|gif|webp|bmp|svg|ico)(?:\?[^)\n\r|`]*)?)\)/i,
  /(file:\/\/[^\s"'<>|`]+\.(jpe?g|png|gif|webp|bmp|svg|ico)(?:\?[^\s"'<>|`]*)?)/i,
  /(\\\\[^\n\r"'<>|`]+?\\[^\n\r"'<>|`]*?\.(jpe?g|png|gif|webp|bmp|svg|ico))/i,
  /([A-Za-z]:[\\/][^\n\r"'<>|`]*?\.(jpe?g|png|gif|webp|bmp|svg|ico))/i,
  /(?:^|[\s"'`(<\[{:=])(\/[^\n\r"'<>|`]*?\.(jpe?g|png|gif|webp|bmp|svg|ico))/i,
];

const VIDEO_PATH_PATTERNS = [
  /(?:src|href)=["']([^"'|`]+\.(mp4|webm|mov|m4v|mkv)(?:\?[^"'|`]*)?)["']/i,
  /\]\(([^)\n\r|`]+?\.(mp4|webm|mov|m4v|mkv)(?:\?[^)\n\r|`]*)?)\)/i,
  /(file:\/\/[^\s"'<>|`]+\.(mp4|webm|mov|m4v|mkv)(?:\?[^\s"'<>|`]*)?)/i,
  /(\\\\[^\n\r"'<>|`]+?\\[^\n\r"'<>|`]*?\.(mp4|webm|mov|m4v|mkv))/i,
  /([A-Za-z]:[\\/][^\n\r"'<>|`]*?\.(mp4|webm|mov|m4v|mkv))/i,
  /(?:^|[\s"'`(<\[{:=])(\/[^\n\r"'<>|`]*?\.(mp4|webm|mov|m4v|mkv))/i,
];

function looksLikeGeneratedMediaPath(path: string, kind: GeneratedMediaKind): boolean {
  const normalized = path.replace(/\\/g, "/").trim();
  if (!normalized) return false;
  if (/[|`]/.test(normalized) || normalized.includes("…") || hasShellCommandSeparator(normalized)) {
    return false;
  }
  if (/^~[\\/]/.test(normalized)) {
    return false;
  }
  if (/^\/\.(?:grok|codex|shellx)\//i.test(normalized)) {
    return false;
  }
  if (kind === "image" && /^\/images\//i.test(normalized)) {
    return false;
  }
  if (kind === "video" && /^\/videos\//i.test(normalized)) {
    return false;
  }
  const repeatedExtensionPath = kind === "image"
    ? /\.(?:jpe?g|png|gif|webp|bmp|svg|ico)(?:[\\/]\.(?:jpe?g|png|gif|webp|bmp|svg|ico))+/i
    : /\.(?:mp4|webm|mov|m4v|mkv)(?:[\\/]\.(?:mp4|webm|mov|m4v|mkv))+/i;
  if (repeatedExtensionPath.test(normalized)) {
    return false;
  }
  if (/\bpath must end in\b/i.test(normalized)) {
    return false;
  }
  return true;
}

function hasShellCommandSeparator(path: string): boolean {
  return /(?:^|\s)(?:&&|\|\||;)(?=\s|$)/.test(path);
}

function cleanMediaPath(path: string): string {
  let out = normalizeRendererFilePath(path).replace(/&amp;/g, "&");
  if (!isGrokSessionPath(out)) {
    try {
      out = decodeURIComponent(out);
    } catch {
      // Leave malformed percent escapes as-is.
    }
  }
  while (out.endsWith(")") && countChar(out, ")") > countChar(out, "(")) {
    out = out.slice(0, -1);
  }
  return out;
}

function isGrokSessionPath(path: string): boolean {
  return /(^|[\\/])\.grok[\\/]sessions[\\/]/i.test(path);
}

function countChar(value: string, needle: string): number {
  let count = 0;
  for (const ch of value) {
    if (ch === needle) count += 1;
  }
  return count;
}
