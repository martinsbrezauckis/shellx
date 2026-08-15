//! Private ShellX conversation archives for automatic Task attempts.
//!
//! Task execution keeps provider output out of the durable Task store, but a
//! run still needs the same reviewable conversation surface as an operator
//! tab. This module binds the deterministic Task runtime tab to one normal
//! `~/.shellx/sessions/<id>.jsonl` archive and serializes writes on a dedicated
//! bounded worker. Only already-emitted ShellX event payloads enter the archive;
//! no authentication file or provider credential source is read here.

use std::collections::HashMap;
use std::io::Read as _;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use sha2::{Digest as _, Sha256};
use tauri::Manager as _;

use crate::task_execution_runtime::TaskExecutionIdentity;
use crate::task_model::TaskDefinitionRevision;
use crate::task_provider_dispatch::task_runtime_tab_id;

const TASK_RUNTIME_TAB_PREFIX: &str = "task-run-";
const TASK_CONVERSATION_QUEUE_CAPACITY: usize = 1_024;
const TASK_CONVERSATION_RECORD_MAX_BYTES: usize = 256 * 1_024;
const TASK_CONVERSATION_FLUSH_TIMEOUT: Duration = Duration::from_secs(5);
const TASK_CONVERSATION_EVIDENCE_MAX_BYTES: u64 = 64 * 1024 * 1024;

#[derive(Clone)]
struct ActiveTaskConversation {
    session_id: String,
    accepted_events: Arc<AtomicU64>,
    dropped_events: Arc<AtomicU64>,
    write_failed: Arc<AtomicBool>,
}

enum TaskConversationWrite {
    Append {
        session_id: String,
        line: String,
        write_failed: Arc<AtomicBool>,
    },
    Barrier(mpsc::Sender<()>),
}

/// Output-free summary returned after every queued transcript event has either
/// reached the normal private session log or been truthfully counted as lost.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct TaskConversationFlushSummary {
    pub(crate) session_id: String,
    pub(crate) accepted_events: u64,
    pub(crate) dropped_events: u64,
    pub(crate) write_failed: bool,
}

/// Output-free inspection of the private JSONL archive. The digest binds the
/// full file while the counters let Task Manager describe evidence quality
/// without copying prompts or provider output into the durable Task store.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct TaskConversationEvidenceSnapshot {
    pub(crate) session_id: String,
    pub(crate) archive_sha256: String,
    pub(crate) archive_bytes: u64,
    pub(crate) record_count: u32,
    pub(crate) provider_event_count: u32,
    pub(crate) initial_context_complete: bool,
    pub(crate) terminal_marker_present: bool,
    pub(crate) format_valid: bool,
}

pub(crate) struct TaskConversationArchive {
    active: Mutex<HashMap<String, ActiveTaskConversation>>,
    sender: mpsc::SyncSender<TaskConversationWrite>,
    home: Option<PathBuf>,
}

impl TaskConversationArchive {
    pub(crate) fn new() -> Self {
        Self::new_with_home(None)
    }

    #[cfg(test)]
    fn new_at(home: PathBuf) -> Self {
        Self::new_with_home(Some(home))
    }

    fn new_with_home(home: Option<PathBuf>) -> Self {
        let (sender, receiver) =
            mpsc::sync_channel::<TaskConversationWrite>(TASK_CONVERSATION_QUEUE_CAPACITY);
        std::thread::Builder::new()
            .name("shellx-task-conversation-writer".to_string())
            .spawn({
                let writer_home = home.clone();
                move || task_conversation_writer(receiver, writer_home)
            })
            .expect("spawn task conversation writer");
        Self {
            active: Mutex::new(HashMap::new()),
            sender,
            home,
        }
    }

