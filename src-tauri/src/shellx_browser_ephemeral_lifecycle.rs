//! Receipt and cleanup lifecycle for task-disposable WebView storage.

use crate::shellx_browser::{lock_or_recover, now_ms, push_receipt, ShellxBrowserRegistry};
use crate::shellx_browser_ephemeral_roots::{
    browser_ephemeral_storage_parent, remove_owned_ephemeral_root, EphemeralRootBinding,
    EphemeralRootCleanupCandidate, EphemeralScavengeReport, EPHEMERAL_CLEANUP_ATTEMPTS,
};

impl ShellxBrowserRegistry {
    pub(crate) fn disposable_webview_storage_root(
        &self,
        engine_id: &str,
        browser_tab_id: Option<&str>,
    ) -> Result<EphemeralRootBinding, String> {
        let (task_identity, tab_id) = {
            let state = lock_or_recover(&self.state);
            let tab = browser_tab_id
                .and_then(|browser_tab_id| {
                    state
                        .tabs
                        .iter()
                        .find(|tab| tab.browser_tab_id == browser_tab_id)
                })
                .or_else(|| state.tabs.iter().find(|tab| tab.engine_id == engine_id))
                .ok_or_else(|| {
                    "task-disposable WebView storage requires a Browser tab/engine owner"
                        .to_string()
                })?;
            if tab.profile_id != "task-disposable" {
                return Err(
                    "task-disposable storage was requested for a non-disposable tab".to_string(),
                );
            }
            let task_identity = tab
                .task_id
                .clone()
                .unwrap_or_else(|| format!("tab:{}", tab.browser_tab_id));
            if state
                .tasks
                .iter()
                .find(|task| task.task_id == task_identity)
                .is_some_and(|task| {
                    crate::shellx_browser_tasks::browser_task_is_terminal(&task.status)
                })
            {
                return Err(
                    "terminal task-disposable Browser tasks cannot recreate native storage"
                        .to_string(),
                );
            }
            (task_identity, tab.browser_tab_id.clone())
        };
        let parent = browser_ephemeral_storage_parent()?;
        let binding = lock_or_recover(&self.ephemeral_roots).binding_for(
            &parent,
            &task_identity,
            engine_id,
        )?;
        let mut state = lock_or_recover(&self.state);
        if let Some(tab) = state
            .tabs
            .iter_mut()
            .find(|tab| tab.browser_tab_id == tab_id)
        {
            tab.storage_root = Some(format!("ephemeral:{}", binding.owner_identity));
            tab.updated_at_ms = now_ms();
        }
        Ok(binding)
    }

    pub(crate) fn active_disposable_root_owner_for_engine(
        &self,
        engine_id: &str,
    ) -> Option<String> {
        lock_or_recover(&self.ephemeral_roots).active_owner_for_engine(engine_id)
    }

    pub(crate) fn mark_disposable_webview_mounted(
        &self,
        engine_id: &str,
        binding: &EphemeralRootBinding,
    ) -> Result<(), String> {
        lock_or_recover(&self.ephemeral_roots)
            .mark_engine_mounted(engine_id, &binding.owner_identity)
    }

    pub(crate) fn disposable_engine_ids_for_task(&self, task_id: &str) -> Vec<String> {
        lock_or_recover(&self.ephemeral_roots).engine_ids_for_task(task_id)
    }

    pub(crate) fn record_disposable_cleanup_deferred_for_engine(
        &self,
        engine_id: &str,
        detail: impl Into<String>,
    ) {
        let detail = detail.into();
        let candidates =
            lock_or_recover(&self.ephemeral_roots).cleanup_candidates_for_engine(engine_id);
        for candidate in candidates {
            self.record_ephemeral_cleanup_deferred_without_confirmed_close(&candidate, &detail);
        }
    }

    pub(crate) fn record_disposable_cleanup_deferred_for_owner(
        &self,
        owner_identity: &str,
        detail: impl Into<String>,
    ) {
        let detail = detail.into();
        let candidate =
            lock_or_recover(&self.ephemeral_roots).cleanup_candidate_for_owner(owner_identity);
        if let Some(candidate) = candidate {
            self.record_ephemeral_cleanup_deferred_without_confirmed_close(&candidate, &detail);
        }
    }

    pub(crate) fn release_disposable_roots_after_engine_close(
        &self,
        engine_id: &str,
    ) -> Vec<EphemeralRootCleanupCandidate> {
        lock_or_recover(&self.ephemeral_roots).release_closed_engine(engine_id)
    }

    pub(crate) fn release_disposable_root_owner_after_engine_close(
        &self,
        engine_id: &str,
        owner_identity: &str,
    ) -> Option<EphemeralRootCleanupCandidate> {
        lock_or_recover(&self.ephemeral_roots)
            .release_closed_engine_owner(engine_id, owner_identity)
    }

