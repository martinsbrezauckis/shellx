import { readFileSync } from "node:fs";
import type { ReleasePlatform, ReleaseSurfaceInventory } from "./release-surface-inventory";
import { assignmentCellKey, type FinalSurfaceDriverPlan } from "./release-surface-driver-plan";

export const FINAL_SURFACE_CONTRACT_SCHEMA = "shellx/final-surface-contract@4";
export const FINAL_SURFACE_RECEIPT_SCHEMA = "shellx/final-surface-receipt@4";

export interface FinalSurfaceRequiredProviderRoute {
  providerId: string;
  transportId: string;
}

export interface FinalSurfaceContract {
  schema: typeof FINAL_SURFACE_CONTRACT_SCHEMA;
  mode: "final-frozen-candidate";
  candidateStage: "signed-and-frozen";
  executionWindow: "immediately-before-publish";
  routineTestUsage: "forbidden";
  invalidatedBy: Array<"source-change" | "artifact-change" | "signature-change" | "inventory-change">;
  updater: {
    requiredPlatforms: Array<"windows-x86_64" | "darwin-aarch64" | "linux-x86_64">;
    requiredChecks: Array<
      | "artifact-minisign-verified-against-embedded-pubkey"
      | "all-required-platforms-present"
      | "release-url-version-bound"
    >;
  };
  platforms: Record<ReleasePlatform, {
    signatureStatus: "verified" | "digest-verified";
    requiredSignatureChecks: string[];
    requiredTransports: string[];
    requiredProviderRoutes: FinalSurfaceRequiredProviderRoute[];
    requiredLiveProviderRoutes: FinalSurfaceRequiredProviderRoute[];
  }>;
  requiredProviders: string[];
  providerRoutePolicy: "exact-identity-routes-with-minimal-live-canaries";
  requiredOutcomeVerdicts: Array<"present" | "invoke" | "effect" | "cleanup">;
  zeroSilentSkips: true;
  requireHealthyStartupAndShutdown: true;
  requireZeroBrokenLinks: true;
  requireZeroUnexpectedConsoleErrors: true;
}

export interface FinalSurfaceReceipt {
  schema: typeof FINAL_SURFACE_RECEIPT_SCHEMA;
  mode: "final-frozen-candidate";
  platform: ReleasePlatform;
  sourceCommit: string;
  version: string;
  inventoryDigest: string;
  startedAt: string;
  completedAt: string;
  artifact: {
    basename: string;
    sha256: string;
    signatureStatus: "verified" | "digest-verified";
  };
  evidenceArtifacts: Array<{
    id: string;
    relativePath: string;
    sha256: string;
    bytes: number;
  }>;
  transports: Array<{ id: string; status: "pass"; evidence: string }>;
  providers: Array<{ id: string; status: "pass"; version: string; evidence: string }>;
  providerRoutes: Array<{
    id: string;
    transportId: string;
    providerId: string;
    status: "pass";
    evidenceMode: "identity-only" | "live-canary";
    version: string;
    executableSha256: string;
    evidence: string;
  }>;
  health: {
    startup: "pass";
    shutdown: "pass";
    brokenLinks: number;
    unexpectedConsoleErrors: number;
    evidence: string;
  };
  outcomes: Array<{
    id: string;
    expectedEffect: string;
    oracleId: string;
    present: "pass";
    invoke: "pass";
    effect: "pass";
    cleanup: "pass";
    evidence: string;
    cleanupEvidence: string;
    observedEffect: string;
  }>;
}

export interface ReceiptFinding {
  ruleId: string;
  platform?: string;
  surfaceId?: string;
  detail: string;
}

export interface FinalSurfaceVerification {
  status: "pass" | "fail";
  findings: ReceiptFinding[];
  counts: {
    inventoryItems: number;
    requiredPlatforms: number;
    suppliedReceipts: number;
    verifiedOutcomes: number;
  };
}

export function loadFinalSurfaceContract(path: string): FinalSurfaceContract {
  return JSON.parse(readFileSync(path, "utf8")) as FinalSurfaceContract;
}

