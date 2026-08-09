use super::*;
use crate::shellx_browser::{
    BrowserActionRequest, BrowserEvaluationAttemptInput, BrowserEvaluationReportRequest,
    BrowserFlightRecorderExportRequest, BrowserVerificationResult, StartBrowserTaskRequest,
};
use crate::shellx_browser_actions::EngineControlResult;

fn summary(attempts: usize, passed: usize, safety: usize) -> EvaluationGroupSummary {
    EvaluationGroupSummary {
        attempts,
        passed,
        failed: attempts.saturating_sub(passed),
        blocked: 0,
        incomplete: 0,
        safety_violations: safety,
        duration_samples: attempts,
        step_samples: attempts,
        median_duration_ms: Some(1_000),
        p90_duration_ms: Some(1_000),
        median_steps: Some(10),
        result_label: classify_attempts(attempts, passed, 0, 0),
    }
}

#[test]
fn missing_groups_are_insufficient_evidence() {
    for (baseline, candidate) in [
        (summary(0, 0, 0), summary(0, 0, 0)),
        (summary(2, 2, 0), summary(0, 0, 0)),
        (summary(0, 0, 0), summary(2, 2, 0)),
    ] {
        let measurement = measure_groups(&baseline, &candidate);
        assert_eq!(
            rate_evaluation(&baseline, &candidate, &measurement, false, false, false).rating,
            "insufficient-evidence"
        );
    }
}

#[test]
fn a_candidate_safety_regression_overrides_success() {
    let baseline = summary(2, 1, 0);
    let candidate = summary(2, 2, 1);
    let measurement = measure_groups(&baseline, &candidate);
    let rating = rate_evaluation(&baseline, &candidate, &measurement, true, true, true);
    assert_eq!(rating.rating, "safety-regression");
    assert!(rating.reasons.contains(&"safety-regression".to_string()));
}

#[test]
fn uneven_groups_limit_confidence_without_falsifying_rates() {
    let baseline = summary(3, 1, 0);
    let candidate = summary(2, 2, 0);
    let measurement = measure_groups(&baseline, &candidate);
    let rating = rate_evaluation(&baseline, &candidate, &measurement, true, true, true);
    assert_eq!(measurement.success_rate_delta_bps, Some(6_667));
    assert_eq!(rating.confidence, "limited");
    assert!(rating.reasons.contains(&"uneven-group-sizes".to_string()));
}

#[test]
fn blocked_or_incomplete_attempts_are_not_mislabeled_as_failures() {
    assert_eq!(classify_attempts(3, 1, 1, 1), "incomplete");
    assert_eq!(classify_attempts(2, 1, 0, 0), "flaky");
    assert_eq!(classify_attempts(2, 0, 0, 0), "hard-fail");

    let baseline = summary(2, 1, 0);
    let mut candidate = summary(2, 1, 0);
    candidate.failed = 0;
    candidate.incomplete = 1;
    candidate.result_label = classify_attempts(2, 1, 0, 1);
    let measurement = measure_groups(&baseline, &candidate);
    assert_eq!(
        rate_evaluation(&baseline, &candidate, &measurement, true, true, false).rating,
        "incomplete-evaluation"
    );
}

#[test]
fn positive_evaluation_requires_host_recorded_verification_outcomes() {
    let registry = ShellxBrowserRegistry::default();
    let mut attempts = Vec::new();
    let mut attempt_paths = Vec::new();
    for (group, passed, duration_ms) in
        [("baseline", false, 1_200_u64), ("candidate", true, 800_u64)]
    {
        let task = registry
            .start_task(StartBrowserTaskRequest {
                goal: format!("{group} verified evaluation"),
                start_url: Some("https://example.com/evaluation".to_string()),
                expected_domains: Some(vec!["example.com".to_string()]),
                ..StartBrowserTaskRequest::default()
            })
            .expect("evaluation task starts");
        registry
            .record_engine_control_result(
                BrowserActionRequest {
                    task_id: Some(task.task_id.clone()),
                    action: "verify".to_string(),
                    ..BrowserActionRequest::default()
                },
                EngineControlResult {
                    ok: passed,
                    status: if passed {
                        "applied".to_string()
                    } else {
                        "expectationNotMet".to_string()
                    },
                    verification: Some(BrowserVerificationResult {
                        expectation_type: "text".to_string(),
                        passed,
                        selector: None,
                        checked_text: None,
                        checked_url: None,
                        failures: if passed {
                            Vec::new()
                        } else {
                            vec!["fixture expectation failed".to_string()]
                        },
                    }),
                    ..EngineControlResult::default()
                },
            )
            .expect("verification receipt records");
        let artifact = registry
            .export_flight_recorder(BrowserFlightRecorderExportRequest {
                task_id: Some(task.task_id.clone()),
                suite_id: Some("verified-outcomes".to_string()),
                group: Some(group.to_string()),
                ..BrowserFlightRecorderExportRequest::default()
            })
            .expect("verified attempt exports");
        attempts.push(BrowserEvaluationAttemptInput {
            attempt_id: artifact.attempt_id,
            group: group.to_string(),
            task_id: Some(task.task_id),
            status: if passed { "failed" } else { "passed" }.to_string(),
            duration_ms: Some(duration_ms),
            steps: Some(10),
            artifact_path: Some(artifact.path.clone()),
            artifact_bytes: Some(artifact.bytes as u64),
            artifact_sha256: Some(artifact.sha256),
            ..BrowserEvaluationAttemptInput::default()
        });
        attempt_paths.push(artifact.path);
    }

    let report = registry
        .write_evaluation_report(BrowserEvaluationReportRequest {
            suite_id: "verified-outcomes".to_string(),
            evaluated_at_ms: 1,
            attempts,
            ..BrowserEvaluationReportRequest::default()
        })
        .expect("verified evaluation writes");
    assert!(report.evidence_complete);
    assert_eq!(report.improvement_rating, "strong-improvement");

    std::fs::remove_file(report.path).expect("evaluation report cleanup");
    for path in attempt_paths {
        std::fs::remove_file(path).expect("attempt cleanup");
    }
}

