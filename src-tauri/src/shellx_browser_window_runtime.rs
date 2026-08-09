use super::*;

#[tauri::command]
pub async fn shellx_browser_open_window(
    app: AppHandle,
    registry: State<'_, Arc<ShellxBrowserRegistry>>,
    #[allow(non_snake_case)] start_url: Option<String>,
) -> Result<BrowserWindowOpenResponse, String> {
    open_or_focus_browser_window_bounded(app, Arc::clone(&*registry), start_url)
        .await
        .map_err(|failure| failure.as_json().to_string())
}

#[tauri::command]
pub async fn shellx_browser_sync_engine(
    app: AppHandle,
    registry: State<'_, Arc<ShellxBrowserRegistry>>,
    request: BrowserEngineSyncRequest,
) -> Result<BrowserEngineSnapshot, String> {
    let registry = Arc::clone(&*registry);
    let request = registry.normalize_engine_sync_request(request);
    let mut request = request;
    match sync_native_browser_engine(&app, &registry, &request).await {
        Ok(Some(current_url)) => request.url = Some(current_url),
        Ok(None) => {}
        Err(err) => {
            registry.record_engine_error(err.clone());
            return Err(err);
        }
    }
    Ok(registry.record_engine_sync(request))
}

#[tauri::command]
pub async fn shellx_browser_clear_history(
    registry: State<'_, Arc<ShellxBrowserRegistry>>,
) -> Result<BrowserReceipt, String> {
    crate::shellx_browser_destructive_actions::clear_browser_history_from_operator(&registry)
}

#[tauri::command]
pub async fn shellx_browser_state(
    registry: State<'_, Arc<ShellxBrowserRegistry>>,
) -> Result<BrowserStateSnapshot, String> {
    Ok(registry.state())
}

#[tauri::command]
pub async fn shellx_browser_control_task(
    registry: State<'_, Arc<ShellxBrowserRegistry>>,
    request: BrowserTaskControlRequest,
) -> Result<BrowserTaskControlResponse, String> {
    registry.control_task_from_operator(request)
}

#[tauri::command]
pub async fn shellx_browser_finish_task(
    registry: State<'_, Arc<ShellxBrowserRegistry>>,
    #[allow(non_snake_case)] taskId: Option<String>,
    status: Option<String>,
    reason: Option<String>,
) -> Result<BrowserTaskSnapshot, String> {
    registry.finish_task_from_operator(taskId, status, reason)
}

#[tauri::command]
pub async fn shellx_browser_resolve_session_grant(
    registry: State<'_, Arc<ShellxBrowserRegistry>>,
    #[allow(non_snake_case)] grantId: String,
    approved: bool,
) -> Result<BrowserSessionGrant, String> {
    crate::shellx_browser_session_grants::resolve_browser_session_grant_from_operator(
        &registry,
        BrowserSessionGrantResolveRequest {
            grant_id: grantId,
            approved,
            operator_approved: false,
        },
    )
}

pub async fn sync_engine_to_task(
    app: &AppHandle,
    registry: &Arc<ShellxBrowserRegistry>,
    task: &BrowserTaskSnapshot,
) -> Result<Option<BrowserEngineSnapshot>, String> {
    let state = registry.state();
    let tab = state
        .tabs
        .iter()
        .find(|tab| tab.task_id.as_deref() == Some(task.task_id.as_str()))
        .cloned();
    let engine_id = tab
        .as_ref()
        .map(|tab| tab.engine_id.clone())
        .unwrap_or_else(|| BROWSER_ENGINE_FOREGROUND_ID.to_string());
    let bounds = if state.active_browser_tab_id.as_deref()
        == tab.as_ref().map(|tab| tab.browser_tab_id.as_str())
    {
        state
            .engine_pool
            .engines
            .iter()
            .find(|engine| engine.engine_id == engine_id)
            .and_then(|engine| engine.bounds)
            .or(state.engine.bounds)
            .unwrap_or_else(browser_default_engine_bounds)
    } else {
        browser_background_engine_bounds()
    };
    let request = BrowserEngineSyncRequest {
        engine_id: Some(engine_id),
        browser_tab_id: tab.as_ref().map(|tab| tab.browser_tab_id.clone()),
        profile_id: Some(task.profile_id.clone()),
        url: task.current_url.clone(),
        preserve_existing_page: false,
        bounds,
    };
    let mut request = request;
    match sync_native_browser_engine(app, registry, &request).await {
        Ok(Some(current_url)) => request.url = Some(current_url),
        Ok(None) => {}
        Err(err) => {
            registry.record_engine_error(err.clone());
            return Err(err);
        }
    }
    Ok(Some(registry.record_engine_sync(request)))
}

