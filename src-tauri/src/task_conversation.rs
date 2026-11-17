//! Private ShellX conversation archives for automatic Task attempts.
//!
//! Task execution keeps provider output out of the durable Task store, but a
//! run still needs the same reviewable conversation surface as an operator
//! tab. This module binds the deterministic Task runtime tab to one normal
//! `~/.shellx/sessions/<id>.jsonl` archive and serializes writes on a dedicated
//! bounded worker. Only already-emitted ShellX event payloads enter the archive;
//! no authentication file or provider credential source is read here.

use std::collections::{BTreeMap, HashMap, VecDeque};
use std::io::Read as _;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};
use tauri::Manager as _;

use crate::task_execution_runtime::TaskExecutionIdentity;
use crate::task_model::TaskDefinitionRevision;
use crate::task_provider_dispatch::task_runtime_tab_id;

const TASK_RUNTIME_TAB_PREFIX: &str = "task-run-";
const TASK_CONVERSATION_QUEUE_CAPACITY: usize = 1_024;
const TASK_CONVERSATION_RECORD_MAX_BYTES: usize = 256 * 1_024;
const TASK_CONVERSATION_STREAM_CONTEXT_MAX_BYTES: usize = 64 * 1_024;
const TASK_CONVERSATION_FLUSH_TIMEOUT: Duration = Duration::from_secs(5);
const TASK_CONVERSATION_EVIDENCE_MAX_BYTES: u64 = 64 * 1024 * 1024;
// Keep the automatic archive within the same bound used by Trace inspection.
// A small reserve remains for one truncation marker, terminal marker, and
// durable completion proof.
const TASK_CONVERSATION_ARCHIVE_MAX_BYTES: u64 = TASK_CONVERSATION_EVIDENCE_MAX_BYTES;
const TASK_CONVERSATION_ARCHIVE_RESERVE_BYTES: u64 = 8 * 1024;

#[derive(Clone)]
struct ActiveTaskConversation {
    session_id: String,
    identity: TaskExecutionIdentity,
    accepting_events: Arc<Mutex<bool>>,
    stream_redactor: Arc<Mutex<TaskConversationStreamRedactor>>,
    accepted_events: Arc<AtomicU64>,
    dropped_events: Arc<AtomicU64>,
    accepted_bytes: Arc<AtomicU64>,
    budget_exhausted: Arc<AtomicBool>,
    write_failed: Arc<AtomicBool>,
}

/// One bounded unpersisted provider event. The stream redactor retains a
/// bounded sequence while any lexical tail could still span provider frames.
struct TaskConversationBufferedEvent {
    kind: String,
    payload: serde_json::Value,
    occurred_at_ms: i64,
    serialized_bytes: usize,
}

#[derive(Default)]
struct TaskArchiveStreamContext {
    text: String,
    overflowed: bool,
}

#[derive(Default)]
struct TaskConversationStreamRedactor {
    pending: VecDeque<TaskConversationBufferedEvent>,
    pending_bytes: usize,
    blocked_contexts: HashMap<String, TaskArchiveBlockedStream>,
    policy_exclusion_until_terminal: bool,
}

impl TaskConversationStreamRedactor {
    /// Holds only the unresolved lexical tail of a provider stream. Frames
    /// whose text could still complete a credential are never handed to the
    /// writer; an overlong unresolved context becomes an explicit policy
    /// exclusion instead of leaking its early fragments.
    fn push(
        &mut self,
        kind: &str,
        payload: &serde_json::Value,
        occurred_at_ms: i64,
    ) -> (Vec<TaskConversationBufferedEvent>, bool) {
        let payload_bytes = match serde_json::to_vec(payload) {
            Ok(bytes) if bytes.len() <= TASK_CONVERSATION_RECORD_MAX_BYTES => bytes.len(),
            _ => {
                self.redact_pending_as_stream_policy();
                return (self.take_pending(), true);
            }
        };
        let mut current = TaskConversationBufferedEvent {
            kind: kind.to_string(),
            payload: payload.clone(),
            occurred_at_ms,
            serialized_bytes: payload_bytes.saturating_add(kind.len()).saturating_add(32),
        };
        if self.policy_exclusion_until_terminal {
            redact_task_archive_stream_text_values(&mut current.payload);
            return (vec![current], false);
        }
        for (context, block) in self.blocked_contexts.clone() {
            let completes_block = task_archive_stream_context_completes_block(
                &current.payload,
                &context,
                block.awaiting_value,
            );
            if task_archive_redact_stream_text_context(&mut current.payload, &context, block.rule)
                && completes_block
            {
                self.blocked_contexts.remove(&context);
            }
        }
        self.pending_bytes = self.pending_bytes.saturating_add(current.serialized_bytes);
        self.pending.push_back(current);
        self.apply_completed_secret_rules();
        let contexts = task_archive_pending_text_contexts(&self.pending);
        let known_prefix = contexts.values().any(|context| {
            context.overflowed || task_archive_has_known_secret_prefix_suffix(&context.text)
        });
        let generic_tail = contexts
            .values()
            .any(|context| task_archive_has_unresolved_token_tail(&context.text));
        if known_prefix || generic_tail || !self.blocked_contexts.is_empty() {
            if self.pending_bytes > TASK_CONVERSATION_STREAM_CONTEXT_MAX_BYTES {
                self.redact_pending_as_stream_policy();
                self.policy_exclusion_until_terminal = true;
                return (self.take_pending(), false);
            }
            return (Vec::new(), false);
        }
        (self.take_pending(), false)
    }

    fn finish(&mut self) -> Vec<TaskConversationBufferedEvent> {
        let contexts = task_archive_pending_text_contexts(&self.pending);
        if contexts.values().any(|context| {
            context.overflowed || task_archive_has_known_secret_prefix_suffix(&context.text)
        }) || !self.blocked_contexts.is_empty()
        {
            self.redact_pending_as_stream_policy();
        }
        self.take_pending()
    }

