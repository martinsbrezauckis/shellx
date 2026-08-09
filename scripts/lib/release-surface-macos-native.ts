import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ReleaseSurfaceFileIdentity } from "./release-surface-candidate-attestation";
import {
  RELEASE_SURFACE_MACOS_APP_BASENAME,
  RELEASE_SURFACE_MACOS_BUNDLE_ID,
  RELEASE_SURFACE_MACOS_DEVELOPER_ID_AUTHORITY,
  RELEASE_SURFACE_MACOS_TEAM_ID,
  type ReleaseSurfaceNativeSignatureVerification,
} from "./release-surface-signature-receipt";

export interface ReleaseSurfaceMacosMountedImage {
  deviceEntry: string;
  mountPoint: string;
  volumeName: string;
  mountedAt: string;
}

interface MacosCodesignMetadata {
  identifier: string;
  teamIdentifier: string;
  authorities: string[];
  secureTimestamp: boolean;
  hardenedRuntime: boolean;
}

interface CommandResult {
  stdout: string;
  stderr: string;
}

export function identifyReleaseSurfaceRegularFile(path: string, label: string): ReleaseSurfaceFileIdentity {
  const absolute = resolve(path);
  const stat = lstatSync(absolute);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size <= 0) {
    throw new Error(`${label} must be a non-empty regular non-link file: ${absolute}`);
  }
  const bytes = readFileSync(absolute);
  return {
    basename: basename(absolute),
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.length,
  };
}

export function assertReleaseSurfaceNoSymlinkAncestry(path: string, label: string): void {
  let current = resolve(path);
  while (true) {
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error(`${label} must not have a symlink in its ancestry: ${current}`);
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

export function parseReleaseSurfaceHdiutilAttachJson(value: unknown): ReleaseSurfaceMacosMountedImage {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("hdiutil attach output must be one property-list object");
  }
  const entities = (value as { "system-entities"?: unknown })["system-entities"];
  if (!Array.isArray(entities)) throw new Error("hdiutil attach output has no system entities");
  const mounted = entities.filter((entry): entry is Record<string, unknown> => Boolean(
    entry && typeof entry === "object" && !Array.isArray(entry)
      && typeof (entry as Record<string, unknown>)["mount-point"] === "string",
  ));
  if (mounted.length !== 1) throw new Error("DMG must expose exactly one mounted filesystem");
  const entity = mounted[0]!;
  const deviceEntry = String(entity["dev-entry"] ?? "");
  const mountPoint = String(entity["mount-point"] ?? "");
  const volumeName = String(entity["volume-name"] ?? basename(mountPoint));
  if (!/^\/dev\/disk\d+(?:s\d+)?$/.test(deviceEntry)) {
    throw new Error("hdiutil mounted entity has an invalid device entry");
  }
  assertCanonicalMacosAbsolutePath(mountPoint, "hdiutil mount point");
  if (!volumeName.trim() || /[\r\n\0]/.test(volumeName)) throw new Error("hdiutil volume name is invalid");
  return { deviceEntry, mountPoint, volumeName, mountedAt: new Date().toISOString() };
}

export function parseReleaseSurfaceCodesignDisplay(output: string): MacosCodesignMetadata {
  const fields = new Map<string, string>();
  const authorities: string[] = [];
  for (const line of output.split(/\r?\n/)) {
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    const name = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (name === "Authority") authorities.push(value);
    else if (!fields.has(name)) fields.set(name, value);
  }
  const flags = fields.get("flags")
    ?? output.match(/(?:^|\s)flags=([^\s]+)/m)?.[1]
    ?? "";
  return {
    identifier: fields.get("Identifier") ?? "",
    teamIdentifier: fields.get("TeamIdentifier") ?? "",
    authorities,
    secureTimestamp: Boolean(fields.get("Timestamp")),
    hardenedRuntime: /(?:^|[,(])runtime(?:[),]|$)/i.test(flags),
  };
}

export function parseReleaseSurfaceGatekeeperAssessment(output: string): {
  status: "accepted";
  assessmentType: "execute";
  source: "Notarized Developer ID";
} {
  const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.some((line) => /:\s*accepted$/.test(line))) {
    throw new Error("Gatekeeper did not report accepted");
  }
  const source = lines.find((line) => line.startsWith("source="))?.slice("source=".length).trim();
  if (source !== "Notarized Developer ID") {
    throw new Error("Gatekeeper did not report the Notarized Developer ID source");
  }
  return { status: "accepted", assessmentType: "execute", source };
}

