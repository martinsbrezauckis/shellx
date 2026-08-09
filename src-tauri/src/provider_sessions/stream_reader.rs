use super::{
    content_reference, emit_provider_event, provider_event, ProviderEventRuntimeContext,
    ProviderRunPhase, ProviderSessionEmit, ProviderSessionEvent, ProviderSessionEventKind,
    ProviderStreamTerminal,
};
use crate::process_registry::ProcessRegistry;
use crate::provider_adapters::ProviderId;
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncReadExt};
use tokio::sync::oneshot;

pub(super) const PROVIDER_STDOUT_MAX_LINE_BYTES: usize = 32 * 1024 * 1024;
pub(super) const PROVIDER_STDERR_MAX_LINE_BYTES: usize = 1024 * 1024;

#[derive(Debug, PartialEq, Eq)]
pub(super) enum ProviderBoundedLine {
    Line(Vec<u8>),
    Overflow,
    Eof,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum ProviderReaderStream {
    Stdout,
    Stderr,
}

/// Read one provider JSONL/log record without allowing an unterminated peer
/// payload to grow memory without bound. Overflow is drained through the next
/// newline so stderr can resynchronize; stdout callers fail the JSON protocol
/// closed because dropping one provider event can corrupt session state.
pub(super) async fn read_provider_bounded_line<R>(
    reader: &mut R,
    max_line_bytes: usize,
) -> std::io::Result<ProviderBoundedLine>
where
    R: AsyncBufRead + Unpin,
{
    let mut buf = Vec::new();
    let mut limited = reader.take(max_line_bytes as u64);
    let read = limited.read_until(b'\n', &mut buf).await?;
    if read == 0 {
        return Ok(ProviderBoundedLine::Eof);
    }
    if buf.last() == Some(&b'\n') {
        buf.pop();
        if buf.last() == Some(&b'\r') {
            buf.pop();
        }
        return Ok(ProviderBoundedLine::Line(buf));
    }
    if buf.len() < max_line_bytes {
        return Ok(ProviderBoundedLine::Line(buf));
    }

    loop {
        let mut scratch = Vec::new();
        let mut limited = reader.take(max_line_bytes as u64);
        let read = limited.read_until(b'\n', &mut scratch).await?;
        if read == 0 || scratch.last() == Some(&b'\n') {
            return Ok(ProviderBoundedLine::Overflow);
        }
    }
}

pub(super) fn observe_provider_stream_terminal(
    observed: &mut Option<ProviderStreamTerminal>,
    sender: &mut Option<oneshot::Sender<ProviderStreamTerminal>>,
    terminal: ProviderStreamTerminal,
) {
    let preserves_failure = observed
        .as_ref()
        .is_some_and(|current| current.phase == ProviderRunPhase::Failed)
        && terminal.phase != ProviderRunPhase::Failed;
    if !preserves_failure {
        *observed = Some(terminal.clone());
    }
    if let Some(sender) = sender.take() {
        let _ = sender.send(terminal);
    }
}

#[allow(clippy::too_many_arguments)]
pub(super) async fn report_provider_reader_issue(
    provider_id: ProviderId,
    run_id: &str,
    tab_id: &str,
    source: ProviderReaderStream,
    message: &str,
    process_summary: &str,
    emit: &ProviderSessionEmit,
    event_context: &ProviderEventRuntimeContext,
    process_registry: Option<&ProcessRegistry>,
    process_task_id: Option<&str>,
) {
    let event = match source {
        ProviderReaderStream::Stdout => {
            provider_reader_failure_event(provider_id, run_id, tab_id, "stdout-reader", message)
        }
        ProviderReaderStream::Stderr => {
            provider_reader_diagnostic_event(provider_id, run_id, tab_id, message)
        }
    };
    if let (Some(process_registry), Some(task_id)) = (process_registry, process_task_id) {
        process_registry
            .push_line(task_id, "stderr", process_summary.to_string())
            .await;
    }
    emit_provider_event(emit, event_context, event);
}

pub(super) fn reconcile_provider_terminal(
    terminal: (ProviderRunPhase, Option<i32>, Option<String>),
    observed_stream_terminal: Option<ProviderStreamTerminal>,
) -> (ProviderRunPhase, Option<i32>, Option<String>) {
    if terminal.0 == ProviderRunPhase::Completed {
        if let Some(observed) =
            observed_stream_terminal.filter(|observed| observed.phase == ProviderRunPhase::Failed)
        {
            return (observed.phase, observed.exit_code, observed.error);
        }
    }
    terminal
}

fn provider_reader_failure_event(
    provider_id: ProviderId,
    run_id: &str,
    tab_id: &str,
    source: &str,
    message: &str,
) -> ProviderSessionEvent {
    let mut event = provider_event(
        provider_id,
        run_id,
        tab_id,
        ProviderSessionEventKind::Failed,
        Some(message.to_string()),
        Some(source.to_string()),
    );
    event.error = Some(message.to_string());
    event
}

fn provider_reader_diagnostic_event(
    provider_id: ProviderId,
    run_id: &str,
    tab_id: &str,
    message: &str,
) -> ProviderSessionEvent {
    let mut event = provider_event(
        provider_id,
        run_id,
        tab_id,
        ProviderSessionEventKind::Raw,
        Some(message.to_string()),
        Some("stderr".to_string()),
    );
    event.error = Some(message.to_string());
    event.raw_reference = Some(content_reference(message.as_bytes(), true));
    event
}

#[cfg(test)]
mod tests {
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
}
