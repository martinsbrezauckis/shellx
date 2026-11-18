use super::*;

#[test]
fn parse_board_empty() {
    let fp = parse_board("");
    assert_eq!(fp.phase_count, 0);
    assert_eq!(fp.done_count, 0);
    assert_eq!(fp.unchecked_count, 0);
    assert!(fp.top_status.is_none());
}

#[test]
fn parse_board_active_with_unchecked() {
    let board = "\
# Goal: test

status: ACTIVE

## Phase 1 — Setup
- [x] Code
- [ ] Test
status: IN_PROGRESS

## Phase 2 — Done
- [x] Code
- [x] Test
status: DONE
";
    let fp = parse_board(board);
    assert_eq!(fp.top_status.as_deref(), Some("ACTIVE"));
    assert_eq!(fp.phase_count, 2);
    // parse_board now counts both `Status: DONE` and `- [x]`
    // checked items. 3 `- [x]` (Phase 1 Code + Phase 2 Code/Test)
    // + 1 phase `status: DONE` = 4.
    assert_eq!(fp.done_count, 4);
    assert_eq!(fp.unchecked_count, 1);
}

#[test]
fn parse_board_top_status_capital_s() {
    // audit fix (HIGH-2) — `Status:` with capital S must be
    // detected so plan_kickoff_text's `Status: AWAITING_APPROVAL`
    // and grok-written `Status: GOAL_COMPLETE` reach the
    // orchestrator's terminal-status branch.
    let board = "# Goal: x\n\nStatus: GOAL_COMPLETE\n\n## Phase 1\n- [x] Done\n";
    let fp = parse_board(board);
    assert_eq!(fp.top_status.as_deref(), Some("GOAL_COMPLETE"));
    assert_eq!(fp.done_count, 1);
}

#[test]
fn plan_kickoff_requires_review_gate_for_code_goals() {
    let text = GoalOrchestrator::plan_kickoff_text("change code");
    assert!(text.contains("Review / verification"));
    assert!(text.contains("`implementer` Agent"));
    assert!(text.contains("`reviewer` Agent"));
    assert!(text.contains("`security-auditor`"));
    assert!(text.contains("Do not invoke Grok Build's bundled"));
    assert!(text.contains("HALT and ask the user"));
    assert!(text.contains("Final verification must cite real evidence"));
    assert!(text.contains("AI slop / wiring audit"));
    assert!(text.contains("fake success paths"));
    assert!(text.contains("Only skip the Agent pass"));
    assert!(text.contains("goal_complete"));
}

#[test]
fn validate_approval_rejects_drafting_stub() {
    let board = "\
# Goal: x

Status: AWAITING_APPROVAL

_grok is drafting the plan…_
";
    let err = validate_approval_ready(board).unwrap_err();
    assert!(err.contains("drafting stub"), "got: {}", err);
}

#[test]
fn validate_approval_accepts_real_unchecked_plan() {
    let board = "\
# Goal: x

Status: AWAITING_APPROVAL

## Phase 1 — Implement
- [ ] Code
- [ ] Test

## Phase 2 — Complete
- [ ] Call goal_complete
";
    validate_approval_ready(board).expect("real plan should be approvable");
}

#[test]
fn approve_status_patch_only_changes_top_level_status() {
    let board = "\
# Goal: x

Status: AWAITING_APPROVAL

## Phase 1
Status: AWAITING_APPROVAL
- [ ] Code
";
    let patched = mark_approved_plan_in_progress(board).unwrap();
    assert!(patched.contains("\nStatus: IN_PROGRESS\n\n## Phase 1"));
    assert!(patched.contains("## Phase 1\nStatus: AWAITING_APPROVAL\n"));
}

#[test]
fn approval_kickoff_does_not_ask_agent_to_rewrite_top_status() {
    let prompt = approval_kickoff_prompt(None);
    assert!(prompt.contains("shellX has already changed"));
    assert!(prompt.contains("AI slop /"));
    assert!(!prompt.contains("First change the top-level"));
}

#[test]
fn validate_rejects_unchecked_phase() {
    let board = "\
# Goal: t

status: GOAL_COMPLETE

## Phase 1
- [x] Code
- [ ] Test
status: DONE
";
    let err = validate_board_text(board).unwrap_err();
    assert!(err.contains("unchecked"), "got: {}", err);
}

