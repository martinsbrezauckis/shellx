import assert from "node:assert/strict";

import { evaluateRustsecReport, validateWinrtPatch } from "./check-rustsec.mjs";

const NOW = new Date("2026-07-10T12:00:00Z");

assert.deepEqual(validateWinrtPatch(), [], "reviewed Windows notification dependency patch stays intact");

function vulnerability(id = "RUSTSEC-2026-0194", version = "0.39.4") {
  return {
    advisory: { id, title: "fixture advisory" },
    package: { name: "quick-xml", version },
  };
}

function report(items = [vulnerability()], unsound = []) {
  return { vulnerabilities: { list: items }, warnings: { unsound } };
}

function policy(overrides = {}) {
  return {
    schemaVersion: "shellx.rustsec-dispositions.v1",
    entries: [{
      advisoryId: "RUSTSEC-2026-0194",
      package: "quick-xml",
      versions: ["0.39.4"],
      expiresOn: "2026-08-15",
      reason: "fixture reachability disposition",
      evidence: ["fixture evidence"],
      upgradeCondition: "upgrade the fixture owner",
      ...overrides,
    }],
  };
}

{
  const result = evaluateRustsecReport(report(), policy(), NOW);
  assert.equal(result.status, "pass");
  assert.equal(result.accepted.length, 1);
  assert.equal(result.blocking.length, 0);
}

{
  const result = evaluateRustsecReport(
    report([vulnerability(), vulnerability("RUSTSEC-2099-0001", "0.39.4")]),
    policy(),
    NOW,
  );
  assert.equal(result.status, "fail");
  assert.equal(result.blocking[0]?.key, "RUSTSEC-2099-0001:quick-xml@0.39.4");
}

{
  const unsound = vulnerability("RUSTSEC-2099-0002", "0.39.4");
  const result = evaluateRustsecReport(report([], [unsound]), policy(), NOW);
  assert.equal(result.status, "fail");
  assert.equal(result.blocking[0]?.key, "RUSTSEC-2099-0002:quick-xml@0.39.4");
}

{
  const result = evaluateRustsecReport(report([], [vulnerability()]), policy(), NOW);
  assert.equal(result.status, "pass");
  assert.equal(result.accepted.length, 1);
  assert.equal(result.blocking.length, 0);
}

{
  const result = evaluateRustsecReport(report([vulnerability("RUSTSEC-2026-0194", "0.40.0")]), policy(), NOW);
  assert.equal(result.status, "fail");
  assert.equal(result.blocking.length, 1);
  assert.deepEqual(result.stale, ["RUSTSEC-2026-0194:quick-xml@0.39.4"]);
}

{
  const result = evaluateRustsecReport(report(), policy({ expiresOn: "2026-07-09" }), NOW);
  assert.equal(result.status, "fail");
  assert.equal(result.expired.length, 1);
  assert.equal(result.blocking.length, 1);
}

{
  const result = evaluateRustsecReport({ vulnerabilities: { list: [] } }, policy(), NOW);
  assert.equal(result.status, "fail");
  assert.deepEqual(result.stale, ["RUSTSEC-2026-0194:quick-xml@0.39.4"]);
}

{
  const result = evaluateRustsecReport(report(), policy({ reason: "", evidence: [] }), NOW);
  assert.equal(result.status, "fail");
  assert.equal(result.policyErrors.length, 1);
}

console.log("RustSec disposition policy tests passed");
