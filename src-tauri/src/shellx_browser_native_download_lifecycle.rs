//! Completion, quarantine, and cleanup transitions for native Browser downloads.
//!
//! This is separate from approval admission so the lifecycle state machine and
//! its private stage ownership stay cohesive without exhausting the Browser
//! source-size budget.

use std::sync::Arc;

use serde_json::json;

use crate::shellx_browser::{
    clean_string, lock_or_recover, now_ms, profile_id_for_task_or_tab, push_receipt, BrowserState,
    BrowserTransferCompleteRequest, ShellxBrowserRegistry,
};
use crate::shellx_browser_transfer_artifacts::{
    complete_native_browser_download_stage, discard_native_browser_download_stage,
    discard_protected_native_browser_download_artifact, finalize_native_browser_download_stage,
    record_native_browser_download_final_cleanup_pending, BrowserNativeDownloadFinalizationError,
    BrowserNativeDownloadStage,
};

use super::{NativeDownloadPermitStatus, NATIVE_DOWNLOAD_REPLAY_TIMEOUT_DETAIL};

#[path = "shellx_browser_native_download_lifecycle_state.rs"]
mod lifecycle_state;
pub(crate) use lifecycle_state::quarantine_native_downloads_for_engine_locked;
use lifecycle_state::{
    mark_native_download_cleanup_pending, mark_native_download_failed,
    mark_native_download_final_artifact_cleanup_pending,
    mark_native_download_retained_final_cleanup_pending,
};

#[cfg(target_os = "windows")]
#[path = "shellx_browser_native_download_windows_observation.rs"]
mod windows_observation;
#[cfg(target_os = "windows")]
use windows_observation::windows_native_download_adapter_observation_json;

