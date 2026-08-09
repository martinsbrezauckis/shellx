import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const lib = readFileSync("src-tauri/src/lib.rs", "utf8");
const environmentApi = readFileSync("src-tauri/src/debug_api_environment.rs", "utf8");
const connectionsApi = readFileSync("src-tauri/src/debug_api_connections.rs", "utf8");
const vaultContract = readFileSync("scripts/test-shellx-vault.ts", "utf8");
const voice = readFileSync("src-tauri/src/voice.rs", "utf8");

for (const superseded of ["get_header_state", "mcp_marketplace_health"]) {
  assert.equal(
    new RegExp(`(?:async\\s+)?fn\\s+${superseded}\\b`).test(lib),
    false,
    `${superseded} must not return as an unwired Tauri wrapper`,
  );
}

assert.match(lib, /async fn session_tooling_snapshot\b/);
assert.match(lib, /session_tooling_snapshot,/);
assert.match(environmentApi, /state_marketplace_health/);
assert.match(environmentApi, /state_session_tooling/);

for (const retained of [
  "host_skill_status",
  "outside_connectors_capabilities",
  "vault_list_resources",
  "vault_update_resource_metadata",
]) {
  assert.match(lib, new RegExp(`(?:async\\s+)?fn\\s+${retained}\\b`));
  assert.match(lib, new RegExp(`\\n\\s*${retained},`));
}

assert.match(connectionsApi, /outside_connectors_capabilities_http/);
assert.match(connectionsApi, /connector_capabilities\(\)/);
assert.match(vaultContract, /"vault_list_resources"/);
assert.match(vaultContract, /"vault_update_resource_metadata"/);
assert.match(voice, /pub async fn voice_credential_source\b/);
assert.match(lib, /crate::voice::voice_credential_source,/);

console.log("Tauri command ownership contracts passed");