    pub(crate) fn release_unmounted_disposable_root(
        &self,
        binding: &EphemeralRootBinding,
    ) -> Result<EphemeralRootCleanupCandidate, String> {
        lock_or_recover(&self.ephemeral_roots).release_unmounted_binding(binding)
    }

    pub(crate) fn record_disposable_engine_closed(&self, engine_id: &str) {
        let mut state = lock_or_recover(&self.state);
        state.engine_event_bindings.remove(engine_id);
        for engine in &mut state.engine_pool.engines {
            if engine.engine_id == engine_id {
                engine.mounted = false;
                engine.load_status = "closed".to_string();
                engine.updated_at_ms = now_ms();
            }
        }
        if state.engine.engine_id == engine_id {
            state.engine.mounted = false;
            state.engine.load_status = "closed".to_string();
            state.engine.updated_at_ms = now_ms();
        }
        for tab in &mut state.tabs {
            if tab.engine_id == engine_id && tab.profile_id == "task-disposable" {
                tab.engine_state = crate::shellx_browser::BrowserEngineTabState::Parked;
                tab.updated_at_ms = now_ms();
            }
        }
    }

    pub(crate) fn record_ephemeral_scavenge(&self, report: EphemeralScavengeReport) {
        let mut state = lock_or_recover(&self.state);
        push_receipt(
            &mut state,
            "browserEphemeralStorageStartupScavenged",
            None,
            Some("task-disposable".to_string()),
            "Browser ephemeral storage startup scavenging completed".to_string(),
            serde_json::json!({
                "removedRoots": report.removed,
                "deferredRoots": report.deferred,
                "refusedRoots": report.refused,
                "skippedDueToProcessLock": report.skipped_due_to_process_lock,
                "errorCount": report.errors.len(),
            }),
        );
    }

    fn record_ephemeral_cleanup_result(
        &self,
        candidate: &EphemeralRootCleanupCandidate,
        removed: bool,
        detail: Option<String>,
    ) {
        let mut state = lock_or_recover(&self.state);
        let storage_identity = format!("ephemeral:{}", candidate.owner_identity);
        let task_id = state
            .tabs
            .iter()
            .find(|tab| tab.storage_root.as_deref() == Some(storage_identity.as_str()))
            .and_then(|tab| tab.task_id.clone());
        let kind = if removed {
            "browserEphemeralStorageCleaned"
        } else {
            "browserEphemeralStorageCleanupDeferred"
        };
        let summary = if removed {
            "Browser ephemeral storage removed after native WebView close"
        } else {
            "Browser ephemeral storage cleanup deferred after native WebView close"
        };
        push_receipt(
            &mut state,
            kind,
            task_id,
            Some("task-disposable".to_string()),
            summary.to_string(),
            serde_json::json!({
                "ownerIdentity": candidate.owner_identity,
                "deleted": removed,
                "retryOnStartup": !removed,
                "detail": detail,
            }),
        );
    }

    fn record_ephemeral_cleanup_deferred_without_confirmed_close(
        &self,
        candidate: &EphemeralRootCleanupCandidate,
        detail: &str,
    ) {
        let mut state = lock_or_recover(&self.state);
        let storage_identity = format!("ephemeral:{}", candidate.owner_identity);
        let task_id = state
            .tabs
            .iter()
            .find(|tab| tab.storage_root.as_deref() == Some(storage_identity.as_str()))
            .and_then(|tab| tab.task_id.clone());
        push_receipt(
            &mut state,
            "browserEphemeralStorageCleanupDeferred",
            task_id,
            Some("task-disposable".to_string()),
            "Browser ephemeral storage retained until startup because native WebView close/release was not confirmed".to_string(),
            serde_json::json!({
                "ownerIdentity": candidate.owner_identity,
                "deleted": false,
                "retryOnStartup": true,
                "detail": detail,
            }),
        );
    }

    fn record_ephemeral_unmounted_cleanup_result(
        &self,
        candidate: &EphemeralRootCleanupCandidate,
        removed: bool,
        detail: Option<String>,
    ) {
        let mut state = lock_or_recover(&self.state);
        let storage_identity = format!("ephemeral:{}", candidate.owner_identity);
        let task_id = state
            .tabs
            .iter()
            .find(|tab| tab.storage_root.as_deref() == Some(storage_identity.as_str()))
            .and_then(|tab| tab.task_id.clone());
        push_receipt(
            &mut state,
            if removed {
                "browserEphemeralStorageCleaned"
            } else {
                "browserEphemeralStorageCleanupDeferred"
            },
            task_id,
            Some("task-disposable".to_string()),
            if removed {
                "Browser ephemeral storage removed after Browser engine replacement failed before native mount"
            } else {
                "Browser ephemeral storage cleanup deferred after Browser engine replacement failed before native mount"
            }
            .to_string(),
            serde_json::json!({
                "ownerIdentity": candidate.owner_identity,
                "deleted": removed,
                "retryOnStartup": !removed,
                "detail": detail,
            }),
        );
    }
}

