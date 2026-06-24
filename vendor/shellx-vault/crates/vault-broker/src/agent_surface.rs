//! Shared agent/MCP/CLI/browser tool surface.

use crate::grants::{
    GrantAction, GrantConstraints, GrantDecision, GrantDenyReason, GrantPolicy, GrantRequest,
    GrantUseRequest, VaultGrant,
};

pub const AGENT_VISIBLE_TOOL_NAMES: [&str; 13] = [
    "vault_list_resources",
    "vault_request_grant",
    "vault_list_grants",
    "vault_generate_secret",
    "vault_deposit_secret",
    "vault_fill_login",
    "vault_fill_profile",
    "vault_read_email_code",
    "vault_use_agent_wallet",
    "vault_sync_set_pull",
    "vault_sync_set_push",
    "vault_project_capsule_create",
    "vault_project_capsule_apply",
];

pub const AGENT_DENIED_TOOL_NAMES: [&str; 6] = [
    "vault_raw_secret_reveal",
    "vault_safe_folder_list",
    "vault_safe_folder_read",
    "vault_safe_folder_search",
    "vault_safe_folder_export",
    "vault_payment_card_raw_reveal",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentSurfaceTool {
    VaultListResources,
    VaultRequestGrant,
    VaultListGrants,
    VaultGenerateSecret,
    VaultDepositSecret,
    VaultFillLogin,
    VaultFillProfile,
    VaultReadEmailCode,
    VaultUseAgentWallet,
    VaultSyncSetPull,
    VaultSyncSetPush,
    VaultProjectCapsuleCreate,
    VaultProjectCapsuleApply,
    VaultRawSecretReveal,
    VaultSafeFolderList,
    VaultSafeFolderRead,
    VaultSafeFolderSearch,
    VaultSafeFolderExport,
    VaultPaymentCardRawReveal,
}

impl AgentSurfaceTool {
    pub fn from_name(name: &str) -> Option<Self> {
        Some(match name {
            "vault_list_resources" => Self::VaultListResources,
            "vault_request_grant" => Self::VaultRequestGrant,
            "vault_list_grants" => Self::VaultListGrants,
            "vault_generate_secret" => Self::VaultGenerateSecret,
            "vault_deposit_secret" => Self::VaultDepositSecret,
            "vault_fill_login" => Self::VaultFillLogin,
            "vault_fill_profile" => Self::VaultFillProfile,
            "vault_read_email_code" => Self::VaultReadEmailCode,
            "vault_use_agent_wallet" => Self::VaultUseAgentWallet,
            "vault_sync_set_pull" => Self::VaultSyncSetPull,
            "vault_sync_set_push" => Self::VaultSyncSetPush,
            "vault_project_capsule_create" => Self::VaultProjectCapsuleCreate,
            "vault_project_capsule_apply" => Self::VaultProjectCapsuleApply,
            "vault_raw_secret_reveal" => Self::VaultRawSecretReveal,
            "vault_safe_folder_list" => Self::VaultSafeFolderList,
            "vault_safe_folder_read" => Self::VaultSafeFolderRead,
            "vault_safe_folder_search" => Self::VaultSafeFolderSearch,
            "vault_safe_folder_export" => Self::VaultSafeFolderExport,
            "vault_payment_card_raw_reveal" => Self::VaultPaymentCardRawReveal,
            _ => return None,
        })
    }

    pub fn name(self) -> &'static str {
        match self {
            Self::VaultListResources => "vault_list_resources",
            Self::VaultRequestGrant => "vault_request_grant",
            Self::VaultListGrants => "vault_list_grants",
            Self::VaultGenerateSecret => "vault_generate_secret",
            Self::VaultDepositSecret => "vault_deposit_secret",
            Self::VaultFillLogin => "vault_fill_login",
            Self::VaultFillProfile => "vault_fill_profile",
            Self::VaultReadEmailCode => "vault_read_email_code",
            Self::VaultUseAgentWallet => "vault_use_agent_wallet",
            Self::VaultSyncSetPull => "vault_sync_set_pull",
            Self::VaultSyncSetPush => "vault_sync_set_push",
            Self::VaultProjectCapsuleCreate => "vault_project_capsule_create",
            Self::VaultProjectCapsuleApply => "vault_project_capsule_apply",
            Self::VaultRawSecretReveal => "vault_raw_secret_reveal",
            Self::VaultSafeFolderList => "vault_safe_folder_list",
            Self::VaultSafeFolderRead => "vault_safe_folder_read",
            Self::VaultSafeFolderSearch => "vault_safe_folder_search",
            Self::VaultSafeFolderExport => "vault_safe_folder_export",
            Self::VaultPaymentCardRawReveal => "vault_payment_card_raw_reveal",
        }
    }

    pub fn is_denied(self) -> bool {
        matches!(
            self,
            Self::VaultRawSecretReveal
                | Self::VaultSafeFolderList
                | Self::VaultSafeFolderRead
                | Self::VaultSafeFolderSearch
                | Self::VaultSafeFolderExport
                | Self::VaultPaymentCardRawReveal
        )
    }

    pub fn grant_action(self) -> Option<GrantAction> {
        Some(match self {
            Self::VaultDepositSecret => GrantAction::Deposit,
            Self::VaultFillLogin => GrantAction::FillLogin,
            Self::VaultFillProfile => GrantAction::FillProfile,
            Self::VaultReadEmailCode => GrantAction::ReadEmailCode,
            Self::VaultUseAgentWallet => GrantAction::UseWallet,
            Self::VaultSyncSetPull => GrantAction::PullSyncSet,
            Self::VaultSyncSetPush => GrantAction::PushSyncSet,
            Self::VaultProjectCapsuleCreate => GrantAction::CreateProjectCapsule,
            Self::VaultProjectCapsuleApply => GrantAction::ApplyProjectCapsule,
            Self::VaultRawSecretReveal | Self::VaultPaymentCardRawReveal => GrantAction::RawReveal,
            Self::VaultSafeFolderExport => GrantAction::ExportFromSafe,
            Self::VaultSafeFolderList | Self::VaultSafeFolderRead | Self::VaultSafeFolderSearch => {
                GrantAction::ReadFile
            }
            Self::VaultListResources
            | Self::VaultRequestGrant
            | Self::VaultListGrants
            | Self::VaultGenerateSecret => return None,
        })
    }

    pub fn denied_reason(self) -> Option<GrantDenyReason> {
        Some(match self {
            Self::VaultRawSecretReveal | Self::VaultPaymentCardRawReveal => {
                GrantDenyReason::RawRevealDenied
            }
            Self::VaultSafeFolderList
            | Self::VaultSafeFolderRead
            | Self::VaultSafeFolderSearch
            | Self::VaultSafeFolderExport => GrantDenyReason::UserOnlyResource,
            _ => return None,
        })
    }
}

