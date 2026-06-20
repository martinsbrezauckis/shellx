// src-tauri/src/text_sniff.rs
//
// File-content classifier — "is this file plausibly text, or is it binary?"
// Used by the attach-UX inlining flow.
//
// Role
// The frontend `handleAttach` flow needs to decide PER FILE whether to
// inline the bytes as an `embedded_context` PromptPart (grok declares
// `embeddedContext: true` so text inlining is supported) or fall back
// to the existing `[attached: <path>]` tag (the only safe handling for
// binary, large, or unknown formats).
//
// Strategy — extension-first, magic-byte fallback
// 1. Whitelist of known-text extensions (md, txt, json, py, ts, tsx, rs,
// yaml, yml, toml, sh, css, html, jsx, go, sql, csv). Matching the
// task spec verbatim — easy to audit. Anything in this list with a
// reasonable size (≤ max_bytes) is treated as text.
// 2. Magic-byte sniff: read the first N bytes. If the file is well-formed
// UTF-8 AND contains no NUL bytes AND printable-character ratio is
// high, accept as text even without a known extension. This catches
// Dockerfile, Makefile, LICENSE, etc.
// 3. Anything else → binary.
//
// We never trust extension alone for the "is binary" call — a `.json`
// file with embedded NULs is still binary as far as inlining is concerned.
// The magic-byte gate runs on the read bytes regardless of extension match.
//
// Size cap
// Caller passes max_bytes (default 64KB). Files over the cap are
// classified as `binary` so the frontend uses the tag fallback rather
// than ballooning the prompt. The cap is enforced on the read length
// AND on the file metadata before reading — we don't want to slurp 100MB
// just to bin it.
//
// Security
// No path traversal handling here — the caller (lib.rs Tauri command)
// passes an absolute path supplied by the OS dialog. We treat the
// filesystem as trusted and only assert size + content shape.

use std::path::Path;

/// Extensions we treat as text without further sniffing.
/// Lower-case comparison; the matcher lowercases the OS extension before
/// lookup so "MD" and "md" both match.
const TEXT_EXTENSIONS: &[&str] = &[
    // Per task spec — kept in the same order for audit clarity.
    "md",
    "txt",
    "json",
    "py",
    "ts",
    "tsx",
    "rs",
    "yaml",
    "yml",
    "toml",
    "sh",
    "css",
    "html",
    "jsx",
    "go",
    "sql",
    "csv",
    // Adjacent obvious-text formats — same rules apply. Keeping them
    // here means a developer attaching a JS or XML file gets inlining
    // too, which is the natural expectation.
    "js",
    "mjs",
    "cjs",
    "xml",
    "ini",
    "conf",
    "cfg",
    "env",
    "log",
    "lock",
    "gitignore",
    "dockerignore",
    "editorconfig",
];

/// Maximum bytes the magic-byte sniff inspects when extension is unknown.
/// 8KB is enough to identify text vs binary with high confidence — fits
/// most file headers (PE/ELF/ZIP magic in first 4 bytes; UTF-8 BOM in
/// first 3) without slurping the entire file.
const SNIFF_BYTES: usize = 8 * 1024;

/// Outcome of the classifier.
///
/// `Text { content }` carries the decoded UTF-8 string (the caller doesn't
/// need to re-read).
/// `Binary` means "do not inline" — too large, wrong shape, or contains
/// NUL bytes.
#[derive(Debug, serde::Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum TextSniffResult {
    Text { content: String },
    Binary,
}

/// Classify a path. Returns the file content if it's plausibly text,
/// otherwise `Binary`. Never returns an error for "the file is binary" —
/// only true I/O errors (missing path, permission denied) bubble up.
///
/// Caller passes `max_bytes`; the function refuses to inline anything
/// larger than that and returns `Binary` for oversize files. This is the
/// caller-friendly shape: "treat as binary" lets the existing tag path
/// take over without special-casing the error.
pub fn classify_file(path: &Path, max_bytes: usize) -> Result<TextSniffResult, String> {
    // Cheap pre-check: stat the file. Oversize → Binary without reading.
    let meta =
        std::fs::metadata(path).map_err(|e| format!("stat {} failed: {}", path.display(), e))?;
    if !meta.is_file() {
        return Err(format!("not a regular file: {}", path.display()));
    }
    if meta.len() as usize > max_bytes {
        // Too big to inline. The tag path picks this up.
        return Ok(TextSniffResult::Binary);
    }

    // Read the whole file (already bounded by max_bytes).
    let bytes =
        std::fs::read(path).map_err(|e| format!("read {} failed: {}", path.display(), e))?;

    // Extension check. If the extension is whitelisted AND the bytes are
    // valid UTF-8 AND no NUL bytes, accept directly.
    let ext = path
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| s.to_ascii_lowercase());
    // Also handle dotfiles (no extension): .gitignore, .env. Path::extension
    // returns Some("env") for ".env" (no stem) on most platforms, but the
    // dotfile-only case (file_stem starts with '.') is worth supporting
    // explicitly so we don't miss `.dockerignore`.
    let dotfile_match = {
        let stem = path
            .file_name()
            .and_then(|s| s.to_str())
            .map(|s| s.to_ascii_lowercase())
            .unwrap_or_default();
        // Trim leading dot for comparison against TEXT_EXTENSIONS.
        let stripped: String = stem
            .strip_prefix('.')
            .map(|s| s.to_string())
            .unwrap_or(stem);
        TEXT_EXTENSIONS.iter().any(|e| *e == stripped)
    };
    let ext_match = ext
        .as_deref()
        .map(|e| TEXT_EXTENSIONS.contains(&e))
        .unwrap_or(false);

    if ext_match || dotfile_match {
        // Validate UTF-8 + reject NULs even on extension-whitelisted files.
        // A `.json` with a NUL is corrupt — better to fall back to the tag.
        if !bytes.contains(&0) {
            if let Ok(s) = std::str::from_utf8(&bytes) {
                return Ok(TextSniffResult::Text {
                    content: s.to_string(),
                });
            }
        }
        return Ok(TextSniffResult::Binary);
    }

    // Unknown extension. Run the magic-byte sniff on the first SNIFF_BYTES.
    if is_plausibly_text(&bytes[..bytes.len().min(SNIFF_BYTES)]) {
        if let Ok(s) = std::str::from_utf8(&bytes) {
            return Ok(TextSniffResult::Text {
                content: s.to_string(),
            });
        }
    }
    Ok(TextSniffResult::Binary)
}

