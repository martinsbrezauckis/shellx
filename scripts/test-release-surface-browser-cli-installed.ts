import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ReleaseSurfaceDriverReport, ReleaseSurfaceDriverRequest } from "./lib/release-surface-driver-protocol";
import { releaseSurfaceControllerBindingFixture, releaseSurfaceFixtureSourceCommit, releaseSurfaceFixtureVersion } from "./fixtures/release-surface-controller-binding-fixture";
import { releaseSurfacePosixNativeBindingFixture } from "./fixtures/release-surface-posix-native-runtime-fixture";

const root = resolve(import.meta.dirname, "..");
const installedDriverSource = readFileSync(
  resolve(root, "scripts/release-drivers/browser-cli-command-installed.ts"),
  "utf8",
);
assert.match(
  installedDriverSource,
  /#coordinate-button\{position:fixed;/,
  "installed coordinate fixture must remain viewport-fixed after ref actions scroll the page",
);
assert.match(
  installedDriverSource,
  /#coordinate-input\{position:fixed;/,
  "installed coordinate input fixture must remain viewport-fixed after ref actions scroll the page",
);
assert.match(
  installedDriverSource,
  /case "screenshot": return \[command, "--full-page", \.\.\.task\];/,
  "installed Browser CLI screenshot proof must exercise the cross-platform page capture path",
);
assert.match(
  installedDriverSource,
  /execFile\(process\.execPath, releaseSurfaceControllerNodeArguments/,
  "installed Browser CLI must not starve its owned HTTP fixtures with synchronous child execution",
);
assert.match(
  installedDriverSource,
  /candidateTaskId === taskId/,
  "installed Browser CLI evaluation proof must reject a reused baseline task",
);
assert.match(
  installedDriverSource,
  /taskId: candidateTaskId, suiteId, group: "candidate"/,
  "installed Browser CLI evaluation proof must export its candidate from a distinct task",
);
const temp = mkdtempSync(join(tmpdir(), "shellx-browser-cli-installed-"));
const tokenPath = join(temp, "shellxagent.token");
const statePath = join(temp, "runtime.json");
const requestPath = join(temp, "request.json");
const reportPath = join(temp, "report.json");
const token = "fixture-browser-cli-installed-token-0001";
const sourceCommit = releaseSurfaceFixtureSourceCommit;
const commands = [
  "snapshot", "tabs", "locks", "check", "dialogs",
  "clear-site-data", "click-at", "click-ref", "extract", "fill-ref", "navigate", "observe", "resolve-dialog", "run-steps", "type-text", "verify", "wait-for",
  "flight-recorder-export", "rendered-check", "screenshot", "trace-open", "workflow-bookmarks", "workflow-evaluate", "workflow-replay", "workflow-save",
] as const;
const localPageCommands = new Set(["clear-site-data", "click-at", "click-ref", "extract", "fill-ref", "navigate", "observe", "resolve-dialog", "run-steps", "type-text", "verify", "wait-for"]);
const artifactCommands = new Set(["screenshot", "trace-open"]);
const recipeWorkflowCommands = new Set(["workflow-replay", "workflow-save"]);
let fixture: ChildProcess | null = null;

try {
  writeFileSync(tokenPath, token, { encoding: "utf8", mode: 0o600 });
  fixture = spawn(process.execPath, [
    "--import", "tsx", resolve(root, "scripts/fixtures/release-surface-runtime-server-fixture.ts"),
    "--token-file", tokenPath,
    "--state-out", statePath,
    "--instance-id", "fixture-browser-cli-instance-0001",
    "--process-id", "4321",
    "--version", releaseSurfaceFixtureVersion,
    "--source-commit", sourceCommit,
  ], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  const port = await waitForPort(statePath, fixture);
  const request = driverRequest(`http://127.0.0.1:${port}`);
  writeFileSync(requestPath, `${JSON.stringify(request, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });

  const described = spawnSync(process.execPath, [
    "--import", "tsx", resolve(root, "scripts/release-drivers/browser-cli-command-installed.ts"), "--describe",
  ], { cwd: root, encoding: "utf8" });
  assert.equal(described.status, 0, described.stderr || described.stdout);
  const manifest = JSON.parse(described.stdout) as { supportedOracles?: string[]; supportedCleanups?: string[] };
  assert(manifest.supportedOracles?.includes("browser-cli:check:schema"));
  assert(manifest.supportedOracles?.includes("browser-cli:dialogs:schema"));
  assert(manifest.supportedOracles?.includes("browser-cli:flight-recorder-export:flight-recorder-effect"));
  assert(manifest.supportedOracles?.includes("browser-cli:workflow-evaluate:flight-recorder-effect"));
  assert(manifest.supportedOracles?.includes("browser-cli:workflow-bookmarks:schema"));
  assert(manifest.supportedOracles?.includes("browser-cli:rendered-check:hidden-renderer-effect"));
  assert(manifest.supportedOracles?.includes("browser-cli:click-at:local-page-effect"));
  assert(manifest.supportedOracles?.includes("browser-cli:type-text:local-page-effect"));
  assert(manifest.supportedOracles?.includes("browser-cli:screenshot:artifact-effect"));
  assert(manifest.supportedOracles?.includes("browser-cli:trace-open:artifact-effect"));
  assert(manifest.supportedOracles?.includes("browser-cli:resolve-dialog:local-page-effect"));
  assert(manifest.supportedOracles?.includes("browser-cli:clear-site-data:local-page-effect"));
  assert(manifest.supportedOracles?.includes("browser-cli:workflow-save:workflow-effect"));
  assert(manifest.supportedOracles?.includes("browser-cli:workflow-replay:workflow-effect"));
  assert.deepEqual(manifest.supportedCleanups, [
    "browser-cli:read-only",
    "browser-cli:close-owned-task-and-delete-run-profile",
    "browser-cli:destroy-hidden-renderer-and-delete-run-profile",
  ]);

  const run = spawnSync(process.execPath, [
    "--import", "tsx", resolve(root, "scripts/release-drivers/browser-cli-command-installed.ts"),
    "--request", requestPath,
    "--out", reportPath,
  ], { cwd: root, encoding: "utf8", timeout: 60_000, maxBuffer: 16 * 1024 * 1024 });
  const failedReport = existsSync(reportPath) ? readFileSync(reportPath, "utf8") : "";
  assert.equal(run.status, 0, [run.stderr, run.stdout, failedReport].filter(Boolean).join("\n"));
  const report = JSON.parse(readFileSync(reportPath, "utf8")) as ReleaseSurfaceDriverReport;
  assert.equal(report.outcomes.length, commands.length);
  assert(report.outcomes.every((outcome) => (
    outcome.present === "pass"
    && outcome.invoke === "pass"
    && outcome.effect === "pass"
    && outcome.cleanup === "pass"
  )));
  assert(report.outcomes.find((outcome) => outcome.id.endsWith(":check"))?.observedEffect.includes("zero-mutation"));
  assert(report.outcomes.find((outcome) => outcome.id.endsWith(":dialogs"))?.observedEffect.includes("1 bounded dialog"));
  assert(report.outcomes.find((outcome) => outcome.id.endsWith(":navigate"))?.observedEffect.includes("successful owned-page effect"));
  assert(report.outcomes.find((outcome) => outcome.id.endsWith(":run-steps"))?.observedEffect.includes("two bounded actions"));
  assert(report.outcomes.find((outcome) => outcome.id.endsWith(":click-at"))?.observedEffect.includes("successful owned-page effect"));
  assert(report.outcomes.find((outcome) => outcome.id.endsWith(":type-text"))?.observedEffect.includes("successful owned-page effect"));
  assert(report.outcomes.find((outcome) => outcome.id.endsWith(":flight-recorder-export"))?.observedEffect.includes("valid SHA-256 identity"));
  assert(report.outcomes.find((outcome) => outcome.id.endsWith(":workflow-evaluate"))?.observedEffect.includes("evidence-complete evaluation"));
  assert(report.outcomes.find((outcome) => outcome.id.endsWith(":workflow-bookmarks"))?.observedEffect.includes("workflow contents were not retained"));
  assert(report.outcomes.find((outcome) => outcome.id.endsWith(":rendered-check"))?.observedEffect.includes("isolated hidden renderer"));
  assert(report.outcomes.find((outcome) => outcome.id.endsWith(":screenshot"))?.observedEffect.includes("positive dimensions"));
  assert(report.outcomes.find((outcome) => outcome.id.endsWith(":trace-open"))?.observedEffect.includes("bounded redacted trace"));
  assert(report.outcomes.find((outcome) => outcome.id.endsWith(":resolve-dialog"))?.observedEffect.includes("task-owned beforeunload dialog"));
  assert(report.outcomes.find((outcome) => outcome.id.endsWith(":clear-site-data"))?.observedEffect.includes("origin-storage sentinel"));
  assert(report.outcomes.find((outcome) => outcome.id.endsWith(":workflow-save"))?.observedEffect.includes("exact owned workflow bookmark"));
  assert(report.outcomes.find((outcome) => outcome.id.endsWith(":workflow-replay"))?.observedEffect.includes("bounded dry-run plan"));
  const reportText = readFileSync(reportPath, "utf8");
  for (const privateValue of [
    "fixture-flight-task-private",
    "fixture-flight-task-1-private",
    "fixture-flight-tab-private",
    "fixture-flight-tab-1-private",
    "fixture-flight-engine-private",
    "fixture-private-button-ref",
    "fixture-private-input-ref",
    "fixture-private-coordinate-input-ref",
    "fixture-private-page-text",
    "fixture-owner-private",
    "fixture-attempt-0-private",
    "fixture-attempt-1-private",
    "/fixture/private/attempt-0.json",
    "/fixture/private/attempt-1.json",
    "fixture-evaluation-report-private",
    "/fixture/private/evaluation.json",
    "fixture-workflow-bookmark-private",
    "fixture-alias-private",
    "fixture-recipe-private",
    "/fixture/private/workflow.json",
    "fixture-private-workflow-goal",
    "/fixture/private/screenshot.png",
    "fixture-private-screenshot-source",
    "fixture-screenshot-receipt-private",
    "browser-trace-fixture-private",
    "/fixture/private/trace.json",
    "fixture-private-trace-source",
    "fixture-trace-receipt-private",
    "fixture-workflow-recipe-private",
    "/fixture/private/workflow-recipe.json",
    "fixture-private-recipe-source",
    "fixture-recipe-receipt-private",
    "fixture-saved-workflow-bookmark-private",
    "fixture-private-workflow-label",
    "fixture-bookmark-receipt-private",
    "fixture-replay-receipt-private",
    "fixture-bookmark-delete-receipt-private",
    "fixture-owned-beforeunload-private",
    "fixture-private-beforeunload-text",
    "fixture-owned-dialog-receipt-private",
    "fixture-dialog-resolved-receipt-private",
  ]) {
    assert(!reportText.includes(privateValue), `Browser CLI driver report retained private Flight Recorder data: ${privateValue}`);
  }

  console.log("Release surface installed Browser CLI read/action tests passed");
} finally {
  if (fixture && fixture.exitCode === null && fixture.signalCode === null) {
    fixture.kill("SIGTERM");
    await waitForExit(fixture);
  }
  rmSync(temp, { recursive: true, force: true });
}

function driverRequest(base: string): ReleaseSurfaceDriverRequest {
  return {
    schema: "shellx/release-surface-driver-request@7",
    mode: "final-frozen-candidate",
    driverId: "browser-cli-command-installed",
    driverKind: "browser-cli-command",
    platform: "linux-installed",
    sourceCommit,
    version: releaseSurfaceFixtureVersion,
    inventoryDigest: "a".repeat(64),
    artifact: { basename: "shellx", sha256: "c".repeat(64) },
    controller: releaseSurfaceControllerBindingFixture(
      "scripts/release-drivers/browser-cli-command-installed.ts",
      ["scripts/shellx-browser-cli.ts"],
    ),
    runtime: {
      processId: 4321,
      instanceId: "fixture-browser-cli-instance-0001",
      debugBase: base,
      debugTokenPath: tokenPath,
      mcpBase: "http://127.0.0.1:9",
      mcpTokenPath: tokenPath,
      executableSha256: "d".repeat(64),
      installedPayloadPath: "/tmp/fixture/shellx",
      installedManifestSha256: "e".repeat(64),
      posixNative: releaseSurfacePosixNativeBindingFixture({ processId: 4321, port: Number(new URL(base).port), imagePath: "/tmp/fixture/shellx", imageSha256: "d".repeat(64) }),
    },
    assignments: commands.map((command) => ({
      surface: {
        id: `browser-cli-command:${command}`,
        kind: "browser-cli-command",
        name: command,
        source: "scripts/shellx-browser-cli.ts",
        platforms: ["windows-installed", "macos-installed", "linux-installed"],
        delivery: "source-package",
      },
      fixtureId: localPageCommands.has(command)
        ? "browser-cli:disposable-local-page-task"
        : artifactCommands.has(command)
          ? "browser-cli:disposable-local-page-task"
          : recipeWorkflowCommands.has(command)
            ? "browser-cli:disposable-local-page-task"
        : command === "rendered-check"
          ? "browser-cli:hidden-rendered-loopback"
        : command === "flight-recorder-export" || command === "workflow-evaluate"
          ? "browser-cli:flight-recorder-disposable-task"
          : "browser-cli:installed-read-model",
      expectedEffect: `${command} returns its exact installed effect`,
      oracleId: localPageCommands.has(command)
        ? `browser-cli:${command}:local-page-effect`
        : artifactCommands.has(command)
          ? `browser-cli:${command}:artifact-effect`
          : recipeWorkflowCommands.has(command)
            ? `browser-cli:${command}:workflow-effect`
        : command === "rendered-check"
          ? "browser-cli:rendered-check:hidden-renderer-effect"
        : command === "flight-recorder-export" || command === "workflow-evaluate"
          ? `browser-cli:${command}:flight-recorder-effect`
          : `browser-cli:${command}:schema`,
      cleanupId: localPageCommands.has(command) || artifactCommands.has(command) || recipeWorkflowCommands.has(command)
        || command === "flight-recorder-export" || command === "workflow-evaluate"
        ? "browser-cli:close-owned-task-and-delete-run-profile"
        : command === "rendered-check"
          ? "browser-cli:destroy-hidden-renderer-and-delete-run-profile"
        : "browser-cli:read-only",
    })),
  };
}

async function waitForPort(path: string, child: ChildProcess): Promise<number> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Browser CLI fixture exited before startup: ${await streamText(child.stderr)}`);
    }
    try {
      const value = JSON.parse(readFileSync(path, "utf8")) as { port?: number };
      if (Number.isInteger(value.port)) return Number(value.port);
    } catch {
      // Create-only fixture state has not landed yet.
    }
    await delay(50);
  }
  throw new Error("Browser CLI fixture did not publish its port");
}

async function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await Promise.race([
    new Promise<void>((resolveExit) => child.once("exit", () => resolveExit())),
    delay(2_000),
  ]);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

async function streamText(stream: NodeJS.ReadableStream | null): Promise<string> {
  if (!stream) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
