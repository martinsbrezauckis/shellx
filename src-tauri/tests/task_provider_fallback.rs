#[path = "../src/task_provider_fallback.rs"]
mod task_provider_fallback;

use task_provider_fallback::*;

fn route() -> Vec<TaskExecutionCandidate> {
    vec![
        TaskExecutionCandidate::provider_default("grok", 1),
        TaskExecutionCandidate {
            provider_id: "codex-cli".to_string(),
            model: ModelSelection::VerifiedModel("o4-mini".to_string()),
            order: 2,
        },
    ]
}

fn evidence(class: EvidenceClass, reference: &str) -> DecisionEvidence {
    DecisionEvidence::new(class, reference)
}

fn rejection(reason: PreEffectRejectionReason) -> PreEffectRejection {
    let class = match reason {
        PreEffectRejectionReason::TargetOfflineBeforeDispatch => EvidenceClass::TargetReachability,
        PreEffectRejectionReason::StructuredRateLimitedNoTaskStarted
        | PreEffectRejectionReason::StructuredUnavailableNoTaskStarted => {
            EvidenceClass::StructuredProviderStream
        }
        _ => EvidenceClass::ProviderCapabilityScan,
    };
    PreEffectRejection::new(reason, evidence(class, "typed-proof-1"))
}

fn begin(coordinator: &mut TaskExecutionCoordinator) {
    let transition = coordinator
        .begin(evidence(EvidenceClass::ProviderAdapter, "lease-claimed"))
        .expect("route starts exactly once");
    assert!(matches!(
        transition.action,
        CoordinatorAction::RunPreflight {
            candidate: TaskExecutionCandidate { order: 1, .. }
        }
    ));
}

fn assert_dispatched_only_once(coordinator: &TaskExecutionCoordinator, expected: &[u16]) {
    let actual: Vec<_> = coordinator.dispatched_orders().collect();
    assert_eq!(actual, expected, "unexpected provider dispatch route");
    let unique: std::collections::BTreeSet<_> = actual.iter().copied().collect();
    assert_eq!(
        unique.len(),
        actual.len(),
        "a provider candidate dispatched twice"
    );
}

#[test]
fn rejects_invalid_ordered_routes() {
    assert!(matches!(
        TaskExecutionCoordinator::new(vec![]),
        Err(RouteValidationError::EmptyRoute)
    ));
    assert!(matches!(
        TaskExecutionCoordinator::new(vec![TaskExecutionCandidate::provider_default("", 1)]),
        Err(RouteValidationError::EmptyProviderId { order: 1 })
    ));
    assert!(matches!(
        TaskExecutionCoordinator::new(vec![
            TaskExecutionCandidate::provider_default("grok", 1),
            TaskExecutionCandidate::provider_default("grok", 2),
        ]),
        Err(RouteValidationError::DuplicateProviderId { provider_id }) if provider_id == "grok"
    ));
    assert!(matches!(
        TaskExecutionCoordinator::new(vec![
            TaskExecutionCandidate::provider_default("grok", 1),
            TaskExecutionCandidate::provider_default("codex-cli", 1),
        ]),
        Err(RouteValidationError::DuplicateOrder { order: 1 })
    ));
    assert!(matches!(
        TaskExecutionCoordinator::new(vec![TaskExecutionCandidate::provider_default("grok", 2)]),
        Err(RouteValidationError::NonContiguousOrder {
            expected: 1,
            found: 2,
        })
    ));
}

#[test]
fn ordered_candidates_are_sorted_by_explicit_order() {
    let mut coordinator = TaskExecutionCoordinator::new(vec![
        TaskExecutionCandidate::provider_default("codex-cli", 2),
        TaskExecutionCandidate::provider_default("grok", 1),
    ])
    .unwrap();

    begin(&mut coordinator);
    let first = coordinator.decisions().last().unwrap();
    assert_eq!(first.candidate.provider_id, "grok");
    assert_eq!(first.candidate.order, 1);
}

