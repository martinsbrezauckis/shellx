use super::*;

pub async fn try_block_beforeunload_navigation(
    app: &AppHandle,
    registry: &Arc<ShellxBrowserRegistry>,
    request: &BrowserActionRequest,
) -> Result<Option<BrowserActionResponse>, String> {
    if clean_string(&request.action) != "navigate" {
        return Ok(None);
    }
    if request
        .url
        .as_deref()
        .map(str::trim)
        .unwrap_or("")
        .is_empty()
    {
        return Ok(None);
    }
    let engine_label =
        browser_engine_webview_label(&registry.engine_id_for_action_request(request));
    if app.get_webview(&engine_label).is_none() {
        return Ok(None);
    }
    match registry.engine_action_targets_active_context(request) {
        Ok(true) => {}
        Ok(false) => return Ok(None),
        Err(_) => return Ok(None),
    }
    let result = match eval_browser_engine_json(
        app,
        &engine_label,
        r#"
(() => {
  return {
    ok: true,
    hasBeforeUnload: Boolean(window.__shellxBeforeUnloadRegistered || window.onbeforeunload),
    url: location.href,
    title: document.title || location.href
  };
})()
"#,
    )
    .await
    {
        Ok(result) => result,
        Err(_) => return Ok(None),
    };
    let has_beforeunload = result
        .get("hasBeforeUnload")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);
    if !has_beforeunload {
        return Ok(None);
    }
    registry.record_engine_beforeunload_blocker(request, "navigate")
}

pub async fn apply_beforeunload_dialog_resolution(
    app: &AppHandle,
    registry: &Arc<ShellxBrowserRegistry>,
    event: &BrowserDialogEvent,
) -> Result<Option<BrowserEngineSnapshot>, String> {
    if event.dialog_type != "beforeunload" {
        return Ok(None);
    }
    if event.status != "accepted" {
        let mut state = lock_or_recover(&registry.state);
        let current_url = state.engine.url.clone();
        state.engine.pending_url = None;
        state.engine.load_status = if current_url.is_some() {
            "loaded".to_string()
        } else {
            "mounted".to_string()
        };
        state.engine.last_error = None;
        state.engine.updated_at_ms = now_ms();
        let engine_status = state.engine.load_status.clone();
        let engine_updated_at_ms = state.engine.updated_at_ms;
        if let Some(tab_id) = event.browser_tab_id.as_deref() {
            let shields = state.shields.clone();
            if let Some(tab) = state
                .tabs
                .iter_mut()
                .find(|tab| tab.browser_tab_id == tab_id)
            {
                update_tab_url(tab, current_url, &shields);
                tab.status = engine_status;
                tab.updated_at_ms = engine_updated_at_ms;
            }
        }
        return Ok(Some(state.engine.clone()));
    }
    let (profile_id, url, bounds) = {
        let mut state = lock_or_recover(&registry.state);
        if !state.engine.mounted {
            return Ok(None);
        }
        let Some(bounds) = state.engine.bounds else {
            return Ok(None);
        };
        let browser_tab_id = event
            .browser_tab_id
            .as_deref()
            .map(clean_string)
            .filter(|value| !value.is_empty());
        let tab_idx = browser_tab_id.as_deref().and_then(|tab_id| {
            state
                .tabs
                .iter()
                .position(|tab| tab.browser_tab_id == tab_id)
        });
        let url = event
            .url
            .as_deref()
            .map(clean_string)
            .filter(|value| !value.is_empty())
            .or_else(|| tab_idx.and_then(|idx| state.tabs[idx].url.clone()))
            .ok_or_else(|| "accepted beforeunload dialog has no pending URL".to_string())?;
        let profile_id = event
            .profile_id
            .as_deref()
            .map(clean_string)
            .filter(|value| !value.is_empty())
            .or_else(|| tab_idx.map(|idx| state.tabs[idx].profile_id.clone()))
            .or_else(|| state.engine.profile_id.clone())
            .unwrap_or_else(|| "agent-work".to_string());
        if let Some(tab_id) = browser_tab_id.as_deref() {
            set_active_tab(&mut state, tab_id);
            if let Some(task_id) = event
                .task_id
                .as_deref()
                .map(clean_string)
                .filter(|value| !value.is_empty())
            {
                state.active_task_id = Some(task_id);
            }
            let shields = state.shields.clone();
            let now = now_ms();
            if let Some(tab) = state
                .tabs
                .iter_mut()
                .find(|tab| tab.browser_tab_id == tab_id)
            {
                update_tab_url(tab, Some(url.clone()), &shields);
                tab.status = "navigating".to_string();
                tab.updated_at_ms = now;
            }
        }
        state.engine.profile_id = Some(profile_id.clone());
        state.engine.pending_url = Some(url.clone());
        state.engine.load_status = "navigating".to_string();
        state.engine.last_error = None;
        state.engine.updated_at_ms = now_ms();
        (profile_id, url, bounds)
    };

    let request = BrowserEngineSyncRequest {
        engine_id: None,
        browser_tab_id: event.browser_tab_id.clone(),
        profile_id: Some(profile_id),
        url: Some(url),
        preserve_existing_page: false,
        bounds,
    };
    let engine_label = browser_engine_webview_label(&registry.engine_id_for_sync_request(&request));
    if let Some(webview) = app.get_webview(&engine_label) {
        let _ = engine_bounds_rect(bounds)?;
        webview.close().map_err(|e| {
            format!(
                "failed to recreate Browser engine after beforeunload approval: {}",
                e
            )
        })?;
        wait_for_browser_engine_label_release(app, &engine_label).await?;
    }
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
