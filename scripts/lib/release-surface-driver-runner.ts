import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import type { ReleasePlatform, ReleaseSurfaceInventory } from "./release-surface-inventory";
import {
  loadReleaseSurfaceCandidateAttestation,
  validateReleaseSurfaceCandidateAttestation,
  type ReleaseSurfaceFileIdentity,
} from "./release-surface-candidate-attestation";
import {
  loadReleaseSurfaceInstallationReceipt,
  validateReleaseSurfaceEvidenceTimeline,
  validateReleaseSurfaceInstallationReceipt,
} from "./release-surface-installation-receipt";
import type { FinalSurfaceContract } from "./release-surface-receipts";
import {
  loadReleaseSurfaceSignatureReceipt,
  validateReleaseSurfaceSignatureReceipt,
} from "./release-surface-signature-receipt";
import {
  driverReadyOnPlatform,
  describeReadyDriver,
  verifyFinalSurfaceDriverPlan,
  type FinalSurfaceDriverPlan,
} from "./release-surface-driver-plan";
import {
  RELEASE_SURFACE_DRIVER_REQUEST_SCHEMA,
  completionTimestamp,
  validateReleaseSurfaceDriverReport,
  releaseSurfaceDriverPhaseReportPassed,
  type ReleaseSurfaceDriverManifest,
  type ReleaseSurfaceDriverReport,
  type ReleaseSurfaceDriverRequest,
} from "./release-surface-driver-protocol";
import {
  validateReleaseSurfaceRuntimeProbe,
  type ReleaseSurfaceRuntimeProbe,
} from "./release-surface-runtime-candidate";
import {
  toReleaseSurfaceWindowsNativeBinding,
  type ReleaseSurfaceWindowsNativeBinding,
} from "./release-surface-windows-native-runtime";
import {
  toReleaseSurfacePosixNativeBinding,
  type ReleaseSurfacePosixNativeBinding,
} from "./release-surface-posix-native-runtime";
import {
  collectReleaseSurfaceInstalledPayloadManifestForPlatform,
  isReleaseSurfacePathInsideRoot,
  sameReleaseSurfaceInstalledPayloadManifest,
} from "./release-surface-installed-payload-manifest";
import {
  releaseSurfaceDriverRequiresNativeWebDriver,
  releaseSurfaceDriverSupportsMacosNativeInput,
  validateReleaseSurfaceWebDriverBinding,
  type ReleaseSurfaceWebDriverBindingEvidence,
  type ReleaseSurfaceWebDriverSession,
} from "./release-surface-webdriver-binding";
import {
  createReleaseSurfaceControllerBinding,
  releaseSurfaceControllerNodeArguments,
  verifyReleaseSurfaceControllerBinding,
  type ReleaseSurfaceControllerBinding,
} from "./release-surface-controller-binding";
import {
  validateReleaseSurfaceMacosNativeInputBinding,
  type ReleaseSurfaceMacosNativeInputBindingEvidence,
  type ReleaseSurfaceMacosNativeInputRequestBinding,
} from "./release-surface-macos-native-input";

export const RELEASE_SURFACE_DRIVER_RUN_SCHEMA = "shellx/release-surface-driver-run@7";
export const RELEASE_SURFACE_DRIVER_TIMEOUT_MS = 60 * 60_000;

export interface ReleaseSurfaceDriverRunInput {
  rootDir: string;
  plan: FinalSurfaceDriverPlan;
  inventory: ReleaseSurfaceInventory;
  contract: FinalSurfaceContract;
  platform: ReleasePlatform;
  sourceCommit: string;
  controllerSourceCommit?: string;
  version: string;
  artifactPath: string;
  signatureReceiptPath: string;
  candidateAttestationPath: string;
  installationReceiptPath: string;
  outputDir: string;
  selectedDriverIds?: string[];
  selectedSurfaceIds?: string[];
  nativeWebDriver?: ReleaseSurfaceWebDriverSession;
  macosNativeInput?: {
    helperPath: string;
    bindingReceiptPath: string;
  };
}

export interface ReleaseSurfaceDriverRunManifest {
  schema: typeof RELEASE_SURFACE_DRIVER_RUN_SCHEMA;
  mode: "final-frozen-candidate";
  targetedClosure?: {
    driverIds: string[];
    surfaceIds?: string[];
    controllerDelta?: ReleaseSurfaceTargetedControllerDelta;
  };
  platform: ReleasePlatform;
  sourceCommit: string;
  version: string;
  inventoryDigest: string;
  startedAt: string;
  completedAt: string;
  controller: ReleaseSurfaceControllerBinding;
  artifact: FileIdentity;
  signatureReceipt: FileIdentity;
  candidateAttestation: FileIdentity;
  installationReceipt: FileIdentity;
  candidateVerification: {
    installedPayloadSha256: string;
    installedManifestSha256: string;
    installedManifestBeforeCollectedAt: string;
    installedManifestAfterCollectedAt: string;
    processId: number;
    instanceId: string;
    debugBase: string;
    debugTokenPath: string;
    mcpBase: string;
    mcpTokenPath: string;
    buildCommit: string;
    windowsNative?: ReleaseSurfaceWindowsNativeBinding;
    posixNative?: ReleaseSurfacePosixNativeBinding;
  };
  signatureVerification: {
    status: "verified" | "digest-verified";
    checks: string[];
  };
  nativeWebDriverBinding?: FileIdentity;
  macosNativeInputBinding?: FileIdentity;
  driverReports: Array<FileIdentity & {
    driverId: string;
    outcomes: number;
    controller: ReleaseSurfaceControllerBinding;
    beforeProbe: FileIdentity;
    afterProbe: FileIdentity;
  }>;
}

