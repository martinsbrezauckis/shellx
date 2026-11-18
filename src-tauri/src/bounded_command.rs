//! Bounded local subprocess capture for short ShellX helper commands.
//!
//! The helpers in this module own the *local* wrapper process only.  A timed
//! out `ssh.exe` or `wsl.exe` is terminated and reaped here, but that alone is
//! not evidence that a remote command or a WSL descendant has exited.

use std::process::{Output, Stdio};
use std::time::Duration;

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::process::{Child, Command};

pub(crate) const DEFAULT_STDOUT_LIMIT: usize = 8 * 1024 * 1024;
pub(crate) const DEFAULT_STDERR_LIMIT: usize = 512 * 1024;

/// Run a short command with bounded capture and local-child cleanup.
///
/// The command is placed in a fresh local process session before it is
/// spawned.  Timeout, pipe read, and output-cap errors terminate and reap that
/// session before returning.  The same session is synchronously signalled if
/// the future is cancelled by its caller.
pub(crate) async fn run_bounded_output(
    command: &mut Command,
    label: &str,
    deadline: Duration,
    stdout_limit: usize,
    stderr_limit: usize,
) -> Result<Output, String> {
    run_bounded_output_with_optional_stdin(
        command,
        label,
        deadline,
        stdout_limit,
        stderr_limit,
        None,
    )
    .await
}

/// As [`run_bounded_output`], with an exact byte sequence written to stdin and
/// then closed before output capture begins.  Callers must not include secret
/// bytes in `label` or in errors they add around this helper.
pub(crate) async fn run_bounded_output_with_stdin(
    command: &mut Command,
    label: &str,
    deadline: Duration,
    stdout_limit: usize,
    stderr_limit: usize,
    stdin: &[u8],
) -> Result<Output, String> {
    run_bounded_output_with_optional_stdin(
        command,
        label,
        deadline,
        stdout_limit,
        stderr_limit,
        Some(stdin),
    )
    .await
}

async fn run_bounded_output_with_optional_stdin(
    command: &mut Command,
    label: &str,
    deadline: Duration,
    stdout_limit: usize,
    stderr_limit: usize,
    stdin: Option<&[u8]>,
) -> Result<Output, String> {
    use crate::winproc::NoWindowExt as _;

    command
        .stdin(if stdin.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        // Tokio's direct-child fallback covers a cancellation race before the
        // session guard below can issue its group/tree request.
        .kill_on_drop(true)
        .no_window();
    crate::winproc::apply_pdeathsig_preexec(command);
    crate::winproc::apply_new_session_preexec(command);

    let mut child = command
        .spawn()
        .map_err(|error| format!("{label} failed to spawn: {error}"))?;
    let pid = match child.id() {
        Some(pid) => pid,
        None => {
            let _ = child.kill().await;
            return Err(format!("{label} started without an owned process id"));
        }
    };
    let local_tree = crate::winproc::own_child_process_tree(pid);
    if !local_tree.binds_parent_lifetime() {
        crate::winproc::tie_to_parent_lifetime(pid);
    }
    let mut owned = OwnedCommandChild::new(child, pid, local_tree);

    let result = tokio::time::timeout(
        deadline,
        capture_output(&mut owned.child, stdin, stdout_limit, stderr_limit),
    )
    .await;
    match result {
        Ok(Ok(output)) => {
            owned.disarm();
            Ok(output)
        }
        Ok(Err(error)) => Err(with_cleanup(label, error, &mut owned).await),
        Err(_) => Err(with_cleanup(
            label,
            format!("timed out after {} ms", deadline.as_millis()),
            &mut owned,
        )
        .await),
    }
}

async fn with_cleanup(label: &str, failure: String, owned: &mut OwnedCommandChild) -> String {
    match owned.terminate_and_reap().await {
        Ok(()) => {
            format!("{label} {failure}; owned local process session was terminated and reaped")
        }
        Err(cleanup) => format!("{label} {failure}; owned local process cleanup failed: {cleanup}"),
    }
}

async fn capture_output(
    child: &mut Child,
    stdin: Option<&[u8]>,
    stdout_limit: usize,
    stderr_limit: usize,
) -> Result<Output, String> {
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "stdout was not available for the owned command".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "stderr was not available for the owned command".to_string())?;
    let (stdin_pipe, stdin_bytes) = match stdin {
        Some(bytes) => (
            Some(
                child
                    .stdin
                    .take()
                    .ok_or_else(|| "stdin was not available for the owned command".to_string())?,
            ),
            Some(bytes),
        ),
        None => (None, None),
    };
    // A command may write output before it finishes reading stdin.  Run the
    // writer and both readers together so a full pipe cannot deadlock the
    // deadline path.
    let (stdout, stderr, ()) = tokio::try_join!(
        read_capped(stdout, stdout_limit, "stdout"),
        read_capped(stderr, stderr_limit, "stderr"),
        write_stdin(stdin_pipe, stdin_bytes),
    )?;
    let status = child
        .wait()
        .await
        .map_err(|error| format!("owned child wait failed: {error}"))?;
    Ok(Output {
        status,
        stdout,
        stderr,
    })
}

