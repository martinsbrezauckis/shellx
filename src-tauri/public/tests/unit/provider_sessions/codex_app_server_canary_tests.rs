use std::collections::BTreeMap;
use std::time::Instant;

const CANARY_EVENT_LIMIT: usize = 48;

// Each field is retained only in the bounded, redacted `Debug` failure evidence.
// Rust's dead-code lint intentionally does not count the derived formatter as a read.
#[derive(Clone, Debug)]
#[allow(dead_code)]
struct CanaryEventMetadata {
    elapsed_ms: u64,
    kind: &'static str,
    method: &'static str,
    status: &'static str,
    error_category: &'static str,
}

#[derive(Clone, Debug)]
struct CanaryProtocolEventMetadata {
    // Retained in bounded, redacted `Debug` failure evidence; derived formatting is
    // intentionally invisible to Rust's dead-code lint.
    #[allow(dead_code)]
    elapsed_ms: u64,
    message_kind: &'static str,
    method: &'static str,
    response_id: &'static str,
    rpc_error_code: Option<i64>,
}

#[derive(Clone, Debug, Default)]
struct CanaryProtocolSnapshot {
    line_count: u32,
    dropped_line_count: u32,
    retained_method_counts: BTreeMap<&'static str, u32>,
    events: Vec<CanaryProtocolEventMetadata>,
}

#[derive(Clone, Debug)]
struct CanaryDiagnosticsSnapshot {
    marker_seen: bool,
    event_count: u32,
    dropped_event_count: u32,
    method_counts: BTreeMap<&'static str, u32>,
    events: Vec<CanaryEventMetadata>,
}

struct CanaryDiagnostics {
    started_at: Instant,
    marker_seen: bool,
    marker_tail: String,
    event_count: u32,
    dropped_event_count: u32,
    method_counts: BTreeMap<&'static str, u32>,
    events: Vec<CanaryEventMetadata>,
}

struct CanaryProtocolTrace {
    started_at: Instant,
    snapshot: CanaryProtocolSnapshot,
}

impl CanaryDiagnostics {
    fn new() -> Self {
        Self {
            started_at: Instant::now(),
            marker_seen: false,
            marker_tail: String::new(),
            event_count: 0,
            dropped_event_count: 0,
            method_counts: BTreeMap::new(),
            events: Vec::new(),
        }
    }

    fn observe(&mut self, payload: &serde_json::Value, marker: &str) {
        self.event_count = self.event_count.saturating_add(1);
        if let Some(text) = payload.get("text").and_then(serde_json::Value::as_str) {
            self.marker_seen |= marker_seen_across_text(marker, &self.marker_tail, text);
            retain_marker_tail(&mut self.marker_tail, text, marker.len().saturating_sub(1));
        }

        let method = canary_method(payload.get("rawType").and_then(serde_json::Value::as_str));
        let method_count = self.method_counts.entry(method).or_default();
        *method_count = method_count.saturating_add(1);
        if self.events.len() == CANARY_EVENT_LIMIT {
            self.dropped_event_count = self.dropped_event_count.saturating_add(1);
            return;
        }
        self.events.push(CanaryEventMetadata {
            elapsed_ms: self.started_at.elapsed().as_millis() as u64,
            kind: canary_kind(payload.get("kind").and_then(serde_json::Value::as_str)),
            method,
            status: canary_status(payload.get("status").and_then(serde_json::Value::as_str)),
            error_category: canary_error_category(
                payload.get("error").and_then(serde_json::Value::as_str),
            ),
        });
    }

    fn snapshot(&self) -> CanaryDiagnosticsSnapshot {
        CanaryDiagnosticsSnapshot {
            marker_seen: self.marker_seen,
            event_count: self.event_count,
            dropped_event_count: self.dropped_event_count,
            method_counts: self.method_counts.clone(),
            events: self.events.clone(),
        }
    }
}

impl CanaryProtocolTrace {
    fn new() -> Self {
        Self {
            started_at: Instant::now(),
            snapshot: CanaryProtocolSnapshot::default(),
        }
    }

    fn observe(&mut self, line: &str) {
        self.snapshot.line_count = self.snapshot.line_count.saturating_add(1);
        if self.snapshot.events.len() == CANARY_EVENT_LIMIT {
            self.snapshot.dropped_line_count = self.snapshot.dropped_line_count.saturating_add(1);
            return;
        }
        let metadata =
            canary_protocol_event_metadata(line, self.started_at.elapsed().as_millis() as u64);
        let method_count = self
            .snapshot
            .retained_method_counts
            .entry(metadata.method)
            .or_default();
        *method_count = method_count.saturating_add(1);
        self.snapshot.events.push(metadata);
    }
}