    fn apply_completed_secret_rules(&mut self) {
        for (stream_context, context) in task_archive_pending_text_contexts(&self.pending) {
            let Some(rule) = task_archive_text_rule(&context.text) else {
                continue;
            };
            for event in &mut self.pending {
                task_archive_redact_stream_text_context(&mut event.payload, &stream_context, rule);
            }
            self.blocked_contexts.insert(
                stream_context,
                TaskArchiveBlockedStream {
                    rule,
                    awaiting_value: true,
                },
            );
        }
    }

    fn redact_pending_as_stream_policy(&mut self) {
        for event in &mut self.pending {
            redact_task_archive_stream_text_values(&mut event.payload);
        }
        self.blocked_contexts.clear();
    }

    fn take_pending(&mut self) -> Vec<TaskConversationBufferedEvent> {
        self.pending_bytes = 0;
        self.pending.drain(..).collect()
    }
}

enum TaskConversationWrite {
    Append {
        session_id: String,
        line: String,
        write_failed: Arc<AtomicBool>,
    },
    Barrier(mpsc::Sender<()>),
}

fn enqueue_task_conversation_control(
    sender: &mpsc::SyncSender<TaskConversationWrite>,
    mut message: TaskConversationWrite,
    deadline: Instant,
) -> Result<(), String> {
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err("task conversation flush timed out".to_string());
        }
        match sender.try_send(message) {
            Ok(()) => return Ok(()),
            Err(mpsc::TrySendError::Disconnected(_)) => {
                return Err("task conversation writer stopped".to_string());
            }
            Err(mpsc::TrySendError::Full(pending)) => {
                message = pending;
                std::thread::sleep(remaining.min(Duration::from_millis(5)));
            }
        }
    }
}

/// Output-free summary returned after every queued transcript event has either
/// reached the normal private session log or been truthfully counted as lost.
/// `write_failed` also covers an archive durability sync failure: a caller must
/// treat either failure as incomplete evidence.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct TaskConversationFlushSummary {
    pub(crate) session_id: String,
    pub(crate) accepted_events: u64,
    pub(crate) dropped_events: u64,
    pub(crate) write_failed: bool,
}

/// The final output-free JSONL record written after a Task terminal marker.
///
/// It is deliberately part of the archive rather than the process-local
/// writer state. A later startup can therefore distinguish a cleanly observed
/// terminal stream from an archive that merely looks terminal because the
/// process stopped before its queue/loss counters were preserved.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TaskConversationDurableFlushProof {
    pub(crate) session_id: String,
    pub(crate) task_id: String,
    pub(crate) revision_id: String,
    pub(crate) revision_sha256: String,
    pub(crate) occurrence_id: String,
    pub(crate) attempt_id: String,
    pub(crate) accepted_events: u64,
    pub(crate) dropped_events: u64,
    pub(crate) write_failed: bool,
    pub(crate) prefix_sha256: String,
    pub(crate) prefix_bytes: u64,
    pub(crate) prefix_record_count: u32,
}

impl TaskConversationDurableFlushProof {
    pub(crate) fn matches_identity(
        &self,
        identity: &TaskExecutionIdentity,
        session_id: &str,
    ) -> bool {
        self.session_id == session_id
            && self.task_id == identity.task_id
            && self.revision_id == identity.revision_id
            && self.revision_sha256 == identity.revision_sha256
            && self.occurrence_id == identity.occurrence_id
            && self.attempt_id == identity.attempt_id
    }

    pub(crate) fn flush_summary(&self) -> TaskConversationFlushSummary {
        TaskConversationFlushSummary {
            session_id: self.session_id.clone(),
            accepted_events: self.accepted_events,
            dropped_events: self.dropped_events,
            write_failed: self.write_failed,
        }
    }
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
    /// Present only when a structurally valid proof is the final record and
    /// immediately follows the archive's terminal marker. Callers must still
    /// bind it to the expected immutable Task identity before using its facts.
    pub(crate) durable_flush_proof: Option<TaskConversationDurableFlushProof>,
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
        let prior_bytes = task_conversation_existing_bytes(self.home.as_deref(), &session_id)?;
        let initial_bytes = prior_bytes
            .checked_add((batch.len() + 1) as u64)
            .ok_or_else(|| "task conversation archive byte count overflowed".to_string())?;
        if initial_bytes
            > TASK_CONVERSATION_ARCHIVE_MAX_BYTES
                .saturating_sub(TASK_CONVERSATION_ARCHIVE_RESERVE_BYTES)
        {
            return Err(
                "task conversation archive already exceeds its evidence budget".to_string(),
            );
        }
        if let Some(home) = &self.home {
            crate::append_session_log_blocking_at(home, &session_id, &batch)?;
        } else {
            crate::append_session_log_blocking(&session_id, &batch)?;
        }

        let route = ActiveTaskConversation {
            session_id: session_id.clone(),
            identity: identity.clone(),
            accepting_events: Arc::new(Mutex::new(true)),
            stream_redactor: Arc::new(Mutex::new(TaskConversationStreamRedactor::default())),
            accepted_events: Arc::new(AtomicU64::new(0)),
            dropped_events: Arc::new(AtomicU64::new(0)),
            accepted_bytes: Arc::new(AtomicU64::new(initial_bytes)),
            budget_exhausted: Arc::new(AtomicBool::new(false)),
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
        let accepting_events = match route.accepting_events.lock() {
            Ok(accepting_events) => accepting_events,
            Err(_) => return,
        };
        if !*accepting_events {
            return;
        }
        let (emitted, dropped_current) = match route.stream_redactor.lock() {
            Ok(mut redactor) => redactor.push(kind, payload, occurred_at_ms),
            Err(_) => {
                route.dropped_events.fetch_add(1, Ordering::Relaxed);
                return;
            }
        };
        if dropped_current {
            route.dropped_events.fetch_add(1, Ordering::Relaxed);
        }
        for emitted in emitted {
            self.queue_task_conversation_event(&route, emitted);
        }
    }

