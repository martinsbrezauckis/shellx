import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  statSync,
} from "node:fs";
import { arch, release } from "node:os";
import { basename } from "node:path";

export const RELEASE_SURFACE_POSIX_NATIVE_RUNTIME_SCHEMA =
  "shellx/release-surface-posix-native-runtime@1";
export const RELEASE_SURFACE_POSIX_NATIVE_BINDING_SCHEMA =
  "shellx/release-surface-posix-native-binding@1";
export const RELEASE_SURFACE_POSIX_OBSERVATION_MAX_AGE_MS = 60_000;

export type ReleaseSurfacePosixPlatform = "linux" | "macos";

export interface ReleaseSurfacePosixNativeRuntime {
  schema: typeof RELEASE_SURFACE_POSIX_NATIVE_RUNTIME_SCHEMA;
  collector: "linux-procfs-v1" | "macos-ps-lsof-v1";
  platform: ReleaseSurfacePosixPlatform;
  observedAt: string;
  osVersion: string;
  architecture: string;
  process: {
    pid: number;
    startId: string;
    imageBasename: string;
    imagePathSha256: string;
    imageSha256: string;
    imageBytes: number;
    imageFileId: string;
  };
  listener: {
    address: "127.0.0.1";
    port: number;
    owningPid: number;
    socketId?: string;
  };
}

export interface ReleaseSurfacePosixNativeBinding {
  schema: typeof RELEASE_SURFACE_POSIX_NATIVE_BINDING_SCHEMA;
  platform: ReleaseSurfacePosixPlatform;
  process: ReleaseSurfacePosixNativeRuntime["process"];
  listener: ReleaseSurfacePosixNativeRuntime["listener"];
}

interface PosixSnapshot {
  process: ReleaseSurfacePosixNativeRuntime["process"];
  listener: ReleaseSurfacePosixNativeRuntime["listener"];
}

export function collectReleaseSurfacePosixNativeRuntime(input: {
  platform: ReleaseSurfacePosixPlatform;
  processId: number;
  port: number;
}): ReleaseSurfacePosixNativeRuntime {
  validateCollectorInput(input);
  const expectedNodePlatform = input.platform === "linux" ? "linux" : "darwin";
  if (process.platform !== expectedNodePlatform) {
    throw new Error(`${input.platform} native runtime collection requires a native ${input.platform} host`);
  }
  const collect = input.platform === "linux" ? collectLinuxSnapshot : collectMacosSnapshot;
  const before = collect(input.processId, input.port);
  const observedAt = new Date().toISOString();
  const after = collect(input.processId, input.port);
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    throw new Error("POSIX process, executable, or listener identity changed during native collection");
  }
  const observation: ReleaseSurfacePosixNativeRuntime = {
    schema: RELEASE_SURFACE_POSIX_NATIVE_RUNTIME_SCHEMA,
    collector: input.platform === "linux" ? "linux-procfs-v1" : "macos-ps-lsof-v1",
    platform: input.platform,
    observedAt,
    osVersion: release(),
    architecture: arch(),
    ...before,
  };
  const errors = validateReleaseSurfacePosixNativeRuntime(observation, input);
  if (errors.length > 0) throw new Error(`POSIX native runtime evidence is invalid: ${errors.join("; ")}`);
  return observation;
}

