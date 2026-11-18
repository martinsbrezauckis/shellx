use super::*;
use std::ffi::OsString;

struct HomeEnvGuard {
    old_home: Option<OsString>,
    old_userprofile: Option<OsString>,
}

impl HomeEnvGuard {
    fn set_home_only(home: &Path) -> Self {
        let old_home = std::env::var_os("HOME");
        let old_userprofile = std::env::var_os("USERPROFILE");
        unsafe {
            std::env::set_var("HOME", home);
            std::env::remove_var("USERPROFILE");
        }
        Self {
            old_home,
            old_userprofile,
        }
    }
}

impl Drop for HomeEnvGuard {
    fn drop(&mut self) {
        unsafe {
            match &self.old_home {
                Some(v) => std::env::set_var("HOME", v),
                None => std::env::remove_var("HOME"),
            }
            match &self.old_userprofile {
                Some(v) => std::env::set_var("USERPROFILE", v),
                None => std::env::remove_var("USERPROFILE"),
            }
        }
    }
}

#[test]
fn bundled_body_non_empty() {
    // Catches a build-time `include_str!` that points at the wrong
    // path producing an empty string. The real manifest ships with
    // YAML frontmatter so >100 bytes is a safe floor.
    assert!(BUNDLED_SKILL_BODY.len() > 100, "bundled body too small");
    assert!(BUNDLED_SKILL_BODY.contains("shellx-host"));
}

#[test]
fn legacy_workflow_skill_hashes_are_recorded_for_cleanup() {
    assert_eq!(
        LEGACY_WORKFLOW_SKILLS.len(),
        5,
        "cleanup should know every retired ShellX starter skill"
    );
    for skill in LEGACY_WORKFLOW_SKILLS {
        assert!(
            skill.id.starts_with("shellx-"),
            "{} should be namespaced to avoid upstream collisions",
            skill.id
        );
        assert!(
            skill.body_hash.len() == 64 && skill.body_hash.chars().all(|c| c.is_ascii_hexdigit()),
            "{} cleanup hash should be SHA-256 hex",
            skill.id,
        );
    }
}

#[test]
fn workflow_skill_statuses_are_empty_after_retirement() {
    assert!(
        workflow_skill_statuses().is_empty(),
        "retired workflow skills should not be advertised in the Plugins modal"
    );
}

