use std::process::Command;



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
    let attributes = tauri_build::Attributes::new();;
    tauri_build::try_build(attributes).expect("failed to run Tauri build script")
}
