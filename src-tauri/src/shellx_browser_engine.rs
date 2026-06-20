use serde_json::json;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{Mutex as AsyncMutex, OwnedMutexGuard};

use crate::shellx_browser::{
    browser_id, clean_string, lock_or_recover, now_ms, push_receipt, resolve_action_tab_index,
    BrowserActionRequest, BrowserActionResponse, BrowserAdMode, BrowserEngineBounds,
    BrowserEnginePoolLimits, BrowserEnginePoolSnapshot, BrowserEnginePoolUpdateRequest,
    BrowserEngineResourcePressure, BrowserEngineSnapshot, BrowserEngineSyncRequest,
    BrowserEngineVisibilityState, BrowserEngineVisualCaptureState, BrowserEngineWaitlistEntry,
    BrowserEngineWaitlistSnapshot, BrowserState, ShellxBrowserRegistry,
    BROWSER_ENGINE_ACTION_WAIT_TIMEOUT_MS, BROWSER_ENGINE_AUTO_BACKGROUND_CAP,
    BROWSER_ENGINE_FOREGROUND_ID, BROWSER_ENGINE_WEBVIEW_LABEL,
};
use crate::shellx_browser_tasks::browser_agent_step_summary_for_task;

impl ShellxBrowserRegistry {
    pub fn update_engine_pool(
        &self,
        request: BrowserEnginePoolUpdateRequest,
    ) -> Result<BrowserEnginePoolSnapshot, String> {
        let configured_parallel_agents =
            normalize_browser_engine_pool_parallel_agents(request.configured_parallel_agents)?;
        let automation_mode =
            normalize_browser_engine_pool_automation_mode(request.automation_mode)?;
        let mut state = lock_or_recover(&self.state);
        let resource_pressure = browser_detect_engine_resource_pressure();
        state.engine_pool.resource_pressure = resource_pressure.clone();
        if let Some(configured_parallel_agents) = configured_parallel_agents {
            state.engine_pool.limits.configured_parallel_agents = configured_parallel_agents;
        }
        state.engine_pool.limits.max_background_engines = BROWSER_ENGINE_AUTO_BACKGROUND_CAP;
        state.engine_pool.limits.effective_background_engines =
            browser_effective_background_engine_cap(
                &state.engine_pool.limits.configured_parallel_agents,
                &resource_pressure,
            );
        if let Some(automation_mode) = automation_mode {
            state.engine_pool.automation_mode = automation_mode;
        }
        let engine_pool = state.engine_pool.clone();
        let active_task_id = state.active_task_id.clone();
        let active_profile_id = active_task_id.as_deref().and_then(|task_id| {
            state
                .tasks
                .iter()
                .find(|task| task.task_id == task_id)
                .map(|task| task.profile_id.clone())
        });
        push_receipt(
            &mut state,
            "browserEnginePoolUpdated",
            active_task_id,
            active_profile_id,
            "Browser engine pool settings updated".to_string(),
            json!({
                "configuredParallelAgents": engine_pool.limits.configured_parallel_agents,
                "effectiveBackgroundEngines": engine_pool.limits.effective_background_engines,
                "automationMode": engine_pool.automation_mode,
                "resourcePressure": engine_pool.resource_pressure,
            }),
        );
        Ok(engine_pool)
    }
}

pub(crate) fn browser_default_engine_pool_snapshot() -> BrowserEnginePoolSnapshot {
    let resource_pressure = browser_detect_engine_resource_pressure();
    let limits = BrowserEnginePoolLimits {
        effective_background_engines: browser_effective_background_engine_cap(
            "auto",
            &resource_pressure,
        ),
        ..BrowserEnginePoolLimits::default()
    };
    BrowserEnginePoolSnapshot {
        limits,
        resource_pressure,
        window_state: "foreground".to_string(),
        automation_mode: "normal".to_string(),
        ..BrowserEnginePoolSnapshot::default()
    }
}

