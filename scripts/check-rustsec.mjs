import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const POLICY_PATH = resolve(ROOT, "security", "rustsec-dispositions.json");
const LOCK_PATH = resolve(ROOT, "src-tauri", "Cargo.lock");
const ROOT_MANIFEST_PATH = resolve(ROOT, "src-tauri", "Cargo.toml");
const WINRT_VENDOR_ROOT = resolve(ROOT, "vendor", "tauri-winrt-notification");

const WINRT_UPSTREAM_HASHES = new Map([
  ["src/lib.rs", "02737ddf3e28757572c6da5ed492496a07f59e56e78bc3dbea327ebaeb8913f1"],
  ["LICENSE_APACHE-2.0", "0d542e0c8804e39aa7f37eb00da5a762149dc682d7829451287e11b938e94594"],
  ["LICENSE_MIT", "9dd42ea92cff2ede5cd477cbfcce051b2d0115c0ac7f368ee88cb545055dff1d"],
]);

function vulnerabilityKey(advisoryId, packageName, version) {
  return `${advisoryId}:${packageName}@${version}`;
}

function dispositionExpiry(expiresOn) {
  return Date.parse(`${expiresOn}T23:59:59.999Z`);
}

export function evaluateRustsecReport(report, policy, now = new Date()) {
  const policyErrors = [];
  if (policy.schemaVersion !== "shellx.rustsec-dispositions.v1") {
    policyErrors.push(`unsupported policy schema: ${policy.schemaVersion || "(missing)"}`);
  }
  if (!Array.isArray(policy.entries)) {
    policyErrors.push("policy entries must be an array");
  }

  const dispositions = new Map();
  const expired = [];
  for (const entry of policy.entries ?? []) {
    if (!entry.advisoryId || !entry.package || !entry.versions?.length) {
      policyErrors.push("every disposition requires advisoryId, package, and at least one version");
      continue;
    }
    const expiry = dispositionExpiry(entry.expiresOn);
    if (!Number.isFinite(expiry)) {
      policyErrors.push(`${entry.advisoryId}:${entry.package} has invalid expiresOn ${entry.expiresOn}`);
    } else if (now.getTime() > expiry) {
      expired.push(entry);
    }
    if (!entry.reason?.trim() || !entry.evidence?.length || !entry.upgradeCondition?.trim()) {
      policyErrors.push(`${entry.advisoryId}:${entry.package} requires reason, evidence, and upgradeCondition`);
    }
    for (const version of entry.versions) {
      const key = vulnerabilityKey(entry.advisoryId, entry.package, version);
      if (dispositions.has(key)) policyErrors.push(`duplicate disposition: ${key}`);
      dispositions.set(key, entry);
    }
  }

  const seen = new Set();
  const accepted = [];
  const blocking = [];
  const reportableFindings = [
    ...(report.vulnerabilities?.list ?? []),
    ...(report.warnings?.unsound ?? []),
  ];
  for (const vulnerability of reportableFindings) {
    const key = vulnerabilityKey(
      vulnerability.advisory.id,
      vulnerability.package.name,
      vulnerability.package.version,
    );
    seen.add(key);
    const disposition = dispositions.get(key);
    const evaluated = { ...vulnerability, disposition, key };
    if (disposition && !expired.includes(disposition)) accepted.push(evaluated);
    else blocking.push(evaluated);
  }

  const stale = [...dispositions.keys()].filter((key) => !seen.has(key));
  const status = blocking.length || expired.length || stale.length || policyErrors.length
    ? "fail"
    : "pass";
  return { status, accepted, blocking, expired, stale, policyErrors };
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`invalid JSON in ${path}: ${String(error)}`);
  }
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function validateWinrtPatch() {
  const errors = [];
  for (const [relativePath, expectedHash] of WINRT_UPSTREAM_HASHES) {
    const actualHash = sha256(resolve(WINRT_VENDOR_ROOT, relativePath));
    if (actualHash !== expectedHash) {
      errors.push(`vendored tauri-winrt-notification ${relativePath} differs from crates.io 0.7.2`);
    }
  }

  const vendorManifest = readFileSync(resolve(WINRT_VENDOR_ROOT, "Cargo.toml"), "utf8");
  if (!vendorManifest.includes('version = "0.7.2"') || !vendorManifest.includes('quick-xml = "0.41"')) {
    errors.push("vendored tauri-winrt-notification must retain API version 0.7.2 and quick-xml 0.41");
  }

  const rootManifest = readFileSync(ROOT_MANIFEST_PATH, "utf8");
  if (!rootManifest.includes('tauri-winrt-notification = { path = "../vendor/tauri-winrt-notification" }')) {
    errors.push("ShellX Cargo manifest does not activate the reviewed tauri-winrt-notification patch");
  }

  const lock = readFileSync(LOCK_PATH, "utf8");
  for (const vulnerableVersion of ["0.37.5", "0.39.4"]) {
    if (lock.includes(`name = "quick-xml"\nversion = "${vulnerableVersion}"`)) {
      errors.push(`Cargo.lock still resolves vulnerable quick-xml ${vulnerableVersion}`);
    }
  }
  return errors;
}

function runCargoAudit() {
  const result = spawnSync("cargo", ["audit", "--file", LOCK_PATH, "--json"], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.error) throw new Error(`cargo audit failed to start: ${result.error.message}`);
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(`cargo audit failed with exit ${result.status ?? result.signal ?? "unknown"}: ${result.stderr.trim()}`);
  }
  if (!result.stdout.trim()) {
    throw new Error(`cargo audit returned no JSON${result.stderr ? `: ${result.stderr.trim()}` : ""}`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`cargo audit returned invalid JSON: ${String(error)}`);
  }
}

function renderEvaluation(evaluation) {
  const lines = [
    `RustSec audit: ${evaluation.status.toUpperCase()}`,
    `Accepted temporary dispositions: ${evaluation.accepted.length}`,
    `Blocking vulnerabilities: ${evaluation.blocking.length}`,
  ];
  for (const item of evaluation.accepted) {
    lines.push(`ACCEPT ${item.key} until ${item.disposition?.expiresOn}: ${item.disposition?.reason}`);
  }
  for (const item of evaluation.blocking) {
    lines.push(`BLOCK ${item.key}: ${item.advisory.title ?? "RustSec vulnerability"}`);
  }
  for (const entry of evaluation.expired) {
    lines.push(`EXPIRED ${entry.advisoryId}:${entry.package} on ${entry.expiresOn}`);
  }
  for (const key of evaluation.stale) lines.push(`STALE ${key}: remove or update the disposition`);
  for (const error of evaluation.policyErrors) lines.push(`POLICY ${error}`);
  return lines.join("\n");
}

function main() {
  try {
    const patchErrors = validateWinrtPatch();
    if (patchErrors.length > 0) throw new Error(patchErrors.join("\n"));
    const report = runCargoAudit();
    const policy = readJson(POLICY_PATH);
    const evaluation = evaluateRustsecReport(report, policy);
    console.log(renderEvaluation(evaluation));
    process.exitCode = evaluation.status === "pass" ? 0 : 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
