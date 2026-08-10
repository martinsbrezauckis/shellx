import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { realpathSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const port = Number(requiredArg(args, "--port"));
const auditOut = requiredArg(args, "--audit-out");
const expectedApplication = requiredArg(args, "--expected-application");
const expectedWorkingDirectory = requiredArg(args, "--expected-working-directory");
const sessionId = requiredArg(args, "--session-id");
const deleteFails = args.includes("--delete-fails");
const exitBeforeReady = args.includes("--exit-before-ready");
const largeLog = args.includes("--large-log");
const sessionDelayMs = optionalBoundedMilliseconds(args, "--session-delay-ms");
let sessionCreated = false;
let sessionDeleted = false;

if (realpathSync(process.cwd()) !== realpathSync(expectedWorkingDirectory)) {
  throw new Error("tauri-driver working directory mismatch");
}

if (exitBeforeReady) {
  console.error("fixture-private-driver-log-must-not-enter-evidence");
  if (largeLog) process.stderr.write("fixture-sensitive-log-line\n".repeat(4_096));
  process.exit(23);
}

const server = createServer(async (request, response) => {
  try {
    if (request.method === "GET" && request.url === "/status") {
      return json(response, 200, { value: { ready: true } });
    }
    if (request.method === "POST" && request.url === "/session") {
      if (sessionDelayMs > 0) await delay(sessionDelayMs);
      const body = await requestJson(request);
      const capabilities = asRecord(body.capabilities);
      const alwaysMatch = asRecord(capabilities?.alwaysMatch);
      const tauriOptions = asRecord(alwaysMatch?.["tauri:options"]);
      const application = tauriOptions?.application;
      if (application !== expectedApplication) {
        return json(response, 400, { value: { error: "invalid argument", message: "application path mismatch" } });
      }
      sessionCreated = true;
      return json(response, 200, { value: { sessionId, capabilities: {} } });
    }
    if (request.method === "DELETE" && request.url === `/session/${encodeURIComponent(sessionId)}`) {
      if (deleteFails) return json(response, 500, { value: { error: "unknown error", message: "fixture delete failure" } });
      sessionDeleted = true;
      return json(response, 200, { value: null });
    }
    return json(response, 404, { value: { error: "unknown command", message: `${request.method} ${request.url}` } });
  } catch (error) {
    return json(response, 500, { value: { error: "unknown error", message: error instanceof Error ? error.message : String(error) } });
  }
});

server.listen(port, "127.0.0.1");
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close(() => {
      writeFileSync(auditOut, `${JSON.stringify({ sessionCreated, sessionDeleted, signal })}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      process.exit(0);
    });
  });
}

async function requestJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const value = Buffer.from(chunk);
    bytes += value.length;
    if (bytes > 64 * 1024) throw new Error("fixture request is too large");
    chunks.push(value);
  }
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("fixture request must be an object");
  return parsed as Record<string, unknown>;
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function requiredArg(values: string[], name: string): string {
  const index = values.indexOf(name);
  const value = index >= 0 ? values[index + 1] : values.find((entry) => entry.startsWith(`${name}=`))?.slice(name.length + 1);
  if (!value?.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

function optionalBoundedMilliseconds(values: string[], name: string): number {
  const index = values.indexOf(name);
  const raw = index >= 0 ? values[index + 1] : undefined;
  if (raw === undefined) return 0;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0 || value > 10_000) {
    throw new Error(`${name} must be an integer from 0 to 10000`);
  }
  return value;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
