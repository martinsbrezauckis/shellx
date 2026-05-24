import type { ToolGroup, UiGroup } from "./grouping";

export type SessionMediaKind = "image" | "video";

export interface SessionMediaItem {
  id: string;
  kind: SessionMediaKind;
  path: string;
  title: string;
  toolTitle: string;
  status: string;
  t: number;
}

export interface SessionMedia {
  images: SessionMediaItem[];
  videos: SessionMediaItem[];
}

function basename(path: string): string {
  const clean = path.split(/[?#]/, 1)[0] || path;
  const parts = clean.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts[parts.length - 1] || clean || "media";
}

function addMedia(
  target: SessionMediaItem[],
  seen: Set<string>,
  group: ToolGroup,
  kind: SessionMediaKind,
  path: string | undefined,
): void {
  const trimmed = path?.trim();
  if (!trimmed) return;
  const key = `${kind}:${trimmed}`;
  if (seen.has(key)) return;
  seen.add(key);
  target.push({
    id: `${group.id}:${kind}`,
    kind,
    path: trimmed,
    title: basename(trimmed),
    toolTitle: group.title || (kind === "image" ? "image_gen" : "video_gen"),
    status: group.status,
    t: group.t,
  });
}

export function extractSessionMedia(groups: UiGroup[]): SessionMedia {
  const images: SessionMediaItem[] = [];
  const videos: SessionMediaItem[] = [];
  const seen = new Set<string>();

  for (const group of groups) {
    if (group.kind !== "tool") continue;
    const tool = group as ToolGroup;
    addMedia(images, seen, tool, "image", tool.imagePath);
    addMedia(videos, seen, tool, "video", tool.videoPath);
  }

  return { images, videos };
}
