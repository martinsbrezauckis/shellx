import assert from "node:assert/strict";

import {
  buildPreviewQaReceipt,
  renderPreviewQaReceiptMarkdown,
  type PreviewQaFlowCheck,
} from "../src/lib/preview-qa-studio";
import { validatePreviewQaReleaseReceipt } from "./verify-preview-qa-receipt";
import type { WorkPreviewDiagnostic } from "../src/lib/work-preview";

const baseDiagnostic: WorkPreviewDiagnostic = {
  tabId: "tab-preview",
  ok: true,
  status: "passed",
  summary: "Preview Doctor passed",
  url: "http://127.0.0.1:5173/",
  cwd: "/home/user/app",
  command: "npm run dev",
  httpStatus: 200,
  responseBytes: 4096,
  title: "ShellX QA Fixture",
  screenshotPath: "/home/user/.grok/shellx-preview-screenshots/work-preview-tab-preview.png",
  screenshotWidth: 1440,
  screenshotHeight: 900,
  screenshotBrowser: "chromium",
  screenshotError: null,
  issues: [],
  browserEvents: [],
  logs: [],
  state: {
    tabId: "tab-preview",
    cwd: "/home/user/app",
    kind: "webApp",
    status: "running",
    url: "http://127.0.0.1:5173/",
    command: "npm run dev",
    taskId: "task-1",
    pid: 123,
    startedAtMs: 1_000,
    updatedAtMs: 2_000,
    viewportHint: null,
    error: null,
    logs: [],
  },
};

const happyFlows: PreviewQaFlowCheck[] = [
  {
    id: "primary-navigation",
    label: "Primary navigation",
    status: "pass",
    evidence: ["Clicked Settings, Files, Preview panels through debug API."],
  },
  {
    id: "broken-links",
    label: "Broken links",
    status: "pass",
    evidence: ["Checked 6 links; no 404 responses."],
  },
  {
    id: "layout-overflow",
    label: "Layout overflow",
    status: "pass",
    evidence: ["Viewport 390x844 and 1440x900 screenshots had no horizontal overflow."],
  },
];

const receipt = buildPreviewQaReceipt({
  generatedAt: "2026-06-06T12:00:00.000Z",
  sourceCommit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  target: {
    tabId: "tab-preview",
    label: "Preview QA fixture",
    cwd: "/home/user/app",
  },
  diagnostic: baseDiagnostic,
  flowChecks: happyFlows,
});

assert.equal(receipt.schemaVersion, "shellx.preview.qa.v1", "preview QA receipt has a stable schema");
assert.equal(receipt.sourceCommit, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "preview QA receipt can bind source identity");
assert.equal(receipt.status, "pass", "passing Preview Doctor plus passing flows produce pass");
assert.equal(receipt.summary.pass, 8, "receipt includes core and flow checks");
assert(
  receipt.checks.some((check) => check.id === "screenshot-captured" && check.status === "pass"),
  "receipt requires screenshot evidence when available",
);
assert(
  receipt.checks.some((check) => check.id === "console-errors" && check.status === "pass"),
  "receipt records browser console state",
);

const browserErrorReceipt = buildPreviewQaReceipt({
  target: { tabId: "tab-preview", cwd: "/home/user/app" },
  diagnostic: {
    ...baseDiagnostic,
    ok: false,
    status: "failed",
    issues: [{ severity: "error", source: "browser", message: "ReferenceError: appState is not defined" }],
    browserEvents: [{ level: "error", message: "ReferenceError: appState is not defined" }],
  },
  flowChecks: [
    {
      id: "primary-button",
      label: "Primary button responds",
      status: "fail",
      evidence: ["Click produced no DOM change within the QA driver timeout."],
    },
  ],
});

assert.equal(browserErrorReceipt.status, "fail", "browser and flow errors fail the QA receipt");
assert(
  browserErrorReceipt.checks.some((check) => check.id === "console-errors" && check.status === "fail"),
  "browser errors become explicit failed checks",
);
assert(
  browserErrorReceipt.checks.some((check) => check.id === "primary-button" && check.status === "fail"),
  "interactive flow failures are carried into the receipt",
);

const missingScreenshotReceipt = buildPreviewQaReceipt({
  target: { tabId: "tab-preview", cwd: "/home/user/app" },
  diagnostic: {
    ...baseDiagnostic,
    screenshotPath: null,
    screenshotError: "Chrome not installed",
  },
  flowChecks: happyFlows,
});
assert.equal(missingScreenshotReceipt.status, "warn", "missing screenshot evidence is a warning when preview is otherwise healthy");

const markdown = renderPreviewQaReceiptMarkdown(browserErrorReceipt);
assert(markdown.includes("Preview QA Studio receipt"), "markdown receipt has a title");
assert(markdown.includes("ReferenceError"), "markdown receipt includes browser evidence");
assert(markdown.includes("Primary button responds"), "markdown receipt includes flow checks");

const liveReceipt = buildPreviewQaReceipt({
  generatedAt: "2026-07-27T12:00:00.000Z",
  sourceCommit: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  target: { tabId: "tab-live", label: "Installed app preview", cwd: "/workspace/app" },
  diagnostic: {
    ...baseDiagnostic,
    tabId: "tab-live",
    cwd: "/workspace/app",
    state: { ...baseDiagnostic.state, tabId: "tab-live", cwd: "/workspace/app" },
  },
  flowChecks: happyFlows,
});
const validation = validatePreviewQaReleaseReceipt(
  liveReceipt,
  "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  Date.parse("2026-07-27T13:00:00.000Z"),
);
assert.equal(validation.status, "pass", "fresh source-bound live receipt passes release validation");
assert.equal(validation.interactiveCheckCount, happyFlows.length, "release validation requires live flow evidence");
assert.throws(
  () => validatePreviewQaReleaseReceipt(receipt, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", Date.parse("2026-06-06T13:00:00.000Z")),
  /synthetic unit-test target/,
  "synthetic receipt cannot satisfy the release command",
);
assert.throws(
  () => validatePreviewQaReleaseReceipt(liveReceipt, "cccccccccccccccccccccccccccccccccccccccc", Date.parse("2026-07-27T13:00:00.000Z")),
  /does not match current source/,
  "receipt from another source commit cannot satisfy the release command",
);

console.log("test-preview-qa-studio ok");
