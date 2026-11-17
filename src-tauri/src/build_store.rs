// src-tauri/src/build_store.rs
//
// Host-local persistence for experimental `/build` mode. State is a single
// atomic JSON file; receipts are append-only JSONL so the UI can replay the
// run timeline even after shellX restarts.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use crate::build_types::{BuildReceipt, BuildRunState};

const MAX_BUILD_RECEIPT_LINE_BYTES: usize = 256 * 1024;
const MAX_BUILD_RECEIPTS_FILE_BYTES: u64 = 64 * 1024 * 1024;

fn ensure_private_build_dir(path: &Path) -> Result<(), String> {
    crate::session_git::ensure_private_dir(path, "build store")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))
            .map_err(|e| format!("build store chmod {} failed: {e}", path.display()))?;
    }
    Ok(())
}

fn prepare_private_run_dir(base: &Path, tab_id: &str, run_id: &str) -> Result<PathBuf, String> {
    ensure_private_build_dir(base)?;
    let tab_dir = base.join(sanitize_build_slug(tab_id));
    ensure_private_build_dir(&tab_dir)?;
    let run_dir = tab_dir.join(sanitize_build_slug(run_id));
    ensure_private_build_dir(&run_dir)?;
    Ok(run_dir)
}

fn write_private_synced(path: &Path, bytes: &[u8], label: &str) -> Result<(), String> {
    #[cfg(unix)]
    let mut file = {
        use std::os::unix::fs::OpenOptionsExt;
        OpenOptions::new()
            .create_new(true)
            .write(true)
            .mode(0o600)
            .open(path)
            .map_err(|e| format!("{label} open {} failed: {e}", path.display()))?
    };
    #[cfg(not(unix))]
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(path)
        .map_err(|e| format!("{label} open {} failed: {e}", path.display()))?;
    file.write_all(bytes)
        .map_err(|e| format!("{label} write {} failed: {e}", path.display()))?;
    file.sync_all()
        .map_err(|e| format!("{label} sync {} failed: {e}", path.display()))?;
    Ok(())
}

#[cfg(unix)]
fn enforce_private_file(path: &Path, label: &str) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
        .map_err(|e| format!("{label} chmod {} failed: {e}", path.display()))
}

#[cfg(not(unix))]
fn enforce_private_file(_path: &Path, _label: &str) -> Result<(), String> {
    Ok(())
}

fn sanitize_build_slug(input: &str) -> String {
    let slug = crate::session_git::sanitize_worktree_slug(input).replace('.', "-");
    let slug = slug
        .split('-')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("-");
    if slug == "." || slug == ".." {
        "build".to_string()
    } else {
        slug
    }
}

pub fn build_run_dir(base: &Path, tab_id: &str, run_id: &str) -> PathBuf {
    base.join(sanitize_build_slug(tab_id))
        .join(sanitize_build_slug(run_id))
}



pub fn write_state(base: &Path, state: &BuildRunState) -> Result<(), String> {
    let dir = prepare_private_run_dir(base, &state.tab_id, &state.run_id)?;
    let path = dir.join("state.json");
    let tmp = dir.join(format!(
        ".state.json.{}.{}.tmp",
        std::process::id(),
        uuid::Uuid::new_v4().simple()
    ));
    let body = serde_json::to_string_pretty(state)
        .map_err(|e| format!("build state serialize failed: {}", e))?;
    write_private_synced(&tmp, body.as_bytes(), "build state temp")?;
    if let Err(error) = fs::rename(&tmp, &path) {
        let _ = fs::remove_file(&tmp);
        return Err(format!("build state rename failed: {error}"));
    }
    enforce_private_file(&path, "build state")?;
    Ok(())
}

pub fn read_state(base: &Path, tab_id: &str, run_id: &str) -> Result<BuildRunState, String> {
    let path = build_run_dir(base, tab_id, run_id).join("state.json");
    let body = fs::read_to_string(&path)
        .map_err(|e| format!("build state read {} failed: {}", path.display(), e))?;
    serde_json::from_str(&body)
        .map_err(|e| format!("build state parse {} failed: {}", path.display(), e))
}

