use serde_json::json;
use tauri::webview::PageLoadEvent;
use tauri::Url;

use crate::shellx_browser::{
    browser_id, clean_string, ensure_engine_snapshot_locked, lock_or_recover, now_ms,
    push_network_entry, push_receipt, record_history_visit, update_tab_url, BrowserActionRequest,
    BrowserActionResponse, BrowserAdMode, BrowserDialogEvent, BrowserEngineSnapshot,
    BrowserEngineSyncRequest, BrowserEngineTabState, BrowserEngineVisibilityState,
    BrowserEngineVisualCaptureState, BrowserEngineWaitlistSnapshot, BrowserNetworkRecordRequest,
    EnsureEngineSnapshotRequest, ShellxBrowserRegistry, BROWSER_ENGINE_FOREGROUND_ID,
    BROWSER_ENGINE_WEBVIEW_LABEL,
};
use crate::shellx_browser_engine::{
    browser_background_engine_bounds, browser_engine_bounds_are_background,
    browser_engine_webview_label, resolve_engine_id_for_sync_request_locked,
};
use crate::shellx_browser_engine_runtime::browser_engine_url_allowed_for_state;
use crate::shellx_browser_profiles::browser_profile_storage_root;
use crate::shellx_browser_security::{
    browser_engine_load_matches_pending_redirect, browser_urls_match_without_query_or_fragment,
    normalize_browser_url,
};
use crate::shellx_browser_shields::{ad_mode_for_profile, effective_ad_mode_for_profile_and_url};
use crate::shellx_browser_tabs::find_tab_index;
use crate::shellx_browser_tasks::{find_task_index, resolve_task_id};

impl ShellxBrowserRegistry {
    pub fn normalize_engine_sync_request(
        &self,
        mut request: BrowserEngineSyncRequest,
    ) -> BrowserEngineSyncRequest {
        let state = lock_or_recover(&self.state);
        let Some(active_tab_id) = state.active_browser_tab_id.as_deref() else {
            return request;
        };
        let Some(tab) = state
            .tabs
            .iter()
            .find(|tab| tab.browser_tab_id == active_tab_id)
        else {
            return request;
        };
        let Some(tab_task_id) = tab.task_id.as_deref() else {
            return request;
        };
        if state.active_task_id.as_deref() != Some(tab_task_id) {
            return request;
        }
        let Some(task) = state.tasks.iter().find(|task| task.task_id == tab_task_id) else {
            return request;
        };
        let requested_profile = request
            .profile_id
            .as_deref()
            .map(clean_string)
            .filter(|value| !value.is_empty());
        let requested_url = request
            .url
            .as_deref()
            .map(clean_string)
            .filter(|value| !value.is_empty());
        let task_url = task.current_url.clone().or_else(|| tab.url.clone());
        let stale_personal_blank_sync = requested_profile.as_deref() == Some("personal")
            && requested_url
                .as_deref()
                .map(normalize_browser_url)
                .as_deref()
                == Some("about:blank")
            && task_url.as_deref().map(normalize_browser_url).as_deref() != Some("about:blank");
        let profile_conflicts_task = requested_profile
            .as_deref()
            .map(|profile_id| profile_id != task.profile_id)
            .unwrap_or(false);
        if stale_personal_blank_sync || profile_conflicts_task {
            request.profile_id = Some(task.profile_id.clone());
            request.url = task_url;
        }
        request
    }

