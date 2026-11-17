use serde_json::json;

use crate::shellx_browser::{
    browser_id, clean_string, lock_or_recover, push_receipt, ShellxBrowserRegistry,
};

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct BrowserEngineEventContext {
    pub(crate) task_id: Option<String>,
    pub(crate) browser_tab_id: Option<String>,
    pub(crate) profile_id: Option<String>,
}

/// The callback binding identifies one physical native WebView. Its current
/// attribution context is updated only by the sync transaction when a shared
/// foreground engine changes tabs; native permits retain their own immutable
/// source context.
#[derive(Clone, Debug)]
pub(crate) struct BrowserEngineEventContexts {
    pub(crate) current: BrowserEngineEventContext,
    /// Native callback admission pauses while an existing WebView is being
    /// reassigned. This prevents a fast response from the target navigation
    /// inheriting the previous tab's context before the sync commits.
    pub(crate) synchronizing: bool,
    /// A physical sync can reject more than one callback. Emit one detached
    /// retry notice instead of attributing or repeating them per tab.
    pub(crate) sync_download_notice_emitted: bool,
}

impl ShellxBrowserRegistry {


    pub(crate) fn begin_engine_event_binding_for_context(
        &self,
        engine_id: &str,
        context: BrowserEngineEventContext,
    ) -> String {
        let engine_id = clean_string(engine_id);
        let binding = browser_id("browser-engine-events");
        let mut state = lock_or_recover(&self.state);
        state
            .engine_event_bindings
            .insert(engine_id.clone(), binding.clone());
        state.engine_event_contexts.insert(
            engine_id,
            BrowserEngineEventContexts {
                current: context,
                synchronizing: false,
                sync_download_notice_emitted: false,
            },
        );
        binding
    }

    pub(crate) fn engine_event_context_for_sync_request(
        &self,
        browser_tab_id: Option<&str>,
        profile_id: &str,
    ) -> BrowserEngineEventContext {
        let browser_tab_id = browser_tab_id
            .map(clean_string)
            .filter(|value| !value.is_empty());
        let profile_id = clean_string(profile_id);
        let state = lock_or_recover(&self.state);
        let tab = browser_tab_id.as_deref().and_then(|browser_tab_id| {
            state
                .tabs
                .iter()
                .find(|tab| tab.browser_tab_id == browser_tab_id)
        });
        BrowserEngineEventContext {
            task_id: tab.and_then(|tab| tab.task_id.clone()),
            browser_tab_id,
            profile_id: (!profile_id.is_empty()).then_some(profile_id),
        }
    }

    pub(crate) fn engine_event_binding_is_current(&self, engine_id: &str, binding: &str) -> bool {
        lock_or_recover(&self.state)
            .engine_event_bindings
            .get(&clean_string(engine_id))
            .is_some_and(|current| current == binding)
    }

    pub(crate) fn bound_engine_event_context(
        &self,
        engine_id: &str,
        binding: &str,
    ) -> Option<BrowserEngineEventContext> {
        let engine_id = clean_string(engine_id);
        let state = lock_or_recover(&self.state);
        state
            .engine_event_bindings
            .get(&engine_id)
            .is_some_and(|current| current == binding)
            .then_some(())
            .and_then(|()| state.engine_event_contexts.get(&engine_id).cloned())
            .filter(|contexts| !contexts.synchronizing)
            .map(|contexts| contexts.current)
    }

    /// Pause admission for an existing callback generation before its native
    /// WebView navigates to another tab. The returned binding/context restore
    /// a failed physical sync without changing attribution.
    pub(crate) fn begin_engine_event_context_sync(
        &self,
        engine_id: &str,
        target: &BrowserEngineEventContext,
    ) -> Option<(String, BrowserEngineEventContext)> {
        let engine_id = clean_string(engine_id);
        let mut state = lock_or_recover(&self.state);
        let binding = state.engine_event_bindings.get(&engine_id)?.clone();
        let contexts = state.engine_event_contexts.get_mut(&engine_id)?;
        if contexts.synchronizing || &contexts.current == target {
            return None;
        }
        contexts.synchronizing = true;
        contexts.sync_download_notice_emitted = false;
        Some((binding, contexts.current.clone()))
    }

    pub(crate) fn engine_event_context_is_synchronizing(
        &self,
        engine_id: &str,
        binding: &str,
    ) -> bool {
        let engine_id = clean_string(engine_id);
        let state = lock_or_recover(&self.state);
        state
            .engine_event_bindings
            .get(&engine_id)
            .is_some_and(|current| current == binding)
            && state
                .engine_event_contexts
                .get(&engine_id)
                .is_some_and(|contexts| contexts.synchronizing)
    }

    /// Record one detached, operator-visible retry receipt for callbacks
    /// rejected during a physical reassignment. It intentionally names
    /// neither the old nor target task/tab.
    pub(crate) fn record_engine_sync_download_rejection_notice(
        &self,
        engine_id: &str,
        binding: &str,
    ) -> bool {
        let engine_id = clean_string(engine_id);
        let mut state = lock_or_recover(&self.state);
        if state
            .engine_event_bindings
            .get(&engine_id)
            .is_none_or(|current| current != binding)
        {
            return false;
        }
        {
            let Some(contexts) = state.engine_event_contexts.get_mut(&engine_id) else {
                return false;
            };
            if !contexts.synchronizing || contexts.sync_download_notice_emitted {
                return false;
            }
            contexts.sync_download_notice_emitted = true;
        }
        push_receipt(
            &mut state,
            "browserNativeDownloadRetryRequired",
            None,
            None,
            "Native Browser download request arrived while the Browser tab changed; retry the download"
                .to_string(),
            json!({
                "reason": "browserTabContextSynchronizing",
                "retryable": true,
            }),
        );
        true
    }

    /// Commit attribution for a physical sync which still owns the callback
    /// generation. This reopens native callback admission only after the
    /// logical engine snapshot has been recorded.
    pub(crate) fn update_current_engine_event_context(
        &self,
        engine_id: &str,
        binding: &str,
        context: BrowserEngineEventContext,
    ) -> bool {
        let engine_id = clean_string(engine_id);
        let mut state = lock_or_recover(&self.state);
        if state
            .engine_event_bindings
            .get(&engine_id)
            .is_none_or(|current| current != binding)
        {
            return false;
        }
        let Some(contexts) = state.engine_event_contexts.get_mut(&engine_id) else {
            return false;
        };
        contexts.current = context;
        contexts.synchronizing = false;
        true
    }

    /// Reopen admission for the same physical generation after a failed sync.
    /// A replaced or retired WebView owns its own fresh context instead.
    pub(crate) fn abort_engine_event_context_sync(
        &self,
        engine_id: &str,
        binding: &str,
        previous: BrowserEngineEventContext,
    ) {
        let engine_id = clean_string(engine_id);
        let mut state = lock_or_recover(&self.state);
        if state
            .engine_event_bindings
            .get(&engine_id)
            .is_none_or(|current| current != binding)
        {
            return;
        }
        if let Some(contexts) = state.engine_event_contexts.get_mut(&engine_id) {
            contexts.current = previous;
            contexts.synchronizing = false;
        }
    }
}
