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

assert(classifyUpdateError("signature verification failed") === "signature", "signature errors are security failures");
assert(classifyUpdateError("Could not fetch a valid release JSON from the remote") === "manifest", "invalid latest.json is a manifest failure");
assert(classifyUpdateError("getaddrinfo ENOTFOUND github.com") === "network", "dns failures are network failures");
assert(classifyUpdateError("download failed while fetching asset") === "download", "download failures stay actionable");
assert(classifyUpdateError("404 not found") === "no-release", "missing release manifest is not noisy");
assert(
  classifyUpdateError("None of the fallback platforms ['darwin-aarch64-app', 'darwin-aarch64'] were found in the response `platforms` object")
    === "no-release",
  "missing macOS updater platform is quiet until mac artifacts ship",
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
assert(summarizeUpdateDiagnostic(warning).accent === "warn", "manifest/no-release errors render as warning diagnostics");

console.log(`\n${failures === 0 ? "PASS" : "FAIL"} update diagnostics tests`);
process.exit(failures === 0 ? 0 : 1);
