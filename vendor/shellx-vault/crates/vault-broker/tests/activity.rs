use vault_broker::activity::{ActivityKind, ActivityStatus, ActivitySurface};
use vault_broker::actors::{ActorKind, VaultActor};
use vault_broker::grants::{GrantAction, GrantConstraints, GrantRequest, GrantUseRequest};
use vault_broker::resources::ResourcePermission;
use vault_broker::VaultBroker;

#[test]
fn activity_snapshot_contains_redacted_grant_receipts() {
    let mut broker = VaultBroker::new().unwrap();
    broker
        .grant_policy_mut()
        .set_resource_permission("profile/main", ResourcePermission::VisibleAsk);
    broker.grant_policy_mut().register_actor(VaultActor {
        actor_id: "agent:browser".to_string(),
        kind: ActorKind::Browser,
        display_name: "Browser".to_string(),
        device_id: "device-a".to_string(),
        public_key: None,
        created_at_ms: 1,
        revoked_at_ms: None,
    });

    let grant = broker
        .grant_policy_mut()
        .create_grant(GrantRequest {
            actor_id: "agent:browser".to_string(),
            resource_id: "profile/main".to_string(),
            action: GrantAction::FillProfile,
            constraints: GrantConstraints::default(),
            created_at_ms: 10,
        })
        .unwrap();
    broker
        .grant_policy_mut()
        .approve_grant(&grant.grant_id, 11)
        .unwrap();
    let _ = broker.grant_policy_mut().authorize(GrantUseRequest {
        grant_id: grant.grant_id,
        actor_id: "agent:browser".to_string(),
        resource_id: "profile/main".to_string(),
        action: GrantAction::FillProfile,
        origin: Some("https://example.invalid".to_string()),
        path: None,
        now_ms: 12,
    });

    let activity = broker.activity_snapshot(20);

    assert!(activity.iter().any(|entry| {
        entry.kind == ActivityKind::Grant
            && entry.surface == ActivitySurface::AgentPermission
            && entry.status == ActivityStatus::Allowed
            && !entry.secret_exposed
            && entry.title.contains("profile/main")
            && entry.detail.contains("fillProfile")
            && entry.actor_label.as_deref() == Some("agent:browser")
            && entry.receipt_ref.as_deref() == Some("receipt-12-1")
    }));
    assert!(activity.iter().all(|entry| !entry.secret_exposed));
}

#[test]
fn activity_snapshot_loads_redacted_receipts_from_persisted_agent_state() {
    let raw = r#"{
      "grantPolicy": { "actors": { "actors": {} }, "resourcePermissions": {}, "grants": {}, "nextGrantSeq": 0 },
      "grantReceipts": [{
        "receiptId": "receipt-44-1",
        "actorId": "agent:codex",
        "resourceId": "login/github",
        "action": "fillLogin",
        "grantId": "grant-1",
        "decision": "allowed",
        "createdAtMs": 44,
        "secretExposed": false
      }]
    }"#;

    let activity = vault_broker::activity::activity_snapshot_from_agent_state_json(raw, 100)
        .expect("persisted agent state is readable");

    assert!(activity.iter().any(|entry| {
        entry.id == "grant:receipt-44-1"
            && entry.status == ActivityStatus::Allowed
            && entry.title == "login/github"
            && entry.receipt_ref.as_deref() == Some("receipt-44-1")
            && !entry.secret_exposed
    }));
}
