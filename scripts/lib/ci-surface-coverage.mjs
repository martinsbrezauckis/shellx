export const REQUIRED_SURFACE_CI_HOSTS = Object.freeze([
  "ubuntu-latest",
  "windows-latest",
  "macos-latest",
]);

export const REQUIRED_SURFACE_KINDS = Object.freeze([
  "browser-cli-command",
  "debug-api-route",
  "host-mcp-tool",
  "keyboard-shortcut",
  "palette-action",
  "shellx-command",
  "tauri-command",
  "ui-control",
  "ui-debug-surface",
]);

const EXPECTED_TYPECHECK_SCRIPT = "tsc --noEmit --noUnusedLocals --noUnusedParameters";

const EXPECTED_CI_SCRIPT = [
  "pnpm run surface:inventory:check",
  "pnpm run surface:driver-plan:check",
  "pnpm test",
].join(" && ");

const REQUIRED_LINUX_NATIVE_PACKAGES = Object.freeze([
  "libwebkit2gtk-4.1-dev",
  "libappindicator3-dev",
  "librsvg2-dev",
  "patchelf",
]);

export function ciSurfaceCoverageErrors({
  ciSource,
  buildScript,
  packageEngines,
  packageScripts,
  releaseSource,
  inventory,
  driverPlan,
  testSuites,
}) {
  ciSource = normalizeNewlines(ciSource);
  releaseSource = normalizeNewlines(releaseSource ?? "");
  const errors = [];
  const frontendJob = workflowJobBlock(ciSource, "frontend");
  if (!frontendJob.includes("run: pnpm run typecheck")) {
    errors.push("frontend CI does not invoke the canonical strict TypeScript gate");
  }
  if (!frontendJob.includes("run: pnpm build")) {
    errors.push("frontend CI does not build the production bundle");
  }
  if (packageScripts?.typecheck !== EXPECTED_TYPECHECK_SCRIPT) {
    errors.push("typecheck must reject unused locals and parameters");
  }
  const job = workflowJobBlock(ciSource, "surface-contracts");
  if (!job) {
    errors.push("CI is missing the surface-contracts job");
  } else {
    if (!job.includes("runs-on: ${{ matrix.os }}")) {
      errors.push("surface-contracts must run on its OS matrix");
    }
    for (const host of REQUIRED_SURFACE_CI_HOSTS) {
      if (!job.includes(`- ${host}`)) errors.push(`surface-contracts is missing ${host}`);
    }
    if (!job.includes("run: pnpm run ci:surface-contracts")) {
      errors.push("surface-contracts does not invoke the canonical package gate");
    }
    if (!job.includes("name: Install real NSIS callback fixture dependency")
      || !job.includes("if: runner.os == 'Linux'")
      || !job.includes("install -y nsis")) {
      errors.push("Linux surface-contracts CI is missing the real NSIS callback fixture dependency");
    }
    if (!job.includes("SHELLX_REQUIRE_REAL_NSIS_FIXTURE: ${{ runner.os == 'Linux' && '1' || '0' }}")) {
      errors.push("surface-contracts CI does not require the real NSIS callback fixture on Linux");
    }
  }

  if (packageScripts?.["ci:surface-contracts"] !== EXPECTED_CI_SCRIPT) {
    errors.push("ci:surface-contracts must check inventory, driver plan, and the complete test registry");
  }
  if (packageEngines?.node !== ">=22") {
    errors.push("package Node baseline must be the maintained Node 22+ line");
  }
  const workflowSources = `${ciSource}\n${releaseSource ?? ""}`;
  const nodeVersions = [...workflowSources.matchAll(/node-version:\s*([^\s#]+)/g)].map((match) => match[1]);
  if (nodeVersions.length < 3 || nodeVersions.some((version) => version !== "22")) {
    errors.push("every CI and build-only Node setup must exercise the declared Node 22 minimum");
  }
  if (!ciSource.includes("debug-api,windows-test-manifest")) {
    errors.push("Windows Rust CI is missing the test-only Common Controls manifest feature");
  }
  const linuxNativeJob = workflowJobBlock(ciSource, "rust-linux-native");
  if (!linuxNativeJob) {
    errors.push("CI is missing the Linux native Rust job");
  } else {
    if (!linuxNativeJob.includes("runs-on: ubuntu-22.04")) {
      errors.push("Linux native Rust CI must pin the Ubuntu 22.04 runner");
    }
    for (const packageName of REQUIRED_LINUX_NATIVE_PACKAGES) {
      if (!linuxNativeJob.includes(packageName)) {
        errors.push(`Linux native Rust CI is missing pinned package ${packageName}`);
      }
    }
    if (!linuxNativeJob.includes("run: cargo check --all-targets --features debug-api")) {
      errors.push("Linux native Rust CI is missing the debug-api cargo check gate");
    }
    if (!linuxNativeJob.includes("run: cargo test --all-targets --features debug-api")) {
      errors.push("Linux native Rust CI is missing the debug-api cargo test gate");
    }
  }
  if (!buildScript?.includes("WindowsAttributes::new_without_app_manifest()")) {
    errors.push("the Windows test manifest feature must suppress Tauri's duplicate app manifest resource");
  }
  if (packageScripts?.["audit:dependencies"] !== "pnpm audit --audit-level low") {
    errors.push("audit:dependencies must cover the complete lockfile down to low severity");
  }
  if (!ciSource.includes("run: pnpm run audit:dependencies")) {
    errors.push("CI does not run the complete dependency audit");
  }
  if (packageScripts?.pretest !== "node scripts/run-test-suite.mjs pretest"
    || packageScripts?.test !== "node scripts/run-test-suite.mjs test") {
    errors.push("the canonical test command is not bound to both explicit registries");
  }
  if (!Array.isArray(testSuites?.pretest) || testSuites.pretest.length < 75
    || !Array.isArray(testSuites?.test) || testSuites.test.length < 100) {
    errors.push("the explicit cross-platform test registry is incomplete");
  }

  const items = Array.isArray(inventory?.items) ? inventory.items : [];
  const assignments = Array.isArray(driverPlan?.assignments) ? driverPlan.assignments : [];
  if (items.length === 0) errors.push("surface inventory is empty");
  if (assignments.length === 0) errors.push("surface driver plan is empty");

  const inventoryIds = new Set();
  const inventoryKinds = new Set();
  for (const item of items) {
    if (inventoryIds.has(item.id)) errors.push(`duplicate inventory surface ${item.id}`);
    inventoryIds.add(item.id);
    inventoryKinds.add(item.kind);
  }
  for (const kind of REQUIRED_SURFACE_KINDS) {
    if (!inventoryKinds.has(kind)) errors.push(`surface inventory is missing kind ${kind}`);
  }

  const assignmentIds = new Set();
  for (const assignment of assignments) {
    if (assignmentIds.has(assignment.surfaceId)) {
      errors.push(`duplicate driver assignment ${assignment.surfaceId}`);
    }
    assignmentIds.add(assignment.surfaceId);
    if (!inventoryIds.has(assignment.surfaceId)) {
      errors.push(`driver plan references unknown surface ${assignment.surfaceId}`);
    }
    if (String(assignment.driverId ?? "").includes("backlog")
      || String(assignment.expectedEffect ?? "").startsWith("BUILDING:")) {
      errors.push(`surface remains BUILDING ${assignment.surfaceId}`);
    }
  }
  for (const id of inventoryIds) {
    if (!assignmentIds.has(id)) errors.push(`surface has no driver assignment ${id}`);
  }

  return errors;
}

function normalizeNewlines(source) {
  return source.replace(/\r\n?/g, "\n");
}

function workflowJobBlock(source, jobId) {
  const marker = `\n  ${jobId}:\n`;
  const start = `\n${source}`.indexOf(marker);
  if (start < 0) return "";
  const body = `\n${source}`.slice(start + 1);
  const next = body.slice(marker.length - 1).search(/\n  [A-Za-z0-9_-]+:\n/);
  return next < 0 ? body : body.slice(0, marker.length - 1 + next);
}
