type JsonObject = Record<string, unknown>;

const MAX_ISSUES = 50;
const MAX_CONSOLE_LINES = 20;
const MAX_NETWORK_ROWS = 30;
const MAX_RESOURCE_AGGREGATES = 50;
const MAX_HEADINGS = 48;
const MAX_PAINT_ENTRIES = 8;
const MAX_COUNT_KEYS = 20;
const MAX_TEXT_LENGTH = 480;

export type BrowserDeveloperInspectionUiState =
  | "ready"
  | "no-task"
  | "loading"
  | "native-engine-unavailable"
  | "developer-mode-required"
  | "empty-clean"
  | "partial"
  | "failed"
  | "success";

export interface BrowserDeveloperInspectionIdentity {
  taskId: string | null;
  browserTabId: string | null;
  origin: string | null;
  path: string | null;
}

export interface BrowserDeveloperInspectionIssue {
  issueId: string;
  severity: "error" | "warning" | "info";
  category: string;
  evidence: string;
  remediation: string;
}

export interface BrowserDeveloperInspectionSnapshot {
  schemaVersion: "sx.browserDeveloperInspection.v1";
  status: "inspected";
  inspected: BrowserDeveloperInspectionIdentity;
  document: {
    title: string;
    language: string;
    viewport: { width: number; height: number; devicePixelRatio: number };
    readyState: string;
    headings: Array<{ level: number; text: string }>;
    headingCount: number;
    headingsOmitted: number;
    checks: Record<string, number>;
  };
  console: {
    severityCounts: Record<string, number>;
    recent: Array<{ level: string; source: string; message: string; origin: string | null; path: string | null; line: number | null }>;
    omitted: number;
  };
  network: {
    outcomeCounts: Record<string, number>;
    resourceTypeCounts: Record<string, number>;
    recent: Array<{ method: string; status: number | null; resourceType: string; durationMs: number; origin: string; path: string }>;
    omitted: number;
  };
  performance: {
    navigation: { type: string; durationMs: number; domContentLoadedMs: number; loadMs: number; transferSize: number } | null;
    paint: Array<{ name: string; startTimeMs: number; durationMs: number }>;
    resourceAggregates: Array<{ resourceType: string; count: number; durationMs: number; transferSize: number }>;
    resourceAggregatesOmitted: number;
    resourceEntriesOmitted: number;
  };
  issues: BrowserDeveloperInspectionIssue[];
  issueCounts: Record<string, number>;
  truncation: {
    sanitizationLosses: number;
    headingsOmitted: number;
    consoleOmitted: number;
    networkOmitted: number;
    resourceAggregatesOmitted: number;
    resourceEntriesOmitted: number;
    issuesOmitted: number;
    responseBudgetOmitted: boolean;
    consoleRetentionDropped: number;
    networkRetentionDropped: number;
  };
  serializedBytes: number;
}

export interface BrowserDeveloperInspectionBlocked {
  schemaVersion: "sx.browserDeveloperInspection.v1";
  status: "blocked";
  requiredApproval: string | null;
  inspected: BrowserDeveloperInspectionIdentity;
  error: string | null;
  withheldSections: string[];
}

export interface BrowserDeveloperInspectionUnavailable {
  schemaVersion: "sx.browserDeveloperInspection.v1";
  status: "nativeEngineUnavailable" | "inspectionUnavailable" | "responseBudgetExceeded";
  inspected: BrowserDeveloperInspectionIdentity | null;
  error: string | null;
  withheldSections: string[];
}

export type BrowserDeveloperInspectionResult =
  | BrowserDeveloperInspectionSnapshot
  | BrowserDeveloperInspectionBlocked
  | BrowserDeveloperInspectionUnavailable;

export interface BrowserDeveloperArtifactReceipt {
  kind: "har" | "performance";
  artifactId: string;
  receiptId: string;
  bytes: number;
  sha256: string;
  createdAtMs: number;
  entries: number | null;
}

function objectValue(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value as JsonObject;
}

function stringValue(value: JsonObject, key: string, label: string): string {
  const result = value[key];
  if (typeof result !== "string" || !result.trim()) throw new Error(`${label}.${key} is invalid.`);
  return result.trim();
}

function nonNegativeNumber(value: JsonObject, key: string, label: string): number {
  const result = value[key];
  if (typeof result !== "number" || !Number.isFinite(result) || result < 0) throw new Error(`${label}.${key} is invalid.`);
  return result;
}

