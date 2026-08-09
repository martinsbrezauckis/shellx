import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateReleaseChecksums } from "./generate-release-checksums";

const root = mkdtempSync(join(tmpdir(), "shellx-release-checksums-"));
try {
  mkdirSync(join(root, "windows"));
  mkdirSync(join(root, "notes"));
  const installer = join(root, "windows", "shellX_0.3.5_x64-setup.exe");
  writeFileSync(installer, "signed-installer");
  writeFileSync(`${installer}.sig`, "updater-signature");
  writeFileSync(join(root, "notes", "private-receipt.json"), "must not publish");

  const output = join(root, "SHA256SUMS");
  const manifest = generateReleaseChecksums(root, output);
  const expected = createHash("sha256").update("signed-installer").digest("hex");
  if (!manifest.includes(`${expected}  windows/shellX_0.3.5_x64-setup.exe`)) {
    throw new Error("checksum manifest does not identify the exact installer bytes");
  }
  if (manifest.includes("private-receipt")) throw new Error("non-release JSON leaked into SHA256SUMS");
  if (readFileSync(output, "utf8") !== manifest) throw new Error("written checksum manifest drifted");

  const linked = join(root, "windows", "linked.dmg");
  try {
    symlinkSync(installer, linked);
  } catch (error) {
    if (process.platform !== "win32" || (error as NodeJS.ErrnoException).code !== "EPERM") throw error;
    symlinkSync(join(root, "notes"), join(root, "linked-assets"), "junction");
  }
  let rejected = false;
  try {
    generateReleaseChecksums(root, output);
  } catch (error) {
    rejected = String(error).includes("symlinks");
  }
  if (!rejected) throw new Error("symlinked release asset was not rejected");
  console.log("PASS release checksum manifest tests");
} finally {
  rmSync(root, { recursive: true, force: true });
}