impl ShellxBrowserRegistry {
    pub(crate) fn complete_native_download_event(
        &self,
        engine_id: &str,
        event_binding: &str,
        source_url: &str,
        reported_path: Option<&std::path::Path>,
        success: bool,
    ) {
        // A Windows `Finished(false)` means only that WebView2 is not
        // currently IN_PROGRESS. Its controller can resume an interrupted
        // transfer (for example after a range or hash interruption), so that
        // callback is not authority to unlink a stage which the controller
        // may still write. Other platform callbacks have the terminal
        // semantics documented by their adapters.
        let callback_establishes_quiescence =
            native_download_finished_callback_establishes_quiescence(success);
        self.record_native_download_terminal_observation(
            engine_id,
            event_binding,
            source_url,
            reported_path,
            success,
            callback_establishes_quiescence,
        );
        let cleanup_pending = callback_establishes_quiescence
            .then(|| {
                let mut state = lock_or_recover(&self.state);
                let transfer_id = state
                    .native_download_permits
                    .iter()
                    .find(|(_, permit)| {
                        permit.status == NativeDownloadPermitStatus::CleanupPending
                            && !permit.finalization_claimed
                            && !permit.cleanup_in_progress
                            && permit.engine_id == engine_id
                            && permit.event_binding == event_binding
                            && permit.source_url == source_url
                            && match permit.stage.as_ref() {
                                Some(stage) => native_download_completion_path_matches_stage(
                                    reported_path,
                                    stage.path(),
                                ),
                                None => reported_path.is_none(),
                            }
                    })
                    .map(|(transfer_id, _)| transfer_id.clone());
                transfer_id.and_then(|transfer_id| {
                    let permit = state.native_download_permits.get_mut(&transfer_id)?;
                    permit.cleanup_in_progress = true;
                    Some((transfer_id, permit.stage.clone()))
                })
            })
            .flatten();
        if let Some((transfer_id, stage)) = cleanup_pending {
            // This is a terminal acknowledgement for a transfer already
            // quarantined by tab/engine teardown. Never turn it back into a
            // successful download or materialize its stage after closure.
            match stage {
                Some(stage) => self.finish_native_download_stage_cleanup(
                    &transfer_id,
                    &stage,
                    "native Browser engine closed before the download completed",
                ),
                None => self.finish_native_download_stage_cleanup_without_stage(
                    &transfer_id,
                    "native Browser engine closed before the download completed",
                ),
            }
            return;
        }
        // Claim the Finished callback before touching the stage or destination.
        // A concurrent teardown sees Finalizing and can require rollback, but
        // cannot discard a stage that this callback may still be reading.
        let Some((transfer_id, approval_id, destination_dir, display_name, stage)) = (|| {
            let mut state = lock_or_recover(&self.state);
            let transfer_id = state
                .native_download_permits
                .iter()
                .find(|(_, permit)| {
                    permit.status == NativeDownloadPermitStatus::InProgress
                        && permit.engine_id == engine_id
                        && permit.event_binding == event_binding
                        && permit.source_url == source_url
                        && permit.stage.as_ref().is_some_and(|stage| {
                            native_download_completion_path_matches_stage(
                                reported_path,
                                stage.path(),
                            )
                        })
                })
                .map(|(transfer_id, _)| transfer_id.clone())?;
            let permit = state.native_download_permits.get_mut(&transfer_id)?;
            permit.status = NativeDownloadPermitStatus::Finalizing;
            permit.finalization_claimed = true;
            Some((
                transfer_id,
                permit.approval_id.clone()?,
                permit.destination_dir.clone(),
                permit.display_name.clone(),
                permit.stage.clone()?,
            ))
        })() else {
            return;
        };
        if !success {
            if !callback_establishes_quiescence {
                self.retain_native_download_after_nonquiescent_interruption(&transfer_id);
                return;
            }
            self.fail_native_download_after_finished_claim(
                &transfer_id,
                "native Browser download failed",
            );
            return;
        }
        if !native_download_completion_path_matches_stage(reported_path, stage.path()) {
            self.fail_native_download_after_finished_claim(
                &transfer_id,
                "native Browser download finished without the expected private staging path",
            );
            return;
        }
        let protected_artifact = match finalize_native_browser_download_stage(
            &stage,
            destination_dir.as_deref(),
            display_name.as_deref(),
        ) {
            Ok(artifact) => artifact,
            Err(BrowserNativeDownloadFinalizationError::Failed(error)) => {
                self.fail_native_download_after_finished_claim(&transfer_id, &error);
                return;
            }
            Err(BrowserNativeDownloadFinalizationError::RetainedFinal {
                detail,
                final_path,
                bytes,
                sha256,
            }) => {
                self.finish_native_download_finalization_with_retained_final(
                    &transfer_id,
                    &detail,
                    &final_path,
                    bytes,
                    sha256.as_deref(),
                );
                return;
            }
        };
        let artifact = protected_artifact.artifact();
        let final_artifact_identity = (
            artifact.final_path.clone(),
            artifact.bytes,
            artifact.sha256.clone(),
        );
        let final_artifact_record = artifact.clone();
        let completion = self.complete_claimed_native_download_from_protected_artifact(
            BrowserTransferCompleteRequest {
                transfer_id: transfer_id.clone(),
                final_path: Some(artifact.final_path.clone()),
                mime_type: artifact.mime_type.clone(),
                bytes: Some(artifact.bytes),
                sha256: Some(artifact.sha256.clone()),
                source_url: Some(source_url.to_string()),
                destination: Some("native-webview".to_string()),
                retention_reason: Some("nativeBrowserDownload".to_string()),
                approval_id: Some(approval_id),
            },
            &protected_artifact,
        );
        match completion {
            Ok(_) => {
                // The transfer receipt is committed. Remove only its private
                // retention marker; a failure leaves bounded maintenance
                // evidence rather than affecting the completed artifact.
                if complete_native_browser_download_stage(&stage).is_err() {
                    self.record_native_download_marker_cleanup_needed(
                        &transfer_id,
                        &final_artifact_record,
                    );
                }
            }
            Err(error) => {
                let rollback_error =
                    discard_protected_native_browser_download_artifact(protected_artifact).err();
                if let Some(rollback_error) = rollback_error.as_deref() {
                    let _ = record_native_browser_download_final_cleanup_pending(
                        &stage,
                        &final_artifact_record.final_path,
                        Some(final_artifact_record.bytes),
                        Some(&final_artifact_record.sha256),
                    );
                    self.finish_native_download_claimed_completion_failure(
                        &transfer_id,
                        &error,
                        Some(rollback_error),
                        Some(&final_artifact_identity),
                    );
                    return;
                }

                // Windows removed the exact CREATE_NEW destination through its
                // retained handle. The staged file was already removed after
                // copy, so clear only the private marker through its retained
                // parent; never reopen a final path for this cleanup.
                let marker_cleanup_failed = complete_native_browser_download_stage(&stage).is_err();
                self.finish_native_download_claimed_completion_failure(
                    &transfer_id,
                    &error,
                    None,
                    Some(&final_artifact_identity),
                );
                if marker_cleanup_failed {
                    self.record_native_download_marker_cleanup_needed(
                        &transfer_id,
                        &final_artifact_record,
                    );
                }
            }
        }
    }