async fn write_stdin(
    stdin: Option<tokio::process::ChildStdin>,
    bytes: Option<&[u8]>,
) -> Result<(), String> {
    let (Some(mut pipe), Some(bytes)) = (stdin, bytes) else {
        return Ok(());
    };
    pipe.write_all(bytes)
        .await
        .map_err(|error| format!("stdin write failed: {error}"))?;
    pipe.shutdown()
        .await
        .map_err(|error| format!("stdin close failed: {error}"))
}

async fn read_capped<R>(reader: R, limit: usize, stream: &str) -> Result<Vec<u8>, String>
where
    R: AsyncRead + Unpin,
{
    let max = u64::try_from(limit).unwrap_or(u64::MAX).saturating_add(1);
    let mut limited = reader.take(max);
    let mut captured = Vec::with_capacity(limit.min(64 * 1024));
    limited
        .read_to_end(&mut captured)
        .await
        .map_err(|error| format!("{stream} read failed: {error}"))?;
    if captured.len() > limit {
        return Err(format!("{stream} exceeded {limit} byte capture limit"));
    }
    Ok(captured)
}

/// Owns a local command session for the duration of a bounded operation.
///
/// The Drop implementation handles future cancellation.  It cannot await a
/// reap, but the explicit error/timeout path always does; `kill_on_drop` is
/// retained as a direct-child fallback for the tiny cancellation race.
struct OwnedCommandChild {
    child: Child,
    session_leader_pid: u32,
    local_tree: crate::winproc::OwnedChildProcessTree,
    armed: bool,
}

impl OwnedCommandChild {
    fn new(
        child: Child,
        session_leader_pid: u32,
        local_tree: crate::winproc::OwnedChildProcessTree,
    ) -> Self {
        Self {
            child,
            session_leader_pid,
            local_tree,
            armed: true,
        }
    }

    fn disarm(&mut self) {
        self.armed = false;
    }

    async fn terminate_and_reap(&mut self) -> Result<(), String> {
        // A dedicated Windows job ends the entire owned local tree before the
        // async fallback/reap. Unix has no per-child job here and uses its
        // fresh process group below.
        let dedicated_job = self.local_tree.terminate_now();
        let result = crate::winproc::terminate_owned_tokio_child_session_tree(
            &mut self.child,
            self.session_leader_pid,
        )
        .await;
        if result.is_ok() {
            self.disarm();
        }
        match (dedicated_job, result) {
            (_, Ok(())) => Ok(()),
            (Err(job_error), Err(cleanup_error)) => Err(format!(
                "dedicated owned-child job cleanup failed: {job_error}; fallback cleanup failed: {cleanup_error}"
            )),
            (_, Err(cleanup_error)) => Err(cleanup_error),
        }
    }
}

impl Drop for OwnedCommandChild {
    fn drop(&mut self) {
        if self.armed {
            if let Err(error) = self.local_tree.terminate_now() {
                tracing::warn!(
                    "owned child cancellation could not terminate dedicated job: {error}"
                );
            }
            crate::winproc::request_owned_tokio_child_session_termination(
                &mut self.child,
                self.session_leader_pid,
            );
        }
    }
}

#[cfg(all(test, unix))]
#[path = "../public/tests/inline/bounded_command/tests.rs"]
mod tests;
