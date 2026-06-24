use vault_broker::actors::{ActorKind, VaultActor};
use vault_broker::grants::{
    GrantAction, GrantConstraints, GrantDenyReason, GrantPolicy, GrantRequest, GrantStatus,
    GrantUseRequest,
};
use vault_broker::resources::ResourcePermission;
use vault_broker::safe_folder::{
    SafeFolder, SafeFolderAction, SafeFolderExportRequest, SafeFolderImportRequest,
    SafeFolderMoveInRequest, SafeFolderPreviewKind, SafeFolderSessionCache,
    SAFE_FOLDER_MANIFEST_PREFIX,
};
use vault_core::MasterKey;

#[test]
fn safe_folder_imports_are_sealed_reserved_and_hidden_from_agents() {
    let master = MasterKey::generate();
    let mut safe = SafeFolder::default();

    let entry = safe
        .import_plaintext(
            &master,
            SafeFolderImportRequest {
                display_name: "contract-review.txt".to_string(),
                media_type: "text/plain".to_string(),
                plaintext: b"client contract has private pricing".to_vec(),
                now_ms: 10,
            },
        )
        .unwrap();

    assert!(entry.manifest_path.starts_with(SAFE_FOLDER_MANIFEST_PREFIX));
    assert!(!entry.manifest_path.contains("contract-review"));
    assert_eq!(safe.agent_visible_files().count(), 0);
    assert_eq!(
        safe.preview_text(&master, &entry.safe_id, 11).unwrap(),
        "client contract has private pricing"
    );
    assert_eq!(safe.receipts()[0].action, SafeFolderAction::Imported);
    assert_eq!(safe.receipts()[1].action, SafeFolderAction::Previewed);
    assert!(safe
        .receipts()
        .iter()
        .all(|receipt| !receipt.secret_exposed));
}

#[test]
fn safe_folder_move_in_revokes_file_and_sync_grants_for_that_path_only() {
    let master = MasterKey::generate();
    let mut safe = SafeFolder::default();
    let mut policy = grant_policy_for_path("private/contract.pdf");
    let read = grant_for_path(
        &mut policy,
        GrantAction::ReadFile,
        "private/contract.pdf",
        1,
    );
    let write = grant_for_path(
        &mut policy,
        GrantAction::WriteFile,
        "private/contract.pdf",
        2,
    );
    let pull = grant_for_path(
        &mut policy,
        GrantAction::PullSyncSet,
        "private/contract.pdf",
        3,
    );
    let push = grant_for_path(
        &mut policy,
        GrantAction::PushSyncSet,
        "private/contract.pdf",
        4,
    );
    let unrelated = grant_for_path(&mut policy, GrantAction::ReadFile, "public/readme.md", 5);

    let moved = safe
        .move_sync_file_into_safe(
            &master,
            &mut policy,
            SafeFolderMoveInRequest {
                source_path: "private/contract.pdf".to_string(),
                display_name: "contract.pdf".to_string(),
                media_type: "application/pdf".to_string(),
                plaintext: b"%PDF-private".to_vec(),
                now_ms: 20,
            },
        )
        .unwrap();

    assert_eq!(moved.source_path, "private/contract.pdf");
    for grant_id in [&read, &write, &pull, &push] {
        assert_eq!(policy.grant(grant_id).unwrap().status, GrantStatus::Revoked);
        assert_eq!(policy.grant(grant_id).unwrap().revoked_at_ms, Some(20));
    }
    assert_eq!(
        policy.grant(&unrelated).unwrap().status,
        GrantStatus::Approved
    );
    assert_eq!(
        policy.authorize(GrantUseRequest {
            grant_id: read,
            actor_id: "agent-1".to_string(),
            resource_id: "sync:files".to_string(),
            action: GrantAction::ReadFile,
            origin: None,
            path: Some("private/contract.pdf".to_string()),
            now_ms: 21,
        }),
        vault_broker::grants::GrantDecision::Deny {
            reason: GrantDenyReason::GrantRevoked,
            receipt: policy.receipts().last().unwrap().clone(),
        }
    );
}

#[test]
fn safe_folder_export_to_sync_requires_user_action_and_records_hash_receipt() {
    let master = MasterKey::generate();
    let mut safe = SafeFolder::default();
    let entry = safe
        .import_plaintext(
            &master,
            SafeFolderImportRequest {
                display_name: "tax-notes.md".to_string(),
                media_type: "text/markdown".to_string(),
                plaintext: b"# private tax notes".to_vec(),
                now_ms: 30,
            },
        )
        .unwrap();

    let exported = safe
        .export_to_sync(
            &master,
            SafeFolderExportRequest {
                safe_id: entry.safe_id.clone(),
                destination_path: "shared/tax-notes.md".to_string(),
                now_ms: 31,
            },
        )
        .unwrap();

    assert_eq!(exported.destination_path, "shared/tax-notes.md");
    assert_eq!(exported.plaintext, b"# private tax notes");
    let receipt = safe.receipts().last().unwrap();
    assert_eq!(receipt.action, SafeFolderAction::ExportedToSync);
    assert_eq!(receipt.safe_id, entry.safe_id);
    assert_eq!(receipt.content_hash, exported.content_hash);
    assert!(!receipt.secret_exposed);
}

