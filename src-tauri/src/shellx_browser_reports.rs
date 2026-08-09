use serde_json::json;

use crate::shellx_browser::{
    browser_id, clean_string, lock_or_recover, next_browser_evidence_sequence, now_ms,
    push_receipt, BrowserConsoleLogEntry, BrowserConsoleLogRequest, BrowserReportRequest,
    BrowserReportResponse, ShellxBrowserRegistry,
};
use crate::shellx_browser_caller::{
    ensure_browser_task_control_authority, BrowserTaskControlAuthority,
};
use crate::shellx_browser_tasks::find_task_index;

impl ShellxBrowserRegistry {
    pub fn console_logs(&self, limit: Option<usize>) -> Vec<BrowserConsoleLogEntry> {
        let mut logs = lock_or_recover(&self.state).console_logs.clone();
        logs.sort_by_key(|entry| entry.t);
        logs.reverse();
        logs.truncate(limit.unwrap_or(200).min(1000));
        logs
    }

    pub fn record_console_log(
        &self,
        request: BrowserConsoleLogRequest,
    ) -> Result<BrowserConsoleLogEntry, String> {
        self.record_console_log_inner(request, true, None)
    }

    pub(crate) fn record_agent_console_log(
        &self,
        mut request: BrowserConsoleLogRequest,
        caller_session_id: &str,
    ) -> Result<BrowserConsoleLogEntry, String> {
        let task_id = request
            .task_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| "agent-reported browser logs require taskId".to_string())?;
        {
            let state = lock_or_recover(&self.state);
            let task_idx = find_task_index(&state, task_id)?;
            ensure_browser_task_control_authority(
                &state.tasks[task_idx],
                BrowserTaskControlAuthority::Agent,
                Some(caller_session_id),
            )?;
        }
        request.source = Some("agent-reported".to_string());
        self.record_console_log_inner(request, false, Some("agent-reported"))
    }

    pub(crate) fn record_operator_ui_console_log(
        &self,
        mut request: BrowserConsoleLogRequest,
    ) -> Result<BrowserConsoleLogEntry, String> {
        // The desktop renderer has no MCP caller session. Keep its diagnostics
        // detached from task Flight Recorder evidence so bearer clients cannot
        // gain operator task authority by omitting the caller header.
        request.task_id = None;
        request.source = Some("shellx-browser-ui".to_string());
        self.record_console_log_inner(request, false, Some("shellx-browser-ui"))
    }

    fn record_console_log_inner(
        &self,
        request: BrowserConsoleLogRequest,
        use_active_task_fallback: bool,
        forced_source: Option<&str>,
    ) -> Result<BrowserConsoleLogEntry, String> {
        let message = sanitize_console_message(&request.message);
        if message.is_empty() {
            return Err("browser console log message is required".to_string());
        }
        let level = normalize_console_level(&request.level);
        let source = forced_source
            .or(request.source.as_deref())
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("browser-runtime")
            .chars()
            .take(80)
            .collect::<String>();
        let mut state = lock_or_recover(&self.state);
        let task_id = match request.task_id.as_deref().map(str::trim) {
            Some(value) if !value.is_empty() => {
                find_task_index(&state, value)?;
                Some(value.to_string())
            }
            _ if use_active_task_fallback => state.active_task_id.clone(),
            _ => None,
        };
        let profile_id = task_id
            .as_deref()
            .and_then(|id| state.tasks.iter().find(|task| task.task_id == id))
            .map(|task| task.profile_id.clone());
        let entry = BrowserConsoleLogEntry {
            log_id: browser_id("browser-log"),
            task_id: task_id.clone(),
            profile_id: profile_id.clone(),
            level: level.clone(),
            source,
            message,
            url: request
                .url
                .map(clean_string)
                .filter(|value| !value.is_empty()),
            line: request.line,
            column: request.column,
            t: now_ms(),
            sequence: next_browser_evidence_sequence(&mut state),
            details: sanitize_console_details(request.details),
        };
        state.console_logs.push(entry.clone());
        if state.console_logs.len() > 1000 {
            let overflow = state.console_logs.len() - 1000;
            let dropped_task_ids = state
                .console_logs
                .drain(0..overflow)
                .filter_map(|entry| entry.task_id)
                .collect::<Vec<_>>();
            state.console_log_retention_dropped = state
                .console_log_retention_dropped
                .saturating_add(overflow as u64);
            for task_id in dropped_task_ids {
                if let Some(task) = state.tasks.iter_mut().find(|task| task.task_id == task_id) {
                    task.retention_dropped_console_events =
                        task.retention_dropped_console_events.saturating_add(1);
                }
            }
        }
        let receipt_kind = if level == "error" {
            "browserConsoleError"
        } else {
            "browserConsoleLog"
        };
        push_receipt(
            &mut state,
            receipt_kind,
            task_id,
            profile_id,
            format!("Browser console {}: {}", level, entry.message),
            json!({
                "logId": entry.log_id,
                "level": entry.level,
                "source": entry.source,
                "url": entry.url,
                "line": entry.line,
                "column": entry.column,
            }),
        );
        Ok(entry)
    }

    pub fn write_report(
        &self,
        request: BrowserReportRequest,
    ) -> Result<BrowserReportResponse, String> {
        let title = clean_string(request.title);
        if title.is_empty() {
            return Err("browser report title is required".to_string());
        }
        let mut state = lock_or_recover(&self.state);
        let report_id = browser_id("browser-report");
        let receipt = push_receipt(
            &mut state,
            "browserReportWritten",
            request.task_id,
            None,
            format!("Browser report written: {}", title),
            json!({
                "reportId": report_id,
                "title": title,
                "bodyBytes": request.body.len(),
            }),
        );
        Ok(BrowserReportResponse {
            report_id,
            title,
            receipt,
        })
    }
}

