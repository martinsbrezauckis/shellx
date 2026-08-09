import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  classifyUpdateError,
  summarizeUpdateDiagnostic,
  type UpdateDiagnosticInput,
} from "../src/lib/update-diagnostics";

let failures = 0;
function assert(cond: boolean, label: string): void {
  console.log(`  ${cond ? "✓" : "✗"} ${label}`);
  if (!cond) failures += 1;
}

console.log("\n=== update diagnostics ===");

const root = resolve(import.meta.dirname, "..");
const cargoManifest = readFileSync(resolve(root, "src-tauri/Cargo.toml"), "utf8");
const packageSection = cargoManifest.match(/\[package\]([\s\S]*?)(?=\n\[|$)/)?.[1] ?? "";
const tauriConfig = JSON.parse(readFileSync(resolve(root, "src-tauri/tauri.conf.json"), "utf8"));
assert(
  /^name = "shellx"$/m.test(packageSection),
  "the Cargo package emits shellx as the real desktop main binary",
);
assert(
  !("mainBinaryName" in tauriConfig),
  "Tauri does not rename an ambiguous multi-bin Cargo artifact into the desktop executable",
);
assert(
  !existsSync(resolve(root, "src-tauri/src/bin/verify-updater-signature.rs"))
    && existsSync(resolve(root, "src-tauri/examples/verify-updater-signature.rs")),
  "the updater verifier is a release-tool example rather than a competing application binary",
);

assert(classifyUpdateError("signature verification failed") === "signature", "signature errors are security failures");
assert(
  classifyUpdateError("Could not fetch a valid release JSON from the remote") === "no-release",
  "missing/invalid remote release JSON is quiet for startup checks",
);
assert(classifyUpdateError("getaddrinfo ENOTFOUND github.com") === "network", "dns failures are network failures");
assert(classifyUpdateError("download failed while fetching asset") === "download", "download failures stay actionable");
assert(
  classifyUpdateError("Invalid updater binary format") === "manual-install",
  "package formats without an in-app updater are classified as manual installs",
);
assert(classifyUpdateError("404 not found") === "no-release", "missing release manifest is not noisy");
assert(
  classifyUpdateError("None of the fallback platforms ['darwin-aarch64-app', 'darwin-aarch64'] were found in the response `platforms` object")
    === "no-release",
  "missing macOS updater platform is quiet when a manifest has no mac artifact for this version",
);

const current: UpdateDiagnosticInput = {
  currentVersion: "0.1.31",
  kind: "current",
  checkedAtMs: 1779583000000,
};
assert(summarizeUpdateDiagnostic(current).statusLabel === "current", "current update state has compact label");
assert(summarizeUpdateDiagnostic(current).detail.includes("0.1.31"), "current version appears in detail");

const available: UpdateDiagnosticInput = {
  currentVersion: "0.1.31",
  kind: "available",
  remoteVersion: "0.1.32",
  checkedAtMs: 1779583000000,
};
assert(summarizeUpdateDiagnostic(available).accent === "ok", "available update uses positive accent");
assert(summarizeUpdateDiagnostic(available).detail.includes("0.1.32"), "available version appears in detail");

const warning: UpdateDiagnosticInput = {
  currentVersion: "0.1.31",
  kind: "error",
  errorMessage: "Could not fetch a valid release JSON from the remote",
};
const warningSummary = summarizeUpdateDiagnostic(warning);
assert(warningSummary.accent === "warn", "manifest/no-release errors render as warning diagnostics");
assert(warningSummary.statusLabel === "no release", "missing remote release JSON is labeled as no release");

console.log(`\n${failures === 0 ? "PASS" : "FAIL"} update diagnostics tests`);
process.exit(failures === 0 ? 0 : 1);