fn canary_protocol_event_metadata(line: &str, elapsed_ms: u64) -> CanaryProtocolEventMetadata {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(line.trim()) else {
        return CanaryProtocolEventMetadata {
            elapsed_ms,
            message_kind: "invalid-json",
            method: "none",
            response_id: "none",
            rpc_error_code: None,
        };
    };
    let Some(object) = value.as_object() else {
        return CanaryProtocolEventMetadata {
            elapsed_ms,
            message_kind: "non-object",
            method: "none",
            response_id: "none",
            rpc_error_code: None,
        };
    };
    let method = canary_method(object.get("method").and_then(serde_json::Value::as_str));
    let response_id = canary_response_id(object.get("id"));
    let has_id = object.contains_key("id");
    let has_method = object.contains_key("method");
    let rpc_error_code = object
        .get("error")
        .and_then(|error| error.get("code"))
        .and_then(serde_json::Value::as_i64);
    CanaryProtocolEventMetadata {
        elapsed_ms,
        message_kind: match (has_id, has_method) {
            (true, true) => "request",
            (true, false) => "response",
            (false, true) => "notification",
            (false, false) => "unclassified",
        },
        method,
        response_id,
        rpc_error_code,
    }
}

fn canary_response_id(value: Option<&serde_json::Value>) -> &'static str {
    match value.and_then(serde_json::Value::as_i64) {
        Some(1) => "initialize",
        Some(2) => "thread",
        Some(3) => "turn",
        Some(_) => "other",
        None => "none",
    }
}

fn marker_seen_across_text(marker: &str, previous_tail: &str, text: &str) -> bool {
    if marker.is_empty() || text.contains(marker) {
        return true;
    }
    (1..marker.len()).any(|split| {
        previous_tail.ends_with(&marker[..split]) && text.starts_with(&marker[split..])
    })
}

fn retain_marker_tail(tail: &mut String, text: &str, limit: usize) {
    if limit == 0 {
        tail.clear();
        return;
    }
    if text.len() >= limit {
        let mut start = text.len() - limit;
        while start < text.len() && !text.is_char_boundary(start) {
            start += 1;
        }
        tail.clear();
        tail.push_str(&text[start..]);
        return;
    }

    tail.push_str(text);
    if tail.len() > limit {
        let mut start = tail.len() - limit;
        while start < tail.len() && !tail.is_char_boundary(start) {
            start += 1;
        }
        tail.drain(..start);
    }
}

fn canary_kind(value: Option<&str>) -> &'static str {
    match value {
        Some("started") => "started",
        Some("text") => "text",
        Some("textDelta") => "textDelta",
        Some("thinking") => "thinking",
        Some("tool") => "tool",
        Some("command") => "command",
        Some("fileChange") => "fileChange",
        Some("mcpTool") => "mcpTool",
        Some("subagent") => "subagent",
        Some("raw") => "raw",
        Some("completed") => "completed",
        Some("failed") => "failed",
        Some("aborted") => "aborted",
        _ => "other",
    }
}

fn canary_method(value: Option<&str>) -> &'static str {
    match value {
        Some("terminal") => "terminal",
        Some("spawn") => "spawn",
        Some("setup-stdin") => "setup-stdin",
        Some("supervisor") => "supervisor",
        Some("stderr") => "stderr",
        Some("item/agentMessage/delta") => "item/agentMessage/delta",
        Some("item/reasoning/textDelta") => "item/reasoning/textDelta",
        Some("item/reasoning/summaryTextDelta") => "item/reasoning/summaryTextDelta",
        Some("item/plan/delta") => "item/plan/delta",
        Some("item/started") => "item/started",
        Some("item/completed") => "item/completed",
        Some("turn/completed") => "turn/completed",
        Some("thread/tokenUsage/updated") => "thread/tokenUsage/updated",
        Some("item/commandExecution/requestApproval") => "item/commandExecution/requestApproval",
        Some("item/fileChange/requestApproval") => "item/fileChange/requestApproval",
        Some("item/permissions/requestApproval") => "item/permissions/requestApproval",
        Some("execCommandApproval") => "execCommandApproval",
        Some("applyPatchApproval") => "applyPatchApproval",
        Some(_) => "other",
        None => "none",
    }
}

fn canary_status(value: Option<&str>) -> &'static str {
    match value {
        Some("started") => "started",
        Some("streaming") => "streaming",
        Some("waitingForApproval") => "waitingForApproval",
        Some("completed") => "completed",
        Some("failed") => "failed",
        Some("aborted") => "aborted",
        Some(_) => "other",
        None => "none",
    }
}