    fn queue_task_conversation_event(
        &self,
        route: &ActiveTaskConversation,
        event: TaskConversationBufferedEvent,
    ) {
        let occurred_at_ms = event.occurred_at_ms;
        let archived_payload = scrub_task_archive_payload(event.payload);
        let line = match serde_json::to_string(&TaskConversationFrame {
            t: occurred_at_ms,
            kind: &event.kind,
            payload: &archived_payload,
        }) {
            Ok(line) if line.len() <= TASK_CONVERSATION_RECORD_MAX_BYTES => line,
            _ => {
                route.dropped_events.fetch_add(1, Ordering::Relaxed);
                return;
            }
        };
        let line_bytes = (line.len() + 1) as u64;
        let event_budget = TASK_CONVERSATION_ARCHIVE_MAX_BYTES
            .saturating_sub(TASK_CONVERSATION_ARCHIVE_RESERVE_BYTES);
        #[allow(
            deprecated,
            reason = "fetch_update supports the Rust 1.88 minimum toolchain"
        )]
        let accepted =
            route
                .accepted_bytes
                .fetch_update(Ordering::AcqRel, Ordering::Relaxed, |current| {
                    current
                        .checked_add(line_bytes)
                        .filter(|next| *next <= event_budget)
                });
        if accepted.is_err() {
            route.dropped_events.fetch_add(1, Ordering::Relaxed);
            if !route.budget_exhausted.swap(true, Ordering::AcqRel) {
                let marker = task_conversation_budget_marker(&route.session_id, occurred_at_ms);
                if self
                    .sender
                    .try_send(TaskConversationWrite::Append {
                        session_id: route.session_id.clone(),
                        line: marker,
                        write_failed: route.write_failed.clone(),
                    })
                    .is_err()
                {
                    route.dropped_events.fetch_add(1, Ordering::Relaxed);
                }
            }
            return;
        }
        match self.sender.try_send(TaskConversationWrite::Append {
            session_id: route.session_id.clone(),
            line,
            write_failed: route.write_failed.clone(),
        }) {
            Ok(()) => {
                route.accepted_events.fetch_add(1, Ordering::Relaxed);
            }
            Err(_) => {
                route.accepted_bytes.fetch_sub(line_bytes, Ordering::AcqRel);
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
        let flush_deadline = Instant::now() + TASK_CONVERSATION_FLUSH_TIMEOUT;
        {
            let mut accepting_events = route
                .accepting_events
                .lock()
                .map_err(|_| "task conversation event gate is unavailable".to_string())?;
            *accepting_events = false;
        }
        let pending = route
            .stream_redactor
            .lock()
            .map_err(|_| "task conversation stream redactor is unavailable".to_string())?
            .finish();
        for pending in pending {
            self.queue_task_conversation_event(&route, pending);
        }
        let terminal_line = serde_json::to_string(&serde_json::json!({
            "t": occurred_at_ms,
            "kind": "ui",
            "payload": {
                "_meta": { "tabId": tab_id, "kind": "task-run-terminal" },
                "text": terminal_state,
            }
        }))
        .map_err(|error| format!("serialize task conversation terminal: {error}"))?;
        enqueue_task_conversation_control(
            &self.sender,
            TaskConversationWrite::Append {
                session_id: route.session_id.clone(),
                line: terminal_line,
                write_failed: route.write_failed.clone(),
            },
            flush_deadline,
        )?;
        let (ack_tx, ack_rx) = mpsc::channel();
        enqueue_task_conversation_control(
            &self.sender,
            TaskConversationWrite::Barrier(ack_tx),
            flush_deadline,
        )?;
        ack_rx
            .recv_timeout(flush_deadline.saturating_duration_since(Instant::now()))
            .map_err(|_| "task conversation flush timed out".to_string())?;
        let summary = TaskConversationFlushSummary {
            session_id: route.session_id.clone(),
            accepted_events: route.accepted_events.load(Ordering::Relaxed),
            dropped_events: route.dropped_events.load(Ordering::Relaxed),
            write_failed: route.write_failed.load(Ordering::Relaxed),
        };
        let prefix =
            match task_conversation_sync_and_prefix(self.home.as_deref(), &summary.session_id) {
                Ok(prefix) => prefix,
                Err(_) => {
                    return Ok(Some(TaskConversationFlushSummary {
                        write_failed: true,
                        ..summary
                    }));
                }
            };
        let proof_line =
            task_conversation_durable_flush_proof_line(&route, &summary, &prefix, occurred_at_ms)?;
        enqueue_task_conversation_control(
            &self.sender,
            TaskConversationWrite::Append {
                session_id: summary.session_id.clone(),
                line: proof_line,
                write_failed: route.write_failed.clone(),
            },
            flush_deadline,
        )?;
        let (proof_ack_tx, proof_ack_rx) = mpsc::channel();
        enqueue_task_conversation_control(
            &self.sender,
            TaskConversationWrite::Barrier(proof_ack_tx),
            flush_deadline,
        )?;
        proof_ack_rx
            .recv_timeout(flush_deadline.saturating_duration_since(Instant::now()))
            .map_err(|_| "task conversation proof flush timed out".to_string())?;
        let proof_sync_failed =
            task_conversation_sync_archive(self.home.as_deref(), &summary.session_id).is_err();
        Ok(Some(TaskConversationFlushSummary {
            write_failed: route.write_failed.load(Ordering::Relaxed) || proof_sync_failed,
            ..summary
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
        let path = task_conversation_archive_path(self.home.as_deref(), session_id)?;
        let bytes = match task_conversation_read_bounded_stable(
            &path,
            TASK_CONVERSATION_EVIDENCE_MAX_BYTES,
            "inspect task conversation",
        ) {
            Ok(bytes) => bytes,
            Err(error) if error == "task conversation archive not found" => return Ok(None),
            Err(error) => return Err(error),
        };
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
        let mut durable_flush_proof = None;
        let mut last_record_was_terminal = false;
        let mut proof_was_last_record = true;
        let mut byte_offset = 0_usize;
        for raw_line in content.split_inclusive('\n') {
            let line_start = byte_offset;
            byte_offset = byte_offset.saturating_add(raw_line.len());
            let line = raw_line.strip_suffix('\n').unwrap_or(raw_line);
            if line.trim().is_empty() {
                continue;
            }
            if durable_flush_proof.is_some() {
                proof_was_last_record = false;
            }
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
            let prior_record_was_terminal = last_record_was_terminal;
            last_record_was_terminal = false;
            match marker {
                Some("title-override") if matching_tab => title = true,
                Some("connection-metadata") if matching_tab => context = true,
                Some("task-run-terminal") if matching_tab => {
                    terminal = true;
                    last_record_was_terminal = true;
                }
                Some("task-run-truncated") if matching_tab => {}
                Some("task-run-durable-flush-proof-v1") if matching_tab => {
                    let proof = task_conversation_durable_flush_proof_from_record(
                        &record,
                        session_id,
                        &bytes[..line_start],
                        record_count.saturating_sub(1),
                    );
                    if !prior_record_was_terminal || durable_flush_proof.is_some() {
                        format_valid = false;
                    }
                    match proof {
                        Some(proof)
                            if prior_record_was_terminal && durable_flush_proof.is_none() =>
                        {
                            durable_flush_proof = Some(proof)
                        }
                        None => format_valid = false,
                        Some(_) => {}
                    }
                }
                _ if matching_tab
                    && meta
                        .and_then(|value| value.get("taskRun"))
                        .and_then(serde_json::Value::as_bool)
                        == Some(true) =>
                {
                    prompt = true
                }
                _ => {
                    provider_event_count = provider_event_count.saturating_add(1);
                }
            }
        }
        if !proof_was_last_record {
            format_valid = false;
        }
        Ok(Some(TaskConversationEvidenceSnapshot {
            session_id: session_id.to_string(),
            archive_sha256,
            archive_bytes: bytes.len() as u64,
            record_count,
            provider_event_count,
            initial_context_complete: title && context && prompt,
            terminal_marker_present: terminal,
            format_valid,
            durable_flush_proof,
        }))
    }
}

#[derive(Serialize)]
struct TaskConversationFrame<'a> {
    t: i64,
    kind: &'a str,
    payload: &'a serde_json::Value,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct TaskConversationArchivePrefix {
    sha256: String,
    bytes: u64,
    record_count: u32,
}

fn task_conversation_durable_flush_proof_line(
    route: &ActiveTaskConversation,
    summary: &TaskConversationFlushSummary,
    prefix: &TaskConversationArchivePrefix,
    occurred_at_ms: i64,
) -> Result<String, String> {
    let proof = TaskConversationDurableFlushProof {
        session_id: summary.session_id.clone(),
        task_id: route.identity.task_id.clone(),
        revision_id: route.identity.revision_id.clone(),
        revision_sha256: route.identity.revision_sha256.clone(),
        occurrence_id: route.identity.occurrence_id.clone(),
        attempt_id: route.identity.attempt_id.clone(),
        accepted_events: summary.accepted_events,
        dropped_events: summary.dropped_events,
        write_failed: summary.write_failed,
        prefix_sha256: prefix.sha256.clone(),
        prefix_bytes: prefix.bytes,
        prefix_record_count: prefix.record_count,
    };
    let line = serde_json::to_string(&serde_json::json!({
        "t": occurred_at_ms,
        "kind": "ui",
        "payload": {
            "_meta": {
                "tabId": summary.session_id.clone(),
                "kind": "task-run-durable-flush-proof-v1",
            },
            "sessionId": proof.session_id,
            "taskId": proof.task_id,
            "revisionId": proof.revision_id,
            "revisionSha256": proof.revision_sha256,
            "occurrenceId": proof.occurrence_id,
            "attemptId": proof.attempt_id,
            "acceptedEvents": proof.accepted_events,
            "droppedEvents": proof.dropped_events,
            "writeFailed": proof.write_failed,
            "prefixSha256": proof.prefix_sha256,
            "prefixBytes": proof.prefix_bytes,
            "prefixRecordCount": proof.prefix_record_count,
        }
    }))
    .map_err(|error| format!("serialize task conversation durable proof: {error}"))?;
    if line.len() > TASK_CONVERSATION_RECORD_MAX_BYTES {
        return Err("task conversation durable proof exceeds its record budget".to_string());
    }
    Ok(line)
}

fn task_conversation_durable_flush_proof_from_record(
    record: &serde_json::Value,
    session_id: &str,
    prefix: &[u8],
    prefix_record_count: u32,
) -> Option<TaskConversationDurableFlushProof> {
    let payload = record.get("payload")?.clone();
    let proof = serde_json::from_value::<TaskConversationDurableFlushProof>(payload).ok()?;
    if proof.session_id != session_id
        || proof.prefix_bytes != prefix.len() as u64
        || proof.prefix_record_count != prefix_record_count
        || proof.prefix_sha256 != format!("{:x}", Sha256::digest(prefix))
    {
        return None;
    }
    Some(proof)
}

fn task_conversation_archive_path(
    home: Option<&std::path::Path>,
    session_id: &str,
) -> Result<PathBuf, String> {
    match home {
        Some(home) => Ok(home
            .join(".shellx")
            .join("sessions")
            .join(format!("{session_id}.jsonl"))),
        None => crate::session_log::session_jsonl_path(session_id),
    }
}

fn task_conversation_open_archive(
    path: &std::path::Path,
    for_sync: bool,
) -> Result<std::fs::File, String> {
    let metadata = std::fs::symlink_metadata(path).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            "task conversation archive not found".to_string()
        } else {
            format!("inspect task conversation archive failed: {error}")
        }
    })?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("task conversation archive is not a regular file".to_string());
    }
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        // FlushFileBuffers requires GENERIC_WRITE. This existing-file open
        // neither truncates the archive nor creates a missing archive.
        options.write(for_sync).custom_flags(0x00200000); // FILE_FLAG_OPEN_REPARSE_POINT
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(nix::libc::O_NOFOLLOW | nix::libc::O_NONBLOCK);
    }
    #[cfg(not(windows))]
    let _ = for_sync;
    let file = options
        .open(path)
        .map_err(|error| format!("open task conversation archive failed: {error}"))?;
    let metadata = file.metadata().map_err(|error| error.to_string())?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("opened task conversation archive is not a regular file".into());
    }
    Ok(file)
}