export function collectReleaseSurfaceMacosSignatureVerification(input: {
  artifactPath: string;
  artifact: ReleaseSurfaceFileIdentity;
}): Extract<ReleaseSurfaceNativeSignatureVerification, { kind: "macos-codesign" }> {
  assertMacosHost();
  const artifactPath = resolve(input.artifactPath);
  assertCanonicalMacosAbsolutePath(artifactPath, "macOS DMG artifact");
  if (basename(artifactPath) !== input.artifact.basename || !artifactPath.toLowerCase().endsWith(".dmg")) {
    throw new Error("macOS signature collection requires the exact named DMG artifact");
  }
  const mountRoot = mkdtempSync(join(tmpdir(), "shellx-final-signature-"));
  let mounted: ReleaseSurfaceMacosMountedImage | undefined;
  let detachedAt = "";
  let verification: Extract<ReleaseSurfaceNativeSignatureVerification, { kind: "macos-codesign" }> | undefined;
  let operationError: unknown;
  try {
    const attach = runMacosCommand("/usr/bin/hdiutil", [
      "attach", artifactPath, "-readonly", "-nobrowse", "-noautoopen", "-mountroot", mountRoot, "-plist",
    ], "read-only DMG attach", 2 * 60_000);
    const plist = runMacosCommand("/usr/bin/plutil", ["-convert", "json", "-o", "-", "-"],
      "hdiutil property-list conversion", 30_000, attach.stdout);
    mounted = parseReleaseSurfaceHdiutilAttachJson(JSON.parse(plist.stdout) as unknown);
    assertReleaseSurfacePathInsidePrivateRoot(mountRoot, mounted.mountPoint, "hdiutil mount point");
    const appPath = resolveMountedApplication(mounted.mountPoint);
    const infoPlist = join(appPath, "Contents", "Info.plist");
    const bundleId = runPlistRaw(infoPlist, "CFBundleIdentifier");
    const executableName = runPlistRaw(infoPlist, "CFBundleExecutable");
    if (bundleId !== RELEASE_SURFACE_MACOS_BUNDLE_ID || !validBundleExecutableName(executableName)) {
      throw new Error("mounted application Info.plist does not match the frozen bundle identity");
    }
    const executablePath = join(appPath, "Contents", "MacOS", executableName);
    const executable = identifyReleaseSurfaceRegularFile(executablePath, "mounted ShellX main executable");
    runMacosCommand("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--all-architectures", "--verbose=4", appPath],
      "deep strict application signature verification", 2 * 60_000);
    const display = runMacosCommand("/usr/bin/codesign", ["--display", "--verbose=4", appPath],
      "application signature identity collection", 30_000);
    const metadata = parseReleaseSurfaceCodesignDisplay(`${display.stdout}\n${display.stderr}`);
    if (metadata.identifier !== RELEASE_SURFACE_MACOS_BUNDLE_ID
      || metadata.teamIdentifier !== RELEASE_SURFACE_MACOS_TEAM_ID
      || !metadata.authorities.includes(RELEASE_SURFACE_MACOS_DEVELOPER_ID_AUTHORITY)
      || !metadata.secureTimestamp || !metadata.hardenedRuntime) {
      throw new Error("mounted application Developer ID metadata does not match the frozen ShellX policy");
    }
    const requirementResult = runMacosCommand("/usr/bin/codesign", ["--display", "--requirements", "-", appPath],
      "designated requirement collection", 30_000);
    const designatedRequirement = `${requirementResult.stdout}\n${requirementResult.stderr}`
      .split(/\r?\n/).map((line) => line.trim()).find((line) => line.startsWith("designated =>")) ?? "";
    if (!designatedRequirement.includes(`identifier \"${RELEASE_SURFACE_MACOS_BUNDLE_ID}\"`)
      || !designatedRequirement.includes(`subject.OU] = \"${RELEASE_SURFACE_MACOS_TEAM_ID}\"`)) {
      throw new Error("mounted application designated requirement does not bind the bundle and team identifiers");
    }
    const gatekeeperResult = runMacosCommand("/usr/sbin/spctl", ["--assess", "--type", "execute", "--verbose=4", appPath],
      "Gatekeeper application assessment", 2 * 60_000);
    const gatekeeper = parseReleaseSurfaceGatekeeperAssessment(`${gatekeeperResult.stdout}\n${gatekeeperResult.stderr}`);
    runStaplerValidate(appPath, "mounted application");
    runStaplerValidate(artifactPath, "exact disk image");
    const verifiedAt = new Date().toISOString();
    verification = {
      kind: "macos-codesign",
      collector: "macos-native-signature-v1",
      verifiedAt,
      artifact: { ...input.artifact },
      mountedImage: {
        ...mounted,
        detachedAt: "pending-finally",
        readOnly: true,
        noBrowse: true,
        noAutoOpen: true,
        detached: true,
      },
      application: {
        relativePath: RELEASE_SURFACE_MACOS_APP_BASENAME,
        bundleId: RELEASE_SURFACE_MACOS_BUNDLE_ID,
        teamId: RELEASE_SURFACE_MACOS_TEAM_ID,
        executableRelativePath: `${RELEASE_SURFACE_MACOS_APP_BASENAME}/Contents/MacOS/${executableName}`,
        executable,
        authorities: metadata.authorities,
        designatedRequirement,
        secureTimestamp: true,
        hardenedRuntime: true,
      },
      codesign: { status: "accepted", deep: true, strict: true, allArchitectures: true },
      gatekeeper,
      stapler: { application: "validated", diskImage: "validated" },
    };
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    try {
      detachedAt = detachReleaseSurfaceMacosMountedImage({ mountRoot, mounted });
    } catch (detachError) {
      if (operationError) {
        throw new AggregateError([operationError, detachError], "macOS verification failed and its private DMG mount could not be detached");
      }
      throw detachError;
    }
  }
  if (!verification || !detachedAt) throw new Error("macOS signature verification did not complete its detach lifecycle");
  verification.mountedImage.detachedAt = detachedAt;
  return verification;
}