export function loadFinalSurfaceReceipt(path: string): FinalSurfaceReceipt {
  return JSON.parse(readFileSync(path, "utf8")) as FinalSurfaceReceipt;
}

export function verifyFinalSurfaceReceipts(input: {
  contract: FinalSurfaceContract;
  inventory: ReleaseSurfaceInventory;
  driverPlan: FinalSurfaceDriverPlan;
  receipts: FinalSurfaceReceipt[];
  sourceCommit: string;
  version: string;
  verifiedEvidenceArtifacts: Partial<Record<ReleasePlatform, string[]>>;
}): FinalSurfaceVerification {
  const { contract, inventory, driverPlan, receipts, sourceCommit, version, verifiedEvidenceArtifacts } = input;
  const findings: ReceiptFinding[] = [];
  let verifiedOutcomes = 0;

  if (contract.schema !== FINAL_SURFACE_CONTRACT_SCHEMA) {
    findings.push(finding("contract-schema", `expected ${FINAL_SURFACE_CONTRACT_SCHEMA}`));
  }
  if (contract.mode !== "final-frozen-candidate") {
    findings.push(finding("contract-mode", "final surface gate must be frozen-candidate-only"));
  }
  if (contract.candidateStage !== "signed-and-frozen") {
    findings.push(finding("contract-candidate-stage", "final surface gate requires the signed and frozen candidate"));
  }
  if (contract.executionWindow !== "immediately-before-publish") {
    findings.push(finding("contract-execution-window", "final surface gate must run immediately before publish"));
  }
  if (contract.routineTestUsage !== "forbidden") {
    findings.push(finding("contract-routine-usage", "final surface gate must not run as a routine fix-cycle walkthrough"));
  }
  if (contract.providerRoutePolicy !== "exact-identity-routes-with-minimal-live-canaries") {
    findings.push(finding("contract-provider-routes", "every declared route must bind executable identity and the coverage-minimal live canaries must pass"));
  }
  const requiredPlatforms: ReleasePlatform[] = ["windows-installed", "macos-installed", "linux-installed"];
  if (!sameStringSet(Object.keys(contract.platforms ?? {}), requiredPlatforms)) {
    findings.push(finding("contract-platforms", "final receipts must cover Windows, macOS, and Linux installed candidates"));
  }
  const requiredProviders = ["grok", "codex-cli", "claude-code", "antigravity-cli"];
  if (!sameStringSet(contract.requiredProviders, requiredProviders)) {
    findings.push(finding("contract-providers", "the exact four supported provider families must remain required"));
  }
  const requiredOutcomeVerdicts: FinalSurfaceContract["requiredOutcomeVerdicts"] = [
    "present",
    "invoke",
    "effect",
    "cleanup",
  ];
  if (!sameStringSet(contract.requiredOutcomeVerdicts, requiredOutcomeVerdicts)) {
    findings.push(finding("contract-outcome-verdicts", "present, invoke, effect, and cleanup verdicts must all remain required"));
  }
  for (const [flag, detail] of [
    ["zeroSilentSkips", "silent skips must remain forbidden"],
    ["requireHealthyStartupAndShutdown", "healthy installed startup and shutdown must remain required"],
    ["requireZeroBrokenLinks", "zero broken links must remain required"],
    ["requireZeroUnexpectedConsoleErrors", "zero unexpected console errors must remain required"],
  ] as const) {
    if (contract[flag] !== true) findings.push(finding(`contract-${flag}`, detail));
  }
  const requiredPlatformContracts: FinalSurfaceContract["platforms"] = {
    "windows-installed": {
      signatureStatus: "verified",
      requiredSignatureChecks: ["authenticode-valid", "publisher-identity", "timestamp-valid"],
      requiredTransports: ["local-native", "local-wsl", "ssh-posix-native", "ssh-windows-native", "ssh-windows-wsl"],
      requiredProviderRoutes: [
        ...requiredProviders.map((providerId) => ({ providerId, transportId: "local-native" })),
        ...requiredProviders.map((providerId) => ({ providerId, transportId: "local-wsl" })),
        ...requiredProviders.map((providerId) => ({ providerId, transportId: "ssh-posix-native" })),
        { providerId: "grok", transportId: "ssh-windows-native" },
        { providerId: "grok", transportId: "ssh-windows-wsl" },
      ],
      requiredLiveProviderRoutes: [
        { providerId: "grok", transportId: "local-native" },
        { providerId: "grok", transportId: "local-wsl" },
        { providerId: "claude-code", transportId: "ssh-posix-native" },
        { providerId: "grok", transportId: "ssh-windows-native" },
        { providerId: "grok", transportId: "ssh-windows-wsl" },
      ],
    },
    "macos-installed": {
      signatureStatus: "verified",
      requiredSignatureChecks: ["codesign-deep-strict", "gatekeeper-assess", "notary-staple"],
      requiredTransports: ["local-native", "ssh-posix-native", "ssh-windows-native", "ssh-windows-wsl"],
      requiredProviderRoutes: [
        { providerId: "grok", transportId: "local-native" },
        { providerId: "codex-cli", transportId: "local-native" },
        ...requiredProviders.map((providerId) => ({ providerId, transportId: "ssh-posix-native" })),
        { providerId: "grok", transportId: "ssh-windows-native" },
        { providerId: "grok", transportId: "ssh-windows-wsl" },
      ],
      requiredLiveProviderRoutes: [
        { providerId: "grok", transportId: "local-native" },
        { providerId: "antigravity-cli", transportId: "ssh-posix-native" },
        { providerId: "grok", transportId: "ssh-windows-native" },
        { providerId: "grok", transportId: "ssh-windows-wsl" },
      ],
    },
    "linux-installed": {
      signatureStatus: "digest-verified",
      requiredSignatureChecks: ["artifact-sha256-recomputed"],
      requiredTransports: ["local-native", "ssh-posix-native", "ssh-windows-native", "ssh-windows-wsl"],
      requiredProviderRoutes: [
        ...requiredProviders.map((providerId) => ({ providerId, transportId: "local-native" })),
        { providerId: "grok", transportId: "ssh-posix-native" },
        { providerId: "codex-cli", transportId: "ssh-posix-native" },
        { providerId: "grok", transportId: "ssh-windows-native" },
        { providerId: "grok", transportId: "ssh-windows-wsl" },
      ],
      requiredLiveProviderRoutes: [
        { providerId: "codex-cli", transportId: "local-native" },
        { providerId: "grok", transportId: "ssh-posix-native" },
        { providerId: "grok", transportId: "ssh-windows-native" },
        { providerId: "grok", transportId: "ssh-windows-wsl" },
      ],
    },
  };
  for (const platform of requiredPlatforms) {
    const actual = contract.platforms?.[platform];
    const expected = requiredPlatformContracts[platform];
    if (!actual
      || actual.signatureStatus !== expected.signatureStatus
      || !sameStringSet(actual.requiredSignatureChecks, expected.requiredSignatureChecks)
      || !sameStringSet(actual.requiredTransports, expected.requiredTransports)
      || !sameProviderRouteSet(actual.requiredProviderRoutes, expected.requiredProviderRoutes)
      || !sameProviderRouteSet(actual.requiredLiveProviderRoutes, expected.requiredLiveProviderRoutes)) {
      findings.push(finding("contract-platform-policy", `${platform} signature and transport policy must remain complete`));
    }
  }
  const requiredInvalidators = ["source-change", "artifact-change", "signature-change", "inventory-change"];
  if (!requiredInvalidators.every((id) => contract.invalidatedBy?.includes(id as FinalSurfaceContract["invalidatedBy"][number]))) {
    findings.push(finding("contract-invalidation", "source, artifact, signature, and inventory changes must invalidate all final receipts"));
  }
  const requiredUpdaterPlatforms: FinalSurfaceContract["updater"]["requiredPlatforms"] = [
    "windows-x86_64",
    "darwin-aarch64",
    "linux-x86_64",
  ];
  const requiredUpdaterChecks: FinalSurfaceContract["updater"]["requiredChecks"] = [
    "artifact-minisign-verified-against-embedded-pubkey",
    "all-required-platforms-present",
    "release-url-version-bound",
  ];
  if (!sameStringSet(contract.updater?.requiredPlatforms, requiredUpdaterPlatforms)) {
    findings.push(finding("contract-updater-platforms", "updater manifest must require Windows, macOS, and Linux artifacts"));
  }
  if (!sameStringSet(contract.updater?.requiredChecks, requiredUpdaterChecks)) {
    findings.push(finding("contract-updater-checks", "updater manifest must require signature, platform-completeness, and version-bound URL checks"));
  }
  if (inventory.unresolvedInteractiveControls > 0) {
    findings.push(finding(
      "unstable-ui-selectors",
      `${inventory.unresolvedInteractiveControls} interactive controls lack a usable frozen-candidate selector`,
    ));
  }
  const inventoryById = new Map(inventory.items.map((surface) => [surface.id, surface]));
  const driverById = new Map(driverPlan.drivers.map((driver) => [driver.id, driver]));
  const assignments = new Map(driverPlan.assignments.flatMap((assignment) => {
    const surface = inventoryById.get(assignment.surfaceId);
    const driver = driverById.get(assignment.driverId);
    return (surface?.platforms ?? []).filter((platform) => driver?.platforms[platform]).map(
      (platform) => [assignmentCellKey(assignment.surfaceId, platform), assignment] as const,
    );
  }));

  const receiptsByPlatform = new Map<ReleasePlatform, FinalSurfaceReceipt[]>();
  for (const receipt of receipts) {
    const rows = receiptsByPlatform.get(receipt.platform) ?? [];
    rows.push(receipt);
    receiptsByPlatform.set(receipt.platform, rows);
  }

  for (const [platform, platformContract] of Object.entries(contract.platforms) as Array<[
    ReleasePlatform,
    FinalSurfaceContract["platforms"][ReleasePlatform],
  ]>) {
    const platformReceipts = receiptsByPlatform.get(platform) ?? [];
    if (platformReceipts.length !== 1) {
      findings.push({
        ruleId: platformReceipts.length === 0 ? "receipt-missing" : "receipt-duplicate",
        platform,
        detail: `expected exactly one receipt, found ${platformReceipts.length}`,
      });
      continue;
    }
    const receipt = platformReceipts[0]!;
    if (receipt.schema !== FINAL_SURFACE_RECEIPT_SCHEMA) add(findings, "receipt-schema", platform, `expected ${FINAL_SURFACE_RECEIPT_SCHEMA}`);
    if (receipt.mode !== contract.mode) add(findings, "receipt-mode", platform, `expected ${contract.mode}`);
    if (receipt.sourceCommit !== sourceCommit) add(findings, "receipt-source-identity", platform, `expected source commit ${sourceCommit}, got ${receipt.sourceCommit}`);
    if (receipt.version !== version) add(findings, "receipt-version", platform, `expected version ${version}, got ${receipt.version}`);
    if (receipt.inventoryDigest !== inventory.digest) add(findings, "receipt-inventory-digest", platform, `expected ${inventory.digest}, got ${receipt.inventoryDigest}`);
    if (!/^[a-f0-9]{64}$/i.test(receipt.artifact?.sha256 ?? "")) add(findings, "artifact-hash", platform, "artifact sha256 must be 64 hex characters");
    if (!receipt.artifact?.basename?.trim()) add(findings, "artifact-basename", platform, "artifact basename is required");
    if (receipt.artifact?.signatureStatus !== platformContract.signatureStatus) {
      add(findings, "artifact-signature", platform, `expected ${platformContract.signatureStatus}, got ${receipt.artifact?.signatureStatus ?? "missing"}`);
    }
    if (!validIsoRange(receipt.startedAt, receipt.completedAt)) add(findings, "receipt-time-range", platform, "startedAt/completedAt must be valid ordered ISO timestamps");

    const declaredEvidence = verifyEvidenceArtifacts(
      findings,
      platform,
      receipt.evidenceArtifacts,
      new Set(verifiedEvidenceArtifacts[platform] ?? []),
    );

    verifyNamedPassRows(findings, platform, "transport", platformContract.requiredTransports, receipt.transports, false, declaredEvidence);
    verifyNamedPassRows(findings, platform, "provider", contract.requiredProviders, receipt.providers, true, declaredEvidence);
    verifyProviderRoutes(
      findings,
      platform,
      platformContract.requiredProviderRoutes,
      platformContract.requiredLiveProviderRoutes,
      receipt.providerRoutes,
      declaredEvidence,
    );

    if (receipt.health?.startup !== "pass") add(findings, "startup-health", platform, "installed app startup must pass");
    if (receipt.health?.shutdown !== "pass") add(findings, "shutdown-health", platform, "installed app shutdown/cleanup must pass");
    if (receipt.health?.brokenLinks !== 0) add(findings, "broken-links", platform, `expected 0 broken links, got ${receipt.health?.brokenLinks ?? "missing"}`);
    if (receipt.health?.unexpectedConsoleErrors !== 0) add(findings, "console-errors", platform, `expected 0 unexpected console errors, got ${receipt.health?.unexpectedConsoleErrors ?? "missing"}`);
    if (!receipt.health?.evidence?.trim()) add(findings, "health-evidence", platform, "startup, shutdown, links, and console health require evidence");
    else verifyEvidenceReference(findings, platform, declaredEvidence, receipt.health.evidence, "health evidence");

    const outcomes = new Map<string, FinalSurfaceReceipt["outcomes"][number]>();
    for (const outcome of receipt.outcomes ?? []) {
      if (outcomes.has(outcome.id)) {
        add(findings, "outcome-duplicate", platform, "surface outcome appears more than once", outcome.id);
      } else {
        outcomes.set(outcome.id, outcome);
      }
    }
    const applicable = inventory.items.filter((surface) => surface.platforms.includes(platform));
    for (const surface of applicable) {
      const outcome = outcomes.get(surface.id);
      if (!outcome) {
        add(findings, "outcome-missing", platform, "no outcome recorded for shipped surface", surface.id);
        continue;
      }
      for (const verdict of contract.requiredOutcomeVerdicts) {
        if (outcome[verdict] !== "pass") add(findings, "outcome-verdict", platform, `${verdict} must pass`, surface.id);
      }
      const assignment = assignments.get(assignmentCellKey(surface.id, platform));
      if (!assignment) {
        add(findings, "outcome-assignment", platform, "surface has no exact driver-plan assignment", surface.id);
      } else if (outcome.expectedEffect !== assignment.expectedEffect) {
        add(findings, "outcome-expected-effect", platform, "receipt expectedEffect does not match the exact driver-plan assignment", surface.id);
      }
      if (!outcome.oracleId?.trim()) add(findings, "outcome-oracle", platform, "effect oracle id is required", surface.id);
      else if (assignment && outcome.oracleId !== assignment.oracleId) {
        add(findings, "outcome-oracle", platform, "receipt oracleId does not match the exact driver-plan assignment", surface.id);
      }
      if (!outcome.evidence?.trim()) add(findings, "outcome-evidence", platform, "evidence pointer is required", surface.id);
      else verifyEvidenceReference(findings, platform, declaredEvidence, outcome.evidence, "surface evidence", surface.id);
      if (!outcome.cleanupEvidence?.trim()) {
        add(findings, "outcome-cleanup-evidence", platform, "cleanup evidence pointer is required", surface.id);
      } else {
        verifyEvidenceReference(
          findings,
          platform,
          declaredEvidence,
          outcome.cleanupEvidence,
          "surface cleanup evidence",
          surface.id,
        );
      }
      if (!outcome.observedEffect?.trim()) add(findings, "outcome-effect", platform, "observed intended effect is required", surface.id);
      verifiedOutcomes += 1;
    }
    const applicableIds = new Set(applicable.map((surface) => surface.id));
    for (const id of outcomes.keys()) {
      if (!applicableIds.has(id)) add(findings, "outcome-unknown", platform, "receipt names a surface outside this exact inventory/platform", id);
    }
  }

  for (const platform of receiptsByPlatform.keys()) {
    if (!(platform in contract.platforms)) add(findings, "receipt-platform-unknown", platform, "platform is not in the final surface contract");
  }

  return {
    status: findings.length ? "fail" : "pass",
    findings,
    counts: {
      inventoryItems: inventory.items.length,
      requiredPlatforms: Object.keys(contract.platforms).length,
      suppliedReceipts: receipts.length,
      verifiedOutcomes,
    },
  };
}