    pub(crate) fn fail_native_download_resume(&self, transfer_id: &str, detail: &str) {
        let transfer_id = clean_string(transfer_id);
        let detail = clean_string(detail).chars().take(240).collect::<String>();
        let stage = {
            let mut state = lock_or_recover(&self.state);
            let Some(permit) = state.native_download_permits.get_mut(&transfer_id) else {
                return;
            };
            if permit.status == NativeDownloadPermitStatus::Finalizing
                && permit.finalization_claimed
            {
                // A claimed callback owns its stage/final descriptor. Teardown
                // records the interruption but must let that callback observe
                // the claim before any destructive cleanup.
                permit.status = NativeDownloadPermitStatus::CleanupPending;
                mark_native_download_cleanup_pending(&mut state, &transfer_id);
                return;
            }
            if permit.status == NativeDownloadPermitStatus::InProgress {
                // The pathname has already been handed to Wry. Only an engine
                // close/release can prove no native writer still has it open.
                permit.status = NativeDownloadPermitStatus::CleanupPending;
                permit.finalization_claimed = false;
                mark_native_download_cleanup_pending(&mut state, &transfer_id);
                return;
            }
            if permit.cleanup_in_progress {
                return;
            }
            permit.status = NativeDownloadPermitStatus::CleanupPending;
            permit.finalization_claimed = false;
            permit.cleanup_in_progress = true;
            let stage = permit.stage.clone();
            mark_native_download_cleanup_pending(&mut state, &transfer_id);
            stage
        };
        match stage {
            Some(stage) => self.finish_native_download_stage_cleanup(&transfer_id, &stage, &detail),
            None => self.finish_native_download_stage_cleanup_without_stage(&transfer_id, &detail),
        }
    }

    fn fail_native_download_after_finished_claim(&self, transfer_id: &str, detail: &str) {
        {
            let mut state = lock_or_recover(&self.state);
            let Some(permit) = state.native_download_permits.get_mut(transfer_id) else {
                return;
            };
            // This callback has finished using the stage without producing a
            // protected final artifact, so it may hand cleanup to the normal
            // exact-stage cleanup path.
            permit.status = NativeDownloadPermitStatus::CleanupPending;
            permit.finalization_claimed = false;
        }
        self.fail_native_download_resume(transfer_id, detail);
    }