#[test]
fn every_proof_bearing_pre_effect_rejection_advances_once() {
    struct Case {
        name: &'static str,
        reason: PreEffectRejectionReason,
        at_dispatch: bool,
    }

    let cases = [
        Case {
            name: "provider missing",
            reason: PreEffectRejectionReason::ProviderMissing,
            at_dispatch: false,
        },
        Case {
            name: "provider unavailable",
            reason: PreEffectRejectionReason::ProviderUnavailable,
            at_dispatch: false,
        },
        Case {
            name: "authentication required",
            reason: PreEffectRejectionReason::AuthenticationRequired,
            at_dispatch: false,
        },
        Case {
            name: "incompatible capability",
            reason: PreEffectRejectionReason::IncompatibleCapability,
            at_dispatch: false,
        },
        Case {
            name: "target offline before dispatch",
            reason: PreEffectRejectionReason::TargetOfflineBeforeDispatch,
            at_dispatch: false,
        },
        Case {
            name: "structured rate limit before start",
            reason: PreEffectRejectionReason::StructuredRateLimitedNoTaskStarted,
            at_dispatch: true,
        },
        Case {
            name: "structured unavailable before start",
            reason: PreEffectRejectionReason::StructuredUnavailableNoTaskStarted,
            at_dispatch: true,
        },
    ];

    for case in cases {
        let mut coordinator = TaskExecutionCoordinator::new(route()).unwrap();
        begin(&mut coordinator);
        let transition = if case.at_dispatch {
            coordinator
                .apply(ProviderClassification::Preflight(
                    PreflightVerdict::Eligible {
                        evidence: evidence(EvidenceClass::ProviderCapabilityScan, "ready-1"),
                    },
                ))
                .unwrap();
            coordinator
                .apply(ProviderClassification::Dispatch(
                    DispatchVerdict::RejectedNoTaskStarted(rejection(case.reason)),
                ))
                .unwrap()
        } else {
            coordinator
                .apply(ProviderClassification::Preflight(
                    PreflightVerdict::Rejected(rejection(case.reason)),
                ))
                .unwrap()
        };

        assert!(
            matches!(
                transition.action,
                CoordinatorAction::RunPreflight {
                    candidate: TaskExecutionCandidate { order: 2, .. }
                }
            ),
            "{}",
            case.name
        );
        assert_eq!(
            coordinator.phase(),
            &ExecutionPhase::AwaitingPreflight { candidate_order: 2 },
            "{}",
            case.name
        );
        assert_eq!(
            transition.decision.reason,
            ProviderRouteDecisionReason::PreEffectRejected(case.reason),
            "{}",
            case.name
        );
        assert_eq!(transition.decision.candidate.order, 1, "{}", case.name);
        assert_eq!(
            transition.decision.evidence.class,
            rejection(case.reason).evidence.class
        );
        assert_eq!(
            transition.decision.transition,
            ExecutionTransition {
                from: if case.at_dispatch {
                    ExecutionPhaseKind::AwaitingDispatch
                } else {
                    ExecutionPhaseKind::AwaitingPreflight
                },
                to: ExecutionPhaseKind::AwaitingPreflight,
            },
            "{}",
            case.name
        );
        assert_dispatched_only_once(&coordinator, if case.at_dispatch { &[1] } else { &[] });
    }
}

#[test]
fn proof_bearing_rejection_on_the_last_candidate_needs_attention() {
    let mut coordinator =
        TaskExecutionCoordinator::new(vec![TaskExecutionCandidate::provider_default("grok", 1)])
            .unwrap();
    begin(&mut coordinator);

    let transition = coordinator
        .apply(ProviderClassification::Preflight(
            PreflightVerdict::Rejected(rejection(PreEffectRejectionReason::ProviderUnavailable)),
        ))
        .unwrap();

    assert!(matches!(
        transition.action,
        CoordinatorAction::NeedsAttention { .. }
    ));
    assert_eq!(
        coordinator.phase(),
        &ExecutionPhase::NeedsAttention { candidate_order: 1 }
    );
    assert_dispatched_only_once(&coordinator, &[]);
}

#[test]
fn inconclusive_preflight_cannot_authorize_fallback() {
    let mut coordinator = TaskExecutionCoordinator::new(route()).unwrap();
    begin(&mut coordinator);

    let transition = coordinator
        .apply(ProviderClassification::Preflight(
            PreflightVerdict::Inconclusive {
                evidence: evidence(EvidenceClass::ProviderAdapter, "adapter-incomplete"),
            },
        ))
        .unwrap();

    assert!(matches!(
        transition.action,
        CoordinatorAction::NeedsAttention { .. }
    ));
    assert_eq!(
        coordinator.phase(),
        &ExecutionPhase::NeedsAttention { candidate_order: 1 }
    );
    assert_dispatched_only_once(&coordinator, &[]);
}