    pub fn record_engine_sync(&self, request: BrowserEngineSyncRequest) -> BrowserEngineSnapshot {
        let mut state = lock_or_recover(&self.state);
        let engine_id = resolve_engine_id_for_sync_request_locked(&state, &request);
        let webview_label = browser_engine_webview_label(&engine_id);
        let profile_id = request
            .profile_id
            .as_deref()
            .map(clean_string)
            .filter(|value| !value.is_empty());
        let previous_browser_tab_id = state
            .engine_pool
            .engines
            .iter()
            .find(|engine| engine.engine_id == engine_id)
            .and_then(|engine| engine.browser_tab_id.clone());
        let previously_mounted = state
            .engine_pool
            .engines
            .iter()
            .find(|engine| engine.engine_id == engine_id)
            .map(|engine| engine.mounted)
            .unwrap_or(false);
        ensure_engine_snapshot_locked(
            &mut state,
            EnsureEngineSnapshotRequest {
                engine_id: &engine_id,
                webview_label: &webview_label,
                task_id: None,
                browser_tab_id: request.browser_tab_id.as_deref().unwrap_or_default(),
                profile_id: profile_id.as_deref().unwrap_or("agent-work"),
                url: request.url.clone(),
                title: None,
                status: "mounted",
            },
        );
        let engine_idx = state
            .engine_pool
            .engines
            .iter()
            .position(|engine| engine.engine_id == engine_id)
            .expect("engine snapshot exists after ensure");
        let was_mounted = state.engine_pool.engines[engine_idx].mounted;
        let previous_url = state.engine_pool.engines[engine_idx].url.clone();
        let previous_pending_url = state.engine_pool.engines[engine_idx].pending_url.clone();
        let requested_url = request
            .url
            .as_deref()
            .map(clean_string)
            .filter(|value| !value.is_empty());
        let sync_browser_tab_id = request
            .browser_tab_id
            .as_deref()
            .map(clean_string)
            .filter(|value| !value.is_empty())
            .or_else(|| state.active_browser_tab_id.clone());
        let preserve_existing_page = request.preserve_existing_page
            && previously_mounted
            && sync_browser_tab_id.is_some()
            && previous_browser_tab_id.as_deref() == sync_browser_tab_id.as_deref();
        let effective_profile_id = profile_id
            .as_deref()
            .or_else(|| state.engine_pool.engines[engine_idx].profile_id.as_deref())
            .unwrap_or("agent-work")
            .to_string();
        let effective_url = if preserve_existing_page {
            previous_url.as_deref().or(requested_url.as_deref())
        } else {
            requested_url.as_deref().or(previous_url.as_deref())
        };
        let engine_privacy_mode = effective_ad_mode_for_profile_and_url(
            &state.privacy,
            &state.shields,
            &effective_profile_id,
            effective_url,
        );
        let navigation_requested = !preserve_existing_page
            && requested_url.is_some()
            && (!was_mounted || previous_url != requested_url);
        let sync_task_id = sync_browser_tab_id.as_deref().and_then(|tab_id| {
            state
                .tabs
                .iter()
                .find(|tab| tab.browser_tab_id == tab_id)
                .and_then(|tab| tab.task_id.clone())
        });
        let visibility_state =
            if state.active_browser_tab_id.as_deref() == sync_browser_tab_id.as_deref() {
                BrowserEngineVisibilityState::Foreground
            } else {
                BrowserEngineVisibilityState::Background
            };
        let engine = &mut state.engine_pool.engines[engine_idx];
        engine.mounted = true;
        engine.webview_label = webview_label.clone();
        engine.browser_tab_id = sync_browser_tab_id;
        engine.task_id = sync_task_id;
        engine.profile_id = profile_id;
        engine.privacy_mode = engine_privacy_mode;
        if preserve_existing_page {
            if let Some(current_url) = requested_url.clone() {
                engine.url = Some(current_url);
            }
        }
        engine.pending_url = if navigation_requested {
            requested_url.clone()
        } else {
            previous_pending_url.clone()
        };
        engine.bounds = Some(request.bounds);
        engine.load_status = if navigation_requested {
            "navigating".to_string()
        } else if previous_pending_url.is_some() {
            engine.load_status.clone()
        } else if was_mounted && engine.load_status == "navigating" {
            "loaded".to_string()
        } else if was_mounted {
            engine.load_status.clone()
        } else {
            "mounted".to_string()
        };
        engine.last_error = None;
        engine.visibility_state = visibility_state;
        engine.visual_capture = BrowserEngineVisualCaptureState::Available;
        engine.updated_at_ms = now_ms();
        if !browser_engine_bounds_are_background(request.bounds) {
            let background_bounds = browser_background_engine_bounds();
            for (idx, other_engine) in state.engine_pool.engines.iter_mut().enumerate() {
                if idx == engine_idx {
                    continue;
                }
                other_engine.visibility_state = BrowserEngineVisibilityState::Background;
                other_engine.bounds = Some(background_bounds);
            }
        }
        let snapshot = state.engine_pool.engines[engine_idx].clone();
        let engine_profile_id = snapshot.profile_id.clone();
        let engine_url = snapshot.url.clone();
        let engine_pending_url = snapshot.pending_url.clone();
        let engine_status = snapshot.load_status.clone();
        let engine_updated_at_ms = snapshot.updated_at_ms;
        let privacy = state.privacy.clone();
        let shields = state.shields.clone();
        let sync_tab_id = snapshot
            .browser_tab_id
            .clone()
            .or_else(|| state.active_browser_tab_id.clone());
        if let Some(active_tab_id) = sync_tab_id {
            if let Some(tab) = state
                .tabs
                .iter_mut()
                .find(|tab| tab.browser_tab_id == active_tab_id)
            {
                let profile_id = engine_profile_id
                    .clone()
                    .unwrap_or_else(|| tab.profile_id.clone());
                tab.profile_id = profile_id.clone();
                tab.privacy_mode = ad_mode_for_profile(&privacy, &profile_id);
                if engine_pending_url.is_none() {
                    update_tab_url(tab, engine_url.clone(), &shields);
                }
                tab.status = engine_status.clone();
                tab.engine_id = snapshot.engine_id.clone();
                tab.engine_webview_label = Some(snapshot.webview_label.clone());
                tab.engine_state = BrowserEngineTabState::Live;
                tab.storage_root = Some(browser_profile_storage_root(&profile_id));
                tab.updated_at_ms = engine_updated_at_ms;
            }
        }
        if state.active_browser_tab_id.as_deref() == snapshot.browser_tab_id.as_deref() {
            state.engine = snapshot.clone();
            state.engine_waitlist = snapshot.waitlist.clone();
        }

        if !was_mounted {
            let active_task_id = state.active_task_id.clone();
            push_receipt(
                &mut state,
                "browserEngineMounted",
                active_task_id,
                snapshot.profile_id.clone(),
                "Browser engine mounted as native child webview".to_string(),
                json!({
                    "engineId": snapshot.engine_id,
                    "webviewLabel": snapshot.webview_label,
                    "url": snapshot.url,
                    "bounds": snapshot.bounds,
                }),
            );
        }
        if navigation_requested {
            let active_task_id = state.active_task_id.clone();
            if let Some(url) = snapshot
                .pending_url
                .clone()
                .or_else(|| snapshot.url.clone())
            {
                let browser_tab_id = state.active_browser_tab_id.clone();
                let profile_id = snapshot.profile_id.clone();
                push_network_entry(
                    &mut state,
                    BrowserNetworkRecordRequest {
                        task_id: active_task_id.clone(),
                        browser_tab_id,
                        profile_id,
                        method: "GET".to_string(),
                        url,
                        resource_type: "document".to_string(),
                        load_status: Some("navigating".to_string()),
                        ..BrowserNetworkRecordRequest::default()
                    },
                );
            }
            push_receipt(
                &mut state,
                "browserEngineNavigated",
                active_task_id,
                snapshot.profile_id.clone(),
                format!(
                    "Browser engine navigating to {}",
                    snapshot
                        .pending_url
                        .as_deref()
                        .or(snapshot.url.as_deref())
                        .unwrap_or("about:blank")
                ),
                json!({
                    "engineId": snapshot.engine_id,
                    "webviewLabel": snapshot.webview_label,
                    "url": snapshot.url,
                    "pendingUrl": snapshot.pending_url,
                }),
            );
        }
        snapshot
    }

