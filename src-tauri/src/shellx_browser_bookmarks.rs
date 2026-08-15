use serde_json::json;
use tauri::Url;

use crate::shellx_browser::{
    lock_or_recover, next_browser_evidence_sequence, push_receipt, BrowserBookmark,
    BrowserBookmarkAgentWorkflow, BrowserBookmarkKind, BrowserBookmarkReorderRequest,
    BrowserBookmarkResponse, BrowserBookmarkToolbarItem, BrowserBookmarkUpsertRequest,
    BrowserReceipt, BrowserState, ShellxBrowserRegistry,
};
use crate::shellx_browser_workflow_taxonomy::{
    canonical_workflow_task_type, workflow_slug as browser_workflow_slug,
};

impl ShellxBrowserRegistry {
    pub fn upsert_bookmark(
        &self,
        request: BrowserBookmarkUpsertRequest,
    ) -> Result<BrowserBookmarkResponse, String> {
        let mut state = lock_or_recover(&self.state);
        self.upsert_bookmark_with_locked_state(&mut state, request)
    }

    pub(crate) fn upsert_bookmark_with_locked_state(
        &self,
        state: &mut BrowserState,
        request: BrowserBookmarkUpsertRequest,
    ) -> Result<BrowserBookmarkResponse, String> {
        let mut bookmarks = state.bookmarks.clone();
        let bookmark = upsert_browser_bookmark_collection(&mut bookmarks, request)?;
        let bookmarks = self.persist_browser_bookmarks(bookmarks)?;
        let bookmark = bookmarks
            .iter()
            .find(|candidate| candidate.bookmark_id == bookmark.bookmark_id)
            .cloned()
            .ok_or_else(|| "persisted bookmark is missing after save".to_string())?;
        state.bookmarks = bookmarks;
        Ok(bookmark_response_after_commit(state, bookmark))
    }

    pub fn reorder_bookmarks(
        &self,
        request: BrowserBookmarkReorderRequest,
    ) -> Result<BrowserReceipt, String> {
        let mut state = lock_or_recover(&self.state);
        let mut bookmarks = state.bookmarks.clone();
        for item in request.items {
            let bookmark_id = clean_string(&item.bookmark_id);
            if bookmark_id.is_empty() {
                return Err("bookmark reorder item requires bookmarkId".to_string());
            }
            let idx = bookmarks
                .iter()
                .position(|bookmark| bookmark.bookmark_id == bookmark_id)
                .ok_or_else(|| format!("unknown bookmark {}", bookmark_id))?;
            let parent_id = item
                .parent_id
                .as_deref()
                .map(clean_string)
                .filter(|value| !value.is_empty());
            validate_browser_bookmark_parent(&bookmarks, &bookmark_id, parent_id.as_deref())?;
            bookmarks[idx].parent_id = parent_id;
            if let Some(toolbar_pinned) = item.toolbar_pinned {
                bookmarks[idx].toolbar_pinned = toolbar_pinned;
            }
            if item.toolbar_order.is_some() {
                bookmarks[idx].toolbar_order = item.toolbar_order;
            }
            bookmarks[idx].updated_at_ms = now_ms();
        }
        let bookmarks = self.persist_browser_bookmarks(bookmarks)?;
        let toolbar_items = browser_bookmark_toolbar(&bookmarks).len();
        state.bookmarks = bookmarks;
        let receipt = push_receipt(
            &mut state,
            "browserBookmarkToolbarChanged",
            None,
            None,
            "Browser bookmark toolbar changed".to_string(),
            json!({
                "toolbarItems": toolbar_items,
            }),
        );
        Ok(receipt)
    }

    pub fn delete_bookmark(&self, bookmark_id: &str) -> Result<BrowserReceipt, String> {
        let mut state = lock_or_recover(&self.state);
        let bookmark_id = clean_string(bookmark_id);
        if bookmark_id.is_empty() {
            return Err("delete bookmark requires bookmarkId".to_string());
        }
        if !state
            .bookmarks
            .iter()
            .any(|bookmark| bookmark.bookmark_id == bookmark_id)
        {
            return Err(format!("unknown bookmark {}", bookmark_id));
        }
        let mut bookmarks = state.bookmarks.clone();
        let mut delete_ids = vec![bookmark_id.clone()];
        let mut changed = true;
        while changed {
            changed = false;
            for bookmark in &bookmarks {
                if bookmark
                    .parent_id
                    .as_ref()
                    .map(|parent_id| delete_ids.contains(parent_id))
                    .unwrap_or(false)
                    && !delete_ids.contains(&bookmark.bookmark_id)
                {
                    delete_ids.push(bookmark.bookmark_id.clone());
                    changed = true;
                }
            }
        }
        bookmarks.retain(|bookmark| !delete_ids.contains(&bookmark.bookmark_id));
        let bookmarks = self.persist_browser_bookmarks(bookmarks)?;
        state.bookmarks = bookmarks;
        let receipt = push_receipt(
            &mut state,
            "browserBookmarkDeleted",
            None,
            None,
            format!("Deleted {} Browser bookmark item(s)", delete_ids.len()),
            json!({
                "bookmarkId": bookmark_id,
                "deleted": delete_ids.len(),
            }),
        );
        Ok(receipt)
    }
}

