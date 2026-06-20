import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("./public/", import.meta.url));
const captures = [];

const contentTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
]);

function json(res, status, body) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type",
    "access-control-allow-methods": "GET,POST,OPTIONS",
  });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(text || "{}");
  } catch {
    return { raw: text };
  }
}

function fixturePath(pathname) {
  const routes = new Map([
    ["/", "login.html"],
    ["/login", "login.html"],
    ["/signup", "signup.html"],
    ["/api-key", "api-key.html"],
    ["/call-api", "call-api.html"],
    ["/adversary", "adversary.html"],
    ["/heavy-spa", "heavy-spa.html"],
    ["/heavy-agent-app", "heavy-agent-app.html"],
    ["/everyday-apps", "everyday-apps.html"],
  ]);
  const mapped = routes.get(pathname) ?? pathname.replace(/^\/+/, "");
  const normalized = normalize(mapped).replace(/^(\.\.(\/|\\|$))+/, "");
  return join(root, normalized);
}

export function createFixtureServer() {
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "OPTIONS") return json(res, 200, {});
    if (req.method === "GET" && url.pathname === "/health") {
      return json(res, 200, {
        ok: true,
        fixture: "shellx-vault-browser",
        routes: ["/login", "/signup", "/api-key", "/call-api", "/adversary", "/heavy-spa", "/heavy-agent-app", "/everyday-apps", "/capture"],
      });
    }
    if (req.method === "GET" && url.pathname === "/capture") {
      return json(res, 200, { captures });
    }
    if (req.method === "POST" && url.pathname === "/capture") {
      const body = await readBody(req);
      const value = body.value === undefined || body.value === null ? "" : String(body.value);
      captures.push({
        t: Date.now(),
        route: body.route ?? null,
        kind: body.kind ?? "unknown",
        valueSeen: Boolean(value),
        valueHash: value ? createHash("sha256").update(value).digest("hex") : null,
        note: body.note ?? null,
      });
      return json(res, 200, { ok: true, captureCount: captures.length });
    }
    if (req.method !== "GET") return json(res, 405, { ok: false, error: "method not allowed" });

    const path = fixturePath(url.pathname);
    try {
      await readFile(path);
      res.writeHead(200, {
        "content-type": contentTypes.get(extname(path)) ?? "application/octet-stream",
        "cache-control": "no-store",
      });
      createReadStream(path).pipe(res);
    } catch {
      json(res, 404, { ok: false, error: "fixture route not found" });
    }
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? 0);
  const server = createFixtureServer();
  server.listen(port, "127.0.0.1", () => {
    const address = server.address();
    const actualPort = typeof address === "object" && address ? address.port : port;
    console.log(`ShellX Vault Browser fixture listening on http://127.0.0.1:${actualPort}`);
  });
}
