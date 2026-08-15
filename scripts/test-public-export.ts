import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import {
  calculateManualAtlasProductSourceSha256,
  isProductSourcePath,
} from "./lib/manual-atlas-product-source.js";

const root = resolve(import.meta.dirname, "..");
const workspace = mkdtempSync(join(tmpdir(), "shellx-public-export-test-"));
const output = join(workspace, "shellx-public-export");
const gitOutput = join(workspace, "shellx-public-export-git");
const helper = join(root, "scripts/prepare-public-export.mjs");

let failures = 0;
function assert(condition: boolean, label: string): void {
  console.log(`  ${condition ? "✓" : "✗"} ${label}`);
  if (!condition) failures += 1;
}

function runExporter(destination: string, git = false): string {
  const script = join(root, "scripts/public_export.sh");
  const invocation = publicExporterInvocation(script, destination, ["--allow-dirty", ...(git ? ["--git"] : [])]);
  return execFileSync(invocation.executable, invocation.args, { cwd: root, encoding: "utf8" });
}

function publicExporterInvocation(script: string, destination: string, extraArgs: string[] = []): {
  executable: string;
  args: string[];
} {
  if (process.platform !== "win32") {
    return { executable: "bash", args: [script, "--out", destination, ...extraArgs] };
  }
  const bash = windowsGitBash();
  return {
    executable: bash,
    args: [
      "--noprofile",
      "--norc",
      windowsGitBashPath(bash, script),
      "--out",
      windowsGitBashPath(bash, destination),
      ...extraArgs,
    ],
  };
}

function windowsGitBash(): string {
  const gitPath = execFileSync("where.exe", ["git.exe"], { encoding: "utf8" })
    .split(/\r?\n/u)
    .map((path) => path.trim())
    .find(Boolean);
  if (!gitPath) throw new Error("Git for Windows is required to test the POSIX public exporter");
  const bash = resolve(dirname(gitPath), "..", "bin", "bash.exe");
  if (!existsSync(bash)) throw new Error(`Git for Windows Bash was not found at ${bash}`);
  return bash;
}

function windowsGitBashPath(bash: string, path: string): string {
  return execFileSync(bash, ["--noprofile", "--norc", "-c", 'cygpath -u -- "$1"', "shellx-cygpath", path], {
    encoding: "utf8",
  }).trim();
}

function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function listFiles(directory: string): string[] {
  const rows: string[] = [];
  const visit = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const absolute = join(current, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else rows.push(relative(directory, absolute).split(sep).join("/"));
    }
  };
  visit(directory);
  return rows.sort();
}

function localMarkdownLinkTargets(markdown: string): string[] {
  return [...markdown.matchAll(/!?\[[^\]]*\]\((<[^>]+>|[^)\s]+)(?:\s+["'][^"']*["'])?\)/g)]
    .map((match) => (match[1] ?? "").replace(/^<|>$/g, ""))
    .filter(Boolean);
}

function resolvePublicLocalTarget(exportRoot: string, sourcePath: string, rawTarget: string): string | null {
  if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(rawTarget)) return null;
  // Rustdoc disambiguators are symbolic intra-doc links, not filesystem paths.
  // Keep the finite supported kind set explicit so ordinary broken relative
  // links containing an at-sign still fail the public-export gate.
  if (/^(?:struct|enum|trait|union|fn|mod|method|const|static|type|macro|derive|prim)@[A-Za-z_][A-Za-z0-9_:]*[!?]?$/.test(rawTarget)) {
    return null;
  }
  const pathOnly = rawTarget.split(/[?#]/, 1)[0];
  if (!pathOnly) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathOnly);
  } catch {
    return "__invalid_encoding__";
  }
  const absolute = decoded.startsWith("/")
    ? resolve(exportRoot, `.${decoded}`)
    : resolve(dirname(join(exportRoot, sourcePath)), decoded);
  const relativeTarget = relative(exportRoot, absolute).split(sep).join("/");
  if (relativeTarget === ".." || relativeTarget.startsWith("../")) return "__outside_export__";
  return relativeTarget || ".";
}

assert(resolvePublicLocalTarget("/tmp/export", "vendor/glib/README.md", "struct@Variant") === null,
  "Rustdoc symbolic links are not treated as public payload paths");
assert(resolvePublicLocalTarget("/tmp/export", "README.md", "docs@guide.md") === "docs@guide.md",
  "ordinary relative links containing an at-sign remain checked");

