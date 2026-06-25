use std::collections::BTreeMap;
use std::path::PathBuf;

use vault_broker::actors::{ActorKind, VaultActor};
use vault_broker::backup::{
    open_backup_bundle, seal_backup_bundle, validate_import, BackupImportMode, VaultBackupBundle,
    BROKER_BACKUP_SCHEMA_VERSION, PLAINTEXT_SAFE_FOLDER_EXPORT_WARNING,
};
use vault_broker::devices::{DeviceKind, VaultDevice};
use vault_broker::grants::{
    GrantAction, GrantConstraints, GrantDecision, GrantPolicy, GrantRequest, GrantStatus,
    GrantUseRequest,
};
use vault_broker::profile::{ProfileDirInput, ProfilePlatform};
use vault_broker::project_capsules::{CapsuleCandidate, CapsuleOptions};
use vault_broker::resources::{
    ResourcePermission, VaultResource, VaultResourceKind, VAULT_RESOURCE_SCHEMA_VERSION,
};
use vault_broker::safe_folder::{
    SafeFolder, SafeFolderAction, SafeFolderExportRequest, SafeFolderImportRequest,
};
use vault_broker::sync_sets::{SyncSet, SyncSetKind};
use vault_broker::VaultBroker;

fn make_broker() -> VaultBroker {
    VaultBroker::for_profile_input(ProfileDirInput {
        platform: ProfilePlatform::Linux,
        home: Some(PathBuf::from("/tmp/shellx-vault-backup-home")),
        xdg_config_home: Some(PathBuf::from("/tmp/shellx-vault-backup-xdg")),
        appdata: None,
        override_dir: None,
    })
    .unwrap()
}

fn actor() -> VaultActor {
    VaultActor {
        actor_id: "agent:backup".to_string(),
        kind: ActorKind::McpAgent,
        display_name: "Backup Agent".to_string(),
        device_id: "device-a".to_string(),
        public_key: None,
        created_at_ms: 1,
        revoked_at_ms: None,
    }
}

fn resource(id: &str) -> VaultResource {
    let mut secret_fields = BTreeMap::new();
    secret_fields.insert("password".to_string(), "RESOURCE_SECRET_VALUE".to_string());
    VaultResource {
        id: id.to_string(),
        schema_version: VAULT_RESOURCE_SCHEMA_VERSION.to_string(),
        kind: VaultResourceKind::Login,
        label: "Main login".to_string(),
        permission: ResourcePermission::VisibleAsk,
        public_fields: BTreeMap::new(),
        secret_fields,
        custom_fields: Vec::new(),
        created_ms: 1,
        updated_ms: 2,
        extra: BTreeMap::new(),
    }
}

fn grant_policy_with_receipt() -> (GrantPolicy, String) {
    let mut policy = GrantPolicy::default();
    let actor = actor();
    policy.register_actor(actor.clone());
    policy.set_resource_permission("login/main", ResourcePermission::VisibleAsk);
    let grant = policy
        .create_grant(GrantRequest {
            actor_id: actor.actor_id.clone(),
            resource_id: "login/main".to_string(),
            action: GrantAction::FillLogin,
            constraints: GrantConstraints::default(),
            created_at_ms: 10,
        })
        .unwrap();
    let grant = policy.approve_grant(&grant.grant_id, 11).unwrap();
    let decision = policy.authorize(GrantUseRequest {
        grant_id: grant.grant_id.clone(),
        actor_id: actor.actor_id,
        resource_id: "login/main".to_string(),
        action: GrantAction::FillLogin,
        origin: None,
        path: None,
        now_ms: 12,
    });
    assert!(matches!(decision, GrantDecision::AllowMediated { .. }));
    (policy, grant.grant_id)
}

