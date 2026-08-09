use super::*;

pub(crate) fn normalize_browser_developer_host(raw: &str) -> Option<String> {
    let cleaned = clean_string(raw);
    if cleaned.is_empty() {
        return None;
    }
    if cleaned.contains("://") || cleaned.starts_with("about:") {
        Url::parse(&normalize_browser_url(&cleaned))
            .ok()
            .and_then(|url| url.host_str().map(normalize_host_for_policy))
            .filter(|value| !value.is_empty())
    } else {
        Some(normalize_host_for_policy(&cleaned)).filter(|value| !value.is_empty())
    }
}

pub(crate) fn push_network_entry(
    state: &mut BrowserState,
    request: BrowserNetworkRecordRequest,
) -> BrowserNetworkEntry {
    let task_id = request
        .task_id
        .as_deref()
        .map(clean_string)
        .filter(|value| !value.is_empty())
        .or_else(|| state.active_task_id.clone());
    let browser_tab_id = request
        .browser_tab_id
        .as_deref()
        .map(clean_string)
        .filter(|value| !value.is_empty())
        .or_else(|| state.active_browser_tab_id.clone());
    let profile_id = request
        .profile_id
        .as_deref()
        .map(clean_string)
        .filter(|value| !value.is_empty())
        .or_else(|| {
            profile_id_for_task_or_tab(state, task_id.as_deref(), browser_tab_id.as_deref())
        })
        .or_else(|| state.engine.profile_id.clone())
        .or_else(|| Some("agent-work".to_string()));
    let method = request
        .method
        .trim()
        .to_ascii_uppercase()
        .chars()
        .take(16)
        .collect::<String>();
    let method = if method.is_empty() {
        "GET".to_string()
    } else {
        method
    };
    let resource_type = request
        .resource_type
        .as_str()
        .trim()
        .chars()
        .take(48)
        .collect::<String>();
    let resource_type = if resource_type.is_empty() {
        "document".to_string()
    } else {
        resource_type
    };
    let safe_url = safe_url_parts(&request.url);
    let mode = profile_id
        .as_deref()
        .map(|profile_id| {
            effective_ad_mode_for_profile_and_url(
                &state.privacy,
                &state.shields,
                profile_id,
                Some(&request.url),
            )
        })
        .unwrap_or_else(|| state.privacy.global_ad_mode.clone());
    let ad_decision = browser_ad_decision_for_url(&mode, &request.url);
    let privacy_decision = BrowserNetworkPrivacyDecision {
        mode: ad_decision.mode,
        suppressed: ad_decision.suppressed,
        presentation_masked: ad_decision.presentation_masked,
        category: ad_decision.category,
        rule_id: ad_decision.rule_id,
    };
    let entry = BrowserNetworkEntry {
        network_id: browser_id("browser-network"),
        task_id,
        browser_tab_id,
        profile_id,
        method,
        url: safe_url.url.clone(),
        origin: safe_url.origin.clone(),
        path: safe_url.path.clone(),
        query_retained: false,
        fragment_retained: false,
        body_retained: false,
        request_headers_redacted: true,
        response_headers_redacted: true,
        resource_type,
        load_status: request
            .load_status
            .as_deref()
            .map(clean_string)
            .filter(|value| !value.is_empty()),
        status: request.status,
        timing_ms: request.timing_ms,
        blocked: request.blocked,
        privacy_decision,
        t: now_ms(),
        sequence: next_browser_evidence_sequence(state),
    };
    state.network.push(entry.clone());
    if state.network.len() > 1000 {
        let overflow = state.network.len() - 1000;
        let dropped_task_ids = state
            .network
            .drain(0..overflow)
            .filter_map(|entry| entry.task_id)
            .collect::<Vec<_>>();
        state.network_retention_dropped = state
            .network_retention_dropped
            .saturating_add(overflow as u64);
        for task_id in dropped_task_ids {
            if let Some(task) = state.tasks.iter_mut().find(|task| task.task_id == task_id) {
                task.retention_dropped_network_events =
                    task.retention_dropped_network_events.saturating_add(1);
            }
        }
    }
    push_receipt(
        state,
        "browserNetworkObserved",
        entry.task_id.clone(),
        entry.profile_id.clone(),
        format!("Browser network metadata observed for {}", entry.url),
        json!({
            "networkId": entry.network_id.clone(),
            "browserTabId": entry.browser_tab_id.clone(),
            "method": entry.method.clone(),
            "url": entry.url.clone(),
            "origin": entry.origin.clone(),
            "path": entry.path.clone(),
            "resourceType": entry.resource_type.clone(),
            "loadStatus": entry.load_status.clone(),
            "status": entry.status,
            "blocked": entry.blocked,
            "queryRetained": false,
            "fragmentRetained": false,
            "bodyRetained": false,
            "requestHeadersRedacted": true,
            "responseHeadersRedacted": true,
            "privacyDecision": entry.privacy_decision.clone(),
        }),
    );
    entry
}

