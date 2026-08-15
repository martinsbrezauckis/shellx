use serde_json::json;

use crate::shellx_browser::{
    clean_string, ensure_engine_matches_tab_context, ensure_engine_task_matches_active_context,
    lock_or_recover, now_ms, push_receipt, update_tab_url, update_task_engine_snapshot_locked,
    BrowserActionRequest, BrowserActionResponse, BrowserObservation, BrowserScreenshotArtifact,
    BrowserState, ShellxBrowserRegistry,
};
use crate::shellx_browser_actions::EngineControlResult;
use crate::shellx_browser_control::decorate_browser_step_summary_for_request;
use crate::shellx_browser_observations::{
    browser_accessibility_tree_with_refs, browser_observation_refs_with_synthetic,
    finalize_browser_observation, preserve_raw_observation_selectors,
};
use crate::shellx_browser_protected_values::{
    browser_is_protected_fill_request, browser_protected_values_for_tab,
    browser_protected_values_for_task, redact_browser_observation, redact_engine_control_result,
    register_browser_protected_value_for_scope_locked,
};
use crate::shellx_browser_security::{
    browser_origin_for_url, insecure_credential_denial_for_request,
    insecure_credential_denial_for_taskless_tab, normalize_browser_url,
};
use crate::shellx_browser_shields::apply_privacy_stats_to_tab;
use crate::shellx_browser_tabs::resolve_action_tab_index;
use crate::shellx_browser_taskless_action_results::{
    record_taskless_engine_control_result_locked, record_taskless_engine_observation_locked,
    record_taskless_screenshot_result_locked,
};
use crate::shellx_browser_tasks::{browser_agent_step_summary_for_task, find_task_index};

pub(crate) fn replayable_engine_control_value(
    action: &str,
    request: &BrowserActionRequest,
) -> Option<String> {
    if !matches!(action, "waitFor" | "scroll" | "verify") {
        return None;
    }
    request
        .value
        .as_deref()
        .map(clean_string)
        .filter(|value| !value.is_empty())
        .filter(|value| !crate::host_mcp::redact_if_credential_pattern(value))
}

pub(crate) fn replayable_engine_control_key(request: &BrowserActionRequest) -> Option<String> {
    request
        .key
        .as_deref()
        .map(clean_string)
        .filter(|value| !value.is_empty())
        .filter(|value| !crate::host_mcp::redact_if_credential_pattern(value))
}

#[derive(Default)]
pub(crate) struct BrowserReplayTargetMetadata {
    pub(crate) selector: Option<String>,
    pub(crate) label: Option<String>,
    pub(crate) role: Option<String>,
}

pub(crate) fn replayable_find_text_query(query: &str) -> Option<String> {
    let query = clean_string(query);
    if query.is_empty() || query.len() > 128 || query.chars().any(char::is_control) {
        return None;
    }
    if crate::host_mcp::redact_if_credential_pattern(&query) {
        return None;
    }
    if query.contains("://") && (query.contains('?') || query.contains('#')) {
        return None;
    }
    Some(query)
}

pub(crate) fn replay_target_metadata(
    request: &BrowserActionRequest,
    observation: Option<&BrowserObservation>,
) -> BrowserReplayTargetMetadata {
    let mut metadata = BrowserReplayTargetMetadata {
        selector: request
            .selector
            .as_deref()
            .map(clean_string)
            .filter(|value| !value.is_empty()),
        ..BrowserReplayTargetMetadata::default()
    };
    let Some(ref_id) = request
        .ref_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return metadata;
    };
    let Some(reference) = observation
        .and_then(|observation| observation.refs.iter().find(|item| item.ref_id == ref_id))
    else {
        return metadata;
    };
    if metadata.selector.is_none() {
        metadata.selector = reference
            .raw_selector
            .clone()
            .or_else(|| reference.selector.clone())
            .map(|value| clean_string(&value))
            .filter(|value| !value.is_empty());
    }
    metadata.label = Some(clean_string(&reference.label)).filter(|value| !value.is_empty());
    metadata.role = Some(clean_string(&reference.role)).filter(|value| !value.is_empty());
    metadata
}

