#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  lstatSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { calculateManualAtlasProductSourceSha256 } from "./lib/manual-atlas-product-source.js";

export const PUBLIC_EXPORT_POLICY_SCHEMA = "shellx/public-export-policy@1";
export const PUBLIC_EXPORT_MANIFEST_SCHEMA = "shellx/public-export-manifest@4";

const POLICY_PATH = "release/public-export-policy.json";
const HUMAN_MANIFEST_PATH = "PUBLIC_EXPORT_MANIFEST.txt";
const JSON_MANIFEST_PATH = "PUBLIC_EXPORT_MANIFEST.json";
const MARKETING_ASSET_MANIFEST_PATH = "docs/public/assets/reviewed-assets.json";
const MARKETING_SOURCE_PREFIX = "docs/public/marketing-sources/";
const MANUAL_ATLAS_PATH = "docs/public/manual/shellx/visuals.json";
const GENERATED_CATEGORY = "generated-export-metadata";
const GENERATED_REASON = "Generated public-export provenance and operator-readable identity metadata.";
const GENERATED_CLASSIFICATION = {
  id: GENERATED_CATEGORY,
  category: GENERATED_CATEGORY,
  reason: GENERATED_REASON,
  matchedBy: "generated",
  matchedPath: null,
};
const TRACKED_GENERATED_CLASSIFICATIONS = new Map([
  [HUMAN_MANIFEST_PATH, { ...GENERATED_CLASSIFICATION, action: "include" }],
  [JSON_MANIFEST_PATH, { ...GENERATED_CLASSIFICATION, action: "exclude" }],
]);
const SUPPORTED_GIT_MODES = new Set(["100644", "100755"]);
const FORBIDDEN_SEGMENTS = new Set([
  ".cache",
  ".git",
  ".project",
  ".worktrees",
  "cache",
  "caches",
  "coverage",
  "dist",
  "node_modules",
  "overnight",
  "private",
  "raw-evidence",
  "receipts",
  "research",
  "reviews",
  "target",
]);
const FORBIDDEN_SUFFIXES = [
  ".bak",
  ".dump",
  ".log",
  ".orig",
  ".swp",
  ".tmp",
];
const FORBIDDEN_TEXT = [
  { id: "private-lan-address", pattern: /\b192\.168\.\d{1,3}\.\d{1,3}\b/ },
  { id: "private-key-material", pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
];

const PURPOSE_REVIEW_EXTENSIONS = new Set([
  ".csv",
  ".json",
  ".jsonl",
  ".log",
  ".md",
  ".ndjson",
  ".pdf",
  ".png",
  ".txt",
  ".webp",
  ".yaml",
  ".yml",
]);
const PURPOSE_REVIEW_TOKENS = new Set([
  "acceptance",
  "artifact",
  "artifacts",
  "audit",
  "audits",
  "draft",
  "evidence",
  "handoff",
  "local",
  "overnight",
  "plan",
  "planning",
  "plans",
  "private",
  "receipt",
  "receipts",
  "report",
  "reports",
  "research",
  "review",
  "reviews",
  "snapshot",
  "triage",
]);
const PURPOSE_REVIEW_PREFIXES = new Set([
  "scripts/",
  "src/",
  "src-tauri/",
  "vendor/",
]);

export function loadPublicExportPolicy(path) {
  const policy = JSON.parse(readFileSync(path, "utf8"));
  if (policy?.schema !== PUBLIC_EXPORT_POLICY_SCHEMA) {
    throw new Error(`public export policy must use ${PUBLIC_EXPORT_POLICY_SCHEMA}`);
  }
  if (!Array.isArray(policy.rules) || policy.rules.length === 0) {
    throw new Error("public export policy must declare rules");
  }
  const ids = new Set();
  for (const rule of policy.rules) {
    if (!rule?.id?.trim() || ids.has(rule.id)) throw new Error(`invalid or duplicate public export rule id: ${rule?.id ?? "missing"}`);
    ids.add(rule.id);
    if (rule.action !== "include" && rule.action !== "exclude") throw new Error(`rule ${rule.id} has invalid action`);
    if (!rule.category?.trim() || !rule.reason?.trim()) throw new Error(`rule ${rule.id} requires category and reason`);
    const exact = Array.isArray(rule.exact) ? rule.exact : [];
    const prefixes = Array.isArray(rule.prefixes) ? rule.prefixes : [];
    if (exact.length + prefixes.length === 0) throw new Error(`rule ${rule.id} has no paths`);
    for (const path of exact) validatePolicyPath(path, false, rule.id);
    for (const prefix of prefixes) validatePolicyPath(prefix, true, rule.id);
  }
  return policy;
}

export function classifyPublicExportPath(policy, path) {
  const generated = TRACKED_GENERATED_CLASSIFICATIONS.get(path);
  if (generated) return generated;

  const exactMatches = policy.rules.filter((rule) => (rule.exact ?? []).includes(path));
  if (exactMatches.length > 1) {
    throw new Error(`public export path ${path} has multiple exact policy rules: ${exactMatches.map((rule) => rule.id).join(", ")}`);
  }
  const exactMatch = exactMatches[0];
  if (exactMatch?.action === "exclude") return tracedClassification(exactMatch, "exact", path);

  const prefixMatches = policy.rules.flatMap((rule) => (rule.prefixes ?? [])
    .filter((prefix) => path.startsWith(prefix))
    .map((prefix) => ({ rule, prefix })));
  if (prefixMatches.length > 1) {
    throw new Error(`public export path ${path} has multiple prefix policy rules: ${prefixMatches.map(({ rule, prefix }) => `${rule.id}:${prefix}`).join(", ")}`);
  }
  const prefixMatch = prefixMatches[0];
  if (!exactMatch && prefixMatch?.rule.action === "exclude") {
    return tracedClassification(prefixMatch.rule, "prefix", prefixMatch.prefix);
  }

  const unsafeReason = unsafePathReason(path);
  if (unsafeReason) {
    return {
      id: "built-in-unsafe-path",
      action: "exclude",
      category: "unsafe-generated-or-private-path",
      reason: unsafeReason,
      matchedBy: "built-in",
      matchedPath: null,
    };
  }

  if (exactMatch) return tracedClassification(exactMatch, "exact", path);
  if (prefixMatch) {
    const { rule, prefix } = prefixMatch;
    if (rule.action === "include" && PURPOSE_REVIEW_PREFIXES.has(prefix) && suspiciousBroadInclude(path)) return null;
    return tracedClassification(rule, "prefix", prefix);
  }
  return null;
}

export function findPublicTextViolation(path, bytes) {
  const candidates = [new TextDecoder("utf-8").decode(bytes)];
  if (bytes.length >= 2) {
    candidates.push(new TextDecoder("utf-16le").decode(bytes));
    candidates.push(new TextDecoder("utf-16be").decode(bytes));
  }
  for (const text of candidates) {
    for (const rule of FORBIDDEN_TEXT) {
      if (rule.pattern.test(text)) return `${rule.id} in ${path}`;
    }
  }
  return null;
}

export function preparePublicExport({ repoRoot, payloadRoot, sourceCommit }) {
  const repo = resolve(repoRoot);
  const payload = resolve(payloadRoot);
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sourceCommit)) {
    throw new Error("source commit must be a full Git object ID");
  }
  const resolvedSourceCommit = git(repo, ["rev-parse", "--verify", `${sourceCommit}^{commit}`]).trim();
  if (resolvedSourceCommit !== sourceCommit) throw new Error("source commit identity is not canonical");
  const policyFile = join(payload, POLICY_PATH);
  const policy = loadPublicExportPolicy(policyFile);
  const policyBytes = readFileSync(policyFile);
  const sourceTree = git(repo, ["rev-parse", `${resolvedSourceCommit}^{tree}`]).trim();
  const rows = gitTree(repo, resolvedSourceCommit);
  const actualBefore = walkFiles(payload).sort();
  const trackedPaths = rows.map((row) => row.path).sort();
  const trackedPathSet = new Set(trackedPaths);
  const staleExactPaths = policy.rules.flatMap((rule) => (rule.exact ?? [])
    .filter((path) => !trackedPathSet.has(path))
    .map((path) => `${rule.id}:${path}`));
  if (staleExactPaths.length > 0) {
    throw new Error(`public export policy has ${staleExactPaths.length} exact path(s) absent from the source commit: ${staleExactPaths.slice(0, 20).join(", ")}`);
  }
  if (JSON.stringify(actualBefore) !== JSON.stringify(trackedPaths)) {
    throw new Error("public export staging tree contains files outside the committed source archive");
  }
  validateReviewedMarketingAssets(payload, trackedPathSet);

  const included = [];
  const excluded = [];
  const unknown = [];
  for (const row of rows) {
    if (row.type !== "blob" || !SUPPORTED_GIT_MODES.has(row.mode)) {
      throw new Error(`unsupported tracked entry ${row.path}: ${row.mode} ${row.type}`);
    }
    const classification = classifyPublicExportPath(policy, row.path);
    if (!classification) {
      unknown.push(row.path);
    } else if (classification.action === "exclude") {
      excluded.push({ row, classification });
    } else {
      const absolute = containedPath(payload, row.path);
      const stat = lstatSync(absolute);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`included path must be a regular non-symlink file: ${row.path}`);
      const bytes = readFileSync(absolute);
      if (gitBlobOid(bytes, row.oid.length) !== row.oid) {
        throw new Error(`included file does not match source commit: ${row.path}`);
      }
      const violation = findPublicTextViolation(row.path, bytes);
      if (violation) throw new Error(`public export hygiene violation: ${violation}`);
      if (row.path === HUMAN_MANIFEST_PATH) {
        rmSync(absolute);
        continue;
      }
      included.push(entryFor(row.path, row.mode, bytes, classification));
    }
  }
  if (unknown.length > 0) {
    throw new Error(`public export policy has no category for ${unknown.length} tracked path(s): ${unknown.slice(0, 20).join(", ")}`);
  }

  for (const { row } of excluded) rmSync(containedPath(payload, row.path));
  removeEmptyDirectories(payload);

  const human = [
    "ShellX public export",
    `Source commit: ${resolvedSourceCommit}`,
    `Source tree: ${sourceTree}`,
    `Policy: ${POLICY_PATH}`,
    "Generated by: scripts/public_export.sh",
    "",
    "Every payload file is classified by the committed public-export policy.",
    "Canonical-only documentation, raw evidence, machine-local data, caches, and worktrees are excluded.",
    "",
  ].join("\n");
  const humanPath = join(payload, HUMAN_MANIFEST_PATH);
  writeFileSync(humanPath, human, { encoding: "utf8", flag: "wx", mode: 0o644 });
  included.push(entryFor(HUMAN_MANIFEST_PATH, "100644", Buffer.from(human, "utf8"), GENERATED_CLASSIFICATION));
  included.sort((left, right) => left.path.localeCompare(right.path));

  const totalBytes = included.reduce((sum, entry) => sum + entry.bytes, 0);
  const manifest = {
    schema: PUBLIC_EXPORT_MANIFEST_SCHEMA,
    source: {
      commit: resolvedSourceCommit,
      tree: sourceTree,
    },
    policy: {
      schema: policy.schema,
      path: POLICY_PATH,
      sha256: sha256(policyBytes),
    },
    manifestFile: {
      path: JSON_MANIFEST_PATH,
      category: GENERATED_CATEGORY,
      reason: GENERATED_REASON,
      ruleId: GENERATED_CLASSIFICATION.id,
      matchedBy: GENERATED_CLASSIFICATION.matchedBy,
      matchedPath: GENERATED_CLASSIFICATION.matchedPath,
      selfExcludedFromEntries: true,
    },
    classification: {
      trackedFileCount: rows.length,
      includedTrackedFileCount: rows.length - excluded.length,
      excludedTrackedFileCount: excluded.length,
    },
    payload: {
      fileCount: included.length,
      totalBytes,
      digest: sha256(Buffer.from(JSON.stringify(included), "utf8")),
    },
    exclusions: {
      fileCount: excluded.length,
      byCategory: countByCategory(excluded.map(({ classification }) => classification.category)),
    },
    entries: included,
  };
  writeFileSync(join(payload, JSON_MANIFEST_PATH), `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o644,
  });
  return manifest;
}

function validateReviewedMarketingAssets(payload, trackedPathSet) {
  const marketingAssets = [...trackedPathSet]
    .filter((path) => path.startsWith("docs/public/assets/") && /\.(?:jpe?g|png|webp)$/i.test(path))
    .sort();
  if (marketingAssets.length === 0) return;
  if (!trackedPathSet.has(MARKETING_ASSET_MANIFEST_PATH)) {
    throw new Error(`public marketing images require ${MARKETING_ASSET_MANIFEST_PATH}`);
  }
  if (!trackedPathSet.has(MANUAL_ATLAS_PATH)) {
    throw new Error(`public marketing images require reviewed atlas metadata at ${MANUAL_ATLAS_PATH}`);
  }

  const manifest = readJsonObject(join(payload, MARKETING_ASSET_MANIFEST_PATH), "marketing asset manifest");
  if (manifest.schemaVersion !== "shellx.public-marketing-assets.v2") {
    throw new Error("marketing asset manifest has an unsupported schemaVersion");
  }
  if (!isNonEmptyString(manifest.reviewedAt)
    || !isNonEmptyString(manifest.generation?.mode)
    || !isNonEmptyString(manifest.generation?.prompt)
    || !isNonEmptyString(manifest.generation?.uiPolicy)
    || !Array.isArray(manifest.assets)) {
    throw new Error("marketing asset manifest is missing review or generation metadata");
  }

  const atlas = readJsonObject(join(payload, MANUAL_ATLAS_PATH), "manual visual atlas");
  const packageJson = readJsonObject(join(payload, "package.json"), "package manifest");
  if (!isNonEmptyString(packageJson.version)) throw new Error("package manifest is missing its version");
  const productSourceSha256 = calculateManualAtlasProductSourceSha256(payload);
  const revalidation = manifest.revalidation;
  if (!revalidation || revalidation.status !== "reviewed"
    || !/^[a-f0-9]{40,64}$/.test(revalidation.sourceCommit ?? "")
    || revalidation.productSourceSha256 !== productSourceSha256
    || !Number.isFinite(Date.parse(revalidation.reviewedAt ?? ""))
    || !/^[a-f0-9]{64}$/.test(revalidation.evidenceSha256 ?? "")) {
    throw new Error("marketing asset revalidation is missing, invalid, or belongs to different product bytes");
  }
  if (!atlas.captures || typeof atlas.captures !== "object" || Array.isArray(atlas.captures)) {
    throw new Error("manual visual atlas is missing captures");
  }
  const reviewedAtlasSources = new Map();
  for (const capture of Object.values(atlas.captures)) {
    if (!capture || typeof capture !== "object" || Array.isArray(capture)) continue;
    const sourcePath = typeof capture.file === "string"
      ? `docs/public/manual/shellx/${capture.file}`
      : "";
    if (capture.kind === "installed-candidate"
      && capture.review?.status === "reviewed"
      && /^[a-f0-9]{40,64}$/.test(capture.review?.sourceCommit ?? "")
      && capture.review?.productSourceSha256 === productSourceSha256
      && capture.review?.appVersion === packageJson.version
      && /^[a-z0-9][a-z0-9._-]{1,63}$/.test(capture.review?.platform ?? "")
      && /^[a-f0-9]{64}$/.test(capture.review?.sha256 ?? "")) {
      reviewedAtlasSources.set(sourcePath, capture.review.sha256);
    }
  }

  const declaredAssets = new Map();
  for (const entry of manifest.assets) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)
      || typeof entry.file !== "string" || !/^[a-zA-Z0-9._-]+\.(?:jpe?g|png|webp)$/i.test(entry.file)) {
      throw new Error("marketing asset manifest contains an unsafe asset filename");
    }
    const assetPath = `docs/public/assets/${entry.file}`;
    if (declaredAssets.has(assetPath)) throw new Error(`marketing asset manifest repeats ${assetPath}`);
    if (!marketingAssets.includes(assetPath)) throw new Error(`marketing asset manifest names missing asset ${assetPath}`);
    if (entry.status !== "reviewed" || !isNonEmptyString(entry.review)) {
      throw new Error(`marketing asset ${assetPath} is not reviewed`);
    }
    if (!/^[a-f0-9]{64}$/.test(entry.sha256 ?? "")
      || sha256(readFileSync(join(payload, assetPath))) !== entry.sha256) {
      throw new Error(`marketing asset ${assetPath} SHA-256 does not match reviewed metadata`);
    }
    if (!isNonEmptyString(entry.source)) throw new Error(`marketing asset ${assetPath} is missing its reviewed source`);
    const sourceAbsolute = resolve(join(payload, "docs/public/assets"), entry.source);
    const sourcePath = relative(payload, sourceAbsolute).split(sep).join("/");
    const manualAtlasSource = sourcePath.startsWith("docs/public/manual/shellx/assets/");
    const dedicatedMarketingSource = sourcePath.startsWith(MARKETING_SOURCE_PREFIX);
    if ((!manualAtlasSource && !dedicatedMarketingSource)
      || !trackedPathSet.has(sourcePath)
      || !/^[a-f0-9]{64}$/.test(entry.sourceSha256 ?? "")
      || sha256(readFileSync(sourceAbsolute)) !== entry.sourceSha256) {
      throw new Error(`marketing asset ${assetPath} has an invalid or drifting reviewed source`);
    }
    if (manualAtlasSource && reviewedAtlasSources.get(sourcePath) !== entry.sourceSha256) {
      throw new Error(`marketing asset ${assetPath} source is not a reviewed installed-candidate capture`);
    }
    if (dedicatedMarketingSource) {
      validateDedicatedMarketingSource(entry, assetPath, sourcePath, productSourceSha256, packageJson.version);
    }
    declaredAssets.set(assetPath, entry);
  }
  const undeclared = marketingAssets.filter((path) => !declaredAssets.has(path));
  if (undeclared.length > 0) {
    throw new Error(`public marketing images are missing reviewed metadata: ${undeclared.join(", ")}`);
  }
}

function validateDedicatedMarketingSource(entry, assetPath, sourcePath, productSourceSha256, appVersion) {
  const review = entry.sourceReview;
  const supportedKinds = new Set(["installed-candidate", "installed-browser-live-site-composite"]);
  if (!review || typeof review !== "object" || Array.isArray(review)
    || review.status !== "reviewed"
    || !supportedKinds.has(review.kind)
    || !/^[a-f0-9]{40,64}$/.test(review.sourceCommit ?? "")
    || review.productSourceSha256 !== productSourceSha256
    || review.appVersion !== appVersion
    || !/^[a-z0-9][a-z0-9._-]{1,63}$/.test(review.platform ?? "")
    || review.sha256 !== entry.sourceSha256
    || !Number.isFinite(Date.parse(review.reviewedAt ?? ""))) {
    throw new Error(`marketing asset ${assetPath} dedicated source review is invalid or belongs to different product bytes`);
  }
  if (review.kind === "installed-browser-live-site-composite") {
    if (!isNonEmptyString(review.composition)
      || !/^https:\/\//.test(review.liveUrl ?? "")
      || !Array.isArray(review.components)
      || review.components.length < 2
      || review.components.length > 8) {
      throw new Error(`marketing asset ${assetPath} Browser composite review is incomplete`);
    }
    const roles = new Set();
    for (const component of review.components) {
      if (!component || typeof component !== "object" || Array.isArray(component)
        || !/^[a-z][a-z0-9-]{2,63}$/.test(component.role ?? "")
        || !/^[a-f0-9]{64}$/.test(component.sha256 ?? "")
        || roles.has(component.role)) {
        throw new Error(`marketing asset ${assetPath} Browser composite components are invalid`);
      }
      roles.add(component.role);
    }
  }
  if (!sourcePath.endsWith(".png") && !sourcePath.endsWith(".jpg") && !sourcePath.endsWith(".webp")) {
    throw new Error(`marketing asset ${assetPath} dedicated source has an unsupported image type`);
  }
}

function readJsonObject(path, label) {
  let value;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value;
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function entryFor(path, mode, bytes, classification) {
  return {
    path,
    mode,
    sha256: sha256(bytes),
    bytes: bytes.length,
    ...classificationEntry(path, classification),
  };
}

function classificationEntry(path, classification) {
  return {
    path,
    ruleId: classification.id,
    matchedBy: classification.matchedBy,
    matchedPath: classification.matchedPath,
    category: classification.category,
    reason: classification.reason,
  };
}

function tracedClassification(rule, matchedBy, matchedPath) {
  return { ...rule, matchedBy, matchedPath };
}

function suspiciousBroadInclude(path) {
  const lower = path.toLowerCase();
  const extension = [...PURPOSE_REVIEW_EXTENSIONS].find((candidate) => lower.endsWith(candidate));
  if (!extension) return false;
  const tokens = lower.split(/[^a-z0-9]+/).filter(Boolean);
  return tokens.some((token) => PURPOSE_REVIEW_TOKENS.has(token))
    || /(?:^|[._/-])20\d{2}-\d{2}-\d{2}(?:[._/-]|$)/.test(lower);
}

function gitTree(repo, commit) {
  const output = execFileSync("git", ["-C", repo, "ls-tree", "-rz", "--full-tree", commit], {
    maxBuffer: 64 * 1024 * 1024,
  });
  return output.toString("utf8").split("\0").filter(Boolean).map((line) => {
    const match = line.match(/^(\d+)\s+(\S+)\s+([a-f0-9]+)\t(.+)$/);
    if (!match) throw new Error(`could not parse git tree row: ${line}`);
    return { mode: match[1], type: match[2], oid: match[3], path: match[4] };
  });
}

function git(repo, args) {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
}

function validatePolicyPath(path, prefix, ruleId) {
  if (typeof path !== "string" || !path || path.startsWith("/") || path.startsWith("\\") || /^[A-Za-z]:[\\/]/.test(path)) {
    throw new Error(`rule ${ruleId} contains an unsafe path`);
  }
  const normalized = prefix ? path.slice(0, -1) : path;
  if (normalized.split(/[\\/]+/).some((segment) => segment === ".." || segment === "")) {
    throw new Error(`rule ${ruleId} contains an unsafe path`);
  }
  if (path.includes("\\") || (prefix && !path.endsWith("/"))) {
    throw new Error(`rule ${ruleId} paths must use normalized repository syntax`);
  }
}

function unsafePathReason(path) {
  if (!path || path.startsWith("/") || path.startsWith("\\") || path.includes("\\")) return "Non-normalized or absolute paths cannot enter a public export.";
  const segments = path.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) return "Traversal or empty path segments cannot enter a public export.";
  const forbiddenSegment = segments.find((segment) => FORBIDDEN_SEGMENTS.has(segment.toLowerCase()));
  if (forbiddenSegment) return `Path segment ${forbiddenSegment} is reserved for private or generated state.`;
  const lower = path.toLowerCase();
  const suffix = FORBIDDEN_SUFFIXES.find((candidate) => lower.endsWith(candidate));
  if (suffix) return `Files ending in ${suffix} are generated or raw evidence rather than public source.`;
  if (segments.some((segment) => segment === ".DS_Store" || segment === "Thumbs.db")) return "Operating-system cache metadata is not public source.";
  return null;
}

function containedPath(root, path) {
  const absolute = resolve(root, path);
  const rel = relative(root, absolute);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`)) throw new Error(`path escapes public export staging root: ${path}`);
  return absolute;
}