#[cfg(test)]
pub(crate) fn upsert_browser_bookmark_locked(
    state: &mut BrowserState,
    request: BrowserBookmarkUpsertRequest,
) -> Result<BrowserBookmarkResponse, String> {
    let bookmark = upsert_browser_bookmark_collection(&mut state.bookmarks, request)?;
    Ok(bookmark_response_after_commit(state, bookmark))
}

fn upsert_browser_bookmark_collection(
    bookmarks: &mut Vec<BrowserBookmark>,
    request: BrowserBookmarkUpsertRequest,
) -> Result<BrowserBookmark, String> {
    let now = now_ms();
    let bookmark_id = request
        .bookmark_id
        .as_deref()
        .map(clean_string)
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| browser_id("browser-bookmark"));
    let existing_idx = bookmarks
        .iter()
        .position(|bookmark| bookmark.bookmark_id == bookmark_id);
    let existing = existing_idx.and_then(|idx| bookmarks.get(idx).cloned());
    let kind = request
        .kind
        .clone()
        .or_else(|| existing.as_ref().map(|bookmark| bookmark.kind.clone()))
        .unwrap_or_default();
    if kind == BrowserBookmarkKind::Link
        && bookmarks
            .iter()
            .any(|bookmark| bookmark.parent_id.as_deref() == Some(bookmark_id.as_str()))
    {
        return Err("invalidBookmarkTree: folder with children cannot become a link".to_string());
    }
    let raw_url = request
        .url
        .as_deref()
        .map(clean_string)
        .filter(|value| !value.is_empty())
        .or_else(|| existing.as_ref().and_then(|bookmark| bookmark.url.clone()));
    let url = match kind {
        BrowserBookmarkKind::Link => Some(
            raw_url
                .filter(|value| !value.is_empty())
                .ok_or_else(|| "link bookmark requires url".to_string())?,
        ),
        BrowserBookmarkKind::Folder => {
            if raw_url.is_some() {
                return Err("folder bookmark cannot have url".to_string());
            }
            None
        }
    };
    let label = request
        .label
        .as_str()
        .trim()
        .to_string()
        .chars()
        .take(80)
        .collect::<String>();
    let label = if !label.is_empty() {
        label
    } else if let Some(existing) = existing.as_ref() {
        existing.label.clone()
    } else if let Some(url) = url.as_deref() {
        bookmark_label_for_url(url)
    } else {
        "Folder".to_string()
    };
    let category = request
        .category
        .as_deref()
        .map(clean_string)
        .filter(|value| !value.is_empty())
        .or_else(|| existing.as_ref().map(|bookmark| bookmark.category.clone()))
        .unwrap_or_else(|| {
            if request.agent_workflow.is_some()
                || existing
                    .as_ref()
                    .and_then(|bookmark| bookmark.agent_workflow.as_ref())
                    .is_some()
            {
                "workflow".to_string()
            } else {
                "saved".to_string()
            }
        });
    let parent_id = request
        .parent_id
        .as_deref()
        .map(clean_string)
        .filter(|value| !value.is_empty())
        .or_else(|| {
            existing
                .as_ref()
                .and_then(|bookmark| bookmark.parent_id.clone())
        });
    validate_browser_bookmark_parent(bookmarks, &bookmark_id, parent_id.as_deref())?;
    let agent_workflow = request
        .agent_workflow
        .clone()
        .and_then(normalize_agent_workflow)
        .or_else(|| {
            existing
                .as_ref()
                .and_then(|bookmark| bookmark.agent_workflow.clone())
        });
    let bookmark = BrowserBookmark {
        bookmark_id: bookmark_id.clone(),
        label: label.clone(),
        url,
        category,
        kind: kind.clone(),
        parent_id,
        toolbar_pinned: request.toolbar_pinned.unwrap_or_else(|| {
            existing
                .as_ref()
                .map(|bookmark| bookmark.toolbar_pinned)
                .unwrap_or(false)
        }),
        toolbar_order: request.toolbar_order.or_else(|| {
            existing
                .as_ref()
                .and_then(|bookmark| bookmark.toolbar_order)
        }),
        agent_workflow,
        created_at_ms: existing
            .as_ref()
            .map(|bookmark| bookmark.created_at_ms)
            .unwrap_or(now),
        updated_at_ms: now,
    };
    if let Some(idx) = existing_idx {
        bookmarks[idx] = bookmark.clone();
    } else {
        bookmarks.push(bookmark.clone());
    }
    Ok(bookmark)
}

