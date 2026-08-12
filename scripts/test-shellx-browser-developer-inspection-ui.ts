import { readFileSync } from "node:fs";

import {
  browserDeveloperInspectionUiState,
  normalizeBrowserDeveloperArtifactReceipt,
  normalizeBrowserDeveloperInspection,
} from "../src/browser/browserDeveloperInspection";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`FAIL: ${message}`);
  console.log(`  ✓ ${message}`);
}

const inspected = {
  schemaVersion: "sx.browserDeveloperInspection.v1",
  ok: true,
  status: "inspected",
  inspected: { taskId: "task-1", browserTabId: "tab-1", origin: "https://example.test", path: "/products" },
  document: {
    title: "Products", language: "en", viewport: { width: 1280, height: 720, devicePixelRatio: 1 }, readyState: "complete",
    headings: [{ level: 1, text: "Products" }], headingCount: 1, headingsOmitted: 0,
    checks: { titleCount: 1, languagePresent: 1, viewportPresent: 1, descriptionPresent: 1, headingOrderViolations: 0, imagesMissingAlt: 0, formFieldsMissingLabel: 0, interactiveMissingName: 0 },
  },
  console: { severityCounts: { error: 0, warning: 1 }, recent: [{ level: "warning", source: "console", message: "A bounded warning", origin: "https://example.test", path: "/products", line: 1 }], omitted: 0 },
  network: { outcomeCounts: { success: 4 }, resourceTypeCounts: { document: 1, script: 3 }, recent: [{ method: "GET", status: 200, resourceType: "document", durationMs: 12, origin: "https://example.test", path: "/products" }], omitted: 0 },
  performance: { navigation: { type: "navigate", durationMs: 210, domContentLoadedMs: 150, loadMs: 200, transferSize: 1200 }, paint: [{ name: "first-contentful-paint", startTimeMs: 80, durationMs: 0 }], resourceAggregates: [{ resourceType: "script", count: 3, durationMs: 40, transferSize: 1200 }], resourceAggregatesOmitted: 0, resourceEntriesOmitted: 0 },
  issues: [{ issueId: "document.title.duplicate", severity: "warning", category: "metadata", evidence: "More than one title element was found.", remediation: "Keep one concise title element." }],
  issueCounts: { warning: 1 },
  truncation: { sanitizationLosses: 0, headingsOmitted: 0, consoleOmitted: 0, networkOmitted: 0, resourceAggregatesOmitted: 0, resourceEntriesOmitted: 0, issuesOmitted: 0, responseBudgetOmitted: false, consoleRetentionDropped: 0, networkRetentionDropped: 0 },
  serializedBytes: 2048,
};

console.log("\n=== ShellX Browser Developer inspection UI ===");
const normalized = normalizeBrowserDeveloperInspection(inspected);
assert(normalized.status === "inspected" && normalized.document.checks.titleCount === 1, "normalizes the exact D1 inspected response");
const publicHomeRoute = normalizeBrowserDeveloperInspection({ ...inspected, inspected: { ...inspected.inspected, path: "/home/products" } });
assert(publicHomeRoute.status === "inspected" && publicHomeRoute.inspected.path === "/home/products", "accepts a sanitized public web path that resembles a local path");
assert(browserDeveloperInspectionUiState("task-1", normalized, false, false) === "success", "maps findings to the success state");
if (normalized.status !== "inspected") throw new Error("FAIL: expected inspected response");
assert(browserDeveloperInspectionUiState("task-1", { ...normalized, issues: [] }, false, false) === "empty-clean", "maps a clean inspection explicitly");
assert(browserDeveloperInspectionUiState("task-1", { ...normalized, truncation: { ...normalized.truncation, consoleOmitted: 1 } }, false, false) === "partial", "maps exact truncation counts to partial");
const missingDocumentFields = normalizeBrowserDeveloperInspection({
  ...inspected,
  document: { ...inspected.document, title: "", language: "" },
  issues: [
    { issueId: "document.title.missing", severity: "error", category: "metadata", evidence: "The page has no title.", remediation: "Add one concise title element." },
    { issueId: "document.language.missing", severity: "warning", category: "metadata", evidence: "The document language is missing.", remediation: "Set the document language." },
  ],
  issueCounts: { error: 1, warning: 1 },
});
assert(missingDocumentFields.status === "inspected" && missingDocumentFields.document.title === "" && browserDeveloperInspectionUiState("task-1", missingDocumentFields, false, false) === "success", "keeps empty title and language as valid issue evidence");
assert(browserDeveloperInspectionUiState(null, normalized, false, false) === "no-task", "requires a current task");
assert(browserDeveloperInspectionUiState("task-1", null, true, false) === "loading", "maps the active request to loading");
assert(browserDeveloperInspectionUiState("task-1", null, false, true) === "failed", "maps malformed or failed responses to failure");

const blocked = normalizeBrowserDeveloperInspection({
  schemaVersion: "sx.browserDeveloperInspection.v1", ok: false, status: "blocked", requiredApproval: "browserDeveloperModeApproval",
  inspected: { taskId: "task-1", browserTabId: "tab-1", origin: null, path: null }, withheldSections: ["document", "console", "network", "performance", "issues"], truncation: { engineUnavailable: false, developerModeRequired: true }, serializedBytes: 300,
});
assert(blocked.status === "blocked" && browserDeveloperInspectionUiState("task-1", blocked, false, false) === "developer-mode-required", "maps the exact Developer Mode block explicitly");

