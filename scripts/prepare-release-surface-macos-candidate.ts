import { createHash } from "node:crypto";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { ReleaseSurfaceFileIdentity } from "./lib/release-surface-candidate-attestation";
import {
  cleanupReleaseSurfaceRunProfile,
  prepareReleaseSurfaceRunProfile,
  type ReleaseSurfaceRunProfile,
} from "./lib/release-surface-run-profile";
import { releaseSurfaceControllerNodeArguments } from "./lib/release-surface-controller-binding";
import { resolveReleaseSurfaceControllerProvenance } from "./lib/release-surface-driver-runner";
import { releaseSurfaceMacosNativeInputFileIdentity } from "./lib/release-surface-macos-native-input";

export const RELEASE_SURFACE_MACOS_CANDIDATE_PREPARATION_SCHEMA =
  "shellx/release-surface-macos-candidate-preparation@2";

if (process.platform !== "darwin") {
  throw new Error("macOS candidate preparation must run on the native Mac candidate host");
}

const root = resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const targetedClosure = readArgs(args, "--driver-id")
  .flatMap((value) => value.split(","))
  .some((value) => value.trim().length > 0);
requireFinalWindow(args);
const runId = requiredArg(args, "--run-id");
const artifactPath = regularFile(requiredArg(args, "--artifact"), "distribution artifact");
const installationReceiptPath = regularFile(
  requiredArg(args, "--installation-receipt"),
  "installation receipt",
);
const applicationPath = realpathSync(regularFile(requiredArg(args, "--application"), "installed application"));
const profilePath = createOnlyDirectoryPath(requiredArg(args, "--profile"), "release profile");
const candidatePath = createOnlyFilePath(
  requiredArg(args, "--candidate-attestation-out"),
  "candidate attestation output",
);
const helperPath = absentPath(requiredArg(args, "--helper-out"), "native-input helper output");
const preparationPath = createOnlyFilePath(requiredArg(args, "--preparation-out"), "preparation output");
const debugPort = requiredPort(args, "--debug-port");
const mcpPort = requiredPort(args, "--mcp-port");
if (!/^[a-f0-9]{16,64}$/.test(runId)) throw new Error("release run id must be 16 to 64 lowercase hexadecimal characters");
if (debugPort === mcpPort) throw new Error("macOS release Debug API and MCP ports must be distinct");
if (basename(profilePath) !== `shellx-final-webdriver-${runId}`) {
  throw new Error("macOS release profile must use the exact run-id name");
}
if (dirname(helperPath) !== profilePath || basename(helperPath) !== "shellx-release-macos-native-input") {
  throw new Error("macOS native-input helper must use the exact path inside the disposable release profile");
}
if (candidatePath === preparationPath) {
  throw new Error("macOS candidate attestation and preparation outputs must differ");
}
for (const output of [candidatePath, preparationPath]) {
  const fromProfile = relative(profilePath, output);
  if (fromProfile === "" || (!fromProfile.startsWith("..") && !isAbsolute(fromProfile))) {
    throw new Error("durable macOS candidate evidence must remain outside the disposable profile");
  }
}

const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" });
if (dirty.trim()) throw new Error("macOS candidate preparation requires a clean frozen source checkout");
const controllerSourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const candidateSourceCommitArg = readArg(args, "--candidate-source-commit");
if (candidateSourceCommitArg && !targetedClosure) {
  throw new Error("--candidate-source-commit is valid only for targeted post-matrix closure");
}
const sourceCommit = candidateSourceCommitArg ?? controllerSourceCommit;
resolveReleaseSurfaceControllerProvenance({
  rootDir: root,
  candidateSourceCommit: sourceCommit,
  controllerSourceCommit,
  targetedClosure,
});
const version = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string }).version;
let profile: ReleaseSurfaceRunProfile | null = null;
let processId: number | null = null;
let completed = false;

