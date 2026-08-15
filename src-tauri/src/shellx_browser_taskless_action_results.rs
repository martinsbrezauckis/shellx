use serde_json::json;

use crate::shellx_browser::{
    clean_string, ensure_engine_matches_tab_context, now_ms, push_receipt, update_tab_url,
    BrowserActionRequest, BrowserActionResponse, BrowserEngineSnapshot, BrowserObservation,
    BrowserScreenshotArtifact, BrowserState,
};
use crate::shellx_browser_action_results::{
    replay_target_metadata, replayable_engine_control_key, replayable_engine_control_value,
    replayable_find_text_query,
};
use crate::shellx_browser_actions::EngineControlResult;
use crate::shellx_browser_observations::{
    browser_accessibility_tree_with_refs, finalize_browser_observation,
    preserve_raw_observation_selectors,
};
use crate::shellx_browser_protected_values::{
    browser_is_protected_fill_request, browser_protected_values_for_tab,
    redact_browser_observation, redact_engine_control_result,
    register_browser_protected_value_for_scope_locked,
};

pub(crate) fn record_taskless_engine_observation_locked(
    state: &mut BrowserState,
    target_tab_idx: Option<usize>,
    _request: BrowserActionRequest,
    action: &str,
    mut observation: BrowserObservation,
) -> Result<BrowserActionResponse, String> {
    let tab_idx = target_tab_idx
        .ok_or_else(|| "browser observation requires an active browser tab".to_string())?;
    ensure_engine_matches_tab_context(state, tab_idx)?;
    let previous_observation = state
        .tabs
        .get(tab_idx)
        .and_then(|tab| state.tab_observations.get(&tab.browser_tab_id))
        .cloned();
    observation.task_id = state
        .tabs
        .get(tab_idx)
        .map(|tab| tab.browser_tab_id.clone())
        .unwrap_or_else(|| "browser-user-tab".to_string());
    observation.requires_engine = false;
    preserve_raw_observation_selectors(&mut observation);
    let raw_observation_url = observation.url.clone();
    let raw_observation_title = observation.title.clone();
    let protected_values = state
        .tabs
        .get(tab_idx)
        .map(|tab| browser_protected_values_for_tab(state, &tab.browser_tab_id))
        .unwrap_or_default();
    redact_browser_observation(&mut observation, &protected_values);
    if observation.dom_summary.text_bytes == 0 && !observation.text.is_empty() {
        observation.dom_summary.text_bytes = observation.text.len();
    }
    observation.accessibility_tree =
        browser_accessibility_tree_with_refs(&observation.refs, observation.accessibility_tree);
    finalize_browser_observation(&mut observation, previous_observation.as_ref());
    let updated_at_ms = now_ms();
    let engine_snapshot = update_tab_engine_snapshot_locked(state, tab_idx, |engine| {
        engine.mounted = true;
        engine.url = raw_observation_url.clone();
        engine.pending_url = None;
        engine.title = Some(raw_observation_title.clone());
        engine.load_status = "observed".to_string();
        engine.last_error = None;
        engine.updated_at_ms = updated_at_ms;
    });
    let engine_title = engine_snapshot.and_then(|engine| engine.title);
    let shields = state.shields.clone();
    {
        let tab = state
            .tabs
            .get_mut(tab_idx)
            .ok_or_else(|| "browser observation target tab is missing".to_string())?;
        update_tab_url(tab, raw_observation_url.clone(), &shields);
        tab.title = Some(observation.title.clone()).or(engine_title);
        tab.status = "observed".to_string();
        tab.updated_at_ms = updated_at_ms;
    }
    if let Some(tab_id) = state
        .tabs
        .get(tab_idx)
        .map(|tab| tab.browser_tab_id.clone())
    {
        state.tab_observations.insert(tab_id, observation.clone());
    }
    let tab = state
        .tabs
        .get(tab_idx)
        .ok_or_else(|| "browser observation target tab is missing".to_string())?
        .clone();
    let response_current_url = observation.url.clone();
    let extracted = match action {
        "extractText" => Some(observation.text.clone()),
        "extractMarkdown" => Some(observation.markdown.clone()),
        _ => None,
    };
    let receipt_kind = match action {
        "extractText" => "browserTextExtracted",
        "extractMarkdown" => "browserMarkdownExtracted",
        _ => "browserEngineObserved",
    };
    let receipt = push_receipt(
        state,
        receipt_kind,
        None,
        Some(tab.profile_id.clone()),
        if action == "observe" {
            "Observed Browser user tab".to_string()
        } else {
            "Extracted Browser user tab content".to_string()
        },
        json!({
            "browserTabId": tab.browser_tab_id,
            "url": observation.url.clone(),
            "title": observation.title.clone(),
            "refs": observation.refs.len(),
            "domSummary": observation.dom_summary.clone(),
            "formFields": observation.form_fields.len(),
            "accessibilityNodes": observation.accessibility_tree.len(),
            "privacyStats": observation.privacy_stats.clone(),
            "textBytes": observation.text.len(),
            "markdownBytes": observation.markdown.len(),
            "source": "native-webview",
        }),
    );
    Ok(BrowserActionResponse {
        ok: true,
        status: "applied".to_string(),
        task_id: None,
        current_url: response_current_url,
        required_approval: None,
        requires_engine: false,
        message: None,
        observation: Some(observation),
        extracted_text: extracted,
        actionability: None,
        verification: None,
        screenshot: None,
        find_result: None,
        security_state: None,
        step_summary: None,
        receipt,
    })
}