fn canary_error_category(value: Option<&str>) -> &'static str {
    let Some(value) = value else {
        return "none";
    };
    if value.starts_with("timeout after ") {
        "supervisor-timeout"
    } else if value.starts_with("spawn ") {
        "spawn"
    } else if value.starts_with("provider setup stdin ") {
        "setup-stdin"
    } else if value.starts_with("invalid Codex app-server JSONL") {
        "protocol-invalid-jsonl"
    } else if value.starts_with("unexpected Codex app-server response") {
        "protocol-unexpected-response"
    } else if value.starts_with("unsupported Codex app-server request") {
        "protocol-unsupported-request"
    } else if value.starts_with("Codex turn ") {
        "turn-noncompleted"
    } else if value == "aborted" {
        "aborted"
    } else {
        "other"
    }
}

#[test]
fn canary_diagnostics_bound_and_redact_captured_provider_values() {
    let mut diagnostics = CanaryDiagnostics::new();
    let marker = "SHELLX_APP_SERVER_OK";
    diagnostics.observe(
        &serde_json::json!({
            "kind": "textDelta",
            "rawType": "item/agentMessage/delta",
            "status": "streaming",
            "text": "SHELLX_APP_SERVER_",
            "error": "provider-error-that-must-not-appear"
        }),
        marker,
    );
    assert!(!diagnostics.marker_seen);
    diagnostics.observe(
        &serde_json::json!({
            "kind": "textDelta",
            "rawType": "item/agentMessage/delta",
            "status": "streaming",
            "text": "OK provider-text-that-must-not-appear"
        }),
        marker,
    );
    for _ in 0..CANARY_EVENT_LIMIT {
        diagnostics.observe(
            &serde_json::json!({
                "kind": "raw",
                "rawType": "unrecognized/provider-method",
                "error": "unrecognized-provider-error"
            }),
            marker,
        );
    }

    let snapshot = diagnostics.snapshot();
    let rendered = format!("{snapshot:?}");
    assert!(snapshot.marker_seen);
    assert_eq!(snapshot.event_count as usize, CANARY_EVENT_LIMIT + 2);
    assert_eq!(snapshot.events.len(), CANARY_EVENT_LIMIT);
    assert_eq!(snapshot.dropped_event_count, 2);
    assert_eq!(
        snapshot.method_counts.get("item/agentMessage/delta"),
        Some(&2)
    );
    assert_eq!(
        snapshot.method_counts.get("other"),
        Some(&(CANARY_EVENT_LIMIT as u32))
    );
    assert!(!rendered.contains("provider-text-that-must-not-appear"));
    assert!(!rendered.contains("provider-error-that-must-not-appear"));
    assert!(!rendered.contains("unrecognized-provider-error"));
}

#[test]
fn canary_protocol_metadata_bounds_and_redacts_jsonl_values() {
    let mut trace = CanaryProtocolTrace::new();
    trace.observe(r#"{"id":1,"result":{"unretained":"provider-value-that-must-not-appear"}}"#);
    trace.observe(r#"{"id":"provider-id-that-must-not-appear","method":"unrecognized/provider-method","params":{"prompt":"prompt-that-must-not-appear"}}"#);
    trace.observe(
        r#"{"id":3,"error":{"code":-32001,"message":"provider-error-that-must-not-appear"}}"#,
    );
    for _ in 0..CANARY_EVENT_LIMIT {
        trace.observe(
            r#"{"method":"item/started","params":{"value":"provider-tail-that-must-not-appear"}}"#,
        );
    }

    let snapshot = trace.snapshot;
    let rendered = format!("{snapshot:?}");
    assert_eq!(snapshot.line_count as usize, CANARY_EVENT_LIMIT + 3);
    assert_eq!(snapshot.events.len(), CANARY_EVENT_LIMIT);
    assert_eq!(snapshot.dropped_line_count, 3);
    assert_eq!(
        snapshot.retained_method_counts.get("item/started"),
        Some(&((CANARY_EVENT_LIMIT - 3) as u32))
    );
    assert_eq!(snapshot.events[0].message_kind, "response");
    assert_eq!(snapshot.events[0].response_id, "initialize");
    assert_eq!(snapshot.events[1].message_kind, "request");
    assert_eq!(snapshot.events[1].method, "other");
    assert_eq!(snapshot.events[2].response_id, "turn");
    assert_eq!(snapshot.events[2].rpc_error_code, Some(-32001));
    assert!(!rendered.contains("provider-value-that-must-not-appear"));
    assert!(!rendered.contains("provider-id-that-must-not-appear"));
    assert!(!rendered.contains("prompt-that-must-not-appear"));
    assert!(!rendered.contains("provider-error-that-must-not-appear"));
    assert!(!rendered.contains("provider-tail-that-must-not-appear"));
}
