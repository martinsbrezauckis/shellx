use vault_broker::safe_folder::{SafeFolder, SafeFolderImportRequest};
use vault_broker::safe_preview::{SafePreviewAction, SafePreviewSession};
use vault_broker::safe_render::{render_safe_preview, SafeRenderInput, SafeRenderKind};
use vault_core::MasterKey;

#[test]
fn text_quick_view_returns_png_without_source_text() {
    let rendered = render_safe_preview(SafeRenderInput {
        display_name: "notes.txt".to_string(),
        media_type: "text/plain".to_string(),
        plaintext: b"private marker alpha beta".to_vec(),
        page_index: 0,
    })
    .expect("render text preview");

    assert_eq!(rendered.kind, SafeRenderKind::RasterPage);
    assert_eq!(rendered.mime, "image/png");
    assert!(rendered.bytes.starts_with(b"\x89PNG\r\n\x1a\n"));
    assert!(!String::from_utf8_lossy(&rendered.bytes).contains("private marker"));
    assert!(!rendered.secret_exposed);
}

#[test]
fn safe_folder_edit_preserves_document_id_and_advances_version() {
    let master = MasterKey::generate();
    let mut safe = SafeFolder::default();
    let entry = safe
        .import_plaintext(
            &master,
            SafeFolderImportRequest {
                display_name: "note.txt".to_string(),
                media_type: "text/plain".to_string(),
                plaintext: b"first".to_vec(),
                now_ms: 100,
            },
        )
        .unwrap();

    let saved = safe
        .save_text_revision(
            &master,
            &entry.document_id,
            "second".to_string(),
            entry.content_hash.clone(),
            101,
        )
        .unwrap();

    assert_eq!(saved.document_id, entry.document_id);
    assert_ne!(saved.version_id, entry.version_id);
    assert_eq!(saved.revision, entry.revision + 1);
    assert_eq!(
        safe.preview_text(&master, &saved.document_id, 102).unwrap(),
        "second"
    );
}

#[test]
fn preview_session_opens_raster_reveals_text_and_clears_on_lock() {
    let master = MasterKey::generate();
    let mut safe = SafeFolder::default();
    let entry = safe
        .import_plaintext(
            &master,
            SafeFolderImportRequest {
                display_name: "note.txt".to_string(),
                media_type: "text/plain".to_string(),
                plaintext: b"private edit marker".to_vec(),
                now_ms: 200,
            },
        )
        .unwrap();
    let mut session = SafePreviewSession::default();

    let raster = session
        .open_raster(&mut safe, &master, &entry.document_id, 0, 201)
        .unwrap();
    assert!(raster.bytes.starts_with(b"\x89PNG"));
    assert!(!raster.secret_exposed);

    let editor = session
        .reveal_text(&mut safe, &master, &entry.document_id, 202)
        .unwrap();
    assert_eq!(editor.text, "private edit marker");
    assert_eq!(editor.action, SafePreviewAction::RevealText);

    session.clear_on_lock();
    assert!(session.preview_handle(&raster.preview_handle_id).is_none());
    assert!(session.editor_handle(&editor.editor_handle_id).is_none());
}

#[test]
fn preview_session_save_uses_single_use_editor_handle() {
    let master = MasterKey::generate();
    let mut safe = SafeFolder::default();
    let entry = safe
        .import_plaintext(
            &master,
            SafeFolderImportRequest {
                display_name: "draft.txt".to_string(),
                media_type: "text/plain".to_string(),
                plaintext: b"first draft".to_vec(),
                now_ms: 300,
            },
        )
        .unwrap();
    let mut session = SafePreviewSession::default();
    let editor = session
        .reveal_text(&mut safe, &master, &entry.document_id, 301)
        .unwrap();

    let saved = session
        .save_text_edit(
            &mut safe,
            &master,
            &editor.editor_handle_id,
            "second draft".to_string(),
            302,
        )
        .unwrap();

    assert_eq!(saved.action, SafePreviewAction::SaveText);
    assert_eq!(saved.document.document_id, entry.document_id);
    assert_eq!(saved.document.revision, 2);
    assert!(session.editor_handle(&editor.editor_handle_id).is_none());
    assert!(session
        .save_text_edit(
            &mut safe,
            &master,
            &editor.editor_handle_id,
            "third draft".to_string(),
            303,
        )
        .is_err());
}
