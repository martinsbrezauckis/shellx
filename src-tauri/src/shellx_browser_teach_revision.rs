//! Immutable Teach revisions, approval gates, and Action Recipe V2 projection.

use std::collections::{BTreeMap, BTreeSet};

use serde::Serialize;
use serde_json::{json, Value};
use tauri::Url;

use crate::shellx_browser_caller::{
    ensure_browser_task_control_authority, BrowserTaskControlAuthority,
};

use super::shellx_browser_teach_source::{
    deterministic_id, hash_bytes, safe_identifier, sanitize_teach_identifier, sanitize_teach_text,
};
use super::*;

pub(super) trait TeachArtifactIdentity: Serialize {
    fn set_semantic_identity(&mut self, bytes: usize, sha256: String);
}

impl TeachArtifactIdentity for BrowserTeachBundle {
    fn set_semantic_identity(&mut self, bytes: usize, sha256: String) {
        self.bytes = bytes;
        self.sha256 = sha256;
    }
}

impl TeachArtifactIdentity for BrowserTeachRevision {
    fn set_semantic_identity(&mut self, bytes: usize, sha256: String) {
        self.bytes = bytes;
        self.sha256 = sha256;
    }
}

pub(super) fn initial_revision(
    bundle: &BrowserTeachBundle,
    goal: String,
    author_surface: &str,
) -> BrowserTeachRevision {
    let required_vault_bindings = bundle
        .values
        .iter()
        .filter(|value| value.required_vault_binding)
        .map(|value| BrowserTeachVaultBinding {
            value_id: value.value_id.clone(),
            binding_id: None,
        })
        .collect::<Vec<_>>();
    let mut revision = BrowserTeachRevision {
        schema_version: "sx.workflow-teach-revision.v1".to_string(),
        revision_id: format!("{}-r1", bundle.bundle_id),
        revision: 1,
        parent_revision_id: None,
        bundle_id: bundle.bundle_id.clone(),
        bundle_sha256: bundle.sha256.clone(),
        goal,
        steps: bundle.steps.clone(),
        values: bundle.values.clone(),
        required_vault_bindings,
        required_capabilities: vec!["browser.native".to_string()],
        ambiguity_resolutions: Vec::new(),
        action_summary: BrowserTeachActionSummary::default(),
        revision_note: Some(
            "Deterministic initial projection from Flight Recorder evidence".to_string(),
        ),
        author_surface: author_surface.to_string(),
        created_at_ms: now_ms(),
        bytes: 0,
        sha256: String::new(),
    };
    revision.action_summary = action_summary(&revision, bundle);
    revision
}

