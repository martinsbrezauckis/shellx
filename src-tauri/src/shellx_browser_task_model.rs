use serde::{Deserialize, Serialize};

use crate::shellx_browser_model::{BrowserAutonomyMode, BrowserObservation};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserTaskSnapshot {
    #[serde(rename = "taskId")]
    pub task_id: String,
    #[serde(rename = "profileId")]
    pub profile_id: String,
    #[serde(
        rename = "ownerActorId",
        default = "default_browser_task_owner_actor_id"
    )]
    pub owner_actor_id: String,
    #[serde(
        rename = "ownerSurface",
        default = "default_browser_task_owner_surface"
    )]
    pub owner_surface: String,
    #[serde(rename = "ownerSessionId", default)]
    pub owner_session_id: Option<String>,
    pub goal: String,
    pub status: String,
    #[serde(rename = "statusReason", default)]
    pub status_reason: Option<String>,
    pub autonomy: BrowserAutonomyMode,
    #[serde(rename = "currentUrl", default)]
    pub current_url: Option<String>,
    #[serde(rename = "lastObservation", default)]
    pub last_observation: Option<BrowserObservation>,
    #[serde(rename = "expectedDomains")]
    pub expected_domains: Vec<String>,
    #[serde(rename = "blockedDomains")]
    pub blocked_domains: Vec<String>,
    #[serde(rename = "createdAtMs")]
    pub created_at_ms: i64,
    #[serde(rename = "updatedAtMs")]
    pub updated_at_ms: i64,
    #[serde(skip)]
    pub(crate) retention_dropped_console_events: u64,
    #[serde(skip)]
    pub(crate) retention_dropped_network_events: u64,
    #[serde(skip)]
    pub(crate) retention_dropped_receipts: u64,
}

fn default_browser_task_owner_actor_id() -> String {
    "shellxDebugApiAgent".to_string()
}

fn default_browser_task_owner_surface() -> String {
    "debugApiBearer".to_string()
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserTaskSummary {
    #[serde(rename = "taskId")]
    pub task_id: String,
    #[serde(rename = "profileId")]
    pub profile_id: String,
    #[serde(rename = "ownerActorId")]
    pub owner_actor_id: String,
    #[serde(rename = "ownerSurface")]
    pub owner_surface: String,
    #[serde(rename = "ownerSessionId", default)]
    pub owner_session_id: Option<String>,
    pub goal: String,
    pub status: String,
    #[serde(rename = "statusReason", default)]
    pub status_reason: Option<String>,
    #[serde(rename = "currentUrl", default)]
    pub current_url: Option<String>,
    #[serde(rename = "updatedAtMs")]
    pub updated_at_ms: i64,
}
