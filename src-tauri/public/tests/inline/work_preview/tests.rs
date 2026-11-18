use super::*;

#[tokio::test]
async fn preview_output_reader_bounds_and_resynchronizes_lines() {
    let input = b"12345678overflow\nnext\r\n";
    let mut reader = BufReader::new(input.as_slice());
    assert_eq!(
        read_preview_bounded_line(&mut reader, 8).await.unwrap(),
        PreviewBoundedLine::Overflow
    );
    assert_eq!(
        read_preview_bounded_line(&mut reader, 8).await.unwrap(),
        PreviewBoundedLine::Line(b"next".to_vec())
    );
    assert_eq!(
        read_preview_bounded_line(&mut reader, 8).await.unwrap(),
        PreviewBoundedLine::Eof
    );
}

use std::fs;

struct TestDir(tempfile::TempDir);

impl std::ops::Deref for TestDir {
    type Target = Path;

    fn deref(&self) -> &Self::Target {
        self.0.path()
    }
}

fn temp_dir(label: &str) -> TestDir {
    TestDir(
        tempfile::Builder::new()
            .prefix(&format!("shellx-work-preview-{label}-"))
            .tempdir()
            .expect("temp dir"),
    )
}

fn canonical_string(path: &Path) -> String {
    path.canonicalize()
        .unwrap_or_else(|_| path.to_path_buf())
        .to_string_lossy()
        .to_string()
}

#[tokio::test]
async fn provider_local_preview_context_uses_provider_run_cwd() {
    let root = temp_dir("provider-context");
    let child = root.join("site");
    fs::create_dir_all(&child).expect("child dir");
    let outside = temp_dir("provider-context-outside");
    let provider_registry = Arc::new(ProviderSessionRegistry::default());
    provider_registry.record_started_with_target(
        crate::provider_sessions::ProviderSessionStart {
            tab_id: "provider-preview-tab".to_string(),
            provider_id: crate::provider_adapters::ProviderId::CodexCli,
            cwd: root.to_string_lossy().to_string(),
            prompt: "preview".to_string(),
        },
        None,
        true,
        crate::provider_adapters::ProviderPermissionMode::default(),
        crate::provider_sessions::ProviderSessionRunTarget::new(
            ProviderExecutionTransport::Local,
            None,
            None,
            None,
        ),
    );
    let manager = WorkPreviewManager::with_session_registries(
        Arc::new(ProcessRegistry::new()),
        Arc::new(SessionRegistry::new()),
        provider_registry,
    );

    let ctx = manager
        .resolve_context(
            "provider-preview-tab",
            &child.to_string_lossy(),
            None,
            None,
            None,
            false,
        )
        .await
        .expect("provider child context");
    assert_eq!(ctx.root_text, canonical_string(&child));
    assert!(matches!(ctx.transport, PreviewTransport::Local));
    let err = match manager
        .resolve_context(
            "provider-preview-tab",
            &outside.to_string_lossy(),
            None,
            None,
            None,
            false,
        )
        .await
    {
        Ok(_) => panic!("outside provider cwd accepted"),
        Err(err) => err,
    };
    assert!(err.contains("outside the active session folder"));
}

#[tokio::test]
async fn mcp_preview_requires_live_caller_session_and_keeps_previous_preview() {
    let root = temp_dir("mcp-session");
    fs::write(root.join("index.html"), "<html>preview</html>").expect("index");
    let manager = Arc::new(WorkPreviewManager::with_session_registries(
        Arc::new(ProcessRegistry::new()),
        Arc::new(SessionRegistry::new()),
        Arc::new(ProviderSessionRegistry::default()),
    ));
    let request = || WorkPreviewStartRequest {
        tab_id: Some("caller".to_string()),
        cwd: root.to_string_lossy().to_string(),
        kind: Some("static".to_string()),
        entry: None,
        session_id: None,
        session_cwd: None,
        transport: None,
    };
    let error = manager
        .start_for_mcp("caller", request())
        .await
        .unwrap_err();
    assert!(error.contains("no active session"));
    let running = manager.start(request()).await.expect("operator preview");
    assert_eq!(running.status, WorkPreviewStatus::Running);
    let error = manager
        .start_for_mcp("caller", request())
        .await
        .unwrap_err();
    assert!(error.contains("no active session"));
    assert_eq!(manager.state("caller").await.url, running.url);
    manager.stop("caller").await.expect("stop");
}

#[tokio::test]
async fn mcp_preview_uses_only_active_provider_run_scope() {
    let root = temp_dir("mcp-provider");
    let child = root.join("site");
    fs::create_dir_all(&child).expect("site");
    let outside = temp_dir("mcp-provider-outside");
    let provider_registry = Arc::new(ProviderSessionRegistry::default());
    let run = provider_registry.record_started_with_target(
        crate::provider_sessions::ProviderSessionStart {
            tab_id: "caller".to_string(),
            provider_id: crate::provider_adapters::ProviderId::CodexCli,
            cwd: root.to_string_lossy().to_string(),
            prompt: "preview".to_string(),
        },
        None,
        true,
        crate::provider_adapters::ProviderPermissionMode::default(),
        crate::provider_sessions::ProviderSessionRunTarget::new(
            ProviderExecutionTransport::Local,
            None,
            None,
            None,
        ),
    );
    let manager = WorkPreviewManager::with_session_registries(
        Arc::new(ProcessRegistry::new()),
        Arc::new(SessionRegistry::new()),
        provider_registry.clone(),
    );
    let ctx = manager
        .resolve_context("caller", &child.to_string_lossy(), None, None, None, true)
        .await
        .expect("active provider child");
    assert_eq!(ctx.root_text, canonical_string(&child));
    let error = manager
        .resolve_context("caller", &outside.to_string_lossy(), None, None, None, true)
        .await
        .err()
        .expect("outside must fail");
    assert!(error.contains("outside the active session folder"));
    assert!(provider_registry.record_abort("caller", Some(&run.run_id)));
    let error = manager
        .resolve_context("caller", &child.to_string_lossy(), None, None, None, true)
        .await
        .err()
        .expect("completed run must fail");
    assert!(error.contains("no active session"));
}

