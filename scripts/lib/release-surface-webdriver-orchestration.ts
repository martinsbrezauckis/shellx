import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, relative, resolve, sep } from "node:path";
import {
  prepareReleaseSurfaceRunProfile,
  cleanupReleaseSurfaceRunProfile,
  type ReleaseSurfaceRunProfile,
  type ReleaseSurfaceRunProfileCleanupReceipt,
} from "./release-surface-run-profile";
import {
  ReleaseSurfaceWebDriverLifecycleError,
  withReleaseSurfaceWebDriverSession,
  type ReleaseSurfaceWebDriverLifecycleInput,
  type ReleaseSurfaceWebDriverLifecycleReceipt,
  type ReleaseSurfaceWebDriverSessionDeleteObserver,
} from "./release-surface-webdriver-lifecycle";
import type { ReleaseSurfaceFileIdentity } from "./release-surface-candidate-attestation";
import { loadReleaseSurfaceCandidateAttestation } from "./release-surface-candidate-attestation";
import {
  createReleaseSurfaceCandidateTeardownReceipt,
  type ReleaseSurfaceCandidateTeardownReceipt,
} from "./release-surface-candidate-teardown";
import type { ReleaseSurfaceDriverRunManifest } from "./release-surface-driver-runner";
import type { ReleaseSurfaceWebDriverSession } from "./release-surface-webdriver-binding";

export const RELEASE_SURFACE_WEBDRIVER_ORCHESTRATION_SCHEMA =
  "shellx/release-surface-webdriver-orchestration@5";

type Platform = ReleaseSurfaceRunProfile["platform"];
type BoundApplication = { processId: number; executableNodePath: string; executableLaunchPath: string };

export interface ReleaseSurfaceWebDriverOrchestrationReceipt {
  schema: typeof RELEASE_SURFACE_WEBDRIVER_ORCHESTRATION_SCHEMA;
  mode: "final-frozen-candidate";
  executionWindow: "immediately-before-publish" | "targeted-post-matrix";
  status: "pass" | "failed";
  platform: Platform;
  runId: string;
  startedAt: string;
  completedAt: string;
  workCompleted: boolean;
  application: {
    bound: boolean;
    processId?: number;
    executableSha256?: string;
  };
  candidateAttestation?: ReleaseSurfaceFileIdentity;
  driverRunManifest?: ReleaseSurfaceFileIdentity;
  providerRouteBatch?: ReleaseSurfaceFileIdentity;
  healthEvidence?: ReleaseSurfaceFileIdentity;
  scenarioReport?: ReleaseSurfaceFileIdentity;
  webdriverLifecycle?: ReleaseSurfaceFileIdentity & {
    status: ReleaseSurfaceWebDriverLifecycleReceipt["status"];
  };
  profileCleanup?: ReleaseSurfaceFileIdentity & {
    status: ReleaseSurfaceRunProfileCleanupReceipt["status"];
  };
  candidateTeardown?: ReleaseSurfaceFileIdentity & {
    status: ReleaseSurfaceCandidateTeardownReceipt["status"];
  };
  error?: string;
}

export interface ReleaseSurfaceWebDriverOrchestrationInput {
  platform: Platform;
  runId: string;
  profileNodePath: string;
  profileLaunchPath: string;
  debugPort: number;
  mcpPort: number;
  lifecycle: Omit<ReleaseSurfaceWebDriverLifecycleInput, "environment" | "workingDirectory">;
  profileCleanupEvidencePath: string;
  candidateTeardownEvidencePath: string;
  orchestrationEvidencePath: string;
  requireProviderRouteBatch?: boolean;
  requireHealthEvidence?: boolean;
  targetedClosure?: boolean;
}

export interface ReleaseSurfaceWebDriverOrchestrationContext {
  profile: ReleaseSurfaceRunProfile;
  signal: AbortSignal;
  driverProcessId: number;
  bindApplication(value: BoundApplication): void;
  bindCandidateAttestation(path: string): void;
  bindDriverRunManifest(path: string): void;
  bindProviderRouteBatch(path: string): void;
  bindHealthEvidence(path: string): void;
  bindScenarioReport(path: string): void;
  registerSessionDeleteObserver(observer: ReleaseSurfaceWebDriverSessionDeleteObserver): void;
}

export class ReleaseSurfaceWebDriverOrchestrationError extends Error {
  constructor(message: string, readonly receipt: ReleaseSurfaceWebDriverOrchestrationReceipt) {
    super(message);
    this.name = "ReleaseSurfaceWebDriverOrchestrationError";
  }
}

