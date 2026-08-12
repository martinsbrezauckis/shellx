import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import {
  ReleaseSurfaceWebDriverOrchestrationError,
  withReleaseSurfaceWebDriverOrchestration,
  type ReleaseSurfaceWebDriverOrchestrationInput,
  type ReleaseSurfaceWebDriverOrchestrationContext,
} from "./lib/release-surface-webdriver-orchestration";
import { RELEASE_SURFACE_CANDIDATE_ATTESTATION_SCHEMA } from "./lib/release-surface-candidate-attestation";
import { RELEASE_SURFACE_DRIVER_RUN_SCHEMA } from "./lib/release-surface-driver-runner";
import { validateCreateOnlyEvidenceDirectory } from "./lib/release-surface-evidence-paths";

const root = resolve(import.meta.dirname, "..");
const tsxImport = import.meta.resolve("tsx");
const fixturePath = resolve(root, "scripts/fixtures/release-surface-webdriver-lifecycle-driver-fixture.ts");
const temp = mkdtempSync(join(tmpdir(), "shellx-webdriver-orchestration-"));
// This fixture proves the WebDriver orchestration used by Windows and Linux.
// macOS has a separate native-input candidate orchestration contract and must
// never be mislabeled as WebDriver-backed merely because this source test runs
// on a macOS CI host.
const fixturePlatform = process.platform === "win32" ? "windows-installed" : "linux-installed";
const children = new Set<ChildProcess>();
try {
  const passedInput = await orchestrationInput("pass");
  passedInput.requireProviderRouteBatch = true;
  passedInput.requireHealthEvidence = true;
  const passed = await withReleaseSurfaceWebDriverOrchestration(passedInput, async (_session, context) => {
    const app = await launchFixtureApplication();
    context.bindApplication({
      processId: app.pid!,
      executableNodePath: process.execPath,
      executableLaunchPath: process.execPath,
    });
    const boundEvidence = writeBoundCandidateEvidence("pass", app.pid!, context);
    const attestationPath = boundEvidence.candidatePath;
    context.bindCandidateAttestation(attestationPath);
    const runManifestPath = boundEvidence.manifestPath;
    context.bindDriverRunManifest(runManifestPath);
    const providerRouteBatchPath = writeEvidence("pass-provider-routes.json", { schema: "fixture-provider-routes", routes: 20 });
    context.bindProviderRouteBatch(providerRouteBatchPath);
    context.bindHealthEvidence(writeEvidence("pass-health.json", { schema: "fixture-health", status: "pass" }));
    context.bindScenarioReport(writeEvidence("pass-scenario.json", { schema: "fixture-scenario", status: "pass" }));
    return "completed";
  });
  assert.equal(passed.value, "completed");
  assert.equal(passed.receipt.status, "pass");
  assert.equal(passed.receipt.executionWindow, "immediately-before-publish");
  assert.equal(passed.receipt.workCompleted, true);
  assert.equal(passed.receipt.application.bound, true);
  assert.match(passed.receipt.application.executableSha256 ?? "", /^[a-f0-9]{64}$/);
  assert.equal(passed.receipt.webdriverLifecycle?.status, "pass");
  assert.equal(passed.receipt.profileCleanup?.status, "pass");
  assert.equal(passed.receipt.candidateTeardown?.status, "pass");
  assert.equal(passed.receipt.candidateAttestation?.basename, "pass-candidate.json");
  assert.equal(passed.receipt.driverRunManifest?.basename, "pass-run-manifest.json");
  assert.equal(passed.receipt.candidateTeardown?.basename, "pass-candidate-teardown.json");
  assert.equal(passed.receipt.providerRouteBatch?.basename, "pass-provider-routes.json");
  assert.equal(passed.receipt.healthEvidence?.basename, "pass-health.json");
  assert.equal(passed.receipt.scenarioReport?.basename, "pass-scenario.json");
  assert.equal(existsSync(passedInput.profileNodePath), false);
  assert.equal(JSON.stringify(passed.receipt).includes("fixture-pass-session-0001"), false);
  assert.deepEqual(JSON.parse(readFileSync(passedInput.orchestrationEvidencePath, "utf8")), passed.receipt);
  assertShutdownAudit("pass", { sessionCreated: true, sessionDeleted: true, signal: "SIGTERM" });

  const targetedInput = await orchestrationInput("targeted");
  targetedInput.targetedClosure = true;
  const targeted = await withReleaseSurfaceWebDriverOrchestration(targetedInput, async (_session, context) => {
    const app = await launchFixtureApplication();
    context.bindApplication({
      processId: app.pid!,
      executableNodePath: process.execPath,
      executableLaunchPath: process.execPath,
    });
    const boundEvidence = writeBoundCandidateEvidence("targeted", app.pid!, context);
    const targetedManifest = JSON.parse(readFileSync(boundEvidence.manifestPath, "utf8"));
    targetedManifest.targetedClosure = { driverIds: ["ui-control-bounded-installed"] };
    writeFileSync(boundEvidence.manifestPath, `${JSON.stringify(targetedManifest, null, 2)}\n`);
    context.bindCandidateAttestation(boundEvidence.candidatePath);
    context.bindDriverRunManifest(boundEvidence.manifestPath);
    return "targeted-completed";
  });
  assert.equal(targeted.value, "targeted-completed");
  assert.equal(targeted.receipt.executionWindow, "targeted-post-matrix");
  assert.equal(targeted.receipt.providerRouteBatch, undefined);
  assert.equal(targeted.receipt.healthEvidence, undefined);
  assert.equal(targeted.receipt.scenarioReport, undefined);
  assert.equal(targeted.receipt.candidateTeardown?.status, "pass");

  const callbackInput = await orchestrationInput("callback-failure");
  const callbackError = await expectFailure(callbackInput, async (_session, context) => {
    const app = await launchFixtureApplication();
    context.bindApplication({
      processId: app.pid!,
      executableNodePath: process.execPath,
      executableLaunchPath: process.execPath,
    });
    context.bindCandidateAttestation(writeEvidence("callback-candidate.json", { schema: "fixture-candidate" }));
    throw new Error("driver callback failed after candidate attestation");
  });
  assert.match(callbackError.receipt.error ?? "", /driver callback failed/);
  assert.equal(callbackError.receipt.application.bound, true);
  assert.equal(callbackError.receipt.candidateAttestation?.basename, "callback-candidate.json");
  assert.equal(callbackError.receipt.driverRunManifest, undefined);
  assert.equal(callbackError.receipt.webdriverLifecycle?.status, "failed");
  assert.equal(callbackError.receipt.profileCleanup?.status, "pass");
  assert.equal(existsSync(callbackInput.profileNodePath), false);

  const unboundInput = await orchestrationInput("unbound");
  const unboundError = await expectFailure(unboundInput, async (_session, context) => {
    context.bindCandidateAttestation(writeEvidence("unbound-candidate.json", { schema: "fixture-candidate" }));
    context.bindDriverRunManifest(writeEvidence("unbound-run.json", { schema: "fixture-run" }));
    return "missing application binding";
  });
  assert.match(unboundError.receipt.error ?? "", /without binding the candidate application PID/);
  assert.equal(unboundError.receipt.profileCleanup?.status, "pass");
  assert.equal(existsSync(unboundInput.profileNodePath), false);

  const missingRoutesInput = await orchestrationInput("missing-routes");
  missingRoutesInput.requireProviderRouteBatch = true;
  const missingRoutesError = await expectFailure(missingRoutesInput, async (_session, context) => {
    const app = await launchFixtureApplication();
    context.bindApplication({
      processId: app.pid!,
      executableNodePath: process.execPath,
      executableLaunchPath: process.execPath,
    });
    context.bindCandidateAttestation(writeEvidence("missing-routes-candidate.json", { schema: "fixture-candidate" }));
    context.bindDriverRunManifest(writeEvidence("missing-routes-run.json", { schema: "fixture-run" }));
    return "missing route batch";
  });
  assert.match(missingRoutesError.receipt.error ?? "", /without binding the required provider route batch/);

  const missingHealthInput = await orchestrationInput("missing-health");
  missingHealthInput.requireHealthEvidence = true;
  const missingHealthError = await expectFailure(missingHealthInput, async (_session, context) => {
    const app = await launchFixtureApplication();
    context.bindApplication({
      processId: app.pid!,
      executableNodePath: process.execPath,
      executableLaunchPath: process.execPath,
    });
    context.bindCandidateAttestation(writeEvidence("missing-health-candidate.json", { schema: "fixture-candidate" }));
    context.bindDriverRunManifest(writeEvidence("missing-health-run.json", { schema: "fixture-run" }));
    return "missing health evidence";
  });
  assert.match(missingHealthError.receipt.error ?? "", /without binding required health and scenario evidence/);

  const startupInput = await orchestrationInput("startup-failure", ["--exit-before-ready"]);
  const startupError = await expectFailure(startupInput, async () => "never");
  assert.match(startupError.receipt.error ?? "", /exited before readiness/);
  assert.equal(startupError.receipt.application.bound, false);
  assert.equal(startupError.receipt.webdriverLifecycle?.status, "failed");
  assert.equal(startupError.receipt.profileCleanup?.status, "pass");
  assert.equal(existsSync(startupInput.profileNodePath), false);

  const occupiedInput = await orchestrationInput("occupied");
  writeFileSync(occupiedInput.orchestrationEvidencePath, "occupied", "utf8");
  await assert.rejects(
    withReleaseSurfaceWebDriverOrchestration(occupiedInput, async () => "never"),
    /orchestration evidence already exists/,
  );
  assert.equal(existsSync(occupiedInput.profileNodePath), false, "evidence refusal happens before profile creation");

  const collidingInput = await orchestrationInput("port-collision");
  collidingInput.debugPort = collidingInput.lifecycle.driverPort;
  await assert.rejects(
    withReleaseSurfaceWebDriverOrchestration(collidingInput, async () => "never"),
    /ports must all be distinct/,
  );
  assert.equal(existsSync(collidingInput.profileNodePath), false);

  const cliSource = readFileSync(
    resolve(root, "scripts/run-release-surface-webdriver-candidate.ts"),
    "utf8",
  );
  assert.match(cliSource, /withReleaseSurfaceWebDriverOrchestration/);
  assert.match(cliSource, /create-release-surface-candidate-attestation\.ts/);
  assert.match(cliSource, /context\.bindApplication/);
  assert.match(cliSource, /context\.bindCandidateAttestation/);
  assert.match(cliSource, /runReleaseSurfaceDrivers/);
  assert.match(cliSource, /context\.bindDriverRunManifest/);
  assert.match(cliSource, /collectReleaseSurfaceProviderRouteBatch/);
  assert.match(cliSource, /context\.bindProviderRouteBatch/);
  assert.match(cliSource, /startReleaseSurfaceHealthCollector/);
  assert.match(cliSource, /context\.registerSessionDeleteObserver/);
  assert.match(cliSource, /context\.bindHealthEvidence/);
  assert.match(cliSource, /context\.bindScenarioReport/);
  assert.match(cliSource, /frozen-candidate orchestration requires a clean source checkout/);
  assert.doesNotMatch(cliSource, /--webdriver-session/, "the orchestrator owns one live session instead of accepting a stale session file");

  const createOnlyParent = join(temp, "create-only-evidence");
  const createOnlyDriverOutput = join(createOnlyParent, "drivers");
  const separateProfile = join(temp, "create-only-profile");
  mkdirSync(createOnlyParent);
  validateCreateOnlyEvidenceDirectory({
    outputDir: createOnlyDriverOutput,
    profilePath: separateProfile,
    label: "release driver output",
  });
  mkdirSync(createOnlyDriverOutput);
  assert.throws(
    () => validateCreateOnlyEvidenceDirectory({
      outputDir: createOnlyDriverOutput,
      profilePath: separateProfile,
      label: "release driver output",
    }),
    /release driver output already exists/,
  );
  mkdirSync(separateProfile);
  assert.throws(
    () => validateCreateOnlyEvidenceDirectory({
      outputDir: join(separateProfile, "drivers"),
      profilePath: separateProfile,
      label: "release driver output",
    }),
    /release driver output must be outside the disposable profile/,
  );

  console.log("Release surface WebDriver orchestration tests passed");
} finally {
  for (const child of children) child.kill("SIGKILL");
  rmSync(temp, { recursive: true, force: true });
}

