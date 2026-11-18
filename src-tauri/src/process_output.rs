use std::collections::VecDeque;
use std::io;

use tokio::io::{AsyncRead, AsyncReadExt};

/// Maximum output retained from each stdout/stderr pipe for short-lived
/// commands. The pipe is always drained to EOF so a noisy child cannot block,
/// while memory remains bounded independently for both streams.
pub(crate) const COMMAND_STREAM_CAPTURE_BYTES: usize = 4 * 1024 * 1024;

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct BoundedStreamCapture {
    bytes: Vec<u8>,
    total_bytes: u64,
}

impl BoundedStreamCapture {
    pub(crate) fn into_lossy_string(self) -> String {
        let retained_bytes = self.bytes.len();
        let mut text = String::from_utf8_lossy(&self.bytes).into_owned();
        if self.total_bytes > retained_bytes as u64 {
            if !text.ends_with('\n') {
                text.push('\n');
            }
            text.push_str(&format!(
                "[ShellX capture truncated: {} bytes total; last {} bytes retained]",
                self.total_bytes, retained_bytes
            ));
        }
        text
    }
}

/// Drain an async stream to EOF while retaining only its most recent `cap`
/// bytes. Keeping the tail preserves terminal errors and provider result
/// envelopes. `VecDeque` avoids repeatedly shifting a multi-megabyte buffer as
/// older chunks are discarded.
pub(crate) async fn drain_stream_tail_bounded<R>(
    mut reader: R,
    cap: usize,
) -> io::Result<BoundedStreamCapture>
where
    R: AsyncRead + Unpin,
{
    let cap = cap.max(1);
    let mut tail = VecDeque::with_capacity(cap.min(16 * 1024));
    let mut total_bytes = 0u64;
    let mut chunk = vec![0u8; 16 * 1024].into_boxed_slice();

    loop {
        let read = reader.read(&mut chunk).await?;
        if read == 0 {
            break;
        }
        total_bytes = total_bytes.saturating_add(read as u64);

        if read >= cap {
            tail.clear();
            tail.extend(&chunk[read - cap..read]);
            continue;
        }

        let overflow = tail.len().saturating_add(read).saturating_sub(cap);
        if overflow > 0 {
            tail.drain(..overflow);
        }
        tail.extend(&chunk[..read]);
    }

    Ok(BoundedStreamCapture {
        bytes: tail.into_iter().collect(),
        total_bytes,
    })
}

#[cfg(test)]
#[path = "../public/tests/inline/process_output/tests.rs"]
mod tests;
