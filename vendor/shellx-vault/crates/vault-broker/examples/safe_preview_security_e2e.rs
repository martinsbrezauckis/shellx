use std::env;
use std::fs;
use std::path::Path;

use anyhow::{bail, Context, Result};
use vault_broker::safe_folder::{SafeFolder, SafeFolderExportRequest, SafeFolderImportRequest};
use vault_broker::safe_preview::SafePreviewSession;
use vault_core::MasterKey;

const SECRET_MARKER: &str = "SAFE_PREVIEW_SECRET_MARKER_20260702";
const EDITED_MARKER: &str = "SAFE_PREVIEW_EDITED_MARKER_20260702";
const DISPLAY_MARKER: &str = "private-preview-note";

fn main() -> Result<()> {
    let root = env::current_dir()?.join(".scratch/safe-preview-security");
    let sealed_dir = root.join("sealed");
    let export_dir = root.join("exported");
    reset_dir(&sealed_dir)?;
    reset_dir(&export_dir)?;

    let master = MasterKey::generate();
    let mut safe = SafeFolder::default();
    let mut session = SafePreviewSession::default();
    let plaintext =
        format!("{DISPLAY_MARKER}\nInitial sealed preview note.\nsecret={SECRET_MARKER}\n");

    let entry = safe.import_plaintext(
        &master,
        SafeFolderImportRequest {
            display_name: format!("{DISPLAY_MARKER}.txt"),
            media_type: "text/plain".to_string(),
            plaintext: plaintext.as_bytes().to_vec(),
            now_ms: 1_783_036_800_000,
        },
    )?;

    let raster =
        session.open_raster(&mut safe, &master, &entry.document_id, 0, 1_783_036_800_001)?;
    if !raster.bytes.starts_with(b"\x89PNG") {
        bail!("raster preview did not return PNG bytes");
    }
    let raster_text = String::from_utf8_lossy(&raster.bytes);
    if raster_text.contains(SECRET_MARKER) || raster_text.contains(EDITED_MARKER) {
        bail!("raster preview bytes contained plaintext marker");
    }

    let editor = session.reveal_text(&mut safe, &master, &entry.document_id, 1_783_036_800_002)?;
    if !editor.text.contains(SECRET_MARKER) {
        bail!("owner reveal did not recover plaintext marker");
    }
    let saved = session.save_text_edit(
        &mut safe,
        &master,
        &editor.editor_handle_id,
        format!("edited sealed note\nsecret={SECRET_MARKER}\nedited={EDITED_MARKER}\n"),
        1_783_036_800_003,
    )?;
    session.clear_on_lock();
    if session.editor_handle(&editor.editor_handle_id).is_some()
        || session.preview_handle(&raster.preview_handle_id).is_some()
    {
        bail!("preview/editor handles survived lock clear");
    }
    if safe.agent_visible_files().count() != 0 {
        bail!("safe folder exposed agent-visible files");
    }

    fs::write(
        sealed_dir.join("safe-preview-sealed-snapshot.json"),
        serde_json::to_vec_pretty(&safe.to_snapshot())?,
    )
    .context("write sealed preview snapshot")?;
    fs::write(
        sealed_dir.join("safe-preview-debug-state.json"),
        serde_json::to_vec_pretty(&safe.debug_state())?,
    )
    .context("write safe preview debug state")?;

    let exported = safe.export_to_sync(
        &master,
        SafeFolderExportRequest {
            safe_id: saved.document.document_id,
            destination_path: "exported/safe-preview-e2e.txt".to_string(),
            now_ms: 1_783_036_800_004,
        },
    )?;
    fs::write(
        export_dir.join("safe-preview-e2e-exported.txt"),
        exported.plaintext,
    )
    .context("write explicit safe preview export")?;

    println!("sealed_dir={}", sealed_dir.display());
    println!("export_dir={}", export_dir.display());
    println!("secret_marker={SECRET_MARKER}");
    println!("edited_marker={EDITED_MARKER}");
    println!("display_marker={DISPLAY_MARKER}");
    println!("raster_preview_ok=true");
    println!("editor_cleared=true");
    println!("agent_visible_count=0");
    println!("explicit_export_written=true");
    Ok(())
}

fn reset_dir(dir: &Path) -> Result<()> {
    if dir.exists() {
        fs::remove_dir_all(dir).with_context(|| format!("reset {}", dir.display()))?;
    }
    fs::create_dir_all(dir).with_context(|| format!("create {}", dir.display()))?;
    Ok(())
}
