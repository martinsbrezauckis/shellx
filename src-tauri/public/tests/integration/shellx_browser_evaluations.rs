use app_lib::shellx_browser::{
    BrowserEvaluationAttemptInput, BrowserEvaluationReportRequest, BrowserFlightRecorderArtifact,
    BrowserFlightRecorderExportRequest, ShellxBrowserRegistry, StartBrowserTaskRequest,
};
use sha2::{Digest, Sha256};

const EVALUATED_AT_MS: i64 = 1_777_777_777_000;

fn start_task(registry: &ShellxBrowserRegistry) -> String {
    registry
        .start_task(StartBrowserTaskRequest {
            goal: "Evaluate a bounded Browser workflow".to_string(),
            start_url: Some("https://example.com/evaluation?token=hidden#fragment".to_string()),
            profile_id: Some("agent-work".to_string()),
            expected_domains: Some(vec!["example.com".to_string()]),
            ..StartBrowserTaskRequest::default()
        })
        .expect("task starts")
        .task_id
}

fn flight_artifact(
    registry: &ShellxBrowserRegistry,
    task_id: &str,
    group: &str,
    attempt_index: usize,
) -> BrowserFlightRecorderArtifact {
    registry
        .export_flight_recorder(BrowserFlightRecorderExportRequest {
            task_id: Some(task_id.to_string()),
            suite_id: Some("evaluation-integration".to_string()),
            attempt_index: Some(attempt_index),
            group: Some(group.to_string()),
            reason: Some(format!("Capture {group} evidence")),
            ..BrowserFlightRecorderExportRequest::default()
        })
        .expect("Flight Recorder artifact exports")
}

fn evaluation_attempt(
    artifact: &BrowserFlightRecorderArtifact,
    group: &str,
    status: &str,
    duration_ms: u64,
    steps: usize,
) -> BrowserEvaluationAttemptInput {
    BrowserEvaluationAttemptInput {
        attempt_id: artifact.attempt_id.clone(),
        group: group.to_string(),
        task_id: artifact.task_id.clone(),
        status: status.to_string(),
        duration_ms: Some(duration_ms),
        steps: Some(steps),
        artifact_path: Some(artifact.path.clone()),
        artifact_bytes: Some(artifact.bytes as u64),
        artifact_sha256: Some(artifact.sha256.clone()),
        ..BrowserEvaluationAttemptInput::default()
    }
}

#[test]
fn evaluation_report_is_source_bound_bounded_and_reproducible() {
    let registry = ShellxBrowserRegistry::default();
    let baseline_task_id = start_task(&registry);
    let candidate_task_id = start_task(&registry);
    let baseline = flight_artifact(&registry, &baseline_task_id, "baseline", 1);
    let candidate = flight_artifact(&registry, &candidate_task_id, "candidate", 1);
    let request = BrowserEvaluationReportRequest {
        suite_id: "evaluation-integration".to_string(),
        evaluated_at_ms: EVALUATED_AT_MS,
        task_id: Some(candidate_task_id),
        baseline_label: Some("current".to_string()),
        candidate_label: Some("candidate".to_string()),
        attempts: vec![
            evaluation_attempt(&candidate, "candidate", "passed", 800, 8),
            evaluation_attempt(&baseline, "baseline", "failed", 1_200, 12),
        ],
        reason: Some("Compare exact attempt artifacts".to_string()),
    };

    let first = registry
        .write_evaluation_report(request.clone())
        .expect("evaluation report writes");
    let second = registry
        .write_evaluation_report(request)
        .expect("identical evaluation report rewrites deterministically");
    let bytes = std::fs::read(&first.path).expect("evaluation report is readable");
    let bundle: serde_json::Value =
        serde_json::from_slice(&bytes).expect("evaluation report is JSON");

    assert_eq!(first.report_id, second.report_id);
    assert_eq!(first.evidence_digest, second.evidence_digest);
    assert_eq!(first.bytes, second.bytes);
    assert_eq!(first.sha256, second.sha256);
    assert_eq!(first.bytes, bytes.len());
    assert_eq!(first.sha256, format!("{:x}", Sha256::digest(&bytes)));
    assert!(first.bytes <= 256 * 1_024);
    assert_eq!(first.attempts, 2);
    assert_eq!(first.baseline_attempts, 1);
    assert_eq!(first.candidate_attempts, 1);
    assert!(!first.evidence_complete);
    assert_eq!(first.improvement_rating, "insufficient-evidence");
    assert_eq!(bundle["schemaVersion"], "sx.evaluation.v1");
    assert_eq!(bundle["rating"]["confidence"], "insufficient");
    assert_eq!(bundle["summary"]["total"]["outcomeEvidenceComplete"], false);
    assert_eq!(bundle["evidencePolicy"]["artifactExportReceiptBound"], true);
    assert_eq!(
        bundle["evidencePolicy"]["attemptOutcomeVerificationRequired"],
        true
    );
    assert!(bundle["attempts"]
        .as_array()
        .expect("attempt array")
        .iter()
        .all(|attempt| attempt["status"] == "incomplete"
            && attempt["statusEvidence"] == "unverifiedEvaluatorDeclaration"
            && attempt["declaredStatus"].is_string()));
    assert_eq!(
        bundle["evidencePolicy"]["attemptArtifactBodiesEmbedded"],
        false
    );
    assert!(bundle["attempts"]
        .as_array()
        .expect("attempt array")
        .iter()
        .all(|attempt| attempt.get("events").is_none() && attempt.get("receipts").is_none()));
    assert_eq!(first.receipt.kind, "browserEvaluationReportWritten");

    std::fs::remove_file(&first.path).expect("evaluation report cleanup");
    std::fs::remove_file(&baseline.path).expect("baseline artifact cleanup");
    std::fs::remove_file(&candidate.path).expect("candidate artifact cleanup");
}