pub(crate) fn record_taskless_screenshot_result_locked(
    state: &mut BrowserState,
    target_tab_idx: Option<usize>,
    _request: BrowserActionRequest,
    mut screenshot: BrowserScreenshotArtifact,
) -> Result<BrowserActionResponse, String> {
    let tab_idx = target_tab_idx
        .ok_or_else(|| "browser screenshot requires an active browser tab".to_string())?;
    ensure_engine_matches_tab_context(state, tab_idx)?;
    let updated_at_ms = now_ms();
    let engine_snapshot = update_tab_engine_snapshot_locked(state, tab_idx, |engine| {
        engine.load_status = "screenshotCaptured".to_string();
        engine.updated_at_ms = updated_at_ms;
    });
    let engine_title = engine_snapshot.and_then(|engine| engine.title);
    {
        let tab = state
            .tabs
            .get_mut(tab_idx)
            .ok_or_else(|| "browser screenshot target tab is missing".to_string())?;
        tab.status = "screenshotCaptured".to_string();
        tab.updated_at_ms = updated_at_ms;
        if tab.title.is_none() {
            tab.title = engine_title.clone();
        }
    }
    let tab = state
        .tabs
        .get(tab_idx)
        .ok_or_else(|| "browser screenshot target tab is missing".to_string())?
        .clone();
    screenshot.url = tab.url.clone();
    screenshot.title = tab.title.clone().or(engine_title);
    let receipt = push_receipt(
        state,
        "browserScreenshotCaptured",
        None,
        Some(tab.profile_id.clone()),
        "Browser user tab screenshot captured".to_string(),
        json!({
            "browserTabId": tab.browser_tab_id,
            "path": screenshot.path.clone(),
            "bytes": screenshot.bytes,
            "sha256": screenshot.sha256.clone(),
            "width": screenshot.width,
            "height": screenshot.height,
            "fullPage": screenshot.full_page,
            "pageWidth": screenshot.page_width,
            "pageHeight": screenshot.page_height,
            "source": screenshot.source.clone(),
            "url": screenshot.url.clone(),
            "title": screenshot.title.clone(),
        }),
    );
    Ok(BrowserActionResponse {
        ok: true,
        status: "applied".to_string(),
        task_id: None,
        current_url: tab.url,
        required_approval: None,
        requires_engine: false,
        message: Some("browser screenshot captured".to_string()),
        observation: None,
        extracted_text: None,
        actionability: None,
        verification: None,
        screenshot: Some(screenshot),
        find_result: None,
        security_state: None,
        step_summary: None,
        receipt,
    })
}

