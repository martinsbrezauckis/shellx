//! Pure ordered-provider fallback state machine for Task occurrences.
//!
//! This module deliberately does not spawn providers, inspect provider output,
//! or persist receipts. Provider adapters must classify their own structured
//! observations into the typed inputs below. The coordinator then makes the
//! only fallback decision: advance only after proof that the candidate could
//! not have started task work.

use std::collections::BTreeSet;

/// A provider/model choice captured in an immutable task revision.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TaskExecutionCandidate {
    pub provider_id: String,
    pub model: ModelSelection,
    /// One-based, immutable route position.
    pub order: u16,
}

impl TaskExecutionCandidate {
    #[cfg(test)]
    pub fn provider_default(provider_id: impl Into<String>, order: u16) -> Self {
        Self {
            provider_id: provider_id.into(),
            model: ModelSelection::ProviderDefault,
            order,
        }
    }
}

/// A provider default is distinct from an explicitly verified model identity.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ModelSelection {
    ProviderDefault,
    VerifiedModel(String),
}

/// A source class suitable for a bounded task receipt.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EvidenceClass {
    ProviderCapabilityScan,
    #[cfg(test)]
    #[allow(dead_code)]
    TargetReachability,
    StructuredProviderStream,
    ProviderAdapter,
    ProviderSession,
    ExternalEffectGuard,
}

/// An adapter-provided reference to the bounded evidence retained elsewhere.
///
/// The coordinator treats this as opaque data. It never parses prose to decide
/// whether fallback is safe.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DecisionEvidence {
    pub class: EvidenceClass,
    pub reference: String,
}

impl DecisionEvidence {
    pub fn new(class: EvidenceClass, reference: impl Into<String>) -> Self {
        Self {
            class,
            reference: reference.into(),
        }
    }
}

/// The complete, closed set of reasons which proves no task work began.
///
/// The structured rate-limit and unavailable variants are intentionally
/// separate: adapters may construct them only from provider-native structured
/// evidence that proves the prompt was not accepted for task execution.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PreEffectRejectionReason {
    ProviderMissing,
    ProviderUnavailable,
    AuthenticationRequired,
    IncompatibleCapability,
    TargetOfflineBeforeDispatch,
    StructuredRateLimitedNoTaskStarted,
    StructuredUnavailableNoTaskStarted,
}

/// A typed, proof-bearing rejection eligible for automatic fallback.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PreEffectRejection {
    pub reason: PreEffectRejectionReason,
    pub evidence: DecisionEvidence,
}

impl PreEffectRejection {
    pub fn new(reason: PreEffectRejectionReason, evidence: DecisionEvidence) -> Self {
        Self { reason, evidence }
    }
}

/// Preflight is complete before the coordinator permits a dispatch request.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PreflightVerdict {
    Eligible {
        evidence: DecisionEvidence,
    },
    Rejected(PreEffectRejection),
    /// A non-proof result must stop, even when no dispatch has happened yet.
    Inconclusive {
        evidence: DecisionEvidence,
    },
}

/// Results that can be reported after the caller has attempted dispatch.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DispatchVerdict {
    /// The provider accepted the task prompt. This is a committed-start event.
    Accepted { evidence: DecisionEvidence },
    /// A structured adapter result proves that no task work started.
    RejectedNoTaskStarted(PreEffectRejection),
    /// The prompt might have been accepted, so automatic fallback is unsafe.
    Ambiguous {
        reason: AmbiguousDispatchReason,
        evidence: DecisionEvidence,
    },
}

/// Ambiguous failures after dispatch never permit automatic fallback.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AmbiguousDispatchReason {
    TransportLostAfterPromptDispatch,
    UnclassifiedErrorAfterPromptDispatch,
}

/// Signals observed after a provider has committed to starting the task.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ActiveProviderSignal {
    Running { evidence: DecisionEvidence },
    FirstTaskContent { evidence: DecisionEvidence },
    ToolOrApproval { evidence: DecisionEvidence },
    PossibleExternalEffect { evidence: DecisionEvidence },
}

