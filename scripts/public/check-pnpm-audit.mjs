import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The raw audit still exits 1: this accepts one reviewed 0.3.62 build-tool
// exposure only. All new findings, changed paths or versions, and stale
// dispositions fail closed.
const RELEASE_VERSION = "0.3.62";
const EXPECTED_ID = "GHSA-fc5q-39xc-vjpf";
const EXPECTED_PATH = ".>vite>picomatch";
const EXPECTED_VERSION = "4.0.7";
const EXPIRES_AT = Date.parse("2026-12-17T23:59:59.999Z");

export function evaluatePnpmAuditReport({ report, exitStatus, packageVersion, lockText, now = new Date() }) {
  if (!report || typeof report.advisories !== "object" || report.advisories === null
    || Array.isArray(report.advisories) || !Array.isArray(report.muted) || report.muted.length !== 0) {
    throw new Error("pnpm audit schema changed or muted findings exist");
  }
  const advisories = Object.values(report.advisories);
  if (advisories.length === 0) {
    if (exitStatus !== 0) throw new Error("pnpm audit exited nonzero without a reported advisory");
    return "pnpm audit: no reported advisories";
  }
  if (packageVersion !== RELEASE_VERSION || now.getTime() > EXPIRES_AT) {
    throw new Error("picomatch build-tool disposition is limited to unexpired ShellX 0.3.62");
  }
  if (!lockText.includes("vite@6.4.6") || !lockText.includes("picomatch@4.0.7")) {
    throw new Error("reviewed Vite/picomatch lockfile versions changed; re-triage the advisory");
  }
  const advisory = advisories[0];
  const finding = advisory?.findings?.[0];
  const counts = report.metadata?.vulnerabilities;
  if (exitStatus !== 1 || advisories.length !== 1
    || advisory.github_advisory_id !== EXPECTED_ID
    || advisory.module_name !== "picomatch"
    || advisory.severity !== "high"
    || advisory.findings?.length !== 1
    || finding?.version !== EXPECTED_VERSION
    || finding.paths?.length !== 1
    || finding.paths[0] !== EXPECTED_PATH
    || counts?.high !== 1
    || ["info", "low", "moderate", "critical"].some((severity) => counts?.[severity] !== 0)) {
    throw new Error("pnpm audit has a finding beyond the exact reviewed 0.3.62 build-tool disposition");
  }
  return `ACCEPTED FOR 0.3.62 BUILD TOOL ONLY: ${EXPECTED_ID} ${EXPECTED_PATH}@${EXPECTED_VERSION}; raw audit exit 1`;
}

function main() {
  const result = spawnSync("pnpm", ["audit", "--json", "--audit-level", "low"], {
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (![0, 1].includes(result.status)) {
    throw new Error(`pnpm audit failed unexpectedly with exit ${result.status ?? result.signal}`);
  }
  let report;
  try { report = JSON.parse(result.stdout); }
  catch { throw new Error("pnpm audit did not return valid structured JSON"); }
  console.log(evaluatePnpmAuditReport({
    report,
    exitStatus: result.status,
    packageVersion: JSON.parse(readFileSync("package.json", "utf8")).version,
    lockText: readFileSync("pnpm-lock.yaml", "utf8"),
  }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
