use super::*;

#[test]
fn vault_placeholders_become_env_refs() {
    assert_eq!(
        expand_vault_placeholders_to_env_refs("Authorization=Bearer $VAULT:github/pat"),
        "Authorization=Bearer ${SHELLX_MCP_MARKETPLACE_GITHUB_PAT}"
    );
}

#[test]
fn vault_placeholder_expansion_preserves_utf8_text() {
    assert_eq!(
        expand_vault_placeholders_to_env_refs("label=cafe\u{00e9} $VAULT:x/y snowman=\u{2603}"),
        "label=cafe\u{00e9} ${SHELLX_MCP_MARKETPLACE_X_Y} snowman=\u{2603}"
    );
}

#[test]
fn catalog_env_references_expand_without_interpreting_literal_shell_syntax() {
    let posix = shell_quote_catalog_arg_for_remote(
        "prefix ${SHELLX_MCP_MARKETPLACE_TOKEN} $(touch /tmp/owned) `id`",
    );
    assert_eq!(
        posix,
        "'prefix '\"${SHELLX_MCP_MARKETPLACE_TOKEN}\"' $(touch /tmp/owned) `id`'"
    );

    let powershell =
        powershell_catalog_arg("prefix $VAULT:test/token $(Start-Process calc) `n suffix");
    assert!(powershell.contains("($env:SHELLX_MCP_MARKETPLACE_TEST_TOKEN)"));
    assert!(powershell.contains("' $(Start-Process calc) `n suffix'"));
    assert!(!powershell.contains("\"prefix"));
}

#[test]
fn http_config_block_uses_grok_native_mcp_shape_without_plain_secret() {
    let github = CATALOG.iter().find(|e| e.id == "github").unwrap();
    let block = config_section_for_entry(github, true);
    assert!(block.contains("[mcp_servers.shellx-mp-github]"));
    assert!(block.contains("url = \"https://api.githubcopilot.com/mcp/\""));
    assert!(block.contains("type = \"http\""));
    assert!(block.contains("\"Authorization\" = \"Bearer ${SHELLX_MCP_MARKETPLACE_GITHUB_PAT}\""));
    assert!(!block.contains("$VAULT:github/pat"));
}

#[test]
fn generated_config_block_is_valid_toml() {
    for entry in CATALOG {
        let block = config_section_for_entry(entry, true);
        toml::from_str::<toml::Value>(&block)
            .unwrap_or_else(|e| panic!("{} config must parse as TOML: {}", entry.id, e));
    }
}

#[test]
fn stdio_keyed_entries_emit_per_server_env_table() {
    let notion = CATALOG.iter().find(|e| e.id == "notion").unwrap();
    let block = config_section_for_entry(notion, true);
    assert!(block.contains("[mcp_servers.shellx-mp-notion.env]"));
    assert!(block.contains("OPENAPI_MCP_HEADERS"));
    assert!(block.contains("${SHELLX_MCP_MARKETPLACE_NOTION_INTEGRATION_TOKEN}"));
    assert!(!block.contains("$VAULT:notion/integration-token"));
    toml::from_str::<toml::Value>(&block).expect("notion config must parse as TOML");
}

#[test]
fn telegram_marketplace_uses_account_credentials_not_bot_token() {
    let telegram = CATALOG.iter().find(|e| e.id == "telegram").unwrap();
    assert_eq!(
        telegram.vault_keys,
        &["telegram/api-id", "telegram/api-hash"]
    );
    let block = config_section_for_entry_for_platform(telegram, false, true);
    assert!(block.contains("enabled = false"));
    assert!(block.contains("API_ID"));
    assert!(block.contains("API_HASH"));
    assert!(!block.contains("TELEGRAM_BOT_TOKEN"));
    assert!(!block.contains("telegram/bot-token"));
}

#[test]
fn detects_legacy_telegram_bot_token_inside_env_block() {
    let source = r#"
# shellX:managed-mcp-marketplace:telegram BEGIN - do not edit by hand
[mcp_servers.shellx-mp-telegram]
command = "cmd.exe"
args = ["/c", "uvx", "mcp-telegram", "start"]
enabled = true
[mcp_servers.shellx-mp-telegram.env]
TELEGRAM_BOT_TOKEN = "${SHELLX_MCP_MARKETPLACE_TELEGRAM_BOT_TOKEN}"
# shellX:managed-mcp-marketplace:telegram END
"#;
    assert!(telegram_section_uses_legacy_bot_token_env(source));
}

