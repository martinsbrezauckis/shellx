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
    pub last_receipt_id: Option<String>,
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_status_serializes_camel_case() {
        let s = serde_json::to_string(&BuildRunStatus::AwaitingApproval).unwrap();
        assert_eq!(s, "\"awaitingApproval\"");
    }

    #[test]
    fn receipt_confidence_serializes_camel_case() {
        let s = serde_json::to_string(&BuildReceiptConfidence::TrustedHost).unwrap();
        assert_eq!(s, "\"trustedHost\"");
    }

    #[test]
    fn run_state_round_trips() {
        let state = BuildRunState {
            run_id: "run-1".into(),
            tab_id: "tab-1".into(),
            objective: "ship feature".into(),
            cwd: "/tmp/project".into(),
            transport_kind: "local".into(),
            scratchboard_path: "/tmp/project/build.md".into(),
            status: BuildRunStatus::AwaitingApproval,
            approved_plan_hash: None,
            current_phase_id: None,
            continuations_total: 0,
            no_progress_cycles: 0,
            created_at_ms: 1,
            updated_at_ms: 1,
            approved_at_ms: None,
            last_continuation_at_ms: None,
            checkpoint_id: None,
            code_changed: false,
            review_required: false,
            review_satisfied: false,
            verification_required: false,
            verification_satisfied: false,
            preview_required: false,
            preview_satisfied: false,
            open_blocker: None,
            last_receipt_id: None,
        };

        let json = serde_json::to_string(&state).unwrap();
        let parsed: BuildRunState = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.run_id, "run-1");
        assert_eq!(parsed.status, BuildRunStatus::AwaitingApproval);
    }
}