    /// Preserve an admitted Windows download after WebView2 reports an
    /// interruption. The consumed approval remains bound to this exact permit;
    /// a later successful callback can claim it again, while engine teardown
    /// still quarantines and cleans the stage after controller closure.
    pub(super) fn retain_native_download_after_nonquiescent_interruption(&self, transfer_id: &str) {
        const DETAIL: &str = "Native Browser download was interrupted; awaiting native controller completion or closure";
        let mut state = lock_or_recover(&self.state);
        let Some(permit) = state.native_download_permits.get_mut(transfer_id) else {
            return;
        };
        match (permit.status, permit.finalization_claimed) {
            (NativeDownloadPermitStatus::Finalizing, true) => {
                permit.status = NativeDownloadPermitStatus::InProgress;
                permit.finalization_claimed = false;
                permit.cleanup_in_progress = false;
            }
            (NativeDownloadPermitStatus::CleanupPending, true) => {
                // Teardown won after this callback claimed finalization. The
                // callback has now stopped using the stage, but it must not
                // revive an engine-closing transfer. Leave cleanup pending;
                // only an acknowledged controller close may reclaim it.
                permit.finalization_claimed = false;
                return;
            }
            _ => return,
        }

        let Some(existing) = state
            .downloads
            .iter()
            .find(|entry| entry.transfer_id == transfer_id)
            .cloned()
        else {
            return;
        };
        // Multiple state-change callbacks can report the same interruption.
        // Retain one receipt per active transfer rather than letting a native
        // controller consume the bounded receipt history.
        if existing.reason == DETAIL {
            return;
        }
        let profile_id = profile_id_for_task_or_tab(
            &state,
            existing.task_id.as_deref(),
            existing.browser_tab_id.as_deref(),
        );
        let receipt = push_receipt(
            &mut state,
            "browserNativeDownloadInterrupted",
            existing.task_id.clone(),
            profile_id,
            DETAIL.to_string(),
            json!({
                "transferId": existing.transfer_id,
                "browserTabId": existing.browser_tab_id,
                "state": "inProgress",
                "nativeControllerMayResume": true,
            }),
        );
        if let Some(entry) = state
            .downloads
            .iter_mut()
            .find(|entry| entry.transfer_id == transfer_id)
        {
            entry.reason = DETAIL.to_string();
            entry.receipt = receipt;
        }
    }

