use super::*;

#[tokio::test]
async fn registry_insert_get_remove() {
    let reg = TerminalRegistry::new();
    let key = TerminalKey {
        tab_id: "t1".into(),
        terminal_id: "term-a".into(),
    };
    // Can't construct a TerminalRecord without a real PTY; just
    // exercise the HashMap path. Negative-path coverage only.
    assert!(reg.get(&key).await.is_none());
    assert!(reg.remove(&key).await.is_none());
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn process_tree_termination_reaps_hup_ignoring_pty_child() {
    let pair = native_pty_system()
        .openpty(PtySize {
            cols: DEFAULT_COLS,
            rows: DEFAULT_ROWS,
            pixel_width: 0,
            pixel_height: 0,
        })
        .expect("open test PTY");
    let mut command = CommandBuilder::new("/bin/sh");
    command.args(["-c", "trap '' HUP TERM; while :; do sleep 60; done"]);
    let mut child = pair
        .slave
        .spawn_command(command)
        .expect("spawn HUP-ignoring child");
    let pid = child.process_id().expect("PTY child PID");
    let killer = child.clone_killer();
    drop(pair.slave);

    let waiter = tokio::task::spawn_blocking(move || child.wait());
    tokio::time::sleep(Duration::from_millis(50)).await;
    terminate_pty_process_tree(Some(pid), Some(killer)).expect("terminate PTY session");
    let status = tokio::time::timeout(Duration::from_secs(2), waiter)
        .await
        .expect("child waiter must not leak")
        .expect("child waiter joins")
        .expect("child reaped");

    assert_ne!(status.exit_code(), 0);
    assert!(!pid_is_alive(pid));
}

#[test]
fn windows_terminal_candidates_include_provider_user_bins() {
    assert_eq!(
        windows_user_bin_path_candidates(
            r"C:\Users\FixtureUser\",
            r"C:\Users\FixtureUser\AppData\Roaming\",
            r"C:\Users\FixtureUser\AppData\Local\",
        ),
        vec![
            r"C:\Users\FixtureUser\.local\bin",
            r"C:\Users\FixtureUser\bin",
            r"C:\Users\FixtureUser\.grok\bin",
            r"C:\Users\FixtureUser\.claude\bin",
            r"C:\Users\FixtureUser\.bun\bin",
            r"C:\Users\FixtureUser\.cargo\bin",
            r"C:\Users\FixtureUser\AppData\Local\Programs\OpenAI\Codex\bin",
            r"C:\Users\FixtureUser\AppData\Local\agy\bin",
            r"C:\Users\FixtureUser\AppData\Roaming\npm",
        ]
    );
}
