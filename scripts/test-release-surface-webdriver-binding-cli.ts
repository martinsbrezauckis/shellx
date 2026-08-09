import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ReleaseSurfaceCandidateAttestation } from "./lib/release-surface-candidate-attestation";
import {
  validateReleaseSurfaceWebDriverBinding,
  type ReleaseSurfaceWebDriverBindingEvidence,
} from "./lib/release-surface-webdriver-binding";

const root = resolve(import.meta.dirname, "..");
const temp = mkdtempSync(join(tmpdir(), "shellx-webdriver-binding-cli-"));
const tokenPath = join(temp, "debug.token");
const statePath = join(temp, "servers.json");
const candidatePath = join(temp, "candidate.json");
const outputPath = join(temp, "binding.json");
const sessionId = "binding-session-0001";
const token = "fixture-debug-token-that-is-long-enough";
let server: ChildProcess | null = null;
try {
  writeFileSync(tokenPath, token, { encoding: "utf8", mode: 0o600 });
  server = spawn(process.execPath, [
    "--import", "tsx", resolve(root, "scripts/fixtures/release-surface-webdriver-binding-server-fixture.ts"),
    "--token-file", tokenPath,
    "--state-out", statePath,
    "--session-id", sessionId,
    "--instance-id", "fixture-instance-0001",
    "--process-id", "4321",
    "--version", "0.3.5",
    "--source-commit", "b".repeat(40),
  ], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  const ports = await waitForPorts(statePath, server);
  const candidate = candidateFixture(tokenPath, ports.candidatePort);
  writeFileSync(candidatePath, `${JSON.stringify(candidate, null, 2)}\n`, "utf8");
  const webdriverBase = `http://127.0.0.1:${ports.webdriverPort}`;
  const result = spawnSync(process.execPath, [
    "--import", "tsx", resolve(root, "scripts/prove-release-surface-webdriver-binding.ts"),
    "--candidate-attestation", candidatePath,
    "--webdriver-base", webdriverBase,
    "--session-id", sessionId,
    "--out", outputPath,
  ], { cwd: root, encoding: "utf8", timeout: 10_000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const evidence = JSON.parse(readFileSync(outputPath, "utf8")) as ReleaseSurfaceWebDriverBindingEvidence;
  assert.deepEqual(validateReleaseSurfaceWebDriverBinding({
    evidence,
    candidate,
    session: { base: webdriverBase, sessionId },
  }), []);
  assert.equal(evidence.challenge.webdriverObservedLabel, true);
  assert.equal(evidence.challenge.webdriverObservedCleared, true);

  const overwrite = spawnSync(process.execPath, [
    "--import", "tsx", resolve(root, "scripts/prove-release-surface-webdriver-binding.ts"),
    "--candidate-attestation", candidatePath,
    "--webdriver-base", webdriverBase,
    "--session-id", sessionId,
    "--out", outputPath,
  ], { cwd: root, encoding: "utf8", timeout: 10_000 });
  assert.notEqual(overwrite.status, 0, "binding evidence must never overwrite an existing receipt");
  console.log("Release surface WebDriver binding CLI tests passed");
} finally {
  server?.kill("SIGTERM");
  rmSync(temp, { recursive: true, force: true });
}

async function waitForPorts(path: string, child: ChildProcess): Promise<{
  candidatePort: number;
  webdriverPort: number;
}> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`binding fixture exited early with ${child.exitCode}`);
    }
    if (existsSync(path)) {
      return JSON.parse(readFileSync(path, "utf8")) as {
        candidatePort: number;
        webdriverPort: number;
      };
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
  throw new Error("binding fixture did not publish its ports");
}

function candidateFixture(tokenFile: string, port: number): ReleaseSurfaceCandidateAttestation {
  return {
    schema: "shellx/release-surface-candidate-attestation@5",
    mode: "final-frozen-candidate",
    platform: "linux-installed",
    sourceCommit: "b".repeat(40),
    version: "0.3.5",
    createdAt: new Date().toISOString(),
    distributionArtifact: { basename: "shellx", sha256: "a".repeat(64), bytes: 100 },
    installation: {
      method: "direct-artifact",
      sourceArtifactSha256: "a".repeat(64),
      receipt: { basename: "installation.json", sha256: "c".repeat(64), bytes: 200 },
      payloadManifestSha256: "d".repeat(64),
    },
    installedPayload: { basename: "shellx", sha256: "a".repeat(64), bytes: 100, path: "/tmp/shellx" },
    process: { pid: 4321, executablePath: "/tmp/shellx", executableSha256: "a".repeat(64) },
    runtime: {
      debugBase: `http://127.0.0.1:${port}`,
      debugPort: port,
      debugTokenPath: tokenFile,
      mcpBase: "http://127.0.0.1:9",
      mcpPort: 9,
      mcpTokenPath: tokenFile,
      processId: 4321,
      instanceId: "fixture-instance-0001",
      appVersion: "0.3.5",
      buildCommit: "b".repeat(40),
    },
  };
}
