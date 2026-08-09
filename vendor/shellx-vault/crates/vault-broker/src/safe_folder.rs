//! Safe Folder broker foundation.

use std::collections::BTreeMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use anyhow::{anyhow, bail, Context, Result};
use serde::{Deserialize, Serialize};
use vault_core::{crypto, validate_rel_path, MasterKey};

use crate::grants::{GrantAction, GrantPolicy};

pub const SAFE_FOLDER_MANIFEST_PREFIX: &str = ".vault-safe/objects/";
const SAFE_FOLDER_KEY_CONTEXT: &str = "shellx vault safe folder object v1";
const SAFE_FOLDER_HASH_CONTEXT: &str = "shellx vault safe folder content hash v1";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SafeFolderAction {
    Imported,
    Previewed,
    RevealedText,
    SavedText,
    DiscardedText,
    Searched,
    CopiedText,
    ExportedToSync,
    MovedToSafe,
    ExternalOpen,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SafeFolderEntry {
    pub safe_id: String,
    #[serde(default)]
    pub document_id: String,
    #[serde(default)]
    pub version_id: String,
    #[serde(default)]
    pub revision: u64,
    pub manifest_path: String,
    pub media_type: String,
    pub byte_len: u64,
    pub content_hash: String,
    pub imported_at_ms: i64,
    #[serde(skip)]
    sealed_bytes: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SafeFolderImportRequest {
    pub display_name: String,
    pub media_type: String,
    pub plaintext: Vec<u8>,
    pub now_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SafeFolderMoveInRequest {
    pub source_path: String,
    pub display_name: String,
    pub media_type: String,
    pub plaintext: Vec<u8>,
    pub now_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SafeFolderMoveInOutcome {
    pub source_path: String,
    pub entry: SafeFolderEntry,
    pub revoked_grants: usize,
}

struct SafeFolderSealRevisionRequest {
    document_id: String,
    display_name: String,
    media_type: String,
    plaintext: Vec<u8>,
    revision: u64,
    now_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SafeFolderExportRequest {
    pub safe_id: String,
    pub destination_path: String,
    pub now_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SafeFolderExport {
    pub destination_path: String,
    pub plaintext: Vec<u8>,
    pub content_hash: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SafeFolderSearchResult {
    pub safe_id: String,
    pub document_id: String,
    pub display_name: String,
    pub media_type: String,
    pub byte_len: u64,
    pub content_hash: String,
    pub secret_exposed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SafeFolderPreviewKind {
    Text,
    Markdown,
    Json,
    ImageMetadata,
    PdfMetadata,
    BinaryMetadata,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SafeFolderPreview {
    pub safe_id: String,
    pub kind: SafeFolderPreviewKind,
    pub summary: String,
    #[serde(default)]
    pub text: Option<String>,
    pub secret_exposed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SafeFolderReceipt {
    pub receipt_id: String,
    pub action: SafeFolderAction,
    pub safe_id: String,
    pub content_hash: String,
    #[serde(default)]
    pub source_path_hash: Option<String>,
    #[serde(default)]
    pub destination_path_hash: Option<String>,
    pub created_at_ms: i64,
    pub secret_exposed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SafeFolderDebugState {
    pub entry_count: usize,
    pub entries: Vec<SafeFolderDebugEntry>,
    pub receipt_count: usize,
    pub secret_exposed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SafeFolderDebugEntry {
    pub safe_id: String,
    pub document_id: String,
    pub version_id: String,
    pub revision: u64,
    pub manifest_path: String,
    pub media_type: String,
    pub byte_len: u64,
    pub content_hash: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SafeFolderPreviewMode {
    Raster,
    TextEditable,
    MetadataOnly,
    Unsupported,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SafeFolderOwnerDocument {
    pub document_id: String,
    pub safe_id: String,
    pub version_id: String,
    pub revision: u64,
    pub display_name: String,
    pub media_type: String,
    pub byte_len: u64,
    pub updated_at_ms: i64,
    pub content_hash: String,
    pub preview_mode: SafeFolderPreviewMode,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SafeFolderOwnerPlaintext {
    pub document_id: String,
    pub display_name: String,
    pub media_type: String,
    pub content_hash: String,
    pub plaintext: Vec<u8>,
}

#[derive(Debug, Clone, Default)]
pub struct SafeFolder {
    entries: BTreeMap<String, SafeFolderEntry>,
    receipts: Vec<SafeFolderReceipt>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SafeFolderSnapshot {
    pub entries: Vec<SafeFolderBackupEntry>,
    pub receipts: Vec<SafeFolderReceipt>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SafeFolderBackupEntry {
    pub safe_id: String,
    #[serde(default)]
    pub document_id: String,
    #[serde(default)]
    pub version_id: String,
    #[serde(default)]
    pub revision: u64,
    pub manifest_path: String,
    pub media_type: String,
    pub byte_len: u64,
    pub content_hash: String,
    pub imported_at_ms: i64,
    pub sealed_hex: String,
}

impl SafeFolder {
    pub fn import_plaintext(
        &mut self,
        master: &MasterKey,
        request: SafeFolderImportRequest,
    ) -> Result<SafeFolderEntry> {
        let entry = self.seal_entry(master, request)?;
        self.push_receipt(
            SafeFolderAction::Imported,
            &entry,
            None,
            None,
            entry.imported_at_ms,
        );
        self.entries.insert(entry.safe_id.clone(), entry.clone());
        Ok(entry)
    }

    pub fn move_sync_file_into_safe(
        &mut self,
        master: &MasterKey,
        policy: &mut GrantPolicy,
        request: SafeFolderMoveInRequest,
    ) -> Result<SafeFolderMoveInOutcome> {
        validate_rel_path(&request.source_path).map_err(|e| anyhow!("invalid source path: {e}"))?;
        let source_path = request.source_path;
        let source_path_hash = Some(redacted_path_hash(master, &source_path));
        let entry = self.seal_entry(
            master,
            SafeFolderImportRequest {
                display_name: request.display_name,
                media_type: request.media_type,
                plaintext: request.plaintext,
                now_ms: request.now_ms,
            },
        )?;
        let revoked_grants = policy.revoke_grants_for_path_actions(
            &source_path,
            [
                GrantAction::ReadFile,
                GrantAction::WriteFile,
                GrantAction::PullSyncSet,
                GrantAction::PushSyncSet,
            ],
            request.now_ms,
        );
        self.push_receipt(
            SafeFolderAction::MovedToSafe,
            &entry,
            source_path_hash,
            None,
            request.now_ms,
        );
        self.entries.insert(entry.safe_id.clone(), entry.clone());
        Ok(SafeFolderMoveInOutcome {
            source_path,
            entry,
            revoked_grants,
        })
    }

    pub fn preview_text(
        &mut self,
        master: &MasterKey,
        safe_id: &str,
        now_ms: i64,
    ) -> Result<String> {
        let entry = self
            .entries
            .get(safe_id)
            .cloned()
            .ok_or_else(|| anyhow!("safe folder entry not found"))?;
        let payload = open_entry(master, &entry)?;
        let text = String::from_utf8(payload.plaintext)
            .context("safe folder preview is not valid UTF-8")?;
        self.push_receipt(SafeFolderAction::Previewed, &entry, None, None, now_ms);
        Ok(text)
    }

    pub fn preview(
        &mut self,
        master: &MasterKey,
        safe_id: &str,
        now_ms: i64,
    ) -> Result<SafeFolderPreview> {
        let entry = self
            .entries
            .get(safe_id)
            .cloned()
            .ok_or_else(|| anyhow!("safe folder entry not found"))?;
        let payload = open_entry(master, &entry)?;
        let preview = preview_for_payload(&entry, &payload)?;
        self.push_receipt(SafeFolderAction::Previewed, &entry, None, None, now_ms);
        Ok(preview)
    }

    pub fn search_text(
        &mut self,
        master: &MasterKey,
        query: &str,
        now_ms: i64,
    ) -> Result<Vec<SafeFolderSearchResult>> {
        let query = query.trim().to_lowercase();
        if query.is_empty() {
            return Ok(Vec::new());
        }
        let mut results = Vec::new();
        for entry in self.entries.values() {
            let payload = open_entry(master, entry)?;
            let text = String::from_utf8_lossy(&payload.plaintext).to_lowercase();
            if payload.display_name.to_lowercase().contains(&query) || text.contains(&query) {
                results.push(SafeFolderSearchResult {
                    safe_id: entry.safe_id.clone(),
                    document_id: entry.document_id.clone(),
                    display_name: payload.display_name,
                    media_type: entry.media_type.clone(),
                    byte_len: entry.byte_len,
                    content_hash: entry.content_hash.clone(),
                    secret_exposed: false,
                });
            }
        }
        self.push_system_receipt(SafeFolderAction::Searched, now_ms);
        Ok(results)
    }

    pub fn copy_text(
        &mut self,
        master: &MasterKey,
        safe_id: &str,
        selected_text: &str,
        now_ms: i64,
    ) -> Result<String> {
        let entry = self
            .entries
            .get(safe_id)
            .cloned()
            .ok_or_else(|| anyhow!("safe folder entry not found"))?;
        let payload = open_entry(master, &entry)?;
        let text = String::from_utf8(payload.plaintext)
            .context("safe folder copy source is not valid UTF-8")?;
        if !text.contains(selected_text) {
            bail!("selected text is not present in safe folder preview");
        }
        self.push_receipt(SafeFolderAction::CopiedText, &entry, None, None, now_ms);
        Ok(selected_text.to_string())
    }

    pub fn export_to_sync(
        &mut self,
        master: &MasterKey,
        request: SafeFolderExportRequest,
    ) -> Result<SafeFolderExport> {
        validate_rel_path(&request.destination_path)
            .map_err(|e| anyhow!("invalid destination path: {e}"))?;
        let entry = self
            .entries
            .get(&request.safe_id)
            .cloned()
            .ok_or_else(|| anyhow!("safe folder entry not found"))?;
        let plaintext = open_entry(master, &entry)?.plaintext;
        let destination_path_hash = Some(redacted_path_hash(master, &request.destination_path));
        self.push_receipt(
            SafeFolderAction::ExportedToSync,
            &entry,
            None,
            destination_path_hash,
            request.now_ms,
        );
        Ok(SafeFolderExport {
            destination_path: request.destination_path,
            plaintext,
            content_hash: entry.content_hash,
        })
    }

    pub fn list_owner_documents(&self, master: &MasterKey) -> Result<Vec<SafeFolderOwnerDocument>> {
        self.entries
            .values()
            .map(|entry| {
                let payload = open_entry(master, entry)?;
                Ok(SafeFolderOwnerDocument {
                    document_id: entry.document_id.clone(),
                    safe_id: entry.safe_id.clone(),
                    version_id: entry.version_id.clone(),
                    revision: entry.revision,
                    display_name: payload.display_name,
                    media_type: entry.media_type.clone(),
                    byte_len: entry.byte_len,
                    updated_at_ms: entry.imported_at_ms,
                    content_hash: entry.content_hash.clone(),
                    preview_mode: preview_mode_for_entry(entry),
                })
            })
            .collect()
    }

    pub fn open_plaintext_for_owner(
        &mut self,
        master: &MasterKey,
        document_id: &str,
        now_ms: i64,
    ) -> Result<SafeFolderOwnerPlaintext> {
        let entry = self
            .entries
            .get(document_id)
            .cloned()
            .ok_or_else(|| anyhow!("safe folder entry not found"))?;
        let payload = open_entry(master, &entry)?;
        self.push_receipt(SafeFolderAction::Previewed, &entry, None, None, now_ms);
        Ok(SafeFolderOwnerPlaintext {
            document_id: entry.document_id.clone(),
            display_name: payload.display_name,
            media_type: entry.media_type.clone(),
            content_hash: entry.content_hash.clone(),
            plaintext: payload.plaintext,
        })
    }

    pub fn reveal_text_for_owner(
        &mut self,
        master: &MasterKey,
        document_id: &str,
        now_ms: i64,
    ) -> Result<SafeFolderOwnerPlaintext> {
        let entry = self
            .entries
            .get(document_id)
            .cloned()
            .ok_or_else(|| anyhow!("safe folder entry not found"))?;
        if !is_text_editable(&entry.media_type) {
            bail!("safe folder document is not editable text");
        }
        let payload = open_entry(master, &entry)?;
        self.push_receipt(SafeFolderAction::RevealedText, &entry, None, None, now_ms);
        Ok(SafeFolderOwnerPlaintext {
            document_id: entry.document_id.clone(),
            display_name: payload.display_name,
            media_type: entry.media_type.clone(),
            content_hash: entry.content_hash.clone(),
            plaintext: payload.plaintext,
        })
    }

    pub fn save_text_revision(
        &mut self,
        master: &MasterKey,
        document_id: &str,
        next_text: String,
        expected_content_hash: String,
        now_ms: i64,
    ) -> Result<SafeFolderEntry> {
        let current = self
            .entries
            .get(document_id)
            .cloned()
            .ok_or_else(|| anyhow!("safe folder entry not found"))?;
        if !is_text_editable(&current.media_type) {
            bail!("safe folder document is not editable text");
        }
        if current.content_hash != expected_content_hash {
            bail!("safe folder document changed; reload before saving");
        }
        let payload = open_entry(master, &current)?;
        let next = self.seal_revision(
            master,
            SafeFolderSealRevisionRequest {
                document_id: current.document_id.clone(),
                display_name: payload.display_name,
                media_type: current.media_type.clone(),
                plaintext: next_text.into_bytes(),
                revision: current.revision + 1,
                now_ms,
            },
        )?;
        self.push_receipt(SafeFolderAction::SavedText, &next, None, None, now_ms);
        self.entries.insert(next.document_id.clone(), next.clone());
        Ok(next)
    }

    pub fn record_text_discard(
        &mut self,
        document_id: &str,
        now_ms: i64,
    ) -> Result<SafeFolderReceipt> {
        let entry = self
            .entries
            .get(document_id)
            .cloned()
            .ok_or_else(|| anyhow!("safe folder entry not found"))?;
        Ok(self.push_receipt(SafeFolderAction::DiscardedText, &entry, None, None, now_ms))
    }

    pub fn agent_visible_files(&self) -> impl Iterator<Item = &SafeFolderEntry> {
        std::iter::empty()
    }

    pub fn receipts(&self) -> &[SafeFolderReceipt] {
        &self.receipts
    }

    pub fn debug_state(&self) -> SafeFolderDebugState {
        SafeFolderDebugState {
            entry_count: self.entries.len(),
            entries: self
                .entries
                .values()
                .map(|entry| SafeFolderDebugEntry {
                    safe_id: entry.safe_id.clone(),
                    document_id: entry.document_id.clone(),
                    version_id: entry.version_id.clone(),
                    revision: entry.revision,
                    manifest_path: entry.manifest_path.clone(),
                    media_type: entry.media_type.clone(),
                    byte_len: entry.byte_len,
                    content_hash: entry.content_hash.clone(),
                })
                .collect(),
            receipt_count: self.receipts.len(),
            secret_exposed: false,
        }
    }

    pub fn to_snapshot(&self) -> SafeFolderSnapshot {
        SafeFolderSnapshot {
            entries: self
                .entries
                .values()
                .map(|entry| SafeFolderBackupEntry {
                    safe_id: entry.safe_id.clone(),
                    document_id: entry.document_id.clone(),
                    version_id: entry.version_id.clone(),
                    revision: entry.revision,
                    manifest_path: entry.manifest_path.clone(),
                    media_type: entry.media_type.clone(),
                    byte_len: entry.byte_len,
                    content_hash: entry.content_hash.clone(),
                    imported_at_ms: entry.imported_at_ms,
                    sealed_hex: hex::encode(&entry.sealed_bytes),
                })
                .collect(),
            receipts: self.receipts.clone(),
        }
    }

    pub fn from_snapshot(snapshot: SafeFolderSnapshot) -> Result<Self> {
        let mut entries = BTreeMap::new();
        for entry in snapshot.entries {
            let sealed_bytes = hex::decode(&entry.sealed_hex)
                .with_context(|| format!("corrupted safe folder object {}", entry.safe_id))?;
            let document_id = if entry.document_id.is_empty() {
                entry.safe_id.clone()
            } else {
                entry.document_id
            };
            let revision = if entry.revision == 0 {
                1
            } else {
                entry.revision
            };
            let version_id = if entry.version_id.is_empty() {
                version_id(&document_id, &entry.content_hash, revision)
            } else {
                entry.version_id
            };
            entries.insert(
                document_id.clone(),
                SafeFolderEntry {
                    safe_id: entry.safe_id,
                    document_id,
                    version_id,
                    revision,
                    manifest_path: entry.manifest_path,
                    media_type: entry.media_type,
                    byte_len: entry.byte_len,
                    content_hash: entry.content_hash,
                    imported_at_ms: entry.imported_at_ms,
                    sealed_bytes,
                },
            );
        }
        Ok(Self {
            entries,
            receipts: snapshot.receipts,
        })
    }

    fn seal_entry(
        &self,
        master: &MasterKey,
        request: SafeFolderImportRequest,
    ) -> Result<SafeFolderEntry> {
        let document_id = document_id(&request.display_name, request.now_ms);
        self.seal_revision(
            master,
            SafeFolderSealRevisionRequest {
                document_id,
                display_name: request.display_name,
                media_type: request.media_type,
                plaintext: request.plaintext,
                revision: 1,
                now_ms: request.now_ms,
            },
        )
    }

    fn seal_revision(
        &self,
        master: &MasterKey,
        request: SafeFolderSealRevisionRequest,
    ) -> Result<SafeFolderEntry> {
        validate_display_name(&request.display_name)?;
        if request.plaintext.is_empty() {
            bail!("safe folder entry cannot be empty");
        }
        let content_hash = content_hash(master, &request.plaintext);
        let safe_id = request.document_id.clone();
        let version_id = version_id(&request.document_id, &content_hash, request.revision);
        let manifest_path = format!("{SAFE_FOLDER_MANIFEST_PREFIX}{}.safe", request.document_id);
        let payload = SafeFolderSealedPayload {
            display_name: request.display_name.trim().to_string(),
            plaintext: request.plaintext.clone(),
        };
        let payload_bytes =
            serde_json::to_vec(&payload).context("safe folder payload serialization failed")?;
        let sealed_bytes = crypto::seal(
            &safe_folder_key(master),
            entry_aad(&safe_id).as_bytes(),
            &payload_bytes,
        );
        Ok(SafeFolderEntry {
            safe_id,
            document_id: request.document_id,
            version_id,
            revision: request.revision,
            manifest_path,
            media_type: normalize_media_type(&request.media_type),
            byte_len: request.plaintext.len() as u64,
            content_hash,
            imported_at_ms: request.now_ms,
            sealed_bytes,
        })
    }

    fn push_receipt(
        &mut self,
        action: SafeFolderAction,
        entry: &SafeFolderEntry,
        source_path_hash: Option<String>,
        destination_path_hash: Option<String>,
        created_at_ms: i64,
    ) -> SafeFolderReceipt {
        let receipt = SafeFolderReceipt {
            receipt_id: format!("safe-receipt-{created_at_ms}-{}", self.receipts.len() + 1),
            action,
            safe_id: entry.safe_id.clone(),
            content_hash: entry.content_hash.clone(),
            source_path_hash,
            destination_path_hash,
            created_at_ms,
            secret_exposed: false,
        };
        self.receipts.push(receipt.clone());
        receipt
    }

    fn push_system_receipt(
        &mut self,
        action: SafeFolderAction,
        created_at_ms: i64,
    ) -> SafeFolderReceipt {
        let receipt = SafeFolderReceipt {
            receipt_id: format!("safe-receipt-{created_at_ms}-{}", self.receipts.len() + 1),
            action,
            safe_id: "safe-folder".to_string(),
            content_hash: String::new(),
            source_path_hash: None,
            destination_path_hash: None,
            created_at_ms,
            secret_exposed: false,
        };
        self.receipts.push(receipt.clone());
        receipt
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct SafeFolderSealedPayload {
    display_name: String,
    plaintext: Vec<u8>,
}

#[derive(Debug, Clone)]
pub struct SafeFolderSessionCache {
    session_dir: PathBuf,
}

impl SafeFolderSessionCache {
    pub fn new(profile_dir: &Path) -> io::Result<Self> {
        let session_dir = profile_dir.join("safe-folder-session");
        fs::create_dir_all(&session_dir)?;
        set_private_dir_permissions(&session_dir)?;
        Ok(Self { session_dir })
    }

    pub fn session_dir(&self) -> &Path {
        &self.session_dir
    }

    pub fn write_preview(&self, safe_id: &str, plaintext: &[u8]) -> io::Result<PathBuf> {
        fs::create_dir_all(&self.session_dir)?;
        set_private_dir_permissions(&self.session_dir)?;
        let path = self
            .session_dir
            .join(format!("{}.preview", sanitize_cache_name(safe_id)));
        fs::write(&path, plaintext)?;
        set_private_file_permissions(&path)?;
        Ok(path)
    }

    pub fn clear_on_lock(&self) -> io::Result<()> {
        if self.session_dir.exists() {
            fs::remove_dir_all(&self.session_dir)?;
        }
        Ok(())
    }
}

fn open_entry(master: &MasterKey, entry: &SafeFolderEntry) -> Result<SafeFolderSealedPayload> {
    let payload = crypto::open(
        &safe_folder_key(master),
        entry_aad(&entry.safe_id).as_bytes(),
        &entry.sealed_bytes,
    )
    .map_err(|e| anyhow!("safe folder entry failed to open: {e}"))?;
    serde_json::from_slice(&payload).context("safe folder sealed payload is malformed")
}

fn safe_folder_key(master: &MasterKey) -> [u8; 32] {
    blake3::derive_key(SAFE_FOLDER_KEY_CONTEXT, &master.manifest_key())
}

fn content_hash(master: &MasterKey, plaintext: &[u8]) -> String {
    blake3::keyed_hash(&content_hash_key(master), plaintext)
        .to_hex()
        .to_string()
}

fn content_hash_key(master: &MasterKey) -> [u8; 32] {
    blake3::derive_key(SAFE_FOLDER_HASH_CONTEXT, &master.manifest_key())
}

fn redacted_path_hash(master: &MasterKey, path: &str) -> String {
    blake3::keyed_hash(&content_hash_key(master), path.as_bytes())
        .to_hex()
        .to_string()
}

fn document_id(display_name: &str, now_ms: i64) -> String {
    let material = format!("{display_name}\0{now_ms}\0shellx-vault-safe-document-v1");
    let hash = blake3::hash(material.as_bytes()).to_hex().to_string();
    format!("safe-doc-{}", &hash[..32])
}

fn version_id(document_id: &str, content_hash: &str, revision: u64) -> String {
    let material = format!("{document_id}\0{content_hash}\0{revision}");
    let hash = blake3::hash(material.as_bytes()).to_hex().to_string();
    format!("safe-ver-{}", &hash[..32])
}

fn entry_aad(safe_id: &str) -> String {
    format!("shellx-vault-safe-folder-entry-v1:{safe_id}")
}

fn validate_display_name(display_name: &str) -> Result<()> {
    let trimmed = display_name.trim();
    if trimmed.is_empty() {
        bail!("display name is required");
    }
    if trimmed.contains('\0') || trimmed.contains('/') || trimmed.contains('\\') {
        bail!("display name must be a single file name");
    }
    Ok(())
}

fn normalize_media_type(media_type: &str) -> String {
    let trimmed = media_type.trim();
    if trimmed.is_empty() {
        "application/octet-stream".to_string()
    } else {
        trimmed.to_ascii_lowercase()
    }
}

fn is_text_editable(media_type: &str) -> bool {
    media_type.starts_with("text/")
        || media_type == "application/json"
        || media_type.ends_with("+json")
}

fn preview_mode_for_entry(entry: &SafeFolderEntry) -> SafeFolderPreviewMode {
    if is_text_editable(&entry.media_type) {
        SafeFolderPreviewMode::TextEditable
    } else if entry.media_type == "application/pdf"
        || entry.media_type.starts_with("image/")
        || is_office_like(&entry.media_type, &entry.manifest_path)
    {
        SafeFolderPreviewMode::MetadataOnly
    } else {
        SafeFolderPreviewMode::Unsupported
    }
}

fn is_office_like(media_type: &str, manifest_path: &str) -> bool {
    matches!(
        media_type,
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            | "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            | "application/vnd.openxmlformats-officedocument.presentationml.presentation"
    ) || [".docx", ".xlsx", ".pptx"]
        .iter()
        .any(|suffix| manifest_path.to_ascii_lowercase().ends_with(suffix))
}

fn preview_for_payload(
    entry: &SafeFolderEntry,
    payload: &SafeFolderSealedPayload,
) -> Result<SafeFolderPreview> {
    let media = entry.media_type.as_str();
    let (kind, summary, text) = if media == "text/markdown" || media == "text/x-markdown" {
        let text = String::from_utf8(payload.plaintext.clone())
            .context("markdown preview is not valid UTF-8")?;
        (
            SafeFolderPreviewKind::Markdown,
            first_line_summary(&text),
            Some(text),
        )
    } else if media.starts_with("text/") {
        let text = String::from_utf8(payload.plaintext.clone())
            .context("text preview is not valid UTF-8")?;
        (
            SafeFolderPreviewKind::Text,
            first_line_summary(&text),
            Some(text),
        )
    } else if media == "application/json" || media.ends_with("+json") {
        let text = String::from_utf8(payload.plaintext.clone())
            .context("JSON preview is not valid UTF-8")?;
        let summary = json_summary(&text)?;
        (SafeFolderPreviewKind::Json, summary, Some(text))
    } else if media.starts_with("image/") {
        (
            SafeFolderPreviewKind::ImageMetadata,
            format!("{media}, {} bytes", entry.byte_len),
            None,
        )
    } else if media == "application/pdf" {
        (
            SafeFolderPreviewKind::PdfMetadata,
            format!("PDF metadata, {} bytes", entry.byte_len),
            None,
        )
    } else {
        (
            SafeFolderPreviewKind::BinaryMetadata,
            format!("{media}, {} bytes", entry.byte_len),
            None,
        )
    };
    Ok(SafeFolderPreview {
        safe_id: entry.safe_id.clone(),
        kind,
        summary,
        text,
        secret_exposed: false,
    })
}

fn first_line_summary(text: &str) -> String {
    text.lines()
        .next()
        .unwrap_or("")
        .chars()
        .take(120)
        .collect::<String>()
}

fn json_summary(text: &str) -> Result<String> {
    let value: serde_json::Value =
        serde_json::from_str(text).context("JSON preview failed to parse")?;
    let summary = match value {
        serde_json::Value::Object(map) => {
            let keys = map.keys().take(8).cloned().collect::<Vec<_>>().join(", ");
            format!("JSON object keys: {keys}")
        }
        serde_json::Value::Array(items) => format!("JSON array with {} item(s)", items.len()),
        _ => "JSON value".to_string(),
    };
    Ok(summary)
}

fn sanitize_cache_name(safe_id: &str) -> String {
    safe_id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

#[cfg(unix)]
fn set_private_dir_permissions(path: &Path) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))
}

#[cfg(not(unix))]
fn set_private_dir_permissions(_path: &Path) -> io::Result<()> {
    Ok(())
}

#[cfg(unix)]
fn set_private_file_permissions(path: &Path) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
}

#[cfg(not(unix))]
fn set_private_file_permissions(_path: &Path) -> io::Result<()> {
    Ok(())
}