#[derive(Clone, Debug)]
pub(crate) struct BrowserSafeUrlParts {
    pub(crate) url: String,
    pub(crate) origin: Option<String>,
    pub(crate) path: Option<String>,
}

pub(crate) fn safe_url_parts(raw: &str) -> BrowserSafeUrlParts {
    let cleaned = clean_string(raw);
    if let Ok(parsed) = Url::parse(&cleaned) {
        if matches!(parsed.scheme(), "http" | "https") {
            let host = parsed.host_str().unwrap_or_default();
            let mut origin = format!("{}://{}", parsed.scheme(), host);
            if let Some(port) = parsed.port() {
                origin.push_str(&format!(":{}", port));
            }
            let path = if parsed.path().is_empty() {
                "/".to_string()
            } else {
                parsed.path().to_string()
            };
            return BrowserSafeUrlParts {
                url: format!("{}{}", origin, path),
                origin: Some(origin),
                path: Some(path),
            };
        }
        if parsed.scheme() == "about" {
            let path = parsed.path().to_string();
            return BrowserSafeUrlParts {
                url: format!("about:{}", path),
                origin: Some("about:".to_string()),
                path: Some(path),
            };
        }
    }
    let without_fragment = cleaned.split('#').next().unwrap_or_default();
    let without_query = without_fragment.split('?').next().unwrap_or_default();
    BrowserSafeUrlParts {
        url: without_query.chars().take(600).collect(),
        origin: None,
        path: None,
    }
}

pub(crate) fn normalize_dialog_type(value: &str) -> String {
    match value.trim().to_ascii_lowercase().as_str() {
        "alert" | "confirm" | "prompt" | "beforeunload" => value.trim().to_ascii_lowercase(),
        _ => "custom".to_string(),
    }
}

pub(crate) fn normalize_browser_permission_kind(value: &str) -> String {
    match value.trim().to_ascii_lowercase().as_str() {
        "notification" | "notifications" => "notifications".to_string(),
        "geo" | "geolocation" | "location" => "geolocation".to_string(),
        "camera" | "video" => "camera".to_string(),
        "microphone" | "mic" | "audio" => "microphone".to_string(),
        "clipboard" | "clipboard-read" | "clipboard_read" => "clipboard-read".to_string(),
        "clipboard-write" | "clipboard_write" => "clipboard-write".to_string(),
        "autoplay" => "autoplay".to_string(),
        "file-read-write" | "file_read_write" | "file-system" | "filesystem" => {
            "file-read-write".to_string()
        }
        "local-fonts" | "local_fonts" | "fonts" => "local-fonts".to_string(),
        "multiple-downloads" | "multiple_downloads" | "automatic-downloads" => {
            "multiple-downloads".to_string()
        }
        "midi" => "midi".to_string(),
        "sensors" | "other-sensors" | "other_sensors" => "sensors".to_string(),
        "storage" | "storage-access" | "storage_access" => "storage-access".to_string(),
        "window-management" | "window_management" | "window-placement" | "window_placement" => {
            "window-management".to_string()
        }
        "media" => "media".to_string(),
        _ => "unknown".to_string(),
    }
}

pub(crate) fn file_name_from_url(url: &str) -> Option<String> {
    Url::parse(url)
        .ok()
        .and_then(|parsed| {
            parsed
                .path_segments()
                .and_then(|mut segments| segments.next_back())
                .map(str::to_string)
        })
        .map(clean_string)
        .filter(|value| !value.is_empty())
}

