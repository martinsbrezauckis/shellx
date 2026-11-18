use super::*;

const DOCTOR_SAMPLE: &str = r#"{
      "sources": [],
      "servers": [
        {
          "name": "grok-shell-host",
          "transport": "stdio",
          "target": "/tmp/app --mcp-server",
          "source": "config",
          "checks": [
            { "label": "handshake OK", "passed": true, "detail": "protocol 2025-06-18" }
          ],
          "healthy": true
        },
        {
          "name": "vercel",
          "transport": "http",
          "target": "https://mcp.vercel.com",
          "source": "plugin: vercel",
          "checks": [
            { "label": "handshake failed", "passed": false, "detail": "OAuth authorization required", "hint": "check server logs" }
          ],
          "healthy": false
        },
        {
          "name": "unreal",
          "transport": "http",
          "target": "http://127.0.0.1:8000/mcp",
          "source": "config",
          "checks": [
            { "label": "handshake failed", "passed": false, "detail": "tcp connect error: Connection refused" }
          ],
          "healthy": false
        }
      ],
      "healthy_count": 1,
      "failing_count": 2
    }"#;

const DOCTOR_SHELLX_HOST_FAILED_SAMPLE: &str = r#"{
      "sources": [],
      "servers": [
        {
          "name": "shellx-host-http",
          "transport": "http",
          "target": "http://127.0.0.1:5758/mcp",
          "source": "config",
          "checks": [
            { "label": "handshake failed", "passed": false, "detail": "connection refused" }
          ],
          "healthy": false
        },
        {
          "name": "cloudflare-docs",
          "transport": "http",
          "target": "https://docs.mcp.cloudflare.com",
          "source": "plugin: cloudflare",
          "checks": [
            { "label": "handshake OK", "passed": true, "detail": "protocol 2025-06-18" }
          ],
          "healthy": true
        }
      ],
      "healthy_count": 1,
      "failing_count": 1
    }"#;

const INSPECT_SAMPLE: &str = r#"{
      "grokVersion": "0.1.220-alpha.2",
      "cwd": "/home/alice/grok-shell",
      "projectRoot": "/home/alice/grok-shell/",
      "projectTrusted": false,
      "projectInstructions": [
        { "path": "/home/alice/.grok/AGENTS.md", "scope": "global", "fileType": "agents_md" },
        { "path": "/home/alice/grok-shell/AGENTS.md", "scope": "project", "fileType": "agents_md" }
      ],
      "skills": [{ "name": "shellx-host" }, { "name": "check" }],
      "plugins": [{ "name": "cloudflare" }],
      "mcpServers": [{ "name": "grok-shell-host" }, { "name": "vercel" }]
    }"#;

#[test]
fn parses_doctor_sample_and_classifies_failures() {
    let doctor = parse_doctor_json(DOCTOR_SAMPLE, "").expect("doctor parses");

    assert_eq!(doctor.summary.healthy_count, 1);
    assert_eq!(doctor.summary.failing_count, 2);
    assert_eq!(doctor.summary.status, GrokEnvironmentStatus::Warn);
    assert_eq!(
        doctor
            .servers
            .iter()
            .find(|server| server.name == "grok-shell-host")
            .expect("host server")
            .category,
        GrokMcpFailureCategory::Healthy
    );
    assert_eq!(
        doctor
            .servers
            .iter()
            .find(|server| server.name == "vercel")
            .expect("vercel server")
            .category,
        GrokMcpFailureCategory::AuthRequired
    );
    assert_eq!(
        doctor
            .servers
            .iter()
            .find(|server| server.name == "unreal")
            .expect("unreal server")
            .category,
        GrokMcpFailureCategory::ConnectionFailed
    );
}

#[test]
fn shellx_host_mcp_failure_keeps_doctor_failed() {
    let doctor = parse_doctor_json(DOCTOR_SHELLX_HOST_FAILED_SAMPLE, "").expect("doctor parses");

    assert_eq!(doctor.summary.status, GrokEnvironmentStatus::Fail);
    assert_eq!(
        doctor
            .servers
            .iter()
            .find(|server| server.name == "shellx-host-http")
            .expect("host server")
            .category,
        GrokMcpFailureCategory::ConnectionFailed
    );
}

