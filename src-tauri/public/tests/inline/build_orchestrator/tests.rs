use super::*;
use crate::build_types::{BuildReceiptConfidence, BuildReceiptKind};

fn temp_base(name: &str) -> PathBuf {
    let mut path = std::env::temp_dir();
    path.push(format!("shellx-build-orch-{}-{}", name, std::process::id()));
    let _ = std::fs::remove_dir_all(&path);
    std::fs::create_dir_all(&path).unwrap();
    path
}

fn complete_board() -> String {
    r#"# Build: test

Status: IN_PROGRESS

## Phase 1 - Plan
Status: DONE
- [x] planned

## Phase 2 - Complete
Status: DONE
- [x] Call build_complete
"#
    .to_string()
}

fn goal_complete_board() -> String {
    complete_board().replace("Status: IN_PROGRESS", "Status: GOAL_COMPLETE")
}

fn approvable_build_plan() -> &'static str {
    r#"# Build: test

Status: AWAITING_APPROVAL

## Phase 1 - Plan
- [ ] planned

## Phase 2 - Review
- [ ] Reviewer must run an AI slop / wiring audit: unwired UI controls, placeholder/mock code, fake success paths, missing frontend/backend bridges, config/schema drift, and release-debug leaks
"#
}

fn receipt(
    state: &BuildRunState,
    kind: BuildReceiptKind,
    confidence: BuildReceiptConfidence,
) -> BuildReceipt {
    let data = match kind {
        BuildReceiptKind::ReviewCompleted => json!({
            "checkpointId": "cp-1",
            "persona": "reviewer",
            "status": "completed",
            "stdoutChars": 420,
            "gateEvidence": {
                "accepted": true,
                "reason": "review report shape matched",
                "matchedMarkers": ["review", "summary", "finding"],
                "stdoutChars": 420
            }
        }),
        BuildReceiptKind::VerificationCompleted => json!({
            "checkpointId": "cp-1",
            "persona": "verifier",
            "status": "completed",
            "stdoutChars": 420,
            "gateEvidence": {
                "accepted": true,
                "reason": "verification report shape matched",
                "matchedMarkers": ["verification", "behavior evidence", "gaps"],
                "stdoutChars": 420
            }
        }),
        _ => json!({ "checkpointId": "cp-1" }),
    };
    BuildReceipt {
        receipt_id: new_receipt_id(),
        run_id: state.run_id.clone(),
        tab_id: state.tab_id.clone(),
        kind,
        created_at_ms: now_ms(),
        actor: "test".into(),
        summary: "ok".into(),
        confidence,
        data,
    }
}