pub fn list_agent_resources(
    policy: &GrantPolicy,
    actor_id: &str,
) -> Result<Vec<String>, GrantDenyReason> {
    policy.require_actor_active(actor_id)?;
    Ok(policy
        .agent_visible_resources()
        .map(str::to_string)
        .collect())
}

pub fn request_agent_grant(
    policy: &mut GrantPolicy,
    actor_id: &str,
    tool: AgentSurfaceTool,
    resource_id: &str,
    constraints: GrantConstraints,
    now_ms: i64,
) -> Result<VaultGrant, GrantDenyReason> {
    if let Some(reason) = tool.denied_reason() {
        return Err(reason);
    }
    let action = tool
        .grant_action()
        .ok_or(GrantDenyReason::AgentPolicyDenied)?;
    policy.create_grant(GrantRequest {
        actor_id: actor_id.to_string(),
        resource_id: resource_id.to_string(),
        action,
        constraints,
        created_at_ms: now_ms,
    })
}

#[allow(clippy::too_many_arguments)]
pub fn authorize_agent_tool(
    policy: &mut GrantPolicy,
    actor_id: &str,
    tool: AgentSurfaceTool,
    resource_id: &str,
    grant_id: &str,
    origin: Option<String>,
    path: Option<String>,
    now_ms: i64,
) -> GrantDecision {
    let action = tool.grant_action().unwrap_or(GrantAction::UseConnector);
    let request = GrantUseRequest {
        grant_id: grant_id.to_string(),
        actor_id: actor_id.to_string(),
        resource_id: resource_id.to_string(),
        action,
        origin,
        path,
        now_ms,
    };
    if let Some(reason) = tool.denied_reason() {
        return policy.deny_request(request, reason);
    }
    if tool.grant_action().is_none() {
        return policy.deny_request(request, GrantDenyReason::AgentPolicyDenied);
    }
    policy.authorize(request)
}