export function validateReleaseSurfacePosixNativeRuntime(
  observation: ReleaseSurfacePosixNativeRuntime,
  expected: {
    platform: ReleaseSurfacePosixPlatform;
    processId: number;
    port: number;
    imagePath?: string;
    imageSha256?: string;
  },
): string[] {
  const errors: string[] = [];
  if (observation?.schema !== RELEASE_SURFACE_POSIX_NATIVE_RUNTIME_SCHEMA) {
    errors.push(`schema must be ${RELEASE_SURFACE_POSIX_NATIVE_RUNTIME_SCHEMA}`);
  }
  const expectedCollector = expected.platform === "linux" ? "linux-procfs-v1" : "macos-ps-lsof-v1";
  if (observation?.collector !== expectedCollector) errors.push(`collector must be ${expectedCollector}`);
  if (observation?.platform !== expected.platform) errors.push("platform does not match the candidate");
  if (!Number.isFinite(Date.parse(observation?.observedAt))) errors.push("observedAt must be a valid ISO timestamp");
  if (!observation?.osVersion?.trim()) errors.push("osVersion is required");
  if (!observation?.architecture?.trim()) errors.push("architecture is required");
  if (observation?.process?.pid !== expected.processId) errors.push("process PID does not match");
  if (!validStartId(observation?.process?.startId, expected.platform)) errors.push("process startId is invalid");
  if (!validBasename(observation?.process?.imageBasename)) errors.push("process imageBasename is invalid");
  if (!isSha256(observation?.process?.imagePathSha256)) errors.push("process imagePathSha256 is invalid");
  if (!isSha256(observation?.process?.imageSha256)) errors.push("process imageSha256 is invalid");
  if (!Number.isSafeInteger(observation?.process?.imageBytes) || observation.process.imageBytes <= 0) {
    errors.push("process imageBytes must be positive");
  }
  if (!/^[a-f0-9]+:[a-f0-9]+$/.test(observation?.process?.imageFileId ?? "")) {
    errors.push("process imageFileId is invalid");
  }
  if (expected.imagePath
    && observation?.process?.imagePathSha256 !== releaseSurfacePosixPathDigest(expected.imagePath)) {
    errors.push("process image path identity does not match");
  }
  if (expected.imageSha256 && observation?.process?.imageSha256 !== expected.imageSha256.toLowerCase()) {
    errors.push("process imageSha256 does not match");
  }
  if (observation?.listener?.address !== "127.0.0.1") errors.push("listener must bind exact IPv4 loopback");
  if (observation?.listener?.port !== expected.port) errors.push("listener port does not match");
  if (observation?.listener?.owningPid !== expected.processId) errors.push("listener owner does not match the candidate PID");
  if (expected.platform === "linux" && !/^inode:[1-9][0-9]*$/.test(observation?.listener?.socketId ?? "")) {
    errors.push("Linux listener socketId is invalid");
  }
  if (expected.platform === "macos" && observation?.listener?.socketId !== undefined) {
    errors.push("macOS listener must not carry an unverifiable socketId");
  }
  return errors;
}

export function toReleaseSurfacePosixNativeBinding(
  observation: ReleaseSurfacePosixNativeRuntime,
): ReleaseSurfacePosixNativeBinding {
  return {
    schema: RELEASE_SURFACE_POSIX_NATIVE_BINDING_SCHEMA,
    platform: observation.platform,
    process: { ...observation.process },
    listener: { ...observation.listener },
  };
}