#[test]
fn backup_bundle_roundtrips_full_broker_state_without_plaintext_safe_folder() {
    let master = vault_core::MasterKey::generate();
    let (policy, grant_id) = grant_policy_with_receipt();

    let mut broker = make_broker();
    broker.resources_mut().push(resource("login/main"));
    *broker.grant_policy_mut() = policy;
    broker.devices_mut().register(VaultDevice {
        device_id: "device-a".to_string(),
        label: "Workstation".to_string(),
        kind: DeviceKind::Linux,
        created_at_ms: 5,
        revoked_at_ms: None,
    });

    broker.sync_sets_mut().insert(SyncSet::new(
        "docs",
        "Docs",
        SyncSetKind::Docs,
        "/home/user/docs",
    ));
    broker
        .sync_sets_mut()
        .add_device("docs", "mac-mini")
        .unwrap();

    broker
        .project_capsules_mut()
        .create_capsule(
            "capsule-a",
            "Main project",
            "/src/project",
            "pc-main",
            CapsuleOptions::default(),
            vec![CapsuleCandidate::file("src/lib.rs", 10, "hash-a")],
            20,
        )
        .unwrap();

    let safe_entry = broker
        .safe_folder_mut()
        .import_plaintext(
            &master,
            SafeFolderImportRequest {
                display_name: "tax-notes.txt".to_string(),
                media_type: "text/plain".to_string(),
                plaintext: b"TOP_SECRET_SAFE_FOLDER_TEXT".to_vec(),
                now_ms: 30,
            },
        )
        .unwrap();

    let bundle = broker.export_backup_bundle(40);

    let sealed = seal_backup_bundle(&bundle, "backup-pass").unwrap();
    assert!(open_backup_bundle(&sealed, "wrong-pass").is_err());
    let text = String::from_utf8_lossy(&sealed);
    assert!(!text.contains("TOP_SECRET_SAFE_FOLDER_TEXT"));
    assert!(!text.contains("RESOURCE_SECRET_VALUE"));

    let restored = open_backup_bundle(&sealed, "backup-pass").unwrap();
    let mut restored_broker = make_broker();
    let preview = restored_broker.backup_import_preview(&restored).unwrap();
    assert_eq!(preview.resource_count, 1);
    assert_eq!(preview.actor_count, 1);
    assert_eq!(preview.grant_count, 1);
    assert_eq!(preview.grant_receipt_count, 1);
    assert_eq!(preview.device_count, 1);
    assert_eq!(preview.sync_set_count, 1);
    assert_eq!(preview.project_capsule_count, 1);
    assert_eq!(preview.safe_folder_object_count, 1);
    assert!(!preview.plaintext_safe_folder_export);

    restored_broker.restore_backup_bundle(restored).unwrap();
    assert_eq!(restored_broker.resources().len(), 1);
    assert!(restored_broker.devices().is_active("device-a"));
    assert_eq!(restored_broker.grant_policy().receipts().len(), 1);
    assert_eq!(restored_broker.sync_sets().to_snapshot().sets.len(), 1);
    assert_eq!(
        restored_broker
            .project_capsules()
            .to_snapshot()
            .capsules
            .len(),
        1
    );
    assert_eq!(
        restored_broker
            .grant_policy()
            .grant(&grant_id)
            .unwrap()
            .status,
        GrantStatus::Approved
    );
    let preview = restored_broker
        .safe_folder()
        .debug_state()
        .entries
        .into_iter()
        .find(|entry| entry.safe_id == safe_entry.safe_id)
        .unwrap();
    assert_eq!(preview.content_hash, safe_entry.content_hash);
}

#[test]
fn import_preview_flags_duplicates_and_partial_import() {
    let (policy, _) = grant_policy_with_receipt();
    let bundle = VaultBackupBundle {
        schema_version: BROKER_BACKUP_SCHEMA_VERSION.to_string(),
        exported_at_ms: 40,
        resources: vec![resource("login/main"), resource("login/secondary")],
        device_registry: Default::default(),
        grant_policy: policy.to_snapshot(),
        grant_receipts: policy.receipts().to_vec(),
        sync_sets: Default::default(),
        project_capsules: Default::default(),
        safe_folder: Default::default(),
    };

    let preview = validate_import(
        &bundle,
        ["login/main".to_string()],
        BackupImportMode::DryRun,
    )
    .unwrap();
    assert_eq!(preview.duplicate_resources, vec!["login/main"]);
    assert_eq!(preview.resources_to_import, vec!["login/secondary"]);
    assert!(preview.partial_import);

    let mut broker = make_broker();
    broker.resources_mut().push(resource("login/main"));
    let preview = broker.backup_import_preview(&bundle).unwrap();
    assert_eq!(preview.duplicate_resources, vec!["login/main"]);
    assert!(broker.restore_backup_bundle(bundle).is_err());
}

#[test]
fn corrupted_backup_bundle_is_rejected_before_import() {
    let bundle = VaultBackupBundle {
        schema_version: BROKER_BACKUP_SCHEMA_VERSION.to_string(),
        exported_at_ms: 40,
        resources: vec![resource("login/main")],
        device_registry: Default::default(),
        grant_policy: GrantPolicy::default().to_snapshot(),
        grant_receipts: Vec::new(),
        sync_sets: Default::default(),
        project_capsules: Default::default(),
        safe_folder: Default::default(),
    };
    let sealed = seal_backup_bundle(&bundle, "backup-pass").unwrap();
    let mut envelope: serde_json::Value = serde_json::from_slice(&sealed).unwrap();
    let sealed_field = envelope["sealed"].as_str().unwrap();
    let replacement = if sealed_field.starts_with('0') {
        "1"
    } else {
        "0"
    };
    let corrupted = format!("{replacement}{}", &sealed_field[1..]);
    envelope["sealed"] = serde_json::Value::String(corrupted);
    let sealed = serde_json::to_vec_pretty(&envelope).unwrap();

    assert!(open_backup_bundle(&sealed, "backup-pass").is_err());
}

#[test]
fn safe_folder_plaintext_export_requires_warning_and_receipt() {
    let master = vault_core::MasterKey::generate();
    let mut safe_folder = SafeFolder::default();
    let entry = safe_folder
        .import_plaintext(
            &master,
            SafeFolderImportRequest {
                display_name: "contract.txt".to_string(),
                media_type: "text/plain".to_string(),
                plaintext: b"private contract".to_vec(),
                now_ms: 10,
            },
        )
        .unwrap();

    assert!(PLAINTEXT_SAFE_FOLDER_EXPORT_WARNING.contains("plaintext"));
    let exported = safe_folder
        .export_to_sync(
            &master,
            SafeFolderExportRequest {
                safe_id: entry.safe_id.clone(),
                destination_path: "shared/contract.txt".to_string(),
                now_ms: 11,
            },
        )
        .unwrap();

    assert_eq!(exported.plaintext, b"private contract");
    let receipt = safe_folder.receipts().last().unwrap();
    assert_eq!(receipt.action, SafeFolderAction::ExportedToSync);
    assert_eq!(receipt.safe_id, entry.safe_id);
    assert!(!receipt.secret_exposed);
}
