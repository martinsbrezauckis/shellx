use crate::shellx_browser_engine_model::BrowserReceipt;
use crate::shellx_browser_settings_model::{BrowserAdMode, BrowserPageSecurityState};
use serde::{Deserialize, Deserializer, Serialize};

fn deserialize_bool_lossy<'de, D>(deserializer: D) -> Result<bool, D::Error>
where
    D: Deserializer<'de>,
{
    let value = serde_json::Value::deserialize(deserializer)?;
    Ok(bool_from_lossy_json(value).unwrap_or(false))
}

pub(crate) fn deserialize_option_bool_lossy<'de, D>(
    deserializer: D,
) -> Result<Option<bool>, D::Error>
where
    D: Deserializer<'de>,
{
    let value = serde_json::Value::deserialize(deserializer)?;
    Ok(bool_from_lossy_json(value))
}

fn bool_from_lossy_json(value: serde_json::Value) -> Option<bool> {
    match value {
        serde_json::Value::Null => None,
        serde_json::Value::Bool(value) => Some(value),
        serde_json::Value::Number(value) => Some(value.as_i64().unwrap_or_default() != 0),
        serde_json::Value::String(value) => {
            let normalized = value.trim().to_ascii_lowercase();
            Some(matches!(
                normalized.as_str(),
                "1" | "true" | "yes" | "y" | "on"
            ))
        }
        _ => None,
    }
}

pub(crate) fn deserialize_string_lossy<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: Deserializer<'de>,
{
    let value = serde_json::Value::deserialize(deserializer)?;
    Ok(string_from_lossy_json(value))
}

pub(crate) fn deserialize_option_string_lossy<'de, D>(
    deserializer: D,
) -> Result<Option<String>, D::Error>
where
    D: Deserializer<'de>,
{
    let value = serde_json::Value::deserialize(deserializer)?;
    if value.is_null() {
        return Ok(None);
    }
    let cleaned = string_from_lossy_json(value);
    Ok((!cleaned.is_empty()).then_some(cleaned))
}

fn deserialize_option_raw_string<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: Deserializer<'de>,
{
    let value = serde_json::Value::deserialize(deserializer)?;
    let serde_json::Value::String(value) = value else {
        return Ok(None);
    };
    let value = value.trim().chars().take(4096).collect::<String>();
    Ok((!value.is_empty()).then_some(value))
}

