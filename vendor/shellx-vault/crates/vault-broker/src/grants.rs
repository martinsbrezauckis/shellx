//! Shared grant policy foundation.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::actors::{ActorKind, ActorRegistry, VaultActor};
use crate::receipts::{ReceiptDecision, VaultReceipt};
use crate::resources::ResourcePermission;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "camelCase")]
pub enum GrantAction {
    FillLogin,
    FillProfile,
    ReadEmailCode,
    InjectEnv,
    UseWallet,
    UseProvider,
    UseConnector,
    Deposit,
    ReadFile,
    WriteFile,
    PullSyncSet,
    PushSyncSet,
    CreateProjectCapsule,
    ApplyProjectCapsule,
    ExportFromSafe,
    RawReveal,
}

impl GrantAction {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::FillLogin => "fillLogin",
            Self::FillProfile => "fillProfile",
            Self::ReadEmailCode => "readEmailCode",
            Self::InjectEnv => "injectEnv",
            Self::UseWallet => "useWallet",
            Self::UseProvider => "useProvider",
            Self::UseConnector => "useConnector",
            Self::Deposit => "deposit",
            Self::ReadFile => "readFile",
            Self::WriteFile => "writeFile",
            Self::PullSyncSet => "pullSyncSet",
            Self::PushSyncSet => "pushSyncSet",
            Self::CreateProjectCapsule => "createProjectCapsule",
            Self::ApplyProjectCapsule => "applyProjectCapsule",
            Self::ExportFromSafe => "exportFromSafe",
            Self::RawReveal => "rawReveal",
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GrantConstraints {
    #[serde(default)]
    pub origin: Option<String>,
    #[serde(default)]
    pub path_prefix: Option<String>,
    #[serde(default)]
    pub expires_at_ms: Option<i64>,
    #[serde(default)]
    pub max_uses: Option<u32>,
    #[serde(default)]
    pub machine_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum GrantStatus {
    Pending,
    Approved,
    Revoked,
    Expired,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct VaultGrant {
    pub grant_id: String,
    pub actor_id: String,
    pub resource_id: String,
    pub action: GrantAction,
    pub constraints: GrantConstraints,
    pub status: GrantStatus,
    pub created_at_ms: i64,
    #[serde(default)]
    pub approved_at_ms: Option<i64>,
    #[serde(default)]
    pub revoked_at_ms: Option<i64>,
    #[serde(default)]
    pub uses: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GrantRequest {
    pub actor_id: String,
    pub resource_id: String,
    pub action: GrantAction,
    #[serde(default)]
    pub constraints: GrantConstraints,
    pub created_at_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GrantUseRequest {
    pub grant_id: String,
    pub actor_id: String,
    pub resource_id: String,
    pub action: GrantAction,
    #[serde(default)]
    pub origin: Option<String>,
    #[serde(default)]
    pub path: Option<String>,
    pub now_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum GrantDenyReason {
    GrantNotFound,
    GrantPending,
    GrantRevoked,
    GrantExpired,
    GrantActorMismatch,
    GrantResourceMismatch,
    GrantActionMismatch,
    ActorNotRegistered,
    ActorRevoked,
    UserOnlyResource,
    RawRevealDenied,
    OriginMismatch,
    PathMismatch,
    MaxUsesExceeded,
    ResourceNotFound,
    AgentPolicyDenied,
}

impl GrantDenyReason {
    fn as_str(&self) -> &'static str {
        match self {
            Self::GrantNotFound => "grantNotFound",
            Self::GrantPending => "grantPending",
            Self::GrantRevoked => "grantRevoked",
            Self::GrantExpired => "grantExpired",
            Self::GrantActorMismatch => "grantActorMismatch",
            Self::GrantResourceMismatch => "grantResourceMismatch",
            Self::GrantActionMismatch => "grantActionMismatch",
            Self::ActorNotRegistered => "actorNotRegistered",
            Self::ActorRevoked => "actorRevoked",
            Self::UserOnlyResource => "userOnlyResource",
            Self::RawRevealDenied => "rawRevealDenied",
            Self::OriginMismatch => "originMismatch",
            Self::PathMismatch => "pathMismatch",
            Self::MaxUsesExceeded => "maxUsesExceeded",
            Self::ResourceNotFound => "resourceNotFound",
            Self::AgentPolicyDenied => "agentPolicyDenied",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GrantDecision {
    AllowMediated {
        receipt: VaultReceipt,
    },
    Deny {
        reason: GrantDenyReason,
        receipt: VaultReceipt,
    },
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GrantPolicySnapshot {
    pub actors: ActorRegistry,
    pub resource_permissions: BTreeMap<String, ResourcePermission>,
    pub grants: BTreeMap<String, VaultGrant>,
    #[serde(default)]
    pub next_grant_seq: u64,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct GrantPolicy {
    actors: ActorRegistry,
    resource_permissions: BTreeMap<String, ResourcePermission>,
    grants: BTreeMap<String, VaultGrant>,
    receipts: Vec<VaultReceipt>,
    next_grant_seq: u64,
}

impl GrantPolicy {
    pub fn register_actor(&mut self, actor: VaultActor) {
        self.actors.register(actor);
    }

    pub fn revoke_actor(
        &mut self,
        actor_id: &str,
        revoked_at_ms: i64,
    ) -> Result<(), GrantDenyReason> {
        self.actors
            .revoke(actor_id, revoked_at_ms)
            .ok_or(GrantDenyReason::ActorNotRegistered)?;
        self.revoke_grants_for_actor(actor_id, revoked_at_ms);
        Ok(())
    }

    pub fn set_resource_permission(&mut self, resource_id: &str, permission: ResourcePermission) {
        self.resource_permissions
            .insert(resource_id.to_string(), permission);
    }

    pub fn create_grant(&mut self, request: GrantRequest) -> Result<VaultGrant, GrantDenyReason> {
        if matches!(request.action, GrantAction::RawReveal) {
            return Err(GrantDenyReason::RawRevealDenied);
        }
        self.require_actor_active(&request.actor_id)?;
        if self.resource_permission(&request.resource_id) == ResourcePermission::UserOnly {
            return Err(GrantDenyReason::UserOnlyResource);
        }
        self.next_grant_seq = self.next_grant_seq.saturating_add(1);
        let grant = VaultGrant {
            grant_id: format!("grant-{}-{}", request.created_at_ms, self.next_grant_seq),
            actor_id: request.actor_id,
            resource_id: request.resource_id,
            action: request.action,
            constraints: request.constraints,
            status: GrantStatus::Pending,
            created_at_ms: request.created_at_ms,
            approved_at_ms: None,
            revoked_at_ms: None,
            uses: 0,
        };
        self.grants.insert(grant.grant_id.clone(), grant.clone());
        Ok(grant)
    }

    pub fn approve_grant(
        &mut self,
        grant_id: &str,
        approved_at_ms: i64,
    ) -> Result<VaultGrant, GrantDenyReason> {
        let grant = self
            .grants
            .get_mut(grant_id)
            .ok_or(GrantDenyReason::GrantNotFound)?;
        grant.status = GrantStatus::Approved;
        grant.approved_at_ms = Some(approved_at_ms);
        Ok(grant.clone())
    }

    pub fn revoke_grant(
        &mut self,
        grant_id: &str,
        revoked_at_ms: i64,
    ) -> Result<VaultGrant, GrantDenyReason> {
        let grant = self
            .grants
            .get_mut(grant_id)
            .ok_or(GrantDenyReason::GrantNotFound)?;
        grant.status = GrantStatus::Revoked;
        grant.revoked_at_ms = Some(revoked_at_ms);
        Ok(grant.clone())
    }

    pub fn revoke_grants_for_resource(&mut self, resource_id: &str, revoked_at_ms: i64) -> usize {
        self.revoke_matching_grants(revoked_at_ms, |grant| grant.resource_id == resource_id)
    }

    pub fn revoke_grants_for_actor(&mut self, actor_id: &str, revoked_at_ms: i64) -> usize {
        self.revoke_matching_grants(revoked_at_ms, |grant| grant.actor_id == actor_id)
    }

    pub fn revoke_grants_for_action(&mut self, action: GrantAction, revoked_at_ms: i64) -> usize {
        self.revoke_matching_grants(revoked_at_ms, |grant| grant.action == action)
    }

    pub fn revoke_grants_for_path_actions(
        &mut self,
        path: &str,
        actions: impl IntoIterator<Item = GrantAction>,
        revoked_at_ms: i64,
    ) -> usize {
        let actions = actions
            .into_iter()
            .collect::<std::collections::BTreeSet<_>>();
        self.revoke_matching_grants(revoked_at_ms, |grant| {
            actions.contains(&grant.action)
                && (grant.resource_id == path
                    || grant
                        .constraints
                        .path_prefix
                        .as_deref()
                        .map(|prefix| path.starts_with(prefix) || prefix == path)
                        .unwrap_or(false))
        })
    }

    pub fn agent_visible_resources(&self) -> impl Iterator<Item = &str> {
        self.resource_permissions
            .iter()
            .filter(|(_, permission)| **permission != ResourcePermission::UserOnly)
            .map(|(resource_id, _)| resource_id.as_str())
    }

    pub fn authorize(&mut self, request: GrantUseRequest) -> GrantDecision {
        let reason = self.authorize_inner(&request);
        match reason {
            None => {
                let receipt = self.push_receipt(&request, ReceiptDecision::Allowed, None);
                GrantDecision::AllowMediated { receipt }
            }
            Some(reason) => {
                let receipt = self.push_receipt(
                    &request,
                    ReceiptDecision::Denied,
                    Some(reason.as_str().to_string()),
                );
                GrantDecision::Deny { reason, receipt }
            }
        }
    }

    pub fn deny_request(
        &mut self,
        request: GrantUseRequest,
        reason: GrantDenyReason,
    ) -> GrantDecision {
        let receipt = self.push_receipt(
            &request,
            ReceiptDecision::Denied,
            Some(reason.as_str().to_string()),
        );
        GrantDecision::Deny { reason, receipt }
    }

    pub fn grant(&self, grant_id: &str) -> Option<&VaultGrant> {
        self.grants.get(grant_id)
    }

    pub fn receipts(&self) -> &[VaultReceipt] {
        &self.receipts
    }

    pub fn to_snapshot(&self) -> GrantPolicySnapshot {
        GrantPolicySnapshot {
            actors: self.actors.clone(),
            resource_permissions: self.resource_permissions.clone(),
            grants: self.grants.clone(),
            next_grant_seq: self.next_grant_seq,
        }
    }

    pub fn from_snapshot(snapshot: GrantPolicySnapshot) -> Self {
        Self {
            actors: snapshot.actors,
            resource_permissions: snapshot.resource_permissions,
            grants: snapshot.grants,
            receipts: Vec::new(),
            next_grant_seq: snapshot.next_grant_seq,
        }
    }

    pub fn from_snapshot_with_receipts(
        snapshot: GrantPolicySnapshot,
        receipts: Vec<VaultReceipt>,
    ) -> Self {
        Self {
            actors: snapshot.actors,
            resource_permissions: snapshot.resource_permissions,
            grants: snapshot.grants,
            receipts,
            next_grant_seq: snapshot.next_grant_seq,
        }
    }

    pub fn from_shellx_legacy_grants_json(raw: &str) -> Result<Self, serde_json::Error> {
        let legacy: BTreeMap<String, LegacyShellxPersistedGrant> = serde_json::from_str(raw)?;
        let mut policy = GrantPolicy::default();
        for (grant_id, grant) in legacy {
            let actor = grant.request.actor_scope.to_actor();
            policy.register_actor(actor.clone());
            policy
                .set_resource_permission(&grant.request.secret_ref, ResourcePermission::VisibleAsk);
            let status = if grant.revoked {
                GrantStatus::Revoked
            } else if grant.approved {
                GrantStatus::Approved
            } else {
                GrantStatus::Pending
            };
            policy.grants.insert(
                grant_id.clone(),
                VaultGrant {
                    grant_id,
                    actor_id: actor.actor_id,
                    resource_id: grant.request.secret_ref,
                    action: grant.request.operation.to_grant_action(),
                    constraints: GrantConstraints {
                        expires_at_ms: grant.request.expires_at_ms,
                        ..GrantConstraints::default()
                    },
                    status,
                    created_at_ms: grant.created_at_ms,
                    approved_at_ms: if grant.approved {
                        Some(grant.created_at_ms)
                    } else {
                        None
                    },
                    revoked_at_ms: None,
                    uses: 0,
                },
            );
        }
        Ok(policy)
    }

    fn authorize_inner(&mut self, request: &GrantUseRequest) -> Option<GrantDenyReason> {
        if matches!(request.action, GrantAction::RawReveal) {
            return Some(GrantDenyReason::RawRevealDenied);
        }
        if let Err(reason) = self.require_actor_active(&request.actor_id) {
            return Some(reason);
        }
        if self.resource_permission(&request.resource_id) == ResourcePermission::UserOnly {
            return Some(GrantDenyReason::UserOnlyResource);
        }
        let grant = match self.grants.get_mut(&request.grant_id) {
            Some(grant) => grant,
            None => return Some(GrantDenyReason::GrantNotFound),
        };
        if grant.actor_id != request.actor_id {
            return Some(GrantDenyReason::GrantActorMismatch);
        }
        if grant.resource_id != request.resource_id {
            return Some(GrantDenyReason::GrantResourceMismatch);
        }
        if grant.action != request.action {
            return Some(GrantDenyReason::GrantActionMismatch);
        }
        match grant.status {
            GrantStatus::Pending => return Some(GrantDenyReason::GrantPending),
            GrantStatus::Revoked => return Some(GrantDenyReason::GrantRevoked),
            GrantStatus::Expired => return Some(GrantDenyReason::GrantExpired),
            GrantStatus::Approved => {}
        }
        if let Some(expires_at_ms) = grant.constraints.expires_at_ms {
            if expires_at_ms <= request.now_ms {
                grant.status = GrantStatus::Expired;
                return Some(GrantDenyReason::GrantExpired);
            }
        }
        if let Some(expected_origin) = grant.constraints.origin.as_deref() {
            if request.origin.as_deref() != Some(expected_origin) {
                return Some(GrantDenyReason::OriginMismatch);
            }
        }
        if let Some(path_prefix) = grant.constraints.path_prefix.as_deref() {
            if !request
                .path
                .as_deref()
                .map(|path| path.starts_with(path_prefix))
                .unwrap_or(false)
            {
                return Some(GrantDenyReason::PathMismatch);
            }
        }
        if let Some(max_uses) = grant.constraints.max_uses {
            if grant.uses >= max_uses {
                return Some(GrantDenyReason::MaxUsesExceeded);
            }
        }
        grant.uses = grant.uses.saturating_add(1);
        None
    }

    pub fn require_actor_active(&self, actor_id: &str) -> Result<(), GrantDenyReason> {
        let Some(actor) = self.actors.get(actor_id) else {
            return Err(GrantDenyReason::ActorNotRegistered);
        };
        if actor.revoked_at_ms.is_some() {
            return Err(GrantDenyReason::ActorRevoked);
        }
        Ok(())
    }

    fn resource_permission(&self, resource_id: &str) -> ResourcePermission {
        self.resource_permissions
            .get(resource_id)
            .cloned()
            .unwrap_or(ResourcePermission::VisibleAsk)
    }

    fn revoke_matching_grants(
        &mut self,
        revoked_at_ms: i64,
        matches: impl Fn(&VaultGrant) -> bool,
    ) -> usize {
        let mut revoked = 0;
        for grant in self.grants.values_mut() {
            if matches(grant) && grant.status != GrantStatus::Revoked {
                grant.status = GrantStatus::Revoked;
                grant.revoked_at_ms = Some(revoked_at_ms);
                revoked += 1;
            }
        }
        revoked
    }

    fn push_receipt(
        &mut self,
        request: &GrantUseRequest,
        decision: ReceiptDecision,
        reason: Option<String>,
    ) -> VaultReceipt {
        let receipt = VaultReceipt {
            receipt_id: format!("receipt-{}-{}", request.now_ms, self.receipts.len() + 1),
            actor_id: request.actor_id.clone(),
            resource_id: request.resource_id.clone(),
            action: request.action.as_str().to_string(),
            grant_id: Some(request.grant_id.clone()),
            decision,
            reason,
            created_at_ms: request.now_ms,
            secret_exposed: false,
        };
        self.receipts.push(receipt.clone());
        receipt
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyShellxPersistedGrant {
    request: LegacyShellxGrantRequest,
    revoked: bool,
    #[serde(default)]
    approved: bool,
    #[serde(default)]
    created_at_ms: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyShellxGrantRequest {
    secret_ref: String,
    actor_scope: LegacyShellxGrantScope,
    operation: LegacyShellxGrantOperation,
    #[serde(default)]
    expires_at_ms: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum LegacyShellxGrantScope {
    Agent { agent_id: String },
    Provider { provider_id: String },
    Workspace { workspace: String },
    BrowserOrigin { origin: String },
    Connector { connector_id: String },
    AllShellxAgents,
}

impl LegacyShellxGrantScope {
    fn to_actor(&self) -> VaultActor {
        match self {
            Self::Agent { agent_id } => legacy_actor(
                format!("shellx:agent:{agent_id}"),
                ActorKind::McpAgent,
                agent_id,
            ),
            Self::Provider { provider_id } => legacy_actor(
                format!("shellx:provider:{provider_id}"),
                ActorKind::Connector,
                provider_id,
            ),
            Self::Workspace { workspace } => legacy_actor(
                format!("shellx:workspace:{workspace}"),
                ActorKind::Shellx,
                workspace,
            ),
            Self::BrowserOrigin { origin } => legacy_actor(
                format!("shellx:browser:{origin}"),
                ActorKind::Browser,
                origin,
            ),
            Self::Connector { connector_id } => legacy_actor(
                format!("shellx:connector:{connector_id}"),
                ActorKind::Connector,
                connector_id,
            ),
            Self::AllShellxAgents => legacy_actor(
                "shellx:all-agents".to_string(),
                ActorKind::Shellx,
                "All ShellX agents",
            ),
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
enum LegacyShellxGrantOperation {
    Fill,
    ProfileFill,
    EmailCodeRead,
    AgentWalletUse,
    InjectEnv,
    ProviderUse,
    ConnectorUse,
    Deposit,
    RawReveal,
}

impl LegacyShellxGrantOperation {
    fn to_grant_action(&self) -> GrantAction {
        match self {
            Self::Fill => GrantAction::FillLogin,
            Self::ProfileFill => GrantAction::FillProfile,
            Self::EmailCodeRead => GrantAction::ReadEmailCode,
            Self::AgentWalletUse => GrantAction::UseWallet,
            Self::InjectEnv => GrantAction::InjectEnv,
            Self::ProviderUse => GrantAction::UseProvider,
            Self::ConnectorUse => GrantAction::UseConnector,
            Self::Deposit => GrantAction::Deposit,
            Self::RawReveal => GrantAction::RawReveal,
        }
    }
}

fn legacy_actor(actor_id: String, kind: ActorKind, display_name: &str) -> VaultActor {
    VaultActor {
        actor_id,
        kind,
        display_name: display_name.to_string(),
        device_id: "shellx-legacy".to_string(),
        public_key: None,
        created_at_ms: 0,
        revoked_at_ms: None,
    }
}