function runSyntheticPolicyFixture(input: {
  name: string;
  files: Record<string, string | Buffer>;
  payloadMutations?: Record<string, string | Buffer>;
  staleExactPath?: string;
  helperPath?: string;
  expectSuccess: boolean;
}): { result: ReturnType<typeof spawnSync>; payload: string } {
  const fixtureRoot = join(workspace, input.name);
  const repo = join(fixtureRoot, "repo");
  const payload = join(fixtureRoot, "payload");
  mkdirSync(repo, { recursive: true });
  const policyPath = join(repo, "release/public-export-policy.json");
  mkdirSync(dirname(policyPath), { recursive: true });
  const fixturePaths = new Set([...Object.keys(input.files), "release/public-export-policy.json"]);
  const policy = JSON.parse(readFileSync(join(root, "release/public-export-policy.json"), "utf8")) as {
    rules: Array<{ id: string; exact?: string[]; prefixes?: string[] }>;
  };
  policy.rules = policy.rules.flatMap((rule) => {
    const exact = (rule.exact ?? []).filter((path) => fixturePaths.has(path));
    const prefixes = (rule.prefixes ?? []).filter((prefix) => [...fixturePaths].some((path) => path.startsWith(prefix)));
    if (exact.length + prefixes.length === 0) return [];
    return [{ ...rule, ...(exact.length ? { exact } : { exact: undefined }), ...(prefixes.length ? { prefixes } : { prefixes: undefined }) }];
  });
  if (input.staleExactPath) {
    const repositoryRule = policy.rules.find((rule) => rule.id === "repository-metadata");
    if (!repositoryRule) throw new Error("synthetic policy omitted repository metadata rule");
    repositoryRule.exact = [...(repositoryRule.exact ?? []), input.staleExactPath];
  }
  writeFileSync(policyPath, `${JSON.stringify(policy, null, 2)}\n`, "utf8");
  for (const [path, contents] of Object.entries(input.files)) {
    const absolute = join(repo, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, contents);
  }
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  execFileSync("git", ["add", "-A", "-f"], { cwd: repo });
  execFileSync("git", [
    "-c", "user.name=ShellX Export Test",
    "-c", "user.email=shellx-export-test@example.invalid",
    "commit", "-q", "-m", "fixture",
  ], { cwd: repo });
  cpSync(repo, payload, {
    recursive: true,
    filter: (source) => {
      const gitDirectory = join(repo, ".git");
      return source !== gitDirectory && !source.startsWith(`${gitDirectory}${sep}`);
    },
  });
  for (const [path, contents] of Object.entries(input.payloadMutations ?? {})) {
    writeFileSync(join(payload, path), contents);
  }
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
  const result = spawnSync(process.execPath, [
    input.helperPath ?? helper,
    "--repo-root", repo,
    "--payload-root", payload,
    "--source-commit", commit,
  ], { cwd: root, encoding: "utf8" });
  const diagnostic = result.stderr.trim().replace(/\s+/g, " ");
  assert(
    (result.status === 0) === input.expectSuccess,
    `${input.name} has expected exporter status${diagnostic ? ` (${diagnostic})` : ""}`,
  );
  return { result, payload };
}

console.log("\n=== public export boundary ===");

