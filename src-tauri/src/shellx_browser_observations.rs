use std::collections::BTreeMap;

use sha2::{Digest, Sha256};

use crate::shellx_browser::{
    BrowserAccessibilityNode, BrowserDomSummary, BrowserObservation, BrowserObservationDelta,
    BrowserObservationRef, BrowserTaskSnapshot,
};

const BROWSER_OBSERVATION_DELTA_REF_LIMIT: usize = 40;

pub(crate) fn finalize_browser_observation(
    observation: &mut BrowserObservation,
    previous: Option<&BrowserObservation>,
) {
    observation.snapshot_id = browser_snapshot_id(observation);
    observation.delta = previous
        .filter(|previous| !previous.snapshot_id.trim().is_empty())
        .map(|previous| browser_observation_delta(previous, observation));
}

fn browser_snapshot_id(observation: &BrowserObservation) -> String {
    let mut hasher = Sha256::new();
    hash_field(&mut hasher, &observation.task_id);
    hash_optional_field(&mut hasher, observation.url.as_deref());
    hash_field(&mut hasher, &observation.title);
    hash_field(&mut hasher, &observation.text);
    hash_field(&mut hasher, &observation.markdown);
    for count in [
        observation.dom_summary.links,
        observation.dom_summary.buttons,
        observation.dom_summary.inputs,
        observation.dom_summary.forms,
        observation.dom_summary.tables,
        observation.dom_summary.headings,
        observation.dom_summary.text_bytes,
    ] {
        hash_field(&mut hasher, &count.to_string());
    }
    for reference in observation.refs.iter().take(240) {
        hash_field(&mut hasher, &reference.ref_id);
        hash_field(&mut hasher, &reference.role);
        hash_field(&mut hasher, &reference.label);
        hash_optional_field(&mut hasher, reference.name.as_deref());
        hash_optional_field(&mut hasher, reference.selector.as_deref());
        hash_optional_field(&mut hasher, reference.fingerprint.as_deref());
        hash_optional_field(&mut hasher, reference.value.as_deref());
        hash_optional_field(&mut hasher, reference.action.as_deref());
        hash_optional_field(&mut hasher, reference.visible.map(bool_string));
        hash_optional_field(&mut hasher, reference.enabled.map(bool_string));
        hash_optional_field(&mut hasher, reference.editable.map(bool_string));
        for value in reference.option_values.iter().take(100) {
            hash_field(&mut hasher, value);
        }
    }
    for field in observation.form_fields.iter().take(200) {
        hash_optional_field(&mut hasher, field.ref_id.as_deref());
        hash_field(&mut hasher, &field.label);
        hash_field(&mut hasher, &field.field_kind);
        hash_optional_field(&mut hasher, field.value.as_deref());
        hash_optional_field(&mut hasher, field.autocomplete.as_deref());
        hash_optional_field(&mut hasher, field.form_action.as_deref());
        hash_field(&mut hasher, bool_string(field.required));
        hash_field(&mut hasher, bool_string(field.disabled));
    }
    let hash = format!("{:x}", hasher.finalize());
    format!("browser-snapshot-{}", &hash[..16])
}

fn bool_string(value: bool) -> &'static str {
    if value {
        "true"
    } else {
        "false"
    }
}

fn hash_field(hasher: &mut Sha256, value: &str) {
    hasher.update(value.as_bytes());
    hasher.update(b"\0");
}

fn hash_optional_field(hasher: &mut Sha256, value: Option<&str>) {
    hash_field(hasher, value.unwrap_or_default());
}

