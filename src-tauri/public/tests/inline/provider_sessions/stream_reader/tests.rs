use super::*;
use crate::provider_sessions::ProviderEventStatus;
use tokio::io::BufReader;

#[tokio::test]
async fn bounded_provider_reader_drops_overflow_and_resynchronizes() {
    let input = b"12345678overflow\n{\"ok\":true}\r\n";
    let mut reader = BufReader::new(input.as_slice());

    assert_eq!(
        read_provider_bounded_line(&mut reader, 8).await.unwrap(),
        ProviderBoundedLine::Overflow
    );
    assert_eq!(
        read_provider_bounded_line(&mut reader, 64).await.unwrap(),
        ProviderBoundedLine::Line(br#"{"ok":true}"#.to_vec())
    );
    assert_eq!(
        read_provider_bounded_line(&mut reader, 64).await.unwrap(),
        ProviderBoundedLine::Eof
    );
}

#[test]
fn provider_reader_failures_are_terminal_typed_events() {
    let event = provider_reader_failure_event(
        ProviderId::CodexCli,
        "run-1",
        "tab-1",
        "stdout-reader",
        "provider stdout read failed: fixture",
    );

    assert_eq!(event.kind, ProviderSessionEventKind::Failed);
    assert_eq!(event.status, Some(ProviderEventStatus::Failed));
    assert_eq!(event.raw_type.as_deref(), Some("stdout-reader"));
    assert_eq!(
        event.error.as_deref(),
        Some("provider stdout read failed: fixture")
    );
}

#[test]
fn observed_stream_failure_wins_process_exit_success_race() {
    let terminal = reconcile_provider_terminal(
        (ProviderRunPhase::Completed, Some(0), None),
        Some(ProviderStreamTerminal {
            phase: ProviderRunPhase::Failed,
            exit_code: None,
            error: Some("provider stdout read failed: fixture".to_string()),
        }),
    );

    assert_eq!(terminal.0, ProviderRunPhase::Failed);
    assert_eq!(terminal.1, None);
    assert_eq!(
        terminal.2.as_deref(),
        Some("provider stdout read failed: fixture")
    );
}

#[test]
fn observed_stream_failure_is_not_downgraded_by_late_success() {
    let mut observed = Some(ProviderStreamTerminal {
        phase: ProviderRunPhase::Failed,
        exit_code: None,
        error: Some("fixture failure".to_string()),
    });
    let mut sender = None;

    observe_provider_stream_terminal(
        &mut observed,
        &mut sender,
        ProviderStreamTerminal {
            phase: ProviderRunPhase::Completed,
            exit_code: Some(0),
            error: None,
        },
    );

    assert_eq!(
        observed.expect("observed terminal").phase,
        ProviderRunPhase::Failed
    );
}

#[test]
fn supervisor_timeout_is_not_hidden_by_late_stream_success() {
    let terminal = reconcile_provider_terminal(
        (
            ProviderRunPhase::Failed,
            None,
            Some("timeout after 1000 ms".to_string()),
        ),
        Some(ProviderStreamTerminal {
            phase: ProviderRunPhase::Completed,
            exit_code: Some(0),
            error: None,
        }),
    );

    assert_eq!(terminal.0, ProviderRunPhase::Failed);
    assert_eq!(terminal.2.as_deref(), Some("timeout after 1000 ms"));
}

#[test]
fn provider_stderr_reader_diagnostics_remain_visible_but_non_terminal() {
    let event = provider_reader_diagnostic_event(
        ProviderId::ClaudeCode,
        "run-1",
        "tab-1",
        "provider stderr line exceeded 10 bytes and was dropped",
    );

    assert_eq!(event.kind, ProviderSessionEventKind::Raw);
    assert_eq!(event.status, None);
    assert_eq!(event.raw_type.as_deref(), Some("stderr"));
    assert_eq!(
        event.text.as_deref(),
        Some("provider stderr line exceeded 10 bytes and was dropped")
    );
}
