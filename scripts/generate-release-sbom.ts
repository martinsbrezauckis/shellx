import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

type JsonObject = Record<string, unknown>;
export const RELEASE_SBOM_SYFT_VERSION = "1.50.0";
export const RELEASE_SBOM_CYCLONEDX_FORMAT = "cyclonedx-json@1.6";

export interface NormalizeReleaseSbomOptions {
  artifactName: string;
  artifactSha256: string;
  directNpmDependencies: string[];
  repositoryRoot: string;
  sourceCommit: string;
  version: string;
}

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(record: JsonObject, key: string): string | undefined {
  return typeof record[key] === "string" ? record[key] : undefined;
}

function objectArray(value: unknown): JsonObject[] {
  return Array.isArray(value) ? value.filter(isObject) : [];
}

function cloneObject(value: JsonObject): JsonObject {
  return structuredClone(value) as JsonObject;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function deterministicUuid(value: string): string {
  const digest = sha256(value).slice(0, 32).split("");
  digest[12] = "5";
  digest[16] = ((Number.parseInt(digest[16]!, 16) & 0x3) | 0x8).toString(16);
  const hex = digest.join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function normalizeProperties(component: JsonObject): void {
  const properties = objectArray(component.properties)
    .filter((property) => !stringValue(property, "name")?.startsWith("syft:location:"))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  if (properties.length > 0) component.properties = properties;
  else delete component.properties;
}

function addProperty(component: JsonObject, name: string, value: string): void {
  const properties = objectArray(component.properties)
    .filter((property) => stringValue(property, "name") !== name);
  properties.push({ name, value });
  component.properties = properties.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

function assertNoPrivatePaths(value: unknown, options: NormalizeReleaseSbomOptions): void {
  const serialized = JSON.stringify(value);
  const forbidden = [resolve(options.repositoryRoot), resolve(homedir())]
    .filter((entry, index, entries) => entries.indexOf(entry) === index);
  for (const path of forbidden) {
    if (serialized.includes(path) || serialized.includes(path.replaceAll("/", "\\"))) {
      throw new Error(`SBOM contains a host-private absolute path rooted at ${path}`);
    }
  }
  if (/file:\/\/(?:\/)?(?:home|Users)\//i.test(serialized)
    || /[A-Za-z]:\\Users\\[^\\"\s]+/i.test(serialized)) {
    throw new Error("SBOM contains a host-private user path");
  }
}

export function normalizeReleaseSbom(rawValue: unknown, options: NormalizeReleaseSbomOptions): JsonObject {
  if (!isObject(rawValue) || rawValue.bomFormat !== "CycloneDX" || rawValue.specVersion !== "1.6") {
    throw new Error("Syft must return a CycloneDX 1.6 JSON document");
  }
  if (!/^[0-9a-f]{40}$/.test(options.sourceCommit)) {
    throw new Error("source commit must be a full lowercase Git SHA-1");
  }
  if (!/^[0-9a-f]{64}$/.test(options.artifactSha256)) {
    throw new Error("artifact SHA-256 must be 64 lowercase hexadecimal characters");
  }
  const artifactSegments = options.artifactName.split("/");
  if (!options.artifactName || options.artifactName.startsWith("/") || options.artifactName.includes("\\")
    || artifactSegments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error("artifact name must be a safe release-root-relative POSIX path");
  }

  const components = objectArray(rawValue.components)
    .filter((component) => stringValue(component, "type") !== "file")
    .map((component) => {
      const normalized = cloneObject(component);
      normalizeProperties(normalized);
      return normalized;
    });
  const root = components.find((component) => (
    stringValue(component, "name") === "shellx"
      && stringValue(component, "version") === options.version
      && stringValue(component, "purl")?.startsWith("pkg:cargo/shellx@")
  )) ?? components.find((component) => {
    if (stringValue(component, "name") !== "shellx"
      || stringValue(component, "version") !== options.version) return false;
    const properties = objectArray(component.properties);
    return properties.some((property) => (
      stringValue(property, "name") === "syft:package:type"
        && stringValue(property, "value") === "rust-crate"
    )) && properties.some((property) => (
      stringValue(property, "name") === "syft:package:language"
        && stringValue(property, "value") === "rust"
    ));
  });
  if (!root) throw new Error("Syft output does not contain the ShellX Cargo root component");
  const rootRef = stringValue(root, "bom-ref");
  if (!rootRef) throw new Error("ShellX root component has no bom-ref");

  root.type = "application";
  root.purl = `pkg:cargo/shellx@${options.version}`;
  root.hashes = [{ alg: "SHA-256", content: options.artifactSha256 }];
  root.licenses = [{ expression: "MIT" }];
  addProperty(root, "shellx:release:artifact", options.artifactName);
  addProperty(root, "shellx:source:commit", options.sourceCommit);
  addProperty(root, "shellx:sbom:scope", "source-build-and-runtime-locks");

  const componentByRef = new Map<string, JsonObject>();
  for (const component of components) {
    const ref = stringValue(component, "bom-ref");
    if (!ref) throw new Error("CycloneDX component has no bom-ref");
    if (componentByRef.has(ref)) throw new Error(`CycloneDX component bom-ref is not unique: ${ref}`);
    componentByRef.set(ref, component);
  }

  const validRefs = new Set(componentByRef.keys());
  const dependencyMap = new Map<string, Set<string>>();
  for (const dependency of objectArray(rawValue.dependencies)) {
    const ref = stringValue(dependency, "ref");
    if (!ref || !validRefs.has(ref)) continue;
    const dependsOn = Array.isArray(dependency.dependsOn)
      ? dependency.dependsOn.filter((item): item is string => typeof item === "string" && validRefs.has(item))
      : [];
    const owned = dependencyMap.get(ref) ?? new Set<string>();
    for (const item of dependsOn) owned.add(item);
    dependencyMap.set(ref, owned);
  }

  const rootDependencies = dependencyMap.get(rootRef) ?? new Set<string>();
  const directNpm = new Set(options.directNpmDependencies);
  for (const component of components) {
    if (directNpm.has(stringValue(component, "name") ?? "")
      && stringValue(component, "purl")?.startsWith("pkg:npm/")) {
      rootDependencies.add(stringValue(component, "bom-ref")!);
    }
  }
  dependencyMap.set(rootRef, rootDependencies);

  const metadataSource = isObject(rawValue.metadata) ? rawValue.metadata : {};
  const tools = isObject(metadataSource.tools) ? cloneObject(metadataSource.tools) : undefined;
  const output: JsonObject = {
    $schema: "http://cyclonedx.org/schema/bom-1.6.schema.json",
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    version: 1,
    metadata: {
      ...(tools ? { tools } : {}),
      component: cloneObject(root),
    },
    components: components
      .filter((component) => stringValue(component, "bom-ref") !== rootRef)
      .sort((left, right) => stringValue(left, "bom-ref")!.localeCompare(stringValue(right, "bom-ref")!)),
    dependencies: [...dependencyMap.entries()]
      .map(([ref, dependsOn]) => ({ ref, dependsOn: [...dependsOn].sort() }))
      .sort((left, right) => left.ref.localeCompare(right.ref)),
  };
  output.serialNumber = `urn:uuid:${deterministicUuid(JSON.stringify(output))}`;
  assertNoPrivatePaths(output, options);
  return output;
}

function requiredOption(argv: string[], name: string): string {
  const index = argv.indexOf(name);
  const value = index >= 0 ? argv[index + 1] : undefined;
  if (!value || value.startsWith("--")) throw new Error(`missing required ${name}`);
  return value;
}

function inside(root: string, path: string): boolean {
  const child = relative(root, path);
  return child === "" || (!child.startsWith(`..${sep}`) && child !== ".." && !isAbsolute(child));
}

function commandOutput(command: string, args: string[], cwd: string): string {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  if (result.error) throw new Error(`unable to run ${command}: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed: ${(result.stderr || result.stdout).trim()}`);
  return result.stdout.trim();
}

export function validateSyftVersion(rawValue: unknown): void {
  if (!isObject(rawValue) || rawValue.application !== "syft" || rawValue.version !== RELEASE_SBOM_SYFT_VERSION) {
    throw new Error(`release SBOM generation requires Syft ${RELEASE_SBOM_SYFT_VERSION}`);
  }
}

function main(): void {
  const argv = process.argv.slice(2);
  const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const packageJson = JSON.parse(readFileSync(resolve(repositoryRoot, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
    version?: string;
  };
  if (!packageJson.version) throw new Error("package.json has no version");

  const artifactRoot = realpathSync(requiredOption(argv, "--artifact-root"));
  const artifactCandidate = resolve(artifactRoot, requiredOption(argv, "--artifact"));
  if (!inside(artifactRoot, artifactCandidate)) throw new Error("release artifact must remain inside artifact root");
  const artifactCandidateStat = lstatSync(artifactCandidate);
  if (artifactCandidateStat.isSymbolicLink()) throw new Error("release artifact must not be a symlink");
  const artifact = realpathSync(artifactCandidate);
  if (!inside(artifactRoot, artifact)) throw new Error("release artifact must remain inside artifact root");
  const artifactStat = lstatSync(artifact);
  if (!artifactStat.isFile() || artifactStat.isSymbolicLink()) {
    throw new Error("release artifact must be a regular non-symlink file");
  }
  const outputCandidate = resolve(argv.includes("--output")
    ? requiredOption(argv, "--output")
    : `${artifact}.cdx.json`);
  const output = resolve(realpathSync(dirname(outputCandidate)), basename(outputCandidate));
  if (!inside(artifactRoot, output) || output === artifact) {
    throw new Error("SBOM output must be distinct from the artifact and remain inside artifact root");
  }
  if (existsSync(output) && lstatSync(output).isSymbolicLink()) {
    throw new Error("SBOM output must not be a symlink");
  }

  const sourceCommit = requiredOption(argv, "--source-commit");
  const actualCommit = commandOutput("git", ["rev-parse", "HEAD"], repositoryRoot);
  if (sourceCommit !== actualCommit) throw new Error("source commit does not match the checked-out HEAD");
  if (commandOutput("git", ["status", "--porcelain=v1", "--untracked-files=all"], repositoryRoot)) {
    throw new Error("release SBOM generation requires a clean source worktree");
  }
  validateSyftVersion(JSON.parse(commandOutput("syft", ["version", "--output", "json"], repositoryRoot)) as unknown);
  const syft = spawnSync("syft", [
    `dir:${repositoryRoot}`,
    "--source-name", "shellx",
    "--source-version", packageJson.version,
    "--exclude", "./node_modules/**",
    "--exclude", "./dist/**",
    "--exclude", "./src-tauri/target/**",
    "--exclude", "./.git/**",
    "--exclude", "./vendor/shellx-vault/Cargo.lock",
    "-o", RELEASE_SBOM_CYCLONEDX_FORMAT,
  ], { cwd: repositoryRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (syft.error) throw new Error(`unable to run Syft: ${syft.error.message}`);
  if (syft.status !== 0) throw new Error(`Syft failed: ${(syft.stderr || syft.stdout).trim()}`);

  const artifactName = relative(artifactRoot, artifact).split(sep).join("/");
  const normalized = normalizeReleaseSbom(JSON.parse(syft.stdout) as unknown, {
    artifactName,
    artifactSha256: sha256(readFileSync(artifact)),
    directNpmDependencies: Object.keys(packageJson.dependencies ?? {}),
    repositoryRoot,
    sourceCommit,
    version: packageJson.version,
  });
  const serialized = `${JSON.stringify(normalized, null, 2)}\n`;
  writeFileSync(output, serialized, { encoding: "utf8", flag: "w", mode: 0o644 });
  console.log(`wrote ${output} (${objectArray(normalized.components).length + 1} components; artifact ${basename(artifact)})`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