fn bookmark_response_after_commit(
    state: &mut BrowserState,
    bookmark: BrowserBookmark,
) -> BrowserBookmarkResponse {
    let receipt_kind = if bookmark.kind == BrowserBookmarkKind::Folder {
        "browserBookmarkFolderSaved"
    } else {
        "browserBookmarkSaved"
    };
    let receipt = push_bookmark_receipt(
        state,
        receipt_kind,
        format!("Saved Browser bookmark: {}", bookmark.label),
        json!({
            "bookmarkId": bookmark.bookmark_id,
            "label": bookmark.label,
            "kind": bookmark.kind,
            "toolbarPinned": bookmark.toolbar_pinned,
            "agentWorkflow": bookmark.agent_workflow,
        }),
    );
    if bookmark.toolbar_pinned {
        push_bookmark_receipt(
            state,
            "browserBookmarkToolbarChanged",
            "Browser bookmark toolbar changed".to_string(),
            json!({
                "toolbarItems": browser_bookmark_toolbar(&state.bookmarks).len(),
            }),
        );
    }
    BrowserBookmarkResponse {
        ok: true,
        bookmark,
        receipt,
    }
}

pub(crate) fn validate_browser_bookmark_parent(
    bookmarks: &[BrowserBookmark],
    bookmark_id: &str,
    parent_id: Option<&str>,
) -> Result<(), String> {
    let Some(parent_id) = parent_id else {
        return Ok(());
    };
    if parent_id == bookmark_id {
        return Err("invalidBookmarkTree: bookmark cannot parent itself".to_string());
    }
    let parent = bookmarks
        .iter()
        .find(|bookmark| bookmark.bookmark_id == parent_id)
        .ok_or_else(|| format!("unknown bookmark parent {}", parent_id))?;
    if parent.kind != BrowserBookmarkKind::Folder {
        return Err("invalidBookmarkTree: parent must be a folder".to_string());
    }
    let mut cursor = parent.parent_id.as_deref();
    while let Some(candidate) = cursor {
        if candidate == bookmark_id {
            return Err("invalidBookmarkTree: folder cycle rejected".to_string());
        }
        cursor = bookmarks
            .iter()
            .find(|bookmark| bookmark.bookmark_id == candidate)
            .and_then(|bookmark| bookmark.parent_id.as_deref());
    }
    Ok(())
}

pub(crate) fn browser_bookmark_toolbar(
    bookmarks: &[BrowserBookmark],
) -> Vec<BrowserBookmarkToolbarItem> {
    let mut pinned = bookmarks
        .iter()
        .filter(|bookmark| bookmark.toolbar_pinned && bookmark.parent_id.is_none())
        .cloned()
        .collect::<Vec<_>>();
    pinned.sort_by(|a, b| {
        a.toolbar_order
            .unwrap_or(u32::MAX)
            .cmp(&b.toolbar_order.unwrap_or(u32::MAX))
            .then_with(|| {
                a.label
                    .to_ascii_lowercase()
                    .cmp(&b.label.to_ascii_lowercase())
            })
            .then_with(|| a.bookmark_id.cmp(&b.bookmark_id))
    });
    pinned
        .into_iter()
        .map(|bookmark| {
            let mut children = if bookmark.kind == BrowserBookmarkKind::Folder {
                bookmarks
                    .iter()
                    .filter(|child| {
                        child.parent_id.as_deref() == Some(bookmark.bookmark_id.as_str())
                    })
                    .cloned()
                    .collect::<Vec<_>>()
            } else {
                Vec::new()
            };
            children.sort_by(|a, b| {
                a.toolbar_order
                    .unwrap_or(u32::MAX)
                    .cmp(&b.toolbar_order.unwrap_or(u32::MAX))
                    .then_with(|| {
                        a.label
                            .to_ascii_lowercase()
                            .cmp(&b.label.to_ascii_lowercase())
                    })
                    .then_with(|| a.bookmark_id.cmp(&b.bookmark_id))
            });
            BrowserBookmarkToolbarItem {
                bookmark_id: bookmark.bookmark_id,
                label: bookmark.label,
                kind: bookmark.kind,
                url: bookmark.url,
                agent_workflow: bookmark.agent_workflow,
                children,
            }
        })
        .collect()
}

