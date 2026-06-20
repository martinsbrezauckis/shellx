use sha2::{Digest, Sha256};

use crate::shellx_browser::{
    clean_string, BrowserActionRequest, BrowserActionabilityCheck, BrowserAgentStepSummary,
    BrowserLocatorRecoveryCandidate, BrowserObservation, BrowserObservationRef,
};

pub(crate) fn assign_browser_snapshot_id(observation: &mut BrowserObservation) {
    if !observation.snapshot_id.trim().is_empty() {
        return;
    }
    observation.snapshot_id = browser_snapshot_id(observation);
}

pub(crate) fn browser_snapshot_id(observation: &BrowserObservation) -> String {
    let mut hasher = Sha256::new();
    hasher.update(observation.task_id.as_bytes());
    hasher.update(b"\n");
    if let Some(url) = observation.url.as_deref() {
        hasher.update(url.as_bytes());
    }
    hasher.update(b"\n");
    hasher.update(observation.title.as_bytes());
    hasher.update(b"\n");
    hasher.update(observation.dom_summary.links.to_string().as_bytes());
    hasher.update(b":");
    hasher.update(observation.dom_summary.buttons.to_string().as_bytes());
    hasher.update(b":");
    hasher.update(observation.dom_summary.inputs.to_string().as_bytes());
    hasher.update(b"\n");
    for reference in observation.refs.iter().take(80) {
        hasher.update(reference.ref_id.as_bytes());
        hasher.update(b"|");
        hasher.update(reference.role.as_bytes());
        hasher.update(b"|");
        hasher.update(reference.label.as_bytes());
        hasher.update(b"|");
        if let Some(selector) = reference.selector.as_deref() {
            hasher.update(selector.as_bytes());
        }
        hasher.update(b"|");
        if let Some(action) = reference.action.as_deref() {
            hasher.update(action.as_bytes());
        }
        hasher.update(b"\n");
    }
    let hash = format!("{:x}", hasher.finalize());
    format!("browser-snapshot-{}", &hash[..16])
}

pub(crate) fn decorate_browser_step_summary_for_request(
    summary: &mut BrowserAgentStepSummary,
    request: &BrowserActionRequest,
    observation: Option<&BrowserObservation>,
    actionability: Option<&BrowserActionabilityCheck>,
) {
    if summary.snapshot_id.is_none() {
        summary.snapshot_id = observation
            .map(|observation| observation.snapshot_id.clone())
            .filter(|value| !value.trim().is_empty());
    }
    summary.target_ref_id = request
        .ref_id
        .as_deref()
        .map(clean_string)
        .filter(|value| !value.is_empty());
    summary.target_selector = request
        .selector
        .as_deref()
        .map(clean_string)
        .filter(|value| !value.is_empty())
        .or_else(|| {
            actionability
                .and_then(|check| check.selector.as_deref())
                .map(clean_string)
                .filter(|value| !value.is_empty())
        });
    summary.failed_checks = actionability
        .map(|check| check.failed_checks.clone())
        .unwrap_or_default();
    summary.locator_candidates = browser_locator_recovery_candidates(
        observation,
        request.ref_id.as_deref(),
        summary.target_selector.as_deref(),
        &request.action,
    );
    if let Some(check) = actionability {
        if let Some(covering) = check.covering_element.as_ref() {
            let cover_label = covering
                .label
                .as_deref()
                .map(clean_string)
                .filter(|value| !value.is_empty())
                .or_else(|| {
                    covering
                        .selector
                        .as_deref()
                        .map(clean_string)
                        .filter(|value| !value.is_empty())
                })
                .unwrap_or_else(|| "another page element".to_string());
            push_unique_hint(
                &mut summary.recovery_hints,
                format!(
                    "The target is covered by {}; close or handle that element, then re-observe before retrying.",
                    cover_label
                ),
            );
        }
    }
    if !summary.locator_candidates.is_empty() {
        push_unique_hint(
            &mut summary.recovery_hints,
            "Locator recovery candidates are available in stepSummary.locatorCandidates; prefer a fresh observe before retrying sensitive actions.".to_string(),
        );
    }
}

