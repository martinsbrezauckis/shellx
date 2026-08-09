import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  rmdirSync,
  unlinkSync,
} from "node:fs";
import { arch, homedir, release, tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import type { ReleaseSurfaceFileIdentity } from "./release-surface-candidate-attestation";
import type { ReleaseSurfaceInstallationSystemEffect } from "./release-surface-installation-receipt";
import {
  collectReleaseSurfaceInstalledPayloadManifest,
  sameReleaseSurfaceInstalledPayloadManifest,
  type ReleaseSurfaceInstalledPayloadManifest,
} from "./release-surface-installed-payload-manifest";

export const RELEASE_SURFACE_LINUX_DEB_INSTALLATION_SCHEMA =
  "shellx/release-surface-linux-deb-installation@1";
export const RELEASE_SURFACE_LINUX_DEB_PACKAGE_NAME = "shell-x";
export const RELEASE_SURFACE_LINUX_DEB_FINALIZATION_SCHEMA =
  "shellx/release-surface-linux-deb-finalization@1";
export const RELEASE_SURFACE_LINUX_DEB_MAIN_EXECUTABLE = "usr/bin/shellx";

const DPKG_DEB = "/usr/bin/dpkg-deb";
const PACKAGE_DATABASE = "/var/lib/dpkg/status";
const CONTROL_SCRIPTS = new Set(["preinst", "postinst", "prerm", "postrm", "config", "triggers"]);

export interface ReleaseSurfaceLinuxHostState {
  packageDatabaseSha256: string;
  shellxProcessIds: number[];
  integrationTargetsPresent: string[];
}

export interface ReleaseSurfaceLinuxDebInstallationObservation {
  schema: typeof RELEASE_SURFACE_LINUX_DEB_INSTALLATION_SCHEMA;
  collector: "linux-dpkg-deb-owned-root-v1";
  environment: "native-linux" | "wsl-fixture";
  observedAt: string;
  kernelRelease: string;
  architecture: string;
  userId: number;
  userIsRoot: false;
  artifact: ReleaseSurfaceFileIdentity & {
    path: string;
    pathSha256: string;
  };
  package: {
    format: "deb";
    name: typeof RELEASE_SURFACE_LINUX_DEB_PACKAGE_NAME;
    version: string;
    architecture: "amd64" | "arm64";
    installedSizeKiB: number;
    mainExecutableRelativePath: typeof RELEASE_SURFACE_LINUX_DEB_MAIN_EXECUTABLE;
    controlScriptsPresent: string[];
  };
  operation: {
    startedAt: string;
    completedAt: string;
    exitCode: 0;
    targetRootStateBefore: "absent";
    mode: "data-payload-extraction";
    tool: "dpkg-deb";
    toolVersion: string;
    arguments: ["--extract", "<exact-deb-artifact>", "<redacted-run-owned-target>"];
    maintainerScriptsExecuted: false;
    systemPackageDatabaseMutated: false;
  };
  targetRootSha256: string;
  safety: {
    before: ReleaseSurfaceLinuxHostState;
    after: ReleaseSurfaceLinuxHostState;
    runRootEntriesAfter: ["<receipt-owned-target>"];
  };
  systemEffects: ReleaseSurfaceInstallationSystemEffect[];
}

export interface ReleaseSurfaceLinuxDebFinalizationEvidence {
  schema: typeof RELEASE_SURFACE_LINUX_DEB_FINALIZATION_SCHEMA;
  platform: "linux-installed";
  sourceCommit: string;
  version: string;
  createdAt: string;
  installationReceipt: ReleaseSurfaceFileIdentity;
  targetRootSha256: string;
  removedFiles: number;
  removedDirectories: number;
  targetRemoved: true;
  runRootRemoved: true;
  recursiveDeleteUsed: false;
  activeTargetProcessIds: [];
  hostStateUnchanged: true;
}

export function collectReleaseSurfaceLinuxDebInstallation(input: {
  artifactPath: string;
  targetRoot: string;
  expectedVersion: string;
}): ReleaseSurfaceLinuxDebInstallationObservation {
  const artifactPath = resolve(input.artifactPath);
  const targetRoot = resolve(input.targetRoot);
  validateExpectedVersion(input.expectedVersion);
  const runRoot = assertOwnedLinuxRunRoot(targetRoot, artifactPath);
  const userId = currentUserId();
  const artifact = identifyRegularFile(artifactPath, "Linux Debian distribution artifact");
  if (!artifact.basename.endsWith(".deb")) throw new Error("Linux package artifact must use the .deb format");
  const packageFields = inspectDebPackage(artifactPath);
  if (packageFields.name !== RELEASE_SURFACE_LINUX_DEB_PACKAGE_NAME) {
    throw new Error(`Linux Debian package name must be ${RELEASE_SURFACE_LINUX_DEB_PACKAGE_NAME}`);
  }
  if (packageFields.version !== input.expectedVersion) throw new Error("Linux Debian package version does not match the frozen version");
  const expectedArchitecture = releaseSurfaceDebArchitecture();
  if (packageFields.architecture !== expectedArchitecture) {
    throw new Error(`Linux Debian package architecture must be ${expectedArchitecture}`);
  }
  const controlScriptsPresent = inspectDebControlScripts(artifactPath);
  const before = collectReleaseSurfaceLinuxHostState();
  assertCleanLinuxHostBaseline(before);
  const startedAt = new Date().toISOString();
  mkdirSync(targetRoot, { mode: 0o700 });
  chmodSync(targetRoot, 0o700);
  const result = spawnSync(DPKG_DEB, ["--extract", artifactPath, targetRoot], {
    encoding: "utf8",
    timeout: 5 * 60_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  const completedAt = new Date().toISOString();
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || "dpkg-deb extraction failed").trim());
  }
  assertRegularOwnedPayloadTree(targetRoot);
  const runRootEntries = readdirSync(runRoot).sort();
  if (runRootEntries.length !== 1 || runRootEntries[0] !== basename(targetRoot)) {
    throw new Error("Linux Debian package wrote outside its receipt-owned target; preserving the poisoned run root");
  }
  const mainExecutable = join(targetRoot, ...RELEASE_SURFACE_LINUX_DEB_MAIN_EXECUTABLE.split("/"));
  const mainStat = lstatSync(mainExecutable);
  if (mainStat.isSymbolicLink() || !mainStat.isFile() || mainStat.size <= 0 || (mainStat.mode & 0o111) === 0) {
    throw new Error("Linux Debian package main executable is missing, empty, linked, or non-executable");
  }
  const after = collectReleaseSurfaceLinuxHostState();
  if (JSON.stringify(after) !== JSON.stringify(before)) {
    throw new Error("Linux Debian owned-root extraction changed host package, process, or integration state");
  }
  const artifactAfter = identifyRegularFile(artifactPath, "Linux Debian distribution artifact after extraction");
  if (JSON.stringify(artifactAfter) !== JSON.stringify(artifact)) {
    throw new Error("Linux Debian distribution artifact changed during extraction");
  }
  const systemEffects = linuxDebSystemEffects(before, after, controlScriptsPresent);
  const observation: ReleaseSurfaceLinuxDebInstallationObservation = {
    schema: RELEASE_SURFACE_LINUX_DEB_INSTALLATION_SCHEMA,
    collector: "linux-dpkg-deb-owned-root-v1",
    environment: isWsl() ? "wsl-fixture" : "native-linux",
    observedAt: new Date().toISOString(),
    kernelRelease: release(),
    architecture: arch(),
    userId,
    userIsRoot: false,
    artifact: {
      ...artifact,
      path: artifactPath,
      pathSha256: releaseSurfaceLinuxPathDigest(artifactPath),
    },
    package: {
      format: "deb",
      name: RELEASE_SURFACE_LINUX_DEB_PACKAGE_NAME,
      version: packageFields.version,
      architecture: packageFields.architecture,
      installedSizeKiB: packageFields.installedSizeKiB,
      mainExecutableRelativePath: RELEASE_SURFACE_LINUX_DEB_MAIN_EXECUTABLE,
      controlScriptsPresent,
    },
    operation: {
      startedAt,
      completedAt,
      exitCode: 0,
      targetRootStateBefore: "absent",
      mode: "data-payload-extraction",
      tool: "dpkg-deb",
      toolVersion: dpkgDebVersion(),
      arguments: ["--extract", "<exact-deb-artifact>", "<redacted-run-owned-target>"],
      maintainerScriptsExecuted: false,
      systemPackageDatabaseMutated: false,
    },
    targetRootSha256: releaseSurfaceLinuxPathDigest(targetRoot),
    safety: {
      before,
      after,
      runRootEntriesAfter: ["<receipt-owned-target>"],
    },
    systemEffects,
  };
  const errors = validateReleaseSurfaceLinuxDebInstallationObservation({
    observation,
    artifact,
    artifactPath,
    targetRoot,
    expectedVersion: input.expectedVersion,
    allowWslFixture: true,
  });
  if (errors.length > 0) throw new Error(`Linux Debian installation observation is invalid: ${errors.join("; ")}`);
  return observation;
}

