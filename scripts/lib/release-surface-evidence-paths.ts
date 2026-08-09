import { existsSync, lstatSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";

function requireOutsideProfile(path: string, profilePath: string, label: string): void {
  const rel = relative(resolve(profilePath), resolve(path));
  if (!rel || rel === "." || (!rel.startsWith(`..${sep}`) && rel !== "..")) {
    throw new Error(`${label} must be outside the disposable profile: ${path}`);
  }
}

export function validateCreateOnlyEvidenceDirectory(input: {
  outputDir: string;
  profilePath: string;
  label: string;
}): void {
  const outputDir = resolve(input.outputDir);
  const parent = lstatSync(dirname(outputDir));
  if (parent.isSymbolicLink() || !parent.isDirectory()) {
    throw new Error(`${input.label} parent must be a regular non-link directory: ${outputDir}`);
  }
  if (existsSync(outputDir)) throw new Error(`${input.label} already exists: ${outputDir}`);
  requireOutsideProfile(outputDir, input.profilePath, input.label);
}

export function validateDirectEvidenceOutputs(input: {
  profilePath: string;
  paths: string[];
}): void {
  const paths = input.paths.map((path) => resolve(path));
  if (new Set(paths).size !== paths.length) throw new Error("direct final evidence paths must be distinct");
  for (const path of paths) {
    const parent = lstatSync(dirname(path));
    if (parent.isSymbolicLink() || !parent.isDirectory()) {
      throw new Error(`final evidence parent must be a regular non-link directory: ${path}`);
    }
    if (existsSync(path)) throw new Error(`final evidence already exists: ${path}`);
    requireOutsideProfile(path, input.profilePath, "final evidence");
  }
}