pub(super) fn revise_from_current(
    draft: &BrowserTeachDraftIndex,
    request: &BrowserTeachRevisionRequest,
    author_surface: &str,
) -> Result<BrowserTeachRevision, String> {
    let current = &draft.current_revision;
    let mut steps = current.steps.clone();
    if let Some(order) = request.ordered_step_ids.as_ref() {
        validate_step_order(order, &steps)?;
        let by_id = steps
            .into_iter()
            .map(|step| (step.step_id.clone(), step))
            .collect::<BTreeMap<_, _>>();
        steps = order
            .iter()
            .map(|id| by_id.get(id).expect("validated step ID").clone())
            .collect();
    }
    let navigation_value_ids = steps
        .iter()
        .filter(|step| step.operation == "navigate")
        .flat_map(|step| step.value_refs.iter().cloned())
        .collect::<BTreeSet<_>>();
    let mut values = current.values.clone();
    if let Some(edits) = request.value_edits.as_ref() {
        let mut seen = BTreeSet::new();
        for edit in edits {
            let value_id = safe_identifier(&edit.value_id, "valueId", 240)?;
            if !seen.insert(value_id.clone()) {
                return Err("Teach revision contains a duplicate value edit".to_string());
            }
            let value = values
                .iter_mut()
                .find(|value| value.value_id == value_id)
                .ok_or_else(|| "Teach revision references an unknown value".to_string())?;
            if let Some(label) = edit.label.as_deref() {
                value.label = sanitize_teach_text(label, "value label", 120)?;
            }
            if let Some(literal) = edit.literal.as_deref() {
                if value.required_vault_binding {
                    return Err(
                        "Teach revision cannot set a literal for a Vault-bound value".to_string(),
                    );
                }
                value.literal = Some(if navigation_value_ids.contains(&value_id) {
                    validate_teach_navigation_url(literal)?
                } else {
                    sanitize_teach_text(literal, "value literal", 240)?
                });
            }
        }
    }
    let required_vault_bindings = if let Some(bindings) = request.vault_bindings.as_ref() {
        normalize_vault_bindings(bindings, &values)?
    } else {
        current.required_vault_bindings.clone()
    };
    let required_capabilities = if let Some(capabilities) = request.required_capabilities.as_ref() {
        normalize_capabilities(capabilities)?
    } else {
        current.required_capabilities.clone()
    };
    let ambiguity_resolutions = if let Some(resolutions) = request.ambiguity_resolutions.as_ref() {
        normalize_resolutions(resolutions, &draft.bundle)?
    } else {
        current.ambiguity_resolutions.clone()
    };
    let goal = match request.goal.as_deref() {
        Some(goal) => sanitize_teach_text(goal, "goal", 300)?,
        None => current.goal.clone(),
    };
    let revision_note = match request.revision_note.as_deref() {
        Some(note) => Some(sanitize_teach_text(note, "revision note", 300)?),
        None => current.revision_note.clone(),
    };
    let revision_number = current.revision.saturating_add(1);
    let mut revision = BrowserTeachRevision {
        schema_version: "sx.workflow-teach-revision.v1".to_string(),
        revision_id: format!("{}-r{revision_number}", draft.bundle.bundle_id),
        revision: revision_number,
        parent_revision_id: Some(current.revision_id.clone()),
        bundle_id: draft.bundle.bundle_id.clone(),
        bundle_sha256: draft.bundle.sha256.clone(),
        goal,
        steps,
        values,
        required_vault_bindings,
        required_capabilities,
        ambiguity_resolutions,
        action_summary: BrowserTeachActionSummary::default(),
        revision_note,
        author_surface: author_surface.to_string(),
        created_at_ms: now_ms(),
        bytes: 0,
        sha256: String::new(),
    };
    revision.action_summary = action_summary(&revision, &draft.bundle);
    Ok(revision)
}

pub(super) fn validate_teach_approval(
    state: &BrowserState,
    draft: &BrowserTeachDraftIndex,
) -> Result<(), String> {
    let source = &draft.bundle.source;
    if !source.evidence_complete {
        return Err("Teach approval rejects an evidence-incomplete source".to_string());
    }
    let task = state
        .tasks
        .iter()
        .find(|task| task.task_id == source.task_id)
        .ok_or_else(|| "Teach approval source task no longer exists".to_string())?;
    if task.status != "completed"
        || task.owner_session_id.as_deref().unwrap_or("operator") != source.owner_session_id
        || !state.tabs.iter().any(|tab| {
            tab.browser_tab_id == source.browser_tab_id
                && tab.task_id.as_deref() == Some(source.task_id.as_str())
        })
    {
        return Err(
            "Teach approval rejects cross-owned or no-longer-complete Browser source".to_string(),
        );
    }
    if draft
        .bundle
        .loss
        .iter()
        .any(|issue| issue.code == "unsupportedOperation")
    {
        return Err(
            "Teach approval rejects a draft with unsupported Browser operations".to_string(),
        );
    }
    validate_redacted_navigation_paths(draft)?;
    let unresolved_ambiguity = draft
        .bundle
        .ambiguities
        .iter()
        .filter(|issue| issue.blocking)
        .any(|issue| {
            !draft
                .current_revision
                .ambiguity_resolutions
                .contains(&issue.issue_id)
        });
    let blocking_loss = draft.bundle.loss.iter().any(|issue| issue.blocking);
    if unresolved_ambiguity || blocking_loss {
        return Err(
            "Teach approval requires every blocking ambiguity to be resolved and no blocking source loss"
                .to_string(),
        );
    }
    for value in draft
        .current_revision
        .values
        .iter()
        .filter(|value| value.required_vault_binding)
    {
        let bound = draft
            .current_revision
            .required_vault_bindings
            .iter()
            .find(|binding| binding.value_id == value.value_id)
            .and_then(|binding| binding.binding_id.as_deref())
            .is_some_and(|binding| !binding.trim().is_empty());
        if !bound {
            return Err("Teach approval requires every Vault binding".to_string());
        }
    }
    if !draft
        .current_revision
        .required_capabilities
        .iter()
        .all(|capability| capability == "browser.native")
    {
        return Err("Teach approval rejects an unsupported required capability".to_string());
    }
    if draft.current_revision.steps.is_empty() {
        return Err("Teach approval requires at least one supported replayable step".to_string());
    }
    Ok(())
}

