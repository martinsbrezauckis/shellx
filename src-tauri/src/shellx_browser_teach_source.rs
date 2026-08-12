//! Flight Recorder source verification and deterministic Teach extraction.

use std::collections::BTreeSet;
use std::io::Read;

use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::shellx_browser::clean_string;

use super::*;

type ExtractedTeachBundle = (
    Vec<BrowserTeachStep>,
    Vec<BrowserTeachValue>,
    Vec<BrowserTeachIssue>,
    Vec<BrowserTeachIssue>,
);

pub(super) fn verify_teach_source(
    state: &BrowserState,
    attempt_id: &str,
    authority: BrowserTaskControlAuthority,
    caller_session_id: Option<&str>,
) -> Result<VerifiedTeachSource, String> {
    let receipt = state
        .receipts
        .iter()
        .rev()
        .find(|receipt| {
            receipt.kind == "browserFlightRecorderExported"
                && receipt.evidence.get("attemptId").and_then(Value::as_str) == Some(attempt_id)
        })
        .ok_or_else(|| "Teach source has no matching Flight Recorder export receipt".to_string())?;
    let task_id = receipt
        .task_id
        .as_deref()
        .ok_or_else(|| "Teach source receipt is not task-owned".to_string())?;
    ensure_browser_task_control_authority_for_teach(state, task_id, authority, caller_session_id)?;
    let expected_bytes = receipt
        .evidence
        .get("bytes")
        .and_then(Value::as_u64)
        .filter(|bytes| *bytes > 0 && *bytes <= MAX_FLIGHT_ARTIFACT_BYTES)
        .ok_or_else(|| {
            "Teach source receipt has an invalid Flight Recorder byte identity".to_string()
        })?;
    let expected_sha256 = safe_sha256(
        receipt
            .evidence
            .get("sha256")
            .and_then(Value::as_str)
            .ok_or_else(|| "Teach source receipt has no Flight Recorder digest".to_string())?,
        "source digest",
    )?;
    if receipt
        .evidence
        .get("evidenceComplete")
        .and_then(Value::as_bool)
        != Some(true)
    {
        return Err("Teach source Flight Recorder evidence is incomplete or gapped".to_string());
    }
    let receipt_path = receipt
        .evidence
        .get("path")
        .and_then(Value::as_str)
        .ok_or_else(|| "Teach source receipt has no private artifact identity".to_string())?;
    let artifact =
        read_verified_private_flight_artifact(receipt_path, expected_bytes, &expected_sha256)?;
    if artifact.get("schemaVersion").and_then(Value::as_str) != Some("sx.flightRecorder.v1")
        || artifact.get("attemptId").and_then(Value::as_str) != Some(attempt_id)
    {
        return Err("Teach source is not the matching Flight Recorder artifact".to_string());
    }
    if artifact
        .get("summary")
        .and_then(|summary| summary.get("counts"))
        .and_then(|counts| counts.get("evidenceComplete"))
        .and_then(Value::as_bool)
        != Some(true)
    {
        return Err("Teach source Flight Recorder artifact is incomplete or gapped".to_string());
    }
    for field in [
        "rawSecrets",
        "cookies",
        "authorizationHeaders",
        "localStorageValues",
        "sessionStorageValues",
        "networkBodies",
        "queryAndFragmentRetained",
        "httpPathValuesRetained",
        "screenshotsIncluded",
        "domSnapshotsIncluded",
    ] {
        if artifact
            .get("redactionReport")
            .and_then(|report| report.get(field))
            .and_then(Value::as_bool)
            != Some(false)
        {
            return Err(format!(
                "Teach source lacks the required {field} redaction receipt"
            ));
        }
    }
    let manifest = artifact
        .get("manifest")
        .and_then(Value::as_object)
        .ok_or_else(|| "Teach source Flight Recorder manifest is malformed".to_string())?;
    let artifact_task_id = manifest
        .get("taskId")
        .and_then(Value::as_str)
        .ok_or_else(|| "Teach source Flight Recorder manifest has no task identity".to_string())?;
    let browser_tab_id = manifest
        .get("browserTabId")
        .and_then(Value::as_str)
        .ok_or_else(|| "Teach source Flight Recorder manifest has no tab identity".to_string())?;
    if artifact_task_id != task_id {
        return Err("Teach source task identity does not match its export receipt".to_string());
    }
    let task = state
        .tasks
        .iter()
        .find(|task| task.task_id == task_id)
        .ok_or_else(|| "Teach source task no longer exists".to_string())?;
    if task.status != "completed" {
        return Err("Teach requires one successfully completed Browser task".to_string());
    }
    let tab_matches = state
        .tabs
        .iter()
        .any(|tab| tab.browser_tab_id == browser_tab_id && tab.task_id.as_deref() == Some(task_id));
    if !tab_matches {
        return Err("Teach source task and Browser tab ownership do not match".to_string());
    }
    let owner_session_id = task.owner_session_id.as_deref().unwrap_or("operator");
    if manifest.get("ownerSessionId").and_then(Value::as_str) != Some(owner_session_id) {
        return Err(
            "Teach source owner-session identity does not match current task ownership".to_string(),
        );
    }
    let source_created_at_ms = artifact
        .get("createdAtMs")
        .and_then(Value::as_i64)
        .filter(|value| *value > 0)
        .ok_or_else(|| "Teach source Flight Recorder creation time is invalid".to_string())?;
    let receipts = artifact
        .get("receipts")
        .and_then(Value::as_array)
        .ok_or_else(|| "Teach source Flight Recorder receipts are malformed".to_string())?;
    let events = artifact
        .get("events")
        .and_then(Value::as_array)
        .ok_or_else(|| "Teach source Flight Recorder events are malformed".to_string())?;
    if receipts.len() > 160 || events.len() > 320 {
        return Err("Teach source exceeds Flight Recorder input bounds".to_string());
    }
    Ok(VerifiedTeachSource {
        source: BrowserTeachSource {
            attempt_id: attempt_id.to_string(),
            task_id: task_id.to_string(),
            browser_tab_id: browser_tab_id.to_string(),
            bytes: expected_bytes,
            sha256: expected_sha256,
            created_at_ms: source_created_at_ms,
            owner_session_id: owner_session_id.to_string(),
            evidence_complete: true,
        },
        artifact,
        goal: sanitize_teach_text(&task.goal, "task goal", 300)?,
    })
}