pub fn read_latest_state_for_tab(
    base: &Path,
    tab_id: &str,
) -> Result<Option<BuildRunState>, String> {
    let tab_dir = base.join(sanitize_build_slug(tab_id));
    if !tab_dir.exists() {
        return Ok(None);
    }

    let entries = fs::read_dir(&tab_dir)
        .map_err(|e| format!("build state list {} failed: {}", tab_dir.display(), e))?;
    let mut latest: Option<BuildRunState> = None;
    for entry in entries {
        let entry = entry.map_err(|e| format!("build state list entry failed: {}", e))?;
        let file_type = entry.file_type().map_err(|e| {
            format!(
                "build state entry type {} failed: {}",
                entry.path().display(),
                e
            )
        })?;
        if !file_type.is_dir() {
            continue;
        }
        let state_path = entry.path().join("state.json");
        if !state_path.exists() {
            continue;
        }
        let body = fs::read_to_string(&state_path)
            .map_err(|e| format!("build state read {} failed: {}", state_path.display(), e))?;
        let state: BuildRunState = serde_json::from_str(&body)
            .map_err(|e| format!("build state parse {} failed: {}", state_path.display(), e))?;
        if state.tab_id != tab_id {
            continue;
        }
        let replace = latest
            .as_ref()
            .map(|current| {
                state.updated_at_ms > current.updated_at_ms
                    || (state.updated_at_ms == current.updated_at_ms
                        && state.created_at_ms > current.created_at_ms)
            })
            .unwrap_or(true);
        if replace {
            latest = Some(state);
        }
    }
    Ok(latest)
}

pub fn append_receipt(base: &Path, receipt: &BuildReceipt) -> Result<(), String> {
    let dir = prepare_private_run_dir(base, &receipt.tab_id, &receipt.run_id)?;
    let path = dir.join("receipts.jsonl");
    let mut line = serde_json::to_vec(receipt)
        .map_err(|e| format!("build receipt serialize failed: {}", e))?;
    line.push(b'\n');
    if line.len() > MAX_BUILD_RECEIPT_LINE_BYTES {
        return Err(format!(
            "build receipt exceeds {} byte per-entry cap",
            MAX_BUILD_RECEIPT_LINE_BYTES
        ));
    }
    let current_bytes = fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0);
    if current_bytes.saturating_add(line.len() as u64) > MAX_BUILD_RECEIPTS_FILE_BYTES {
        return Err(format!(
            "build receipts file exceeds {} byte per-run cap",
            MAX_BUILD_RECEIPTS_FILE_BYTES
        ));
    }
    #[cfg(unix)]
    let file = {
        use std::os::unix::fs::OpenOptionsExt;
        OpenOptions::new()
            .create(true)
            .append(true)
            .mode(0o600)
            .open(&path)
    };
    #[cfg(not(unix))]
    let file = OpenOptions::new().create(true).append(true).open(&path);
    let mut file =
        file.map_err(|e| format!("build receipt open {} failed: {e}", path.display()))?;
    enforce_private_file(&path, "build receipt")?;
    file.write_all(&line)
        .map_err(|e| format!("build receipt append {} failed: {e}", path.display()))?;
    file.sync_data()
        .map_err(|e| format!("build receipt sync {} failed: {e}", path.display()))
}

pub fn read_receipts(base: &Path, tab_id: &str, run_id: &str) -> Result<Vec<BuildReceipt>, String> {
    read_receipts_with_errors(base, tab_id, run_id).map(|(receipts, _errors)| receipts)
}

pub fn read_receipts_with_errors(
    base: &Path,
    tab_id: &str,
    run_id: &str,
) -> Result<(Vec<BuildReceipt>, usize), String> {
    let path = build_run_dir(base, tab_id, run_id).join("receipts.jsonl");
    if !path.exists() {
        return Ok((Vec::new(), 0));
    }
    let body = fs::read_to_string(&path)
        .map_err(|e| format!("build receipts read {} failed: {}", path.display(), e))?;
    let mut receipts = Vec::new();
    let mut errors = 0usize;
    for line in body.lines().filter(|line| !line.trim().is_empty()) {
        match serde_json::from_str::<BuildReceipt>(line) {
            Ok(receipt) => receipts.push(receipt),
            Err(_) => errors += 1,
        }
    }
    Ok((receipts, errors))
}
