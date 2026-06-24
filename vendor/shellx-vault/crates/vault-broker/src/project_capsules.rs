//! Project capsule handoff foundation.

use std::collections::{BTreeMap, BTreeSet};

use anyhow::{anyhow, bail, Result};
use serde::{Deserialize, Serialize};

use crate::sync_sets::SyncSetPolicy;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CapsuleOptions {
    pub include_git: bool,
    pub max_file_bytes: u64,
    pub exclude_globs: Vec<String>,
}

impl Default for CapsuleOptions {
    fn default() -> Self {
        let sync_policy = SyncSetPolicy::default();
        Self {
            include_git: false,
            max_file_bytes: sync_policy.max_file_bytes,
            exclude_globs: sync_policy.exclude_globs,
        }
    }
}

impl CapsuleOptions {
    fn sync_policy(&self) -> SyncSetPolicy {
        let exclude_globs = self
            .exclude_globs
            .iter()
            .filter(|pattern| !self.include_git || pattern.as_str() != ".git/**")
            .cloned()
            .collect();
        SyncSetPolicy {
            max_file_bytes: self.max_file_bytes,
            exclude_globs,
            ..SyncSetPolicy::default()
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CapsuleCandidate {
    pub path: String,
    pub size: u64,
    pub hash: String,
}

impl CapsuleCandidate {
    pub fn file(path: impl Into<String>, size: u64, hash: impl Into<String>) -> Self {
        Self {
            path: path.into(),
            size,
            hash: hash.into(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CapsuleManifest {
    pub files: Vec<CapsuleManifestEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CapsuleManifestEntry {
    pub path: String,
    pub size: u64,
    pub hash: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum CapsuleExcludedReason {
    GitExcluded,
    SyncSetExclude,
    LargeFile,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CapsuleExcludedEntry {
    pub path: String,
    pub reason: CapsuleExcludedReason,
    pub size: u64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CapsuleSizeReport {
    pub included_files: usize,
    pub included_bytes: u64,
    pub excluded_files: usize,
    pub excluded_bytes: u64,
    pub blocked_large_files: usize,
    pub blocked_large_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum CapsuleStatus {
    Created,
    Hydrated,
    ReturnCollected,
    Previewed,
    Applied,
    BlockedByConflicts,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectCapsule {
    pub capsule_id: String,
    #[serde(default)]
    pub parent_capsule_id: Option<String>,
    pub label: String,
    pub source_path: String,
    pub source_device: String,
    #[serde(default)]
    pub target_device: Option<String>,
    #[serde(default)]
    pub workspace_path: Option<String>,
    #[serde(default)]
    pub actor_id: Option<String>,
    pub options: CapsuleOptions,
    pub manifest: CapsuleManifest,
    pub excluded_report: Vec<CapsuleExcludedEntry>,
    pub size_report: CapsuleSizeReport,
    pub status: CapsuleStatus,
    pub created_at_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum CapsuleReceiptAction {
    Created,
    Hydrated,
    ReturnCollected,
    Previewed,
    Applied,
    Conflict,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CapsuleReceipt {
    pub receipt_id: String,
    pub capsule_id: String,
    #[serde(default)]
    pub parent_capsule_id: Option<String>,
    pub action: CapsuleReceiptAction,
    pub source_device: String,
    #[serde(default)]
    pub target_device: Option<String>,
    #[serde(default)]
    pub actor_id: Option<String>,
    pub files_changed: usize,
    pub conflicts: usize,
    pub created_at_ms: i64,
    pub secret_exposed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CapsuleApplyPreview {
    pub preview_id: String,
    pub return_capsule_id: String,
    pub added_paths: Vec<String>,
    pub modified_paths: Vec<String>,
    pub deleted_paths: Vec<String>,
    pub conflict_paths: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum CapsuleApplyDecision {
    Applied,
    BlockedByConflicts,
}

#[derive(Debug, Clone, Default)]
pub struct CapsuleRegistry {
    capsules: BTreeMap<String, ProjectCapsule>,
    previews: BTreeMap<String, CapsuleApplyPreview>,
    receipts: Vec<CapsuleReceipt>,
}

impl CapsuleRegistry {
    #[allow(clippy::too_many_arguments)]
    pub fn create_capsule(
        &mut self,
        capsule_id: &str,
        label: &str,
        source_path: &str,
        source_device: &str,
        options: CapsuleOptions,
        candidates: Vec<CapsuleCandidate>,
        now_ms: i64,
    ) -> Result<ProjectCapsule> {
        if self.capsules.contains_key(capsule_id) {
            bail!("capsule already exists");
        }
        let (manifest, excluded_report, size_report) = build_manifest(&options, candidates);
        let capsule = ProjectCapsule {
            capsule_id: capsule_id.to_string(),
            parent_capsule_id: None,
            label: label.to_string(),
            source_path: source_path.to_string(),
            source_device: source_device.to_string(),
            target_device: None,
            workspace_path: None,
            actor_id: None,
            options,
            manifest,
            excluded_report,
            size_report,
            status: CapsuleStatus::Created,
            created_at_ms: now_ms,
        };
        self.capsules
            .insert(capsule.capsule_id.clone(), capsule.clone());
        self.push_receipt(&capsule, CapsuleReceiptAction::Created, 0, now_ms);
        Ok(capsule)
    }

    pub fn hydrate_capsule(
        &mut self,
        capsule_id: &str,
        target_device: &str,
        workspace_path: &str,
        now_ms: i64,
    ) -> Result<ProjectCapsule> {
        let capsule = self
            .capsules
            .get_mut(capsule_id)
            .ok_or_else(|| anyhow!("capsule not found"))?;
        capsule.target_device = Some(target_device.to_string());
        capsule.workspace_path = Some(workspace_path.to_string());
        capsule.status = CapsuleStatus::Hydrated;
        let capsule = capsule.clone();
        self.push_receipt(&capsule, CapsuleReceiptAction::Hydrated, 0, now_ms);
        Ok(capsule)
    }

    pub fn collect_return_capsule(
        &mut self,
        parent_capsule_id: &str,
        return_capsule_id: &str,
        actor_id: &str,
        source_device: &str,
        candidates: Vec<CapsuleCandidate>,
        now_ms: i64,
    ) -> Result<ProjectCapsule> {
        if self.capsules.contains_key(return_capsule_id) {
            bail!("return capsule already exists");
        }
        let parent = self
            .capsules
            .get(parent_capsule_id)
            .cloned()
            .ok_or_else(|| anyhow!("parent capsule not found"))?;
        let (manifest, excluded_report, size_report) = build_manifest(&parent.options, candidates);
        let capsule = ProjectCapsule {
            capsule_id: return_capsule_id.to_string(),
            parent_capsule_id: Some(parent_capsule_id.to_string()),
            label: format!("{} return", parent.label),
            source_path: parent
                .workspace_path
                .clone()
                .unwrap_or_else(|| parent.source_path.clone()),
            source_device: source_device.to_string(),
            target_device: Some(parent.source_device.clone()),
            workspace_path: parent.workspace_path,
            actor_id: Some(actor_id.to_string()),
            options: parent.options,
            manifest,
            excluded_report,
            size_report,
            status: CapsuleStatus::ReturnCollected,
            created_at_ms: now_ms,
        };
        self.capsules
            .insert(capsule.capsule_id.clone(), capsule.clone());
        self.push_receipt(&capsule, CapsuleReceiptAction::ReturnCollected, 0, now_ms);
        Ok(capsule)
    }

    pub fn preview_apply_return_capsule(
        &mut self,
        return_capsule_id: &str,
        current_source: Vec<CapsuleCandidate>,
        now_ms: i64,
    ) -> Result<CapsuleApplyPreview> {
        let return_capsule = self
            .capsules
            .get(return_capsule_id)
            .cloned()
            .ok_or_else(|| anyhow!("return capsule not found"))?;
        let parent_id = return_capsule
            .parent_capsule_id
            .clone()
            .ok_or_else(|| anyhow!("capsule is not a return capsule"))?;
        let parent = self
            .capsules
            .get(&parent_id)
            .ok_or_else(|| anyhow!("parent capsule not found"))?;
        let preview = build_preview(
            return_capsule_id,
            &parent.manifest.files,
            &return_capsule.manifest.files,
            current_source,
            self.previews.len() + 1,
        );
        self.previews
            .insert(preview.preview_id.clone(), preview.clone());
        let mut capsule = return_capsule;
        capsule.status = CapsuleStatus::Previewed;
        self.capsules
            .insert(capsule.capsule_id.clone(), capsule.clone());
        self.push_receipt(
            &capsule,
            CapsuleReceiptAction::Previewed,
            preview.conflict_paths.len(),
            now_ms,
        );
        Ok(preview)
    }

    pub fn apply_return_capsule(
        &mut self,
        return_capsule_id: &str,
        preview_id: &str,
        now_ms: i64,
    ) -> Result<CapsuleApplyDecision> {
        let preview = self
            .previews
            .get(preview_id)
            .cloned()
            .ok_or_else(|| anyhow!("preview not found"))?;
        if preview.return_capsule_id != return_capsule_id {
            bail!("preview does not belong to return capsule");
        }
        let capsule = self
            .capsules
            .get_mut(return_capsule_id)
            .ok_or_else(|| anyhow!("return capsule not found"))?;
        let action = if preview.conflict_paths.is_empty() {
            capsule.status = CapsuleStatus::Applied;
            CapsuleReceiptAction::Applied
        } else {
            capsule.status = CapsuleStatus::BlockedByConflicts;
            CapsuleReceiptAction::Conflict
        };
        let decision = if action == CapsuleReceiptAction::Applied {
            CapsuleApplyDecision::Applied
        } else {
            CapsuleApplyDecision::BlockedByConflicts
        };
        let conflicts = preview.conflict_paths.len();
        let capsule = capsule.clone();
        self.push_receipt(&capsule, action, conflicts, now_ms);
        Ok(decision)
    }

    pub fn receipts(&self) -> &[CapsuleReceipt] {
        &self.receipts
    }

    fn push_receipt(
        &mut self,
        capsule: &ProjectCapsule,
        action: CapsuleReceiptAction,
        conflicts: usize,
        created_at_ms: i64,
    ) {
        self.receipts.push(CapsuleReceipt {
            receipt_id: format!(
                "capsule-receipt-{created_at_ms}-{}",
                self.receipts.len() + 1
            ),
            capsule_id: capsule.capsule_id.clone(),
            parent_capsule_id: capsule.parent_capsule_id.clone(),
            action,
            source_device: capsule.source_device.clone(),
            target_device: capsule.target_device.clone(),
            actor_id: capsule.actor_id.clone(),
            files_changed: capsule.manifest.files.len(),
            conflicts,
            created_at_ms,
            secret_exposed: false,
        });
    }
}

fn build_manifest(
    options: &CapsuleOptions,
    candidates: Vec<CapsuleCandidate>,
) -> (
    CapsuleManifest,
    Vec<CapsuleExcludedEntry>,
    CapsuleSizeReport,
) {
    let sync_policy = options.sync_policy();
    let mut files = Vec::new();
    let mut excluded_report = Vec::new();
    let mut size_report = CapsuleSizeReport::default();

    for candidate in candidates {
        let normalized = candidate.path.trim_start_matches("./").to_string();
        if !options.include_git && is_git_path(&normalized) {
            push_excluded(
                &mut excluded_report,
                &mut size_report,
                normalized,
                CapsuleExcludedReason::GitExcluded,
                candidate.size,
            );
        } else if candidate.size > options.max_file_bytes {
            push_excluded(
                &mut excluded_report,
                &mut size_report,
                normalized,
                CapsuleExcludedReason::LargeFile,
                candidate.size,
            );
        } else if sync_policy.excludes_path(&normalized) {
            push_excluded(
                &mut excluded_report,
                &mut size_report,
                normalized,
                CapsuleExcludedReason::SyncSetExclude,
                candidate.size,
            );
        } else {
            size_report.included_files += 1;
            size_report.included_bytes = size_report.included_bytes.saturating_add(candidate.size);
            files.push(CapsuleManifestEntry {
                path: normalized,
                size: candidate.size,
                hash: candidate.hash,
            });
        }
    }

    files.sort_by(|a, b| a.path.cmp(&b.path));
    excluded_report.sort_by(|a, b| a.path.cmp(&b.path));
    (CapsuleManifest { files }, excluded_report, size_report)
}

fn push_excluded(
    excluded_report: &mut Vec<CapsuleExcludedEntry>,
    size_report: &mut CapsuleSizeReport,
    path: String,
    reason: CapsuleExcludedReason,
    size: u64,
) {
    if reason == CapsuleExcludedReason::LargeFile {
        size_report.blocked_large_files += 1;
        size_report.blocked_large_bytes = size_report.blocked_large_bytes.saturating_add(size);
    }
    size_report.excluded_files += 1;
    size_report.excluded_bytes = size_report.excluded_bytes.saturating_add(size);
    excluded_report.push(CapsuleExcludedEntry { path, reason, size });
}

fn build_preview(
    return_capsule_id: &str,
    base_entries: &[CapsuleManifestEntry],
    return_entries: &[CapsuleManifestEntry],
    current_source: Vec<CapsuleCandidate>,
    sequence: usize,
) -> CapsuleApplyPreview {
    let base = manifest_map(base_entries);
    let returned = manifest_map(return_entries);
    let current = current_source
        .into_iter()
        .map(|candidate| {
            (
                candidate.path.trim_start_matches("./").to_string(),
                candidate.hash,
            )
        })
        .collect::<BTreeMap<_, _>>();
    let mut paths = BTreeSet::new();
    paths.extend(base.keys().cloned());
    paths.extend(returned.keys().cloned());
    paths.extend(current.keys().cloned());

    let mut added_paths = Vec::new();
    let mut modified_paths = Vec::new();
    let mut deleted_paths = Vec::new();
    let mut conflict_paths = Vec::new();

    for path in paths {
        let base_hash = base.get(&path);
        let return_hash = returned.get(&path);
        let current_hash = current.get(&path);
        match (base_hash, return_hash, current_hash) {
            (None, Some(_), None) => added_paths.push(path),
            (None, Some(return_hash), Some(current_hash)) if return_hash != current_hash => {
                conflict_paths.push(path);
            }
            (Some(base_hash), Some(return_hash), Some(current_hash))
                if current_hash != base_hash
                    && return_hash != base_hash
                    && current_hash != return_hash =>
            {
                conflict_paths.push(path);
            }
            (Some(_), Some(return_hash), Some(current_hash)) if return_hash != current_hash => {
                modified_paths.push(path);
            }
            (Some(base_hash), None, Some(current_hash)) if base_hash != current_hash => {
                conflict_paths.push(path);
            }
            (Some(_), None, Some(_)) => deleted_paths.push(path),
            (Some(base_hash), Some(return_hash), None) if return_hash != base_hash => {
                conflict_paths.push(path);
            }
            _ => {}
        }
    }

    CapsuleApplyPreview {
        preview_id: format!("capsule-preview-{return_capsule_id}-{sequence}"),
        return_capsule_id: return_capsule_id.to_string(),
        added_paths,
        modified_paths,
        deleted_paths,
        conflict_paths,
    }
}

fn manifest_map(entries: &[CapsuleManifestEntry]) -> BTreeMap<String, String> {
    entries
        .iter()
        .map(|entry| (entry.path.clone(), entry.hash.clone()))
        .collect()
}

fn is_git_path(path: &str) -> bool {
    path == ".git" || path.starts_with(".git/")
}