#[test]
fn wsl_grok_command_adds_user_bins_and_quotes_args() {
    let command = wsl_grok_command("/home/alice/.grok/bin/grok", &["mcp", "doctor", "--json"]);

    for path in [
        "$HOME/.local/bin",
        "$HOME/bin",
        "$HOME/.cargo/bin",
        "$HOME/.claude/bin",
        "$HOME/.grok/bin",
        "$HOME/.bun/bin",
        "$HOME/.npm-global/bin",
    ] {
        assert!(command.contains(path), "missing {path}: {command}");
    }
    assert!(command.contains("exec '/home/alice/.grok/bin/grok' 'mcp' 'doctor' '--json'"));
}

#[test]
fn ssh_grok_command_reads_token_from_stdin_before_exec() {
    let command = ssh_grok_command("/opt/grok/bin/grok", &["mcp", "doctor", "--json"]);

    assert!(command.contains("IFS= read -r SHELLX_MCP_TOKEN"));
    assert!(command.contains("export SHELLX_MCP_TOKEN"));
    assert!(command.contains("exec '/opt/grok/bin/grok' 'mcp' 'doctor' '--json'"));
}

#[test]
fn parses_inspect_sample_into_counts() {
    let inspect = parse_inspect_json(INSPECT_SAMPLE, "").expect("inspect parses");

    assert_eq!(inspect.grok_version.as_deref(), Some("0.1.220-alpha.2"));
    assert!(!inspect.project_trusted);
    assert_eq!(inspect.instruction_count, 2);
    assert_eq!(inspect.skill_count, 2);
    assert_eq!(inspect.plugin_count, 1);
    assert_eq!(inspect.mcp_server_count, 2);
}

#[test]
fn command_found_then_spawn_failed_is_not_command_missing() {
    let server = serde_json::json!({
        "healthy": false,
        "checks": [
            { "label": "command found", "passed": true, "detail": "C:\\\\Program Files\\\\nodejs\\\\npx.cmd" },
            { "label": "spawn failed", "passed": false, "detail": "program not found" }
        ]
    });

    assert_eq!(
        classify_doctor_server(&server),
        GrokMcpFailureCategory::Failed
    );
}

#[test]
fn trace_export_args_are_local_only() {
    assert_eq!(
        trace_export_args("019e-session"),
        vec!["trace", "--local", "--json", "019e-session"]
    );
}

#[test]
fn trace_idle_message_is_provider_neutral() {
    let trace = trace_availability(None);
    assert!(!trace.available);
    assert_eq!(trace.detail, "No active session id is available yet.");
    assert!(!trace.detail.contains("Grok"));
}

#[test]
fn doctor_output_with_nonzero_exit_still_parses_valid_json() {
    let mut errors = Vec::new();
    let doctor = parse_doctor_command_output(
        &CommandOutput {
            exit_code: Some(1),
            stdout: DOCTOR_SAMPLE.to_string(),
            stderr: "worker quit with fatal: auth required".to_string(),
        },
        &mut errors,
    )
    .expect("valid doctor json should be usable even when doctor exits 1");

    assert!(errors.is_empty());
    assert_eq!(doctor.summary.status, GrokEnvironmentStatus::Warn);
    assert_eq!(doctor.summary.failing_count, 2);
}