    /// Create the normal private ShellX archive before provider dispatch. The
    /// initial title/context/prompt batch is synchronous so subsequent events
    /// can never overtake it in the JSONL.
    pub(crate) fn begin(
        &self,
        identity: &TaskExecutionIdentity,
        revision: &TaskDefinitionRevision,
        occurred_at_ms: i64,
    ) -> Result<String, String> {
        if occurred_at_ms <= 0 {
            return Err("task conversation requires a positive timestamp".to_string());
        }
        let session_id = task_runtime_tab_id(identity);
        if !is_task_runtime_tab_id(&session_id) {
            return Err("task conversation identity is invalid".to_string());
        }
        {
            let active = self
                .active
                .lock()
                .map_err(|_| "task conversation registry is unavailable".to_string())?;
            if let Some(existing) = active.get(&session_id) {
                return Ok(existing.session_id.clone());
            }
        }

        let connection_transport = task_transport_label(&revision.draft.environment.target_key);
        let initial = [
            serde_json::json!({
                "t": occurred_at_ms,
                "kind": "ui",
                "payload": {
                    "_meta": { "tabId": session_id, "kind": "title-override" },
                    "title": revision.draft.name,
                }
            }),
            serde_json::json!({
                "t": occurred_at_ms,
                "kind": "ui",
                "payload": {
                    "_meta": {
                        "tabId": session_id,
                        "kind": "connection-metadata",
                        "taskOccurrenceId": identity.occurrence_id,
                        "taskAttemptId": identity.attempt_id,
                    },
                    "connectionId": revision.draft.environment.connection_id,
                    "connectionLabel": revision.draft.environment.connection_id,
                    "connectionTransport": connection_transport,
                    "cwd": revision.draft.environment.canonical_cwd,
                }
            }),
            serde_json::json!({
                "t": occurred_at_ms,
                "kind": "ui",
                "payload": {
                    "_meta": { "tabId": session_id, "taskRun": true },
                    "text": format!("→ prompt: {}", revision.draft.instruction),
                    "attachments": [],
                }
            }),
        ];
        let batch = initial
            .iter()
            .map(serde_json::to_string)
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("serialize task conversation start: {error}"))?
            .join("\n");
        if batch.len() > TASK_CONVERSATION_RECORD_MAX_BYTES {
            return Err("task conversation start exceeds its bounded record budget".to_string());
        }
        if let Some(home) = &self.home {
            crate::append_session_log_blocking_at(home, &session_id, &batch)?;
        } else {
            crate::append_session_log_blocking(&session_id, &batch)?;
        }