/// How an active provider attempt reached a terminal result.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ActiveProviderOutcome {
    Succeeded { evidence: DecisionEvidence },
    Failed { evidence: DecisionEvidence },
    Cancelled { evidence: DecisionEvidence },
    TimedOut { evidence: DecisionEvidence },
    OutcomeUnknown { evidence: DecisionEvidence },
}

/// Typed adapter input accepted by the coordinator.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ProviderClassification {
    Preflight(PreflightVerdict),
    Dispatch(DispatchVerdict),
    Active(ActiveProviderSignal),
    Outcome(ActiveProviderOutcome),
}

/// The earliest event that commits the occurrence to one provider attempt.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum CommittedStartBoundary {
    ProviderAccepted,
    ProviderRunning,
    FirstTaskContent,
    ToolOrApproval,
    PossibleExternalEffect,
}

impl ActiveProviderSignal {
    pub fn committed_start_boundary(&self) -> CommittedStartBoundary {
        match self {
            Self::Running { .. } => CommittedStartBoundary::ProviderRunning,
            Self::FirstTaskContent { .. } => CommittedStartBoundary::FirstTaskContent,
            Self::ToolOrApproval { .. } => CommittedStartBoundary::ToolOrApproval,
            Self::PossibleExternalEffect { .. } => CommittedStartBoundary::PossibleExternalEffect,
        }
    }
}

/// Coarse state suitable for a durable receipt transition.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ExecutionPhaseKind {
    Ready,
    AwaitingPreflight,
    AwaitingDispatch,
    Active,
    NeedsAttention,
    OutcomeUnknown,
    Completed,
}

/// Current state of the occurrence's ordered provider route.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ExecutionPhase {
    Ready,
    AwaitingPreflight {
        candidate_order: u16,
    },
    AwaitingDispatch {
        candidate_order: u16,
    },
    Active {
        candidate_order: u16,
        committed_start: CommittedStartBoundary,
    },
    NeedsAttention {
        candidate_order: u16,
    },
    OutcomeUnknown {
        candidate_order: u16,
    },
    Completed {
        candidate_order: u16,
    },
}

impl ExecutionPhase {
    pub fn kind(&self) -> ExecutionPhaseKind {
        match self {
            Self::Ready => ExecutionPhaseKind::Ready,
            Self::AwaitingPreflight { .. } => ExecutionPhaseKind::AwaitingPreflight,
            Self::AwaitingDispatch { .. } => ExecutionPhaseKind::AwaitingDispatch,
            Self::Active { .. } => ExecutionPhaseKind::Active,
            Self::NeedsAttention { .. } => ExecutionPhaseKind::NeedsAttention,
            Self::OutcomeUnknown { .. } => ExecutionPhaseKind::OutcomeUnknown,
            Self::Completed { .. } => ExecutionPhaseKind::Completed,
        }
    }

    #[cfg(test)]
    #[allow(dead_code)]
    pub fn is_terminal(&self) -> bool {
        matches!(
            self,
            Self::NeedsAttention { .. } | Self::OutcomeUnknown { .. } | Self::Completed { .. }
        )
    }
}

/// An append-only decision record ready for a receipt writer.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProviderRouteDecision {
    pub candidate: TaskExecutionCandidate,
    pub reason: ProviderRouteDecisionReason,
    pub evidence: DecisionEvidence,
    pub transition: ExecutionTransition,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ProviderRouteDecisionReason {
    CandidateSelected,
    PreflightEligible,
    PreEffectRejected(PreEffectRejectionReason),
    PreflightInconclusive,
    CommittedStart(CommittedStartBoundary),
    AmbiguousDispatch(AmbiguousDispatchReason),
    ProviderActivity(CommittedStartBoundary),
    Succeeded,
    Failed,
    Cancelled,
    TimedOut,
    OutcomeUnknown,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ExecutionTransition {
    pub from: ExecutionPhaseKind,
    pub to: ExecutionPhaseKind,
}

/// Work requested from the runtime integration. This module performs none of
/// it; callers must persist the returned decision before reporting progress.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CoordinatorAction {
    RunPreflight {
        candidate: TaskExecutionCandidate,
    },
    DispatchProvider {
        candidate: TaskExecutionCandidate,
    },
    PersistCommittedStart {
        candidate: TaskExecutionCandidate,
        boundary: CommittedStartBoundary,
    },
    NeedsAttention {
        candidate: TaskExecutionCandidate,
    },
    OutcomeUnknown {
        candidate: TaskExecutionCandidate,
    },
    Completed {
        candidate: TaskExecutionCandidate,
    },
}

