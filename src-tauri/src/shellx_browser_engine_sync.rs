//! Atomic physical/logical Browser engine synchronization.
//!
//! The short admission pause prevents a callback from a navigation target
//! being attributed to the tab which previously owned a reused WebView.

use super::*;

/// Synchronize the physical WebView and record its logical tab assignment as
/// one transaction. Approval replay takes the same lock, so a later tab sync
/// cannot retarget a WebView between the permit-context check and `eval`.
pub(crate) async fn sync_and_record_native_browser_engine(
    app: &AppHandle,
    registry: &Arc<ShellxBrowserRegistry>,
    mut request: BrowserEngineSyncRequest,
) -> Result<crate::shellx_browser::BrowserEngineSnapshot, String> {
    let _engine_sync_guard = registry.engine_sync_lock.lock().await;
    let profile_id = request
        .profile_id
        .as_deref()
        .map(clean_string)
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "agent-work".to_string());
    let event_context = registry
        .engine_event_context_for_sync_request(request.browser_tab_id.as_deref(), &profile_id);
    let engine_id = registry.engine_id_for_sync_request(&request);
    // Existing callback generations remain physically attached while the
    // shared foreground WebView navigates. Pause their native DownloadEvent
    // admission before dispatching the navigation, then restore the previous
    // context on failure or commit the target after record_engine_sync.
    let suspended_context = registry.begin_engine_event_context_sync(&engine_id, &event_context);
    let current_url =
        match sync_native_browser_engine_locked(app, registry, &request, event_context.clone())
            .await
        {
            Ok(current_url) => current_url,
            Err(error) => {
                if let Some((binding, previous)) = suspended_context.as_ref() {
                    registry.abort_engine_event_context_sync(&engine_id, binding, previous.clone());
                }
                return Err(error);
            }
        };
    if let Some(current_url) = current_url {
        request.url = Some(current_url);
    }
    let snapshot = registry.record_engine_sync(request);
    let binding = {
        let state = lock_or_recover(&registry.state);
        state
            .engine_event_bindings
            .get(&snapshot.engine_id)
            .cloned()
    };
    let Some(binding) = binding else {
        if let Some((suspended_binding, previous)) = suspended_context.as_ref() {
            registry.abort_engine_event_context_sync(
                &engine_id,
                suspended_binding,
                previous.clone(),
            );
        }
        return Err(
            "Browser engine callback binding was retired during synchronization".to_string(),
        );
    };
    if !registry.update_current_engine_event_context(&snapshot.engine_id, &binding, event_context) {
        if let Some((suspended_binding, previous)) = suspended_context.as_ref() {
            registry.abort_engine_event_context_sync(
                &engine_id,
                suspended_binding,
                previous.clone(),
            );
        }
        return Err("Browser engine callback binding changed during synchronization".to_string());
    }
    Ok(snapshot)
}
