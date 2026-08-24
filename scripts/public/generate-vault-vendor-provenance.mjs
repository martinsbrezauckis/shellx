import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";

const repoRoot = resolve(import.meta.dirname, "../..");
const vendorRoot = resolve(repoRoot, "vendor", "shellx-vault");
const manifestPath = resolve(vendorRoot, "PROVENANCE.json");
const crateNames = ["vault-broker", "vault-client", "vault-core", "vault-server"];
const topLevelFiles = ["Cargo.lock", "Cargo.toml", "LICENSE"];

const args = new Set(process.argv.slice(2));
const write = args.delete("--write");
const check = args.delete("--check");
const revision = takeValue(args, "--upstream-revision");
const committedAt = takeValue(args, "--upstream-committed-at");

if (args.size > 0 || write === check) {
  fail("usage: node scripts/public/generate-vault-vendor-provenance.mjs (--check | --write --upstream-revision=<40-hex> --upstream-committed-at=<ISO-8601>)");
}

if (write) {
  if (!revision || !/^[0-9a-f]{40}$/.test(revision)) {
    fail("--upstream-revision must be a full lowercase 40-hex Git revision");
  }
  if (!committedAt || Number.isNaN(Date.parse(committedAt))) {
    fail("--upstream-committed-at must be a valid ISO-8601 timestamp");
  }
  writeFileSync(manifestPath, canonicalManifest(revision, committedAt));
  console.log(`Wrote ${relative(repoRoot, manifestPath)}`);
} else {
  const current = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (current.schemaVersion !== 1) fail("Vault vendor provenance schemaVersion must be 1");
  if (!/^[0-9a-f]{40}$/.test(current.upstreamRevision ?? "")) {
    fail("Vault vendor provenance upstreamRevision must be a full lowercase 40-hex Git revision");
  }
  if (Number.isNaN(Date.parse(current.upstreamCommittedAt ?? ""))) {
    fail("Vault vendor provenance upstreamCommittedAt must be a valid ISO-8601 timestamp");
  }
  const expected = canonicalManifest(current.upstreamRevision, current.upstreamCommittedAt);
  const actual = readFileSync(manifestPath, "utf8");
  if (actual !== expected) {
    fail("vendor/shellx-vault/PROVENANCE.json does not match the checked-in Vault sources");
  }
  console.log(`Vault vendor provenance verified at ${current.upstreamRevision}`);
}

function canonicalManifest(upstreamRevision, upstreamCommittedAt) {
  const crates = Object.fromEntries(crateNames.map((name) => {
    const result = digestTree(resolve(vendorRoot, "crates", name));
    return [name, {
      path: `crates/${name}`,
      sourceDigestSha256: result.digest,
      fileCount: result.fileCount,
      byteCount: result.byteCount,
    }];
  }));
  const rootFiles = Object.fromEntries(topLevelFiles.map((name) => {
    const body = readFileSync(resolve(vendorRoot, name));
    return [name, {
      sha256: sha256(body),
      byteCount: body.byteLength,
    }];
  }));
  return `${JSON.stringify({
    schemaVersion: 1,
    upstreamProject: "ShellX Vault",
    upstreamRevision,
    upstreamCommittedAt,
    digestAlgorithm: "sha256(relative-path NUL sha256(file-bytes) LF)",
    crates,
    rootFiles,
  }, null, 2)}\n`;
}

function digestTree(root) {
  const entries = listFiles(root);
  const digest = createHash("sha256");
  let byteCount = 0;
  for (const entry of entries) {
    const body = readFileSync(resolve(root, entry));
    byteCount += body.byteLength;
    digest.update(entry);
    digest.update("\0");
    digest.update(sha256(body));
    digest.update("\n");
  }
  return { digest: digest.digest("hex"), fileCount: entries.length, byteCount };
}

function listFiles(root, directory = root) {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const path = resolve(directory, entry.name);
      if (entry.isSymbolicLink()) fail(`Vault vendor provenance does not accept symlinks: ${path}`);
      if (entry.isDirectory()) return listFiles(root, path);
      if (!entry.isFile() || !statSync(path).isFile()) fail(`Unsupported Vault vendor entry: ${path}`);
      return [relative(root, path).split(sep).join("/")];
    })
    .sort();
}

function sha256(body) {
  return createHash("sha256").update(body).digest("hex");
}

function takeValue(values, name) {
  const prefix = `${name}=`;
  const match = [...values].find((value) => value.startsWith(prefix));
  if (!match) return null;
  values.delete(match);
  return match.slice(prefix.length);
}

function fail(message) {
  throw new Error(message);
}