    pub fn record_engine_load_for_engine(
        &self,
        engine_id: &str,
        url: String,
        event: PageLoadEvent,
    ) -> BrowserEngineSnapshot {
        let engine_id = clean_string(engine_id);
        let mut state = lock_or_recover(&self.state);
        let url = clean_string(url);
        let engine_idx = state
            .engine_pool
            .engines
            .iter()
            .position(|engine| engine.engine_id == engine_id)
            .unwrap_or_else(|| {
                let label = browser_engine_webview_label(&engine_id);
                state.engine_pool.engines.push(BrowserEngineSnapshot {
                    engine_id: engine_id.clone(),
                    mounted: false,
                    webview_label: label,
                    browser_tab_id: None,
                    task_id: None,
                    profile_id: Some("agent-work".to_string()),
                    privacy_mode: BrowserAdMode::Balanced,
                    url: None,
                    pending_url: None,
                    title: None,
                    load_status: "idle".to_string(),
                    bounds: None,
                    last_error: None,
                    visibility_state: if engine_id == BROWSER_ENGINE_FOREGROUND_ID {
                        BrowserEngineVisibilityState::Foreground
                    } else {
                        BrowserEngineVisibilityState::Background
                    },
                    visual_capture: BrowserEngineVisualCaptureState::Available,
                    waitlist: BrowserEngineWaitlistSnapshot::default(),
                    updated_at_ms: now_ms(),
                });
                state.engine_pool.engines.len() - 1
            });
        let committed_url = if let Some(pending) = state.engine_pool.engines[engine_idx]
            .pending_url
            .as_deref()
            .map(clean_string)
            .filter(|value| !value.is_empty())
        {
            if pending == url || browser_urls_match_without_query_or_fragment(&pending, &url) {
                pending
            } else if browser_engine_load_matches_pending_redirect(&state, &pending, &url) {
                url.clone()
            } else {
                return state.engine_pool.engines[engine_idx].clone();
            }
        } else {
            url.clone()
        };
        let load_status = match event {
            PageLoadEvent::Started => "loading",
            PageLoadEvent::Finished => "loaded",
        }
        .to_string();
        {
            let engine = &mut state.engine_pool.engines[engine_idx];
            engine.mounted = true;
            engine.url = Some(committed_url.clone());
            engine.pending_url = None;
            engine.load_status = load_status.clone();
            engine.last_error = None;
            engine.updated_at_ms = now_ms();
        }
        let snapshot = state.engine_pool.engines[engine_idx].clone();
        let shields = state.shields.clone();
        if let Some(tab_id) = snapshot.browser_tab_id.as_deref() {
            if let Some(tab) = state
                .tabs
                .iter_mut()
                .find(|tab| tab.browser_tab_id == tab_id)
            {
                update_tab_url(tab, Some(committed_url.clone()), &shields);
                tab.status = load_status.clone();
                tab.engine_state = BrowserEngineTabState::Live;
                tab.updated_at_ms = snapshot.updated_at_ms;
            }
        }
        if event == PageLoadEvent::Finished {
            if let Some(task_id) = snapshot.task_id.as_deref() {
                if let Some(task) = state.tasks.iter_mut().find(|task| task.task_id == task_id) {
                    task.current_url = Some(committed_url.clone());
                    task.updated_at_ms = now_ms();
                }
            }
            record_history_visit(
                &mut state,
                snapshot.task_id.clone(),
                snapshot
                    .profile_id
                    .clone()
                    .unwrap_or_else(|| "agent-work".to_string()),
                committed_url.clone(),
                snapshot.title.clone(),
            );
        }
        push_network_entry(
            &mut state,
            BrowserNetworkRecordRequest {
                task_id: snapshot.task_id.clone(),
                browser_tab_id: snapshot.browser_tab_id.clone(),
                profile_id: snapshot.profile_id.clone(),
                method: "GET".to_string(),
                url: committed_url.clone(),
                resource_type: "document".to_string(),
                load_status: Some(load_status),
                ..BrowserNetworkRecordRequest::default()
            },
        );
        if state.active_browser_tab_id.as_deref() == snapshot.browser_tab_id.as_deref() {
            state.engine = state.engine_pool.engines[engine_idx].clone();
            state.engine_waitlist = state.engine.waitlist.clone();
        }
        state.engine_pool.engines[engine_idx].clone()
    }

