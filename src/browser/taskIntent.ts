const DOMAIN_PATTERN = /(?:open|go to|navigate to|load)\s+(?:https?:\/\/)?([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+)(?:[/?#][^\s]*)?/i;
const SEARCH_PATTERN = /\bsearch(?:\s+(?:google|web))?\s+(?:for|about)?\s+(.+)$/i;

function normalizeStartUrl(value: string | null | undefined): string | null {
  const trimmed = (value ?? "").trim();
  if (!trimmed || trimmed === "about:blank") return null;
  try {
    const url = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
    if (!["http:", "https:"].includes(url.protocol)) return null;
    return url.href;
  } catch {
    return null;
  }
}

function inferRequestedDomain(goal: string): string | null {
  const match = goal.match(DOMAIN_PATTERN);
  return match?.[1]?.toLowerCase() ?? null;
}

function inferSearchQuery(goal: string): string | null {
  const match = goal.match(SEARCH_PATTERN);
  if (!match?.[1]) return null;
  const query = match[1]
    .replace(/\s+(?:please|thanks)\.?$/i, "")
    .trim()
    .replace(/[.?!]+$/, "")
    .trim();
  return query || null;
}

function isGoogleDomain(domain: string | null): boolean {
  return Boolean(domain && /(^|\.)google\.[a-z.]+$/i.test(domain));
}

export function inferBrowserTaskStartUrl(goal: string, currentUrl: string | null | undefined): string | null {
  const requestedDomain = inferRequestedDomain(goal);
  const searchQuery = inferSearchQuery(goal);

  if (searchQuery && (!requestedDomain || isGoogleDomain(requestedDomain))) {
    const params = new URLSearchParams({ q: searchQuery });
    return `https://www.google.com/search?${params.toString()}`;
  }

  if (requestedDomain) {
    return normalizeStartUrl(requestedDomain);
  }

  return normalizeStartUrl(currentUrl);
}