pub(crate) fn browser_detect_engine_resource_pressure() -> BrowserEngineResourcePressure {
    let mut sys = sysinfo::System::new();
    sys.refresh_memory();
    let total_bytes = sys.total_memory();
    let free_bytes = sys.available_memory();
    if total_bytes == 0 {
        return BrowserEngineResourcePressure::default();
    }
    let gib = 1024_u64 * 1024 * 1024;
    let mib = 1024_u64 * 1024;
    let detected_ram_gb = total_bytes.div_ceil(gib).max(1);
    let free_ram_mb = free_bytes / mib;
    let status = if detected_ram_gb < 6 || free_ram_mb < 1536 {
        "lowMemory"
    } else if detected_ram_gb < 16 || free_ram_mb < 3072 {
        "constrained"
    } else {
        "normal"
    };
    BrowserEngineResourcePressure {
        status: status.to_string(),
        detected_ram_gb: Some(detected_ram_gb),
        free_ram_mb: Some(free_ram_mb),
        cpu_pressure: None,
        battery_saver: None,
    }
}

pub(crate) fn browser_effective_background_engine_cap(
    configured_parallel_agents: &str,
    resource_pressure: &BrowserEngineResourcePressure,
) -> usize {
    let configured = clean_string(configured_parallel_agents).to_ascii_lowercase();
    if configured != "auto" {
        if let Ok(value) = configured.parse::<usize>() {
            return value.clamp(1, BROWSER_ENGINE_AUTO_BACKGROUND_CAP);
        }
    }
    let detected_ram_gb = resource_pressure.detected_ram_gb.unwrap_or(0);
    let free_ram_mb = resource_pressure.free_ram_mb.unwrap_or(u64::MAX);
    let ram_cap = if detected_ram_gb >= 28 {
        4
    } else if detected_ram_gb >= 16 {
        3
    } else if detected_ram_gb >= 8 {
        2
    } else {
        1
    };
    let free_cap = if free_ram_mb < 1536 {
        1
    } else if free_ram_mb < 3072 {
        2
    } else {
        BROWSER_ENGINE_AUTO_BACKGROUND_CAP
    };
    ram_cap
        .min(free_cap)
        .clamp(1, BROWSER_ENGINE_AUTO_BACKGROUND_CAP)
}

pub(crate) fn normalize_browser_engine_pool_parallel_agents(
    value: Option<String>,
) -> Result<Option<String>, String> {
    let Some(value) = value else {
        return Ok(None);
    };
    let normalized = clean_string(value).to_ascii_lowercase();
    if normalized.is_empty() {
        return Ok(None);
    }
    if normalized == "auto" {
        return Ok(Some("auto".to_string()));
    }
    let parsed = normalized
        .parse::<usize>()
        .map_err(|_| "configuredParallelAgents must be auto or a number from 1 to 4".to_string())?;
    if !(1..=BROWSER_ENGINE_AUTO_BACKGROUND_CAP).contains(&parsed) {
        return Err("configuredParallelAgents must be auto or a number from 1 to 4".to_string());
    }
    Ok(Some(parsed.to_string()))
}

pub(crate) fn normalize_browser_engine_pool_automation_mode(
    value: Option<String>,
) -> Result<Option<String>, String> {
    let Some(value) = value else {
        return Ok(None);
    };
    let normalized = clean_string(value)
        .to_ascii_lowercase()
        .replace(['-', '_'], "");
    if normalized.is_empty() {
        return Ok(None);
    }
    match normalized.as_str() {
        "normal" => Ok(Some("normal".to_string())),
        "backgroundonly" => Ok(Some("backgroundOnly".to_string())),
        _ => Err("automationMode must be normal or backgroundOnly".to_string()),
    }
}

pub(crate) fn browser_default_engine_bounds() -> BrowserEngineBounds {
    BrowserEngineBounds {
        x: 0.0,
        y: 96.0,
        width: 900.0,
        height: 640.0,
    }
}

pub(crate) fn browser_background_engine_bounds() -> BrowserEngineBounds {
    BrowserEngineBounds {
        x: -30000.0,
        y: -30000.0,
        width: 1024.0,
        height: 768.0,
    }
}

pub(crate) fn browser_engine_bounds_are_background(bounds: BrowserEngineBounds) -> bool {
    bounds.x <= -1000.0 || bounds.y <= -1000.0
}

pub(crate) fn browser_engine_webview_label(engine_id: &str) -> String {
    if engine_id == BROWSER_ENGINE_FOREGROUND_ID {
        return BROWSER_ENGINE_WEBVIEW_LABEL.to_string();
    }
    let suffix = engine_id
        .trim()
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' {
                ch
            } else {
                '-'
            }
        })
        .collect::<String>();
    format!("{}-{}", BROWSER_ENGINE_WEBVIEW_LABEL, suffix)
}

