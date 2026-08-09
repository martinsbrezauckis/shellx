use super::*;

impl ShellxBrowserRegistry {
    pub fn apply_action(
        &self,
        mut request: BrowserActionRequest,
    ) -> Result<BrowserActionResponse, String> {
        let mut state = lock_or_recover(&self.state);
        let action = clean_string(&request.action);
        if action.is_empty() {
            return Err("browser action is required".to_string());
        }
        let target_tab_idx = resolve_action_tab_index(&state, &request)?;
        if let (Some(tab_idx), Some(requested_task_id)) = (
            target_tab_idx,
            request
                .task_id
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty()),
        ) {
            if state.tabs[tab_idx].task_id.as_deref() != Some(requested_task_id) {
                if let Some(response) =
                    crate::shellx_browser_personal_lock::personal_lock_denial_for_request(
                        &mut state, tab_idx, &request, &action,
                    )
                {
                    return Ok(response);
                }
                return Err("browserTabId/taskId mismatch for Browser action target".to_string());
            }
        }
        if request.task_id.is_none() {
            if let Some(tab_idx) = target_tab_idx {
                request.task_id = state.tabs[tab_idx].task_id.clone();
            }
        }
        if let Some(tab_idx) = target_tab_idx {
            if let Some(response) =
                crate::shellx_browser_personal_lock::personal_lock_denial_for_request(
                    &mut state, tab_idx, &request, &action,
                )
            {
                return Ok(response);
            }
            if let Some(response) =
                tab_lock_denial_for_request(&mut state, tab_idx, &request, &action)
            {
                return Ok(response);
            }
        }
        let target_is_taskless_tab = target_tab_idx
            .map(|tab_idx| state.tabs[tab_idx].task_id.is_none())
            .unwrap_or_else(|| state.active_task_id.is_none());
        if request.task_id.is_none()
            && target_is_taskless_tab
            && matches!(action.as_str(), "navigate" | "bookmarkCurrent")
        {
            match action.as_str() {
                "navigate" => {
                    let raw_url = request
                        .url
                        .as_deref()
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                        .ok_or_else(|| "navigate action requires url".to_string())?
                        .to_string();
                    let target_profile_id = target_tab_idx
                        .map(|tab_idx| state.tabs[tab_idx].profile_id.clone())
                        .unwrap_or_else(|| "personal".to_string());
                    let url = validate_browser_navigation_target(
                        &raw_url,
                        &[],
                        &[],
                        &target_profile_id,
                        false,
                    )?;
                    let tab_idx = if let Some(tab_idx) = target_tab_idx {
                        tab_idx
                    } else {
                        let tab = create_browser_tab(
                            &mut state,
                            None,
                            target_profile_id.clone(),
                            Some(url.clone()),
                            None,
                            "open".to_string(),
                        );
                        state.tabs.push(tab);
                        state.tabs.len() - 1
                    };
                    let browser_tab_id = state.tabs[tab_idx].browser_tab_id.clone();
                    let profile_id = state.tabs[tab_idx].profile_id.clone();
                    let shields = state.shields.clone();
                    {
                        let tab = &mut state.tabs[tab_idx];
                        update_tab_url(tab, Some(url.clone()), &shields);
                        tab.status = "navigated".to_string();
                        tab.updated_at_ms = now_ms();
                    }
                    state.active_task_id = None;
                    set_active_tab(&mut state, &browser_tab_id);
                    record_history_visit(&mut state, None, profile_id.clone(), url.clone(), None);
                    push_network_entry(
                        &mut state,
                        BrowserNetworkRecordRequest {
                            task_id: None,
                            browser_tab_id: Some(browser_tab_id.clone()),
                            profile_id: Some(profile_id.clone()),
                            method: "GET".to_string(),
                            url: url.clone(),
                            resource_type: "document".to_string(),
                            load_status: Some("navigated".to_string()),
                            ..BrowserNetworkRecordRequest::default()
                        },
                    );
                    let receipt = push_receipt(
                        &mut state,
                        "browserUserNavigated",
                        None,
                        Some(profile_id),
                        format!("Browser user tab navigated to {}", url),
                        json!({
                            "browserTabId": browser_tab_id,
                            "url": url,
                        }),
                    );
                    return Ok(BrowserActionResponse {
                        ok: true,
                        status: "applied".to_string(),
                        task_id: None,
                        current_url: Some(url),
                        required_approval: None,
                        requires_engine: false,
                        message: None,
                        observation: None,
                        extracted_text: None,
                        actionability: None,
                        verification: None,
                        screenshot: None,
                        find_result: None,
                        security_state: None,
                        step_summary: None,
                        receipt,
                    });
                }
                "bookmarkCurrent" => {
                    // taskless bookmarkCurrent keeps user bookmarks usable outside an agent task.
                    let url = target_tab_idx
                        .and_then(|tab_idx| state.tabs[tab_idx].url.clone())
                        .or_else(|| state.engine.url.clone())
                        .or_else(|| request.url.clone())
                        .map(|value| clean_string(&value))
                        .filter(|value| !value.is_empty())
                        .ok_or_else(|| "bookmarkCurrent requires a current page URL".to_string())?;
                    let profile_id = target_tab_idx
                        .map(|tab_idx| state.tabs[tab_idx].profile_id.clone())
                        .or_else(|| state.engine.profile_id.clone())
                        .unwrap_or_else(|| "personal".to_string());
                    let label = request
                        .value
                        .as_deref()
                        .map(clean_string)
                        .filter(|value| !value.is_empty())
                        .or_else(|| state.engine.title.clone())
                        .unwrap_or_else(|| {
                            crate::shellx_browser_bookmarks::bookmark_label_for_url(&url)
                        });
                    let now = now_ms();
                    if let Some(existing) = state
                        .bookmarks
                        .iter_mut()
                        .find(|item| item.url.as_deref() == Some(url.as_str()))
                    {
                        existing.label = label.clone();
                        existing.category = "saved".to_string();
                        existing.kind = BrowserBookmarkKind::Link;
                        existing.updated_at_ms = now;
                    } else {
                        state.bookmarks.insert(
                            0,
                            BrowserBookmark {
                                bookmark_id: browser_id("browser-bookmark"),
                                label: label.clone(),
                                url: Some(url.clone()),
                                category: "saved".to_string(),
                                kind: BrowserBookmarkKind::Link,
                                parent_id: None,
                                toolbar_pinned: false,
                                toolbar_order: None,
                                agent_workflow: None,
                                created_at_ms: now,
                                updated_at_ms: now,
                            },
                        );
                    }
                    state.bookmarks.truncate(100);
                    let receipt = push_receipt(
                        &mut state,
                        "browserBookmarkSaved",
                        None,
                        Some(profile_id),
                        format!("Saved Browser bookmark: {}", label),
                        json!({
                            "url": url,
                            "label": label,
                        }),
                    );
                    return Ok(BrowserActionResponse {
                        ok: true,
                        status: "applied".to_string(),
                        task_id: None,
                        current_url: Some(url),
                        required_approval: None,
                        requires_engine: false,
                        message: None,
                        observation: None,
                        extracted_text: None,
                        actionability: None,
                        verification: None,
                        screenshot: None,
                        find_result: None,
                        security_state: None,
                        step_summary: None,
                        receipt,
                    });
                }
                _ => {}
            }
        }
        let task_id = resolve_task_id(&state, request.task_id.clone())?;
        let idx = find_task_index(&state, &task_id)?;
        if let Some(response) =
            task_control_blocked_response(&mut state, target_tab_idx, idx, &action)
        {
            return Ok(response);
        }

