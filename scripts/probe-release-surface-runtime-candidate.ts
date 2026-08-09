import { readFileSync, writeFileSync } from "node:fs";
import {
  probeReleaseSurfaceRuntimeCandidate,
  type ReleaseSurfaceRuntimeProbe,
} from "./lib/release-surface-runtime-candidate";
import type { ReleaseSurfaceDriverRequest } from "./lib/release-surface-driver-protocol";

const args = process.argv.slice(2);
const requestPath = requiredArg(args, "--request");
const outputPath = requiredArg(args, "--out");
const phase = requiredArg(args, "--phase") as ReleaseSurfaceRuntimeProbe["phase"];
if (!(["before-driver", "after-driver"] as string[]).includes(phase)) {
  throw new Error("--phase must be before-driver or after-driver");
}
const request = JSON.parse(readFileSync(requestPath, "utf8")) as ReleaseSurfaceDriverRequest;
const probe = await probeReleaseSurfaceRuntimeCandidate(request, phase);
writeFileSync(outputPath, `${JSON.stringify(probe, null, 2)}\n`, {
  encoding: "utf8",
  flag: "wx",
  mode: 0o600,
});

function requiredArg(values: string[], name: string): string {
  const index = values.indexOf(name);
  const value = index >= 0 ? values[index + 1] : values.find((entry) => entry.startsWith(`${name}=`))?.slice(name.length + 1);
  if (!value?.trim()) throw new Error(`${name} is required`);
  return value;
}
