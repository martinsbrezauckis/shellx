use super::{run_bounded_output, DEFAULT_STDERR_LIMIT};
use std::time::{Duration, Instant};
use tokio::process::Command;

#[tokio::test]
async fn sleeping_session_is_terminated_at_deadline() {
    let mut command = Command::new("sh");
    command.args(["-c", "sleep 30 & wait"]);
    let started = Instant::now();
    let error = run_bounded_output(
        &mut command,
        "sleeping fixture",
        Duration::from_millis(80),
        1024,
        DEFAULT_STDERR_LIMIT,
    )
    .await
    .expect_err("sleeping fixture must time out");

    assert!(error.contains("timed out"), "unexpected error: {error}");
    assert!(
        started.elapsed() < Duration::from_secs(3),
        "cleanup should be bounded, elapsed={:?}",
        started.elapsed()
    );
}

#[tokio::test]
async fn oversized_stdout_is_stopped_without_waiting_for_deadline() {
    let mut command = Command::new("sh");
    command.args(["-c", "while :; do printf 0123456789; done"]);
    let started = Instant::now();
    let error = run_bounded_output(
        &mut command,
        "oversized fixture",
        Duration::from_secs(10),
        128,
        DEFAULT_STDERR_LIMIT,
    )
    .await
    .expect_err("oversized stdout must fail");

    assert!(
        error.contains("stdout exceeded 128 byte capture limit"),
        "unexpected error: {error}"
    );
    assert!(
        started.elapsed() < Duration::from_secs(3),
        "capture cap should stop promptly, elapsed={:?}",
        started.elapsed()
    );
}

#[tokio::test]
async fn failed_command_preserves_status_and_stderr() {
    let mut command = Command::new("sh");
    command.args(["-c", "printf deliberate-error >&2; exit 7"]);
    let output = run_bounded_output(
        &mut command,
        "error fixture",
        Duration::from_secs(2),
        1024,
        DEFAULT_STDERR_LIMIT,
    )
    .await
    .expect("exit status is part of a successful capture");

    assert_eq!(output.status.code(), Some(7));
    assert_eq!(output.stderr, b"deliberate-error");
}
