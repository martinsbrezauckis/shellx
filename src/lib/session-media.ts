import type { MessageGroup, ToolGroup, UiGroup } from "./grouping";
import {
  extractGeneratedMediaPath,
  looksLikeStandaloneGeneratedMediaPathText,
} from "./media-paths";

export type SessionMediaKind = "image" | "video";
export type SessionAttachmentKind = "image" | "text" | "file";

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

export interface SessionAttachmentItem {
  id: string;
  path: string;
  title: string;
  kind: SessionAttachmentKind;
  t: number;
}

function basename(path: string): string {
  const clean = path.split(/[?#]/, 1)[0] || path;
  const parts = clean.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts[parts.length - 1] || clean || "media";
}

function addMedia(
  target: SessionMediaItem[],
  seen: Set<string>,
  group: ToolGroup | MessageGroup,
  kind: SessionMediaKind,
  path: string | undefined,
  toolTitle?: string,
  status?: string,
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
    toolTitle: toolTitle || (kind === "image" ? "image_gen" : "video_gen"),
    status: status || "completed",
    t: group.t,
  });
}

function shouldScanMessageForGeneratedMedia(text: string, kind: SessionMediaKind): boolean {
  if (looksLikeStandaloneGeneratedMediaPathText(text, kind)) return true;
  if (/(^|[\\/])\.grok[\\/]sessions[\\/]/i.test(text)) return true;
  if (/(^|[\\/])\.codex[\\/]generated_images[\\/]/i.test(text)) return true;
  const lower = text.toLowerCase();
  if (kind === "image") {
    return /\b(image|screenshot|picture|generated|created|saved|output|artifact|preview)\b/.test(lower);
  }
  return /\b(video|clip|movie|generated|created|saved|output|artifact|preview)\b/.test(lower);
}

export function extractSessionMedia(groups: UiGroup[]): SessionMedia {
  const images: SessionMediaItem[] = [];
  const videos: SessionMediaItem[] = [];
  const seen = new Set<string>();

  for (const group of groups) {
    if (group.kind === "tool") {
      const tool = group as ToolGroup;
      addMedia(images, seen, tool, "image", tool.imagePath, tool.title, tool.status);
      addMedia(videos, seen, tool, "video", tool.videoPath, tool.title, tool.status);
      continue;
    }
    if (group.kind === "message" && group.text) {
      const message = group as MessageGroup;
      if (shouldScanMessageForGeneratedMedia(message.text, "image")) {
        addMedia(
          images,
          seen,
          message,
          "image",
          extractGeneratedMediaPath(message.text, "image"),
          "provider output",
        );
      }
      if (shouldScanMessageForGeneratedMedia(message.text, "video")) {
        addMedia(
          videos,
          seen,
          message,
          "video",
          extractGeneratedMediaPath(message.text, "video"),
          "provider output",
        );
      }
    }
  }

  return { images, videos };
}

export function extractSessionAttachments(groups: UiGroup[]): SessionAttachmentItem[] {
  const attachments: SessionAttachmentItem[] = [];
  const seen = new Set<string>();

  for (const group of groups) {
    if (group.kind !== "ui" || !Array.isArray(group.attachments)) continue;
    for (const attachment of group.attachments) {
      const path = attachment.path?.trim();
      if (!path) continue;
      const key = path.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const kind: SessionAttachmentKind =
        attachment.kind === "image" || attachment.kind === "text" || attachment.kind === "file"
          ? attachment.kind
          : "file";
      attachments.push({
        id: `${group.id}:attachment:${attachments.length}`,
        path,
        title: attachment.label?.trim() || basename(path),
        kind,
        t: group.t,
      });
    }
  }

  return attachments;
}