function nullableNumber(value: JsonObject, key: string, label: string): number | null {
  if (value[key] === null || value[key] === undefined) return null;
  return nonNegativeNumber(value, key, label);
}

function compactText(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} is invalid.`);
  const text = value.replace(/\s+/g, " ").trim();
  if (!text || text.length > MAX_TEXT_LENGTH) throw new Error(`${label} is out of bounds.`);
  if (
    /(?:file:\/\/|[a-z]:(?:\\|\/(?!\/))|\\\\|(?:^|[\s"'(])\/(?:home|users|private|var|tmp|mnt|opt|etc)(?:\/|$))/i.test(text)
    || /(?:https?|wss?):\/\/[^\s]*[?#]/i.test(text)
  ) {
    throw new Error(`${label} contains private or query-bearing data.`);
  }
  return text;
}

function compactTextAllowEmpty(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} is invalid.`);
  const text = value.replace(/\s+/g, " ").trim();
  if (text.length > MAX_TEXT_LENGTH) throw new Error(`${label} is out of bounds.`);
  if (!text) return "";
  return compactText(text, label);
}

function nullableCompactText(value: JsonObject, key: string, label: string): string | null {
  const result = value[key];
  if (result === undefined || result === null || result === "") return null;
  return compactText(result, `${label}.${key}`);
}

function safeOrigin(value: unknown, label: string): string {
  const origin = compactText(value, label);
  if (origin === "about:") return origin;
  let parsed: URL;
  try { parsed = new URL(origin); } catch { throw new Error(`${label} is not an origin.`); }
  if (!/^https?:$/.test(parsed.protocol) || parsed.origin !== origin || parsed.search || parsed.hash) {
    throw new Error(`${label} must be a sanitized origin.`);
  }
  return origin;
}

function nullableSafeOrigin(value: JsonObject, key: string, label: string): string | null {
  const result = value[key];
  if (result === undefined || result === null || result === "") return null;
  return safeOrigin(result, `${label}.${key}`);
}