#[test]
fn ambiguous_post_dispatch_failures_never_advance_route() {
    let cases = [
        AmbiguousDispatchReason::TransportLostAfterPromptDispatch,
        AmbiguousDispatchReason::UnclassifiedErrorAfterPromptDispatch,
    ];

    for reason in cases {
        let mut coordinator = TaskExecutionCoordinator::new(route()).unwrap();
        begin(&mut coordinator);
        coordinator
            .apply(ProviderClassification::Preflight(
                PreflightVerdict::Eligible {
                    evidence: evidence(EvidenceClass::ProviderCapabilityScan, "ready-1"),
                },
            ))
            .unwrap();
        let transition = coordinator
            .apply(ProviderClassification::Dispatch(
                DispatchVerdict::Ambiguous {
                    reason,
                    evidence: evidence(EvidenceClass::ProviderAdapter, "dispatch-ambiguous"),
                },
            ))
            .unwrap();

        assert_eq!(
            transition.decision.reason,
            ProviderRouteDecisionReason::AmbiguousDispatch(reason)
        );
        assert_eq!(transition.decision.candidate.order, 1);
        assert!(coordinator.phase().is_terminal());
        assert_ne!(
            coordinator.phase(),
            &ExecutionPhase::AwaitingPreflight { candidate_order: 2 }
        );
        assert_dispatched_only_once(&coordinator, &[1]);
        assert!(matches!(
            coordinator.apply(ProviderClassification::Preflight(
                PreflightVerdict::Eligible {
                    evidence: evidence(EvidenceClass::ProviderCapabilityScan, "would-be-second"),
                }
            )),
            Err(CoordinatorTransitionError::UnexpectedClassification { .. })
        ));
    }
}

#[test]
fn committed_start_boundaries_never_allow_a_second_provider_start() {
    struct Case {
        signal: ActiveProviderSignal,
        boundary: CommittedStartBoundary,
    }

    let cases = [
        Case {
            signal: ActiveProviderSignal::Running {
                evidence: evidence(EvidenceClass::ProviderSession, "running"),
            },
            boundary: CommittedStartBoundary::ProviderRunning,
        },
        Case {
            signal: ActiveProviderSignal::FirstTaskContent {
                evidence: evidence(EvidenceClass::StructuredProviderStream, "first-content"),
            },
            boundary: CommittedStartBoundary::FirstTaskContent,
        },
        Case {
            signal: ActiveProviderSignal::ToolOrApproval {
                evidence: evidence(EvidenceClass::StructuredProviderStream, "tool-or-approval"),
            },
            boundary: CommittedStartBoundary::ToolOrApproval,
        },
        Case {
            signal: ActiveProviderSignal::PossibleExternalEffect {
                evidence: evidence(EvidenceClass::ExternalEffectGuard, "effect-possible"),
            },
            boundary: CommittedStartBoundary::PossibleExternalEffect,
        },
    ];

    for case in cases {
        assert_eq!(case.signal.committed_start_boundary(), case.boundary);
        let mut coordinator = TaskExecutionCoordinator::new(route()).unwrap();
        begin(&mut coordinator);
        coordinator
            .apply(ProviderClassification::Preflight(
                PreflightVerdict::Eligible {
                    evidence: evidence(EvidenceClass::ProviderCapabilityScan, "ready-1"),
                },
            ))
            .unwrap();
        let transition = coordinator
            .apply(ProviderClassification::Active(case.signal))
            .unwrap();

        assert_eq!(
            transition.decision.reason,
            ProviderRouteDecisionReason::CommittedStart(case.boundary)
        );
        assert_eq!(
            transition.action,
            CoordinatorAction::PersistCommittedStart {
                candidate: route()[0].clone(),
                boundary: case.boundary,
            }
        );
        assert_eq!(
            coordinator.phase(),
            &ExecutionPhase::Active {
                candidate_order: 1,
                committed_start: case.boundary,
            }
        );
        assert_dispatched_only_once(&coordinator, &[1]);
        assert!(coordinator.has_recorded_activity(case.boundary));
        assert!(matches!(
            coordinator.apply(ProviderClassification::Dispatch(
                DispatchVerdict::RejectedNoTaskStarted(rejection(
                    PreEffectRejectionReason::StructuredUnavailableNoTaskStarted,
                )),
            )),
            Err(CoordinatorTransitionError::UnexpectedClassification { .. })
        ));
    }
}

