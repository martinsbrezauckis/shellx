//! Structured Grok ACP and provider-session lifecycle classifiers.
//!
//! These classifiers recognize protocol event fields only. They do not inspect
//! diagnostic or message text to authorize fallback; only the preflight and
//! structured dispatch inputs in the runtime core can do that.

use crate::provider_sessions::{
    ProviderEventStatus, ProviderRunPhase, ProviderRunSnapshot, ProviderSessionEvent,
    ProviderSessionEventKind,
};
use crate::task_execution_runtime_evidence::{bounded_evidence, provider_session_evidence};
use crate::task_provider_fallback::{ActiveProviderOutcome, ActiveProviderSignal, EvidenceClass};
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TaskProviderSessionObservation {
    None,
    Active(ActiveProviderSignal),
    Outcome(ActiveProviderOutcome),
}

pub fn classify_provider_session_event(
    event: &ProviderSessionEvent,
) -> TaskProviderSessionObservation {
    let Some(evidence) = provider_session_evidence(event.run_id.trim(), event.event_id.trim())
    else {
        return TaskProviderSessionObservation::None;
    };

    if matches!(event.kind, ProviderSessionEventKind::Aborted)
        || matches!(event.status, Some(ProviderEventStatus::Aborted))
    {
        return TaskProviderSessionObservation::Outcome(ActiveProviderOutcome::Cancelled {
            evidence,
        });
    }
    if matches!(event.kind, ProviderSessionEventKind::Failed)
        || matches!(event.status, Some(ProviderEventStatus::Failed))
    {
        return TaskProviderSessionObservation::Outcome(ActiveProviderOutcome::Failed { evidence });
    }
    if matches!(event.kind, ProviderSessionEventKind::Completed)
        || matches!(event.status, Some(ProviderEventStatus::Completed))
    {
        return TaskProviderSessionObservation::Outcome(ActiveProviderOutcome::Succeeded {
            evidence,
        });
    }
    if matches!(event.status, Some(ProviderEventStatus::WaitingForApproval))
        || matches!(
            event.kind,
            ProviderSessionEventKind::Tool
                | ProviderSessionEventKind::Command
                | ProviderSessionEventKind::McpTool
                | ProviderSessionEventKind::Subagent
        )
    {
        return TaskProviderSessionObservation::Active(ActiveProviderSignal::ToolOrApproval {
            evidence,
        });
    }
    if matches!(event.kind, ProviderSessionEventKind::FileChange) {
        return TaskProviderSessionObservation::Active(
            ActiveProviderSignal::PossibleExternalEffect { evidence },
        );
    }
    if matches!(
        event.kind,
        ProviderSessionEventKind::Text | ProviderSessionEventKind::TextDelta
    ) && event
        .text
        .as_deref()
        .is_some_and(|text| !text.trim().is_empty())
    {
        return TaskProviderSessionObservation::Active(ActiveProviderSignal::FirstTaskContent {
            evidence,
        });
    }
    if matches!(event.kind, ProviderSessionEventKind::Started)
        || matches!(
            event.status,
            Some(ProviderEventStatus::Started | ProviderEventStatus::InProgress)
        )
    {
        return TaskProviderSessionObservation::Active(ActiveProviderSignal::Running { evidence });
    }

    TaskProviderSessionObservation::None
}

pub fn classify_provider_run_snapshot(
    run: &ProviderRunSnapshot,
    evidence_reference: impl AsRef<str>,
) -> TaskProviderSessionObservation {
    let Some(evidence) = bounded_evidence(EvidenceClass::ProviderSession, evidence_reference)
    else {
        return TaskProviderSessionObservation::None;
    };
    match run.phase {
        ProviderRunPhase::Starting | ProviderRunPhase::Streaming => {
            TaskProviderSessionObservation::Active(ActiveProviderSignal::Running { evidence })
        }
        ProviderRunPhase::Completed => {
            TaskProviderSessionObservation::Outcome(ActiveProviderOutcome::Succeeded { evidence })
        }
        ProviderRunPhase::Failed => {
            TaskProviderSessionObservation::Outcome(ActiveProviderOutcome::Failed { evidence })
        }
        ProviderRunPhase::Aborted => {
            TaskProviderSessionObservation::Outcome(ActiveProviderOutcome::Cancelled { evidence })
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TaskGrokAcpObservation {
    None,
    Active(ActiveProviderSignal),
    Outcome(ActiveProviderOutcome),
}

pub fn classify_grok_acp_event(
    payload: &serde_json::Value,
    evidence_reference: impl AsRef<str>,
) -> TaskGrokAcpObservation {
    let Some(evidence) =
        bounded_evidence(EvidenceClass::StructuredProviderStream, evidence_reference)
    else {
        return TaskGrokAcpObservation::None;
    };
    let method = payload.get("method").and_then(serde_json::Value::as_str);
    let params = payload.get("params").unwrap_or(&serde_json::Value::Null);

    match method {
        Some("session/update") => {
            let update = params.get("update").unwrap_or(&serde_json::Value::Null);
            match update
                .get("sessionUpdate")
                .and_then(serde_json::Value::as_str)
            {
                Some("tool_call_update") => {
                    TaskGrokAcpObservation::Active(ActiveProviderSignal::ToolOrApproval {
                        evidence,
                    })
                }
                Some("agent_message_chunk")
                    if update
                        .get("content")
                        .and_then(|content| content.get("text"))
                        .and_then(serde_json::Value::as_str)
                        .is_some_and(|text| !text.trim().is_empty()) =>
                {
                    TaskGrokAcpObservation::Active(ActiveProviderSignal::FirstTaskContent {
                        evidence,
                    })
                }
                Some("agent_thought_chunk") => {
                    TaskGrokAcpObservation::Active(ActiveProviderSignal::Running { evidence })
                }
                _ => TaskGrokAcpObservation::None,
            }
        }
        Some("_x.ai/session/prompt_complete") => {
            let outcome = match params.get("stopReason").and_then(serde_json::Value::as_str) {
                Some("end_turn" | "completed" | "complete" | "success") => {
                    ActiveProviderOutcome::Succeeded { evidence }
                }
                Some("cancelled") => ActiveProviderOutcome::Cancelled { evidence },
                Some("error" | "failed") => ActiveProviderOutcome::Failed { evidence },
                _ => ActiveProviderOutcome::OutcomeUnknown { evidence },
            };
            TaskGrokAcpObservation::Outcome(outcome)
        }
        _ => TaskGrokAcpObservation::None,
    }
}
