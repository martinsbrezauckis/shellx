const DRAFT_VISIBILITY_NOTE =
  "This draft is not visible to auto-update clients until the release is published.";

export function cleanUpdateNotes(body: string | null | undefined): string {
  if (!body) return "";
  return body
    .replaceAll(DRAFT_VISIBILITY_NOTE, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

export function firstUpdateNotesUrl(body: string | null | undefined): string | null {
  const notes = cleanUpdateNotes(body);
  const markdownLink = /\[[^\]]+\]\((https?:\/\/[^)\s]+)\)/i.exec(notes);
  if (markdownLink?.[1] && trustedUpdateNotesUrl(markdownLink[1])) return markdownLink[1];
  const bareUrl = /(https?:\/\/\S+)/i.exec(notes);
  const candidate = bareUrl?.[1]?.replace(/[),.;]+$/, "") ?? null;
  return candidate && trustedUpdateNotesUrl(candidate) ? candidate : null;
}

function trustedUpdateNotesUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      && url.hostname === "github.com"
      && url.pathname.startsWith("/martinsbrezauckis/shellx/");
  } catch {
    return false;
  }
}