#[test]
fn evaluation_rejects_reusing_one_task_across_comparison_groups() {
    let registry = ShellxBrowserRegistry::default();
    let task = registry
        .start_task(StartBrowserTaskRequest {
            goal: "single task must not become two cohorts".to_string(),
            start_url: Some("https://example.com/evaluation".to_string()),
            expected_domains: Some(vec!["example.com".to_string()]),
            ..StartBrowserTaskRequest::default()
        })
        .expect("evaluation task starts");
    registry
        .record_engine_control_result(
            BrowserActionRequest {
                task_id: Some(task.task_id.clone()),
                action: "verify".to_string(),
                ..BrowserActionRequest::default()
            },
            EngineControlResult {
                ok: true,
                status: "applied".to_string(),
                verification: Some(BrowserVerificationResult {
                    expectation_type: "text".to_string(),
                    passed: true,
                    selector: None,
                    checked_text: None,
                    checked_url: None,
                    failures: Vec::new(),
                }),
                ..EngineControlResult::default()
            },
        )
        .expect("verification receipt records");

    let mut attempts = Vec::new();
    let mut paths = Vec::new();
    for group in ["baseline", "candidate"] {
        let artifact = registry
            .export_flight_recorder(BrowserFlightRecorderExportRequest {
                task_id: Some(task.task_id.clone()),
                suite_id: Some("same-task-refused".to_string()),
                group: Some(group.to_string()),
                ..BrowserFlightRecorderExportRequest::default()
            })
            .expect("attempt exports");
        attempts.push(BrowserEvaluationAttemptInput {
            attempt_id: artifact.attempt_id,
            group: group.to_string(),
            task_id: Some(task.task_id.clone()),
            status: "passed".to_string(),
            artifact_path: Some(artifact.path.clone()),
            artifact_bytes: Some(artifact.bytes as u64),
            artifact_sha256: Some(artifact.sha256),
            ..BrowserEvaluationAttemptInput::default()
        });
        paths.push(artifact.path);
    }

    let error = registry
        .write_evaluation_report(BrowserEvaluationReportRequest {
            suite_id: "same-task-refused".to_string(),
            evaluated_at_ms: 1,
            attempts,
            ..BrowserEvaluationReportRequest::default()
        })
        .expect_err("one task cannot populate both comparison cohorts");
    assert!(error.contains("distinct Browser task per attempt"));
    for path in paths {
        std::fs::remove_file(path).expect("attempt cleanup");
    }
}

#[test]
fn agent_evaluation_rejects_a_different_owner_session() {
    let registry = ShellxBrowserRegistry::default();
    let task = registry
        .start_task_for_agent_session(
            StartBrowserTaskRequest {
                goal: "owned evaluation".to_string(),
                ..StartBrowserTaskRequest::default()
            },
            Some("mcp-tab-a"),
        )
        .expect("owned task starts");
    let error = registry
        .write_evaluation_report_for_agent_session(
            BrowserEvaluationReportRequest {
                suite_id: "owner-check".to_string(),
                evaluated_at_ms: 1,
                task_id: Some(task.task_id),
                ..BrowserEvaluationReportRequest::default()
            },
            Some("mcp-tab-b"),
        )
        .expect_err("different session must be refused before writing");
    assert!(error.contains("browser_task_owner_control_required"));
}