pub(crate) fn browser_action_uses_native_engine(action: &str) -> bool {
    matches!(
        action,
        "observe"
            | "extractText"
            | "extractMarkdown"
            | "goBack"
            | "goForward"
            | "reload"
            | "click"
            | "clickRef"
            | "clickAt"
            | "fillRef"
            | "type"
            | "typeText"
            | "scroll"
            | "waitFor"
            | "select"
            | "press"
            | "extractTable"
            | "capturePageSecretToVault"
            | "captureScreenshot"
            | "verify"
            | "findText"
            | "clearSiteData"
    )
}

pub fn browser_action_uses_engine_slot(action: &str) -> bool {
    let action = clean_string(action);
    matches!(
        action.as_str(),
        "navigate" | "fillFromVaultGrant" | "fillProfileCardGrant"
    ) || browser_action_uses_native_engine(&action)
}

pub fn browser_engine_action_wait_timeout() -> Duration {
    Duration::from_millis(BROWSER_ENGINE_ACTION_WAIT_TIMEOUT_MS)
}

pub struct BrowserEngineActionSlotGuard<'a> {
    registry: &'a ShellxBrowserRegistry,
    engine_id: String,
    wait_id: String,
    _guard: OwnedMutexGuard<()>,
}

impl std::fmt::Debug for BrowserEngineActionSlotGuard<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("BrowserEngineActionSlotGuard")
            .field("engine_id", &self.engine_id)
            .field("wait_id", &self.wait_id)
            .finish_non_exhaustive()
    }
}

impl Drop for BrowserEngineActionSlotGuard<'_> {
    fn drop(&mut self) {
        self.registry
            .finish_engine_action_slot(&self.engine_id, &self.wait_id);
    }
}

