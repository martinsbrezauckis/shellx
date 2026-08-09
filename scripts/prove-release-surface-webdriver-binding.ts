import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ReleasePlatform } from "./lib/release-surface-inventory";
import { loadReleaseSurfaceCandidateAttestation } from "./lib/release-surface-candidate-attestation";
import {
  proveReleaseSurfaceWebDriverBinding,
  validateReleaseSurfaceWebDriverBinding,
} from "./lib/release-surface-webdriver-binding";

const args = process.argv.slice(2);
const candidatePath = requiredArg(args, "--candidate-attestation");
const webdriverBase = requiredArg(args, "--webdriver-base");
const sessionId = requiredArg(args, "--session-id");
const outputPath = resolve(requiredArg(args, "--out"));
const candidate = loadReleaseSurfaceCandidateAttestation(candidatePath);
const tokenPath = nodeReadablePath(candidate.runtime.debugTokenPath, candidate.platform);
const tokenStat = lstatSync(tokenPath);
if (tokenStat.isSymbolicLink() || !tokenStat.isFile()) {
  throw new Error(`candidate Debug API token must be a regular non-symlink file: ${tokenPath}`);
}
const candidateToken = readFileSync(tokenPath, "utf8").trim();
const session = { base: webdriverBase, sessionId };
const evidence = await proveReleaseSurfaceWebDriverBinding({ candidate, candidateToken, session });
const errors = validateReleaseSurfaceWebDriverBinding({ evidence, candidate, session });
if (errors.length > 0) throw new Error(`WebDriver binding evidence is invalid: ${errors.join("; ")}`);
writeFileSync(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, {
  encoding: "utf8",
  flag: "wx",
  mode: 0o600,
});
console.log(`Bound WebDriver session to candidate PID ${candidate.runtime.processId}: ${outputPath}`);

function nodeReadablePath(path: string, platform: ReleasePlatform): string {
  if (platform !== "windows-installed" || process.platform === "win32" || !/^[A-Za-z]:[\\/]/.test(path)) {
    return resolve(path);
  }
  const result = spawnSync("wslpath", ["-u", path], { encoding: "utf8" });
  if (result.status !== 0 || !result.stdout.trim()) throw new Error(`unable to map candidate Debug API token ${path}`);
  return resolve(result.stdout.trim());
}

function requiredArg(values: string[], name: string): string {
  const index = values.indexOf(name);
  const value = index >= 0
    ? values[index + 1]
    : values.find((entry) => entry.startsWith(`${name}=`))?.slice(name.length + 1);
  if (!value?.trim()) throw new Error(`${name} is required`);
  return value;
}
