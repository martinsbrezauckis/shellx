use super::*;

#[test]
fn owned_process_identity_rejects_pid_reuse_generation() {
    let identity = capture_owned_process_identity(std::process::id())
        .expect("current process has a stable OS identity");
    assert!(owned_process_identity_is_current(identity));

    let stale = OwnedProcessIdentity {
        start_token: identity.start_token.wrapping_add(1),
        ..identity
    };
    assert!(!owned_process_identity_is_current(stale));
}

#[tokio::test]
async fn register_and_list_roundtrip() {
    let reg = ProcessRegistry::new();
    let id = reg
        .register("echo hi", ProcessSource::Terminal, Some(std::process::id()))
        .await;
    let snaps = reg.list().await;
    assert_eq!(snaps.len(), 1);
    assert_eq!(snaps[0].task_id, id);
    assert_eq!(snaps[0].cmd, "echo hi");
}

#[tokio::test]
async fn unknown_task_rejects_signal() {
    let reg = ProcessRegistry::new();
    let err = reg.signal("gs-deadbeef", "SIGTERM").await.unwrap_err();
    assert!(err.contains("unknown taskId"));
}

#[tokio::test]
async fn invalid_process_ids_never_reach_direct_or_group_signaling() {
    for pid in [0, 1, i32::MAX as u32 + 1, u32::MAX] {
        let reg = ProcessRegistry::new();
        let task_id = reg
            .register("unsafe pid fixture", ProcessSource::Terminal, Some(pid))
            .await;
        for result in [
            reg.signal(&task_id, "SIGTERM").await,
            reg.signal_tree(&task_id, "SIGKILL").await,
        ] {
            let error = result.expect_err("unsafe pid must fail before OS signaling");
            assert!(error.contains("unsafe process id"), "{error}");
        }
    }
}

#[tokio::test]
async fn registry_refuses_a_reused_pid_generation_before_signaling() {
    let reg = ProcessRegistry::new();
    let task_id = reg
        .register(
            "stale process generation",
            ProcessSource::Terminal,
            Some(std::process::id()),
        )
        .await;
    {
        let mut inner = reg.inner.lock().await;
        let record = inner
            .records
            .get_mut(&task_id)
            .expect("registered process record");
        let identity = record
            .process_identity
            .expect("current process identity captured");
        record.process_identity = Some(OwnedProcessIdentity {
            start_token: identity.start_token.wrapping_add(1),
            ..identity
        });
    }

    let error = reg
        .running_pid_for_signal(&task_id)
        .await
        .expect_err("stale process generation must fail before OS signaling");
    assert!(error.contains("no longer owns PID"), "{error}");
}

#[test]
fn process_signal_accepts_short_and_sig_prefixed_names() {
    let cases = [
        ("TERM", "SIGTERM"),
        ("sigterm", "SIGTERM"),
        ("INT", "SIGINT"),
        ("KILL", "SIGKILL"),
        ("HUP", "SIGHUP"),
        ("USR1", "SIGUSR1"),
    ];
    for (input, expected) in cases {
        assert_eq!(normalize_signal_name(input).unwrap(), expected);
    }
    let err = normalize_signal_name("QUIT").unwrap_err();
    assert!(
        err.contains("supported"),
        "error should name supported signals: {err}"
    );
}

#[tokio::test]
async fn push_lines_appear_in_tail() {
    let reg = ProcessRegistry::new();
    let id = reg.register("sleep 1", ProcessSource::Terminal, None).await;
    reg.push_line(&id, "stdout", "line1".to_string()).await;
    reg.push_line(&id, "stdout", "line2".to_string()).await;
    let (tail, _rx) = reg.attach_stdout(&id, 10).await.unwrap();
    assert_eq!(tail.len(), 2);
    assert_eq!(tail[0].line, "line1");
    assert_eq!(tail[1].line, "line2");
}