function verifyProviderRoutes(
  findings: ReceiptFinding[],
  platform: ReleasePlatform,
  requiredRoutes: FinalSurfaceRequiredProviderRoute[],
  requiredLiveRoutes: FinalSurfaceRequiredProviderRoute[],
  routes: FinalSurfaceReceipt["providerRoutes"],
  declaredEvidence: Set<string>,
): void {
  if (!Array.isArray(routes)) {
    add(findings, "provider-route-missing", platform, "provider route matrix is missing");
    return;
  }
  const expected = requiredRoutes.map(({ providerId, transportId }) => ({
    id: `${providerId}::${transportId}`,
    providerId,
    transportId,
  }));
  const liveIds = new Set(requiredLiveRoutes.map(({ providerId, transportId }) => `${providerId}::${transportId}`));
  const byId = new Map(routes.map((route) => [route.id, route]));
  if (byId.size !== routes.length) add(findings, "provider-route-duplicate", platform, "provider route ids must be unique");
  for (const row of expected) {
    const route = byId.get(row.id);
    if (!route) {
      add(findings, "provider-route-missing", platform, `required provider route ${row.id} is missing`);
      continue;
    }
    if (route.providerId !== row.providerId || route.transportId !== row.transportId) {
      add(findings, "provider-route-identity", platform, `provider route ${row.id} identity is inconsistent`);
    }
    if (route.status !== "pass") add(findings, "provider-route-status", platform, `provider route ${row.id} must pass`);
    const expectedMode = liveIds.has(row.id) ? "live-canary" : "identity-only";
    if (route.evidenceMode !== expectedMode) {
      add(findings, "provider-route-evidence-mode", platform, `provider route ${row.id} must use ${expectedMode} evidence`);
    }
    if (!route.version?.trim()) add(findings, "provider-route-version", platform, `provider route ${row.id} must record a version`);
    if (!/^[a-f0-9]{64}$/i.test(route.executableSha256 ?? "")) {
      add(findings, "provider-route-executable", platform, `provider route ${row.id} must bind the executable SHA-256`);
    }
    if (!route.evidence?.trim()) add(findings, "provider-route-evidence", platform, `provider route ${row.id} requires evidence`);
    else verifyEvidenceReference(findings, platform, declaredEvidence, route.evidence, `provider route ${row.id} evidence`);
  }
  const expectedIds = new Set(expected.map((row) => row.id));
  for (const id of byId.keys()) {
    if (!expectedIds.has(id)) add(findings, "provider-route-unknown", platform, `provider route ${id} is outside the exact matrix`);
  }
}