#[test]
fn validate_rejects_missing_done() {
    let board = "\
# Goal: t

status: GOAL_COMPLETE

## Phase 1
- [x] Code
status: IN_PROGRESS
";
    let err = validate_board_text(board).unwrap_err();
    assert!(err.contains("no `status: DONE`"), "got: {}", err);
}

#[test]
fn validate_accepts_checked_phase_without_status() {
    let board = "\
# Goal: t

status: IN_PROGRESS

## Phase 1
- [x] Code
- [x] Test

## Phase 2
- [x] Review
";
    validate_board_text(board)
        .expect("fully checked phases should not require redundant status lines");
}

#[test]
fn validate_accepts_capital_status_and_done_top_level() {
    let board = "\
# Goal: t

Status: DONE

## Phase 1
Status: DONE
- [x] Code
- [x] Test

## Phase 2
Status: DONE
- [x] Review
";
    validate_board_text(board).expect("DONE top-level should be accepted before tool patch");
}

#[test]
fn validate_accepts_goal_complete_phase_status() {
    let board = "\
# Goal: t

status: GOAL_COMPLETE

## Phase 1
status: GOAL_COMPLETE
- [x] Code
- [x] Test
";
    validate_board_text(board).expect("phase status GOAL_COMPLETE is terminal");
}

#[test]
fn validate_accepts_in_progress_top_status_when_phases_are_complete() {
    let board = "\
# Goal: t

status: IN_PROGRESS

## Phase 1
- [x] Code
status: DONE
";
    validate_board_text(board).expect("goal_complete tool should be the completion signal");
}

#[test]
fn validate_rejects_awaiting_approval_top_status() {
    let board = "\
# Goal: t

status: AWAITING_APPROVAL

## Phase 1
- [x] Code
status: DONE
";
    let err = validate_board_text(board).unwrap_err();
    assert!(
        err.contains("top-level Goal") && err.contains("AWAITING_APPROVAL"),
        "got: {}",
        err
    );
}

#[test]
fn validate_accepts_clean_board() {
    let board = "\
# Goal: t

status: GOAL_COMPLETE

## Phase 1
- [x] Code
- [x] Test
status: DONE

## Phase 2
- [x] Code
- [x] Test
- [x] Review
status: DONE
";
    validate_board_text(board).expect("should accept clean board");
}

#[test]
fn validate_rejects_banned_final_evidence_phrases() {
    let board = "\
# Goal: t

status: IN_PROGRESS

## Phase 1
Status: DONE
- [x] Code

## Phase 2
Status: DONE
- [x] Final verification: All gates PASS when running npm run dev (tested in this session via code paths). Evidence is the running app itself + the code.
";
    let err = validate_board_text(board).unwrap_err();
    assert!(err.contains("banned non-evidence phrase"), "got: {}", err);
}

#[test]
fn validate_allows_banned_phrase_when_it_is_a_rule_not_evidence() {
    let board = "\
# Goal: t

status: IN_PROGRESS

## Phase 1
Status: DONE
- [x] Code

## Phase 2
Status: DONE
- [x] Final verification must cite real command output; do not use \"tested via code paths\" because it does not count.
- [x] Evidence: cargo test --manifest-path src-tauri/Cargo.toml --features debug-api goal_orchestrator -- --nocapture passed.
";
    validate_board_text(board).expect("rule text should not trigger evidence ban");
}

#[test]
fn validate_rejects_self_review_after_transport_failure() {
    let board = "\
# Goal: t

status: IN_PROGRESS

## Phase 1
Status: DONE
- [x] Code

## Phase 2 — Review / verification
Status: DONE
- [x] Agent dispatch blocked by transport (Transport closed). Performed direct self-review instead.

## Phase 3
Status: DONE
- [x] Call goal_complete
";
    let err = validate_board_text(board).unwrap_err();
    assert!(
        err.contains("review gate cannot be satisfied by self-review"),
        "got: {}",
        err
    );
}

#[test]
fn scratchboard_wsl_drive_mount_to_windows_path_normalizes_common_form() {
    assert_eq!(
        wsl_drive_mount_to_windows_path("/mnt/c/Users/User/project/build.tab.md")
            .unwrap()
            .to_string_lossy(),
        "C:\\Users\\User\\project\\build.tab.md"
    );
    assert_eq!(
        wsl_drive_mount_to_windows_path("/mnt/d")
            .unwrap()
            .to_string_lossy(),
        "D:\\"
    );
}

