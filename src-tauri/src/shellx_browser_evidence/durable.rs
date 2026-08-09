use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};
use sha2::{Digest, Sha256};

const FLIGHT_ARTIFACT_FOLDER: &str = "shellx-browser-flight-recorder";
const EVALUATION_ARTIFACT_FOLDER: &str = "shellx-browser-evaluations";
const MAX_FLIGHT_ARTIFACT_BYTES: u64 = 512 * 1_024;
const MAX_EVALUATION_ARTIFACT_BYTES: u64 = 256 * 1_024;
const MAX_DURABLE_SCAN_ENTRIES_PER_ROOT: usize = 2_048;
const MAX_DURABLE_PARSE_CANDIDATES_PER_ROOT: usize = 400;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum DurableEvidenceKind {
    Attempt,
    Evaluation,
}

impl DurableEvidenceKind {
    fn schema(self) -> &'static str {
        match self {
            Self::Attempt => "sx.flightRecorder.v1",
            Self::Evaluation => "sx.evaluation.v1",
        }
    }

    fn max_bytes(self) -> u64 {
        match self {
            Self::Attempt => MAX_FLIGHT_ARTIFACT_BYTES,
            Self::Evaluation => MAX_EVALUATION_ARTIFACT_BYTES,
        }
    }
}

#[derive(Debug)]
struct DurableEvidenceRoot {
    path: PathBuf,
    kind: DurableEvidenceKind,
}

#[derive(Debug)]
struct DurableEvidenceCandidate {
    path: PathBuf,
    filename_timestamp_ms: i64,
    kind: DurableEvidenceKind,
}

#[derive(Debug, Default)]
pub(super) struct DurableEvidenceRows {
    pub(super) rows: Vec<Value>,
    pub(super) scan_truncated: bool,
    pub(super) skipped_invalid: usize,
}

pub(super) fn load_durable_browser_evidence(limit: usize) -> Result<DurableEvidenceRows, String> {
    let roots = [
        DurableEvidenceRoot {
            path: crate::shellx_browser_artifacts::browser_artifact_root(FLIGHT_ARTIFACT_FOLDER)?,
            kind: DurableEvidenceKind::Attempt,
        },
        DurableEvidenceRoot {
            path: crate::shellx_browser_artifacts::browser_artifact_root(
                EVALUATION_ARTIFACT_FOLDER,
            )?,
            kind: DurableEvidenceKind::Evaluation,
        },
    ];
    load_durable_browser_evidence_from_roots(&roots, limit)
}

fn load_durable_browser_evidence_from_roots(
    roots: &[DurableEvidenceRoot],
    limit: usize,
) -> Result<DurableEvidenceRows, String> {
    let mut candidates = Vec::new();
    let mut scan_truncated = false;
    for root in roots {
        let read_dir = match std::fs::read_dir(&root.path) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => {
                return Err(format!(
                    "read durable Browser evidence directory {} failed: {error}",
                    root.path.display()
                ));
            }
        };
        let mut root_candidates = Vec::new();
        for (index, entry) in read_dir.enumerate() {
            if index >= MAX_DURABLE_SCAN_ENTRIES_PER_ROOT {
                scan_truncated = true;
                break;
            }
            let Ok(entry) = entry else { continue };
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if !file_type.is_file() {
                continue;
            }
            let Some(timestamp) = artifact_filename_timestamp(&entry.path()) else {
                continue;
            };
            root_candidates.push(DurableEvidenceCandidate {
                path: entry.path(),
                filename_timestamp_ms: timestamp,
                kind: root.kind,
            });
        }
        root_candidates.sort_by_key(|candidate| std::cmp::Reverse(candidate.filename_timestamp_ms));
        let parse_limit = limit
            .saturating_mul(4)
            .max(limit)
            .min(MAX_DURABLE_PARSE_CANDIDATES_PER_ROOT);
        if root_candidates.len() > parse_limit {
            scan_truncated = true;
            root_candidates.truncate(parse_limit);
        }
        candidates.extend(root_candidates);
    }
    candidates.sort_by_key(|candidate| std::cmp::Reverse(candidate.filename_timestamp_ms));

    let mut rows = Vec::new();
    let mut skipped_invalid = 0usize;
    for candidate in candidates {
        match read_durable_evidence_row(&candidate) {
            Ok(Some(row)) => rows.push(row),
            Ok(None) | Err(_) => skipped_invalid = skipped_invalid.saturating_add(1),
        }
    }
    rows.sort_by(|left, right| {
        let left_t = left.get("t").and_then(Value::as_i64).unwrap_or_default();
        let right_t = right.get("t").and_then(Value::as_i64).unwrap_or_default();
        right_t.cmp(&left_t)
    });
    rows.truncate(limit);
    Ok(DurableEvidenceRows {
        rows,
        scan_truncated,
        skipped_invalid,
    })
}

