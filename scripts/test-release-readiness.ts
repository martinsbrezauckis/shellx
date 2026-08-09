import {
  buildReleaseRunbook,
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
  providerCapabilitySnapshotVerified: true,
  debugApiSurfaceSweepVerified: true,
  shellxBrowserDebugApiVerified: true,
  tauriWebdriverVerified: true,
  previewQaStudioVerified: true,
  jsTestsVerified: true,
  typecheckVerified: true,
  windowsArtifact: true,
  windowsSignature: true,
  updaterManifest: true,
  linuxArtifact: true,
  macAppSmoke: true,
  macSignedNotarized: true,
  macArtifact: true,
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
assert(
  checks.find((c) => c.id === "provider-capability-snapshot")?.status === "pass",
  "provider capability snapshot gate exists",
);
assert(
  checks.find((c) => c.id === "debug-api-surface-sweep")?.status === "pass",
  "debug API surface sweep gate exists",
);
assert(
  checks.find((c) => c.id === "shellx-browser-debug-api")?.status === "pass",
  "ShellX Browser debug API smoke gate exists",
);
assert(checks.find((c) => c.id === "tauri-webdriver")?.status === "pass", "Tauri WebDriver smoke gate exists");
assert(
  checks.find((c) => c.id === "preview-qa-studio")?.status === "pass",
  "Preview QA Studio gate exists",
);
assert(checks.find((c) => c.id === "ci-grok-shim")?.status === "pass", "fake grok shim gate exists and passes when verified");
assert(checks.find((c) => c.id === "mac-app-smoke")?.status === "pass", "macOS app smoke gate exists and passes when verified");
assert(checks.find((c) => c.id === "mac-artifact")?.status === "pass", "mac artifact gate passes when artifacts are staged");
assert(checks.find((c) => c.id === "updater-manifest")?.status === "pass", "updater manifest gate passes when generated");
assert(
  checks.find((c) => c.id === "mac-signed-notarized")?.status === "pass",
  "macOS signing/notarization gate passes when verified",
);
assert(
  summarizeReleaseReadiness(checks).statusLabel === "ready with warnings",
  "local gates passing still leaves explicit publish approval as a warning",
);

const broken = buildReleaseReadinessChecks({
  ...ready,
  cargoVersion: "0.1.30",
  workRepoClean: false,
  rustTestsVerified: false,
  rustLintVerified: false,
  semgrepScanVerified: false,
  providerCapabilitySnapshotVerified: false,
  debugApiSurfaceSweepVerified: false,
  shellxBrowserDebugApiVerified: false,
  tauriWebdriverVerified: false,
  previewQaStudioVerified: false,
  macAppSmoke: false,
  macArtifact: false,
  macSignedNotarized: false,
  updaterManifest: false,
  ciGrokShimVerified: false,
});
assert(broken.find((c) => c.id === "version-sync")?.status === "fail", "version mismatch fails");
assert(broken.find((c) => c.id === "rust-lint")?.status === "fail", "missing rust clippy/fmt blocks release");
assert(broken.find((c) => c.id === "semgrep-scan")?.status === "fail", "missing Semgrep scan blocks release");
assert(
  broken.find((c) => c.id === "provider-capability-snapshot")?.status === "fail",
  "missing provider capability snapshot blocks release",
);
assert(
  broken.find((c) => c.id === "debug-api-surface-sweep")?.status === "fail",
  "missing debug API surface sweep blocks release",
);
assert(
  broken.find((c) => c.id === "shellx-browser-debug-api")?.status === "fail",
  "missing ShellX Browser debug API smoke blocks release",
);
assert(
  broken.find((c) => c.id === "tauri-webdriver")?.status === "fail",
  "missing Tauri WebDriver smoke blocks release",
);
assert(
  broken.find((c) => c.id === "preview-qa-studio")?.status === "fail",
  "missing Preview QA Studio receipt blocks release",
);
assert(
  broken.find((c) => c.id === "preview-qa-studio")?.command?.includes("--receipt <live-receipt.json>") === true,
  "Preview QA Studio gate requires an explicit live receipt",
);
assert(broken.find((c) => c.id === "mac-app-smoke")?.status === "fail", "missing macOS app smoke blocks release staging");
assert(broken.find((c) => c.id === "mac-artifact")?.status === "fail", "missing macOS artifact blocks release staging");
assert(broken.find((c) => c.id === "updater-manifest")?.status === "fail", "missing updater manifest blocks release staging");
assert(
  broken.find((c) => c.id === "mac-signed-notarized")?.status === "fail",
  "missing macOS signing/notarization blocks release staging",
);
assert(broken.find((c) => c.id === "ci-grok-shim")?.status === "fail", "missing fake grok shim blocks release");
assert(summarizeReleaseReadiness(broken).statusLabel === "blocked", "failed gates block release");

const publicBoundaryMissing = buildReleaseReadinessChecks({
  ...ready,
  publicBoundaryChecked: false,
});
assert(
  publicBoundaryMissing
    .find((c) => c.id === "public-boundary")
    ?.command?.includes("AGENTS\\.md|grok-shell|\\.project|private|notebook|night_run|mockups") === true,
  "public-boundary gate scans for stale repo/private host markers",
);

const runbook = buildReleaseRunbook({ version: "0.1.31", checks: broken });
assert(runbook.includes("shellX v0.1.31 release runbook"), "runbook includes release version");
assert(runbook.includes("yes, push"), "runbook preserves explicit push approval reminder");
assert(runbook.includes("yes, tag"), "runbook preserves explicit tag approval reminder");
assert(runbook.includes("yes, release"), "runbook preserves explicit release approval reminder");
assert(runbook.includes("Rust fmt/clippy"), "runbook includes failing gate labels");
assert(runbook.includes("Preview QA Studio"), "runbook includes Preview QA gate");
assert(!runbook.includes("tomorrow"), "runbook uses date-neutral approval wording");

const ciWorkflow = readFileSync(".github/workflows/ci.yml", "utf8");
assert(ciWorkflow.includes("GROK_BIN"), "CI workflow exports GROK_BIN for tests that spawn grok");
assert(/fake grok/i.test(ciWorkflow), "CI workflow documents the fake grok shim");

const releaseWorkflow = readFileSync(".github/workflows/release.yml", "utf8");
assert(
  releaseWorkflow.includes("save-if: ${{ runner.os != 'Windows' }}"),
  "build-only release smoke does not fail Windows completion on post-job Rust cache save",
);
assert(
  /permissions:\s*\n\s*contents: read/.test(releaseWorkflow),
  "build-only release smoke has read-only repository contents permission",
);
assert(
  releaseWorkflow.includes("pnpm tauri build --features debug-api"),
  "build-only release smoke compiles Tauri bundles directly",
);
assert(
  !/contents:\s*write/.test(releaseWorkflow) &&
    !/\btagName:|\breleaseName:|\breleaseDraft:|\breleaseBody:|\bprerelease:/.test(releaseWorkflow),
  "build-only release smoke cannot configure GitHub tag or release creation",
);
assert(
  !/GITHUB_TOKEN|TAURI_SIGNING_PRIVATE_KEY|secrets\./.test(releaseWorkflow),
  "build-only release smoke receives no publish or signing secrets",
);

const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as { scripts?: Record<string, string> };
const publicScriptText = JSON.stringify(packageJson.scripts ?? {});
assert(
  !publicScriptText.includes("release-quality-receipt") &&
    !publicScriptText.includes("release-docs-audit") &&
    !publicScriptText.includes("test-release-docs-audit"),
  "public package scripts do not expose internal release audit runners",
);
assert(
  packageJson.scripts?.["release:preview-qa"] === "tsx scripts/verify-preview-qa-receipt.ts",
  "Preview QA release command validates evidence instead of running the receipt-builder unit test",
);

const gitignore = readFileSync(".gitignore", "utf8");
for (const internalPath of [
  "scripts/release-docs-audit.ts",
  "scripts/release-quality-receipt.ts",
  "scripts/test-release-docs-audit.ts",
  "src/lib/release-docs-audit.ts",
  "release-evidence/",
]) {
  assert(gitignore.includes(internalPath), `gitignore protects internal release path ${internalPath}`);
}

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
