use vault_broker::actors::{ActorKind, VaultActor};
use vault_broker::agent_surface::{
    authorize_agent_tool, list_agent_resources, request_agent_grant, AgentSurfaceTool,
    AGENT_DENIED_TOOL_NAMES, AGENT_VISIBLE_TOOL_NAMES,
};
use vault_broker::devices::{DeviceKind, DeviceRegistry, VaultDevice};
use vault_broker::grants::{
    GrantConstraints, GrantDecision, GrantDenyReason, GrantPolicy, GrantStatus,
};
use vault_broker::resources::ResourcePermission;

#[test]
fn agent_surface_declares_visible_and_denied_tools() {
    assert_eq!(
        AGENT_VISIBLE_TOOL_NAMES,
        [
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
        ]
    );
    assert_eq!(
        AGENT_DENIED_TOOL_NAMES,
        [
            "vault_raw_secret_reveal",
            "vault_safe_folder_list",
            "vault_safe_folder_read",
            "vault_safe_folder_search",
            "vault_safe_folder_export",
            "vault_payment_card_raw_reveal",
        ]
    );
    assert_eq!(
        AgentSurfaceTool::from_name("vault_sync_set_push").unwrap(),
        AgentSurfaceTool::VaultSyncSetPush
    );
    assert!(AgentSurfaceTool::from_name("vault_raw_secret_reveal")
        .unwrap()
        .is_denied());
}

#[test]
fn device_registry_registers_revokes_and_lists_active_machines() {
    let mut devices = DeviceRegistry::default();
    devices.register(VaultDevice {
        device_id: "workstation".to_string(),
        label: "Windows workstation".to_string(),
        kind: DeviceKind::Windows,
        created_at_ms: 10,
        revoked_at_ms: None,
    });
    devices.register(VaultDevice {
        device_id: "mac-mini".to_string(),
        label: "Mac mini".to_string(),
        kind: DeviceKind::Macos,
        created_at_ms: 11,
        revoked_at_ms: None,
    });
    devices.revoke("mac-mini", 12).unwrap();

    assert!(devices.is_active("workstation"));
    assert!(!devices.is_active("mac-mini"));
    assert_eq!(
        devices
            .active_devices()
            .map(|device| device.device_id.as_str())
            .collect::<Vec<_>>(),
        vec!["workstation"]
    );
}

#[test]
fn agent_surface_hides_user_only_resources_and_denies_unregistered_actors() {
    let mut policy = GrantPolicy::default();
    policy.register_actor(actor("agent-1", ActorKind::McpAgent, "workstation"));
    policy.set_resource_permission("res-visible", ResourcePermission::VisibleAsk);
    policy.set_resource_permission("res-user-only", ResourcePermission::UserOnly);

    assert_eq!(
        list_agent_resources(&policy, "agent-1").unwrap(),
        vec!["res-visible".to_string()]
    );
    assert_eq!(
        list_agent_resources(&policy, "missing-agent").unwrap_err(),
        GrantDenyReason::ActorNotRegistered
    );
}

#[test]
fn agent_surface_requests_and_authorizes_grant_mediated_tools() {
    let mut policy = GrantPolicy::default();
    policy.register_actor(actor("browser-1", ActorKind::Browser, "workstation"));
    policy.set_resource_permission("login:github", ResourcePermission::VisibleAsk);

    let grant = request_agent_grant(
        &mut policy,
        "browser-1",
        AgentSurfaceTool::VaultFillLogin,
        "login:github",
        GrantConstraints {
            origin: Some("https://github.com".to_string()),
            max_uses: Some(1),
            ..GrantConstraints::default()
        },
        20,
    )
    .unwrap();
    assert_eq!(grant.status, GrantStatus::Pending);
    policy.approve_grant(&grant.grant_id, 21).unwrap();

    let allowed = authorize_agent_tool(
        &mut policy,
        "browser-1",
        AgentSurfaceTool::VaultFillLogin,
        "login:github",
        &grant.grant_id,
        Some("https://github.com".to_string()),
        None,
        22,
    );
    assert!(matches!(allowed, GrantDecision::AllowMediated { .. }));

    let exhausted = authorize_agent_tool(
        &mut policy,
        "browser-1",
        AgentSurfaceTool::VaultFillLogin,
        "login:github",
        &grant.grant_id,
        Some("https://github.com".to_string()),
        None,
        23,
    );
    assert_denied(exhausted, GrantDenyReason::MaxUsesExceeded);
}

#[test]
fn agent_surface_denies_raw_reveal_and_revoked_actors_lose_grants() {
    let mut policy = GrantPolicy::default();
    policy.register_actor(actor("agent-1", ActorKind::McpAgent, "workstation"));
    policy.set_resource_permission("wallet:stripe", ResourcePermission::VisibleAsk);

    let raw = request_agent_grant(
        &mut policy,
        "agent-1",
        AgentSurfaceTool::VaultRawSecretReveal,
        "wallet:stripe",
        GrantConstraints::default(),
        30,
    );
    assert_eq!(raw.unwrap_err(), GrantDenyReason::RawRevealDenied);

    let grant = request_agent_grant(
        &mut policy,
        "agent-1",
        AgentSurfaceTool::VaultUseAgentWallet,
        "wallet:stripe",
        GrantConstraints::default(),
        31,
    )
    .unwrap();
    policy.approve_grant(&grant.grant_id, 32).unwrap();
    policy.revoke_actor("agent-1", 33).unwrap();

    let revoked = authorize_agent_tool(
        &mut policy,
        "agent-1",
        AgentSurfaceTool::VaultUseAgentWallet,
        "wallet:stripe",
        &grant.grant_id,
        None,
        None,
        34,
    );
    assert_denied(revoked, GrantDenyReason::ActorRevoked);
}

fn actor(actor_id: &str, kind: ActorKind, device_id: &str) -> VaultActor {
    VaultActor {
        actor_id: actor_id.to_string(),
        kind,
        display_name: actor_id.to_string(),
        device_id: device_id.to_string(),
        public_key: None,
        created_at_ms: 1,
        revoked_at_ms: None,
    }
}

fn assert_denied(decision: GrantDecision, reason: GrantDenyReason) {
    match decision {
        GrantDecision::Deny {
            reason: got,
            receipt,
        } => {
            assert_eq!(got, reason);
            assert!(!receipt.secret_exposed);
        }
        other => panic!("expected deny {reason:?}, got {other:?}"),
    }
}