function verifyNamedPassRows(
  findings: ReceiptFinding[],
  platform: ReleasePlatform,
  kind: "transport" | "provider",
  required: string[],
  actual: Array<{ id: string; status: "pass"; evidence: string; version?: string }>,
  requireVersion = false,
  declaredEvidence?: Set<string>,
): void {
  const byId = new Map(actual.map((row) => [row.id, row]));
  if (byId.size !== actual.length) add(findings, `${kind}-duplicate`, platform, `${kind} ids must be unique`);
  for (const id of required) {
    const row = byId.get(id);
    if (!row) {
      add(findings, `${kind}-missing`, platform, `required ${kind} ${id} is missing`);
      continue;
    }
    if (row.status !== "pass") add(findings, `${kind}-status`, platform, `${kind} ${id} must pass`);
    if (!row.evidence?.trim()) add(findings, `${kind}-evidence`, platform, `${kind} ${id} requires evidence`);
    else if (declaredEvidence) verifyEvidenceReference(findings, platform, declaredEvidence, row.evidence, `${kind} ${id} evidence`);
    if (requireVersion && !row.version?.trim()) add(findings, `${kind}-version`, platform, `${kind} ${id} requires the tested version`);
  }
  for (const id of byId.keys()) {
    if (!required.includes(id)) add(findings, `${kind}-unknown`, platform, `${kind} ${id} is not declared in the contract`);
  }
}