/// A state change and the receipt decision that describes it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CoordinatorTransition {
    pub action: CoordinatorAction,
    pub decision: ProviderRouteDecision,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RouteValidationError {
    EmptyRoute,
    EmptyProviderId { order: u16 },
    DuplicateProviderId { provider_id: String },
    DuplicateOrder { order: u16 },
    NonContiguousOrder { expected: u16, found: u16 },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ClassificationKind {
    Preflight,
    Dispatch,
    Active,
    Outcome,
}

impl ProviderClassification {
    fn kind(&self) -> ClassificationKind {
        match self {
            Self::Preflight(_) => ClassificationKind::Preflight,
            Self::Dispatch(_) => ClassificationKind::Dispatch,
            Self::Active(_) => ClassificationKind::Active,
            Self::Outcome(_) => ClassificationKind::Outcome,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CoordinatorTransitionError {
    AlreadyBegun {
        phase: ExecutionPhaseKind,
    },
    UnexpectedClassification {
        phase: ExecutionPhaseKind,
        classification: ClassificationKind,
    },
    CandidateAlreadyDispatched {
        order: u16,
    },
}

/// A pure, single-occurrence coordinator. It never retries or revisits a
/// candidate after dispatch, which prevents duplicate provider starts.
#[derive(Clone, Debug)]
pub struct TaskExecutionCoordinator {
    candidates: Vec<TaskExecutionCandidate>,
    current_index: usize,
    phase: ExecutionPhase,
    decisions: Vec<ProviderRouteDecision>,
    dispatched_orders: BTreeSet<u16>,
}

impl TaskExecutionCoordinator {
    pub fn new(mut candidates: Vec<TaskExecutionCandidate>) -> Result<Self, RouteValidationError> {
        validate_route(&mut candidates)?;

        Ok(Self {
            candidates,
            current_index: 0,
            phase: ExecutionPhase::Ready,
            decisions: Vec::new(),
            dispatched_orders: BTreeSet::new(),
        })
    }

    pub fn phase(&self) -> &ExecutionPhase {
        &self.phase
    }

    /// Whether this durable coordinator has already recorded the semantic
    /// activity milestone. Provider streams can emit hundreds of thought or
    /// text deltas for one attempt; those repeats add no new authority or
    /// audit fact and must not consume the bounded receipt tail.
    pub fn has_recorded_activity(&self, boundary: CommittedStartBoundary) -> bool {
        self.decisions.iter().any(|decision| {
            matches!(
                decision.reason,
                ProviderRouteDecisionReason::CommittedStart(recorded)
                    | ProviderRouteDecisionReason::ProviderActivity(recorded)
                    if recorded == boundary
            )
        })
    }

    #[cfg(test)]
    #[allow(dead_code)]
    pub fn decisions(&self) -> &[ProviderRouteDecision] {
        &self.decisions
    }

    /// Candidate orders that have received a dispatch action exactly once.
    #[cfg(test)]
    #[allow(dead_code)]
    pub fn dispatched_orders(&self) -> impl Iterator<Item = u16> + '_ {
        self.dispatched_orders.iter().copied()
    }

    pub fn begin(
        &mut self,
        evidence: DecisionEvidence,
    ) -> Result<CoordinatorTransition, CoordinatorTransitionError> {
        if !matches!(self.phase, ExecutionPhase::Ready) {
            return Err(CoordinatorTransitionError::AlreadyBegun {
                phase: self.phase.kind(),
            });
        }

        let candidate = self.current_candidate().clone();
        let from = self.phase.kind();
        self.phase = ExecutionPhase::AwaitingPreflight {
            candidate_order: candidate.order,
        };
        Ok(self.record(
            candidate.clone(),
            ProviderRouteDecisionReason::CandidateSelected,
            evidence,
            from,
            CoordinatorAction::RunPreflight { candidate },
        ))
    }

    pub fn apply(
        &mut self,
        classification: ProviderClassification,
    ) -> Result<CoordinatorTransition, CoordinatorTransitionError> {
        match (&self.phase, classification) {
            (
                ExecutionPhase::AwaitingPreflight { .. },
                ProviderClassification::Preflight(verdict),
            ) => self.apply_preflight(verdict),
            (
                ExecutionPhase::AwaitingDispatch { .. },
                ProviderClassification::Dispatch(verdict),
            ) => self.apply_dispatch(verdict),
            (ExecutionPhase::AwaitingDispatch { .. }, ProviderClassification::Active(signal)) => {
                self.commit_from_active_signal(signal)
            }
            (ExecutionPhase::Active { .. }, ProviderClassification::Active(signal)) => {
                self.apply_active_signal(signal)
            }
            (ExecutionPhase::Active { .. }, ProviderClassification::Outcome(outcome)) => {
                self.apply_outcome(outcome)
            }
            (phase, classification) => Err(CoordinatorTransitionError::UnexpectedClassification {
                phase: phase.kind(),
                classification: classification.kind(),
            }),
        }
    }

    fn apply_preflight(
        &mut self,
        verdict: PreflightVerdict,
    ) -> Result<CoordinatorTransition, CoordinatorTransitionError> {
        let candidate = self.current_candidate().clone();
        let from = self.phase.kind();
        match verdict {
            PreflightVerdict::Eligible { evidence } => {
                if !self.dispatched_orders.insert(candidate.order) {
                    return Err(CoordinatorTransitionError::CandidateAlreadyDispatched {
                        order: candidate.order,
                    });
                }
                self.phase = ExecutionPhase::AwaitingDispatch {
                    candidate_order: candidate.order,
                };
                Ok(self.record(
                    candidate.clone(),
                    ProviderRouteDecisionReason::PreflightEligible,
                    evidence,
                    from,
                    CoordinatorAction::DispatchProvider { candidate },
                ))
            }
            PreflightVerdict::Rejected(rejection) => {
                self.advance_after_rejection(candidate, rejection, from)
            }
            PreflightVerdict::Inconclusive { evidence } => {
                self.phase = ExecutionPhase::NeedsAttention {
                    candidate_order: candidate.order,
                };
                Ok(self.record(
                    candidate.clone(),
                    ProviderRouteDecisionReason::PreflightInconclusive,
                    evidence,
                    from,
                    CoordinatorAction::NeedsAttention { candidate },
                ))
            }
        }
    }

    fn apply_dispatch(
        &mut self,
        verdict: DispatchVerdict,
    ) -> Result<CoordinatorTransition, CoordinatorTransitionError> {
        let candidate = self.current_candidate().clone();
        let from = self.phase.kind();
        match verdict {
            DispatchVerdict::Accepted { evidence } => self.commit_start(
                candidate,
                CommittedStartBoundary::ProviderAccepted,
                evidence,
                from,
            ),
            DispatchVerdict::RejectedNoTaskStarted(rejection) => {
                self.advance_after_rejection(candidate, rejection, from)
            }
            DispatchVerdict::Ambiguous { reason, evidence } => {
                self.phase = match reason {
                    AmbiguousDispatchReason::TransportLostAfterPromptDispatch => {
                        ExecutionPhase::OutcomeUnknown {
                            candidate_order: candidate.order,
                        }
                    }
                    AmbiguousDispatchReason::UnclassifiedErrorAfterPromptDispatch => {
                        ExecutionPhase::OutcomeUnknown {
                            candidate_order: candidate.order,
                        }
                    }
                };
                let action = match reason {
                    AmbiguousDispatchReason::TransportLostAfterPromptDispatch => {
                        CoordinatorAction::OutcomeUnknown {
                            candidate: candidate.clone(),
                        }
                    }
                    AmbiguousDispatchReason::UnclassifiedErrorAfterPromptDispatch => {
                        CoordinatorAction::OutcomeUnknown {
                            candidate: candidate.clone(),
                        }
                    }
                };
                Ok(self.record(
                    candidate,
                    ProviderRouteDecisionReason::AmbiguousDispatch(reason),
                    evidence,
                    from,
                    action,
                ))
            }
        }
    }

    fn apply_active_signal(
        &mut self,
        signal: ActiveProviderSignal,
    ) -> Result<CoordinatorTransition, CoordinatorTransitionError> {
        let candidate = self.current_candidate().clone();
        let from = self.phase.kind();
        let (boundary, evidence) = active_signal_parts(signal);
        Ok(self.record(
            candidate,
            ProviderRouteDecisionReason::ProviderActivity(boundary),
            evidence,
            from,
            CoordinatorAction::PersistCommittedStart {
                candidate: self.current_candidate().clone(),
                boundary,
            },
        ))
    }

    fn commit_from_active_signal(
        &mut self,
        signal: ActiveProviderSignal,
    ) -> Result<CoordinatorTransition, CoordinatorTransitionError> {
        let candidate = self.current_candidate().clone();
        let from = self.phase.kind();
        let (boundary, evidence) = active_signal_parts(signal);
        self.commit_start(candidate, boundary, evidence, from)
    }

    fn apply_outcome(
        &mut self,
        outcome: ActiveProviderOutcome,
    ) -> Result<CoordinatorTransition, CoordinatorTransitionError> {
        let candidate = self.current_candidate().clone();
        let from = self.phase.kind();
        let (reason, evidence, phase, action) = match outcome {
            ActiveProviderOutcome::Succeeded { evidence } => (
                ProviderRouteDecisionReason::Succeeded,
                evidence,
                ExecutionPhase::Completed {
                    candidate_order: candidate.order,
                },
                CoordinatorAction::Completed {
                    candidate: candidate.clone(),
                },
            ),
            ActiveProviderOutcome::Failed { evidence } => (
                ProviderRouteDecisionReason::Failed,
                evidence,
                ExecutionPhase::NeedsAttention {
                    candidate_order: candidate.order,
                },
                CoordinatorAction::NeedsAttention {
                    candidate: candidate.clone(),
                },
            ),
            ActiveProviderOutcome::Cancelled { evidence } => (
                ProviderRouteDecisionReason::Cancelled,
                evidence,
                ExecutionPhase::NeedsAttention {
                    candidate_order: candidate.order,
                },
                CoordinatorAction::NeedsAttention {
                    candidate: candidate.clone(),
                },
            ),
            ActiveProviderOutcome::TimedOut { evidence } => (
                ProviderRouteDecisionReason::TimedOut,
                evidence,
                ExecutionPhase::NeedsAttention {
                    candidate_order: candidate.order,
                },
                CoordinatorAction::NeedsAttention {
                    candidate: candidate.clone(),
                },
            ),
            ActiveProviderOutcome::OutcomeUnknown { evidence } => (
                ProviderRouteDecisionReason::OutcomeUnknown,
                evidence,
                ExecutionPhase::OutcomeUnknown {
                    candidate_order: candidate.order,
                },
                CoordinatorAction::OutcomeUnknown {
                    candidate: candidate.clone(),
                },
            ),
        };
        self.phase = phase;
        Ok(self.record(candidate, reason, evidence, from, action))
    }

    fn commit_start(
        &mut self,
        candidate: TaskExecutionCandidate,
        boundary: CommittedStartBoundary,
        evidence: DecisionEvidence,
        from: ExecutionPhaseKind,
    ) -> Result<CoordinatorTransition, CoordinatorTransitionError> {
        self.phase = ExecutionPhase::Active {
            candidate_order: candidate.order,
            committed_start: boundary,
        };
        Ok(self.record(
            candidate.clone(),
            ProviderRouteDecisionReason::CommittedStart(boundary),
            evidence,
            from,
            CoordinatorAction::PersistCommittedStart {
                candidate,
                boundary,
            },
        ))
    }

    fn advance_after_rejection(
        &mut self,
        candidate: TaskExecutionCandidate,
        rejection: PreEffectRejection,
        from: ExecutionPhaseKind,
    ) -> Result<CoordinatorTransition, CoordinatorTransitionError> {
        let PreEffectRejection { reason, evidence } = rejection;
        if self.current_index + 1 < self.candidates.len() {
            self.current_index += 1;
            let next = self.current_candidate().clone();
            self.phase = ExecutionPhase::AwaitingPreflight {
                candidate_order: next.order,
            };
            Ok(self.record(
                candidate,
                ProviderRouteDecisionReason::PreEffectRejected(reason),
                evidence,
                from,
                CoordinatorAction::RunPreflight { candidate: next },
            ))
        } else {
            self.phase = ExecutionPhase::NeedsAttention {
                candidate_order: candidate.order,
            };
            Ok(self.record(
                candidate.clone(),
                ProviderRouteDecisionReason::PreEffectRejected(reason),
                evidence,
                from,
                CoordinatorAction::NeedsAttention { candidate },
            ))
        }
    }

    fn current_candidate(&self) -> &TaskExecutionCandidate {
        &self.candidates[self.current_index]
    }

    fn record(
        &mut self,
        candidate: TaskExecutionCandidate,
        reason: ProviderRouteDecisionReason,
        evidence: DecisionEvidence,
        from: ExecutionPhaseKind,
        action: CoordinatorAction,
    ) -> CoordinatorTransition {
        let decision = ProviderRouteDecision {
            candidate,
            reason,
            evidence,
            transition: ExecutionTransition {
                from,
                to: self.phase.kind(),
            },
        };
        self.decisions.push(decision.clone());
        CoordinatorTransition { action, decision }
    }
}

fn validate_route(candidates: &mut [TaskExecutionCandidate]) -> Result<(), RouteValidationError> {
    if candidates.is_empty() {
        return Err(RouteValidationError::EmptyRoute);
    }

    candidates.sort_by_key(|candidate| candidate.order);
    let mut providers = BTreeSet::new();
    let mut orders = BTreeSet::new();

    for (index, candidate) in candidates.iter().enumerate() {
        if candidate.provider_id.trim().is_empty() {
            return Err(RouteValidationError::EmptyProviderId {
                order: candidate.order,
            });
        }
        if !providers.insert(candidate.provider_id.clone()) {
            return Err(RouteValidationError::DuplicateProviderId {
                provider_id: candidate.provider_id.clone(),
            });
        }
        if !orders.insert(candidate.order) {
            return Err(RouteValidationError::DuplicateOrder {
                order: candidate.order,
            });
        }
        let expected = u16::try_from(index + 1).expect("task route cannot exceed u16 orders");
        if candidate.order != expected {
            return Err(RouteValidationError::NonContiguousOrder {
                expected,
                found: candidate.order,
            });
        }
    }

    Ok(())
}

fn active_signal_parts(signal: ActiveProviderSignal) -> (CommittedStartBoundary, DecisionEvidence) {
    match signal {
        ActiveProviderSignal::Running { evidence } => {
            (CommittedStartBoundary::ProviderRunning, evidence)
        }
        ActiveProviderSignal::FirstTaskContent { evidence } => {
            (CommittedStartBoundary::FirstTaskContent, evidence)
        }
        ActiveProviderSignal::ToolOrApproval { evidence } => {
            (CommittedStartBoundary::ToolOrApproval, evidence)
        }
        ActiveProviderSignal::PossibleExternalEffect { evidence } => {
            (CommittedStartBoundary::PossibleExternalEffect, evidence)
        }
    }
}
