// src-tauri/src/mcp_events_tail.rs
//
// Tail `~/.shellx/mcp-events.jsonl` to surface stdio-mode host MCP
// tool calls into the running shellX UI.
//
// Why this file exists
// The HTTP MCP server (mcp_http.rs) emits `host-mcp-tool-call` events
// directly via `state.app.emit` because it lives in-process. The
// stdio MCP child (host_mcp.rs::run_stdio) runs under grok-build, not
// shellX, so it has no AppHandle. It writes one JSON line per tool
// call to `~/.shellx/mcp-events.jsonl`. This task tails that file and
// emits the same typed event the HTTP path emits, so the Tasks tab /
// /events WS / event-recent ring see both paths uniformly.
//
// Trade-offs
// - 500ms polling instead of `notify` crate watcher: keeps the
// dependency surface flat and avoids inotify quirks on WSL2 mirror
// mode.
// - Idempotent on app restart: we always start from EOF, so events
// written while shellX was closed are skipped (they'd have been
// orphan tool-call cards anyway).
// - 8 MiB rotation in host_mcp.rs::write_mcp_event_line — we
// auto-recover here by treating shrink-after-truncate as "start
// from offset 0".

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use tauri::{AppHandle, Emitter as _};
use tokio::io::AsyncSeekExt;

use crate::debug_api::DebugHub;

const POLL_MS: u64 = 500;

fn complete_jsonl_prefix_len(buf: &[u8]) -> usize {
    buf.iter()
        .rposition(|b| *b == b'\n')
        .map(|idx| idx + 1)
        .unwrap_or(0)
}

fn events_path() -> Option<PathBuf> {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .ok()?;
    Some(PathBuf::from(home).join(".shellx").join("mcp-events.jsonl"))
}

pub async fn tail_loop(handle: AppHandle, hub: Arc<DebugHub>) {
    let Some(path) = events_path() else { return };

    // Wait until the file exists before opening — host_mcp.rs creates
    // it on first tool call.
    let mut offset: u64;
    loop {
        // Seek-to-EOF on first open so we don't replay old lines from
        // a previous shellX session.
        if let Ok(meta) = tokio::fs::metadata(&path).await {
            offset = meta.len();
            break;
        }
        tokio::time::sleep(Duration::from_millis(POLL_MS)).await;
    }

    loop {
        tokio::time::sleep(Duration::from_millis(POLL_MS)).await;

        let meta = match tokio::fs::metadata(&path).await {
            Ok(m) => m,
            Err(_) => continue,
        };
        let new_len = meta.len();

        // Rotation detected (host_mcp.rs truncates at 8 MiB). Reset
        // offset to 0 — anything written between the truncate and our
        // next poll is read.
        if new_len < offset {
            offset = 0;
        }
        if new_len == offset {
            continue;
        }

        // Open + seek + read forward to new_len.
        let file = match tokio::fs::File::open(&path).await {
            Ok(f) => f,
            Err(_) => continue,
        };
        let mut reader = tokio::io::BufReader::new(file);
        if reader.seek(std::io::SeekFrom::Start(offset)).await.is_err() {
            continue;
        }
        let mut buf = Vec::with_capacity(4096);
        let bytes_read = match reader.read_to_end(&mut buf).await {
            Ok(n) => n,
            Err(_) => continue,
        };
        let complete_len = complete_jsonl_prefix_len(&buf);
        if complete_len == 0 {
            continue;
        }

        // Parse line-by-line. Tolerate a trailing partial line (it'll
        // appear on the next poll once the writer finishes the write).
        let text = match std::str::from_utf8(&buf[..complete_len]) {
            Ok(s) => s,
            Err(_) => {
                offset = offset.saturating_add(complete_len as u64);
                continue;
            }
        };
        offset = offset.saturating_add(complete_len as u64);
        let _tail_bytes = bytes_read.saturating_sub(complete_len);
        for line in text.lines() {
            if line.trim().is_empty() {
                continue;
            }
            let parsed: Result<serde_json::Value, _> = serde_json::from_str(line);
            let Ok(payload) = parsed else { continue };
            // Best-effort emit. Mirror the HTTP MCP shape so the UI
            // doesn't need to branch.
            let _ = handle.emit("host-mcp-tool-call", payload.clone());
            hub.record_raw_event("host-mcp-tool-call", payload);
        }
    }
}

use tokio::io::AsyncReadExt as _;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn complete_jsonl_prefix_len_leaves_partial_line_for_next_poll() {
        let buf = b"{\"ok\":true}\n{\"partial\":";
        assert_eq!(complete_jsonl_prefix_len(buf), b"{\"ok\":true}\n".len());
    }

    #[test]
    fn complete_jsonl_prefix_len_leaves_partial_utf8_for_next_poll() {
        let mut buf = b"{\"ok\":true}\n{\"text\":\"".to_vec();
        buf.push(0xE2);
        buf.push(0x82);
        assert_eq!(complete_jsonl_prefix_len(&buf), b"{\"ok\":true}\n".len());
    }
}