    /// Record that the platform delivered a terminal callback without
    /// retaining the callback URL, local path, or response content. This lets
    /// installed qualification distinguish a callback that never reached
    /// ShellX from a callback that reached ShellX but could not claim a permit.
    fn record_native_download_terminal_observation(
        &self,
        engine_id: &str,
        event_binding: &str,
        source_url: &str,
        reported_path: Option<&std::path::Path>,
        success: bool,
        callback_establishes_quiescence: bool,
    ) {
        let mut state = lock_or_recover(&self.state);
        let matching_permit = state
            .native_download_permits
            .iter()
            .find(|(_, permit)| {
                permit.engine_id == engine_id
                    && permit.event_binding == event_binding
                    && permit.source_url == source_url
            })
            .map(|(transfer_id, permit)| {
                let stage_path_matched = permit.stage.as_ref().is_some_and(|stage| {
                    native_download_completion_path_matches_stage(reported_path, stage.path())
                });
                let completion_matched = match permit.status {
                    NativeDownloadPermitStatus::InProgress => stage_path_matched,
                    NativeDownloadPermitStatus::CleanupPending => {
                        callback_establishes_quiescence
                            && !permit.finalization_claimed
                            && !permit.cleanup_in_progress
                            && match permit.stage.as_ref() {
                                Some(_) => stage_path_matched,
                                None => reported_path.is_none(),
                            }
                    }
                    NativeDownloadPermitStatus::Requested
                    | NativeDownloadPermitStatus::Approved
                    | NativeDownloadPermitStatus::Finalizing => false,
                };
                let reason = if completion_matched {
                    match permit.status {
                        NativeDownloadPermitStatus::InProgress => "inProgressExactPrivateStage",
                        NativeDownloadPermitStatus::CleanupPending => {
                            "cleanupPendingExactPrivateStage"
                        }
                        NativeDownloadPermitStatus::Requested
                        | NativeDownloadPermitStatus::Approved
                        | NativeDownloadPermitStatus::Finalizing => {
                            unreachable!("only terminal-eligible statuses can match")
                        }
                    }
                } else if permit.stage.is_none() {
                    "permitHasNoPrivateStage"
                } else if reported_path.is_none() {
                    "reportedStagePathMissing"
                } else if !stage_path_matched {
                    "reportedStagePathMismatch"
                } else if permit.status == NativeDownloadPermitStatus::CleanupPending
                    && !callback_establishes_quiescence
                {
                    "cleanupPendingRequiresQuiescentTerminal"
                } else {
                    "permitNotAwaitingTerminalCallback"
                };
                (
                    Some(transfer_id.clone()),
                    permit.task_id.clone(),
                    permit.browser_tab_id.clone(),
                    Some(native_download_permit_status_name(permit.status)),
                    stage_path_matched,
                    completion_matched,
                    reason,
                )
            });
        let (
            transfer_id,
            task_id,
            browser_tab_id,
            permit_status,
            stage_path_matched,
            completion_matched,
            reason,
        ) = matching_permit.unwrap_or_else(|| {
            let reason = state.native_download_permits.values().any(|permit| {
                permit.engine_id == engine_id && permit.event_binding == event_binding
            });
            (
                None,
                None,
                None,
                None,
                false,
                false,
                if reason {
                    "sourceUrlDoesNotMatchPermit"
                } else {
                    "noMatchingPermit"
                },
            )
        });
        let profile_id =
            profile_id_for_task_or_tab(&state, task_id.as_deref(), browser_tab_id.as_deref());
        push_receipt(
            &mut state,
            "browserNativeDownloadTerminalObserved",
            task_id,
            profile_id,
            "Native Browser download terminal callback observed".to_string(),
            json!({
                "transferId": transfer_id,
                "browserTabId": browser_tab_id,
                "callbackObserved": true,
                "terminalState": if success { "completed" } else { "interrupted" },
                "nativeControllerMayResume": !success && cfg!(target_os = "windows"),
                "reportedStagePathPresent": reported_path.is_some(),
                "stagePathMatched": stage_path_matched,
                "completionMatched": completion_matched,
                "permitStatus": permit_status,
                "reason": reason,
            }),
        );
    }

    /// Persist a bounded WebView2 adapter observation only while its exact
    /// approved private stage is still owned by this engine binding. The Wry
    /// callback has no download-operation identifier, so accepting any weaker
    /// correlation here would let a stale controller attach evidence to a
    /// later transfer.
    #[cfg(target_os = "windows")]
    pub(crate) fn record_windows_native_download_adapter_event(
        &self,
        engine_id: &str,
        event_binding: &str,
        stage_path: &std::path::Path,
        event: wry::WindowsDownloadAdapterEvent,
    ) {
        let mut state = lock_or_recover(&self.state);
        let matching_permit = state
            .native_download_permits
            .iter()
            .find(|(_, permit)| {
                permit.engine_id == engine_id
                    && permit.event_binding == event_binding
                    && matches!(
                        permit.status,
                        NativeDownloadPermitStatus::InProgress
                            | NativeDownloadPermitStatus::CleanupPending
                    )
                    && permit
                        .stage
                        .as_ref()
                        .is_some_and(|stage| stage.path() == stage_path)
            })
            .map(|(transfer_id, permit)| {
                (
                    transfer_id.clone(),
                    permit.task_id.clone(),
                    permit.browser_tab_id.clone(),
                    native_download_permit_status_name(permit.status),
                )
            });
        let Some((transfer_id, task_id, browser_tab_id, permit_status)) = matching_permit else {
            return;
        };
        let profile_id =
            profile_id_for_task_or_tab(&state, task_id.as_deref(), browser_tab_id.as_deref());
        push_receipt(
            &mut state,
            "browserNativeDownloadAdapterObserved",
            task_id,
            profile_id,
            "Native Browser download adapter state observed".to_string(),
            json!({
                "transferId": transfer_id,
                "browserTabId": browser_tab_id,
                "adapter": "webview2",
                "permitStatus": permit_status,
                "observation": windows_native_download_adapter_observation_json(event),
            }),
        );
    }