fn read_verified_private_flight_artifact(
    path: &str,
    expected_bytes: u64,
    expected_sha256: &str,
) -> Result<Value, String> {
    let root = crate::shellx_browser_artifacts::browser_artifact_root(FLIGHT_ARTIFACT_FOLDER)?;
    let root = std::fs::canonicalize(&root)
        .map_err(|_| "Teach source private Flight Recorder storage is unavailable".to_string())?;
    let canonical = std::fs::canonicalize(path)
        .map_err(|_| "Teach source private Flight Recorder artifact is unavailable".to_string())?;
    if !canonical.starts_with(&root) {
        return Err("Teach source is outside private Flight Recorder storage".to_string());
    }
    let metadata = std::fs::metadata(&canonical)
        .map_err(|_| "Teach source Flight Recorder metadata is unavailable".to_string())?;
    if !metadata.is_file() || metadata.len() != expected_bytes {
        return Err("Teach source Flight Recorder byte identity does not match".to_string());
    }
    let file = std::fs::File::open(&canonical)
        .map_err(|_| "Teach source Flight Recorder artifact cannot be opened".to_string())?;
    let mut bytes = Vec::with_capacity(expected_bytes as usize);
    file.take(MAX_FLIGHT_ARTIFACT_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "Teach source Flight Recorder artifact cannot be read".to_string())?;
    if bytes.len() as u64 != expected_bytes || hash_bytes(&bytes) != expected_sha256 {
        return Err("Teach source Flight Recorder digest identity does not match".to_string());
    }
    serde_json::from_slice(&bytes)
        .map_err(|_| "Teach source Flight Recorder artifact is malformed JSON".to_string())
}

