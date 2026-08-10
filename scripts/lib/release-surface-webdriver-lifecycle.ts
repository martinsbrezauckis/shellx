import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { lstatSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { parseExactReleaseSurfaceWebDriverBase, type ReleaseSurfaceWebDriverSession } from "./release-surface-webdriver-binding";

export const RELEASE_SURFACE_WEBDRIVER_LIFECYCLE_SCHEMA =
  "shellx/release-surface-webdriver-lifecycle@2";

const MAX_DRIVER_RESPONSE_BYTES = 1024 * 1024;
const MAX_DRIVER_LOG_BYTES = 64 * 1024;
const DRIVER_STATUS_TIMEOUT_MS = 3_000;
const SESSION_CREATE_TIMEOUT_MS = 120_000;
const SESSION_DELETE_TIMEOUT_MS = 30_000;

export interface ReleaseSurfaceWebDriverLifecycleReceipt {
  schema: typeof RELEASE_SURFACE_WEBDRIVER_LIFECYCLE_SCHEMA;
  mode: "final-frozen-candidate";
  status: "pass" | "failed";
  startedAt: string;
  completedAt: string;
  driver: FileIdentity & {
    launchPath: string;
    argsPrefixSha256: string;
    processId: number;
    base: string;
    nativePort: number;
  };
  application: FileIdentity & { launchPath: string };
  nativeDriver?: FileIdentity & { launchPath: string };
  driverLog: {
    retainedSha256: string;
    retainedBytes: number;
    observedBytes: number;
    truncated: boolean;
  };
  session: {
    created: boolean;
    sessionIdSha256?: string;
    workCompleted: boolean;
  };
  cleanup: {
    sessionDeleted: "pass" | "fail" | "not-created";
    driverStopped: "pass" | "fail";
    sessionDelete?: {
      requestedAt: string;
      completedAt: string;
    };
  };
  error?: string;
}

export interface ReleaseSurfaceWebDriverLifecycleInput {
  tauriDriverCommand: string;
  tauriDriverNodePath?: string;
  tauriDriverArgsPrefix?: string[];
  workingDirectory?: string;
  applicationLaunchPath: string;
  applicationNodePath?: string;
  nativeDriverLaunchPath?: string;
  nativeDriverNodePath?: string;
  driverPort: number;
  nativePort: number;
  environment?: NodeJS.ProcessEnv;
  evidencePath: string;
  startupTimeoutMs?: number;
  shutdownTimeoutMs?: number;
}

export class ReleaseSurfaceWebDriverLifecycleError extends Error {
  constructor(message: string, readonly receipt: ReleaseSurfaceWebDriverLifecycleReceipt) {
    super(message);
    this.name = "ReleaseSurfaceWebDriverLifecycleError";
  }
}

export interface ReleaseSurfaceWebDriverSessionDeleteObserver {
  beforeSessionDelete(session: ReleaseSurfaceWebDriverSession): Promise<void>;
  afterSessionDelete(input: {
    session: ReleaseSurfaceWebDriverSession;
    requestedAt: string;
    completedAt: string;
    status: "pass" | "fail";
  }): Promise<void>;
}

export interface ReleaseSurfaceWebDriverLifecycleContext {
  signal: AbortSignal;
  driverProcessId: number;
  registerSessionDeleteObserver(observer: ReleaseSurfaceWebDriverSessionDeleteObserver): void;
}

type FileIdentity = { basename: string; sha256: string; bytes: number };
type WebDriverEnvelope = { value?: unknown; sessionId?: unknown };
const driverSpawnErrors = new WeakMap<ChildProcess, Error>();

export async function withReleaseSurfaceWebDriverSession<T>(
  input: ReleaseSurfaceWebDriverLifecycleInput,
  work: (session: ReleaseSurfaceWebDriverSession, context: ReleaseSurfaceWebDriverLifecycleContext) => Promise<T>,
): Promise<{ value: T; receipt: ReleaseSurfaceWebDriverLifecycleReceipt }> {
  const validated = validateInput(input);
  const startedAt = new Date().toISOString();
  const abort = new AbortController();
  const logs = new BoundedDriverLogs();
  let child: ChildProcess | null = null;
  let session: ReleaseSurfaceWebDriverSession | null = null;
  let value: T | undefined;
  let workCompleted = false;
  let primaryError: unknown = null;
  let sessionDeleted: ReleaseSurfaceWebDriverLifecycleReceipt["cleanup"]["sessionDeleted"] = "not-created";
  let driverStopped: ReleaseSurfaceWebDriverLifecycleReceipt["cleanup"]["driverStopped"] = "fail";
  let sessionDeleteObserver: ReleaseSurfaceWebDriverSessionDeleteObserver | null = null;
  let sessionDeleteRequestedAt: string | null = null;
  let sessionDeleteCompletedAt: string | null = null;
  const onInterrupt = (): void => abort.abort(new Error("release WebDriver lifecycle interrupted"));
  process.once("SIGINT", onInterrupt);
  process.once("SIGTERM", onInterrupt);
  try {
    child = launchDriver({ ...input, ...validated }, logs);
    await waitForDriver(child, validated.driverBase, logs, input.startupTimeoutMs ?? 15_000, abort.signal);
    const created = await webdriverRequest(validated.driverBase, "POST", "/session", {
      capabilities: { alwaysMatch: { "tauri:options": { application: input.applicationLaunchPath } } },
    }, SESSION_CREATE_TIMEOUT_MS);
    const sessionId = parseSessionId(created);
    session = { base: validated.driverBase, sessionId };
    value = await work(session, {
      signal: abort.signal,
      driverProcessId: requireChildPid(child),
      registerSessionDeleteObserver: (observer) => {
        if (sessionDeleteObserver) throw new Error("WebDriver session-delete observer may be registered only once");
        if (!observer || typeof observer.beforeSessionDelete !== "function"
          || typeof observer.afterSessionDelete !== "function") {
          throw new Error("WebDriver session-delete observer is invalid");
        }
        sessionDeleteObserver = observer;
      },
    });
    workCompleted = true;
  } catch (error) {
    primaryError = error;
  } finally {
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onInterrupt);
    abort.abort(new Error("release WebDriver lifecycle finalized"));
    if (session) {
      const deleteObserver = sessionDeleteObserver as ReleaseSurfaceWebDriverSessionDeleteObserver | null;
      if (deleteObserver) {
        try {
          await deleteObserver.beforeSessionDelete(session);
        } catch (error) {
          primaryError = combineErrors(primaryError, `before session deletion observer failed: ${errorMessage(error)}`);
        }
      }
      sessionDeleteRequestedAt = new Date().toISOString();
      try {
        await webdriverRequest(
          validated.driverBase,
          "DELETE",
          `/session/${encodeURIComponent(session.sessionId)}`,
          undefined,
          SESSION_DELETE_TIMEOUT_MS,
        );
        sessionDeleted = "pass";
      } catch (error) {
        sessionDeleted = "fail";
        primaryError = combineErrors(primaryError, `session deletion failed: ${errorMessage(error)}`);
      }
      sessionDeleteCompletedAt = new Date().toISOString();
      if (deleteObserver) {
        try {
          await deleteObserver.afterSessionDelete({
            session,
            requestedAt: sessionDeleteRequestedAt,
            completedAt: sessionDeleteCompletedAt,
            status: sessionDeleted,
          });
        } catch (error) {
          primaryError = combineErrors(primaryError, `after session deletion observer failed: ${errorMessage(error)}`);
        }
      }
    }
    if (child) {
      try {
        await stopDriver(child, input.shutdownTimeoutMs ?? 2_000);
        driverStopped = "pass";
      } catch (error) {
        primaryError = combineErrors(primaryError, `driver shutdown failed: ${errorMessage(error)}`);
      }
    }
  }

  const receipt: ReleaseSurfaceWebDriverLifecycleReceipt = {
    schema: RELEASE_SURFACE_WEBDRIVER_LIFECYCLE_SCHEMA,
    mode: "final-frozen-candidate",
    status: primaryError ? "failed" : "pass",
    startedAt,
    completedAt: new Date().toISOString(),
    driver: {
      ...validated.tauriDriver,
      launchPath: validated.tauriDriverLaunchPath,
      argsPrefixSha256: sha256(JSON.stringify(input.tauriDriverArgsPrefix ?? [])),
      processId: Number(child?.pid ?? 0),
      base: validated.driverBase,
      nativePort: input.nativePort,
    },
    application: { ...validated.application, launchPath: input.applicationLaunchPath },
    ...(validated.nativeDriver
      ? { nativeDriver: { ...validated.nativeDriver, launchPath: input.nativeDriverLaunchPath! } }
      : {}),
    driverLog: logs.identity(),
    session: {
      created: Boolean(session),
      ...(session ? { sessionIdSha256: sha256(session.sessionId) } : {}),
      workCompleted,
    },
    cleanup: {
      sessionDeleted,
      driverStopped,
      ...(sessionDeleteRequestedAt && sessionDeleteCompletedAt
        ? { sessionDelete: { requestedAt: sessionDeleteRequestedAt, completedAt: sessionDeleteCompletedAt } }
        : {}),
    },
    ...(primaryError ? { error: redactLifecycleError(primaryError, session?.sessionId) } : {}),
  };
  try {
    writeFileSync(validated.evidencePath, `${JSON.stringify(receipt, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    throw new Error(`unable to write create-only WebDriver lifecycle evidence: ${errorMessage(error)}`);
  }
  if (primaryError) throw new ReleaseSurfaceWebDriverLifecycleError(errorMessage(primaryError), receipt);
  return { value: value as T, receipt };
}

function validateInput(input: ReleaseSurfaceWebDriverLifecycleInput): {
  driverBase: string;
  evidencePath: string;
  tauriDriver: FileIdentity;
  tauriDriverLaunchPath: string;
  application: FileIdentity;
  nativeDriver?: FileIdentity;
} {
  if (!validPort(input.driverPort) || !validPort(input.nativePort) || input.driverPort === input.nativePort) {
    throw new Error("WebDriver and native-driver ports must be distinct valid TCP ports");
  }
  const driverBase = `http://127.0.0.1:${input.driverPort}`;
  if (!parseExactReleaseSurfaceWebDriverBase(driverBase)) throw new Error("WebDriver lifecycle base is invalid");
  if (!input.applicationLaunchPath.trim() || /[\r\n\0]/.test(input.applicationLaunchPath)) {
    throw new Error("WebDriver application launch path is invalid");
  }
  if (input.nativeDriverLaunchPath && !input.nativeDriverNodePath) {
    throw new Error("native driver launch path requires an exact node-readable identity path");
  }
  if (input.nativeDriverNodePath && !input.nativeDriverLaunchPath) {
    throw new Error("native driver identity path requires an exact launch path");
  }
  if (input.workingDirectory !== undefined) {
    const workingDirectory = resolve(input.workingDirectory);
    if (input.workingDirectory !== workingDirectory) {
      throw new Error("tauri-driver working directory must be absolute");
    }
    const workingDirectoryStat = lstatSync(workingDirectory);
    if (workingDirectoryStat.isSymbolicLink() || !workingDirectoryStat.isDirectory()) {
      throw new Error("tauri-driver working directory must be a regular non-link directory");
    }
  }
  for (const arg of input.tauriDriverArgsPrefix ?? []) {
    if (typeof arg !== "string" || arg.length > 4_096 || /[\r\n\0]/.test(arg)) {
      throw new Error("tauri-driver argument prefix contains an invalid value");
    }
  }
  const tauriDriverLaunchPath = resolve(input.tauriDriverCommand);
  const tauriDriverNodePath = resolve(input.tauriDriverNodePath ?? input.tauriDriverCommand);
  if (input.tauriDriverCommand !== tauriDriverLaunchPath) {
    throw new Error("tauri-driver command must be an absolute path");
  }
  if (tauriDriverLaunchPath !== tauriDriverNodePath) {
    throw new Error("tauri-driver command must be the exact absolute node-readable binary that is measured");
  }
  const evidencePath = resolve(input.evidencePath);
  const parent = lstatSync(dirname(evidencePath));
  if (parent.isSymbolicLink() || !parent.isDirectory()) {
    throw new Error("WebDriver lifecycle evidence parent must be a regular non-link directory");
  }
  try {
    lstatSync(evidencePath);
    throw new Error(`WebDriver lifecycle evidence already exists: ${evidencePath}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return {
    driverBase,
    evidencePath,
    tauriDriverLaunchPath,
    tauriDriver: identifyRegularFile(tauriDriverNodePath, "tauri-driver"),
    application: identifyRegularFile(input.applicationNodePath ?? input.applicationLaunchPath, "installed application"),
    ...(input.nativeDriverNodePath
      ? { nativeDriver: identifyRegularFile(input.nativeDriverNodePath, "native WebDriver") }
      : {}),
  };
}

function launchDriver(
  input: ReleaseSurfaceWebDriverLifecycleInput & { driverBase: string },
  logs: BoundedDriverLogs,
): ChildProcess {
  const args = [
    ...(input.tauriDriverArgsPrefix ?? []),
    "--port", String(input.driverPort),
    "--native-port", String(input.nativePort),
    ...(input.nativeDriverLaunchPath ? ["--native-driver", input.nativeDriverLaunchPath] : []),
  ];
  const child = spawn(input.tauriDriverCommand, args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: input.environment ?? process.env,
    ...(input.workingDirectory ? { cwd: input.workingDirectory } : {}),
  });
  child.stdout?.on("data", (chunk) => logs.append("stdout", chunk));
  child.stderr?.on("data", (chunk) => logs.append("stderr", chunk));
  child.on("error", (error) => {
    driverSpawnErrors.set(child, error);
    logs.append("stderr", error.message);
  });
  return child;
}

async function waitForDriver(
  child: ChildProcess,
  base: string,
  logs: BoundedDriverLogs,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (signal.aborted) throw signal.reason;
    assertChildRunning(child);
    try {
      const status = await webdriverRequest(base, "GET", "/status", undefined, DRIVER_STATUS_TIMEOUT_MS);
      if (status.value) return;
    } catch {
      // External drivers need a bounded startup window before /status is available.
    }
    await delay(100);
  }
  throw new Error(`tauri-driver did not become ready on ${base}; driver log ${logs.identity().retainedSha256}`);
}

async function webdriverRequest(
  base: string,
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: unknown,
  timeoutMs = DRIVER_STATUS_TIMEOUT_MS,
): Promise<WebDriverEnvelope> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await boundedResponseText(response);
  if (!response.ok) throw new Error(`WebDriver ${method} ${path} returned ${response.status}: ${text.slice(0, 1000)}`);
  if (!text) return {};
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("WebDriver response must be an object");
  return parsed as WebDriverEnvelope;
}

function parseSessionId(envelope: WebDriverEnvelope): string {
  const nested = envelope.value && typeof envelope.value === "object" && !Array.isArray(envelope.value)
    ? (envelope.value as Record<string, unknown>).sessionId
    : undefined;
  const sessionId = typeof nested === "string" ? nested : envelope.sessionId;
  if (typeof sessionId !== "string" || !/^[a-zA-Z0-9._:-]{8,256}$/.test(sessionId)) {
    throw new Error("WebDriver session creation returned no bounded opaque session id");
  }
  return sessionId;
}

async function stopDriver(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = waitForChildExit(child, timeoutMs);
  child.kill("SIGTERM");
  if (await exited) return;
  const killed = waitForChildExit(child, timeoutMs);
  child.kill("SIGKILL");
  if (!await killed) throw new Error("owned tauri-driver process did not stop");
}

function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return Promise.race([
    new Promise<true>((resolveExit) => child.once("exit", () => resolveExit(true))),
    delay(timeoutMs).then(() => false),
  ]);
}

function assertChildRunning(child: ChildProcess): void {
  const spawnError = driverSpawnErrors.get(child);
  if (spawnError) throw new Error(`tauri-driver failed to spawn: ${spawnError.message}`);
  if (child.exitCode !== null || child.signalCode !== null) {
    throw new Error(`tauri-driver exited before readiness (exit=${child.exitCode}, signal=${child.signalCode})`);
  }
}

function requireChildPid(child: ChildProcess): number {
  if (!Number.isSafeInteger(child.pid) || Number(child.pid) <= 0) throw new Error("tauri-driver process has no valid PID");
  return Number(child.pid);
}

async function boundedResponseText(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > MAX_DRIVER_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error(`WebDriver response exceeds ${MAX_DRIVER_RESPONSE_BYTES} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function identifyRegularFile(path: string, label: string): FileIdentity {
  const absolute = resolve(path);
  const stat = lstatSync(absolute);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`${label} must be a regular non-symlink file: ${absolute}`);
  const value = readFileSync(absolute);
  if (value.length === 0) throw new Error(`${label} must not be empty: ${absolute}`);
  return { basename: basename(absolute), sha256: sha256(value), bytes: value.length };
}

function validPort(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0 && value <= 65_535;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function combineErrors(primary: unknown, secondary: string): Error {
  return new Error(primary ? `${errorMessage(primary)}; ${secondary}` : secondary);
}

function redactLifecycleError(error: unknown, sessionId: string | undefined): string {
  let text = errorMessage(error);
  if (sessionId) text = text.replaceAll(sessionId, "[session-id-redacted]");
  return text.replace(/[\r\n]+/g, " ").slice(0, 4_096);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

class BoundedDriverLogs {
  private value = "";
  private observedBytes = 0;
  private truncated = false;

  append(channel: "stdout" | "stderr", chunk: unknown): void {
    const entry = `[${channel}] ${String(chunk)}`;
    this.observedBytes += Buffer.byteLength(entry);
    this.value += entry;
    if (Buffer.byteLength(this.value) > MAX_DRIVER_LOG_BYTES) {
      this.value = Buffer.from(this.value).subarray(-MAX_DRIVER_LOG_BYTES).toString("utf8");
      this.truncated = true;
    }
  }

  identity(): ReleaseSurfaceWebDriverLifecycleReceipt["driverLog"] {
    const value = Buffer.from(this.value);
    return {
      retainedSha256: sha256(value),
      retainedBytes: value.length,
      observedBytes: this.observedBytes,
      truncated: this.truncated,
    };
  }
}
