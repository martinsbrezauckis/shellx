use super::*;

pub(crate) fn record_history_visit(
    state: &mut BrowserState,
    task_id: Option<String>,
    profile_id: String,
    url: String,
    title: Option<String>,
) {
    let url = clean_string(url);
    if url.is_empty() || url == "about:blank" {
        return;
    }
    let profile_id = clean_string(profile_id);
    let profile_id = if profile_id.is_empty() {
        "agent-work".to_string()
    } else {
        profile_id
    };
    state
        .history
        .retain(|entry| !(entry.url == url && entry.profile_id == profile_id));
    state.history.insert(
        0,
        BrowserHistoryEntry {
            history_id: browser_id("browser-history"),
            task_id,
            profile_id,
            url,
            title: title.map(clean_string).filter(|value| !value.is_empty()),
            visited_at_ms: now_ms(),
        },
    );
    state.history.truncate(200);
}

pub(crate) fn ensure_engine_task_matches_active_context(
    state: &BrowserState,
    task_id: &str,
) -> Result<(), String> {
    find_task_index(state, task_id)?;
    let tab_idx = state
        .tabs
        .iter()
        .position(|tab| tab.task_id.as_deref() == Some(task_id))
        .ok_or_else(|| {
            "Browser engine has no tab for the requested task; reopen or focus the task tab before using native Browser actions"
                .to_string()
        })?;
    ensure_engine_matches_tab_context(state, tab_idx)
}

pub(crate) fn ensure_engine_matches_tab_context(
    state: &BrowserState,
    tab_idx: usize,
) -> Result<(), String> {
    let tab = state
        .tabs
        .get(tab_idx)
        .ok_or_else(|| "Browser engine target tab is missing".to_string())?;
    let engine = state
        .engine_pool
        .engines
        .iter()
        .find(|engine| engine.engine_id == tab.engine_id)
        .or_else(|| (state.engine.engine_id == tab.engine_id).then_some(&state.engine))
        .ok_or_else(|| {
            "Browser engine for this tab is not allocated; wait for the browser engine pool to create it"
                .to_string()
        })?;
    if let Some(pending_url) = engine.pending_url.as_deref() {
        let safe_pending_url = safe_url_parts(pending_url).url;
        return Err(format!(
            "Browser engine navigation to {} is still pending; wait for page load or resolve the page navigation prompt before using native Browser actions",
            safe_pending_url
        ));
    }
    if engine.load_status == "navigating" {
        return Err(
            "Browser engine navigation is still pending; wait for page load before using native Browser actions"
                .to_string(),
        );
    }
    let Some(engine_url) = engine
        .url
        .as_deref()
        .map(clean_string)
        .filter(|value| !value.is_empty())
    else {
        return Err("Browser engine has no committed page URL yet".to_string());
    };
    if let Some(tab_url) = tab
        .url
        .as_deref()
        .map(clean_string)
        .filter(|value| !value.is_empty())
    {
        if normalize_browser_url(&tab_url) != normalize_browser_url(&engine_url) {
            let engine_tab_matches = engine
                .browser_tab_id
                .as_deref()
                .map(|tab_id| tab_id == tab.browser_tab_id.as_str())
                .unwrap_or(true);
            let engine_task_matches = match (engine.task_id.as_deref(), tab.task_id.as_deref()) {
                (Some(engine_task_id), Some(tab_task_id)) => engine_task_id == tab_task_id,
                (None, Some(_)) | (None, None) => true,
                (Some(_), None) => false,
            };
            let engine_belongs_to_tab =
                engine.engine_id == tab.engine_id && engine_tab_matches && engine_task_matches;
            if engine_belongs_to_tab {
                return Ok(());
            }
            let safe_engine_url = safe_url_parts(&engine_url).url;
            let safe_tab_url = safe_url_parts(&tab_url).url;
            return Err(format!(
                "Browser engine is showing {} while active tab expects {}; wait for navigation to finish or resolve the page navigation prompt",
                safe_engine_url, safe_tab_url
            ));
        }
    }
    Ok(())
}

pub(crate) fn create_browser_tab(
    state: &mut BrowserState,
    task_id: Option<String>,
    profile_id: String,
    url: Option<String>,
    title: Option<String>,
    status: String,
) -> BrowserTabSnapshot {
    let now = now_ms();
    let security_state = classify_browser_page_security(url.as_deref());
    let privacy_mode = ad_mode_for_profile(&state.privacy, &profile_id);
    let owner_kind = if task_id.is_some() {
        BrowserTabOwnerKind::Agent
    } else {
        BrowserTabOwnerKind::User
    };
    let mut shields = browser_tab_shields_for_url(&state.shields, url.as_deref());
    apply_privacy_mode_to_tab_shields(&mut shields, &privacy_mode);
    let engine_id = allocate_engine_for_tab_locked(state, task_id.as_deref(), &profile_id);
    let engine_webview_label = browser_engine_webview_label(&engine_id);
    let browser_tab_id = browser_id("browser-tab");
    ensure_engine_snapshot_locked(
        state,
        EnsureEngineSnapshotRequest {
            engine_id: &engine_id,
            webview_label: &engine_webview_label,
            task_id: task_id.as_deref(),
            browser_tab_id: &browser_tab_id,
            profile_id: &profile_id,
            url: url.clone(),
            title: title.clone(),
            status: &status,
        },
    );
    BrowserTabSnapshot {
        browser_tab_id,
        engine_id,
        task_id,
        profile_id: profile_id.clone(),
        url,
        expected_domains: Vec::new(),
        title,
        status,
        active: false,
        security_state,
        shields,
        engine_webview_label: Some(engine_webview_label),
        engine_state: BrowserEngineTabState::Live,
        last_visual_capture_at_ms: None,
        requires_user_attention: false,
        storage_root: Some(browser_profile_storage_root(&profile_id)),
        privacy_mode,
        owner_kind,
        delegated_task_id: None,
        delegated_grant_id: None,
        lock: None,
        created_at_ms: now,
        updated_at_ms: now,
    }
}

