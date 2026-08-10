import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const RELEASE_ASSET_PATTERN = /(?:\.exe|\.msi|\.dmg|\.pkg|\.appimage|\.deb|\.rpm|\.zip|\.tar\.gz|\.sig|\.cdx\.json|\.intoto\.jsonl|latest\.json)$/i;

function option(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

export function generateReleaseChecksums(artifactRoot: string, outputPath?: string): string {
  const root = resolve(artifactRoot);
  const output = resolve(outputPath ?? resolve(root, "SHA256SUMS"));
  if (output !== root && !output.startsWith(`${root}${sep}`)) {
    throw new Error("SHA256SUMS output must remain inside the artifact root");
  }

  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error(`Release artifact staging must not contain symlinks: ${path}`);
      if (entry.isDirectory()) {
        visit(path);
      } else if (entry.isFile() && path !== output && RELEASE_ASSET_PATTERN.test(entry.name)) {
        files.push(path);
      }
    }
  };
  visit(root);
  files.sort((left, right) => relative(root, left).localeCompare(relative(root, right)));
  if (files.length === 0) throw new Error(`No release assets found under ${root}`);

  const manifest = files.map((path) => {
    const digest = createHash("sha256").update(readFileSync(path)).digest("hex");
    const name = relative(root, path).split(sep).join("/");
    return `${digest}  ${name}`;
  }).join("\n") + "\n";
  writeFileSync(output, manifest, { encoding: "utf8", flag: "w", mode: 0o644 });
  return manifest;
}

function main(): void {
  const argv = process.argv.slice(2);
  const artifactRoot = option(argv, "--artifact-root");
  if (!artifactRoot) throw new Error("Usage: pnpm release:checksums -- --artifact-root <release-assets-dir> [--output <SHA256SUMS>]");
  const output = option(argv, "--output") ?? resolve(artifactRoot, "SHA256SUMS");
  const manifest = generateReleaseChecksums(artifactRoot, output);
  console.log(`wrote ${resolve(output)} (${manifest.trimEnd().split("\n").length} assets)`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
