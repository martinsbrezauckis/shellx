//! Bounded Tauri projection for the durable Task definition store.

use crate::task_attachments::TaskAttachmentPersistenceReceipt;
use crate::task_model::{
    TaskAttachmentReference, TaskDefinition, TaskDefinitionRecord, TaskDraft,
    TaskRevisionPrecondition,
};
use crate::task_receipts::TaskReceipt;
use crate::task_state_projection::{TaskAttentionItem, TaskStateProjection};
use crate::task_store::{
    TaskAttentionOverflowResolvePrecondition, TaskAttentionResolutionRecord,
    TaskAttentionResolvePrecondition, TaskStoreService,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, State};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TasksCreateRequest {
    pub draft: TaskDraft,
    #[serde(default)]
    pub paused: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TasksReviseRequest {
    pub task_id: String,
    pub precondition: TaskRevisionPrecondition,
    pub draft: TaskDraft,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TasksActionRequest {
    pub task_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TasksReceiptsRequest {
    pub task_id: String,
    pub limit: usize,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TasksAttentionRequest {
    pub task_id: String,
    pub limit: usize,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TasksResolveAttentionRequest {
    pub task_id: String,
    pub attention_id: String,
    pub expected_opened_at_ms: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TasksResolveAttentionOverflowRequest {
    pub task_id: String,
    pub expected_attention_id: String,
    pub expected_omitted_count: u32,
    pub expected_updated_at_ms: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TasksRunNowRequest {
    pub task_id: String,
    pub revision_id: String,
    pub revision_hash: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TasksCancelRunRequest {
    pub occurrence_id: String,
    pub attempt_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TasksPersistAttachmentsRequest {
    pub connection_id: String,
    pub canonical_cwd: String,
    pub sources: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TasksPersistAttachmentsResponse {
    pub target_key: String,
    pub attachments: Vec<TaskAttachmentReference>,
    pub receipts: Vec<TaskAttachmentPersistenceReceipt>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TasksReclaimAttachmentsRequest {
    pub attachment_ids: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TasksReclaimAttachmentsResponse {
    pub selected_attachment_ids: Vec<String>,
    pub reclaimed_attachment_ids: Vec<String>,
    pub pending_attachment_ids: Vec<String>,
}

#[tauri::command]
pub(crate) fn tasks_list(
    task_store: State<'_, Arc<TaskStoreService>>,
) -> Result<Vec<TaskDefinitionRecord>, String> {
    task_store.list()
}

#[tauri::command]
pub(crate) fn tasks_list_states(
    task_store: State<'_, Arc<TaskStoreService>>,
) -> Result<Vec<TaskStateProjection>, String> {
    task_store.list_states(now_ms())
}

#[tauri::command]
pub(crate) fn tasks_get(
    request: TasksActionRequest,
    task_store: State<'_, Arc<TaskStoreService>>,
) -> Result<TaskDefinitionRecord, String> {
    task_store.get(&request.task_id)
}

#[tauri::command]
pub(crate) fn tasks_get_state(
    request: TasksActionRequest,
    task_store: State<'_, Arc<TaskStoreService>>,
) -> Result<TaskStateProjection, String> {
    task_store.get_state(&request.task_id, now_ms())
}

#[tauri::command]
pub(crate) fn tasks_create(
    request: TasksCreateRequest,
    task_store: State<'_, Arc<TaskStoreService>>,
) -> Result<TaskDefinitionRecord, String> {
    task_store.create(request.draft, request.paused, now_ms())
}

/// Copy operator-selected composer files into the exact current Task target,
/// verify their content digests, and only then record path-redacted durable
/// identities in the single process-owned Task store.
#[tauri::command]
pub(crate) async fn tasks_persist_attachments(
    request: TasksPersistAttachmentsRequest,
    task_store: State<'_, Arc<TaskStoreService>>,
) -> Result<TasksPersistAttachmentsResponse, String> {
    let _attachment_io = task_store.attachment_io_guard().await;
    let target =
        crate::task_runtime_authority::resolve_task_attachment_target(&request.connection_id)
            .await
            .map_err(|error| error.to_string())?;
    let registrations = crate::task_attachment_transport::persist_task_attachments(
        &target,
        &request.canonical_cwd,
        &request.sources,
    )
    .await?;
    let records = task_store.register_attachments(registrations, now_ms())?;
    Ok(TasksPersistAttachmentsResponse {
        target_key: target.target_key().to_string(),
        attachments: records.iter().map(TaskAttachmentReference::from).collect(),
        receipts: records
            .iter()
            .map(TaskAttachmentPersistenceReceipt::from)
            .collect(),
    })
}

/// Reclaim only imports that no immutable saved Task revision references.
/// Store reservation happens before target I/O; unreachable or changed copies
/// remain `reclaimPending` and are safe to retry without claiming success.
#[tauri::command]
pub(crate) async fn tasks_reclaim_attachments(
    request: TasksReclaimAttachmentsRequest,
    task_store: State<'_, Arc<TaskStoreService>>,
) -> Result<TasksReclaimAttachmentsResponse, String> {
    let _attachment_io = task_store.attachment_io_guard().await;
    let now = now_ms();
    let records = task_store.prepare_attachment_reclamation(request.attachment_ids, now)?;
    reclaim_attachment_records(task_store.inner(), records).await
}

/// Bounded startup maintenance retries durable pending deletions and reclaims
/// imports that remained unreferenced for at least 24 hours, including imports
/// stranded by a renderer crash before its draft could close.
#[tauri::command]
pub(crate) async fn tasks_maintain_attachments(
    task_store: State<'_, Arc<TaskStoreService>>,
) -> Result<TasksReclaimAttachmentsResponse, String> {
    let _attachment_io = task_store.attachment_io_guard().await;
    const STALE_AFTER_MS: i64 = 24 * 60 * 60 * 1_000;
    let now = now_ms();
    let records =
        task_store.prepare_attachment_maintenance(now.saturating_sub(STALE_AFTER_MS), 16, now)?;
    reclaim_attachment_records(task_store.inner(), records).await
}

async fn reclaim_attachment_records(
    task_store: &TaskStoreService,
    records: Vec<crate::task_attachments::TaskAttachmentRecord>,
) -> Result<TasksReclaimAttachmentsResponse, String> {
    let selected = records
        .iter()
        .map(|record| record.attachment_id.clone())
        .collect::<Vec<_>>();
    let mut reclaimed = Vec::new();
    let mut pending = Vec::new();
    for record in records {
        let result = match crate::task_runtime_authority::resolve_task_attachment_target(
            &record.connection_id,
        )
        .await
        {
            Ok(target) => {
                crate::task_attachment_transport::reclaim_task_attachment_record(&target, &record)
                    .await
            }
            Err(_) => Err("The Task attachment target is unavailable.".to_string()),
        };
        if result.is_ok() {
            reclaimed.push(record.attachment_id);
        } else {
            pending.push(record.attachment_id);
        }
    }
    if !reclaimed.is_empty() {
        task_store.finish_attachment_reclamation(reclaimed.clone(), now_ms())?;
    }
    Ok(TasksReclaimAttachmentsResponse {
        selected_attachment_ids: selected,
        reclaimed_attachment_ids: reclaimed,
        pending_attachment_ids: pending,
    })
}

/// Persist one exact-revision manual occurrence before asking the managed
/// foreground service to advance it. The command returns after durable queue
/// acceptance; provider work remains on the app runtime and every later
/// transition is receipt-backed. A busy poll cannot strand the row because
/// the ordinary due planner re-exposes current-revision pending occurrences,
/// including Manual-only definitions.
#[tauri::command]
pub(crate) fn tasks_run_now(
    request: TasksRunNowRequest,
    task_store: State<'_, Arc<TaskStoreService>>,
    task_runtime: State<'_, Arc<crate::task_runtime_app::TaskRuntimeAppState>>,
    app: AppHandle,
) -> Result<crate::task_runtime_app::TaskManualRunQueueReceipt, String> {
    crate::task_runtime_app::queue_manual_run(
        task_store.inner().as_ref(),
        task_runtime.inner().as_ref(),
        &app,
        &request.task_id,
        &request.revision_id,
        &request.revision_hash,
    )
}

#[tauri::command]
pub(crate) fn tasks_cancel_run(
    request: TasksCancelRunRequest,
    task_runtime: State<'_, Arc<crate::task_runtime_app::TaskRuntimeAppState>>,
) -> Result<(), String> {
    if task_runtime
        .cancellation()
        .request(&request.occurrence_id, &request.attempt_id)
    {
        Ok(())
    } else {
        Err("That Task attempt is no longer active. Reload its run history.".to_string())
    }
}

#[tauri::command]
pub(crate) fn tasks_revise(
    request: TasksReviseRequest,
    task_store: State<'_, Arc<TaskStoreService>>,
) -> Result<TaskDefinitionRecord, String> {
    task_store.revise(
        &request.task_id,
        request.precondition,
        request.draft,
        now_ms(),
    )
}

#[tauri::command]
pub(crate) fn tasks_pause(
    request: TasksActionRequest,
    task_store: State<'_, Arc<TaskStoreService>>,
) -> Result<TaskDefinition, String> {
    task_store.pause(&request.task_id, now_ms())
}

#[tauri::command]
pub(crate) fn tasks_resume(
    request: TasksActionRequest,
    task_store: State<'_, Arc<TaskStoreService>>,
) -> Result<TaskDefinition, String> {
    task_store.resume(&request.task_id, now_ms())
}

#[tauri::command]
pub(crate) fn tasks_delete(
    request: TasksActionRequest,
    task_store: State<'_, Arc<TaskStoreService>>,
) -> Result<(), String> {
    task_store.delete(&request.task_id, now_ms())
}

#[tauri::command]
pub(crate) fn tasks_list_receipts(
    request: TasksReceiptsRequest,
    task_store: State<'_, Arc<TaskStoreService>>,
) -> Result<Vec<TaskReceipt>, String> {
    task_store.list_receipts(&request.task_id, request.limit)
}

#[tauri::command]
pub(crate) fn tasks_list_open_attention(
    request: TasksAttentionRequest,
    task_store: State<'_, Arc<TaskStoreService>>,
) -> Result<Vec<TaskAttentionItem>, String> {
    task_store.list_open_attention(&request.task_id, request.limit)
}

#[tauri::command]
pub(crate) fn tasks_resolve_attention(
    request: TasksResolveAttentionRequest,
    task_store: State<'_, Arc<TaskStoreService>>,
) -> Result<TaskAttentionResolutionRecord, String> {
    task_store.resolve_attention(
        &request.task_id,
        &request.attention_id,
        TaskAttentionResolvePrecondition {
            expected_opened_at_ms: request.expected_opened_at_ms,
        },
        now_ms(),
    )
}

#[tauri::command]
pub(crate) fn tasks_resolve_attention_overflow(
    request: TasksResolveAttentionOverflowRequest,
    task_store: State<'_, Arc<TaskStoreService>>,
) -> Result<TaskAttentionResolutionRecord, String> {
    task_store.resolve_attention_overflow(
        &request.task_id,
        TaskAttentionOverflowResolvePrecondition {
            expected_attention_id: request.expected_attention_id,
            expected_omitted_count: request.expected_omitted_count,
            expected_updated_at_ms: request.expected_updated_at_ms,
        },
        now_ms(),
    )
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(i64::MAX)
}
