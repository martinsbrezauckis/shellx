// src-tauri/src/env_security.rs
//
// First-pass environment security scanner for host-MCP. This is intentionally
// small: inventory dependency manifests/lockfiles and, when requested, run
// fixed local advisory tools. It does not embed a remote service or execute
// arbitrary commands supplied by the model.

use serde::Serialize;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::process::Command;
use tokio::time::timeout;

const DEFAULT_MAX_DEPTH: usize = 4;
const DEFAULT_MAX_MANIFESTS: usize = 80;
const DEFAULT_TIMEOUT_MS: u64 = 60_000;
const MAX_TIMEOUT_MS: u64 = 180_000;
const OUTPUT_TAIL_BYTES: usize = 4_000;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SecurityManifest {
    pub path: String,
    pub file_name: String,
    pub ecosystem: String,
    pub kind: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SecurityAuditCheck {
    name: String,
    status: String,
    detail: String,
    command: Vec<String>,
    cwd: String,
    exit_code: Option<i32>,
    stdout_tail: Option<String>,
    stderr_tail: Option<String>,
}

#[derive(Debug)]
struct ScanOptions {
    root: PathBuf,
    run_audits: bool,
    max_depth: usize,
    max_manifests: usize,
    timeout_ms: u64,
}

pub async fn scan_from_mcp(args: Value, cwd: &Path) -> Result<Value, String> {
    let options = parse_options(args, cwd)?;
    let started = Instant::now();
    let manifests = discover_manifests(&options.root, options.max_depth, options.max_manifests)?;
    let mut checks = Vec::new();

    if options.run_audits {
        checks = run_audits(
            &options.root,
            &manifests,
            Duration::from_millis(options.timeout_ms),
        )
        .await;
    }

    let warn = checks.iter().filter(|c| c.status == "warn").count();
    let fail = checks.iter().filter(|c| c.status == "fail").count();
    let pass = checks.iter().filter(|c| c.status == "pass").count();
    let skipped = checks.iter().filter(|c| c.status == "skipped").count();
    let status = if fail > 0 {
        "fail"
    } else if warn > 0 {
        "warn"
    } else {
        "pass"
    };

    Ok(json!({
        "summary": {
            "status": status,
            "manifestCount": manifests.len(),
            "auditsRun": pass + warn + fail,
            "auditsSkipped": skipped,
            "elapsedMs": started.elapsed().as_millis() as u64,
            "scannedAtMs": now_ms(),
            "dataSources": data_sources(options.run_audits),
        },
        "root": options.root.display().to_string(),
        "manifests": manifests,
        "checks": checks,
        "note": if options.run_audits {
            "Audits use locally installed advisory tools and their configured upstream databases."
        } else {
            "Inventory only. Re-run with run_audits=true to query local advisory tools."
        }
    }))
}

fn parse_options(args: Value, cwd: &Path) -> Result<ScanOptions, String> {
    let root = match args.get("path").and_then(|v| v.as_str()) {
        Some(raw) if !raw.trim().is_empty() => PathBuf::from(raw),
        _ => cwd.to_path_buf(),
    };
    if !root.is_absolute() {
        return Err(format!(
            "security_scan: path must be absolute: {}",
            root.display()
        ));
    }
    if !root.exists() {
        return Err(format!(
            "security_scan: path does not exist: {}",
            root.display()
        ));
    }
    if !root.is_dir() {
        return Err(format!(
            "security_scan: path must be a directory: {}",
            root.display()
        ));
    }

    let root_allowed = path_allowed_for_scan(&root, cwd);
    let allow_outside = args
        .get("allow_outside_cwd")
        .or_else(|| args.get("allowOutsideCwd"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    if !root_allowed && !allow_outside {
        return Err(format!(
            "security_scan: path {} not allowed (must be inside cwd {} or set allow_outside_cwd=true)",
            root.display(),
            cwd.display()
        ));
    }

    let max_depth = args
        .get("max_depth")
        .or_else(|| args.get("maxDepth"))
        .and_then(|v| v.as_u64())
        .map(|n| n.clamp(1, 12) as usize)
        .unwrap_or(DEFAULT_MAX_DEPTH);
    let max_manifests = args
        .get("max_manifests")
        .or_else(|| args.get("maxManifests"))
        .and_then(|v| v.as_u64())
        .map(|n| n.clamp(1, 500) as usize)
        .unwrap_or(DEFAULT_MAX_MANIFESTS);
    let timeout_ms = args
        .get("timeout_ms")
        .or_else(|| args.get("timeoutMs"))
        .and_then(|v| v.as_u64())
        .map(|n| n.clamp(1_000, MAX_TIMEOUT_MS))
        .unwrap_or(DEFAULT_TIMEOUT_MS);

    Ok(ScanOptions {
        root,
        run_audits: args
            .get("run_audits")
            .or_else(|| args.get("runAudits"))
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
        max_depth,
        max_manifests,
        timeout_ms,
    })
}

fn path_allowed_for_scan(root: &Path, cwd: &Path) -> bool {
    let root_c = std::fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
    let cwd_c = std::fs::canonicalize(cwd).unwrap_or_else(|_| cwd.to_path_buf());
    root_c.starts_with(&cwd_c)
}

pub fn discover_manifests(
    root: &Path,
    max_depth: usize,
    max_manifests: usize,
) -> Result<Vec<SecurityManifest>, String> {
    let mut out = Vec::new();
    visit_dir(root, root, 0, max_depth, max_manifests, &mut out)?;
    out.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(out)
}

fn visit_dir(
    root: &Path,
    dir: &Path,
    depth: usize,
    max_depth: usize,
    max_manifests: usize,
    out: &mut Vec<SecurityManifest>,
) -> Result<(), String> {
    if out.len() >= max_manifests || depth > max_depth {
        return Ok(());
    }
    let entries =
        std::fs::read_dir(dir).map_err(|e| format!("read_dir {}: {}", dir.display(), e))?;
    for entry in entries.flatten() {
        if out.len() >= max_manifests {
            break;
        }
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        if path.is_dir() {
            if should_skip_dir(&name) {
                continue;
            }
            visit_dir(root, &path, depth + 1, max_depth, max_manifests, out)?;
            continue;
        }
        if let Some((ecosystem, kind)) = manifest_kind(&name) {
            let rel = path
                .strip_prefix(root)
                .unwrap_or(&path)
                .to_string_lossy()
                .replace('\\', "/");
            out.push(SecurityManifest {
                path: rel,
                file_name: name,
                ecosystem: ecosystem.to_string(),
                kind: kind.to_string(),
            });
        }
    }
    Ok(())
}

fn should_skip_dir(name: &str) -> bool {
    matches!(
        name,
        ".git"
            | "node_modules"
            | "target"
            | "dist"
            | "build"
            | ".venv"
            | "venv"
            | "__pycache__"
            | ".next"
            | ".nuxt"
            | ".turbo"
    )
}

fn manifest_kind(name: &str) -> Option<(&'static str, &'static str)> {
    match name {
        "package-lock.json" => Some(("npm", "lockfile")),
        "npm-shrinkwrap.json" => Some(("npm", "lockfile")),
        "pnpm-lock.yaml" => Some(("npm", "pnpm-lockfile")),
        "yarn.lock" => Some(("npm", "yarn-lockfile")),
        "bun.lock" | "bun.lockb" => Some(("npm", "bun-lockfile")),
        "package.json" => Some(("npm", "manifest")),
        "Cargo.lock" => Some(("cargo", "lockfile")),
        "Cargo.toml" => Some(("cargo", "manifest")),
        "go.sum" => Some(("go", "lockfile")),
        "go.mod" => Some(("go", "manifest")),
        "requirements.txt" => Some(("pypi", "manifest")),
        "uv.lock" => Some(("pypi", "uv-lockfile")),
        "poetry.lock" => Some(("pypi", "poetry-lockfile")),
        "Pipfile.lock" => Some(("pypi", "pipfile-lockfile")),
        "pyproject.toml" => Some(("pypi", "manifest")),
        "Gemfile.lock" => Some(("rubygems", "lockfile")),
        "composer.lock" => Some(("packagist", "lockfile")),
        "pom.xml" => Some(("maven", "manifest")),
        _ => None,
    }
}

async fn run_audits(
    root: &Path,
    manifests: &[SecurityManifest],
    timeout_duration: Duration,
) -> Vec<SecurityAuditCheck> {
    let mut checks = Vec::new();
    if has_manifest(manifests, "pnpm-lock.yaml") {
        checks.push(
            run_fixed_command(
                "pnpm audit",
                root,
                "pnpm",
                &["audit", "--json", "--prod"],
                timeout_duration,
            )
            .await,
        );
    } else if has_manifest(manifests, "package-lock.json") {
        checks.push(
            run_fixed_command(
                "npm audit",
                root,
                "npm",
                &["audit", "--json", "--omit=dev"],
                timeout_duration,
            )
            .await,
        );
    }

    for cargo_lock in manifest_paths(root, manifests, "Cargo.lock") {
        let cwd = cargo_lock.parent().unwrap_or(root);
        checks.push(
            run_fixed_command(
                "cargo audit",
                cwd,
                "cargo",
                &["audit", "--json"],
                timeout_duration,
            )
            .await,
        );
    }

    for go_mod in manifest_paths(root, manifests, "go.mod") {
        let cwd = go_mod.parent().unwrap_or(root);
        checks.push(
            run_optional_command(
                "govulncheck",
                cwd,
                "govulncheck",
                &["./..."],
                timeout_duration,
            )
            .await,
        );
    }

    checks.push(
        run_optional_command(
            "osv-scanner",
            root,
            "osv-scanner",
            &["--format", "json", "--recursive", "."],
            timeout_duration,
        )
        .await,
    );
    checks
}

fn has_manifest(manifests: &[SecurityManifest], file_name: &str) -> bool {
    manifests.iter().any(|m| m.file_name == file_name)
}

fn manifest_paths(root: &Path, manifests: &[SecurityManifest], file_name: &str) -> Vec<PathBuf> {
    manifests
        .iter()
        .filter(|m| m.file_name == file_name)
        .map(|m| root.join(&m.path))
        .collect()
}

async fn run_optional_command(
    name: &str,
    cwd: &Path,
    program: &str,
    args: &[&str],
    timeout_duration: Duration,
) -> SecurityAuditCheck {
    if !command_available(program).await {
        return SecurityAuditCheck {
            name: name.to_string(),
            status: "skipped".to_string(),
            detail: format!("{} is not installed on PATH", program),
            command: command_vec(program, args),
            cwd: cwd.display().to_string(),
            exit_code: None,
            stdout_tail: None,
            stderr_tail: None,
        };
    }
    run_fixed_command(name, cwd, program, args, timeout_duration).await
}

async fn command_available(program: &str) -> bool {
    let fut = async {
        let mut cmd = version_command(program);
        cmd.stdout(Stdio::null())
            .stderr(Stdio::null())
            .stdin(Stdio::null());
        match cmd.spawn() {
            Ok(child) => child
                .wait_with_output()
                .await
                .map(|out| out.status.success())
                .unwrap_or(false),
            Err(_) => false,
        }
    };
    timeout(Duration::from_secs(3), fut).await.unwrap_or(false)
}

async fn run_fixed_command(
    name: &str,
    cwd: &Path,
    program: &str,
    args: &[&str],
    timeout_duration: Duration,
) -> SecurityAuditCheck {
    let fut = async {
        let mut cmd = audit_command(program, args);
        cmd.current_dir(cwd)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .stdin(Stdio::null());
        let child = cmd.spawn()?;
        child.wait_with_output().await
    };

    match timeout(timeout_duration, fut).await {
        Ok(Ok(out)) => audit_output_to_check(name, cwd, program, args, out),
        Ok(Err(e)) => SecurityAuditCheck {
            name: name.to_string(),
            status: "skipped".to_string(),
            detail: format!("{} could not start: {}", program, e),
            command: command_vec(program, args),
            cwd: cwd.display().to_string(),
            exit_code: None,
            stdout_tail: None,
            stderr_tail: None,
        },
        Err(_) => SecurityAuditCheck {
            name: name.to_string(),
            status: "fail".to_string(),
            detail: format!(
                "{} timed out after {} ms",
                name,
                timeout_duration.as_millis()
            ),
            command: command_vec(program, args),
            cwd: cwd.display().to_string(),
            exit_code: None,
            stdout_tail: None,
            stderr_tail: None,
        },
    }
}

fn audit_output_to_check(
    name: &str,
    cwd: &Path,
    program: &str,
    args: &[&str],
    out: std::process::Output,
) -> SecurityAuditCheck {
    let code = out.status.code();
    let stdout = String::from_utf8_lossy(&out.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&out.stderr).into_owned();
    let status = if out.status.success() { "pass" } else { "warn" };
    let detail = if out.status.success() {
        format!(
            "{} completed with no reported vulnerable dependencies",
            name
        )
    } else {
        format!("{} reported advisories or exited non-zero", name)
    };
    SecurityAuditCheck {
        name: name.to_string(),
        status: status.to_string(),
        detail,
        command: command_vec(program, args),
        cwd: cwd.display().to_string(),
        exit_code: code,
        stdout_tail: non_empty_tail(&stdout),
        stderr_tail: non_empty_tail(&stderr),
    }
}

#[cfg(windows)]
fn version_command(program: &str) -> Command {
    let mut cmd = Command::new("cmd.exe");
    cmd.arg("/c").arg(program).arg("--version");
    cmd
}

#[cfg(not(windows))]
fn version_command(program: &str) -> Command {
    let mut cmd = Command::new(program);
    cmd.arg("--version");
    cmd
}

#[cfg(windows)]
fn audit_command(program: &str, args: &[&str]) -> Command {
    let mut cmd = Command::new("cmd.exe");
    cmd.arg("/c").arg(program);
    for arg in args {
        cmd.arg(arg);
    }
    cmd
}

#[cfg(not(windows))]
fn audit_command(program: &str, args: &[&str]) -> Command {
    let mut cmd = Command::new(program);
    for arg in args {
        cmd.arg(arg);
    }
    cmd
}

fn command_vec(program: &str, args: &[&str]) -> Vec<String> {
    std::iter::once(program.to_string())
        .chain(args.iter().map(|s| s.to_string()))
        .collect()
}

fn non_empty_tail(s: &str) -> Option<String> {
    let trimmed = s.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(tail(trimmed, OUTPUT_TAIL_BYTES))
}

fn tail(s: &str, max_bytes: usize) -> String {
    if s.len() <= max_bytes {
        return s.to_string();
    }
    let mut start = s.len() - max_bytes;
    while !s.is_char_boundary(start) {
        start += 1;
    }
    format!("...{}", &s[start..])
}

fn data_sources(run_audits: bool) -> Vec<&'static str> {
    let mut sources = vec!["local dependency manifest inventory"];
    if run_audits {
        sources.push("pnpm/npm audit when Node lockfiles are present");
        sources.push("cargo audit when Cargo.lock is present");
        sources.push("govulncheck when go.mod is present and govulncheck is installed");
        sources.push("osv-scanner when installed");
    }
    sources
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unique_temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "shellx-security-scan-{}-{}",
            name,
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("temp dir");
        dir
    }

    #[test]
    fn discover_manifests_skips_generated_dependency_trees() {
        let root = unique_temp_dir("skip");
        std::fs::write(root.join("pnpm-lock.yaml"), "").expect("root lock");
        std::fs::create_dir_all(root.join("node_modules/pkg")).expect("node_modules");
        std::fs::write(root.join("node_modules/pkg/package.json"), "{}").expect("nested package");
        std::fs::create_dir_all(root.join("src-tauri")).expect("src-tauri");
        std::fs::write(root.join("src-tauri/Cargo.lock"), "").expect("cargo lock");

        let found = discover_manifests(&root, 4, 20).expect("discover");
        let paths: Vec<&str> = found.iter().map(|m| m.path.as_str()).collect();
        assert!(paths.contains(&"pnpm-lock.yaml"));
        assert!(paths.contains(&"src-tauri/Cargo.lock"));
        assert!(!paths.iter().any(|p| p.contains("node_modules")));

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn manifest_kind_recognizes_agent0007_relevant_lockfiles() {
        assert_eq!(
            manifest_kind("pnpm-lock.yaml"),
            Some(("npm", "pnpm-lockfile"))
        );
        assert_eq!(manifest_kind("Cargo.lock"), Some(("cargo", "lockfile")));
        assert_eq!(manifest_kind("go.sum"), Some(("go", "lockfile")));
        assert_eq!(manifest_kind("uv.lock"), Some(("pypi", "uv-lockfile")));
    }

    #[tokio::test]
    async fn scan_from_mcp_inventory_reports_manifests_without_running_audits() {
        let root = unique_temp_dir("inventory");
        std::fs::write(root.join("package.json"), "{}").expect("package manifest");
        std::fs::write(root.join("pnpm-lock.yaml"), "").expect("pnpm lock");

        let out = scan_from_mcp(json!({ "run_audits": false }), &root)
            .await
            .expect("scan");

        assert_eq!(out["summary"]["status"], "pass");
        assert_eq!(out["summary"]["manifestCount"], 2);
        assert_eq!(out["summary"]["auditsRun"], 0);
        assert_eq!(out["checks"].as_array().expect("checks").len(), 0);

        let _ = std::fs::remove_dir_all(root);
    }
}