pub(crate) async fn cleanup_unmounted_disposable_root_after_replacement_failure(
    registry: &ShellxBrowserRegistry,
    binding: &EphemeralRootBinding,
    detail: &str,
) {
    let fallback_candidate = EphemeralRootCleanupCandidate {
        owner_identity: binding.owner_identity.clone(),
        root: binding.root.clone(),
    };
    let candidate = match registry.release_unmounted_disposable_root(binding) {
        Ok(candidate) => candidate,
        Err(error) => {
            registry.record_ephemeral_unmounted_cleanup_result(
                &fallback_candidate,
                false,
                Some(format!("{detail}; {error}")),
            );
            return;
        }
    };
    let parent = match browser_ephemeral_storage_parent() {
        Ok(parent) => parent,
        Err(error) => {
            registry.record_ephemeral_unmounted_cleanup_result(&candidate, false, Some(error));
            return;
        }
    };
    let mut last_error = None;
    let mut removed = false;
    for attempt in 0..EPHEMERAL_CLEANUP_ATTEMPTS {
        match remove_owned_ephemeral_root(&parent, &candidate) {
            Ok(()) => {
                removed = true;
                break;
            }
            Err(error) => {
                last_error = Some(error);
                if attempt + 1 < EPHEMERAL_CLEANUP_ATTEMPTS {
                    tokio::time::sleep(std::time::Duration::from_millis(75)).await;
                }
            }
        }
    }
    registry.record_ephemeral_unmounted_cleanup_result(&candidate, removed, last_error);
}

pub(crate) async fn cleanup_disposable_roots_after_engine_close(
    registry: &ShellxBrowserRegistry,
    engine_id: &str,
) {
    registry.record_disposable_engine_closed(engine_id);
    let parent = match browser_ephemeral_storage_parent() {
        Ok(parent) => parent,
        Err(error) => {
            for candidate in registry.release_disposable_roots_after_engine_close(engine_id) {
                registry.record_ephemeral_cleanup_result(&candidate, false, Some(error.clone()));
            }
            return;
        }
    };
    for candidate in registry.release_disposable_roots_after_engine_close(engine_id) {
        let mut last_error = None;
        let mut removed = false;
        for attempt in 0..EPHEMERAL_CLEANUP_ATTEMPTS {
            match remove_owned_ephemeral_root(&parent, &candidate) {
                Ok(()) => {
                    removed = true;
                    break;
                }
                Err(error) => {
                    last_error = Some(error);
                    if attempt + 1 < EPHEMERAL_CLEANUP_ATTEMPTS {
                        tokio::time::sleep(std::time::Duration::from_millis(75)).await;
                    }
                }
            }
        }
        registry.record_ephemeral_cleanup_result(&candidate, removed, last_error);
    }
}

pub(crate) async fn cleanup_disposable_root_owner_after_engine_close(
    registry: &ShellxBrowserRegistry,
    engine_id: &str,
    owner_identity: &str,
) {
    registry.record_disposable_engine_closed(engine_id);
    let Some(candidate) =
        registry.release_disposable_root_owner_after_engine_close(engine_id, owner_identity)
    else {
        return;
    };
    let parent = match browser_ephemeral_storage_parent() {
        Ok(parent) => parent,
        Err(error) => {
            registry.record_ephemeral_cleanup_result(&candidate, false, Some(error));
            return;
        }
    };
    let mut last_error = None;
    let mut removed = false;
    for attempt in 0..EPHEMERAL_CLEANUP_ATTEMPTS {
        match remove_owned_ephemeral_root(&parent, &candidate) {
            Ok(()) => {
                removed = true;
                break;
            }
            Err(error) => {
                last_error = Some(error);
                if attempt + 1 < EPHEMERAL_CLEANUP_ATTEMPTS {
                    tokio::time::sleep(std::time::Duration::from_millis(75)).await;
                }
            }
        }
    }
    registry.record_ephemeral_cleanup_result(&candidate, removed, last_error);
}

pub(crate) async fn close_disposable_task_webviews_and_cleanup(
    app: &tauri::AppHandle,
    registry: &ShellxBrowserRegistry,
    task_id: &str,
) -> Result<(), String> {
    let mut close_errors = Vec::new();
    for engine_id in registry.disposable_engine_ids_for_task(task_id) {
        match crate::shellx_browser::close_browser_engine_webview(app, &engine_id).await {
            Ok(()) => cleanup_disposable_roots_after_engine_close(registry, &engine_id).await,
            Err(error) => {
                registry.record_disposable_cleanup_deferred_for_engine(
                    &engine_id,
                    format!(
                        "task terminal cleanup retained the lease because native WebView close/release failed: {error}"
                    ),
                );
                close_errors.push(format!("{engine_id}: {error}"));
            }
        }
    }
    if !close_errors.is_empty() {
        return Err(format!(
            "failed to close task-disposable Browser WebViews: {}",
            close_errors.join("; ")
        ));
    }
    Ok(())
}
