import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

export function configuredUpdaterPublicKey(repoRoot = process.cwd()): string {
  const configPath = resolve(repoRoot, "src-tauri/tauri.conf.json");
  const config = JSON.parse(readFileSync(configPath, "utf8")) as {
    plugins?: { updater?: { pubkey?: unknown } };
  };
  const pubkey = config.plugins?.updater?.pubkey;
  if (typeof pubkey !== "string" || pubkey.trim().length < 40) {
    throw new Error(`Missing updater public key in ${configPath}`);
  }
  return pubkey.trim();
}

export function verifyUpdaterSignature(
  artifactPath: string,
  signaturePath: string,
  repoRoot = process.cwd(),
): void {
  const result = spawnSync("cargo", [
    "run",
    "--quiet",
    "--manifest-path",
    resolve(repoRoot, "src-tauri/Cargo.toml"),
    "--example",
    "verify-updater-signature",
    "--",
    "--public-key",
    configuredUpdaterPublicKey(repoRoot),
    "--artifact",
    resolve(artifactPath),
    "--signature",
    resolve(signaturePath),
  ], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "unknown verification failure").trim();
    throw new Error(`Updater signature does not match ${artifactPath}: ${detail}`);
  }
}