export function detachReleaseSurfaceMacosMountedImage(input: {
  mountRoot: string;
  mounted?: ReleaseSurfaceMacosMountedImage;
}): string {
  const targets = input.mounted
    ? [input.mounted.deviceEntry]
    : readdirSync(input.mountRoot).map((name) => {
      const path = join(input.mountRoot, name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error(`private DMG mount root contains an unexpected entry: ${path}`);
      }
      return path;
    });
  for (const target of targets) {
    runMacosCommand("/usr/bin/hdiutil", ["detach", target], "exact DMG detach", 2 * 60_000);
  }
  for (const name of readdirSync(input.mountRoot)) {
    const path = join(input.mountRoot, name);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isDirectory() || readdirSync(path).length !== 0) {
      throw new Error(`private DMG mount root was not empty after detach: ${path}`);
    }
    rmdirSync(path);
  }
  rmdirSync(input.mountRoot);
  return targets.length > 0 ? new Date().toISOString() : "";
}

function runStaplerValidate(path: string, label: string): void {
  const result = runMacosCommand("/usr/bin/xcrun", ["stapler", "validate", path], `${label} staple validation`, 2 * 60_000);
  if (!`${result.stdout}\n${result.stderr}`.includes("The validate action worked!")) {
    throw new Error(`${label} stapler output did not confirm validation`);
  }
}

function runPlistRaw(path: string, key: string): string {
  const result = runMacosCommand("/usr/bin/plutil", ["-extract", key, "raw", "-o", "-", path],
    `Info.plist ${key} collection`, 30_000);
  return result.stdout.trim();
}

function runMacosCommand(
  command: string,
  args: string[],
  label: string,
  timeout: number,
  input?: string,
): CommandResult {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout,
    maxBuffer: 16 * 1024 * 1024,
    input,
  });
  if (result.error) throw new Error(`${label} could not start: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`${label} failed: ${(result.stderr || result.stdout || `exit ${result.status}`).trim()}`);
  }
  return { stdout: result.stdout, stderr: result.stderr };
}

function resolveMountedApplication(mountPoint: string): string {
  const apps = readdirSync(mountPoint).filter((name) => name.endsWith(".app"));
  if (apps.length !== 1 || apps[0] !== RELEASE_SURFACE_MACOS_APP_BASENAME) {
    throw new Error(`mounted DMG must contain exactly one top-level ${RELEASE_SURFACE_MACOS_APP_BASENAME}`);
  }
  const appPath = join(mountPoint, apps[0]);
  const stat = lstatSync(appPath);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error("mounted ShellX application must be a regular non-link directory");
  }
  return appPath;
}

export function assertReleaseSurfacePathInsidePrivateRoot(root: string, candidate: string, label: string): void {
  const delta = relative(realpathSync(root), realpathSync(candidate));
  if (!delta || delta === ".." || delta.startsWith(`..${sep}`) || isAbsolute(delta)) {
    throw new Error(`${label} must be a child of the private mount root`);
  }
}

function validBundleExecutableName(value: string): boolean {
  return Boolean(value && value === basename(value) && value !== "." && value !== ".." && !/[\/\0\r\n]/.test(value));
}

export function assertCanonicalMacosAbsolutePath(path: string, label: string): void {
  if (!path.startsWith("/") || path === "/" || path !== path.trim() || path.includes("\\")
    || path.includes("//") || path.endsWith("/") || /[\0\r\n]/.test(path)
    || path.slice(1).split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error(`${label} must be a canonical non-root absolute macOS path`);
  }
}

function assertMacosHost(): void {
  if (process.platform !== "darwin") throw new Error("macOS native release evidence requires a native macOS host");
}