#[test]
fn setup_detects_static_html_preview() {
    let dir = test_dir("static-html");
    std::fs::write(dir.join("index.html"), "<script>window.ok=true</script>").unwrap();

    let setup = project_setup_snapshot("local", Some(dir.to_str().unwrap()));

    assert_eq!(setup.summary.status, GrokEnvironmentStatus::Pass);
    assert!(setup
        .checks
        .iter()
        .any(|check| check.id == "static-html-preview"
            && check.status == GrokEnvironmentStatus::Pass));
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn setup_detects_missing_package_install() {
    let dir = test_dir("package-install");
    std::fs::write(
        dir.join("package.json"),
        r#"{"scripts":{"dev":"vite --host 127.0.0.1"}}"#,
    )
    .unwrap();
    std::fs::write(dir.join("pnpm-lock.yaml"), "").unwrap();

    let setup = project_setup_snapshot("local", Some(dir.to_str().unwrap()));
    let deps = setup
        .checks
        .iter()
        .find(|check| check.id == "node-dependencies")
        .expect("dependencies check");

    assert_eq!(setup.summary.status, GrokEnvironmentStatus::Warn);
    assert_eq!(deps.command.as_deref(), Some("pnpm install"));
    assert!(setup
        .checks
        .iter()
        .any(|check| check.id == "preview-command" && check.status == GrokEnvironmentStatus::Pass));
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn setup_detects_missing_expo_web_dependencies() {
    let dir = test_dir("expo-web");
    std::fs::write(
        dir.join("package.json"),
        r#"{"dependencies":{"expo":"^54.0.0","react":"19.1.0"}}"#,
    )
    .unwrap();

    let setup = project_setup_snapshot("local", Some(dir.to_str().unwrap()));
    let expo = setup
        .checks
        .iter()
        .find(|check| check.id == "expo-web-dependencies")
        .expect("expo dependency check");

    assert_eq!(setup.summary.status, GrokEnvironmentStatus::Fail);
    assert_eq!(
        expo.command.as_deref(),
        Some("npx expo install react-dom react-native-web")
    );
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn readiness_reports_missing_node_runtime_for_package_preview() {
    let dir = test_dir("readiness-node");
    std::fs::write(dir.join("package.json"), r#"{"scripts":{"dev":"vite"}}"#).unwrap();
    let setup = project_setup_snapshot("local", Some(dir.to_str().unwrap()));
    let probe = CommandProbeSnapshot::default();

    let readiness =
        build_readiness_snapshot("local", Some(dir.to_str().unwrap()), None, &setup, &probe);
    let node = readiness
        .checks
        .iter()
        .find(|check| check.id == "node-runtime")
        .expect("node readiness row");
    let package_manager = readiness
        .checks
        .iter()
        .find(|check| check.id == "package-manager")
        .expect("package manager readiness row");

    assert_eq!(readiness.summary.status, GrokEnvironmentStatus::Fail);
    assert_eq!(node.status, GrokEnvironmentStatus::Fail);
    assert!(node.detail.contains("node was not found"));
    assert_eq!(package_manager.status, GrokEnvironmentStatus::Fail);
    assert!(package_manager.detail.contains("npm was not found"));
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn readiness_uses_lockfile_package_manager() {
    let dir = test_dir("readiness-pnpm");
    std::fs::write(dir.join("package.json"), r#"{"scripts":{"dev":"vite"}}"#).unwrap();
    std::fs::write(dir.join("pnpm-lock.yaml"), "").unwrap();
    let setup = project_setup_snapshot("local", Some(dir.to_str().unwrap()));
    let mut found = HashMap::new();
    found.insert("node".to_string(), Some("/usr/bin/node".to_string()));
    found.insert("npm".to_string(), Some("/usr/bin/npm".to_string()));
    let probe = CommandProbeSnapshot { found, error: None };

    let readiness =
        build_readiness_snapshot("local", Some(dir.to_str().unwrap()), None, &setup, &probe);
    let package_manager = readiness
        .checks
        .iter()
        .find(|check| check.id == "package-manager")
        .expect("package manager readiness row");

    assert_eq!(package_manager.status, GrokEnvironmentStatus::Fail);
    assert_eq!(package_manager.command.as_deref(), Some("pnpm --version"));
    assert!(package_manager.detail.contains("pnpm was not found"));
    let _ = std::fs::remove_dir_all(dir);
}

fn test_dir(label: &str) -> std::path::PathBuf {
    let mut dir = std::env::temp_dir();
    dir.push(format!(
        "shellx-grok-env-{}-{}-{}",
        label,
        std::process::id(),
        now_ms()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}
