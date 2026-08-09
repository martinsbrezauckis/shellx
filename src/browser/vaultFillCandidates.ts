import type { BrowserVaultKeyMeta } from "./api";

export interface BrowserObservationRefLike {
  refId?: string;
  role?: string;
  label?: string;
  name?: string | null;
  value?: string | null;
  selector?: string | null;
  action?: string | null;
  visible?: boolean | null;
  editable?: boolean | null;
}

export interface BrowserObservationLike {
  url?: string | null;
  title?: string | null;
  text?: string | null;
  markdown?: string | null;
  refs?: BrowserObservationRefLike[];
  domSummary?: Record<string, unknown> | null;
}

function optionalObservationString(value: unknown): string | null | undefined {
  return typeof value === "string" || value === null ? value : undefined;
}

function optionalObservationBoolean(value: unknown): boolean | null | undefined {
  return typeof value === "boolean" || value === null ? value : undefined;
}

function normalizeBrowserObservationRef(value: unknown): BrowserObservationRefLike | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return {
    refId: optionalObservationString(Reflect.get(value, "refId")) ?? undefined,
    role: optionalObservationString(Reflect.get(value, "role")) ?? undefined,
    label: optionalObservationString(Reflect.get(value, "label")) ?? undefined,
    name: optionalObservationString(Reflect.get(value, "name")),
    value: optionalObservationString(Reflect.get(value, "value")),
    selector: optionalObservationString(Reflect.get(value, "selector")),
    action: optionalObservationString(Reflect.get(value, "action")),
    visible: optionalObservationBoolean(Reflect.get(value, "visible")),
    editable: optionalObservationBoolean(Reflect.get(value, "editable")),
  };
}

export function normalizeBrowserObservation(value: unknown): BrowserObservationLike | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const refsValue = Reflect.get(value, "refs");
  const domSummaryValue = Reflect.get(value, "domSummary");
  return {
    url: optionalObservationString(Reflect.get(value, "url")),
    title: optionalObservationString(Reflect.get(value, "title")),
    text: optionalObservationString(Reflect.get(value, "text")),
    markdown: optionalObservationString(Reflect.get(value, "markdown")),
    refs: Array.isArray(refsValue)
      ? refsValue.map(normalizeBrowserObservationRef).filter((ref) => ref !== null)
      : [],
    domSummary: domSummaryValue !== null && typeof domSummaryValue === "object" && !Array.isArray(domSummaryValue)
      ? Object.fromEntries(Object.entries(domSummaryValue))
      : null,
  };
}

export type BrowserVaultFillFieldKind = "password" | "apiKey" | "token" | "secret";

export interface BrowserVaultFillCandidate {
  id: string;
  key: string;
  label: string;
  description: string;
  userOnly: boolean;
  fieldKind: BrowserVaultFillFieldKind;
  fieldLabel: string;
  refId?: string;
  selector?: string;
  origin: string;
  score: number;
}

function cleanVaultFillText(value?: string | null, fallback = ""): string {
  const cleaned = String(value ?? "").replace(/\s+/g, " ").trim();
  return cleaned || fallback;
}

