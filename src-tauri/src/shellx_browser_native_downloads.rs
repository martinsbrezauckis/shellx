use std::sync::Arc;

use url::Url;

use crate::shellx_browser::{
    clean_string, lock_or_recover, BrowserState, BrowserTransferApproval, ShellxBrowserRegistry,
};
use crate::shellx_browser_transfer_artifacts::{
    discard_native_browser_download_stage, prepare_native_browser_download_stage,
    BrowserNativeDownloadStage,
};
use crate::shellx_browser_transfer_privacy::browser_download_destination_dir;

#[path = "shellx_browser_native_download_cancellation_ack.rs"]
mod cancellation_ack;
#[cfg(not(target_os = "linux"))]
pub(crate) use cancellation_ack::BrowserNativeDownloadCancellationAcknowledgement;
pub(crate) use cancellation_ack::NativeDownloadCancellationAcks;

#[derive(Clone, Debug)]
pub(crate) struct BrowserNativeDownloadPermit {
    pub(crate) engine_id: String,
    pub(crate) event_binding: String,
    pub(crate) source_url: String,
    /// Immutable attribution from the current engine callback. These values
    /// bind pre-execution approval or decline to the originating context even
    /// if a later navigation retires that callback binding.
    pub(crate) task_id: Option<String>,
    pub(crate) browser_tab_id: Option<String>,
    pub(crate) approval_id: Option<String>,
    pub(crate) status: NativeDownloadPermitStatus,
    pub(crate) destination_dir: Option<String>,
    pub(crate) display_name: Option<String>,
    pub(crate) stage: Option<Arc<BrowserNativeDownloadStage>>,
    /// Set exactly when a Finished callback owns finalization. A teardown may
    /// mark the transfer cleanup-pending, but must not discard this stage while
    /// the callback can still read it or holds the protected final descriptor.
    pub(crate) finalization_claimed: bool,
    /// Prevent concurrent close/error paths from deleting the same stage.
    pub(crate) cleanup_in_progress: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum NativeDownloadPermitStatus {
    Requested,
    Approved,
    InProgress,
    Finalizing,
    CleanupPending,
}

#[derive(Clone, Debug)]
pub(crate) struct BrowserNativeDownloadResume {
    pub(crate) transfer_id: String,
    pub(crate) approval_id: String,
    pub(crate) engine_id: String,
    pub(crate) event_binding: String,
    pub(crate) source_url: String,
}

pub(crate) enum BrowserNativeDownloadRequested {
    Start {
        destination: std::path::PathBuf,
        context: crate::shellx_browser_engine_state::BrowserEngineEventContext,
    },
    RecordIntent {
        display_name: Option<String>,
    },
    Reject,
}

/// The native callback exposes a URL and destination only. ShellX must not
/// claim to know whether the browser's original request was GET, POST, or
/// another method. A later approval can only navigate to an HTTP(S) URL.
pub(crate) fn native_download_replay_failure_reason(source_url: &str) -> Option<String> {
    let parsed = match Url::parse(source_url) {
        Ok(parsed) => parsed,
        Err(_) => {
            return Some(
                "native Browser download cannot be resumed because its callback URL is invalid"
                    .to_string(),
            )
        }
    };
    if matches!(parsed.scheme(), "http" | "https") && parsed.host_str().is_some() {
        None
    } else {
        Some(
            "native Browser download cannot be resumed because its callback URL is not HTTP or HTTPS"
                .to_string(),
        )
    }
}

pub(crate) const NATIVE_DOWNLOAD_REPLAY_TIMEOUT_DETAIL: &str =
    "native Browser download did not re-enter the callback after URL-addressable replay; the original request may have required POST, form state, or an unsupported URL";

impl ShellxBrowserRegistry {
    pub(crate) fn native_download_resume_matches_current_engine_context(
        &self,
        resume: &BrowserNativeDownloadResume,
    ) -> bool {
        let state = lock_or_recover(&self.state);
        state
            .native_download_permits
            .get(&resume.transfer_id)
            .is_some_and(|permit| {
                permit.engine_id == resume.engine_id
                    && permit.event_binding == resume.event_binding
                    && permit.source_url == resume.source_url
                    && permit.approval_id.as_deref() == Some(resume.approval_id.as_str())
                    && native_download_permit_matches_current_engine_context_locked(&state, permit)
            })
    }