#[test]
fn scratchboard_wsl_drive_mount_to_windows_path_rejects_non_drive_mounts() {
    assert!(wsl_drive_mount_to_windows_path("/home/user/goal.md").is_none());
    assert!(wsl_drive_mount_to_windows_path("/mnt/share/project/goal.md").is_none());
    assert!(wsl_drive_mount_to_windows_path("C:\\Users\\User\\goal.md").is_none());
}

#[tokio::test]
async fn scratchboard_transport_policy_keeps_local_sessions_direct_only() {
    let path = Path::new("/mnt/c/__shellx_missing_scratchboard__/goal.md");
    let local = read_scratchboard_text_for_transport(path, "local", None)
        .await
        .unwrap_err();
    assert!(
        local.contains("tried direct only"),
        "local transport must not use WSL bridge: {}",
        local
    );

    let wsl = read_scratchboard_text_for_transport(path, "wsl", None)
        .await
        .unwrap_err();
    assert!(
        wsl.contains("WSL drive mount + WSL UNC"),
        "WSL transport should advertise WSL bridge attempts: {}",
        wsl
    );
}

#[tokio::test]
async fn ssh_scratchboard_requires_the_captured_goal_project_root() {
    let orchestrator = GoalOrchestrator::new();
    let project_root = Path::new("/srv/owned-goal-project");
    let ssh = crate::acp::SshSpawnConfig {
        host: "fixture.example".to_string(),
        port: None,
        key_vault_ref: None,
        remote_grok_path: "grok".to_string(),
        remote_runtime: crate::acp::SshRemoteRuntime::Posix,
        wsl_distro: None,
    };

    orchestrator
        .set_mode_with_transport_context(
            "goal-ssh-owned-root",
            true,
            Some("fixture".to_string()),
            project_root,
            "ssh",
            Some(ssh.clone()),
        )
        .await;
    let state = orchestrator
        .get_state("goal-ssh-owned-root")
        .await
        .expect("Goal state");
    assert_eq!(state.project_root, project_root);

    let read = read_scratchboard_text_for_transport(
        Path::new("/srv/other-project/goal.md"),
        "ssh",
        Some(&ssh),
    )
    .await
    .expect_err("generic SSH reader must not accept a path without its owner");
    assert!(read.contains("owned Goal project root"), "got: {read}");

    let write = write_scratchboard_text_for_transport(
        Path::new("/srv/other-project/goal.md"),
        "fixture",
        "ssh",
        Some(&ssh),
    )
    .await
    .expect_err("generic SSH writer must not accept a path without its owner");
    assert!(write.contains("owned Goal project root"), "got: {write}");
}

#[tokio::test]
async fn consider_continue_inactive_returns_none() {
    let o = GoalOrchestrator::new();
    assert!(o.consider_continue("tab1", "end_turn").await.is_none());
}

#[tokio::test]
async fn consider_continue_paused_returns_none() {
    let o = GoalOrchestrator::new();
    let dir = std::env::temp_dir();
    o.set_mode("tab1", true, Some("obj".to_string()), &dir, "local")
        .await;
    o.pause("tab1").await;
    assert!(o.consider_continue("tab1", "end_turn").await.is_none());
}

#[tokio::test]
async fn consider_continue_bad_stop_reason_returns_none() {
    let o = GoalOrchestrator::new();
    let dir = std::env::temp_dir();
    o.set_mode("tab1", true, Some("obj".to_string()), &dir, "local")
        .await;
    assert!(o.consider_continue("tab1", "cancelled").await.is_none());
    assert!(o.consider_continue("tab1", "refused").await.is_none());
}

