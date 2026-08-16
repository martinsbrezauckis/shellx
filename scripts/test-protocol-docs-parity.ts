import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

function read(relativePath: string): string {
  return readFileSync(resolve(root, relativePath), "utf8");
}

function debugApiSourceFiles(): string[] {
  return readdirSync(resolve(root, "src-tauri/src"))
    .filter((name) => name === "debug_api.rs" || /^debug_api_.*\.rs$/.test(name))
    .map((name) => `src-tauri/src/${name}`)
    .sort();
}

function routeCalls(source: string): string[] {
  const calls: string[] = [];
  let cursor = 0;
  while ((cursor = source.indexOf(".route(", cursor)) >= 0) {
    const bodyStart = cursor + ".route(".length;
    let depth = 1;
    let quote = "";
    let escaped = false;
    let index = bodyStart;
    for (; index < source.length && depth > 0; index += 1) {
      const character = source[index];
      if (quote) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === quote) quote = "";
        continue;
      }
      if (character === '"' || character === "'") quote = character;
      else if (character === "(") depth += 1;
      else if (character === ")") depth -= 1;
    }
    assert.equal(depth, 0, "Debug API route declaration must have balanced parentheses");
    calls.push(source.slice(bodyStart, index - 1));
    cursor = index;
  }
  return calls;
}

function implementedDebugApiRoutes(): Set<string> {
  const routes = new Set<string>();
  for (const sourcePath of debugApiSourceFiles()) {
    for (const call of routeCalls(read(sourcePath))) {
      const path = call.match(/^\s*"([^"]+)"\s*,/)?.[1];
      assert(path, `${sourcePath} must use a literal path for every Debug API route`);
      const methods = [...call.matchAll(/\b(get|post|delete)\s*\(/g)]
        .map((match) => match[1]?.toUpperCase())
        .filter((method): method is string => Boolean(method));
      assert(methods.length > 0, `${sourcePath} ${path} must declare an HTTP method`);
      for (const method of methods) routes.add(`${method} ${path}`);
    }
  }
  return routes;
}

