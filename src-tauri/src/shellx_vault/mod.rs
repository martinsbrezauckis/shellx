//! ShellX policy bridge over ShellX Vault.
//!
//! Vault crates own encrypted storage and sync. This module owns ShellX
//! authorization: setup state, recovery confirmation, legacy import,
//! grants, browser mediation, agent mediation, and compatibility shims.

use std::sync::{Arc, OnceLock};

mod backend;
pub mod grants;
mod leak_guard;
pub mod legacy_import;
pub mod recovery;

pub use backend::{
    compat_key_to_item_id, SetupRequest, SetupTarget, ShellxVaultBackend, ShellxVaultKeyMeta,
    ShellxVaultMode, ShellxVaultStatus, UnlockRequest, VaultDebugAuditRecord,
    VaultDebugProbeResponse, VaultProfile, VaultResourceKind,
};
pub use grants::{
    GrantActorContext, GrantDecision, GrantOperation, GrantRequest, GrantScope, GrantSummary,
};
pub use leak_guard::marker_was_leaked;
pub use legacy_import::LegacyImportReceipt;
pub use recovery::RecoveryKit;

pub async fn resolve_internal_secret(
    backend: &ShellxVaultBackend,
    key: &str,
) -> Result<Option<String>, String> {
    backend.compat_get(key).await
}

pub fn shared_backend() -> Arc<ShellxVaultBackend> {
    static BACKEND: OnceLock<Arc<ShellxVaultBackend>> = OnceLock::new();
    BACKEND
        .get_or_init(|| Arc::new(ShellxVaultBackend::default()))
        .clone()
}
