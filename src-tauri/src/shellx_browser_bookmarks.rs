use serde_json::json;
use tauri::Url;

use crate::shellx_browser::{
    lock_or_recover, push_receipt, BrowserBookmark, BrowserBookmarkKind,
    BrowserBookmarkReorderRequest, BrowserBookmarkResponse, BrowserBookmarkToolbarItem,
    BrowserBookmarkUpsertRequest, BrowserClearHistoryRequest, BrowserReceipt, BrowserState,
    ShellxBrowserRegistry,
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
        .unwrap_or_else(|| "saved".to_string());
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

pub(crate) fn bookmark_label_for_url(url: &str) -> String {
    Url::parse(url)
        .ok()
        .and_then(|parsed| parsed.host_str().map(|host| host.to_string()))
        .unwrap_or_else(|| "Saved page".to_string())
}