fn validate_redacted_navigation_paths(draft: &BrowserTeachDraftIndex) -> Result<(), String> {
    for issue in draft
        .bundle
        .ambiguities
        .iter()
        .filter(|issue| issue.code == "redactedNavigationPath")
    {
        if !draft
            .current_revision
            .ambiguity_resolutions
            .contains(&issue.issue_id)
        {
            return Err(
                "Teach approval requires the redacted navigation path ambiguity to be resolved"
                    .to_string(),
            );
        }
        let sequence = issue.source_sequence.ok_or_else(|| {
            "Teach approval cannot match a redacted navigation path to its source step".to_string()
        })?;
        let value_id = draft
            .current_revision
            .steps
            .iter()
            .find(|step| step.operation == "navigate" && step.source_sequence == sequence)
            .and_then(|step| step.value_refs.first())
            .ok_or_else(|| {
                "Teach approval requires a named URL value for the redacted navigation path"
                    .to_string()
            })?;
        let url = draft
            .current_revision
            .values
            .iter()
            .find(|value| value.value_id == *value_id)
            .and_then(|value| value.literal.as_deref())
            .ok_or_else(|| {
                "Teach approval requires replacing the redacted navigation URL value".to_string()
            })?;
        validate_teach_navigation_url(url).map_err(|_| {
            "Teach approval requires replacing the redacted navigation URL with a safe HTTP(S) URL"
                .to_string()
        })?;
    }
    Ok(())
}

pub(super) fn validate_teach_navigation_url(value: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() || value.len() > 240 || value.chars().any(char::is_control) {
        return Err("Teach navigation URL is empty or exceeds its bounded text budget".to_string());
    }
    if value.to_ascii_lowercase().contains("[redacted-path]") {
        return Err("Teach navigation URL must replace the redacted path placeholder".to_string());
    }
    if crate::host_mcp::redact_if_credential_pattern(value) {
        return Err("Teach navigation URL must not contain a literal secret".to_string());
    }
    let parsed = Url::parse(value)
        .map_err(|_| "Teach navigation URL must be an absolute HTTP(S) URL".to_string())?;
    if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
        return Err("Teach navigation URL must be an absolute HTTP(S) URL".to_string());
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("Teach navigation URL must not contain credentials".to_string());
    }
    if parsed.query().is_some() || parsed.fragment().is_some() {
        return Err("Teach navigation URL must not contain a query string or fragment".to_string());
    }
    let path = parsed.path().to_ascii_lowercase();
    if path.starts_with("/.shellx")
        || path.contains("/.shellx/")
        || path.starts_with("/browser-artifacts")
        || path.contains("/browser-artifacts/")
        || path.contains("%2f.shellx")
        || path.contains("%2fbrowser-artifacts")
    {
        return Err("Teach navigation URL must not contain a private local path".to_string());
    }
    Ok(parsed.to_string())
}