#[tokio::test]
async fn static_preview_serves_index_html() {
    let root = temp_dir("static");
    fs::write(
        root.join("index.html"),
        "<html><body>STATIC_PREVIEW_OK</body></html>",
    )
    .expect("index");
    let manager = Arc::new(WorkPreviewManager::new(Arc::new(ProcessRegistry::new())));
    let state = manager
        .start(WorkPreviewStartRequest {
            tab_id: Some("static-tab".to_string()),
            cwd: root.to_string_lossy().to_string(),
            kind: Some("static".to_string()),
            entry: None,
            session_id: None,
            session_cwd: None,
            transport: None,
        })
        .await
        .expect("static start");
    assert_eq!(state.status, WorkPreviewStatus::Running);
    assert_eq!(state.kind, Some(WorkPreviewKind::StaticHtml));
    let url = state.url.clone().expect("url");
    assert!(
        url.ends_with('/'),
        "index.html static preview should open the directory root for routed exports, got {}",
        url
    );
    let body = reqwest::get(url)
        .await
        .expect("get")
        .text()
        .await
        .expect("body");
    assert!(body.contains("STATIC_PREVIEW_OK"));
    assert!(body.contains("data-shellx-preview-doctor"));
    manager.stop("static-tab").await.expect("stop");
}

#[test]
fn static_preview_doctor_injection_is_idempotent() {
    let html = "<html><head><title>x</title></head><body>ok</body></html>";
    let once = inject_static_preview_doctor(html);
    let twice = inject_static_preview_doctor(&once);
    assert!(once.contains("data-shellx-preview-doctor"));
    assert_eq!(
        once.matches("data-shellx-preview-doctor").count(),
        twice.matches("data-shellx-preview-doctor").count()
    );
    assert!(find_ascii_case_insensitive(&once, "</head>").is_some());
}

#[tokio::test]
async fn static_preview_serves_named_html_without_index() {
    let root = temp_dir("named-static");
    fs::write(
        root.join("grok-preview.html"),
        "<html><body>NAMED_STATIC_PREVIEW_OK</body></html>",
    )
    .expect("html");
    let manager = Arc::new(WorkPreviewManager::new(Arc::new(ProcessRegistry::new())));
    let state = manager
        .start(WorkPreviewStartRequest {
            tab_id: Some("named-static-tab".to_string()),
            cwd: root.to_string_lossy().to_string(),
            kind: None,
            entry: None,
            session_id: None,
            session_cwd: None,
            transport: None,
        })
        .await
        .expect("static start");
    assert_eq!(state.status, WorkPreviewStatus::Running);
    assert_eq!(state.kind, Some(WorkPreviewKind::StaticHtml));
    let url = state.url.clone().expect("url");
    assert!(
        url.ends_with("/grok-preview.html"),
        "named html should be the preview URL, got {}",
        url
    );
    let body = reqwest::get(url)
        .await
        .expect("get")
        .text()
        .await
        .expect("body");
    assert!(body.contains("NAMED_STATIC_PREVIEW_OK"));
    manager.stop("named-static-tab").await.expect("stop");
}

#[tokio::test]
async fn static_preview_uses_requested_html_entry() {
    let root = temp_dir("requested-static");
    fs::write(
        root.join("alpha.html"),
        "<html><body>WRONG_STATIC_ENTRY</body></html>",
    )
    .expect("alpha");
    fs::write(
        root.join("shellx-preview-test.html"),
        "<html><body>REQUESTED_STATIC_ENTRY_OK</body></html>",
    )
    .expect("requested");
    let manager = Arc::new(WorkPreviewManager::new(Arc::new(ProcessRegistry::new())));
    let state = manager
        .start(WorkPreviewStartRequest {
            tab_id: Some("requested-static-tab".to_string()),
            cwd: root.to_string_lossy().to_string(),
            kind: Some("static".to_string()),
            entry: Some("shellx-preview-test.html".to_string()),
            session_id: None,
            session_cwd: None,
            transport: None,
        })
        .await
        .expect("static start");
    let url = state.url.clone().expect("url");
    assert!(
        url.ends_with("/shellx-preview-test.html"),
        "requested html should be the preview URL, got {}",
        url
    );
    let body = reqwest::get(url)
        .await
        .expect("get")
        .text()
        .await
        .expect("body");
    assert!(body.contains("REQUESTED_STATIC_ENTRY_OK"));
    assert!(!body.contains("WRONG_STATIC_ENTRY"));
    manager.stop("requested-static-tab").await.expect("stop");
}

#[test]
fn static_preview_relative_index_entry_uses_directory_root() {
    assert_eq!(
        static_url_path_for_relative("index.html").as_deref(),
        Some("/")
    );
    assert_eq!(
        static_url_path_for_relative("./index.html").as_deref(),
        Some("/")
    );
    assert_eq!(
        static_url_path_for_relative("nested/index.html").as_deref(),
        Some("/nested/")
    );
    assert_eq!(
        static_url_path_for_relative("nested/page.html").as_deref(),
        Some("/nested/page.html")
    );
}

#[test]
fn static_entry_hint_rejects_escape_paths() {
    assert!(sanitize_static_entry("../secret.html").is_err());
    assert!(sanitize_static_entry("/tmp/page.html").is_err());
    assert!(sanitize_static_entry("package.json").is_err());
    assert_eq!(
        sanitize_static_entry("./nested/page.html").expect("relative html"),
        "nested/page.html"
    );
}

