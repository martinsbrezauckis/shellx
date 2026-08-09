import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyUpdaterSignature } from "./lib/updater-signature-verifier";

interface ManifestPlatform {
  signature: string;
  url: string;
}

interface UpdaterManifest {
  version: string;
  notes: string;
  pub_date: string;
  platforms: Record<string, ManifestPlatform>;
}

export interface BuildOptions {
  version: string;
  artifactRoot: string;
  repo: string;
  tag: string;
  baseUrl?: string;
  macPlatform: string;
  output: string;
  pubDate: string;
  notes: string;
  requiredPlatforms?: string[];
  verifySignature?: (artifactPath: string, signaturePath: string) => void;
}

interface Candidate {
  platform: string;
  artifactNames: string[];
  note: string;
}

const DEFAULT_REPO = "martinsbrezauckis/shellx";

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg) continue;
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      out[key] = true;
    } else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

function optString(opts: Record<string, string | boolean>, key: string): string | undefined {
  const value = opts[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

function firstExisting(root: string, names: string[]): string | null {
  for (const name of names) {
    const path = join(root, name);
    if (existsSync(path)) return path;
  }
  return null;
}

function artifactUrl(baseUrl: string, artifactPath: string): string {
  const name = artifactPath.split(/[\\/]/).pop();
  if (!name) throw new Error(`Cannot derive artifact name from ${artifactPath}`);
  return `${baseUrl.replace(/\/$/, "")}/${encodeURIComponent(name)}`;
}

function validatedArtifactUrl(options: BuildOptions, baseUrl: string, artifactPath: string): string {
  const raw = artifactUrl(baseUrl, artifactPath);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`Updater artifact URL is invalid: ${raw}`);
  }
  const expectedPrefix = `/${options.repo}/releases/download/${options.tag}/`;
  if (
    parsed.protocol !== "https:"
    || parsed.hostname !== "github.com"
    || !parsed.pathname.startsWith(expectedPrefix)
  ) {
    throw new Error(
      `Updater artifact URL must use https://github.com/${options.repo}/releases/download/${options.tag}/`,
    );
  }
  return parsed.toString();
}

export function buildUpdaterManifest(options: BuildOptions): { manifest: UpdaterManifest; included: string[]; skipped: string[] } {
  const baseUrl = options.baseUrl ?? `https://github.com/${options.repo}/releases/download/${options.tag}`;
  const candidates: Candidate[] = [
    {
      platform: "windows-x86_64",
      artifactNames: [
        `windows/shellX_${options.version}_x64-setup.exe`,
        `shellX_${options.version}_x64-setup.exe`,
      ],
      note: "Windows NSIS updater installer",
    },
    {
      platform: options.macPlatform,
      artifactNames: ["macos/shellX.app.tar.gz", "shellX.app.tar.gz"],
      note: "macOS Tauri updater archive",
    },
    {
      platform: "linux-x86_64",
      artifactNames: [
        `linux/shellX_${options.version}_amd64.AppImage`,
        `shellX_${options.version}_amd64.AppImage`,
      ],
      note: "Linux AppImage updater artifact",
    },
  ];

  const platforms: Record<string, ManifestPlatform> = {};
  const included: string[] = [];
  const skipped: string[] = [];
  if (!options.verifySignature) {
    throw new Error("Updater manifest generation requires cryptographic signature verification");
  }
  const candidatePlatforms = new Set(candidates.map((candidate) => candidate.platform));
  const requiredPlatforms = options.requiredPlatforms ?? [...candidatePlatforms];
  const unknownRequired = requiredPlatforms.filter((platform) => !candidatePlatforms.has(platform));
  if (unknownRequired.length > 0) {
    throw new Error(`Unknown required updater platform(s): ${unknownRequired.join(", ")}`);
  }

  for (const candidate of candidates) {
    const artifact = firstExisting(options.artifactRoot, candidate.artifactNames);
    if (!artifact) {
      skipped.push(`${candidate.platform}: missing ${candidate.note}`);
      continue;
    }
    const signaturePath = `${artifact}.sig`;
    if (!existsSync(signaturePath)) {
      skipped.push(`${candidate.platform}: missing ${signaturePath}`);
      continue;
    }
    options.verifySignature(artifact, signaturePath);
    platforms[candidate.platform] = {
      signature: readFileSync(signaturePath, "utf8").trim(),
      url: validatedArtifactUrl(options, baseUrl, artifact),
    };
    included.push(`${candidate.platform}: ${artifact.split(/[\\/]/).pop()}`);
  }

  const missingRequired = requiredPlatforms.filter((platform) => !platforms[platform]);
  if (missingRequired.length > 0) {
    throw new Error(
      `Missing required verified updater platform(s): ${missingRequired.join(", ")}. ${skipped.join("; ")}`,
    );
  }

  return {
    manifest: {
      version: options.version,
      notes: options.notes,
      pub_date: options.pubDate,
      platforms,
    },
    included,
    skipped,
  };
}

export function optionsFromArgv(argv: string[]): BuildOptions {
  const parsed = parseArgs(argv);
  const packageVersion = JSON.parse(readFileSync("package.json", "utf8")) as { version?: string };
  const version = optString(parsed, "version") ?? packageVersion.version ?? "";
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Invalid release version: ${version}`);
  const tag = optString(parsed, "tag") ?? `v${version}`;
  const artifactRoot = resolve(expandHome(optString(parsed, "artifact-root") ?? `~/shellx-builds/v${version}`));
  const output = resolve(expandHome(optString(parsed, "output") ?? join(artifactRoot, "latest.json")));
  return {
    version,
    tag,
    artifactRoot,
    output,
    repo: optString(parsed, "repo") ?? DEFAULT_REPO,
    baseUrl: optString(parsed, "base-url"),
    macPlatform: optString(parsed, "mac-platform") ?? process.env.SHELLX_UPDATER_MAC_PLATFORM ?? "darwin-aarch64",
    pubDate: optString(parsed, "pub-date") ?? new Date().toISOString(),
    notes: optString(parsed, "notes") ?? `See ShellX ${tag} release notes on GitHub.`,
    requiredPlatforms: (optString(parsed, "platforms")
      ?? `windows-x86_64,${optString(parsed, "mac-platform") ?? process.env.SHELLX_UPDATER_MAC_PLATFORM ?? "darwin-aarch64"},linux-x86_64`)
      .split(",")
      .map((platform) => platform.trim())
      .filter(Boolean),
  };
}

export function buildVerifiedUpdaterManifestFromArgv(argv: string[]): {
  options: BuildOptions;
  result: ReturnType<typeof buildUpdaterManifest>;
} {
  const options = optionsFromArgv(argv);
  options.verifySignature = (artifactPath, signaturePath) => {
    verifyUpdaterSignature(artifactPath, signaturePath);
  };
  return { options, result: buildUpdaterManifest(options) };
}

function main(): void {
  const { options, result } = buildVerifiedUpdaterManifestFromArgv(process.argv.slice(2));
  const { manifest, included, skipped } = result;
  mkdirSync(dirname(options.output), { recursive: true });
  writeFileSync(options.output, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(`wrote ${options.output}`);
  for (const line of included) console.log(`included ${line}`);
  for (const line of skipped) console.log(`skipped ${line}`);
}

const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === thisFile) {
  main();
}