#[test]
fn table_sequences_preserve_no_duplicate_provider_start_property() {
    struct Case {
        name: &'static str,
        expected_dispatches: &'static [u16],
        drive: fn(&mut TaskExecutionCoordinator),
    }

    fn selected_twice(coordinator: &mut TaskExecutionCoordinator) {
        begin(coordinator);
        assert!(matches!(
            coordinator.begin(evidence(EvidenceClass::ProviderAdapter, "duplicate-begin")),
            Err(CoordinatorTransitionError::AlreadyBegun { .. })
        ));
    }

    fn eligible_then_repeated_preflight(coordinator: &mut TaskExecutionCoordinator) {
        begin(coordinator);
        coordinator
            .apply(ProviderClassification::Preflight(
                PreflightVerdict::Eligible {
                    evidence: evidence(EvidenceClass::ProviderCapabilityScan, "ready-1"),
                },
            ))
            .unwrap();
        assert!(matches!(
            coordinator.apply(ProviderClassification::Preflight(
                PreflightVerdict::Eligible {
                    evidence: evidence(EvidenceClass::ProviderCapabilityScan, "duplicate-ready"),
                }
            )),
            Err(CoordinatorTransitionError::UnexpectedClassification { .. })
        ));
    }

    fn reject_first_then_start_second(coordinator: &mut TaskExecutionCoordinator) {
        begin(coordinator);
        coordinator
            .apply(ProviderClassification::Preflight(
                PreflightVerdict::Rejected(rejection(PreEffectRejectionReason::ProviderMissing)),
            ))
            .unwrap();
        coordinator
            .apply(ProviderClassification::Preflight(
                PreflightVerdict::Eligible {
                    evidence: evidence(EvidenceClass::ProviderCapabilityScan, "ready-2"),
                },
            ))
            .unwrap();
        coordinator
            .apply(ProviderClassification::Dispatch(
                DispatchVerdict::Accepted {
                    evidence: evidence(EvidenceClass::ProviderSession, "accepted-2"),
                },
            ))
            .unwrap();
    }

    let cases = [
        Case {
            name: "begin is single-use",
            expected_dispatches: &[],
            drive: selected_twice,
        },
        Case {
            name: "eligible candidate is dispatched once",
            expected_dispatches: &[1],
            drive: eligible_then_repeated_preflight,
        },
        Case {
            name: "only the next proof-safe candidate starts",
            expected_dispatches: &[2],
            drive: reject_first_then_start_second,
        },
    ];

    for case in cases {
        let mut coordinator = TaskExecutionCoordinator::new(route()).unwrap();
        (case.drive)(&mut coordinator);
        assert_dispatched_only_once(&coordinator, case.expected_dispatches);
        assert_eq!(
            coordinator.dispatched_orders().count(),
            case.expected_dispatches.len(),
            "{}",
            case.name
        );
    }
}

#[test]
fn terminal_outcomes_after_commit_never_fallback() {
    let outcomes = [
        ActiveProviderOutcome::Succeeded {
            evidence: evidence(EvidenceClass::ProviderSession, "success"),
        },
        ActiveProviderOutcome::Failed {
            evidence: evidence(EvidenceClass::ProviderSession, "failed"),
        },
        ActiveProviderOutcome::Cancelled {
            evidence: evidence(EvidenceClass::ProviderSession, "cancelled"),
        },
        ActiveProviderOutcome::TimedOut {
            evidence: evidence(EvidenceClass::ProviderSession, "timed-out"),
        },
        ActiveProviderOutcome::OutcomeUnknown {
            evidence: evidence(EvidenceClass::ProviderSession, "unknown"),
        },
    ];

    for outcome in outcomes {
        let mut coordinator = TaskExecutionCoordinator::new(route()).unwrap();
        begin(&mut coordinator);
        coordinator
            .apply(ProviderClassification::Preflight(
                PreflightVerdict::Eligible {
                    evidence: evidence(EvidenceClass::ProviderCapabilityScan, "ready-1"),
                },
            ))
            .unwrap();
        coordinator
            .apply(ProviderClassification::Dispatch(
                DispatchVerdict::Accepted {
                    evidence: evidence(EvidenceClass::ProviderSession, "accepted"),
                },
            ))
            .unwrap();
        let transition = coordinator
            .apply(ProviderClassification::Outcome(outcome))
            .unwrap();

        assert!(coordinator.phase().is_terminal());
        assert_eq!(transition.decision.candidate.order, 1);
        assert_dispatched_only_once(&coordinator, &[1]);
        assert!(matches!(
            coordinator.apply(ProviderClassification::Dispatch(
                DispatchVerdict::RejectedNoTaskStarted(rejection(
                    PreEffectRejectionReason::StructuredRateLimitedNoTaskStarted,
                )),
            )),
            Err(CoordinatorTransitionError::UnexpectedClassification { .. })
        ));
    }
}