pub(super) fn teach_recipe_value(
    recipe_id: &str,
    created_at_ms: i64,
    draft: &BrowserTeachDraftIndex,
) -> Result<Value, String> {
    let value_by_id = draft
        .current_revision
        .values
        .iter()
        .map(|value| (value.value_id.as_str(), value))
        .collect::<BTreeMap<_, _>>();
    let vault_binding_by_value = draft
        .current_revision
        .required_vault_bindings
        .iter()
        .filter_map(|binding| {
            binding
                .binding_id
                .as_deref()
                .map(|binding_id| (binding.value_id.as_str(), binding_id))
        })
        .collect::<BTreeMap<_, _>>();
    let steps = draft
        .current_revision
        .steps
        .iter()
        .map(|step| {
            let mut recipe_step = step.recipe_step.clone();
            if step.operation == "navigate" {
                let value_id = step
                    .value_refs
                    .first()
                    .ok_or_else(|| "Teach navigation step has no named URL value".to_string())?;
                let url = value_by_id
                    .get(value_id.as_str())
                    .and_then(|value| value.literal.as_deref())
                    .ok_or_else(|| "Teach navigation URL value is unavailable".to_string())?;
                recipe_step["url"] = json!(validate_teach_navigation_url(url)?);
            }
            if let Some(binding_id) = step
                .value_refs
                .iter()
                .find_map(|value_id| vault_binding_by_value.get(value_id.as_str()))
            {
                // V2 replayers ignore unknown metadata and continue to require
                // Vault/user input for redacted values. Retaining this opaque
                // identity lets the private recipe remain auditable without
                // serializing a secret or attempting automatic injection.
                recipe_step["vaultBindingId"] = json!(binding_id);
            }
            Ok(recipe_step)
        })
        .collect::<Result<Vec<_>, String>>()?;
    let variable_inputs = draft
        .current_revision
        .values
        .iter()
        .map(|value| {
            let mut input = json!({
                "valueId": value.value_id,
                "label": value.label,
                "kind": value.kind,
                "requiresVaultBinding": value.required_vault_binding,
            });
            if let Some(binding_id) = vault_binding_by_value.get(value.value_id.as_str()) {
                input["vaultBindingId"] = json!(binding_id);
            }
            input
        })
        .collect::<Vec<_>>();
    let assertions = draft
        .current_revision
        .steps
        .iter()
        .filter(|step| !step.assertion_refs.is_empty())
        .map(|step| json!({ "stepId": step.step_id, "evidenceRefs": step.assertion_refs }))
        .collect::<Vec<_>>();
    let decision_points = draft
        .current_revision
        .steps
        .iter()
        .filter(|step| !step.decision_point_refs.is_empty())
        .map(|step| json!({ "stepId": step.step_id, "evidenceRefs": step.decision_point_refs }))
        .collect::<Vec<_>>();
    let source_receipts = draft
        .current_revision
        .steps
        .iter()
        .flat_map(|step| {
            step.evidence_refs.iter().map(move |receipt_id| {
                json!({
                    "receiptId": receipt_id,
                    "sourceSequence": step.source_sequence,
                    "stepId": step.step_id,
                })
            })
        })
        .collect::<Vec<_>>();
    Ok(json!({
        "schemaVersion": 2,
        "recipeId": recipe_id,
        "createdAtMs": created_at_ms,
        "reason": "Operator-approved deterministic Teach draft",
        "goal": draft.current_revision.goal,
        "taskId": draft.bundle.source.task_id,
        "browserTabId": draft.bundle.source.browser_tab_id,
        "source": "shellx-browser-recorder",
        "steps": steps,
        "variableInputs": variable_inputs,
        "assertions": assertions,
        "decisionPoints": decision_points,
        "sourceReceipts": source_receipts,
        "redactionPolicy": {
            "rawInputValues": false,
            "rawSecrets": false,
            "cookies": false,
            "headers": false,
            "queryAndFragmentRetained": false,
            "typedValueReplayRequiresVaultOrUserInput": true,
            "teachSource": "shellx-browser-teach",
            "teachBundleId": draft.bundle.bundle_id,
            "teachBundleSha256": draft.bundle.sha256,
            "teachRevisionId": draft.current_revision.revision_id,
            "teachRevisionSha256": draft.current_revision.sha256,
        }
    }))
}

pub(super) fn write_teach_revision(revision: &BrowserTeachRevision) -> Result<String, String> {
    let payload = serde_json::to_value(revision)
        .map_err(|error| format!("Teach revision encode failed: {error}"))?;
    let encoded = serde_json::to_vec(&payload)
        .map_err(|error| format!("Teach revision encode failed: {error}"))?;
    if encoded.len() > MAX_TEACH_ARTIFACT_BYTES {
        return Err(format!(
            "Teach revision exceeds the {MAX_TEACH_ARTIFACT_BYTES} byte budget"
        ));
    }
    let (path, _, _) = crate::shellx_browser_artifacts::write_browser_json_artifact(
        TEACH_REVISION_FOLDER,
        "teach-revision",
        &revision.revision_id,
        revision.created_at_ms,
        &payload,
    )?;
    Ok(path)
}