        if let Some(response) = insecure_credential_denial_for_request(
            &mut state,
            target_tab_idx,
            idx,
            &request,
            &action,
        ) {
            return Ok(response);
        }

        if let Some(response) =
            cdp_access_denial_for_request(&mut state, target_tab_idx, idx, &request, &action)
        {
            return Ok(response);
        }

        if let Some(required) = required_approval_for_browser_request(
            &request,
            &action,
            state.tasks[idx].last_observation.as_ref(),
        ) {
            let task = state.tasks[idx].clone();
            let receipt = push_receipt(
                &mut state,
                "browserActionBlocked",
                Some(task.task_id.clone()),
                Some(task.profile_id.clone()),
                format!(
                    "Blocked browser action '{}' until {} approval",
                    action, required
                ),
                json!({
                    "action": action,
                    "requiredApproval": required,
                    "refId": request.ref_id,
                    "sensitiveKind": request.sensitive_kind,
                }),
            );
            let step_summary = browser_agent_step_summary_for_task(
                &state,
                &task,
                &action,
                "blocked",
                false,
                Some(required),
                None,
                None,
                None,
            );
            return Ok(BrowserActionResponse {
                ok: false,
                status: "blocked".to_string(),
                task_id: Some(task.task_id),
                current_url: task.current_url,
                required_approval: Some(required.to_string()),
                requires_engine: false,
                message: Some(format!("action requires {}", required)),
                observation: None,
                extracted_text: None,
                actionability: None,
                verification: None,
                screenshot: None,
                find_result: None,
                security_state: None,
                step_summary: Some(step_summary),
                receipt,
            });
        }

