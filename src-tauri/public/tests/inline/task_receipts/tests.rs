use super::*;
use crate::task_model::TaskRetentionPolicy;

fn definition() -> TaskDefinition {
    TaskDefinition {
        task_id: "task-1".to_string(),
        name: "Task".to_string(),
        enabled: true,
        paused: false,
        current_revision_id: "task-1:r1".to_string(),
        current_revision_number: 1,
        current_revision_hash: "a".repeat(64),
        retention_policy: TaskRetentionPolicy { max_receipts: 2 },
        created_at_ms: 1,
        updated_at_ms: 1,
        deleted_at_ms: None,
    }
}

#[test]
fn journal_keeps_a_bounded_append_only_tail_with_verifiable_lineage() {
    let mut journal = TaskReceiptJournal::default();
    let mut task = definition();
    journal
        .append(&task, TaskReceiptKind::DefinitionCreated, 1)
        .unwrap();
    task.paused = true;
    journal.append(&task, TaskReceiptKind::Paused, 2).unwrap();
    task.paused = false;
    journal.append(&task, TaskReceiptKind::Resumed, 3).unwrap();

    assert_eq!(journal.entries.len(), 2);
    assert_eq!(journal.entries[0].kind as u8, TaskReceiptKind::Paused as u8);
    assert!(journal.entries[1].previous_receipt_hash.is_some());
    journal.validate().unwrap();
}