try {
  profile = prepareReleaseSurfaceRunProfile({
    platform: "macos-installed",
    runId,
    nodePath: profilePath,
    launchPath: profilePath,
    debugPort,
    mcpPort,
    baseEnvironment: process.env,
  });
  const helper = spawnSync(process.execPath, releaseSurfaceControllerNodeArguments(
    resolve(root, "scripts/build-release-surface-macos-native-input.ts"), [
      "--out", helperPath,
    ],
  ), { cwd: root, encoding: "utf8", timeout: 120_000, maxBuffer: 1024 * 1024 });
  if (helper.status !== 0) {
    throw new Error(`macOS native-input helper build failed: ${(helper.stderr || helper.stdout).trim()}`);
  }
  const child = spawn(applicationPath, [], {
    cwd: dirname(applicationPath),
    env: profile.environment,
    detached: true,
    stdio: "ignore",
  });
  if (!child.pid) throw new Error("macOS installed candidate did not return a process id");
  processId = child.pid;
  child.unref();
  await waitForCandidateRuntime({
    profile,
    processId,
    sourceCommit,
    version,
  });
  const activation = activateMacosCandidateApplication(processId);
  await delay(250);
  const attestation = spawnSync(process.execPath, releaseSurfaceControllerNodeArguments(
    resolve(root, "scripts/create-release-surface-candidate-attestation.ts"), [
      "--platform", "macos-installed",
      "--artifact", artifactPath,
      "--installed-payload", applicationPath,
      "--installation-receipt", installationReceiptPath,
      "--candidate-source-commit", sourceCommit,
      "--pid", String(processId),
      "--debug-base", profile.debugBase,
      "--debug-token-file", profile.debugTokenLaunchPath,
      "--mcp-base", profile.mcpBase,
      "--mcp-token-file", profile.mcpTokenLaunchPath,
      "--out", candidatePath,
    ],
  ), { cwd: root, encoding: "utf8", timeout: 60_000, maxBuffer: 1024 * 1024 });
  if (attestation.status !== 0) {
    throw new Error(`macOS candidate attestation failed: ${(attestation.stderr || attestation.stdout).trim()}`);
  }
  const preparation = {
    schema: RELEASE_SURFACE_MACOS_CANDIDATE_PREPARATION_SCHEMA,
    mode: "final-frozen-candidate",
    status: "pass",
    platform: "macos-installed",
    runId,
    sourceCommit,
    version,
    createdAt: new Date().toISOString(),
    candidateAttestation: fileIdentity(candidatePath),
    helper: releaseSurfaceMacosNativeInputFileIdentity(helperPath),
    profileMarker: fileIdentity(profile.markerPath),
    activation,
    runtime: {
      processId,
      debugPort,
      mcpPort,
      profilePathSha256: sha256(profilePath),
    },
  } as const;
  writeFileSync(preparationPath, `${JSON.stringify(preparation, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  completed = true;
  console.log(`Prepared exact macOS candidate ${processId} and native-input helper: ${preparationPath}`);
  console.log(`Accessibility prerequisite helper: ${helperPath}`);
} finally {
  if (!completed && profile) {
    const failureCleanup = nextAvailableFailurePath(
      dirname(preparationPath),
      `macos-preparation-failure-cleanup-${runId}`,
    );
    await cleanupReleaseSurfaceRunProfile({
      profile,
      evidencePath: failureCleanup,
      ...(processId
        ? {
            application: {
              processId,
              executableNodePath: applicationPath,
              executableLaunchPath: applicationPath,
            },
          }
        : {}),
    }).catch(() => undefined);
  }
}

function activateMacosCandidateApplication(processId: number): {
  method: "system-events-frontmost-by-pid";
  processId: number;
  verified: true;
} {
  if (!Number.isSafeInteger(processId) || processId <= 0) {
    throw new Error("macOS candidate activation requires a positive process id");
  }
  const script = [
    'tell application "System Events"',
    `set candidateProcess to first process whose unix id is ${processId}`,
    "set frontmost of candidateProcess to true",
    "return frontmost of candidateProcess",
    "end tell",
  ];
  const result = spawnSync(
    "/usr/bin/osascript",
    script.flatMap((line) => ["-e", line]),
    { encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024 },
  );
  if (result.status !== 0 || result.stdout.trim() !== "true") {
    throw new Error(
      `macOS could not activate the exact candidate process: ${
        (result.stderr || result.stdout || result.error?.message || "activation was refused").trim()
      }`,
    );
  }
  return { method: "system-events-frontmost-by-pid", processId, verified: true };
}

async function waitForCandidateRuntime(input: {
  profile: ReleaseSurfaceRunProfile;
  processId: number;
  sourceCommit: string;
  version: string;
}): Promise<void> {
  const deadline = Date.now() + 30_000;
  let lastError = "candidate runtime is not ready";
  while (Date.now() < deadline) {
    try {
      const token = readPrivateToken(input.profile.debugTokenNodePath);
      readPrivateToken(input.profile.mcpTokenNodePath);
      const response = await fetch(`${input.profile.debugBase}/health`, {
        signal: AbortSignal.timeout(1_500),
      });
      if (!response.ok) throw new Error(`/health returned ${response.status}`);
      const health = await response.json() as Record<string, unknown>;
      if (Number(health.processId) !== input.processId
        || health.instanceId !== `shellx-final-${input.profile.runId}`
        || health.appVersion !== input.version
        || health.buildCommit !== input.sourceCommit
        || Number(health.debugApiPort) !== input.profile.debugPort) {
        throw new Error("candidate /health identity drifted from the prepared profile");
      }
      const protectedResponse = await fetch(`${input.profile.debugBase}/browser/state`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(1_500),
      });
      await protectedResponse.body?.cancel();
      if (!protectedResponse.ok) throw new Error(`/browser/state returned ${protectedResponse.status}`);
      return;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      await delay(100);
    }
  }
  throw new Error(`macOS installed candidate did not become attestable: ${lastError}`);
}

function readPrivateToken(path: string): string {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("candidate token must be a regular non-link file");
  const token = readFileSync(path, "utf8").trim();
  if (token.length < 32) throw new Error("candidate token is invalid");
  return token;
}

function fileIdentity(path: string): ReleaseSurfaceFileIdentity {
  const contents = readFileSync(path);
  return { basename: basename(path), sha256: sha256(contents), bytes: contents.length };
}

function createOnlyDirectoryPath(path: string, label: string): string {
  const absolute = resolve(path);
  if (existsSync(absolute)) throw new Error(`${label} already exists`);
  const parent = lstatSync(dirname(absolute));
  if (parent.isSymbolicLink() || !parent.isDirectory()) {
    throw new Error(`${label} parent must be a regular non-link directory`);
  }
  return absolute;
}

function createOnlyFilePath(path: string, label: string): string {
  const absolute = resolve(path);
  if (existsSync(absolute)) throw new Error(`${label} already exists`);
  const parent = lstatSync(dirname(absolute));
  if (parent.isSymbolicLink() || !parent.isDirectory()) {
    throw new Error(`${label} parent must be a regular non-link directory`);
  }
  return absolute;
}

function absentPath(path: string, label: string): string {
  const absolute = resolve(path);
  if (existsSync(absolute)) throw new Error(`${label} already exists`);
  return absolute;
}

function nextAvailableFailurePath(parent: string, stem: string): string {
  for (let index = 1; index <= 1_000; index += 1) {
    const candidate = join(parent, `${stem}-${index}.json`);
    if (!existsSync(candidate)) return candidate;
  }
  throw new Error(`unable to allocate bounded failure evidence path for ${stem}`);
}

function regularFile(path: string, label: string): string {
  const absolute = resolve(path);
  const stat = lstatSync(absolute);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size <= 0) {
    throw new Error(`${label} must be a non-empty regular non-link file`);
  }
  return absolute;
}

function requireFinalWindow(values: string[]): void {
  const targetedClosure = readArgs(values, "--driver-id")
    .flatMap((value) => value.split(","))
    .some((value) => value.trim().length > 0);
  const expectedExecutionWindow = targetedClosure
    ? "targeted-post-matrix"
    : "immediately-before-publish";
  if (readArg(values, "--candidate-stage") !== "signed-and-frozen"
    || readArg(values, "--execution-window") !== expectedExecutionWindow) {
    throw new Error(
      targetedClosure
        ? "refusing targeted execution: pass --candidate-stage signed-and-frozen "
          + "--execution-window targeted-post-matrix with one or more --driver-id values"
        : "refusing routine execution: pass --candidate-stage signed-and-frozen "
          + "--execution-window immediately-before-publish for the final candidate only",
    );
  }
}

function requiredPort(values: string[], name: string): number {
  const value = Number(requiredArg(values, name));
  if (!Number.isSafeInteger(value) || value <= 0 || value > 65_535) {
    throw new Error(`${name} must be a valid TCP port`);
  }
  return value;
}

function requiredArg(values: string[], name: string): string {
  const value = readArg(values, name)?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function readArg(values: string[], name: string): string | undefined {
  const index = values.indexOf(name);
  if (index >= 0) return values[index + 1];
  return values.find((value) => value.startsWith(`${name}=`))?.slice(name.length + 1);
}

function readArgs(values: string[], name: string): string[] {
  const prefix = `${name}=`;
  return values.flatMap((value, index) => {
    if (value === name) return values[index + 1] ? [values[index + 1]!] : [];
    return value.startsWith(prefix) ? [value.slice(prefix.length)] : [];
  });
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