#[tokio::test]
async fn process_output_is_byte_bounded_before_tail_and_broadcast() {
    let reg = ProcessRegistry::new();
    let id = reg.register("noisy", ProcessSource::Provider, None).await;
    let (_initial, mut rx) = reg.attach_stdout(&id, 1).await.unwrap();
    let oversized = "界".repeat(CAPTURED_LINE_BYTES);
    reg.push_line(&id, "stdout", oversized).await;

    let broadcast = rx.recv().await.expect("bounded broadcast line");
    assert!(broadcast.line.len() <= CAPTURED_LINE_BYTES);
    assert!(broadcast.line.ends_with(CAPTURED_LINE_TRUNCATION_MARKER));
    assert!(std::str::from_utf8(broadcast.line.as_bytes()).is_ok());

    for index in 0..64 {
        reg.push_line(
            &id,
            "stderr",
            format!("{index:02}{}", "x".repeat(CAPTURED_LINE_BYTES)),
        )
        .await;
    }
    let (tail, _rx) = reg.attach_stdout(&id, TAIL_BUFFER_LINES).await.unwrap();
    assert!(
        tail.len() < 64,
        "byte cap evicts old lines before the line cap"
    );
    assert!(tail.iter().map(|line| line.line.len()).sum::<usize>() <= TAIL_BUFFER_BYTES);
    assert!(tail.last().unwrap().line.starts_with("63"));
}

#[tokio::test]
async fn running_task_ids_for_tab_source_filters_by_tab_source_and_status() {
    let reg = ProcessRegistry::new();
    let owned = reg
        .register(
            "grok -p owned",
            ProcessSource::HostMcp,
            Some(std::process::id()),
        )
        .await;
    let other_tab = reg
        .register(
            "grok -p other-tab",
            ProcessSource::HostMcp,
            Some(std::process::id()),
        )
        .await;
    let terminal = reg
        .register("bash", ProcessSource::Terminal, Some(std::process::id()))
        .await;
    let exited = reg
        .register(
            "grok -p exited",
            ProcessSource::HostMcp,
            Some(std::process::id()),
        )
        .await;

    reg.set_tab_id(&owned, "tab-a".to_string()).await;
    reg.set_tab_id(&other_tab, "tab-b".to_string()).await;
    reg.set_tab_id(&terminal, "tab-a".to_string()).await;
    reg.set_tab_id(&exited, "tab-a".to_string()).await;
    reg.mark_exited(&exited, Some(0), ProcessStatus::Exited)
        .await;

    let ids = reg
        .running_task_ids_for_tab_source("tab-a", ProcessSource::HostMcp)
        .await;
    assert_eq!(ids, vec![owned]);
}

#[tokio::test]
async fn release_test_forget_host_mcp_requires_exact_finished_ownership() {
    let reg = ProcessRegistry::new();
    let command = "ShellX release-owned Host MCP child";
    let owned = reg
        .register(command, ProcessSource::HostMcp, Some(std::process::id()))
        .await;
    reg.set_tab_id(&owned, "release-tab".to_string()).await;

    let running_error = reg
        .release_test_forget_owned_host_mcp(&owned, "release-tab", command)
        .await
        .expect_err("a running record must not be forgotten");
    assert!(running_error.contains("still running"));

    reg.mark_exited(&owned, None, ProcessStatus::Killed).await;
    let ownership_error = reg
        .release_test_forget_owned_host_mcp(&owned, "other-tab", command)
        .await
        .expect_err("a different tab must not match the release-owned record");
    assert!(ownership_error.contains("ownership did not match"));
    assert_eq!(reg.list().await.len(), 1);

    reg.release_test_forget_owned_host_mcp(&owned, "release-tab", command)
        .await
        .expect("the exact finished release-owned record is removable");
    assert!(reg.list().await.is_empty());
}

#[tokio::test]
async fn signal_refuses_non_running_task_records() {
    let reg = ProcessRegistry::new();
    let task = reg
        .register(
            "already exited",
            ProcessSource::HostMcp,
            Some(2_147_483_000),
        )
        .await;
    reg.mark_exited(&task, Some(0), ProcessStatus::Exited).await;

    let err = reg
        .signal(&task, "SIGTERM")
        .await
        .expect_err("signal must reject non-running task records");

    assert!(
        err.contains("not running"),
        "error should explain non-running status, got: {}",
        err
    );
}

#[tokio::test]
async fn signal_tree_refuses_non_running_task_records() {
    let reg = ProcessRegistry::new();
    let task = reg
        .register(
            "already killed",
            ProcessSource::HostMcp,
            Some(2_147_483_000),
        )
        .await;
    reg.mark_exited(&task, None, ProcessStatus::Killed).await;

    let err = reg
        .signal_tree(&task, "SIGTERM")
        .await
        .expect_err("signal_tree must reject non-running task records");

    assert!(
        err.contains("not running"),
        "error should explain non-running status, got: {}",
        err
    );
}
