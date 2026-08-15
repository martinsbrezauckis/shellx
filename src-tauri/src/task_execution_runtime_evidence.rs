//! Bounded identifiers and evidence references used by the Task runtime bridge.
//!
//! These helpers keep opaque receipt references bounded before they cross into
//! `task_provider_fallback`, whose pure data types deliberately do not own
//! serialization or storage policy.

use crate::task_provider_fallback::{DecisionEvidence, EvidenceClass};

pub(crate) const MAX_TASK_ID_BYTES: usize = 256;
pub(crate) const MAX_TARGET_FIELD_BYTES: usize = 512;
pub(crate) const MAX_EVIDENCE_REFERENCE_BYTES: usize = 512;
const MAX_PROVIDER_EVENT_COMPONENT_BYTES: usize = 200;

pub(crate) fn is_bounded_non_control(value: &str, max_bytes: usize) -> bool {
    !value.trim().is_empty() && value.len() <= max_bytes && !value.chars().any(char::is_control)
}

pub(crate) fn bounded_evidence(
    class: EvidenceClass,
    reference: impl AsRef<str>,
) -> Option<DecisionEvidence> {
    let reference = reference.as_ref();
    is_bounded_non_control(reference, MAX_EVIDENCE_REFERENCE_BYTES)
        .then(|| DecisionEvidence::new(class, reference))
}

pub(crate) fn provider_session_evidence(run_id: &str, event_id: &str) -> Option<DecisionEvidence> {
    if !is_bounded_non_control(run_id, MAX_PROVIDER_EVENT_COMPONENT_BYTES)
        || !is_bounded_non_control(event_id, MAX_PROVIDER_EVENT_COMPONENT_BYTES)
    {
        return None;
    }
    bounded_evidence(
        EvidenceClass::ProviderSession,
        format!("provider-session:{run_id}:event:{event_id}"),
    )
}

/// `TaskProviderCatalog.snapshotId` is an exact opaque lowercase sha256
/// identity, unlike revision digests which may arrive in legacy bare form.
pub(crate) fn is_exact_catalogue_snapshot_id(value: &str) -> bool {
    let Some(digest) = value.strip_prefix("sha256:") else {
        return false;
    };
    digest.len() == 64
        && digest
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
}

/// Accept legacy bare revision digests or a `sha256:` prefix, then retain one
/// canonical lowercase representation in every runtime receipt.
pub(crate) fn normalize_revision_sha256(value: &str) -> Option<String> {
    let digest = value.strip_prefix("sha256:").unwrap_or(value);
    (digest.len() == 64 && digest.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .then(|| format!("sha256:{}", digest.to_ascii_lowercase()))
}
