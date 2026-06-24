use vault_broker::actors::{ActorKind, VaultActor};
use vault_broker::grants::{
    GrantAction, GrantConstraints, GrantDecision, GrantDenyReason, GrantPolicy, GrantRequest,
};
use vault_broker::resources::ResourcePermission;
use vault_broker::sync_sets::{
    AgentWritePolicy, SyncCandidate, SyncSet, SyncSetKind, SyncSetMode, SyncSetReceiptAction,
    SyncSetRegistry,
};

#[test]
fn sync_sets_default_policy_excludes_artifacts_and_blocks_large_files() {
    let set = SyncSet::new(
        "release-studio",
        "Release Studio",
        SyncSetKind::Tooling,
        "/work/release-studio",
    );

    assert!(set.policy.user_writable);
    assert_eq!(set.policy.agent_write_policy, AgentWritePolicy::Ask);
    assert!(set.policy.excludes_path(".git/config"));
    assert!(set.policy.excludes_path("node_modules/react/index.js"));
    assert!(set.policy.excludes_path("target/debug/app"));
    assert!(set.policy.excludes_path(".env"));
    assert!(set.policy.excludes_path("certs/dev.pem"));

    let mut registry = SyncSetRegistry::default();
    registry.insert(set);
    let dry_run = registry
        .dry_run_push(
            "release-studio",
            vec![
                SyncCandidate::file("src/main.rs", 1200),
                SyncCandidate::file("node_modules/react/index.js", 100),
                SyncCandidate::file("video.mov", 60 * 1024 * 1024),
            ],
            10,
        )
        .unwrap();

    assert_eq!(dry_run.included_paths, vec!["src/main.rs"]);
    assert_eq!(dry_run.excluded_paths, vec!["node_modules/react/index.js"]);
    assert_eq!(dry_run.blocked_large_paths, vec!["video.mov"]);
    assert!(registry
        .receipts()
        .iter()
        .any(|receipt| receipt.action == SyncSetReceiptAction::Excluded));
    assert!(registry
        .receipts()
        .iter()
        .any(|receipt| receipt.action == SyncSetReceiptAction::BlockedLargeFile));
}

#[test]
fn sync_sets_agent_push_requires_broker_grant_approval() {
    let mut registry = SyncSetRegistry::default();
    registry.insert(SyncSet::new(
        "docs",
        "Reusable docs",
        SyncSetKind::Docs,
        "/work/docs",
    ));
    let mut policy = GrantPolicy::default();
    policy.register_actor(actor("agent-1"));
    policy.set_resource_permission("sync-set:docs", ResourcePermission::VisibleAsk);

    let denied = registry.authorize_agent_push(
        &mut policy,
        "docs",
        "agent-1",
        "missing-grant",
        "docs/readme.md",
        20,
    );
    assert_denied(denied, GrantDenyReason::GrantNotFound);

    let grant = policy
        .create_grant(GrantRequest {
            actor_id: "agent-1".to_string(),
            resource_id: "sync-set:docs".to_string(),
            action: GrantAction::PushSyncSet,
            constraints: GrantConstraints {
                path_prefix: Some("docs/".to_string()),
                ..GrantConstraints::default()
            },
            created_at_ms: 21,
        })
        .unwrap();
    policy.approve_grant(&grant.grant_id, 22).unwrap();

    let allowed = registry.authorize_agent_push(
        &mut policy,
        "docs",
        "agent-1",
        &grant.grant_id,
        "docs/readme.md",
        23,
    );
    assert!(matches!(allowed, GrantDecision::AllowMediated { .. }));

    let missing_set = registry.authorize_agent_push(
        &mut policy,
        "missing",
        "agent-1",
        &grant.grant_id,
        "docs/readme.md",
        24,
    );
    assert_denied(missing_set, GrantDenyReason::ResourceNotFound);
}

#[test]
fn sync_sets_agent_deny_policy_rejects_existing_grants() {
    let mut registry = SyncSetRegistry::default();
    let mut denied_set = SyncSet::new(
        "contracts",
        "Contracts",
        SyncSetKind::Docs,
        "/work/contracts",
    );
    denied_set.policy.agent_write_policy = AgentWritePolicy::Deny;
    registry.insert(denied_set);

    let mut policy = GrantPolicy::default();
    policy.register_actor(actor("agent-1"));
    policy.set_resource_permission("sync-set:contracts", ResourcePermission::VisibleAsk);
    let grant = policy
        .create_grant(GrantRequest {
            actor_id: "agent-1".to_string(),
            resource_id: "sync-set:contracts".to_string(),
            action: GrantAction::PushSyncSet,
            constraints: GrantConstraints {
                path_prefix: Some("contracts/".to_string()),
                ..GrantConstraints::default()
            },
            created_at_ms: 25,
        })
        .unwrap();
    policy.approve_grant(&grant.grant_id, 26).unwrap();

    let denied = registry.authorize_agent_push(
        &mut policy,
        "contracts",
        "agent-1",
        &grant.grant_id,
        "contracts/acme.md",
        27,
    );
    assert_denied(denied, GrantDenyReason::AgentPolicyDenied);
}

#[test]
fn sync_sets_record_pull_push_conflict_and_user_writes_without_agent_grant() {
    let mut registry = SyncSetRegistry::default();
    registry.insert(SyncSet::new(
        "resources",
        "Reusable resources",
        SyncSetKind::Resources,
        "/work/resources",
    ));

    registry
        .record_user_push("resources", "assets/logo.png", 30)
        .unwrap();
    registry
        .record_pull("resources", "templates/readme.md", "mac-mini", 31)
        .unwrap();
    registry
        .record_conflict(
            "resources",
            "templates/readme.md",
            "workstation",
            "mac-mini",
            32,
        )
        .unwrap();

    let actions = registry
        .receipts()
        .iter()
        .map(|receipt| receipt.action.clone())
        .collect::<Vec<_>>();
    assert_eq!(
        actions,
        vec![
            SyncSetReceiptAction::Push,
            SyncSetReceiptAction::Pull,
            SyncSetReceiptAction::Conflict
        ]
    );
    assert!(registry
        .receipts()
        .iter()
        .all(|receipt| !receipt.secret_exposed));
}

#[test]
fn sync_sets_manage_devices_pause_resume_and_dry_run_diff() {
    let mut registry = SyncSetRegistry::default();
    registry.insert(SyncSet::new(
        "tools",
        "Tooling",
        SyncSetKind::Tooling,
        "/work/tools",
    ));

    registry.add_device("tools", "workstation").unwrap();
    registry.add_device("tools", "mac-mini").unwrap();
    assert_eq!(
        registry.get("tools").unwrap().devices,
        vec!["mac-mini", "workstation"]
    );

    registry.pause("tools").unwrap();
    assert_eq!(
        registry.get("tools").unwrap().policy.mode,
        SyncSetMode::Paused
    );
    registry.resume("tools", SyncSetMode::Manual).unwrap();
    assert_eq!(
        registry.get("tools").unwrap().policy.mode,
        SyncSetMode::Manual
    );

    registry.remove_device("tools", "mac-mini").unwrap();
    assert_eq!(registry.get("tools").unwrap().devices, vec!["workstation"]);
}

fn actor(actor_id: &str) -> VaultActor {
    VaultActor {
        actor_id: actor_id.to_string(),
        kind: ActorKind::McpAgent,
        display_name: actor_id.to_string(),
        device_id: "device-1".to_string(),
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