async function expectFailure<T>(
  input: ReleaseSurfaceWebDriverOrchestrationInput,
  work: Parameters<typeof withReleaseSurfaceWebDriverOrchestration<T>>[1],
): Promise<ReleaseSurfaceWebDriverOrchestrationError> {
  try {
    await withReleaseSurfaceWebDriverOrchestration(input, work);
    assert.fail("orchestration was expected to fail");
  } catch (error) {
    assert(error instanceof ReleaseSurfaceWebDriverOrchestrationError);
    assert.equal(error.receipt.status, "failed");
    assert.deepEqual(JSON.parse(readFileSync(input.orchestrationEvidencePath, "utf8")), error.receipt);
    return error;
  }
}

async function orchestrationInput(
  name: string,
  fixtureArgs: string[] = [],
): Promise<ReleaseSurfaceWebDriverOrchestrationInput> {
  const ports = await distinctPorts();
  const runId = Buffer.from(name).toString("hex").padEnd(16, "0").slice(0, 16);
  const profilePath = join(temp, `shellx-final-webdriver-${runId}`);
  return {
    platform: fixturePlatform,
    runId,
    profileNodePath: profilePath,
    profileLaunchPath: profilePath,
    debugPort: ports.debugPort,
    mcpPort: ports.mcpPort,
    lifecycle: {
      tauriDriverCommand: process.execPath,
      tauriDriverNodePath: process.execPath,
      tauriDriverArgsPrefix: [
        "--import", tsxImport, fixturePath,
        "--audit-out", join(temp, `${name}-audit.json`),
        "--expected-application", process.execPath,
        "--expected-working-directory", profilePath,
        "--session-id", `fixture-${name}-session-0001`,
        ...fixtureArgs,
      ],
      applicationLaunchPath: process.execPath,
      applicationNodePath: process.execPath,
      driverPort: ports.driverPort,
      nativePort: ports.nativePort,
      evidencePath: join(temp, `${name}-lifecycle.json`),
      startupTimeoutMs: 2_000,
      shutdownTimeoutMs: 2_000,
    },
    profileCleanupEvidencePath: join(temp, `${name}-profile-cleanup.json`),
    candidateTeardownEvidencePath: join(temp, `${name}-candidate-teardown.json`),
    orchestrationEvidencePath: join(temp, `${name}-orchestration.json`),
  };
}