const VAULT_FILL_EMAIL_PATTERN = /[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+/gi;

function emailAddressesForVaultFill(value?: string | null): string[] {
  const matches = String(value ?? "").toLowerCase().match(VAULT_FILL_EMAIL_PATTERN) ?? [];
  return Array.from(new Set(matches.map((email) => email.trim()).filter(Boolean)));
}

interface BrowserVaultOriginContext {
  origin: string;
  host: string;
  domainMarkers: string[];
  providerMarkers: string[];
}

const VAULT_FILL_PROVIDER_HOSTS: Array<{ host: RegExp; markers: string[] }> = [
  { host: /(^|\.)google\.[a-z.]+$/, markers: ["google", "gmail", "accounts", "gemini"] },
  { host: /(^|\.)(microsoft|office|outlook|live)\.[a-z.]+$/, markers: ["microsoft", "office", "outlook", "live", "azure"] },
  ...[
    "github", "gitlab", "notion", "slack", "stripe", "firecrawl", "openai", "anthropic",
    "cloudflare", "linear", "figma", "airtable", "todoist", "dropbox", "trello", "atlassian",
  ].map((provider) => ({
    host: new RegExp(`(^|\\.)${provider}\\.[a-z.]+$`),
    markers: [provider],
  })),
];

const VAULT_FILL_COMMON_SECOND_LEVEL_SUFFIXES = new Set([
  "ac", "co", "com", "edu", "gov", "mil", "net", "org", "sch",
]);

function browserVaultSiteDomain(labels: string[]): string | null {
  if (labels.length < 3) return null;
  const topLevel = labels.at(-1) ?? "";
  const secondLevel = labels.at(-2) ?? "";
  const suffixDepth = topLevel.length === 2 && VAULT_FILL_COMMON_SECOND_LEVEL_SUFFIXES.has(secondLevel)
    ? 2
    : 1;
  return labels.length > suffixDepth
    ? labels.slice(-(suffixDepth + 1)).join(".")
    : null;
}

function browserVaultOriginContext(rawUrl?: string | null): BrowserVaultOriginContext | null {
  const raw = rawUrl?.trim();
  if (!raw) return null;
  try {
    const parsed = new URL(raw.includes("://") ? raw : `https://${raw}`);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
    const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
    if (!host) return null;
    const labels = host.split(".").filter(Boolean);
    const domainMarkers = new Set([host]);
    const siteDomain = !/^\d+$/.test(labels.at(-1) ?? "")
      ? browserVaultSiteDomain(labels)
      : null;
    if (siteDomain) domainMarkers.add(siteDomain);
    const providerMarkers = new Set<string>();
    for (const provider of VAULT_FILL_PROVIDER_HOSTS) {
      if (provider.host.test(host)) provider.markers.forEach((marker) => providerMarkers.add(marker));
    }
    return {
      origin: parsed.origin.toLowerCase(),
      host,
      domainMarkers: [...domainMarkers],
      providerMarkers: [...providerMarkers],
    };
  } catch {
    return null;
  }
}

function vaultFillMetadataContainsMarker(haystack: string, marker: string): boolean {
  const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:$|[^a-z0-9])`, "i").test(haystack);
}

function vaultFillOriginScore(context: BrowserVaultOriginContext, haystack: string): number {
  for (const [index, marker] of context.domainMarkers.entries()) {
    if (vaultFillMetadataContainsMarker(haystack, marker)) return index === 0 ? 30 : 24;
  }
  return context.providerMarkers.some((marker) => vaultFillMetadataContainsMarker(haystack, marker)) ? 18 : 0;
}

function pageEmailsForVaultFill(observation: BrowserObservationLike | null): string[] {
  const emails = new Set<string>();
  for (const email of emailAddressesForVaultFill(`${observation?.title ?? ""} ${observation?.text ?? ""}`)) {
    emails.add(email);
  }
  for (const ref of observation?.refs ?? []) {
    if (ref.visible === false) continue;
    for (const value of [ref.value, ref.label, ref.name]) {
      for (const email of emailAddressesForVaultFill(value)) emails.add(email);
    }
  }
  return [...emails];
}

export function browserVaultFillFieldKind(ref: BrowserObservationRefLike): BrowserVaultFillFieldKind | null {
  const metadata = [
    ref.role,
    ref.label,
    ref.name,
    ref.selector,
    ref.refId,
  ].map((value) => String(value ?? "").toLowerCase()).join(" ");
  if (ref.visible === false) return null;
  if (ref.action && ref.action !== "fillRef") return null;
  if (ref.editable === false && ref.role !== "password") return null;
  if (/\b(pass(word)?|passwd)\b/.test(metadata) || ref.role === "password") return "password";
  if (/\b(api[-_ ]?key|apikey|access[-_ ]?key)\b/.test(metadata)) return "apiKey";
  if (/\b(token|bearer|oauth)\b/.test(metadata)) return "token";
  if (/\b(secret|credential)\b/.test(metadata)) return "secret";
  return null;
}

function vaultFillKindScore(kind: BrowserVaultFillFieldKind, haystack: string): number {
  if (kind === "password") {
    return /\b(pass(word)?|passwd|login|credential|account|gmail|google|mail)\b/.test(haystack) ? 8 : 0;
  }
  if (kind === "apiKey") {
    return /\b(api[-_ ]?key|apikey|access[-_ ]?key|developer[-_ ]?key)\b/.test(haystack) ? 8 : 0;
  }
  if (kind === "token") {
    return /\b(token|bearer|oauth|access[-_ ]?token|refresh[-_ ]?token)\b/.test(haystack) ? 8 : 0;
  }
  return /\b(secret|credential)\b/.test(haystack) ? 6 : 0;
}

function vaultFillAccountScore(kind: BrowserVaultFillFieldKind, haystack: string, pageEmails: string[]): number {
  if (kind !== "password") return 0;
  return pageEmails.some((email) => haystack.includes(email)) ? 18 : 0;
}

function vaultFillFieldLabel(kind: BrowserVaultFillFieldKind, ref: BrowserObservationRefLike): string {
  return cleanVaultFillText(
    ref.label || ref.name || ref.selector || ref.refId,
    kind === "password" ? "Password field" : kind === "apiKey" ? "API key field" : kind === "token" ? "Token field" : "Secret field",
  );
}

export function buildBrowserVaultFillCandidates(input: {
  entries: BrowserVaultKeyMeta[];
  observation: BrowserObservationLike | null;
  url: string;
}): BrowserVaultFillCandidate[] {
  const pageContext = browserVaultOriginContext(input.url);
  const observedContext = browserVaultOriginContext(input.observation?.url);
  if (!pageContext || !observedContext || observedContext.origin !== pageContext.origin) return [];
  const pageEmails = pageEmailsForVaultFill(input.observation);
  const refs = (input.observation?.refs ?? [])
    .map((ref) => ({ ref, kind: browserVaultFillFieldKind(ref) }))
    .filter((entry): entry is { ref: BrowserObservationRefLike; kind: BrowserVaultFillFieldKind } => Boolean(entry.kind));
  if (refs.length === 0) return [];

  const candidates: BrowserVaultFillCandidate[] = [];
  for (const entry of input.entries) {
    if ((entry.resourceKind ?? "secret") !== "secret") continue;
    const haystack = [
      entry.key,
      entry.description,
      entry.resourceSummary,
      entry.resourceProvider,
      ...(entry.resourceFields ?? []),
    ].map((value) => String(value ?? "").toLowerCase()).join(" ");
    for (const { ref, kind } of refs) {
      const fieldScore = vaultFillKindScore(kind, haystack);
      const originScore = vaultFillOriginScore(pageContext, haystack);
      if (originScore <= 0) continue;
      const accountScore = vaultFillAccountScore(kind, haystack, pageEmails);
      const score = fieldScore + originScore + accountScore;
      const target = ref.refId || ref.selector;
      if (!target) continue;
      candidates.push({
        id: `${entry.key}:${ref.refId ?? ""}:${ref.selector ?? ""}`,
        key: entry.key,
        label: entry.key,
        description: cleanVaultFillText(entry.description ?? entry.resourceSummary, entry.userOnly ? "User-only Vault secret" : "Vault secret"),
        userOnly: Boolean(entry.userOnly),
        fieldKind: kind,
        fieldLabel: vaultFillFieldLabel(kind, ref),
        refId: ref.refId,
        selector: ref.selector ?? undefined,
        origin: pageContext.origin,
        score,
      });
    }
  }
  const bestByTarget = new Map<string, BrowserVaultFillCandidate>();
  for (const candidate of candidates) {
    const targetKey = `${candidate.key}:${candidate.refId ?? candidate.selector ?? candidate.fieldKind}`;
    const existing = bestByTarget.get(targetKey);
    if (!existing || candidate.score > existing.score) {
      bestByTarget.set(targetKey, candidate);
    }
  }
  return [...bestByTarget.values()]
    .sort((a, b) => b.score - a.score || a.label.localeCompare(b.label))
    .slice(0, 8);
}