export function validateReleaseSurfacePosixRuntimeBinding(
  binding: ReleaseSurfacePosixNativeBinding,
  observed?: ReleaseSurfacePosixNativeRuntime,
): string[] {
  const errors: string[] = [];
  if (binding?.schema !== RELEASE_SURFACE_POSIX_NATIVE_BINDING_SCHEMA) {
    errors.push(`POSIX runtime binding schema must be ${RELEASE_SURFACE_POSIX_NATIVE_BINDING_SCHEMA}`);
  }
  if (!(binding?.platform === "linux" || binding?.platform === "macos")) errors.push("POSIX runtime binding platform is invalid");
  if (!Number.isSafeInteger(binding?.process?.pid) || binding.process.pid <= 0) errors.push("POSIX runtime binding PID must be positive");
  if (!validStartId(binding?.process?.startId, binding?.platform)) errors.push("POSIX runtime binding startId is invalid");
  if (!validBasename(binding?.process?.imageBasename)) errors.push("POSIX runtime binding imageBasename is invalid");
  if (!isSha256(binding?.process?.imagePathSha256)) errors.push("POSIX runtime binding imagePathSha256 is invalid");
  if (!isSha256(binding?.process?.imageSha256)) errors.push("POSIX runtime binding imageSha256 is invalid");
  if (!Number.isSafeInteger(binding?.process?.imageBytes) || binding.process.imageBytes <= 0) {
    errors.push("POSIX runtime binding imageBytes must be positive");
  }
  if (!/^[a-f0-9]+:[a-f0-9]+$/.test(binding?.process?.imageFileId ?? "")) errors.push("POSIX runtime binding imageFileId is invalid");
  if (binding?.listener?.address !== "127.0.0.1") errors.push("POSIX runtime binding listener must use exact IPv4 loopback");
  if (!Number.isSafeInteger(binding?.listener?.port) || binding.listener.port <= 0 || binding.listener.port > 65535) {
    errors.push("POSIX runtime binding listener port is invalid");
  }
  if (binding?.listener?.owningPid !== binding?.process?.pid) errors.push("POSIX runtime binding listener owner does not match its PID");
  if (binding?.platform === "linux" && !/^inode:[1-9][0-9]*$/.test(binding?.listener?.socketId ?? "")) {
    errors.push("POSIX Linux runtime binding socketId is invalid");
  }
  if (binding?.platform === "macos" && binding?.listener?.socketId !== undefined) {
    errors.push("POSIX macOS runtime binding must not carry socketId");
  }
  if (observed && JSON.stringify(toReleaseSurfacePosixNativeBinding(observed)) !== JSON.stringify(binding)) {
    errors.push("POSIX runtime binding changed after candidate attestation");
  }
  return errors;
}

export function validateReleaseSurfacePosixObservationWindow(
  observedAt: string,
  enclosingObservedAt: string,
  label: string,
  maxAgeMs = RELEASE_SURFACE_POSIX_OBSERVATION_MAX_AGE_MS,
): string[] {
  const observed = Date.parse(observedAt);
  const enclosing = Date.parse(enclosingObservedAt);
  if (!Number.isFinite(observed) || !Number.isFinite(enclosing)) return [`${label} timestamps must be valid ISO timestamps`];
  const errors: string[] = [];
  if (observed > enclosing) errors.push(`${label} follows its enclosing evidence`);
  if (enclosing - observed > maxAgeMs) errors.push(`${label} is stale for its enclosing evidence`);
  return errors;
}

export function validateReleaseSurfacePosixProbeOrder(input: {
  attestedAt: string;
  beforeAt: string;
  afterAt: string;
}): string[] {
  const attested = Date.parse(input.attestedAt);
  const before = Date.parse(input.beforeAt);
  const after = Date.parse(input.afterAt);
  if (![attested, before, after].every(Number.isFinite)) {
    return ["POSIX native attestation and probe timestamps must be valid ISO timestamps"];
  }
  const errors: string[] = [];
  if (before < attested) errors.push("POSIX before-driver native observation predates candidate attestation");
  if (after < before) errors.push("POSIX after-driver native observation predates before-driver observation");
  return errors;
}

export function releaseSurfacePosixPathDigest(path: string): string {
  return createHash("sha256").update(path).digest("hex");
}

export function parseReleaseSurfaceLinuxStartId(stat: string, bootId: string): string {
  const close = stat.lastIndexOf(")");
  if (close < 0) throw new Error("Linux process stat has no command terminator");
  const fields = stat.slice(close + 1).trim().split(/\s+/);
  const startTicks = fields[19];
  const normalizedBootId = bootId.trim().toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(normalizedBootId)
    || !/^[1-9][0-9]*$/.test(startTicks ?? "")) {
    throw new Error("Linux process start identity is invalid");
  }
  return `linux:${normalizedBootId}:${startTicks}`;
}

export function parseReleaseSurfaceMacosStartId(value: string): string {
  const match = /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat)\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+([0-9]{1,2})\s+([0-9]{2}):([0-9]{2}):([0-9]{2})\s+([0-9]{4})$/.exec(value.trim());
  if (!match) throw new Error("macOS process start time is invalid");
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const epoch = Date.UTC(Number(match[7]), months.indexOf(match[2]!), Number(match[3]), Number(match[4]), Number(match[5]), Number(match[6]));
  if (!Number.isFinite(epoch)) throw new Error("macOS process start time is invalid");
  return `macos:${epoch}`;
}

