use serde_json::json;

use crate::shellx_browser::{
    browser_id, clean_string, lock_or_recover, now_ms, push_receipt, BrowserConsoleLogEntry,
    BrowserConsoleLogRequest, BrowserReportRequest, BrowserReportResponse, ShellxBrowserRegistry,
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
        let message = sanitize_console_message(&request.message);
        if message.is_empty() {
            return Err("browser console log message is required".to_string());
        }
        let level = normalize_console_level(&request.level);
        let source = request
            .source
            .as_deref()
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
            _ => state.active_task_id.clone(),
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
            details: sanitize_console_details(request.details),
        };
        state.console_logs.push(entry.clone());
        if state.console_logs.len() > 1000 {
            let overflow = state.console_logs.len() - 1000;
            state.console_logs.drain(0..overflow);
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
