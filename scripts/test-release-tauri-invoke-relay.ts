import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  handleReleaseTauriInvokeEvent,
  RELEASE_TAURI_INVOKE_EVENT,
} from "../src/lib/release-tauri-invoke-relay";

const id = `rti-${"a".repeat(32)}`;
const nonce = "b".repeat(32);

{
  const calls: Array<{ path: string; body: unknown }> = [];
  const invoked: Array<{ command: string; args: Record<string, unknown> }> = [];
  await handleReleaseTauriInvokeEvent({ id, nonce }, {
    invokeCommand: async (command, args) => {
      invoked.push({ command, args });
      return { ok: true };
    },
    postJson: async <T>(path: string, body: unknown) => {
      calls.push({ path, body });
      if (path.endsWith("/claim")) {
        return { id, command: "vault_status", args: {} } as T;
      }
      return { id, status: "passed" } as T;
    },
  });
  assert.deepEqual(invoked, [{ command: "vault_status", args: {} }]);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1], {
    path: `/release-test/tauri-invokes/${id}/complete`,
    body: { nonce, status: "passed", value: { ok: true } },
  });
}

{
  const completions: unknown[] = [];
  await handleReleaseTauriInvokeEvent({ id, nonce }, {
    invokeCommand: async () => {
      throw new Error("bounded fixture failure");
    },
    postJson: async <T>(path: string, body: unknown) => {
      if (path.endsWith("/claim")) {
        return { id, command: "vault_status", args: {} } as T;
      }
      completions.push(body);
      return { id, status: "failed" } as T;
    },
  });
  assert.deepEqual(completions, [{ nonce, status: "failed", error: "bounded fixture failure" }]);
}

{
  let touched = false;
  await handleReleaseTauriInvokeEvent({ id: "bad", nonce }, {
    invokeCommand: async () => {
      touched = true;
      return null;
    },
    postJson: async <T>() => {
      touched = true;
      return null as T;
    },
  });
  assert.equal(touched, false);
}

const rust = readFileSync("src-tauri/src/debug_api_release_relay.rs", "utf8");
const app = readFileSync("src/App.tsx", "utf8");
const apiDocs = readFileSync("docs/public/API.md", "utf8");
const allowlist = readFileSync("src-tauri/src/release_tauri_command_allowlist.txt", "utf8")
  .trim()
  .split(/\r?\n/);
assert.equal(RELEASE_TAURI_INVOKE_EVENT, "release-test-tauri-invoke");
assert.equal(allowlist.length, 154);
assert.equal(new Set(allowlist).size, allowlist.length);
assert(allowlist.includes("shellx_browser_fill_user_vault_secret"));
assert(allowlist.includes("release_test_take_native_picker"));
assert.match(rust, /isolated_test_instance_requested\(\)/);
assert.match(rust, /MAX_ARGS_BYTES: usize = 64 \* 1024/);
assert.match(rust, /MAX_RESULT_BYTES: usize = 8 \* 1024 \* 1024/);
assert.match(rust, /another release Tauri invoke is still active/);
assert.match(rust, /record\.args = Value::Null/);
assert.match(app, /startReleaseTauriInvokeRelay\(\)/);
assert.doesNotMatch(app, /TAURI_CHANNELS[\s\S]{0,1000}release-test-tauri-invoke/);
assert.match(apiDocs, /Isolated release-test Tauri relay/);
assert.match(apiDocs, /Relay arguments, results, and errors are not written to the Debug event ring/);

console.log("Release Tauri invoke relay tests passed");