fn task_conversation_path_stamp(
    path: &std::path::Path,
) -> Result<crate::session_log::FileStamp, String> {
    crate::session_log::file_stamp(&task_conversation_open_archive(path, false)?)
}

/// Read only a stable, regular archive through the opened file handle. The
/// `max_bytes + 1` take is the enforcement point: an attacker cannot turn a
/// metadata race into an unbounded allocation by swapping or extending the
/// pathname after the preliminary stat.
fn task_conversation_read_bounded_stable(
    path: &std::path::Path,
    max_bytes: u64,
    operation: &str,
) -> Result<Vec<u8>, String> {
    let before_path = task_conversation_path_stamp(path)?;
    if before_path.len() > max_bytes {
        return Err("task conversation archive exceeds its evidence budget".to_string());
    }
    let mut file = task_conversation_open_archive(path, false)?;
    let before_file = crate::session_log::file_stamp(&file)?;
    if crate::session_log::file_stamp_changed(&before_path, &before_file) {
        return Err(format!(
            "{operation}: task conversation archive changed before read"
        ));
    }
    if before_file.len() > max_bytes {
        return Err("task conversation archive exceeds its evidence budget".to_string());
    }
    let capacity = usize::try_from(before_file.len())
        .unwrap_or(usize::MAX)
        .min(usize::try_from(max_bytes).unwrap_or(usize::MAX));
    let mut bytes = Vec::with_capacity(capacity);
    let read_limit = max_bytes
        .checked_add(1)
        .ok_or_else(|| "task conversation evidence budget overflowed".to_string())?;
    file.by_ref()
        .take(read_limit)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("read task conversation failed: {error}"))?;
    if bytes.len() as u64 > max_bytes {
        return Err("task conversation archive exceeds its evidence budget".to_string());
    }
    let after_file = crate::session_log::file_stamp(&file)?;
    let after_path = task_conversation_path_stamp(path)?;
    if crate::session_log::file_stamp_changed(&before_file, &after_file)
        || crate::session_log::file_stamp_changed(&before_file, &after_path)
    {
        return Err(format!(
            "{operation}: task conversation archive changed during read"
        ));
    }
    if bytes.len() as u64 != after_file.len() {
        return Err(format!(
            "{operation}: task conversation archive changed during read"
        ));
    }
    Ok(bytes)
}