#[test]
fn linear_uses_sse_transport_type() {
    let linear = CATALOG.iter().find(|e| e.id == "linear").unwrap();
    let block = config_section_for_entry(linear, true);
    assert!(block.contains("url = \"https://mcp.linear.app/sse\""));
    assert!(block.contains("type = \"sse\""));
}

#[test]
fn remote_project_config_uses_posix_stdio_commands() {
    let context7 = CATALOG.iter().find(|e| e.id == "context7").unwrap();
    let block = config_section_for_entry_for_platform(context7, true, false);
    assert!(block.contains("command = \"bash\""));
    assert!(block.contains("\"-lc\""));
    assert!(block.contains("$HOME/.local/bin"));
    assert!(block.contains("/opt/homebrew/bin"));
    assert!(block.contains("$HOME/.nvm/nvm.sh"));
    assert!(block.contains("exec 'npx' '-y' '@upstash/context7-mcp'"));
    assert!(!block.contains("cmd.exe"));
    assert!(!block.contains("--stdio-proxy"));

    let windows_block = config_section_for_entry_for_platform(context7, true, true);
    assert!(windows_block.contains("--stdio-proxy"));
    assert!(windows_block.contains("\"npx\""));
    assert!(!windows_block.contains("command = \"cmd.exe\""));
}