function walkFiles(root) {
  const rows = [];
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const absolute = join(dir, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else rows.push(relative(root, absolute).split(sep).join("/"));
    }
  };
  visit(root);
  return rows;
}

function removeEmptyDirectories(root) {
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) visit(join(dir, entry.name));
    }
    if (dir !== root && readdirSync(dir).length === 0) rmdirSync(dir);
  };
  visit(root);
}

function countByCategory(values) {
  const counts = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function gitBlobOid(bytes, oidLength) {
  const algorithm = oidLength === 40 ? "sha1" : oidLength === 64 ? "sha256" : null;
  if (!algorithm) throw new Error(`unsupported Git object ID length: ${oidLength}`);
  return createHash(algorithm)
    .update(Buffer.from(`blob ${bytes.length}\0`, "utf8"))
    .update(bytes)
    .digest("hex");
}

function readArg(args, name) {
  const index = args.indexOf(name);
  if (index >= 0) return args[index + 1];
  const prefix = `${name}=`;
  return args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

async function main() {
  const args = process.argv.slice(2);
  const repoRoot = readArg(args, "--repo-root");
  const payloadRoot = readArg(args, "--payload-root");
  const sourceCommit = readArg(args, "--source-commit");
  if (!repoRoot || !payloadRoot || !sourceCommit) {
    throw new Error("Usage: prepare-public-export.mjs --repo-root <repo> --payload-root <archive> --source-commit <commit>");
  }
  const manifest = preparePublicExport({ repoRoot, payloadRoot, sourceCommit });
  process.stdout.write(`SHELLX_PUBLIC_EXPORT_MANIFEST_OK ${manifest.payload.fileCount} ${manifest.payload.digest}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`public export preparation failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