function verifyEvidenceArtifacts(
  findings: ReceiptFinding[],
  platform: ReleasePlatform,
  artifacts: FinalSurfaceReceipt["evidenceArtifacts"],
  verifiedIds: Set<string>,
): Set<string> {
  const declared = new Set<string>();
  for (const artifact of artifacts ?? []) {
    const id = artifact?.id?.trim();
    if (!id) {
      add(findings, "evidence-artifact-id", platform, "evidence artifact id is required");
      continue;
    }
    if (declared.has(id)) {
      add(findings, "evidence-artifact-duplicate", platform, `evidence artifact ${id} is declared more than once`);
      continue;
    }
    declared.add(id);
    if (!isSafeRelativePath(artifact.relativePath)) {
      add(findings, "evidence-artifact-path", platform, `evidence artifact ${id} must use a contained relative path`);
    }
    if (!/^[a-f0-9]{64}$/i.test(artifact.sha256 ?? "")) {
      add(findings, "evidence-artifact-hash", platform, `evidence artifact ${id} sha256 must be 64 hex characters`);
    }
    if (!Number.isSafeInteger(artifact.bytes) || artifact.bytes <= 0) {
      add(findings, "evidence-artifact-bytes", platform, `evidence artifact ${id} must record a positive exact byte count`);
    }
    if (!verifiedIds.has(id)) {
      add(findings, "evidence-artifact-unverified", platform, `evidence artifact ${id} was not hash-verified from private storage`);
    }
  }
  return declared;
}

