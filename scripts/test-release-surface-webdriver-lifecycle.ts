import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  ReleaseSurfaceWebDriverLifecycleError,
  withReleaseSurfaceWebDriverSession,
  type ReleaseSurfaceWebDriverLifecycleInput,
  type ReleaseSurfaceWebDriverLifecycleReceipt,
} from "./lib/release-surface-webdriver-lifecycle";

const root = resolve(import.meta.dirname, "..");
const fixturePath = resolve(root, "scripts/fixtures/release-surface-webdriver-lifecycle-driver-fixture.ts");
const temp = mkdtempSync(join(tmpdir(), "shellx-webdriver-lifecycle-"));
const applicationPath = join(temp, "shellx-fixture");
writeFileSync(applicationPath, "exact installed application fixture", "utf8");

try {
  const observerCalls: string[] = [];
  const passed = await runLifecycle("pass", async (session, context) => {
    assert.equal(context.signal.aborted, false);
    assert(context.driverProcessId > 0);
    assert.equal(session.base.startsWith("http://127.0.0.1:"), true);
    context.registerSessionDeleteObserver({
      beforeSessionDelete: async (observedSession) => {
        assert.equal(observedSession, session);
        observerCalls.push("before");
      },
      afterSessionDelete: async (observation) => {
        assert.equal(observation.session, session);
        assert.equal(observation.status, "pass");
        assert(Date.parse(observation.completedAt) >= Date.parse(observation.requestedAt));
        observerCalls.push("after");
      },
    });
    return "completed";
  });
  assert.equal(passed.result.value, "completed");
  assert.equal(passed.result.receipt.status, "pass");
  assert.equal(passed.result.receipt.cleanup.sessionDeleted, "pass");
  assert.equal(passed.result.receipt.cleanup.driverStopped, "pass");
  assert(passed.result.receipt.cleanup.sessionDelete);
  assert(Date.parse(passed.result.receipt.cleanup.sessionDelete.completedAt)
    >= Date.parse(passed.result.receipt.cleanup.sessionDelete.requestedAt));
  assert.deepEqual(observerCalls, ["before", "after"]);
  assert.equal(passed.result.receipt.session.workCompleted, true);
  assert.equal(passed.result.receipt.driver.launchPath, process.execPath);
  assert.match(passed.result.receipt.driver.argsPrefixSha256, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(passed.result.receipt).includes(passed.sessionId), false, "raw session id must not enter evidence");
  assertShutdownAudit(passed.auditPath, {
    sessionCreated: true,
    sessionDeleted: true,
    signal: "SIGTERM",
  });
  assertProcessGone(passed.result.receipt.driver.processId);

  const delayedSession = await runLifecycle(
    "delayed-session-create",
    async () => "completed-after-launch",
    ["--session-delay-ms", "3100"],
  );
  assert.equal(delayedSession.result.value, "completed-after-launch");
  assert.equal(delayedSession.result.receipt.status, "pass");
  assert.equal(delayedSession.result.receipt.session.created, true);
  assert.equal(delayedSession.result.receipt.cleanup.sessionDeleted, "pass");
  assertProcessGone(delayedSession.result.receipt.driver.processId);

  const callbackFailure = await expectLifecycleFailure("callback-failure", async () => {
    throw new Error("fixture work failed");
  });
  assert.equal(callbackFailure.receipt.status, "failed");
  assert.equal(callbackFailure.receipt.session.workCompleted, false);
  assert.equal(callbackFailure.receipt.cleanup.sessionDeleted, "pass");
  assert.equal(callbackFailure.receipt.cleanup.driverStopped, "pass");
  assert.match(callbackFailure.receipt.error ?? "", /fixture work failed/);
  assertShutdownAudit(join(temp, "callback-failure-audit.json"), {
    sessionCreated: true,
    sessionDeleted: true,
    signal: "SIGTERM",
  });

  const deleteFailure = await expectLifecycleFailure("delete-failure", async () => "done", ["--delete-fails"]);
  assert.equal(deleteFailure.receipt.session.workCompleted, true);
  assert.equal(deleteFailure.receipt.cleanup.sessionDeleted, "fail");
  assert.equal(deleteFailure.receipt.cleanup.driverStopped, "pass");
  assert.match(deleteFailure.receipt.error ?? "", /session deletion failed/);
  assertShutdownAudit(join(temp, "delete-failure-audit.json"), {
    sessionCreated: true,
    sessionDeleted: false,
    signal: "SIGTERM",
  });

  const startupFailure = await expectLifecycleFailure(
    "startup-failure",
    async () => "never",
    ["--exit-before-ready", "--large-log"],
  );
  assert.equal(startupFailure.receipt.session.created, false);
  assert.equal(startupFailure.receipt.cleanup.sessionDeleted, "not-created");
  assert.equal(startupFailure.receipt.cleanup.driverStopped, "pass");
  assert.match(startupFailure.receipt.error ?? "", /exited before readiness/);
  assert.equal(
    JSON.stringify(startupFailure.receipt).includes("fixture-private-driver-log"),
    false,
    "raw tauri-driver output must be represented only by its bounded digest",
  );
  assert.match(startupFailure.receipt.driverLog.retainedSha256, /^[a-f0-9]{64}$/);
  assert.equal(startupFailure.receipt.driverLog.truncated, true);
  assert(startupFailure.receipt.driverLog.observedBytes > startupFailure.receipt.driverLog.retainedBytes);
  assert(startupFailure.receipt.driverLog.retainedBytes <= 64 * 1024);

  const existingEvidence = join(temp, "existing-evidence.json");
  writeFileSync(existingEvidence, "occupied", "utf8");
  const unusedAudit = join(temp, "existing-audit.json");
  const ports = await distinctPorts();
  await assert.rejects(
    withReleaseSurfaceWebDriverSession(
      lifecycleInput("existing", existingEvidence, unusedAudit, ports, []),
      async () => "never",
    ),
    /evidence already exists/,
  );
  assert.equal(existsSync(unusedAudit), false, "create-only evidence refusal must happen before driver launch");

  const observerFailure = await expectLifecycleFailure("observer-failure", async (_session, context) => {
    context.registerSessionDeleteObserver({
      beforeSessionDelete: async () => undefined,
      afterSessionDelete: async () => { throw new Error("fixture observer failed"); },
    });
    return "done";
  });
  assert.equal(observerFailure.receipt.cleanup.sessionDeleted, "pass");
  assert.equal(observerFailure.receipt.cleanup.driverStopped, "pass");
  assert.match(observerFailure.receipt.error ?? "", /after session deletion observer failed: fixture observer failed/);

  console.log("Release surface WebDriver lifecycle tests passed");
} finally {
  rmSync(temp, { recursive: true, force: true });
}

