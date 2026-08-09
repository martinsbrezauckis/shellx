use serde::{Deserialize, Serialize};

use crate::shellx_browser::BrowserReceipt;

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserFlightRecorderExportRequest {
    #[serde(rename = "taskId", alias = "task_id", default)]
    pub task_id: Option<String>,
    #[serde(rename = "browserTabId", alias = "browser_tab_id", default)]
    pub browser_tab_id: Option<String>,
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(rename = "suiteId", alias = "suite_id", default)]
    pub suite_id: Option<String>,
    #[serde(rename = "attemptIndex", alias = "attempt_index", default)]
    pub attempt_index: Option<usize>,
    #[serde(default)]
    pub group: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserFlightRecorderArtifact {
    #[serde(rename = "attemptId")]
    pub attempt_id: String,
    #[serde(rename = "taskId", default)]
    pub task_id: Option<String>,
    #[serde(rename = "browserTabId", default)]
    pub browser_tab_id: Option<String>,
    pub path: String,
    pub bytes: usize,
    pub sha256: String,
    pub events: usize,
    pub receipts: usize,
    #[serde(rename = "droppedEvents")]
    pub dropped_events: usize,
    #[serde(rename = "droppedReceipts")]
    pub dropped_receipts: usize,
    #[serde(rename = "retentionDroppedEvents")]
    pub retention_dropped_events: u64,
    #[serde(rename = "retentionDroppedReceipts")]
    pub retention_dropped_receipts: u64,
    #[serde(rename = "gapCount")]
    pub gap_count: usize,
    #[serde(rename = "sanitizerLossCount")]
    pub sanitizer_loss_count: usize,
    #[serde(rename = "evidenceComplete")]
    pub evidence_complete: bool,
    #[serde(rename = "firstSourceSequence", default)]
    pub first_source_sequence: Option<u64>,
    #[serde(rename = "lastSourceSequence", default)]
    pub last_source_sequence: Option<u64>,
    pub source: String,
    #[serde(rename = "createdAtMs")]
    pub created_at_ms: i64,
    pub receipt: BrowserReceipt,
}
