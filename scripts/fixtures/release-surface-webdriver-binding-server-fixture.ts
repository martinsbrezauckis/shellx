import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const token = readFileSync(requiredArg(args, "--token-file"), "utf8").trim();
const statePath = requiredArg(args, "--state-out");
const sessionId = requiredArg(args, "--session-id");
const instanceId = requiredArg(args, "--instance-id");
const processId = Number(requiredArg(args, "--process-id"));
const version = requiredArg(args, "--version");
const sourceCommit = requiredArg(args, "--source-commit");
let highlight: { id: string; label: string } | null = null;

const candidate = createServer(async (request, response) => {
  if (request.headers.authorization !== `Bearer ${token}`) return end(response, 401);
  if (request.url === "/health") {
    const address = candidate.address();
    if (!address || typeof address === "string") return end(response, 503);
    return json(response, {
      ok: true,
      processId,
      instanceId,
      appVersion: version,
      buildCommit: sourceCommit,
      debugApiVersion: "1.2.0",
      debugApiPort: address.port,
    });
  }
  if (request.url === "/browser/state") return json(response, { ok: true });
  if (request.url === "/state/ui" && request.method === "POST") {
    const body = JSON.parse(await readBody(request)) as {
      debugHighlights?: Array<{ id?: string; label?: string }>;
    };
    const row = body.debugHighlights?.[0];
    highlight = row?.id && row.label ? { id: row.id, label: row.label } : null;
    return json(response, { ok: true });
  }
  if (request.url === "/state/ui" && request.method === "GET") {
    return json(response, {
      debugHighlightResultsBySurface: {
        app: highlight ? [{ id: highlight.id, status: "resolved" }] : [],
      },
    });
  }
  return end(response, 404);
});

const webdriver = createServer((request, response) => {
  if (request.url === `/session/${sessionId}/title`) return json(response, { value: "shellX" });
  if (request.url === `/session/${sessionId}/source`) {
    return json(response, {
      value: `<html><body><div class="debug-highlight-label">${highlight?.label ?? ""}</div></body></html>`,
    });
  }
  return end(response, 404);
});

candidate.listen(0, "127.0.0.1", () => {
  webdriver.listen(0, "127.0.0.1", () => {
    const candidateAddress = candidate.address();
    const webdriverAddress = webdriver.address();
    if (!candidateAddress || typeof candidateAddress === "string"
      || !webdriverAddress || typeof webdriverAddress === "string") {
      throw new Error("binding fixture servers have no TCP addresses");
    }
    writeFileSync(statePath, `${JSON.stringify({
      candidatePort: candidateAddress.port,
      webdriverPort: webdriverAddress.port,
    })}\n`, { encoding: "utf8", flag: "wx" });
  });
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => candidate.close(() => webdriver.close(() => process.exit(0))));
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function json(response: ServerResponse, value: unknown): void {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

function end(response: ServerResponse, status: number): void {
  response.writeHead(status).end();
}

function requiredArg(values: string[], name: string): string {
  const index = values.indexOf(name);
  const value = index >= 0
    ? values[index + 1]
    : values.find((entry) => entry.startsWith(`${name}=`))?.slice(name.length + 1);
  if (!value?.trim()) throw new Error(`${name} is required`);
  return value;
}