    pub(crate) fn activate_native_download_approval(
        &self,
        approval: &BrowserTransferApproval,
    ) -> Result<Option<BrowserNativeDownloadResume>, String> {
        if approval.direction != "download" {
            return Ok(None);
        }
        let state = lock_or_recover(&self.state);
        let Some(permit) = state
            .native_download_permits
            .get(&approval.transfer_id)
            .cloned()
        else {
            return Ok(None);
        };
        if permit.status != NativeDownloadPermitStatus::Approved
            || permit.approval_id.as_deref() != Some(approval.approval_id.as_str())
        {
            return Err("native Browser download approval is no longer current".to_string());
        }
        if !native_download_permit_matches_current_engine_context_locked(&state, &permit) {
            // This helper is also used below the Tauri command boundary. Do not
            // leave an approved permit occupying admission capacity when its
            // binding was retired between operator approval and replay. Check
            // it before cancellation capacity so a stale target cannot remain
            // approved merely because unrelated acknowledgement state overflowed.
            drop(state);
            let detail =
                "native Browser download target changed before the approved download could resume";
            self.fail_native_download_resume_if_still_approved_with_detail(
                &approval.transfer_id,
                &approval.approval_id,
                detail,
            );
            return Err(detail.to_string());
        }
        state
            .native_download_cancellation_acks
            .require_safe_for_approval()?;
        if let Some(reason) = native_download_replay_failure_reason(&permit.source_url) {
            drop(state);
            self.fail_native_download_resume(&approval.transfer_id, &reason);
            // The operator action itself is valid. Return normally so the
            // Browser renderer refreshes and shows the terminal failed row.
            return Ok(None);
        }
        let pending_cancellation_acknowledgement = state
            .native_download_cancellation_acks
            .has_pending(&permit.engine_id, &permit.event_binding, &permit.source_url);
        let entry = state
            .downloads
            .iter()
            .find(|entry| entry.transfer_id == approval.transfer_id)
            .ok_or_else(|| "native Browser download transfer no longer exists".to_string())?;
        if entry.status != "approved"
            || !entry.requires_approval
            || entry.approval_id.as_deref() != Some(approval.approval_id.as_str())
        {
            return Err("native Browser download approval is no longer current".to_string());
        }
        let resume = BrowserNativeDownloadResume {
            transfer_id: approval.transfer_id.clone(),
            approval_id: approval.approval_id.clone(),
            engine_id: permit.engine_id,
            event_binding: permit.event_binding,
            source_url: permit.source_url,
        };
        if pending_cancellation_acknowledgement {
            Ok(None)
        } else {
            Ok(Some(resume))
        }
    }