pub(super) fn extract_teach_bundle(
    bundle_id: &str,
    artifact: &Value,
) -> Result<ExtractedTeachBundle, String> {
    let receipts = artifact
        .get("receipts")
        .and_then(Value::as_array)
        .ok_or_else(|| "Teach source receipts are malformed".to_string())?;
    let mut steps = Vec::new();
    let mut values = Vec::new();
    let mut ambiguities = Vec::new();
    let mut loss = Vec::new();
    let mut evidence_refs = 0usize;
    let mut seen_sequences = BTreeSet::new();
    for receipt in receipts {
        let sequence = receipt
            .get("sourceSequence")
            .and_then(Value::as_u64)
            .filter(|sequence| *sequence > 0)
            .ok_or_else(|| {
                "Teach source has a receipt without a durable source sequence".to_string()
            })?;
        if !seen_sequences.insert(sequence) {
            return Err("Teach source receipt sequences are not unique".to_string());
        }
        let receipt_id = receipt
            .get("receiptId")
            .and_then(Value::as_str)
            .ok_or_else(|| "Teach source has a receipt without an identity".to_string())?;
        let kind = receipt
            .get("kind")
            .and_then(Value::as_str)
            .ok_or_else(|| "Teach source has a receipt without a kind".to_string())?;
        let evidence = receipt.get("evidence").unwrap_or(&Value::Null);
        let maybe_step = match kind {
            "browserNavigated" | "browserUserNavigated" => teach_navigation_step(
                bundle_id,
                sequence,
                receipt_id,
                evidence,
                &mut values,
                &mut ambiguities,
            )?,
            "browserEngineActionApplied" => teach_engine_step(
                bundle_id,
                sequence,
                receipt_id,
                evidence,
                &mut values,
                &mut ambiguities,
            )?,
            "browserFindTextCompleted" => teach_find_step(
                bundle_id,
                sequence,
                receipt_id,
                evidence,
                &mut values,
                &mut ambiguities,
            )?,
            "browserVerificationPassed" | "browserVerificationFailed" => {
                teach_verification_step(bundle_id, sequence, receipt_id, evidence)
            }
            _ if teach_noise_receipt(kind) => None,
            _ => {
                push_teach_issue(
                    &mut loss,
                    bundle_id,
                    "unsupportedOperation",
                    true,
                    Some(sequence),
                    "A receipted Browser operation has no Action Recipe V2 projection",
                )?;
                None
            }
        };
        let Some(step) = maybe_step else {
            continue;
        };
        if is_repeated_transport_step(steps.last(), &step) {
            continue;
        }
        if steps.len() >= MAX_TEACH_STEPS {
            return Err(format!(
                "Teach source exceeds the {MAX_TEACH_STEPS} step budget"
            ));
        }
        evidence_refs += step.evidence_refs.len();
        if evidence_refs > MAX_TEACH_EVIDENCE_REFS {
            return Err(format!(
                "Teach source exceeds the {MAX_TEACH_EVIDENCE_REFS} evidence-reference budget"
            ));
        }
        steps.push(step);
    }
    if steps.is_empty() {
        push_teach_issue(
            &mut ambiguities,
            bundle_id,
            "noReplayableSteps",
            true,
            None,
            "The completed attempt contains no supported receipted Browser operation",
        )?;
    }
    if values.len() > MAX_TEACH_VALUES {
        return Err(format!(
            "Teach source exceeds the {MAX_TEACH_VALUES} named-value budget"
        ));
    }
    Ok((steps, values, ambiguities, loss))
}