fn allocate_engine_for_tab_locked(
    state: &BrowserState,
    task_id: Option<&str>,
    profile_id: &str,
) -> String {
    if let Some(task_id) = task_id {
        if let Some(existing) = state
            .tabs
            .iter()
            .find(|tab| tab.task_id.as_deref() == Some(task_id))
        {
            return existing.engine_id.clone();
        }
        let active_task_engine_ids = state
            .tabs
            .iter()
            .filter(|tab| tab.task_id.is_some())
            .map(|tab| tab.engine_id.as_str())
            .collect::<Vec<_>>();
        let mut idle_agent_engines = state
            .engine_pool
            .engines
            .iter()
            .filter(|engine| {
                browser_agent_engine_suffix(&engine.engine_id).is_some()
                    && !active_task_engine_ids
                        .iter()
                        .any(|active| *active == engine.engine_id)
            })
            .collect::<Vec<_>>();
        idle_agent_engines.sort_by_key(|engine| {
            browser_agent_engine_suffix(&engine.engine_id).unwrap_or(usize::MAX)
        });
        if let Some(engine) = idle_agent_engines.first() {
            return engine.engine_id.clone();
        }
        for index in 1.. {
            let candidate = browser_agent_engine_id(index);
            let already_allocated = state
                .engine_pool
                .engines
                .iter()
                .any(|engine| engine.engine_id == candidate)
                || active_task_engine_ids
                    .iter()
                    .any(|active| *active == candidate);
            if !already_allocated {
                return candidate;
            }
        }
        unreachable!("agent engine allocation loop always returns");
    }
    if profile_id == "personal" {
        BROWSER_ENGINE_FOREGROUND_ID.to_string()
    } else {
        state
            .tabs
            .iter()
            .find(|tab| tab.task_id.is_none() && tab.profile_id == profile_id)
            .map(|tab| tab.engine_id.clone())
            .unwrap_or_else(|| BROWSER_ENGINE_FOREGROUND_ID.to_string())
    }
}

fn browser_agent_engine_id(index: usize) -> String {
    format!("browser-engine-agent-{}", index)
}

fn browser_agent_engine_suffix(engine_id: &str) -> Option<usize> {
    engine_id
        .strip_prefix("browser-engine-agent-")
        .and_then(|suffix| suffix.parse::<usize>().ok())
}

pub(crate) fn update_task_engine_snapshot_locked<F>(
    state: &mut BrowserState,
    task_id: &str,
    mut update: F,
) -> Option<BrowserEngineSnapshot>
where
    F: FnMut(&mut BrowserEngineSnapshot),
{
    let (engine_id, browser_tab_id) = state
        .tabs
        .iter()
        .find(|tab| tab.task_id.as_deref() == Some(task_id))
        .map(|tab| (tab.engine_id.clone(), tab.browser_tab_id.clone()))?;
    let engine_idx = state
        .engine_pool
        .engines
        .iter()
        .position(|engine| engine.engine_id == engine_id)?;
    {
        let engine = &mut state.engine_pool.engines[engine_idx];
        engine.browser_tab_id = Some(browser_tab_id.clone());
        engine.task_id = Some(task_id.to_string());
        update(engine);
    }
    let snapshot = state.engine_pool.engines[engine_idx].clone();
    if state.active_browser_tab_id.as_deref() == Some(browser_tab_id.as_str())
        || snapshot.engine_id == BROWSER_ENGINE_FOREGROUND_ID
    {
        state.engine = snapshot.clone();
        state.engine_waitlist = snapshot.waitlist.clone();
    }
    Some(snapshot)
}

pub(crate) struct EnsureEngineSnapshotRequest<'a> {
    pub(crate) engine_id: &'a str,
    pub(crate) webview_label: &'a str,
    pub(crate) task_id: Option<&'a str>,
    pub(crate) browser_tab_id: &'a str,
    pub(crate) profile_id: &'a str,
    pub(crate) url: Option<String>,
    pub(crate) title: Option<String>,
    pub(crate) status: &'a str,
}