pub(super) fn set_semantic_identity<T: TeachArtifactIdentity>(value: &mut T) -> Result<(), String> {
    let mut payload = serde_json::to_value(&*value)
        .map_err(|error| format!("Teach artifact identity encode failed: {error}"))?;
    let map = payload
        .as_object_mut()
        .ok_or_else(|| "Teach artifact identity requires an object".to_string())?;
    map.insert("bytes".to_string(), json!(0));
    map.insert("sha256".to_string(), json!(""));
    let bytes = serde_json::to_vec(&payload)
        .map_err(|error| format!("Teach artifact identity encode failed: {error}"))?;
    let identity = hash_bytes(&bytes);
    value.set_semantic_identity(bytes.len(), identity);
    Ok(())
}

pub(super) fn prepare_response(draft: &BrowserTeachDraftIndex) -> BrowserTeachPrepareResponse {
    let draft_id = deterministic_id(
        "teach-draft",
        [
            draft.bundle.bundle_id.as_str(),
            draft.bundle.sha256.as_str(),
        ],
    );
    prepare_response_with_summary(draft, draft_summary(draft, &draft_id))
}

pub(super) fn prepare_response_with_summary(
    draft: &BrowserTeachDraftIndex,
    summary: BrowserTeachDraftSummary,
) -> BrowserTeachPrepareResponse {
    BrowserTeachPrepareResponse {
        bundle: draft.bundle.clone(),
        revision: draft.current_revision.clone(),
        draft: summary,
    }
}

pub(super) fn draft_summary(
    draft: &BrowserTeachDraftIndex,
    draft_id: &str,
) -> BrowserTeachDraftSummary {
    BrowserTeachDraftSummary {
        draft_id: draft_id.to_string(),
        bundle_id: draft.bundle.bundle_id.clone(),
        bundle_sha256: draft.bundle.sha256.clone(),
        task_id: draft.bundle.source.task_id.clone(),
        browser_tab_id: draft.bundle.source.browser_tab_id.clone(),
        attempt_id: draft.bundle.source.attempt_id.clone(),
        current_revision_id: draft.current_revision.revision_id.clone(),
        current_revision_sha256: draft.current_revision.sha256.clone(),
        revision: draft.current_revision.revision,
        step_count: draft.current_revision.steps.len(),
        value_count: draft.current_revision.values.len(),
        blocking_issues: draft
            .bundle
            .ambiguities
            .iter()
            .filter(|issue| {
                issue.blocking
                    && !draft
                        .current_revision
                        .ambiguity_resolutions
                        .contains(&issue.issue_id)
            })
            .count()
            + draft
                .bundle
                .loss
                .iter()
                .filter(|issue| issue.blocking)
                .count(),
        created_at_ms: draft.bundle.created_at_ms,
    }
}

pub(super) fn ensure_current_revision(
    current: &BrowserTeachRevision,
    request: &BrowserTeachRevisionRequest,
) -> Result<(), String> {
    if request.expected_revision_id.trim() != current.revision_id
        || !request
            .expected_revision_sha256
            .trim()
            .eq_ignore_ascii_case(&current.sha256)
    {
        return Err("Teach draft revision compare-and-swap conflict".to_string());
    }
    Ok(())
}

pub(super) fn ensure_browser_task_control_authority_for_teach(
    state: &BrowserState,
    task_id: &str,
    authority: BrowserTaskControlAuthority,
    caller_session_id: Option<&str>,
) -> Result<(), String> {
    let task = state
        .tasks
        .iter()
        .find(|task| task.task_id == task_id)
        .ok_or_else(|| "Teach task was not found".to_string())?;
    ensure_browser_task_control_authority(task, authority, caller_session_id)
}

fn validate_step_order(order: &[String], steps: &[BrowserTeachStep]) -> Result<(), String> {
    if order.len() != steps.len() || order.len() > MAX_TEACH_STEPS {
        return Err("Teach revision must retain every known step exactly once".to_string());
    }
    let expected = steps
        .iter()
        .map(|step| step.step_id.as_str())
        .collect::<BTreeSet<_>>();
    let actual = order.iter().map(String::as_str).collect::<BTreeSet<_>>();
    if expected != actual || actual.len() != order.len() {
        return Err("Teach revision references an unknown or duplicate step".to_string());
    }
    Ok(())
}

