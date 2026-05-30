import {
  isStaticHtmlPreviewPath,
  workPreviewEntryForFilePath,
  workPreviewRootForFilePath,
} from "./work-preview";
import { stripWindowsExtendedPathPrefix } from "./media-paths";

export type PreviewCenterView = "file" | "work";

export interface PreviewRouteInput {
  path: string;
  cwd?: string | null;
  canRunWorkPreview: boolean;
}

export interface SessionMarkdownArtifactInput {
  path: string;
  cwd?: string | null;
  sessionId?: string | null;
}

export interface PreviewRouteBlocked {
  ok: false;
  reason: string;
  path: string;
}

export interface PreviewRouteResolved {
  ok: true;
  view: PreviewCenterView;
  path: string;
  workRoot: string | null;
  workEntry: string | null;
}

export type PreviewRoute = PreviewRouteBlocked | PreviewRouteResolved;

function isGrokSessionReference(path: string): boolean {
  return /(^|[\\/])\.grok[\\/]sessions[\\/]/i.test(path);
}

const SESSION_MARKDOWN_ARTIFACTS = new Set(["goal.md", "plan.md"]);

export function normalizePreviewReference(path: string): string {
  let clean = stripWindowsExtendedPathPrefix(path.trim());
  if (!isGrokSessionReference(clean)) {
    try {
      clean = decodeURI(clean);
    } catch {
      /* Keep the original text; malformed URI text can still be a real path. */
    }
  }
  if (/^\/[A-Za-z]:[\\/]/.test(clean)) {
    clean = clean.slice(1);
  }
  return clean;
}

export function previewPathHasParentTraversal(path: string): boolean {
  return path
    .replace(/\\/g, "/")
    .split("/")
    .some((part) => part === "..");
}

function sessionMarkdownArtifactName(path: string): string | null {
  const clean = normalizePreviewReference(path).trim().replace(/\\/g, "/").replace(/^\.\//, "");
  if (!clean || clean.includes("/") || previewPathHasParentTraversal(clean)) return null;
  const lower = clean.toLowerCase();
  return SESSION_MARKDOWN_ARTIFACTS.has(lower) ? lower : null;
}

function userHomeFromCwd(cwd: string): string | null {
  const clean = normalizePreviewReference(cwd).trim().replace(/[\\/]$/, "");
  if (!clean) return null;
  const winMatch = /^([A-Za-z]:)[\\/](Users)[\\/]([^\\/]+)/.exec(clean);
  if (winMatch) return `${winMatch[1]}\\${winMatch[2]}\\${winMatch[3]}`;
  const posixMatch = /^\/(home|Users)\/([^/]+)/.exec(clean);
  if (posixMatch) return `/${posixMatch[1]}/${posixMatch[2]}`;
  return null;
}

export function resolveSessionMarkdownArtifactPath(
  path: string,
  input: Omit<SessionMarkdownArtifactInput, "path">,
): string | null {
  const artifact = sessionMarkdownArtifactName(path);
  const sessionId = input.sessionId?.trim();
  const cwd = input.cwd?.trim().replace(/[\\/]$/, "");
  if (!artifact || !sessionId || !cwd) return null;

  const home = userHomeFromCwd(cwd);
  if (!home) return null;

  const winStyle = /^[A-Za-z]:[\\/]/.test(home) || home.includes("\\");
  const sep = winStyle ? "\\" : "/";
  return [
    home,
    ".grok",
    "sessions",
    encodeURIComponent(cwd),
    sessionId,
    artifact,
  ].join(sep);
}

export function resolvePreviewPath(path: string, cwd?: string | null): string {
  const clean = normalizePreviewReference(path);
  const isAbs = /^([A-Za-z]:[\\/]|\/|\\\\)/.test(clean);
  if (isAbs) return clean;
  const base = cwd?.trim();
  if (!base) return clean;

  const winStyle = /[A-Za-z]:[\\/]/.test(base) || base.includes("\\");
  const sep = winStyle ? "\\" : "/";
  const stripped = clean.replace(/^\.\//, "");
  return `${base.replace(/[\\/]$/, "")}${sep}${stripped}`;
}

export function resolvePreviewRoute(input: PreviewRouteInput): PreviewRoute {
  const abs = resolvePreviewPath(input.path, input.cwd);
  if (previewPathHasParentTraversal(abs)) {
    return {
      ok: false,
      reason: `preview blocked unsafe path reference: ${abs}`,
      path: abs,
    };
  }

  if (input.canRunWorkPreview && isStaticHtmlPreviewPath(abs)) {
    const workRoot = workPreviewRootForFilePath(abs);
    const workEntry = workPreviewEntryForFilePath(abs);
    if (workRoot && workEntry) {
      return {
        ok: true,
        view: "work",
        path: abs,
        workRoot,
        workEntry,
      };
    }
  }

  return {
    ok: true,
    view: "file",
    path: abs,
    workRoot: null,
    workEntry: null,
  };
}