    pub fn record_engine_load(&self, url: String, event: PageLoadEvent) -> BrowserEngineSnapshot {
        let mut state = lock_or_recover(&self.state);
        let url = clean_string(url);
        if let Ok(parsed) = Url::parse(&normalize_browser_url(&url)) {
            let profile_id = state.engine.profile_id.as_deref().unwrap_or("agent-work");
            if !browser_engine_url_allowed_for_state(&state, &parsed, profile_id) {
                return state.engine.clone();
            }
        }
        let committed_url = if let Some(expected_url) = state
            .engine
            .pending_url
            .as_deref()
            .map(clean_string)
            .filter(|value| !value.is_empty())
        {
            if expected_url == url {
                url.clone()
            } else if browser_urls_match_without_query_or_fragment(&expected_url, &url) {
                expected_url
            } else if browser_engine_load_matches_pending_redirect(&state, &expected_url, &url) {
                url.clone()
            } else {
                return state.engine.clone();
            }
        } else {
            url.clone()
        };
        state.engine.mounted = true;
        state.engine.webview_label = BROWSER_ENGINE_WEBVIEW_LABEL.to_string();
        state.engine.url = Some(committed_url.clone());
        state.engine.pending_url = None;
        state.engine.load_status = match event {
            PageLoadEvent::Started => "loading",
            PageLoadEvent::Finished => "loaded",
        }
        .to_string();
        state.engine.last_error = None;
        state.engine.updated_at_ms = now_ms();
        let engine_status = state.engine.load_status.clone();
        let engine_updated_at_ms = state.engine.updated_at_ms;
        let shields = state.shields.clone();
        if let Some(active_tab_id) = state.active_browser_tab_id.clone() {
            if let Some(tab) = state
                .tabs
                .iter_mut()
                .find(|tab| tab.browser_tab_id == active_tab_id)
            {
                update_tab_url(tab, Some(committed_url.clone()), &shields);
                tab.status = engine_status.clone();
                tab.updated_at_ms = engine_updated_at_ms;
            }
        }
        let active_task_id = state.active_task_id.clone();
        let browser_tab_id = state.active_browser_tab_id.clone();
        let profile_id = active_task_id
            .as_deref()
            .and_then(|task_id| {
                state
                    .tasks
                    .iter()
                    .find(|task| task.task_id == task_id)
                    .map(|task| task.profile_id.clone())
            })
            .or_else(|| state.engine.profile_id.clone());
        push_network_entry(
            &mut state,
            BrowserNetworkRecordRequest {
                task_id: active_task_id.clone(),
                browser_tab_id,
                profile_id,
                method: "GET".to_string(),
                url: committed_url.clone(),
                resource_type: "document".to_string(),
                load_status: Some(
                    match event {
                        PageLoadEvent::Started => "loading",
                        PageLoadEvent::Finished => "loaded",
                    }
                    .to_string(),
                ),
                ..BrowserNetworkRecordRequest::default()
            },
        );
        if event == PageLoadEvent::Finished {
            let active_task_id = state.active_task_id.clone();
            let profile_id = active_task_id
                .as_deref()
                .and_then(|task_id| {
                    state
                        .tasks
                        .iter()
                        .find(|task| task.task_id == task_id)
                        .map(|task| task.profile_id.clone())
                })
                .or_else(|| state.engine.profile_id.clone())
                .unwrap_or_else(|| "agent-work".to_string());
            let title = state.engine.title.clone();
            if let Some(task_id) = active_task_id.as_deref() {
                if let Some(task) = state.tasks.iter_mut().find(|task| task.task_id == task_id) {
                    task.current_url = Some(committed_url.clone());
                    task.updated_at_ms = now_ms();
                }
            }
            record_history_visit(
                &mut state,
                active_task_id.clone(),
                profile_id,
                committed_url.clone(),
                title,
            );
        }
        let snapshot = state.engine.clone();
        if event == PageLoadEvent::Finished {
            let active_task_id = state.active_task_id.clone();
            push_receipt(
                &mut state,
                "browserEngineLoaded",
                active_task_id,
                snapshot.profile_id.clone(),
                format!("Browser engine loaded {}", committed_url),
                json!({
                    "webviewLabel": snapshot.webview_label,
                    "url": committed_url,
                }),
            );
        }
        snapshot
    }