pub(crate) fn normalize_browser_bookmarks_for_persistence(
    mut bookmarks: Vec<BrowserBookmark>,
) -> Result<Vec<BrowserBookmark>, String> {
    const BROWSER_BOOKMARK_LIMIT: usize = 100;
    if bookmarks.len() > BROWSER_BOOKMARK_LIMIT {
        return Err(format!(
            "bookmark store exceeds the {BROWSER_BOOKMARK_LIMIT} item limit"
        ));
    }

    let mut bookmark_ids = std::collections::BTreeSet::new();
    for bookmark in &mut bookmarks {
        bookmark.bookmark_id = clean_bookmark_text(Some(bookmark.bookmark_id.clone()), 128)
            .ok_or_else(|| "bookmark store item requires bookmarkId".to_string())?;
        if !bookmark_ids.insert(bookmark.bookmark_id.clone()) {
            return Err(format!(
                "bookmark store contains duplicate bookmarkId {}",
                bookmark.bookmark_id
            ));
        }
        bookmark.label = clean_bookmark_text(Some(bookmark.label.clone()), 80)
            .ok_or_else(|| format!("bookmark {} requires a label", bookmark.bookmark_id))?;
        bookmark.category = clean_bookmark_text(Some(bookmark.category.clone()), 80)
            .ok_or_else(|| format!("bookmark {} requires a category", bookmark.bookmark_id))?;
        bookmark.parent_id = bookmark
            .parent_id
            .take()
            .and_then(|value| clean_bookmark_text(Some(value), 128));
        match &bookmark.kind {
            BrowserBookmarkKind::Link => {
                bookmark.url = clean_bookmark_text(bookmark.url.take(), 4096)
                    .ok_or_else(|| format!("link bookmark {} requires url", bookmark.bookmark_id))
                    .map(Some)?;
            }
            BrowserBookmarkKind::Folder => {
                if bookmark.url.is_some() {
                    return Err(format!(
                        "folder bookmark {} cannot have url",
                        bookmark.bookmark_id
                    ));
                }
            }
        }
        bookmark.agent_workflow = bookmark
            .agent_workflow
            .take()
            .and_then(normalize_agent_workflow);
    }

    let bookmark_by_id = bookmarks
        .iter()
        .enumerate()
        .map(|(index, bookmark)| (bookmark.bookmark_id.as_str(), index))
        .collect::<std::collections::BTreeMap<_, _>>();
    for bookmark in &bookmarks {
        let mut ancestors = std::collections::BTreeSet::new();
        let mut parent_id = bookmark.parent_id.as_deref();
        while let Some(current_parent_id) = parent_id {
            if !ancestors.insert(current_parent_id) {
                return Err(format!(
                    "invalidBookmarkTree: bookmark {} is part of a folder cycle",
                    bookmark.bookmark_id
                ));
            }
            let parent_index = bookmark_by_id.get(current_parent_id).ok_or_else(|| {
                format!(
                    "unknown bookmark parent {} for {}",
                    current_parent_id, bookmark.bookmark_id
                )
            })?;
            let parent = &bookmarks[*parent_index];
            if parent.kind != BrowserBookmarkKind::Folder {
                return Err(format!(
                    "invalidBookmarkTree: parent {} must be a folder",
                    current_parent_id
                ));
            }
            parent_id = parent.parent_id.as_deref();
        }
    }
    Ok(bookmarks)
}

pub(crate) fn save_current_browser_bookmark(
    bookmarks: &mut Vec<BrowserBookmark>,
    url: &str,
    label: &str,
) {
    let now = now_ms();
    if let Some(existing) = bookmarks
        .iter_mut()
        .find(|item| item.url.as_deref() == Some(url))
    {
        existing.label = label.to_string();
        existing.category = "saved".to_string();
        existing.kind = BrowserBookmarkKind::Link;
        existing.updated_at_ms = now;
    } else {
        bookmarks.insert(
            0,
            BrowserBookmark {
                bookmark_id: browser_id("browser-bookmark"),
                label: label.to_string(),
                url: Some(url.to_string()),
                category: "saved".to_string(),
                kind: BrowserBookmarkKind::Link,
                parent_id: None,
                toolbar_pinned: false,
                toolbar_order: None,
                agent_workflow: None,
                created_at_ms: now,
                updated_at_ms: now,
            },
        );
    }
    bookmarks.truncate(100);
}