async function launchFixtureApplication(): Promise<ChildProcess> {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  children.add(child);
  child.once("exit", () => children.delete(child));
  if (!child.pid) throw new Error("fixture application did not return a PID");
  await new Promise<void>((resolveSpawn, reject) => {
    child.once("spawn", resolveSpawn);
    child.once("error", reject);
  });
  return child;
}

function writeEvidence(name: string, value: unknown): string {
  const path = join(temp, name);
  writeFileSync(path, `${JSON.stringify(value)}\n`, { encoding: "utf8", flag: "wx" });
  return path;
}

function writeBoundCandidateEvidence(
  name: string,
  processId: number,
  context: ReleaseSurfaceWebDriverOrchestrationContext,
): { candidatePath: string; manifestPath: string } {
  const sourceCommit = "a".repeat(40);
  const executable = identifyFile(process.execPath);
  const candidatePath = writeEvidence(`${name}-candidate.json`, {
    schema: RELEASE_SURFACE_CANDIDATE_ATTESTATION_SCHEMA,
    mode: "final-frozen-candidate",
    platform: fixturePlatform,
    sourceCommit,
    version: "0.3.5",
    createdAt: new Date().toISOString(),
    distributionArtifact: executable,
    installation: {
      method: "direct-artifact",
      sourceArtifactSha256: executable.sha256,
      receipt: { basename: "installation.json", sha256: "b".repeat(64), bytes: 100 },
      payloadManifestSha256: "c".repeat(64),
    },
    installedPayload: { ...executable, path: process.execPath },
    process: { pid: processId, executablePath: process.execPath, executableSha256: executable.sha256 },
    runtime: {
      debugBase: context.profile.debugBase,
      debugPort: context.profile.debugPort,
      debugTokenPath: context.profile.debugTokenLaunchPath,
      mcpBase: context.profile.mcpBase,
      mcpPort: context.profile.mcpPort,
      mcpTokenPath: context.profile.mcpTokenLaunchPath,
      processId,
      instanceId: `shellx-final-${context.profile.runId}`,
      appVersion: "0.3.5",
      buildCommit: sourceCommit,
    },
  });
  const candidateIdentity = identifyFile(candidatePath);
  const manifestPath = writeEvidence(`${name}-run-manifest.json`, {
    schema: RELEASE_SURFACE_DRIVER_RUN_SCHEMA,
    mode: "final-frozen-candidate",
    platform: fixturePlatform,
    sourceCommit,
    version: "0.3.5",
    inventoryDigest: "d".repeat(64),
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    artifact: executable,
    candidateAttestation: candidateIdentity,
    candidateVerification: {
      processId,
      instanceId: `shellx-final-${context.profile.runId}`,
      debugBase: context.profile.debugBase,
      mcpBase: context.profile.mcpBase,
      buildCommit: sourceCommit,
    },
  });
  return { candidatePath, manifestPath };
}