async function runLifecycle<T>(
  name: string,
  work: Parameters<typeof withReleaseSurfaceWebDriverSession<T>>[1],
  fixtureArgs: string[] = [],
): Promise<{ result: Awaited<ReturnType<typeof withReleaseSurfaceWebDriverSession<T>>>; auditPath: string; sessionId: string }> {
  const evidencePath = join(temp, `${name}-evidence.json`);
  const auditPath = join(temp, `${name}-audit.json`);
  const sessionId = `fixture-${name}-session-0001`;
  const ports = await distinctPorts();
  const result = await withReleaseSurfaceWebDriverSession(
    lifecycleInput(name, evidencePath, auditPath, ports, fixtureArgs, sessionId),
    work,
  );
  assert.deepEqual(JSON.parse(readFileSync(evidencePath, "utf8")), result.receipt);
  return { result, auditPath, sessionId };
}

async function expectLifecycleFailure<T>(
  name: string,
  work: Parameters<typeof withReleaseSurfaceWebDriverSession<T>>[1],
  fixtureArgs: string[] = [],
): Promise<ReleaseSurfaceWebDriverLifecycleError> {
  try {
    await runLifecycle(name, work, fixtureArgs);
    assert.fail("lifecycle was expected to fail");
  } catch (error) {
    assert(error instanceof ReleaseSurfaceWebDriverLifecycleError);
    const evidence = JSON.parse(readFileSync(join(temp, `${name}-evidence.json`), "utf8")) as ReleaseSurfaceWebDriverLifecycleReceipt;
    assert.deepEqual(evidence, error.receipt);
    assertProcessGone(error.receipt.driver.processId);
    return error;
  }
}

function lifecycleInput(
  name: string,
  evidencePath: string,
  auditPath: string,
  ports: { driverPort: number; nativePort: number },
  fixtureArgs: string[],
  sessionId = `fixture-${name}-session-0001`,
): ReleaseSurfaceWebDriverLifecycleInput {
  return {
    tauriDriverCommand: process.execPath,
    tauriDriverNodePath: process.execPath,
    tauriDriverArgsPrefix: [
      "--import", "tsx", fixturePath,
      "--audit-out", auditPath,
      "--expected-application", applicationPath,
      "--session-id", sessionId,
      ...fixtureArgs,
    ],
    applicationLaunchPath: applicationPath,
    applicationNodePath: applicationPath,
    driverPort: ports.driverPort,
    nativePort: ports.nativePort,
    evidencePath,
    startupTimeoutMs: 2_000,
    shutdownTimeoutMs: 2_000,
  };
}

async function distinctPorts(): Promise<{ driverPort: number; nativePort: number }> {
  const driverPort = await unusedPort();
  let nativePort = await unusedPort();
  while (nativePort === driverPort) nativePort = await unusedPort();
  return { driverPort, nativePort };
}

async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("unable to allocate fixture port");
  const port = address.port;
  await new Promise<void>((resolveClose, rejectClose) => server.close((error) => error ? rejectClose(error) : resolveClose()));
  return port;
}

function readAudit(path: string): { sessionCreated: boolean; sessionDeleted: boolean; signal: string } {
  return JSON.parse(readFileSync(path, "utf8")) as { sessionCreated: boolean; sessionDeleted: boolean; signal: string };
}

function assertShutdownAudit(
  path: string,
  expected: { sessionCreated: boolean; sessionDeleted: boolean; signal: "SIGTERM" },
): void {
  if (process.platform === "win32") {
    assert.equal(
      existsSync(path),
      false,
      "Windows process termination must not be represented as a delivered POSIX signal",
    );
    return;
  }
  assert.deepEqual(readAudit(path), expected);
}

function assertProcessGone(pid: number): void {
  assert.throws(() => process.kill(pid, 0), /ESRCH|no such process/i, `owned driver PID ${pid} must be gone`);
}