export function parseReleaseSurfaceMacosLsofOwner(output: string, processId: number, port: number): number {
  const owners = new Set<number>();
  let currentPid: number | null = null;
  for (const line of output.split(/\r?\n/)) {
    if (/^p[1-9][0-9]*$/.test(line)) currentPid = Number(line.slice(1));
    if (currentPid !== null && line === `n127.0.0.1:${port}`) owners.add(currentPid);
  }
  if (owners.size !== 1 || !owners.has(processId)) {
    throw new Error(`macOS listener 127.0.0.1:${port} is not uniquely owned by PID ${processId}`);
  }
  return processId;
}

export function parseReleaseSurfaceMacosTextIdentity(
  output: string,
  processId: number,
  expectedPath: string,
): { imageFileId: string; imageBytes: number } {
  type TextRecord = { pid: number | null; fd: string; device: string; inode: string; size: string; name: string };
  const records: TextRecord[] = [];
  let pid: number | null = null;
  let current: TextRecord | null = null;
  const finish = (): void => {
    if (current) records.push(current);
    current = null;
  };
  for (const line of output.split(/\r?\n/)) {
    if (/^p[1-9][0-9]*$/.test(line)) {
      finish();
      pid = Number(line.slice(1));
    } else if (line.startsWith("f")) {
      finish();
      current = { pid, fd: line.slice(1), device: "", inode: "", size: "", name: "" };
    } else if (current && line.startsWith("D")) current.device = line.slice(1);
    else if (current && line.startsWith("i")) current.inode = line.slice(1);
    else if (current && line.startsWith("s")) current.size = line.slice(1);
    else if (current && line.startsWith("n")) current.name = line.slice(1);
  }
  finish();
  const matches = records.filter((record) => record.pid === processId && record.fd === "txt" && record.name === expectedPath);
  if (matches.length !== 1) {
    throw new Error(`macOS process ${processId} loaded executable vnode is not unique for its resolved path`);
  }
  const match = matches[0]!;
  if (!/^(?:0x[0-9a-f]+|[0-9]+)$/i.test(match.device)
    || !/^[1-9][0-9]*$/.test(match.inode)
    || !/^[1-9][0-9]*$/.test(match.size)) {
    throw new Error(`macOS process ${processId} loaded executable vnode identity is invalid`);
  }
  const device = BigInt(match.device);
  const inode = BigInt(match.inode);
  const size = Number(match.size);
  if (!Number.isSafeInteger(size)) throw new Error(`macOS process ${processId} loaded executable size is unsafe`);
  return { imageFileId: `${device.toString(16)}:${inode.toString(16)}`, imageBytes: size };
}