#[tokio::test]
async fn consider_continue_active_with_unchecked_returns_some() {
    // Make a temp dir with a scratchboard that has unchecked items.
    let tmp = std::env::temp_dir().join(format!(
        "goal_test_{}",
        std::time::SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&tmp).unwrap();
    let o = GoalOrchestrator::new();
    o.set_mode("tab1", true, Some("obj".to_string()), &tmp, "local")
        .await;
    let board = "\
# Goal: x

Status: AWAITING_APPROVAL

## Phase 1
- [ ] Code
status: IN_PROGRESS
";
    std::fs::write(tmp.join("goal.md"), board).unwrap();
    {
        let mut map = o.states.write().await;
        map.get_mut("tab1").unwrap().plan_turn_completed = true;
    }
    // set_mode starts in awaiting_approval=true (plan-approval gate);
    // consider_continue is gated by approval — approve first so the
    // active-with-unchecked path can fire.
    o.approve_plan("tab1").await.unwrap();
    let p = o.consider_continue("tab1", "end_turn").await;
    assert!(p.is_some());
    let txt = p.unwrap();
    assert!(txt.contains("<goal_context>"));
    assert!(txt.contains("<objective>\nx\n</objective>"));
    // continuations_total bumped
    let st = o.get_state("tab1").await.unwrap();
    assert_eq!(st.continuations_total, 1);
    // cleanup
    let _ = std::fs::remove_dir_all(&tmp);
}

#[tokio::test]
async fn consider_continue_terminal_status_returns_none() {
    let tmp = std::env::temp_dir().join(format!(
        "goal_test_term_{}",
        std::time::SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&tmp).unwrap();
    let board = "\
# Goal: x

status: GOAL_COMPLETE

## Phase 1
- [x] Code
status: DONE
";
    let o = GoalOrchestrator::new();
    o.set_mode("tab1", true, Some("obj".to_string()), &tmp, "local")
        .await;
    std::fs::write(tmp.join("goal.md"), board).unwrap();
    {
        let mut map = o.states.write().await;
        let st = map.get_mut("tab1").unwrap();
        st.awaiting_approval = false;
        st.plan_turn_completed = true;
    }
    assert!(o.consider_continue("tab1", "end_turn").await.is_none());
    assert!(!o.get_state("tab1").await.unwrap().active);
    let last_clear = o.get_last_clear("tab1").await.unwrap();
    assert_eq!(last_clear.reason, "completed");
    assert_eq!(last_clear.objective.as_deref(), Some("obj"));
    let _ = std::fs::remove_dir_all(&tmp);
}

#[tokio::test]
async fn consider_continue_rejects_false_goal_complete_status() {
    let tmp = std::env::temp_dir().join(format!(
        "goal_test_false_complete_{}",
        std::time::SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&tmp).unwrap();
    let o = GoalOrchestrator::new();
    o.set_mode("tab1", true, Some("obj".to_string()), &tmp, "local")
        .await;
    let board = "\
# Goal: x

status: GOAL_COMPLETE

## Phase 1
- [x] Code
- [ ] Test
status: DONE
";
    std::fs::write(tmp.join("goal.md"), board).unwrap();
    {
        let mut map = o.states.write().await;
        let st = map.get_mut("tab1").unwrap();
        st.awaiting_approval = false;
        st.plan_turn_completed = true;
    }
    let p = o.consider_continue("tab1", "end_turn").await;
    assert!(p.is_some());
    let txt = p.unwrap();
    assert!(txt.contains("<goal_status_drift>"), "got: {}", txt);
    assert!(txt.contains("Change the top-level `Status:` back to `IN_PROGRESS`"));
    let st = o.get_state("tab1").await.unwrap();
    assert!(st.active);
    let _ = std::fs::remove_dir_all(&tmp);
}

#[tokio::test]
async fn consider_continue_does_not_completion_nudge_before_phase_statuses_done() {
    let tmp = std::env::temp_dir().join(format!(
        "goal_test_not_ready_nudge_{}",
        std::time::SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&tmp).unwrap();
    let o = GoalOrchestrator::new();
    o.set_mode("tab1", true, Some("obj".to_string()), &tmp, "local")
        .await;
    let board = "\
# Goal: x

Status: IN_PROGRESS

## Phase 1
- [x] Code
- [x] Test
status: IN_PROGRESS
";
    std::fs::write(tmp.join("goal.md"), board).unwrap();
    {
        let mut map = o.states.write().await;
        let st = map.get_mut("tab1").unwrap();
        st.awaiting_approval = false;
        st.plan_turn_completed = true;
    }
    let p = o.consider_continue("tab1", "end_turn").await;
    assert!(p.is_some());
    let txt = p.unwrap();
    assert!(txt.contains("<goal_context>"), "got: {}", txt);
    assert!(
        !txt.contains("<goal_completion_check>"),
        "should not nudge completion until phase statuses validate: {}",
        txt
    );
    let _ = std::fs::remove_dir_all(&tmp);
}

#[test]
fn extract_goal_title_reads_current_scratchboard_title() {
    let board = "\
# Goal: revised objective

Status: AWAITING_APPROVAL

## Phase 1
- [ ] Code
";
    assert_eq!(
        extract_goal_title(board).as_deref(),
        Some("revised objective")
    );
}

#[tokio::test]
async fn approve_plan_updates_objective_from_revised_goal_title() {
    let tmp = std::env::temp_dir().join(format!(
        "goal-orchestrator-revised-objective-{}",
        std::process::id()
    ));
    std::fs::create_dir_all(&tmp).unwrap();
    let o = GoalOrchestrator::new();
    o.set_mode(
        "tab1",
        true,
        Some("old objective".to_string()),
        &tmp,
        "local",
    )
    .await;
    let board = "\
# Goal: revised objective

Status: AWAITING_APPROVAL

## Phase 1
- [ ] Code
";
    std::fs::write(tmp.join("goal.md"), board).unwrap();
    {
        let mut map = o.states.write().await;
        map.get_mut("tab1").unwrap().plan_turn_completed = true;
    }

    let changed = o.approve_plan("tab1").await.unwrap();
    assert!(changed);
    let st = o.get_state("tab1").await.unwrap();
    assert_eq!(st.objective, "revised objective");
    assert!(!st.awaiting_approval);
    let updated = std::fs::read_to_string(tmp.join("goal.md")).unwrap();
    assert!(updated.contains("Status: IN_PROGRESS"));
    let _ = std::fs::remove_dir_all(&tmp);
}

#[tokio::test]
async fn watchdog_reports_stalled_tab_without_halting() {
    // Tab with an old `last_continuation_at_ms` (now - 700_000ms)
    // and a 600_000ms timeout should be reported by the watchdog,
    // but not halted. ACP can hide long-running tool output.
    let o = GoalOrchestrator::new();
    let tmp = std::env::temp_dir();
    o.set_mode("stalled-tab", true, Some("obj".to_string()), &tmp, "local")
        .await;
    {
        let mut map = o.states.write().await;
        let st = map.get_mut("stalled-tab").unwrap();
        // Pretend a continuation was injected 700s ago.
        st.last_continuation_at_ms = now_ms().saturating_sub(700_000);
        st.continuations_total = 1;
        st.per_turn_timeout_ms = 600_000;
    }
    let stalled = o.watchdog_tick().await;
    assert_eq!(stalled.len(), 1);
    assert_eq!(stalled[0].0, "stalled-tab");
    assert!(stalled[0].1.contains("STALLED"));
    let st = o.get_state("stalled-tab").await.unwrap();
    assert!(!st.halted);
    assert!(st.halted_reason.is_none());
}

#[tokio::test]
async fn watchdog_ignores_untouched_tab() {
    // Active tab that never injected a continuation
    // (last_continuation_at_ms == 0) must not be halted.
    let o = GoalOrchestrator::new();
    let tmp = std::env::temp_dir();
    o.set_mode("fresh-tab", true, Some("obj".to_string()), &tmp, "local")
        .await;
    let halts = o.watchdog_tick().await;
    assert!(halts.is_empty());
    let st = o.get_state("fresh-tab").await.unwrap();
    assert!(!st.halted);
}

#[tokio::test]
async fn watchdog_ignores_recent_continuation() {
    // Continuation 100ms ago, timeout 60s — should NOT halt.
    let o = GoalOrchestrator::new();
    let tmp = std::env::temp_dir();
    o.set_mode("recent-tab", true, Some("obj".to_string()), &tmp, "local")
        .await;
    {
        let mut map = o.states.write().await;
        let st = map.get_mut("recent-tab").unwrap();
        st.last_continuation_at_ms = now_ms().saturating_sub(100);
        st.continuations_total = 1;
        st.per_turn_timeout_ms = 60_000;
    }
    let halts = o.watchdog_tick().await;
    assert!(halts.is_empty());
}