    pub fn record_engine_title_for_engine(
        &self,
        engine_id: &str,
        title: String,
    ) -> BrowserEngineSnapshot {
        let engine_id = clean_string(engine_id);
        let mut state = lock_or_recover(&self.state);
        let engine_idx = state
            .engine_pool
            .engines
            .iter()
            .position(|engine| engine.engine_id == engine_id)
            .unwrap_or_else(|| {
                let label = browser_engine_webview_label(&engine_id);
                state.engine_pool.engines.push(BrowserEngineSnapshot {
                    engine_id: engine_id.clone(),
                    mounted: false,
                    webview_label: label,
                    browser_tab_id: None,
                    task_id: None,
                    profile_id: Some("agent-work".to_string()),
                    privacy_mode: BrowserAdMode::Balanced,
                    url: None,
                    pending_url: None,
                    title: None,
                    load_status: "idle".to_string(),
                    bounds: None,
                    last_error: None,
                    visibility_state: if engine_id == BROWSER_ENGINE_FOREGROUND_ID {
                        BrowserEngineVisibilityState::Foreground
                    } else {
                        BrowserEngineVisibilityState::Background
                    },
                    visual_capture: BrowserEngineVisualCaptureState::Available,
                    waitlist: BrowserEngineWaitlistSnapshot::default(),
                    updated_at_ms: now_ms(),
                });
                state.engine_pool.engines.len() - 1
            });
        // A reused native webview can deliver the previous document's title
        // after the next navigation has already been assigned. Keep the title
        // callback from contaminating that pending navigation; the current
        // document will emit its own title after its URL commits.
        if state.engine_pool.engines[engine_idx].pending_url.is_some() {
            return state.engine_pool.engines[engine_idx].clone();
        }
        state.engine_pool.engines[engine_idx].mounted = true;
        state.engine_pool.engines[engine_idx].title =
            Some(title.trim().chars().take(180).collect());
        state.engine_pool.engines[engine_idx].updated_at_ms = now_ms();
        let snapshot = state.engine_pool.engines[engine_idx].clone();
        if snapshot.pending_url.is_none() {
            if let Some(tab_id) = snapshot.browser_tab_id.as_deref() {
                if let Some(tab) = state
                    .tabs
                    .iter_mut()
                    .find(|tab| tab.browser_tab_id == tab_id)
                {
                    tab.title = snapshot.title.clone();
                    tab.updated_at_ms = snapshot.updated_at_ms;
                }
            }
        }
        if state.active_browser_tab_id.as_deref() == snapshot.browser_tab_id.as_deref() {
            state.engine = snapshot.clone();
            state.engine_waitlist = snapshot.waitlist.clone();
        }
        snapshot
    }