function safePath(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} is invalid.`);
  const path = value.replace(/\s+/g, " ").trim();
  if (!path || path.length > 240 || (path !== "blank" && !path.startsWith("/")) || path.includes("?") || path.includes("#") || path.includes("\\")) {
    throw new Error(`${label} must be a sanitized browser path.`);
  }
  return path;
}

function nullableSafePath(value: JsonObject, key: string, label: string): string | null {
  const result = value[key];
  if (result === undefined || result === null || result === "") return null;
  return safePath(result, `${label}.${key}`);
}

function boundedCountMap(value: unknown, label: string): Record<string, number> {
  const map = objectValue(value, label);
  const entries = Object.entries(map);
  if (entries.length > MAX_COUNT_KEYS) throw new Error(`${label} is unbounded.`);
  return Object.fromEntries(entries.map(([key, count]) => {
    const normalizedKey = compactText(key, `${label} key`);
    if (normalizedKey.length > 64 || typeof count !== "number" || !Number.isFinite(count) || count < 0) {
      throw new Error(`${label}.${key} is invalid.`);
    }
    return [normalizedKey, count];
  }));
}

function normalizeIdentity(value: unknown, label: string): BrowserDeveloperInspectionIdentity {
  const identity = objectValue(value, label);
  return {
    taskId: nullableCompactText(identity, "taskId", label),
    browserTabId: nullableCompactText(identity, "browserTabId", label),
    origin: nullableSafeOrigin(identity, "origin", label),
    path: nullableSafePath(identity, "path", label),
  };
}

function normalizeIssues(value: unknown): BrowserDeveloperInspectionIssue[] {
  if (!Array.isArray(value) || value.length > MAX_ISSUES) throw new Error("Browser developer issues are invalid or unbounded.");
  return value.map((entry, index) => {
    const issue = objectValue(entry, `Browser developer issue ${index + 1}`);
    const severity = stringValue(issue, "severity", "Browser developer issue");
    if (severity !== "error" && severity !== "warning" && severity !== "info") throw new Error("Browser developer issue severity is invalid.");
    return {
      issueId: compactText(issue.issueId, "Browser developer issue.issueId"),
      severity,
      category: compactText(issue.category, "Browser developer issue.category"),
      evidence: compactText(issue.evidence, "Browser developer issue.evidence"),
      remediation: compactText(issue.remediation, "Browser developer issue.remediation"),
    };
  });
}

function normalizeWithheldSections(value: JsonObject): string[] {
  const sections = value.withheldSections;
  if (sections === undefined || sections === null) return [];
  if (!Array.isArray(sections) || sections.length > 5) throw new Error("Browser developer withheld sections are invalid.");
  return sections.map((section, index) => compactText(section, `Browser developer withheld section ${index + 1}`));
}

function normalizeSuccess(response: JsonObject): BrowserDeveloperInspectionSnapshot {
  const document = objectValue(response.document, "Browser developer document");
  const viewport = objectValue(document.viewport, "Browser developer viewport");
  const headings = document.headings;
  if (!Array.isArray(headings) || headings.length > MAX_HEADINGS) throw new Error("Browser developer headings are invalid or unbounded.");
  const consoleValue = objectValue(response.console, "Browser developer console");
  const consoleRecent = consoleValue.recent;
  if (!Array.isArray(consoleRecent) || consoleRecent.length > MAX_CONSOLE_LINES) throw new Error("Browser developer console lines are invalid or unbounded.");
  const network = objectValue(response.network, "Browser developer network");
  const networkRecent = network.recent;
  if (!Array.isArray(networkRecent) || networkRecent.length > MAX_NETWORK_ROWS) throw new Error("Browser developer network rows are invalid or unbounded.");
  const performance = objectValue(response.performance, "Browser developer performance");
  const resourceAggregates = performance.resourceAggregates;
  const paint = performance.paint;
  if (!Array.isArray(resourceAggregates) || resourceAggregates.length > MAX_RESOURCE_AGGREGATES || !Array.isArray(paint) || paint.length > MAX_PAINT_ENTRIES) {
    throw new Error("Browser developer performance rows are invalid or unbounded.");
  }
  const truncation = objectValue(response.truncation, "Browser developer truncation");
  const responseBudgetOmitted = truncation.responseBudgetOmitted;
  if (typeof responseBudgetOmitted !== "boolean" && (typeof responseBudgetOmitted !== "number" || !Number.isFinite(responseBudgetOmitted) || responseBudgetOmitted < 0)) {
    throw new Error("Browser developer response budget truncation is invalid.");
  }
  const navigation = performance.navigation;
  if (navigation !== null && navigation !== undefined && (typeof navigation !== "object" || Array.isArray(navigation))) {
    throw new Error("Browser developer navigation is invalid.");
  }
  const parsedNavigation = navigation ? objectValue(navigation, "Browser developer navigation") : null;
  return {
    schemaVersion: "sx.browserDeveloperInspection.v1",
    status: "inspected",
    inspected: normalizeIdentity(response.inspected, "Browser developer inspected identity"),
    document: {
      title: compactTextAllowEmpty(document.title, "Browser developer document title"),
      language: compactTextAllowEmpty(document.language, "Browser developer document language"),
      viewport: {
        width: nonNegativeNumber(viewport, "width", "Browser developer viewport"),
        height: nonNegativeNumber(viewport, "height", "Browser developer viewport"),
        devicePixelRatio: nonNegativeNumber(viewport, "devicePixelRatio", "Browser developer viewport"),
      },
      readyState: compactText(document.readyState, "Browser developer document ready state"),
      headings: headings.map((entry, index) => {
        const heading = objectValue(entry, `Browser developer heading ${index + 1}`);
        const level = nonNegativeNumber(heading, "level", "Browser developer heading");
        if (level < 1 || level > 6) throw new Error("Browser developer heading level is invalid.");
        return { level, text: compactTextAllowEmpty(heading.text, "Browser developer heading text") };
      }),
      headingCount: nonNegativeNumber(document, "headingCount", "Browser developer document"),
      headingsOmitted: nonNegativeNumber(document, "headingsOmitted", "Browser developer document"),
      checks: boundedCountMap(document.checks, "Browser developer checks"),
    },
    console: {
      severityCounts: boundedCountMap(consoleValue.severityCounts, "Browser developer console severity counts"),
      recent: consoleRecent.map((entry, index) => {
        const line = objectValue(entry, `Browser developer console line ${index + 1}`);
        return {
          level: compactText(line.level, "Browser developer console level"),
          source: compactTextAllowEmpty(line.source, "Browser developer console source"),
          message: compactTextAllowEmpty(line.message, "Browser developer console message"),
          origin: nullableSafeOrigin(line, "origin", "Browser developer console line"),
          path: nullableSafePath(line, "path", "Browser developer console line"),
          line: nullableNumber(line, "line", "Browser developer console line"),
        };
      }),
      omitted: nonNegativeNumber(consoleValue, "omitted", "Browser developer console"),
    },
    network: {
      outcomeCounts: boundedCountMap(network.outcomeCounts, "Browser developer network outcome counts"),
      resourceTypeCounts: boundedCountMap(network.resourceTypeCounts, "Browser developer network resource type counts"),
      recent: networkRecent.map((entry, index) => {
        const row = objectValue(entry, `Browser developer network row ${index + 1}`);
        return {
          method: compactText(row.method, "Browser developer network method"),
          status: nullableNumber(row, "status", "Browser developer network row"),
          resourceType: compactText(row.resourceType, "Browser developer network resource type"),
          durationMs: nonNegativeNumber(row, "durationMs", "Browser developer network row"),
          origin: safeOrigin(row.origin, "Browser developer network origin"),
          path: safePath(row.path, "Browser developer network path"),
        };
      }),
      omitted: nonNegativeNumber(network, "omitted", "Browser developer network"),
    },
    performance: {
      navigation: parsedNavigation ? {
        type: compactText(parsedNavigation.type, "Browser developer navigation type"),
        durationMs: nonNegativeNumber(parsedNavigation, "durationMs", "Browser developer navigation"),
        domContentLoadedMs: nonNegativeNumber(parsedNavigation, "domContentLoadedMs", "Browser developer navigation"),
        loadMs: nonNegativeNumber(parsedNavigation, "loadMs", "Browser developer navigation"),
        transferSize: nonNegativeNumber(parsedNavigation, "transferSize", "Browser developer navigation"),
      } : null,
      paint: paint.map((entry, index) => {
        const row = objectValue(entry, `Browser developer paint ${index + 1}`);
        return { name: compactText(row.name, "Browser developer paint name"), startTimeMs: nonNegativeNumber(row, "startTimeMs", "Browser developer paint"), durationMs: nonNegativeNumber(row, "durationMs", "Browser developer paint") };
      }),
      resourceAggregates: resourceAggregates.map((entry, index) => {
        const row = objectValue(entry, `Browser developer resource aggregate ${index + 1}`);
        return { resourceType: compactText(row.resourceType, "Browser developer resource type"), count: nonNegativeNumber(row, "count", "Browser developer resource aggregate"), durationMs: nonNegativeNumber(row, "durationMs", "Browser developer resource aggregate"), transferSize: nonNegativeNumber(row, "transferSize", "Browser developer resource aggregate") };
      }),
      resourceAggregatesOmitted: nonNegativeNumber(performance, "resourceAggregatesOmitted", "Browser developer performance"),
      resourceEntriesOmitted: nonNegativeNumber(performance, "resourceEntriesOmitted", "Browser developer performance"),
    },
    issues: normalizeIssues(response.issues),
    issueCounts: boundedCountMap(response.issueCounts, "Browser developer issue counts"),
    truncation: {
      sanitizationLosses: nonNegativeNumber(truncation, "sanitizationLosses", "Browser developer truncation"),
      headingsOmitted: nonNegativeNumber(truncation, "headingsOmitted", "Browser developer truncation"),
      consoleOmitted: nonNegativeNumber(truncation, "consoleOmitted", "Browser developer truncation"),
      networkOmitted: nonNegativeNumber(truncation, "networkOmitted", "Browser developer truncation"),
      resourceAggregatesOmitted: nonNegativeNumber(truncation, "resourceAggregatesOmitted", "Browser developer truncation"),
      resourceEntriesOmitted: nonNegativeNumber(truncation, "resourceEntriesOmitted", "Browser developer truncation"),
      issuesOmitted: nonNegativeNumber(truncation, "issuesOmitted", "Browser developer truncation"),
      responseBudgetOmitted: responseBudgetOmitted === true || (typeof responseBudgetOmitted === "number" && responseBudgetOmitted > 0),
      consoleRetentionDropped: nonNegativeNumber(truncation, "consoleRetentionDropped", "Browser developer truncation"),
      networkRetentionDropped: nonNegativeNumber(truncation, "networkRetentionDropped", "Browser developer truncation"),
    },
    serializedBytes: nonNegativeNumber(response, "serializedBytes", "Browser developer inspection response"),
  };
}

export function normalizeBrowserDeveloperInspection(value: unknown): BrowserDeveloperInspectionResult {
  const response = objectValue(value, "Browser developer inspection response");
  if (stringValue(response, "schemaVersion", "Browser developer inspection response") !== "sx.browserDeveloperInspection.v1") throw new Error("Browser developer inspection schema is unsupported.");
  if (response.ok === true && response.status === "inspected") return normalizeSuccess(response);
  if (response.ok !== false) throw new Error("Browser developer inspection response is invalid.");
  const status = stringValue(response, "status", "Browser developer inspection response");
  if (status === "blocked") {
    return {
      schemaVersion: "sx.browserDeveloperInspection.v1",
      status,
      requiredApproval: nullableCompactText(response, "requiredApproval", "Browser developer inspection response"),
      inspected: normalizeIdentity(response.inspected, "Browser developer inspected identity"),
      error: nullableCompactText(response, "error", "Browser developer inspection response"),
      withheldSections: normalizeWithheldSections(response),
    };
  }
  if (status !== "nativeEngineUnavailable" && status !== "inspectionUnavailable" && status !== "responseBudgetExceeded") {
    throw new Error("Browser developer inspection status is unsupported.");
  }
  return {
    schemaVersion: "sx.browserDeveloperInspection.v1",
    status,
    inspected: response.inspected ? normalizeIdentity(response.inspected, "Browser developer inspected identity") : null,
    error: nullableCompactText(response, "error", "Browser developer inspection response"),
    withheldSections: normalizeWithheldSections(response),
  };
}

export function normalizeBrowserDeveloperArtifactReceipt(value: unknown, kind: BrowserDeveloperArtifactReceipt["kind"]): BrowserDeveloperArtifactReceipt {
  const artifact = objectValue(value, `Browser ${kind} artifact response`);
  if (stringValue(artifact, "kind", `Browser ${kind} artifact response`) !== kind) throw new Error(`Browser ${kind} artifact kind is invalid.`);
  const sha256 = stringValue(artifact, "sha256", `Browser ${kind} artifact response`).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error(`Browser ${kind} artifact hash is invalid.`);
  return {
    kind,
    artifactId: compactText(artifact.artifactId, `Browser ${kind} artifact id`),
    receiptId: compactText(artifact.receiptId, `Browser ${kind} receipt id`),
    bytes: nonNegativeNumber(artifact, "bytes", `Browser ${kind} artifact response`),
    sha256,
    createdAtMs: nonNegativeNumber(artifact, "createdAtMs", `Browser ${kind} artifact response`),
    entries: nullableNumber(artifact, "entries", `Browser ${kind} artifact response`),
  };
}

export function browserDeveloperInspectionUiState(
  activeTaskId: string | null | undefined,
  result: BrowserDeveloperInspectionResult | null,
  loading: boolean,
  failed: boolean,
): BrowserDeveloperInspectionUiState {
  if (!activeTaskId?.trim()) return "no-task";
  if (loading) return "loading";
  if (failed) return "failed";
  if (!result) return "ready";
  if (result.status === "nativeEngineUnavailable") return "native-engine-unavailable";
  if (result.status === "blocked") return "developer-mode-required";
  if (result.status !== "inspected") return "failed";
  if (developerInspectionHasLoss(result)) return "partial";
  if (result.issues.length === 0) return "empty-clean";
  return "success";
}

export function developerInspectionHasLoss(snapshot: BrowserDeveloperInspectionSnapshot): boolean {
  return snapshot.truncation.sanitizationLosses > 0
    || snapshot.truncation.headingsOmitted > 0
    || snapshot.truncation.consoleOmitted > 0
    || snapshot.truncation.networkOmitted > 0
    || snapshot.truncation.resourceAggregatesOmitted > 0
    || snapshot.truncation.resourceEntriesOmitted > 0
    || snapshot.truncation.issuesOmitted > 0
    || snapshot.truncation.responseBudgetOmitted
    || snapshot.truncation.consoleRetentionDropped > 0
    || snapshot.truncation.networkRetentionDropped > 0;
}