fn browser_observation_delta(
    previous: &BrowserObservation,
    current: &BrowserObservation,
) -> BrowserObservationDelta {
    let previous_refs = browser_dom_ref_map(previous);
    let current_refs = browser_dom_ref_map(current);
    let mut added_ref_ids = Vec::new();
    let mut removed_ref_ids = Vec::new();
    let mut updated_ref_ids = Vec::new();
    let mut remaining = BROWSER_OBSERVATION_DELTA_REF_LIMIT;
    let mut added_ref_count = 0;
    let mut removed_ref_count = 0;
    let mut updated_ref_count = 0;

    for ref_id in current_refs.keys() {
        if !previous_refs.contains_key(ref_id) {
            added_ref_count += 1;
            push_bounded_ref_id(&mut added_ref_ids, ref_id, &mut remaining);
        }
    }
    for ref_id in previous_refs.keys() {
        if !current_refs.contains_key(ref_id) {
            removed_ref_count += 1;
            push_bounded_ref_id(&mut removed_ref_ids, ref_id, &mut remaining);
        }
    }
    for (ref_id, current_ref) in &current_refs {
        if let Some(previous_ref) = previous_refs.get(ref_id) {
            if browser_observation_ref_changed(previous_ref, current_ref) {
                updated_ref_count += 1;
                push_bounded_ref_id(&mut updated_ref_ids, ref_id, &mut remaining);
            }
        }
    }

    let url_changed = previous.url != current.url;
    let title_changed = previous.title != current.title;
    let text_changed = previous.text != current.text || previous.markdown != current.markdown;
    let structure_changed =
        browser_dom_summary_changed(&previous.dom_summary, &current.dom_summary)
            || previous.form_fields.len() != current.form_fields.len()
            || previous.form_field_groups.len() != current.form_field_groups.len()
            || previous.accessibility_tree.len() != current.accessibility_tree.len();
    let ref_change_count = added_ref_count + removed_ref_count + updated_ref_count;
    BrowserObservationDelta {
        from_snapshot_id: previous.snapshot_id.clone(),
        changed: previous.snapshot_id != current.snapshot_id
            || url_changed
            || title_changed
            || text_changed
            || structure_changed
            || ref_change_count > 0,
        url_changed,
        title_changed,
        text_changed,
        structure_changed,
        added_ref_count,
        removed_ref_count,
        updated_ref_count,
        truncated: ref_change_count
            > added_ref_ids.len() + removed_ref_ids.len() + updated_ref_ids.len(),
        added_ref_ids,
        removed_ref_ids,
        updated_ref_ids,
    }
}

fn browser_dom_ref_map(observation: &BrowserObservation) -> BTreeMap<&str, &BrowserObservationRef> {
    observation
        .refs
        .iter()
        .filter(|reference| !matches!(reference.ref_id.as_str(), "page" | "address" | "report"))
        .map(|reference| (reference.ref_id.as_str(), reference))
        .collect()
}

fn push_bounded_ref_id(target: &mut Vec<String>, ref_id: &str, remaining: &mut usize) {
    if *remaining == 0 {
        return;
    }
    target.push(ref_id.to_string());
    *remaining -= 1;
}

fn browser_observation_ref_changed(
    previous: &BrowserObservationRef,
    current: &BrowserObservationRef,
) -> bool {
    previous.role != current.role
        || previous.label != current.label
        || previous.name != current.name
        || previous.fingerprint != current.fingerprint
        || previous.value != current.value
        || previous.action != current.action
        || previous.visible != current.visible
        || previous.enabled != current.enabled
        || previous.editable != current.editable
        || previous.frame_id != current.frame_id
        || previous.option_values != current.option_values
}

fn browser_dom_summary_changed(previous: &BrowserDomSummary, current: &BrowserDomSummary) -> bool {
    previous.links != current.links
        || previous.buttons != current.buttons
        || previous.inputs != current.inputs
        || previous.forms != current.forms
        || previous.tables != current.tables
        || previous.headings != current.headings
        || previous.text_bytes != current.text_bytes
}

pub(crate) fn observation_for_task(task: &BrowserTaskSnapshot) -> BrowserObservation {
    let url = task.current_url.clone();
    let title = url
        .as_deref()
        .and_then(|value| value.split('/').nth(2))
        .map(|domain| format!("ShellX Browser page: {}", domain))
        .unwrap_or_else(|| "ShellX Browser blank page".to_string());
    let text = format!(
        "Browser task: {}\nCurrent URL: {}\nObservation source: ShellX Browser state. Page DOM extraction requires the browser engine harness.",
        task.goal,
        url.as_deref().unwrap_or("(blank)")
    );
    let refs = browser_observation_refs_with_synthetic(task, url.clone(), Vec::new());
    let mut observation = BrowserObservation {
        task_id: task.task_id.clone(),
        snapshot_id: String::new(),
        delta: None,
        url: url.clone(),
        title: title.clone(),
        markdown: format!("# {}\n\n{}", title, text),
        dom_summary: BrowserDomSummary {
            text_bytes: text.len(),
            ..BrowserDomSummary::default()
        },
        form_fields: Vec::new(),
        form_field_groups: Vec::new(),
        accessibility_tree: browser_accessibility_tree_with_refs(&refs, Vec::new()),
        privacy_stats: None,
        text,
        refs,
        untrusted_input: true,
        requires_engine: true,
    };
    finalize_browser_observation(&mut observation, None);
    observation
}

pub(crate) fn browser_observation_refs_with_synthetic(
    task: &BrowserTaskSnapshot,
    url: Option<String>,
    refs: Vec<BrowserObservationRef>,
) -> Vec<BrowserObservationRef> {
    let current_url = url.or_else(|| task.current_url.clone());
    let page_label = current_url
        .as_deref()
        .map(|value| format!("Current page {}", value))
        .unwrap_or_else(|| "Blank page".to_string());
    let mut merged = vec![
        synthetic_browser_ref(
            "page",
            "document",
            page_label,
            current_url.clone(),
            "observe",
            None,
        ),
        synthetic_browser_ref(
            "address",
            "textbox",
            "Address".to_string(),
            current_url,
            "navigate",
            Some(true),
        ),
        synthetic_browser_ref(
            "report",
            "button",
            "Write report".to_string(),
            None,
            "writeReport",
            Some(false),
        ),
    ];
    merged.extend(
        refs.into_iter()
            .filter(|item| !matches!(item.ref_id.as_str(), "page" | "address" | "report")),
    );
    merged
}

