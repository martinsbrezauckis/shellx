import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync("src-tauri/src/lib.rs", "utf8");

function functionBody(startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0 && end > start, `missing bounded source region ${startMarker}`);
  return source.slice(start, end);
}

function logMacros(body: string): string {
  return (body.match(/(?:info|warn)!\([\s\S]*?\);/g) ?? []).join("\n");
}

const sessionStart = functionBody("async fn start_grok_session(", "#[cfg(test)]\nmod grok_session_initializer_tests");
assert.doesNotMatch(logMacros(sessionStart), /\bcwd\b/);
assert.doesNotMatch(logMacros(sessionStart), /\{:\?\}/);
assert.match(sessionStart, /resume_requested=\{\}/);

const prompt = functionBody("async fn send_prompt(", "/// Queue a human correction");
assert.doesNotMatch(logMacros(prompt), /restart_cwd/);
assert.doesNotMatch(logMacros(prompt), /restart_session_id/);
assert.doesNotMatch(logMacros(prompt), /session\/prompt response received:\s*\{:\?\}/);
assert.match(prompt, /info!\("session\/prompt response received"\)/);

const rename = functionBody("async fn rename_past_session(", "/// Shallow directory listing");
assert.doesNotMatch(logMacros(rename), /\btrimmed\b/);
assert.match(rename, /info!\("rename_past_session: title updated"\)/);

const migrator = functionBody("// H2 token strategy migrator", "// Startup log to file");
assert.doesNotMatch(logMacros(migrator), /global_config\.display\(\)/);

console.log("ShellX sensitive-log privacy contract passed");