impl ShellxBrowserRegistry {
    pub async fn wait_for_engine_action_slot(
        &self,
        request: &BrowserActionRequest,
        action: &str,
        wait_timeout: Duration,
    ) -> Result<BrowserEngineActionSlotGuard<'_>, BrowserActionResponse> {
        let action = clean_string(action);
        let engine_id = self.engine_id_for_action_request(request);
        let wait_id = browser_id("browser-engine-wait");
        let entry = BrowserEngineWaitlistEntry {
            wait_id: wait_id.clone(),
            engine_id: engine_id.clone(),
            action: action.clone(),
            task_id: request
                .task_id
                .as_deref()
                .map(clean_string)
                .filter(|value| !value.is_empty()),
            browser_tab_id: request
                .browser_tab_id
                .as_deref()
                .map(clean_string)
                .filter(|value| !value.is_empty()),
            owner_agent_id: request
                .owner_agent_id
                .as_deref()
                .map(clean_string)
                .filter(|value| !value.is_empty()),
            owner_run_id: request
                .owner_run_id
                .as_deref()
                .map(clean_string)
                .filter(|value| !value.is_empty()),
            queued_at_ms: now_ms(),
            started_at_ms: None,
        };
        self.record_engine_wait_queued(&engine_id, entry.clone());
        let lock = self.engine_action_lock_for(&engine_id);
        match tokio::time::timeout(wait_timeout, lock.lock_owned()).await {
            Ok(guard) => {
                self.record_engine_wait_active(&engine_id, &wait_id, entry);
                Ok(BrowserEngineActionSlotGuard {
                    registry: self,
                    engine_id,
                    wait_id,
                    _guard: guard,
                })
            }
            Err(_) => Err(self.record_engine_wait_timeout(
                &engine_id,
                &wait_id,
                request,
                &action,
                wait_timeout,
            )),
        }
    }

    pub(crate) fn engine_id_for_action_request(&self, request: &BrowserActionRequest) -> String {
        let state = lock_or_recover(&self.state);
        resolve_action_tab_index(&state, request)
            .ok()
            .flatten()
            .and_then(|idx| state.tabs.get(idx).map(|tab| tab.engine_id.clone()))
            .or_else(|| {
                state.active_browser_tab_id.as_deref().and_then(|tab_id| {
                    state
                        .tabs
                        .iter()
                        .find(|tab| tab.browser_tab_id == tab_id)
                        .map(|tab| tab.engine_id.clone())
                })
            })
            .or_else(|| {
                state
                    .engine_pool
                    .engines
                    .first()
                    .map(|engine| engine.engine_id.clone())
            })
            .unwrap_or_else(|| BROWSER_ENGINE_FOREGROUND_ID.to_string())
    }

    pub(crate) fn engine_id_for_sync_request(&self, request: &BrowserEngineSyncRequest) -> String {
        let state = lock_or_recover(&self.state);
        resolve_engine_id_for_sync_request_locked(&state, request)
    }

    fn engine_action_lock_for(&self, engine_id: &str) -> Arc<AsyncMutex<()>> {
        let mut locks = lock_or_recover(&self.engine_action_locks);
        locks
            .entry(engine_id.to_string())
            .or_insert_with(|| Arc::new(AsyncMutex::new(())))
            .clone()
    }

    fn record_engine_wait_queued(&self, engine_id: &str, entry: BrowserEngineWaitlistEntry) {
        let mut state = lock_or_recover(&self.state);
        let waitlist = engine_waitlist_mut(&mut state, engine_id);
        waitlist.waiting.push(entry);
        if waitlist.waiting.len() > 128 {
            let overflow = waitlist.waiting.len() - 128;
            waitlist.waiting.drain(0..overflow);
        }
        sync_engine_waitlist_compat_locked(&mut state, engine_id);
    }

    fn record_engine_wait_active(
        &self,
        engine_id: &str,
        wait_id: &str,
        mut entry: BrowserEngineWaitlistEntry,
    ) {
        let mut state = lock_or_recover(&self.state);
        let waitlist = engine_waitlist_mut(&mut state, engine_id);
        waitlist
            .waiting
            .retain(|candidate| candidate.wait_id != wait_id);
        entry.started_at_ms = Some(now_ms());
        waitlist.active = Some(entry);
        sync_engine_waitlist_compat_locked(&mut state, engine_id);
    }

    fn finish_engine_action_slot(&self, engine_id: &str, wait_id: &str) {
        let mut state = lock_or_recover(&self.state);
        let waitlist = engine_waitlist_mut(&mut state, engine_id);
        if waitlist
            .active
            .as_ref()
            .is_some_and(|entry| entry.wait_id == wait_id)
        {
            waitlist.active = None;
        }
        sync_engine_waitlist_compat_locked(&mut state, engine_id);
    }

    fn record_engine_wait_timeout(
        &self,
        engine_id: &str,
        wait_id: &str,
        request: &BrowserActionRequest,
        action: &str,
        wait_timeout: Duration,
    ) -> BrowserActionResponse {
        let mut state = lock_or_recover(&self.state);
        let queue_position = engine_waitlist_ref(&state, engine_id)
            .map(|waitlist| {
                waitlist
                    .waiting
                    .iter()
                    .position(|entry| entry.wait_id == wait_id)
                    .map(|idx| idx + 1)
                    .unwrap_or(0)
            })
            .unwrap_or(0);
        let active_entry = {
            let waitlist = engine_waitlist_mut(&mut state, engine_id);
            waitlist.waiting.retain(|entry| entry.wait_id != wait_id);
            waitlist.active.clone()
        };
        sync_engine_waitlist_compat_locked(&mut state, engine_id);
        let target_tab = resolve_action_tab_index(&state, request)
            .ok()
            .flatten()
            .and_then(|idx| state.tabs.get(idx).cloned());
        let task_id = request
            .task_id
            .as_deref()
            .map(clean_string)
            .filter(|value| !value.is_empty())
            .or_else(|| target_tab.as_ref().and_then(|tab| tab.task_id.clone()))
            .or_else(|| state.active_task_id.clone());
        let task = task_id
            .as_deref()
            .and_then(|id| state.tasks.iter().find(|task| task.task_id == id))
            .cloned();
        let profile_id = target_tab
            .as_ref()
            .map(|tab| tab.profile_id.clone())
            .or_else(|| task.as_ref().map(|task| task.profile_id.clone()))
            .or_else(|| state.engine.profile_id.clone());
        let current_url = target_tab
            .as_ref()
            .and_then(|tab| tab.url.clone())
            .or_else(|| task.as_ref().and_then(|task| task.current_url.clone()))
            .or_else(|| state.engine.url.clone());
        let browser_tab_id = target_tab
            .as_ref()
            .map(|tab| tab.browser_tab_id.clone())
            .or_else(|| request.browser_tab_id.clone());
        let wait_timeout_ms = wait_timeout.as_millis().try_into().unwrap_or(u64::MAX);
        let message = format!(
            "Browser engine is busy with another action; retry this browser action after {} ms.",
            wait_timeout_ms
        );
        let receipt = push_receipt(
            &mut state,
            "browserEngineBusy",
            task_id.clone(),
            profile_id,
            format!("Browser engine busy while queuing action '{}'", action),
            json!({
                "waitId": wait_id,
                "engineId": engine_id,
                "action": action,
                "browserTabId": browser_tab_id,
                "queuePosition": queue_position,
                "waitTimeoutMs": wait_timeout_ms,
                "activeWaitId": active_entry.as_ref().map(|entry| entry.wait_id.clone()),
                "activeAction": active_entry.as_ref().map(|entry| entry.action.clone()),
                "retryable": true,
            }),
        );
        let step_summary = task.as_ref().map(|task| {
            browser_agent_step_summary_for_task(
                &state,
                task,
                action,
                "browserEngineBusy",
                true,
                None,
                None,
                None,
                None,
            )
        });
        BrowserActionResponse {
            ok: false,
            status: "browserEngineBusy".to_string(),
            task_id,
            current_url,
            required_approval: None,
            requires_engine: true,
            message: Some(message),
            observation: None,
            extracted_text: None,
            actionability: None,
            verification: None,
            screenshot: None,
            find_result: None,
            security_state: None,
            step_summary,
            receipt,
        }
    }
}