#[test]
fn static_entry_detection_skips_blocked_dotfiles() {
    let root = temp_dir("static-dotfile");
    fs::write(root.join(".hidden.html"), "<html>hidden</html>").expect("hidden");
    fs::write(root.join("visible.html"), "<html>visible</html>").expect("visible");
    let entry = static_html_entry(&root).expect("visible entry");
    assert_eq!(
        entry.file_name().and_then(|s| s.to_str()),
        Some("visible.html")
    );
}

#[tokio::test]
async fn static_preview_blocks_sensitive_project_files() {
    let root = temp_dir("static-sensitive");
    fs::write(
            root.join("index.html"),
            "<html><head><script src=\"/app.js\"></script></head><body>SENSITIVE_BLOCK_OK</body></html>",
        )
        .expect("index");
    fs::write(root.join("app.js"), "window.shellxPreviewOk = true;").expect("js");
    fs::write(root.join(".env"), "TOKEN=secret").expect("env");
    fs::write(root.join("package.json"), r#"{"secret":"not an asset"}"#).expect("package");
    fs::create_dir_all(root.join(".git")).expect("git dir");
    fs::write(root.join(".git").join("config"), "[remote]\nurl=secret").expect("git config");

    let manager = Arc::new(WorkPreviewManager::new(Arc::new(ProcessRegistry::new())));
    let state = manager
        .start(WorkPreviewStartRequest {
            tab_id: Some("static-sensitive-tab".to_string()),
            cwd: root.to_string_lossy().to_string(),
            kind: Some("static".to_string()),
            entry: None,
            session_id: None,
            session_cwd: None,
            transport: None,
        })
        .await
        .expect("static start");
    assert_eq!(state.status, WorkPreviewStatus::Running);
    let url = state.url.clone().expect("url");
    let origin = url.split('/').take(3).collect::<Vec<_>>().join("/");

    let asset = reqwest::get(format!("{}/app.js", origin))
        .await
        .expect("asset response");
    assert!(asset.status().is_success());
    let env = reqwest::get(format!("{}/.env", origin))
        .await
        .expect("env response");
    assert!(!env.status().is_success());
    let package_json = reqwest::get(format!("{}/package.json", origin))
        .await
        .expect("package response");
    assert!(!package_json.status().is_success());
    let git_config = reqwest::get(format!("{}/.git/config", origin))
        .await
        .expect("git response");
    assert!(!git_config.status().is_success());

    manager.stop("static-sensitive-tab").await.expect("stop");
}

#[test]
fn remote_static_command_uses_filtered_server() {
    let command = remote_command_for_kind(&WorkPreviewKind::StaticHtml, 4321);

    assert!(command.contains("python3 -c"));
    assert!(command.contains("BLOCKED_NAMES"));
    assert!(command.contains("JSON_ALLOWED_NAMES"));
    assert!(command.contains("package.json"));
    assert!(command.contains("data-shellx-preview-doctor"));
    assert!(command.contains("inject_preview_doctor"));
    assert!(!command.contains("-m http.server"));
}

#[test]
fn expo_preview_commands_clear_metro_cache() {
    let root = temp_dir("expo-command");
    fs::write(
        root.join("package.json"),
        r#"{"dependencies":{"expo":"latest"}}"#,
    )
    .expect("package");

    let local = command_for_project(&root, &WorkPreviewKind::ExpoWeb, 4321).expect("local command");
    assert!(local.contains("expo start --clear --web"));
    assert!(local.contains("--port 4321"));

    let remote = remote_command_for_kind(&WorkPreviewKind::ExpoWeb, 4321);
    assert!(remote.contains("./node_modules/.bin/expo start --clear --web"));
    assert!(remote.contains("expo start --clear --web"));
    assert!(!remote.contains("expo start --web --host"));
}

#[test]
fn local_expo_command_prefers_project_bin() {
    let root = temp_dir("expo-local-bin");
    let bin_dir = root.join("node_modules").join(".bin");
    fs::create_dir_all(&bin_dir).expect("bin dir");
    let bin = if cfg!(windows) {
        bin_dir.join("expo.cmd")
    } else {
        bin_dir.join("expo")
    };
    fs::write(&bin, "expo stub").expect("bin");

    let command =
        command_for_project(&root, &WorkPreviewKind::ExpoWeb, 4321).expect("local command");
    assert!(command.contains("node_modules"));
    assert!(command.contains("expo"));
    assert!(command.contains("--clear --web --host localhost --port 4321"));
}

#[test]
fn web_preview_commands_use_framework_specific_flags() {
    let root = temp_dir("web-command");
    fs::write(
        root.join("package.json"),
        r#"{"scripts":{"dev":"next dev"}}"#,
    )
    .expect("next package");
    let next = command_for_project(&root, &WorkPreviewKind::WebApp, 4321).expect("next command");
    assert!(next.contains("--hostname 127.0.0.1 --port 4321"));
    assert!(!next.contains("--host 127.0.0.1 --port"));

    fs::write(root.join("package.json"), r#"{"scripts":{"dev":"vite"}}"#).expect("vite package");
    let vite = command_for_project(&root, &WorkPreviewKind::WebApp, 4322).expect("vite command");
    assert!(vite.contains("--host 127.0.0.1 --port 4322"));

    fs::write(
        root.join("package.json"),
        r#"{"scripts":{"dev":"node server.js"}}"#,
    )
    .expect("generic package");
    let generic =
        command_for_project(&root, &WorkPreviewKind::WebApp, 4323).expect("generic command");
    assert!(generic.contains("npm run dev"));
}

#[test]
fn generic_web_preview_command_still_forces_loopback_environment() {
    let root = temp_dir("generic-web-command");
    fs::write(
        root.join("package.json"),
        r#"{"scripts":{"dev":"node server.js"}}"#,
    )
    .expect("generic package");

    let generic =
        command_for_project(&root, &WorkPreviewKind::WebApp, 4350).expect("generic command");

    assert!(
        generic.contains("HOST=127.0.0.1") || generic.contains("SHELLX_PREVIEW_HOST=127.0.0.1"),
        "generic dev servers must receive an explicit loopback bind hint, got: {}",
        generic
    );
    assert!(
        generic.contains("PORT=4350") || generic.contains("SHELLX_PREVIEW_PORT=4350"),
        "generic dev servers must receive the preview port, got: {}",
        generic
    );
}

#[test]
fn generic_web_preview_command_uses_cmd_set_syntax_on_windows() {
    let root = temp_dir("generic-web-command-windows");
    fs::write(
        root.join("package.json"),
        r#"{"scripts":{"dev":"node server.js"}}"#,
    )
    .expect("generic package");

    let generic = web_command_for_project_for_shell(&root, "node server.js", 4350, true);

    assert!(
        generic.contains("set \"HOST=127.0.0.1\""),
        "Windows generic dev server must use cmd.exe set syntax, got: {}",
        generic
    );
    assert!(
        generic.contains("set \"PORT=4350\""),
        "Windows generic dev server must receive the preview port, got: {}",
        generic
    );
    assert!(
        !generic.starts_with("HOST=127.0.0.1 "),
        "Windows command must not use POSIX env-prefix syntax, got: {}",
        generic
    );
    assert!(generic.ends_with("npm run dev"));
}

#[tokio::test]
async fn preview_probe_does_not_follow_redirects() {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .expect("bind redirect server");
    let port = listener.local_addr().expect("addr").port();
    tokio::spawn(async move {
        if let Ok((mut socket, _)) = listener.accept().await {
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            let mut buf = [0u8; 1024];
            let _ = socket.read(&mut buf).await;
            let body = "redirecting";
            let response = format!(
                    "HTTP/1.1 302 Found\r\nLocation: http://169.254.169.254/latest/meta-data/\r\nContent-Length: {}\r\n\r\n{}",
                    body.len(),
                    body
                );
            let _ = socket.write_all(response.as_bytes()).await;
        }
    });

    let probe = probe_preview_url(&format!("http://127.0.0.1:{}/", port))
        .await
        .expect("probe succeeds without following redirect");

    assert_eq!(probe.status, 302);
    assert!(
        probe
            .issues
            .iter()
            .any(|issue| issue.message.contains("HTTP 302")),
        "redirect response should be reported as an HTTP issue: {:?}",
        probe.issues
    );
}

#[tokio::test]
async fn append_log_ignores_output_from_replaced_preview() {
    let manager = Arc::new(WorkPreviewManager::new(Arc::new(ProcessRegistry::new())));
    let state = WorkPreviewState {
        tab_id: "stale-log-tab".to_string(),
        cwd: None,
        kind: Some(WorkPreviewKind::WebApp),
        status: WorkPreviewStatus::Running,
        url: None,
        command: None,
        task_id: Some("new-task".to_string()),
        pid: None,
        started_at_ms: Some(now_ms()),
        updated_at_ms: now_ms(),
        viewport_hint: None,
        error: None,
        logs: Vec::new(),
    };
    manager
        .sessions
        .lock()
        .await
        .insert("stale-log-tab".to_string(), RuntimePreview::new(state));

    manager
        .append_log(
            "stale-log-tab",
            Some("old-task"),
            "stderr",
            "old failure".to_string(),
        )
        .await;
    manager
        .append_log(
            "stale-log-tab",
            Some("new-task"),
            "stdout",
            "new ready".to_string(),
        )
        .await;

    let logs = manager.logs("stale-log-tab").await;
    assert_eq!(logs.len(), 1);
    assert_eq!(logs[0].line, "new ready");
}

#[tokio::test]
async fn unready_preview_uses_registry_exit_as_terminal_failure() {
    let registry = Arc::new(ProcessRegistry::new());
    let manager = Arc::new(WorkPreviewManager::new(Arc::clone(&registry)));
    let task_id = registry
        .register(
            "work-preview: failing command".to_string(),
            ProcessSource::DebugApi,
            None,
        )
        .await;
    registry
        .mark_exited(&task_id, Some(1), ProcessStatus::Failed)
        .await;
    let state = WorkPreviewState {
        tab_id: "registry-fail-tab".to_string(),
        cwd: None,
        kind: Some(WorkPreviewKind::WebApp),
        status: WorkPreviewStatus::Running,
        url: None,
        command: Some("failing command".to_string()),
        task_id: Some(task_id.clone()),
        pid: None,
        started_at_ms: Some(now_ms()),
        updated_at_ms: now_ms(),
        viewport_hint: None,
        error: None,
        logs: Vec::new(),
    };
    manager
        .sessions
        .lock()
        .await
        .insert("registry-fail-tab".to_string(), RuntimePreview::new(state));

    let snapshot = manager
        .mark_running_unready(
            "registry-fail-tab",
            &task_id,
            "http://127.0.0.1:9/".to_string(),
            "preview did not become reachable".to_string(),
        )
        .await;

    assert_eq!(snapshot.status, WorkPreviewStatus::Failed);
    assert!(snapshot
        .error
        .as_deref()
        .unwrap_or_default()
        .contains("preview process exited"));
}

#[tokio::test]
async fn readiness_probe_stops_waiting_when_preview_process_fails() {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .expect("bind hanging readiness server");
    let port = listener.local_addr().expect("readiness address").port();
    let server = tokio::spawn(async move {
        let (_stream, _) = listener.accept().await.expect("accept readiness probe");
        sleep(Duration::from_secs(5)).await;
    });

    let manager = Arc::new(WorkPreviewManager::new(Arc::new(ProcessRegistry::new())));
    let task_id = "hung-readiness-task".to_string();
    let state = WorkPreviewState {
        tab_id: "hung-readiness-tab".to_string(),
        cwd: None,
        kind: Some(WorkPreviewKind::WebApp),
        status: WorkPreviewStatus::Starting,
        url: None,
        command: Some("failing command".to_string()),
        task_id: Some(task_id.clone()),
        pid: None,
        started_at_ms: Some(now_ms()),
        updated_at_ms: now_ms(),
        viewport_hint: None,
        error: None,
        logs: Vec::new(),
    };
    manager
        .sessions
        .lock()
        .await
        .insert("hung-readiness-tab".to_string(), RuntimePreview::new(state));

    let failing_manager = Arc::clone(&manager);
    let failing_task_id = task_id.clone();
    tokio::spawn(async move {
        sleep(Duration::from_millis(100)).await;
        failing_manager
            .fail_if_current(
                "hung-readiness-tab",
                Some(&failing_task_id),
                "preview process exited with code Some(1)".to_string(),
            )
            .await;
    });

    let result = timeout(
        Duration::from_secs(2),
        manager.wait_for_http_or_exit(
            "hung-readiness-tab",
            &task_id,
            &format!("http://127.0.0.1:{port}/"),
            &WorkPreviewKind::WebApp,
        ),
    )
    .await
    .expect("process failure must interrupt a hanging HTTP readiness probe")
    .expect_err("failed preview cannot become ready");
    assert!(result.contains("exited with code"));
    server.abort();
}

#[test]
fn static_preview_blocks_maps_and_generic_json() {
    assert!(!static_preview_extension_allowed("app.js.map"));
    assert!(!static_preview_extension_allowed("data.json"));
    assert!(static_preview_extension_allowed("manifest.json"));
    assert!(static_preview_extension_allowed("site.webmanifest"));
}

#[tokio::test]
async fn command_preview_uses_port_env_and_tracks_logs() {
    if std::process::Command::new("node")
        .arg("--version")
        .output()
        .is_err()
    {
        return;
    }
    let root = temp_dir("command");
    fs::write(
        root.join("package.json"),
        r#"{"scripts":{"dev":"node server.js"}}"#,
    )
    .expect("package");
    fs::write(
        root.join("server.js"),
        r#"
const http = require('http');
const port = Number(process.env.PORT || 0);
const host = process.env.HOST || '127.0.0.1';
http.createServer((req, res) => {
  console.log('served ' + req.url);
  res.end('COMMAND_PREVIEW_OK');
}).listen(port, host, () => console.log('ready ' + host + ':' + port));
"#,
    )
    .expect("server");
    let manager = Arc::new(WorkPreviewManager::new(Arc::new(ProcessRegistry::new())));
    let state = manager
        .start(WorkPreviewStartRequest {
            tab_id: Some("cmd-tab".to_string()),
            cwd: root.to_string_lossy().to_string(),
            kind: Some("web".to_string()),
            entry: None,
            session_id: None,
            session_cwd: None,
            transport: None,
        })
        .await
        .expect("command start");
    assert_eq!(state.status, WorkPreviewStatus::Running);
    assert_eq!(state.kind, Some(WorkPreviewKind::WebApp));
    let body = reqwest::get(state.url.clone().expect("url"))
        .await
        .expect("get")
        .text()
        .await
        .expect("body");
    assert!(body.contains("COMMAND_PREVIEW_OK"));
    sleep(Duration::from_millis(100)).await;
    let logs = manager.logs("cmd-tab").await;
    assert!(logs.iter().any(|line| line.line.contains("ready")));
    manager.stop("cmd-tab").await.expect("stop");
}

#[tokio::test]
async fn failed_command_preview_returns_failed_state_and_can_retry() {
    if std::process::Command::new("node")
        .arg("--version")
        .output()
        .is_err()
    {
        return;
    }
    let root = temp_dir("command-fail");
    fs::write(
        root.join("package.json"),
        r#"{"scripts":{"dev":"node server.js"}}"#,
    )
    .expect("package");
    fs::write(
        root.join("server.js"),
        "console.error('intentional preview failure'); process.exit(1);\n",
    )
    .expect("failing server");
    let manager = Arc::new(WorkPreviewManager::new(Arc::new(ProcessRegistry::new())));
    let failure_bound = if cfg!(target_os = "windows") {
        // The fully concurrent hosted Windows suite can spend longer than
        // 60 seconds starting and unwinding the real cmd -> npm -> node
        // process chain. Keep the harness bound just beyond WebApp's own
        // readiness deadline so the product contract resolves first. The
        // state/log/retry assertions below still reject a readiness timeout
        // or a process that never reports its failed exit.
        Duration::from_millis(WEB_PREVIEW_READY_TIMEOUT_MS + 30_000)
    } else {
        Duration::from_secs(8)
    };
    let failed = timeout(
        failure_bound,
        manager.start(WorkPreviewStartRequest {
            tab_id: Some("cmd-fail-tab".to_string()),
            cwd: root.to_string_lossy().to_string(),
            kind: Some("web".to_string()),
            entry: None,
            session_id: None,
            session_cwd: None,
            transport: None,
        }),
    )
    .await
    .expect("failed preview should return before readiness timeout")
    .expect("failed preview returns state");
    assert_eq!(failed.status, WorkPreviewStatus::Failed);
    assert_eq!(
        failed.cwd.as_deref(),
        Some(canonical_string(&root).as_str())
    );
    assert!(failed.error.as_deref().unwrap_or_default().contains("code"));
    assert!(failed
        .logs
        .iter()
        .any(|line| line.line.contains("intentional preview failure")));

    fs::write(
        root.join("server.js"),
        r#"
const http = require('http');
const port = Number(process.env.PORT || 0);
const host = process.env.HOST || '127.0.0.1';
http.createServer((req, res) => res.end('RETRY_PREVIEW_OK'))
  .listen(port, host, () => console.log('retry ready'));
"#,
    )
    .expect("retry server");
    let retry = manager
        .start(WorkPreviewStartRequest {
            tab_id: Some("cmd-fail-tab".to_string()),
            cwd: root.to_string_lossy().to_string(),
            kind: Some("web".to_string()),
            entry: None,
            session_id: None,
            session_cwd: None,
            transport: None,
        })
        .await
        .expect("retry start");
    assert_eq!(retry.status, WorkPreviewStatus::Running);
    let body = reqwest::get(retry.url.clone().expect("url"))
        .await
        .expect("get")
        .text()
        .await
        .expect("body");
    assert!(body.contains("RETRY_PREVIEW_OK"));
    manager.stop("cmd-fail-tab").await.expect("stop");
}

#[tokio::test]
async fn preview_diagnose_reports_browser_and_log_errors() {
    let root = temp_dir("diagnose");
    fs::write(
        root.join("index.html"),
        "<html><head><title>Broken</title></head><body>REFERENCEERROR</body></html>",
    )
    .expect("index");
    let manager = Arc::new(WorkPreviewManager::new(Arc::new(ProcessRegistry::new())));
    let state = manager
        .start(WorkPreviewStartRequest {
            tab_id: Some("diagnose-tab".to_string()),
            cwd: root.to_string_lossy().to_string(),
            kind: Some("static".to_string()),
            entry: None,
            session_id: None,
            session_cwd: None,
            transport: None,
        })
        .await
        .expect("static start");
    assert_eq!(state.status, WorkPreviewStatus::Running);
    let started_at = state.started_at_ms.expect("started");
    let preview_url = state.url.clone().expect("url");
    manager
        .append_log(
            "diagnose-tab",
            None,
            "stderr",
            "TypeError: broken render".to_string(),
        )
        .await;
    let diagnostic = manager
        .diagnose(
            "diagnose-tab",
            WorkPreviewDiagnoseRequest {
                tab_id: Some("diagnose-tab".to_string()),
                browser_events: vec![WorkPreviewBrowserEvent {
                    t: Some(started_at + 1),
                    level: "error".to_string(),
                    message: "ReferenceError: missingState is not defined".to_string(),
                    source: Some("index.html".to_string()),
                    url: Some(preview_url),
                    ..Default::default()
                }],
            },
        )
        .await;
    assert!(!diagnostic.ok);
    assert_eq!(diagnostic.title.as_deref(), Some("Broken"));
    assert!(diagnostic
        .issues
        .iter()
        .any(|issue| issue.source == "browser"));
    assert!(diagnostic.issues.iter().any(|issue| issue.source == "logs"));
    assert!(diagnostic
        .issues
        .iter()
        .any(|issue| issue.source == "content"));
    if diagnostic.screenshot_path.is_some() {
        assert!(diagnostic.screenshot_width.is_some());
        assert!(diagnostic.screenshot_height.is_some());
        assert!(diagnostic.screenshot_browser.is_some());
    }
    manager.stop("diagnose-tab").await.expect("stop");
}

#[tokio::test]
async fn preview_diagnose_snapshot_never_probes_or_captures() {
    let root = temp_dir("diagnose-snapshot");
    fs::write(
        root.join("index.html"),
        "<html><head><title>Snapshot</title></head><body>ok</body></html>",
    )
    .expect("index");
    let manager = Arc::new(WorkPreviewManager::new(Arc::new(ProcessRegistry::new())));
    let state = manager
        .start(WorkPreviewStartRequest {
            tab_id: Some("diagnose-snapshot-tab".to_string()),
            cwd: root.to_string_lossy().to_string(),
            kind: Some("static".to_string()),
            entry: None,
            session_id: None,
            session_cwd: None,
            transport: None,
        })
        .await
        .expect("static start");
    assert_eq!(state.status, WorkPreviewStatus::Running);

    let diagnostic = manager.diagnose_snapshot("diagnose-snapshot-tab").await;
    assert_eq!(diagnostic.status, "passed");
    assert_eq!(diagnostic.url, state.url);
    assert_eq!(diagnostic.http_status, None);
    assert_eq!(diagnostic.response_bytes, None);
    assert_eq!(diagnostic.title, None);
    assert_eq!(diagnostic.screenshot_path, None);
    assert_eq!(diagnostic.screenshot_error, None);
    assert!(diagnostic
        .issues
        .iter()
        .all(|issue| issue.source != "http" && issue.source != "screenshot"));

    manager.stop("diagnose-snapshot-tab").await.expect("stop");
}

#[tokio::test]
async fn preview_diagnose_filters_stale_browser_events() {
    let root = temp_dir("diagnose-stale");
    fs::write(root.join("index.html"), "<html><body>ok</body></html>").expect("index");
    let manager = Arc::new(WorkPreviewManager::new(Arc::new(ProcessRegistry::new())));
    let state = manager
        .start(WorkPreviewStartRequest {
            tab_id: Some("diagnose-stale-tab".to_string()),
            cwd: root.to_string_lossy().to_string(),
            kind: Some("static".to_string()),
            entry: None,
            session_id: None,
            session_cwd: None,
            transport: None,
        })
        .await
        .expect("static start");
    let started_at = state.started_at_ms.expect("started");
    let current_url = state.url.clone().expect("url");
    let stale_origin = "http://127.0.0.1:9/index.html".to_string();
    let diagnostic = manager
        .diagnose(
            "diagnose-stale-tab",
            WorkPreviewDiagnoseRequest {
                tab_id: Some("diagnose-stale-tab".to_string()),
                browser_events: vec![
                    WorkPreviewBrowserEvent {
                        t: Some(started_at - 10_000),
                        level: "error".to_string(),
                        message: "old generation".to_string(),
                        url: Some(current_url.clone()),
                        ..Default::default()
                    },
                    WorkPreviewBrowserEvent {
                        t: Some(started_at + 1),
                        level: "error".to_string(),
                        message: "old origin".to_string(),
                        url: Some(stale_origin),
                        ..Default::default()
                    },
                    WorkPreviewBrowserEvent {
                        level: "error".to_string(),
                        message: "missing timestamp and URL".to_string(),
                        ..Default::default()
                    },
                    WorkPreviewBrowserEvent {
                        t: Some(started_at + 1),
                        level: "error".to_string(),
                        message: "missing URL".to_string(),
                        ..Default::default()
                    },
                    WorkPreviewBrowserEvent {
                        level: "error".to_string(),
                        message: "missing timestamp".to_string(),
                        url: Some(current_url.clone()),
                        ..Default::default()
                    },
                    WorkPreviewBrowserEvent {
                        t: Some(started_at + 1),
                        level: "error".to_string(),
                        message: "current origin".to_string(),
                        url: Some(current_url),
                        ..Default::default()
                    },
                ],
            },
        )
        .await;
    assert_eq!(diagnostic.browser_events.len(), 1);
    assert_eq!(diagnostic.browser_events[0].message, "current origin");
    manager.stop("diagnose-stale-tab").await.expect("stop");
}

#[test]
fn remote_path_scope_requires_path_under_session_root() {
    assert!(remote_path_within(
        "/home/user/project",
        "/home/user/project"
    ));
    assert!(remote_path_within(
        "/home/user/project/",
        "/home/user/project/app"
    ));
    assert!(!remote_path_within(
        "/home/user/project",
        "/home/user/project-other"
    ));
    assert!(!remote_path_within("/home/user/project", "/home/user"));
    assert!(!remote_path_within("", "/home/user/project"));
}

#[test]
fn preview_screenshot_viewport_matches_preview_kind() {
    assert_eq!(
        preview_screenshot_viewport(Some(&WorkPreviewKind::ExpoWeb)),
        (390, 844)
    );
    assert_eq!(
        preview_screenshot_viewport(Some(&WorkPreviewKind::WebApp)),
        (1365, 900)
    );
    assert_eq!(
        preview_screenshot_viewport(Some(&WorkPreviewKind::StaticHtml)),
        (1365, 900)
    );
    assert_eq!(preview_screenshot_viewport(None), (1365, 900));
}

#[tokio::test]
async fn wait_for_screenshot_file_waits_for_delayed_write() {
    let root = temp_dir("screenshot-wait");
    let path = root.join("delayed.png");
    let writer_path = path.clone();
    tokio::spawn(async move {
        sleep(Duration::from_millis(80)).await;
        tokio::fs::write(writer_path, b"png").await.expect("write");
    });
    wait_for_screenshot_file(&path)
        .await
        .expect("screenshot ready");
}

#[test]
fn preview_log_issue_ignores_static_server_access_logs() {
    let benign = WorkPreviewLogLine {
        t: now_ms(),
        stream: "stderr".to_string(),
        line: r#"127.0.0.1 - - [28/May/2026 13:12:18] "GET /index.html HTTP/1.1" 200 -"#
            .to_string(),
    };
    let blocked_probe = WorkPreviewLogLine {
        t: now_ms(),
        stream: "stderr".to_string(),
        line: r#"127.0.0.1 - - [28/May/2026 13:12:18] "GET /.env HTTP/1.1" 404 -"#.to_string(),
    };
    let real_error = WorkPreviewLogLine {
        t: now_ms(),
        stream: "stderr".to_string(),
        line: "ReferenceError: missingState is not defined".to_string(),
    };
    let ssh_forward_warmup = WorkPreviewLogLine {
        t: now_ms(),
        stream: "stderr".to_string(),
        line: "channel 2: open failed: connect failed: Connection refused".to_string(),
    };
    let metro_warning = WorkPreviewLogLine {
            t: now_ms(),
            stream: "stdout".to_string(),
            line: "Web  WARN  Launch API unavailable, using offline fallback data. [Error: Launch API upcoming failed: 429]".to_string(),
        };

    assert!(preview_log_issue(&benign).is_none());
    assert!(preview_log_issue(&blocked_probe).is_none());
    assert!(preview_log_issue(&ssh_forward_warmup).is_none());
    assert!(preview_log_issue(&metro_warning).is_none());
    assert!(preview_log_issue(&real_error).is_some());
}

#[test]
fn detects_expo_before_generic_web_app() {
    let root = temp_dir("expo");
    fs::write(
        root.join("package.json"),
        r#"{"scripts":{"dev":"vite"},"dependencies":{"expo":"latest"}}"#,
    )
    .expect("package");
    let kind = detect_kind(&root, None).expect("detect");
    assert_eq!(kind, WorkPreviewKind::ExpoWeb);
}

#[test]
fn package_json_detection_accepts_utf8_bom() {
    let root = temp_dir("expo-bom");
    fs::write(
        root.join("package.json"),
        "\u{feff}{\"dependencies\":{\"expo\":\"latest\"}}",
    )
    .expect("package");
    let kind = detect_kind(&root, None).expect("detect");
    assert_eq!(kind, WorkPreviewKind::ExpoWeb);
}

#[test]
fn auto_detects_nested_expo_before_static_html() {
    let root = temp_dir("nested-expo");
    fs::write(root.join("landing.html"), "<html>old page</html>").expect("html");
    let app = root.join("mobile-app");
    fs::create_dir_all(&app).expect("app dir");
    fs::write(
        app.join("package.json"),
        r#"{"scripts":{"dev":"vite"},"dependencies":{"expo":"latest"}}"#,
    )
    .expect("package");
    let detected = detect_local_preview(&root, None, None).expect("detect");
    assert_eq!(detected.kind, WorkPreviewKind::ExpoWeb);
    assert_eq!(detected.local_root.as_deref(), Some(app.as_path()));
}

#[test]
fn local_static_expo_export_carries_phone_viewport_hint() {
    let root = temp_dir("expo-static-export");
    fs::write(root.join("index.html"), "<html>expo export</html>").expect("html");
    let marker = root.join("_expo");
    fs::create_dir_all(&marker).expect("expo marker dir");
    fs::write(marker.join(".routes.json"), "{}").expect("expo routes marker");

    let detected =
        detect_local_preview(&root, Some(WorkPreviewKind::StaticHtml), Some("index.html"))
            .expect("detect");

    assert_eq!(detected.kind, WorkPreviewKind::StaticHtml);
    assert_eq!(detected.viewport_hint.as_deref(), Some("phone"));
}

#[test]
fn remote_detection_keeps_nested_package_root() {
    let detected =
        parse_remote_detection("/home/user/project", "expo|./mobile app\n").expect("detect");
    assert_eq!(detected.kind, WorkPreviewKind::ExpoWeb);
    assert_eq!(detected.root_text, "/home/user/project/mobile app");
}

#[test]
fn remote_detection_keeps_native_windows_package_root() {
    let detected =
        parse_remote_detection(r"C:\Users\Fixture\Project", "web|apps/site\n").expect("detect");
    assert_eq!(detected.kind, WorkPreviewKind::WebApp);
    assert_eq!(detected.root_text, r"C:\Users\Fixture\Project\apps\site");
}

#[test]
fn remote_static_expo_export_carries_phone_viewport_hint() {
    let detected = parse_remote_detection("/home/user/project/dist", "static-expo|index.html\n")
        .expect("detect");

    assert_eq!(detected.kind, WorkPreviewKind::StaticHtml);
    assert_eq!(detected.static_entry.as_deref(), Some("index.html"));
    assert_eq!(detected.viewport_hint.as_deref(), Some("phone"));
}

#[test]
fn remote_preview_script_wraps_shell_conditionals() {
    let script = remote_preview_script(
        "/tmp/demo",
        4321,
        "if command -v python3 >/dev/null 2>&1; then python3 -m http.server 4321; fi",
        false,
    );

    assert!(script.contains("exec sh -lc "));
    assert!(!script.contains("exec bash -lc "));
    assert!(!script.contains("exec if "));
    assert!(script.contains("PORT=4321"));
    assert!(script.contains(".nvm/nvm.sh"));
}

#[test]
fn remote_preview_script_encodes_web_command_payload() {
    let command = remote_command_for_kind(&WorkPreviewKind::WebApp, 4321);
    let script = remote_preview_script("/tmp/demo", 4321, &command, true);

    assert!(script.contains("command_payload=$(printf %s "));
    assert!(script.contains("base64 -d"));
    assert!(script.contains("exec sh -lc \"$command_payload\""));
    assert!(!script.contains("require('./package.json')"));
}

#[test]
fn native_windows_remote_preview_uses_powershell_without_posix_shell() {
    let command = remote_windows_command_for_kind(&WorkPreviewKind::WebApp, 4321);
    let script = remote_windows_preview_script(r"C:\Users\Fixture\Project", 4321, &command);

    assert!(script.contains(r"C:\Users\Fixture\Project"));
    assert!(script.contains("ConvertFrom-Json"));
    assert!(script.contains("$env:PORT='4321'"));
    assert!(!script.contains("sh -lc"));
    let encoded = crate::acp::wrap_ssh_windows_command(&script);
    assert!(encoded.starts_with("powershell.exe "));
    assert!(!encoded.contains(r"C:\Users\Fixture\Project"));
}

#[test]
fn native_windows_static_preview_avoids_store_aliases_and_native_argv_requoting() {
    let command = remote_windows_static_command(4321);

    assert!(command.contains("-notlike '*\\WindowsApps\\*'"));
    assert!(command.contains("SHELLX_STATIC_PYTHON_SOURCE_B64"));
    assert!(command.contains("SHELLX_STATIC_NODE_SOURCE_B64"));
    assert!(command.contains("os.environ.pop"));
    assert!(command.contains("Buffer.from"));
    assert!(!command.contains("const http=require"));
}

#[test]
fn native_windows_preview_guard_tracks_the_ssh_session_and_kills_the_child_tree() {
    let guarded = windows_preview_session_guard_script("Write-Output 'preview-ready'");

    assert!(guarded.contains("NtQueryInformationProcess"));
    assert!(guarded.contains("Get-ShellXParentProcessId $PID"));
    assert!(!guarded.contains("Get-CimInstance"));
    assert!(guarded.contains("Start-Process"));
    assert!(guarded.contains("WaitForExit(250)"));
    assert!(guarded.contains("taskkill.exe /PID $child.Id /T /F"));
    assert!(!guarded.contains("preview-ready"));
}

#[test]
fn wsl_remote_preview_script_strips_windows_path_entries() {
    let script = remote_preview_script("/tmp/demo", 4321, "command -v npx", true);

    assert!(script.contains("/mnt/?/*|/mnt/??/*"));
    assert!(script.contains("$HOME/.local/bin"));
    assert!(script.contains(".nvm/nvm.sh"));
}

#[cfg(unix)]
#[test]
fn remote_preview_script_executes_quoted_command_from_root_with_spaces() {
    let root = temp_dir("remote script");
    let script = remote_preview_script(
        &canonical_string(&root),
        4321,
        "printf '%s\\n' shellx-preview-ok",
        false,
    );
    let output = std::process::Command::new("sh")
        .arg("-lc")
        .arg(script)
        .output()
        .expect("run preview bootstrap");

    assert!(
        output.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        String::from_utf8_lossy(&output.stdout).trim(),
        "shellx-preview-ok"
    );
}

#[cfg(unix)]
#[test]
fn remote_preview_script_executes_payload_with_quotes() {
    let root = temp_dir("remote payload quotes");
    let script = remote_preview_script(
        &canonical_string(&root),
        4321,
        "printf '%s\\n' \"shellx-preview's-ok\"",
        false,
    );
    let output = std::process::Command::new("sh")
        .arg("-lc")
        .arg(script)
        .output()
        .expect("run preview bootstrap");

    assert!(
        output.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        String::from_utf8_lossy(&output.stdout).trim(),
        "shellx-preview's-ok"
    );
}