function verifyEvidenceReference(
  findings: ReceiptFinding[],
  platform: ReleasePlatform,
  declared: Set<string>,
  evidenceId: string | undefined,
  label: string,
  surfaceId?: string,
): void {
  if (!evidenceId?.trim()) return;
  if (!declared.has(evidenceId)) {
    add(findings, "evidence-reference", platform, `${label} must reference a declared evidence artifact id`, surfaceId);
  }
}

function isSafeRelativePath(path: string | undefined): boolean {
  if (!path?.trim() || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("/") || path.startsWith("\\")) return false;
  return !path.split(/[\\/]+/).some((segment) => segment === ".." || segment === "");
}

function validIsoRange(startedAt: string, completedAt: string): boolean {
  const start = Date.parse(startedAt);
  const end = Date.parse(completedAt);
  return Number.isFinite(start) && Number.isFinite(end) && end >= start;
}

function sameStringSet(actual: readonly string[] | undefined, expected: readonly string[]): boolean {
  return Array.isArray(actual)
    && actual.length === expected.length
    && expected.every((value) => actual.includes(value));
}

function sameProviderRouteSet(
  actual: readonly FinalSurfaceRequiredProviderRoute[] | undefined,
  expected: readonly FinalSurfaceRequiredProviderRoute[],
): boolean {
  if (!Array.isArray(actual) || actual.length !== expected.length) return false;
  const routeId = (route: FinalSurfaceRequiredProviderRoute): string => `${route.providerId}::${route.transportId}`;
  const actualIds = new Set(actual.map(routeId));
  return actualIds.size === actual.length && expected.every((route) => actualIds.has(routeId(route)));
}

function finding(ruleId: string, detail: string): ReceiptFinding {
  return { ruleId, detail };
}

function add(findings: ReceiptFinding[], ruleId: string, platform: string, detail: string, surfaceId?: string): void {
  findings.push({ ruleId, platform, detail, ...(surfaceId ? { surfaceId } : {}) });
}