fn task_conversation_sync_and_prefix(
    home: Option<&std::path::Path>,
    session_id: &str,
) -> Result<TaskConversationArchivePrefix, String> {
    task_conversation_sync_archive(home, session_id)?;
    let path = task_conversation_archive_path(home, session_id)?;
    let bytes = task_conversation_read_bounded_stable(
        &path,
        TASK_CONVERSATION_EVIDENCE_MAX_BYTES,
        "inspect task conversation prefix",
    )?;
    let content = std::str::from_utf8(&bytes)
        .map_err(|_| "task conversation archive is not UTF-8".to_string())?;
    let mut record_count = 0_u32;
    for line in content.lines().filter(|line| !line.trim().is_empty()) {
        serde_json::from_str::<serde_json::Value>(line)
            .map_err(|_| "task conversation archive has malformed pre-proof JSONL".to_string())?;
        record_count = record_count.saturating_add(1);
    }
    Ok(TaskConversationArchivePrefix {
        sha256: format!("{:x}", Sha256::digest(&bytes)),
        bytes: bytes.len() as u64,
        record_count,
    })
}

fn task_conversation_sync_archive(
    home: Option<&std::path::Path>,
    session_id: &str,
) -> Result<(), String> {
    let path = task_conversation_archive_path(home, session_id)?;
    let before = task_conversation_path_stamp(&path)?;
    let file = task_conversation_open_archive(&path, true)?;
    let opened = crate::session_log::file_stamp(&file)?;
    if crate::session_log::file_stamp_changed(&before, &opened) {
        return Err("task conversation archive changed before sync".into());
    }
    file.sync_data()
        .map_err(|error| format!("sync task conversation archive failed: {error}"))?;
    if crate::session_log::file_stamp_changed(&opened, &task_conversation_path_stamp(&path)?) {
        return Err("task conversation archive changed during sync".into());
    }
    Ok(())
}

#[derive(Clone, Copy)]
struct TaskArchiveRedactionRule {
    id: &'static str,
    reason: &'static str,
}

#[derive(Clone, Copy)]
struct TaskArchiveBlockedStream {
    rule: TaskArchiveRedactionRule,
    awaiting_value: bool,
}

const TASK_ARCHIVE_POLICY_FIELD_VALUE: TaskArchiveRedactionRule = TaskArchiveRedactionRule {
    id: "sx.redaction.policy.task-field-value.v1",
    reason: "field value hidden by policy",
};
const TASK_ARCHIVE_POLICY_AUTHORIZATION: TaskArchiveRedactionRule = TaskArchiveRedactionRule {
    id: "sx.redaction.policy.authorization-header.v1",
    reason: "authorization header hidden by policy",
};
const TASK_ARCHIVE_POLICY_COOKIE: TaskArchiveRedactionRule = TaskArchiveRedactionRule {
    id: "sx.redaction.policy.cookie.v1",
    reason: "cookie hidden by policy",
};
const TASK_ARCHIVE_POLICY_PASSWORD_FIELD: TaskArchiveRedactionRule = TaskArchiveRedactionRule {
    id: "sx.redaction.policy.password-field.v1",
    reason: "password field hidden by policy",
};
const TASK_ARCHIVE_POLICY_TOKEN_FIELD: TaskArchiveRedactionRule = TaskArchiveRedactionRule {
    id: "sx.redaction.policy.token-field.v1",
    reason: "token field hidden by policy",
};
const TASK_ARCHIVE_POLICY_STREAM_CONTEXT: TaskArchiveRedactionRule = TaskArchiveRedactionRule {
    id: "sx.redaction.policy.provider-stream-context.v1",
    reason: "provider stream text hidden by policy",
};
const TASK_ARCHIVE_POSSIBLE_API_TOKEN: TaskArchiveRedactionRule = TaskArchiveRedactionRule {
    id: "sx.redaction.possible-api-token.v1",
    reason: "possible API token",
};
const TASK_ARCHIVE_POSSIBLE_PASSWORD: TaskArchiveRedactionRule = TaskArchiveRedactionRule {
    id: "sx.redaction.possible-password.v1",
    reason: "possible password",
};
const TASK_ARCHIVE_POSSIBLE_AUTHORIZATION: TaskArchiveRedactionRule = TaskArchiveRedactionRule {
    id: "sx.redaction.possible-authorization-secret.v1",
    reason: "possible authorization secret",
};
const TASK_ARCHIVE_POSSIBLE_SESSION_COOKIE: TaskArchiveRedactionRule = TaskArchiveRedactionRule {
    id: "sx.redaction.possible-session-cookie.v1",
    reason: "possible session cookie",
};
const TASK_ARCHIVE_POSSIBLE_CREDENTIAL: TaskArchiveRedactionRule = TaskArchiveRedactionRule {
    id: "sx.redaction.possible-credential.v1",
    reason: "possible credential",
};

