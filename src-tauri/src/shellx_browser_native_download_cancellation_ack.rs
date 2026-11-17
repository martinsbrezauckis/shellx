//! Exact, bounded acknowledgement tracking for cancelled native downloads.
//!
//! Wry can deliver a rejected request's `Finished(false, None, url)` after an
//! operator has approved the URL replay. The acknowledgment is therefore
//! consumed before common completion handling can see a newly in-progress
//! replay with the same engine, binding, and URL.

use std::collections::BTreeMap;

use sha2::{Digest, Sha256};

use super::*;

#[cfg(not(target_os = "linux"))]
const MAX_PENDING_NATIVE_DOWNLOAD_CANCELLATION_KEYS: usize = 1024;
#[cfg(not(target_os = "linux"))]
const MAX_PENDING_NATIVE_DOWNLOAD_CANCELLATIONS_PER_KEY: usize = 1024;
const CANCELLATION_ACK_CAPACITY_ERROR: &str =
    "native Browser download cancellation acknowledgement capacity is unknown; restart ShellX before approving another native download";
const CANCELLATION_ACK_PENDING_ERROR: &str =
    "native Browser download is still awaiting cancellation acknowledgement";

#[derive(Clone, Debug, Default)]
pub(crate) struct NativeDownloadCancellationAcks {
    pending: BTreeMap<NativeDownloadCancellationKey, usize>,
    /// Once a callback cannot be recorded exactly, never evict a different
    /// outstanding callback and never resume a native request from this state.
    overflowed: bool,
}

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
struct NativeDownloadCancellationKey {
    engine_id: String,
    event_binding: String,
    // Do not retain page-controlled URL text for every pending cancellation.
    // The full URL remains in the permit and is checked before replay.
    source_url_digest: [u8; 32],
}

#[derive(Clone, Debug)]
#[cfg(not(target_os = "linux"))]
pub(crate) enum BrowserNativeDownloadCancellationAcknowledgement {
    /// This event does not correspond to a known rejected native request and
    /// must continue through ordinary completion handling.
    Ignore,
    /// A rejected request was acknowledged, but an older cancellation remains
    /// or the associated approval is no longer eligible to replay.
    Consumed,
    /// The final earlier cancellation was acknowledged while the exact permit
    /// remains approved. The caller may now replay this URL exactly once.
    ReadyResume(BrowserNativeDownloadResume),
}

impl NativeDownloadCancellationAcks {
    #[cfg(not(target_os = "linux"))]
    pub(super) fn record_rejected_request(
        &mut self,
        engine_id: &str,
        event_binding: &str,
        source_url: &str,
    ) {
        if self.overflowed {
            return;
        }
        let key = NativeDownloadCancellationKey::new(engine_id, event_binding, source_url);
        let Some(current) = self.pending.get_mut(&key) else {
            if self.pending.len() >= MAX_PENDING_NATIVE_DOWNLOAD_CANCELLATION_KEYS {
                self.overflowed = true;
                return;
            }
            self.pending.insert(key, 1);
            return;
        };
        if *current >= MAX_PENDING_NATIVE_DOWNLOAD_CANCELLATIONS_PER_KEY {
            self.overflowed = true;
            return;
        }
        *current += 1;
    }

    pub(crate) fn require_safe_for_approval(&self) -> Result<(), String> {
        if self.overflowed {
            return Err(CANCELLATION_ACK_CAPACITY_ERROR.to_string());
        }
        Ok(())
    }

    pub(super) fn has_pending(
        &self,
        engine_id: &str,
        event_binding: &str,
        source_url: &str,
    ) -> bool {
        self.pending
            .contains_key(&NativeDownloadCancellationKey::new(
                engine_id,
                event_binding,
                source_url,
            ))
    }

    /// Returns `None` if this callback was not a tracked cancellation and
    /// otherwise whether its exact key is now fully drained.
    #[cfg(not(target_os = "linux"))]
    fn consume(&mut self, engine_id: &str, event_binding: &str, source_url: &str) -> Option<bool> {
        let key = NativeDownloadCancellationKey::new(engine_id, event_binding, source_url);
        let current = self.pending.get_mut(&key)?;
        debug_assert!(*current > 0);
        *current -= 1;
        if *current == 0 {
            self.pending.remove(&key);
            Some(true)
        } else {
            Some(false)
        }
    }
}

