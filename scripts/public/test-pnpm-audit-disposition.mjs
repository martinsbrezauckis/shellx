import assert from "node:assert/strict";
import { evaluatePnpmAuditReport } from "./check-pnpm-audit.mjs";

const advisory = {
  github_advisory_id: "GHSA-fc5q-39xc-vjpf",
  module_name: "picomatch",
  severity: "high",
  findings: [{ version: "4.0.7", paths: [".>vite>picomatch"] }],
};
const report = {
  advisories: { "1247710": advisory },
  muted: [],
  metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 1, critical: 0 } },
};
const accepted = {
  report,
  exitStatus: 1,
  packageVersion: "0.3.62",
  lockText: "vite@6.4.6\npicomatch@4.0.7",
  now: new Date("2026-11-18T00:00:00Z"),
};
assert.match(evaluatePnpmAuditReport(accepted), /raw audit exit 1/);
for (const mutation of [
  { report: { ...report, advisories: { ...report.advisories, unknown: { ...advisory, github_advisory_id: "GHSA-new" } } } },
  { report: { ...report, advisories: { "1247710": { ...advisory, findings: [{ version: "4.0.8", paths: [".>vite>picomatch"] }] } } } },
  { report: { ...report, advisories: { "1247710": { ...advisory, findings: [{ version: "4.0.7", paths: [".>runtime>picomatch"] }] } } } },
  { packageVersion: "0.3.63" },
  { now: new Date("2026-12-18T00:00:00Z") },
  { lockText: "vite@7.0.0\npicomatch@4.0.7" },
  { report: { ...report, muted: ["GHSA-new"] } },
  { exitStatus: 2 },
]) {
  assert.throws(() => evaluatePnpmAuditReport({ ...accepted, ...mutation }));
}
assert.equal(evaluatePnpmAuditReport({
  ...accepted,
  report: { advisories: {}, muted: [] },
  exitStatus: 0,
}), "pnpm audit: no reported advisories");
assert.equal(evaluatePnpmAuditReport({
  ...accepted,
  report: { advisories: {}, muted: [] },
  exitStatus: 0,
  packageVersion: "0.3.63",
  lockText: "updated dependencies",
  now: new Date("2027-01-01T00:00:00Z"),
}), "pnpm audit: no reported advisories", "a clean later release needs no expired exception");
console.log("pnpm audit disposition rejects unknown findings, changed paths/versions, expiry, and tool failures");