function identifyFile(path: string): { basename: string; sha256: string; bytes: number } {
  const bytes = readFileSync(path);
  return {
    basename: basename(path),
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.length,
  };
}

function readAudit(name: string): unknown {
  return JSON.parse(readFileSync(join(temp, `${name}-audit.json`), "utf8"));
}

function assertShutdownAudit(name: string, expected: unknown): void {
  const path = join(temp, `${name}-audit.json`);
  if (process.platform === "win32") {
    assert.equal(
      existsSync(path),
      false,
      "Windows process termination must not be represented as a delivered POSIX signal",
    );
    return;
  }
  assert.deepEqual(readAudit(name), expected);
}

async function distinctPorts(): Promise<{
  driverPort: number;
  nativePort: number;
  debugPort: number;
  mcpPort: number;
}> {
  const servers = Array.from({ length: 4 }, () => createServer());
  const ports: number[] = [];
  try {
    for (const server of servers) {
      await new Promise<void>((resolveListen, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolveListen);
      });
      const address = server.address();
      assert(address && typeof address === "object");
      ports.push(address.port);
    }
  } finally {
    await Promise.all(servers.map((server) => new Promise<void>((resolveClose, reject) => {
      server.close((error) => error ? reject(error) : resolveClose());
    })));
  }
  return { driverPort: ports[0]!, nativePort: ports[1]!, debugPort: ports[2]!, mcpPort: ports[3]! };
}
