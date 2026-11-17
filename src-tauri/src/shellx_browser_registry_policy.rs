use super::*;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct BrowserWindowOpenTicket {
    pub(crate) generation: u64,
    pub(crate) previous_window_open: bool,
}

impl ShellxBrowserRegistry {
    pub fn ad_mode_for_profile_id(&self, profile_id: Option<&str>) -> BrowserAdMode {
        let state = lock_or_recover(&self.state);
        ad_mode_for_profile(&state.privacy, profile_id.unwrap_or("agent-work"))
    }

    pub fn effective_ad_mode_for_profile_id(
        &self,
        profile_id: Option<&str>,
        raw_url: Option<&str>,
    ) -> BrowserAdMode {
        let state = lock_or_recover(&self.state);
        effective_ad_mode_for_profile_and_url(
            &state.privacy,
            &state.shields,
            profile_id.unwrap_or("agent-work"),
            raw_url,
        )
    }

    pub fn record_tab_privacy_stats(
        &self,
        browser_tab_id: &str,
        stats: BrowserPrivacyStats,
    ) -> Option<u32> {
        let mut state = lock_or_recover(&self.state);
        let tab = state
            .tabs
            .iter_mut()
            .find(|tab| tab.browser_tab_id == browser_tab_id)?;
        apply_privacy_stats_to_tab(tab, Some(&stats));
        tab.updated_at_ms = now_ms();
        Some(tab.shields.blocked_ad_tracker_count)
    }

    #[cfg(windows)]
    pub(crate) fn record_bound_strict_request_blocked(
        &self,
        engine_id: &str,
        event_binding: &str,
        profile_id: &str,
        method: &str,
        url: String,
        resource_type: String,
    ) -> bool {
        let mut state = lock_or_recover(&self.state);
        let engine_id = clean_string(engine_id);
        if state
            .engine_event_bindings
            .get(&engine_id)
            .map(String::as_str)
            != Some(event_binding)
        {
            return false;
        }
        let engine = state
            .engine_pool
            .engines
            .iter()
            .find(|engine| engine.engine_id == engine_id)
            .or_else(|| (state.engine.engine_id == engine_id).then_some(&state.engine))
            .cloned();
        let Some(engine) = engine else {
            return false;
        };
        let browser_tab_id = engine.browser_tab_id.clone();
        let task_id = engine.task_id.clone();
        let entry = push_network_entry(
            &mut state,
            BrowserNetworkRecordRequest {
                task_id: task_id.clone(),
                browser_tab_id: browser_tab_id.clone(),
                profile_id: Some(profile_id.to_string()),
                method: method.to_string(),
                url: url.clone(),
                resource_type,
                load_status: Some("strictBlocked".to_string()),
                status: Some(204),
                blocked: true,
                ..BrowserNetworkRecordRequest::default()
            },
        );
        if let Some(tab_id) = browser_tab_id.as_deref() {
            if let Some(tab) = state
                .tabs
                .iter_mut()
                .find(|tab| tab.browser_tab_id == tab_id)
            {
                tab.shields.blocked_ad_tracker_count =
                    tab.shields.blocked_ad_tracker_count.saturating_add(1);
                tab.updated_at_ms = now_ms();
            }
        }
        push_receipt(
            &mut state,
            "browserStrictRequestBlocked",
            task_id,
            Some(profile_id.to_string()),
            format!("Browser strict request filter blocked {}", entry.url),
            json!({
                "networkId": entry.network_id,
                "browserTabId": entry.browser_tab_id,
                "method": entry.method,
                "url": entry.url,
                "origin": entry.origin,
                "path": entry.path,
                "resourceType": entry.resource_type,
                "privacyDecision": entry.privacy_decision,
            }),
        );
        true
    }

