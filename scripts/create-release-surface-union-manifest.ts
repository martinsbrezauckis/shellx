import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import {
  RELEASE_SURFACE_UNION_MANIFEST_SCHEMA,
  type ReleaseSurfaceUnionManifest,
} from "./lib/release-surface-union-manifest";
import type { ReleaseSurfaceDriverRunManifest } from "./lib/release-surface-driver-runner";
import type { ReleaseSurfaceWebDriverOrchestrationReceipt } from "./lib/release-surface-webdriver-orchestration";
import type { ReleasePlatform, ReleaseSurfaceInventory } from "./lib/release-surface-inventory";

const root = resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const receiptsDir = resolve(requiredArg(args, "--receipts-dir"));
const runsDir = containedDirectory(receiptsDir, requiredArg(args, "--runs-dir"), "union runs directory");
const signatureReceipt = containedRelative(receiptsDir, requiredArg(args, "--signature-receipt"), "shared signature receipt");
const installationReceipt = containedRelative(receiptsDir, requiredArg(args, "--installation-receipt"), "shared installation receipt");
const outputPath = resolve(requiredArg(args, "--out"));
if (resolve(outputPath).startsWith(`${runsDir}${sep}`) || resolve(outputPath) === runsDir) {
  throw new Error("union manifest output must stay outside the immutable run evidence roots");
}
if (existsSync(outputPath)) throw new Error(`union manifest output already exists: ${outputPath}`);
const platform = requiredArg(args, "--platform") as ReleasePlatform;
if (!("windows-installed macos-installed linux-installed".split(" ") as string[]).includes(platform)) {
  throw new Error("valid --platform is required");
}
const sourceCommit = requiredArg(args, "--source-commit");
const version = requiredArg(args, "--version");
const inventory = JSON.parse(readFileSync(join(root, "release", "surface-inventory.json"), "utf8")) as ReleaseSurfaceInventory;