fn scrub_task_archive_payload(mut payload: serde_json::Value) -> serde_json::Value {
    redact_task_archive_payload(&mut payload);
    payload
}

fn task_archive_redaction_marker(
    rule: TaskArchiveRedactionRule,
    scope: &str,
    original_bytes: usize,
) -> serde_json::Value {
    serde_json::json!({
        "redacted": true,
        "replacement": format!("[{}]", rule.reason),
        "reason": rule.reason,
        "ruleId": rule.id,
        "scope": scope,
        "originalBytes": original_bytes,
    })
}

fn task_archive_field_rule(key: &str) -> Option<TaskArchiveRedactionRule> {
    let normalized = key
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect::<String>();
    if normalized.contains("proxyauthorization") || normalized.contains("authorization") {
        Some(TASK_ARCHIVE_POLICY_AUTHORIZATION)
    } else if normalized.contains("cookie") {
        Some(TASK_ARCHIVE_POLICY_COOKIE)
    } else if normalized.contains("password") || normalized.contains("passwd") {
        Some(TASK_ARCHIVE_POLICY_PASSWORD_FIELD)
    } else if normalized.contains("apikey")
        || normalized.contains("accesstoken")
        || normalized.contains("refreshtoken")
        || normalized == "token"
        || normalized == "secret"
        || normalized == "credential"
    {
        Some(TASK_ARCHIVE_POLICY_TOKEN_FIELD)
    } else if normalized.ends_with("value")
        || normalized.ends_with("headers")
        || normalized.contains("requestbody")
        || normalized.contains("responsebody")
        || normalized.contains("postdata")
        || normalized.contains("formdata")
        || normalized.ends_with("payload")
        || normalized.contains("localstorage")
        || normalized.contains("sessionstorage")
    {
        Some(TASK_ARCHIVE_POLICY_FIELD_VALUE)
    } else {
        None
    }
}

fn task_archive_text_rule(text: &str) -> Option<TaskArchiveRedactionRule> {
    let lower = text.to_ascii_lowercase();
    if lower.contains("password=") || lower.contains("password:") || lower.contains("passwd=") {
        Some(TASK_ARCHIVE_POSSIBLE_PASSWORD)
    } else if lower.contains("authorization:")
        || lower.contains("proxy-authorization:")
        || lower.contains("bearer ")
    {
        Some(TASK_ARCHIVE_POSSIBLE_AUTHORIZATION)
    } else if lower.contains("cookie:") || lower.contains("set-cookie:") {
        Some(TASK_ARCHIVE_POSSIBLE_SESSION_COOKIE)
    } else if lower.contains("api_key")
        || lower.contains("api-key")
        || lower.contains("access_token")
        || lower.contains("refresh_token")
        || task_archive_text_has_api_token_prefix(&lower, "sk-")
    {
        Some(TASK_ARCHIVE_POSSIBLE_API_TOKEN)
    } else if crate::host_mcp::redact_if_credential_pattern(text) {
        Some(TASK_ARCHIVE_POSSIBLE_CREDENTIAL)
    } else {
        None
    }
}

fn is_task_archive_redaction_marker(value: &serde_json::Value) -> bool {
    let Some(marker) = value.as_object() else {
        return false;
    };
    if marker.len() != 6
        || marker.get("redacted").and_then(serde_json::Value::as_bool) != Some(true)
    {
        return false;
    }
    let Some(scope @ ("field" | "providerFrameText")) =
        marker.get("scope").and_then(serde_json::Value::as_str)
    else {
        return false;
    };
    let Some(original_bytes) = marker
        .get("originalBytes")
        .and_then(serde_json::Value::as_u64)
    else {
        return false;
    };
    if original_bytes > TASK_CONVERSATION_RECORD_MAX_BYTES as u64 {
        return false;
    }
    // Provider objects can contain arbitrary fields. Only our complete,
    // output-free marker shape may bypass recursive redaction.
    [
        TASK_ARCHIVE_POLICY_FIELD_VALUE,
        TASK_ARCHIVE_POLICY_AUTHORIZATION,
        TASK_ARCHIVE_POLICY_COOKIE,
        TASK_ARCHIVE_POLICY_PASSWORD_FIELD,
        TASK_ARCHIVE_POLICY_TOKEN_FIELD,
        TASK_ARCHIVE_POLICY_STREAM_CONTEXT,
        TASK_ARCHIVE_POSSIBLE_API_TOKEN,
        TASK_ARCHIVE_POSSIBLE_PASSWORD,
        TASK_ARCHIVE_POSSIBLE_AUTHORIZATION,
        TASK_ARCHIVE_POSSIBLE_SESSION_COOKIE,
        TASK_ARCHIVE_POSSIBLE_CREDENTIAL,
    ]
    .into_iter()
    .any(|rule| {
        marker.get("ruleId").and_then(serde_json::Value::as_str) == Some(rule.id)
            && *value == task_archive_redaction_marker(rule, scope, original_bytes as usize)
    })
}