fn normalize_console_level(level: &str) -> String {
    match level.trim().to_ascii_lowercase().as_str() {
        "error" | "warn" | "warning" | "info" | "debug" | "trace" => {
            if level.trim().eq_ignore_ascii_case("warning") {
                "warn".to_string()
            } else {
                level.trim().to_ascii_lowercase()
            }
        }
        _ => "info".to_string(),
    }
}

fn sanitize_console_message(message: &str) -> String {
    let lines = message
        .lines()
        .take(40)
        .map(|line| {
            let trimmed = line.trim_end();
            if crate::host_mcp::redact_if_credential_pattern(trimmed) {
                "<redacted: credential-shaped console log>".to_string()
            } else {
                trimmed.chars().take(400).collect::<String>()
            }
        })
        .collect::<Vec<_>>();
    let joined = lines.join("\n");
    joined
        .chars()
        .take(4000)
        .collect::<String>()
        .trim()
        .to_string()
}

fn sanitize_console_details(details: Option<serde_json::Value>) -> serde_json::Value {
    let mut details = details.unwrap_or_else(|| json!({}));
    crate::mcp_http::scrub_credentials(&mut details);
    let Ok(serialized) = serde_json::to_string(&details) else {
        return json!({ "unserializable": true });
    };
    if serialized.len() > 8192 {
        json!({
            "truncated": true,
            "bytes": serialized.len(),
        })
    } else {
        details
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shellx_browser::StartBrowserTaskRequest;
    use crate::shellx_browser_tasks::BROWSER_TASK_OWNER_CONTROL_REQUIRED;

    fn agent_owned_task(registry: &ShellxBrowserRegistry) -> String {
        registry
            .start_task_for_agent_session(
                StartBrowserTaskRequest {
                    goal: "Test Browser log ownership".to_string(),
                    start_url: Some("https://example.test".to_string()),
                    profile_id: Some("agent-work".to_string()),
                    ..StartBrowserTaskRequest::default()
                },
                Some("session-a"),
            )
            .expect("start agent-owned task")
            .task_id
    }

    #[test]
    fn agent_reported_logs_are_owned_and_cannot_spoof_runtime_source() {
        let registry = ShellxBrowserRegistry::default();
        let task_id = agent_owned_task(&registry);
        let request = BrowserConsoleLogRequest {
            task_id: Some(task_id.clone()),
            level: "info".to_string(),
            source: Some("browser-runtime".to_string()),
            message: "Agent diagnostic".to_string(),
            ..BrowserConsoleLogRequest::default()
        };

        let denied = registry
            .record_agent_console_log(request.clone(), "session-b")
            .expect_err("another caller session must not inject task evidence");
        assert!(denied.contains(BROWSER_TASK_OWNER_CONTROL_REQUIRED));

        let entry = registry
            .record_agent_console_log(request, "session-a")
            .expect("owner session may append an attributed diagnostic");
        assert_eq!(entry.task_id.as_deref(), Some(task_id.as_str()));
        assert_eq!(entry.source, "agent-reported");
    }

    #[test]
    fn headerless_ui_logs_are_detached_from_task_evidence() {
        let registry = ShellxBrowserRegistry::default();
        let task_id = agent_owned_task(&registry);
        let entry = registry
            .record_operator_ui_console_log(BrowserConsoleLogRequest {
                task_id: Some(task_id),
                level: "error".to_string(),
                source: Some("browser-runtime".to_string()),
                message: "Renderer diagnostic".to_string(),
                ..BrowserConsoleLogRequest::default()
            })
            .expect("desktop UI diagnostics remain available");

        assert_eq!(entry.task_id, None);
        assert_eq!(entry.profile_id, None);
        assert_eq!(entry.source, "shellx-browser-ui");
    }
}