try {
  assert(isProductSourcePath("src/components/Browser.tsx"), "visual product identity includes shipped frontend source");
  assert(isProductSourcePath("src-tauri/src/shellx_browser.rs"), "visual product identity includes shipped native source");
  assert(!isProductSourcePath("src/components/Browser.test.tsx"), "visual product identity excludes colocated frontend tests");
  assert(!isProductSourcePath("src-tauri/src/shellx_browser_tests.rs"), "visual product identity excludes native test modules");
  assert(!isProductSourcePath("src-tauri/src/host_mcp/tests/contract.rs"), "visual product identity excludes nested native tests");
  const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const outputText = runExporter(output);
  assert(outputText.includes(`SHELLX_PUBLIC_EXPORT_OK ${sourceCommit}`), "export reports exact committed source identity");
  const publicAttributes = readFileSync(join(output, ".gitattributes"), "utf8");
  assert(publicAttributes.includes("*.sh text eol=lf") && !publicAttributes.includes("\r"),
    "public clones keep Bash scripts and export metadata on LF line endings");
  assert(existsSync(join(output, "package.json")), "package metadata is exported");
  assert(existsSync(join(output, "src-tauri/src/lib.rs")), "native product source is exported");
  assert(existsSync(join(output, "skills/shellx-host/SKILL.md")), "installer-embedded host skill is exported");
  assert(existsSync(join(output, "docs/public/manual/shellx/index.html")), "interactive manual is exported");
  assert(existsSync(join(output, "docs/public/SHELLX_MANUAL.md")), "repository manual is exported");
  const vaultProvenancePath = join(output, "vendor/shellx-vault/PROVENANCE.json");
  assert(existsSync(vaultProvenancePath), "vendored Vault provenance is exported");
  const vaultProvenance = JSON.parse(readFileSync(vaultProvenancePath, "utf8")) as {
    upstreamRevision?: string;
    crates?: Record<string, { sourceDigestSha256?: string }>;
  };
  assert(
    /^[0-9a-f]{40}$/.test(vaultProvenance.upstreamRevision ?? "") &&
      Object.keys(vaultProvenance.crates ?? {}).sort().join(",") === "vault-broker,vault-client,vault-core,vault-server" &&
      Object.values(vaultProvenance.crates ?? {}).every((crate) => /^[0-9a-f]{64}$/.test(crate.sourceDigestSha256 ?? "")),
    "exported Vault provenance binds one full upstream revision and four SHA-256 crate digests",
  );
  const initialPayloadFiles = listFiles(output);
  assert(initialPayloadFiles.every((path) => !path.startsWith("docs/private/")), "the complete docs/private tree is excluded without publishing its filenames");
  assert(!existsSync(join(output, ".git")), "plain export does not synthesize Git metadata");
  assert(!existsSync(join(output, "node_modules")), "installed dependencies are excluded by committed-source export");
  assert(!existsSync(join(output, "dist")), "untracked build output is excluded by committed-source export");
  assert(!existsSync(join(output, ".worktrees")), "linked worktrees are excluded");

  const humanManifest = readFileSync(join(output, "PUBLIC_EXPORT_MANIFEST.txt"), "utf8");
  assert(humanManifest.includes(`Source commit: ${sourceCommit}`), "human manifest binds the full source commit");
  const manifestText = readFileSync(join(output, "PUBLIC_EXPORT_MANIFEST.json"), "utf8");
  const manifest = JSON.parse(manifestText) as {
    schema: string;
    source: { commit: string; tree: string };
    policy: { schema: string; path: string; sha256: string };
    manifestFile: {
      path: string;
      category: string;
      reason: string;
      ruleId: string;
      matchedBy: string;
      matchedPath: string | null;
      selfExcludedFromEntries: boolean;
    };
    classification: { trackedFileCount: number; includedTrackedFileCount: number; excludedTrackedFileCount: number };
    payload: { fileCount: number; totalBytes: number; digest: string };
    exclusions: {
      fileCount: number;
      byCategory: Record<string, number>;
    };
    entries: Array<{
      path: string;
      mode: string;
      sha256: string;
      bytes: number;
      ruleId: string;
      matchedBy: string;
      matchedPath: string | null;
      category: string;
      reason: string;
    }>;
  };
  const sourceTree = execFileSync("git", ["rev-parse", "HEAD^{tree}"], { cwd: root, encoding: "utf8" }).trim();
  assert(manifest.schema === "shellx/public-export-manifest@4", "machine manifest uses the privacy-preserving classification schema");
  assert(manifest.source.commit === sourceCommit && manifest.source.tree === sourceTree, "machine manifest binds source commit and tree");
  assert(manifest.policy.path === "release/public-export-policy.json", "manifest identifies the committed classification policy");
  assert(manifest.policy.sha256 === sha256(readFileSync(join(output, manifest.policy.path))), "manifest binds the exact policy bytes");
  assert(manifest.manifestFile.selfExcludedFromEntries === true, "manifest declares its self-reference exception");
  assert(Boolean(manifest.manifestFile.category && manifest.manifestFile.reason), "generated manifest has an explicit public category and reason");

  const payloadFiles = listFiles(output).filter((path) => path !== "PUBLIC_EXPORT_MANIFEST.json");
  assert(manifest.entries.length === payloadFiles.length, "every exported payload file has exactly one manifest entry");
  assert(new Set(manifest.entries.map((entry) => entry.path)).size === manifest.entries.length, "manifest paths are unique");
  assert(JSON.stringify(manifest.entries.map((entry) => entry.path).sort()) === JSON.stringify(payloadFiles), "manifest path set equals the exported payload path set");
  const invalidBytes: string[] = [];
  const invalidHashes: string[] = [];
  const invalidModes: string[] = [];
  const invalidClassifications: string[] = [];
  for (const entry of manifest.entries) {
    const bytes = readFileSync(join(output, entry.path));
    if (entry.bytes !== bytes.length) invalidBytes.push(entry.path);
    if (entry.sha256 !== sha256(bytes)) invalidHashes.push(entry.path);
    if (entry.mode !== "100644" && entry.mode !== "100755") invalidModes.push(entry.path);
    if (!entry.category || !entry.reason || !entry.ruleId || !entry.matchedBy
      || (entry.matchedBy !== "generated" && !entry.matchedPath)) invalidClassifications.push(entry.path);
  }
  assert(invalidBytes.length === 0, "all manifest entries record exact bytes");
  assert(invalidHashes.length === 0, "all manifest entries record exact SHA-256 values");
  assert(invalidModes.length === 0, "all manifest entries record supported Git modes");
  assert(invalidClassifications.length === 0, "all manifest entries have an explicit reason and policy-rule trace");
  assert(manifest.payload.fileCount === manifest.entries.length, "payload summary records exact file count");
  assert(manifest.payload.totalBytes === manifest.entries.reduce((sum, entry) => sum + entry.bytes, 0), "payload summary records exact byte count");
  assert(manifest.payload.digest === sha256(JSON.stringify(manifest.entries)), "payload digest binds the ordered manifest entries");
  assert(!("entries" in manifest.exclusions), "excluded private filenames are not published in the machine manifest");
  assert(!manifestText.includes("docs/private/"), "machine manifest does not disclose private documentation paths");
  const sourceTrackedPaths = new Set(execFileSync("git", ["ls-tree", "-r", "--name-only", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim().split("\n").filter(Boolean));
  const includedTrackedPaths = manifest.entries.map((entry) => entry.path).filter((path) => sourceTrackedPaths.has(path));
  assert(includedTrackedPaths.length + manifest.exclusions.fileCount === sourceTrackedPaths.size,
    "included paths plus aggregated exclusions account for the complete source tree");
  assert(manifest.classification.trackedFileCount === sourceTrackedPaths.size, "classification summary records the exact tracked-file count");
  assert(manifest.classification.includedTrackedFileCount === includedTrackedPaths.length, "classification summary records exact included tracked files");
  assert(manifest.classification.excludedTrackedFileCount === manifest.exclusions.fileCount, "classification summary records exact excluded tracked files");
  const expectedPrivateDocCount = [...sourceTrackedPaths].filter((path) => path.startsWith("docs/private/")).length;
  assert((manifest.exclusions.byCategory["private-working-documentation"] ?? 0) === expectedPrivateDocCount,
    "the complete docs/private boundary is represented only by an aggregate count");
  const unclassifiedDocs = [...sourceTrackedPaths]
    .filter((path) => path.startsWith("docs/")
      && !path.startsWith("docs/public/")
      && !path.startsWith("docs/private/"));
  assert(unclassifiedDocs.length === 0, "working documentation has no unclassified legacy docs paths");
  assert(manifest.entries
    .filter((entry) => entry.path.startsWith("docs/"))
    .every((entry) => entry.path.startsWith("docs/public/")), "only docs/public is present beneath docs in the export");
  assert(manifest.entries.some((entry) => entry.path === "docs/public/API.md" && entry.category === "public-product-documentation"), "public API documentation retains its category");
  assert(manifest.entries.some((entry) => entry.path === "docs/public/THREAT_MODEL.md"), "public threat model is preserved");
  assert(manifest.entries.some((entry) => entry.path === "release/surface-contract.json" && entry.category === "public-release-contracts"), "public release contract is preserved");

  const publicPolicy = JSON.parse(readFileSync(join(output, "release/public-export-policy.json"), "utf8")) as {
    rules: Array<{ id: string; action: string; exact?: string[]; prefixes?: string[] }>;
  };
  const broadIncludeRules = publicPolicy.rules.filter((rule) => rule.action === "include" && (rule.prefixes?.length ?? 0) > 0);
  const broadIncludePrefixes = broadIncludeRules.flatMap((rule) => rule.prefixes ?? []).sort();
  assert(
    JSON.stringify(broadIncludePrefixes) === JSON.stringify(["docs/public/", "scripts/", "src-tauri/", "src/", "vendor/"]),
    "broad includes are limited to docs/public and the four reviewed source trees",
  );
  assert(
    publicPolicy.rules.filter((rule) => ["public-automation", "public-security-policy", "public-agent-resources"].includes(rule.id))
      .every((rule) => (rule.prefixes?.length ?? 0) === 0 && (rule.exact?.length ?? 0) > 0),
    "automation, security policy, and agent resources require exact-path promotion",
  );
  const publicDocumentRule = publicPolicy.rules.find((rule) => rule.id === "public-product-documentation");
  const privateDocumentRule = publicPolicy.rules.find((rule) => rule.id === "private-working-documentation");
  assert(JSON.stringify(publicDocumentRule?.prefixes) === JSON.stringify(["docs/public/"])
    && (publicDocumentRule?.exact?.length ?? 0) === 0, "docs/public is the single positive documentation root");
  assert(privateDocumentRule?.action === "exclude"
    && JSON.stringify(privateDocumentRule.prefixes) === JSON.stringify(["docs/private/"]), "docs/private is excluded as one directory boundary");

  const brokenMarkdownLinks: string[] = [];
  for (const path of payloadFiles.filter((entry) => entry.endsWith(".md"))) {
    const markdown = readFileSync(join(output, path), "utf8");
    for (const target of localMarkdownLinkTargets(markdown)) {
      const resolvedTarget = resolvePublicLocalTarget(output, path, target);
      if (resolvedTarget !== null && !existsSync(join(output, resolvedTarget))) {
        brokenMarkdownLinks.push(`${path} -> ${target}`);
      }
    }
  }
  assert(brokenMarkdownLinks.length === 0, `all exported Markdown links resolve inside the public payload${brokenMarkdownLinks.length ? ` (${brokenMarkdownLinks.join(", ")})` : ""}`);

  const discoverableRuleIds = new Set(["public-product-documentation", "public-release-contracts"]);
  const publicMarkdownDocuments = payloadFiles
    .filter((path) => path.startsWith("docs/public/") && path.endsWith(".md"));
  publicMarkdownDocuments.push(...publicPolicy.rules
    .filter((rule) => discoverableRuleIds.has(rule.id))
    .flatMap((rule) => rule.exact ?? [])
    .filter((path) => path.endsWith(".md")));
  publicMarkdownDocuments.push("shellx-browser/README.md");
  const publicTextPaths = payloadFiles.filter((path) => path !== "release/public-export-policy.json"
    && /\.(?:css|html|js|json|md|txt)$/.test(path));
  const undiscoverableDocuments = publicMarkdownDocuments.filter((documentPath) => {
    const basename = documentPath.split("/").at(-1) ?? documentPath;
    return !publicTextPaths.some((sourcePath) => sourcePath !== documentPath
      && (readFileSync(join(output, sourcePath), "utf8").includes(documentPath)
        || readFileSync(join(output, sourcePath), "utf8").includes(basename)));
  });
  assert(undiscoverableDocuments.length === 0, `every promoted public Markdown document is referenced by another public surface${undiscoverableDocuments.length ? ` (${undiscoverableDocuments.join(", ")})` : ""}`);
  assert(readFileSync(join(output, "README.md"), "utf8").includes("release/FINAL_SURFACE_GATE.md"), "README links the exhaustive final release surface gate");
  assert(readFileSync(join(output, "README.md"), "utf8").includes("shellx-browser/README.md"), "README links the Browser module guide");

  const publicApi = readFileSync(join(output, "docs/public/API.md"), "utf8");
  const publicHostSkill = readFileSync(join(output, "skills/shellx-host/SKILL.md"), "utf8");
  const publicBrowserGuide = readFileSync(join(output, "shellx-browser/README.md"), "utf8");
  const publicReadme = readFileSync(join(output, "README.md"), "utf8");
  for (const [path, text] of [
    ["README.md", publicReadme],
    ["docs/public/API.md", publicApi],
    ["skills/shellx-host/SKILL.md", publicHostSkill],
    ["shellx-browser/README.md", publicBrowserGuide],
  ] as const) {
    assert(!/\$\(\s*cat\s+~\/\.shellx\/(?:shellxagent|mcp)\.token\s*\)/.test(text), `${path} must not publish a shell command that loads a bearer token`);
    assert(!/\b(?:TOKEN|SECRET)\s*=\s*["']?\$\(/.test(text), `${path} must not publish a shell variable loader for secret material`);
    assert(!/~\/\.shellx\/(?:shellxagent|mcp)\.token/.test(text), `${path} must not direct public readers to a raw bearer-token path`);
  }

  const publicWindowsSigningProfile = JSON.parse(readFileSync(join(output, "release/windows-signing-profile.json"), "utf8")) as Record<string, unknown>;
  assert(publicWindowsSigningProfile.schema === "shellx/windows-signing-profile@2", "public Windows signing policy uses the certificate-only schema");
  for (const privateField of ["provider", "endpointHost", "accountName", "profileName"]) {
    assert(!(privateField in publicWindowsSigningProfile), `public Windows signing policy omits private ${privateField}`);
  }
  const signingContractPaths = [
    "release/FINAL_SURFACE_GATE.md",
    "release/windows-signing-profile.json",
    "scripts/test-release-surface-windows-nsis-installation.ts",
    "scripts/test-release-surface-candidate-attestation.ts",
    "scripts/test-release-surface-signature-receipt.ts",
  ];
  const signingContracts = signingContractPaths.map((path) => readFileSync(join(output, path), "utf8")).join("\n");
  assert((signingContracts.match(/expectedEndpointHost:\s*["']fixture\.codesigning\.azure\.net["']/g) ?? []).length === 3,
    "public signing fixtures use only the synthetic Azure endpoint identity");
  assert((signingContracts.match(/expectedAccountName:\s*["']fixture-account["']/g) ?? []).length === 3,
    "public signing fixtures use only the synthetic Azure account identity");
  assert((signingContracts.match(/expectedProfileName:\s*["']fixture-profile["']/g) ?? []).length === 3,
    "public signing fixtures use only the synthetic Azure profile identity");

  const publicAssets = payloadFiles
    .filter((path) => path.startsWith("docs/public/") && /\.(?:png|jpe?g|webp|svg)$/.test(path));
  const unreferencedAssets = publicAssets.filter((assetPath) => {
    const basename = assetPath.split("/").at(-1) ?? assetPath;
    return !publicTextPaths.some((sourcePath) => {
      const text = readFileSync(join(output, sourcePath), "utf8");
      return text.includes(assetPath) || text.includes(basename);
    });
  });
  assert(unreferencedAssets.length === 0, `every promoted documentation asset is referenced by public content${unreferencedAssets.length ? ` (${unreferencedAssets.join(", ")})` : ""}`);

  const marketingReview = JSON.parse(readFileSync(join(output, "docs/public/assets/reviewed-assets.json"), "utf8")) as {
    schemaVersion: string;
    assets: Array<{ file: string; sha256: string; source: string; sourceSha256: string; status: string }>;
  };
  const marketingAssets = publicAssets
    .filter((path) => path.startsWith("docs/public/assets/") && /\.(?:png|jpe?g|webp)$/.test(path))
    .sort();
  const reviewedMarketingAssets = marketingReview.assets.map((entry) => `docs/public/assets/${entry.file}`).sort();
  assert(marketingReview.schemaVersion === "shellx.public-marketing-assets.v2", "marketing image review manifest uses the supported schema");
  assert(JSON.stringify(reviewedMarketingAssets) === JSON.stringify(marketingAssets), "every public marketing raster has exactly one review entry");
  assert(marketingReview.assets.every((entry) => entry.status === "reviewed"
    && sha256(readFileSync(join(output, "docs/public/assets", entry.file))) === entry.sha256),
  "every public marketing raster matches its reviewed SHA-256");

  const manualRoot = join(output, "docs/public/manual/shellx");
  const manualHtml = readFileSync(join(manualRoot, "index.html"), "utf8");
  const manualContent = JSON.parse(readFileSync(join(manualRoot, "content.json"), "utf8")) as {
    sections: Array<{ features: Array<{ id: string }> }>;
  };
  const manualFeatureIds = new Set(manualContent.sections.flatMap((section) => section.features.map((feature) => feature.id)));
  const deepLinks = [...manualHtml.matchAll(/href="\?feature=([^"]+)"/g)].map((match) => decodeURIComponent(match[1] ?? ""));
  assert(deepLinks.length === manualFeatureIds.size, "manual renders one article permalink for every feature");
  assert(deepLinks.every((id) => manualFeatureIds.has(id)), "every manual feature deep link resolves to a generated article");
  const manualNavigationIds = [...manualHtml.matchAll(/data-feature-link="([^"]+)"/g)].map((match) => match[1] ?? "");
  assert(manualNavigationIds.length === manualFeatureIds.size, "manual renders one interactive navigation item for every feature");
  assert(manualNavigationIds.every((id) => manualFeatureIds.has(id)), "every manual navigation item resolves to a generated article");
  const familyRoutes = new Set([
    "../../",
    "../browser/",
    "../canvas/",
    "../cut/",
    "../drive/",
    "../motion/",
    "../vault/",
  ]);
  const brokenManualAssets: string[] = [];
  for (const match of manualHtml.matchAll(/(?:href|src)="([^"]+)"/g)) {
    const target = match[1];
    if (!target) continue;
    if (familyRoutes.has(target) || target.startsWith("?feature=") || target.startsWith("#")) continue;
    const resolvedTarget = resolvePublicLocalTarget(output, "docs/public/manual/shellx/index.html", target);
    if (resolvedTarget !== null && !existsSync(join(output, resolvedTarget))) brokenManualAssets.push(target);
  }
  assert(brokenManualAssets.length === 0, `manual local styles, scripts, and images resolve inside the public payload${brokenManualAssets.length ? ` (${brokenManualAssets.join(", ")})` : ""}`);

  const repeatInvocation = publicExporterInvocation(join(root, "scripts/public_export.sh"), output, ["--allow-dirty"]);
  const repeat = spawnSync(repeatInvocation.executable, repeatInvocation.args, {
    cwd: root,
    encoding: "utf8",
  });
  assert(repeat.status === 2 && repeat.stderr.includes("must be empty"), "non-empty destination fails closed");

  const sourceInvocation = publicExporterInvocation(join(root, "scripts/public_export.sh"), root, ["--allow-dirty"]);
  const sourceTarget = spawnSync(sourceInvocation.executable, sourceInvocation.args, {
    cwd: root,
    encoding: "utf8",
  });
  assert(sourceTarget.status === 2 && sourceTarget.stderr.includes("unsafe"), "source checkout cannot be an export destination");

  const nestedTargetPath = join(root, "public-export-nested-test");
  const nestedInvocation = publicExporterInvocation(join(root, "scripts/public_export.sh"), nestedTargetPath, ["--allow-dirty"]);
  const nestedTarget = spawnSync(nestedInvocation.executable, nestedInvocation.args, {
    cwd: root,
    encoding: "utf8",
  });
  assert(nestedTarget.status === 2 && nestedTarget.stderr.includes("unsafe"), "destination inside the source checkout fails closed");
  assert(!existsSync(nestedTargetPath), "rejected nested destination is not created");

  runExporter(gitOutput, true);
  assert(readFileSync(join(gitOutput, "PUBLIC_EXPORT_MANIFEST.json"), "utf8") === manifestText, "repeated export manifest is deterministic");
  assert(existsSync(join(gitOutput, ".git")), "optional local Git export is initialized");
  const exportStatus = execFileSync("git", ["status", "--short"], { cwd: gitOutput, encoding: "utf8" });
  assert(exportStatus.trim() === "", "optional local Git export is clean after its local commit");

  const secondGeneration = join(workspace, "public-export-second-generation");
  const secondGenerationInvocation = publicExporterInvocation(
    join(gitOutput, "scripts/public_export.sh"),
    secondGeneration,
  );
  const secondGenerationRun = spawnSync(secondGenerationInvocation.executable, secondGenerationInvocation.args, {
    cwd: gitOutput,
    encoding: "utf8",
  });
  assert(secondGenerationRun.status === 0, `a committed public export can produce another sanitized export${secondGenerationRun.stderr ? ` (${secondGenerationRun.stderr.trim()})` : ""}`);
  const secondGenerationManifest = JSON.parse(readFileSync(join(secondGeneration, "PUBLIC_EXPORT_MANIFEST.json"), "utf8")) as {
    source: { commit: string };
    entries: Array<{ path: string }>;
    exclusions: { fileCount: number; byCategory: Record<string, number> };
  };
  const publicExportCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: gitOutput, encoding: "utf8" }).trim();
  assert(secondGenerationManifest.source.commit === publicExportCommit, "second-generation export binds its committed public source identity");
  assert(secondGenerationManifest.entries.some((entry) => entry.path === "PUBLIC_EXPORT_MANIFEST.txt"), "tracked human export metadata is regenerated and included exactly once");
  assert((secondGenerationManifest.exclusions.byCategory["generated-export-metadata"] ?? 0) === 1,
    "tracked self-referential machine metadata is aggregated before regeneration without exposing its source path");

  const unknown = runSyntheticPolicyFixture({
    name: "unknown-policy-path",
    files: {
      "README.md": "fixture\n",
      "unclassified-root/data.txt": "must fail closed\n",
    },
    expectSuccess: false,
  });
  assert(unknown.result.stderr.includes("no category"), "unclassified tracked paths fail closed");

  const publicDocs = runSyntheticPolicyFixture({
    name: "public-docs-positive-root",
    files: {
      "README.md": "fixture\n",
      "docs/public/evidence-plan.md": "# Public evidence plan\n",
    },
    expectSuccess: true,
  });
  assert(existsSync(join(publicDocs.payload, "docs/public/evidence-plan.md")), "docs/public remains authoritative even when a public filename contains review-sensitive words");

  const privateDocs = runSyntheticPolicyFixture({
    name: "private-docs-directory-boundary",
    files: {
      "README.md": "fixture\n",
      "docs/private/audit.md": "# Internal audit\n",
    },
    expectSuccess: true,
  });
  assert(!existsSync(join(privateDocs.payload, "docs/private/audit.md")), "docs/private content is removed as one directory boundary");

  const legacyDocs = runSyntheticPolicyFixture({
    name: "unclassified-legacy-docs",
    files: {
      "README.md": "fixture\n",
      "docs/guide.md": "# Unclassified guide\n",
    },
    expectSuccess: false,
  });
  assert(legacyDocs.result.stderr.includes("no category"), "unclassified legacy docs paths fail closed");

  const privateLanFixture = ["192", ".168", ".42", ".99"].join("");
  const nulBinary = runSyntheticPolicyFixture({
    name: "nul-binary-hygiene",
    files: {
      "README.md": Buffer.concat([Buffer.from([0x00, 0x01, 0x02, 0x00]), Buffer.from(privateLanFixture)]),
    },
    expectSuccess: false,
  });
  assert(nulBinary.result.stderr.includes("hygiene violation"), "NUL-containing binary payloads cannot bypass public marker checks");

  const utf16Binary = runSyntheticPolicyFixture({
    name: "utf16-binary-hygiene",
    files: {
      "README.md": Buffer.from(privateLanFixture, "utf16le"),
    },
    expectSuccess: false,
  });
  assert(utf16Binary.result.stderr.includes("hygiene violation"), "UTF-16 payloads cannot bypass public marker checks");

  const unreviewedMarketing = runSyntheticPolicyFixture({
    name: "unreviewed-marketing-image",
    files: {
      "README.md": "![fixture](docs/public/assets/hero.png)\n",
      "docs/public/assets/hero.png": Buffer.from("fixture-marketing-image"),
    },
    expectSuccess: false,
  });
  assert(unreviewedMarketing.result.stderr.includes("require docs/public/assets/reviewed-assets.json"),
    "public marketing rasters require an explicit review manifest");

  const marketingAsset = Buffer.from("fixture-marketing-image");
  const marketingSource = Buffer.from("fixture-installed-candidate-image");
  const marketingSourceSha = sha256(marketingSource);
  const marketingProductFiles: Record<string, string | Buffer> = {
    "index.html": "<main>fixture</main>\n",
    "package.json": "{\"version\":\"0.3.5\"}\n",
    "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
    "shellx-browser.html": "<main>fixture browser</main>\n",
    "src-tauri/Cargo.lock": "# fixture\n",
    "src-tauri/Cargo.toml": "[package]\nname = \"shellx-fixture\"\nversion = \"0.3.5\"\n",
    "src-tauri/build.rs": "fn main() {}\n",
    "src-tauri/tauri.conf.json": "{}\n",
    "vite.config.ts": "export default {};\n",
    "src/fixture.ts": "export const fixture = true;\n",
    "src-tauri/capabilities/fixture.json": "{}\n",
    "src-tauri/icons/fixture.png": Buffer.from("fixture-icon"),
    "src-tauri/src/fixture.rs": "pub const FIXTURE: bool = true;\n",
  };
  const marketingProductRoot = join(workspace, "marketing-product-source");
  for (const [path, contents] of Object.entries(marketingProductFiles)) {
    const absolute = join(marketingProductRoot, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, contents);
  }
  const marketingProductSha = calculateManualAtlasProductSourceSha256(marketingProductRoot);
  const marketingRevalidation = {
    status: "reviewed",
    sourceCommit: "b".repeat(40),
    productSourceSha256: marketingProductSha,
    reviewedAt: "2026-08-08",
    evidenceSha256: "c".repeat(64),
  };
  const marketingVisuals = `${JSON.stringify({
    revalidation: marketingRevalidation,
    captures: {
      fixture: {
        file: "assets/source.png",
        kind: "installed-candidate",
        review: {
          status: "reviewed",
          sourceCommit: "a".repeat(40),
          productSourceSha256: marketingProductSha,
          appVersion: "0.3.5",
          platform: "linux-installed",
          sha256: marketingSourceSha,
        },
      },
    },
  }, null, 2)}\n`;
  const marketingManifest = (assetSha256: string): string => `${JSON.stringify({
    schemaVersion: "shellx.public-marketing-assets.v2",
    reviewedAt: "2026-08-05",
    revalidation: marketingRevalidation,
    generation: { mode: "fixture", prompt: "fixture prompt", uiPolicy: "fixture policy" },
    assets: [{
      file: "hero.png",
      sha256: assetSha256,
      source: "../manual/shellx/assets/source.png",
      sourceSha256: marketingSourceSha,
      status: "reviewed",
      review: "fixture review",
    }],
  }, null, 2)}\n`;
  const driftingMarketing = runSyntheticPolicyFixture({
    name: "drifting-marketing-image",
    files: {
      ...marketingProductFiles,
      "README.md": "![fixture](docs/public/assets/hero.png)\n",
      "docs/public/assets/hero.png": marketingAsset,
      "docs/public/assets/reviewed-assets.json": marketingManifest("0".repeat(64)),
      "docs/public/manual/shellx/assets/source.png": marketingSource,
      "docs/public/manual/shellx/visuals.json": marketingVisuals,
    },
    expectSuccess: false,
  });
  assert(driftingMarketing.result.stderr.includes("SHA-256 does not match"), "reviewed marketing asset byte drift fails closed");

  const missingRevalidationData = JSON.parse(marketingManifest(sha256(marketingAsset)));
  delete missingRevalidationData.revalidation;
  const missingMarketingRevalidation = runSyntheticPolicyFixture({
    name: "missing-marketing-revalidation",
    files: {
      ...marketingProductFiles,
      "README.md": "![fixture](docs/public/assets/hero.png)\n",
      "docs/public/assets/hero.png": marketingAsset,
      "docs/public/assets/reviewed-assets.json": `${JSON.stringify(missingRevalidationData, null, 2)}\n`,
      "docs/public/manual/shellx/assets/source.png": marketingSource,
      "docs/public/manual/shellx/visuals.json": marketingVisuals,
    },
    expectSuccess: false,
  });
  assert(missingMarketingRevalidation.result.stderr.includes("marketing asset revalidation"),
    "marketing exports fail closed without a current product revalidation receipt");

  const reviewedMarketing = runSyntheticPolicyFixture({
    name: "reviewed-marketing-image",
    files: {
      ...marketingProductFiles,
      "README.md": "![fixture](docs/public/assets/hero.png)\n",
      "docs/public/assets/hero.png": marketingAsset,
      "docs/public/assets/reviewed-assets.json": marketingManifest(sha256(marketingAsset)),
      "docs/public/manual/shellx/assets/source.png": marketingSource,
      "docs/public/manual/shellx/visuals.json": marketingVisuals,
    },
    expectSuccess: true,
  });
  assert(existsSync(join(reviewedMarketing.payload, "docs/public/assets/hero.png")),
    "a reviewed marketing asset bound to a reviewed installed-candidate source is exported");

  const dedicatedMarketingManifest = (sourceSha256: string, reviewedProductSha256 = marketingProductSha): string => `${JSON.stringify({
    schemaVersion: "shellx.public-marketing-assets.v2",
    reviewedAt: "2026-08-05",
    revalidation: marketingRevalidation,
    generation: { mode: "fixture", prompt: "fixture prompt", uiPolicy: "fixture policy" },
    assets: [{
      file: "hero.png",
      sha256: sha256(marketingAsset),
      source: "../marketing-sources/source.png",
      sourceSha256,
      sourceReview: {
        status: "reviewed",
        kind: "installed-candidate",
        sourceCommit: "a".repeat(40),
        productSourceSha256: reviewedProductSha256,
        appVersion: "0.3.5",
        platform: "linux-installed",
        sha256: sourceSha256,
        reviewedAt: "2026-08-05",
      },
      status: "reviewed",
      review: "fixture dedicated source review",
    }],
  }, null, 2)}\n`;
  const reviewedDedicatedMarketing = runSyntheticPolicyFixture({
    name: "reviewed-dedicated-marketing-source",
    files: {
      ...marketingProductFiles,
      "README.md": "![fixture](docs/public/assets/hero.png)\n",
      "docs/public/assets/hero.png": marketingAsset,
      "docs/public/assets/reviewed-assets.json": dedicatedMarketingManifest(marketingSourceSha),
      "docs/public/marketing-sources/source.png": marketingSource,
      "docs/public/manual/shellx/assets/source.png": marketingSource,
      "docs/public/manual/shellx/visuals.json": marketingVisuals,
    },
    expectSuccess: true,
  });
  assert(existsSync(join(reviewedDedicatedMarketing.payload, "docs/public/marketing-sources/source.png")),
    "a dedicated reviewed installed-candidate marketing source is exported");

  const mismatchedDedicatedMarketing = runSyntheticPolicyFixture({
    name: "mismatched-dedicated-marketing-source",
    files: {
      ...marketingProductFiles,
      "README.md": "![fixture](docs/public/assets/hero.png)\n",
      "docs/public/assets/hero.png": marketingAsset,
      "docs/public/assets/reviewed-assets.json": dedicatedMarketingManifest(marketingSourceSha, "0".repeat(64)),
      "docs/public/marketing-sources/source.png": marketingSource,
      "docs/public/manual/shellx/assets/source.png": marketingSource,
      "docs/public/manual/shellx/visuals.json": marketingVisuals,
    },
    expectSuccess: false,
  });
  assert(mismatchedDedicatedMarketing.result.stderr.includes("belongs to different product bytes"),
    "dedicated marketing sources fail closed when their reviewed product digest drifts");

  const staleExactPolicy = runSyntheticPolicyFixture({
    name: "stale-exact-policy-path",
    files: { "README.md": "fixture\n" },
    staleExactPath: "docs/removed-public-manual.md",
    expectSuccess: false,
  });
  assert(staleExactPolicy.result.stderr.includes("exact path(s) absent"), "stale exact policy promotions fail closed");

  const suspiciousBroadPath = runSyntheticPolicyFixture({
    name: "broad-prefix-purpose-review",
    files: {
      "README.md": "fixture\n",
      "scripts/audits/provider-evidence.json": "{}\n",
    },
    expectSuccess: false,
  });
  assert(suspiciousBroadPath.result.stderr.includes("no category"), "artifact-like files below broad source prefixes require an exact purpose decision");

  const exactPersona = runSyntheticPolicyFixture({
    name: "exact-public-persona",
    files: {
      "README.md": "fixture\n",
      "src-tauri/personas/reviewer.md": "public runtime persona\n",
    },
    expectSuccess: true,
  });
  assert(existsSync(join(exactPersona.payload, "src-tauri/personas/reviewer.md")), "an exact public resource can intentionally override broad-path purpose review");

  const reviewedVendoredOriginal = runSyntheticPolicyFixture({
    name: "reviewed-vendored-original",
    files: {
      "README.md": "fixture\n",
      "vendor/glib/Cargo.toml.orig": "reviewed upstream package manifest\n",
      "vendor/demo/Cargo.toml.orig": "unreviewed backup-like file\n",
    },
    expectSuccess: true,
  });
  assert(existsSync(join(reviewedVendoredOriginal.payload, "vendor/glib/Cargo.toml.orig")),
    "the exact reviewed GLib upstream manifest survives the unsafe-suffix quarantine");
  assert(!existsSync(join(reviewedVendoredOriginal.payload, "vendor/demo/Cargo.toml.orig")),
    "unreviewed vendored .orig files remain excluded");

  const tamperedPayload = runSyntheticPolicyFixture({
    name: "source-payload-mismatch",
    files: {
      "README.md": "committed bytes\n",
    },
    payloadMutations: {
      "README.md": "different staged bytes\n",
    },
    expectSuccess: false,
  });
  assert(tamperedPayload.result.stderr.includes("does not match source commit"), "payload bytes must match the declared source commit");

  const generated = runSyntheticPolicyFixture({
    name: "generated-state-exclusion",
    files: {
      "README.md": "fixture\n",
      "scripts/cache/raw.log": "raw private evidence\n",
    },
    expectSuccess: true,
  });
  assert(!existsSync(join(generated.payload, "scripts/cache/raw.log")), "cache and raw log paths are excluded even below a public source prefix");
  assert(lstatSync(join(generated.payload, "PUBLIC_EXPORT_MANIFEST.json")).isFile(), "successful synthetic export writes its manifest");

  if (process.platform !== "win32") {
    const helperAlias = join(workspace, "prepare-public-export-alias.mjs");
    symlinkSync(helper, helperAlias);
    const aliasedHelper = runSyntheticPolicyFixture({
      name: "symlinked-helper-main",
      files: { "README.md": "fixture\n" },
      helperPath: helperAlias,
      expectSuccess: true,
    });
    assert(existsSync(join(aliasedHelper.payload, "PUBLIC_EXPORT_MANIFEST.json")),
      "export helper executes when its main-module path uses a filesystem alias");
  }
} finally {
  rmSync(workspace, { recursive: true, force: true });
}

console.log(`\n${failures === 0 ? "PASS" : "FAIL"} public export boundary tests`);
process.exit(failures === 0 ? 0 : 1);