export interface ReleaseSurfaceTargetedControllerDelta {
  candidateSourceCommit: string;
  controllerSourceCommit: string;
  changedPaths: string[];
  patchSha256: string;
}

type FileIdentity = ReleaseSurfaceFileIdentity;

export function releaseSurfaceDriverRunFailedDriverIds(
  manifest: ReleaseSurfaceDriverRunManifest,
  outputDir: string,
): string[] {
  const root = resolve(outputDir);
  return manifest.driverReports.flatMap((row) => {
    const reportPath = join(root, `${safeStem(row.driverId)}.report.json`);
    const identity = identifyRegularFile(reportPath, `driver ${row.driverId} report`);
    if (identity.basename !== row.basename || identity.sha256 !== row.sha256 || identity.bytes !== row.bytes) {
      throw new Error(`driver ${row.driverId} report identity drifted after the complete discovery run`);
    }
    const report = JSON.parse(readFileSync(reportPath, "utf8")) as ReleaseSurfaceDriverReport;
    return releaseSurfaceDriverPhaseReportPassed(report) ? [] : [row.driverId];
  });
}

export function resolveReleaseSurfaceDriverSelection(
  plan: FinalSurfaceDriverPlan,
  platform: ReleasePlatform,
  requestedDriverIds?: string[],
): string[] {
  const ready = plan.drivers
    .filter((driver) => driverReadyOnPlatform(driver, platform))
    .map((driver) => driver.id)
    .sort();
  if (requestedDriverIds === undefined) return ready;
  const requested = requestedDriverIds.map((id) => id.trim()).filter(Boolean);
  if (requested.length === 0) {
    throw new Error("targeted closure requires at least one non-empty driver id");
  }
  if (new Set(requested).size !== requested.length) {
    throw new Error("targeted closure driver ids must be unique");
  }
  const readySet = new Set(ready);
  const unknown = requested.filter((id) => !readySet.has(id));
  if (unknown.length > 0) {
    throw new Error(`targeted closure names unavailable ${platform} drivers: ${unknown.join(", ")}`);
  }
  return [...requested].sort();
}

export function resolveReleaseSurfaceControllerProvenance(input: {
  rootDir: string;
  candidateSourceCommit: string;
  controllerSourceCommit: string;
  targetedClosure: boolean;
}): {
  controllerSourceCommit: string;
  controllerDelta?: ReleaseSurfaceTargetedControllerDelta;
} {
  const root = resolve(input.rootDir);
  const candidateSourceCommit = input.candidateSourceCommit.trim().toLowerCase();
  const controllerSourceCommit = input.controllerSourceCommit.trim().toLowerCase();
  if (!/^[a-f0-9]{40,64}$/.test(candidateSourceCommit)
    || !/^[a-f0-9]{40,64}$/.test(controllerSourceCommit)) {
    throw new Error("release candidate and controller commits must be lowercase Git object ids");
  }
  const head = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  }).trim().toLowerCase();
  if (head !== controllerSourceCommit) {
    throw new Error("release controller source commit must match the exact clean checkout HEAD");
  }
  if (candidateSourceCommit === controllerSourceCommit) return { controllerSourceCommit };
  if (!input.targetedClosure) {
    throw new Error("only a targeted post-matrix closure may use a descendant controller commit");
  }
  const ancestor = spawnSync(
    "git",
    ["-C", root, "merge-base", "--is-ancestor", candidateSourceCommit, controllerSourceCommit],
    { encoding: "utf8" },
  );
  if (ancestor.status !== 0) {
    throw new Error("targeted controller commit must descend from the exact signed candidate commit");
  }
  const changedPaths = execFileSync(
    "git",
    ["-C", root, "diff", "--name-only", "--no-renames", "-z", `${candidateSourceCommit}..${controllerSourceCommit}`],
    { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
  ).split("\0").filter(Boolean);
  if (changedPaths.length === 0 || changedPaths.length > 256) {
    throw new Error("targeted controller delta must contain one to 256 changed files");
  }
  const deletedPaths = execFileSync(
    "git",
    ["-C", root, "diff", "--name-only", "--no-renames", "--diff-filter=D", "-z", `${candidateSourceCommit}..${controllerSourceCommit}`],
    { encoding: "utf8", maxBuffer: 1024 * 1024 },
  ).split("\0").filter(Boolean);
  if (deletedPaths.length > 0) {
    throw new Error(`targeted controller delta refuses deleted files: ${deletedPaths.slice(0, 5).join(", ")}`);
  }
  for (const path of changedPaths) {
    if (!path.startsWith("scripts/") || path.includes("\\") || /[\r\n\0]/.test(path)
      || path.split("/").some((part) => !part || part === "." || part === "..")) {
      throw new Error(`targeted controller delta is outside scripts/**: ${JSON.stringify(path)}`);
    }
    const stat = lstatSync(resolve(root, path));
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error(`targeted controller delta path must be a regular non-link file: ${path}`);
    }
  }
  const patch = execFileSync(
    "git",
    ["-C", root, "diff", "--binary", "--full-index", "--no-renames", `${candidateSourceCommit}..${controllerSourceCommit}`, "--", "scripts"],
    { maxBuffer: 32 * 1024 * 1024 },
  );
  return {
    controllerSourceCommit,
    controllerDelta: {
      candidateSourceCommit,
      controllerSourceCommit,
      changedPaths,
      patchSha256: createHash("sha256").update(patch).digest("hex"),
    },
  };
}