fn synthetic_browser_ref(
    ref_id: &str,
    role: &str,
    label: String,
    value: Option<String>,
    action: &str,
    editable: Option<bool>,
) -> BrowserObservationRef {
    BrowserObservationRef {
        ref_id: ref_id.to_string(),
        role: role.to_string(),
        label: label.clone(),
        name: Some(if ref_id == "page" {
            "Current page".to_string()
        } else {
            label
        }),
        test_id: None,
        selector: None,
        raw_selector: None,
        raw_locator: None,
        fingerprint: None,
        dom_path: None,
        frame_url: None,
        shadow_path: Vec::new(),
        option_values: Vec::new(),
        value,
        action: Some(action.to_string()),
        locator_suggestions: Vec::new(),
        bounds: None,
        visible: None,
        enabled: editable.map(|_| true),
        editable,
        frame_id: Some("browser-chrome".to_string()),
        strict_match_count: None,
    }
}

pub(crate) fn preserve_raw_observation_selectors(observation: &mut BrowserObservation) {
    for reference in &mut observation.refs {
        if reference.raw_selector.is_none() {
            reference.raw_selector = reference.selector.clone();
        }
    }
}

pub(crate) fn browser_accessibility_tree_with_refs(
    refs: &[BrowserObservationRef],
    nodes: Vec<BrowserAccessibilityNode>,
) -> Vec<BrowserAccessibilityNode> {
    let mut merged = nodes
        .into_iter()
        .filter(|item| !item.label.trim().is_empty())
        .take(240)
        .collect::<Vec<_>>();
    let mut synthetic = Vec::new();
    for item in refs
        .iter()
        .filter(|item| matches!(item.ref_id.as_str(), "page" | "address" | "report"))
    {
        if merged
            .iter()
            .any(|node| node.ref_id.as_deref() == Some(item.ref_id.as_str()))
        {
            continue;
        }
        synthetic.push(BrowserAccessibilityNode {
            ref_id: Some(item.ref_id.clone()),
            role: item.role.clone(),
            label: item.label.clone(),
            selector: item.selector.clone(),
            action: item.action.clone(),
        });
    }
    let remaining = 240usize.saturating_sub(synthetic.len());
    synthetic.extend(merged.drain(..).take(remaining));
    synthetic
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shellx_browser::{BrowserAutonomyMode, BrowserTaskSnapshot};

    fn task() -> BrowserTaskSnapshot {
        BrowserTaskSnapshot {
            task_id: "task-delta".to_string(),
            profile_id: "agent-work".to_string(),
            owner_actor_id: "test-agent".to_string(),
            owner_surface: "test".to_string(),
            owner_session_id: Some("test-session".to_string()),
            goal: "delta fixture".to_string(),
            status: "running".to_string(),
            status_reason: None,
            autonomy: BrowserAutonomyMode::AssistedAutonomous,
            current_url: Some("https://example.test/".to_string()),
            last_observation: None,
            expected_domains: vec!["example.test".to_string()],
            blocked_domains: Vec::new(),
            created_at_ms: 1,
            updated_at_ms: 1,
            retention_dropped_console_events: 0,
            retention_dropped_network_events: 0,
            retention_dropped_receipts: 0,
        }
    }

    #[test]
    fn snapshot_and_delta_detect_text_only_changes() {
        let previous = observation_for_task(&task());
        let mut current = previous.clone();
        current.snapshot_id = "engine-supplied-stale-id".to_string();
        current.delta = None;
        current.text.push_str(" changed");
        finalize_browser_observation(&mut current, Some(&previous));
        let delta = current.delta.expect("delta");
        assert!(delta.changed);
        assert!(delta.text_changed);
        assert_ne!(current.snapshot_id, previous.snapshot_id);
        assert_ne!(current.snapshot_id, "engine-supplied-stale-id");
    }

    #[test]
    fn unchanged_observation_reports_a_compact_empty_delta() {
        let previous = observation_for_task(&task());
        let mut current = previous.clone();
        current.snapshot_id.clear();
        current.delta = None;
        finalize_browser_observation(&mut current, Some(&previous));
        let delta = current.delta.expect("delta");
        assert!(!delta.changed);
        assert_eq!(delta.added_ref_count, 0);
        assert_eq!(delta.removed_ref_count, 0);
        assert_eq!(delta.updated_ref_count, 0);
    }
}