    pub fn lock_denial_for_action(
        &self,
        request: &BrowserActionRequest,
        action: &str,
    ) -> Result<Option<BrowserActionResponse>, String> {
        let mut state = lock_or_recover(&self.state);
        let target_tab_idx = resolve_action_tab_index(&state, request)?;
        if let Some(tab_idx) = target_tab_idx {
            if let Some(response) =
                crate::shellx_browser_personal_lock::personal_lock_denial_for_request(
                    &mut state, tab_idx, request, action,
                )
            {
                return Ok(Some(response));
            }
            return Ok(tab_lock_denial_for_request(
                &mut state, tab_idx, request, action,
            ));
        }
        Ok(None)
    }

    pub(crate) fn open_window_record(
        &self,
        ticket: BrowserWindowOpenTicket,
        start_url: Option<String>,
    ) -> Result<BrowserWindowOpenResponse, String> {
        let mut state = lock_or_recover(&self.state);
        if state.window_lifecycle_generation != ticket.generation {
            return Err(
                "ShellX Browser window changed while the open operation was in flight".to_string(),
            );
        }
        state.window_open = true;
        state.pending_start_url = start_url.as_ref().map(clean_string);
        state.engine_pool.window_state = "foreground".to_string();
        let pending_start_url = state.pending_start_url.clone();
        let receipt = push_receipt(
            &mut state,
            "browserWindowOpened",
            None,
            None,
            "ShellX Browser window opened".to_string(),
            json!({
                "windowLabel": BROWSER_WINDOW_LABEL,
                "startUrl": pending_start_url,
            }),
        );
        Ok(BrowserWindowOpenResponse {
            ok: true,
            window_label: BROWSER_WINDOW_LABEL.to_string(),
            start_url,
            receipt,
        })
    }

    pub(crate) fn prepare_window_open(&self, start_url: Option<String>) -> BrowserWindowOpenTicket {
        let mut state = lock_or_recover(&self.state);
        let previous_window_open = state.window_open;
        state.window_lifecycle_generation = state.window_lifecycle_generation.saturating_add(1);
        state.pending_start_url = start_url.as_ref().map(clean_string);
        BrowserWindowOpenTicket {
            generation: state.window_lifecycle_generation,
            previous_window_open,
        }
    }

    pub(crate) fn record_window_destroyed(&self) -> Option<BrowserReceipt> {
        let mut state = lock_or_recover(&self.state);
        let mounted_engine_ids = state
            .engine_pool
            .engines
            .iter()
            .filter(|engine| engine.mounted)
            .map(|engine| engine.engine_id.clone())
            .chain(state.engine.mounted.then(|| state.engine.engine_id.clone()))
            .collect::<std::collections::BTreeSet<_>>();
        let mounted_engines = mounted_engine_ids.len();
        let should_record_receipt =
            state.window_open || mounted_engines > 0 || state.pending_start_url.is_some();
        let updated_at_ms = now_ms();
        // Window destruction makes every mounted engine unavailable before its
        // current binding is discarded. Quarantine first so a late Finished
        // callback can acknowledge the exact retained stage without turning a
        // closed tab into a successful download.
        for engine_id in &mounted_engine_ids {
            crate::shellx_browser_transfers::quarantine_native_downloads_for_engine_locked(
                &mut state, engine_id,
            );
        }
        // A native Destroyed event is a lifecycle boundary even when the registry
        // already looked closed. Incrementing unconditionally invalidates an opener
        // that prepared its ticket immediately before the event arrived.
        state.window_lifecycle_generation = state.window_lifecycle_generation.saturating_add(1);
        state.window_open = false;
        state.pending_start_url = None;
        state.engine_event_bindings.clear();
        state.engine_history_visit_admissions.clear();
        state.engine_event_contexts.clear();
        state.engine_pool.window_state = "closed".to_string();
        if mounted_engine_ids.contains(&state.engine.engine_id) {
            state.engine.mounted = false;
            state.engine.pending_url = None;
            state.engine.load_status = "idle".to_string();
            state.engine.visibility_state = BrowserEngineVisibilityState::Hidden;
            state.engine.visual_capture = BrowserEngineVisualCaptureState::Unavailable;
            state.engine.updated_at_ms = updated_at_ms;
        }
        for engine in &mut state.engine_pool.engines {
            if mounted_engine_ids.contains(&engine.engine_id) {
                engine.mounted = false;
                engine.pending_url = None;
                engine.load_status = "idle".to_string();
                engine.visibility_state = BrowserEngineVisibilityState::Hidden;
                engine.visual_capture = BrowserEngineVisualCaptureState::Unavailable;
                engine.updated_at_ms = updated_at_ms;
            }
        }
        for tab in &mut state.tabs {
            if mounted_engine_ids.contains(&tab.engine_id) {
                tab.engine_state = BrowserEngineTabState::Parked;
                tab.updated_at_ms = updated_at_ms;
            }
        }
        if !should_record_receipt {
            return None;
        }
        Some(push_receipt(
            &mut state,
            "browserWindowClosed",
            None,
            None,
            "ShellX Browser window closed".to_string(),
            json!({
                "windowLabel": BROWSER_WINDOW_LABEL,
                "unmountedEngines": mounted_engines,
                "tasksPreserved": true,
            }),
        ))
    }

