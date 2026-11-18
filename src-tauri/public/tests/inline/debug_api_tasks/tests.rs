use super::*;

#[test]
fn task_ids_are_bounded_and_control_free() {
    assert_eq!(
        validate_task_path_id(" task-1 ".to_string()).unwrap(),
        "task-1"
    );
    assert!(validate_task_path_id(String::new()).is_err());
    assert!(validate_task_path_id("x".repeat(TASKS_PATH_ID_MAX_CHARS + 1)).is_err());
    assert!(validate_task_path_id("task\u{0000}".to_string()).is_err());
}

#[test]
fn receipt_limits_have_a_small_default_and_hard_cap() {
    assert_eq!(
        validate_receipt_limit(None).unwrap(),
        TASKS_RECEIPTS_DEFAULT_LIMIT
    );
    assert_eq!(validate_receipt_limit(Some(1)).unwrap(), 1);
    assert_eq!(
        validate_receipt_limit(Some(TASKS_RECEIPTS_MAX_LIMIT)).unwrap(),
        256
    );
    assert!(validate_receipt_limit(Some(0)).is_err());
    assert!(validate_receipt_limit(Some(TASKS_RECEIPTS_MAX_LIMIT + 1)).is_err());
}

#[test]
fn attention_limits_and_run_ids_are_bounded() {
    assert_eq!(validate_attention_limit(None).unwrap(), 24);
    assert_eq!(validate_attention_limit(Some(64)).unwrap(), 64);
    assert!(validate_attention_limit(Some(0)).is_err());
    assert!(validate_attention_limit(Some(65)).is_err());
    assert_eq!(
        validate_run_path_id(" attempt-1 ".to_string(), "task_attempt_id_invalid").unwrap(),
        "attempt-1"
    );
    assert!(validate_run_path_id("bad\0id".to_string(), "task_attempt_id_invalid").is_err());
}

#[test]
fn store_errors_keep_conflict_and_not_found_semantics_redacted() {
    let conflict = task_store_error_response(
        "Task revision conflict; reload the current task before saving.".to_string(),
    );
    assert_eq!(conflict.status(), StatusCode::CONFLICT);
    let missing = task_store_error_response("Task definition was not found.".to_string());
    assert_eq!(missing.status(), StatusCode::NOT_FOUND);
    let unknown = task_store_error_response("private I/O detail /tmp/task-store".to_string());
    assert_eq!(unknown.status(), StatusCode::INTERNAL_SERVER_ERROR);
}
