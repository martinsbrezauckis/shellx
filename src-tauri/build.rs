use std::process::Command;

fn compile_windows_test_manifest_directive() {
    let out_dir =
        std::path::PathBuf::from(std::env::var("OUT_DIR").expect("Cargo provides OUT_DIR"));
    let target = std::env::var("TARGET").expect("Cargo provides TARGET");
    let host = std::env::var("HOST").expect("Cargo provides HOST");
    cc::Build::new()
        .target(&target)
        .host(&host)
        .file("windows-test-manifest.c")
        .cargo_metadata(false)
        .warnings(false)
        .compile("windows-test-manifest-archive");
    let archive = out_dir.join("windows-test-manifest-archive.lib");
    println!("cargo:rustc-link-search=native={}", out_dir.display());
    println!("cargo:rustc-link-arg=/WHOLEARCHIVE:{}", archive.display());
    println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
}

fn git_stdout(args: &[&str]) -> Option<String> {
    let output = Command::new("git").args(args).output().ok()?;
    if !output.status.success() {
        return None;
    }
    let value = String::from_utf8(output.stdout).ok()?;
    let value = value.trim();
    (!value.is_empty()).then(|| value.to_string())
}

fn normalize_build_commit(value: String) -> Option<String> {
    let value = value.trim();
    (value.len() >= 7 && value.len() <= 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .then(|| value.to_ascii_lowercase())
}

fn main() {
    println!("cargo:rerun-if-env-changed=SHELLX_BUILD_COMMIT");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
        && std::env::var_os("CARGO_FEATURE_WINDOWS_TEST_MANIFEST").is_some()
    {
        // `tauri_build` embeds this dependency in the packaged application,
        // but Cargo's generated test and benchmark executables do not inherit
        // that application resource. Without it Windows binds the legacy
        // System32 comctl32.dll, which does not export TaskDialogIndirect, and
        // the test process exits with STATUS_ENTRYPOINT_NOT_FOUND before the
        // Rust harness starts. The explicit windows-test-manifest feature is
        // enabled only by Windows test commands. It compiles a COFF directive
        // object for the Common Controls v6 dependency and passes the embed
        // switch as a real linker argument. A static archive avoids treating a
        // raw `.res` as a library, which native link.exe rejects with LNK1356.
        println!("cargo:rerun-if-changed=windows-test-manifest.c");
        compile_windows_test_manifest_directive();
    }
    if let Some(head_path) = git_stdout(&["rev-parse", "--git-path", "HEAD"]) {
        println!("cargo:rerun-if-changed={head_path}");
    }
    if let Some(reference) = git_stdout(&["symbolic-ref", "-q", "HEAD"]) {
        if let Some(reference_path) = git_stdout(&["rev-parse", "--git-path", &reference]) {
            println!("cargo:rerun-if-changed={reference_path}");
        }
    }
    let build_commit = std::env::var("SHELLX_BUILD_COMMIT")
        .ok()
        .and_then(normalize_build_commit)
        .or_else(|| git_stdout(&["rev-parse", "HEAD"]).and_then(normalize_build_commit))
        .unwrap_or_else(|| "unknown".to_string());
    println!("cargo:rustc-env=SHELLX_BUILD_COMMIT={build_commit}");
    tauri_build::build()
}
