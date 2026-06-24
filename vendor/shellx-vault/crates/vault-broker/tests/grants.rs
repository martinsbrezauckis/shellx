use serde_json::json;
use vault_broker::actors::{ActorKind, VaultActor};
use vault_broker::grants::{
    GrantAction, GrantConstraints, GrantDecision, GrantDenyReason, GrantPolicy, GrantRequest,
    GrantStatus, GrantUseRequest,
};
use vault_broker::resources::ResourcePermission;

#[test]
fn grants_pending_approved_revoked_and_expired_decisions_emit_redacted_receipts() {
    let mut policy = GrantPolicy::default();
    policy.register_actor(actor("agent-1", ActorKind::McpAgent));
    policy.set_resource_permission("res-login", ResourcePermission::VisibleAsk);

    let grant = policy
        .create_grant(GrantRequest {
            actor_id: "agent-1".to_string(),
            resource_id: "res-login".to_string(),
            action: GrantAction::FillLogin,
            constraints: GrantConstraints::default(),
            created_at_ms: 10,
        })
        .unwrap();
    assert_eq!(grant.status, GrantStatus::Pending);

    let pending = policy.authorize(GrantUseRequest {
        grant_id: grant.grant_id.clone(),
        actor_id: "agent-1".to_string(),
        resource_id: "res-login".to_string(),
        action: GrantAction::FillLogin,
        origin: None,
        path: None,
        now_ms: 11,
    });
    assert_denied(pending, GrantDenyReason::GrantPending);

    policy.approve_grant(&grant.grant_id, 12).unwrap();
    let allowed = policy.authorize(GrantUseRequest {
        grant_id: grant.grant_id.clone(),
        actor_id: "agent-1".to_string(),
        resource_id: "res-login".to_string(),
        action: GrantAction::FillLogin,
        origin: None,
        path: None,
        now_ms: 13,
    });
    assert_allowed(allowed);

    policy.revoke_grant(&grant.grant_id, 14).unwrap();
    let revoked = policy.authorize(GrantUseRequest {
        grant_id: grant.grant_id.clone(),
        actor_id: "agent-1".to_string(),
        resource_id: "res-login".to_string(),
        action: GrantAction::FillLogin,
        origin: None,
        path: None,
        now_ms: 15,
    });
    assert_denied(revoked, GrantDenyReason::GrantRevoked);

    let expiring = policy
        .create_grant(GrantRequest {
            actor_id: "agent-1".to_string(),
            resource_id: "res-login".to_string(),
            action: GrantAction::FillLogin,
            constraints: GrantConstraints {
                expires_at_ms: Some(20),
                ..GrantConstraints::default()
            },
            created_at_ms: 16,
        })
        .unwrap();
    policy.approve_grant(&expiring.grant_id, 17).unwrap();
    let expired = policy.authorize(GrantUseRequest {
        grant_id: expiring.grant_id,
        actor_id: "agent-1".to_string(),
        resource_id: "res-login".to_string(),
        action: GrantAction::FillLogin,
        origin: None,
        path: None,
        now_ms: 21,
    });
    assert_denied(expired, GrantDenyReason::GrantExpired);

    assert_eq!(policy.receipts().len(), 4);
    assert!(policy
        .receipts()
        .iter()
        .all(|receipt| !receipt.secret_exposed));
}

#[test]
fn grants_hide_user_only_resources_and_reject_agent_grants_for_them() {
    let mut policy = GrantPolicy::default();
    policy.register_actor(actor("agent-1", ActorKind::McpAgent));
    policy.set_resource_permission("res-secret", ResourcePermission::VisibleAsk);
    policy.set_resource_permission("res-user-only", ResourcePermission::UserOnly);

    assert_eq!(
        policy.agent_visible_resources().collect::<Vec<_>>(),
        vec!["res-secret"]
    );

    let denied = policy.create_grant(GrantRequest {
        actor_id: "agent-1".to_string(),
        resource_id: "res-user-only".to_string(),
        action: GrantAction::InjectEnv,
        constraints: GrantConstraints::default(),
        created_at_ms: 1,
    });
    assert_eq!(denied.unwrap_err(), GrantDenyReason::UserOnlyResource);
}

