use super::{
    build_session_activity_report, discover_scratch_dir_under_home, filter_updates_jsonl,
    missing_hunk_status, percent_decode_path_segment, read_filtered_updates_jsonl,
    remote_scratch_dir, urlencoded_cwd, wsl_scratch_dir, FilteredUpdatesRead,
    SessionActivitySource, MAX_FILTERED_UPDATE_BYTES,
};

#[test]
fn encodes_cwd_as_grok_session_segment() {
    assert_eq!(
        urlencoded_cwd("/home/user/project"),
        "%2Fhome%2Fuser%2Fproject"
    );
    assert_eq!(
        urlencoded_cwd("C:\\Users\\FixtureUser"),
        "C%3A%5CUsers%5CFixtureUser"
    );
}

#[test]
fn decodes_grok_session_cwd_segment() {
    assert_eq!(
        percent_decode_path_segment("%2Fhome%2Fuser%2Fproject").as_deref(),
        Some("/home/user/project")
    );
    assert_eq!(
        percent_decode_path_segment("C%3A%5CUsers%5CFixtureUser").as_deref(),
        Some("C:\\Users\\FixtureUser")
    );
}

#[test]
fn discovers_restored_local_scratch_dir_by_session_id() {
    let root = std::env::temp_dir().join(format!(
        "shellx-session-activity-test-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("system time")
            .as_nanos()
    ));
    let scratch = root
        .join(".grok")
        .join("sessions")
        .join("%2Fhome%2Fuser%2Fproject")
        .join("sid-restored");
    std::fs::create_dir_all(&scratch).expect("create scratch dir");
    std::fs::write(scratch.join("hunk_records.jsonl"), "{}\n").expect("write hunk log");

    let found = discover_scratch_dir_under_home(&root, "sid-restored", "local")
        .expect("discovers scratch dir");
    assert_eq!(found.cwd.as_deref(), Some("/home/user/project"));
    assert_eq!(found.transport, "local");
    assert!(found.scratch_dir.ends_with("sid-restored"));

    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn builds_wsl_scratch_unc_path() {
    let path = wsl_scratch_dir(
        "Ubuntu-24.04",
        "/home/alice",
        "/home/alice/project",
        "sid-1",
    )
    .expect("valid WSL scratch path");
    assert_eq!(
        path.to_string_lossy(),
        "\\\\wsl$\\Ubuntu-24.04\\home\\alice\\.grok\\sessions\\%2Fhome%2Falice%2Fproject\\sid-1"
    );
}

#[test]
fn builds_ssh_remote_scratch_path() {
    assert_eq!(
        remote_scratch_dir("/home/bob", "/home/bob/project", "sid-2",),
        "/home/bob/.grok/sessions/%2Fhome%2Fbob%2Fproject/sid-2"
    );
}

#[test]
fn filters_updates_to_tool_calls_only() {
    let jsonl = [
            r#"{"method":"session/update","params":{"update":{"sessionUpdate":"text_delta"}}}"#,
            r#"{"method":"session/update","params":{"update":{"sessionUpdate":"tool_call","toolCallId":"a"}}}"#,
            r#"{"method":"session/update","params":{"update":{"sessionUpdate":"tool_call_update","toolCallId":"a"}}}"#,
        ]
        .join("\n");
    let filtered = filter_updates_jsonl(&jsonl);
    assert!(!filtered.contains("text_delta"));
    assert!(filtered.contains(r#""sessionUpdate":"tool_call""#));
    assert!(filtered.contains(r#""sessionUpdate":"tool_call_update""#));
}

#[test]
fn streams_large_update_logs_before_applying_filtered_cap() {
    let root = std::env::temp_dir().join(format!(
        "shellx-session-updates-large-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("system time")
            .as_nanos()
    ));
    std::fs::create_dir_all(&root).expect("create temp root");
    let updates_path = root.join("updates.jsonl");
    let noise = format!(
            "{{\"method\":\"session/update\",\"params\":{{\"update\":{{\"sessionUpdate\":\"text_delta\",\"text\":\"{}\"}}}}}}\n",
            "x".repeat(MAX_FILTERED_UPDATE_BYTES + 1024)
        );
    let tool_call = r#"{"method":"session/update","params":{"update":{"sessionUpdate":"tool_call","toolCallId":"read-large","title":"read_file","rawInput":{"target_file":"README.md"}}}}"#;
    std::fs::write(&updates_path, format!("{}{}\n", noise, tool_call))
        .expect("write large updates");

    let filtered = read_filtered_updates_jsonl(&updates_path).expect("read large updates");
    assert!(filtered.present);
    assert!(filtered.too_large.is_none());
    assert!(filtered.jsonl.contains("read-large"));
    assert!(!filtered.jsonl.contains("text_delta"));

    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn missing_hunk_status_distinguishes_idle_and_update_only_sessions() {
    let missing = FilteredUpdatesRead::missing();
    let (status, readable, note) = missing_hunk_status(&missing, false);
    assert_eq!(status, "missing-activity-logs");
    assert!(!readable);
    assert!(note.contains("activity logs"));

    let idle = FilteredUpdatesRead::content(
        r#"{"method":"session/update","params":{"update":{"sessionUpdate":"user_message_chunk"}}}"#
            .to_string(),
    );
    let (status, readable, note) = missing_hunk_status(&idle, false);
    assert_eq!(status, "no-file-activity");
    assert!(!readable);
    assert!(note.contains("no file/tool activity"));

    let updates = FilteredUpdatesRead::content(
            r#"{"method":"session/update","params":{"update":{"sessionUpdate":"tool_call","toolCallId":"a","title":"read_file","rawInput":{"target_file":"src/App.tsx"}}}}"#
                .to_string(),
        );
    let (status, readable, note) = missing_hunk_status(&updates, false);
    assert_eq!(status, "observed-updates-only");
    assert!(readable);
    assert!(note.contains("observed tool updates"));
}

#[test]
fn builds_compact_activity_report_for_debug_api() {
    let hunk_records_jsonl = serde_json::json!({
        "hunkId": "h1",
        "filePath": "/home/user/project/src/App.tsx",
        "linesAdded": 4,
        "linesRemoved": 1,
        "authorType": "agent",
        "sourceType": "agentEdit",
        "timestamp": "2026-06-08T10:00:00Z",
        "eventType": "added"
    })
    .to_string();
    let updates_jsonl = [
            serde_json::json!({
                "timestamp": "2026-06-08T10:01:00Z",
                "params": {
                    "update": {
                        "sessionUpdate": "tool_call",
                        "toolCallId": "read-1",
                        "title": "read_file",
                        "rawInput": { "target_file": "README.md" }
                    }
                }
            })
            .to_string(),
            serde_json::json!({
                "timestamp": "2026-06-08T10:01:01Z",
                "params": {
                    "update": {
                        "sessionUpdate": "tool_call_update",
                        "toolCallId": "read-1",
                        "title": "Read `README.md`",
                        "rawInput": { "variant": "ReadFile", "target_file": "README.md" }
                    }
                }
            })
            .to_string(),
            serde_json::json!({
                "timestamp": "2026-06-08T10:02:00Z",
                "params": {
                    "update": {
                        "sessionUpdate": "tool_call",
                        "toolCallId": "grep-1",
                        "title": "grep",
                        "rawInput": { "path": "src", "pattern": "ActivityEvidenceView" }
                    }
                }
            })
            .to_string(),
            serde_json::json!({
                "timestamp": "2026-06-08T10:03:00Z",
                "params": {
                    "update": {
                        "sessionUpdate": "tool_call",
                        "toolCallId": "cmd-1",
                        "title": "run_terminal_command",
                        "rawInput": { "command": "node scripts/check.js" }
                    }
                }
            })
            .to_string(),
            serde_json::json!({
                "timestamp": "2026-06-08T10:04:00Z",
                "params": {
                    "update": {
                        "sessionUpdate": "tool_call",
                        "toolCallId": "git-1",
                        "title": "run_terminal_command",
                        "rawInput": { "command": "git push origin main" }
                    }
                }
            })
            .to_string(),
            serde_json::json!({
                "timestamp": "2026-06-08T10:05:00Z",
                "params": {
                    "update": {
                        "sessionUpdate": "tool_call",
                        "toolCallId": "git-redir",
                        "title": "run_terminal_command",
                        "rawInput": { "command": "git rev-parse --show-toplevel 2>/dev/null; git status --short" }
                    }
                }
            })
            .to_string(),
        ]
        .join("\n");
    let source = SessionActivitySource {
        tab_id: "tab-1".to_string(),
        session_id: Some("sid-1".to_string()),
        cwd: Some("/home/user/project".to_string()),
        transport: "local".to_string(),
        status: "ready".to_string(),
        readable: true,
        scratch_dir: None,
        hunk_records_path: None,
        hunk_records_jsonl,
        updates_path: None,
        updates_jsonl,
        note: None,
    };

    let report = build_session_activity_report(&source);
    assert_eq!(report.schema_version, "shellx.sessionActivity.report.v1");
    assert_eq!(report.summary.verified, 1);
    assert_eq!(report.summary.observed, 2);
    assert_eq!(report.summary.inferred, 3);
    assert_eq!(report.summary.git, 2);
    assert_eq!(report.changes[0].relative_path, "src/App.tsx");
    assert_eq!(report.changes[0].confidence, "verified");
    assert!(report
        .reads_and_searches
        .iter()
        .any(|item| item.relative_path == "README.md"));
    assert_eq!(
        report
            .reads_and_searches
            .iter()
            .find(|item| item.relative_path == "README.md")
            .map(|item| item.count),
        Some(1)
    );
    assert!(report
        .reads_and_searches
        .iter()
        .any(|item| item.query.as_deref() == Some("ActivityEvidenceView")));
    assert_eq!(
        report.commands[0].command.as_deref(),
        Some("node scripts/check.js")
    );
    assert!(report.git.iter().any(|item| item.command.as_deref()
        == Some("git rev-parse --show-toplevel 2>/dev/null; git status --short")));
    assert!(report
        .git
        .iter()
        .all(|item| !item.relative_path.contains("2>/dev/null")));
}