#[cfg(unix)]
#[test]
fn appimage_uvx_marketplace_launch_keeps_external_python_paths() {
    use std::os::unix::fs::PermissionsExt;

    let root = std::env::temp_dir().join(format!(
        "shellx-marketplace-uvx-env-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let home = root.join("home");
    let bin = home.join(".local/bin");
    std::fs::create_dir_all(&bin).unwrap();
    let fake_uvx = bin.join("uvx");
    std::fs::write(
        &fake_uvx,
        "#!/bin/sh\nprintf '%s\\n%s\\n' \"${PYTHONHOME-<unset>}\" \"${PYTHONPATH-<unset>}\"\n",
    )
    .unwrap();
    std::fs::set_permissions(&fake_uvx, std::fs::Permissions::from_mode(0o700)).unwrap();

    let appdir = root.join("appimage-root");
    let (command, args) = posix_stdio_command_with_user_path("uvx", &["mcp-server-git"]);
    assert_eq!(command, "bash");
    let git = CATALOG.iter().find(|entry| entry.id == "git").unwrap();
    let acp = acp_server_for_entry(git, MarketplaceAcpRuntime::Posix, &HashMap::new())
        .expect("POSIX ACP Git entry");
    assert_eq!(acp["command"], "/usr/bin/env");
    assert_eq!(acp["args"], serde_json::json!(["bash", "-lc", args[1]]));
    let run = |appimage: bool, python_home: &str, python_path: &str| {
        let mut process = std::process::Command::new(&command);
        process
            .args(&args)
            .env("HOME", &home)
            .env("APPDIR", &appdir)
            .env("PYTHONHOME", python_home)
            .env("PYTHONPATH", python_path);
        if appimage {
            process.env("APPIMAGE", root.join("shellx.AppImage"));
        } else {
            process.env_remove("APPIMAGE");
        }
        let output = process.output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8(output.stdout).unwrap()
    };

    assert_eq!(
        run(
            true,
            &appdir.join("usr").to_string_lossy(),
            &format!(
                "{}:/owned/python",
                appdir.join("usr/share/pyshared").display()
            ),
        ),
        "<unset>\n/owned/python\n"
    );
    assert_eq!(
        run(true, "/external/python", "/external/modules"),
        "/external/python\n/external/modules\n"
    );
    assert_eq!(
        run(
            false,
            &appdir.join("usr").to_string_lossy(),
            &appdir.join("usr/share/pyshared").to_string_lossy(),
        ),
        format!(
            "{}\n{}\n",
            appdir.join("usr").display(),
            appdir.join("usr/share/pyshared").display()
        )
    );
    let (_, npx_args) = posix_stdio_command_with_user_path("npx", &["-y", "test-package"]);
    assert!(!npx_args[1].contains("_shellx_python_tail"));
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn acp_stdio_entries_use_absolute_cross_host_launchers() {
    let context7 = CATALOG.iter().find(|entry| entry.id == "context7").unwrap();
    let posix = acp_server_for_entry(context7, MarketplaceAcpRuntime::Posix, &HashMap::new())
        .expect("POSIX ACP entry");
    assert_eq!(posix["name"], "shellx-mp-context7");
    assert_eq!(posix["command"], "/usr/bin/env");
    assert_eq!(posix["args"][0], "bash");
    assert!(posix["args"][2]
        .as_str()
        .unwrap_or_default()
        .contains("exec 'npx' '-y' '@upstash/context7-mcp'"));
    assert_eq!(posix["env"], serde_json::json!([]));

    let stripe = CATALOG.iter().find(|entry| entry.id == "stripe").unwrap();
    let secrets = HashMap::from([(
        "stripe/secret-key".to_string(),
        "stripe-fixture-secret".to_string(),
    )]);
    let windows = acp_server_for_entry(stripe, MarketplaceAcpRuntime::Windows, &secrets)
        .expect("Windows ACP entry");
    assert_eq!(
        windows["command"],
        r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe"
    );
    let script = windows["args"][4].as_str().unwrap_or_default();
    assert!(script.contains("$env:SHELLX_MCP_MARKETPLACE_STRIPE_SECRET_KEY"));
    assert!(!script.contains("stripe-fixture-secret"));
    assert!(windows["env"].as_array().unwrap().iter().any(|value| {
        value["name"] == "SHELLX_MCP_MARKETPLACE_STRIPE_SECRET_KEY"
            && value["value"] == "stripe-fixture-secret"
    }));
}

#[test]
fn acp_http_entries_resolve_headers_without_persistent_placeholders() {
    let github = CATALOG.iter().find(|entry| entry.id == "github").unwrap();
    let secrets = HashMap::from([(
        "github/pat".to_string(),
        "github-fixture-secret".to_string(),
    )]);
    let server = acp_server_for_entry(github, MarketplaceAcpRuntime::Posix, &secrets)
        .expect("HTTP ACP entry");
    assert_eq!(server["type"], "http");
    assert_eq!(server["headers"][0]["name"], "Authorization");
    assert_eq!(
        server["headers"][0]["value"],
        "Bearer github-fixture-secret"
    );
    assert!(!serde_json::to_string(&server).unwrap().contains("$VAULT:"));
}

#[test]
fn project_marketplace_cleanup_preserves_user_sections() {
    let root = std::env::temp_dir().join(format!(
        "shellx-marketplace-cleanup-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let config_dir = root.join(".grok");
    std::fs::create_dir_all(&config_dir).unwrap();
    let config = config_dir.join("config.toml");
    std::fs::write(
            &config,
            "[mcp_servers.keep]\ncommand = \"keep\"\n\n# shellX:managed-mcp-marketplace:context7 BEGIN - do not edit by hand\n[mcp_servers.shellx-mp-context7]\ncommand = \"npx\"\n# shellX:managed-mcp-marketplace:context7 END\n",
        )
        .unwrap();

    assert!(cleanup_project_marketplace_config(&root).unwrap());
    let updated = std::fs::read_to_string(&config).unwrap();
    assert!(updated.contains("[mcp_servers.keep]"));
    assert!(!updated.contains("shellx-mp-context7"));
    assert!(!cleanup_project_marketplace_config(&root).unwrap());
    let _ = std::fs::remove_dir_all(&root);
}

const PROJECT_MIGRATION_CONFIG: &str = "[mcp_servers.keep]\ncommand = \"keep\"\n\n# shellX:managed-mcp-marketplace:context7 BEGIN - do not edit by hand\n[mcp_servers.shellx-mp-context7]\ncommand = \"npx\"\n# shellX:managed-mcp-marketplace:context7 END\n";

#[cfg(unix)]
#[test]
fn project_marketplace_cleanup_refuses_linked_directory_and_config() {
    let directory = tempfile::tempdir().unwrap();
    let project = directory.path().join("project");
    let outside = directory.path().join("outside");
    std::fs::create_dir(&project).unwrap();
    std::fs::create_dir(&outside).unwrap();
    let victim = outside.join("config.toml");
    std::fs::write(&victim, PROJECT_MIGRATION_CONFIG).unwrap();

    let config_dir = project.join(".grok");
    std::os::unix::fs::symlink(&outside, &config_dir).unwrap();
    assert!(cleanup_project_marketplace_config(&project).is_err());
    assert_eq!(
        std::fs::read_to_string(&victim).unwrap(),
        PROJECT_MIGRATION_CONFIG
    );

    std::fs::remove_file(&config_dir).unwrap();
    std::fs::create_dir(&config_dir).unwrap();
    std::os::unix::fs::symlink(&victim, config_dir.join("config.toml")).unwrap();
    assert!(cleanup_project_marketplace_config(&project).is_err());
    assert_eq!(
        std::fs::read_to_string(&victim).unwrap(),
        PROJECT_MIGRATION_CONFIG
    );
}

#[test]
fn project_marketplace_cleanup_refuses_multiply_linked_config() {
    let directory = tempfile::tempdir().unwrap();
    let project = directory.path().join("project");
    let config_dir = project.join(".grok");
    std::fs::create_dir_all(&config_dir).unwrap();
    let victim = directory.path().join("outside.toml");
    std::fs::write(&victim, PROJECT_MIGRATION_CONFIG).unwrap();
    std::fs::hard_link(&victim, config_dir.join("config.toml")).unwrap();
    assert!(cleanup_project_marketplace_config(&project).is_err());
    assert_eq!(
        std::fs::read_to_string(&victim).unwrap(),
        PROJECT_MIGRATION_CONFIG
    );
}

#[cfg(unix)]
#[test]
fn project_marketplace_cleanup_preserves_config_inode_and_mode() {
    use std::os::unix::fs::{MetadataExt as _, PermissionsExt as _};

    let directory = tempfile::tempdir().unwrap();
    let config_dir = directory.path().join(".grok");
    std::fs::create_dir(&config_dir).unwrap();
    let config = config_dir.join("config.toml");
    std::fs::write(&config, PROJECT_MIGRATION_CONFIG).unwrap();
    std::fs::set_permissions(&config, std::fs::Permissions::from_mode(0o640)).unwrap();
    let before = std::fs::metadata(&config).unwrap();
    assert!(cleanup_project_marketplace_config(directory.path()).unwrap());
    let after = std::fs::metadata(&config).unwrap();
    assert_eq!(after.ino(), before.ino());
    assert_eq!(after.permissions().mode() & 0o777, 0o640);
    let updated = std::fs::read_to_string(&config).unwrap();
    assert!(updated.contains("[mcp_servers.keep]"));
    assert!(!updated.contains("shellx-mp-context7"));
    assert!(!cleanup_project_marketplace_config(directory.path()).unwrap());
}

#[test]
fn grok_config_replacement_ignores_planted_predictable_temp_symlink() {
    let directory = tempfile::tempdir().unwrap();
    let config = directory.path().join("config.toml");
    let victim = directory.path().join("other.toml");
    let old_temp = config.with_extension(format!("toml.{}.tmp", std::process::id()));
    std::fs::write(&config, "[original]\nvalue = 1\n").unwrap();
    std::fs::write(&victim, "do not change").unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink(&victim, &old_temp).unwrap();
    #[cfg(windows)]
    if std::os::windows::fs::symlink_file(&victim, &old_temp).is_err() {
        // Windows installations without symlink privilege still run the
        // predictable-name collision case below.
        return;
    }
    write_grok_config_validated(&config, "[updated]\nvalue = 2\n").unwrap();
    assert_eq!(std::fs::read_to_string(&victim).unwrap(), "do not change");
    assert_eq!(
        std::fs::read_to_string(&config).unwrap(),
        "[updated]\nvalue = 2\n"
    );
    assert!(std::fs::symlink_metadata(&old_temp)
        .unwrap()
        .file_type()
        .is_symlink());
}

#[test]
fn grok_config_replacement_ignores_planted_predictable_temp_collision() {
    let directory = tempfile::tempdir().unwrap();
    let config = directory.path().join("config.toml");
    let old_temp = config.with_extension(format!("toml.{}.tmp", std::process::id()));
    std::fs::write(&config, "[original]\nvalue = 1\n").unwrap();
    std::fs::write(&old_temp, "keep this unrelated file").unwrap();
    write_grok_config_validated(&config, "[updated]\nvalue = 2\n").unwrap();
    assert_eq!(
        std::fs::read_to_string(&old_temp).unwrap(),
        "keep this unrelated file"
    );
    assert_eq!(
        std::fs::read_to_string(&config).unwrap(),
        "[updated]\nvalue = 2\n"
    );
}

#[test]
fn grok_config_replacement_preserves_existing_permissions_and_replaces_content() {
    let directory = tempfile::tempdir().unwrap();
    let config = directory.path().join("config.toml");
    std::fs::write(&config, "[original]\nvalue = 1\n").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&config, std::fs::Permissions::from_mode(0o640)).unwrap();
    }
    let before = std::fs::metadata(&config).unwrap().permissions();
    write_grok_config_validated(&config, "[updated]\nvalue = 2\n").unwrap();
    assert_eq!(
        std::fs::read_to_string(&config).unwrap(),
        "[updated]\nvalue = 2\n"
    );
    let after = std::fs::metadata(&config).unwrap().permissions();
    assert_eq!(after.readonly(), before.readonly());
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(after.mode() & 0o777, before.mode() & 0o777);
    }
    assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 1);
}

#[test]
fn strip_unmanaged_server_section_removes_main_and_headers_sections() {
    let source = r#"
[mcp_servers.keep]
command = "ok"

[mcp_servers.shellx-mp-demo]
url = "https://example.invalid/mcp"
enabled = true

[mcp_servers.shellx-mp-demo.headers]
Authorization = "Bearer nope"

[mcp_servers.shellx-mp-demo.env]
TOKEN = "nope"

[mcp_servers.after]
command = "still"
"#;
    let stripped = strip_unmanaged_server_section(source, "shellx-mp-demo");
    assert!(stripped.contains("[mcp_servers.keep]"));
    assert!(stripped.contains("[mcp_servers.after]"));
    assert!(!stripped.contains("shellx-mp-demo"));
}

#[test]
fn strip_unmanaged_server_section_removes_duplicate_sections() {
    let source = r#"
[mcp_servers.shellx-mp-demo]
url = "https://one.invalid"

[mcp_servers.keep]
command = "ok"

[mcp_servers.shellx-mp-demo]
url = "https://two.invalid"

[mcp_servers.shellx-mp-demo.env]
TOKEN = "nope"

[mcp_servers.shellx-mp-demo.env]
TOKEN = "still-nope"
"#;
    let stripped = strip_unmanaged_server_section(source, "shellx-mp-demo");
    assert!(stripped.contains("[mcp_servers.keep]"));
    assert!(!stripped.contains("shellx-mp-demo"));
    toml::from_str::<toml::Value>(&stripped).expect("stripped config should parse");
}

#[test]
fn strip_toml_section_preserves_following_shellx_sentinel() {
    let source = r#"
[mcp_servers.shellx-mp-demo.env]
TOKEN = "x"
# shellX:managed-mcp:grok-shell-host BEGIN - do not edit by hand
[mcp_servers.grok-shell-host]
command = "app"
"#;
    let stripped = strip_toml_section(source, "mcp_servers.shellx-mp-demo.env");

    assert!(!stripped.contains("TOKEN = \"x\""));
    assert!(stripped.contains("# shellX:managed-mcp:grok-shell-host BEGIN"));
    assert!(stripped.contains("[mcp_servers.grok-shell-host]"));
}

#[test]
fn section_enabled_defaults_true_and_respects_false() {
    assert!(section_enabled("[mcp_servers.x]\nurl = \"u\"\n"));
    assert!(!section_enabled(
        "[mcp_servers.x]\nurl = \"u\"\nenabled = false\n"
    ));
}
