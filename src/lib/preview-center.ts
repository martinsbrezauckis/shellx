import {
  isStaticHtmlPreviewPath,
  workPreviewEntryForFilePath,
  workPreviewRootForFilePath,
} from "./work-preview";

export type PreviewCenterView = "file" | "work";

export interface PreviewRouteInput {
  path: string;
  cwd?: string | null;
  canRunWorkPreview: boolean;
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

export function normalizePreviewReference(path: string): string {
  let clean = path.trim();
  try {
    clean = decodeURI(clean);
  } catch {
    /* Keep the original text; malformed URI text can still be a real path. */
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