fn redact_task_archive_payload(value: &mut serde_json::Value) {
    if is_task_archive_redaction_marker(value) {
        return;
    }
    if value.is_string() {
        let serde_json::Value::String(text) = value.take() else {
            unreachable!("checked task archive string value");
        };
        *value = task_archive_text_rule(&text)
            .map(|rule| task_archive_redaction_marker(rule, "providerFrameText", text.len()))
            .unwrap_or(serde_json::Value::String(text));
        return;
    }
    match value {
        serde_json::Value::Object(map) => {
            for (key, child) in map.iter_mut() {
                if let Some(rule) = task_archive_field_rule(key) {
                    *child = task_archive_redaction_marker(rule, "field", child.to_string().len());
                } else {
                    redact_task_archive_payload(child);
                }
            }
        }
        serde_json::Value::Array(values) => {
            for child in values {
                redact_task_archive_payload(child);
            }
        }
        _ => {}
    }
}

fn task_archive_pending_text_contexts(
    pending: &VecDeque<TaskConversationBufferedEvent>,
) -> BTreeMap<String, TaskArchiveStreamContext> {
    let mut contexts = BTreeMap::new();
    for event in pending {
        task_archive_collect_text_values(&event.payload, &mut contexts);
    }
    contexts
}

fn task_archive_collect_text_values(
    value: &serde_json::Value,
    contexts: &mut BTreeMap<String, TaskArchiveStreamContext>,
) {
    if is_task_archive_redaction_marker(value) {
        return;
    }
    match value {
        serde_json::Value::Object(map) => {
            for (key, child) in map {
                // Archive routing metadata is structural, not provider text.
                if key == "_meta" {
                    continue;
                }
                if let Some(stream_context) = task_archive_stream_text_context_for_key(key) {
                    task_archive_collect_stream_text_value(child, stream_context, contexts);
                } else {
                    task_archive_collect_text_values(child, contexts);
                }
            }
        }
        serde_json::Value::Array(values) => {
            for child in values {
                task_archive_collect_text_values(child, contexts);
            }
        }
        _ => {}
    }
}

/// Only values whose field names are provider-facing content are joined across
/// frames. Run IDs, enum names, and other structural strings must not turn a
/// normal conversation into an unresolved lexical tail.
fn task_archive_stream_text_context_for_key(key: &str) -> Option<&'static str> {
    let normalized = key
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect::<String>();
    match normalized.as_str() {
        "text" | "message" | "content" | "delta" | "output" => Some("providerText"),
        "error" | "stderr" | "stdout" | "detail" => Some("providerDiagnostic"),
        _ => None,
    }
}

fn task_archive_collect_stream_text_value(
    value: &serde_json::Value,
    stream_context: &str,
    contexts: &mut BTreeMap<String, TaskArchiveStreamContext>,
) {
    if is_task_archive_redaction_marker(value) {
        return;
    }
    match value {
        serde_json::Value::String(text) => {
            let context = contexts.entry(stream_context.to_string()).or_default();
            if context.overflowed {
                return;
            }
            if context.text.len().saturating_add(text.len())
                <= TASK_CONVERSATION_STREAM_CONTEXT_MAX_BYTES
            {
                context.text.push_str(text);
            } else {
                // The pending-byte guard will turn this unresolved sequence into
                // a policy marker before any of the omitted text is persisted.
                context.overflowed = true;
            }
        }
        serde_json::Value::Array(values) => {
            for child in values {
                task_archive_collect_stream_text_value(child, stream_context, contexts);
            }
        }
        serde_json::Value::Object(map) => {
            for child in map.values() {
                task_archive_collect_stream_text_value(child, stream_context, contexts);
            }
        }
        _ => {}
    }
}

fn task_archive_redact_stream_text_context(
    value: &mut serde_json::Value,
    target_context: &str,
    rule: TaskArchiveRedactionRule,
) -> bool {
    if is_task_archive_redaction_marker(value) {
        return false;
    }
    match value {
        serde_json::Value::Object(map) => {
            let mut redacted = false;
            for (key, child) in map.iter_mut() {
                if key == "_meta" {
                    continue;
                }
                if task_archive_stream_text_context_for_key(key) == Some(target_context) {
                    redacted |= task_archive_redact_stream_text_value(child, rule);
                } else {
                    redacted |=
                        task_archive_redact_stream_text_context(child, target_context, rule);
                }
            }
            redacted
        }
        serde_json::Value::Array(values) => {
            let mut redacted = false;
            for child in values {
                redacted |= task_archive_redact_stream_text_context(child, target_context, rule);
            }
            redacted
        }
        _ => false,
    }
}

fn task_archive_redact_stream_text_value(
    value: &mut serde_json::Value,
    rule: TaskArchiveRedactionRule,
) -> bool {
    if is_task_archive_redaction_marker(value) {
        return false;
    }
    if value.is_string() {
        let serde_json::Value::String(text) = value.take() else {
            unreachable!("checked matching provider stream text value");
        };
        *value = task_archive_redaction_marker(rule, "providerFrameText", text.len());
        return true;
    }
    match value {
        serde_json::Value::Object(map) => {
            let mut redacted = false;
            for (key, child) in map.iter_mut() {
                if key != "_meta" {
                    redacted |= task_archive_redact_stream_text_value(child, rule);
                }
            }
            redacted
        }
        serde_json::Value::Array(values) => {
            let mut redacted = false;
            for child in values {
                redacted |= task_archive_redact_stream_text_value(child, rule);
            }
            redacted
        }
        _ => false,
    }
}

fn task_archive_stream_context_completes_block(
    value: &serde_json::Value,
    target_context: &str,
    awaiting_value: bool,
) -> bool {
    if is_task_archive_redaction_marker(value) {
        return false;
    }
    match value {
        serde_json::Value::Object(map) => map.iter().any(|(key, child)| {
            key != "_meta"
                && if task_archive_stream_text_context_for_key(key) == Some(target_context) {
                    task_archive_stream_text_value_completes_block(child, awaiting_value)
                } else {
                    task_archive_stream_context_completes_block(
                        child,
                        target_context,
                        awaiting_value,
                    )
                }
        }),
        serde_json::Value::Array(values) => values.iter().any(|child| {
            task_archive_stream_context_completes_block(child, target_context, awaiting_value)
        }),
        _ => false,
    }
}