export function validateReleaseSurfaceLinuxDebInstallationObservation(input: {
  observation: ReleaseSurfaceLinuxDebInstallationObservation;
  artifact: ReleaseSurfaceFileIdentity;
  artifactPath: string;
  targetRoot: string;
  expectedVersion: string;
  allowWslFixture?: boolean;
}): string[] {
  const { observation, artifact, artifactPath, targetRoot, expectedVersion } = input;
  const errors: string[] = [];
  if (observation?.schema !== RELEASE_SURFACE_LINUX_DEB_INSTALLATION_SCHEMA) {
    errors.push(`Linux Debian observation schema must be ${RELEASE_SURFACE_LINUX_DEB_INSTALLATION_SCHEMA}`);
  }
  if (observation?.collector !== "linux-dpkg-deb-owned-root-v1") errors.push("Linux Debian collector is invalid");
  if (observation?.environment !== "native-linux"
    && !(input.allowWslFixture && observation?.environment === "wsl-fixture")) {
    errors.push("Linux Debian release evidence requires a native non-WSL Linux host");
  }
  if (!Number.isFinite(Date.parse(observation?.observedAt))) errors.push("Linux Debian observedAt is invalid");
  if (!observation?.kernelRelease?.trim() || !observation?.architecture?.trim()) errors.push("Linux Debian host identity is incomplete");
  if (!Number.isSafeInteger(observation?.userId) || observation.userId <= 0 || observation?.userIsRoot !== false) {
    errors.push("Linux Debian installation requires a non-root disposable user");
  }
  if (observation?.artifact?.basename !== artifact.basename
    || observation?.artifact?.sha256 !== artifact.sha256
    || observation?.artifact?.bytes !== artifact.bytes
    || observation?.artifact?.path !== resolve(artifactPath)
    || observation?.artifact?.pathSha256 !== releaseSurfaceLinuxPathDigest(artifactPath)) {
    errors.push("Linux Debian observation does not bind the exact distribution artifact");
  }
  if (observation?.package?.format !== "deb"
    || observation?.package?.name !== RELEASE_SURFACE_LINUX_DEB_PACKAGE_NAME
    || observation?.package?.version !== expectedVersion
    || !(observation?.package?.architecture === "amd64" || observation?.package?.architecture === "arm64")
    || !Number.isSafeInteger(observation?.package?.installedSizeKiB) || observation.package.installedSizeKiB <= 0
    || observation?.package?.mainExecutableRelativePath !== RELEASE_SURFACE_LINUX_DEB_MAIN_EXECUTABLE
    || !validControlScripts(observation?.package?.controlScriptsPresent)) {
    errors.push("Linux Debian package metadata is invalid or does not match the frozen candidate");
  }
  const started = Date.parse(observation?.operation?.startedAt);
  const completed = Date.parse(observation?.operation?.completedAt);
  if (!Number.isFinite(started) || !Number.isFinite(completed) || completed < started
    || observation?.operation?.exitCode !== 0
    || observation?.operation?.targetRootStateBefore !== "absent"
    || observation?.operation?.mode !== "data-payload-extraction"
    || observation?.operation?.tool !== "dpkg-deb"
    || !observation?.operation?.toolVersion?.trim()
    || JSON.stringify(observation?.operation?.arguments)
      !== JSON.stringify(["--extract", "<exact-deb-artifact>", "<redacted-run-owned-target>"])
    || observation?.operation?.maintainerScriptsExecuted !== false
    || observation?.operation?.systemPackageDatabaseMutated !== false) {
    errors.push("Linux Debian extraction operation is incomplete or unsafe");
  }
  if (observation?.targetRootSha256 !== releaseSurfaceLinuxPathDigest(targetRoot)) {
    errors.push("Linux Debian observation target identity does not match the receipt-owned root");
  }
  errors.push(...validateLinuxHostState("before", observation?.safety?.before));
  errors.push(...validateLinuxHostState("after", observation?.safety?.after));
  if (JSON.stringify(observation?.safety?.before) !== JSON.stringify(observation?.safety?.after)) {
    errors.push("Linux Debian host state changed during owned-root extraction");
  }
  if (JSON.stringify(observation?.safety?.runRootEntriesAfter) !== JSON.stringify(["<receipt-owned-target>"])) {
    errors.push("Linux Debian run root contains unexpected extraction output");
  }
  const expectedEffects = linuxDebSystemEffects(
    observation?.safety?.before,
    observation?.safety?.after,
    observation?.package?.controlScriptsPresent ?? [],
  );
  if (JSON.stringify(observation?.systemEffects) !== JSON.stringify(expectedEffects)) {
    errors.push("Linux Debian structured system-effect claims do not match the native observation");
  }
  return errors;
}

