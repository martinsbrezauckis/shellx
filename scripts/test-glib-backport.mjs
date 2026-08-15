import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { validateGlibBackport } from "./lib/verify-glib-backport.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const errors = validateGlibBackport();
if (errors.length > 0) throw new Error(errors.join("\n"));

const scratch = mkdtempSync(resolve(tmpdir(), "shellx-glib-backport-"));
try {
  mkdirSync(resolve(scratch, "src"));
  writeFileSync(resolve(scratch, "Cargo.toml"), `[package]
name = "shellx-glib-backport-proof"
version = "0.0.0"
edition = "2021"

[dependencies]
glib = { path = ${JSON.stringify(resolve(ROOT, "vendor", "glib"))} }
`);
  writeFileSync(resolve(scratch, "src", "main.rs"), `use glib::{prelude::*, Variant};

fn string_array() -> Variant {
    Variant::array_from_iter::<String>([
        "zero".to_variant(),
        "one".to_variant(),
        "two".to_variant(),
        "three".to_variant(),
    ])
}

fn main() {
    assert_eq!(string_array().array_iter_str().unwrap().next(), Some("zero"));
    assert_eq!(string_array().array_iter_str().unwrap().next_back(), Some("three"));
    assert_eq!(string_array().array_iter_str().unwrap().nth(1), Some("one"));
    assert_eq!(string_array().array_iter_str().unwrap().nth_back(1), Some("two"));
    assert_eq!(string_array().array_iter_str().unwrap().last(), Some("three"));
}
`);

  const cargo = spawnSync("cargo", ["run", "--manifest-path", resolve(scratch, "Cargo.toml"), "--release", "--quiet"], {
    cwd: ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      CARGO_TARGET_DIR: resolve(ROOT, "src-tauri", "target"),
    },
    maxBuffer: 20 * 1024 * 1024,
  });
  if (cargo.error) throw new Error(`optimized glib backport proof failed to start: ${cargo.error.message}`);
  if (cargo.status !== 0) {
    throw new Error(`optimized glib backport proof failed (${cargo.status ?? cargo.signal ?? "unknown"}):\n${cargo.stderr}${cargo.stdout}`);
  }
  console.log("PASS glib VariantStrIter optimized backport proof");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
