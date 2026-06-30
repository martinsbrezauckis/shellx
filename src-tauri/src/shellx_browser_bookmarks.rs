use serde_json::json;
use tauri::Url;

use crate::shellx_browser::{
    lock_or_recover, push_receipt, BrowserBookmark, BrowserBookmarkAgentWorkflow,
    BrowserBookmarkKind, BrowserBookmarkReorderRequest, BrowserBookmarkResponse,
    BrowserBookmarkToolbarItem, BrowserBookmarkUpsertRequest, BrowserClearHistoryRequest,
    BrowserReceipt, BrowserState, ShellxBrowserRegistry,
};

impl ShellxBrowserRegistry {
    pub fn upsert_bookmark(
        &self,
        request: BrowserBookmarkUpsertRequest,
    ) -> Result<BrowserBookmarkResponse, String> {
        let mut state = lock_or_recover(&self.state);
        upsert_browser_bookmark_locked(&mut state, request)
    }

    pub fn reorder_bookmarks(
        &self,
        request: BrowserBookmarkReorderRequest,
    ) -> Result<BrowserReceipt, String> {
        let mut state = lock_or_recover(&self.state);
        for item in request.items {
            let bookmark_id = clean_string(&item.bookmark_id);
            if bookmark_id.is_empty() {
                return Err("bookmark reorder item requires bookmarkId".to_string());
            }
            let idx = state
                .bookmarks
                .iter()
                .position(|bookmark| bookmark.bookmark_id == bookmark_id)
                .ok_or_else(|| format!("unknown bookmark {}", bookmark_id))?;
            let parent_id = item
                .parent_id
                .as_deref()
                .map(clean_string)
                .filter(|value| !value.is_empty());
            validate_browser_bookmark_parent(&state.bookmarks, &bookmark_id, parent_id.as_deref())?;
            state.bookmarks[idx].parent_id = parent_id;
            if let Some(toolbar_pinned) = item.toolbar_pinned {
                state.bookmarks[idx].toolbar_pinned = toolbar_pinned;
            }
            if item.toolbar_order.is_some() {
                state.bookmarks[idx].toolbar_order = item.toolbar_order;
            }
            state.bookmarks[idx].updated_at_ms = now_ms();
        }
        let toolbar_items = browser_bookmark_toolbar(&state.bookmarks).len();
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
        let mut delete_ids = vec![bookmark_id.clone()];
        let mut changed = true;
        while changed {
            changed = false;
            for bookmark in &state.bookmarks {
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
        state
            .bookmarks
            .retain(|bookmark| !delete_ids.contains(&bookmark.bookmark_id));
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

    pub fn clear_history(
        &self,
        request: BrowserClearHistoryRequest,
    ) -> Result<BrowserReceipt, String> {
        if crate::shellx_browser_destructive_actions::browser_destructive_action_requires_operator(
            &request,
        ) && !request.operator_approved
        {
            return Err(format!(
                "{}: {}",
                crate::shellx_browser_destructive_actions::BROWSER_DESTRUCTIVE_ACTION_OPERATOR_ERROR_CODE,
                crate::shellx_browser_destructive_actions::BROWSER_DESTRUCTIVE_ACTION_OPERATOR_ERROR_MESSAGE
            ));
        }
        let mut state = lock_or_recover(&self.state);
        let cleared = state.history.len();
        state.history.clear();
        let active_task_id = state.active_task_id.clone();
        let active_profile_id = active_task_id.as_deref().and_then(|task_id| {
            state
                .tasks
                .iter()
                .find(|task| task.task_id == task_id)
                .map(|task| task.profile_id.clone())
        });
        Ok(push_receipt(
            &mut state,
            "browserHistoryCleared",
            active_task_id,
            active_profile_id,
            format!("Cleared {} Browser history entries", cleared),
            json!({ "cleared": cleared }),
        ))
    }
}

pub(crate) fn upsert_browser_bookmark_locked(
    state: &mut BrowserState,
    request: BrowserBookmarkUpsertRequest,
) -> Result<BrowserBookmarkResponse, String> {
    let now = now_ms();
    let bookmark_id = request
        .bookmark_id
        .as_deref()
        .map(clean_string)
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| browser_id("browser-bookmark"));
    let existing_idx = state
        .bookmarks
        .iter()
        .position(|bookmark| bookmark.bookmark_id == bookmark_id);
    let existing = existing_idx.and_then(|idx| state.bookmarks.get(idx).cloned());
    let kind = request
        .kind
        .clone()
        .or_else(|| existing.as_ref().map(|bookmark| bookmark.kind.clone()))
        .unwrap_or_default();
    if kind == BrowserBookmarkKind::Link
        && state
            .bookmarks
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
    validate_browser_bookmark_parent(&state.bookmarks, &bookmark_id, parent_id.as_deref())?;
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
        state.bookmarks[idx] = bookmark.clone();
    } else {
        state.bookmarks.push(bookmark.clone());
    }
    let receipt_kind = if kind == BrowserBookmarkKind::Folder {
        "browserBookmarkFolderSaved"
    } else {
        "browserBookmarkSaved"
    };
    let receipt = push_bookmark_receipt(
        state,
        receipt_kind,
        format!("Saved Browser bookmark: {}", label),
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
    Ok(BrowserBookmarkResponse {
        ok: true,
        bookmark,
        receipt,
    })
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

pub(crate) fn default_bookmarks() -> Vec<BrowserBookmark> {
    let now = now_ms();
    vec![
        BrowserBookmark {
            bookmark_id: "docs".to_string(),
            label: "Documentation".to_string(),
            url: Some("https://example.com/".to_string()),
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
        evidence,
    };
    state.receipts.push(receipt.clone());
    if state.receipts.len() > 1000 {
        let overflow = state.receipts.len() - 1000;
        state.receipts.drain(0..overflow);
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

fn workflow_slug(value: &str, limit: usize) -> Option<String> {
    let mut out = String::new();
    let mut last_dash = false;
    for ch in value.chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch.to_ascii_lowercase());
            last_dash = false;
        } else if !last_dash && !out.is_empty() {
            out.push('-');
            last_dash = true;
        }
        if out.len() >= limit {
            break;
        }
    }
    while out.ends_with('-') {
        out.pop();
    }
    if out.is_empty() {
        None
    } else {
        Some(out)
    }
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
        .filter_map(|label| workflow_slug(label, 63))
        .collect::<Vec<_>>();
    if labels.is_empty() {
        None
    } else {
        Some(labels.join(".").chars().take(128).collect())
    }
}

fn clean_workflow_task_type(value: Option<String>) -> Option<String> {
    let slug = workflow_slug(&clean_bookmark_text(value, 64)?, 64)?;
    let first = slug.split('-').next().unwrap_or(slug.as_str());
    let canonical = match first {
        "read" | "get" | "search" | "create" | "update" | "upload" | "download" | "fill"
        | "submit" | "buy" | "login" | "register" | "verify" | "store" | "delete" | "open"
        | "analyze" => first,
        "fetch" | "retrieve" | "copy" => "get",
        "find" => "search",
        "add" | "new" => "create",
        "edit" | "change" => "update",
        "signin" | "sign-in" | "sign" => "login",
        _ => slug.as_str(),
    };
    Some(canonical.to_string())
}

fn clean_workflow_slug_field(value: Option<String>, limit: usize) -> Option<String> {
    workflow_slug(&clean_bookmark_text(value, limit)?, limit)
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
    let slug = workflow_slug(&cleaned, 64)?;
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
        "strong-improvement" | "improved" | "neutral" | "regressed" => Some(value),
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
    let refresh_reason = clean_bookmark_text(workflow.refresh_reason, 512);
    let refresh_candidate_recipe_path =
        clean_bookmark_text(workflow.refresh_candidate_recipe_path, 4096);
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
}
