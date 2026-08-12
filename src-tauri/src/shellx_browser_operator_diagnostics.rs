use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, State};

use crate::shellx_browser::{
    export_browser_performance, BrowserHarArtifact, BrowserHarExportRequest,
    BrowserPerformanceArtifact, BrowserPerformanceExportRequest, ShellxBrowserRegistry,
};
use crate::shellx_browser_caller::{
    ensure_browser_task_control_authority, BrowserTaskControlAuthority,
};
use crate::shellx_browser_developer_inspection::{
    inspect_browser_developer_page, BrowserDeveloperInspectionRequest,
};
use crate::shellx_browser_tasks::{find_task_index, resolve_task_id};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserOperatorDiagnosticArtifactReceipt {
    pub kind: &'static str,
    pub artifact_id: String,
    pub receipt_id: String,
    pub bytes: usize,
    pub sha256: String,
    pub created_at_ms: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub entries: Option<usize>,
}

fn operator_har_receipt(artifact: BrowserHarArtifact) -> BrowserOperatorDiagnosticArtifactReceipt {
    BrowserOperatorDiagnosticArtifactReceipt {
        kind: "har",
        artifact_id: artifact.har_id,
        receipt_id: artifact.receipt.receipt_id,
        bytes: artifact.bytes,
        sha256: artifact.sha256,
        created_at_ms: artifact.created_at_ms,
        entries: Some(artifact.entries),
    }
}

fn operator_performance_receipt(
    artifact: BrowserPerformanceArtifact,
) -> BrowserOperatorDiagnosticArtifactReceipt {
    BrowserOperatorDiagnosticArtifactReceipt {
        kind: "performance",
        artifact_id: artifact.performance_id,
        receipt_id: artifact.receipt.receipt_id,
        bytes: artifact.bytes,
        sha256: artifact.sha256,
        created_at_ms: artifact.created_at_ms,
        entries: None,
    }
}

fn ensure_operator_developer_inspection_task(
    registry: &Arc<ShellxBrowserRegistry>,
    request: &BrowserDeveloperInspectionRequest,
) -> Result<(), String> {
    let state = crate::shellx_browser::lock_or_recover(&registry.state);
    let task_id = resolve_task_id(&state, request.task_id.clone())?;
    let task_idx = find_task_index(&state, &task_id)?;
    ensure_browser_task_control_authority(
        &state.tasks[task_idx],
        BrowserTaskControlAuthority::Operator,
        None,
    )
}

/// Operator-only UI adapter for the fixed D1 page inspector.
///
/// It deliberately sets operator task authority locally and never accepts or
/// manufactures an MCP caller identity. The underlying inspector owns the
/// fixed Developer Mode-gated capture script.
#[tauri::command]
pub async fn shellx_browser_operator_developer_inspect(
    app: AppHandle,
    registry: State<'_, Arc<ShellxBrowserRegistry>>,
    request: BrowserDeveloperInspectionRequest,
) -> Result<serde_json::Value, String> {
    ensure_operator_developer_inspection_task(&registry, &request)?;
    inspect_browser_developer_page(&app, &registry, request).await
}

/// Operator-only UI adapter for the existing sanitized HAR exporter.
///
/// This command is deliberately not routed through Host MCP or Debug HTTP.
#[tauri::command]
pub fn shellx_browser_operator_export_har(
    registry: State<'_, Arc<ShellxBrowserRegistry>>,
    request: BrowserHarExportRequest,
) -> Result<BrowserOperatorDiagnosticArtifactReceipt, String> {
    registry.export_har(request).map(operator_har_receipt)
}

/// Operator-only UI adapter for the existing sanitized performance exporter.
///
/// The export remains bounded by the native runtime and returns only a compact
/// receipt; renderer callers never receive the artifact path or metrics.
#[tauri::command]
pub async fn shellx_browser_operator_export_performance(
    app: AppHandle,
    registry: State<'_, Arc<ShellxBrowserRegistry>>,
    request: BrowserPerformanceExportRequest,
) -> Result<BrowserOperatorDiagnosticArtifactReceipt, String> {
    export_browser_performance(&app, &registry, request)
        .await
        .map(operator_performance_receipt)
}