        let route = ActiveTaskConversation {
            session_id: session_id.clone(),
            accepted_events: Arc::new(AtomicU64::new(0)),
            dropped_events: Arc::new(AtomicU64::new(0)),
            write_failed: Arc::new(AtomicBool::new(false)),
        };
        self.active
            .lock()
            .map_err(|_| "task conversation registry is unavailable".to_string())?
            .insert(session_id.clone(), route);
        Ok(session_id)
    }

    /// Queue one already-prepared event payload. The caller retains its normal
    /// UI/debug emission path; this copy exists only in the private conversation
    /// archive. A full queue drops the copy instead of blocking provider IO and
    /// makes the final Trace summary incomplete.
    pub(crate) fn record_event(
        &self,
        tab_id: &str,
        kind: &str,
        payload: &serde_json::Value,
        occurred_at_ms: i64,
    ) {
        if !is_task_runtime_tab_id(tab_id) || occurred_at_ms <= 0 {
            return;
        }
        let route = match self.active.lock() {
            Ok(active) => active.get(tab_id).cloned(),
            Err(_) => None,
        };
        let Some(route) = route else {
            return;
        };
        let line = match serde_json::to_string(&TaskConversationFrame {
            t: occurred_at_ms,
            kind,
            payload,
        }) {
            Ok(line) if line.len() <= TASK_CONVERSATION_RECORD_MAX_BYTES => line,
            _ => {
                route.dropped_events.fetch_add(1, Ordering::Relaxed);
                return;
            }
        };
        match self.sender.try_send(TaskConversationWrite::Append {
            session_id: route.session_id,
            line,
            write_failed: route.write_failed.clone(),
        }) {
            Ok(()) => {
                route.accepted_events.fetch_add(1, Ordering::Relaxed);
            }
            Err(_) => {
                route.dropped_events.fetch_add(1, Ordering::Relaxed);
            }
        }
    }

    /// Append a fixed terminal marker and wait for the writer barrier. This is
    /// called after the Task terminal receipt, so a failure changes only Trace
    /// completeness and can never change or repeat provider execution.
    pub(crate) fn finish(
        &self,
        tab_id: &str,
        terminal_state: &str,
        occurred_at_ms: i64,
    ) -> Result<Option<TaskConversationFlushSummary>, String> {
        let route = self
            .active
            .lock()
            .map_err(|_| "task conversation registry is unavailable".to_string())?
            .remove(tab_id);
        let Some(route) = route else {
            return Ok(None);
        };
        let terminal_line = serde_json::to_string(&serde_json::json!({
            "t": occurred_at_ms,
            "kind": "ui",
            "payload": {
                "_meta": { "tabId": tab_id, "kind": "task-run-terminal" },
                "text": terminal_state,
            }
        }))
        .map_err(|error| format!("serialize task conversation terminal: {error}"))?;
        self.sender
            .send(TaskConversationWrite::Append {
                session_id: route.session_id.clone(),
                line: terminal_line,
                write_failed: route.write_failed.clone(),
            })
            .map_err(|_| "task conversation writer stopped".to_string())?;
        let (ack_tx, ack_rx) = mpsc::channel();
        self.sender
            .send(TaskConversationWrite::Barrier(ack_tx))
            .map_err(|_| "task conversation writer stopped".to_string())?;
        ack_rx
            .recv_timeout(TASK_CONVERSATION_FLUSH_TIMEOUT)
            .map_err(|_| "task conversation flush timed out".to_string())?;
        Ok(Some(TaskConversationFlushSummary {
            session_id: route.session_id,
            accepted_events: route.accepted_events.load(Ordering::Relaxed),
            dropped_events: route.dropped_events.load(Ordering::Relaxed),
            write_failed: route.write_failed.load(Ordering::Relaxed),
        }))
    }

    /// Inspect only the deterministic private archive owned by this service.
    /// Symlinks, oversized files, and non-files are refused before reading.
    pub(crate) fn inspect(
        &self,
        session_id: &str,
    ) -> Result<Option<TaskConversationEvidenceSnapshot>, String> {
        if !is_task_runtime_tab_id(session_id) {
            return Err("task conversation identity is invalid".to_string());
        }
        let path = if let Some(home) = &self.home {
            home.join(".shellx")
                .join("sessions")
                .join(format!("{session_id}.jsonl"))
        } else {
            crate::session_log::session_jsonl_path(session_id)?
        };
        let metadata = match std::fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(format!("inspect task conversation failed: {error}")),
        };
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err("task conversation archive is not a regular file".to_string());
        }
        if metadata.len() > TASK_CONVERSATION_EVIDENCE_MAX_BYTES {
            return Err("task conversation archive exceeds its evidence budget".to_string());
        }
        let mut file = std::fs::File::open(&path)
            .map_err(|error| format!("open task conversation failed: {error}"))?;
        let mut bytes = Vec::with_capacity(metadata.len() as usize);
        file.read_to_end(&mut bytes)
            .map_err(|error| format!("read task conversation failed: {error}"))?;
        if bytes.len() as u64 != metadata.len() {
            return Err("task conversation archive changed during inspection".to_string());
        }
        let archive_sha256 = format!("{:x}", Sha256::digest(&bytes));
        let content = std::str::from_utf8(&bytes)
            .map_err(|_| "task conversation archive is not UTF-8".to_string())?;
        let mut record_count = 0_u32;
        let mut provider_event_count = 0_u32;
        let mut title = false;
        let mut context = false;
        let mut prompt = false;
        let mut terminal = false;
        let mut format_valid = true;
        for line in content.lines().filter(|line| !line.trim().is_empty()) {
            let Ok(record) = serde_json::from_str::<serde_json::Value>(line) else {
                format_valid = false;
                continue;
            };
            record_count = record_count.saturating_add(1);
            let meta = record.pointer("/payload/_meta");
            let matching_tab = meta
                .and_then(|value| value.get("tabId"))
                .and_then(serde_json::Value::as_str)
                == Some(session_id);
            let marker = meta
                .and_then(|value| value.get("kind"))
                .and_then(serde_json::Value::as_str);
            match marker {
                Some("title-override") if matching_tab => title = true,
                Some("connection-metadata") if matching_tab => context = true,
                Some("task-run-terminal") if matching_tab => terminal = true,
                _ if matching_tab
                    && meta
                        .and_then(|value| value.get("taskRun"))
                        .and_then(serde_json::Value::as_bool)
                        == Some(true) =>
                {
                    prompt = true
                }
                _ => provider_event_count = provider_event_count.saturating_add(1),
            }
        }
        Ok(Some(TaskConversationEvidenceSnapshot {
            session_id: session_id.to_string(),
            archive_sha256,
            archive_bytes: metadata.len(),
            record_count,
            provider_event_count,
            initial_context_complete: title && context && prompt,
            terminal_marker_present: terminal,
            format_valid,
        }))
    }
}