export function runReleaseSurfaceDrivers(input: ReleaseSurfaceDriverRunInput): ReleaseSurfaceDriverRunManifest {
  const root = resolve(input.rootDir);
  const outputDir = resolve(input.outputDir);
  const controllerProvenance = resolveReleaseSurfaceControllerProvenance({
    rootDir: root,
    candidateSourceCommit: input.sourceCommit,
    controllerSourceCommit: input.controllerSourceCommit ?? input.sourceCommit,
    targetedClosure: input.selectedDriverIds !== undefined || input.selectedSurfaceIds !== undefined,
  });
  const planVerification = verifyFinalSurfaceDriverPlan(input.plan, input.inventory, root);
  if (planVerification.status !== "ready") {
    throw new Error(
      `final surface driver plan is ${planVerification.status}; ready ${planVerification.counts.ready}`
      + `/${planVerification.counts.inventoryCells} platform cells, missing ${planVerification.counts.missing}`,
    );
  }
  const selectedDriverIds = resolveReleaseSurfaceDriverSelection(
    input.plan,
    input.platform,
    input.selectedDriverIds,
  );
  const selectedDriverIdSet = new Set(selectedDriverIds);
  const driverSurfaceIds = new Set(input.plan.assignments
    .filter((assignment) => selectedDriverIdSet.has(assignment.driverId))
    .map((assignment) => assignment.surfaceId));
  const requestedSurfaceIds = input.selectedSurfaceIds?.map((id) => id.trim()).filter(Boolean);
  if (requestedSurfaceIds && input.selectedDriverIds === undefined) {
    throw new Error("surface-level targeted closure requires one or more exact driver ids");
  }
  if (requestedSurfaceIds && requestedSurfaceIds.length === 0) {
    throw new Error("surface-level targeted closure requires at least one non-empty surface id");
  }
  if (requestedSurfaceIds && new Set(requestedSurfaceIds).size !== requestedSurfaceIds.length) {
    throw new Error("surface-level targeted closure surface ids must be unique");
  }
  const unavailableSurfaceIds = (requestedSurfaceIds ?? []).filter((id) => !driverSurfaceIds.has(id));
  if (unavailableSurfaceIds.length > 0) {
    throw new Error(`surface-level targeted closure names assignments outside the selected drivers: ${unavailableSurfaceIds.join(", ")}`);
  }
  const selectedSurfaceIds = new Set(requestedSurfaceIds ?? driverSurfaceIds);
  const applicable = input.inventory.items.filter((surface) =>
    surface.platforms.includes(input.platform) && selectedSurfaceIds.has(surface.id));
  if (input.selectedDriverIds !== undefined && applicable.length === 0) {
    throw new Error(`targeted closure drivers have no ${input.platform} inventory assignments`);
  }
  if (existsSync(outputDir)) throw new Error(`release driver output already exists: ${outputDir}`);

  const artifact = identifyRegularFile(input.artifactPath, "candidate artifact");
  const signatureReceipt = identifyRegularFile(input.signatureReceiptPath, "signature receipt");
  const candidateAttestation = identifyRegularFile(input.candidateAttestationPath, "candidate attestation");
  const installationReceipt = identifyRegularFile(input.installationReceiptPath, "installation receipt");
  const platformContract = input.contract.platforms[input.platform];
  if (!platformContract) throw new Error(`platform ${input.platform} is outside the final surface contract`);
  const parsedSignatureReceipt = loadReleaseSurfaceSignatureReceipt(input.signatureReceiptPath);
  const signatureErrors = validateReleaseSurfaceSignatureReceipt({
    receipt: parsedSignatureReceipt,
    platform: input.platform,
    sourceCommit: input.sourceCommit,
    version: input.version,
    artifact,
    expectedStatus: platformContract.signatureStatus,
    requiredChecks: platformContract.requiredSignatureChecks,
  });
  if (signatureErrors.length > 0) throw new Error(`candidate signature receipt is invalid: ${signatureErrors.join("; ")}`);
  const parsedCandidateAttestation = loadReleaseSurfaceCandidateAttestation(input.candidateAttestationPath);
  const candidateErrors = validateReleaseSurfaceCandidateAttestation({
    attestation: parsedCandidateAttestation,
    platform: input.platform,
    sourceCommit: input.sourceCommit,
    version: input.version,
    artifact,
    installationReceipt,
  });
  if (candidateErrors.length > 0) throw new Error(`candidate attestation is invalid: ${candidateErrors.join("; ")}`);
  const parsedInstallationReceipt = loadReleaseSurfaceInstallationReceipt(input.installationReceiptPath);
  const installationErrors = validateReleaseSurfaceInstallationReceipt({
    receipt: parsedInstallationReceipt,
    platform: input.platform,
    sourceCommit: input.sourceCommit,
    version: input.version,
    method: parsedCandidateAttestation.installation.method,
    artifact,
    installedPayload: parsedCandidateAttestation.installedPayload,
  });
  if (installationErrors.length > 0) throw new Error(`installation receipt is invalid: ${installationErrors.join("; ")}`);
  if (parsedInstallationReceipt.signatureReceipt
    && (parsedInstallationReceipt.signatureReceipt.basename !== signatureReceipt.basename
      || parsedInstallationReceipt.signatureReceipt.sha256 !== signatureReceipt.sha256
      || parsedInstallationReceipt.signatureReceipt.bytes !== signatureReceipt.bytes)) {
    throw new Error("installation receipt is not bound to the exact candidate signature receipt file");
  }
  if (parsedCandidateAttestation.installation.payloadManifestSha256
    !== parsedInstallationReceipt.payloadManifest.manifestSha256) {
    throw new Error("candidate attestation payload manifest digest does not match installation receipt");
  }
  const installedNodeRoot = nodeReadableInstalledPath(parsedInstallationReceipt.payloadManifest.rootPath, input.platform);
  const observedManifestBefore = collectReleaseSurfaceInstalledPayloadManifestForPlatform({
    nodeRootPath: installedNodeRoot,
    recordedRootPath: parsedInstallationReceipt.payloadManifest.rootPath,
    platform: input.platform,
    scope: parsedInstallationReceipt.payloadManifest.scope,
    mainExecutableRelativePath: parsedInstallationReceipt.payloadManifest.mainExecutableRelativePath,
  });
  if (!sameReleaseSurfaceInstalledPayloadManifest(parsedInstallationReceipt.payloadManifest, observedManifestBefore)) {
    throw new Error("installed payload manifest changed before the driver run");
  }
  if (isReleaseSurfacePathInsideRoot(installedNodeRoot, outputDir, input.platform)) {
    throw new Error("release driver output must be outside the installed payload root");
  }
  const runnerController = createReleaseSurfaceControllerBinding({
    rootDir: root,
    sourceCommit: controllerProvenance.controllerSourceCommit,
    entrypoint: relative(root, resolve(process.argv[1] ?? "")),
    auxiliaryFiles: [
      "scripts/lib/release-surface-driver-runner.ts",
      "scripts/probe-release-surface-runtime-candidate.ts",
      "scripts/prove-release-surface-webdriver-binding.ts",
      "scripts/prove-release-surface-macos-native-input-binding.ts",
      "scripts/lib/release-surface-macos-native-input.ts",
    ],
    requireClean: true,
  });
  // The payload collector may run across a host/WSL clock correction. Anchor
  // the run to the observation it causally follows instead of trusting that a
  // later wall-clock read is always greater.
  const startedAt = completionTimestamp(observedManifestBefore.collectedAt);
  const timelineErrors = validateReleaseSurfaceEvidenceTimeline({
    installationCreatedAt: parsedInstallationReceipt.createdAt,
    attestationCreatedAt: parsedCandidateAttestation.createdAt,
    runStartedAt: startedAt,
  });
  if (timelineErrors.length > 0) throw new Error(`candidate evidence timeline is invalid: ${timelineErrors.join("; ")}`);
  const inventoryById = new Map(input.inventory.items.map((surface) => [surface.id, surface]));
  const assignmentsByDriver = new Map<string, FinalSurfaceDriverPlan["assignments"]>();
  for (const assignment of input.plan.assignments) {
    if (!selectedSurfaceIds.has(assignment.surfaceId)) continue;
    const surface = inventoryById.get(assignment.surfaceId);
    if (!surface) throw new Error(`assignment names missing inventory surface ${assignment.surfaceId}`);
    if (!surface.platforms.includes(input.platform)) continue;
    const driver = input.plan.drivers.find((candidate) => candidate.id === assignment.driverId);
    if (!driver?.platforms[input.platform]) continue;
    const rows = assignmentsByDriver.get(assignment.driverId) ?? [];
    rows.push(assignment);
    assignmentsByDriver.set(assignment.driverId, rows);
  }

  const driverReports: ReleaseSurfaceDriverRunManifest["driverReports"] = [];
  const nativeDriverIds = new Set(input.plan.drivers
    .filter((driver) => selectedDriverIdSet.has(driver.id)
      && driverReadyOnPlatform(driver, input.platform)
      && releaseSurfaceDriverRequiresNativeWebDriver(driver.id, driver.kind, input.platform))
    .filter((driver) => (assignmentsByDriver.get(driver.id) ?? []).length > 0)
    .map((driver) => driver.id));
  if (input.nativeWebDriver && nativeDriverIds.size === 0) {
    throw new Error("native WebDriver session was supplied but no applicable ready native driver exists");
  }
  if (!input.nativeWebDriver && nativeDriverIds.size > 0) {
    throw new Error("ready native WebDriver drivers require a live same-process session");
  }
  const macosNativeInputDriverIds = new Set(input.plan.drivers
    .filter((driver) => selectedDriverIdSet.has(driver.id)
      && input.platform === "macos-installed"
      && driverReadyOnPlatform(driver, input.platform)
      && releaseSurfaceDriverSupportsMacosNativeInput(driver.id, driver.kind))
    .filter((driver) => (assignmentsByDriver.get(driver.id) ?? []).length > 0)
    .map((driver) => driver.id));
  if (input.macosNativeInput && macosNativeInputDriverIds.size === 0) {
    throw new Error("macOS native-input binding was supplied but no applicable ready native-input driver exists");
  }
  if (!input.macosNativeInput && macosNativeInputDriverIds.size > 0) {
    throw new Error("ready macOS native-input drivers require an exact operator-granted helper binding receipt");
  }
  mkdirSync(outputDir);
  const nativeWebDriverBinding = nativeDriverIds.size > 0
    ? proveNativeWebDriverBinding({
        root,
        outputDir,
        candidateAttestationPath: input.candidateAttestationPath,
        candidate: parsedCandidateAttestation,
        session: input.nativeWebDriver,
      })
    : undefined;
  const macosNativeInput = macosNativeInputDriverIds.size > 0
    ? proveMacosNativeInputBinding({
        outputDir,
        candidate: parsedCandidateAttestation,
        helperPath: input.macosNativeInput!.helperPath,
        bindingReceiptPath: input.macosNativeInput!.bindingReceiptPath,
      })
    : undefined;
  for (const driver of input.plan.drivers
    .filter((candidate) => selectedDriverIdSet.has(candidate.id)
      && driverReadyOnPlatform(candidate, input.platform))
    .sort((a, b) => a.id.localeCompare(b.id))) {
    const assignments = assignmentsByDriver.get(driver.id) ?? [];
    if (assignments.length === 0) continue;
    const described = describeReadyDriver(root, driver);
    if (typeof described === "string") throw new Error(described);
    const controller = createReleaseSurfaceControllerBinding({
      rootDir: root,
      sourceCommit: controllerProvenance.controllerSourceCommit,
      entrypoint: driver.entrypoint,
      auxiliaryFiles: described.controllerFiles,
      requireClean: true,
    });
    const request: ReleaseSurfaceDriverRequest = {
      schema: RELEASE_SURFACE_DRIVER_REQUEST_SCHEMA,
      mode: "final-frozen-candidate",
      driverId: driver.id,
      driverKind: driver.kind,
      platform: input.platform,
      sourceCommit: input.sourceCommit,
      version: input.version,
      inventoryDigest: input.inventory.digest,
      artifact: { basename: artifact.basename, sha256: artifact.sha256 },
      controller,
      runtime: {
        processId: parsedCandidateAttestation.runtime.processId,
        instanceId: parsedCandidateAttestation.runtime.instanceId,
        debugBase: parsedCandidateAttestation.runtime.debugBase,
        debugTokenPath: parsedCandidateAttestation.runtime.debugTokenPath,
        mcpBase: parsedCandidateAttestation.runtime.mcpBase,
        mcpTokenPath: parsedCandidateAttestation.runtime.mcpTokenPath,
        executableSha256: parsedCandidateAttestation.process.executableSha256,
        installedPayloadPath: parsedCandidateAttestation.installedPayload.path,
        installedManifestSha256: parsedInstallationReceipt.payloadManifest.manifestSha256,
        ...(parsedCandidateAttestation.windowsNativeRuntime
          ? { windowsNative: toReleaseSurfaceWindowsNativeBinding(parsedCandidateAttestation.windowsNativeRuntime) }
          : {}),
        ...(parsedCandidateAttestation.posixNativeRuntime
          ? { posixNative: toReleaseSurfacePosixNativeBinding(parsedCandidateAttestation.posixNativeRuntime) }
          : {}),
      },
      ...(nativeDriverIds.has(driver.id)
        ? {
            nativeWebDriver: {
              ...input.nativeWebDriver!,
              evidence: nativeWebDriverBinding!,
            },
          }
        : {}),
      ...(macosNativeInputDriverIds.has(driver.id)
        ? { macosNativeInput: macosNativeInput!.request }
        : {}),
      assignments: assignments.map((assignment) => {
        const surface = inventoryById.get(assignment.surfaceId);
        if (!surface) throw new Error(`assignment names missing inventory surface ${assignment.surfaceId}`);
        return {
          surface,
          fixtureId: assignment.fixtureId,
          expectedEffect: assignment.expectedEffect,
          oracleId: assignment.oracleId,
          cleanupId: assignment.cleanupId,
        };
      }),
    };
    const stem = safeStem(driver.id);
    const requestPath = join(outputDir, `${stem}.request.json`);
    const reportPath = join(outputDir, `${stem}.report.json`);
    const beforeProbePath = join(outputDir, `${stem}.runtime-before.json`);
    const afterProbePath = join(outputDir, `${stem}.runtime-after.json`);
    writeFileSync(requestPath, `${JSON.stringify(request, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    const beforeProbe = runRuntimeProbe(root, request, requestPath, beforeProbePath, "before-driver");
    const result = runReleaseSurfaceDriverProcess({
      rootDir: root,
      entrypoint: resolve(root, driver.entrypoint),
      request,
      requestPath,
      reportPath,
      maxAssignmentsPerProcess: described.maxAssignmentsPerProcess,
    });
    let afterProbe: FileIdentity | null = null;
    let afterProbeError: string | null = null;
    try {
      afterProbe = runRuntimeProbe(root, request, requestPath, afterProbePath, "after-driver");
    } catch (error) {
      afterProbeError = error instanceof Error ? error.message : String(error);
    }
    if (!afterProbe) throw new Error(`release driver ${driver.id} lost its attested runtime after execution: ${afterProbeError}`);
    if (!existsSync(reportPath)) {
      throw new Error(`release driver ${driver.id} failed without a durable report: ${(result.stderr || result.stdout).trim()}`);
    }
    const report = JSON.parse(readFileSync(reportPath, "utf8")) as ReleaseSurfaceDriverReport;
    const errors = validateReleaseSurfaceDriverReport(request, report);
    if (errors.length > 0) throw new Error(`release driver ${driver.id} returned invalid evidence: ${errors.join("; ")}`);
    const reportPassed = releaseSurfaceDriverPhaseReportPassed(report);
    if (result.status !== 0 && reportPassed) {
      throw new Error(
        `release driver ${driver.id} exited unsuccessfully despite a passing report: ${(result.stderr || result.stdout).trim()}`,
      );
    }
    const controllerAfterErrors = verifyReleaseSurfaceControllerBinding({
      rootDir: root,
      binding: controller,
      requireClean: true,
    });
    if (controllerAfterErrors.length > 0) {
      throw new Error(`release driver ${driver.id} controller changed during execution: ${controllerAfterErrors.join("; ")}`);
    }
    driverReports.push({
      driverId: driver.id,
      outcomes: report.outcomes.length,
      controller,
      beforeProbe,
      afterProbe,
      ...identifyRegularFile(reportPath, `driver ${driver.id} report`),
    });
  }

  const observedIds = new Set<string>();
  for (const report of driverReports) {
    const parsed = JSON.parse(readFileSync(join(outputDir, `${safeStem(report.driverId)}.report.json`), "utf8")) as ReleaseSurfaceDriverReport;
    for (const outcome of parsed.outcomes) {
      if (observedIds.has(outcome.id)) throw new Error(`surface ${outcome.id} was exercised by more than one driver`);
      observedIds.add(outcome.id);
    }
  }
  const missingIds = applicable.filter((surface) => !observedIds.has(surface.id)).map((surface) => surface.id);
  if (missingIds.length > 0) throw new Error(`driver reports omitted ${missingIds.length} surfaces; first: ${missingIds.slice(0, 5).join(", ")}`);
  const observedManifestAfter = collectReleaseSurfaceInstalledPayloadManifestForPlatform({
    nodeRootPath: installedNodeRoot,
    recordedRootPath: parsedInstallationReceipt.payloadManifest.rootPath,
    platform: input.platform,
    scope: parsedInstallationReceipt.payloadManifest.scope,
    mainExecutableRelativePath: parsedInstallationReceipt.payloadManifest.mainExecutableRelativePath,
  });
  if (!sameReleaseSurfaceInstalledPayloadManifest(parsedInstallationReceipt.payloadManifest, observedManifestAfter)) {
    throw new Error("installed payload manifest changed during the driver run");
  }
  const runnerControllerAfterErrors = verifyReleaseSurfaceControllerBinding({
    rootDir: root,
    binding: runnerController,
    requireClean: true,
  });
  if (runnerControllerAfterErrors.length > 0) {
    throw new Error(`release driver runner controller changed during execution: ${runnerControllerAfterErrors.join("; ")}`);
  }

  const manifest: ReleaseSurfaceDriverRunManifest = {
    schema: RELEASE_SURFACE_DRIVER_RUN_SCHEMA,
    mode: "final-frozen-candidate",
    ...(input.selectedDriverIds !== undefined || input.selectedSurfaceIds !== undefined
      ? { targetedClosure: {
        driverIds: selectedDriverIds,
        ...(requestedSurfaceIds ? { surfaceIds: [...requestedSurfaceIds].sort() } : {}),
        ...(controllerProvenance.controllerDelta
          ? { controllerDelta: controllerProvenance.controllerDelta }
          : {}),
      } }
      : {}),
    platform: input.platform,
    sourceCommit: input.sourceCommit,
    version: input.version,
    inventoryDigest: input.inventory.digest,
    startedAt,
    completedAt: completionTimestamp(
      startedAt,
      Math.max(Date.now(), Date.parse(observedManifestAfter.collectedAt)),
    ),
    controller: runnerController,
    artifact,
    signatureReceipt,
    candidateAttestation,
    installationReceipt,
    candidateVerification: {
      installedPayloadSha256: parsedCandidateAttestation.installedPayload.sha256,
      installedManifestSha256: parsedInstallationReceipt.payloadManifest.manifestSha256,
      installedManifestBeforeCollectedAt: observedManifestBefore.collectedAt,
      installedManifestAfterCollectedAt: observedManifestAfter.collectedAt,
      processId: parsedCandidateAttestation.runtime.processId,
      instanceId: parsedCandidateAttestation.runtime.instanceId,
      debugBase: parsedCandidateAttestation.runtime.debugBase,
      debugTokenPath: parsedCandidateAttestation.runtime.debugTokenPath,
      mcpBase: parsedCandidateAttestation.runtime.mcpBase,
      mcpTokenPath: parsedCandidateAttestation.runtime.mcpTokenPath,
      buildCommit: parsedCandidateAttestation.runtime.buildCommit,
      ...(parsedCandidateAttestation.windowsNativeRuntime
        ? { windowsNative: toReleaseSurfaceWindowsNativeBinding(parsedCandidateAttestation.windowsNativeRuntime) }
        : {}),
      ...(parsedCandidateAttestation.posixNativeRuntime
        ? { posixNative: toReleaseSurfacePosixNativeBinding(parsedCandidateAttestation.posixNativeRuntime) }
        : {}),
    },
    signatureVerification: {
      status: parsedSignatureReceipt.status,
      checks: parsedSignatureReceipt.checks.map((check) => check.id).sort(),
    },
    ...(nativeWebDriverBinding ? { nativeWebDriverBinding } : {}),
    ...(macosNativeInput ? { macosNativeInputBinding: macosNativeInput.evidence } : {}),
    driverReports,
  };
  writeFileSync(join(outputDir, "run-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  return manifest;
}

interface ReleaseSurfaceDriverProcessResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export function releaseSurfaceDriverAssignmentBatches<T>(
  assignments: readonly T[],
  maxAssignmentsPerProcess?: number,
): T[][] {
  if (maxAssignmentsPerProcess !== undefined
    && (!Number.isSafeInteger(maxAssignmentsPerProcess) || maxAssignmentsPerProcess < 1)) {
    throw new Error("release driver assignment process bound must be a positive safe integer");
  }
  if (maxAssignmentsPerProcess === undefined || assignments.length <= maxAssignmentsPerProcess) {
    return [[...assignments]];
  }
  const batches: T[][] = [];
  for (let index = 0; index < assignments.length; index += maxAssignmentsPerProcess) {
    batches.push(assignments.slice(index, index + maxAssignmentsPerProcess));
  }
  return batches;
}

function runReleaseSurfaceDriverProcess(input: {
  rootDir: string;
  entrypoint: string;
  request: ReleaseSurfaceDriverRequest;
  requestPath: string;
  reportPath: string;
  maxAssignmentsPerProcess?: ReleaseSurfaceDriverManifest["maxAssignmentsPerProcess"];
}): ReleaseSurfaceDriverProcessResult {
  const batches = releaseSurfaceDriverAssignmentBatches(
    input.request.assignments,
    input.maxAssignmentsPerProcess,
  );
  if (batches.length === 1) {
    return spawnSync(process.execPath, releaseSurfaceControllerNodeArguments(input.entrypoint, [
      "--request", input.requestPath,
      "--out", input.reportPath,
    ]), {
      cwd: input.rootDir,
      encoding: "utf8",
      timeout: RELEASE_SURFACE_DRIVER_TIMEOUT_MS,
      maxBuffer: 10 * 1024 * 1024,
    });
  }

  const reports: ReleaseSurfaceDriverReport[] = [];
  const errors: string[] = [];
  let combinedStdout = "";
  let combinedStderr = "";
  for (const [index, assignments] of batches.entries()) {
    const suffix = `.part-${index + 1}-of-${batches.length}`;
    const partRequestPath = input.requestPath.replace(/\.request\.json$/, `${suffix}.request.json`);
    const partReportPath = input.reportPath.replace(/\.report\.json$/, `${suffix}.report.json`);
    const partRequest: ReleaseSurfaceDriverRequest = { ...input.request, assignments };
    writeFileSync(partRequestPath, `${JSON.stringify(partRequest, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    const result = spawnSync(process.execPath, releaseSurfaceControllerNodeArguments(input.entrypoint, [
      "--request", partRequestPath,
      "--out", partReportPath,
    ]), {
      cwd: input.rootDir,
      encoding: "utf8",
      timeout: RELEASE_SURFACE_DRIVER_TIMEOUT_MS,
      maxBuffer: 10 * 1024 * 1024,
    });
    combinedStdout += result.stdout ?? "";
    combinedStderr += result.stderr ?? "";
    if (!existsSync(partReportPath)) {
      errors.push(`part ${index + 1}/${batches.length} returned no report: ${(result.stderr || result.stdout).trim()}`);
      continue;
    }
    const report = JSON.parse(readFileSync(partReportPath, "utf8")) as ReleaseSurfaceDriverReport;
    const reportErrors = validateReleaseSurfaceDriverReport(partRequest, report);
    if (reportErrors.length > 0) {
      errors.push(`part ${index + 1}/${batches.length} returned invalid evidence: ${reportErrors.join("; ")}`);
      continue;
    }
    if (result.status !== 0 && releaseSurfaceDriverPhaseReportPassed(report)) {
      errors.push(`part ${index + 1}/${batches.length} exited unsuccessfully despite a passing report`);
      continue;
    }
    reports.push(report);
  }
  if (errors.length > 0 || reports.length !== batches.length) {
    return {
      status: 1,
      stdout: combinedStdout,
      stderr: [...errors, combinedStderr.trim()].filter(Boolean).join("; "),
    };
  }

  const outcomes = new Map(reports.flatMap((report) => report.outcomes.map((outcome) => [outcome.id, outcome] as const)));
  if (outcomes.size !== input.request.assignments.length) {
    return {
      status: 1,
      stdout: combinedStdout,
      stderr: "partitioned release driver returned duplicate or missing surface outcomes",
    };
  }
  const combined: ReleaseSurfaceDriverReport = {
    ...reports[0]!,
    startedAt: reports.map((report) => report.startedAt).sort()[0]!,
    completedAt: reports.map((report) => report.completedAt).sort().at(-1)!,
    outcomes: input.request.assignments.map((assignment) => {
      const outcome = outcomes.get(assignment.surface.id);
      if (!outcome) throw new Error(`partitioned release driver omitted ${assignment.surface.id}`);
      return outcome;
    }),
  };
  writeFileSync(input.reportPath, `${JSON.stringify(combined, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  return {
    status: releaseSurfaceDriverPhaseReportPassed(combined) ? 0 : 1,
    stdout: combinedStdout,
    stderr: combinedStderr,
  };
}

function proveMacosNativeInputBinding(input: {
  outputDir: string;
  candidate: ReturnType<typeof loadReleaseSurfaceCandidateAttestation>;
  helperPath: string;
  bindingReceiptPath: string;
}): { evidence: FileIdentity; request: ReleaseSurfaceMacosNativeInputRequestBinding } {
  const sourceEvidence = identifyRegularFile(input.bindingReceiptPath, "macOS native-input binding evidence");
  const parsed = JSON.parse(readFileSync(resolve(input.bindingReceiptPath), "utf8")) as ReleaseSurfaceMacosNativeInputBindingEvidence;
  const errors = validateReleaseSurfaceMacosNativeInputBinding({
    evidence: parsed,
    candidate: input.candidate,
    helperPath: resolve(input.helperPath),
  });
  if (errors.length > 0) throw new Error(`macOS native-input binding evidence is invalid: ${errors.join("; ")}`);
  const outputPath = join(input.outputDir, "macos-native-input-binding.json");
  copyFileSync(resolve(input.bindingReceiptPath), outputPath, constants.COPYFILE_EXCL);
  const evidence = identifyRegularFile(outputPath, "copied macOS native-input binding evidence");
  if (JSON.stringify(evidence) !== JSON.stringify({ ...sourceEvidence, basename: evidence.basename })) {
    throw new Error("copied macOS native-input binding evidence changed bytes");
  }
  return {
    evidence,
    request: {
      helperPath: resolve(input.helperPath),
      expectedWindowTitle: "shellX",
      windowNumber: parsed.window.number,
      helper: parsed.helper,
      evidence,
    },
  };
}

function proveNativeWebDriverBinding(input: {
  root: string;
  outputDir: string;
  candidateAttestationPath: string;
  candidate: ReturnType<typeof loadReleaseSurfaceCandidateAttestation>;
  session: ReleaseSurfaceWebDriverSession | undefined;
}): FileIdentity {
  if (!input.session) throw new Error("ready native WebDriver drivers require a live same-process session");
  const outputPath = join(input.outputDir, "native-webdriver-binding.json");
  const result = spawnSync(process.execPath, releaseSurfaceControllerNodeArguments(
    resolve(input.root, "scripts/prove-release-surface-webdriver-binding.ts"), [
    "--candidate-attestation", resolve(input.candidateAttestationPath),
    "--webdriver-base", input.session.base,
    "--session-id", input.session.sessionId,
    "--out", outputPath,
  ]), { cwd: input.root, encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024 });
  if (result.status !== 0) {
    throw new Error(`native WebDriver same-process binding failed: ${(result.stderr || result.stdout).trim()}`);
  }
  const evidence = JSON.parse(readFileSync(outputPath, "utf8")) as ReleaseSurfaceWebDriverBindingEvidence;
  const errors = validateReleaseSurfaceWebDriverBinding({
    evidence,
    candidate: input.candidate,
    session: input.session,
  });
  if (errors.length > 0) throw new Error(`native WebDriver binding evidence is invalid: ${errors.join("; ")}`);
  return identifyRegularFile(outputPath, "native WebDriver binding evidence");
}

function runRuntimeProbe(
  root: string,
  request: ReleaseSurfaceDriverRequest,
  requestPath: string,
  outputPath: string,
  phase: ReleaseSurfaceRuntimeProbe["phase"],
): FileIdentity {
  const result = spawnSync(process.execPath, releaseSurfaceControllerNodeArguments(
    resolve(root, "scripts/probe-release-surface-runtime-candidate.ts"), [
    "--request", requestPath,
    "--phase", phase,
    "--out", outputPath,
  ]), { cwd: root, encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024 });
  if (result.status !== 0) {
    throw new Error(`${phase} runtime probe failed: ${(result.stderr || result.stdout).trim()}`);
  }
  const probe = JSON.parse(readFileSync(outputPath, "utf8")) as ReleaseSurfaceRuntimeProbe;
  const errors = validateReleaseSurfaceRuntimeProbe(probe, request, phase);
  if (errors.length > 0) throw new Error(`${phase} runtime probe is invalid: ${errors.join("; ")}`);
  return identifyRegularFile(outputPath, `${phase} runtime probe`);
}

function identifyRegularFile(path: string, label: string): FileIdentity {
  const absolute = resolve(path);
  const stat = lstatSync(absolute);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`${label} must be a regular non-symlink file: ${absolute}`);
  const bytes = readFileSync(absolute);
  if (bytes.length === 0) throw new Error(`${label} must not be empty: ${absolute}`);
  return {
    basename: basename(absolute),
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.length,
  };
}

function safeStem(value: string): string {
  const stem = value.replace(/[^a-zA-Z0-9_-]+/g, "-");
  if (!stem || stem !== value) throw new Error(`driver id is not safe for evidence filenames: ${value}`);
  return stem;
}

function nodeReadableInstalledPath(path: string, platform: ReleasePlatform): string {
  if (platform !== "windows-installed" || process.platform === "win32" || !/^[A-Za-z]:[\\/]/.test(path)) {
    return resolve(path);
  }
  const result = spawnSync("wslpath", ["-u", path], { encoding: "utf8" });
  if (result.status !== 0 || !result.stdout.trim()) throw new Error(`unable to map installed payload root ${path}`);
  return resolve(result.stdout.trim());
}