    pub(super) fn finish_native_download_finalization_with_retained_final(
        &self,
        transfer_id: &str,
        detail: &str,
        final_path: &str,
        bytes: Option<u64>,
        sha256: Option<&str>,
    ) {
        let mut state = lock_or_recover(&self.state);
        if let Some(permit) = state.native_download_permits.get_mut(transfer_id) {
            permit.status = NativeDownloadPermitStatus::CleanupPending;
            // The finalizer has finished, but the staged marker now records a
            // retained destination. Do not let a later callback or generic
            // cleanup delete it by pathname.
            permit.finalization_claimed = true;
            permit.cleanup_in_progress = false;
        }
        mark_native_download_retained_final_cleanup_pending(
            &mut state,
            transfer_id,
            detail,
            final_path,
            bytes,
            sha256,
        );
    }

    fn finish_native_download_claimed_completion_failure(
        &self,
        transfer_id: &str,
        detail: &str,
        rollback_error: Option<&str>,
        retained_final: Option<&(String, u64, String)>,
    ) {
        let mut state = lock_or_recover(&self.state);
        if rollback_error.is_none() {
            state.native_download_permits.remove(transfer_id);
            mark_native_download_failed(&mut state, transfer_id, detail);
            return;
        }
        if let Some(permit) = state.native_download_permits.get_mut(transfer_id) {
            permit.status = NativeDownloadPermitStatus::CleanupPending;
            // The protected destination could not be removed. Do not pretend a
            // later stage cleanup can repair it; retain the permit as durable
            // cleanup-pending evidence for an operator-visible failure.
            permit.finalization_claimed = true;
            permit.cleanup_in_progress = false;
        }
        if let Some((final_path, bytes, sha256)) = retained_final {
            mark_native_download_final_artifact_cleanup_pending(
                &mut state,
                transfer_id,
                final_path,
                *bytes,
                sha256,
            );
        } else {
            mark_native_download_cleanup_pending(&mut state, transfer_id);
        }
    }

    fn record_native_download_marker_cleanup_needed(
        &self,
        transfer_id: &str,
        artifact: &crate::shellx_browser_transfer_artifacts::BrowserLocalArtifact,
    ) {
        let mut state = lock_or_recover(&self.state);
        let task_id = state
            .downloads
            .iter()
            .find(|entry| entry.transfer_id == transfer_id)
            .and_then(|entry| entry.task_id.clone());
        let browser_tab_id = state
            .downloads
            .iter()
            .find(|entry| entry.transfer_id == transfer_id)
            .and_then(|entry| entry.browser_tab_id.clone());
        let profile_id =
            profile_id_for_task_or_tab(&state, task_id.as_deref(), browser_tab_id.as_deref());
        push_receipt(
            &mut state,
            "browserNativeDownloadMarkerCleanupPending",
            task_id,
            profile_id,
            "Native Browser download reached a terminal state, but its private cleanup marker was retained for recovery".to_string(),
            json!({
                "transferId": transfer_id,
                "state": "cleanupPending",
                "retainedArtifact": {
                    "finalPath": artifact.final_path,
                    "bytes": artifact.bytes,
                    "sha256": artifact.sha256,
                },
            }),
        );
    }

    fn finish_native_download_stage_cleanup(
        &self,
        transfer_id: &str,
        stage: &Arc<BrowserNativeDownloadStage>,
        detail: &str,
    ) {
        #[cfg(target_os = "windows")]
        {
            // Once a stage is being torn down, no later WebView2 callback may
            // retain its registry observer. The exact stage remains the key;
            // there is no path simplification or canonicalization here.
            wry::unregister_windows_download_adapter_observer(stage.path());
        }
        match discard_native_browser_download_stage(stage) {
            Ok(()) => self.finish_native_download_stage_cleanup_without_stage(transfer_id, detail),
            Err(_) => {
                let mut state = lock_or_recover(&self.state);
                if let Some(permit) = state.native_download_permits.get_mut(transfer_id) {
                    permit.cleanup_in_progress = false;
                }
                mark_native_download_cleanup_pending(&mut state, transfer_id);
            }
        }
    }