function collectLinuxSnapshot(processId: number, port: number): PosixSnapshot {
  const procRoot = `/proc/${processId}`;
  const startId = parseReleaseSurfaceLinuxStartId(
    readFileSync(`${procRoot}/stat`, "utf8"),
    readFileSync("/proc/sys/kernel/random/boot_id", "utf8"),
  );
  const path = realpathSync(`${procRoot}/exe`);
  const process = identifyProcessImage(processId, startId, path);
  const socketId = findLinuxListenerSocketId(port);
  const links = readdirSync(`${procRoot}/fd`).flatMap((entry) => {
    try {
      return [readlinkSync(`${procRoot}/fd/${entry}`)];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  });
  if (!links.includes(`socket:[${socketId}]`)) {
    throw new Error(`Linux listener 127.0.0.1:${port} is not owned by PID ${processId}`);
  }
  return {
    process,
    listener: { address: "127.0.0.1", port, owningPid: processId, socketId: `inode:${socketId}` },
  };
}

function collectMacosSnapshot(processId: number, port: number): PosixSnapshot {
  const startId = parseReleaseSurfaceMacosStartId(runMacosCommand("/bin/ps", ["-p", String(processId), "-o", "lstart="]));
  const commandPath = runMacosCommand("/bin/ps", ["-p", String(processId), "-o", "comm="]).trim();
  if (!commandPath.startsWith("/")) throw new Error(`macOS process ${processId} returned a non-absolute executable path`);
  const path = realpathSync(commandPath);
  const process = identifyProcessImage(processId, startId, path);
  const loadedImage = parseReleaseSurfaceMacosTextIdentity(runMacosCommand("/usr/sbin/lsof", [
    "-nP", "-a", "-p", String(processId), "-d", "txt", "-FpfDinsn",
  ]), processId, path);
  if (loadedImage.imageFileId !== process.imageFileId || loadedImage.imageBytes !== process.imageBytes) {
    throw new Error(`macOS process ${processId} loaded executable vnode does not match the on-disk candidate`);
  }
  const owner = parseReleaseSurfaceMacosLsofOwner(runMacosCommand("/usr/sbin/lsof", [
    "-nP", `-iTCP@127.0.0.1:${port}`, "-sTCP:LISTEN", "-Fpn",
  ]), processId, port);
  return {
    process,
    listener: { address: "127.0.0.1", port, owningPid: owner },
  };
}

function identifyProcessImage(
  pid: number,
  startId: string,
  path: string,
): ReleaseSurfacePosixNativeRuntime["process"] {
  const canonicalPath = realpathSync(path);
  const stat = statSync(canonicalPath, { bigint: true });
  if (!stat.isFile() || stat.size <= 0n || stat.size > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`POSIX process ${pid} image must be a non-empty regular file`);
  }
  const bytes = readFileSync(canonicalPath);
  return {
    pid,
    startId,
    imageBasename: basename(canonicalPath),
    imagePathSha256: createHash("sha256").update(canonicalPath).digest("hex"),
    imageSha256: createHash("sha256").update(bytes).digest("hex"),
    imageBytes: Number(stat.size),
    imageFileId: `${stat.dev.toString(16)}:${stat.ino.toString(16)}`,
  };
}

function findLinuxListenerSocketId(port: number): string {
  const portHex = port.toString(16).toUpperCase().padStart(4, "0");
  const matches = readFileSync("/proc/net/tcp", "utf8").split(/\r?\n/).slice(1).flatMap((line) => {
    const fields = line.trim().split(/\s+/);
    return fields[1] === `0100007F:${portHex}` && fields[3] === "0A" && /^[1-9][0-9]*$/.test(fields[9] ?? "")
      ? [fields[9]!]
      : [];
  });
  if (matches.length !== 1) {
    throw new Error(`Linux listener 127.0.0.1:${port} must resolve to exactly one kernel socket`);
  }
  return matches[0]!;
}

function runMacosCommand(command: string, args: string[]): string {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C", LANG: "C", TZ: "UTC" },
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
  });
  if (result.status !== 0 || !result.stdout.trim()) {
    throw new Error((result.stderr || result.stdout || `${command} returned no evidence`).trim());
  }
  return result.stdout.trim();
}

function validateCollectorInput(input: { processId: number; port: number }): void {
  if (!Number.isSafeInteger(input.processId) || input.processId <= 0) throw new Error("POSIX runtime PID must be positive");
  if (!Number.isSafeInteger(input.port) || input.port <= 0 || input.port > 65535) throw new Error("POSIX runtime port is invalid");
}

function validStartId(value: string | undefined, platform: ReleaseSurfacePosixPlatform | undefined): boolean {
  if (platform === "linux") return /^linux:[0-9a-f-]{36}:[1-9][0-9]*$/.test(value ?? "");
  if (platform === "macos") return /^macos:[1-9][0-9]{11,}$/.test(value ?? "");
  return false;
}

function validBasename(value: string | undefined): boolean {
  return typeof value === "string" && value.length > 0 && value.length <= 255 && !/[\\/\0]/.test(value);
}

function isSha256(value: string | undefined): boolean {
  return /^[a-f0-9]{64}$/.test(value ?? "");
}
