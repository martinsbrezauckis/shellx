export type GeneratedMediaKind = "image" | "video";

export function shouldScanGeneratedMediaOutput(title: string, kind: GeneratedMediaKind): boolean {
  const normalized = title.toLowerCase();
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
  const ext = kind === "image"
    ? "jpe?g|png|gif|webp|bmp|svg|ico"
    : "mp4|webm|mov|m4v|mkv";
  const patterns = [
    new RegExp(`(?:src|href)=["']([^"']+\\.(${ext})(?:\\?[^"']*)?)["']`, "i"),
    new RegExp(`\\]\\((.+\\.(${ext})(?:\\?[^)]*)?)\\)`, "i"),
    new RegExp(`(file://[^\\s"'<>]+\\.(${ext})(?:\\?[^\\s"'<>]*)?)`, "i"),
    new RegExp(`(\\\\\\\\[^\\n\\r"'<>]+\\\\[^\\n\\r"'<>]*\\.(${ext}))`, "i"),
    new RegExp(`([A-Za-z]:[\\\\/][^\\n\\r"'<>]*\\.(${ext}))`, "i"),
    new RegExp(`(/[^\\n\\r"'<>]*\\.(${ext}))`, "i"),
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    const raw = match?.[1];
    if (!raw) continue;
    return cleanMediaPath(raw);
  }
  return undefined;
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