    pub(crate) fn native_download_requested(
        &self,
        engine_id: &str,
        event_binding: &str,
        source_url: &str,
        suggested_display_name: Option<&str>,
    ) -> BrowserNativeDownloadRequested {
        if !self.engine_event_binding_is_current(engine_id, event_binding)
            || self.engine_event_context_is_synchronizing(engine_id, event_binding)
        {
            return BrowserNativeDownloadRequested::Reject;
        }
        let candidate = {
            #[cfg(not(target_os = "linux"))]
            let mut state = lock_or_recover(&self.state);
            #[cfg(target_os = "linux")]
            let state = lock_or_recover(&self.state);
            let Some((transfer_id, permit)) = state
                .native_download_permits
                .iter()
                .find(|(_, permit)| {
                    permit.engine_id == engine_id
                        && permit.event_binding == event_binding
                        && permit.source_url == source_url
                        && native_download_permit_matches_current_engine_context_locked(
                            &state, permit,
                        )
                })
                .map(|(transfer_id, permit)| (transfer_id.clone(), permit.clone()))
            else {
                let conflicting_active_permit =
                    state.native_download_permits.values().any(|permit| {
                        permit.engine_id == engine_id
                            && permit.event_binding == event_binding
                            && permit.source_url == source_url
                            && permit.status != NativeDownloadPermitStatus::Requested
                    });
                #[cfg(not(target_os = "linux"))]
                state
                    .native_download_cancellation_acks
                    .record_rejected_request(engine_id, event_binding, source_url);
                if conflicting_active_permit {
                    return BrowserNativeDownloadRequested::Reject;
                }
                return BrowserNativeDownloadRequested::RecordIntent {
                    display_name: suggested_display_name
                        .map(clean_string)
                        .filter(|value| !value.is_empty()),
                };
            };
            if permit.status != NativeDownloadPermitStatus::Approved
                || !native_download_permit_matches_current_engine_context_locked(&state, &permit)
                || state.native_download_cancellation_acks.has_pending(
                    engine_id,
                    event_binding,
                    source_url,
                )
            {
                #[cfg(not(target_os = "linux"))]
                state
                    .native_download_cancellation_acks
                    .record_rejected_request(engine_id, event_binding, source_url);
                return BrowserNativeDownloadRequested::Reject;
            }
            let Some(entry) = state
                .downloads
                .iter()
                .find(|entry| entry.transfer_id == transfer_id)
            else {
                #[cfg(not(target_os = "linux"))]
                state
                    .native_download_cancellation_acks
                    .record_rejected_request(engine_id, event_binding, source_url);
                return BrowserNativeDownloadRequested::Reject;
            };
            if entry.status != "approved" || !entry.requires_approval {
                #[cfg(not(target_os = "linux"))]
                state
                    .native_download_cancellation_acks
                    .record_rejected_request(engine_id, event_binding, source_url);
                return BrowserNativeDownloadRequested::Reject;
            }
            (transfer_id, state.download_folder.clone())
        };
        let (transfer_id, destination_dir) = candidate;
        if let Err(error) = native_download_destination_is_available(destination_dir.as_deref()) {
            self.fail_native_download_resume(&transfer_id, &error);
            self.record_rejected_native_download_cancellation(engine_id, event_binding, source_url);
            return BrowserNativeDownloadRequested::Reject;
        }
        let stage = match prepare_native_browser_download_stage() {
            Ok(stage) => Arc::new(stage),
            Err(error) => {
                self.fail_native_download_resume(&transfer_id, &error);
                self.record_rejected_native_download_cancellation(
                    engine_id,
                    event_binding,
                    source_url,
                );
                return BrowserNativeDownloadRequested::Reject;
            }
        };
        let start = (|| -> Result<
            (
                std::path::PathBuf,
                crate::shellx_browser_engine_state::BrowserEngineEventContext,
            ),
            String,
        > {
            let mut state = lock_or_recover(&self.state);
            let permit = state
                .native_download_permits
                .get(&transfer_id)
                .cloned()
                .ok_or_else(|| {
                    "native Browser download permit was removed before execution".to_string()
                })?;
            if permit.status != NativeDownloadPermitStatus::Approved
                || permit.engine_id != engine_id
                || permit.event_binding != event_binding
                || permit.source_url != source_url
                || !native_download_permit_matches_current_engine_context_locked(&state, &permit)
            {
                return Err("native Browser download approval is no longer current".to_string());
            }
            state
                .native_download_cancellation_acks
                .require_safe_for_approval()?;
            if state.native_download_cancellation_acks.has_pending(
                engine_id,
                event_binding,
                source_url,
            ) {
                return Err(
                    "native Browser download is still awaiting cancellation acknowledgement"
                        .to_string(),
                );
            }
            let approval_id = permit.approval_id.as_deref().ok_or_else(|| {
                "native Browser download approval was removed before execution".to_string()
            })?;
            let entry = state
                .downloads
                .iter()
                .find(|entry| entry.transfer_id == transfer_id)
                .ok_or_else(|| "native Browser download transfer no longer exists".to_string())?;
            if entry.status != "approved" || !entry.requires_approval {
                return Err("native Browser download is no longer awaiting execution".to_string());
            }
            let source_context = crate::shellx_browser_engine_state::BrowserEngineEventContext {
                task_id: permit.task_id.clone(),
                browser_tab_id: permit.browser_tab_id.clone(),
                profile_id: crate::shellx_browser::profile_id_for_task_or_tab(
                    &state,
                    permit.task_id.as_deref(),
                    permit.browser_tab_id.as_deref(),
                ),
            };
            // This is the linearization point for a native approval. Once Wry
            // is handed its private stage, a later TTL expiry cannot invalidate
            // the already-admitted download.
            super::transfer_completion::consume_native_download_approval_at_start(
                &mut state,
                approval_id,
                &transfer_id,
            )?;
            let entry = state
                .downloads
                .iter_mut()
                .find(|entry| entry.transfer_id == transfer_id)
                .expect("native Browser transfer was checked while holding the state lock");
            entry.status = "inProgress".to_string();
            entry.reason = "Native download started after operator approval".to_string();
            entry.destination = Some("native-webview".to_string());
            let permit = state
                .native_download_permits
                .get_mut(&transfer_id)
                .expect("native Browser permit was checked while holding the state lock");
            permit.status = NativeDownloadPermitStatus::InProgress;
            permit.destination_dir = destination_dir;
            permit.stage = Some(Arc::clone(&stage));
            Ok((stage.path().to_path_buf(), source_context))
        })();
        match start {
            Ok((destination, context)) => BrowserNativeDownloadRequested::Start {
                destination,
                context,
            },
            Err(error) => {
                // Wry was not given this stage when the reservation failed.
                // Discard it directly rather than leaving an unreachable leaf.
                let _ = discard_native_browser_download_stage(&stage);
                self.fail_native_download_resume(&transfer_id, &error);
                self.record_rejected_native_download_cancellation(
                    engine_id,
                    event_binding,
                    source_url,
                );
                BrowserNativeDownloadRequested::Reject
            }
        }
    }

