import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import type { PreviewQaReceipt } from "../src/lib/preview-qa-studio";

const CORE_CHECK_IDS = new Set([
  "preview-running",
  "http-reachable",
  "console-errors",
  "server-errors",
  "screenshot-captured",
]);

export interface PreviewQaReleaseValidation {
  schemaVersion: "shellx.preview.qa.release-validation.v1";
  sourceCommit: string;
  receiptSha256: string;
  generatedAt: string;
  ageMinutes: number;
  target: string;
  checkCount: number;
  interactiveCheckCount: number;
  status: "pass";
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value.trim();
}

export function validatePreviewQaReleaseReceipt(
  value: unknown,
  expectedSourceCommit: string,
  nowMs = Date.now(),
  maxAgeHours = 24,
): Omit<PreviewQaReleaseValidation, "receiptSha256"> {
  const receipt = requireObject(value, "Preview QA receipt");
  if (receipt.schemaVersion !== "shellx.preview.qa.v1") {
    throw new Error(`Unsupported Preview QA receipt schema: ${String(receipt.schemaVersion)}`);
  }
  const sourceCommit = requireString(receipt.sourceCommit, "Preview QA receipt sourceCommit");
  if (!/^[a-f0-9]{40}$/i.test(sourceCommit)) throw new Error("Preview QA receipt sourceCommit must be a 40-character Git commit");
  if (sourceCommit.toLowerCase() !== expectedSourceCommit.toLowerCase()) {
    throw new Error(`Preview QA receipt source ${sourceCommit} does not match current source ${expectedSourceCommit}`);
  }
  if (receipt.status !== "pass") throw new Error(`Preview QA receipt status must be pass, got ${String(receipt.status)}`);

  const generatedAt = requireString(receipt.generatedAt, "Preview QA receipt generatedAt");
  const generatedMs = Date.parse(generatedAt);
  if (!Number.isFinite(generatedMs)) throw new Error("Preview QA receipt generatedAt must be an ISO timestamp");
  const ageMs = nowMs - generatedMs;
  if (ageMs < -5 * 60_000) throw new Error("Preview QA receipt is dated in the future");
  if (ageMs > maxAgeHours * 60 * 60_000) {
    throw new Error(`Preview QA receipt is stale (${Math.round(ageMs / 60_000)} minutes old)`);
  }

  const target = requireObject(receipt.target, "Preview QA receipt target");
  const targetLabel = requireString(target.label ?? target.tabId, "Preview QA receipt target label");
  const targetText = JSON.stringify(target).toLowerCase();
  if (targetText.includes("fixture") || targetText.includes("/home/user/app")) {
    throw new Error("Preview QA release receipt cannot use the synthetic unit-test target");
  }
  const targetUrl = requireString(target.url, "Preview QA receipt target url");
  if (!/^https?:\/\//i.test(targetUrl)) throw new Error("Preview QA receipt target url must be HTTP(S)");

  if (!Array.isArray(receipt.checks)) throw new Error("Preview QA receipt checks must be an array");
  const checks = receipt.checks.map((entry, index) => requireObject(entry, `Preview QA check ${index}`));
  for (const id of CORE_CHECK_IDS) {
    const check = checks.find((entry) => entry.id === id);
    if (!check) throw new Error(`Preview QA receipt is missing core check ${id}`);
    if (check.status !== "pass") throw new Error(`Preview QA core check ${id} must pass`);
    if (!Array.isArray(check.evidence) || check.evidence.length === 0) {
      throw new Error(`Preview QA core check ${id} must include evidence`);
    }
  }
  const interactiveChecks = checks.filter((entry) => typeof entry.id === "string" && !CORE_CHECK_IDS.has(entry.id));
  if (interactiveChecks.length === 0) throw new Error("Preview QA receipt must include at least one live interactive flow check");
  for (const check of interactiveChecks) {
    if (check.status !== "pass") throw new Error(`Preview QA interactive check ${String(check.id)} must pass`);
    if (!Array.isArray(check.evidence) || check.evidence.length === 0) {
      throw new Error(`Preview QA interactive check ${String(check.id)} must include evidence`);
    }
  }

  return {
    schemaVersion: "shellx.preview.qa.release-validation.v1",
    sourceCommit,
    generatedAt,
    ageMinutes: Math.max(0, Math.round(ageMs / 60_000)),
    target: targetLabel,
    checkCount: checks.length,
    interactiveCheckCount: interactiveChecks.length,
    status: "pass",
  };
}

function readArg(name: string): string | undefined {
  const args = process.argv.slice(2);
  const index = args.indexOf(name);
  if (index >= 0) return args[index + 1];
  return args.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1);
}

function currentCommit(): string {
  const result = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" });
  if (result.status !== 0) throw new Error((result.stderr || result.stdout || "git rev-parse failed").trim());
  return result.stdout.trim();
}

function main(): void {
  const receiptPath = readArg("--receipt");
  if (!receiptPath) {
    throw new Error("Usage: pnpm release:preview-qa -- --receipt <live-receipt.json>");
  }
  const bytes = readFileSync(receiptPath);
  const receipt = JSON.parse(bytes.toString("utf8")) as PreviewQaReceipt;
  const validation = validatePreviewQaReleaseReceipt(receipt, currentCommit());
  const output: PreviewQaReleaseValidation = {
    ...validation,
    receiptSha256: createHash("sha256").update(bytes).digest("hex"),
  };
  console.log(JSON.stringify(output));
}

const invokedAsScript = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedAsScript) {
  try {
    main();
  } catch (error) {
    console.error(`FAIL Preview QA release receipt: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
