import {
  buildReleaseReadinessChecks,
  shouldShowReleaseReadiness,
  summarizeReleaseReadiness,
  type ReleaseReadinessInput,
} from "../src/lib/release-readiness";
import { readFileSync } from "node:fs";

let failures = 0;
function assert(cond: boolean, label: string): void {
  console.log(`  ${cond ? "✓" : "✗"} ${label}`);
  if (!cond) failures += 1;
}

console.log("\n=== release readiness helpers ===");

const ready: ReleaseReadinessInput = {
  packageVersion: "0.1.31",
  cargoVersion: "0.1.31",
  tauriVersion: "0.1.31",
  workRepoClean: true,
  publicExportClean: true,
  changelogUpdated: true,
  publicBoundaryChecked: true,
  rustTestsVerified: true,
  rustCheckVerified: true,
  rustLintVerified: true,
  dependencyAuditVerified: true,
  semgrepScanVerified: true,
  jsTestsVerified: true,
  typecheckVerified: true,
  windowsArtifact: true,
  windowsSignature: true,
  linuxArtifact: true,
  macAppSmoke: true,
  macSignedNotarized: false,
  macArtifact: false,
  ciGrokShimVerified: true,
  githubCiGreen: true,
};

const checks = buildReleaseReadinessChecks(ready);
assert(checks.length >= 10, "readiness checklist includes release gates");
assert(checks.every((c) => c.command || c.status === "pass"), "non-passing gates include commands");
assert(checks.find((c) => c.id === "version-sync")?.status === "pass", "matching versions pass");
assert(checks.find((c) => c.id === "rust-lint")?.status === "pass", "rust clippy/fmt gate exists");
assert(checks.find((c) => c.id === "dependency-audit")?.status === "pass", "dependency audit gate exists");
assert(checks.find((c) => c.id === "semgrep-scan")?.status === "pass", "Semgrep source scan gate exists");
assert(checks.find((c) => c.id === "ci-grok-shim")?.status === "pass", "fake grok shim gate exists and passes when verified");
assert(checks.find((c) => c.id === "mac-app-smoke")?.status === "pass", "macOS app smoke gate exists and passes when verified");
assert(checks.find((c) => c.id === "mac-artifact")?.status === "warn", "missing mac artifact is a warning until signing is ready");
assert(
  checks.find((c) => c.id === "mac-signed-notarized")?.status === "warn",
  "missing macOS signing/notarization is a warning until public macOS launch",
);
assert(summarizeReleaseReadiness(checks).statusLabel === "ready with warnings", "warnings keep release in review state");

const broken = buildReleaseReadinessChecks({
  ...ready,
  cargoVersion: "0.1.30",
  workRepoClean: false,
  rustTestsVerified: false,
  rustLintVerified: false,
  semgrepScanVerified: false,
  macAppSmoke: false,
  ciGrokShimVerified: false,
});
assert(broken.find((c) => c.id === "version-sync")?.status === "fail", "version mismatch fails");
assert(broken.find((c) => c.id === "rust-lint")?.status === "fail", "missing rust clippy/fmt blocks release");
assert(broken.find((c) => c.id === "semgrep-scan")?.status === "fail", "missing Semgrep scan blocks release");
assert(broken.find((c) => c.id === "mac-app-smoke")?.status === "fail", "missing macOS app smoke blocks release staging");
assert(broken.find((c) => c.id === "ci-grok-shim")?.status === "fail", "missing fake grok shim blocks release");
assert(summarizeReleaseReadiness(broken).statusLabel === "blocked", "failed gates block release");

const ciWorkflow = readFileSync(".github/workflows/ci.yml", "utf8");
assert(ciWorkflow.includes("GROK_BIN"), "CI workflow exports GROK_BIN for tests that spawn grok");
assert(/fake grok/i.test(ciWorkflow), "CI workflow documents the fake grok shim");

assert(
  shouldShowReleaseReadiness({ dev: false, internalTools: undefined }) === false,
  "release readiness is hidden in normal production builds",
);
assert(
  shouldShowReleaseReadiness({ dev: true, internalTools: undefined }) === true,
  "release readiness remains visible during dev builds",
);
assert(
  shouldShowReleaseReadiness({ dev: false, internalTools: "1" }) === true,
  "release readiness can be enabled for internal production builds",
);

console.log(`\n${failures === 0 ? "PASS" : "FAIL"} release readiness helper tests`);
process.exit(failures === 0 ? 0 : 1);