#[test]
fn evaluation_report_rates_empty_input_as_insufficient_evidence() {
    let registry = ShellxBrowserRegistry::default();
    let report = registry
        .write_evaluation_report(BrowserEvaluationReportRequest {
            suite_id: "empty-evaluation".to_string(),
            evaluated_at_ms: EVALUATED_AT_MS + 1,
            ..BrowserEvaluationReportRequest::default()
        })
        .expect("empty report remains a factual artifact");

    assert_eq!(report.attempts, 0);
    assert!(!report.evidence_complete);
    assert_eq!(report.improvement_rating, "insufficient-evidence");
    std::fs::remove_file(&report.path).expect("empty report cleanup");
}

#[test]
fn evaluation_report_rejects_artifacts_outside_private_flight_storage() {
    let registry = ShellxBrowserRegistry::default();
    let outside_path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("Cargo.toml");
    let bytes = std::fs::read(&outside_path).expect("Cargo manifest is readable");
    let error = registry
        .write_evaluation_report(BrowserEvaluationReportRequest {
            suite_id: "outside-artifact".to_string(),
            evaluated_at_ms: EVALUATED_AT_MS + 2,
            attempts: vec![BrowserEvaluationAttemptInput {
                attempt_id: "outside-attempt".to_string(),
                group: "baseline".to_string(),
                status: "failed".to_string(),
                artifact_path: Some(outside_path.to_string_lossy().into_owned()),
                artifact_bytes: Some(bytes.len() as u64),
                artifact_sha256: Some(format!("{:x}", Sha256::digest(&bytes))),
                ..BrowserEvaluationAttemptInput::default()
            }],
            ..BrowserEvaluationReportRequest::default()
        })
        .expect_err("non-private evidence must be rejected");

    assert!(error.contains("outside private Flight Recorder storage"));
}

#[test]
fn evaluation_report_rejects_rehashed_but_gapped_flight_evidence() {
    let registry = ShellxBrowserRegistry::default();
    let task_id = start_task(&registry);
    let artifact = flight_artifact(&registry, &task_id, "candidate", 1);
    let mut bundle: serde_json::Value = serde_json::from_slice(
        &std::fs::read(&artifact.path).expect("attempt artifact is readable"),
    )
    .expect("attempt artifact is JSON");
    bundle["summary"]["counts"]["evidenceComplete"] = serde_json::json!(false);
    bundle["summary"]["counts"]["gapCount"] = serde_json::json!(1);
    let changed = serde_json::to_vec_pretty(&bundle).expect("changed artifact encodes");
    std::fs::write(&artifact.path, &changed).expect("changed artifact writes");

    let error = registry
        .write_evaluation_report(BrowserEvaluationReportRequest {
            suite_id: "gapped-evaluation".to_string(),
            evaluated_at_ms: EVALUATED_AT_MS + 3,
            task_id: Some(task_id),
            attempts: vec![BrowserEvaluationAttemptInput {
                attempt_id: artifact.attempt_id.clone(),
                group: "candidate".to_string(),
                status: "passed".to_string(),
                artifact_path: Some(artifact.path.clone()),
                artifact_bytes: Some(changed.len() as u64),
                artifact_sha256: Some(format!("{:x}", Sha256::digest(&changed))),
                ..BrowserEvaluationAttemptInput::default()
            }],
            ..BrowserEvaluationReportRequest::default()
        })
        .expect_err("gapped evidence must not become a passing evaluation input");

    assert!(error.contains("incomplete or gapped Flight Recorder evidence"));
    std::fs::remove_file(&artifact.path).expect("attempt artifact cleanup");
}

#[test]
fn evaluation_report_rejects_self_consistent_artifact_without_export_receipt() {
    let registry = ShellxBrowserRegistry::default();
    let task_id = start_task(&registry);
    let artifact = flight_artifact(&registry, &task_id, "candidate", 1);
    let mut bundle: serde_json::Value = serde_json::from_slice(
        &std::fs::read(&artifact.path).expect("attempt artifact is readable"),
    )
    .expect("attempt artifact is JSON");
    let forged_id = "browser-attempt-self-consistent-forgery";
    bundle["attemptId"] = serde_json::json!(forged_id);
    bundle["manifest"]["attemptId"] = serde_json::json!(forged_id);
    let forged = serde_json::to_vec_pretty(&bundle).expect("forged artifact encodes");
    let forged_path = std::path::Path::new(&artifact.path)
        .parent()
        .expect("Flight Recorder artifact parent")
        .join("self-consistent-forgery.json");
    std::fs::write(&forged_path, &forged).expect("forged artifact writes");

    let error = registry
        .write_evaluation_report(BrowserEvaluationReportRequest {
            suite_id: "evaluation-integration".to_string(),
            evaluated_at_ms: EVALUATED_AT_MS + 4,
            task_id: Some(task_id),
            attempts: vec![BrowserEvaluationAttemptInput {
                attempt_id: forged_id.to_string(),
                group: "candidate".to_string(),
                status: "passed".to_string(),
                artifact_path: Some(forged_path.to_string_lossy().into_owned()),
                artifact_bytes: Some(forged.len() as u64),
                artifact_sha256: Some(format!("{:x}", Sha256::digest(&forged))),
                ..BrowserEvaluationAttemptInput::default()
            }],
            ..BrowserEvaluationReportRequest::default()
        })
        .expect_err("self-consistent artifact without host receipt must be rejected");

    assert!(error.contains("no matching Flight Recorder export receipt"));
    std::fs::remove_file(forged_path).expect("forged artifact cleanup");
    std::fs::remove_file(artifact.path).expect("attempt artifact cleanup");
}
