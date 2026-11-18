use super::*;
use std::ops::Deref;
use std::sync::atomic::{AtomicU32, Ordering};

static COUNTER: AtomicU32 = AtomicU32::new(0);

struct TempConnectionStore(ConnectionStore);

impl Deref for TempConnectionStore {
    type Target = ConnectionStore;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl Drop for TempConnectionStore {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0.path);
    }
}

/// Each test gets its own connections.json path so the global file
/// in $HOME isn't touched. The Mutex around state is local to the
/// instance, so concurrent tests are isolated.
fn temp_store() -> TempConnectionStore {
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    let path = std::env::temp_dir().join(format!(
        "grok-shell-connections-test-{}-{}.json",
        std::process::id(),
        n
    ));
    let _ = std::fs::remove_file(&path);
    TempConnectionStore(ConnectionStore {
        path,
        state: Mutex::new(vec![]),
    })
}

fn temp_connections_root() -> std::path::PathBuf {
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    std::env::temp_dir().join(format!(
        "shellx-connections-migrate-test-{}-{}",
        std::process::id(),
        n,
    ))
}

fn preset_with_id(id: &str, label: &str) -> ConnectionPreset {
    ConnectionPreset {
        id: id.to_string(),
        label: label.to_string(),
        transport: Transport::Local { grok_path: None },
        created_ms: 1,
        last_used_ms: 0,
        provider_scan: Vec::new(),
    }
}

fn write_test_store(path: &PathBuf, presets: &[ConnectionPreset]) {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).expect("mk store parent");
    }
    persist(path, presets).expect("write test store");
}

fn read_test_store(path: &PathBuf) -> StoreFile {
    read_store_file(path, "test").expect("read test store")
}

#[tokio::test]
async fn reload_waits_for_writer_before_reading_disk() {
    use std::future::Future;
    use std::task::{Context, Waker};

    let store = temp_store();
    store
        .save(preset_with_id("conn-owned", "before"))
        .await
        .expect("initial save");
    let mut writer = store.state.lock().await;
    let mut reload = Box::pin(store.reload_from_disk());
    let mut context = Context::from_waker(Waker::noop());
    assert!(reload.as_mut().poll(&mut context).is_pending());

    // Complete a writer's disk/cache update while reload waits for its
    // lock. Reload must not later publish bytes read before this update.
    let latest = preset_with_id("conn-owned", "after");
    write_test_store(&store.path, std::slice::from_ref(&latest));
    *writer = vec![latest];
    drop(writer);
    reload.await.expect("reload after writer");
    assert_eq!(store.list().await[0].label, "after");
    assert_eq!(read_test_store(&store.path).presets[0].label, "after");
}

#[tokio::test]
async fn save_list_delete_roundtrip() {
    let store = temp_store();
    let p = ConnectionPreset::new("self".to_string(), Transport::Local { grok_path: None });
    let saved = store.save(p.clone()).await.expect("save ok");
    assert_eq!(saved.label, "self");
    let listed = store.list().await;
    assert_eq!(listed.len(), 1);
    let removed = store.delete(&saved.id).await.expect("delete ok");
    assert!(removed);
    assert!(store.list().await.is_empty());
}