impl NativeDownloadCancellationKey {
    fn new(engine_id: &str, event_binding: &str, source_url: &str) -> Self {
        Self {
            engine_id: engine_id.to_string(),
            event_binding: event_binding.to_string(),
            source_url_digest: Sha256::digest(source_url.as_bytes()).into(),
        }
    }
}

impl ShellxBrowserRegistry {
    /// Consume a non-Linux rejected native request before ordinary Finished
    /// handling. This method intentionally receives no path or success claim:
    /// the caller has already established Wry's `Finished(false, ..)` shape.
    #[cfg(not(target_os = "linux"))]
    pub(crate) fn acknowledge_native_download_cancellation(
        &self,
        engine_id: &str,
        event_binding: &str,
        source_url: &str,
    ) -> BrowserNativeDownloadCancellationAcknowledgement {
        let mut state = lock_or_recover(&self.state);
        let Some(drained) =
            state
                .native_download_cancellation_acks
                .consume(engine_id, event_binding, source_url)
        else {
            return BrowserNativeDownloadCancellationAcknowledgement::Ignore;
        };
        if !drained
            || state
                .native_download_cancellation_acks
                .require_safe_for_approval()
                .is_err()
        {
            return BrowserNativeDownloadCancellationAcknowledgement::Consumed;
        }
        let Some((transfer_id, permit)) = state
            .native_download_permits
            .iter()
            .find(|(_, permit)| {
                permit.status == NativeDownloadPermitStatus::Approved
                    && permit.engine_id == engine_id
                    && permit.event_binding == event_binding
                    && permit.source_url == source_url
            })
            .map(|(transfer_id, permit)| (transfer_id.clone(), permit.clone()))
        else {
            return BrowserNativeDownloadCancellationAcknowledgement::Consumed;
        };
        let Some(approval_id) = permit.approval_id.clone() else {
            return BrowserNativeDownloadCancellationAcknowledgement::Consumed;
        };
        let Some(entry) = state
            .downloads
            .iter()
            .find(|entry| entry.transfer_id == transfer_id)
        else {
            return BrowserNativeDownloadCancellationAcknowledgement::Consumed;
        };
        if entry.status != "approved"
            || !entry.requires_approval
            || entry.approval_id.as_deref() != Some(approval_id.as_str())
            || state
                .engine_event_bindings
                .get(&permit.engine_id)
                .is_none_or(|binding| binding != &permit.event_binding)
        {
            return BrowserNativeDownloadCancellationAcknowledgement::Consumed;
        }
        BrowserNativeDownloadCancellationAcknowledgement::ReadyResume(BrowserNativeDownloadResume {
            transfer_id,
            approval_id,
            engine_id: permit.engine_id,
            event_binding: permit.event_binding,
            source_url: permit.source_url,
        })
    }

    /// Recheck the exact permit and bounded cancellation state immediately
    /// before a platform adapter replays an approved URL or accepts its native
    /// callback. This closes the gap between approval and callback dispatch.
    pub(crate) fn native_download_resume_is_eligible(
        &self,
        resume: &BrowserNativeDownloadResume,
    ) -> Result<(), String> {
        let state = lock_or_recover(&self.state);
        state
            .native_download_cancellation_acks
            .require_safe_for_approval()?;
        if state.native_download_cancellation_acks.has_pending(
            &resume.engine_id,
            &resume.event_binding,
            &resume.source_url,
        ) {
            return Err(CANCELLATION_ACK_PENDING_ERROR.to_string());
        }
        let permit = state
            .native_download_permits
            .get(&resume.transfer_id)
            .ok_or_else(|| {
                "native Browser download permit was removed before replay".to_string()
            })?;
        if permit.status != NativeDownloadPermitStatus::Approved
            || permit.engine_id != resume.engine_id
            || permit.event_binding != resume.event_binding
            || permit.source_url != resume.source_url
            || permit.approval_id.as_deref() != Some(resume.approval_id.as_str())
        {
            return Err("native Browser download approval is no longer current".to_string());
        }
        let entry = state
            .downloads
            .iter()
            .find(|entry| entry.transfer_id == resume.transfer_id)
            .ok_or_else(|| "native Browser download transfer no longer exists".to_string())?;
        if entry.status != "approved"
            || !entry.requires_approval
            || entry.approval_id.as_deref() != Some(resume.approval_id.as_str())
        {
            return Err("native Browser download is no longer awaiting execution".to_string());
        }
        Ok(())
    }
}