#[test]
fn fresh_install_writes_shellx_host_manifest_only_to_product_docs() {
    let unique = format!("shellx-host-agent-docs-{}", uuid_like());
    let root = std::env::temp_dir().join(unique);
    std::fs::create_dir_all(&root).unwrap();

    let _env_lock = crate::test_env_lock();
    let _home_guard = HomeEnvGuard::set_home_only(&root);

    let changed = ensure_shellx_host_skill_installed().expect("install host skill docs");

    assert!(
        changed,
        "fresh home should report that at least one bundled skill/doc file was written"
    );
    let product_doc = root
        .join(".shellx")
        .join("agent-docs")
        .join("shellx-host")
        .join("SKILL.md");
    assert!(product_doc.is_file());
    assert_eq!(
        std::fs::read_to_string(&product_doc).unwrap(),
        BUNDLED_SKILL_BODY
    );
    for agent_dir in [".grok", ".codex", ".claude"] {
        assert!(
            !root
                .join(agent_dir)
                .join("skills")
                .join("shellx-host")
                .join("SKILL.md")
                .exists(),
            "fresh install must not expose shellx-host to direct {} sessions",
            agent_dir
        );
    }

    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn migration_removes_only_exact_legacy_global_host_skill_leaves() {
    let unique = format!("shellx-host-global-migration-{}", uuid_like());
    let root = std::env::temp_dir().join(unique);
    for agent_dir in [".grok", ".codex", ".claude"] {
        let skill_dir = root.join(agent_dir).join("skills").join("shellx-host");
        std::fs::create_dir_all(&skill_dir).unwrap();
        std::fs::write(skill_dir.join("SKILL.md"), "managed by old ShellX\n").unwrap();
    }
    let preserved = root
        .join(".codex")
        .join("skills")
        .join("shellx-host")
        .join("user-note.md");
    std::fs::write(&preserved, "keep\n").unwrap();

    let _env_lock = crate::test_env_lock();
    let _home_guard = HomeEnvGuard::set_home_only(&root);
    assert_eq!(cleanup_legacy_global_shellx_host_skills().unwrap(), 3);

    assert!(preserved.is_file(), "user sibling must be preserved");
    for agent_dir in [".grok", ".codex", ".claude"] {
        assert!(!root
            .join(agent_dir)
            .join("skills")
            .join("shellx-host")
            .join("SKILL.md")
            .exists());
    }

    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn legacy_cleanup_removes_only_matching_skill_file() {
    let unique = format!("shellx-legacy-cleanup-{}", uuid_like());
    let root = std::env::temp_dir().join(unique);
    let skill_dir = root.join(".grok").join("skills").join("shellx-old");
    let target = skill_dir.join("SKILL.md");
    let user_note = skill_dir.join("notes.txt");
    let body = "old managed skill body\n";
    std::fs::create_dir_all(&skill_dir).unwrap();
    std::fs::write(&target, body).unwrap();
    std::fs::write(&user_note, "keep user-added file\n").unwrap();

    let removed = cleanup_legacy_skill_path(&target, &body_sha256_hex(body), "shellx-old").unwrap();

    assert!(removed, "matching legacy skill file should be removed");
    assert!(
        !target.exists(),
        "managed SKILL.md should be removed after exact hash match"
    );
    assert!(
        user_note.exists(),
        "cleanup must not delete user-added files in the skill directory"
    );

    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn legacy_cleanup_keeps_drifted_skill_file() {
    let unique = format!("shellx-legacy-keep-{}", uuid_like());
    let root = std::env::temp_dir().join(unique);
    let target = root
        .join(".grok")
        .join("skills")
        .join("shellx-old")
        .join("SKILL.md");
    std::fs::create_dir_all(target.parent().unwrap()).unwrap();
    std::fs::write(&target, "user edited body\n").unwrap();

    let removed = cleanup_legacy_skill_path(
        &target,
        &body_sha256_hex("old managed body\n"),
        "shellx-old",
    )
    .unwrap();

    assert!(
        !removed,
        "drifted or user-edited skill files must not be removed"
    );
    assert!(target.exists(), "drifted skill file should remain");

    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn body_sha256_is_64_hex_chars() {
    let h = body_sha256_hex("hello");
    assert_eq!(h.len(), 64);
    assert!(h
        .chars()
        .all(|c| c.is_ascii_hexdigit() && !c.is_uppercase()));
}

#[test]
fn body_sha256_known_vector() {
    // SHA-256("") = e3b0c442... — RFC test vector. Confirms our hex
    // encoding matches the canonical lowercase hex form.
    assert_eq!(
        body_sha256_hex(""),
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
}

/// Behavior test: fresh install writes the body and parent dir.
/// Uses an OS tempdir so we don't race on HOME/USERPROFILE.
#[test]
fn ensure_installed_at_writes_on_fresh_target() {
    // std::env::temp_dir is shared across tests but each test picks
    // its own unique subdir name to avoid collisions under
    // `cargo test` parallel runner.
    let unique = format!("shellx-host-test-fresh-{}", uuid_like());
    let root = std::env::temp_dir().join(unique);
    let target = root.join("skills").join("shellx-host").join("SKILL.md");

    let body = "# shellx-host\nhello world\n";
    let r = ensure_installed_at(&target, body).expect("install");
    assert!(r, "first install must return Ok(true)");
    assert!(target.is_file());
    let on_disk = std::fs::read_to_string(&target).expect("read");
    assert_eq!(on_disk, body);

    // Cleanup. Best-effort; tempdir leaks are harmless.
    let _ = std::fs::remove_dir_all(&root);
}

/// Behavior test: re-install with identical body is a no-op
/// (returns Ok(false)) and does NOT rewrite the file.
#[test]
fn ensure_installed_at_skips_when_bytes_match() {
    let unique = format!("shellx-host-test-skip-{}", uuid_like());
    let root = std::env::temp_dir().join(unique);
    let target = root.join("skills").join("shellx-host").join("SKILL.md");

    let body = "# shellx-host\nskip me\n";
    assert!(ensure_installed_at(&target, body).expect("first"));
    // mtime can be flaky in CI tempfs, so we don't compare mtimes.
    // The Ok(false) return is the contract; we assert that.
    let r = ensure_installed_at(&target, body).expect("second");
    assert!(
        !r,
        "second install with identical body must return Ok(false)"
    );

    let _ = std::fs::remove_dir_all(&root);
}

/// Behavior test: when on-disk bytes differ from the body argument,
/// the installer overwrites and returns Ok(true).
#[test]
fn ensure_installed_at_overwrites_when_bytes_drift() {
    let unique = format!("shellx-host-test-drift-{}", uuid_like());
    let root = std::env::temp_dir().join(unique);
    let target = root.join("skills").join("shellx-host").join("SKILL.md");

    // Seed with a divergent body (simulates user edit OR an older
    // shellX binary that shipped a different manifest).
    std::fs::create_dir_all(target.parent().unwrap()).unwrap();
    std::fs::write(&target, "old content").unwrap();

    let new_body = "# shellx-host\nfresh\n";
    let r = ensure_installed_at(&target, new_body).expect("install");
    assert!(r, "drifted target must overwrite + return Ok(true)");
    assert_eq!(std::fs::read_to_string(&target).unwrap(), new_body);

    let _ = std::fs::remove_dir_all(&root);
}

#[cfg(unix)]
#[test]
fn ensure_installed_at_rejects_symlink_leaf() {
    use std::os::unix::fs::symlink;

    let unique = format!("shellx-host-test-symlink-{}", uuid_like());
    let root = std::env::temp_dir().join(unique);
    let target = root.join("skills").join("shellx-host").join("SKILL.md");
    let outside = root.join("outside.md");
    std::fs::create_dir_all(target.parent().unwrap()).unwrap();
    std::fs::write(&outside, "outside").unwrap();
    symlink(&outside, &target).unwrap();

    let err = ensure_installed_at(&target, "# shellx-host\nfresh\n")
        .expect_err("installer must not follow a symlink leaf");
    assert!(err.contains("symlink"), "unexpected error: {err}");
    assert_eq!(std::fs::read_to_string(&outside).unwrap(), "outside");

    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn strip_shellx_managed_blocks_removes_legacy_and_current_blocks() {
    let source = concat!(
            "# user rules\n\n",
            "<!-- BEGIN shellX-managed (legacy - do not edit between markers; shellX rewrites this section on session start) -->\n",
            "old routing\n",
            "<!-- END shellX-managed -->\n\n",
            "keep me\n\n",
            "<!-- BEGIN shellX-managed (do not edit between markers; shellX rewrites this section on session start) -->\n",
            "newer duplicate\n",
            "<!-- END shellX-managed -->\n",
            "tail\n",
        );
    let cleaned = strip_shellx_managed_blocks(source);
    assert!(cleaned.contains("# user rules"));
    assert!(cleaned.contains("keep me"));
    assert!(cleaned.contains("tail"));
    assert!(!cleaned.contains("old routing"));
    assert!(!cleaned.contains("newer duplicate"));
    assert!(!cleaned.contains(MANAGED_AGENTS_BEGIN_PREFIX));
    assert!(!cleaned.contains(MANAGED_AGENTS_END));
}

#[test]
fn cleanup_does_not_append_a_new_managed_block() {
    let cleaned = strip_shellx_managed_blocks(concat!(
        "prefix\n",
        "<!-- BEGIN shellX-managed (old marker) -->\n",
        "stale\n",
        "<!-- END shellX-managed -->\n",
    ));
    assert_eq!(cleaned.matches(MANAGED_AGENTS_BEGIN_PREFIX).count(), 0);
    assert_eq!(cleaned.matches(MANAGED_AGENTS_END).count(), 0);
    assert!(cleaned.contains("prefix"));
    assert!(!cleaned.contains("stale"));
}

#[test]
fn cleanup_agents_guidance_removes_legacy_hint_without_replacement() {
    let source = format!(
        "# Behavior rules\n\n{}\n\n{}",
        LEGACY_SEARCH_TOOL_GUIDANCE,
        concat!(
            "<!-- BEGIN shellX-managed (old marker) -->\n",
            "stale managed body\n",
            "<!-- END shellX-managed -->\n",
        )
    );

    let out = clean_legacy_shellx_agents_guidance(&strip_shellx_managed_blocks(&source));

    assert!(!out.contains(LEGACY_SEARCH_TOOL_GUIDANCE));
    assert!(!out.contains("stale managed body"));
    assert!(!out.contains(UPDATED_SEARCH_TOOL_GUIDANCE));
    assert_eq!(out.matches(MANAGED_AGENTS_BEGIN_PREFIX).count(), 0);
    assert_eq!(out.matches(MANAGED_AGENTS_END).count(), 0);
}

#[test]
fn migration_removes_disabled_global_host_mcp_and_preserves_user_config() {
    let unique = format!("shellx-grok-mcp-migration-{}", uuid_like());
    let root = std::env::temp_dir().join(unique);
    let config = root.join(".grok").join("config.toml");
    std::fs::create_dir_all(config.parent().unwrap()).unwrap();

    std::fs::write(
        &config,
        concat!(
            "[mcp_servers.keep]\ncommand = \"/bin/echo\"\n\n",
            "# # shellX:managed-mcp:grok-shell-host BEGIN — do not edit by hand\n",
            "# [mcp_servers.grok-shell-host]\n",
            "# command = \"/old/shellx\"\n",
            "# args = [\"--mcp-server\"]\n",
            "# # shellX:managed-mcp:grok-shell-host END\n",
        ),
    )
    .unwrap();

    let changed = cleanup_grok_host_mcp_config_at(&config).expect("cleanup");

    assert!(changed, "legacy global block should be removed");
    let rewritten = std::fs::read_to_string(&config).unwrap();
    assert!(!rewritten.contains(MCP_BEGIN_NEEDLE));
    assert!(!rewritten.contains("/old/shellx"));
    assert!(rewritten.contains("[mcp_servers.keep]"));

    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn project_cleanup_removes_shellx_host_mcp_and_preserves_user_servers() {
    let unique = format!("shellx-project-mcp-cleanup-{}", uuid_like());
    let root = std::env::temp_dir().join(unique);
    let config = root.join(".grok").join("config.toml");
    std::fs::create_dir_all(config.parent().unwrap()).unwrap();
    std::fs::write(
        &config,
        format!(
            "[mcp_servers.keep]\ncommand = \"/bin/echo\"\n\n{}\n\
                 [mcp_servers.shellx-host-http]\n\
                 url = \"http://localhost:5758/mcp\"\n\
                 [mcp_servers.shellx-host-http.headers]\n\
                 MCP-Tab-Id = \"tab-old\"\n\
                 {}\n",
            crate::mcp_http::HTTP_SNIPPET_BEGIN,
            crate::mcp_http::HTTP_SNIPPET_END,
        ),
    )
    .unwrap();

    let changed = cleanup_project_grok_host_mcp_config(&root).expect("project cleanup");

    assert!(changed);
    let rewritten = std::fs::read_to_string(&config).unwrap();
    assert!(rewritten.contains("[mcp_servers.keep]"));
    assert!(!rewritten.contains("shellx-host-http"));
    assert!(!rewritten.contains("tab-old"));

    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn strip_unmanaged_section_preserves_following_shellx_sentinel() {
    let source = concat!(
        "[mcp_servers.grok-shell-host]\n",
        "command = \"/old/shellx\"\n",
        "# shellX:managed-mcp-marketplace:context7 BEGIN - do not edit by hand\n",
        "[mcp_servers.shellx-mp-context7]\n",
        "command = \"cmd.exe\"\n",
    );
    let stripped = strip_unmanaged_section(source, "mcp_servers.grok-shell-host");

    assert!(!stripped.contains("/old/shellx"));
    assert!(stripped.contains("# shellX:managed-mcp-marketplace:context7 BEGIN"));
    assert!(stripped.contains("[mcp_servers.shellx-mp-context7]"));
}

#[test]
fn orphan_host_mcp_sentinel_lines_are_removed() {
    let source = concat!(
        "[ui]\n",
        "permission_mode = \"always-approve\"\n",
        "# shellX:managed-mcp:grok-shell-host END\n",
        "# shellX:managed-mcp-marketplace:context7 BEGIN - do not edit by hand\n",
        "[mcp_servers.shellx-mp-context7]\n",
        "command = \"cmd.exe\"\n",
    );
    let stripped = strip_orphan_managed_sentinel_lines(source, MCP_BEGIN_NEEDLE, MCP_END_NEEDLE);

    assert!(!stripped.contains("grok-shell-host END"));
    assert!(stripped.contains("# shellX:managed-mcp-marketplace:context7 BEGIN"));
    assert!(stripped.contains("[mcp_servers.shellx-mp-context7]"));
}

#[test]
fn ensure_project_mcp_http_config_removes_unmanaged_shellx_host_http_sections() {
    let unique = format!("shellx-project-mcp-config-{}", uuid_like());
    let root = std::env::temp_dir().join(unique);
    let config = root.join(".grok").join("config.toml");
    std::fs::create_dir_all(config.parent().unwrap()).unwrap();
    std::fs::write(
        &config,
        concat!(
            "[mcp_servers.user]\n",
            "command = \"/bin/echo\"\n\n",
            "# orphan from a crashed prior shellX process\n",
            "[mcp_servers.shellx-host-http]\n",
            "url = \"http://localhost:5762/mcp\"\n",
            "enabled = true\n",
            "[mcp_servers.shellx-host-http.headers]\n",
            "MCP-Tab-Id = \"stale-tab\"\n\n",
            "[mcp_servers.shellx-host-http]\n",
            "url = \"http://localhost:5763/mcp\"\n",
            "enabled = true\n",
            "[mcp_servers.shellx-host-http.headers]\n",
            "MCP-Tab-Id = \"stale-tab-2\"\n\n",
            "[mcp_servers.keep-me]\n",
            "url = \"http://localhost:9999/mcp\"\n",
        ),
    )
    .unwrap();

    let changed = ensure_project_mcp_http_config(
        &root,
        5764,
        "0123456789abcdef0123456789abcdef",
        "fresh-tab",
        "",
    )
    .expect("rewrite project MCP config");
    assert!(
        changed,
        "orphan shellx-host-http section should be rewritten"
    );

    let rewritten = std::fs::read_to_string(&config).unwrap();
    assert_eq!(
        rewritten.matches("[mcp_servers.shellx-host-http]").count(),
        1,
        "rewritten config must contain exactly one shellx-host-http table:\n{}",
        rewritten
    );
    assert_eq!(
        rewritten
            .matches("[mcp_servers.shellx-host-http.headers]")
            .count(),
        1,
        "rewritten config must contain exactly one shellx-host-http headers table:\n{}",
        rewritten
    );
    assert!(
        !rewritten.contains("stale-tab"),
        "orphan header survived:\n{}",
        rewritten
    );
    assert!(rewritten.contains("MCP-Tab-Id = \"fresh-tab\""));
    assert!(rewritten.contains("[mcp_servers.user]"));
    assert!(rewritten.contains("[mcp_servers.keep-me]"));
    toml::from_str::<toml::Value>(&rewritten).expect("rewritten config should parse as TOML");

    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn ensure_project_mcp_http_config_excludes_shellx_artifacts_locally() {
    let unique = format!("shellx-project-mcp-exclude-{}", uuid_like());
    let root = std::env::temp_dir().join(unique);
    let project = root.join("work").join("sdk");
    let git_info = root.join(".git").join("info");
    std::fs::create_dir_all(&project).unwrap();
    let initialized = std::process::Command::new("git")
        .args(["init", "--quiet"])
        .arg(&root)
        .status()
        .expect("git must initialize the project exclusion fixture");
    assert!(
        initialized.success(),
        "git init failed for project exclusion fixture"
    );

    let changed = ensure_project_mcp_http_config(
        &project,
        5764,
        "0123456789abcdef0123456789abcdef",
        "fresh-tab",
        "",
    )
    .expect("write project MCP config and local git excludes");
    assert!(changed, "first run should write config and git exclude");

    let exclude = std::fs::read_to_string(git_info.join("exclude")).unwrap();
    assert!(exclude.contains(MCP_ARTIFACT_EXCLUDE_BEGIN));
    assert!(exclude.contains("/work/sdk/.grok/config.toml"));
    assert!(exclude.contains("/work/sdk/mcps/"));
    assert_eq!(
        exclude.matches(MCP_ARTIFACT_EXCLUDE_BEGIN).count(),
        1,
        "managed exclude block should not duplicate:\n{}",
        exclude
    );

    let changed_again = ensure_project_mcp_http_config(
        &project,
        5764,
        "0123456789abcdef0123456789abcdef",
        "fresh-tab",
        "",
    )
    .expect("second run should be idempotent");
    assert!(
        !changed_again,
        "matching config and git exclude should be idempotent"
    );

    let _ = std::fs::remove_dir_all(&root);
}

/// Tiny uuid-like helper for test scratch-dir names. Avoids pulling
/// uuid into dev-deps just for tests — process id + nanos is unique
/// enough across `cargo test --test-threads=N`.
fn uuid_like() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{}-{}", std::process::id(), nanos)
}

#[test]
fn target_path_uses_home_under_unix() {
    if cfg!(target_os = "windows") {
        return; // covered by the Windows-only variant in CI later.
    }
    // Don't poke at the actual env: we'd race with parallel tests.
    // Just sanity-check the public function returns a non-empty
    // suffix matching `.shellx/agent-docs/shellx-host/SKILL.md`.
    if let Some(p) = target_skill_path() {
        let s = p.to_string_lossy();
        assert!(
            s.ends_with(".shellx/agent-docs/shellx-host/SKILL.md"),
            "unexpected target path: {}",
            s
        );
    }
    // If HOME is somehow unset, target_skill_path returns None;
    // that's accepted at the caller (returns soft warning).
}
