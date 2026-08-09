import { readFileSync } from "node:fs";

function source(path: string): string {
  return readFileSync(path, "utf8");
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`FAIL: ${message}`);
}

const core = source("src-tauri/src/host_mcp/filesystem_core.rs");
const implementation = source("src-tauri/src/host_mcp/filesystem_media.rs");
const schema = source("src-tauri/src/host_mcp/tool_specs_core.rs");
const skill = source("skills/shellx-host/SKILL.md");
const docs = source("docs/public/API.md");

assert(
  core.includes("FS_READ_DEFAULT_MAX: usize = 16 * 1024") &&
    core.includes("FS_READ_HARD_MAX: usize = 1024 * 1024"),
  "host text reads must have compact default and hard response bounds",
);
assert(
  implementation.includes("read_file_range_with_cap_async") &&
    implementation.includes('\"next_offset_bytes\"') &&
    implementation.includes('\"approx_tokens\"') &&
    implementation.includes("offset_bytes.min(total)"),
  "fs_read must return a cursor-pageable response with bounded token evidence",
);
assert(
  schema.includes('\"offset_bytes\"') &&
    schema.includes('\"maximum\": 1048576') &&
    schema.includes("continue from next_offset_bytes"),
  "the searchable fs_read schema must document cursor paging and its hard cap",
);
assert(
  skill.includes("compact 16 KiB page") &&
    skill.includes("next_offset_bytes") &&
    docs.includes("An explicit page is capped at") &&
    docs.includes("approx_tokens"),
  "bundled agent guidance and API docs must teach bounded host document reads",
);

console.log("Host MCP bounded text-read contracts passed");