pub(crate) fn default_bookmarks() -> Vec<BrowserBookmark> {
    let now = now_ms();
    vec![
        BrowserBookmark {
            bookmark_id: "docs".to_string(),
            label: "Documentation".to_string(),
            url: Some("https://docs.theshellx.com/manual/shellx/".to_string()),
            category: "workflow".to_string(),
            kind: BrowserBookmarkKind::Link,
            parent_id: None,
            toolbar_pinned: false,
            toolbar_order: None,
            agent_workflow: None,
            created_at_ms: now,
            updated_at_ms: now,
        },
        BrowserBookmark {
            bookmark_id: "vault".to_string(),
            label: "Vault handoff".to_string(),
            url: Some("shellx://vault".to_string()),
            category: "shellx".to_string(),
            kind: BrowserBookmarkKind::Link,
            parent_id: None,
            toolbar_pinned: false,
            toolbar_order: None,
            agent_workflow: None,
            created_at_ms: now,
            updated_at_ms: now,
        },
    ]
}

fn push_bookmark_receipt(
    state: &mut BrowserState,
    kind: &str,
    summary: String,
    evidence: serde_json::Value,
) -> BrowserReceipt {
    let receipt = BrowserReceipt {
        receipt_id: browser_id("browser-receipt"),
        kind: kind.to_string(),
        task_id: None,
        profile_id: None,
        summary,
        t: now_ms(),
        sequence: next_browser_evidence_sequence(state),
        evidence,
    };
    state.receipts.push(receipt.clone());
    if state.receipts.len() > 1000 {
        let overflow = state.receipts.len() - 1000;
        let dropped_task_ids = state
            .receipts
            .drain(0..overflow)
            .filter_map(|receipt| receipt.task_id)
            .collect::<Vec<_>>();
        state.receipt_retention_dropped = state
            .receipt_retention_dropped
            .saturating_add(overflow as u64);
        for task_id in dropped_task_ids {
            if let Some(task) = state.tasks.iter_mut().find(|task| task.task_id == task_id) {
                task.retention_dropped_receipts = task.retention_dropped_receipts.saturating_add(1);
            }
        }
    }
    receipt
}