export function collectReleaseSurfaceLinuxHostState(): ReleaseSurfaceLinuxHostState {
  const packageDatabase = lstatSync(PACKAGE_DATABASE);
  if (packageDatabase.isSymbolicLink() || !packageDatabase.isFile() || packageDatabase.size <= 0) {
    throw new Error("Linux dpkg status database must be a non-empty regular non-link file");
  }
  const packageDatabaseSha256 = createHash("sha256").update(readFileSync(PACKAGE_DATABASE)).digest("hex");
  const shellxProcessIds = readdirSync("/proc").filter((entry) => /^[1-9][0-9]*$/.test(entry)).flatMap((entry) => {
    try {
      const command = readFileSync(`/proc/${entry}/comm`, "utf8").trim().toLowerCase();
      let executable = "";
      try {
        executable = basename(readlinkSync(`/proc/${entry}/exe`)).toLowerCase();
      } catch (error) {
        if (!(["ENOENT", "EACCES", "EPERM"] as Array<string | undefined>).includes((error as NodeJS.ErrnoException).code)) throw error;
      }
      return command === "shellx" || executable === "shellx" ? [Number(entry)] : [];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }).sort((left, right) => left - right);
  const integrationTargetsPresent = linuxIntegrationTargets().filter((target) => target.paths.some((path) => existsSync(path)))
    .map((target) => target.id)
    .sort();
  return { packageDatabaseSha256, shellxProcessIds, integrationTargetsPresent };
}

export function findReleaseSurfaceLinuxTargetProcesses(targetRoot: string): number[] {
  const root = `${resolve(targetRoot)}${sep}`;
  return readdirSync("/proc").filter((entry) => /^[1-9][0-9]*$/.test(entry)).flatMap((entry) => {
    try {
      const executable = readlinkSync(`/proc/${entry}/exe`).replace(/ \(deleted\)$/, "");
      const resolvedExecutable = resolve(executable);
      return resolvedExecutable.startsWith(root) ? [Number(entry)] : [];
    } catch (error) {
      if ((["ENOENT", "EACCES", "EPERM"] as Array<string | undefined>).includes((error as NodeJS.ErrnoException).code)) return [];
      throw error;
    }
  }).sort((left, right) => left - right);
}

export function removeReleaseSurfaceLinuxManifestTarget(input: {
  targetRoot: string;
  manifest: ReleaseSurfaceInstalledPayloadManifest;
}): { removedFiles: number; removedDirectories: number } {
  const targetRoot = resolve(input.targetRoot);
  const current = collectReleaseSurfaceInstalledPayloadManifest({
    nodeRootPath: targetRoot,
    recordedRootPath: input.manifest.rootPath,
    platform: "linux-installed",
    scope: "installer-target-root",
    mainExecutableRelativePath: input.manifest.mainExecutableRelativePath,
  });
  if (!sameReleaseSurfaceInstalledPayloadManifest(input.manifest, current)) {
    throw new Error("Linux installed payload changed after candidate testing; refusing finalization");
  }
  const active = findReleaseSurfaceLinuxTargetProcesses(targetRoot);
  if (active.length > 0) throw new Error(`Linux installed payload is still active in PID ${active.join(",")}; preserving target`);
  const files = [...input.manifest.entries].filter((entry) => entry.kind === "file")
    .sort((left, right) => right.path.localeCompare(left.path));
  const directories = [...input.manifest.entries].filter((entry) => entry.kind === "directory")
    .sort((left, right) => pathDepth(right.path) - pathDepth(left.path) || right.path.localeCompare(left.path));
  for (const entry of files) unlinkSync(safeManifestPath(targetRoot, entry.path));
  for (const entry of directories) rmdirSync(safeManifestPath(targetRoot, entry.path));
  rmdirSync(targetRoot);
  if (existsSync(targetRoot)) throw new Error("Linux finalizer claimed success but the receipt-owned target remains");
  return { removedFiles: files.length, removedDirectories: directories.length + 1 };
}

export function assertNativeReleaseSurfaceLinuxHost(): void {
  if (process.platform !== "linux" || isWsl()) {
    throw new Error("Linux Debian release evidence requires a native non-WSL Linux host");
  }
  currentUserId();
}

export function releaseSurfaceLinuxPathDigest(path: string): string {
  return createHash("sha256").update(resolve(path)).digest("hex");
}

function inspectDebPackage(artifactPath: string): {
  name: string;
  version: string;
  architecture: "amd64" | "arm64";
  installedSizeKiB: number;
} {
  const output = runDpkgDeb([
    "--show",
    "--showformat=${Package}\t${Version}\t${Architecture}\t${Installed-Size}\n",
    artifactPath,
  ], "package metadata");
  const [name, version, architecture, installedSize] = output.trim().split("\t");
  if (!(architecture === "amd64" || architecture === "arm64")) {
    throw new Error("Linux Debian package architecture is unsupported");
  }
  const installedSizeKiB = Number(installedSize);
  if (!name?.trim() || !version?.trim() || !Number.isSafeInteger(installedSizeKiB) || installedSizeKiB <= 0) {
    throw new Error("Linux Debian package metadata is incomplete");
  }
  return { name, version, architecture, installedSizeKiB };
}

function inspectDebControlScripts(artifactPath: string): string[] {
  const temp = mkdtempSync(join(tmpdir(), "shellx-deb-control-"));
  const controlRoot = join(temp, "control");
  try {
    mkdirSync(controlRoot, { mode: 0o700 });
    runDpkgDeb(["--control", artifactPath, controlRoot], "control archive");
    const entries = readdirSync(controlRoot).sort();
    for (const entry of entries) {
      const stat = lstatSync(join(controlRoot, entry));
      if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("Linux Debian control archive contains a linked or special entry");
    }
    return entries.filter((entry) => CONTROL_SCRIPTS.has(entry));
  } finally {
    rmSync(temp, { recursive: true, force: false });
  }
}

function linuxDebSystemEffects(
  before: ReleaseSurfaceLinuxHostState,
  after: ReleaseSurfaceLinuxHostState,
  controlScriptsPresent: string[],
): ReleaseSurfaceInstallationSystemEffect[] {
  return [
    {
      id: "linux-package-database-unchanged",
      status: "pass",
      observed: "The dpkg status database digest was unchanged by owned-root data extraction.",
      details: {
        backend: "dpkg-status",
        beforeSha256: before?.packageDatabaseSha256,
        afterSha256: after?.packageDatabaseSha256,
      },
    },
    {
      id: "linux-process-autolaunch-absent",
      status: "pass",
      observed: "No ShellX process existed before or appeared after package extraction.",
      details: {
        beforeProcessIds: before?.shellxProcessIds,
        afterProcessIds: after?.shellxProcessIds,
      },
    },
    {
      id: "linux-host-integration-unchanged",
      status: "pass",
      observed: "Known host desktop, autostart, and service targets remained absent.",
      details: {
        targetsChecked: linuxIntegrationTargets().map((target) => target.id),
        beforePresent: before?.integrationTargetsPresent,
        afterPresent: after?.integrationTargetsPresent,
      },
    },
    {
      id: "linux-maintainer-scripts-not-executed",
      status: "pass",
      observed: "Control scripts were inventoried while dpkg-deb extracted only the package data payload.",
      details: {
        scriptsPresent: controlScriptsPresent,
        executionMode: "data-payload-extraction",
        executed: false,
      },
    },
  ];
}

function validateLinuxHostState(label: string, state: ReleaseSurfaceLinuxHostState | undefined): string[] {
  const errors: string[] = [];
  if (!/^[a-f0-9]{64}$/.test(state?.packageDatabaseSha256 ?? "")) errors.push(`Linux Debian ${label} package database digest is invalid`);
  if (!Array.isArray(state?.shellxProcessIds) || state.shellxProcessIds.length !== 0) {
    errors.push(`Linux Debian ${label} state must have no ShellX process`);
  }
  if (!Array.isArray(state?.integrationTargetsPresent) || state.integrationTargetsPresent.length !== 0) {
    errors.push(`Linux Debian ${label} state must have no pre-existing host integration target`);
  }
  return errors;
}

function assertCleanLinuxHostBaseline(state: ReleaseSurfaceLinuxHostState): void {
  const errors = validateLinuxHostState("baseline", state);
  if (errors.length > 0) throw new Error(`Linux Debian release fixture is not isolated: ${errors.join("; ")}`);
}

function assertOwnedLinuxRunRoot(targetRoot: string, artifactPath: string): string {
  if (!targetRoot.startsWith("/") || targetRoot === "/" || targetRoot.includes("\\") || targetRoot.endsWith("/")
    || targetRoot.includes("//") || targetRoot.slice(1).split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error("Linux Debian target root must be a canonical non-root absolute path");
  }
  if (!/^shellx-final-install-[A-Za-z0-9._-]+$/.test(basename(targetRoot))) {
    throw new Error("Linux Debian target root must name one shellx-final-install-* directory");
  }
  const runRoot = dirname(targetRoot);
  if (!/^shellx-final-linux-run-[A-Za-z0-9._-]+$/.test(basename(runRoot))) {
    throw new Error("Linux Debian target parent must name one shellx-final-linux-run-* owned root");
  }
  assertNoSymlinkAncestry(runRoot, "Linux Debian run root");
  const stat = lstatSync(runRoot);
  const userId = currentUserId();
  if (stat.isSymbolicLink() || !stat.isDirectory() || stat.uid !== userId || (stat.mode & 0o077) !== 0) {
    throw new Error("Linux Debian run root must be a mode-0700 directory owned by the current non-root user");
  }
  if (readdirSync(runRoot).length !== 0) throw new Error("Linux Debian run root must be empty before extraction");
  if (existsSync(targetRoot)) throw new Error("Linux Debian target root must be absent before extraction");
  if (artifactPath === runRoot || artifactPath.startsWith(`${runRoot}${sep}`)) {
    throw new Error("Linux Debian artifact must be outside the empty receipt-owned run root");
  }
  return runRoot;
}

function assertRegularOwnedPayloadTree(root: string): void {
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory)) {
      const path = join(directory, entry);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error("Linux Debian payload contains a symbolic link; preserving target for diagnosis");
      if (stat.isDirectory()) walk(path);
      else if (!stat.isFile()) throw new Error("Linux Debian payload contains an unsupported special file; preserving target for diagnosis");
    }
  };
  walk(root);
}