#[test]
fn grants_deny_actor_mismatch_revoked_actor_and_raw_reveal() {
    let mut policy = GrantPolicy::default();
    policy.register_actor(actor("agent-1", ActorKind::McpAgent));
    policy.register_actor(actor("agent-2", ActorKind::McpAgent));
    policy.set_resource_permission("res-secret", ResourcePermission::VisibleAsk);
    let grant = policy
        .create_grant(GrantRequest {
            actor_id: "agent-1".to_string(),
            resource_id: "res-secret".to_string(),
            action: GrantAction::InjectEnv,
            constraints: GrantConstraints::default(),
            created_at_ms: 1,
        })
        .unwrap();
    policy.approve_grant(&grant.grant_id, 2).unwrap();

    let mismatch = policy.authorize(GrantUseRequest {
        grant_id: grant.grant_id.clone(),
        actor_id: "agent-2".to_string(),
        resource_id: "res-secret".to_string(),
        action: GrantAction::InjectEnv,
        origin: None,
        path: None,
        now_ms: 3,
    });
    assert_denied(mismatch, GrantDenyReason::GrantActorMismatch);

    policy.revoke_actor("agent-1", 4).unwrap();
    let revoked_actor = policy.authorize(GrantUseRequest {
        grant_id: grant.grant_id.clone(),
        actor_id: "agent-1".to_string(),
        resource_id: "res-secret".to_string(),
        action: GrantAction::InjectEnv,
        origin: None,
        path: None,
        now_ms: 5,
    });
    assert_denied(revoked_actor, GrantDenyReason::ActorRevoked);

    let raw = policy.authorize(GrantUseRequest {
        grant_id: grant.grant_id,
        actor_id: "agent-1".to_string(),
        resource_id: "res-secret".to_string(),
        action: GrantAction::RawReveal,
        origin: None,
        path: None,
        now_ms: 6,
    });
    assert_denied(raw, GrantDenyReason::RawRevealDenied);
}

#[test]
fn grants_enforce_origin_path_max_use_and_bulk_revocation_constraints() {
    let mut policy = GrantPolicy::default();
    policy.register_actor(actor("browser-1", ActorKind::Browser));
    policy.set_resource_permission("res-login", ResourcePermission::VisibleAsk);
    policy.set_resource_permission("sync:docs", ResourcePermission::VisibleAsk);

    let origin_bound = policy
        .create_grant(GrantRequest {
            actor_id: "browser-1".to_string(),
            resource_id: "res-login".to_string(),
            action: GrantAction::FillLogin,
            constraints: GrantConstraints {
                origin: Some("https://example.com".to_string()),
                max_uses: Some(1),
                ..GrantConstraints::default()
            },
            created_at_ms: 1,
        })
        .unwrap();
    policy.approve_grant(&origin_bound.grant_id, 2).unwrap();

    assert_denied(
        policy.authorize(GrantUseRequest {
            grant_id: origin_bound.grant_id.clone(),
            actor_id: "browser-1".to_string(),
            resource_id: "res-login".to_string(),
            action: GrantAction::FillLogin,
            origin: Some("https://evil.example".to_string()),
            path: None,
            now_ms: 3,
        }),
        GrantDenyReason::OriginMismatch,
    );
    assert_allowed(policy.authorize(GrantUseRequest {
        grant_id: origin_bound.grant_id.clone(),
        actor_id: "browser-1".to_string(),
        resource_id: "res-login".to_string(),
        action: GrantAction::FillLogin,
        origin: Some("https://example.com".to_string()),
        path: None,
        now_ms: 4,
    }));
    assert_denied(
        policy.authorize(GrantUseRequest {
            grant_id: origin_bound.grant_id.clone(),
            actor_id: "browser-1".to_string(),
            resource_id: "res-login".to_string(),
            action: GrantAction::FillLogin,
            origin: Some("https://example.com".to_string()),
            path: None,
            now_ms: 5,
        }),
        GrantDenyReason::MaxUsesExceeded,
    );

    let path_bound = policy
        .create_grant(GrantRequest {
            actor_id: "browser-1".to_string(),
            resource_id: "sync:docs".to_string(),
            action: GrantAction::ReadFile,
            constraints: GrantConstraints {
                path_prefix: Some("docs/".to_string()),
                ..GrantConstraints::default()
            },
            created_at_ms: 6,
        })
        .unwrap();
    policy.approve_grant(&path_bound.grant_id, 7).unwrap();
    assert_denied(
        policy.authorize(GrantUseRequest {
            grant_id: path_bound.grant_id.clone(),
            actor_id: "browser-1".to_string(),
            resource_id: "sync:docs".to_string(),
            action: GrantAction::ReadFile,
            origin: None,
            path: Some("private/contract.pdf".to_string()),
            now_ms: 8,
        }),
        GrantDenyReason::PathMismatch,
    );
    assert_eq!(policy.revoke_grants_for_resource("sync:docs", 9), 1);
    assert_denied(
        policy.authorize(GrantUseRequest {
            grant_id: path_bound.grant_id,
            actor_id: "browser-1".to_string(),
            resource_id: "sync:docs".to_string(),
            action: GrantAction::ReadFile,
            origin: None,
            path: Some("docs/readme.md".to_string()),
            now_ms: 10,
        }),
        GrantDenyReason::GrantRevoked,
    );

    let action_grant = policy
        .create_grant(GrantRequest {
            actor_id: "browser-1".to_string(),
            resource_id: "res-login".to_string(),
            action: GrantAction::InjectEnv,
            constraints: GrantConstraints::default(),
            created_at_ms: 11,
        })
        .unwrap();
    policy.approve_grant(&action_grant.grant_id, 12).unwrap();
    assert_eq!(
        policy.revoke_grants_for_action(GrantAction::InjectEnv, 13),
        1
    );
    assert_denied(
        policy.authorize(GrantUseRequest {
            grant_id: action_grant.grant_id,
            actor_id: "browser-1".to_string(),
            resource_id: "res-login".to_string(),
            action: GrantAction::InjectEnv,
            origin: None,
            path: None,
            now_ms: 14,
        }),
        GrantDenyReason::GrantRevoked,
    );
}