    fn record_rejected_native_download_cancellation(
        &self,
        engine_id: &str,
        event_binding: &str,
        source_url: &str,
    ) {
        #[cfg(not(target_os = "linux"))]
        {
            let mut state = lock_or_recover(&self.state);
            state
                .native_download_cancellation_acks
                .record_rejected_request(engine_id, event_binding, source_url);
        }
        #[cfg(target_os = "linux")]
        {
            let _ = (engine_id, event_binding, source_url);
        }
    }
}

/// A physical WebView binding remains stable while the shared foreground
/// engine moves between tabs. A permit is executable only while both the
/// mutable engine snapshot and the binding's current context still identify
/// its original task/tab.
pub(crate) fn native_download_permit_matches_current_engine_context_locked(
    state: &BrowserState,
    permit: &BrowserNativeDownloadPermit,
) -> bool {
    if state
        .engine_event_bindings
        .get(&permit.engine_id)
        .is_none_or(|binding| binding != &permit.event_binding)
    {
        return false;
    }
    let Some(contexts) = state.engine_event_contexts.get(&permit.engine_id) else {
        return false;
    };
    if contexts.synchronizing {
        return false;
    }
    if contexts.current.task_id != permit.task_id
        || contexts.current.browser_tab_id != permit.browser_tab_id
    {
        return false;
    }
    let engine = state
        .engine_pool
        .engines
        .iter()
        .find(|engine| engine.engine_id == permit.engine_id)
        .or_else(|| (state.engine.engine_id == permit.engine_id).then_some(&state.engine));
    engine.is_some_and(|engine| {
        engine.task_id == permit.task_id && engine.browser_tab_id == permit.browser_tab_id
    })
}

#[path = "shellx_browser_native_download_lifecycle.rs"]
mod native_download_lifecycle;
pub(crate) use native_download_lifecycle::quarantine_native_downloads_for_engine_locked;


fn native_download_destination_is_available(
    configured_destination: Option<&str>,
) -> Result<(), String> {
    let requested_dir = browser_download_destination_dir(configured_destination)?;
    let metadata = std::fs::symlink_metadata(&requested_dir).map_err(|error| {
        format!(
            "native Browser download destination {} is unavailable: {}",
            requested_dir.display(),
            error
        )
    })?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(format!(
            "native Browser download destination must be an existing non-link directory: {}",
            requested_dir.display()
        ));
    }
    Ok(())
}