fn task_archive_stream_text_value_completes_block(
    value: &serde_json::Value,
    awaiting_value: bool,
) -> bool {
    match value {
        serde_json::Value::Object(map) => {
            map.iter()
                .filter(|(key, _)| *key != "_meta")
                .any(|(_, child)| {
                    task_archive_stream_text_value_completes_block(child, awaiting_value)
                })
        }
        serde_json::Value::Array(values) => values
            .iter()
            .any(|child| task_archive_stream_text_value_completes_block(child, awaiting_value)),
        serde_json::Value::String(text) => {
            (!awaiting_value || task_archive_stream_text_has_value(text))
                && task_archive_text_ends_at_boundary(text)
        }
        _ => false,
    }
}

fn task_archive_text_ends_at_boundary(text: &str) -> bool {
    text.chars().last().is_some_and(|character| {
        character.is_whitespace()
            || matches!(character, '"' | '\'' | ',' | ';' | '(' | ')' | '<' | '>')
    })
}

fn task_archive_stream_text_has_value(text: &str) -> bool {
    let lower = text.trim_start().to_ascii_lowercase();
    let Some(after_bearer) = lower.strip_prefix("bearer") else {
        return lower.chars().any(|character| !character.is_whitespace());
    };
    after_bearer
        .trim_start_matches([':', '='])
        .trim()
        .chars()
        .next()
        .is_some()
}

fn task_archive_has_known_secret_prefix_suffix(text: &str) -> bool {
    const PREFIXES: &[&str] = &[
        "authorization: bearer ",
        "authorization:bearer ",
        "authorization=bearer ",
        "bearer ey",
        "x-api-key:",
        "x-api-key=",
        "api_key=",
        "apikey=",
        "api-key=",
        "access_token=",
        "refresh_token=",
        "password=",
        "client_secret=",
        "aws_secret_access_key=",
        "github_pat_",
        "ghp_",
        "xai-",
        "fc-",
        "sk_live_",
        "sk_test_",
        "sk-",
        "xoxb-",
        "glpat-",
        "shpat_",
        "sg.",
        "akia",
        "aiza",
        "ya29.",
    ];
    let lower = text.to_ascii_lowercase();
    // Single-character matches turn ordinary prose (for example, a sentence
    // ending in `r`) into an unresolved stream because several credential
    // prefixes start with common letters. Identifier-like tails are already
    // retained while a stream is live; the explicit `sk` case keeps the
    // short API-key prefix fail-closed at end-of-stream.
    if lower.ends_with("sk") && task_archive_suffix_starts_at_token_boundary(&lower, "sk") {
        return true;
    }
    PREFIXES.iter().any(|prefix| {
        let minimum_prefix_bytes = 3.min(prefix.len());
        (minimum_prefix_bytes..=prefix.len()).any(|length| {
            let prefix_fragment = &prefix[..length];
            lower.ends_with(prefix_fragment)
                && (*prefix != "sk-"
                    || task_archive_suffix_starts_at_token_boundary(&lower, prefix_fragment))
        })
    })
}

fn task_archive_text_has_api_token_prefix(text: &str, prefix: &str) -> bool {
    text.match_indices(prefix).any(|(offset, _)| {
        task_archive_suffix_starts_at_token_boundary(&text[..offset + prefix.len()], prefix)
            && text[offset + prefix.len()..]
                .chars()
                .next()
                .is_some_and(|character| character.is_ascii_alphanumeric())
    })
}

fn task_archive_suffix_starts_at_token_boundary(text: &str, suffix: &str) -> bool {
    let Some(offset) = text.len().checked_sub(suffix.len()) else {
        return false;
    };
    text.ends_with(suffix)
        && (offset == 0
            || text[..offset]
                .chars()
                .last()
                .is_some_and(|character| !character.is_ascii_alphanumeric()))
}

fn task_archive_has_unresolved_token_tail(text: &str) -> bool {
    text.chars().last().is_some_and(|character| {
        character.is_ascii_alphanumeric() || matches!(character, '_' | '-' | '=' | '+' | '/')
    })
}

fn redact_task_archive_stream_text_values(value: &mut serde_json::Value) {
    if is_task_archive_redaction_marker(value) {
        return;
    }
    match value {
        serde_json::Value::Object(map) => {
            for (key, child) in map.iter_mut() {
                if key == "_meta" {
                    continue;
                }
                if task_archive_stream_text_context_for_key(key).is_some() {
                    task_archive_redact_stream_text_value(
                        child,
                        TASK_ARCHIVE_POLICY_STREAM_CONTEXT,
                    );
                } else {
                    redact_task_archive_stream_text_values(child);
                }
            }
        }
        serde_json::Value::Array(values) => {
            for child in values {
                redact_task_archive_stream_text_values(child);
            }
        }
        _ => {}
    }
}

fn task_conversation_budget_marker(tab_id: &str, occurred_at_ms: i64) -> String {
    serde_json::to_string(&serde_json::json!({
        "t": occurred_at_ms,
        "kind": "ui",
        "payload": {
            "_meta": { "tabId": tab_id, "kind": "task-run-truncated" },
            "text": "Task conversation archive reached its 64 MiB evidence budget. Later provider events were not retained.",
        }
    }))
    .expect("fixed Task conversation budget marker serializes")
}

fn task_conversation_existing_bytes(
    home: Option<&std::path::Path>,
    session_id: &str,
) -> Result<u64, String> {
    let path = match home {
        Some(home) => home
            .join(".shellx")
            .join("sessions")
            .join(format!("{session_id}.jsonl")),
        None => crate::session_log::session_jsonl_path(session_id)?,
    };
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
            Err("task conversation archive is not a regular file".to_string())
        }
        Ok(metadata) => Ok(metadata.len()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(0),
        Err(error) => Err(format!("inspect task conversation archive failed: {error}")),
    }
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