impl ShellxBrowserRegistry {
    pub fn record_engine_observation(
        &self,
        request: BrowserActionRequest,
        action: &str,
        mut observation: BrowserObservation,
    ) -> Result<BrowserActionResponse, String> {
        let mut state = lock_or_recover(&self.state);
        let target_tab_idx = resolve_action_tab_index(&state, &request)?;
        let task_id = action_task_id_for_request(&state, &request, target_tab_idx)?;
        let Some(task_id) = task_id else {
            return record_taskless_engine_observation_locked(
                &mut state,
                target_tab_idx,
                request,
                action,
                observation,
            );
        };
        let idx = find_task_index(&state, &task_id)?;
        let previous_observation = state.tasks[idx].last_observation.clone();
        let raw_observation_url = observation.url.clone();
        let raw_observation_title = observation.title.clone();
        reconcile_task_engine_result_before_context_check(
            &mut state,
            &task_id,
            target_tab_idx,
            raw_observation_url.as_deref(),
            Some(raw_observation_title.as_str()),
        );
        ensure_engine_task_matches_active_context(&state, &task_id)?;
        observation.task_id = task_id.clone();
        observation.requires_engine = false;
        preserve_raw_observation_selectors(&mut observation);
        let protected_values = target_tab_idx
            .and_then(|tab_idx| state.tabs.get(tab_idx))
            .map(|tab| browser_protected_values_for_tab(&state, &tab.browser_tab_id))
            .unwrap_or_else(|| browser_protected_values_for_task(&state, &task_id));
        redact_browser_observation(&mut observation, &protected_values);
        state.tasks[idx].current_url = raw_observation_url.clone();
        let refs_task = state.tasks[idx].clone();
        observation.refs = browser_observation_refs_with_synthetic(
            &refs_task,
            observation.url.clone(),
            observation.refs,
        );
        if observation.dom_summary.text_bytes == 0 && !observation.text.is_empty() {
            observation.dom_summary.text_bytes = observation.text.len();
        }
        observation.accessibility_tree =
            browser_accessibility_tree_with_refs(&observation.refs, observation.accessibility_tree);
        finalize_browser_observation(&mut observation, previous_observation.as_ref());
        state.tasks[idx].last_observation = Some(observation.clone());
        let updated_at_ms = now_ms();
        state.tasks[idx].updated_at_ms = updated_at_ms;
        update_task_engine_snapshot_locked(&mut state, &task_id, |engine| {
            engine.mounted = true;
            engine.url = raw_observation_url.clone();
            engine.pending_url = None;
            engine.title = Some(raw_observation_title.clone());
            engine.load_status = "observed".to_string();
            engine.last_error = None;
            engine.updated_at_ms = updated_at_ms;
        });
        let task = state.tasks[idx].clone();
        let shields = state.shields.clone();
        update_task_target_tab_locked(&mut state, target_tab_idx, &task.task_id, |tab| {
            update_tab_url(tab, raw_observation_url.clone(), &shields);
            apply_privacy_stats_to_tab(tab, observation.privacy_stats.as_ref());
            tab.title = Some(observation.title.clone());
            tab.status = "observed".to_string();
        });
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
            &mut state,
            receipt_kind,
            Some(task.task_id.clone()),
            Some(task.profile_id.clone()),
            if action == "observe" {
                format!("Observed Browser engine page for task {}", task.task_id)
            } else {
                format!("Extracted Browser engine content for task {}", task.task_id)
            },
            json!({
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
        let step_summary = browser_agent_step_summary_for_task(
            &state,
            &task,
            action,
            "applied",
            false,
            None,
            Some(&observation),
            None,
            None,
        );
        let mut step_summary = step_summary;
        decorate_browser_step_summary_for_request(
            &mut step_summary,
            &request,
            Some(&observation),
            None,
        );
        Ok(BrowserActionResponse {
            ok: true,
            status: "applied".to_string(),
            task_id: Some(task.task_id),
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
            step_summary: Some(step_summary),
            receipt,
        })
    }

    pub(crate) fn record_engine_control_result(
        &self,
        request: BrowserActionRequest,
        mut result: EngineControlResult,
    ) -> Result<BrowserActionResponse, String> {
        let mut state = lock_or_recover(&self.state);
        let target_tab_idx = resolve_action_tab_index(&state, &request)?;
        let task_id = action_task_id_for_request(&state, &request, target_tab_idx)?;
        let Some(task_id) = task_id else {
            return record_taskless_engine_control_result_locked(
                &mut state,
                target_tab_idx,
                request,
                result,
            );
        };
        let idx = find_task_index(&state, &task_id)?;
        let raw_result_url = result
            .url
            .as_deref()
            .map(clean_string)
            .filter(|value| !value.is_empty());
        let committed_title = result
            .title
            .as_deref()
            .map(clean_string)
            .filter(|value| !value.is_empty());
        if result.ok {
            reconcile_task_engine_result_before_context_check(
                &mut state,
                &task_id,
                target_tab_idx,
                raw_result_url.as_deref(),
                committed_title.as_deref(),
            );
        }
        ensure_engine_task_matches_active_context(&state, &task_id)?;
        if result.ok && browser_is_protected_fill_request(&request) {
            if let Some(value) = request.value.as_deref() {
                let browser_tab_id = target_tab_idx
                    .and_then(|tab_idx| state.tabs.get(tab_idx))
                    .map(|tab| tab.browser_tab_id.clone());
                register_browser_protected_value_for_scope_locked(
                    &mut state,
                    Some(task_id.clone()),
                    browser_tab_id,
                    value,
                    request
                        .sensitive_kind
                        .as_deref()
                        .unwrap_or("hostMediatedFill"),
                );
            }
        }
        let protected_values = target_tab_idx
            .and_then(|tab_idx| state.tabs.get(tab_idx))
            .map(|tab| browser_protected_values_for_tab(&state, &tab.browser_tab_id))
            .unwrap_or_else(|| browser_protected_values_for_task(&state, &task_id));
        redact_engine_control_result(&mut result, &protected_values);
        let response_current_url = result
            .url
            .as_deref()
            .map(clean_string)
            .filter(|value| !value.is_empty());
        let committed_url = raw_result_url;
        if let Some(url) = committed_url.clone() {
            state.tasks[idx].current_url = Some(url.clone());
        }
        let updated_at_ms = now_ms();
        state.tasks[idx].updated_at_ms = updated_at_ms;
        let engine_status = if result.ok {
            "actionApplied".to_string()
        } else {
            result.status.clone()
        };
        let engine_snapshot = update_task_engine_snapshot_locked(&mut state, &task_id, |engine| {
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
        let task = state.tasks[idx].clone();
        let browser_tab_id = state
            .tabs
            .iter()
            .find(|tab| tab.task_id.as_deref() == Some(task.task_id.as_str()))
            .map(|tab| tab.browser_tab_id.clone());
        let shields = state.shields.clone();
        update_task_target_tab_locked(&mut state, target_tab_idx, &task.task_id, |tab| {
            update_tab_url(tab, task.current_url.clone(), &shields);
            tab.title = engine_title.clone();
            tab.status = engine_status.clone();
        });
        let action = clean_string(&request.action);
        let status = if result.status.trim().is_empty() {
            if result.ok { "applied" } else { "blocked" }.to_string()
        } else {
            clean_string(result.status)
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
        let last_observation = task.last_observation.as_ref();
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
            &mut state,
            receipt_kind,
            Some(task.task_id.clone()),
            Some(task.profile_id.clone()),
            format!("Browser engine action '{}' {}", action, status),
            json!({
                "browserTabId": browser_tab_id,
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
                "message": result.message,
                "url": response_current_url.clone(),
                "source": "native-webview",
                "actionability": actionability.clone(),
                "verification": verification.clone(),
                "findResult": find_receipt,
            }),
        );
        let step_summary = browser_agent_step_summary_for_task(
            &state,
            &task,
            &action,
            &status,
            false,
            None,
            None,
            actionability.as_ref(),
            verification.as_ref(),
        );
        let mut step_summary = step_summary;
        decorate_browser_step_summary_for_request(
            &mut step_summary,
            &request,
            last_observation,
            actionability.as_ref(),
        );
        Ok(BrowserActionResponse {
            ok: result.ok,
            status,
            task_id: Some(task.task_id),
            current_url: response_current_url.or(task.current_url),
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
            step_summary: Some(step_summary),
            receipt,
        })
    }

    pub(crate) fn record_screenshot_result(
        &self,
        request: BrowserActionRequest,
        mut screenshot: BrowserScreenshotArtifact,
    ) -> Result<BrowserActionResponse, String> {
        if let Some(blocked) = self.block_screenshot_if_protected_values(&request)? {
            return Ok(blocked);
        }
        let mut state = lock_or_recover(&self.state);
        let target_tab_idx = resolve_action_tab_index(&state, &request)?;
        let task_id = action_task_id_for_request(&state, &request, target_tab_idx)?;
        let Some(task_id) = task_id else {
            return record_taskless_screenshot_result_locked(
                &mut state,
                target_tab_idx,
                request,
                screenshot,
            );
        };
        let idx = find_task_index(&state, &task_id)?;
        ensure_engine_task_matches_active_context(&state, &task_id)?;
        let updated_at_ms = now_ms();
        state.tasks[idx].updated_at_ms = updated_at_ms;
        let engine_snapshot = update_task_engine_snapshot_locked(&mut state, &task_id, |engine| {
            engine.load_status = "screenshotCaptured".to_string();
            engine.updated_at_ms = updated_at_ms;
        });
        let task = state.tasks[idx].clone();
        update_task_target_tab_locked(&mut state, target_tab_idx, &task.task_id, |tab| {
            tab.status = "screenshotCaptured".to_string();
        });
        screenshot.url = task.current_url.clone();
        screenshot.title = engine_snapshot.and_then(|engine| engine.title);
        let receipt = push_receipt(
            &mut state,
            "browserScreenshotCaptured",
            Some(task.task_id.clone()),
            Some(task.profile_id.clone()),
            format!("Browser screenshot captured for task {}", task.task_id),
            json!({
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
        let step_summary = browser_agent_step_summary_for_task(
            &state,
            &task,
            "captureScreenshot",
            "applied",
            false,
            None,
            None,
            None,
            None,
        );
        Ok(BrowserActionResponse {
            ok: true,
            status: "applied".to_string(),
            task_id: Some(task.task_id),
            current_url: task.current_url,
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
            step_summary: Some(step_summary),
            receipt,
        })
    }

    pub fn engine_action_targets_active_context(
        &self,
        request: &BrowserActionRequest,
    ) -> Result<bool, String> {
        let mut state = lock_or_recover(&self.state);
        let Some(tab_idx) = resolve_action_tab_index(&state, request)? else {
            return Ok(false);
        };
        reconcile_allocated_engine_before_context_check(&mut state, tab_idx);
        ensure_engine_matches_tab_context(&state, tab_idx).map(|_| true)
    }

    pub fn credential_entry_denial_for_action(
        &self,
        request: &BrowserActionRequest,
    ) -> Result<Option<BrowserActionResponse>, String> {
        let action = clean_string(&request.action);
        if action.is_empty() {
            return Ok(None);
        }
        let mut state = lock_or_recover(&self.state);
        let target_tab_idx = resolve_action_tab_index(&state, request)?;
        let task_id = if let Some(task_id) = request
            .task_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            Some(task_id.to_string())
        } else {
            target_tab_idx
                .and_then(|tab_idx| state.tabs[tab_idx].task_id.clone())
                .or_else(|| state.active_task_id.clone())
        };
        let Some(task_id) = task_id else {
            if let Some(tab_idx) = target_tab_idx {
                return Ok(insecure_credential_denial_for_taskless_tab(
                    &mut state, tab_idx, request, &action,
                ));
            }
            return Ok(None);
        };
        let idx = find_task_index(&state, &task_id)?;
        Ok(insecure_credential_denial_for_request(
            &mut state,
            target_tab_idx,
            idx,
            request,
            &action,
        ))
    }

    pub fn vault_grant_actor_context_for_action(
        &self,
        request: &BrowserActionRequest,
        authenticated_agent_id: Option<&str>,
    ) -> Result<crate::shellx_vault::GrantActorContext, String> {
        let state = lock_or_recover(&self.state);
        let target_tab_idx = resolve_action_tab_index(&state, request)?;
        let task_id = if let Some(task_id) = request
            .task_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            Some(task_id.to_string())
        } else {
            target_tab_idx
                .and_then(|tab_idx| state.tabs[tab_idx].task_id.clone())
                .or_else(|| state.active_task_id.clone())
        };
        let task_url = task_id.as_deref().and_then(|id| {
            state
                .tasks
                .iter()
                .find(|task| task.task_id == id)
                .and_then(|task| task.current_url.clone())
        });
        let current_url = target_tab_idx
            .and_then(|idx| state.tabs.get(idx).and_then(|tab| tab.url.clone()))
            .or(task_url)
            .or_else(|| state.engine.url.clone());
        Ok(crate::shellx_vault::GrantActorContext {
            agent_id: crate::shellx_browser_caller::browser_vault_agent_identity(
                authenticated_agent_id,
                request.owner_agent_id.as_deref(),
            ),
            provider_id: None,
            workspace: None,
            origin: current_url.as_deref().and_then(browser_origin_for_url),
            connector_id: None,
        })
    }
}

fn action_task_id_for_request(
    state: &BrowserState,
    request: &BrowserActionRequest,
    target_tab_idx: Option<usize>,
) -> Result<Option<String>, String> {
    let requested_task_id = request
        .task_id
        .as_deref()
        .map(clean_string)
        .filter(|value| !value.is_empty());
    if let Some(tab_idx) = target_tab_idx {
        let tab_task_id = state.tabs[tab_idx].task_id.clone();
        if let Some(requested_task_id) = requested_task_id {
            if tab_task_id.as_deref() != Some(requested_task_id.as_str()) {
                return Err("browserTabId/taskId mismatch for Browser action target".to_string());
            }
            return Ok(Some(requested_task_id));
        }
        return Ok(tab_task_id);
    }
    if let Some(task_id) = request
        .task_id
        .as_deref()
        .map(clean_string)
        .filter(|value| !value.is_empty())
    {
        return Ok(Some(task_id));
    }
    Ok(state.active_task_id.clone())
}

fn reconcile_task_engine_result_before_context_check(
    state: &mut BrowserState,
    task_id: &str,
    target_tab_idx: Option<usize>,
    raw_url: Option<&str>,
    raw_title: Option<&str>,
) {
    let Some(url) = raw_url.map(clean_string).filter(|value| !value.is_empty()) else {
        return;
    };
    let title = raw_title
        .map(clean_string)
        .filter(|value| !value.is_empty());
    let updated_at_ms = now_ms();
    if let Ok(idx) = find_task_index(state, task_id) {
        state.tasks[idx].current_url = Some(url.clone());
        state.tasks[idx].updated_at_ms = updated_at_ms;
    }
    let engine_title = title.clone();
    update_task_engine_snapshot_locked(state, task_id, |engine| {
        engine.url = Some(url.clone());
        engine.pending_url = None;
        if let Some(title) = engine_title.clone() {
            engine.title = Some(title);
        }
        if matches!(
            engine.load_status.as_str(),
            "open" | "loading" | "navigating"
        ) {
            engine.load_status = "loaded".to_string();
        }
        engine.last_error = None;
        engine.updated_at_ms = updated_at_ms;
    });
    let shields = state.shields.clone();
    update_task_target_tab_locked(state, target_tab_idx, task_id, |tab| {
        update_tab_url(tab, Some(url.clone()), &shields);
        if let Some(title) = title.clone() {
            tab.title = Some(title);
        }
        if matches!(tab.status.as_str(), "open" | "loading" | "navigating") {
            tab.status = "loaded".to_string();
        }
    });
}

fn reconcile_allocated_engine_before_context_check(state: &mut BrowserState, tab_idx: usize) {
    let Some(tab) = state.tabs.get(tab_idx).cloned() else {
        return;
    };
    let Some(engine) = state
        .engine_pool
        .engines
        .iter()
        .find(|engine| engine.engine_id == tab.engine_id)
        .cloned()
        .or_else(|| (state.engine.engine_id == tab.engine_id).then_some(state.engine.clone()))
    else {
        return;
    };
    if engine.pending_url.is_some() || engine.load_status == "navigating" {
        return;
    }
    let Some(engine_url) = engine
        .url
        .as_deref()
        .map(clean_string)
        .filter(|value| !value.is_empty())
    else {
        return;
    };
    if tab
        .url
        .as_deref()
        .map(|tab_url| normalize_browser_url(tab_url) == normalize_browser_url(&engine_url))
        .unwrap_or(false)
    {
        return;
    }
    let engine_title = engine.title.as_deref();
    if let Some(task_id) = tab.task_id.as_deref() {
        reconcile_task_engine_result_before_context_check(
            state,
            task_id,
            Some(tab_idx),
            Some(&engine_url),
            engine_title,
        );
        return;
    }
    let title = engine_title
        .map(clean_string)
        .filter(|value| !value.is_empty());
    let shields = state.shields.clone();
    if let Some(tab) = state.tabs.get_mut(tab_idx) {
        update_tab_url(tab, Some(engine_url), &shields);
        if let Some(title) = title {
            tab.title = Some(title);
        }
        if matches!(tab.status.as_str(), "open" | "loading" | "navigating") {
            tab.status = "loaded".to_string();
        }
        tab.updated_at_ms = now_ms();
    }
}

fn update_task_target_tab_locked<F>(
    state: &mut BrowserState,
    target_tab_idx: Option<usize>,
    task_id: &str,
    mut f: F,
) where
    F: FnMut(&mut crate::shellx_browser::BrowserTabSnapshot),
{
    let target_tab_id = target_tab_idx
        .and_then(|idx| state.tabs.get(idx))
        .filter(|tab| tab.task_id.as_deref() == Some(task_id))
        .map(|tab| tab.browser_tab_id.clone())
        .or_else(|| {
            state
                .tabs
                .iter()
                .find(|tab| tab.task_id.as_deref() == Some(task_id))
                .map(|tab| tab.browser_tab_id.clone())
        });
    let Some(target_tab_id) = target_tab_id else {
        return;
    };
    if let Some(tab) = state
        .tabs
        .iter_mut()
        .find(|tab| tab.browser_tab_id == target_tab_id)
    {
        f(tab);
        tab.updated_at_ms = now_ms();
    }
}
