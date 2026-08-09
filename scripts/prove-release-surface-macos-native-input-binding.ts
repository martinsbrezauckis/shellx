import { lstatSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadReleaseSurfaceCandidateAttestation } from "./lib/release-surface-candidate-attestation";
import {
  proveReleaseSurfaceMacosNativeInputBinding,
  ReleaseSurfaceMacosAccessibilityBlockedError,
  validateReleaseSurfaceMacosNativeInputBinding,
} from "./lib/release-surface-macos-native-input";

try {
  const args = process.argv.slice(2);
  const candidatePath = resolve(requiredArg(args, "--candidate-attestation"));
  const helperPath = resolve(requiredArg(args, "--helper"));
  const outputPath = resolve(requiredArg(args, "--out"));
  const candidate = loadReleaseSurfaceCandidateAttestation(candidatePath);
  if (candidate.platform !== "macos-installed") {
    throw new Error("macOS native-input proof requires a macos-installed candidate attestation");
  }
  if (process.platform !== "darwin") {
    throw new Error("macOS native-input proof must run on the candidate Mac host");
  }
  const tokenPath = resolve(candidate.runtime.debugTokenPath);
  const tokenStat = lstatSync(tokenPath);
  if (tokenStat.isSymbolicLink() || !tokenStat.isFile()) {
    throw new Error("candidate Debug API token must be a regular non-symlink file");
  }
  const candidateToken = readFileSync(tokenPath, "utf8").trim();
  const evidence = await proveReleaseSurfaceMacosNativeInputBinding({
    candidate,
    candidateToken,
    helperPath,
  });
  const errors = validateReleaseSurfaceMacosNativeInputBinding({ evidence, candidate, helperPath });
  if (errors.length > 0) {
    throw new Error(`macOS native-input binding evidence is invalid: ${errors.join("; ")}`);
  }
  writeFileSync(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  console.log(`Bound the native macOS input helper to candidate PID ${candidate.runtime.processId}: ${outputPath}`);
} catch (error) {
  if (error instanceof ReleaseSurfaceMacosAccessibilityBlockedError) {
    console.error(`${error.code}: ${error.prerequisite}`);
    process.exitCode = 3;
  } else {
    throw error;
  }
}

function readArg(values: string[], name: string): string | undefined {
  const index = values.indexOf(name);
  return index >= 0
    ? values[index + 1]
    : values.find((entry) => entry.startsWith(`${name}=`))?.slice(name.length + 1);
}

function requiredArg(values: string[], name: string): string {
  const value = readArg(values, name);
  if (!value?.trim()) throw new Error(`${name} is required`);
  return value;
}