    pub(crate) fn record_late_window_present(
        &self,
        ticket: BrowserWindowOpenTicket,
        disposition: &str,
        detail: &str,
    ) -> Option<BrowserReceipt> {
        let mut state = lock_or_recover(&self.state);
        if state.window_lifecycle_generation != ticket.generation {
            return None;
        }
        state.window_open = true;
        state.pending_start_url = None;
        state.engine_pool.window_state = "foreground".to_string();
        Some(push_receipt(
            &mut state,
            "browserWindowOpenRecovered",
            None,
            None,
            "ShellX Browser late opener reconciled native window presence".to_string(),
            json!({
                "windowLabel": BROWSER_WINDOW_LABEL,
                "disposition": disposition,
                "detail": detail.chars().take(240).collect::<String>(),
                "startUrlApplied": false,
            }),
        ))
    }

    pub(crate) fn record_window_open_failure(
        &self,
        start_url: Option<String>,
        ticket: Option<BrowserWindowOpenTicket>,
        code: &str,
        message: &str,
        timeout_ms: u64,
        diagnostics: serde_json::Value,
    ) -> BrowserReceipt {
        let mut state = lock_or_recover(&self.state);
        if let Some(ticket) =
            ticket.filter(|ticket| ticket.generation == state.window_lifecycle_generation)
        {
            state.window_open = ticket.previous_window_open;
            state.pending_start_url = None;
            let mounted_covered_personal =
                crate::shellx_browser_personal_lock::personal_content_requires_native_cover(
                    &state.personal_lock,
                    "personal",
                ) && (state.engine_pool.engines.iter().any(|engine| {
                    engine.mounted && engine.profile_id.as_deref() == Some("personal")
                }) || (state.engine.mounted
                    && state.engine.profile_id.as_deref() == Some("personal")));
            if !ticket.previous_window_open
                && code != "browser_window_cover_failed"
                && !mounted_covered_personal
            {
                state.engine = BrowserEngineSnapshot {
                    load_status: "error".to_string(),
                    last_error: Some(message.chars().take(600).collect()),
                    updated_at_ms: now_ms(),
                    ..BrowserEngineSnapshot::default()
                };
                state.engine_pool.engines.clear();
                state.engine_event_bindings.clear();
                state.engine_history_visit_admissions.clear();
                state.engine_event_contexts.clear();
                state.engine_pool.waiting.clear();
                state.engine_pool.parked_tabs.clear();
                state.engine_waitlist = BrowserEngineWaitlistSnapshot::default();
            }
        }
        push_receipt(
            &mut state,
            "browserWindowOpenFailed",
            None,
            None,
            message.chars().take(240).collect(),
            json!({
                "code": code,
                "startUrlProvided": start_url.as_ref().is_some_and(|value| !value.trim().is_empty()),
                "timeoutMs": timeout_ms,
                "diagnostics": diagnostics,
            }),
        )
    }
}