fn artifact_filename_timestamp(path: &Path) -> Option<i64> {
    let stem = path.file_stem()?.to_str()?;
    let (_, timestamp) = stem.rsplit_once('-')?;
    timestamp.parse::<i64>().ok().filter(|value| *value > 0)
}

fn read_durable_evidence_row(
    candidate: &DurableEvidenceCandidate,
) -> Result<Option<Value>, String> {
    let metadata = std::fs::metadata(&candidate.path)
        .map_err(|error| format!("read durable Browser evidence metadata failed: {error}"))?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > candidate.kind.max_bytes() {
        return Ok(None);
    }
    let file = File::open(&candidate.path)
        .map_err(|error| format!("open durable Browser evidence failed: {error}"))?;
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take(candidate.kind.max_bytes() + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("read durable Browser evidence failed: {error}"))?;
    if bytes.len() as u64 != metadata.len() {
        return Ok(None);
    }
    let artifact: Value = match serde_json::from_slice(&bytes) {
        Ok(value) => value,
        Err(_) => return Ok(None),
    };
    if artifact.get("schemaVersion").and_then(Value::as_str) != Some(candidate.kind.schema()) {
        return Ok(None);
    }
    let sha256 = format!("{:x}", Sha256::digest(&bytes));
    Ok(match candidate.kind {
        DurableEvidenceKind::Attempt => durable_attempt_row(&artifact, bytes.len(), &sha256),
        DurableEvidenceKind::Evaluation => durable_evaluation_row(&artifact, bytes.len(), &sha256),
    })
}

fn durable_attempt_row(artifact: &Value, bytes: usize, sha256: &str) -> Option<Value> {
    let attempt_id = safe_identifier(artifact.get("attemptId"), 200)?;
    let created_at_ms = positive_i64(artifact.get("createdAtMs"))?;
    let manifest = artifact.get("manifest");
    if manifest
        .and_then(|value| value.get("attemptId"))
        .and_then(Value::as_str)
        != Some(attempt_id)
        || manifest
            .and_then(|value| value.get("source"))
            .and_then(Value::as_str)
            != Some("shellx-browser-flight-recorder")
        || !attempt_redaction_receipt_is_safe(artifact)
    {
        return None;
    }
    let task_id = safe_optional_identifier(manifest.and_then(|value| value.get("taskId")), 200);
    let browser_tab_id =
        safe_optional_identifier(manifest.and_then(|value| value.get("browserTabId")), 200);
    let counts = artifact
        .get("summary")
        .and_then(|value| value.get("counts"));
    Some(json!({
        "receiptId": format!("durable-evidence-{}", &sha256[..24]),
        "kind": "browserFlightRecorderExported",
        "taskId": task_id,
        "summary": format!("Stored Browser Flight Recorder attempt: {attempt_id}"),
        "t": created_at_ms,
        "evidence": {
            "attemptId": attempt_id,
            "taskId": task_id,
            "browserTabId": browser_tab_id,
            "bytes": bytes,
            "sha256": sha256,
            "events": bounded_u64(counts.and_then(|value| value.get("events"))),
            "receipts": bounded_u64(counts.and_then(|value| value.get("receipts"))),
            "droppedEvents": bounded_u64(counts.and_then(|value| value.get("droppedEvents"))),
            "droppedReceipts": bounded_u64(counts.and_then(|value| value.get("droppedReceipts"))),
            "retentionDroppedEvents": bounded_u64(counts.and_then(|value| value.get("retentionDroppedEvents"))),
            "retentionDroppedReceipts": bounded_u64(counts.and_then(|value| value.get("retentionDroppedReceipts"))),
            "gapCount": bounded_u64(counts.and_then(|value| value.get("gapCount"))),
            "evidenceComplete": counts.and_then(|value| value.get("evidenceComplete")).and_then(Value::as_bool),
            "source": "shellx-browser-flight-recorder",
        },
    }))
}