pub async fn rollback_failed_task_engine_sync(
    app: &AppHandle,
    registry: &Arc<ShellxBrowserRegistry>,
    task_id: &str,
    previous_active_browser_tab_id: Option<&str>,
    failure: &str,
) -> Result<serde_json::Value, String> {
    let rollback =
        registry.rollback_failed_task_start(task_id, previous_active_browser_tab_id, failure)?;
    let mut cleanup_errors = Vec::new();
    for engine_id in &rollback.engine_ids_to_close {
        if let Err(error) = close_browser_engine_webview(app, engine_id).await {
            cleanup_errors.push(error);
        }
    }
    if let Some(active_tab_id) = rollback.restored_active_browser_tab_id.as_deref() {
        let active_tab = registry
            .state()
            .tabs
            .into_iter()
            .find(|tab| tab.browser_tab_id == active_tab_id);
        if let Some(active_tab) = active_tab {
            if let Err(error) = sync_engine_to_tab_preserving_page(app, registry, &active_tab).await
            {
                cleanup_errors.push(format!(
                    "failed to restore the previously active Browser engine: {error}"
                ));
            }
        }
    }
    Ok(json!({
        "ok": cleanup_errors.is_empty(),
        "taskId": rollback.task.task_id,
        "taskStatus": rollback.task.status,
        "closedBrowserTabIds": rollback.closed_tabs
            .iter()
            .map(|tab| tab.browser_tab_id.clone())
            .collect::<Vec<_>>(),
        "closedEngineIds": rollback.engine_ids_to_close,
        "restoredActiveBrowserTabId": rollback.restored_active_browser_tab_id,
        "cleanupErrors": cleanup_errors,
        "receipt": rollback.receipt,
    }))
}

pub async fn sync_engine_to_tab(
    app: &AppHandle,
    registry: &Arc<ShellxBrowserRegistry>,
    tab: &BrowserTabSnapshot,
) -> Result<Option<BrowserEngineSnapshot>, String> {
    sync_engine_to_tab_with_preservation(app, registry, tab, false).await
}

pub async fn sync_engine_to_tab_preserving_page(
    app: &AppHandle,
    registry: &Arc<ShellxBrowserRegistry>,
    tab: &BrowserTabSnapshot,
) -> Result<Option<BrowserEngineSnapshot>, String> {
    sync_engine_to_tab_with_preservation(app, registry, tab, true).await
}

async fn sync_engine_to_tab_with_preservation(
    app: &AppHandle,
    registry: &Arc<ShellxBrowserRegistry>,
    tab: &BrowserTabSnapshot,
    preserve_existing_page: bool,
) -> Result<Option<BrowserEngineSnapshot>, String> {
    let state = registry.state();
    let preserve_existing_page = preserve_existing_page
        && state
            .engine_pool
            .engines
            .iter()
            .find(|engine| engine.engine_id == tab.engine_id)
            .map(|engine| {
                engine.mounted
                    && engine.browser_tab_id.as_deref() == Some(tab.browser_tab_id.as_str())
                    && engine.pending_url.is_none()
            })
            .unwrap_or(false);
    let bounds = if state.active_browser_tab_id.as_deref() == Some(tab.browser_tab_id.as_str()) {
        state
            .engine_pool
            .engines
            .iter()
            .find(|engine| engine.engine_id == tab.engine_id)
            .and_then(|engine| engine.bounds)
            .or(state.engine.bounds)
            .unwrap_or_else(browser_default_engine_bounds)
    } else {
        browser_background_engine_bounds()
    };
    let request = BrowserEngineSyncRequest {
        engine_id: Some(tab.engine_id.clone()),
        browser_tab_id: Some(tab.browser_tab_id.clone()),
        profile_id: Some(tab.profile_id.clone()),
        url: tab.url.clone(),
        preserve_existing_page,
        bounds,
    };
    let mut request = request;
    match sync_native_browser_engine(app, registry, &request).await {
        Ok(Some(current_url)) => request.url = Some(current_url),
        Ok(None) => {}
        Err(err) => {
            registry.record_engine_error(err.clone());
            return Err(err);
        }
    }
    Ok(Some(registry.record_engine_sync(request)))
}

