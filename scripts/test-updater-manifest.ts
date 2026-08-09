import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildUpdaterManifest } from "./generate-updater-manifest";

let failures = 0;
function assert(cond: boolean, label: string): void {
  console.log(`  ${cond ? "✓" : "✗"} ${label}`);
  if (!cond) failures += 1;
}

console.log("\n=== updater manifest ===");

const root = mkdtempSync(join(tmpdir(), "shellx-updater-manifest-"));
try {
  mkdirSync(join(root, "windows"), { recursive: true });
  mkdirSync(join(root, "macos"), { recursive: true });
  mkdirSync(join(root, "linux"), { recursive: true });

  writeFileSync(join(root, "windows", "shellX_0.3.2_x64-setup.exe"), "exe");
  writeFileSync(join(root, "windows", "shellX_0.3.2_x64-setup.exe.sig"), "windows-signature\n");
  writeFileSync(join(root, "macos", "shellX.app.tar.gz"), "tar");
  writeFileSync(join(root, "macos", "shellX.app.tar.gz.sig"), "mac-signature\n");
  writeFileSync(join(root, "linux", "shellX_0.3.2_amd64.deb"), "deb");
  writeFileSync(join(root, "linux", "shellX_0.3.2_amd64.deb.sig"), "deb-signature\n");
  writeFileSync(join(root, "linux", "shellX_0.3.2_amd64.AppImage"), "appimage");
  writeFileSync(join(root, "linux", "shellX_0.3.2_amd64.AppImage.sig"), "linux-signature\n");

  const verified: string[] = [];

  const result = buildUpdaterManifest({
    version: "0.3.2",
    artifactRoot: root,
    repo: "owner/repo",
    tag: "v0.3.2",
    macPlatform: "darwin-aarch64",
    output: join(root, "latest.json"),
    pubDate: "2026-06-20T00:00:00.000Z",
    notes: "notes",
    requiredPlatforms: ["windows-x86_64", "darwin-aarch64", "linux-x86_64"],
    verifySignature: (artifactPath, signaturePath) => {
      if (!artifactPath || !signaturePath.endsWith(".sig")) throw new Error("invalid verifier input");
      verified.push(artifactPath);
    },
  });

  assert(result.manifest.version === "0.3.2", "manifest uses release version");
  assert(result.manifest.platforms["windows-x86_64"]?.signature === "windows-signature", "Windows signature is embedded");
  assert(result.manifest.platforms["darwin-aarch64"]?.signature === "mac-signature", "macOS signature is embedded");
  assert(result.manifest.platforms["linux-x86_64"]?.signature === "linux-signature", "Linux AppImage signature is embedded");
  assert(verified.length === 3, "every included platform is cryptographically verified before manifest assembly");
  assert(
    result.manifest.platforms["windows-x86_64"]?.url ===
      "https://github.com/owner/repo/releases/download/v0.3.2/shellX_0.3.2_x64-setup.exe",
    "Windows updater URL targets the release asset",
  );
  let partialRejected = false;
  rmSync(join(root, "macos", "shellX.app.tar.gz.sig"));
  try {
    buildUpdaterManifest({
      version: "0.3.2",
      artifactRoot: root,
      repo: "owner/repo",
      tag: "v0.3.2",
      macPlatform: "darwin-aarch64",
      output: join(root, "partial.json"),
      pubDate: "2026-06-20T00:00:00.000Z",
      notes: "notes",
      requiredPlatforms: ["windows-x86_64", "darwin-aarch64", "linux-x86_64"],
      verifySignature: () => {},
    });
  } catch (error) {
    partialRejected = String(error).includes("darwin-aarch64");
  }
  assert(partialRejected, "missing required platform fails instead of writing a partial manifest");

  let mismatchRejected = false;
  try {
    buildUpdaterManifest({
      version: "0.3.2",
      artifactRoot: root,
      repo: "owner/repo",
      tag: "v0.3.2",
      macPlatform: "darwin-aarch64",
      output: join(root, "mismatch.json"),
      pubDate: "2026-06-20T00:00:00.000Z",
      notes: "notes",
      requiredPlatforms: ["windows-x86_64"],
      verifySignature: () => { throw new Error("signature mismatch"); },
    });
  } catch (error) {
    mismatchRejected = String(error).includes("signature mismatch");
  }
  assert(mismatchRejected, "signature mismatch aborts manifest generation");

  let releaseUrlRejected = false;
  try {
    buildUpdaterManifest({
      version: "0.3.2",
      artifactRoot: root,
      repo: "owner/repo",
      tag: "v0.3.2",
      baseUrl: "https://evil.example/owner/repo/releases/download/v0.3.2",
      macPlatform: "darwin-aarch64",
      output: join(root, "wrong-origin.json"),
      pubDate: "2026-06-20T00:00:00.000Z",
      notes: "notes",
      requiredPlatforms: ["windows-x86_64"],
      verifySignature: () => {},
    });
  } catch (error) {
    releaseUrlRejected = String(error).includes("https://github.com/owner/repo/releases/download/v0.3.2/");
  }
  assert(releaseUrlRejected, "artifact URLs are bound to the expected GitHub repository and release tag");
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(`\n${failures === 0 ? "PASS" : "FAIL"} updater manifest tests`);
process.exit(failures === 0 ? 0 : 1);
