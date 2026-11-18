// src-tauri/src/build_types.rs
//
// Shared data contracts for experimental `/build` mode. These types are
// serialized to the debug API, Tauri commands, and the host-local build-run
// store under ~/.shellx/build-runs.

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum BuildRunStatus {
    Draft,
    AwaitingApproval,
    Active,
    Paused,
    Blocked,
    TransportFailed,
    BudgetLimited,
    Complete,
    Halted,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum BuildPersonaRole {
    Manager,
    Explore,
    Implementer,
    Reviewer,
    SecurityAuditor,
    TestWriter,
    Verifier,
    ReleaseManager,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum BuildReceiptKind {
    RunStarted,
    PromptSent,
    OperatorNoteQueued,
    RunHalted,
    PlanWritten,
    PlanApproved,
    PlanRejected,
    CheckpointCreated,
    FileWrite,
    FileDelete,
    FileCopy,
    CommandObserved,
    AgentStarted,
    AgentCompleted,
    ReviewCompleted,
    VerificationCompleted,
    PreviewDiagnosed,
    BlockerOpened,
    BlockerResolved,
    CompletionRequested,
    CompletionAccepted,
    CompletionRejected,
    TransportFailure,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum BuildReceiptConfidence {
    TrustedHost,
    ObservedAcp,
    ModelDeclared,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BuildRunState {
    pub run_id: String,
    pub tab_id: String,
    pub objective: String,
    pub cwd: String,
    pub transport_kind: String,
    pub scratchboard_path: String,
    pub status: BuildRunStatus,
    pub approved_plan_hash: Option<String>,
    pub current_phase_id: Option<String>,
    pub continuations_total: u32,
    pub no_progress_cycles: u32,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
    pub approved_at_ms: Option<u64>,
    pub last_continuation_at_ms: Option<u64>,
    pub checkpoint_id: Option<String>,
    pub code_changed: bool,
    pub review_required: bool,
    pub review_satisfied: bool,
    pub verification_required: bool,
    pub verification_satisfied: bool,
    #[serde(default)]
    pub preview_required: bool,
    #[serde(default)]
    pub preview_satisfied: bool,
    pub open_blocker: Option<String>,
    #[serde(default)]
    pub pending_operator_notes: Vec<BuildOperatorNote>,
    pub last_receipt_id: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BuildOperatorNote {
    pub note_id: String,
    pub created_at_ms: u64,
    pub text: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BuildReceipt {
    pub receipt_id: String,
    pub run_id: String,
    pub tab_id: String,
    pub kind: BuildReceiptKind,
    pub created_at_ms: u64,
    pub actor: String,
    pub summary: String,
    pub confidence: BuildReceiptConfidence,
    pub data: serde_json::Value,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BuildBlockerRecheckResult {
    pub checked: bool,
    pub cleared: bool,
    pub message: String,
    pub matched_receipt_id: Option<String>,
    pub matched_subagent_id: Option<String>,
}

#[cfg(test)]
#[path = "../public/tests/inline/build_types/tests.rs"]
mod tests;
