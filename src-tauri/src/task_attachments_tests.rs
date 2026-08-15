use super::*;

fn registration(target: &str, byte: u8, extension: &str) -> TaskAttachmentRegistration {
    let digest = format!("sha256:{}", format!("{byte:02x}").repeat(32));
    TaskAttachmentRegistration {
        provider_relative_path: task_attachment_provider_relative_path(&digest, extension).unwrap(),
        digest,
        connection_id: "connection-a".to_string(),
        target_key: target.to_string(),
        canonical_cwd: "/work/a".to_string(),
        size_bytes: 42,
    }
}

#[test]
fn registration_is_target_bound_hash_linked_and_idempotent() {
    let mut ledger = TaskAttachmentLedger::default();
    let first = ledger
        .register(vec![registration("local:linux", 0x11, "txt")], 100)
        .unwrap();
    let repeat = ledger
        .register(vec![registration("local:linux", 0x11, "txt")], 200)
        .unwrap();
    assert_eq!(first, repeat);
    assert_eq!(ledger.records.len(), 1);
    assert_eq!(ledger.receipts.len(), 1);
    ledger.validate().unwrap();

    let second = ledger
        .register(vec![registration("local:linux", 0x22, "png")], 300)
        .unwrap();
    assert_eq!(
        ledger.receipts[1].previous_receipt_hash.as_deref(),
        Some(ledger.receipts[0].receipt_hash.as_str())
    );
    assert_ne!(first[0].attachment_id, second[0].attachment_id);
}

#[test]
fn reference_resolution_requires_exact_target_and_digest() {
    let mut ledger = TaskAttachmentLedger::default();
    let records = ledger
        .register(vec![registration("ssh:example:22:posix", 0x33, "bin")], 100)
        .unwrap();
    let reference = TaskAttachmentReference::from(&records[0]);
    assert_eq!(
        ledger
            .resolve_references(
                "connection-a",
                "ssh:example:22:posix",
                "/work/a",
                std::slice::from_ref(&reference),
            )
            .unwrap(),
        records
    );
    assert!(ledger
        .resolve_references(
            "connection-a",
            "local:linux",
            "/work/a",
            std::slice::from_ref(&reference)
        )
        .is_err());
    let mut changed = reference;
    changed.digest = Some(format!("sha256:{}", "44".repeat(32)));
    assert!(ledger
        .resolve_references(
            "connection-a",
            "ssh:example:22:posix",
            "/work/a",
            &[changed]
        )
        .is_err());
}

#[test]
fn ledger_validation_detects_receipt_and_path_tampering() {
    let mut ledger = TaskAttachmentLedger::default();
    let records = ledger
        .register(vec![registration("local:windows", 0x55, "json")], 100)
        .unwrap();
    ledger.receipts[0].size_bytes += 1;
    assert!(ledger.validate().is_err());

    let mut ledger = TaskAttachmentLedger::default();
    ledger
        .register(vec![registration("local:windows", 0x55, "json")], 100)
        .unwrap();
    ledger
        .records
        .get_mut(&records[0].attachment_id)
        .unwrap()
        .provider_relative_path = "../auth.json".to_string();
    assert!(ledger.validate().is_err());
}

#[test]
fn identity_refuses_noncanonical_digests_and_paths() {
    assert!(
        task_attachment_provider_relative_path(&format!("sha256:{}", "AA".repeat(32)), "txt")
            .is_err()
    );
    assert!(task_attachment_provider_relative_path(
        &format!("sha256:{}", "11".repeat(32)),
        "tar.gz"
    )
    .is_err());
    assert!(deterministic_attachment_id(
        "local",
        "local:linux",
        "/work/a",
        &format!("sha256:{}", "11".repeat(32)),
        ".shellx/task-attachments/other/attachment.txt"
    )
    .is_err());
}

#[test]
fn reclamation_is_two_phase_retryable_and_releases_record_capacity() {
    let mut ledger = TaskAttachmentLedger::default();
    let record = ledger
        .register(vec![registration("local:linux", 0x66, "txt")], 100)
        .unwrap()
        .remove(0);
    let ids = vec![record.attachment_id.clone()];
    let pending = ledger
        .prepare_reclamation(&ids, &BTreeSet::new(), 200)
        .unwrap();
    assert_eq!(pending[0].state, TaskAttachmentRecordState::ReclaimPending);
    assert!(ledger
        .resolve_references(
            "connection-a",
            "local:linux",
            "/work/a",
            &[TaskAttachmentReference::from(&record)],
        )
        .is_err());
    assert_eq!(
        ledger
            .prepare_reclamation(&ids, &BTreeSet::new(), 250)
            .unwrap()[0]
            .state,
        TaskAttachmentRecordState::ReclaimPending
    );
    ledger.finish_reclamation(&ids, 300).unwrap();
    assert!(!ledger.records.contains_key(&record.attachment_id));
    assert_eq!(ledger.receipts.len(), 3);
    ledger.validate().unwrap();

    let replacement = ledger
        .register(vec![registration("local:linux", 0x66, "txt")], 400)
        .unwrap();
    assert_eq!(replacement[0].attachment_id, record.attachment_id);
    assert_ne!(replacement[0].receipt_id, record.receipt_id);
    ledger.validate().unwrap();
}