pub(crate) fn resolve_engine_id_for_sync_request_locked(
    state: &BrowserState,
    request: &BrowserEngineSyncRequest,
) -> String {
    request
        .engine_id
        .as_deref()
        .map(clean_string)
        .filter(|value| !value.is_empty())
        .or_else(|| {
            request
                .browser_tab_id
                .as_deref()
                .and_then(|tab_id| state.tabs.iter().find(|tab| tab.browser_tab_id == tab_id))
                .map(|tab| tab.engine_id.clone())
        })
        .or_else(|| {
            state.active_browser_tab_id.as_deref().and_then(|tab_id| {
                state
                    .tabs
                    .iter()
                    .find(|tab| tab.browser_tab_id == tab_id)
                    .map(|tab| tab.engine_id.clone())
            })
        })
        .unwrap_or_else(|| BROWSER_ENGINE_FOREGROUND_ID.to_string())
}

fn engine_waitlist_ref<'a>(
    state: &'a BrowserState,
    engine_id: &str,
) -> Option<&'a BrowserEngineWaitlistSnapshot> {
    state
        .engine_pool
        .engines
        .iter()
        .find(|engine| engine.engine_id == engine_id)
        .map(|engine| &engine.waitlist)
}

fn engine_waitlist_mut<'a>(
    state: &'a mut BrowserState,
    engine_id: &str,
) -> &'a mut BrowserEngineWaitlistSnapshot {
    if let Some(idx) = state
        .engine_pool
        .engines
        .iter()
        .position(|engine| engine.engine_id == engine_id)
    {
        return &mut state.engine_pool.engines[idx].waitlist;
    }
    let webview_label = browser_engine_webview_label(engine_id);
    state.engine_pool.engines.push(BrowserEngineSnapshot {
        engine_id: engine_id.to_string(),
        mounted: false,
        webview_label,
        browser_tab_id: None,
        task_id: None,
        profile_id: None,
        privacy_mode: BrowserAdMode::Balanced,
        url: None,
        pending_url: None,
        title: None,
        load_status: "queued".to_string(),
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
    &mut state
        .engine_pool
        .engines
        .last_mut()
        .expect("engine was just pushed")
        .waitlist
}

fn sync_engine_waitlist_compat_locked(state: &mut BrowserState, engine_id: &str) {
    let waitlist = state
        .engine_pool
        .engines
        .iter()
        .find(|engine| engine.engine_id == engine_id)
        .map(|engine| engine.waitlist.clone());
    let Some(waitlist) = waitlist else {
        return;
    };
    if state.engine.engine_id == engine_id {
        state.engine.waitlist = waitlist.clone();
        state.engine_waitlist = waitlist;
    }
}
