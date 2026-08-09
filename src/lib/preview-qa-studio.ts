import type { WorkPreviewDiagnostic } from "./work-preview";

export type PreviewQaStatus = "pass" | "warn" | "fail";

export interface PreviewQaTarget {
  tabId: string;
  label?: string;
  cwd?: string | null;
  url?: string | null;
}

export interface PreviewQaFlowCheck {
  id: string;
  label: string;
  status: PreviewQaStatus;
  evidence: string[];
}

export interface PreviewQaCheck {
  id: string;
  label: string;
  status: PreviewQaStatus;
  evidence: string[];
}

export interface PreviewQaReceiptInput {
  generatedAt?: string;
  sourceCommit?: string;
  target: PreviewQaTarget;
  diagnostic: WorkPreviewDiagnostic;
  flowChecks?: PreviewQaFlowCheck[];
}

export interface PreviewQaReceipt {
  schemaVersion: "shellx.preview.qa.v1";
  generatedAt: string;
  sourceCommit?: string;
  target: PreviewQaTarget;
  status: PreviewQaStatus;
  summary: { pass: number; warn: number; fail: number };
  checks: PreviewQaCheck[];
}

export function buildPreviewQaReceipt(input: PreviewQaReceiptInput): PreviewQaReceipt {
  const diagnostic = input.diagnostic;
  const checks: PreviewQaCheck[] = [
    {
      id: "preview-running",
      label: "Preview running",
      status: diagnostic.state.status === "running" && Boolean(diagnostic.url) ? "pass" : "fail",
      evidence: [
        `status=${diagnostic.state.status}`,
        `url=${diagnostic.url ?? "(none)"}`,
        `kind=${diagnostic.state.kind ?? "(unknown)"}`,
      ],
    },
    {
      id: "http-reachable",
      label: "HTTP reachable",
      status: diagnostic.httpStatus && diagnostic.httpStatus >= 200 && diagnostic.httpStatus < 400 ? "pass" : "fail",
      evidence: [
        `httpStatus=${diagnostic.httpStatus ?? "(not fetched)"}`,
        `responseBytes=${diagnostic.responseBytes ?? "(unknown)"}`,
        `title=${diagnostic.title ?? "(none)"}`,
      ],
    },
    {
      id: "console-errors",
      label: "Browser console/runtime errors",
      status: hasErrorFrom(diagnostic, "browser") ? "fail" : "pass",
      evidence: browserEvidence(diagnostic),
    },
    {
      id: "server-errors",
      label: "Server/runtime log errors",
      status: hasServerErrors(diagnostic) ? "fail" : "pass",
      evidence: serverEvidence(diagnostic),
    },
    {
      id: "screenshot-captured",
      label: "Screenshot evidence",
      status: diagnostic.screenshotPath ? "pass" : "warn",
      evidence: [
        `screenshot=${diagnostic.screenshotPath ?? "(not captured)"}`,
        `viewport=${diagnostic.screenshotWidth && diagnostic.screenshotHeight ? `${diagnostic.screenshotWidth}x${diagnostic.screenshotHeight}` : "(unknown)"}`,
        `browser=${diagnostic.screenshotBrowser ?? "(unknown)"}`,
        `error=${diagnostic.screenshotError ?? "(none)"}`,
      ],
    },
    ...((input.flowChecks ?? []).map((check) => ({
      id: check.id,
      label: check.label,
      status: check.status,
      evidence: check.evidence.length > 0 ? check.evidence : ["No evidence text was recorded."],
    } satisfies PreviewQaCheck))),
  ];
  const summary = summarizePreviewQaChecks(checks);
  return {
    schemaVersion: "shellx.preview.qa.v1",
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    sourceCommit: input.sourceCommit,
    target: {
      ...input.target,
      cwd: input.target.cwd ?? diagnostic.cwd,
      url: input.target.url ?? diagnostic.url,
    },
    status: summary.fail > 0 ? "fail" : summary.warn > 0 ? "warn" : "pass",
    summary,
    checks,
  };
}

export function renderPreviewQaReceiptMarkdown(receipt: PreviewQaReceipt): string {
  return [
    "Preview QA Studio receipt",
    "",
    `Schema: ${receipt.schemaVersion}`,
    `Generated: ${receipt.generatedAt}`,
    `Source commit: ${receipt.sourceCommit ?? "(unbound)"}`,
    `Target: ${receipt.target.label ?? receipt.target.tabId}`,
    `Cwd: ${receipt.target.cwd ?? "(unknown)"}`,
    `Url: ${receipt.target.url ?? "(none)"}`,
    `Status: ${receipt.status}`,
    `Pass: ${receipt.summary.pass}`,
    `Warn: ${receipt.summary.warn}`,
    `Fail: ${receipt.summary.fail}`,
    "",
    "Checks:",
    ...receipt.checks.flatMap((check) => [
      `- ${check.label} (${check.status})`,
      ...check.evidence.slice(0, 8).map((line) => `  ${line}`),
    ]),
  ].join("\n");
}

function summarizePreviewQaChecks(checks: PreviewQaCheck[]): { pass: number; warn: number; fail: number } {
  return {
    pass: checks.filter((check) => check.status === "pass").length,
    warn: checks.filter((check) => check.status === "warn").length,
    fail: checks.filter((check) => check.status === "fail").length,
  };
}

function hasErrorFrom(diagnostic: WorkPreviewDiagnostic, source: string): boolean {
  const normalizedSource = source.toLowerCase();
  return diagnostic.issues.some(
    (issue) => issue.severity === "error" && issue.source.toLowerCase() === normalizedSource,
  );
}

function hasServerErrors(diagnostic: WorkPreviewDiagnostic): boolean {
  return diagnostic.issues.some(
    (issue) =>
      issue.severity === "error" &&
      (issue.source.toLowerCase().includes("log") || issue.source.toLowerCase().includes("server")),
  );
}

function browserEvidence(diagnostic: WorkPreviewDiagnostic): string[] {
  const issueEvidence = diagnostic.issues
    .filter((issue) => issue.source.toLowerCase() === "browser")
    .map((issue) => `[${issue.severity}] ${issue.message}`);
  const eventEvidence = diagnostic.browserEvents
    .filter((event) => event.level.toLowerCase() === "error")
    .map((event) => `[${event.level}] ${event.message}${event.source ? ` (${event.source})` : ""}`);
  const evidence = [...issueEvidence, ...eventEvidence];
  return evidence.length > 0 ? evidence.slice(0, 12) : ["No browser console/runtime errors recorded."];
}

function serverEvidence(diagnostic: WorkPreviewDiagnostic): string[] {
  const issueEvidence = diagnostic.issues
    .filter((issue) => issue.source.toLowerCase().includes("log") || issue.source.toLowerCase().includes("server"))
    .map((issue) => `[${issue.severity}] ${issue.message}`);
  const logEvidence = diagnostic.logs
    .filter((line) => /error|exception|panic|traceback|failed/i.test(line.line))
    .map((line) => `[${line.stream}] ${line.line}`);
  const evidence = [...issueEvidence, ...logEvidence];
  return evidence.length > 0 ? evidence.slice(0, 12) : ["No server/runtime log errors recorded."];
}
