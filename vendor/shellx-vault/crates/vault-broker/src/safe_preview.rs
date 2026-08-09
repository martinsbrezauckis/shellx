//! Owner-only Safe Folder preview/edit session manager.
//!
//! Handles are intentionally opaque. Raster handles never retain image
//! bytes, and editor handles retain only document identity and CAS hash.
//! The trusted UI owns any revealed editor text and lock clears all
//! broker-side handles.

use std::collections::BTreeMap;

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use vault_core::MasterKey;

use crate::safe_folder::{SafeFolder, SafeFolderEntry};
use crate::safe_render::{render_safe_preview, SafeRenderInput, SafeRenderKind};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SafePreviewAction {
    RasterPreview,
    RevealText,
    SaveText,
    DiscardText,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SafeRasterPreviewResponse {
    pub preview_handle_id: String,
    pub document_id: String,
    pub kind: SafeRenderKind,
    pub bytes: Vec<u8>,
    pub mime: String,
    pub width: u32,
    pub height: u32,
    pub page_index: usize,
    pub page_count: usize,
    pub summary: String,
    pub secret_exposed: bool,
    pub action: SafePreviewAction,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SafeTextEditorResponse {
    pub editor_handle_id: String,
    pub document_id: String,
    pub display_name: String,
    pub media_type: String,
    pub text: String,
    pub content_hash: String,
    pub action: SafePreviewAction,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SafeTextEditOutcome {
    pub document: SafeFolderEntry,
    pub action: SafePreviewAction,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SafeTextDiscardOutcome {
    pub document_id: String,
    pub action: SafePreviewAction,
}

#[derive(Debug, Clone)]
struct PreviewHandle {
    document_id: String,
}

#[derive(Debug, Clone)]
struct EditorHandle {
    document_id: String,
    content_hash: String,
}

#[derive(Debug, Default, Clone)]
pub struct SafePreviewSession {
    next_id: u64,
    previews: BTreeMap<String, PreviewHandle>,
    editors: BTreeMap<String, EditorHandle>,
}

impl SafePreviewSession {
    pub fn open_raster(
        &mut self,
        safe: &mut SafeFolder,
        master: &MasterKey,
        document_id: &str,
        page_index: usize,
        now_ms: i64,
    ) -> Result<SafeRasterPreviewResponse> {
        let opened = safe.open_plaintext_for_owner(master, document_id, now_ms)?;
        let rendered = render_safe_preview(SafeRenderInput {
            display_name: opened.display_name,
            media_type: opened.media_type,
            plaintext: opened.plaintext,
            page_index,
        })?;
        let preview_handle_id = self.next_handle("safe-preview");
        self.previews.insert(
            preview_handle_id.clone(),
            PreviewHandle {
                document_id: opened.document_id.clone(),
            },
        );
        Ok(SafeRasterPreviewResponse {
            preview_handle_id,
            document_id: opened.document_id,
            kind: rendered.kind,
            bytes: rendered.bytes,
            mime: rendered.mime,
            width: rendered.width,
            height: rendered.height,
            page_index: rendered.page_index,
            page_count: rendered.page_count,
            summary: rendered.summary,
            secret_exposed: false,
            action: SafePreviewAction::RasterPreview,
        })
    }

    pub fn reveal_text(
        &mut self,
        safe: &mut SafeFolder,
        master: &MasterKey,
        document_id: &str,
        now_ms: i64,
    ) -> Result<SafeTextEditorResponse> {
        let opened = safe.reveal_text_for_owner(master, document_id, now_ms)?;
        let text = String::from_utf8(opened.plaintext)?;
        let editor_handle_id = self.next_handle("safe-editor");
        self.editors.insert(
            editor_handle_id.clone(),
            EditorHandle {
                document_id: opened.document_id.clone(),
                content_hash: opened.content_hash.clone(),
            },
        );
        Ok(SafeTextEditorResponse {
            editor_handle_id,
            document_id: opened.document_id,
            display_name: opened.display_name,
            media_type: opened.media_type,
            text,
            content_hash: opened.content_hash,
            action: SafePreviewAction::RevealText,
        })
    }

    pub fn save_text_edit(
        &mut self,
        safe: &mut SafeFolder,
        master: &MasterKey,
        editor_handle_id: &str,
        text: String,
        now_ms: i64,
    ) -> Result<SafeTextEditOutcome> {
        let handle = self
            .editors
            .remove(editor_handle_id)
            .ok_or_else(|| anyhow!("safe folder editor handle not found"))?;
        let document = safe.save_text_revision(
            master,
            &handle.document_id,
            text,
            handle.content_hash,
            now_ms,
        )?;
        Ok(SafeTextEditOutcome {
            document,
            action: SafePreviewAction::SaveText,
        })
    }

    pub fn discard_text_edit(
        &mut self,
        safe: &mut SafeFolder,
        editor_handle_id: &str,
        now_ms: i64,
    ) -> Result<SafeTextDiscardOutcome> {
        let handle = self
            .editors
            .remove(editor_handle_id)
            .ok_or_else(|| anyhow!("safe folder editor handle not found"))?;
        safe.record_text_discard(&handle.document_id, now_ms)?;
        Ok(SafeTextDiscardOutcome {
            document_id: handle.document_id,
            action: SafePreviewAction::DiscardText,
        })
    }

    pub fn preview_handle(&self, handle_id: &str) -> Option<&str> {
        self.previews
            .get(handle_id)
            .map(|handle| handle.document_id.as_str())
    }

    pub fn editor_handle(&self, handle_id: &str) -> Option<&str> {
        self.editors
            .get(handle_id)
            .map(|handle| handle.document_id.as_str())
    }

    pub fn clear_on_lock(&mut self) {
        self.previews.clear();
        self.editors.clear();
    }

    fn next_handle(&mut self, prefix: &str) -> String {
        self.next_id += 1;
        format!("{prefix}-{}", self.next_id)
    }
}
