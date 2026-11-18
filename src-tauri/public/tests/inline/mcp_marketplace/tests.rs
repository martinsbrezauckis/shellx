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