#[test]
fn safe_folder_search_and_copy_text_are_user_only_receipted_actions() {
    let master = MasterKey::generate();
    let mut safe = SafeFolder::default();
    let entry = safe
        .import_plaintext(
            &master,
            SafeFolderImportRequest {
                display_name: "tax-notes.md".to_string(),
                media_type: "text/markdown".to_string(),
                plaintext: b"deductions checklist and private account references".to_vec(),
                now_ms: 35,
            },
        )
        .unwrap();

    let results = safe.search_text(&master, "deductions", 36).unwrap();
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].safe_id, entry.safe_id);
    assert_eq!(results[0].display_name, "tax-notes.md");
    assert!(!results[0].secret_exposed);

    let copied = safe
        .copy_text(&master, &entry.safe_id, "private account", 37)
        .unwrap();
    assert_eq!(copied, "private account");
    assert_eq!(safe.receipts()[1].action, SafeFolderAction::Searched);
    assert_eq!(safe.receipts()[2].action, SafeFolderAction::CopiedText);
    assert!(safe
        .receipts()
        .iter()
        .all(|receipt| !receipt.secret_exposed));
}

#[test]
fn safe_folder_preview_adapters_cover_text_json_image_and_pdf_metadata() {
    let master = MasterKey::generate();
    let mut safe = SafeFolder::default();
    let text = safe_entry(&mut safe, &master, "note.txt", "text/plain", b"hello", 50);
    let markdown = safe_entry(
        &mut safe,
        &master,
        "note.md",
        "text/markdown",
        b"# hello",
        51,
    );
    let json = safe_entry(
        &mut safe,
        &master,
        "profile.json",
        "application/json",
        br#"{"email":"owner@example.com","phone":"private"}"#,
        52,
    );
    let image = safe_entry(&mut safe, &master, "scan.png", "image/png", b"\x89PNG", 53);
    let pdf = safe_entry(
        &mut safe,
        &master,
        "contract.pdf",
        "application/pdf",
        b"%PDF-1.7",
        54,
    );

    assert_eq!(
        safe.preview(&master, &text.safe_id, 60).unwrap().kind,
        SafeFolderPreviewKind::Text
    );
    assert_eq!(
        safe.preview(&master, &markdown.safe_id, 61).unwrap().kind,
        SafeFolderPreviewKind::Markdown
    );
    let json_preview = safe.preview(&master, &json.safe_id, 62).unwrap();
    assert_eq!(json_preview.kind, SafeFolderPreviewKind::Json);
    assert!(json_preview.summary.contains("email"));
    assert_eq!(
        safe.preview(&master, &image.safe_id, 63).unwrap().kind,
        SafeFolderPreviewKind::ImageMetadata
    );
    assert_eq!(
        safe.preview(&master, &pdf.safe_id, 64).unwrap().kind,
        SafeFolderPreviewKind::PdfMetadata
    );
}

#[test]
fn safe_folder_session_cache_clears_owned_plaintext_on_lock() {
    let temp = tempfile::tempdir().unwrap();
    let cache = SafeFolderSessionCache::new(temp.path()).unwrap();
    let preview_path = cache
        .write_preview("safe-1", b"temporary plaintext preview")
        .unwrap();
    assert!(preview_path.exists());

    cache.clear_on_lock().unwrap();

    assert!(!preview_path.exists());
    assert!(!cache.session_dir().exists());
}

fn safe_entry(
    safe: &mut SafeFolder,
    master: &MasterKey,
    display_name: &str,
    media_type: &str,
    plaintext: &[u8],
    now_ms: i64,
) -> vault_broker::safe_folder::SafeFolderEntry {
    safe.import_plaintext(
        master,
        SafeFolderImportRequest {
            display_name: display_name.to_string(),
            media_type: media_type.to_string(),
            plaintext: plaintext.to_vec(),
            now_ms,
        },
    )
    .unwrap()
}

#[test]
fn safe_folder_debug_state_never_contains_plaintext_or_display_names() {
    let master = MasterKey::generate();
    let mut safe = SafeFolder::default();
    let entry = safe
        .import_plaintext(
            &master,
            SafeFolderImportRequest {
                display_name: "medical-record.txt".to_string(),
                media_type: "text/plain".to_string(),
                plaintext: b"diagnosis private details".to_vec(),
                now_ms: 40,
            },
        )
        .unwrap();
    safe.preview_text(&master, &entry.safe_id, 41).unwrap();

    let state = serde_json::to_string(&safe.debug_state()).unwrap();

    assert!(!state.contains("diagnosis"));
    assert!(!state.contains("medical-record"));
    assert!(state.contains(&entry.safe_id));
    assert!(state.contains("\"secretExposed\":false"));
}

fn grant_policy_for_path(path: &str) -> GrantPolicy {
    let mut policy = GrantPolicy::default();
    policy.register_actor(VaultActor {
        actor_id: "agent-1".to_string(),
        kind: ActorKind::McpAgent,
        display_name: "agent-1".to_string(),
        device_id: "device-1".to_string(),
        public_key: None,
        created_at_ms: 1,
        revoked_at_ms: None,
    });
    policy.set_resource_permission("sync:files", ResourcePermission::VisibleAsk);
    policy.set_resource_permission(path, ResourcePermission::VisibleAsk);
    policy
}

fn grant_for_path(
    policy: &mut GrantPolicy,
    action: GrantAction,
    path: &str,
    created_at_ms: i64,
) -> String {
    let grant = policy
        .create_grant(GrantRequest {
            actor_id: "agent-1".to_string(),
            resource_id: "sync:files".to_string(),
            action,
            constraints: GrantConstraints {
                path_prefix: Some(path.to_string()),
                ..GrantConstraints::default()
            },
            created_at_ms,
        })
        .unwrap();
    policy
        .approve_grant(&grant.grant_id, created_at_ms + 100)
        .unwrap();
    grant.grant_id
}