        match action.as_str() {
            "navigate" => {
                let raw_url = request
                    .url
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .ok_or_else(|| "navigate action requires url".to_string())?
                    .to_string();
                let url = validate_browser_navigation_target(
                    &raw_url,
                    &state.tasks[idx].expected_domains,
                    &state.tasks[idx].blocked_domains,
                    &state.tasks[idx].profile_id,
                    true,
                )?;
                state.tasks[idx].current_url = Some(url.clone());
                state.tasks[idx].updated_at_ms = now_ms();
                let task_id = state.tasks[idx].task_id.clone();
                let profile_id = state.tasks[idx].profile_id.clone();
                record_history_visit(
                    &mut state,
                    Some(task_id.clone()),
                    profile_id.clone(),
                    url.clone(),
                    None,
                );
                let task = state.tasks[idx].clone();
                let shields = state.shields.clone();
                sync_tabs_for_task(&mut state, &task.task_id, |tab| {
                    update_tab_url(tab, Some(url.clone()), &shields);
                    tab.status = "navigated".to_string();
                });
                let browser_tab_id = state
                    .tabs
                    .iter()
                    .find(|tab| tab.task_id.as_deref() == Some(task.task_id.as_str()))
                    .map(|tab| tab.browser_tab_id.clone());
                push_network_entry(
                    &mut state,
                    BrowserNetworkRecordRequest {
                        task_id: Some(task_id),
                        browser_tab_id: browser_tab_id.clone(),
                        profile_id: Some(profile_id),
                        method: "GET".to_string(),
                        url: url.clone(),
                        resource_type: "document".to_string(),
                        load_status: Some("navigated".to_string()),
                        ..BrowserNetworkRecordRequest::default()
                    },
                );
                let receipt = push_receipt(
                    &mut state,
                    "browserNavigated",
                    Some(task.task_id.clone()),
                    Some(task.profile_id.clone()),
                    format!("Browser navigated to {}", url),
                    json!({
                        "browserTabId": browser_tab_id,
                        "url": url,
                    }),
                );
                let step_summary = browser_agent_step_summary_for_task(
                    &state, &task, &action, "applied", false, None, None, None, None,
                );
                Ok(BrowserActionResponse {
                    ok: true,
                    status: "applied".to_string(),
                    task_id: Some(task.task_id),
                    current_url: task.current_url,
                    required_approval: None,
                    requires_engine: false,
                    message: None,
                    observation: None,
                    extracted_text: None,
                    actionability: None,
                    verification: None,
                    screenshot: None,
                    find_result: None,
                    security_state: None,
                    step_summary: Some(step_summary),
                    receipt,
                })
            }
            "bookmarkCurrent" => {
                let url = state.tasks[idx]
                    .current_url
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .ok_or_else(|| "bookmarkCurrent requires a current page URL".to_string())?
                    .to_string();
                let label = request
                    .value
                    .as_deref()
                    .map(clean_string)
                    .filter(|value| !value.is_empty())
                    .or_else(|| state.engine.title.clone())
                    .unwrap_or_else(|| {
                        crate::shellx_browser_bookmarks::bookmark_label_for_url(&url)
                    });
                let now = now_ms();
                if let Some(existing) = state
                    .bookmarks
                    .iter_mut()
                    .find(|item| item.url.as_deref() == Some(url.as_str()))
                {
                    existing.label = label.clone();
                    existing.category = "saved".to_string();
                    existing.kind = BrowserBookmarkKind::Link;
                    existing.updated_at_ms = now;
                } else {
                    state.bookmarks.insert(
                        0,
                        BrowserBookmark {
                            bookmark_id: browser_id("browser-bookmark"),
                            label: label.clone(),
                            url: Some(url.clone()),
                            category: "saved".to_string(),
                            kind: BrowserBookmarkKind::Link,
                            parent_id: None,
                            toolbar_pinned: false,
                            toolbar_order: None,
                            agent_workflow: None,
                            created_at_ms: now,
                            updated_at_ms: now,
                        },
                    );
                }
                state.bookmarks.truncate(100);
                let task = state.tasks[idx].clone();
                let receipt = push_receipt(
                    &mut state,
                    "browserBookmarkSaved",
                    Some(task.task_id.clone()),
                    Some(task.profile_id.clone()),
                    format!("Saved Browser bookmark: {}", label),
                    json!({
                        "url": url,
                        "label": label,
                    }),
                );
                let step_summary = browser_agent_step_summary_for_task(
                    &state, &task, &action, "applied", false, None, None, None, None,
                );
                Ok(BrowserActionResponse {
                    ok: true,
                    status: "applied".to_string(),
                    task_id: Some(task.task_id),
                    current_url: task.current_url,
                    required_approval: None,
                    requires_engine: false,
                    message: None,
                    observation: None,
                    extracted_text: None,
                    actionability: None,
                    verification: None,
                    screenshot: None,
                    find_result: None,
                    security_state: None,
                    step_summary: Some(step_summary),
                    receipt,
                })
            }
            "observe" => {
                let observation = observation_for_task(&state.tasks[idx]);
                state.tasks[idx].last_observation = Some(observation.clone());
                state.tasks[idx].updated_at_ms = now_ms();
                let task = state.tasks[idx].clone();
                let shields = state.shields.clone();
                sync_tabs_for_task(&mut state, &task.task_id, |tab| {
                    update_tab_url(tab, task.current_url.clone(), &shields);
                    tab.title = Some(observation.title.clone());
                    tab.status = "observed".to_string();
                });
                let receipt = push_receipt(
                    &mut state,
                    "browserPageObserved",
                    Some(task.task_id.clone()),
                    Some(task.profile_id.clone()),
                    format!("Observed browser page for task {}", task.task_id),
                    json!({
                        "url": task.current_url,
                        "refs": observation.refs.len(),
                        "domSummary": observation.dom_summary.clone(),
                        "formFields": observation.form_fields.len(),
                        "accessibilityNodes": observation.accessibility_tree.len(),
                        "requiresEngine": observation.requires_engine,
                    }),
                );
                let step_summary = browser_agent_step_summary_for_task(
                    &state,
                    &task,
                    &action,
                    "applied",
                    observation.requires_engine,
                    None,
                    Some(&observation),
                    None,
                    None,
                );
                Ok(BrowserActionResponse {
                    ok: true,
                    status: "applied".to_string(),
                    task_id: Some(task.task_id),
                    current_url: task.current_url,
                    required_approval: None,
                    requires_engine: observation.requires_engine,
                    message: None,
                    observation: Some(observation),
                    extracted_text: None,
                    actionability: None,
                    verification: None,
                    screenshot: None,
                    find_result: None,
                    security_state: None,
                    step_summary: Some(step_summary),
                    receipt,
                })
            }
            "extractText" | "extractMarkdown" => {
                let observation = observation_for_task(&state.tasks[idx]);
                state.tasks[idx].last_observation = Some(observation.clone());
                state.tasks[idx].updated_at_ms = now_ms();
                let task = state.tasks[idx].clone();
                let shields = state.shields.clone();
                sync_tabs_for_task(&mut state, &task.task_id, |tab| {
                    update_tab_url(tab, task.current_url.clone(), &shields);
                    tab.title = Some(observation.title.clone());
                    tab.status = "observed".to_string();
                });
                let extracted = if action == "extractMarkdown" {
                    observation.markdown.clone()
                } else {
                    observation.text.clone()
                };
                let receipt = push_receipt(
                    &mut state,
                    if action == "extractMarkdown" {
                        "browserMarkdownExtracted"
                    } else {
                        "browserTextExtracted"
                    },
                    Some(task.task_id.clone()),
                    Some(task.profile_id.clone()),
                    format!("Extracted browser page content for task {}", task.task_id),
                    json!({
                        "url": task.current_url,
                        "bytes": extracted.len(),
                        "requiresEngine": observation.requires_engine,
                    }),
                );
                let step_summary = browser_agent_step_summary_for_task(
                    &state,
                    &task,
                    &action,
                    "applied",
                    observation.requires_engine,
                    None,
                    Some(&observation),
                    None,
                    None,
                );
                Ok(BrowserActionResponse {
                    ok: true,
                    status: "applied".to_string(),
                    task_id: Some(task.task_id),
                    current_url: task.current_url,
                    required_approval: None,
                    requires_engine: observation.requires_engine,
                    message: None,
                    observation: Some(observation),
                    extracted_text: Some(extracted),
                    actionability: None,
                    verification: None,
                    screenshot: None,
                    find_result: None,
                    security_state: None,
                    step_summary: Some(step_summary),
                    receipt,
                })
            }
            "goBack" | "goForward" | "reload" | "clickRef" | "fillRef" | "press" => {
                let task = state.tasks[idx].clone();
                let receipt = push_receipt(
                    &mut state,
                    "browserActionBlocked",
                    Some(task.task_id.clone()),
                    Some(task.profile_id.clone()),
                    format!(
                        "Browser action '{}' requires the browser engine harness",
                        action
                    ),
                    json!({
                        "action": action,
                        "refId": request.ref_id,
                        "requiresEngine": true,
                    }),
                );
                let step_summary = browser_agent_step_summary_for_task(
                    &state,
                    &task,
                    &action,
                    "requiresEngine",
                    true,
                    None,
                    None,
                    None,
                    None,
                );
                Ok(BrowserActionResponse {
                    ok: false,
                    status: "requiresEngine".to_string(),
                    task_id: Some(task.task_id),
                    current_url: task.current_url,
                    required_approval: None,
                    requires_engine: true,
                    message: Some(
                        "browser engine harness is not wired for this action yet".to_string(),
                    ),
                    observation: None,
                    extracted_text: None,
                    actionability: None,
                    verification: None,
                    screenshot: None,
                    find_result: None,
                    security_state: None,
                    step_summary: Some(step_summary),
                    receipt,
                })
            }
            "click"
            | "type"
            | "scroll"
            | "waitFor"
            | "select"
            | "extractTable"
            | "capturePageSecretToVault"
            | "captureScreenshot"
            | "verify"
            | "findText"
            | "cdpCommand" => {
                let task = state.tasks[idx].clone();
                let receipt = push_receipt(
                    &mut state,
                    "browserActionBlocked",
                    Some(task.task_id.clone()),
                    Some(task.profile_id.clone()),
                    format!(
                        "Browser action '{}' requires the browser engine harness",
                        action
                    ),
                    json!({
                        "action": action,
                        "refId": request.ref_id,
                        "requiresEngine": true,
                    }),
                );
                let step_summary = browser_agent_step_summary_for_task(
                    &state,
                    &task,
                    &action,
                    "requiresEngine",
                    true,
                    None,
                    None,
                    None,
                    None,
                );
                Ok(BrowserActionResponse {
                    ok: false,
                    status: "requiresEngine".to_string(),
                    task_id: Some(task.task_id),
                    current_url: task.current_url,
                    required_approval: None,
                    requires_engine: true,
                    message: Some(
                        "browser engine harness is not wired for this action yet".to_string(),
                    ),
                    observation: None,
                    extracted_text: None,
                    actionability: None,
                    verification: None,
                    screenshot: None,
                    find_result: None,
                    security_state: None,
                    step_summary: Some(step_summary),
                    receipt,
                })
            }
            "askUser" => {
                let task = state.tasks[idx].clone();
                let receipt = push_receipt(
                    &mut state,
                    "browserUserHandoffRequired",
                    Some(task.task_id.clone()),
                    Some(task.profile_id.clone()),
                    "Browser workflow needs user handoff".to_string(),
                    json!({
                        "action": action,
                        "refId": request.ref_id,
                    }),
                );
                let step_summary = browser_agent_step_summary_for_task(
                    &state,
                    &task,
                    &action,
                    "blocked",
                    false,
                    Some("userHandoff"),
                    None,
                    None,
                    None,
                );
                Ok(BrowserActionResponse {
                    ok: false,
                    status: "blocked".to_string(),
                    task_id: Some(task.task_id),
                    current_url: task.current_url,
                    required_approval: Some("userHandoff".to_string()),
                    requires_engine: false,
                    message: Some("user handoff is required".to_string()),
                    observation: None,
                    extracted_text: None,
                    actionability: None,
                    verification: None,
                    screenshot: None,
                    find_result: None,
                    security_state: None,
                    step_summary: Some(step_summary),
                    receipt,
                })
            }
            "requestSessionGrant"
            | "createVaultDeposit"
            | "recordVaultFillReceipt"
            | "recordVaultGenerateReceipt"
            | "writeReport" => {
                let task = state.tasks[idx].clone();
                let route = match action.as_str() {
                    "requestSessionGrant" => "/browser/session-grants/request",
                    "createVaultDeposit" => "/browser/vault-deposits",
                    "recordVaultFillReceipt" => "/browser/vault/fill-receipt",
                    "recordVaultGenerateReceipt" => "/browser/vault/generate-receipt",
                    "writeReport" => "/browser/report",
                    _ => "/browser/action",
                };
                let receipt = push_receipt(
                    &mut state,
                    "browserActionBlocked",
                    Some(task.task_id.clone()),
                    Some(task.profile_id.clone()),
                    format!("Browser action '{}' requires {}", action, route),
                    json!({
                        "action": action,
                        "route": route,
                    }),
                );
                let step_summary = browser_agent_step_summary_for_task(
                    &state,
                    &task,
                    &action,
                    "requiresRoute",
                    false,
                    None,
                    None,
                    None,
                    None,
                );
                Ok(BrowserActionResponse {
                    ok: false,
                    status: "requiresRoute".to_string(),
                    task_id: Some(task.task_id),
                    current_url: task.current_url,
                    required_approval: None,
                    requires_engine: false,
                    message: Some(format!("use {} for this typed action", route)),
                    observation: None,
                    extracted_text: None,
                    actionability: None,
                    verification: None,
                    screenshot: None,
                    find_result: None,
                    security_state: None,
                    step_summary: Some(step_summary),
                    receipt,
                })
            }
            "requestFinalActionApproval" => {
                let task = state.tasks[idx].clone();
                let receipt = push_receipt(
                    &mut state,
                    "browserFinalActionApprovalRequired",
                    Some(task.task_id.clone()),
                    Some(task.profile_id.clone()),
                    "Final browser action approval requested".to_string(),
                    json!({ "refId": request.ref_id }),
                );
                let step_summary = browser_agent_step_summary_for_task(
                    &state,
                    &task,
                    &action,
                    "blocked",
                    false,
                    Some("finalActionApproval"),
                    None,
                    None,
                    None,
                );
                Ok(BrowserActionResponse {
                    ok: false,
                    status: "blocked".to_string(),
                    task_id: Some(task.task_id),
                    current_url: task.current_url,
                    required_approval: Some("finalActionApproval".to_string()),
                    requires_engine: false,
                    message: Some("final action approval is required".to_string()),
                    observation: None,
                    extracted_text: None,
                    actionability: None,
                    verification: None,
                    screenshot: None,
                    find_result: None,
                    security_state: None,
                    step_summary: Some(step_summary),
                    receipt,
                })
            }
            _ => {
                let task = state.tasks[idx].clone();
                let receipt = push_receipt(
                    &mut state,
                    "browserActionBlocked",
                    Some(task.task_id.clone()),
                    Some(task.profile_id.clone()),
                    format!("Unsupported browser action '{}'", action),
                    json!({ "action": action }),
                );
                let step_summary = browser_agent_step_summary_for_task(
                    &state,
                    &task,
                    &action,
                    "unsupported",
                    false,
                    None,
                    None,
                    None,
                    None,
                );
                Ok(BrowserActionResponse {
                    ok: false,
                    status: "unsupported".to_string(),
                    task_id: Some(task.task_id),
                    current_url: task.current_url,
                    required_approval: None,
                    requires_engine: false,
                    message: Some("unsupported browser action".to_string()),
                    observation: None,
                    extracted_text: None,
                    actionability: None,
                    verification: None,
                    screenshot: None,
                    find_result: None,
                    security_state: None,
                    step_summary: Some(step_summary),
                    receipt,
                })
            }
        }
    }
}