fn push_unique_hint(hints: &mut Vec<String>, hint: String) {
    if hint.trim().is_empty() || hints.iter().any(|existing| existing == &hint) {
        return;
    }
    hints.push(hint);
}

fn browser_locator_recovery_candidates(
    observation: Option<&BrowserObservation>,
    ref_id: Option<&str>,
    selector: Option<&str>,
    action: &str,
) -> Vec<BrowserLocatorRecoveryCandidate> {
    let Some(observation) = observation else {
        return Vec::new();
    };
    let requested_ref_id = ref_id.map(clean_string).filter(|value| !value.is_empty());
    let requested_selector = selector.map(clean_string).filter(|value| !value.is_empty());
    let target = observation.refs.iter().find(|candidate| {
        requested_ref_id
            .as_deref()
            .map(|ref_id| candidate.ref_id == ref_id)
            .unwrap_or(false)
            || requested_selector
                .as_deref()
                .map(|selector| {
                    candidate.selector.as_deref() == Some(selector)
                        || candidate.raw_selector.as_deref() == Some(selector)
                })
                .unwrap_or(false)
    });
    let mut scored = observation
        .refs
        .iter()
        .filter(|candidate| {
            requested_ref_id
                .as_deref()
                .map(|ref_id| candidate.ref_id != ref_id)
                .unwrap_or(true)
                && requested_selector
                    .as_deref()
                    .map(|selector| {
                        candidate.selector.as_deref() != Some(selector)
                            && candidate.raw_selector.as_deref() != Some(selector)
                    })
                    .unwrap_or(true)
        })
        .filter_map(|candidate| {
            let score = locator_candidate_score(candidate, target, action);
            (score > 0).then_some((score, candidate))
        })
        .collect::<Vec<_>>();
    scored.sort_by_key(|entry| std::cmp::Reverse(entry.0));
    scored
        .into_iter()
        .take(5)
        .map(|(_, candidate)| BrowserLocatorRecoveryCandidate {
            ref_id: candidate.ref_id.clone(),
            role: candidate.role.clone(),
            label: candidate.label.clone(),
            name: candidate.name.clone(),
            selector: candidate.selector.clone(),
            action: candidate.action.clone(),
            locator_suggestions: candidate.locator_suggestions.clone(),
            visible: candidate.visible,
            enabled: candidate.enabled,
            editable: candidate.editable,
            strict_match_count: candidate.strict_match_count,
        })
        .collect()
}

fn locator_candidate_score(
    candidate: &BrowserObservationRef,
    target: Option<&BrowserObservationRef>,
    action: &str,
) -> i32 {
    if candidate.visible == Some(false) || candidate.enabled == Some(false) {
        return 0;
    }
    let mut score = 0;
    let action = action.trim();
    let candidate_action = candidate.action.as_deref();
    let action_matches = action.is_empty()
        || candidate_action == Some(action)
        || matches!(
            (action, candidate_action),
            ("click", Some("clickRef")) | ("type", Some("fillRef"))
        );
    if action_matches {
        score += 20;
    }
    if candidate.strict_match_count == Some(1) {
        score += 6;
    }
    if candidate.visible == Some(true) {
        score += 4;
    }
    if let Some(target) = target {
        if !target.role.is_empty() && candidate.role == target.role {
            score += 18;
        }
        if !target.label.is_empty() && candidate.label == target.label {
            score += 18;
        }
        if target.name.is_some() && candidate.name == target.name {
            score += 12;
        }
        if !target.label.is_empty()
            && !candidate.label.is_empty()
            && target.label != candidate.label
            && target
                .label
                .to_ascii_lowercase()
                .split_whitespace()
                .any(|part| part.len() > 3 && candidate.label.to_ascii_lowercase().contains(part))
        {
            score += 5;
        }
    }
    score
}