fn teach_navigation_step(
    bundle_id: &str,
    sequence: u64,
    receipt_id: &str,
    evidence: &Value,
    values: &mut Vec<BrowserTeachValue>,
    ambiguities: &mut Vec<BrowserTeachIssue>,
) -> Result<Option<BrowserTeachStep>, String> {
    let Some(url) = sanitized_url_from_evidence(evidence.get("url")) else {
        push_teach_issue(
            ambiguities,
            bundle_id,
            "missingNavigationTarget",
            true,
            Some(sequence),
            "Navigation evidence has no sanitized reusable URL target",
        )?;
        return Ok(None);
    };
    // The Flight Recorder intentionally replaces every HTTP path with a
    // placeholder. Keep that placeholder as an explicitly named editable URL
    // value, but never treat it as a replay target until the operator supplies
    // a valid safe HTTP(S) URL in a later CAS revision.
    let value_id = add_literal_value(
        values,
        bundle_id,
        sequence,
        receipt_id,
        "Navigation URL",
        &url,
    )?;
    if url.contains("[redacted-path]") {
        push_teach_issue(
            ambiguities,
            bundle_id,
            "redactedNavigationPath",
            true,
            Some(sequence),
            "Navigation path is redacted; replace the named URL value with a safe HTTP(S) URL",
        )?;
    }
    let step_id = deterministic_id("teach-step", [bundle_id, &sequence.to_string(), receipt_id]);
    Ok(Some(BrowserTeachStep {
        step_id: step_id.clone(),
        source_sequence: sequence,
        operation: "navigate".to_string(),
        classification: "action".to_string(),
        target_ref: Some(url.clone()),
        value_refs: vec![value_id],
        assertion_refs: Vec::new(),
        decision_point_refs: Vec::new(),
        evidence_refs: vec![receipt_id.to_string()],
        recipe_step: json!({
            "stepId": step_id,
            "sourceReceiptId": receipt_id,
            "sourceSequence": sequence,
            "action": "navigate",
            "url": url,
            "queryRetained": false,
            "fragmentRetained": false,
        }),
    }))
}

fn teach_engine_step(
    bundle_id: &str,
    sequence: u64,
    receipt_id: &str,
    evidence: &Value,
    values: &mut Vec<BrowserTeachValue>,
    ambiguities: &mut Vec<BrowserTeachIssue>,
) -> Result<Option<BrowserTeachStep>, String> {
    let Some(operation) = evidence.get("action").and_then(Value::as_str) else {
        push_teach_issue(
            ambiguities,
            bundle_id,
            "missingOperation",
            true,
            Some(sequence),
            "Engine action evidence has no supported operation",
        )?;
        return Ok(None);
    };
    if !supported_engine_operation(operation) {
        push_teach_issue(
            ambiguities,
            bundle_id,
            "unsupportedOperation",
            true,
            Some(sequence),
            "Engine action is not supported by deterministic Action Recipe V2 projection",
        )?;
        return Ok(None);
    }
    let ref_id = safe_optional_identifier_value(evidence.get("refId"), 200);
    let selector = safe_optional_selector(evidence.get("selector"));
    let needs_target = matches!(
        operation,
        "click" | "clickRef" | "fillRef" | "select" | "press"
    );
    if needs_target && ref_id.is_none() && selector.is_none() {
        push_teach_issue(
            ambiguities,
            bundle_id,
            "missingTarget",
            true,
            Some(sequence),
            "A user-visible action has no sanitized selector or stable reference",
        )?;
        return Ok(None);
    }
    let step_id = deterministic_id("teach-step", [bundle_id, &sequence.to_string(), receipt_id]);
    let mut recipe_step = json!({
        "stepId": step_id,
        "sourceReceiptId": receipt_id,
        "sourceSequence": sequence,
        "action": operation,
        "refId": ref_id,
        "selector": selector,
    });
    for key in ["timeoutMs", "force", "x", "y", "key"] {
        if let Some(value) = evidence.get(key) {
            if safe_replay_scalar(key, value) {
                recipe_step[key] = value.clone();
            }
        }
    }
    let input_operation = matches!(operation, "fillRef" | "type" | "select");
    let mut value_refs = Vec::new();
    if operation == "press" {
        if recipe_step.get("key").and_then(Value::as_str).is_none() {
            push_teach_issue(
                ambiguities,
                bundle_id,
                "missingPressKey",
                true,
                Some(sequence),
                "Press evidence has no bounded reusable key",
            )?;
            return Ok(None);
        }
        // A key such as Enter/Escape is already bounded Flight Recorder
        // evidence. It is not typed form input and must not demand a Vault
        // binding just to replay a normal keyboard action.
        recipe_step["valueRedacted"] = json!(false);
    } else if input_operation {
        let value_id = add_vault_value(values, bundle_id, sequence, receipt_id, operation)?;
        value_refs.push(value_id);
        recipe_step["valueRedacted"] = json!(true);
        recipe_step["valueRef"] = json!("vault-binding-required");
    } else if matches!(operation, "waitFor" | "scroll" | "verify") {
        if let Some(value) = evidence.get("value").and_then(Value::as_str) {
            let value = sanitize_teach_text(value, "action value", 128)?;
            let value_id =
                add_literal_value(values, bundle_id, sequence, receipt_id, "Value", &value)?;
            value_refs.push(value_id);
            recipe_step["value"] = json!(value);
            recipe_step["valueRedacted"] = json!(false);
        } else if evidence.get("value").is_some() {
            recipe_step["valueRedacted"] = json!(true);
        }
    }
    let target_ref = ref_id.or(selector);
    Ok(Some(BrowserTeachStep {
        step_id,
        source_sequence: sequence,
        operation: operation.to_string(),
        classification: if operation == "verify" || operation == "waitFor" {
            "read".to_string()
        } else if operation == "scroll" {
            "derive".to_string()
        } else {
            "action".to_string()
        },
        target_ref,
        value_refs,
        assertion_refs: if operation == "verify" {
            vec![receipt_id.to_string()]
        } else {
            Vec::new()
        },
        decision_point_refs: Vec::new(),
        evidence_refs: vec![receipt_id.to_string()],
        recipe_step,
    }))
}