pub(crate) fn record_taskless_engine_control_result_locked(
    state: &mut BrowserState,
    target_tab_idx: Option<usize>,
    request: BrowserActionRequest,
    mut result: EngineControlResult,
) -> Result<BrowserActionResponse, String> {
    let tab_idx = target_tab_idx
        .ok_or_else(|| "browser action requires an active browser tab".to_string())?;
    ensure_engine_matches_tab_context(state, tab_idx)?;
    if result.ok && browser_is_protected_fill_request(&request) {
        if let Some(value) = request.value.as_deref() {
            let browser_tab_id = state
                .tabs
                .get(tab_idx)
                .map(|tab| tab.browser_tab_id.clone());
            register_browser_protected_value_for_scope_locked(
                state,
                None,
                browser_tab_id,
                value,
                request
                    .sensitive_kind
                    .as_deref()
                    .unwrap_or("hostMediatedFill"),
            );
        }
    }
    let protected_values = state
        .tabs
        .get(tab_idx)
        .map(|tab| browser_protected_values_for_tab(state, &tab.browser_tab_id))
        .unwrap_or_default();
    let raw_result_url = result
        .url
        .as_deref()
        .map(clean_string)
        .filter(|value| !value.is_empty());
    redact_engine_control_result(&mut result, &protected_values);

    let response_current_url = result
        .url
        .as_deref()
        .map(clean_string)
        .filter(|value| !value.is_empty());
    let committed_url = raw_result_url;
    let committed_title = result
        .title
        .as_deref()
        .map(clean_string)
        .filter(|value| !value.is_empty());
    let updated_at_ms = now_ms();
    let engine_status = if result.ok {
        "actionApplied".to_string()
    } else if result.status.trim().is_empty() {
        "blocked".to_string()
    } else {
        result.status.clone()
    };
    let engine_snapshot = update_tab_engine_snapshot_locked(state, tab_idx, |engine| {
        if let Some(url) = committed_url.clone() {
            engine.url = Some(url);
            engine.pending_url = None;
        }
        if let Some(title) = committed_title.clone() {
            engine.title = Some(title);
        }
        engine.load_status = engine_status.clone();
        engine.updated_at_ms = updated_at_ms;
    });
    let engine_title = engine_snapshot.and_then(|engine| engine.title);
    let shields = state.shields.clone();
    {
        let tab = state
            .tabs
            .get_mut(tab_idx)
            .ok_or_else(|| "browser action target tab is missing".to_string())?;
        if let Some(url) = committed_url.clone() {
            update_tab_url(tab, Some(url), &shields);
        }
        if committed_title.is_some() || engine_title.is_some() {
            tab.title = committed_title.clone().or(engine_title);
        }
        tab.status = engine_status.clone();
        tab.updated_at_ms = updated_at_ms;
    }

    let tab = state
        .tabs
        .get(tab_idx)
        .ok_or_else(|| "browser action target tab is missing".to_string())?
        .clone();
    let action = clean_string(&request.action);
    let status = if result.status.trim().is_empty() {
        if result.ok { "applied" } else { "blocked" }.to_string()
    } else {
        clean_string(&result.status)
    };
    let receipt_kind = if action == "verify" {
        if result.ok {
            "browserVerificationPassed"
        } else {
            "browserVerificationFailed"
        }
    } else if action == "findText" {
        "browserFindTextCompleted"
    } else if result.ok {
        "browserEngineActionApplied"
    } else {
        "browserEngineActionBlocked"
    };
    let actionability = result.actionability.clone();
    let verification = result.verification.clone();
    let find_result = result.find_result.clone();
    let last_observation = state.tab_observations.get(&tab.browser_tab_id);
    let replay_target = replay_target_metadata(&request, last_observation);
    let find_receipt = find_result.as_ref().map(|value| {
        json!({
            "query": replayable_find_text_query(&value.query),
            "queryBytes": value.query.len(),
            "matchCount": value.match_count,
            "activeIndex": value.active_index,
            "scrolled": value.scrolled,
            "caseSensitive": value.case_sensitive,
        })
    });
    let receipt = push_receipt(
        state,
        receipt_kind,
        None,
        Some(tab.profile_id.clone()),
        format!("Browser user tab engine action '{}' {}", action, status),
        json!({
            "browserTabId": tab.browser_tab_id,
            "action": action,
            "status": status,
            "refId": request.ref_id.clone(),
            "selector": replay_target.selector.clone(),
            "resolvedSelector": replay_target.selector.clone(),
            "targetLabel": replay_target.label.clone(),
            "targetRole": replay_target.role.clone(),
            "value": replayable_engine_control_value(&action, &request),
            "key": replayable_engine_control_key(&request),
            "x": request.x,
            "y": request.y,
            "force": request.force,
            "timeoutMs": request.timeout_ms,
            "message": result.message.clone(),
            "url": tab.url.clone(),
            "source": "native-webview",
            "actionability": actionability.clone(),
            "verification": verification.clone(),
            "findResult": find_receipt,
        }),
    );
    Ok(BrowserActionResponse {
        ok: result.ok,
        status,
        task_id: None,
        current_url: response_current_url.or(tab.url),
        required_approval: None,
        requires_engine: false,
        message: result.message,
        observation: None,
        extracted_text: result.extracted_text,
        actionability,
        verification,
        screenshot: None,
        find_result,
        security_state: None,
        step_summary: None,
        receipt,
    })
}

fn update_tab_engine_snapshot_locked<F>(
    state: &mut BrowserState,
    tab_idx: usize,
    mut update: F,
) -> Option<BrowserEngineSnapshot>
where
    F: FnMut(&mut BrowserEngineSnapshot),
{
    let tab = state.tabs.get(tab_idx)?;
    let engine_id = tab.engine_id.clone();
    let browser_tab_id = tab.browser_tab_id.clone();
    let task_id = tab.task_id.clone();
    let profile_id = tab.profile_id.clone();
    let engine_idx = state
        .engine_pool
        .engines
        .iter()
        .position(|engine| engine.engine_id == engine_id)?;
    {
        let engine = &mut state.engine_pool.engines[engine_idx];
        engine.browser_tab_id = Some(browser_tab_id.clone());
        engine.task_id = task_id;
        engine.profile_id = Some(profile_id);
        update(engine);
    }
    let snapshot = state.engine_pool.engines[engine_idx].clone();
    if state.active_browser_tab_id.as_deref() == Some(browser_tab_id.as_str())
        || state.engine.engine_id == snapshot.engine_id
    {
        state.engine = snapshot.clone();
        state.engine_waitlist = snapshot.waitlist.clone();
    }
    Some(snapshot)
}
