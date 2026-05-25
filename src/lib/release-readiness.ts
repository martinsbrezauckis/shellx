export type ReleaseGateStatus = "pass" | "warn" | "fail";

export interface ReleaseReadinessInput {
  packageVersion: string;
  cargoVersion: string;
  tauriVersion: string;
  workRepoClean: boolean;
  publicExportClean: boolean;
  changelogUpdated: boolean;
  publicBoundaryChecked: boolean;
  rustTestsVerified: boolean;
  rustCheckVerified: boolean;
  rustLintVerified: boolean;
  dependencyAuditVerified: boolean;
  jsTestsVerified: boolean;
  typecheckVerified: boolean;
  windowsArtifact: boolean;
  windowsSignature: boolean;
  linuxArtifact: boolean;
  macArtifact: boolean;
  ciGrokShimVerified: boolean;
  githubCiGreen: boolean;
}

export interface ReleaseReadinessCheck {
  id: string;
  label: string;
  status: ReleaseGateStatus;
  detail: string;
  command?: string;
}

export interface ReleaseReadinessSummary {
  statusLabel: "ready" | "ready with warnings" | "blocked";
  accent: "ok" | "warn" | "bad";
  pass: number;
  warn: number;
  fail: number;
}

export interface ReleaseReadinessVisibilityEnv {
  dev: boolean;
  internalTools?: string | boolean;
}

export function shouldShowReleaseReadiness(env: ReleaseReadinessVisibilityEnv): boolean {
  return env.dev || env.internalTools === true || env.internalTools === "1" || env.internalTools === "true";
}

function check(
  id: string,
  label: string,
  passed: boolean,
  detailPass: string,
  detailFail: string,
  command: string,
  failStatus: ReleaseGateStatus = "fail",
): ReleaseReadinessCheck {
  return {
    id,
    label,
    status: passed ? "pass" : failStatus,
    detail: passed ? detailPass : detailFail,
    command: passed ? undefined : command,
  };
}

export function buildReleaseReadinessChecks(input: ReleaseReadinessInput): ReleaseReadinessCheck[] {
  const versions = [input.packageVersion, input.cargoVersion, input.tauriVersion].filter(Boolean);
  const versionsMatch = versions.length === 3 && new Set(versions).size === 1;
  return [
    check(
      "work-repo-clean",
      "Work repo clean",
      input.workRepoClean,
      "No local worktree changes.",
      "Commit, stash, or intentionally remove local changes before packaging.",
      "git -C <work-repo> status --short",
    ),
    check(
      "public-export-clean",
      "Public export clean",
      input.publicExportClean,
      "Public export has no dirty tracked or untracked files.",
      "Public export needs review before release staging.",
      "git -C <public-export> status --short",
    ),
    check(
      "version-sync",
      "Version sync",
      versionsMatch,
      `All manifests report v${versions[0] ?? "?"}.`,
      `Versions differ: package ${input.packageVersion}, Cargo ${input.cargoVersion}, Tauri ${input.tauriVersion}.`,
      "rg '0\\.1\\.' package.json src-tauri/Cargo.toml src-tauri/tauri.conf.json",
    ),
    check(
      "changelog",
      "Changelog",
      input.changelogUpdated,
      "CHANGELOG has release notes for the current version.",
      "Add user-facing release notes before packaging.",
      "sed -n '1,80p' CHANGELOG.md",
    ),
    check(
      "public-boundary",
      "Public boundary scan",
      input.publicBoundaryChecked,
      "Public/private boundary scan reviewed.",
      "Run the public-boundary scan and review every match before staging.",
      'rg -n "\\.project|private|notebook|night_run|mockups" .',
    ),
    check(
      "rust-tests",
      "Rust tests",
      input.rustTestsVerified,
      "Rust unit tests passed.",
      "Run the Rust test suite and fix failures.",
      "cd src-tauri && cargo test --features debug-api --lib",
    ),
    check(
      "rust-check",
      "Rust check",
      input.rustCheckVerified,
      "Rust debug-api build check passed.",
      "Run cargo check with debug-api enabled.",
      "cd src-tauri && cargo check --features debug-api",
    ),
    check(
      "rust-lint",
      "Rust fmt/clippy",
      input.rustLintVerified,
      "Rust formatting and clippy passed with warnings denied.",
      "Run Rust formatting and clippy checks, then fix any warnings.",
      "cd src-tauri && cargo fmt --check && cargo clippy --all-targets --features debug-api -- -D warnings",
    ),
    check(
      "dependency-audit",
      "Dependency audit",
      input.dependencyAuditVerified,
      "Rust dependency audit passed.",
      "Run cargo audit and review any advisories before release.",
      "cd src-tauri && cargo audit",
    ),
    check(
      "js-tests",
      "JS tests",
      input.jsTestsVerified,
      "Frontend/script test suite passed.",
      "Run the JS test suite and fix failures.",
      "pnpm test",
    ),
    check(
      "typecheck",
      "TypeScript",
      input.typecheckVerified,
      "TypeScript check passed.",
      "Run frontend typecheck and fix errors.",
      "pnpm exec tsc --noEmit",
    ),
    check(
      "windows-artifact",
      "Windows artifact",
      input.windowsArtifact,
      "Windows installer/artifact is present.",
      "Build and inspect the Windows package.",
      "pnpm tauri build --target x86_64-pc-windows-msvc",
    ),
    check(
      "windows-signature",
      "Windows signature/hash",
      input.windowsSignature,
      "Windows installer signature and SHA256SUMS are present.",
      "Verify the Windows installer .sig and SHA256SUMS.txt are present in the release artifact folder.",
      `Get-ChildItem "$env:USERPROFILE\\shellx-builds\\v${input.packageVersion}"`,
    ),
    check(
      "linux-artifact",
      "Linux artifact",
      input.linuxArtifact,
      "Linux package is present.",
      "Build and inspect the Linux package.",
      "pnpm tauri build",
    ),
    check(
      "mac-artifact",
      "macOS artifact",
      input.macArtifact,
      "macOS package is present.",
      "Build on the macOS signing host when signing/notarization is ready.",
      "ssh <macos-builder> 'cd <repo> && pnpm tauri build'",
      "warn",
    ),
    check(
      "ci-grok-shim",
      "CI fake grok shim",
      input.ciGrokShimVerified,
      "CI has a fake grok binary or equivalent shim for tests that spawn grok.",
      "Add or verify a fake grok binary is placed on PATH before CI tests that need grok.",
      "command -v grok || printf 'install fake grok shim for CI tests\\n'",
    ),
    check(
      "github-ci",
      "GitHub CI",
      input.githubCiGreen,
      "Latest GitHub Actions checks are green for the release commit.",
      "Confirm GitHub Actions are green before publishing a GitHub release.",
      "gh run list --limit 5",
    ),
    {
      id: "publish-approval",
      label: "Publish approval",
      status: "warn",
      detail: "Push, tag, and GitHub release each require explicit per-operation approval.",
      command: "Ask for: yes, push / yes, tag / yes, release",
    },
  ];
}

export function summarizeReleaseReadiness(checks: ReleaseReadinessCheck[]): ReleaseReadinessSummary {
  const pass = checks.filter((c) => c.status === "pass").length;
  const warn = checks.filter((c) => c.status === "warn").length;
  const fail = checks.filter((c) => c.status === "fail").length;
  if (fail > 0) return { statusLabel: "blocked", accent: "bad", pass, warn, fail };
  if (warn > 0) return { statusLabel: "ready with warnings", accent: "warn", pass, warn, fail };
  return { statusLabel: "ready", accent: "ok", pass, warn, fail };
}
