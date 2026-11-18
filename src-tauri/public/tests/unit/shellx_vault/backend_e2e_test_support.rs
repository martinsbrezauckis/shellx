//! Synthetic Vault guards and audit helpers exercised by ordinary native tests.

use std::ffi::OsString;
use std::fs;

use super::*;

pub(super) const MAX_DEBUG_AUDIT_RECORDS: usize = 512;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct VaultDebugAuditRecord {
    pub receipt_id: String,
    pub action: String,
    pub secret_ref: Option<String>,
    pub grant_id: Option<String>,
    pub decision: Option<String>,
    pub reason: Option<String>,
    pub secret_present: Option<bool>,
    pub secret_exposed: bool,
    pub t: i64,
}

impl ShellxVaultBackend {
    pub(super) fn debug_require_isolated_e2e_profile_for_env(
        &self,
        profile_dir_env: Option<OsString>,
    ) -> Result<(), String> {
        let configured = profile_dir_env
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            .ok_or_else(|| {
                "Vault E2E routes require SHELLX_VAULT_PROFILE_DIR to point at a disposable test profile".to_string()
            })?;
        if !paths_match_for_guard(&self.profile_dir, &configured) {
            return Err(format!(
                "Vault E2E profile mismatch: backend uses {}, but SHELLX_VAULT_PROFILE_DIR is {}",
                self.profile_dir.display(),
                configured.display()
            ));
        }
        if !self.profile_dir.is_absolute() {
            return Err(format!(
                "Vault E2E profile must be an absolute disposable path, got {}",
                self.profile_dir.display()
            ));
        }
        let profile_key = normalize_guard_path(&self.profile_dir);
        let stable_key = normalize_guard_path(&stable_default_profile_dir_without_env_override());
        if profile_key == stable_key || profile_key.ends_with("/.shellx/shellx-vault") {
            return Err(format!(
                "Vault E2E profile refuses stable user Vault path {}",
                self.profile_dir.display()
            ));
        }
        let leaf = self
            .profile_dir
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        if !leaf.contains("e2e") && !leaf.contains("test") {
            return Err(format!(
                "Vault E2E profile path must be clearly disposable and include e2e or test, got {}",
                self.profile_dir.display()
            ));
        }
        Ok(())
    }

    pub(crate) async fn debug_reset_e2e(&self) -> Result<VaultDebugAuditRecord, String> {
        let _transition = self.state_transition.lock().await;
        let mut reset_warning: Option<String> = None;
        self.compat_values.lock().await.clear();
        self.compat_meta.lock().await.clear();
        *self.staged_legacy_import_receipt.lock().await = None;
        #[cfg(test)]
        {
            *self.compat_flush_fail_after_saves.lock().await = None;
            *self
                .compat_confirmation_profile_write_fail_once
                .lock()
                .await = false;
        }
        *self.grants.lock().await = BrokerGrantPolicy::default();
        self.write_grants_snapshot().await?;
        *self.pending_profile.lock().await = None;
        *self.pending_keyfile_publish.lock().await = None;
        *self.pending_remembered_device_secret.lock().await = None;
        *self.pending_session.lock().await = None;
        *self.session.lock().await = None;
        *self.manual_lock.lock().await = false;
        *self.remembered_unlock_attempt.lock().await = RememberedUnlockAttempt::default();
        *self.local_server.lock().await = None;
        crate::shellx_vault::agent_requests::debug_reset_agent_state(self)?;
        if let Err(err) = self
            .remembered_device_store
            .delete(&self.remembered_device_account())
        {
            reset_warning = Some(err);
        }
        match fs::remove_file(self.profile_path()) {
            Ok(()) => {}
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
            Err(err) => return Err(format!("Vault E2E profile reset failed: {err}")),
        }
        let local_server_dir = self.profile_dir.join("local-vault-server");
        match fs::remove_dir_all(&local_server_dir) {
            Ok(()) => {}
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
            Err(err) => return Err(format!("Vault E2E local store reset failed: {err}")),
        }
        *self.status.lock().await = ShellxVaultStatus::default();
        self.debug_audit.lock().await.clear();
        Ok(self
            .push_debug_audit(VaultDebugAuditInput {
                reason: reset_warning,
                ..VaultDebugAuditInput::new("vaultE2eReset")
            })
            .await)
    }

    pub(crate) async fn debug_audit(&self) -> Vec<VaultDebugAuditRecord> {
        self.debug_audit.lock().await.clone()
    }

    pub(crate) async fn debug_record_e2e_event(
        &self,
        action: &str,
        secret_ref: Option<String>,
        grant_id: Option<String>,
    ) -> VaultDebugAuditRecord {
        self.push_debug_audit(VaultDebugAuditInput {
            secret_ref,
            grant_id,
            ..VaultDebugAuditInput::new(action)
        })
        .await
    }

    pub(super) async fn push_debug_audit(
        &self,
        input: VaultDebugAuditInput<'_>,
    ) -> VaultDebugAuditRecord {
        let record = VaultDebugAuditRecord {
            receipt_id: format!("vault-e2e-{}", hex::encode(vault_core::random_bytes::<8>())),
            action: input.action.to_string(),
            secret_ref: input.secret_ref,
            grant_id: input.grant_id,
            decision: input.decision,
            reason: input.reason,
            secret_present: input.secret_present,
            secret_exposed: input.secret_exposed,
            t: now_ms(),
        };
        let mut audit = self.debug_audit.lock().await;
        audit.push(record.clone());
        let overflow = audit.len().saturating_sub(MAX_DEBUG_AUDIT_RECORDS);
        if overflow > 0 {
            audit.drain(..overflow);
        }
        record
    }
}

pub(super) struct VaultDebugAuditInput<'a> {
    pub(super) action: &'a str,
    pub(super) secret_ref: Option<String>,
    pub(super) grant_id: Option<String>,
    pub(super) decision: Option<String>,
    pub(super) reason: Option<String>,
    pub(super) secret_present: Option<bool>,
    pub(super) secret_exposed: bool,
}

impl<'a> VaultDebugAuditInput<'a> {
    pub(super) fn new(action: &'a str) -> Self {
        Self {
            action,
            secret_ref: None,
            grant_id: None,
            decision: None,
            reason: None,
            secret_present: None,
            secret_exposed: false,
        }
    }
}