export async function withReleaseSurfaceWebDriverOrchestration<T>(
  input: ReleaseSurfaceWebDriverOrchestrationInput,
  work: (session: ReleaseSurfaceWebDriverSession, context: ReleaseSurfaceWebDriverOrchestrationContext) => Promise<T>,
): Promise<{ value: T; receipt: ReleaseSurfaceWebDriverOrchestrationReceipt }> {
  validateCreateOnlyEvidence(input.orchestrationEvidencePath, "orchestration evidence");
  validateCreateOnlyEvidence(input.lifecycle.evidencePath, "WebDriver lifecycle evidence");
  validateCreateOnlyEvidence(input.profileCleanupEvidencePath, "profile cleanup evidence");
  validateCreateOnlyEvidence(input.candidateTeardownEvidencePath, "candidate teardown evidence");
  requireDistinctEvidencePaths([
    input.orchestrationEvidencePath,
    input.lifecycle.evidencePath,
    input.profileCleanupEvidencePath,
    input.candidateTeardownEvidencePath,
  ]);
  if (new Set([
    input.debugPort,
    input.mcpPort,
    input.lifecycle.driverPort,
    input.lifecycle.nativePort,
  ]).size !== 4) {
    throw new Error("Debug API, MCP, WebDriver, and native-driver ports must all be distinct");
  }
  const startedAt = new Date().toISOString();
  const profile = prepareReleaseSurfaceRunProfile({
    platform: input.platform,
    runId: input.runId,
    nodePath: input.profileNodePath,
    launchPath: input.profileLaunchPath,
    debugPort: input.debugPort,
    mcpPort: input.mcpPort,
  });
  for (const path of [
    input.orchestrationEvidencePath,
    input.lifecycle.evidencePath,
    input.profileCleanupEvidencePath,
    input.candidateTeardownEvidencePath,
  ]) {
    requireOutsideProfile(profile.nodePath, path, "orchestration evidence");
  }

  let application: BoundApplication | null = null;
  let candidateAttestationPath: string | null = null;
  let driverRunManifestPath: string | null = null;
  let providerRouteBatchPath: string | null = null;
  let healthEvidencePath: string | null = null;
  let scenarioReportPath: string | null = null;
  let lifecycleReceipt: ReleaseSurfaceWebDriverLifecycleReceipt | null = null;
  let cleanupReceipt: ReleaseSurfaceRunProfileCleanupReceipt | null = null;
  let candidateTeardownReceipt: ReleaseSurfaceCandidateTeardownReceipt | null = null;
  let value: T | undefined;
  let workCompleted = false;
  let primaryError: unknown = null;
  try {
    const lifecycleResult = await withReleaseSurfaceWebDriverSession(
      {
        ...input.lifecycle,
        environment: profile.environment,
        workingDirectory: profile.nodePath,
      },
      async (session, lifecycleContext) => {
        value = await work(session, {
          profile,
          signal: lifecycleContext.signal,
          driverProcessId: lifecycleContext.driverProcessId,
          bindApplication: (binding) => {
            if (application) throw new Error("candidate application may be bound only once");
            validateApplicationBinding(binding, input.lifecycle);
            application = binding;
          },
          bindCandidateAttestation: (path) => {
            if (candidateAttestationPath) throw new Error("candidate attestation may be bound only once");
            candidateAttestationPath = requireEvidenceFileOutsideProfile(profile.nodePath, path, "candidate attestation");
          },
          bindDriverRunManifest: (path) => {
            if (driverRunManifestPath) throw new Error("driver run manifest may be bound only once");
            driverRunManifestPath = requireEvidenceFileOutsideProfile(profile.nodePath, path, "driver run manifest");
          },
          bindProviderRouteBatch: (path) => {
            if (providerRouteBatchPath) throw new Error("provider route batch may be bound only once");
            providerRouteBatchPath = requireEvidenceFileOutsideProfile(profile.nodePath, path, "provider route batch");
          },
          bindHealthEvidence: (path) => {
            if (healthEvidencePath) throw new Error("health evidence may be bound only once");
            healthEvidencePath = requireEvidenceFileOutsideProfile(profile.nodePath, path, "health evidence");
          },
          bindScenarioReport: (path) => {
            if (scenarioReportPath) throw new Error("scenario report may be bound only once");
            scenarioReportPath = requireEvidenceFileOutsideProfile(profile.nodePath, path, "scenario report");
          },
          registerSessionDeleteObserver: lifecycleContext.registerSessionDeleteObserver,
        });
        if (!application) throw new Error("orchestration work completed without binding the candidate application PID");
        if (!candidateAttestationPath) throw new Error("orchestration work completed without binding candidate attestation evidence");
        if (!driverRunManifestPath) throw new Error("orchestration work completed without binding the driver run manifest");
        if (input.requireProviderRouteBatch && !providerRouteBatchPath) {
          throw new Error("orchestration work completed without binding the required provider route batch");
        }
        workCompleted = true;
        return value;
      },
    );
    lifecycleReceipt = lifecycleResult.receipt;
    if (input.requireHealthEvidence && (!healthEvidencePath || !scenarioReportPath)) {
      primaryError = combineErrors(primaryError, "orchestration completed without binding required health and scenario evidence");
    }
  } catch (error) {
    primaryError = error;
    if (error instanceof ReleaseSurfaceWebDriverLifecycleError) lifecycleReceipt = error.receipt;
  }

  try {
    cleanupReceipt = await cleanupReleaseSurfaceRunProfile({
      profile,
      evidencePath: input.profileCleanupEvidencePath,
      ...(application ? { application } : {}),
      ...(input.lifecycle.nativeDriverLaunchPath
        ? { nativeDriver: {
            executableLaunchPath: input.lifecycle.nativeDriverLaunchPath,
            nativePort: input.lifecycle.nativePort,
          } }
        : {}),
    });
  } catch (error) {
    if (error && typeof error === "object" && "receipt" in error) {
      cleanupReceipt = (error as { receipt: ReleaseSurfaceRunProfileCleanupReceipt }).receipt;
    }
    primaryError = combineErrors(primaryError, `profile cleanup failed: ${errorMessage(error)}`);
  }

  if (candidateAttestationPath && driverRunManifestPath && lifecycleReceipt && cleanupReceipt) {
    try {
      const candidateAttestationIdentity = identifyRegularFile(candidateAttestationPath, "candidate attestation");
      const driverRunManifestIdentity = identifyRegularFile(driverRunManifestPath, "driver run manifest");
      const webdriverLifecycleIdentity = identifyRegularFile(input.lifecycle.evidencePath, "WebDriver lifecycle evidence");
      const profileCleanupIdentity = identifyRegularFile(input.profileCleanupEvidencePath, "profile cleanup evidence");
      candidateTeardownReceipt = createReleaseSurfaceCandidateTeardownReceipt({
        platform: input.platform,
        runId: input.runId,
        candidateAttestation: loadReleaseSurfaceCandidateAttestation(candidateAttestationPath),
        candidateAttestationIdentity,
        driverRunManifest: JSON.parse(readFileSync(driverRunManifestPath, "utf8")) as ReleaseSurfaceDriverRunManifest,
        driverRunManifestIdentity,
        webdriverLifecycle: lifecycleReceipt,
        webdriverLifecycleIdentity,
        profileCleanup: cleanupReceipt,
        profileCleanupIdentity,
      });
      writeFileSync(
        resolve(input.candidateTeardownEvidencePath),
        `${JSON.stringify(candidateTeardownReceipt, null, 2)}\n`,
        { encoding: "utf8", flag: "wx", mode: 0o600 },
      );
    } catch (error) {
      primaryError = combineErrors(primaryError, `candidate teardown evidence failed: ${errorMessage(error)}`);
    }
  } else if (workCompleted) {
    primaryError = combineErrors(primaryError, "candidate teardown evidence is missing required bound inputs");
  }

  const boundApplication = application as BoundApplication | null;
  const boundEvidencePaths = [
    candidateAttestationPath,
    driverRunManifestPath,
    providerRouteBatchPath,
    healthEvidencePath,
    scenarioReportPath,
  ] as Array<string | null>;
  requireDistinctEvidencePaths([
    input.orchestrationEvidencePath,
    input.lifecycle.evidencePath,
    input.profileCleanupEvidencePath,
    input.candidateTeardownEvidencePath,
    ...boundEvidencePaths.filter((path): path is string => Boolean(path)),
  ]);
  const receipt: ReleaseSurfaceWebDriverOrchestrationReceipt = {
    schema: RELEASE_SURFACE_WEBDRIVER_ORCHESTRATION_SCHEMA,
    mode: "final-frozen-candidate",
    executionWindow: input.targetedClosure
      ? "targeted-post-matrix"
      : "immediately-before-publish",
    status: primaryError ? "failed" : "pass",
    platform: input.platform,
    runId: input.runId,
    startedAt,
    completedAt: new Date().toISOString(),
    workCompleted,
    application: {
      bound: Boolean(boundApplication),
      ...(boundApplication ? {
        processId: boundApplication.processId,
        executableSha256: identifyRegularFile(boundApplication.executableNodePath, "candidate executable").sha256,
      } : {}),
    },
    ...(candidateAttestationPath
      ? { candidateAttestation: identifyRegularFile(candidateAttestationPath, "candidate attestation") }
      : {}),
    ...(driverRunManifestPath
      ? { driverRunManifest: identifyRegularFile(driverRunManifestPath, "driver run manifest") }
      : {}),
    ...(providerRouteBatchPath
      ? { providerRouteBatch: identifyRegularFile(providerRouteBatchPath, "provider route batch") }
      : {}),
    ...(healthEvidencePath
      ? { healthEvidence: identifyRegularFile(healthEvidencePath, "health evidence") }
      : {}),
    ...(scenarioReportPath
      ? { scenarioReport: identifyRegularFile(scenarioReportPath, "scenario report") }
      : {}),
    ...(lifecycleReceipt
      ? { webdriverLifecycle: {
          ...identifyRegularFile(input.lifecycle.evidencePath, "WebDriver lifecycle evidence"),
          status: lifecycleReceipt.status,
        } }
      : {}),
    ...(cleanupReceipt
      ? { profileCleanup: {
          ...identifyRegularFile(input.profileCleanupEvidencePath, "profile cleanup evidence"),
          status: cleanupReceipt.status,
        } }
      : {}),
    ...(candidateTeardownReceipt
      ? { candidateTeardown: {
          ...identifyRegularFile(input.candidateTeardownEvidencePath, "candidate teardown evidence"),
          status: candidateTeardownReceipt.status,
        } }
      : {}),
    ...(primaryError ? { error: redactError(primaryError) } : {}),
  };
  writeFileSync(resolve(input.orchestrationEvidencePath), `${JSON.stringify(receipt, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  if (primaryError) throw new ReleaseSurfaceWebDriverOrchestrationError(errorMessage(primaryError), receipt);
  return { value: value as T, receipt };
}

function validateApplicationBinding(
  binding: BoundApplication,
  lifecycle: ReleaseSurfaceWebDriverOrchestrationInput["lifecycle"],
): void {
  if (!Number.isSafeInteger(binding.processId) || binding.processId <= 0) {
    throw new Error("candidate application binding requires a positive PID");
  }
  if (resolve(binding.executableNodePath) !== resolve(lifecycle.applicationNodePath ?? lifecycle.applicationLaunchPath)) {
    throw new Error("candidate application binding node path does not match the measured lifecycle application");
  }
  if (binding.executableLaunchPath !== lifecycle.applicationLaunchPath) {
    throw new Error("candidate application binding launch path does not match the WebDriver application");
  }
  identifyRegularFile(binding.executableNodePath, "candidate executable");
}

function validateCreateOnlyEvidence(path: string, label: string): void {
  const absolute = resolve(path);
  const parent = lstatSync(dirname(absolute));
  if (parent.isSymbolicLink() || !parent.isDirectory()) throw new Error(`${label} parent must be a regular non-link directory`);
  if (existsSync(absolute)) throw new Error(`${label} already exists: ${absolute}`);
}

function requireDistinctEvidencePaths(paths: string[]): void {
  const distinct = new Set(paths.map((path) => resolve(path)));
  if (distinct.size !== paths.length) throw new Error("all final orchestration evidence paths must be distinct");
}

function requireEvidenceFileOutsideProfile(profilePath: string, path: string, label: string): string {
  const absolute = resolve(path);
  requireOutsideProfile(profilePath, absolute, label);
  identifyRegularFile(absolute, label);
  return absolute;
}

function requireOutsideProfile(profilePath: string, path: string, label: string): void {
  const rel = relative(resolve(profilePath), resolve(path));
  if (!rel || rel === "." || (!rel.startsWith(`..${sep}`) && rel !== "..")) {
    throw new Error(`${label} must be outside the disposable profile`);
  }
}

function identifyRegularFile(path: string, label: string): ReleaseSurfaceFileIdentity {
  const absolute = resolve(path);
  const stat = lstatSync(absolute);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`${label} must be a regular non-link file`);
  const bytes = readFileSync(absolute);
  if (bytes.length === 0) throw new Error(`${label} must not be empty`);
  return {
    basename: basename(absolute),
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.length,
  };
}

function combineErrors(primary: unknown, detail: string): Error {
  return new Error(primary ? `${errorMessage(primary)}; ${detail}` : detail);
}

function redactError(error: unknown): string {
  return errorMessage(error)
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/(token|secret)(\s*[=:]\s*)[^\s;,]+/gi, "$1$2[redacted]")
    .slice(0, 4_096);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? "unknown error");
}