function documentedDebugApiRoutes(apiDocs: string): Set<string> {
  const start = apiDocs.indexOf("## Current Implementation Inventory");
  const end = apiDocs.indexOf("Legacy `/goal/*`", start);
  assert(start >= 0 && end > start, "API docs must contain one bounded current route inventory");
  const routes = new Set<string>();
  for (const line of apiDocs.slice(start, end).split(/\r?\n/)) {
    const row = line.match(/^\| (GET|POST|DELETE) \| (.+) \|$/);
    if (!row) continue;
    const method = row[1];
    const paths = row[2];
    assert(method && paths, "API route inventory row must contain a method and path list");
    for (const pathMatch of paths.matchAll(/`(\/[^`]+)`/g)) {
      const path = pathMatch[1];
      assert(path, "API route inventory path must not be empty");
      routes.add(`${method} ${path}`);
    }
  }
  return routes;
}

function sorted(values: Iterable<string>): string[] {
  return [...values].sort();
}

const apiDocs = read("docs/public/API.md");
const architecture = read("docs/public/ARCHITECTURE.md");
const threatModel = read("docs/public/THREAT_MODEL.md");
const normalizedApiDocs = apiDocs.replace(/\s+/g, " ");
const normalizedThreatModel = threatModel.replace(/\s+/g, " ");
const debugApiClient = read("src/lib/debug-api.ts");
const netFetch = read("src-tauri/src/host_mcp/net_fetch.rs");
const sessionArchive = read("src-tauri/src/session_archive.rs");
const hostSkill = read("skills/shellx-host/SKILL.md");
const skillInstaller = read("src-tauri/src/skill_install.rs");
const cutStatus = read("src-tauri/src/host_mcp/cut_status.rs");
const rightRail = `${read("src/components/RightRail.tsx")}\n${read("src/components/CutToolingRow.tsx")}`;
const taskProviderCatalog = read("src-tauri/src/task_provider_catalog.rs");
const backend = read("src-tauri/src/lib.rs");
const manualContent = read("docs/public/manual/shellx/content.json");
const generatedManual = read("docs/public/SHELLX_MANUAL.md");
const inventory = JSON.parse(read("release/surface-inventory.json")) as {
  counts: Record<string, number>;
  items: Array<{ kind: string; name: string; aliasOf?: string }>;
};

const implementedRoutes = implementedDebugApiRoutes();
const documentedRoutes = documentedDebugApiRoutes(apiDocs);
const inventoriedRoutes = new Set(
  inventory.items.filter((item) => item.kind === "debug-api-route").map((item) => item.name),
);
assert.deepEqual(sorted(documentedRoutes), sorted(implementedRoutes), "API route table must exactly match the Axum routers");
assert.deepEqual(sorted(inventoriedRoutes), sorted(implementedRoutes), "release inventory must exactly match the Axum routers");
assert.equal(inventory.counts["debug-api-route"], implementedRoutes.size);

const hostTools = inventory.items.filter((item) => item.kind === "host-mcp-tool").map((item) => item.name);
assert.equal(inventory.counts["host-mcp-tool"], hostTools.length);
assert(architecture.includes(`contains ${hostTools.length} host-MCP surfaces`), "architecture must use the live Host MCP inventory count");
const compactCatalogEntries = new Set([
  "capabilities_summary", "search_tool", "browser_read", "browser_act", "cut_read", "cut_act",
]);
const dispatchOnlyAliases = new Set(
  inventory.items
    .filter((item) => item.kind === "host-mcp-tool" && typeof item.aliasOf === "string")
    .map((item) => item.name),
);
const exactUnderlyingTools = hostTools.filter((name) => (
  !compactCatalogEntries.has(name)
  && name !== "host_read"
  && name !== "host_act"
  && !dispatchOnlyAliases.has(name)
));
assert(apiDocs.includes(`The ${exactUnderlyingTools.length} exact underlying Host schemas remain searchable`), "API guide must use the live searchable Host schema count");

for (const gateway of [
  "capabilities_summary", "search_tool", "host_read", "host_act", "browser_read", "browser_act", "cut_read", "cut_act",
]) {
  assert(apiDocs.includes(`\`${gateway}\``), `API guide must name compact gateway ${gateway}`);
  assert(hostSkill.includes(gateway), `installed host skill must name compact gateway ${gateway}`);
}
assert(
  hostSkill.includes("Use this skill only after positive evidence")
    && hostSkill.includes("If this precondition is absent, stop using this skill"),
  "installed host skill must remain opt-in for confirmed ShellX sessions",
);
assert(
  cutStatus.includes("ShellX never opens Cut automatically.")
    && rightRail.includes('title="Check ShellX Cut status without opening the editor"')
    && apiDocs.includes("Its **Check** control probes status only and never opens")
    && architecture.includes("The status is\ncompact by design and never carries Cut's generated verb catalogue")
    && normalizedThreatModel.includes("Status checks never launch the editor; only the operator-visible Open action may do so.")
    && hostSkill.includes("It never opens or focuses the Cut editor.")
    && hostSkill.includes("Opening Cut is not an\nagent action"),
  "Cut documentation must preserve the typed non-launching status and operator-only Open contract",
);
assert(
  cutStatus.includes("CutTarget::Local | CutTarget::Wsl | CutTarget::Ssh")
    && backend.includes("remote_transports_inject_session_scoped_http_host_mcp")
    && apiDocs.includes("WSL uses\nthe ShellX host bridge and SSH uses its reverse tunnel")
    && architecture.includes("WSL reaches the host through the ShellX\nbridge and SSH through the tab-bound reverse tunnel")
    && normalizedThreatModel.includes("tooling-enabled WSL or SSH provider can instead use the existing authenticated tab-bound host bridge")
    && hostSkill.includes("Local, WSL, and SSH\nagents use the parent desktop-host Cut bridge"),
  "Cut documentation must keep the tooling-enabled WSL/SSH parent-host bridge accurate",
);
assert(
  manualContent.includes("Check never opens the Cut editor.")
    && manualContent.includes("Model and reasoning choices remain with the selected provider.")
    && generatedManual.includes("Check never opens the Cut editor.")
    && generatedManual.includes("Model and reasoning choices remain with the selected provider."),
  "generated manual must retain its canonical Cut and model-selection boundaries",
);
assert(
  backend.includes("async fn task_provider_catalog(")
    && taskProviderCatalog.includes("models: Vec::new()")
    && taskProviderCatalog.includes("TaskProviderDefaultModelMode::ProviderDefault")
    && taskProviderCatalog.includes("safe_semantic_version_token")
    && taskProviderCatalog.includes("public_availability_detail")
    && apiDocs.includes("### First-class Tasks and provider catalogue")
    && apiDocs.includes("POST /tasks/provider-catalog")
    && normalizedApiDocs.includes("A queued response proves durable acceptance only")
    && normalizedApiDocs.includes("`task_manage` Host tool")
    && normalizedApiDocs.includes("exactly one isolated ASCII semantic-version token")
    && architecture.includes("`POST /tasks/provider-catalog` Debug API projection")
    && architecture.includes("exact-revision manual queueing")
    && architecture.includes("Host MCP exposes only the narrow write-class `task_manage`")
    && architecture.includes("introducing a second provider runtime"),
  "provider catalogue and Task docs must describe the receipt-gated Debug API without claiming direct provider execution",
);
assert(
  skillInstaller.includes('include_str!("../../skills/shellx-host/SKILL.md")'),
  "desktop installer must embed the repository host skill byte-for-byte",
);
assert(
  architecture.includes("Reqwest redirects are disabled")
    && netFetch.includes("redirect(reqwest::redirect::Policy::none())")
    && !architecture.includes("redirects\n  follow default policy"),
  "architecture must describe the implemented fail-closed net_fetch redirect policy",
);
assert(
  debugApiClient.includes("ShellX creates a bearer token at startup")
    && !debugApiClient.includes("auth middleware then\n// accepts requests without a token"),
  "Debug API client guidance must not claim authenticated routes become tokenless by default",
);
assert(
  sessionArchive.includes("SSH: build a filtered tar stream")
    && !sessionArchive.includes("SSH: NOT YET"),
  "session archive ownership comment must include the shipped SSH implementations",
);
assert(
  normalizedThreatModel.includes("ShellX does not copy, move, rewrite, or persist that provider-owned")
    && normalizedThreatModel.includes("the local tool reads the canonical credential into process memory")
    && !normalizedThreatModel.includes("shellX does not read or store xAI credentials itself"),
  "threat model must describe the implemented optional xAI media and X Search credential boundary",
);

for (const path of [
  "docs/public/API.md",
  "docs/public/ARCHITECTURE.md",
  "docs/public/DOCUMENTATION_WORKFLOW.md",
  "docs/public/THREAT_MODEL.md",
  "skills/shellx-host/SKILL.md",
]) {
  assert(
    !/~\/\.shellx\/(?:shellxagent|mcp)\.token/.test(read(path)),
    `${path} must not direct public readers to a raw bearer-token path`,
  );
}

console.log(
  `Protocol docs match ${implementedRoutes.size} Debug API routes, ${hostTools.length} Host MCP tools, and the installer-bundled session-only skill`,
);