const discovered = readdirSync(runsDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
  .map((entry) => discoverSource(join(runsDir, entry.name), entry.name))
  .sort((left, right) => Date.parse(left.startedAt) - Date.parse(right.startedAt));
if (discovered.length < 2) throw new Error("union discovery requires at least two immutable run evidence roots");
const discoverySources = discovered.filter((row) => row.source.sourceKind !== "targeted-closure");
if (discoverySources.length !== 1) {
  throw new Error(`union discovery requires exactly one original discovery source, got ${discoverySources.length}`);
}
const scenarioSources = discovered.filter((row) => row.hasScenario);
if (scenarioSources.length === 0) throw new Error("union discovery found no sealed scenario source");
const scenarioSource = scenarioSources.at(-1)!;
const manifest: ReleaseSurfaceUnionManifest = {
  schema: RELEASE_SURFACE_UNION_MANIFEST_SCHEMA,
  platform,
  sourceCommit,
  version,
  inventoryDigest: inventory.digest,
  scenarioSourceId: scenarioSource.source.sourceId,
  sources: discovered.map((row) => row.source),
};
writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
console.log(`Created union manifest with ${manifest.sources.length} sources; scenario ${manifest.scenarioSourceId}: ${outputPath}`);

function discoverSource(runRoot: string, sourceId: string): {
  source: ReleaseSurfaceUnionManifest["sources"][number];
  startedAt: string;
  hasScenario: boolean;
} {
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(sourceId)) throw new Error(`invalid run evidence directory name ${sourceId}`);
  const orchestrationPath = join(runRoot, "orchestration.json");
  const orchestration = readJson<ReleaseSurfaceWebDriverOrchestrationReceipt>(orchestrationPath);
  if (orchestration.platform !== platform || orchestration.runId !== sourceId || !Number.isFinite(Date.parse(orchestration.startedAt))) {
    throw new Error(`run ${sourceId} orchestration identity drifted`);
  }
  const candidatePath = join(runRoot, "candidate-attestation.json");
  requireIdentity(candidatePath, orchestration.candidateAttestation, `run ${sourceId} candidate attestation`);
  const driverRunDir = containedDirectory(receiptsDir, join(runRoot, "driver-run"), `run ${sourceId} driver directory`);
  const manifestPath = join(driverRunDir, "run-manifest.json");
  if (!existsSync(manifestPath)) {
    if (orchestration.status !== "failed"
      || orchestration.workCompleted !== false
      || orchestration.executionWindow !== "immediately-before-publish") {
      throw new Error(`run ${sourceId} lacks a sealed manifest but is not an interrupted discovery`);
    }
    requireIdentity(join(runRoot, "lifecycle.json"), orchestration.webdriverLifecycle, `run ${sourceId} lifecycle`);
    requireIdentity(join(runRoot, "profile-cleanup.json"), orchestration.profileCleanup, `run ${sourceId} profile cleanup`);
    return {
      source: {
        sourceId,
        sourceKind: "interrupted-discovery",
        driverRunDir: relativeUnix(receiptsDir, driverRunDir),
        orchestration: relativeUnix(receiptsDir, orchestrationPath),
        lifecycle: relativeUnix(receiptsDir, join(runRoot, "lifecycle.json")),
        profileCleanup: relativeUnix(receiptsDir, join(runRoot, "profile-cleanup.json")),
        candidateAttestation: relativeUnix(receiptsDir, candidatePath),
        signatureReceipt,
        installationReceipt,
      },
      startedAt: orchestration.startedAt,
      hasScenario: false,
    };
  }
  const runManifest = readJson<ReleaseSurfaceDriverRunManifest>(manifestPath);
  if (runManifest.platform !== platform
    || runManifest.sourceCommit !== sourceCommit
    || runManifest.version !== version
    || runManifest.inventoryDigest !== inventory.digest) {
    throw new Error(`run ${sourceId} driver manifest identity drifted`);
  }
  requireIdentity(manifestPath, orchestration.driverRunManifest, `run ${sourceId} driver manifest`);
  const sourceKind = runManifest.targetedClosure ? "targeted-closure" : "complete-discovery";
  if (sourceKind === "complete-discovery" && orchestration.executionWindow !== "immediately-before-publish") {
    throw new Error(`run ${sourceId} complete discovery has the wrong execution window`);
  }
  if (sourceKind === "targeted-closure" && orchestration.executionWindow !== "targeted-post-matrix") {
    throw new Error(`run ${sourceId} targeted closure has the wrong execution window`);
  }
  const teardownPath = join(runRoot, "candidate-teardown.json");
  requireIdentity(teardownPath, orchestration.candidateTeardown, `run ${sourceId} candidate teardown`);
  const scenarioPath = join(runRoot, "scenario.json");
  const hasScenario = existsSync(scenarioPath);
  if (hasScenario) requireIdentity(scenarioPath, orchestration.scenarioReport, `run ${sourceId} scenario`);
  return {
    source: {
      sourceId,
      sourceKind,
      driverRunDir: relativeUnix(receiptsDir, driverRunDir),
      ...(hasScenario ? { scenarioReport: relativeUnix(receiptsDir, scenarioPath) } : {}),
      signatureReceipt,
      candidateAttestation: relativeUnix(receiptsDir, candidatePath),
      candidateTeardown: relativeUnix(receiptsDir, teardownPath),
      installationReceipt,
    },
    startedAt: orchestration.startedAt,
    hasScenario,
  };
}

function requireIdentity(
  path: string,
  expected: { basename: string; sha256: string; bytes: number } | undefined,
  label: string,
): void {
  if (!expected) throw new Error(`${label} is missing from orchestration`);
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`${label} must be a regular non-link file`);
  const bytes = readFileSync(path);
  const actual = { basename: basename(path), sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length };
  if (actual.basename !== expected.basename || actual.sha256 !== expected.sha256 || actual.bytes !== expected.bytes) {
    throw new Error(`${label} identity drifted`);
  }
}

function containedRelative(rootDir: string, path: string, label: string): string {
  const absolute = resolve(path);
  const stat = lstatSync(absolute);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`${label} must be a regular non-link file`);
  return relativeUnix(rootDir, absolute);
}

function containedDirectory(rootDir: string, path: string, label: string): string {
  const absolute = resolve(path);
  relativeUnix(rootDir, absolute);
  const stat = lstatSync(absolute);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`${label} must be a regular non-link directory`);
  return absolute;
}

function relativeUnix(rootDir: string, path: string): string {
  const value = relative(resolve(rootDir), resolve(path));
  if (!value || value === "." || value === ".." || value.startsWith(`..${sep}`) || value.startsWith(sep)) {
    throw new Error("union evidence path must stay inside the receipts directory");
  }
  return value.split(sep).join("/");
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function requiredArg(values: string[], name: string): string {
  const index = values.indexOf(name);
  const value = index >= 0 ? values[index + 1] : values.find((entry) => entry.startsWith(`${name}=`))?.slice(name.length + 1);
  if (!value?.trim()) throw new Error(`${name} is required`);
  return value;
}