/// Heuristic: "is this byte slice plausibly text?"
///
/// Rules (all must hold):
/// 1. No NUL bytes (binary marker — every common binary format hits this).
/// 2. Valid UTF-8 over the inspected window.
/// 3. Printable ratio ≥ 85% — printable = ASCII printable, whitespace
/// (space/tab/newline/CR), OR any non-ASCII UTF-8 char (covers UTF-8
/// content in CJK/Cyrillic/etc).
///
/// The 85% threshold tolerates a small number of control codes (e.g. ANSI
/// escapes in a log file) while still rejecting random binary noise which
/// has roughly 50% non-printable bytes.
fn is_plausibly_text(buf: &[u8]) -> bool {
    if buf.is_empty() {
        return true; // Empty file is trivially text.
    }
    if buf.contains(&0) {
        return false;
    }
    let s = match std::str::from_utf8(buf) {
        Ok(s) => s,
        Err(_) => return false,
    };
    let total = s.chars().count();
    if total == 0 {
        return true;
    }
    let printable = s
        .chars()
        .filter(|c| {
            // ASCII printable range OR whitespace OR non-ASCII (UTF-8 char).
            c.is_ascii_graphic() || matches!(*c, ' ' | '\t' | '\n' | '\r') || !c.is_ascii()
        })
        .count();
    let ratio = (printable as f64) / (total as f64);
    ratio >= 0.85
}

// ───── tests ─────

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn write_tmp(name: &str, bytes: &[u8]) -> std::path::PathBuf {
        let dir = std::env::temp_dir();
        let path = dir.join(format!("grok-shell-sniff-{}", name));
        let mut f = std::fs::File::create(&path).expect("tmp create");
        f.write_all(bytes).expect("tmp write");
        path
    }

    #[test]
    fn whitelisted_extension_inlines_text() {
        let p = write_tmp("a.md", b"# Hello\n");
        let r = classify_file(&p, 64 * 1024).unwrap();
        match r {
            TextSniffResult::Text { content } => assert_eq!(content, "# Hello\n"),
            TextSniffResult::Binary => panic!("expected Text"),
        }
        std::fs::remove_file(&p).ok();
    }

    #[test]
    fn binary_with_text_extension_falls_back_to_binary() {
        // Pretend a binary blob was renamed to .json.
        let p = write_tmp(
            "a.json",
            &[0xFFu8, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46],
        );
        let r = classify_file(&p, 64 * 1024).unwrap();
        matches!(r, TextSniffResult::Binary)
            .then_some(())
            .expect("expected Binary");
        std::fs::remove_file(&p).ok();
    }

    #[test]
    fn oversize_returns_binary_without_reading() {
        let big: Vec<u8> = vec![b'a'; 200 * 1024];
        let p = write_tmp("big.txt", &big);
        let r = classify_file(&p, 64 * 1024).unwrap();
        matches!(r, TextSniffResult::Binary)
            .then_some(())
            .expect("expected Binary");
        std::fs::remove_file(&p).ok();
    }

    #[test]
    fn unknown_extension_inlines_when_plausible() {
        // No extension, but plain ASCII text.
        let p = write_tmp("README", b"this is a readme file\nwith two lines\n");
        let r = classify_file(&p, 64 * 1024).unwrap();
        matches!(r, TextSniffResult::Text { .. })
            .then_some(())
            .expect("expected Text");
        std::fs::remove_file(&p).ok();
    }

    #[test]
    fn unknown_extension_rejects_binary_blob() {
        // PE header bytes + lots of zeros.
        let mut bytes = vec![b'M', b'Z'];
        bytes.extend(std::iter::repeat(0u8).take(200));
        let p = write_tmp("blob.dat", &bytes);
        let r = classify_file(&p, 64 * 1024).unwrap();
        matches!(r, TextSniffResult::Binary)
            .then_some(())
            .expect("expected Binary");
        std::fs::remove_file(&p).ok();
    }

    #[test]
    fn dotfile_known_name_inlines() {
        let p = write_tmp(".gitignore", b"node_modules\n");
        let r = classify_file(&p, 64 * 1024).unwrap();
        matches!(r, TextSniffResult::Text { .. })
            .then_some(())
            .expect("expected Text");
        std::fs::remove_file(&p).ok();
    }

    #[test]
    fn empty_file_is_text() {
        let p = write_tmp("empty.txt", b"");
        let r = classify_file(&p, 64 * 1024).unwrap();
        match r {
            TextSniffResult::Text { content } => assert_eq!(content, ""),
            TextSniffResult::Binary => panic!("expected Text"),
        }
        std::fs::remove_file(&p).ok();
    }
}