fn normalize_vault_bindings(
    bindings: &[BrowserTeachVaultBinding],
    values: &[BrowserTeachValue],
) -> Result<Vec<BrowserTeachVaultBinding>, String> {
    let expected = values
        .iter()
        .filter(|value| value.required_vault_binding)
        .map(|value| value.value_id.as_str())
        .collect::<BTreeSet<_>>();
    if bindings.len() != expected.len() {
        return Err("Teach revision must retain every required Vault binding".to_string());
    }
    let mut normalized = Vec::new();
    let mut seen = BTreeSet::new();
    for binding in bindings {
        let value_id = safe_identifier(&binding.value_id, "valueId", 240)?;
        if !expected.contains(value_id.as_str()) || !seen.insert(value_id.clone()) {
            return Err(
                "Teach revision references an unknown or duplicate Vault binding".to_string(),
            );
        }
        let binding_id = binding
            .binding_id
            .as_deref()
            .map(normalize_vault_binding_id)
            .transpose()?;
        normalized.push(BrowserTeachVaultBinding {
            value_id,
            binding_id,
        });
    }
    normalized.sort_by(|left, right| left.value_id.cmp(&right.value_id));
    Ok(normalized)
}

fn normalize_vault_binding_id(value: &str) -> Result<String, String> {
    // Vault key identities are opaque labels, not filesystem paths. Slash-delimited
    // keys such as `github/pat` and `xai/api-key` are canonical throughout ShellX.
    let value = value.trim().to_string();
    if value.is_empty() || value.chars().count() > 200 || value.chars().any(char::is_control) {
        return Err("Teach Vault binding ID is invalid".to_string());
    }
    Ok(value)
}

fn normalize_capabilities(capabilities: &[String]) -> Result<Vec<String>, String> {
    if capabilities.is_empty() || capabilities.len() > 8 {
        return Err("Teach revision requires the browser.native capability".to_string());
    }
    let mut normalized = BTreeSet::new();
    for capability in capabilities {
        let capability = sanitize_teach_identifier(capability, "capability", 80)?;
        if capability != "browser.native" {
            return Err("Teach revision has an unsupported capability".to_string());
        }
        normalized.insert(capability);
    }
    if !normalized.contains("browser.native") {
        return Err("Teach revision requires the browser.native capability".to_string());
    }
    Ok(normalized.into_iter().collect())
}

fn normalize_resolutions(
    resolutions: &[String],
    bundle: &BrowserTeachBundle,
) -> Result<Vec<String>, String> {
    if resolutions.len() > MAX_TEACH_ISSUES {
        return Err("Teach revision exceeds the ambiguity-resolution budget".to_string());
    }
    let known = bundle
        .ambiguities
        .iter()
        .map(|issue| issue.issue_id.as_str())
        .collect::<BTreeSet<_>>();
    let mut normalized = BTreeSet::new();
    for resolution in resolutions {
        let resolution = safe_identifier(resolution, "ambiguity resolution", 240)?;
        if !known.contains(resolution.as_str()) {
            return Err(
                "Teach revision resolves an unknown or non-resolvable ambiguity".to_string(),
            );
        }
        normalized.insert(resolution);
    }
    Ok(normalized.into_iter().collect())
}

fn action_summary(
    revision: &BrowserTeachRevision,
    bundle: &BrowserTeachBundle,
) -> BrowserTeachActionSummary {
    BrowserTeachActionSummary {
        reads: revision
            .steps
            .iter()
            .filter(|step| step.classification == "read")
            .count(),
        derives: revision
            .steps
            .iter()
            .filter(|step| step.classification == "derive")
            .count(),
        actions: revision
            .steps
            .iter()
            .filter(|step| step.classification == "action")
            .count(),
        assertions: revision
            .steps
            .iter()
            .map(|step| step.assertion_refs.len())
            .sum(),
        decision_points: revision
            .steps
            .iter()
            .map(|step| step.decision_point_refs.len())
            .sum(),
        blocking_issues: bundle
            .ambiguities
            .iter()
            .filter(|issue| {
                issue.blocking && !revision.ambiguity_resolutions.contains(&issue.issue_id)
            })
            .count()
            + bundle.loss.iter().filter(|issue| issue.blocking).count(),
    }
}
