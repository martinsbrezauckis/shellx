import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const VENDOR_ROOT = resolve(ROOT, "vendor", "glib");
const MANIFEST_PATH = resolve(ROOT, "src-tauri", "Cargo.toml");
const LOCK_PATH = resolve(ROOT, "src-tauri", "Cargo.lock");

const EXPECTED_FILE_COUNT = 121;
const EXPECTED_PATCHED_TREE_SHA256 = "9580323e2dcaa8d924521b0d88e435e6c7e7e83c5984a8d6b183cb601f7cfb89";
const EXPECTED_PACKAGE_SHA256 = "233daaf6e83ae6a12a52055f568f9d7cf4671dabb78ff9560ab6da230ce00ee5";
const EXPECTED_BACKPORT_COMMIT = "ea720152f28e293ef4362ee844ee5cc499f32d2a";

function collectFiles(root, current = root, files = [], errors = []) {
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const path = join(current, entry.name);
    if (entry.isDirectory()) {
      collectFiles(root, path, files, errors);
    } else if (entry.isFile()) {
      const relativePath = relative(root, path).replaceAll("\\", "/");
      if (relativePath !== "UPSTREAM") files.push(relativePath);
    } else {
      errors.push(`vendored glib contains a non-regular path: ${relative(root, path)}`);
    }
  }
  return { files, errors };
}

function patchedTreeSha256(files) {
  const hash = createHash("sha256");
  for (const relativePath of [...files].sort()) {
    hash.update(relativePath, "utf8");
    hash.update("\0");
    hash.update(readFileSync(resolve(VENDOR_ROOT, relativePath)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

export function validateGlibBackport() {
  const errors = [];
  try {
    if (!lstatSync(VENDOR_ROOT).isDirectory()) {
      return ["vendored glib root is not a directory"];
    }
    const collected = collectFiles(VENDOR_ROOT);
    errors.push(...collected.errors);
    if (collected.files.length !== EXPECTED_FILE_COUNT) {
      errors.push(`vendored glib file count changed: ${collected.files.length} != ${EXPECTED_FILE_COUNT}`);
    }
    const treeHash = patchedTreeSha256(collected.files);
    if (treeHash !== EXPECTED_PATCHED_TREE_SHA256) {
      errors.push(`vendored glib patched tree digest changed: ${treeHash}`);
    }

    const source = readFileSync(resolve(VENDOR_ROOT, "src", "variant_iter.rs"), "utf8");
    if (!source.includes("let mut p: *mut libc::c_char = std::ptr::null_mut();")) {
      errors.push("vendored glib does not declare the VariantStrIter out-parameter mutable");
    }
    if (!source.includes("                &mut p,")) {
      errors.push("vendored glib does not pass the VariantStrIter out-parameter by mutable reference");
    }
    if (source.includes("                &p,")) {
      errors.push("vendored glib still contains the vulnerable immutable out-parameter call");
    }

    const upstream = readFileSync(resolve(VENDOR_ROOT, "UPSTREAM"), "utf8");
    if (!upstream.includes(`Package SHA-256: ${EXPECTED_PACKAGE_SHA256}`)) {
      errors.push("vendored glib provenance does not bind the crates.io package digest");
    }
    if (!upstream.includes(`Backport commit: ${EXPECTED_BACKPORT_COMMIT}`)) {
      errors.push("vendored glib provenance does not bind the reviewed gtk-rs backport commit");
    }

    const manifest = readFileSync(MANIFEST_PATH, "utf8");
    if (!manifest.includes('glib = { path = "../vendor/glib" }')) {
      errors.push("ShellX Cargo manifest does not activate the reviewed glib backport");
    }
    const lock = readFileSync(LOCK_PATH, "utf8");
    const glibPackage = lock.match(/\[\[package\]\]\nname = "glib"\nversion = "0\.18\.5"\n([\s\S]*?)(?=\n\[\[package\]\])/u)?.[1];
    if (!glibPackage) {
      errors.push("Cargo.lock does not contain the expected glib 0.18.5 package");
    } else if (/^(source|checksum) = /mu.test(glibPackage)) {
      errors.push("Cargo.lock still resolves glib 0.18.5 from the registry instead of the reviewed path patch");
    }
  } catch (error) {
    errors.push(`unable to validate vendored glib backport: ${error instanceof Error ? error.message : String(error)}`);
  }
  return errors;
}