    pub fn record_engine_title(&self, title: String) -> BrowserEngineSnapshot {
        let mut state = lock_or_recover(&self.state);
        state.engine.mounted = true;
        state.engine.webview_label = BROWSER_ENGINE_WEBVIEW_LABEL.to_string();
        state.engine.title = Some(title.trim().chars().take(180).collect());
        state.engine.updated_at_ms = now_ms();
        let engine_title = state.engine.title.clone();
        let engine_updated_at_ms = state.engine.updated_at_ms;
        if state.engine.pending_url.is_none() {
            if let Some(active_tab_id) = state.active_browser_tab_id.clone() {
                if let Some(tab) = state
                    .tabs
                    .iter_mut()
                    .find(|tab| tab.browser_tab_id == active_tab_id)
                {
                    tab.title = engine_title.clone();
                    tab.updated_at_ms = engine_updated_at_ms;
                }
            }
        }
        state.engine.clone()
    }

    pub fn record_engine_error(&self, message: String) -> BrowserEngineSnapshot {
        let mut state = lock_or_recover(&self.state);
        state.engine.mounted = state.engine.mounted || state.window_open;
        state.engine.webview_label = BROWSER_ENGINE_WEBVIEW_LABEL.to_string();
        state.engine.pending_url = None;
        state.engine.load_status = "error".to_string();
        state.engine.last_error = Some(message.chars().take(600).collect());
        state.engine.updated_at_ms = now_ms();
        let engine_updated_at_ms = state.engine.updated_at_ms;
        if let Some(active_tab_id) = state.active_browser_tab_id.clone() {
            if let Some(tab) = state
                .tabs
                .iter_mut()
                .find(|tab| tab.browser_tab_id == active_tab_id)
            {
                tab.status = "error".to_string();
                tab.updated_at_ms = engine_updated_at_ms;
            }
        }
        state.engine.clone()
    }