#[deny(clippy::expect_used, clippy::unwrap_used)]
pub(crate) fn ensure_engine_snapshot_locked(
    state: &mut BrowserState,
    request: EnsureEngineSnapshotRequest<'_>,
) -> usize {
    let now = now_ms();
    let privacy_mode = effective_ad_mode_for_profile_and_url(
        &state.privacy,
        &state.shields,
        request.profile_id,
        request.url.as_deref(),
    );
    if let Some(engine_idx) = state
        .engine_pool
        .engines
        .iter()
        .position(|engine| engine.engine_id == request.engine_id)
    {
        let engine = &mut state.engine_pool.engines[engine_idx];
        engine.browser_tab_id = Some(request.browser_tab_id.to_string());
        engine.task_id = request.task_id.map(ToOwned::to_owned);
        engine.profile_id = Some(request.profile_id.to_string());
        engine.privacy_mode = privacy_mode;
        if engine.url.is_none() {
            engine.url = request.url;
        }
        if engine.title.is_none() {
            engine.title = request.title;
        }
        if !engine.mounted {
            engine.load_status = request.status.to_string();
        }
        engine.updated_at_ms = now;
        return engine_idx;
    }
    let is_foreground = request.engine_id == BROWSER_ENGINE_FOREGROUND_ID;
    let engine_idx = state.engine_pool.engines.len();
    state.engine_pool.engines.push(BrowserEngineSnapshot {
        engine_id: request.engine_id.to_string(),
        mounted: false,
        webview_label: request.webview_label.to_string(),
        browser_tab_id: Some(request.browser_tab_id.to_string()),
        task_id: request.task_id.map(ToOwned::to_owned),
        profile_id: Some(request.profile_id.to_string()),
        privacy_mode,
        url: request.url,
        pending_url: None,
        title: request.title,
        load_status: request.status.to_string(),
        bounds: None,
        last_error: None,
        visibility_state: if is_foreground {
            BrowserEngineVisibilityState::Foreground
        } else {
            BrowserEngineVisibilityState::Background
        },
        visual_capture: BrowserEngineVisualCaptureState::Available,
        waitlist: BrowserEngineWaitlistSnapshot::default(),
        updated_at_ms: now,
    });
    engine_idx
}

pub(crate) fn update_tab_url(
    tab: &mut BrowserTabSnapshot,
    url: Option<String>,
    shields: &BrowserShieldSettings,
) {
    let url = url.map(|value| normalize_browser_external_redirect_url(&value));
    tab.security_state = classify_browser_page_security(url.as_deref());
    refresh_browser_tab_effective_shields_for_url(tab, shields, url.as_deref());
    tab.url = url;
}

pub(crate) fn set_active_tab(state: &mut BrowserState, browser_tab_id: &str) {
    state.active_browser_tab_id = Some(browser_tab_id.to_string());
    let active_tab = state
        .tabs
        .iter()
        .find(|tab| tab.browser_tab_id == browser_tab_id)
        .map(|tab| (tab.engine_id.clone(), tab.task_id.clone()));
    let active_engine_id = active_tab.as_ref().map(|(engine_id, _)| engine_id.clone());
    let active_tab_task_id = active_tab
        .and_then(|(_, task_id)| task_id)
        .filter(|task_id| {
            state.tasks.iter().any(|task| {
                task.task_id == *task_id
                    && !crate::shellx_browser_tasks::browser_task_is_terminal(&task.status)
            })
        });
    // active tab selection must clear stale agent task context when the user
    // focuses a personal/taskless tab.
    state.active_task_id = active_tab_task_id;
    for tab in &mut state.tabs {
        tab.active = tab.browser_tab_id == browser_tab_id;
        if tab.active {
            tab.engine_webview_label = Some(browser_engine_webview_label(&tab.engine_id));
            tab.updated_at_ms = now_ms();
        }
    }
    for engine in &mut state.engine_pool.engines {
        engine.visibility_state = if Some(engine.engine_id.as_str()) == active_engine_id.as_deref()
        {
            BrowserEngineVisibilityState::Foreground
        } else {
            BrowserEngineVisibilityState::Background
        };
    }
    if let Some(engine_id) = active_engine_id {
        if let Some(engine) = state
            .engine_pool
            .engines
            .iter()
            .find(|engine| engine.engine_id == engine_id)
            .cloned()
        {
            state.engine = engine;
            state.engine_waitlist = state.engine.waitlist.clone();
        }
    }
}

pub(crate) fn reset_browser_engine_snapshots_for_empty_tabs_locked(state: &mut BrowserState) {
    state.active_browser_tab_id = None;
    state.active_task_id = None;
    state.engine = BrowserEngineSnapshot::default();
    state.engine_waitlist = BrowserEngineWaitlistSnapshot::default();
    state.engine_pool.engines.clear();
    state.engine_pool.waiting.clear();
    state.engine_pool.parked_tabs.clear();
}

pub(crate) fn sync_tabs_for_task<F>(state: &mut BrowserState, task_id: &str, mut f: F)
where
    F: FnMut(&mut BrowserTabSnapshot),
{
    for tab in state
        .tabs
        .iter_mut()
        .filter(|tab| tab.task_id.as_deref() == Some(task_id))
    {
        f(tab);
        tab.updated_at_ms = now_ms();
    }
}