const unavailable = normalizeBrowserDeveloperInspection({
  schemaVersion: "sx.browserDeveloperInspection.v1", ok: false, status: "nativeEngineUnavailable", inspected: { taskId: "task-1", browserTabId: "tab-1", origin: "https://example.test", path: "/products" }, error: "Native Browser engine inspection was unavailable.", withheldSections: ["document", "console", "network", "performance", "issues"], truncation: { engineUnavailable: true, developerModeRequired: false }, serializedBytes: 300,
});
assert(unavailable.status === "nativeEngineUnavailable" && browserDeveloperInspectionUiState("task-1", unavailable, false, false) === "native-engine-unavailable", "maps the exact native-engine-unavailable response");

const artifact = normalizeBrowserDeveloperArtifactReceipt({ kind: "har", artifactId: "har-1", receiptId: "receipt-har-1", bytes: 1024, sha256: "a".repeat(64), createdAtMs: 200, entries: 4 }, "har");
assert(artifact.receiptId === "receipt-har-1" && artifact.entries === 4, "normalizes the compact operator artifact receipt");
assert(!("path" in artifact), "keeps private artifact paths outside the renderer DTO");

for (const [label, input] of [
  ["query-bearing path", { ...inspected, inspected: { ...inspected.inspected, path: "/products?secret=1" } }],
  ["private issue evidence", { ...inspected, issues: [{ ...inspected.issues[0], evidence: "/home/operator/private.txt" }] }],
  ["unbounded console lines", { ...inspected, console: { ...inspected.console, recent: Array.from({ length: 21 }, () => inspected.console.recent[0]) } }],
] as const) {
  let rejected = false;
  try { normalizeBrowserDeveloperInspection(input); } catch { rejected = true; }
  assert(rejected, `rejects ${label}`);
}

const panel = readFileSync(new URL("../src/browser/components/BrowserEvidencePanel.tsx", import.meta.url), "utf8");
const component = readFileSync(new URL("../src/browser/components/BrowserDeveloperInspection.tsx", import.meta.url), "utf8");
const hook = readFileSync(new URL("../src/browser/hooks/useBrowserDeveloperInspection.ts", import.meta.url), "utf8");
const api = readFileSync(new URL("../src/browser/api.ts", import.meta.url), "utf8");
const adapter = readFileSync(new URL("../src-tauri/src/shellx_browser_operator_diagnostics.rs", import.meta.url), "utf8");
const rustLib = readFileSync(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");
const css = readFileSync(new URL("../src/browser/browserEvidence.css", import.meta.url), "utf8");

assert(panel.includes("BrowserDeveloperInspection activeTaskId={activeTaskId}"), "mounts Developer inspection inside Browser Evidence");
for (const id of ["inspect", "export-har", "export-performance", "last-inspected", "issues", "console-summary", "network-summary", "performance-summary", "artifacts"]) {
  assert(component.includes(`shellx-browser-developer-${id}`), `publishes stable debug id for ${id}`);
}
for (const id of ["approve-current-site", "disable-mode", "access-required", "access-active"]) {
  assert(component.includes(`shellx-browser-developer-${id}`), `publishes stable Developer Mode debug id for ${id}`);
}
for (const state of ["no-task", "native-engine-unavailable", "developer-mode-required", "loading", "empty-clean", "partial", "failed", "success"]) {
  assert(component.includes(state), `renders the ${state} state explicitly`);
}
assert(component.includes("UI received") && component.includes("receipt identity, bytes, and hash prefix only") && !component.includes("artifact.path"), "labels local completion time and does not render artifact paths");
assert(component.includes('inspection.document.title || "Missing"') && component.includes('inspection.document.language || "Missing"'), "renders backend-permitted missing document fields without failure");
assert(component.includes('role={developer.state === "failed" ? "alert" : "status"}') && component.includes("aria-busy"), "exposes status and busy semantics");
assert(component.includes("isTrustedShellxUserEvent(event)") && component.includes("full CDP access for the current Browser host"), "requires a trusted operator click and explains the current-site access boundary");
assert(
  component.includes('className="shellx-browser-secondary shellx-browser-developer-permission-action"')
    && !component.includes('className="shellx-browser-primary"')
    && css.includes(".shellx-browser-developer-permission-action")
    && css.includes(".shellx-browser-developer-access:not(.active)"),
  "keeps a pending Developer Mode permission neutral until access is allowed",
);
assert(hook.includes("normalizeBrowserDeveloperInspection") && hook.includes("setCompletedAtMs(Date.now())"), "normalizes exact backend output and labels UI-local completion time");
assert(
  api.includes('invoke<unknown>("shellx_browser_operator_developer_inspect"')
    && api.includes('invoke<unknown>("shellx_browser_operator_export_har"')
    && api.includes('invoke<unknown>("shellx_browser_operator_export_performance"')
    && api.includes('invoke<unknown>("shellx_browser_approve_developer_mode_host"')
    && api.includes('invoke<unknown>("shellx_browser_update_developer_mode"')
    && api.includes("approvedHosts: []"),
  "uses explicit operator Tauri commands without general CDP IPC",
);
assert(adapter.includes("inspect_browser_developer_page") && adapter.includes("BrowserTaskControlAuthority::Operator") && adapter.includes("BrowserOperatorDiagnosticArtifactReceipt") && !adapter.includes("path:"), "uses local operator authority and path-free artifact DTOs");
assert(rustLib.includes("shellx_browser_operator_developer_inspect") && rustLib.includes("shellx_browser_operator_export_performance"), "registers the narrow operator adapters with Tauri");
assert(css.includes(".shellx-browser-developer") && css.includes("@media (max-width: 1000px)") && css.includes("prefers-reduced-motion"), "keeps the inspector responsive and motion-safe");

console.log("ShellX Browser Developer inspection UI checks passed");