fn run_git(cwd: &Path, args: &[&str]) {
    let output = std::process::Command::new("git")
        .args(args)
        .current_dir(cwd)
        .output()
        .unwrap_or_else(|e| panic!("git {:?} spawn failed: {}", args, e));
    assert!(
        output.status.success(),
        "git {:?} failed\nstdout={}\nstderr={}",
        args,
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

fn initialize_owned_git_fixture(cwd: &Path) {
    run_git(cwd, &["init", "--quiet"]);
    run_git(
        cwd,
        &["config", "user.email", "shellx-test@example.invalid"],
    );
    run_git(cwd, &["config", "user.name", "shellX Test"]);
    std::fs::write(cwd.join("fixture.txt"), "before\n").unwrap();
    run_git(cwd, &["add", "fixture.txt"]);
    let empty_hooks = cwd.join("fixture-empty-hooks");
    std::fs::create_dir(&empty_hooks).unwrap();
    let empty_hooks = empty_hooks.to_string_lossy().to_string();
    run_git(
        cwd,
        &[
            "-c",
            "commit.gpgsign=false",
            "-c",
            &format!("core.hooksPath={empty_hooks}"),
            "commit",
            "--quiet",
            "-m",
            "initial fixture",
        ],
    );
    std::fs::write(cwd.join("fixture.txt"), "after\n").unwrap();

    let output = std::process::Command::new("git")
        .args(["rev-parse", "--show-toplevel"])
        .current_dir(cwd)
        .output()
        .expect("inspect owned Git fixture root");
    assert!(
        output.status.success(),
        "owned fixture Git root lookup failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        std::fs::canonicalize(cwd).unwrap(),
        std::fs::canonicalize(String::from_utf8(output.stdout).unwrap().trim()).unwrap(),
        "completion-gate fixtures must use their own Git worktree, not an enclosing checkout"
    );
}

async fn append_owned_git_checkpoint(orch: &BuildOrchestrator, state: &BuildRunState) {
    let mut checkpoint = receipt(
        state,
        BuildReceiptKind::CheckpointCreated,
        BuildReceiptConfidence::TrustedHost,
    );
    checkpoint.data = json!({
        "checkpointId": "cp-1",
        "staged": 0,
        "unstaged": 1,
        "untracked": 0,
    });
    orch.append_receipt(checkpoint).await.unwrap();

    let checkpoint = orch
        .get_receipts(&state.tab_id)
        .await
        .unwrap()
        .into_iter()
        .find(|receipt| {
            receipt.kind == BuildReceiptKind::CheckpointCreated
                && receipt
                    .data
                    .get("checkpointId")
                    .and_then(|value| value.as_str())
                    == Some("cp-1")
        })
        .expect("persisted owned Git checkpoint");
    assert!(
        checkpoint
            .data
            .get("buildWorktreeFingerprint")
            .and_then(|value| value.as_str())
            .is_some(),
        "the fixture checkpoint must bind the owned Git worktree"
    );
}

#[test]
fn parse_build_command_extracts_objective() {
    assert_eq!(
        BuildOrchestrator::parse_build_command("/build ship it").as_deref(),
        Some("ship it")
    );
    assert_eq!(
        BuildOrchestrator::parse_build_command("   /build").as_deref(),
        Some("")
    );
    assert_eq!(
        BuildOrchestrator::parse_build_command("/goal ship it").as_deref(),
        Some("ship it")
    );
}

#[test]
fn plan_kickoff_text_is_plan_only() {
    let text = BuildOrchestrator::plan_kickoff_text("change code");
    assert!(text.contains("Scratchboard path:"));
    assert!(text.contains("Status: AWAITING_APPROVAL"));
    assert!(text.contains("Status: TODO"));
    assert!(text.contains("Do not execute any phase yet"));
    assert!(text.contains("build_complete"));
    assert!(text.contains("Do not invent `Status: COMPLETE`"));
    assert!(text.contains("Do not call Grok"));
    assert!(
        text.contains("native write/edit file tool")
            && text.contains("WSL/SSH")
            && text.contains("instead of opening a blocker"),
        "build kickoff should steer POSIX scratchboard writes away from host fs_write"
    );
    assert!(
        text.contains("test-writer"),
        "build kickoff should advertise a dedicated test-writing persona"
    );
    assert!(
        text.contains("AI slop / wiring audit") && text.contains("fake success paths"),
        "build kickoff should require the slop/wiring review pass"
    );
    assert!(
        text.contains("wait=true"),
        "build kickoff should steer sequential agent phases toward wait=true"
    );
    assert!(
        text.contains("wait=false"),
        "build kickoff should reserve wait=false for real fan-out"
    );
    assert!(
        text.contains("Establish git baseline")
            && text.contains("git rev-parse --show-toplevel")
            && text.contains("git init")
            && text.contains("git status --short"),
        "build kickoff should require a git baseline task"
    );
}

#[test]
fn scratchboard_path_is_tab_and_run_scoped() {
    let cwd = PathBuf::from("/tmp/project");
    let a = pick_build_scratchboard_path(&cwd, "tab-a", "build-111111111111-aaaa");
    let b = pick_build_scratchboard_path(&cwd, "tab-b", "build-222222222222-bbbb");
    assert_ne!(a, b);
    assert!(a.to_string_lossy().contains("tab-a"));
    assert!(b.to_string_lossy().contains("tab-b"));
}

#[test]
fn build_fingerprint_ignores_scratchboard_content() {
    let cwd = temp_base("build-fingerprint-cwd");
    run_git(&cwd, &["init"]);
    run_git(
        &cwd,
        &["config", "user.email", "shellx-test@example.invalid"],
    );
    run_git(&cwd, &["config", "user.name", "shellX Test"]);
    std::fs::write(cwd.join("index.mjs"), "export const label = 'before';\n").unwrap();
    run_git(&cwd, &["add", "index.mjs"]);
    run_git(&cwd, &["commit", "-m", "initial"]);

    let scratchboard = cwd.join("build.tab1.abcdef.md");
    std::fs::write(&scratchboard, "# Build: test\n\nStatus: IN_PROGRESS\n").unwrap();
    let first = local_build_worktree_fingerprint(&cwd, &scratchboard)
        .unwrap()
        .expect("fingerprint");
    std::fs::write(
        &scratchboard,
        "# Build: test\n\nStatus: IN_PROGRESS\n\n## Phase\n- [x] done\n",
    )
    .unwrap();
    let second = local_build_worktree_fingerprint(&cwd, &scratchboard)
        .unwrap()
        .expect("fingerprint");
    assert_eq!(
        first, second,
        "scratchboard-only edits should not stale build checkpoints"
    );

    std::fs::create_dir_all(cwd.join("dist")).unwrap();
    std::fs::write(cwd.join("dist/release-summary.json"), "{}\n").unwrap();
    let third = local_build_worktree_fingerprint(&cwd, &scratchboard)
        .unwrap()
        .expect("fingerprint");
    assert_ne!(
        second, third,
        "non-scratchboard release artifacts should remain part of the build fingerprint"
    );
    let _ = std::fs::remove_dir_all(cwd);
}

#[tokio::test]
async fn local_build_complete_uses_build_fingerprint_not_generic_session_fingerprint() {
    let cwd = temp_base("local-complete-build-fp-cwd");
    let store = temp_base("local-complete-build-fp-store");
    run_git(&cwd, &["init"]);
    run_git(
        &cwd,
        &["config", "user.email", "shellx-test@example.invalid"],
    );
    run_git(&cwd, &["config", "user.name", "shellX Test"]);
    std::fs::write(cwd.join("index.mjs"), "export const label = 'before';\n").unwrap();
    run_git(&cwd, &["add", "index.mjs"]);
    run_git(&cwd, &["commit", "-m", "initial"]);

    let orch = BuildOrchestrator::new(store.clone());
    let state = orch.start_run("tab1", "test", &cwd, "local").await.unwrap();
    std::fs::write(&state.scratchboard_path, complete_board()).unwrap();
    {
        let mut map = orch.states.write().await;
        map.get_mut("tab1").unwrap().state.status = BuildRunStatus::Active;
    }

    std::fs::write(cwd.join("index.mjs"), "export const label = 'after';\n").unwrap();
    std::fs::create_dir_all(cwd.join("dist")).unwrap();
    std::fs::write(cwd.join("dist/release-summary.json"), "{}\n").unwrap();
    let mut checkpoint = receipt(
        &state,
        BuildReceiptKind::CheckpointCreated,
        BuildReceiptConfidence::TrustedHost,
    );
    checkpoint.data = json!({
        "checkpointId": "cp-local-build-fp",
        "staged": 0,
        "unstaged": 1,
        "untracked": 1,
    });
    orch.append_receipt(checkpoint).await.unwrap();
    orch.append_receipt(receipt(
        &state,
        BuildReceiptKind::ReviewCompleted,
        BuildReceiptConfidence::TrustedHost,
    ))
    .await
    .unwrap();
    orch.append_receipt(receipt(
        &state,
        BuildReceiptKind::VerificationCompleted,
        BuildReceiptConfidence::ObservedAcp,
    ))
    .await
    .unwrap();

    std::fs::write(
        &state.scratchboard_path,
        format!(
            "{}\n<!-- final scratchboard-only edit -->\n",
            complete_board()
        ),
    )
    .unwrap();
    let checkpoint_fingerprint =
        latest_checkpoint_worktree_fingerprint(&store, "tab1", &state.run_id, "cp-local-build-fp")
            .unwrap()
            .expect("checkpoint fingerprint");
    let generic_fingerprint = crate::session_git::local_worktree_fingerprint(&cwd)
        .unwrap()
        .expect("generic fingerprint");
    assert_ne!(
        checkpoint_fingerprint, generic_fingerprint,
        "the generic session fingerprint includes scratchboard-only edits"
    );

    orch.validate_complete_with_current_fingerprint("tab1", "done", Some(generic_fingerprint))
        .await
        .unwrap();
    assert_eq!(
        orch.get_state("tab1").await.unwrap().status,
        BuildRunStatus::Complete
    );

    let _ = std::fs::remove_dir_all(cwd);
    let _ = std::fs::remove_dir_all(store);
}

#[tokio::test]
async fn late_receipts_do_not_reopen_terminal_builds() {
    let cwd = temp_base("late-receipt-cwd");
    let store = temp_base("late-receipt-store");
    let orch = BuildOrchestrator::new(store.clone());
    let state = orch.start_run("tab1", "test", &cwd, "local").await.unwrap();
    {
        let mut map = orch.states.write().await;
        map.get_mut("tab1").unwrap().state.status = BuildRunStatus::Complete;
    }

    let mut blocker = receipt(
        &state,
        BuildReceiptKind::BlockerOpened,
        BuildReceiptConfidence::ModelDeclared,
    );
    blocker.summary = "late post-complete blocker".into();
    orch.append_receipt(blocker).await.unwrap();

    let current = orch.get_state("tab1").await.unwrap();
    assert_eq!(current.status, BuildRunStatus::Complete);
    assert_eq!(current.open_blocker, None);

    let _ = std::fs::remove_dir_all(cwd);
    let _ = std::fs::remove_dir_all(store);
}

#[tokio::test]
async fn agent_completion_clears_matching_in_flight_agent_blocker() {
    let cwd = temp_base("agent-blocker-cwd");
    let store = temp_base("agent-blocker-store");
    let orch = BuildOrchestrator::new(store.clone());
    let state = orch.start_run("tab1", "test", &cwd, "local").await.unwrap();
    let subagent_id = "2c76d5b3-27fb-4bbb-9d28-d7bde7dd8dc6";

    let mut blocker = receipt(
        &state,
        BuildReceiptKind::BlockerOpened,
        BuildReceiptConfidence::ModelDeclared,
    );
    blocker.summary =
        format!("blocked by in-flight Agent {subagent_id} still running with 0 stdout");
    orch.append_receipt(blocker).await.unwrap();

    let blocked = orch.get_state("tab1").await.unwrap();
    assert_eq!(blocked.status, BuildRunStatus::Blocked);
    assert!(blocked
        .open_blocker
        .as_deref()
        .unwrap()
        .contains(subagent_id));

    let mut completed = receipt(
        &state,
        BuildReceiptKind::AgentCompleted,
        BuildReceiptConfidence::TrustedHost,
    );
    completed.data = json!({
        "subagentId": subagent_id,
        "status": "completed",
        "exitCode": 0
    });
    orch.append_receipt(completed).await.unwrap();

    let current = orch.get_state("tab1").await.unwrap();
    assert_eq!(current.status, BuildRunStatus::Active);
    assert_eq!(current.open_blocker, None);

    let _ = std::fs::remove_dir_all(cwd);
    let _ = std::fs::remove_dir_all(store);
}

#[tokio::test]
async fn trusted_agent_start_after_blocker_marks_build_active() {
    let cwd = temp_base("agent-progress-clears-blocker-cwd");
    let store = temp_base("agent-progress-clears-blocker-store");
    let orch = BuildOrchestrator::new(store.clone());
    let state = orch.start_run("tab1", "test", &cwd, "local").await.unwrap();

    let mut blocker = receipt(
        &state,
        BuildReceiptKind::BlockerOpened,
        BuildReceiptConfidence::ModelDeclared,
    );
    blocker.summary = "reviewer Agent spawn failed; waiting for operator action".into();
    orch.append_receipt(blocker).await.unwrap();

    let mut started = receipt(
        &state,
        BuildReceiptKind::AgentStarted,
        BuildReceiptConfidence::TrustedHost,
    );
    started.summary = "implementer Agent started: next build stage".into();
    started.data = json!({
        "subagentId": "agent-2",
        "persona": "implementer",
        "status": "running"
    });
    orch.append_receipt(started).await.unwrap();

    let current = orch.get_state("tab1").await.unwrap();
    assert_eq!(current.status, BuildRunStatus::Active);
    assert_eq!(current.open_blocker, None);

    let _ = std::fs::remove_dir_all(cwd);
    let _ = std::fs::remove_dir_all(store);
}

#[tokio::test]
async fn operator_notes_are_injected_once_on_next_build_continuation() {
    let cwd = temp_base("operator-note-cwd");
    let store = temp_base("operator-note-store");
    let orch = BuildOrchestrator::new(store.clone());
    let state = orch.start_run("tab1", "test", &cwd, "local").await.unwrap();
    std::fs::write(
        &state.scratchboard_path,
        "# Build: test\n\nStatus: IN_PROGRESS\n\n## Phase\nStatus: IN_PROGRESS\n- [ ] next\n",
    )
    .unwrap();
    {
        let mut map = orch.states.write().await;
        map.get_mut("tab1").unwrap().state.status = BuildRunStatus::Active;
    }

    let note = orch
        .add_operator_note("tab1", "Use the simpler fill tolerance first.")
        .await
        .unwrap();
    assert!(note.note_id.starts_with("bon-"));

    let queued = orch.get_state("tab1").await.unwrap();
    assert_eq!(queued.pending_operator_notes.len(), 1);

    let prompt = orch.consider_continue("tab1", "end_turn").await.unwrap();
    assert!(prompt.contains("<operator_notes>"));
    assert!(prompt.contains("Use the simpler fill tolerance first."));

    let drained = orch.get_state("tab1").await.unwrap();
    assert!(drained.pending_operator_notes.is_empty());

    let next_prompt = orch.consider_continue("tab1", "end_turn").await.unwrap();
    assert!(!next_prompt.contains("<operator_notes>"));

    let _ = std::fs::remove_dir_all(cwd);
    let _ = std::fs::remove_dir_all(store);
}

#[tokio::test]
async fn recheck_blocker_clears_satisfied_review_gate_blocker() {
    let cwd = temp_base("recheck-review-blocker-cwd");
    let store = temp_base("recheck-review-blocker-store");
    let orch = BuildOrchestrator::new(store.clone());
    let state = orch.start_run("tab1", "test", &cwd, "local").await.unwrap();

    let mut blocker = receipt(
        &state,
        BuildReceiptKind::BlockerOpened,
        BuildReceiptConfidence::ModelDeclared,
    );
    blocker.summary = "reviewer gate blocked by timed out reviewer".into();
    orch.append_receipt(blocker).await.unwrap();

    let mut review = receipt(
        &state,
        BuildReceiptKind::ReviewCompleted,
        BuildReceiptConfidence::TrustedHost,
    );
    review.summary = "replacement reviewer completed".into();
    orch.append_receipt(review).await.unwrap();

    let result = orch.recheck_blocker("tab1").await.unwrap();
    assert!(result.checked);
    assert!(result.cleared);
    assert!(result.message.contains("Blocker cleared"));

    let current = orch.get_state("tab1").await.unwrap();
    assert_eq!(current.status, BuildRunStatus::Active);
    assert_eq!(current.open_blocker, None);

    let receipts = orch.get_receipts("tab1").await.unwrap();
    assert!(receipts
        .iter()
        .any(|r| r.kind == BuildReceiptKind::BlockerResolved
            && r.actor == "shellx"
            && r.summary.contains("Rechecked blocker")));

    let _ = std::fs::remove_dir_all(cwd);
    let _ = std::fs::remove_dir_all(store);
}

#[tokio::test]
async fn recheck_missing_checkpoint_resumes_queued_note_without_satisfying_other_gates() {
    let cwd = temp_base("recheck-checkpoint-cwd");
    let store = temp_base("recheck-checkpoint-store");
    let orch = BuildOrchestrator::new(store.clone());
    let state = orch.start_run("tab1", "test", &cwd, "local").await.unwrap();
    std::fs::write(&state.scratchboard_path, complete_board()).unwrap();
    {
        let mut map = orch.states.write().await;
        let state = &mut map.get_mut("tab1").unwrap().state;
        state.status = BuildRunStatus::Active;
        state.preview_required = true;
    }

    let mut blocker = receipt(
        &state,
        BuildReceiptKind::BlockerOpened,
        BuildReceiptConfidence::TrustedHost,
    );
    blocker.summary = "build_complete rejected: code changed but no checkpoint receipt exists. Checkpoint was not created because this objective forbids commits, and the dirty tree includes pre-existing source edits plus another tab's scratchboard.".into();
    orch.append_receipt(blocker).await.unwrap();
    orch.add_operator_note(
        "tab1",
        "Continue the existing review and verification work.",
    )
    .await
    .unwrap();

    let mut checkpoint = receipt(
        &state,
        BuildReceiptKind::CheckpointCreated,
        BuildReceiptConfidence::TrustedHost,
    );
    checkpoint.data = json!({"checkpointId": "cp-1", "staged": 0, "unstaged": 1, "untracked": 0});
    let checkpoint_receipt_id = checkpoint.receipt_id.clone();
    orch.append_receipt(checkpoint).await.unwrap();

    let blocked = orch.get_state("tab1").await.unwrap();
    assert_eq!(blocked.status, BuildRunStatus::Blocked);
    assert_eq!(blocked.checkpoint_id.as_deref(), Some("cp-1"));
    assert!(blocked.review_required && !blocked.review_satisfied);
    assert!(blocked.verification_required && !blocked.verification_satisfied);
    assert!(blocked.preview_required && !blocked.preview_satisfied);
    let result = orch.recheck_blocker("tab1").await.unwrap();
    assert!(result.cleared);
    assert_eq!(
        result.matched_receipt_id.as_deref(),
        Some(checkpoint_receipt_id.as_str())
    );
    let resumed = orch.get_state("tab1").await.unwrap();
    assert_eq!(resumed.status, BuildRunStatus::Active);
    assert_eq!(resumed.open_blocker, None);
    assert!(resumed.review_required && !resumed.review_satisfied);
    assert!(resumed.verification_required && !resumed.verification_satisfied);
    assert!(resumed.preview_required && !resumed.preview_satisfied);
    let prompt = orch.consider_continue("tab1", "end_turn").await.unwrap();
    assert!(prompt.contains("Continue the existing review and verification work."));
    let continued = orch.get_state("tab1").await.unwrap();
    assert!(continued.pending_operator_notes.is_empty());
    assert_ne!(continued.status, BuildRunStatus::Complete);

    let _ = std::fs::remove_dir_all(cwd);
    let _ = std::fs::remove_dir_all(store);
}

#[tokio::test]
async fn recheck_missing_checkpoint_requires_current_trusted_receipt_after_blocker() {
    let cwd = temp_base("recheck-checkpoint-neg-cwd");
    let store = temp_base("recheck-checkpoint-neg-store");
    let orch = BuildOrchestrator::new(store.clone());
    let mut state = orch.start_run("tab1", "test", &cwd, "local").await.unwrap();
    state.status = BuildRunStatus::Blocked;
    state.open_blocker = Some("build_complete rejected: code changed but no checkpoint receipt exists. Checkpoint was not created because this objective forbids commits, and the dirty tree includes pre-existing source edits plus another tab's scratchboard.".into());
    state.checkpoint_id = Some("cp-1".into());
    let mut opened = receipt(
        &state,
        BuildReceiptKind::BlockerOpened,
        BuildReceiptConfidence::TrustedHost,
    );
    opened.summary = state.open_blocker.clone().unwrap();
    opened.created_at_ms = 20;
    let mut checkpoint = receipt(
        &state,
        BuildReceiptKind::CheckpointCreated,
        BuildReceiptConfidence::TrustedHost,
    );
    checkpoint.created_at_ms = 21;
    checkpoint.data = json!({"checkpointId": "cp-1"});

    let matching = [opened.clone(), checkpoint.clone()];
    assert!(evaluate_blocker_recheck(&state, &matching).cleared);
    let mut sentence_only = state.clone();
    sentence_only.open_blocker =
        Some("build_complete rejected: code changed but no checkpoint receipt exists.".into());
    let mut sentence_opened = opened.clone();
    sentence_opened.summary = sentence_only.open_blocker.clone().unwrap();
    assert!(
        evaluate_blocker_recheck(&sentence_only, &[sentence_opened, checkpoint.clone()]).cleared
    );
    assert!(!evaluate_blocker_recheck(&state, &[opened.clone()]).cleared);
    assert!(!evaluate_blocker_recheck(&state, &[checkpoint.clone(), opened.clone()]).cleared);

    for candidate in [
        {
            let mut r = checkpoint.clone();
            r.confidence = BuildReceiptConfidence::ModelDeclared;
            r
        },
        {
            let mut r = checkpoint.clone();
            r.confidence = BuildReceiptConfidence::ObservedAcp;
            r
        },
        {
            let mut r = checkpoint.clone();
            r.run_id = "other-run".into();
            r
        },
        {
            let mut r = checkpoint.clone();
            r.tab_id = "other-tab".into();
            r
        },
        {
            let mut r = checkpoint.clone();
            r.data = json!({"checkpointId": "old"});
            r
        },
        {
            let mut r = checkpoint.clone();
            r.data = json!({"checkpointId": "cp-1", "checkpointUnavailable": true});
            r
        },
        {
            let mut r = checkpoint.clone();
            r.created_at_ms = 19;
            r
        },
    ] {
        assert!(!evaluate_blocker_recheck(&state, &[opened.clone(), candidate]).cleared);
    }
    let mut no_current_id = state.clone();
    no_current_id.checkpoint_id = None;
    assert!(!evaluate_blocker_recheck(&no_current_id, &matching).cleared);
    no_current_id.checkpoint_id = Some("  ".into());
    assert!(!evaluate_blocker_recheck(&no_current_id, &matching).cleared);
    let mut unrelated = state.clone();
    unrelated.open_blocker = Some("operator asked about the checkpoint receipt".into());
    let mut unrelated_opened = opened.clone();
    unrelated_opened.summary = unrelated.open_blocker.clone().unwrap();
    assert!(!evaluate_blocker_recheck(&unrelated, &[unrelated_opened, checkpoint.clone()]).cleared);
    unrelated.open_blocker = Some("build_complete rejected: code changed but no checkpoint receipt exists for another project".into());
    let mut similar_opened = opened.clone();
    similar_opened.summary = unrelated.open_blocker.clone().unwrap();
    assert!(!evaluate_blocker_recheck(&unrelated, &[similar_opened, checkpoint.clone()]).cleared);
    for status in [
        BuildRunStatus::Halted,
        BuildRunStatus::Complete,
        BuildRunStatus::TransportFailed,
    ] {
        let mut terminal = state.clone();
        terminal.status = status;
        assert!(!evaluate_blocker_recheck(&terminal, &matching).cleared);
    }

    let _ = std::fs::remove_dir_all(cwd);
    let _ = std::fs::remove_dir_all(store);
}

#[tokio::test]
async fn recheck_blocker_keeps_running_agent_blocker() {
    let cwd = temp_base("recheck-running-agent-cwd");
    let store = temp_base("recheck-running-agent-store");
    let orch = BuildOrchestrator::new(store.clone());
    let state = orch.start_run("tab1", "test", &cwd, "local").await.unwrap();
    let subagent_id = "7f6b8b33-29fe-4811-85b3-1fefc870b7a0";

    let mut started = receipt(
        &state,
        BuildReceiptKind::AgentStarted,
        BuildReceiptConfidence::TrustedHost,
    );
    started.data = json!({
        "subagentId": subagent_id,
        "persona": "reviewer",
        "status": "running"
    });
    orch.append_receipt(started).await.unwrap();

    let mut blocker = receipt(
        &state,
        BuildReceiptKind::BlockerOpened,
        BuildReceiptConfidence::ModelDeclared,
    );
    blocker.summary =
        format!("blocked by in-flight Agent {subagent_id} still running with 0 stdout");
    orch.append_receipt(blocker).await.unwrap();

    let result = orch.recheck_blocker("tab1").await.unwrap();
    assert!(result.checked);
    assert!(!result.cleared);
    assert!(result.message.contains("Still blocked"));

    let current = orch.get_state("tab1").await.unwrap();
    assert_eq!(current.status, BuildRunStatus::Blocked);
    assert!(current
        .open_blocker
        .as_deref()
        .unwrap()
        .contains(subagent_id));

    let _ = std::fs::remove_dir_all(cwd);
    let _ = std::fs::remove_dir_all(store);
}

#[tokio::test]
async fn approve_build_plan_hashes_snapshot() {
    let cwd = temp_base("approve-cwd");
    let store = temp_base("approve-store");
    let orch = BuildOrchestrator::new(store.clone());
    let state = orch.start_run("tab1", "test", &cwd, "local").await.unwrap();
    let plan = approvable_build_plan();
    std::fs::write(&state.scratchboard_path, plan).unwrap();
    assert!(orch.approve_plan("tab1").await.unwrap());
    let approved = orch.get_state("tab1").await.unwrap();
    assert_eq!(approved.status, BuildRunStatus::Active);
    assert_eq!(approved.approved_plan_hash, Some(plan_hash(plan)));
    let patched = std::fs::read_to_string(&state.scratchboard_path).unwrap();
    assert!(patched.contains("Status: IN_PROGRESS"));
    let _ = std::fs::remove_dir_all(cwd);
    let _ = std::fs::remove_dir_all(store);
}

#[tokio::test]
async fn start_run_stays_draft_until_valid_plan_written() {
    let cwd = temp_base("draft-plan-cwd");
    let store = temp_base("draft-plan-store");
    let orch = BuildOrchestrator::new(store.clone());
    let state = orch
        .start_run("tab-draft", "test", &cwd, "local")
        .await
        .unwrap();
    assert_eq!(state.status, BuildRunStatus::Draft);
    let stub = std::fs::read_to_string(&state.scratchboard_path).unwrap();
    assert!(stub.contains("Status: DRAFTING"));

    let mut stub_write = receipt(
        &state,
        BuildReceiptKind::FileWrite,
        BuildReceiptConfidence::ObservedAcp,
    );
    stub_write.data = json!({ "path": state.scratchboard_path.clone() });
    orch.append_receipt(stub_write).await.unwrap();
    let still_draft = orch.get_state("tab-draft").await.unwrap();
    assert_eq!(still_draft.status, BuildRunStatus::Draft);

    let plan = approvable_build_plan();
    std::fs::write(&still_draft.scratchboard_path, plan).unwrap();
    let mut plan_write = receipt(
        &still_draft,
        BuildReceiptKind::FileWrite,
        BuildReceiptConfidence::ObservedAcp,
    );
    plan_write.data = json!({ "path": still_draft.scratchboard_path.clone() });
    orch.append_receipt(plan_write).await.unwrap();
    let awaiting = orch.get_state("tab-draft").await.unwrap();
    assert_eq!(awaiting.status, BuildRunStatus::AwaitingApproval);

    let _ = std::fs::remove_dir_all(cwd);
    let _ = std::fs::remove_dir_all(store);
}

#[tokio::test]
async fn draft_plan_poll_recovers_after_write_observation_race() {
    let cwd = temp_base("draft-plan-race-cwd");
    let store = temp_base("draft-plan-race-store");
    let orch = BuildOrchestrator::new(store.clone());
    let state = orch
        .start_run("tab-draft-race", "test", &cwd, "local")
        .await
        .unwrap();
    assert_eq!(state.status, BuildRunStatus::Draft);

    let mut early_write = receipt(
        &state,
        BuildReceiptKind::FileWrite,
        BuildReceiptConfidence::ObservedAcp,
    );
    early_write.data = json!({ "path": state.scratchboard_path.clone() });
    orch.append_receipt(early_write).await.unwrap();
    let still_draft = orch.get_state("tab-draft-race").await.unwrap();
    assert_eq!(still_draft.status, BuildRunStatus::Draft);

    std::fs::write(&still_draft.scratchboard_path, approvable_build_plan()).unwrap();
    let recovered = orch.get_state("tab-draft-race").await.unwrap();
    assert_eq!(recovered.status, BuildRunStatus::AwaitingApproval);

    let _ = std::fs::remove_dir_all(cwd);
    let _ = std::fs::remove_dir_all(store);
}

#[tokio::test]
async fn normalized_plan_written_receipt_is_returned_and_matches_persistence() {
    let cwd = temp_base("normalized-plan-cwd");
    let store = temp_base("normalized-plan-store");
    let orch = BuildOrchestrator::new(store.clone());
    let state = orch
        .start_run("build-normalized-tab", "test", &cwd, "local")
        .await
        .unwrap();
    std::fs::write(&state.scratchboard_path, approvable_build_plan()).unwrap();

    let mut observed_write = receipt(
        &state,
        BuildReceiptKind::FileWrite,
        BuildReceiptConfidence::ObservedAcp,
    );
    observed_write.data = json!({ "path": state.scratchboard_path.clone() });
    let normalized = orch
        .append_normalized_receipt(observed_write)
        .await
        .unwrap()
        .expect("scratchboard write must be persisted as PlanWritten");
    assert_eq!(normalized.kind, BuildReceiptKind::PlanWritten);
    assert_eq!(
        normalized
            .data
            .get("scratchboardPath")
            .and_then(|value| value.as_str()),
        Some(state.scratchboard_path.as_str())
    );

    let persisted = orch
        .get_receipts("build-normalized-tab")
        .await
        .unwrap()
        .into_iter()
        .find(|receipt| receipt.receipt_id == normalized.receipt_id)
        .expect("normalized receipt must be in the persisted ledger");
    assert_eq!(persisted, normalized);

    let _ = std::fs::remove_dir_all(cwd);
    let _ = std::fs::remove_dir_all(store);
}

#[tokio::test]
async fn approve_build_rejects_plan_without_slop_review_gate() {
    let cwd = temp_base("approve-noslop-cwd");
    let store = temp_base("approve-noslop-store");
    let orch = BuildOrchestrator::new(store.clone());
    let state = orch
        .start_run("tab-noslop", "test", &cwd, "local")
        .await
        .unwrap();
    let plan = r#"# Build: test

Status: AWAITING_APPROVAL

## Phase 1 - Plan
- [ ] planned

## Phase 2 - Review
- [ ] Reviewer checks code
"#;
    std::fs::write(&state.scratchboard_path, plan).unwrap();
    let err = orch.approve_plan("tab-noslop").await.unwrap_err();
    assert!(err.contains("AI slop / wiring audit"), "got: {}", err);
    let _ = std::fs::remove_dir_all(cwd);
    let _ = std::fs::remove_dir_all(store);
}

#[tokio::test]
async fn plan_written_rejects_tab_scoped_alias_and_forged_receipt_path() {
    let cwd = temp_base("alias-plan-cwd");
    let store = temp_base("alias-plan-store");
    let orch = BuildOrchestrator::new(store.clone());
    let state = orch
        .start_run("build-live-023e", "test", &cwd, "local")
        .await
        .unwrap();
    let alias_path = cwd.join("build.build-live-023e.other-run-id.md");
    let plan = approvable_build_plan();
    std::fs::write(&alias_path, plan).unwrap();
    let mut write = receipt(
        &state,
        BuildReceiptKind::FileWrite,
        BuildReceiptConfidence::ObservedAcp,
    );
    write.data = json!({ "path": alias_path.to_string_lossy() });
    let alias_error = orch
        .append_normalized_receipt(write)
        .await
        .expect_err("same-directory Build aliases must not become PlanWritten");
    assert!(
        alias_error.contains("owned run scratchboard"),
        "got: {alias_error}"
    );

    let mut forged = receipt(
        &state,
        BuildReceiptKind::PlanWritten,
        BuildReceiptConfidence::ObservedAcp,
    );
    forged.data = json!({ "scratchboardPath": alias_path.to_string_lossy() });
    let forged_receipt_id = forged.receipt_id.clone();
    let forged_error = orch
        .append_normalized_receipt(forged)
        .await
        .expect_err("PlanWritten must reject a claimed scratchboard alias");
    assert!(
        forged_error.contains("owned run scratchboard"),
        "got: {forged_error}"
    );

    let updated = orch.get_state("build-live-023e").await.unwrap();
    assert_eq!(updated.status, BuildRunStatus::Draft);
    assert_eq!(updated.scratchboard_path, state.scratchboard_path,);
    assert!(
        !updated.code_changed,
        "rejected scratchboard claims must not trip code-change gates"
    );
    let receipts = orch.get_receipts("build-live-023e").await.unwrap();
    assert!(
        receipts
            .iter()
            .all(|receipt| receipt.kind != BuildReceiptKind::PlanWritten),
        "rejected aliases must not be persisted as plan evidence"
    );
    assert!(
        receipts
            .iter()
            .all(|receipt| receipt.receipt_id != forged_receipt_id),
        "a rejected PlanWritten receipt must not create a ledger record"
    );
    assert_eq!(std::fs::read_to_string(&alias_path).unwrap(), plan);
    let _ = std::fs::remove_dir_all(cwd);
    let _ = std::fs::remove_dir_all(store);
}

#[tokio::test]
async fn loading_a_run_repairs_its_display_path_in_memory_until_a_normal_transition() {
    let cwd = temp_base("repair-path-cwd");
    let store = temp_base("repair-path-store");
    let writer = BuildOrchestrator::new(store.clone());
    let started = writer
        .start_run("build-repair-tab", "test", &cwd, "local")
        .await
        .unwrap();
    let mut forged = crate::build_store::read_latest_state_for_tab(&store, "build-repair-tab")
        .unwrap()
        .expect("persisted Build state");
    forged.scratchboard_path = cwd
        .join("build.build-repair-tab.forged.md")
        .display()
        .to_string();
    crate::build_store::write_state(&store, &forged).unwrap();
    writer.clear_tab("build-repair-tab").await;

    let reader = BuildOrchestrator::new(store.clone());
    let restored = reader
        .get_state("build-repair-tab")
        .await
        .expect("repaired Build state");
    assert_eq!(restored.scratchboard_path, started.scratchboard_path);
    let persisted = crate::build_store::read_latest_state_for_tab(&store, "build-repair-tab")
        .unwrap()
        .expect("persisted Build state");
    assert_eq!(persisted.scratchboard_path, forged.scratchboard_path);

    let mut ordinary_write = receipt(
        &restored,
        BuildReceiptKind::FileWrite,
        BuildReceiptConfidence::ObservedAcp,
    );
    ordinary_write.data = json!({ "path": cwd.join("ordinary-file.rs") });
    reader.append_receipt(ordinary_write).await.unwrap();
    let persisted_after_transition =
        crate::build_store::read_latest_state_for_tab(&store, "build-repair-tab")
            .unwrap()
            .expect("persisted Build state after normal transition");
    assert_eq!(
        persisted_after_transition.scratchboard_path,
        started.scratchboard_path
    );

    let _ = std::fs::remove_dir_all(cwd);
    let _ = std::fs::remove_dir_all(store);
}

#[tokio::test]
async fn ssh_build_without_session_context_refuses_scratchboard_io() {
    let cwd = temp_base("ssh-context-cwd");
    let store = temp_base("ssh-context-store");
    let orch = BuildOrchestrator::new(store.clone());
    orch.start_run("build-ssh-context", "test", &cwd, "ssh")
        .await
        .unwrap();
    let runtime = orch
        .states
        .read()
        .await
        .get("build-ssh-context")
        .cloned()
        .expect("Build runtime");

    let read = read_owned_build_scratchboard(&runtime)
        .await
        .expect_err("SSH Build reads need a session-owned transport context");
    assert!(
        read.contains("session-owned SSH transport context"),
        "got: {read}"
    );
    let write = write_owned_build_scratchboard(&runtime, "fixture")
        .await
        .expect_err("SSH Build writes need a session-owned transport context");
    assert!(
        write.contains("session-owned SSH transport context"),
        "got: {write}"
    );

    let _ = std::fs::remove_dir_all(cwd);
    let _ = std::fs::remove_dir_all(store);
}

#[tokio::test]
async fn build_complete_rejects_missing_review_gate() {
    let cwd = temp_base("reject-cwd");
    let store = temp_base("reject-store");
    initialize_owned_git_fixture(&cwd);
    let orch = BuildOrchestrator::new(store.clone());
    let state = orch.start_run("tab1", "test", &cwd, "local").await.unwrap();
    std::fs::write(&state.scratchboard_path, complete_board()).unwrap();
    append_owned_git_checkpoint(&orch, &state).await;
    {
        let mut map = orch.states.write().await;
        let runtime = map.get_mut("tab1").unwrap();
        runtime.state.status = BuildRunStatus::Active;
        runtime.state.verification_required = false;
    }
    let err = orch.validate_complete("tab1", "done").await.unwrap_err();
    assert!(err.contains("reviewer receipt"), "got: {}", err);
    let _ = std::fs::remove_dir_all(cwd);
    let _ = std::fs::remove_dir_all(store);
    let _ = state;
}

#[tokio::test]
async fn build_complete_rejects_weak_review_gate_receipt() {
    let cwd = temp_base("weak-review-cwd");
    let store = temp_base("weak-review-store");
    initialize_owned_git_fixture(&cwd);
    let orch = BuildOrchestrator::new(store.clone());
    let state = orch.start_run("tab1", "test", &cwd, "local").await.unwrap();
    std::fs::write(&state.scratchboard_path, complete_board()).unwrap();
    append_owned_git_checkpoint(&orch, &state).await;
    {
        let mut map = orch.states.write().await;
        let runtime = map.get_mut("tab1").unwrap();
        runtime.state.status = BuildRunStatus::Active;
    }
    let mut weak_review = receipt(
        &state,
        BuildReceiptKind::ReviewCompleted,
        BuildReceiptConfidence::TrustedHost,
    );
    weak_review.data = json!({
        "persona": "reviewer",
        "status": "completed",
        "stdoutChars": 2,
        "gateEvidence": {
            "accepted": false,
            "reason": "too little reviewer output",
            "matchedMarkers": [],
            "stdoutChars": 2
        }
    });
    orch.append_receipt(weak_review).await.unwrap();
    orch.append_receipt(receipt(
        &state,
        BuildReceiptKind::VerificationCompleted,
        BuildReceiptConfidence::TrustedHost,
    ))
    .await
    .unwrap();

    let updated = orch.get_state("tab1").await.unwrap();
    assert!(
        !updated.review_satisfied,
        "weak reviewer output must not satisfy review gate"
    );
    let err = orch.validate_complete("tab1", "done").await.unwrap_err();
    assert!(err.contains("reviewer receipt"), "got: {}", err);
    assert!(err.contains("evidence"), "got: {}", err);

    let _ = std::fs::remove_dir_all(cwd);
    let _ = std::fs::remove_dir_all(store);
}

#[tokio::test]
async fn build_complete_rejects_weak_verification_gate_receipt() {
    let cwd = temp_base("weak-verification-cwd");
    let store = temp_base("weak-verification-store");
    initialize_owned_git_fixture(&cwd);
    let orch = BuildOrchestrator::new(store.clone());
    let state = orch.start_run("tab1", "test", &cwd, "local").await.unwrap();
    std::fs::write(&state.scratchboard_path, complete_board()).unwrap();
    append_owned_git_checkpoint(&orch, &state).await;
    {
        let mut map = orch.states.write().await;
        let runtime = map.get_mut("tab1").unwrap();
        runtime.state.status = BuildRunStatus::Active;
    }
    orch.append_receipt(receipt(
        &state,
        BuildReceiptKind::ReviewCompleted,
        BuildReceiptConfidence::TrustedHost,
    ))
    .await
    .unwrap();
    let mut weak_verification = receipt(
        &state,
        BuildReceiptKind::VerificationCompleted,
        BuildReceiptConfidence::TrustedHost,
    );
    weak_verification.data = json!({
        "persona": "verifier",
        "status": "completed",
        "stdoutChars": 2,
        "gateEvidence": {
            "accepted": false,
            "reason": "too little verifier output",
            "matchedMarkers": [],
            "stdoutChars": 2
        }
    });
    orch.append_receipt(weak_verification).await.unwrap();

    let updated = orch.get_state("tab1").await.unwrap();
    assert!(
        !updated.verification_satisfied,
        "weak verifier output must not satisfy verification gate"
    );
    let err = orch.validate_complete("tab1", "done").await.unwrap_err();
    assert!(err.contains("verification receipt"), "got: {}", err);
    assert!(err.contains("evidence"), "got: {}", err);

    let _ = std::fs::remove_dir_all(cwd);
    let _ = std::fs::remove_dir_all(store);
}

#[tokio::test]
async fn build_complete_rejects_missing_preview_gate_for_ui_work() {
    let cwd = temp_base("reject-preview-cwd");
    let store = temp_base("reject-preview-store");
    let orch = BuildOrchestrator::new(store.clone());
    let state = orch
        .start_run("tab1", "build a web page", &cwd, "local")
        .await
        .unwrap();
    assert!(state.preview_required);
    std::fs::write(&state.scratchboard_path, complete_board()).unwrap();
    {
        let mut map = orch.states.write().await;
        map.get_mut("tab1").unwrap().state.status = BuildRunStatus::Active;
    }
    let err = orch.validate_complete("tab1", "done").await.unwrap_err();
    assert!(err.contains("Preview Doctor"), "got: {}", err);

    let mut preview = receipt(
        &state,
        BuildReceiptKind::PreviewDiagnosed,
        BuildReceiptConfidence::TrustedHost,
    );
    preview.data = json!({
        "ok": true,
        "url": "http://localhost:12345/",
        "summary": "Preview Doctor passed"
    });
    orch.append_receipt(preview).await.unwrap();
    orch.validate_complete("tab1", "done").await.unwrap();

    let _ = std::fs::remove_dir_all(cwd);
    let _ = std::fs::remove_dir_all(store);
}

#[test]
fn preview_gate_ignores_non_visual_browser_sdk_objectives() {
    assert!(!build_objective_requires_preview(
            "Create a standalone TypeScript package called shellx-browser-driver-sdk for the Browser Debug API over HTTP. No UI."
        ));
    assert!(!build_objective_requires_preview(
        "Build a browser automation SDK with CLI examples"
    ));
    assert!(build_objective_requires_preview("build a web page"));
    assert!(build_objective_requires_preview(
        "build a browser settings screen"
    ));
    assert!(!build_objective_requires_preview(
        "Create one new plain text data file. Preserve README.md and dist/index.html. This changes no application code or UI, so skip unrelated UI previews."
    ));
    assert!(build_objective_requires_preview(
        "Create a plain text data file and build a web page"
    ));
}

#[tokio::test]
async fn browser_debug_api_sdk_build_can_complete_without_preview_gate() {
    let cwd = temp_base("browser-sdk-no-preview-cwd");
    let store = temp_base("browser-sdk-no-preview-store");
    let orch = BuildOrchestrator::new(store.clone());
    let state = orch
            .start_run(
                "tab1",
                "Create a standalone TypeScript package called shellx-browser-driver-sdk for the Browser Debug API over HTTP. No UI.",
                &cwd,
                "local",
            )
            .await
            .unwrap();
    assert!(
        !state.preview_required,
        "Browser Debug API SDK work must not require Preview Doctor"
    );
    std::fs::write(&state.scratchboard_path, complete_board()).unwrap();
    {
        let mut map = orch.states.write().await;
        map.get_mut("tab1").unwrap().state.status = BuildRunStatus::Active;
    }
    orch.validate_complete("tab1", "done").await.unwrap();

    let _ = std::fs::remove_dir_all(cwd);
    let _ = std::fs::remove_dir_all(store);
}

#[tokio::test]
async fn build_complete_detects_dirty_git_worktree_without_file_receipt() {
    let cwd = temp_base("dirty-git-cwd");
    let store = temp_base("dirty-git-store");
    run_git(&cwd, &["init"]);
    run_git(
        &cwd,
        &["config", "user.email", "shellx-test@example.invalid"],
    );
    run_git(&cwd, &["config", "user.name", "shellX Test"]);
    std::fs::write(cwd.join("message.txt"), "before\n").unwrap();
    run_git(&cwd, &["add", "message.txt"]);
    run_git(&cwd, &["commit", "-m", "initial"]);
    std::fs::write(cwd.join("message.txt"), "after\n").unwrap();

    let orch = BuildOrchestrator::new(store.clone());
    let state = orch.start_run("tab1", "test", &cwd, "local").await.unwrap();
    std::fs::write(&state.scratchboard_path, complete_board()).unwrap();
    {
        let mut map = orch.states.write().await;
        map.get_mut("tab1").unwrap().state.status = BuildRunStatus::Active;
    }

    let err = orch.validate_complete("tab1", "done").await.unwrap_err();
    assert!(err.contains("checkpoint receipt"), "got: {}", err);
    let updated = orch.get_state("tab1").await.unwrap();
    assert!(
        updated.code_changed,
        "dirty git worktree should mark code_changed"
    );
    assert!(
        updated.review_required,
        "dirty git worktree should require review"
    );
    assert!(
        updated.verification_required,
        "dirty git worktree should require verification"
    );

    let _ = std::fs::remove_dir_all(cwd);
    let _ = std::fs::remove_dir_all(store);
}

#[tokio::test]
async fn manual_mark_complete_uses_completion_gates() {
    let cwd = temp_base("manual-complete-cwd");
    let store = temp_base("manual-complete-store");
    initialize_owned_git_fixture(&cwd);
    let orch = BuildOrchestrator::new(store.clone());
    let state = orch.start_run("tab1", "test", &cwd, "local").await.unwrap();
    std::fs::write(&state.scratchboard_path, complete_board()).unwrap();
    append_owned_git_checkpoint(&orch, &state).await;
    {
        let mut map = orch.states.write().await;
        let runtime = map.get_mut("tab1").unwrap();
        runtime.state.status = BuildRunStatus::Active;
    }

    let err = orch.mark_complete("tab1", "done").await.unwrap_err();
    assert!(err.contains("reviewer receipt"), "got: {}", err);
    assert_eq!(
        orch.get_state("tab1").await.unwrap().status,
        BuildRunStatus::Active
    );
    let _ = std::fs::remove_dir_all(cwd);
    let _ = std::fs::remove_dir_all(store);
}

#[tokio::test]
async fn build_complete_accepts_required_receipts() {
    let cwd = temp_base("accept-cwd");
    let store = temp_base("accept-store");
    initialize_owned_git_fixture(&cwd);
    let orch = BuildOrchestrator::new(store.clone());
    let state = orch.start_run("tab1", "test", &cwd, "local").await.unwrap();
    std::fs::write(&state.scratchboard_path, complete_board()).unwrap();
    append_owned_git_checkpoint(&orch, &state).await;
    {
        let mut map = orch.states.write().await;
        let runtime = map.get_mut("tab1").unwrap();
        runtime.state.status = BuildRunStatus::Active;
    }
    orch.append_receipt(receipt(
        &state,
        BuildReceiptKind::ReviewCompleted,
        BuildReceiptConfidence::TrustedHost,
    ))
    .await
    .unwrap();
    orch.append_receipt(receipt(
        &state,
        BuildReceiptKind::VerificationCompleted,
        BuildReceiptConfidence::ObservedAcp,
    ))
    .await
    .unwrap();
    orch.validate_complete("tab1", "done").await.unwrap();
    assert_eq!(
        orch.get_state("tab1").await.unwrap().status,
        BuildRunStatus::Complete
    );
    let _ = std::fs::remove_dir_all(cwd);
    let _ = std::fs::remove_dir_all(store);
}

#[tokio::test]
async fn agent_checkpoint_marker_for_nongit_requires_review_and_verification() {
    let cwd = temp_base("agent-nongit-cwd");
    let store = temp_base("agent-nongit-store");
    let orch = BuildOrchestrator::new(store.clone());
    let state = orch.start_run("tab1", "test", &cwd, "local").await.unwrap();
    std::fs::write(&state.scratchboard_path, complete_board()).unwrap();
    {
        let mut map = orch.states.write().await;
        map.get_mut("tab1").unwrap().state.status = BuildRunStatus::Active;
    }

    let mut checkpoint = receipt(
        &state,
        BuildReceiptKind::CheckpointCreated,
        BuildReceiptConfidence::TrustedHost,
    );
    checkpoint.data = json!({
        "checkpointId": "agent-implementer-complete-nongit",
        "agentCodeChange": true,
        "checkpointUnavailable": true,
        "checkpointUnavailableReason": "git rev-parse failed",
    });
    orch.append_receipt(checkpoint).await.unwrap();

    let gated = orch.get_state("tab1").await.unwrap();
    assert!(gated.code_changed);
    assert_eq!(
        gated.checkpoint_id.as_deref(),
        Some("agent-implementer-complete-nongit")
    );
    assert!(gated.review_required);
    assert!(gated.verification_required);

    let err = orch.validate_complete("tab1", "done").await.unwrap_err();
    assert!(err.contains("reviewer receipt"), "got: {}", err);

    orch.append_receipt(receipt(
        &state,
        BuildReceiptKind::ReviewCompleted,
        BuildReceiptConfidence::TrustedHost,
    ))
    .await
    .unwrap();
    orch.append_receipt(receipt(
        &state,
        BuildReceiptKind::VerificationCompleted,
        BuildReceiptConfidence::ObservedAcp,
    ))
    .await
    .unwrap();
    orch.validate_complete("tab1", "done").await.unwrap();

    let _ = std::fs::remove_dir_all(cwd);
    let _ = std::fs::remove_dir_all(store);
}

#[tokio::test]
async fn nonlocal_build_complete_rejects_without_current_fingerprint() {
    let cwd = temp_base("nonlocal-no-fingerprint-cwd");
    let store = temp_base("nonlocal-no-fingerprint-store");
    let orch = BuildOrchestrator::new(store.clone());
    let state = orch.start_run("tab1", "test", &cwd, "wsl").await.unwrap();
    std::fs::write(&state.scratchboard_path, complete_board()).unwrap();
    {
        let mut map = orch.states.write().await;
        let runtime = map.get_mut("tab1").unwrap();
        runtime.state.status = BuildRunStatus::Active;
        runtime.state.code_changed = true;
        runtime.state.review_required = true;
        runtime.state.verification_required = true;
        runtime.state.checkpoint_id = Some("cp-1".into());
    }
    let mut checkpoint = receipt(
        &state,
        BuildReceiptKind::CheckpointCreated,
        BuildReceiptConfidence::TrustedHost,
    );
    checkpoint.data = json!({
        "checkpointId": "cp-1",
        "staged": 1,
        "unstaged": 0,
        "untracked": 0,
        "worktreeFingerprint": "fp-1",
    });
    orch.append_receipt(checkpoint).await.unwrap();
    orch.append_receipt(receipt(
        &state,
        BuildReceiptKind::ReviewCompleted,
        BuildReceiptConfidence::TrustedHost,
    ))
    .await
    .unwrap();
    orch.append_receipt(receipt(
        &state,
        BuildReceiptKind::VerificationCompleted,
        BuildReceiptConfidence::ObservedAcp,
    ))
    .await
    .unwrap();

    let err = orch.validate_complete("tab1", "done").await.unwrap_err();
    assert!(err.contains("current worktree fingerprint"), "got: {}", err);
    let _ = std::fs::remove_dir_all(cwd);
    let _ = std::fs::remove_dir_all(store);
}

#[tokio::test]
async fn nonlocal_build_complete_accepts_matching_current_fingerprint() {
    let cwd = temp_base("nonlocal-matching-fingerprint-cwd");
    let store = temp_base("nonlocal-matching-fingerprint-store");
    let orch = BuildOrchestrator::new(store.clone());
    let state = orch.start_run("tab1", "test", &cwd, "wsl").await.unwrap();
    std::fs::write(&state.scratchboard_path, complete_board()).unwrap();
    {
        let mut map = orch.states.write().await;
        let runtime = map.get_mut("tab1").unwrap();
        runtime.state.status = BuildRunStatus::Active;
        runtime.state.code_changed = true;
        runtime.state.review_required = true;
        runtime.state.verification_required = true;
        runtime.state.checkpoint_id = Some("cp-1".into());
    }
    let mut checkpoint = receipt(
        &state,
        BuildReceiptKind::CheckpointCreated,
        BuildReceiptConfidence::TrustedHost,
    );
    checkpoint.data = json!({
        "checkpointId": "cp-1",
        "staged": 1,
        "unstaged": 0,
        "untracked": 0,
        "worktreeFingerprint": "fp-1",
    });
    orch.append_receipt(checkpoint).await.unwrap();
    orch.append_receipt(receipt(
        &state,
        BuildReceiptKind::ReviewCompleted,
        BuildReceiptConfidence::TrustedHost,
    ))
    .await
    .unwrap();
    orch.append_receipt(receipt(
        &state,
        BuildReceiptKind::VerificationCompleted,
        BuildReceiptConfidence::ObservedAcp,
    ))
    .await
    .unwrap();

    orch.validate_complete_with_current_fingerprint("tab1", "done", Some("fp-1".into()))
        .await
        .unwrap();
    assert_eq!(
        orch.get_state("tab1").await.unwrap().status,
        BuildRunStatus::Complete
    );
    let _ = std::fs::remove_dir_all(cwd);
    let _ = std::fs::remove_dir_all(store);
}

#[tokio::test]
async fn build_complete_rejects_stale_checkpoint_fingerprint() {
    let cwd = temp_base("stale-checkpoint-cwd");
    let store = temp_base("stale-checkpoint-store");
    run_git(&cwd, &["init"]);
    run_git(
        &cwd,
        &["config", "user.email", "shellx-test@example.invalid"],
    );
    run_git(&cwd, &["config", "user.name", "shellX Test"]);
    std::fs::write(cwd.join("message.txt"), "before\n").unwrap();
    run_git(&cwd, &["add", "message.txt"]);
    run_git(&cwd, &["commit", "-m", "initial"]);

    let orch = BuildOrchestrator::new(store.clone());
    let state = orch.start_run("tab1", "test", &cwd, "local").await.unwrap();
    std::fs::write(&state.scratchboard_path, complete_board()).unwrap();
    {
        let mut map = orch.states.write().await;
        map.get_mut("tab1").unwrap().state.status = BuildRunStatus::Active;
    }

    std::fs::write(cwd.join("message.txt"), "checkpointed\n").unwrap();
    let fingerprint = crate::session_git::local_worktree_fingerprint(&cwd)
        .unwrap()
        .expect("git fingerprint");
    let mut checkpoint = receipt(
        &state,
        BuildReceiptKind::CheckpointCreated,
        BuildReceiptConfidence::TrustedHost,
    );
    checkpoint.data = json!({
        "checkpointId": "cp-1",
        "staged": 0,
        "unstaged": 1,
        "untracked": 0,
        "worktreeFingerprint": fingerprint,
    });
    orch.append_receipt(checkpoint).await.unwrap();
    orch.append_receipt(receipt(
        &state,
        BuildReceiptKind::ReviewCompleted,
        BuildReceiptConfidence::TrustedHost,
    ))
    .await
    .unwrap();
    orch.append_receipt(receipt(
        &state,
        BuildReceiptKind::VerificationCompleted,
        BuildReceiptConfidence::ObservedAcp,
    ))
    .await
    .unwrap();

    std::fs::write(cwd.join("message.txt"), "changed after checkpoint\n").unwrap();
    let err = orch.validate_complete("tab1", "done").await.unwrap_err();
    assert!(err.contains("checkpoint receipt"), "got: {}", err);
    let updated = orch.get_state("tab1").await.unwrap();
    assert!(updated.checkpoint_id.is_none());
    assert!(!updated.review_satisfied);
    assert!(!updated.verification_satisfied);

    let _ = std::fs::remove_dir_all(cwd);
    let _ = std::fs::remove_dir_all(store);
}

#[tokio::test]
async fn code_change_after_review_invalidates_completion_gates() {
    let cwd = temp_base("stale-gate-cwd");
    let store = temp_base("stale-gate-store");
    let orch = BuildOrchestrator::new(store.clone());
    let state = orch.start_run("tab1", "test", &cwd, "local").await.unwrap();
    std::fs::write(&state.scratchboard_path, complete_board()).unwrap();
    {
        let mut map = orch.states.write().await;
        let runtime = map.get_mut("tab1").unwrap();
        runtime.state.status = BuildRunStatus::Active;
        runtime.state.code_changed = true;
        runtime.state.review_required = true;
        runtime.state.verification_required = true;
        runtime.state.checkpoint_id = Some("cp-1".into());
    }
    orch.append_receipt(receipt(
        &state,
        BuildReceiptKind::ReviewCompleted,
        BuildReceiptConfidence::TrustedHost,
    ))
    .await
    .unwrap();
    orch.append_receipt(receipt(
        &state,
        BuildReceiptKind::VerificationCompleted,
        BuildReceiptConfidence::ObservedAcp,
    ))
    .await
    .unwrap();

    orch.append_receipt(receipt(
        &state,
        BuildReceiptKind::FileWrite,
        BuildReceiptConfidence::ObservedAcp,
    ))
    .await
    .unwrap();

    let updated = orch.get_state("tab1").await.unwrap();
    assert!(updated.checkpoint_id.is_none());
    assert!(!updated.review_satisfied);
    assert!(!updated.verification_satisfied);
    let err = orch.validate_complete("tab1", "done").await.unwrap_err();
    assert!(err.contains("checkpoint receipt"), "got: {}", err);

    let _ = std::fs::remove_dir_all(cwd);
    let _ = std::fs::remove_dir_all(store);
}

#[tokio::test]
async fn build_evidence_log_write_does_not_invalidate_completion_gates() {
    let cwd = temp_base("evidence-log-cwd");
    let store = temp_base("evidence-log-store");
    let orch = BuildOrchestrator::new(store.clone());
    let state = orch.start_run("tab1", "test", &cwd, "local").await.unwrap();
    std::fs::write(&state.scratchboard_path, complete_board()).unwrap();
    {
        let mut map = orch.states.write().await;
        let runtime = map.get_mut("tab1").unwrap();
        runtime.state.status = BuildRunStatus::Active;
        runtime.state.code_changed = true;
        runtime.state.review_required = true;
        runtime.state.verification_required = true;
        runtime.state.checkpoint_id = Some("cp-1".into());
    }
    orch.append_receipt(receipt(
        &state,
        BuildReceiptKind::ReviewCompleted,
        BuildReceiptConfidence::TrustedHost,
    ))
    .await
    .unwrap();
    orch.append_receipt(receipt(
        &state,
        BuildReceiptKind::VerificationCompleted,
        BuildReceiptConfidence::ObservedAcp,
    ))
    .await
    .unwrap();

    let evidence_path = cwd.join("build.md");
    std::fs::write(
            &evidence_path,
            "# shellX Build Evidence Log\n\nBuild Mode scratchboard: build.tab1.test.md\n\nCall build_complete after gates pass.\n",
        )
        .unwrap();
    let mut evidence_write = receipt(
        &state,
        BuildReceiptKind::FileWrite,
        BuildReceiptConfidence::ObservedAcp,
    );
    evidence_write.data = json!({ "path": evidence_path.to_string_lossy() });
    orch.append_receipt(evidence_write).await.unwrap();

    let updated = orch.get_state("tab1").await.unwrap();
    assert_eq!(updated.checkpoint_id.as_deref(), Some("cp-1"));
    assert!(updated.review_satisfied);
    assert!(updated.verification_satisfied);
    let receipts = orch.get_receipts("tab1").await.unwrap();
    let evidence_receipt = receipts
        .iter()
        .rev()
        .find(|r| r.kind == BuildReceiptKind::FileWrite)
        .expect("evidence fileWrite receipt");
    assert_eq!(
        evidence_receipt
            .data
            .get("buildEvidenceLog")
            .and_then(|v| v.as_bool()),
        Some(true)
    );

    let _ = std::fs::remove_dir_all(cwd);
    let _ = std::fs::remove_dir_all(store);
}

#[test]
fn git_dirty_check_ignores_recognized_build_evidence_log() {
    let cwd = temp_base("evidence-log-git-cwd");
    run_git(&cwd, &["init"]);
    run_git(
        &cwd,
        &["config", "user.email", "shellx-test@example.invalid"],
    );
    run_git(&cwd, &["config", "user.name", "shellX Test"]);
    std::fs::write(cwd.join("index.html"), "<h1>ok</h1>\n").unwrap();
    run_git(&cwd, &["add", "index.html"]);
    run_git(&cwd, &["commit", "-m", "initial"]);
    let scratchboard = cwd.join("build.tab1.abc123.md");
    std::fs::write(&scratchboard, complete_board()).unwrap();
    std::fs::write(
            cwd.join("build.md"),
            "# shellX Build Evidence Log\n\nBuild Mode scratchboard: build.tab1.abc123.md\n\nCall build_complete after gates pass.\n",
        )
        .unwrap();

    assert!(
        !local_git_worktree_has_code_changes(&cwd, &scratchboard),
        "recognized Build Mode evidence log should not dirty completion gates"
    );
    std::fs::write(cwd.join("notes.md"), "real code-adjacent change\n").unwrap();
    assert!(local_git_worktree_has_code_changes(&cwd, &scratchboard));

    let _ = std::fs::remove_dir_all(cwd);
}

#[tokio::test]
async fn halt_marks_run_halted_without_accepting_completion() {
    let cwd = temp_base("halt-cwd");
    let store = temp_base("halt-store");
    let orch = BuildOrchestrator::new(store.clone());
    let state = orch.start_run("tab1", "test", &cwd, "local").await.unwrap();
    {
        let mut map = orch.states.write().await;
        map.get_mut("tab1").unwrap().state.status = BuildRunStatus::Active;
    }

    assert!(orch.halt("tab1", "Stopped from cockpit").await.unwrap());
    let halted = orch.get_state("tab1").await.unwrap();
    assert_eq!(halted.status, BuildRunStatus::Halted);
    let receipts = orch.get_receipts("tab1").await.unwrap();
    assert!(receipts
        .iter()
        .any(|r| r.kind == BuildReceiptKind::RunHalted));
    assert!(!receipts
        .iter()
        .any(|r| r.kind == BuildReceiptKind::CompletionAccepted));
    let _ = std::fs::remove_dir_all(cwd);
    let _ = std::fs::remove_dir_all(store);
    let _ = state;
}

#[tokio::test]
async fn checkpoint_with_diff_marks_code_changed_and_requires_gates() {
    let cwd = temp_base("checkpoint-diff-cwd");
    let store = temp_base("checkpoint-diff-store");
    let orch = BuildOrchestrator::new(store.clone());
    let state = orch.start_run("tab1", "test", &cwd, "wsl").await.unwrap();
    {
        let mut map = orch.states.write().await;
        map.get_mut("tab1").unwrap().state.status = BuildRunStatus::Active;
    }

    let mut checkpoint = receipt(
        &state,
        BuildReceiptKind::CheckpointCreated,
        BuildReceiptConfidence::TrustedHost,
    );
    checkpoint.data = json!({
        "checkpointId": "cp-1",
        "staged": 0,
        "unstaged": 1,
        "untracked": 0,
    });
    orch.append_receipt(checkpoint).await.unwrap();

    let updated = orch.get_state("tab1").await.unwrap();
    assert!(updated.code_changed);
    assert!(updated.review_required);
    assert!(updated.verification_required);
    assert_eq!(updated.checkpoint_id.as_deref(), Some("cp-1"));
    let _ = std::fs::remove_dir_all(cwd);
    let _ = std::fs::remove_dir_all(store);
}

#[tokio::test]
async fn bookkeeping_checkpoint_preserves_satisfied_gates() {
    let cwd = temp_base("checkpoint-bookkeeping-cwd");
    let store = temp_base("checkpoint-bookkeeping-store");
    let orch = BuildOrchestrator::new(store.clone());
    let state = orch.start_run("tab1", "test", &cwd, "wsl").await.unwrap();
    {
        let mut map = orch.states.write().await;
        let st = &mut map.get_mut("tab1").unwrap().state;
        st.status = BuildRunStatus::Active;
        st.code_changed = true;
        st.review_required = true;
        st.review_satisfied = true;
        st.verification_required = true;
        st.verification_satisfied = true;
        st.checkpoint_id = Some("cp-before".into());
    }

    let mut checkpoint = receipt(
        &state,
        BuildReceiptKind::CheckpointCreated,
        BuildReceiptConfidence::TrustedHost,
    );
    checkpoint.data = json!({
        "checkpointId": "post-verifier-reviewed-state",
        "staged": 0,
        "unstaged": 3,
        "untracked": 4,
        "conflicts": 0,
    });
    orch.append_receipt(checkpoint).await.unwrap();

    let updated = orch.get_state("tab1").await.unwrap();
    assert_eq!(
        updated.checkpoint_id.as_deref(),
        Some("post-verifier-reviewed-state")
    );
    assert!(updated.review_satisfied);
    assert!(updated.verification_satisfied);
    let _ = std::fs::remove_dir_all(cwd);
    let _ = std::fs::remove_dir_all(store);
}

#[tokio::test]
async fn code_writer_checkpoint_requires_fresh_gates() {
    let cwd = temp_base("checkpoint-code-writer-cwd");
    let store = temp_base("checkpoint-code-writer-store");
    let orch = BuildOrchestrator::new(store.clone());
    let state = orch.start_run("tab1", "test", &cwd, "wsl").await.unwrap();
    {
        let mut map = orch.states.write().await;
        let st = &mut map.get_mut("tab1").unwrap().state;
        st.status = BuildRunStatus::Active;
        st.code_changed = true;
        st.review_required = true;
        st.review_satisfied = true;
        st.verification_required = true;
        st.verification_satisfied = true;
        st.checkpoint_id = Some("cp-before".into());
    }

    let mut checkpoint = receipt(
        &state,
        BuildReceiptKind::CheckpointCreated,
        BuildReceiptConfidence::TrustedHost,
    );
    checkpoint.data = json!({
        "checkpointId": "1779832326218-agent-test-writer-complete",
        "staged": 0,
        "unstaged": 3,
        "untracked": 4,
        "conflicts": 0,
    });
    orch.append_receipt(checkpoint).await.unwrap();

    let updated = orch.get_state("tab1").await.unwrap();
    assert_eq!(
        updated.checkpoint_id.as_deref(),
        Some("1779832326218-agent-test-writer-complete")
    );
    assert!(!updated.review_satisfied);
    assert!(!updated.verification_satisfied);
    let _ = std::fs::remove_dir_all(cwd);
    let _ = std::fs::remove_dir_all(store);
}

#[tokio::test]
async fn no_op_test_writer_checkpoint_preserves_satisfied_gates() {
    let cwd = temp_base("checkpoint-test-writer-noop-cwd");
    let store = temp_base("checkpoint-test-writer-noop-store");
    let orch = BuildOrchestrator::new(store.clone());
    let state = orch.start_run("tab1", "test", &cwd, "wsl").await.unwrap();
    {
        let mut map = orch.states.write().await;
        let st = &mut map.get_mut("tab1").unwrap().state;
        st.status = BuildRunStatus::Active;
        st.code_changed = true;
        st.review_required = true;
        st.verification_required = true;
    }

    let mut implementation_checkpoint = receipt(
        &state,
        BuildReceiptKind::CheckpointCreated,
        BuildReceiptConfidence::TrustedHost,
    );
    implementation_checkpoint.data = json!({
        "checkpointId": "post-implementer-buildstamp",
        "staged": 0,
        "unstaged": 2,
        "untracked": 1,
        "conflicts": 0,
        "buildWorktreeFingerprint": "fp-1",
    });
    orch.append_receipt(implementation_checkpoint)
        .await
        .unwrap();
    orch.append_receipt(receipt(
        &state,
        BuildReceiptKind::ReviewCompleted,
        BuildReceiptConfidence::TrustedHost,
    ))
    .await
    .unwrap();
    orch.append_receipt(receipt(
        &state,
        BuildReceiptKind::VerificationCompleted,
        BuildReceiptConfidence::TrustedHost,
    ))
    .await
    .unwrap();

    let mut no_op_test_writer_checkpoint = receipt(
        &state,
        BuildReceiptKind::CheckpointCreated,
        BuildReceiptConfidence::TrustedHost,
    );
    no_op_test_writer_checkpoint.data = json!({
        "checkpointId": "1779836703735-agent-test-writer-complete",
        "staged": 0,
        "unstaged": 2,
        "untracked": 2,
        "conflicts": 0,
        "buildWorktreeFingerprint": "fp-1",
    });
    orch.append_receipt(no_op_test_writer_checkpoint)
        .await
        .unwrap();

    let updated = orch.get_state("tab1").await.unwrap();
    assert!(updated.review_satisfied);
    assert!(updated.verification_satisfied);

    let mut real_test_writer_checkpoint = receipt(
        &state,
        BuildReceiptKind::CheckpointCreated,
        BuildReceiptConfidence::TrustedHost,
    );
    real_test_writer_checkpoint.data = json!({
        "checkpointId": "1779836703999-agent-test-writer-complete",
        "staged": 0,
        "unstaged": 3,
        "untracked": 2,
        "conflicts": 0,
        "buildWorktreeFingerprint": "fp-2",
    });
    orch.append_receipt(real_test_writer_checkpoint)
        .await
        .unwrap();

    let updated = orch.get_state("tab1").await.unwrap();
    assert!(!updated.review_satisfied);
    assert!(!updated.verification_satisfied);
    let _ = std::fs::remove_dir_all(cwd);
    let _ = std::fs::remove_dir_all(store);
}

#[tokio::test]
async fn release_manager_checkpoint_preserves_satisfied_gates() {
    let cwd = temp_base("checkpoint-release-manager-cwd");
    let store = temp_base("checkpoint-release-manager-store");
    let orch = BuildOrchestrator::new(store.clone());
    let state = orch.start_run("tab1", "test", &cwd, "wsl").await.unwrap();
    {
        let mut map = orch.states.write().await;
        let st = &mut map.get_mut("tab1").unwrap().state;
        st.status = BuildRunStatus::Active;
        st.code_changed = true;
        st.review_required = true;
        st.review_satisfied = true;
        st.verification_required = true;
        st.verification_satisfied = true;
        st.checkpoint_id = Some("cp-before".into());
    }

    let mut checkpoint = receipt(
        &state,
        BuildReceiptKind::CheckpointCreated,
        BuildReceiptConfidence::TrustedHost,
    );
    checkpoint.data = json!({
        "checkpointId": "1779835948461-agent-release-manager-complete",
        "staged": 0,
        "unstaged": 2,
        "untracked": 3,
        "conflicts": 0,
    });
    orch.append_receipt(checkpoint).await.unwrap();

    let updated = orch.get_state("tab1").await.unwrap();
    assert_eq!(
        updated.checkpoint_id.as_deref(),
        Some("1779835948461-agent-release-manager-complete")
    );
    assert!(updated.review_satisfied);
    assert!(updated.verification_satisfied);
    let _ = std::fs::remove_dir_all(cwd);
    let _ = std::fs::remove_dir_all(store);
}

#[tokio::test]
async fn transport_failure_marks_active_run_failed() {
    let cwd = temp_base("transport-failure-cwd");
    let store = temp_base("transport-failure-store");
    let orch = BuildOrchestrator::new(store.clone());
    orch.start_run("tab1", "test", &cwd, "ssh").await.unwrap();
    {
        let mut map = orch.states.write().await;
        map.get_mut("tab1").unwrap().state.status = BuildRunStatus::Active;
    }

    assert!(orch
        .mark_transport_failed("tab1", "responses API error: 403")
        .await
        .unwrap());
    let failed = orch.get_state("tab1").await.unwrap();
    assert_eq!(failed.status, BuildRunStatus::TransportFailed);
    let receipts = orch.get_receipts("tab1").await.unwrap();
    assert!(receipts.iter().any(|r| {
        r.kind == BuildReceiptKind::TransportFailure && r.summary.contains("responses API error")
    }));
    let _ = std::fs::remove_dir_all(cwd);
    let _ = std::fs::remove_dir_all(store);
}

#[tokio::test]
async fn resume_recovers_transport_failed_run_after_auth_refresh() {
    let cwd = temp_base("transport-resume-cwd");
    let store = temp_base("transport-resume-store");
    let orch = BuildOrchestrator::new(store.clone());
    orch.start_run("tab1", "test", &cwd, "local").await.unwrap();
    {
        let mut map = orch.states.write().await;
        map.get_mut("tab1").unwrap().state.status = BuildRunStatus::Active;
    }

    assert!(orch
        .mark_transport_failed("tab1", "responses API error: 401")
        .await
        .unwrap());
    assert!(orch.resume("tab1").await.unwrap());
    let resumed = orch.get_state("tab1").await.unwrap();
    assert_eq!(resumed.status, BuildRunStatus::Active);

    let _ = std::fs::remove_dir_all(cwd);
    let _ = std::fs::remove_dir_all(store);
}

#[tokio::test]
async fn resume_active_run_returns_true_for_reinject_after_reconnect() {
    let cwd = temp_base("active-resume-reinject-cwd");
    let store = temp_base("active-resume-reinject-store");
    let orch = BuildOrchestrator::new(store.clone());
    orch.start_run("tab1", "test", &cwd, "local").await.unwrap();
    {
        let mut map = orch.states.write().await;
        map.get_mut("tab1").unwrap().state.status = BuildRunStatus::Active;
    }

    assert!(orch.resume("tab1").await.unwrap());
    let resumed = orch.get_state("tab1").await.unwrap();
    assert_eq!(resumed.status, BuildRunStatus::Active);

    let _ = std::fs::remove_dir_all(cwd);
    let _ = std::fs::remove_dir_all(store);
}

#[tokio::test]
async fn resume_recovers_persisted_transport_failed_run_after_restart() {
    let cwd = temp_base("transport-resume-persisted-cwd");
    let store = temp_base("transport-resume-persisted-store");
    let writer = BuildOrchestrator::new(store.clone());
    writer
        .start_run("tab1", "test", &cwd, "local")
        .await
        .unwrap();
    {
        let mut map = writer.states.write().await;
        map.get_mut("tab1").unwrap().state.status = BuildRunStatus::Active;
    }
    assert!(writer
        .mark_transport_failed("tab1", "responses API error: 401")
        .await
        .unwrap());

    let reader = BuildOrchestrator::new(store.clone());
    assert!(reader.resume("tab1").await.unwrap());
    let resumed = reader.get_state("tab1").await.unwrap();
    assert_eq!(resumed.status, BuildRunStatus::Active);

    let _ = std::fs::remove_dir_all(cwd);
    let _ = std::fs::remove_dir_all(store);
}

#[tokio::test]
async fn operator_note_can_queue_on_persisted_transport_failed_run() {
    let cwd = temp_base("transport-note-persisted-cwd");
    let store = temp_base("transport-note-persisted-store");
    let writer = BuildOrchestrator::new(store.clone());
    writer
        .start_run("tab1", "test", &cwd, "local")
        .await
        .unwrap();
    {
        let mut map = writer.states.write().await;
        map.get_mut("tab1").unwrap().state.status = BuildRunStatus::Active;
    }
    assert!(writer
        .mark_transport_failed("tab1", "responses API error: 401")
        .await
        .unwrap());

    let reader = BuildOrchestrator::new(store.clone());
    let note = reader
        .add_operator_note("tab1", "auth popup completed; continue existing build")
        .await
        .unwrap();
    assert!(note.text.contains("auth popup"));
    let state = reader.get_state("tab1").await.unwrap();
    assert_eq!(state.pending_operator_notes.len(), 1);

    let _ = std::fs::remove_dir_all(cwd);
    let _ = std::fs::remove_dir_all(store);
}

#[tokio::test]
async fn resume_transport_failure_clears_stale_satisfied_blocker() {
    let cwd = temp_base("transport-resume-blocker-cwd");
    let store = temp_base("transport-resume-blocker-store");
    let orch = BuildOrchestrator::new(store.clone());
    let state = orch.start_run("tab1", "test", &cwd, "local").await.unwrap();
    {
        let mut map = orch.states.write().await;
        map.get_mut("tab1").unwrap().state.status = BuildRunStatus::Active;
    }

    let mut blocker = receipt(
        &state,
        BuildReceiptKind::BlockerOpened,
        BuildReceiptConfidence::TrustedHost,
    );
    blocker.summary = "review blocked until reviewer Agent completes".into();
    orch.append_receipt(blocker).await.unwrap();
    orch.append_receipt(receipt(
        &state,
        BuildReceiptKind::ReviewCompleted,
        BuildReceiptConfidence::TrustedHost,
    ))
    .await
    .unwrap();
    assert!(orch
        .mark_transport_failed("tab1", "responses API error: 401")
        .await
        .unwrap());

    assert!(orch.resume("tab1").await.unwrap());
    let resumed = orch.get_state("tab1").await.unwrap();
    assert_eq!(resumed.status, BuildRunStatus::Active);
    assert_eq!(resumed.open_blocker, None);

    let _ = std::fs::remove_dir_all(cwd);
    let _ = std::fs::remove_dir_all(store);
}

#[tokio::test]
async fn reads_persisted_state_and_receipts_when_run_is_not_active() {
    let cwd = temp_base("persisted-read-cwd");
    let store = temp_base("persisted-read-store");
    let writer = BuildOrchestrator::new(store.clone());
    let state = writer
        .start_run("tab1", "test", &cwd, "local")
        .await
        .unwrap();
    writer.clear_tab("tab1").await;

    let reader = BuildOrchestrator::new(store.clone());
    let loaded = reader.get_state("tab1").await.unwrap();
    assert_eq!(loaded.run_id, state.run_id);

    let receipts = reader.get_receipts("tab1").await.unwrap();
    assert!(receipts
        .iter()
        .any(|r| r.kind == BuildReceiptKind::RunStarted));

    let _ = std::fs::remove_dir_all(cwd);
    let _ = std::fs::remove_dir_all(store);
}

#[tokio::test]
async fn build_continuation_respects_hard_gates() {
    let cwd = temp_base("continue-cwd");
    let store = temp_base("continue-store");
    let orch = BuildOrchestrator::new(store.clone());
    orch.start_run("tab1", "test", &cwd, "local").await.unwrap();
    assert!(orch.consider_continue("tab1", "end_turn").await.is_none());
    {
        let mut map = orch.states.write().await;
        map.get_mut("tab1").unwrap().state.status = BuildRunStatus::Active;
    }
    assert!(orch.consider_continue("tab1", "cancelled").await.is_none());
    let prompt = orch.consider_continue("tab1", "end_turn").await.unwrap();
    assert!(
        prompt.contains("git rev-parse --show-toplevel")
            && prompt.contains("git status --short")
            && prompt.contains("checkpoint"),
        "build continuation should keep git baseline/checkpoint guidance visible"
    );
    orch.pause("tab1").await.unwrap();
    assert!(orch.consider_continue("tab1", "end_turn").await.is_none());
    let _ = std::fs::remove_dir_all(cwd);
    let _ = std::fs::remove_dir_all(store);
}

#[tokio::test]
async fn build_continuation_waits_while_agent_is_in_flight() {
    let cwd = temp_base("continue-agent-cwd");
    let store = temp_base("continue-agent-store");
    let orch = BuildOrchestrator::new(store.clone());
    let state = orch.start_run("tab1", "test", &cwd, "local").await.unwrap();
    {
        let mut map = orch.states.write().await;
        map.get_mut("tab1").unwrap().state.status = BuildRunStatus::Active;
    }
    let mut started = receipt(
        &state,
        BuildReceiptKind::AgentStarted,
        BuildReceiptConfidence::TrustedHost,
    );
    started.data = json!({ "subagentId": "agent-1", "persona": "release-manager" });
    orch.append_receipt(started).await.unwrap();
    assert_eq!(
        orch.in_flight_agent_summaries("tab1").await.unwrap(),
        vec!["release-manager agent-1".to_string()]
    );
    assert!(orch.consider_continue("tab1", "end_turn").await.is_none());

    let mut completed = receipt(
        &state,
        BuildReceiptKind::AgentCompleted,
        BuildReceiptConfidence::TrustedHost,
    );
    completed.data = json!({ "subagentId": "agent-1", "persona": "release-manager" });
    orch.append_receipt(completed).await.unwrap();
    assert!(orch
        .in_flight_agent_summaries("tab1")
        .await
        .unwrap()
        .is_empty());
    assert!(orch.consider_continue("tab1", "end_turn").await.is_some());

    let _ = std::fs::remove_dir_all(cwd);
    let _ = std::fs::remove_dir_all(store);
}

#[tokio::test]
async fn running_agent_completed_snapshot_stays_in_flight() {
    let cwd = temp_base("continue-agent-running-cwd");
    let store = temp_base("continue-agent-running-store");
    let orch = BuildOrchestrator::new(store.clone());
    let state = orch.start_run("tab1", "test", &cwd, "local").await.unwrap();
    {
        let mut map = orch.states.write().await;
        map.get_mut("tab1").unwrap().state.status = BuildRunStatus::Active;
    }
    let mut started = receipt(
        &state,
        BuildReceiptKind::AgentStarted,
        BuildReceiptConfidence::TrustedHost,
    );
    started.data = json!({ "subagentId": "agent-1", "persona": "implementer" });
    orch.append_receipt(started).await.unwrap();

    let mut wait_budget_snapshot = receipt(
        &state,
        BuildReceiptKind::AgentCompleted,
        BuildReceiptConfidence::TrustedHost,
    );
    wait_budget_snapshot.data = json!({
        "subagentId": "agent-1",
        "persona": "implementer",
        "status": "running",
        "waitBudgetExpired": true
    });
    orch.append_receipt(wait_budget_snapshot).await.unwrap();

    assert_eq!(
        orch.in_flight_agent_summaries("tab1").await.unwrap(),
        vec!["implementer agent-1".to_string()]
    );
    assert_eq!(
        orch.in_flight_agent_ids("tab1").await.unwrap(),
        vec!["agent-1".to_string()]
    );
    assert!(orch.consider_continue("tab1", "end_turn").await.is_none());

    let _ = std::fs::remove_dir_all(cwd);
    let _ = std::fs::remove_dir_all(store);
}

#[tokio::test]
async fn build_continuation_forward_nudges_stale_review_verify_loop_without_blocking() {
    let cwd = temp_base("continue-stale-loop-cwd");
    let store = temp_base("continue-stale-loop-store");
    let orch = BuildOrchestrator::new(store.clone());
    let state = orch
        .start_run("tab1", "paint app", &cwd, "local")
        .await
        .unwrap();
    std::fs::write(
            &state.scratchboard_path,
            "# Build: paint app\n\nStatus: IN_PROGRESS\n\n## Phase\nStatus: IN_PROGRESS\n- [ ] implement next paint tool\n",
        )
        .unwrap();
    {
        let mut map = orch.states.write().await;
        let st = &mut map.get_mut("tab1").unwrap().state;
        st.status = BuildRunStatus::Active;
        st.code_changed = true;
        st.review_required = true;
        st.verification_required = true;
        st.checkpoint_id = Some("cp-1".into());
    }

    let mut review = receipt(
        &state,
        BuildReceiptKind::ReviewCompleted,
        BuildReceiptConfidence::TrustedHost,
    );
    review.summary = "0 new findings on same visual scope".into();
    orch.append_receipt(review).await.unwrap();
    let mut verify = receipt(
        &state,
        BuildReceiptKind::VerificationCompleted,
        BuildReceiptConfidence::TrustedHost,
    );
    verify.summary = "verification gate satisfiable on same testable scope".into();
    orch.append_receipt(verify).await.unwrap();

    let prompt = orch.consider_continue("tab1", "end_turn").await.unwrap();
    assert!(
        prompt.contains("<build_forward_nudge"),
        "stale review/verify suffix should produce a forward nudge, got: {}",
        prompt
    );
    assert!(
        prompt.contains("Do not dispatch another reviewer or verifier for the same scope"),
        "nudge should prevent repeating the same reviewer/verifier loop, got: {}",
        prompt
    );
    let nudged = orch.get_state("tab1").await.unwrap();
    assert_eq!(nudged.status, BuildRunStatus::Active);
    assert_eq!(nudged.open_blocker, None);
    assert_eq!(nudged.no_progress_cycles, 1);

    let prompt = orch.consider_continue("tab1", "end_turn").await.unwrap();
    assert!(
        prompt.contains("Forced forward step"),
        "second stale continuation should escalate the nudge, got: {}",
        prompt
    );
    let nudged = orch.get_state("tab1").await.unwrap();
    assert_eq!(nudged.status, BuildRunStatus::Active);
    assert_eq!(nudged.no_progress_cycles, 2);

    let _ = std::fs::remove_dir_all(cwd);
    let _ = std::fs::remove_dir_all(store);
}

#[tokio::test]
async fn build_continuation_resets_forward_nudge_after_checkpoint_progress() {
    let cwd = temp_base("continue-stale-reset-cwd");
    let store = temp_base("continue-stale-reset-store");
    let orch = BuildOrchestrator::new(store.clone());
    let state = orch
        .start_run("tab1", "paint app", &cwd, "local")
        .await
        .unwrap();
    std::fs::write(
            &state.scratchboard_path,
            "# Build: paint app\n\nStatus: IN_PROGRESS\n\n## Phase\nStatus: IN_PROGRESS\n- [ ] implement next paint tool\n",
        )
        .unwrap();
    {
        let mut map = orch.states.write().await;
        let st = &mut map.get_mut("tab1").unwrap().state;
        st.status = BuildRunStatus::Active;
        st.no_progress_cycles = 3;
    }

    let mut checkpoint = receipt(
        &state,
        BuildReceiptKind::CheckpointCreated,
        BuildReceiptConfidence::TrustedHost,
    );
    checkpoint.data = json!({
        "checkpointId": "cp-new",
        "staged": 0,
        "unstaged": 1,
        "untracked": 0,
        "buildWorktreeFingerprint": "fp-new"
    });
    orch.append_receipt(checkpoint).await.unwrap();

    let prompt = orch.consider_continue("tab1", "end_turn").await.unwrap();
    assert!(
        !prompt.contains("<build_forward_nudge"),
        "fresh checkpoint progress should return to the normal continuation prompt, got: {}",
        prompt
    );
    let nudged = orch.get_state("tab1").await.unwrap();
    assert_eq!(nudged.no_progress_cycles, 0);

    let _ = std::fs::remove_dir_all(cwd);
    let _ = std::fs::remove_dir_all(store);
}

#[tokio::test]
async fn build_continuation_rejects_goal_complete_without_gates() {
    let cwd = temp_base("complete-nudge-cwd");
    let store = temp_base("complete-nudge-store");
    let orch = BuildOrchestrator::new(store.clone());
    let state = orch.start_run("tab1", "test", &cwd, "local").await.unwrap();
    std::fs::write(&state.scratchboard_path, goal_complete_board()).unwrap();
    {
        let mut map = orch.states.write().await;
        let runtime = map.get_mut("tab1").unwrap();
        runtime.state.status = BuildRunStatus::Active;
        runtime.state.code_changed = true;
        runtime.state.review_required = true;
        runtime.state.verification_required = true;
    }

    let prompt = orch.consider_continue("tab1", "end_turn").await.unwrap();
    assert!(
        prompt.contains("build_complete rejected"),
        "got: {}",
        prompt
    );
    assert!(
        prompt.contains("checkpoint receipt") || prompt.contains("reviewer receipt"),
        "got: {}",
        prompt
    );
    assert_eq!(
        orch.get_state("tab1").await.unwrap().status,
        BuildRunStatus::Active
    );
    let _ = std::fs::remove_dir_all(cwd);
    let _ = std::fs::remove_dir_all(store);
}