    fn finish_native_download_stage_cleanup_without_stage(&self, transfer_id: &str, detail: &str) {
        let mut state = lock_or_recover(&self.state);
        let can_remove = state
            .native_download_permits
            .get(transfer_id)
            .is_some_and(|permit| {
                permit.status == NativeDownloadPermitStatus::CleanupPending
                    && !permit.finalization_claimed
                    && permit.cleanup_in_progress
            });
        if can_remove {
            state.native_download_permits.remove(transfer_id);
            mark_native_download_failed(&mut state, transfer_id, detail);
        }
    }

    #[cfg(test)]
    pub(crate) fn fail_native_download_resume_if_still_approved(
        &self,
        transfer_id: &str,
        approval_id: &str,
    ) {
        self.fail_native_download_resume_if_still_approved_with_detail(
            transfer_id,
            approval_id,
            NATIVE_DOWNLOAD_REPLAY_TIMEOUT_DETAIL,
        );
    }

    /// Atomically claim only the approval observed by the caller before
    /// terminalizing it. A stale activation must never remove a different
    /// approval that replaced it after the caller released the state lock.
    pub(crate) fn fail_native_download_resume_if_still_approved_with_detail(
        &self,
        transfer_id: &str,
        approval_id: &str,
        detail: &str,
    ) {
        self.fail_native_download_resume_if_still_approved_in_phase(
            transfer_id,
            approval_id,
            None,
            detail,
        );
    }

    pub(crate) fn fail_native_download_resume_if_still_in_phase(
        &self,
        transfer_id: &str,
        approval_id: &str,
        phase: super::NativeDownloadReplayPhase,
    ) {
        let detail = if phase == super::NativeDownloadReplayPhase::AwaitingAck {
            "native Browser download cancellation was not acknowledged within 15 seconds"
        } else {
            NATIVE_DOWNLOAD_REPLAY_TIMEOUT_DETAIL
        };
        self.fail_native_download_resume_if_still_approved_in_phase(
            transfer_id,
            approval_id,
            Some(phase),
            detail,
        );
    }

    fn fail_native_download_resume_if_still_approved_in_phase(
        &self,
        transfer_id: &str,
        approval_id: &str,
        phase: Option<super::NativeDownloadReplayPhase>,
        detail: &str,
    ) {
        let transfer_id = clean_string(transfer_id);
        let approval_id = clean_string(approval_id);
        let detail = clean_string(detail).chars().take(240).collect::<String>();
        let timed_out = {
            let mut state = lock_or_recover(&self.state);
            let Some(permit) = state.native_download_permits.get_mut(&transfer_id) else {
                return;
            };
            if permit.status != NativeDownloadPermitStatus::Approved
                || permit.approval_id.as_deref() != Some(approval_id.as_str())
                || phase.is_some_and(|expected| permit.replay_phase != expected)
            {
                return;
            }
            // This cleanup owns only the exact still-Approved permit. Once an
            // engine callback has moved it to InProgress, a stale caller cannot
            // race in and remove the stage handed to Wry.
            permit.status = NativeDownloadPermitStatus::CleanupPending;
            permit.finalization_claimed = false;
            permit.cleanup_in_progress = true;
            let stage = permit.stage.clone();
            mark_native_download_cleanup_pending(&mut state, &transfer_id);
            stage
        };
        match timed_out {
            Some(stage) => self.finish_native_download_stage_cleanup(&transfer_id, &stage, &detail),
            None => self.finish_native_download_stage_cleanup_without_stage(&transfer_id, &detail),
        }
    }

