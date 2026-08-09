import { evaluateGrypeRustReport } from "./check-grype-rust.mjs";

const now = new Date("2026-08-05T00:00:00Z");
const report = {
  descriptor: { db: { status: { valid: true, built: "2026-08-04T00:00:00Z" } } },
  matches: [{
    artifact: { type: "rust-crate", name: "fixture-crate", version: "1.0.0" },
    vulnerability: { id: "GHSA-fixture", description: "fixture" },
  }],
};
const policy = {
  schemaVersion: "shellx.grype-dispositions.v1",
  entries: [{
    advisoryId: "GHSA-fixture",
    package: "fixture-crate",
    versions: ["1.0.0"],
    expiresOn: "2026-08-06",
    reason: "fixture reachability review",
    evidence: ["fixture evidence"],
    upgradeCondition: "upgrade fixture",
  }],
};

if (evaluateGrypeRustReport(report, policy, now).status !== "pass") throw new Error("current exact disposition must pass");
const unknown = structuredClone(report);
unknown.matches[0].vulnerability.id = "GHSA-unknown";
if (evaluateGrypeRustReport(unknown, policy, now).status !== "fail") throw new Error("unknown advisory must block");
const expired = structuredClone(policy);
expired.entries[0].expiresOn = "2026-08-04";
if (evaluateGrypeRustReport(report, expired, now).status !== "fail") throw new Error("expired disposition must block");
const staleDb = structuredClone(report);
staleDb.descriptor.db.status.built = "2026-07-01T00:00:00Z";
if (evaluateGrypeRustReport(staleDb, policy, now).status !== "fail") throw new Error("stale Grype DB must block");
console.log("PASS Grype Rust/GHSA audit policy tests");