#[derive(Serialize)]
struct TaskConversationFrame<'a> {
    t: i64,
    kind: &'a str,
    payload: &'a serde_json::Value,
}

fn task_conversation_writer(
    receiver: mpsc::Receiver<TaskConversationWrite>,
    home: Option<PathBuf>,
) {
    while let Ok(message) = receiver.recv() {
        match message {
            TaskConversationWrite::Append {
                session_id,
                line,
                write_failed,
            } => {
                let result = if let Some(home) = &home {
                    crate::append_session_log_blocking_at(home, &session_id, &line)
                } else {
                    crate::append_session_log_blocking(&session_id, &line)
                };
                if result.is_err() {
                    write_failed.store(true, Ordering::Relaxed);
                }
            }
            TaskConversationWrite::Barrier(ack) => {
                let _ = ack.send(());
            }
        }
    }
}

pub(crate) fn record_tauri_event(
    app: &tauri::AppHandle,
    kind: &str,
    payload: &serde_json::Value,
    tab_id: Option<&str>,
) {
    let Some(tab_id) = tab_id.filter(|value| is_task_runtime_tab_id(value)) else {
        return;
    };
    let Some(archive) = app.try_state::<Arc<TaskConversationArchive>>() else {
        return;
    };
    archive.record_event(tab_id, kind, payload, current_time_ms());
}

pub(crate) fn is_task_runtime_tab_id(value: &str) -> bool {
    value.len() == TASK_RUNTIME_TAB_PREFIX.len() + 32
        && value.starts_with(TASK_RUNTIME_TAB_PREFIX)
        && value.as_bytes()[TASK_RUNTIME_TAB_PREFIX.len()..]
            .iter()
            .all(u8::is_ascii_hexdigit)
}

fn task_transport_label(target_key: &str) -> &str {
    match target_key.split(':').next().unwrap_or("") {
        "local" => "local",
        "wsl" => "wsl",
        "ssh" => "ssh",
        "windows" => "windows",
        other if !other.is_empty() => other,
        _ => "local",
    }
}

