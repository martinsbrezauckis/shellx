import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const authority = readFileSync("src-tauri/src/mcp_http_auth.rs", "utf8");
const mcpHttp = readFileSync("src-tauri/src/mcp_http.rs", "utf8");
const lib = readFileSync("src-tauri/src/lib.rs", "utf8");
const providerAdapters = readFileSync("src-tauri/src/provider_adapters.rs", "utf8");
const subagent = readFileSync("src-tauri/src/subagent.rs", "utf8");
const grokEnv = readFileSync("src-tauri/src/grok_env.rs", "utf8");
const apiDocs = readFileSync("docs/public/API.md", "utf8");
const architecture = readFileSync("docs/public/ARCHITECTURE.md", "utf8");
const threatModel = readFileSync("docs/public/THREAT_MODEL.md", "utf8");

assert(authority.includes("OnceLock<McpTokenAuthority>"), "Host MCP must have one process-owned token authority");
assert(authority.includes("Mutex<()>") && authority.includes("MCP_TOKEN_INITIALIZATION"), "concurrent authority initialization must serialize");
assert(authority.includes("atomic_write_private_file") && authority.includes("ShellX Host MCP token"), "profile token creation/rotation must use the atomic private writer");
assert(authority.includes("regular non-link file") && authority.includes("symlink_metadata"), "existing profile tokens must refuse links and non-files");
assert(authority.includes("HOME/USERPROFILE must be an absolute path"), "Host MCP must require an absolute private profile");
assert(!authority.includes('PathBuf::from("/tmp")'), "Host MCP must never fall back to shared temporary storage");
assert(authority.includes("persistence failure must not return a memory token"), "the persistence failure regression must remain explicit");
assert(authority.includes("process_authority_ignores_later_disk_drift"), "disk drift must not replace the live authority");
assert(authority.includes("legacy_rotation_persists_before_returning"), "legacy rotation must be persistence-gated");

const initializeIndex = lib.indexOf("match crate::mcp_http::initialize_mcp_token_authority()");
const spawnIndex = lib.indexOf("crate::mcp_http::start_mcp_server(handle).await", initializeIndex);
assert(initializeIndex >= 0 && spawnIndex > initializeIndex, "Tauri setup must initialize authority before scheduling Host MCP");
assert(mcpHttp.includes("initialize_mcp_token_authority()?;") && mcpHttp.includes("let token = current_mcp_token()?;"), "direct server starts must also bind the initialized authority");
assert(!mcpHttp.includes("resolve_or_create_mcp_token()"), "request and server paths must not re-resolve mutable token storage");
assert(mcpHttp.includes("let base_token = match current_mcp_token()"), "write authorization must use the live process authority");
assert(providerAdapters.includes("tab_bound_mcp_token(&tab_id)?"), "provider tooling must fail closed when token authority is unavailable");
assert(subagent.includes("tab_bound_mcp_token(transport_tab_id)?"), "subagent tooling must fail closed when token authority is unavailable");
assert(grokEnv.includes("current_mcp_token()?"), "Grok command execution must reuse the process authority");

for (const [label, docs] of [["API", apiDocs], ["architecture", architecture], ["threat model", threatModel]] as const) {
  assert(/process-owned token\s+authority/.test(docs), `${label} must document Host MCP process authority`);
}

console.log("Host MCP token authority contracts passed");