fn durable_evaluation_row(artifact: &Value, bytes: usize, sha256: &str) -> Option<Value> {
    let report_id = safe_identifier(artifact.get("reportId"), 200)?;
    let evaluated_at_ms = positive_i64(artifact.get("evaluatedAtMs"))?;
    let manifest = artifact.get("manifest");
    let evidence_policy = artifact.get("evidencePolicy");
    if manifest
        .and_then(|value| value.get("source"))
        .and_then(Value::as_str)
        != Some("shellx-browser-evaluations")
        || evidence_policy
            .and_then(|value| value.get("artifactIdentityVerified"))
            .and_then(Value::as_bool)
            != Some(true)
        || evidence_policy
            .and_then(|value| value.get("missingEvidenceFailsClosed"))
            .and_then(Value::as_bool)
            != Some(true)
    {
        return None;
    }
    let evidence_digest = safe_sha256(artifact.get("evidenceDigest"))?;
    let task_id = safe_optional_identifier(manifest.and_then(|value| value.get("taskId")), 200);
    let summary = artifact.get("summary");
    let rating = artifact.get("rating");
    let measurement = artifact.get("measurement");
    Some(json!({
        "receiptId": format!("durable-evidence-{}", &sha256[..24]),
        "kind": "browserEvaluationReportWritten",
        "taskId": task_id,
        "summary": format!("Stored Browser evaluation report: {report_id}"),
        "t": evaluated_at_ms,
        "evidence": {
            "reportId": report_id,
            "suiteId": safe_optional_identifier(manifest.and_then(|value| value.get("suiteId")), 200),
            "taskId": task_id,
            "bytes": bytes,
            "sha256": sha256,
            "evidenceDigest": evidence_digest,
            "baselineAttempts": bounded_u64(summary.and_then(|value| value.get("baseline")).and_then(|value| value.get("attempts"))),
            "candidateAttempts": bounded_u64(summary.and_then(|value| value.get("candidate")).and_then(|value| value.get("attempts"))),
            "safetyViolationDelta": bounded_i64(measurement.and_then(|value| value.get("safetyViolationDelta"))),
            "improvementScore": bounded_i64(rating.and_then(|value| value.get("score"))),
            "improvementRating": safe_optional_identifier(rating.and_then(|value| value.get("result")), 80),
            "evidenceComplete": summary.and_then(|value| value.get("total")).and_then(|value| value.get("evidenceComplete")).and_then(Value::as_bool),
            "source": "shellx-browser-evaluations",
        },
    }))
}

fn attempt_redaction_receipt_is_safe(artifact: &Value) -> bool {
    let report = artifact.get("redactionReport");
    let excludes = [
        "rawSecrets",
        "cookies",
        "authorizationHeaders",
        "localStorageValues",
        "sessionStorageValues",
        "networkBodies",
        "queryAndFragmentRetained",
    ]
    .into_iter()
    .all(|field| {
        report
            .and_then(|value| value.get(field))
            .and_then(Value::as_bool)
            == Some(false)
    });
    excludes
        && report
            .and_then(|value| value.get("urlValuesSanitized"))
            .and_then(Value::as_bool)
            == Some(true)
        && report
            .and_then(|value| value.get("credentialPatternsRedacted"))
            .and_then(Value::as_bool)
            == Some(true)
        && artifact
            .get("evidencePolicy")
            .and_then(|value| value.get("rawBrowserStateIncluded"))
            .and_then(Value::as_bool)
            == Some(false)
}

fn safe_identifier(value: Option<&Value>, max_chars: usize) -> Option<&str> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| {
            !value.is_empty()
                && value.chars().count() <= max_chars
                && !value.chars().any(char::is_control)
        })
}

fn safe_optional_identifier(value: Option<&Value>, max_chars: usize) -> Option<&str> {
    value
        .filter(|value| !value.is_null())
        .and_then(|value| safe_identifier(Some(value), max_chars))
}

fn safe_sha256(value: Option<&Value>) -> Option<&str> {
    safe_identifier(value, 64).filter(|value| {
        value.len() == 64 && value.chars().all(|character| character.is_ascii_hexdigit())
    })
}

fn positive_i64(value: Option<&Value>) -> Option<i64> {
    value.and_then(Value::as_i64).filter(|value| *value > 0)
}

fn bounded_u64(value: Option<&Value>) -> Option<u64> {
    value
        .and_then(Value::as_u64)
        .filter(|value| *value <= 1_000_000_000)
}

fn bounded_i64(value: Option<&Value>) -> Option<i64> {
    value
        .and_then(Value::as_i64)
        .filter(|value| value.unsigned_abs() <= 1_000_000_000)
}

#[cfg(test)]
mod tests {
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
}