fn current_time_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::task_execution_runtime::TaskExecutionIdentity;
    use crate::task_model::*;

    fn revision() -> TaskDefinitionRevision {
        TaskDefinitionRevision {
            revision_id: "task-1:r1".to_string(),
            task_id: "task-1".to_string(),
            revision_number: 1,
            canonical_sha256: "a".repeat(64),
            created_at_ms: 1,
            draft: TaskDraft {
                name: "Daily review".to_string(),
                instruction: "Review the project and report changes.".to_string(),
                success_criteria: None,
                no_change_criteria: None,
                environment: TaskEnvironmentSnapshot {
                    connection_id: "local".to_string(),
                    snapshot_id: format!("sha256:{}", "b".repeat(64)),
                    target_key: "local:linux".to_string(),
                    canonical_cwd: "/workspace".to_string(),
                    project_id: None,
                },
                candidates: vec![TaskExecutionCandidate {
                    order: 1,
                    provider_id: "grok".to_string(),
                    model: TaskModelSelection::ProviderDefault,
                    capability_requirements: vec![],
                    option_refs: vec![],
                }],
                execution_policy: TaskExecutionPolicy {
                    permission_mode: "default".to_string(),
                    autonomy_mode: "default".to_string(),
                    tool_exposure_ids: vec![],
                },
                attachment_refs: vec![],
                workflow: None,
                vault_requirements: vec![],
                trigger: TaskTrigger::Manual,
                timezone: "UTC".to_string(),
                missed_run_policy: TaskMissedRunPolicy::Skip,
                concurrency_policy: TaskConcurrencyPolicy { max_active_runs: 1 },
                timeout_policy: TaskTimeoutPolicy {
                    max_run_seconds: 60,
                },
                retry_policy: TaskRetryPolicy {
                    max_attempts: 1,
                    idempotent_observation_only: false,
                },
                notification_policy: TaskNotificationPolicy::None,
                retention_policy: TaskRetentionPolicy { max_receipts: 32 },
                origin: None,
            },
        }
    }

    fn identity() -> TaskExecutionIdentity {
        TaskExecutionIdentity {
            task_id: "task-1".to_string(),
            revision_id: "task-1:r1".to_string(),
            revision_sha256: "a".repeat(64),
            occurrence_id: "task-occurrence:v1:test".to_string(),
            attempt_id: "attempt-1".to_string(),
        }
    }

    #[test]
    fn task_conversation_is_private_ordered_and_reviewable() {
        let root = tempfile::tempdir().expect("temp root");
        let archive = TaskConversationArchive::new_at(root.path().to_path_buf());
        let session_id = archive.begin(&identity(), &revision(), 10).expect("begin");
        archive.record_event(
            &session_id,
            "provider-session-event",
            &serde_json::json!({
                "_meta": { "tabId": session_id },
                "kind": "message",
                "text": "private provider output",
            }),
            11,
        );
        let summary = archive
            .finish(&session_id, "completed", 12)
            .expect("finish")
            .expect("active route");
        assert_eq!(summary.session_id, session_id);
        assert_eq!(summary.accepted_events, 1);
        assert_eq!(summary.dropped_events, 0);
        assert!(!summary.write_failed);

        let snapshot = archive.inspect(&session_id).unwrap().unwrap();
        assert_eq!(snapshot.record_count, 5);
        assert_eq!(snapshot.provider_event_count, 1);
        assert!(snapshot.initial_context_complete);
        assert!(snapshot.terminal_marker_present);
        assert!(snapshot.format_valid);
        assert_eq!(snapshot.archive_sha256.len(), 64);

        let path = root
            .path()
            .join(".shellx")
            .join("sessions")
            .join(format!("{session_id}.jsonl"));
        let content = std::fs::read_to_string(path).expect("read transcript");
        let records = crate::split_session_jsonl_records(&content);
        assert_eq!(records.len(), 5);
        assert!(records[0].contains("title-override"));
        assert!(records[1].contains("connection-metadata"));
        assert!(records[2].contains("→ prompt:"));
        assert!(records[3].contains("private provider output"));
        assert!(records[4].contains("task-run-terminal"));
    }

    #[test]
    fn runtime_tab_shape_is_exact() {
        assert!(is_task_runtime_tab_id(
            "task-run-0123456789abcdef0123456789abcdef"
        ));
        assert!(!is_task_runtime_tab_id("task-run-short"));
        assert!(!is_task_runtime_tab_id(
            "task-run-0123456789abcdef0123456789abcdeg"
        ));
    }
}
