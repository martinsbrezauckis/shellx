import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
  loadReleaseSurfaceCandidateAttestation,
  type ReleaseSurfaceFileIdentity,
} from "./lib/release-surface-candidate-attestation";
import {
  RELEASE_SURFACE_DRIVER_RUN_SCHEMA,
  type ReleaseSurfaceDriverRunManifest,
} from "./lib/release-surface-driver-runner";
import {
  cleanupReleaseSurfaceRunProfile,
  releaseSurfaceProfileLaunchRootFromDebugTokenPath,
  type ReleaseSurfaceRunProfile,
} from "./lib/release-surface-run-profile";
import {
  createReleaseSurfaceCandidateTeardownReceipt,
} from "./lib/release-surface-candidate-teardown";
import {
  releaseSurfaceMacosNativeInputFileIdentity,
  validateReleaseSurfaceMacosNativeInputBinding,
} from "./lib/release-surface-macos-native-input";

if (process.platform !== "darwin") {
  throw new Error("macOS candidate finalization must run on the native Mac candidate host");
}

const root = resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const runId = requiredArg(args, "--run-id");
const candidatePath = regularFile(requiredArg(args, "--candidate-attestation"), "candidate attestation");
const driverManifestPath = regularFile(requiredArg(args, "--driver-manifest"), "driver run manifest");
const bindingPath = regularFile(requiredArg(args, "--macos-native-input-binding"), "macOS native-input binding");
const cleanupPath = createOnlyPath(requiredArg(args, "--profile-cleanup-out"), "profile cleanup output");
const teardownPath = createOnlyPath(requiredArg(args, "--candidate-teardown-out"), "candidate teardown output");

if (!/^[a-f0-9]{16,64}$/.test(runId)) throw new Error("release run id must be 16 to 64 lowercase hexadecimal characters");
const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" });
if (dirty.trim()) throw new Error("macOS candidate finalization requires a clean frozen source checkout");
const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();

const candidate = loadReleaseSurfaceCandidateAttestation(candidatePath);
if (candidate.platform !== "macos-installed" || candidate.sourceCommit !== sourceCommit) {
  throw new Error("macOS candidate attestation is not bound to the frozen source checkout");
}
const manifest = JSON.parse(readFileSync(driverManifestPath, "utf8")) as ReleaseSurfaceDriverRunManifest;
if (manifest.schema !== RELEASE_SURFACE_DRIVER_RUN_SCHEMA
  || manifest.mode !== "final-frozen-candidate"
  || manifest.targetedClosure
  || manifest.platform !== "macos-installed"
  || manifest.sourceCommit !== sourceCommit
  || manifest.version !== candidate.version) {
  throw new Error("macOS driver manifest is not bound to the exact frozen candidate");
}
const binding = loadReleaseSurfaceMacosNativeInputBinding(bindingPath);
const profileRoot = releaseSurfaceProfileLaunchRootFromDebugTokenPath(
  candidate.runtime.debugTokenPath,
  "macos-installed",
);
if (basename(profileRoot) !== `shellx-final-webdriver-${runId}`) {
  throw new Error("macOS candidate profile does not match the exact run id");
}
const helperPath = join(profileRoot, binding.helper.basename);
const liveHelper = releaseSurfaceMacosNativeInputFileIdentity(helperPath);
const bindingErrors = validateReleaseSurfaceMacosNativeInputBinding({
  evidence: binding,
  candidate,
  helperPath,
  helperIdentity: liveHelper,
});
if (bindingErrors.length > 0) {
  throw new Error(`macOS native-input binding is invalid before teardown: ${bindingErrors.join("; ")}`);
}
const bindingIdentity = fileIdentity(bindingPath);
if (!manifest.macosNativeInputBinding
  || JSON.stringify(manifest.macosNativeInputBinding) !== JSON.stringify(bindingIdentity)
  || manifest.nativeWebDriverBinding) {
  throw new Error("macOS driver manifest does not contain the exact native-input-only binding");
}

const profile: ReleaseSurfaceRunProfile = {
  schema: "shellx/release-surface-run-profile@1",
  platform: "macos-installed",
  runId,
  nodePath: profileRoot,
  launchPath: profileRoot,
  markerPath: join(profileRoot, "shellx-final-profile.json"),
  debugBase: candidate.runtime.debugBase,
  debugPort: candidate.runtime.debugPort,
  mcpBase: candidate.runtime.mcpBase,
  mcpPort: candidate.runtime.mcpPort,
  debugTokenNodePath: candidate.runtime.debugTokenPath,
  debugTokenLaunchPath: candidate.runtime.debugTokenPath,
  mcpTokenNodePath: candidate.runtime.mcpTokenPath,
  mcpTokenLaunchPath: candidate.runtime.mcpTokenPath,
  environment: {},
};

const candidateIdentity = fileIdentity(candidatePath);
const manifestIdentity = fileIdentity(driverManifestPath);
const cleanup = await cleanupReleaseSurfaceRunProfile({
  profile,
  evidencePath: cleanupPath,
  application: {
    processId: candidate.process.pid,
    executableNodePath: candidate.process.executablePath,
    executableLaunchPath: candidate.process.executablePath,
  },
});
const cleanupIdentity = fileIdentity(cleanupPath);
const teardown = createReleaseSurfaceCandidateTeardownReceipt({
  platform: "macos-installed",
  runId,
  candidateAttestation: candidate,
  candidateAttestationIdentity: candidateIdentity,
  driverRunManifest: manifest,
  driverRunManifestIdentity: manifestIdentity,
  macosNativeInputBinding: binding,
  macosNativeInputBindingIdentity: bindingIdentity,
  profileCleanup: cleanup,
  profileCleanupIdentity: cleanupIdentity,
});
writeFileSync(teardownPath, `${JSON.stringify(teardown, null, 2)}\n`, {
  encoding: "utf8",
  flag: "wx",
  mode: 0o600,
});
console.log(`Finalized the exact macOS candidate and removed its disposable profile: ${teardownPath}`);

function loadReleaseSurfaceMacosNativeInputBinding(path: string) {
  return JSON.parse(readFileSync(path, "utf8")) as import("./lib/release-surface-macos-native-input").ReleaseSurfaceMacosNativeInputBindingEvidence;
}

function fileIdentity(path: string): ReleaseSurfaceFileIdentity {
  const bytes = readFileSync(path);
  return {
    basename: basename(path),
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.length,
  };
}

function regularFile(path: string, label: string): string {
  const absolute = resolve(path);
  const stat = lstatSync(absolute);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size <= 0) {
    throw new Error(`${label} must be a non-empty regular non-link file`);
  }
  return absolute;
}

function createOnlyPath(path: string, label: string): string {
  const absolute = resolve(path);
  if (existsSync(absolute)) throw new Error(`${label} already exists`);
  const parent = lstatSync(dirname(absolute));
  if (parent.isSymbolicLink() || !parent.isDirectory()) {
    throw new Error(`${label} parent must be a regular non-link directory`);
  }
  return absolute;
}

function requiredArg(values: string[], name: string): string {
  const index = values.indexOf(name);
  const value = index >= 0 ? values[index + 1] : values.find((entry) => entry.startsWith(`${name}=`))?.slice(name.length + 1);
  if (!value?.trim()) throw new Error(`${name} is required`);
  return value;
}
