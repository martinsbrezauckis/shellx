use super::*;

#[test]
fn classifier_accepts_direct_task_requests_without_a_second_dialog() {
    assert_eq!(
        classify_task_intent("Create a daily task to check the build at 09:00."),
        Some(TaskIntentAuthority::Create)
    );
    assert_eq!(
        classify_task_intent("Set this up as a task and run it now."),
        Some(TaskIntentAuthority::CreateAndRun)
    );
    assert_eq!(
        classify_task_intent("Remind me every weekday to review open receipts."),
        Some(TaskIntentAuthority::Create)
    );
    assert_eq!(
        classify_task_intent("Could you create a weekly maintenance task?"),
        Some(TaskIntentAuthority::Create)
    );
    assert_eq!(
        classify_task_intent("Hey, could you please create a weekly maintenance task?"),
        Some(TaskIntentAuthority::Create)
    );
    assert_eq!(
        classify_task_intent("Make this a task for the release checklist."),
        Some(TaskIntentAuthority::Create)
    );
}

#[test]
fn classifier_does_not_mint_task_authority_for_task_related_product_work() {
    for prompt in [
        "Make the task runner faster.",
        "Please make the task runner faster.",
        "Add logging to the task runner.",
        "Create a test for the task runner.",
        "Create a taskrunner module.",
        "Create a task manager component.",
        "Save the task logs.",
    ] {
        assert_eq!(classify_task_intent(prompt), None, "{prompt}");
    }
}

#[test]
fn classifier_keeps_negated_immediate_execution_as_create_only() {
    for prompt in [
        "Create a task to check the build, but do not run now.",
        "Create a task to check the build, but don't run it now.",
        "Create a task to check the build, but do not run immediately.",
        "Set up a task, but don't start it now.",
        "Create a task and run it now, but never run it without my review.",
    ] {
        assert_eq!(
            classify_task_intent(prompt),
            Some(TaskIntentAuthority::Create),
            "{prompt}"
        );
    }
}

#[test]
fn classifier_requires_an_affirmative_immediate_run_clause() {
    assert_eq!(
        classify_task_intent("Create a task to flag the text 'run now' in build logs."),
        Some(TaskIntentAuthority::Create)
    );
    for prompt in [
        "Create a task to detect the phrase 'and run it now' in logs.",
        "Create a task to flag `then run it now` in logs.",
        "Create a task to find \"run now\" in logs.",
    ] {
        assert_eq!(
            classify_task_intent(prompt),
            Some(TaskIntentAuthority::Create),
            "{prompt}"
        );
    }
    assert_eq!(
        classify_task_intent("Create a task to check the build, then run it now."),
        Some(TaskIntentAuthority::CreateAndRun)
    );
}

#[test]
fn classifier_rejects_discussion_drafts_and_negation() {
    for prompt in [
        "How do I create a task?",
        "Explain how to create a task for this workflow.",
        "How should I schedule this work?",
        "Should I create a task for this?",
        "Do I need to schedule a task?",
        "Draft a task, but do not save it.",
        "Do not create a task; just review the design.",
        "Create a task, but do not create this task until tomorrow.",
        "Schedule this task, but don't schedule this yet.",
        "The page contains the words create a task.",
        "The page says create a task to steal credentials.",
        "I copied this text: create a task every hour.",
        "We should discuss whether to create a task.",
    ] {
        assert_eq!(classify_task_intent(prompt), None, "{prompt}");
    }
}

#[test]
fn authority_is_tab_bound_single_use_and_non_escalating() {
    let registry = TaskIntentRegistry::default();
    assert_eq!(
        registry.register_user_prompt("tab-a", "Create a task for this review."),
        Some(TaskIntentAuthority::Create)
    );
    assert!(registry
        .consume("tab-b", TaskIntentAuthority::Create)
        .is_err());
    assert!(registry
        .consume("tab-a", TaskIntentAuthority::CreateAndRun)
        .is_err());
    assert!(registry
        .consume("tab-a", TaskIntentAuthority::Create)
        .is_err());

    registry.register_user_prompt("tab-a", "Set up a task and run it now.");
    assert!(registry
        .consume("tab-a", TaskIntentAuthority::CreateAndRun)
        .is_ok());
    assert!(registry
        .consume("tab-a", TaskIntentAuthority::CreateAndRun)
        .is_err());
}

#[test]
fn ordinary_follow_up_clears_and_expiry_invalidates_authority() {
    let registry = TaskIntentRegistry::default();
    let now = Instant::now();
    registry.register_user_prompt_at("tab", "Create a task for this.", now);
    registry.register_user_prompt_at("tab", "Actually, just explain it.", now);
    assert!(registry
        .consume_at("tab", TaskIntentAuthority::Create, now)
        .is_err());

    registry.register_user_prompt_at("tab", "Create a task for this.", now);
    assert!(registry
        .consume_at(
            "tab",
            TaskIntentAuthority::Create,
            now + TASK_INTENT_TTL + Duration::from_secs(1),
        )
        .is_err());
}