pub async fn reapply_browser_privacy_to_active_engine(
    app: &AppHandle,
    registry: &Arc<ShellxBrowserRegistry>,
) -> Result<Option<serde_json::Value>, String> {
    let state = registry.state();
    let Some(active_tab_id) = state.active_browser_tab_id.clone() else {
        return Ok(None);
    };
    let Some(tab) = state
        .tabs
        .iter()
        .find(|tab| tab.browser_tab_id == active_tab_id)
    else {
        return Ok(None);
    };
    let engine_label = browser_engine_webview_label(&tab.engine_id);
    if app.get_webview(&engine_label).is_none() {
        return Ok(None);
    }
    let mode = registry.effective_ad_mode_for_profile_id(Some(&tab.profile_id), tab.url.as_deref());
    let current_mode = state
        .engine_pool
        .engines
        .iter()
        .find(|engine| engine.engine_id == tab.engine_id)
        .map(|engine| engine.privacy_mode.clone())
        .unwrap_or_else(|| tab.privacy_mode.clone());
    let current_native_filter = browser_requires_native_request_filter(&current_mode);
    let next_native_filter = browser_requires_native_request_filter(&mode);
    if current_native_filter != next_native_filter {
        let request = BrowserEngineSyncRequest {
            engine_id: Some(tab.engine_id.clone()),
            browser_tab_id: Some(tab.browser_tab_id.clone()),
            profile_id: Some(tab.profile_id.clone()),
            url: tab
                .url
                .clone()
                .or_else(|| state.engine.url.clone())
                .or_else(|| Some("about:blank".to_string())),
            preserve_existing_page: false,
            bounds: state
                .engine_pool
                .engines
                .iter()
                .find(|engine| engine.engine_id == tab.engine_id)
                .and_then(|engine| engine.bounds)
                .or(state.engine.bounds)
                .unwrap_or_else(browser_default_engine_bounds),
        };
        drop(state);
        close_browser_engine_webview(app, &request.engine_id.clone().unwrap_or_default()).await?;
        let mut request = request;
        if let Some(current_url) = sync_native_browser_engine(app, registry, &request).await? {
            request.url = Some(current_url);
        }
        let snapshot = registry.record_engine_sync(request);
        return Ok(Some(json!({
            "ok": true,
            "runtimeApply": "recreated",
            "mode": mode,
            "engineId": snapshot.engine_id,
            "webviewLabel": snapshot.webview_label,
        })));
    }
    drop(state);
    let result = eval_browser_engine_json(
        app,
        &engine_label,
        browser_privacy_initialization_script(&mode),
    )
    .await?;
    if let Some(stats_value) = result.get("privacyStats").cloned() {
        if let Ok(stats) = serde_json::from_value::<BrowserPrivacyStats>(stats_value) {
            let _ = registry.record_tab_privacy_stats(&active_tab_id, stats);
        }
    }
    Ok(Some(result))
}

pub async fn close_browser_engine_webview(app: &AppHandle, engine_id: &str) -> Result<(), String> {
    let engine_id = clean_string(engine_id);
    if engine_id.is_empty() {
        return Ok(());
    }
    let engine_label = browser_engine_webview_label(&engine_id);
    if let Some(webview) = app.get_webview(&engine_label) {
        webview.close().map_err(|e| {
            format!(
                "failed to close Browser engine webview '{}': {}",
                engine_label, e
            )
        })?;
        wait_for_browser_engine_label_release(app, &engine_label).await?;
    }
    Ok(())
}