fn browser_id(prefix: &str) -> String {
    format!(
        "{}-{}",
        prefix,
        hex::encode(vault_core::random_bytes::<6>())
    )
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn clean_string(value: impl AsRef<str>) -> String {
    value.as_ref().trim().chars().take(4096).collect()
}

fn clean_bookmark_text(value: Option<String>, limit: usize) -> Option<String> {
    value
        .map(|value| value.split_whitespace().collect::<Vec<_>>().join(" "))
        .map(|value| value.chars().take(limit).collect::<String>())
        .filter(|value| !value.is_empty())
}

fn clean_workflow_site_key(value: Option<String>) -> Option<String> {
    let raw = clean_bookmark_text(value, 256)?;
    let candidate = if raw.contains("://") {
        raw.clone()
    } else {
        format!("https://{}", raw)
    };
    let host = Url::parse(&candidate)
        .ok()
        .and_then(|parsed| parsed.host_str().map(|host| host.to_ascii_lowercase()))
        .or_else(|| {
            raw.split('/')
                .next()
                .map(|host| host.trim().to_ascii_lowercase())
        })?;
    let host = host
        .trim_end_matches('.')
        .strip_prefix("www.")
        .unwrap_or(&host)
        .to_string();
    let labels = host
        .split('.')
        .filter_map(|label| browser_workflow_slug(label, 63))
        .collect::<Vec<_>>();
    if labels.is_empty() {
        None
    } else {
        Some(labels.join(".").chars().take(128).collect())
    }
}

fn clean_workflow_task_type(value: Option<String>) -> Option<String> {
    canonical_workflow_task_type(value)
}

fn clean_workflow_slug_field(value: Option<String>, limit: usize) -> Option<String> {
    browser_workflow_slug(&clean_bookmark_text(value, limit)?, limit)
}

fn clean_workflow_aliases(values: Vec<String>) -> Vec<String> {
    values
        .into_iter()
        .filter_map(|value| clean_bookmark_text(Some(value), 80))
        .take(16)
        .collect()
}

fn clean_workflow_permissions(values: Vec<String>) -> Vec<String> {
    values
        .into_iter()
        .filter_map(|value| clean_bookmark_text(Some(value), 80))
        .map(|value| value.replace(' ', "").to_ascii_lowercase())
        .filter(|value| !value.is_empty())
        .take(24)
        .collect()
}

fn clean_workflow_secret_kind(value: String) -> Option<String> {
    let cleaned = clean_bookmark_text(Some(value), 64)?;
    let slug = browser_workflow_slug(&cleaned, 64)?;
    let canonical = match slug.as_str() {
        "apitoken" | "api-token" | "api-key" | "apikey" | "token" => "apiToken",
        "password" | "passphrase" => "password",
        "email-code" | "emailcode" | "otp" | "one-time-code" | "verification-code" => "emailCode",
        "recovery-code" | "recoverykey" | "recovery-key" => "recoveryCode",
        "wallet-budget" | "agent-wallet" | "agent-wallet-budget" => "agentWalletBudget",
        "credential" | "credentials" => "credential",
        _ => cleaned.as_str(),
    };
    Some(canonical.to_string())
}

fn clean_workflow_secret_kinds(values: Vec<String>) -> Vec<String> {
    values
        .into_iter()
        .filter_map(clean_workflow_secret_kind)
        .take(16)
        .collect()
}

fn clean_workflow_contract_hash(value: Option<String>) -> Option<String> {
    clean_bookmark_text(value, 128).map(|value| value.to_ascii_lowercase())
}

fn clean_workflow_contract_audit_status(value: Option<String>) -> Option<String> {
    let value = clean_bookmark_text(value, 32)?;
    match value.as_str() {
        "fresh" | "needs-review" | "contract-drift" | "blocked-by-contract" | "overlay-used" => {
            Some(value)
        }
        _ => None,
    }
}

fn clean_workflow_health(value: Option<String>) -> Option<String> {
    let value = clean_bookmark_text(value, 32)?;
    match value.as_str() {
        "fresh" | "improved" | "degraded" | "needs-review" | "broken" => Some(value),
        _ => None,
    }
}

fn clean_workflow_rating(value: Option<String>) -> Option<String> {
    let value = clean_bookmark_text(value, 32)?;
    match value.as_str() {
        "strong-improvement"
        | "improved"
        | "neutral"
        | "regressed"
        | "insufficient-evidence"
        | "safety-regression"
        | "unsafe-candidate"
        | "incomplete-evaluation" => Some(value),
        _ => None,
    }
}

fn clean_workflow_replay_status(value: Option<String>) -> Option<String> {
    let value = clean_bookmark_text(value, 32)?;
    match value.as_str() {
        "dry-run" | "applied" | "skipped" | "failed" => Some(value),
        _ => None,
    }
}

fn clean_workflow_drift_status(value: Option<String>) -> Option<String> {
    let value = clean_bookmark_text(value, 32)?;
    match value.as_str() {
        "fresh" | "unknown" | "needs-review" | "drifted" | "broken" => Some(value),
        _ => None,
    }
}

fn normalize_agent_workflow(
    workflow: BrowserBookmarkAgentWorkflow,
) -> Option<BrowserBookmarkAgentWorkflow> {
    let site_key = clean_workflow_site_key(workflow.site_key);
    let task_type = clean_workflow_task_type(workflow.task_type);
    let target = clean_workflow_slug_field(workflow.target, 64);
    let surface = clean_workflow_slug_field(workflow.surface, 64);
    let aliases = clean_workflow_aliases(workflow.aliases);
    let contract_profile = clean_workflow_slug_field(workflow.contract_profile, 80);
    let contract_id = clean_workflow_slug_field(workflow.contract_id, 120);
    let contract_version = workflow.contract_version.filter(|value| *value > 0);
    let contract_hash = clean_workflow_contract_hash(workflow.contract_hash);
    let contract_overlay_id = clean_workflow_slug_field(workflow.contract_overlay_id, 120);
    let contract_audit_status =
        clean_workflow_contract_audit_status(workflow.contract_audit_status);
    let contract_audit_reason = clean_bookmark_text(workflow.contract_audit_reason, 512);
    let last_contract_audit_at_ms = workflow
        .last_contract_audit_at_ms
        .filter(|value| *value > 0);
    let permissions_needed = clean_workflow_permissions(workflow.permissions_needed);
    let secret_kinds = clean_workflow_secret_kinds(workflow.secret_kinds);
    let recipe_id = clean_bookmark_text(workflow.recipe_id, 128);
    let recipe_path = clean_bookmark_text(workflow.recipe_path, 4096);
    let goal = clean_bookmark_text(workflow.goal, 512);
    let source = clean_bookmark_text(workflow.source, 64);
    let steps = workflow.steps.filter(|steps| *steps > 0);
    let created_at_ms = workflow.created_at_ms.filter(|value| *value > 0);
    let health = clean_workflow_health(workflow.health);
    let last_run_at_ms = workflow.last_run_at_ms.filter(|value| *value > 0);
    let last_evaluation_report_path =
        clean_bookmark_text(workflow.last_evaluation_report_path, 4096);
    let last_improvement_score = workflow
        .last_improvement_score
        .map(|score| score.clamp(-100, 100));
    let last_improvement_rating = clean_workflow_rating(workflow.last_improvement_rating);
    let last_attempt_id = clean_bookmark_text(workflow.last_attempt_id, 128);
    let last_attempt_path = clean_bookmark_text(workflow.last_attempt_path, 4096);
    let last_replay_status = clean_workflow_replay_status(workflow.last_replay_status);
    let last_replay_at_ms = workflow.last_replay_at_ms.filter(|value| *value > 0);
    let drift_status = clean_workflow_drift_status(workflow.drift_status);
    let mut refresh_reason = clean_bookmark_text(workflow.refresh_reason, 512);
    let mut refresh_candidate_recipe_path =
        clean_bookmark_text(workflow.refresh_candidate_recipe_path, 4096);
    let needs_refresh = matches!(
        health.as_deref(),
        Some("degraded" | "needs-review" | "broken")
    ) || matches!(
        drift_status.as_deref(),
        Some("needs-review" | "drifted" | "broken")
    );
    if !needs_refresh {
        refresh_reason = None;
        refresh_candidate_recipe_path = None;
    } else if refresh_reason.is_none() {
        refresh_candidate_recipe_path = None;
    }
    if site_key.is_none()
        && task_type.is_none()
        && target.is_none()
        && surface.is_none()
        && aliases.is_empty()
        && contract_profile.is_none()
        && contract_id.is_none()
        && contract_version.is_none()
        && contract_hash.is_none()
        && contract_overlay_id.is_none()
        && contract_audit_status.is_none()
        && contract_audit_reason.is_none()
        && last_contract_audit_at_ms.is_none()
        && permissions_needed.is_empty()
        && secret_kinds.is_empty()
        && recipe_id.is_none()
        && recipe_path.is_none()
        && goal.is_none()
        && source.is_none()
        && steps.is_none()
        && created_at_ms.is_none()
        && health.is_none()
        && last_run_at_ms.is_none()
        && last_evaluation_report_path.is_none()
        && last_improvement_score.is_none()
        && last_improvement_rating.is_none()
        && last_attempt_id.is_none()
        && last_attempt_path.is_none()
        && last_replay_status.is_none()
        && last_replay_at_ms.is_none()
        && drift_status.is_none()
        && refresh_reason.is_none()
        && refresh_candidate_recipe_path.is_none()
    {
        return None;
    }
    Some(BrowserBookmarkAgentWorkflow {
        site_key,
        task_type,
        target,
        surface,
        aliases,
        contract_profile,
        contract_id,
        contract_version,
        contract_hash,
        contract_overlay_id,
        contract_audit_status,
        contract_audit_reason,
        last_contract_audit_at_ms,
        permissions_needed,
        secret_kinds,
        recipe_id,
        recipe_path,
        goal,
        steps,
        source,
        created_at_ms,
        health,
        last_run_at_ms,
        last_evaluation_report_path,
        last_improvement_score,
        last_improvement_rating,
        last_attempt_id,
        last_attempt_path,
        last_replay_status,
        last_replay_at_ms,
        drift_status,
        refresh_reason,
        refresh_candidate_recipe_path,
    })
}

pub(crate) fn bookmark_label_for_url(url: &str) -> String {
    Url::parse(url)
        .ok()
        .and_then(|parsed| parsed.host_str().map(|host| host.to_string()))
        .unwrap_or_else(|| "Saved page".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shellx_browser::BrowserBookmarkAgentWorkflow;

    #[test]
    fn workflow_bookmarks_preserve_normalized_agent_metadata() {
        let mut state = BrowserState::default();

        let response = upsert_browser_bookmark_locked(
            &mut state,
            BrowserBookmarkUpsertRequest {
                bookmark_id: Some("wf-google-ai-key".to_string()),
                label: "Get Google AI Studio key".to_string(),
                url: Some("https://aistudio.google.com/app/apikey".to_string()),
                toolbar_pinned: Some(true),
                agent_workflow: Some(BrowserBookmarkAgentWorkflow {
                    site_key: Some(" HTTPS://WWW.Google.COM/aistudio ".to_string()),
                    task_type: Some("Get API Key".to_string()),
                    target: Some(" API Key ".to_string()),
                    surface: Some(" AI Studio ".to_string()),
                    aliases: vec![" Gemini developer key ".to_string()],
                    permissions_needed: vec![" cookies.accept ".to_string()],
                    secret_kinds: vec![" api-token ".to_string()],
                    recipe_id: Some("browser-recipe-123".to_string()),
                    recipe_path: Some("/tmp/shellx-browser-recipes/recipe.json".to_string()),
                    goal: Some("Get an API key and store it in Vault".to_string()),
                    steps: Some(4),
                    source: Some("shellx-browser-recorder".to_string()),
                    health: Some("fresh".to_string()),
                    drift_status: Some("fresh".to_string()),
                    ..BrowserBookmarkAgentWorkflow::default()
                }),
                ..BrowserBookmarkUpsertRequest::default()
            },
        )
        .expect("workflow bookmark is saved");

        assert_eq!(response.bookmark.category, "workflow");
        let workflow = response
            .bookmark
            .agent_workflow
            .expect("workflow metadata is preserved");
        assert_eq!(workflow.site_key.as_deref(), Some("google.com"));
        assert_eq!(workflow.task_type.as_deref(), Some("get"));
        assert_eq!(workflow.target.as_deref(), Some("api-key"));
        assert_eq!(workflow.surface.as_deref(), Some("ai-studio"));
        assert_eq!(workflow.secret_kinds, vec!["apiToken".to_string()]);

        let toolbar = browser_bookmark_toolbar(&state.bookmarks);
        let toolbar_workflow = toolbar
            .iter()
            .find(|item| item.bookmark_id == "wf-google-ai-key")
            .and_then(|item| item.agent_workflow.as_ref())
            .expect("toolbar exposes workflow metadata for agent discovery");
        assert_eq!(
            toolbar_workflow.recipe_id.as_deref(),
            Some("browser-recipe-123")
        );
    }

    #[test]
    fn workflow_task_type_preserves_signup_intent() {
        assert_eq!(
            clean_workflow_task_type(Some("sign-up".to_string())).as_deref(),
            Some("register")
        );
        assert_eq!(
            clean_workflow_task_type(Some("signup".to_string())).as_deref(),
            Some("register")
        );
        assert_eq!(
            clean_workflow_task_type(Some("sign-in".to_string())).as_deref(),
            Some("login")
        );
    }

    #[test]
    fn workflow_evaluation_metadata_preserves_fail_closed_ratings_and_current_refreshes() {
        let degraded = normalize_agent_workflow(BrowserBookmarkAgentWorkflow {
            health: Some("degraded".to_string()),
            drift_status: Some("needs-review".to_string()),
            last_improvement_score: Some(-25),
            last_improvement_rating: Some("safety-regression".to_string()),
            last_attempt_id: Some("attempt-17".to_string()),
            last_attempt_path: Some("/tmp/attempt-17.json".to_string()),
            last_evaluation_report_path: Some("/tmp/evaluation-17.json".to_string()),
            refresh_reason: Some("The page contract changed".to_string()),
            refresh_candidate_recipe_path: Some("/tmp/recipe-refresh.json".to_string()),
            ..BrowserBookmarkAgentWorkflow::default()
        })
        .expect("degraded workflow remains available");

        assert_eq!(
            degraded.last_improvement_rating.as_deref(),
            Some("safety-regression")
        );
        assert_eq!(degraded.last_improvement_score, Some(-25));
        assert_eq!(
            degraded.refresh_candidate_recipe_path.as_deref(),
            Some("/tmp/recipe-refresh.json")
        );

        let fresh = normalize_agent_workflow(BrowserBookmarkAgentWorkflow {
            health: Some("fresh".to_string()),
            drift_status: Some("fresh".to_string()),
            refresh_reason: degraded.refresh_reason,
            refresh_candidate_recipe_path: degraded.refresh_candidate_recipe_path,
            ..BrowserBookmarkAgentWorkflow::default()
        })
        .expect("fresh workflow remains available");

        assert_eq!(fresh.refresh_reason, None);
        assert_eq!(fresh.refresh_candidate_recipe_path, None);
    }
}