function identifyRegularFile(path: string, label: string): ReleaseSurfaceFileIdentity {
  assertNoSymlinkAncestry(path, label);
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size <= 0) throw new Error(`${label} must be a non-empty regular non-link file`);
  const bytes = readFileSync(path);
  return { basename: basename(path), sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length };
}

function assertNoSymlinkAncestry(path: string, label: string): void {
  let current = resolve(path);
  while (true) {
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error(`${label} must not have a symlink in its ancestry`);
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

function safeManifestPath(targetRoot: string, relativePath: string): string {
  const path = resolve(targetRoot, relativePath);
  const prefix = `${resolve(targetRoot)}${sep}`;
  if (!path.startsWith(prefix) || relative(targetRoot, path).startsWith("..")) {
    throw new Error("Linux finalizer manifest path escapes the receipt-owned target");
  }
  return path;
}

function runDpkgDeb(args: string[], label: string): string {
  const result = spawnSync(DPKG_DEB, args, {
    encoding: "utf8",
    timeout: 60_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error((result.stderr || result.stdout || `dpkg-deb ${label} failed`).trim());
  return result.stdout;
}

function dpkgDebVersion(): string {
  const first = runDpkgDeb(["--version"], "version probe").split(/\r?\n/)[0]?.trim();
  if (!first) throw new Error("dpkg-deb version probe returned no identity");
  return first.slice(0, 256);
}

function releaseSurfaceDebArchitecture(): "amd64" | "arm64" {
  if (process.arch === "x64") return "amd64";
  if (process.arch === "arm64") return "arm64";
  throw new Error(`Linux Debian release adapter does not support ${process.arch}`);
}

function currentUserId(): number {
  const userId = process.getuid?.();
  if (!Number.isSafeInteger(userId) || Number(userId) <= 0) throw new Error("Linux Debian installation requires a non-root user identity");
  return Number(userId);
}

function validateExpectedVersion(value: string): void {
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$/.test(value)) {
    throw new Error("Linux Debian expected version is invalid");
  }
}

function validControlScripts(value: string[] | undefined): boolean {
  return Array.isArray(value) && JSON.stringify(value) === JSON.stringify([...value].sort())
    && new Set(value).size === value.length && value.every((entry) => CONTROL_SCRIPTS.has(entry));
}

function isWsl(): boolean {
  return Boolean(process.env.WSL_INTEROP?.trim() || process.env.WSL_DISTRO_NAME?.trim()
    || readFileSync("/proc/sys/kernel/osrelease", "utf8").toLowerCase().includes("microsoft"));
}

function pathDepth(path: string): number {
  return path.split("/").length;
}

function linuxIntegrationTargets(): Array<{ id: string; paths: string[] }> {
  const home = homedir();
  const names = ["shellx", "shellX"];
  return [
    { id: "user-autostart", paths: names.map((name) => join(home, ".config", "autostart", `${name}.desktop`)) },
    { id: "user-desktop-entry", paths: names.map((name) => join(home, ".local", "share", "applications", `${name}.desktop`)) },
    { id: "user-systemd-service", paths: names.map((name) => join(home, ".config", "systemd", "user", `${name}.service`)) },
    { id: "system-autostart", paths: names.map((name) => join("/etc", "xdg", "autostart", `${name}.desktop`)) },
    { id: "system-desktop-entry", paths: names.map((name) => join("/usr", "share", "applications", `${name}.desktop`)) },
    { id: "system-systemd-service", paths: names.flatMap((name) => [
      join("/etc", "systemd", "system", `${name}.service`),
      join("/usr", "lib", "systemd", "system", `${name}.service`),
      join("/usr", "lib", "systemd", "user", `${name}.service`),
    ]) },
  ];
}