#[test]
fn legacy_connection_migration_renames_when_canonical_missing() {
    let root = temp_connections_root();
    let canon = root.join(".shellx").join("connections.json");
    let legacy = root.join(".grok-shell").join("connections.json");
    write_test_store(&legacy, &[preset_with_id("conn-legacy", "Legacy")]);

    migrate_legacy_connections_file_if_needed(&canon, &legacy);

    assert!(
        !legacy.exists(),
        "legacy file should be moved when canonical is missing"
    );
    let migrated = read_test_store(&canon);
    assert_eq!(migrated.presets.len(), 1);
    assert_eq!(migrated.presets[0].id, "conn-legacy");
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn legacy_connection_migration_merges_missing_presets_without_clobbering() {
    let root = temp_connections_root();
    let canon = root.join(".shellx").join("connections.json");
    let legacy = root.join(".grok-shell").join("connections.json");
    write_test_store(
        &canon,
        &[
            preset_with_id("conn-shared", "Canonical wins"),
            preset_with_id("conn-current", "Current only"),
        ],
    );
    write_test_store(
        &legacy,
        &[
            preset_with_id("conn-shared", "Legacy duplicate"),
            preset_with_id("conn-legacy", "Legacy only"),
        ],
    );

    migrate_legacy_connections_file_if_needed(&canon, &legacy);

    assert!(legacy.exists(), "merge should leave legacy file as backup");
    let merged = read_test_store(&canon);
    assert_eq!(merged.presets.len(), 3);
    assert_eq!(
        merged
            .presets
            .iter()
            .find(|preset| preset.id == "conn-shared")
            .map(|preset| preset.label.as_str()),
        Some("Canonical wins"),
        "canonical preset must not be overwritten by legacy duplicate",
    );
    assert!(
        merged
            .presets
            .iter()
            .any(|preset| preset.id == "conn-legacy"),
        "missing legacy preset should be imported",
    );
    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn save_rejects_blank_label() {
    let store = temp_store();
    let p = ConnectionPreset::new("".to_string(), Transport::Local { grok_path: None });
    assert!(store.save(p).await.is_err());
}

#[tokio::test]
async fn save_rejects_ssh_host_option_injection() {
    let store = temp_store();
    let p = ConnectionPreset::new(
        "ssh".to_string(),
        Transport::Ssh {
            host: "-oProxyCommand=calc".to_string(),
            port: None,
            key_vault_ref: None,
            remote_grok_path: "grok".to_string(),
            remote_runtime: crate::acp::SshRemoteRuntime::Posix,
            wsl_distro: None,
        },
    );
    let err = store.save(p).await.expect_err("ssh option host rejected");
    assert!(err.contains("cannot start with '-'"));
}

#[tokio::test]
async fn save_rejects_ssh_remote_grok_path_option_injection() {
    let store = temp_store();
    let p = ConnectionPreset::new(
        "ssh".to_string(),
        Transport::Ssh {
            host: "user@example.com".to_string(),
            port: None,
            key_vault_ref: None,
            remote_grok_path: "-oProxyCommand=calc".to_string(),
            remote_runtime: crate::acp::SshRemoteRuntime::Posix,
            wsl_distro: None,
        },
    );
    let err = store
        .save(p)
        .await
        .expect_err("remote grok path option should be rejected");
    assert!(
        err.contains("remote_grok_path") && err.contains("cannot start with '-'"),
        "unexpected error: {err}"
    );
}

#[tokio::test]
async fn save_rejects_wsl_distro_on_native_windows_runtime() {
    let store = temp_store();
    let p = ConnectionPreset::new(
        "windows ssh".to_string(),
        Transport::Ssh {
            host: "user@windows-host".to_string(),
            port: None,
            key_vault_ref: None,
            remote_grok_path: r"C:\Users\FixtureUser\.grok\bin\grok.exe".to_string(),
            remote_runtime: crate::acp::SshRemoteRuntime::Windows,
            wsl_distro: Some("Ubuntu".to_string()),
        },
    );
    let err = store
        .save(p)
        .await
        .expect_err("native Windows runtime must reject a WSL distro");
    assert!(err.contains("wslDistro must be empty"));
}

#[test]
fn native_windows_agent_discovery_uses_get_command_and_bounded_names() {
    let script = remote_windows_command_find_binary(&["codex.exe", "codex"]);
    assert!(script.contains("Get-Command"));
    assert!(script.contains("'codex.exe','codex'"));
    assert!(script.contains("$env:APPDATA"));
    assert!(!script.contains("bash"));
}

#[test]
fn configured_grok_discovery_never_falls_back_to_another_binary() {
    let windows =
        remote_windows_command_find_configured_binary(r"C:\Users\Fixture\.grok\bin\grok.exe");
    assert!(windows.contains(r"C:\Users\Fixture\.grok\bin\grok.exe"));
    assert!(windows.ends_with("exit 1"));
    assert_eq!(windows.matches("Get-Command").count(), 1);
    assert!(!windows.contains("foreach($n"));

    let posix = remote_posix_command_find_configured_binary("/home/fixture/.grok/bin/grok");
    assert!(posix.contains("/home/fixture/.grok/bin/grok"));
    assert!(posix.ends_with("exit 1; fi"));
    assert!(!posix.contains("$HOME/.grok/bin"));
}

#[test]
fn remote_grok_path_must_match_the_explicit_ssh_runtime_frame() {
    assert!(validate_remote_grok_path_arg(
        r"C:\Users\Fixture\.grok\bin\grok.exe",
        crate::acp::SshRemoteRuntime::Windows,
    )
    .is_ok());
    assert!(validate_remote_grok_path_arg(
        "/home/fixture/.grok/bin/grok",
        crate::acp::SshRemoteRuntime::WindowsWsl,
    )
    .is_ok());
    assert!(validate_remote_grok_path_arg("grok", crate::acp::SshRemoteRuntime::Windows,).is_ok());
    assert!(validate_remote_grok_path_arg(
        "/home/fixture/.grok/bin/grok",
        crate::acp::SshRemoteRuntime::Windows,
    )
    .unwrap_err()
    .contains("absolute Windows"));
    assert!(validate_remote_grok_path_arg(
        r"C:\Users\Fixture\.grok\bin\grok.exe",
        crate::acp::SshRemoteRuntime::WindowsWsl,
    )
    .unwrap_err()
    .contains("absolute POSIX"));
    assert!(validate_remote_grok_path_arg(
        "relative/.grok/bin/grok",
        crate::acp::SshRemoteRuntime::Posix,
    )
    .unwrap_err()
    .contains("absolute POSIX"));
}

#[tokio::test]
async fn save_rejects_wsl_distro_on_posix_ssh_runtime() {
    let store = temp_store();
    let preset = ConnectionPreset::new(
        "POSIX SSH".to_string(),
        Transport::Ssh {
            host: "user@example.test".to_string(),
            port: None,
            key_vault_ref: None,
            remote_grok_path: "grok".to_string(),
            remote_runtime: crate::acp::SshRemoteRuntime::Posix,
            wsl_distro: Some("Ubuntu".to_string()),
        },
    );
    let error = store
        .save(preset)
        .await
        .expect_err("POSIX SSH must not retain a Windows WSL distro");
    assert!(error.contains("only valid for Windows + WSL"));
}

#[test]
fn capability_target_keys_distinguish_native_windows_windows_wsl_and_posix_ssh() {
    let make = |runtime, distro: Option<&str>| {
        ConnectionPreset::new(
            "target".to_string(),
            Transport::Ssh {
                host: "User@Example.test".to_string(),
                port: Some(2222),
                key_vault_ref: Some("ssh/test".to_string()),
                remote_grok_path: "grok".to_string(),
                remote_runtime: runtime,
                wsl_distro: distro.map(str::to_string),
            },
        )
    };
    let posix =
        connection_provider_capability_target(&make(crate::acp::SshRemoteRuntime::Posix, None));
    let windows =
        connection_provider_capability_target(&make(crate::acp::SshRemoteRuntime::Windows, None));
    let windows_wsl = connection_provider_capability_target(&make(
        crate::acp::SshRemoteRuntime::WindowsWsl,
        Some("Ubuntu-24.04"),
    ));

    assert_eq!(posix.key, "ssh:posix:User@example.test:2222");
    assert_eq!(windows.key, "ssh:windows:User@example.test:2222");
    assert_eq!(
        windows_wsl.key,
        "ssh:windows_wsl:User@example.test:2222:wsl=ubuntu-24.04"
    );
    assert_eq!(windows.runtime, "windows");
    assert_eq!(windows_wsl.runtime, "windows_wsl");
    assert_ne!(posix.key, windows.key);
    assert_ne!(windows.key, windows_wsl.key);
    assert!(
        !windows.key.contains("ssh/test"),
        "target key must not expose the Vault key reference"
    );
}

#[test]
fn capability_snapshot_reports_typed_probe_state_and_freshness() {
    let preset = ConnectionPreset::new("local".to_string(), Transport::Local { grok_path: None });
    let (status, detail) = connection_provider_scan_status(Some("/bin/codex"), None, None, None);
    assert_eq!(status, ConnectionProviderScanStatus::VersionFailed);
    assert!(detail
        .as_deref()
        .is_some_and(|value| value.contains("--version")));
    let target = connection_provider_capability_target(&preset);
    let snapshot = connection_provider_capability_snapshot_from_parts(
        &preset,
        vec![ConnectionProviderScanEntry {
            provider_id: "codex-cli".to_string(),
            can_run: true,
            status,
            binary: Some("/bin/codex".to_string()),
            version: None,
            binary_sha256: None,
            binary_bytes: None,
            target_key: target.key.clone(),
            detail,
            checked_at_ms: 1_780_000_030_000,
        }],
        1_780_000_040_000,
    );

    assert_eq!(snapshot.schema_version, PROVIDER_CAPABILITY_SCHEMA_VERSION);
    assert_eq!(snapshot.generated_at_ms, 1_780_000_040_000);
    assert_eq!(snapshot.fresh_until_ms, 1_780_000_100_000);
    assert_eq!(snapshot.providers[0].target_key, snapshot.target.key);
    assert_eq!(
        snapshot.providers[0].status,
        ConnectionProviderScanStatus::VersionFailed
    );
}

#[test]
fn capability_scan_requires_exact_binary_identity_before_ready() {
    let digest = "a".repeat(64);
    let (ready, ready_detail) = connection_provider_scan_status(
        Some("/bin/codex"),
        Some("codex 1.2.3"),
        Some(&digest),
        Some(4096),
    );
    assert_eq!(ready, ConnectionProviderScanStatus::Ready);
    assert!(ready_detail.is_none());

    let (failed, detail) =
        connection_provider_scan_status(Some("/bin/codex"), Some("codex 1.2.3"), None, None);
    assert_eq!(failed, ConnectionProviderScanStatus::IdentityFailed);
    assert!(detail
        .as_deref()
        .is_some_and(|value| value.contains("hash/size")));
}

#[test]
fn binary_identity_parser_rejects_partial_or_trailing_output() {
    let digest = "b".repeat(64);
    assert_eq!(
        parse_provider_binary_identity(&format!("{digest} 123\n")),
        Ok((digest.clone(), 123)),
    );
    assert!(parse_provider_binary_identity(&digest).is_err());
    assert!(parse_provider_binary_identity(&format!("{digest} 0")).is_err());
    assert!(parse_provider_binary_identity(&format!("{digest} 123 extra")).is_err());
}

#[test]
fn local_binary_identity_streams_exact_file_hash_and_size() {
    let root = temp_connections_root();
    std::fs::create_dir_all(&root).expect("create provider fixture root");
    let path = root.join("provider-fixture.bin");
    std::fs::write(&path, b"abc").expect("write provider fixture");
    let identity = hash_local_provider_binary(&path).expect("hash provider fixture");
    assert_eq!(
        identity,
        (
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad".to_string(),
            3,
        )
    );
    let _ = std::fs::remove_dir_all(root);
}

#[cfg(unix)]
#[tokio::test]
async fn local_capability_refresh_observes_replaced_version_and_identity() {
    use std::os::unix::fs::PermissionsExt as _;

    let root = temp_connections_root();
    std::fs::create_dir_all(&root).expect("create provider refresh fixture root");
    let binary = root.join("grok");
    let write_version = |version: &str| {
        std::fs::write(
                &binary,
                format!("#!/bin/sh\n[ \"$1\" = \"--version\" ] || exit 64\nprintf '%s\\n' 'grok {version}'\n"),
            )
            .expect("write provider refresh fixture");
        std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o700))
            .expect("make provider refresh fixture executable");
    };
    write_version("fixture-1.0.0");
    let preset = ConnectionPreset::new(
        "owned refresh".to_string(),
        Transport::Local {
            grok_path: Some(binary.to_string_lossy().to_string()),
        },
    );
    let first = scan_connection_provider_capabilities(&preset)
        .await
        .expect("first exact-target capability scan");
    write_version("fixture-2.0.0");
    let second = scan_connection_provider_capabilities(&preset)
        .await
        .expect("second exact-target capability scan");
    let first_grok = first
        .providers
        .iter()
        .find(|row| row.provider_id == "grok")
        .unwrap();
    let second_grok = second
        .providers
        .iter()
        .find(|row| row.provider_id == "grok")
        .unwrap();
    assert_eq!(first_grok.version.as_deref(), Some("grok fixture-1.0.0"));
    assert_eq!(second_grok.version.as_deref(), Some("grok fixture-2.0.0"));
    assert_eq!(second_grok.status, ConnectionProviderScanStatus::Ready);
    assert_ne!(first_grok.binary_sha256, second_grok.binary_sha256);
    assert!(first_grok.binary_bytes.is_some_and(|bytes| bytes > 0));
    assert_eq!(first_grok.binary_bytes, second_grok.binary_bytes);
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn capability_target_errors_distinguish_auth_runtime_and_reachability() {
    let preset = ConnectionPreset::new(
        "ssh".to_string(),
        Transport::Ssh {
            host: "host.example".to_string(),
            port: None,
            key_vault_ref: None,
            remote_grok_path: "grok".to_string(),
            remote_runtime: crate::acp::SshRemoteRuntime::Windows,
            wsl_distro: None,
        },
    );
    assert_eq!(
        connection_provider_target_error_status(&preset, "Permission denied (publickey)"),
        Some(ConnectionProviderScanStatus::AuthNeeded)
    );
    assert_eq!(
        connection_provider_target_error_status(&preset, "Native Windows SSH runtime probe failed"),
        Some(ConnectionProviderScanStatus::CanaryFailed)
    );
    assert_eq!(
        connection_provider_target_error_status(&preset, "connection timed out"),
        Some(ConnectionProviderScanStatus::TargetUnavailable)
    );
    assert_eq!(
        connection_provider_target_error_status(
            &preset,
            "SSH key Vault ref connections.key is not set"
        ),
        None
    );
}

#[test]
fn remote_shell_prelude_includes_macos_homebrew_bins() {
    let prelude = remote_shell_prelude();
    assert!(prelude.contains("/opt/homebrew/bin"));
    assert!(prelude.contains("/usr/local/bin"));
    assert!(prelude.contains("$HOME/.nvm/nvm.sh"));
}

#[tokio::test]
async fn save_preserves_created_on_update() {
    let store = temp_store();
    let p = ConnectionPreset::new("alpha".to_string(), Transport::Local { grok_path: None });
    let saved = store.save(p).await.expect("save ok");
    let created_then = saved.created_ms;
    // Sleep so a wallclock change WOULD be visible if we
    // accidentally overwrote created_ms.
    tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    let updated = ConnectionPreset {
        label: "beta".to_string(),
        ..saved.clone()
    };
    let after = store.save(updated).await.expect("save ok 2");
    assert_eq!(after.created_ms, created_then);
    assert_eq!(after.label, "beta");
}

#[tokio::test]
async fn save_preserves_provider_scan() {
    let store = temp_store();
    let mut p = ConnectionPreset::new("local".to_string(), Transport::Local { grok_path: None });
    p.provider_scan.push(ConnectionProviderScanEntry {
        provider_id: "codex-cli".to_string(),
        can_run: true,
        status: ConnectionProviderScanStatus::Ready,
        binary: Some("/usr/bin/codex".to_string()),
        version: Some("codex-cli 0.136.0".to_string()),
        binary_sha256: Some("c".repeat(64)),
        binary_bytes: Some(4096),
        target_key: "local:linux".to_string(),
        detail: None,
        checked_at_ms: 1_780_000_000_000,
    });
    let saved = store.save(p).await.expect("save ok");
    assert_eq!(saved.provider_scan.len(), 1);
    let listed = store.list().await;
    assert_eq!(listed[0].provider_scan[0].provider_id, "codex-cli");
    assert_eq!(
        listed[0].provider_scan[0].version.as_deref(),
        Some("codex-cli 0.136.0"),
    );
}

#[tokio::test]
async fn update_provider_scan_persists_fresh_scan() {
    let store = temp_store();
    let p = ConnectionPreset::new("local".to_string(), Transport::Local { grok_path: None });
    let saved = store.save(p).await.expect("save ok");

    store
        .update_provider_scan(
            &saved.id,
            vec![ConnectionProviderScanEntry {
                provider_id: "claude-code".to_string(),
                can_run: true,
                status: ConnectionProviderScanStatus::Ready,
                binary: Some("/usr/bin/claude".to_string()),
                version: Some("claude 2.1.162".to_string()),
                binary_sha256: Some("d".repeat(64)),
                binary_bytes: Some(8192),
                target_key: "local:linux".to_string(),
                detail: None,
                checked_at_ms: 1_780_000_000_001,
            }],
        )
        .await
        .expect("scan update ok");

    let listed = store.list().await;
    assert_eq!(listed[0].provider_scan.len(), 1);
    assert_eq!(listed[0].provider_scan[0].provider_id, "claude-code");
    assert_eq!(
        listed[0].provider_scan[0].version.as_deref(),
        Some("claude 2.1.162")
    );
}