pub(crate) fn required_approval_for_action(
    action: &str,
    sensitive_kind: Option<&str>,
) -> Option<&'static str> {
    match action {
        "submitFinal" => return Some("finalActionApproval"),
        "delete" => return Some("destructiveActionApproval"),
        "clearHistory" => return Some("destructiveActionApproval"),
        "uploadFile" => return Some("fileGrant"),
        "downloadFile" => return Some("downloadApproval"),
        "fillFromVaultGrant" => return Some("credentialGrant"),
        _ => {}
    }

    match sensitive_kind.unwrap_or_default() {
        "credentialUse" => Some("credentialGrant"),
        "sessionUse" => Some("sessionGrant"),
        "payment" => Some("agentWalletApproval"),
        "publish" | "finalAction" => Some("finalActionApproval"),
        "delete" | "destructive" => Some("destructiveActionApproval"),
        "securityChange" => Some("securityChangeApproval"),
        "rawSecretReveal" => Some("rawSecretRevealApproval"),
        "longLivedAccess" => Some("longLivedAccessApproval"),
        "softwareInstall" => Some("softwareInstallApproval"),
        "executeDownload" => Some("executeDownloadedCodeApproval"),
        _ => None,
    }
}

pub(crate) fn required_approval_for_browser_request(
    request: &BrowserActionRequest,
    action: &str,
    observation: Option<&BrowserObservation>,
) -> Option<&'static str> {
    if let Some(required) = required_approval_for_action(action, request.sensitive_kind.as_deref())
    {
        return Some(required);
    }
    if !matches!(action, "click" | "clickRef" | "clickAt" | "press") {
        return None;
    }

    let target = observed_action_target(request, observation);
    let text = target
        .map(browser_risk_target_text)
        .unwrap_or_else(|| normalize_risk_text(request.selector.as_deref()));
    required_approval_for_risk_target(action, &text, target.is_some(), request.key.as_deref())
}

fn required_approval_for_risk_target(
    action: &str,
    text: &str,
    target_observed: bool,
    key: Option<&str>,
) -> Option<&'static str> {
    if contains_risk_phrase(
        text,
        &[
            "delete",
            "delete account",
            "remove account",
            "close account",
            "erase",
            "destroy",
            "deactivate",
            "revoke",
            "discard changes",
            "cancel subscription",
            "cancel order",
            "terminate",
        ],
    ) {
        return Some("destructiveActionApproval");
    }
    if contains_risk_phrase(
        text,
        &[
            "pay",
            "pay now",
            "purchase",
            "buy now",
            "place order",
            "confirm payment",
            "subscribe",
            "send money",
            "transfer funds",
            "complete purchase",
        ],
    ) {
        return Some("agentWalletApproval");
    }
    if contains_risk_phrase(
        text,
        &[
            "change password",
            "reset password",
            "disable two factor",
            "disable 2fa",
            "enable two factor",
            "enable 2fa",
            "change permissions",
            "grant access",
            "make admin",
            "remove security",
        ],
    ) {
        return Some("securityChangeApproval");
    }
    if contains_risk_phrase(
        text,
        &[
            "install",
            "install now",
            "run installer",
            "download and run",
            "add extension",
        ],
    ) {
        return Some("softwareInstallApproval");
    }
    if contains_risk_phrase(
        text,
        &[
            "publish",
            "publish now",
            "submit",
            "submit application",
            "submit form",
            "post",
            "send email",
            "send message",
            "book now",
            "confirm booking",
            "reserve",
            "sign agreement",
            "accept terms",
            "agree and continue",
            "finalize",
            "complete registration",
            "create pull request",
            "merge",
        ],
    ) {
        return Some("finalActionApproval");
    }
    if action == "press"
        && !target_observed
        && matches!(key, Some("Enter" | "enter" | "Return" | "return"))
    {
        return Some("finalActionApproval");
    }
    None
}

impl ShellxBrowserRegistry {
    pub(crate) fn required_approval_for_engine_request(
        &self,
        request: &BrowserActionRequest,
        action: &str,
    ) -> Option<&'static str> {
        let state = lock_or_recover(&self.state);
        let task_id = request
            .task_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .or_else(|| {
                request
                    .browser_tab_id
                    .as_deref()
                    .and_then(|browser_tab_id| {
                        state
                            .tabs
                            .iter()
                            .find(|tab| tab.browser_tab_id == browser_tab_id)
                            .and_then(|tab| tab.task_id.clone())
                    })
            })
            .or_else(|| state.active_task_id.clone());
        let observation = task_id.as_deref().and_then(|task_id| {
            state
                .tasks
                .iter()
                .find(|task| task.task_id == task_id)
                .and_then(|task| task.last_observation.as_ref())
        });
        required_approval_for_browser_request(request, action, observation)
    }
}

