use std::env;
use std::fs;
use std::path::PathBuf;

use anyhow::{bail, Context, Result};
use vault_broker::safe_folder::{SafeFolder, SafeFolderExportRequest, SafeFolderImportRequest};
use vault_core::MasterKey;

fn main() -> Result<()> {
    let sealed_dir = PathBuf::from(env::var("SHELLX_VAULT_SAFE_FOLDER_E2E_SEALED_DIR")?);
    let export_dir = PathBuf::from(env::var("SHELLX_VAULT_SAFE_FOLDER_E2E_EXPORT_DIR")?);
    let secret_marker = env::var("SHELLX_VAULT_SAFE_FOLDER_E2E_SECRET")?;
    let display_marker = env::var("SHELLX_VAULT_SAFE_FOLDER_E2E_DISPLAY")?;
    let control_marker = env::var("SHELLX_VAULT_SAFE_FOLDER_E2E_CONTROL")?;

    reset_dir(&sealed_dir)?;
    reset_dir(&export_dir)?;

    let master = MasterKey::generate();
    let plaintext = format!("Windows agent safe-folder E2E document.\nsecret={secret_marker}\n");

    let mut safe_folder = SafeFolder::default();
    let entry = safe_folder.import_plaintext(
        &master,
        SafeFolderImportRequest {
            display_name: display_marker.clone(),
            media_type: "text/plain".to_string(),
            plaintext: plaintext.as_bytes().to_vec(),
            now_ms: 1_782_945_600_000,
        },
    )?;

    let owner_preview = safe_folder.preview_text(&master, &entry.safe_id, 1_782_945_600_001)?;
    if !owner_preview.contains(&secret_marker) {
        bail!("owner preview did not recover the sealed document");
    }

    let mut reloaded = SafeFolder::from_snapshot(safe_folder.to_snapshot())?;
    let wrong_master = MasterKey::generate();
    if reloaded
        .preview_text(&wrong_master, &entry.safe_id, 1_782_945_600_002)
        .is_ok()
    {
        bail!("wrong master unexpectedly opened the sealed document");
    }

    if safe_folder.agent_visible_files().count() != 0 {
        bail!("safe folder exposed files to agent-visible iterator");
    }

    let snapshot = serde_json::to_vec_pretty(&safe_folder.to_snapshot())?;
    let debug_state = serde_json::to_vec_pretty(&safe_folder.debug_state())?;
    fs::write(
        sealed_dir.join("safe-folder-sealed-snapshot.json"),
        snapshot,
    )
    .context("write sealed snapshot")?;
    fs::write(sealed_dir.join("safe-folder-debug-state.json"), debug_state)
        .context("write safe folder debug state")?;
    fs::write(
        sealed_dir.join("windows-agent-control-visible.txt"),
        format!("control={control_marker}\n"),
    )
    .context("write Windows search positive-control file")?;

    let exported = safe_folder.export_to_sync(
        &master,
        SafeFolderExportRequest {
            safe_id: entry.safe_id.clone(),
            destination_path: "exported/safe-folder-e2e.txt".to_string(),
            now_ms: 1_782_945_600_003,
        },
    )?;
    fs::write(
        export_dir.join("safe-folder-e2e-exported.txt"),
        exported.plaintext,
    )
    .context("write explicit safe-folder export")?;

    println!("safe_id={}", entry.safe_id);
    println!("manifest_path={}", entry.manifest_path);
    println!("sealed_dir={}", sealed_dir.display());
    println!("export_dir={}", export_dir.display());
    println!("agent_visible_count=0");
    println!("owner_preview_ok=true");
    println!("wrong_master_opened=false");
    println!("explicit_export_written=true");
    Ok(())
}

fn reset_dir(dir: &PathBuf) -> Result<()> {
    if dir.exists() {
        fs::remove_dir_all(dir).with_context(|| format!("reset {}", dir.display()))?;
    }
    fs::create_dir_all(dir).with_context(|| format!("create {}", dir.display()))?;
    Ok(())
}