    /// Quarantine every native permit for an engine before its WebView is
    /// closed. A claimed Finished callback keeps ownership of its stage until
    /// it observes this state and rolls back. Only platforms whose controller
    /// is known quiescent after close may clean unclaimed stages here; WebKit
    /// controllers wait for their terminal callback.
    pub(crate) fn quarantine_native_downloads_for_engine(&self, engine_id: &str) {
        let mut state = lock_or_recover(&self.state);
        quarantine_native_downloads_for_engine_locked(&mut state, engine_id);
    }

    /// Run exact-stage cleanup only after the corresponding WebView is known
    /// closed. Claimed finalizers are intentionally retained: closing Wry does
    /// not prove Rust has finished reading its stage or holding the destination
    /// descriptor.
    pub(crate) fn cleanup_quarantined_native_downloads_after_engine_close(&self, engine_id: &str) {
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        {
            let _ = engine_id;
            // Neither WKDownload nor WebKitGTK's Download is cancelled merely
            // because Wry's WebView label releases. Retain the stage until a
            // terminal callback can safely acknowledge it; bounded marker
            // admission prevents accumulation.
        }
        #[cfg(not(any(target_os = "macos", target_os = "linux")))]
        {
            let engine_id = clean_string(engine_id);
            if engine_id.is_empty() {
                return;
            }
            let cleanup = {
                let mut state = lock_or_recover(&self.state);
                let transfer_ids = state
                    .native_download_permits
                    .iter()
                    .filter(|(_, permit)| {
                        permit.engine_id == engine_id
                            && permit.status == NativeDownloadPermitStatus::CleanupPending
                            && !permit.finalization_claimed
                            && !permit.cleanup_in_progress
                    })
                    .map(|(transfer_id, _)| transfer_id.clone())
                    .collect::<Vec<_>>();
                transfer_ids
                    .into_iter()
                    .filter_map(|transfer_id| {
                        let permit = state.native_download_permits.get_mut(&transfer_id)?;
                        permit.cleanup_in_progress = true;
                        Some((transfer_id, permit.stage.clone()))
                    })
                    .collect::<Vec<_>>()
            };
            for (transfer_id, stage) in cleanup {
                match stage {
                    Some(stage) => self.finish_native_download_stage_cleanup(
                        &transfer_id,
                        &stage,
                        "native Browser engine closed before the download completed",
                    ),
                    None => self.finish_native_download_stage_cleanup_without_stage(
                        &transfer_id,
                        "native Browser engine closed before the download completed",
                    ),
                }
            }
        }
    }
}

/// Whether this platform's completed callback proves the native controller is
/// no longer permitted to write the private stage. WebView2 can emit
/// `Finished(false)` for an interrupted state which it may resume, so Windows
/// retains the admission until a later success or controller close. WebKitGTK
/// and the macOS adapter use their terminal callbacks for failure handling.
pub(super) fn native_download_finished_callback_establishes_quiescence(success: bool) -> bool {
    #[cfg(target_os = "windows")]
    {
        success
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = success;
        true
    }
}

fn native_download_permit_status_name(status: NativeDownloadPermitStatus) -> &'static str {
    match status {
        NativeDownloadPermitStatus::Requested => "requested",
        NativeDownloadPermitStatus::Approved => "approved",
        NativeDownloadPermitStatus::InProgress => "inProgress",
        NativeDownloadPermitStatus::Finalizing => "finalizing",
        NativeDownloadPermitStatus::CleanupPending => "cleanupPending",
    }
}

// ShellX accepts a terminal callback only when it carries the exact private
// stage handed to the accepted controller. Pathless callbacks belong to
// rejected pre-approval requests and are handled only as cancellation
// acknowledgements, never as completion authority for a same-URL transfer.
pub(super) fn native_download_completion_path_matches_stage(
    reported_path: Option<&std::path::Path>,
    expected_stage: &std::path::Path,
) -> bool {
    reported_path == Some(expected_stage)
}
