import { lstatSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  loadReleaseSurfaceCandidateAttestation,
} from "./lib/release-surface-candidate-attestation";
import {
  validateReleaseSurfaceHealthEvidence,
  type ReleaseSurfaceHealthEvidence,
} from "./lib/release-surface-health-evidence";
import type { ReleaseSurfaceScenarioReport } from "./lib/release-surface-scenario-report";
import {
  assertReleaseSurfaceCollectorSource,
  type ReleaseSurfaceGitRunner,
} from "./lib/release-surface-source-provenance";

const HEALTH_EVIDENCE_TRACKED_SOURCES = [
  "scripts/create-release-surface-health-evidence.ts",
  "scripts/lib/release-surface-health-evidence.ts",
] as const;

export function createReleaseSurfaceHealthEvidence(input: {
  draftPath: string;
  candidateAttestationPath: string;
  scenarioStartedAt: string;
  scenarioCompletedAt: string;
  outputPath: string;
  repositoryRoot?: string;
  runGit?: ReleaseSurfaceGitRunner;
}): void {
  const draftPath = requireRegularFile(input.draftPath, "health evidence draft");
  const candidatePath = requireRegularFile(input.candidateAttestationPath, "candidate attestation");
  const outputPath = resolve(input.outputPath);
  const parent = lstatSync(dirname(outputPath));
  if (parent.isSymbolicLink() || !parent.isDirectory()) {
    throw new Error("health evidence output parent must be a regular directory");
  }
  const evidence = JSON.parse(readFileSync(draftPath, "utf8")) as ReleaseSurfaceHealthEvidence;
  const candidate = loadReleaseSurfaceCandidateAttestation(candidatePath);
  assertReleaseSurfaceCollectorSource({
    sourceCommit: candidate.sourceCommit,
    repositoryRoot: input.repositoryRoot ?? resolve(dirname(fileURLToPath(import.meta.url)), ".."),
    trackedSources: HEALTH_EVIDENCE_TRACKED_SOURCES,
    runGit: input.runGit,
  });
  const scenario = {
    startedAt: input.scenarioStartedAt,
    completedAt: input.scenarioCompletedAt,
    health: {
      brokenLinks: evidence.links?.brokenLinks,
      unexpectedConsoleErrors: evidence.console?.unexpectedConsoleErrors,
    },
  } as ReleaseSurfaceScenarioReport;
  const errors = validateReleaseSurfaceHealthEvidence({ evidence, candidate, scenario });
  if (errors.length > 0) throw new Error(`health evidence draft is invalid: ${errors.join("; ")}`);
  writeFileSync(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, { flag: "wx", mode: 0o600 });
}

function requireRegularFile(path: string, label: string): string {
  const absolute = resolve(path);
  const stat = lstatSync(absolute);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`${label} must be a regular non-symlink file`);
  return absolute;
}

function requiredArg(args: string[], flag: string): string {
  const index = args.indexOf(flag);
  const value = index >= 0 ? args[index + 1]?.trim() : undefined;
  if (!value) throw new Error(`${flag} is required`);
  return value;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  createReleaseSurfaceHealthEvidence({
    draftPath: requiredArg(args, "--draft"),
    candidateAttestationPath: requiredArg(args, "--candidate-attestation"),
    scenarioStartedAt: requiredArg(args, "--scenario-started-at"),
    scenarioCompletedAt: requiredArg(args, "--scenario-completed-at"),
    outputPath: requiredArg(args, "--out"),
  });
}

const invokedAsScript = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedAsScript) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exit(1);
  });
}