fn teach_find_step(
    bundle_id: &str,
    sequence: u64,
    receipt_id: &str,
    evidence: &Value,
    values: &mut Vec<BrowserTeachValue>,
    ambiguities: &mut Vec<BrowserTeachIssue>,
) -> Result<Option<BrowserTeachStep>, String> {
    let query = evidence
        .get("findResult")
        .and_then(|result| result.get("query"))
        .and_then(Value::as_str);
    let Some(query) = query else {
        push_teach_issue(
            ambiguities,
            bundle_id,
            "redactedSearchQuery",
            true,
            Some(sequence),
            "Search evidence is redacted and requires an operator-supplied value",
        )?;
        return Ok(None);
    };
    let query = sanitize_teach_text(query, "search query", 128)?;
    let value_id = add_literal_value(values, bundle_id, sequence, receipt_id, "Search", &query)?;
    let step_id = deterministic_id("teach-step", [bundle_id, &sequence.to_string(), receipt_id]);
    Ok(Some(BrowserTeachStep {
        step_id: step_id.clone(),
        source_sequence: sequence,
        operation: "findText".to_string(),
        classification: "read".to_string(),
        target_ref: None,
        value_refs: vec![value_id],
        assertion_refs: Vec::new(),
        decision_point_refs: Vec::new(),
        evidence_refs: vec![receipt_id.to_string()],
        recipe_step: json!({
            "stepId": step_id,
            "sourceReceiptId": receipt_id,
            "sourceSequence": sequence,
            "action": "findText",
            "query": query,
            "queryRedacted": false,
        }),
    }))
}

fn teach_verification_step(
    bundle_id: &str,
    sequence: u64,
    receipt_id: &str,
    evidence: &Value,
) -> Option<BrowserTeachStep> {
    let verification = evidence.get("verification").unwrap_or(&Value::Null);
    let selector = safe_optional_selector(verification.get("selector"));
    let expectation_type = verification
        .get("expectationType")
        .and_then(Value::as_str)
        .and_then(|value| sanitize_teach_text(value, "expectation type", 80).ok());
    let step_id = deterministic_id("teach-step", [bundle_id, &sequence.to_string(), receipt_id]);
    Some(BrowserTeachStep {
        step_id: step_id.clone(),
        source_sequence: sequence,
        operation: "verify".to_string(),
        classification: "read".to_string(),
        target_ref: selector.clone(),
        value_refs: Vec::new(),
        assertion_refs: vec![receipt_id.to_string()],
        decision_point_refs: Vec::new(),
        evidence_refs: vec![receipt_id.to_string()],
        recipe_step: json!({
            "stepId": step_id,
            "sourceReceiptId": receipt_id,
            "sourceSequence": sequence,
            "action": "verify",
            "selector": selector,
            "expectationType": expectation_type.unwrap_or_else(|| "element".to_string()),
            "checkedTextRedacted": true,
        }),
    })
}