fn observed_action_target<'a>(
    request: &BrowserActionRequest,
    observation: Option<&'a BrowserObservation>,
) -> Option<&'a BrowserObservationRef> {
    let observation = observation?;
    if let Some(ref_id) = request
        .ref_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        if let Some(reference) = observation
            .refs
            .iter()
            .find(|reference| reference.ref_id == ref_id)
        {
            return Some(reference);
        }
    }
    if let Some(selector) = request
        .selector
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        if let Some(reference) = observation.refs.iter().find(|reference| {
            reference.selector.as_deref() == Some(selector)
                || reference.raw_selector.as_deref() == Some(selector)
        }) {
            return Some(reference);
        }
    }
    let (Some(x), Some(y)) = (request.x, request.y) else {
        return None;
    };
    observation
        .refs
        .iter()
        .filter_map(|reference| {
            let bounds = reference.bounds.as_ref()?;
            let contains = x >= bounds.x
                && y >= bounds.y
                && x <= bounds.x + bounds.width
                && y <= bounds.y + bounds.height;
            contains.then_some((reference, bounds.width.max(0.0) * bounds.height.max(0.0)))
        })
        .min_by(|left, right| left.1.total_cmp(&right.1))
        .map(|(reference, _)| reference)
}

fn browser_risk_target_text(reference: &BrowserObservationRef) -> String {
    normalize_risk_text(
        [
            Some(reference.role.as_str()),
            Some(reference.label.as_str()),
            reference.name.as_deref(),
            reference.action.as_deref(),
            reference.selector.as_deref(),
            reference.raw_selector.as_deref(),
        ]
        .into_iter()
        .flatten(),
    )
}

fn normalize_risk_text<'a>(parts: impl IntoIterator<Item = &'a str>) -> String {
    let combined = parts.into_iter().collect::<Vec<_>>().join(" ");
    let normalized = combined
        .chars()
        .map(|ch| {
            if ch.is_alphanumeric() {
                ch.to_ascii_lowercase()
            } else {
                ' '
            }
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    format!(" {normalized} ")
}

fn contains_risk_phrase(text: &str, phrases: &[&str]) -> bool {
    phrases
        .iter()
        .any(|phrase| text.contains(&format!(" {} ", phrase.trim().to_ascii_lowercase())))
}

pub(crate) fn push_receipt(
    state: &mut BrowserState,
    kind: &str,
    task_id: Option<String>,
    profile_id: Option<String>,
    summary: String,
    evidence: serde_json::Value,
) -> BrowserReceipt {
    let receipt = BrowserReceipt {
        receipt_id: browser_id("browser-receipt"),
        kind: kind.to_string(),
        task_id,
        profile_id,
        summary,
        t: now_ms(),
        sequence: next_browser_evidence_sequence(state),
        evidence,
    };
    state.receipts.push(receipt.clone());
    if state.receipts.len() > 1000 {
        let overflow = state.receipts.len() - 1000;
        let dropped_task_ids = state
            .receipts
            .drain(0..overflow)
            .filter_map(|receipt| receipt.task_id)
            .collect::<Vec<_>>();
        state.receipt_retention_dropped = state
            .receipt_retention_dropped
            .saturating_add(overflow as u64);
        for task_id in dropped_task_ids {
            if let Some(task) = state.tasks.iter_mut().find(|task| task.task_id == task_id) {
                task.retention_dropped_receipts = task.retention_dropped_receipts.saturating_add(1);
            }
        }
    }
    receipt
}

pub(crate) fn next_browser_evidence_sequence(state: &mut BrowserState) -> u64 {
    state.next_evidence_sequence = state.next_evidence_sequence.saturating_add(1);
    state.next_evidence_sequence
}

#[cfg(test)]
#[path = "shellx_browser_network_receipts_tests.rs"]
mod browser_action_risk_tests;