    pub fn record_engine_beforeunload_blocker(
        &self,
        request: &BrowserActionRequest,
        action: &str,
    ) -> Result<Option<BrowserActionResponse>, String> {
        let mut state = lock_or_recover(&self.state);
        let requested_navigation_url = request
            .url
            .as_deref()
            .map(clean_string)
            .filter(|value| !value.is_empty());
        let task_id = match resolve_task_id(&state, request.task_id.clone()) {
            Ok(task_id) => task_id,
            Err(_) => return Ok(None),
        };
        if state.active_task_id.as_deref() != Some(task_id.as_str()) {
            return Ok(None);
        }
        let idx = find_task_index(&state, &task_id)?;
        let browser_tab_id = request
            .browser_tab_id
            .as_deref()
            .map(clean_string)
            .filter(|value| !value.is_empty())
            .or_else(|| state.active_browser_tab_id.clone());
        if let Some(tab_id) = browser_tab_id.as_deref() {
            let tab_idx = find_tab_index(&state, tab_id)?;
            if state.tabs[tab_idx].task_id.as_deref() != Some(task_id.as_str()) {
                return Ok(None);
            }
        }
        let existing_dialog_id = state
            .dialogs
            .iter()
            .rev()
            .find(|dialog| {
                dialog.dialog_type == "beforeunload"
                    && dialog.status == "pending"
                    && dialog.browser_tab_id == browser_tab_id
            })
            .map(|dialog| dialog.dialog_id.clone());
        let has_pending_navigation = existing_dialog_id.is_some()
            || state.engine.load_status == "blockedBeforeUnload"
            || (action == "navigate" && requested_navigation_url.is_some());
        if !has_pending_navigation {
            return Ok(None);
        }
        let task = state.tasks[idx].clone();
        let profile_id = state
            .engine
            .profile_id
            .clone()
            .or_else(|| Some(task.profile_id.clone()));
        let pending_url = state
            .engine
            .pending_url
            .clone()
            .or_else(|| requested_navigation_url.clone())
            .or_else(|| task.current_url.clone())
            .or_else(|| state.engine.url.clone());
        if action == "navigate" && state.engine.pending_url.is_none() {
            state.engine.pending_url = pending_url.clone();
        }
        let dialog_id = existing_dialog_id.unwrap_or_else(|| browser_id("browser-dialog"));
        let message = format!(
            "Page navigation is waiting for confirmation. Changes you made may not be saved. Resolve dialogId {} with browser_resolve_dialog.",
            dialog_id
        );
        let now = now_ms();
        state.engine.load_status = "blockedBeforeUnload".to_string();
        state.engine.last_error = Some(message.clone());
        state.engine.updated_at_ms = now;
        if let Some(tab_id) = browser_tab_id.as_deref() {
            if let Some(tab) = state
                .tabs
                .iter_mut()
                .find(|tab| tab.browser_tab_id == tab_id)
            {
                tab.status = "blockedBeforeUnload".to_string();
                tab.updated_at_ms = now;
            }
        }
        let receipt = push_receipt(
            &mut state,
            "browserBeforeUnloadBlocked",
            Some(task.task_id.clone()),
            profile_id.clone(),
            format!(
                "Browser beforeunload confirmation blocked action '{}'",
                action
            ),
            json!({
                "dialogId": dialog_id,
                "browserTabId": browser_tab_id,
                "dialogType": "beforeunload",
                "action": action,
                "pendingUrl": pending_url,
                "requiredApproval": "beforeunloadNavigation",
            }),
        );
        if !state
            .dialogs
            .iter()
            .any(|dialog| dialog.dialog_id == dialog_id)
        {
            state.dialogs.push(BrowserDialogEvent {
                dialog_id: dialog_id.clone(),
                task_id: Some(task.task_id.clone()),
                browser_tab_id: browser_tab_id.clone(),
                profile_id: profile_id.clone(),
                dialog_type: "beforeunload".to_string(),
                text: "Leave site? Changes you made may not be saved.".to_string(),
                url: pending_url.clone(),
                status: "pending".to_string(),
                requires_approval: true,
                prompt_value_provided: false,
                created_at_ms: now,
                resolved_at_ms: None,
                receipt: receipt.clone(),
            });
            if state.dialogs.len() > 500 {
                let overflow = state.dialogs.len() - 500;
                state.dialogs.drain(0..overflow);
            }
        }
        Ok(Some(BrowserActionResponse {
            ok: false,
            status: "blockedBeforeUnload".to_string(),
            task_id: Some(task.task_id),
            current_url: task.current_url,
            required_approval: Some("beforeunloadNavigation".to_string()),
            requires_engine: false,
            message: Some(message),
            observation: None,
            extracted_text: None,
            actionability: None,
            verification: None,
            screenshot: None,
            find_result: None,
            security_state: None,
            step_summary: None,
            receipt,
        }))
    }
}