fn add_literal_value(
    values: &mut Vec<BrowserTeachValue>,
    bundle_id: &str,
    sequence: u64,
    receipt_id: &str,
    prefix: &str,
    literal: &str,
) -> Result<String, String> {
    if let Some(existing) = values
        .iter_mut()
        .find(|value| value.kind == "sanitizedLiteral" && value.literal.as_deref() == Some(literal))
    {
        if !existing
            .source_evidence_refs
            .iter()
            .any(|evidence_ref| evidence_ref == receipt_id)
        {
            existing.source_evidence_refs.push(receipt_id.to_string());
        }
        return Ok(existing.value_id.clone());
    }
    if values.len() >= MAX_TEACH_VALUES {
        return Err(format!(
            "Teach source exceeds the {MAX_TEACH_VALUES} named-value budget"
        ));
    }
    let value_id = deterministic_id(
        "teach-value",
        [bundle_id, &sequence.to_string(), receipt_id],
    );
    values.push(BrowserTeachValue {
        value_id: value_id.clone(),
        label: format!("{prefix} {sequence}"),
        kind: "sanitizedLiteral".to_string(),
        literal: Some(literal.to_string()),
        required_vault_binding: false,
        source_evidence_refs: vec![receipt_id.to_string()],
    });
    Ok(value_id)
}

fn add_vault_value(
    values: &mut Vec<BrowserTeachValue>,
    bundle_id: &str,
    sequence: u64,
    receipt_id: &str,
    operation: &str,
) -> Result<String, String> {
    if values.len() >= MAX_TEACH_VALUES {
        return Err(format!(
            "Teach source exceeds the {MAX_TEACH_VALUES} named-value budget"
        ));
    }
    let value_id = deterministic_id(
        "teach-value",
        [bundle_id, &sequence.to_string(), receipt_id],
    );
    values.push(BrowserTeachValue {
        value_id: value_id.clone(),
        label: format!("{operation} input {sequence}"),
        kind: "vaultBinding".to_string(),
        literal: None,
        required_vault_binding: true,
        source_evidence_refs: vec![receipt_id.to_string()],
    });
    Ok(value_id)
}

fn push_teach_issue(
    issues: &mut Vec<BrowserTeachIssue>,
    bundle_id: &str,
    code: &str,
    blocking: bool,
    source_sequence: Option<u64>,
    detail: &str,
) -> Result<(), String> {
    if issues.len() >= MAX_TEACH_ISSUES {
        return Err(format!(
            "Teach source exceeds the {MAX_TEACH_ISSUES} ambiguity/loss budget"
        ));
    }
    let sequence = source_sequence.unwrap_or_default().to_string();
    issues.push(BrowserTeachIssue {
        issue_id: deterministic_id("teach-issue", [bundle_id, code, &sequence, detail]),
        code: code.to_string(),
        blocking,
        source_sequence,
        detail: detail.to_string(),
    });
    Ok(())
}

fn supported_engine_operation(operation: &str) -> bool {
    matches!(
        operation,
        "click"
            | "clickRef"
            | "clickAt"
            | "fillRef"
            | "type"
            | "select"
            | "press"
            | "waitFor"
            | "scroll"
            | "verify"
            | "goBack"
            | "goForward"
            | "reload"
    )
}

fn teach_noise_receipt(kind: &str) -> bool {
    kind.starts_with("browserTask")
        || kind.starts_with("browserTab")
        || kind.starts_with("browserProfile")
        || kind.starts_with("browserWindow")
        || kind.starts_with("browserNetwork")
        || kind.starts_with("browserCdp")
        || kind.starts_with("browserDeveloper")
        || kind.starts_with("browserConsole")
        || kind.starts_with("browserWorkflow")
        || kind.starts_with("browserFlightRecorder")
        || kind.starts_with("browserTeach")
        || matches!(
            kind,
            "browserEngineMounted"
                | "browserEngineNavigated"
                | "browserEngineLoaded"
                | "browserEngineObserved"
                | "browserTextExtracted"
                | "browserMarkdownExtracted"
                | "browserScreenshotCaptured"
                | "browserHarExported"
                | "browserPerformanceExported"
                | "browserTraceBundleExported"
                | "browserReportWritten"
        )
        || kind == "browserRecipeExported"
        || kind == "browserRecipeReplayCompleted"
        || kind == "browserRecipeReplayIncomplete"
}