#[test]
fn grants_snapshot_survives_restart_and_legacy_shellx_grants_import_pending() {
    let mut policy = GrantPolicy::default();
    policy.register_actor(actor("agent-1", ActorKind::McpAgent));
    policy.set_resource_permission("res-secret", ResourcePermission::VisibleAsk);
    let grant = policy
        .create_grant(GrantRequest {
            actor_id: "agent-1".to_string(),
            resource_id: "res-secret".to_string(),
            action: GrantAction::UseWallet,
            constraints: GrantConstraints::default(),
            created_at_ms: 1,
        })
        .unwrap();
    policy.approve_grant(&grant.grant_id, 2).unwrap();

    let snapshot = policy.to_snapshot();
    let restarted = GrantPolicy::from_snapshot(snapshot);
    let restarted_grant = restarted.grant(&grant.grant_id).unwrap();
    assert_eq!(restarted_grant.status, GrantStatus::Approved);
    assert_eq!(restarted_grant.approved_at_ms, Some(2));

    let legacy_json = json!({
        "grant-legacy": {
            "request": {
                "secretRef": "legacy/secret",
                "actorScope": { "kind": "allShellxAgents" },
                "operation": "fill",
                "expiresAtMs": null
            },
            "revoked": false
        }
    })
    .to_string();
    let imported = GrantPolicy::from_shellx_legacy_grants_json(&legacy_json).unwrap();
    let legacy = imported.grant("grant-legacy").unwrap();
    assert_eq!(legacy.actor_id, "shellx:all-agents");
    assert_eq!(legacy.resource_id, "legacy/secret");
    assert_eq!(legacy.action, GrantAction::FillLogin);
    assert_eq!(legacy.status, GrantStatus::Pending);
}

fn actor(actor_id: &str, kind: ActorKind) -> VaultActor {
    VaultActor {
        actor_id: actor_id.to_string(),
        kind,
        display_name: actor_id.to_string(),
        device_id: "device-1".to_string(),
        public_key: None,
        created_at_ms: 1,
        revoked_at_ms: None,
    }
}

fn assert_allowed(decision: GrantDecision) {
    match decision {
        GrantDecision::AllowMediated { receipt } => {
            assert!(!receipt.secret_exposed);
            assert_eq!(receipt.decision.as_str(), "allowed");
        }
        other => panic!("expected allow, got {other:?}"),
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
            assert_eq!(receipt.decision.as_str(), "denied");
        }
        other => panic!("expected deny {reason:?}, got {other:?}"),
    }
}