fn string_from_lossy_json(value: serde_json::Value) -> String {
    let raw = match value {
        serde_json::Value::Null => String::new(),
        serde_json::Value::String(value) => value,
        serde_json::Value::Bool(value) => value.to_string(),
        serde_json::Value::Number(value) => value.to_string(),
        serde_json::Value::Array(_) | serde_json::Value::Object(_) => {
            serde_json::to_string(&value).unwrap_or_default()
        }
    };
    raw.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(512)
        .collect()
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserLocatorSuggestion {
    #[serde(default, deserialize_with = "deserialize_string_lossy")]
    pub kind: String,
    #[serde(default, deserialize_with = "deserialize_string_lossy")]
    pub value: String,
    #[serde(default, deserialize_with = "deserialize_bool_lossy")]
    pub strict: bool,
    #[serde(rename = "matchCount")]
    pub match_count: usize,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserElementBounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserActionabilityCoveringElement {
    #[serde(default)]
    pub selector: Option<String>,
    #[serde(default)]
    pub role: Option<String>,
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub bounds: Option<BrowserElementBounds>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserActionabilityCheck {
    #[serde(default, deserialize_with = "deserialize_bool_lossy")]
    pub attached: bool,
    #[serde(default, deserialize_with = "deserialize_bool_lossy")]
    pub visible: bool,
    #[serde(default, deserialize_with = "deserialize_bool_lossy")]
    pub stable: bool,
    #[serde(rename = "stabilityMs", default)]
    pub stability_ms: u64,
    #[serde(rename = "stabilitySamples", default)]
    pub stability_samples: usize,
    #[serde(
        rename = "expectedFingerprint",
        default,
        deserialize_with = "deserialize_option_string_lossy"
    )]
    pub expected_fingerprint: Option<String>,
    #[serde(
        rename = "actualFingerprint",
        default,
        deserialize_with = "deserialize_option_string_lossy"
    )]
    pub actual_fingerprint: Option<String>,
    #[serde(
        rename = "fingerprintMatches",
        default,
        deserialize_with = "deserialize_option_bool_lossy"
    )]
    pub fingerprint_matches: Option<bool>,
    #[serde(default, deserialize_with = "deserialize_bool_lossy")]
    pub enabled: bool,
    #[serde(default, deserialize_with = "deserialize_bool_lossy")]
    pub editable: bool,
    #[serde(
        rename = "inViewport",
        default,
        deserialize_with = "deserialize_bool_lossy"
    )]
    pub in_viewport: bool,
    #[serde(
        rename = "receivesEvents",
        default,
        deserialize_with = "deserialize_bool_lossy"
    )]
    pub receives_events: bool,
    #[serde(rename = "strictMatchCount")]
    pub strict_match_count: usize,
    #[serde(default)]
    pub selector: Option<String>,
    #[serde(default)]
    pub bounds: Option<BrowserElementBounds>,
    #[serde(rename = "coveringElement", default)]
    pub covering_element: Option<BrowserActionabilityCoveringElement>,
    #[serde(rename = "failedChecks", default)]
    pub failed_checks: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserVerificationResult {
    #[serde(rename = "expectationType")]
    pub expectation_type: String,
    #[serde(default, deserialize_with = "deserialize_bool_lossy")]
    pub passed: bool,
    #[serde(default)]
    pub selector: Option<String>,
    #[serde(rename = "checkedText", default)]
    pub checked_text: Option<String>,
    #[serde(rename = "checkedUrl", default)]
    pub checked_url: Option<String>,
    #[serde(default)]
    pub failures: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserObservationRef {
    #[serde(rename = "refId")]
    #[serde(default, deserialize_with = "deserialize_string_lossy")]
    pub ref_id: String,
    #[serde(default, deserialize_with = "deserialize_string_lossy")]
    pub role: String,
    #[serde(default, deserialize_with = "deserialize_string_lossy")]
    pub label: String,
    #[serde(default, deserialize_with = "deserialize_option_string_lossy")]
    pub name: Option<String>,
    #[serde(
        rename = "testId",
        default,
        deserialize_with = "deserialize_option_string_lossy"
    )]
    pub test_id: Option<String>,
    #[serde(default, deserialize_with = "deserialize_option_string_lossy")]
    pub selector: Option<String>,
    #[serde(skip)]
    pub raw_selector: Option<String>,
    #[serde(
        rename = "locator",
        default,
        skip_serializing,
        deserialize_with = "deserialize_option_raw_string"
    )]
    pub raw_locator: Option<String>,
    #[serde(default, deserialize_with = "deserialize_option_string_lossy")]
    pub fingerprint: Option<String>,
    #[serde(
        rename = "domPath",
        default,
        deserialize_with = "deserialize_option_string_lossy"
    )]
    pub dom_path: Option<String>,
    #[serde(
        rename = "frameUrl",
        default,
        deserialize_with = "deserialize_option_string_lossy"
    )]
    pub frame_url: Option<String>,
    #[serde(rename = "shadowPath", default)]
    pub shadow_path: Vec<String>,
    #[serde(rename = "optionValues", default)]
    pub option_values: Vec<String>,
    #[serde(default, deserialize_with = "deserialize_option_string_lossy")]
    pub value: Option<String>,
    #[serde(default, deserialize_with = "deserialize_option_string_lossy")]
    pub action: Option<String>,
    #[serde(rename = "locatorSuggestions", default)]
    pub locator_suggestions: Vec<BrowserLocatorSuggestion>,
    #[serde(default)]
    pub bounds: Option<BrowserElementBounds>,
    #[serde(default, deserialize_with = "deserialize_option_bool_lossy")]
    pub visible: Option<bool>,
    #[serde(default, deserialize_with = "deserialize_option_bool_lossy")]
    pub enabled: Option<bool>,
    #[serde(default, deserialize_with = "deserialize_option_bool_lossy")]
    pub editable: Option<bool>,
    #[serde(
        rename = "frameId",
        default,
        deserialize_with = "deserialize_option_string_lossy"
    )]
    pub frame_id: Option<String>,
    #[serde(rename = "strictMatchCount", default)]
    pub strict_match_count: Option<usize>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserDomSummary {
    pub links: usize,
    pub buttons: usize,
    pub inputs: usize,
    pub forms: usize,
    pub tables: usize,
    pub headings: usize,
    #[serde(rename = "textBytes")]
    pub text_bytes: usize,
    #[serde(rename = "sameOriginFrames", default)]
    pub same_origin_frames: usize,
    #[serde(rename = "crossOriginFrames", default)]
    pub cross_origin_frames: usize,
    #[serde(rename = "openShadowRoots", default)]
    pub open_shadow_roots: usize,
    #[serde(rename = "traversalTruncated", default)]
    pub traversal_truncated: bool,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserPrivacyStats {
    pub mode: BrowserAdMode,
    #[serde(rename = "hiddenElements", default)]
    pub hidden_elements: u32,
    #[serde(rename = "maskedElements", default)]
    pub masked_elements: u32,
    #[serde(rename = "blockedRequests", default)]
    pub blocked_requests: u32,
    #[serde(rename = "matchedElements", default)]
    pub matched_elements: u32,
    #[serde(rename = "lastRunAt", default)]
    pub last_run_at: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserFormField {
    #[serde(
        rename = "refId",
        default,
        deserialize_with = "deserialize_option_string_lossy"
    )]
    pub ref_id: Option<String>,
    #[serde(default, deserialize_with = "deserialize_string_lossy")]
    pub label: String,
    #[serde(rename = "fieldKind")]
    #[serde(default, deserialize_with = "deserialize_string_lossy")]
    pub field_kind: String,
    #[serde(default, deserialize_with = "deserialize_option_string_lossy")]
    pub selector: Option<String>,
    #[serde(default, deserialize_with = "deserialize_option_string_lossy")]
    pub value: Option<String>,
    #[serde(default, deserialize_with = "deserialize_bool_lossy")]
    pub required: bool,
    #[serde(default, deserialize_with = "deserialize_bool_lossy")]
    pub disabled: bool,
    #[serde(default, deserialize_with = "deserialize_option_string_lossy")]
    pub autocomplete: Option<String>,
    #[serde(
        rename = "formAction",
        default,
        deserialize_with = "deserialize_option_string_lossy"
    )]
    pub form_action: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserFormFieldGroupField {
    #[serde(
        rename = "refId",
        default,
        deserialize_with = "deserialize_option_string_lossy"
    )]
    pub ref_id: Option<String>,
    #[serde(default, deserialize_with = "deserialize_option_string_lossy")]
    pub selector: Option<String>,
    #[serde(default, deserialize_with = "deserialize_string_lossy")]
    pub label: String,
    #[serde(rename = "fieldKind")]
    #[serde(default, deserialize_with = "deserialize_string_lossy")]
    pub field_kind: String,
    #[serde(default, deserialize_with = "deserialize_string_lossy")]
    pub intent: String,
    #[serde(default, deserialize_with = "deserialize_bool_lossy")]
    pub required: bool,
    #[serde(default, deserialize_with = "deserialize_bool_lossy")]
    pub disabled: bool,
    #[serde(default, deserialize_with = "deserialize_bool_lossy")]
    pub sensitive: bool,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserFormFieldGroup {
    #[serde(rename = "groupId")]
    #[serde(default, deserialize_with = "deserialize_string_lossy")]
    pub group_id: String,
    #[serde(rename = "groupKind")]
    #[serde(default, deserialize_with = "deserialize_string_lossy")]
    pub group_kind: String,
    #[serde(default, deserialize_with = "deserialize_string_lossy")]
    pub label: String,
    #[serde(rename = "formAction")]
    #[serde(default, deserialize_with = "deserialize_option_string_lossy")]
    pub form_action: Option<String>,
    #[serde(rename = "fieldIntents", default)]
    pub field_intents: Vec<String>,
    #[serde(default)]
    pub fields: Vec<BrowserFormFieldGroupField>,
    #[serde(default, deserialize_with = "deserialize_bool_lossy")]
    pub sensitive: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserAccessibilityNode {
    #[serde(
        rename = "refId",
        default,
        deserialize_with = "deserialize_option_string_lossy"
    )]
    pub ref_id: Option<String>,
    #[serde(default, deserialize_with = "deserialize_string_lossy")]
    pub role: String,
    #[serde(default, deserialize_with = "deserialize_string_lossy")]
    pub label: String,
    #[serde(default, deserialize_with = "deserialize_option_string_lossy")]
    pub selector: Option<String>,
    #[serde(default, deserialize_with = "deserialize_option_string_lossy")]
    pub action: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserObservationDelta {
    #[serde(rename = "fromSnapshotId")]
    pub from_snapshot_id: String,
    pub changed: bool,
    #[serde(rename = "urlChanged")]
    pub url_changed: bool,
    #[serde(rename = "titleChanged")]
    pub title_changed: bool,
    #[serde(rename = "textChanged")]
    pub text_changed: bool,
    #[serde(rename = "structureChanged")]
    pub structure_changed: bool,
    #[serde(rename = "addedRefCount")]
    pub added_ref_count: usize,
    #[serde(rename = "removedRefCount")]
    pub removed_ref_count: usize,
    #[serde(rename = "updatedRefCount")]
    pub updated_ref_count: usize,
    #[serde(rename = "addedRefIds", default)]
    pub added_ref_ids: Vec<String>,
    #[serde(rename = "removedRefIds", default)]
    pub removed_ref_ids: Vec<String>,
    #[serde(rename = "updatedRefIds", default)]
    pub updated_ref_ids: Vec<String>,
    #[serde(default)]
    pub truncated: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserObservation {
    #[serde(rename = "taskId")]
    pub task_id: String,
    #[serde(rename = "snapshotId")]
    pub snapshot_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delta: Option<BrowserObservationDelta>,
    #[serde(default)]
    pub url: Option<String>,
    pub title: String,
    pub text: String,
    pub markdown: String,
    pub refs: Vec<BrowserObservationRef>,
    #[serde(rename = "domSummary")]
    pub dom_summary: BrowserDomSummary,
    #[serde(rename = "formFields")]
    pub form_fields: Vec<BrowserFormField>,
    #[serde(rename = "formFieldGroups", default)]
    pub form_field_groups: Vec<BrowserFormFieldGroup>,
    #[serde(rename = "accessibilityTree")]
    pub accessibility_tree: Vec<BrowserAccessibilityNode>,
    #[serde(rename = "privacyStats", default)]
    pub privacy_stats: Option<BrowserPrivacyStats>,
    #[serde(rename = "untrustedInput")]
    pub untrusted_input: bool,
    #[serde(rename = "requiresEngine")]
    pub requires_engine: bool,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserLocatorRecoveryCandidate {
    #[serde(rename = "refId")]
    pub ref_id: String,
    pub role: String,
    pub label: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub selector: Option<String>,
    #[serde(default)]
    pub action: Option<String>,
    #[serde(rename = "locatorSuggestions", default)]
    pub locator_suggestions: Vec<BrowserLocatorSuggestion>,
    #[serde(default)]
    pub visible: Option<bool>,
    #[serde(default)]
    pub enabled: Option<bool>,
    #[serde(default)]
    pub editable: Option<bool>,
    #[serde(rename = "strictMatchCount", default)]
    pub strict_match_count: Option<usize>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserAgentStepSummary {
    pub action: String,
    pub status: String,
    #[serde(
        rename = "snapshotId",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub snapshot_id: Option<String>,
    #[serde(
        rename = "targetRefId",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub target_ref_id: Option<String>,
    #[serde(
        rename = "targetSelector",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub target_selector: Option<String>,
    #[serde(rename = "currentUrl", default)]
    pub current_url: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(rename = "securityLevel")]
    pub security_level: String,
    #[serde(rename = "pageStatus")]
    pub page_status: String,
    pub refs: usize,
    #[serde(rename = "formFields")]
    pub form_fields: usize,
    #[serde(rename = "accessibilityNodes")]
    pub accessibility_nodes: usize,
    pub buttons: usize,
    pub inputs: usize,
    pub links: usize,
    #[serde(rename = "requiresEngine")]
    pub requires_engine: bool,
    #[serde(rename = "needsObserve")]
    pub needs_observe: bool,
    #[serde(rename = "nextActions")]
    pub next_actions: Vec<String>,
    #[serde(rename = "recoveryHints")]
    pub recovery_hints: Vec<String>,
    #[serde(
        rename = "failedChecks",
        default,
        skip_serializing_if = "Vec::is_empty"
    )]
    pub failed_checks: Vec<String>,
    #[serde(
        rename = "locatorCandidates",
        default,
        skip_serializing_if = "Vec::is_empty"
    )]
    pub locator_candidates: Vec<BrowserLocatorRecoveryCandidate>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserActionResponse {
    pub ok: bool,
    pub status: String,
    #[serde(rename = "taskId", default)]
    pub task_id: Option<String>,
    #[serde(rename = "currentUrl", default)]
    pub current_url: Option<String>,
    #[serde(rename = "requiredApproval", default)]
    pub required_approval: Option<String>,
    #[serde(rename = "requiresEngine")]
    pub requires_engine: bool,
    #[serde(default)]
    pub message: Option<String>,
    #[serde(default)]
    pub observation: Option<BrowserObservation>,
    #[serde(rename = "extractedText", default)]
    pub extracted_text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub actionability: Option<BrowserActionabilityCheck>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verification: Option<BrowserVerificationResult>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub screenshot: Option<BrowserScreenshotArtifact>,
    #[serde(
        rename = "findResult",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub find_result: Option<BrowserFindTextResult>,
    #[serde(
        rename = "securityState",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub security_state: Option<BrowserPageSecurityState>,
    #[serde(
        rename = "stepSummary",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub step_summary: Option<BrowserAgentStepSummary>,
    pub receipt: BrowserReceipt,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserFindTextResult {
    pub query: String,
    #[serde(rename = "matchCount")]
    pub match_count: usize,
    #[serde(rename = "activeIndex", default)]
    pub active_index: Option<usize>,
    #[serde(default)]
    pub snippet: Option<String>,
    pub scrolled: bool,
    #[serde(rename = "caseSensitive")]
    pub case_sensitive: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserScreenshotArtifact {
    pub path: String,
    pub bytes: usize,
    pub sha256: String,
    #[serde(default)]
    pub width: Option<u32>,
    #[serde(default)]
    pub height: Option<u32>,
    #[serde(rename = "fullPage", default)]
    pub full_page: bool,
    #[serde(rename = "pageWidth", default)]
    pub page_width: Option<u32>,
    #[serde(rename = "pageHeight", default)]
    pub page_height: Option<u32>,
    pub source: String,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserWindowOpenResponse {
    pub ok: bool,
    #[serde(rename = "windowLabel")]
    pub window_label: String,
    #[serde(rename = "startUrl", default)]
    pub start_url: Option<String>,
    pub receipt: BrowserReceipt,
}
