use super::*;

fn write_json(path: &Path, value: &Value) {
    std::fs::write(
        path,
        serde_json::to_vec_pretty(value).expect("encode fixture"),
    )
    .expect("write fixture");
}

#[test]
fn durable_evidence_recovers_hash_verified_attempt_and_evaluation_rows() {
    let temp = tempfile::tempdir().expect("tempdir");
    let attempts = temp.path().join("attempts");
    let evaluations = temp.path().join("evaluations");
    std::fs::create_dir_all(&attempts).expect("attempt dir");
    std::fs::create_dir_all(&evaluations).expect("evaluation dir");
    write_json(
        &attempts.join("browser-attempt-fixture-100.json"),
        &json!({
            "schemaVersion": "sx.flightRecorder.v1",
            "attemptId": "browser-attempt-fixture",
            "createdAtMs": 100,
            "manifest": {
                "attemptId": "browser-attempt-fixture",
                "taskId": "task-1",
                "browserTabId": "tab-1",
                "source": "shellx-browser-flight-recorder"
            },
            "summary": { "counts": { "events": 3, "receipts": 2, "droppedEvents": 0, "droppedReceipts": 1 } },
            "redactionReport": {
                "rawSecrets": false,
                "cookies": false,
                "authorizationHeaders": false,
                "localStorageValues": false,
                "sessionStorageValues": false,
                "networkBodies": false,
                "queryAndFragmentRetained": false,
                "urlValuesSanitized": true,
                "credentialPatternsRedacted": true
            },
            "evidencePolicy": { "rawBrowserStateIncluded": false }
        }),
    );
    write_json(
        &evaluations.join("browser-eval-fixture-200.json"),
        &json!({
            "schemaVersion": "sx.evaluation.v1",
            "reportId": "browser-eval-fixture",
            "evidenceDigest": "a".repeat(64),
            "evaluatedAtMs": 200,
            "manifest": { "suiteId": "suite-1", "taskId": "task-1", "source": "shellx-browser-evaluations" },
            "summary": {
                "baseline": { "attempts": 1 },
                "candidate": { "attempts": 1 },
                "total": { "evidenceComplete": true }
            },
            "measurement": { "safetyViolationDelta": -1 },
            "rating": { "score": 25, "result": "improved" },
            "evidencePolicy": { "artifactIdentityVerified": true, "missingEvidenceFailsClosed": true }
        }),
    );

    let recovered = load_durable_browser_evidence_from_roots(
        &[
            DurableEvidenceRoot {
                path: attempts,
                kind: DurableEvidenceKind::Attempt,
            },
            DurableEvidenceRoot {
                path: evaluations,
                kind: DurableEvidenceKind::Evaluation,
            },
        ],
        20,
    )
    .expect("recover evidence");

    assert_eq!(recovered.rows.len(), 2);
    assert_eq!(recovered.skipped_invalid, 0);
    assert_eq!(recovered.rows[0]["kind"], "browserEvaluationReportWritten");
    assert_eq!(recovered.rows[0]["evidence"]["evidenceComplete"], true);
    assert_eq!(recovered.rows[1]["kind"], "browserFlightRecorderExported");
    assert_eq!(recovered.rows[1]["evidence"]["events"], 3);
    for row in recovered.rows {
        assert_eq!(row["evidence"]["sha256"].as_str().map(str::len), Some(64));
        assert!(row["evidence"]["bytes"]
            .as_u64()
            .is_some_and(|bytes| bytes > 0));
    }
}

#[test]
fn durable_evidence_rejects_artifacts_without_safe_redaction_receipts() {
    let temp = tempfile::tempdir().expect("tempdir");
    write_json(
        &temp.path().join("browser-attempt-unsafe-100.json"),
        &json!({
            "schemaVersion": "sx.flightRecorder.v1",
            "attemptId": "browser-attempt-unsafe",
            "createdAtMs": 100,
            "manifest": { "attemptId": "browser-attempt-unsafe", "source": "shellx-browser-flight-recorder" },
            "redactionReport": { "rawSecrets": true },
            "evidencePolicy": { "rawBrowserStateIncluded": false }
        }),
    );

    let recovered = load_durable_browser_evidence_from_roots(
        &[DurableEvidenceRoot {
            path: temp.path().to_path_buf(),
            kind: DurableEvidenceKind::Attempt,
        }],
        20,
    )
    .expect("scan succeeds safely");

    assert!(recovered.rows.is_empty());
    assert_eq!(recovered.skipped_invalid, 1);
}