fn is_repeated_transport_step(
    previous: Option<&BrowserTeachStep>,
    step: &BrowserTeachStep,
) -> bool {
    previous.is_some_and(|previous| {
        previous.operation == "waitFor"
            && step.operation == "waitFor"
            && previous.target_ref == step.target_ref
            && previous.value_refs == step.value_refs
    })
}

fn safe_replay_scalar(key: &str, value: &Value) -> bool {
    match key {
        "timeoutMs" => value.as_u64().is_some(),
        "force" => value.as_bool().is_some(),
        "x" | "y" => value.as_f64().is_some(),
        "key" => value
            .as_str()
            .and_then(|value| sanitize_teach_text(value, "action key", 80).ok())
            .is_some(),
        _ => false,
    }
}

fn safe_optional_identifier_value(value: Option<&Value>, max: usize) -> Option<String> {
    value
        .and_then(Value::as_str)
        .and_then(|value| safe_identifier(value, "reference", max).ok())
}

fn safe_optional_selector(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .and_then(|value| sanitize_teach_text(value, "selector", 240).ok())
}

fn sanitized_url_from_evidence(value: Option<&Value>) -> Option<String> {
    let value = value?;
    let raw = value
        .as_str()
        .or_else(|| value.get("url").and_then(Value::as_str))?;
    let safe = crate::shellx_browser::safe_url_parts(raw);
    let origin = safe.origin?;
    if !(origin.starts_with("https://") || origin.starts_with("http://")) {
        return None;
    }
    let path = safe
        .path
        .as_deref()
        .filter(|path| path.starts_with("/[redacted"));
    Some(format!(
        "{}{}",
        origin.trim_end_matches('/'),
        path.unwrap_or("/[redacted-path]")
    ))
}

pub(super) fn sanitize_teach_text(value: &str, label: &str, max: usize) -> Result<String, String> {
    let value = clean_string(value);
    if value.is_empty() || value.chars().count() > max || value.chars().any(char::is_control) {
        return Err(format!(
            "Teach {label} is empty or exceeds its bounded text budget"
        ));
    }
    if looks_like_private_path(&value) {
        return Err(format!("Teach {label} must not contain a private path"));
    }
    if crate::host_mcp::redact_if_credential_pattern(&value) {
        return Err(format!("Teach {label} must not contain a literal secret"));
    }
    Ok(value)
}

pub(super) fn sanitize_teach_identifier(
    value: &str,
    label: &str,
    max: usize,
) -> Result<String, String> {
    let value = safe_identifier(value, label, max)?;
    if looks_like_private_path(&value) {
        return Err(format!("Teach {label} must not contain a private path"));
    }
    Ok(value)
}

pub(super) fn safe_identifier(value: &str, label: &str, max: usize) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty()
        || value.len() > max
        || !value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.' | ':'))
    {
        return Err(format!("Teach {label} is invalid"));
    }
    Ok(value.to_string())
}

pub(super) fn safe_sha256(value: &str, label: &str) -> Result<String, String> {
    let value = value.trim();
    if value.len() != 64 || !value.chars().all(|ch| ch.is_ascii_hexdigit()) {
        return Err(format!("Teach {label} is invalid"));
    }
    Ok(value.to_ascii_lowercase())
}

fn looks_like_private_path(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    value.starts_with('/')
        || value.starts_with("\\\\")
        || value.as_bytes().get(1).is_some_and(|byte| *byte == b':')
        || lower.contains("/.shellx/")
        || lower.contains("\\.shellx\\")
        || lower.contains("/browser-artifacts/")
        || lower.contains("\\browser-artifacts\\")
}

pub(super) fn deterministic_id<'a>(
    prefix: &str,
    values: impl IntoIterator<Item = &'a str>,
) -> String {
    let mut hasher = Sha256::new();
    for value in values {
        hasher.update(value.as_bytes());
        hasher.update([0]);
    }
    let digest = format!("{:x}", hasher.finalize());
    format!("{prefix}-{}", &digest[..24])
}

pub(super) fn hash_bytes(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
