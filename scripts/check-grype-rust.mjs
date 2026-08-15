import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { validateGlibBackport } from "./lib/verify-glib-backport.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const POLICY_PATH = resolve(ROOT, "security", "grype-dispositions.json");

function key(advisoryId, packageName, version) {
  return `${advisoryId}:${packageName}@${version}`;
}

function expiry(expiresOn) {
  return Date.parse(`${expiresOn}T23:59:59.999Z`);
}

export function evaluateGrypeRustReport(report, policy, now = new Date()) {
  const policyErrors = [];
  if (policy.schemaVersion !== "shellx.grype-dispositions.v1") {
    policyErrors.push(`unsupported policy schema: ${policy.schemaVersion || "(missing)"}`);
  }
  if (!Array.isArray(policy.entries)) policyErrors.push("policy entries must be an array");
  const dbStatus = report.descriptor?.db?.status;
  if (dbStatus?.valid !== true || !Number.isFinite(Date.parse(dbStatus?.built ?? ""))) {
    policyErrors.push("Grype vulnerability database must be valid and expose a build timestamp");
  } else if (now.getTime() - Date.parse(dbStatus.built) > 7 * 24 * 60 * 60 * 1000) {
    policyErrors.push(`Grype vulnerability database is older than seven days: ${dbStatus.built}`);
  }

  const dispositions = new Map();
  const expired = [];
  for (const entry of policy.entries ?? []) {
    if (!entry.advisoryId || !entry.package || !entry.versions?.length) {
      policyErrors.push("every disposition requires advisoryId, package, and at least one version");
      continue;
    }
    const expiresAt = expiry(entry.expiresOn);
    if (!Number.isFinite(expiresAt)) policyErrors.push(`${entry.advisoryId}:${entry.package} has invalid expiresOn`);
    else if (now.getTime() > expiresAt) expired.push(entry);
    if (!entry.reason?.trim() || !entry.evidence?.length || !entry.upgradeCondition?.trim()) {
      policyErrors.push(`${entry.advisoryId}:${entry.package} requires reason, evidence, and upgradeCondition`);
    }
    for (const version of entry.versions) {
      const dispositionKey = key(entry.advisoryId, entry.package, version);
      if (dispositions.has(dispositionKey)) policyErrors.push(`duplicate disposition: ${dispositionKey}`);
      dispositions.set(dispositionKey, entry);
    }
  }

  const unique = new Map();
  for (const match of report.matches ?? []) {
    if (match.artifact?.type !== "rust-crate") {
      policyErrors.push(`unexpected non-Rust Grype match: ${match.artifact?.type ?? "unknown"}`);
      continue;
    }
    const matchKey = key(match.vulnerability?.id, match.artifact?.name, match.artifact?.version);
    unique.set(matchKey, { ...match, key: matchKey });
  }
  const accepted = [];
  const blocking = [];
  for (const match of unique.values()) {
    const disposition = dispositions.get(match.key);
    const evaluated = { ...match, disposition };
    if (disposition && !expired.includes(disposition)) accepted.push(evaluated);
    else blocking.push(evaluated);
  }
  const stale = [...dispositions.keys()].filter((dispositionKey) => !unique.has(dispositionKey));
  const status = blocking.length || expired.length || stale.length || policyErrors.length ? "fail" : "pass";
  return { status, accepted, blocking, expired, stale, policyErrors };
}

function runGrype() {
  const result = spawnSync("grype", ["dir:src-tauri", "--exclude", "./target/**", "-o", "json"], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 30 * 1024 * 1024,
  });
  if (result.error) throw new Error(`grype failed to start: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`grype failed with exit ${result.status ?? result.signal ?? "unknown"}: ${result.stderr.trim()}`);
  if (!result.stdout.trim()) throw new Error(`grype returned no JSON${result.stderr ? `: ${result.stderr.trim()}` : ""}`);
  return JSON.parse(result.stdout);
}

function main() {
  try {
    const patchErrors = validateGlibBackport();
    if (patchErrors.length > 0) throw new Error(patchErrors.join("\n"));
    const evaluation = evaluateGrypeRustReport(
      runGrype(),
      JSON.parse(readFileSync(POLICY_PATH, "utf8")),
    );
    console.log(`Grype Rust/GHSA audit: ${evaluation.status.toUpperCase()}`);
    console.log(`Accepted temporary dispositions: ${evaluation.accepted.length}`);
    console.log(`Blocking vulnerabilities: ${evaluation.blocking.length}`);
    for (const item of evaluation.accepted) {
      console.log(`ACCEPT ${item.key} until ${item.disposition.expiresOn}: ${item.disposition.reason}`);
    }
    for (const item of evaluation.blocking) {
      console.log(`BLOCK ${item.key}: ${item.vulnerability?.description ?? "Grype vulnerability"}`);
    }
    for (const entry of evaluation.expired) console.log(`EXPIRED ${entry.advisoryId}:${entry.package} on ${entry.expiresOn}`);
    for (const dispositionKey of evaluation.stale) console.log(`STALE ${dispositionKey}: remove or update the disposition`);
    for (const error of evaluation.policyErrors) console.log(`POLICY ${error}`);
    process.exitCode = evaluation.status === "pass" ? 0 : 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
