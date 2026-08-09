use serde::{Deserialize, Serialize};

use crate::shellx_browser::BrowserReceipt;

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserEvaluationAttemptInput {
    #[serde(rename = "attemptId", alias = "attempt_id", default)]
    pub attempt_id: String,
    #[serde(default)]
    pub group: String,
    #[serde(rename = "taskId", alias = "task_id", default)]
    pub task_id: Option<String>,
    #[serde(default)]
    pub status: String,
    #[serde(rename = "durationMs", alias = "duration_ms", default)]
    pub duration_ms: Option<u64>,
    #[serde(default)]
    pub steps: Option<usize>,
    #[serde(rename = "safetyViolations", alias = "safety_violations", default)]
    pub safety_violations: usize,
    #[serde(rename = "stuckCategory", alias = "stuck_category", default)]
    pub stuck_category: Option<String>,
    #[serde(rename = "artifactPath", alias = "artifact_path", default)]
    pub artifact_path: Option<String>,
    #[serde(rename = "artifactBytes", alias = "artifact_bytes", default)]
    pub artifact_bytes: Option<u64>,
    #[serde(rename = "artifactSha256", alias = "artifact_sha256", default)]
    pub artifact_sha256: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserEvaluationReportRequest {
    #[serde(rename = "suiteId", alias = "suite_id", default)]
    pub suite_id: String,
    #[serde(rename = "evaluatedAtMs", alias = "evaluated_at_ms", default)]
    pub evaluated_at_ms: i64,
    #[serde(rename = "taskId", alias = "task_id", default)]
    pub task_id: Option<String>,
    #[serde(rename = "baselineLabel", alias = "baseline_label", default)]
    pub baseline_label: Option<String>,
    #[serde(rename = "candidateLabel", alias = "candidate_label", default)]
    pub candidate_label: Option<String>,
    #[serde(default)]
    pub attempts: Vec<BrowserEvaluationAttemptInput>,
    #[serde(default)]
    pub reason: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserEvaluationReportArtifact {
    #[serde(rename = "reportId")]
    pub report_id: String,
    #[serde(rename = "suiteId")]
    pub suite_id: String,
    #[serde(rename = "taskId", default)]
    pub task_id: Option<String>,
    pub path: String,
    pub bytes: usize,
    pub sha256: String,
    #[serde(rename = "evidenceDigest")]
    pub evidence_digest: String,
    pub attempts: usize,
    #[serde(rename = "baselineAttempts")]
    pub baseline_attempts: usize,
    #[serde(rename = "candidateAttempts")]
    pub candidate_attempts: usize,
    #[serde(rename = "safetyViolationDelta")]
    pub safety_violation_delta: i64,
    #[serde(rename = "improvementScore")]
    pub improvement_score: i32,
    #[serde(rename = "improvementRating")]
    pub improvement_rating: String,
    #[serde(rename = "evidenceComplete")]
    pub evidence_complete: bool,
    pub source: String,
    #[serde(rename = "evaluatedAtMs")]
    pub evaluated_at_ms: i64,
    pub receipt: BrowserReceipt,
}
