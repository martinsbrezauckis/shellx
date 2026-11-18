use super::*;

#[test]
fn native_windows_subagent_bootstrap_uses_streamed_config_and_bounded_args() {
    let script = windows_native_subagent_bootstrap(
        r"C:\Users\Fixture\Project",
        r"C:\Users\Fixture\.grok\bin\grok.exe",
        "review the current diff",
    );

    assert!(script.contains("[Console]::In.ReadLine()"));
    assert!(script.contains("SHELLX_SUBAGENT_DEPTH"));
    assert!(script.contains("--no-subagents"));
    assert!(script.contains("--always-approve"));
    assert!(script.contains("mcp:shellx-host-http/Agent"));
    assert!(script.contains(r"C:\Users\Fixture\Project"));
    assert!(script.contains("review the current diff"));
    assert!(script.contains("GROK_HOME"));
    assert!(script.contains("GROK_AUTH_PATH"));
    assert!(script.contains("shellx-grok-subagent-"));
    assert!(script.contains("Remove-Item -LiteralPath $grokHome -Recurse -Force"));
    assert!(!script.contains("Copy-Item -LiteralPath $auth"));
    assert!(!script.contains("Join-Path $work '.grok'"));
    assert!(!script.contains("Bearer "));
}

#[test]
fn posix_subagent_home_is_process_scoped_and_self_cleaning() {
    let setup = posix_isolated_grok_home_setup("c2hlbGx4LWZpeHR1cmU=");
    assert!(setup.contains("mktemp -d"));
    assert!(setup.contains("GROK_HOME"));
    assert!(setup.contains("trap shellx_cleanup_grok_home EXIT HUP INT TERM"));
    assert!(setup.contains("rm -rf -- \"$shellx_grok_home\""));
    assert!(setup.contains("config.toml"));
    assert!(setup.contains("GROK_AUTH_PATH"));
    assert!(!setup.contains("cp ~/.grok/auth.json"));
    assert!(!setup.contains("$work/.grok"));
}

fn fake_grok_bin() -> &'static Path {
    static FAKE_GROK: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();
    FAKE_GROK
        .get_or_init(|| {
            if cfg!(target_os = "windows") {
                // `std::process::Command` deliberately rejects complex
                // argument forwarding through .cmd files. The current
                // Rust test executable is a real PE and exits quickly on
                // Grok's unknown CLI arguments, which is sufficient for
                // these spawn/registry tests (the child result is not the
                // behavior under test).
                return std::env::current_exe().expect("current Windows test executable");
            }
            for candidate in ["/usr/bin/true", "/bin/true"] {
                let path = PathBuf::from(candidate);
                if path.is_file() {
                    return path;
                }
            }
            panic!("tests require a system true executable")
        })
        .as_path()
}

fn use_fake_grok_bin() {
    std::env::set_var("GROK_BIN", fake_grok_bin());
}

#[test]
fn subagents_allow_managed_http_mcp_for_write_class_tools() {
    assert_eq!(SUBAGENT_ALLOWED_MCP, "mcp:shellx-host-http/*");
    assert!(
        !SUBAGENT_ALLOWED_MCP.contains("grok-shell-host"),
        "subagents must not prefer standalone stdio host MCP for Build Mode writes"
    );
    assert!(SUBAGENT_DENIED_MCP.contains(&"mcp:shellx-host-http/Agent"));
    assert!(SUBAGENT_DENIED_MCP.contains(&"mcp:shellx-host-http/send_prompt_to_provider"));
    assert!(SUBAGENT_DENIED_MCP.contains(&"mcp:shellx-host-http/send_prompt_to_session"));
    for term in ["native ShellX Browser", "browser_act", "browser_read"] {
        assert!(
            SUBAGENT_RUNTIME_GUARD.contains(term),
            "subagent runtime guard must teach Browser flow term {term}"
        );
    }
}

#[test]
fn isolated_grok_home_references_canonical_auth_and_uses_minimal_config() {
    let real_home = std::env::temp_dir().join(format!(
        "shellx-isolated-grok-home-test-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&real_home);
    std::fs::create_dir_all(real_home.join(".grok")).expect("create real .grok");
    std::fs::write(
        real_home.join(".grok").join("auth.json"),
        "{\"token\":\"test\"}\n",
    )
    .expect("write fake auth");
    let legacy_isolated_grok_home = real_home.join(".shellx/grok-subagent-home/.grok");
    std::fs::create_dir_all(&legacy_isolated_grok_home).expect("create legacy isolated Grok home");
    std::fs::write(
        legacy_isolated_grok_home.join("auth.json"),
        "{\"token\":\"stale-copy\"}\n",
    )
    .expect("write stale isolated auth copy");

    let (isolated_home, isolated_grok_home, returned_real_home, canonical_auth) =
        prepare_isolated_grok_subagent_home_for(&real_home).expect("prepare isolated home");

    assert_eq!(returned_real_home, real_home);
    assert_eq!(
        isolated_home,
        returned_real_home.join(".shellx/grok-subagent-home")
    );
    let config =
        std::fs::read_to_string(isolated_grok_home.join("config.toml")).expect("read config");
    assert!(config.contains("auto_update = false"));
    assert!(!config.contains("mcp_servers."));
    assert_eq!(canonical_auth, Some(real_home.join(".grok/auth.json")));
    assert!(!isolated_grok_home.join("auth.json").exists());

    let _ = std::fs::remove_dir_all(returned_real_home);
}

#[test]
fn personas_embed_with_expected_header_shape() {
    // Every persona's line 1 must start with `# <name> — <description>`.
    assert!(
        PERSONA_NAMES.contains(&"test-writer"),
        "Agent persona enum should expose a dedicated test-writer"
    );
    for name in PERSONA_NAMES {
        let body = persona_prompt(name).expect("known persona");
        let first = body.lines().next().expect("non-empty persona");
        assert!(
            first.starts_with("# "),
            "{}: first line must be a Markdown H1 (got {:?})",
            name,
            first
        );
        assert!(
            first.contains('—'),
            "{}: header missing em-dash separator (got {:?})",
            name,
            first
        );
        let one = persona_one_liner(name);
        assert!(
            !one.is_empty() && one.len() < 200,
            "{}: one-liner unexpected len={}: {:?}",
            name,
            one.len(),
            one
        );
    }
}

#[test]
fn compose_prompt_separates_persona_and_task() {
    let composed = compose_prompt("general-purpose", "Find the bug in foo.rs");
    assert!(composed.contains(PERSONA_GENERAL));
    assert!(composed.contains("You are already running inside a shellX Agent subprocess."));
    assert!(composed.contains("Do not call `search_tool`, `use_tool`"));
    assert!(composed.contains("\n\n---\n\n"));
    assert!(composed.ends_with("Find the bug in foo.rs"));
}

#[test]
fn append_wslenv_var_adds_token_without_clobbering_existing_entries() {
    assert_eq!(
        append_wslenv_var("PATH/l:USERPROFILE/p", crate::mcp_http::MCP_TOKEN_ENV_VAR),
        format!(
            "PATH/l:USERPROFILE/p:{}",
            crate::mcp_http::MCP_TOKEN_ENV_VAR
        )
    );
    assert_eq!(
        append_wslenv_var(
            &format!("PATH/l:{}/u", crate::mcp_http::MCP_TOKEN_ENV_VAR),
            crate::mcp_http::MCP_TOKEN_ENV_VAR
        ),
        format!("PATH/l:{}/u", crate::mcp_http::MCP_TOKEN_ENV_VAR)
    );
}

#[test]
fn build_wait_timing_uses_wait_budget_without_watchdog() {
    let timing = AgentTimingOptions::build_wait(Some(1234));

    assert_eq!(timing.wait_budget_ms, Some(1234));
    assert_eq!(timing.watchdog, SubagentWatchdogPolicy::Disabled);
}

#[test]
fn legacy_timing_preserves_detached_watchdog_behavior() {
    let timing = AgentTimingOptions::legacy(false, Some(4321));

    assert_eq!(timing.wait_budget_ms, None);
    assert_eq!(
        timing.watchdog,
        SubagentWatchdogPolicy::Hard {
            max_runtime_ms: 4321
        }
    );
}

#[test]
fn legacy_wait_timing_preserves_hard_timeout_behavior() {
    let timing = AgentTimingOptions::legacy(true, Some(9876));

    assert_eq!(timing.wait_budget_ms, Some(9876));
    assert_eq!(
        timing.watchdog,
        SubagentWatchdogPolicy::Hard {
            max_runtime_ms: 9876
        }
    );
}

#[test]
fn running_state_initializes_activity_counters() {
    let st = SubagentState::new_running();

    assert!(st.started_at_ms > 0);
    assert!(st.last_activity_ms >= st.started_at_ms);
    assert_eq!(st.stdout_bytes_seen, 0);
    assert_eq!(st.stderr_bytes_seen, 0);
}

#[tokio::test]
async fn activity_reader_updates_stdout_counters() {
    let handle = Arc::new(SubagentHandle {
        id: Uuid::new_v4(),
        persona: "general-purpose".to_string(),
        task_preview: "activity stdout test".to_string(),
        started_at: Instant::now(),
        state: Mutex::new(SubagentState::new_running()),
    });
    let started_at_ms = handle.state.lock().await.started_at_ms;
    let reader = std::io::Cursor::new(b"hello stdout".to_vec());

    let (_captured, total) =
        read_stream_capped_with_activity(reader, 4096, handle.clone(), SubagentStream::Stdout)
            .await;

    assert_eq!(total, 12);
    let st = handle.state.lock().await;
    assert_eq!(st.stdout_bytes_seen, 12);
    assert_eq!(st.stderr_bytes_seen, 0);
    assert!(st.last_activity_ms >= started_at_ms);
}

#[tokio::test]
async fn activity_reader_updates_stderr_counters() {
    let handle = Arc::new(SubagentHandle {
        id: Uuid::new_v4(),
        persona: "general-purpose".to_string(),
        task_preview: "activity stderr test".to_string(),
        started_at: Instant::now(),
        state: Mutex::new(SubagentState::new_running()),
    });
    let reader = std::io::Cursor::new(b"oops stderr".to_vec());

    let (_captured, total) =
        read_stream_capped_with_activity(reader, 4096, handle.clone(), SubagentStream::Stderr)
            .await;

    assert_eq!(total, 11);
    let st = handle.state.lock().await;
    assert_eq!(st.stdout_bytes_seen, 0);
    assert_eq!(st.stderr_bytes_seen, 11);
}

#[tokio::test]
async fn status_exposes_activity_fields() {
    let id = Uuid::new_v4();
    let mut state = SubagentState::new_running();
    state.stdout_bytes_seen = 7;
    state.stderr_bytes_seen = 3;
    let last_activity_ms = state.last_activity_ms;
    let handle = Arc::new(SubagentHandle {
        id,
        persona: "general-purpose".to_string(),
        task_preview: "status activity test".to_string(),
        started_at: Instant::now(),
        state: Mutex::new(state),
    });
    registry().lock().await.insert(id, handle);

    let value = status(&id.to_string()).await.expect("status ok");

    registry().lock().await.remove(&id);
    assert_eq!(value["last_activity_ms"], json!(last_activity_ms));
    assert_eq!(value["stdout_bytes_seen"], json!(7));
    assert_eq!(value["stderr_bytes_seen"], json!(3));
}

#[test]
fn ssh_mcp_reverse_forward_matches_http_snippet_port() {
    assert_eq!(
        ssh_mcp_reverse_forward_arg(57_610, 5_760),
        "57610:127.0.0.1:5760"
    );
    let first = subagent_remote_mcp_port(Uuid::from_u128(1), 5_760);
    let second = subagent_remote_mcp_port(Uuid::from_u128(2), 5_760);
    assert!((49_152..61_152).contains(&first));
    assert_ne!(first, second);
}

#[tokio::test]
async fn spawn_rejects_unknown_persona() {
    let res = spawn_subagent("bogus", "do a thing", None, true, None, None).await;
    assert!(res.is_err(), "expected error for unknown persona");
    let msg = res.unwrap_err();
    assert!(msg.contains("unknown persona"), "got: {}", msg);
}

#[tokio::test]
async fn spawn_rejects_empty_task() {
    let res = spawn_subagent("general-purpose", "   ", None, true, None, None).await;
    assert!(res.is_err());
    let msg = res.unwrap_err();
    assert!(msg.contains("empty task"), "got: {}", msg);
}

#[tokio::test]
async fn status_rejects_bad_uuid() {
    let res = status("not-a-uuid").await;
    assert!(res.is_err());
}

#[tokio::test]
async fn status_rejects_unknown_id() {
    let fake = Uuid::new_v4().to_string();
    let res = status(&fake).await;
    assert!(res.is_err(), "expected lookup error for unknown id");
}

// ──── Registry mirror + kill state machine + metrics ────

/// When a `ProcessRegistry` is wired via `set_process_registry`, a
/// successful spawn must register a row under origin `host_mcp` with
/// the spawned child's pid + a 60-char command display. We use a
/// fresh registry per test so other test cases don't pollute counts.
///
/// CI does not install a real grok CLI, so this test points GROK_BIN
/// at a tiny fake executable and asserts on shellX's registry behavior
/// rather than upstream grok behavior.
#[tokio::test]
async fn spawn_registers_into_process_registry_under_host_mcp() {
    use_fake_grok_bin();
    let reg = match process_registry() {
        Some(existing) => existing.clone(),
        None => {
            let reg = Arc::new(ProcessRegistry::new());
            set_process_registry(reg.clone());
            reg
        }
    };

    // Use a unique persona-tagged task so we can find our row amongst
    // any other parallel tests' rows in the same global subagent
    // registry. wait=false: we don't care about the child outcome,
    // just the registry row creation.
    let needle = format!("registry-mirror-test-{}", Uuid::new_v4());
    let test_cwd = std::env::temp_dir().to_string_lossy().into_owned();
    let _ = spawn_subagent(
        "general-purpose",
        &needle,
        Some(test_cwd),
        false,
        None,
        None,
    )
    .await
    .expect("spawn returns a handle with fake grok");

    let snaps = reg.list().await;
    let matching: Vec<_> = snaps.iter().filter(|s| s.cmd.contains(&needle)).collect();
    assert!(!matching.is_empty(), "expected registry row for fake grok");
    let row = matching[0];
    assert_eq!(
        row.source,
        ProcessSource::HostMcp,
        "subagent rows must use the HostMcp origin"
    );
    assert!(
        row.cmd.starts_with("Agent[general-purpose]:"),
        "command_display should be persona-prefixed: {:?}",
        row.cmd
    );
    // 60-char preview cap (task is exactly the needle, well under 60).
    // For longer tasks the slice is capped at 60 chars; assert here on
    // the upper bound rather than the exact length.
    let preview_part = row.cmd.split(": ").nth(1).unwrap_or("");
    assert!(
        preview_part.chars().count() <= 60,
        "preview exceeds 60 chars: {:?}",
        preview_part
    );
}

/// Kill of an unknown id must error structurally.
#[tokio::test]
async fn kill_rejects_unknown_id() {
    let fake = Uuid::new_v4().to_string();
    let res = kill(&fake, false).await;
    assert!(res.is_err(), "kill of unknown id must error");
}

/// Kill of a bad uuid must error before lookup.
#[tokio::test]
async fn kill_rejects_malformed_id() {
    let res = kill("not-a-uuid", false).await;
    assert!(res.is_err());
    let msg = res.unwrap_err();
    assert!(msg.contains("bad subagent_id"), "got: {}", msg);
}

/// `Agent_metrics` must produce a stable shape with the 7 fields the
/// MCP schema documents. Counts may include rows from parallel tests
/// (shared global registry) — we only assert shape + monotonicity, not
/// exact values.
#[tokio::test]
async fn metrics_shape_is_stable() {
    let v = metrics().await.expect("metrics ok");
    for key in &[
        "running",
        "completed",
        "failed",
        "total",
        "total_elapsed_ms_p50",
        "total_elapsed_ms_p95",
        "success_rate",
    ] {
        assert!(v.get(*key).is_some(), "missing metrics key: {}", key);
    }
    // total = running + completed + failed (sanity).
    let total = v["total"].as_u64().expect("total is u64");
    let r = v["running"].as_u64().unwrap_or(0);
    let c = v["completed"].as_u64().unwrap_or(0);
    let f = v["failed"].as_u64().unwrap_or(0);
    assert_eq!(total, r + c + f, "total must be running+completed+failed");
    // success_rate is null until at least one terminal row exists.
    if c + f == 0 {
        assert!(v["success_rate"].is_null());
    } else {
        let sr = v["success_rate"].as_f64().expect("success_rate is f64");
        assert!(
            (0.0..=1.0).contains(&sr),
            "success_rate out of range: {}",
            sr
        );
    }
}

/// Audit finding #380 M5 — the streaming reader must keep the TAIL
/// of the input when total > cap, prepend a `[OUTPUT TRUNCATED …]`
/// sentinel, and report the true total byte count.
///
/// We feed a 16 KiB input through a 4 KiB cap and assert:
/// - total reported = 16384
/// - captured bytes start with the sentinel
/// - last 64 bytes of captured match last 64 of the original
/// (proves it kept the TAIL, not the head)
#[tokio::test]
async fn read_stream_capped_truncates_and_prepends_sentinel() {
    // Build 16 KiB of deterministic input: a..z repeating. Tail is
    // predictable so we can pin-check.
    let mut input = Vec::with_capacity(16 * 1024);
    for i in 0..(16 * 1024) {
        input.push(b'a' + ((i % 26) as u8));
    }
    let total_in = input.len();
    let cap = 4 * 1024;
    let reader = std::io::Cursor::new(input.clone());
    let (captured, total) = read_stream_capped(reader, cap).await;
    assert_eq!(total, total_in, "total must match input size");
    // Sentinel present + structural.
    let prefix =
        std::str::from_utf8(&captured[..captured.len().min(200)]).expect("sentinel is ASCII");
    assert!(
        prefix.starts_with("[OUTPUT TRUNCATED — "),
        "missing sentinel: {:?}",
        prefix
    );
    assert!(
        prefix.contains(&format!("{} bytes total", total_in)),
        "sentinel missing total: {:?}",
        prefix
    );
    // Tail preserved: last 64 bytes of captured must equal last 64
    // of input (the sentinel is at the FRONT, body is the tail).
    let tail_in = &input[total_in - 64..];
    let tail_out = &captured[captured.len() - 64..];
    assert_eq!(
        tail_in, tail_out,
        "captured tail differs from input tail (head was kept by mistake?)"
    );
}

/// Audit finding #380 M5 — when input fits under cap, no sentinel
/// is prepended and captured == input. This is the common path
/// for small grok outputs.
#[tokio::test]
async fn read_stream_capped_no_sentinel_when_under_cap() {
    let input = b"hello world".to_vec();
    let reader = std::io::Cursor::new(input.clone());
    let (captured, total) = read_stream_capped(reader, 4096).await;
    assert_eq!(total, input.len());
    assert_eq!(captured, input);
    // No sentinel substring anywhere.
    let s = std::str::from_utf8(&captured).unwrap();
    assert!(!s.contains("[OUTPUT TRUNCATED"));
}

/// Audit finding #380 M5 — when the detached watchdog timeout
/// elapses while the handle is still in `Running`, the watchdog
/// must mark `killed=true`. We use a synthetic handle with
/// pid=None so no signal is sent to a real process (no flake risk
/// from PID-collision on a busy CI host).
#[tokio::test]
async fn detached_watchdog_marks_killed_after_timeout() {
    let handle = Arc::new(SubagentHandle {
        id: Uuid::new_v4(),
        persona: "general-purpose".to_string(),
        task_preview: "watchdog test".to_string(),
        started_at: Instant::now(),
        state: Mutex::new(SubagentState::new_running()),
    });
    // pid stays None so the signal-sending branches are skipped.
    // We're only asserting on the killed=true transition.
    super::arm_detached_watchdog(handle.clone(), 50);
    // Wait long enough for the 50ms sleep + the post-sleep mutex
    // acquire to land.
    tokio::time::sleep(Duration::from_millis(200)).await;
    let st = handle.state.lock().await;
    assert!(
        st.killed,
        "watchdog must mark killed=true after timeout while Running"
    );
}

/// Audit finding #380 M5 — when the handle has already transitioned
/// to a terminal state (Completed/Failed) before the watchdog
/// fires, the watchdog must no-op: do NOT flip killed, do NOT send
/// a signal. Proves the watchdog can't mis-classify a fast-finishing
/// detached subagent as Killed.
#[tokio::test]
async fn detached_watchdog_noops_when_handle_already_terminal() {
    let handle = Arc::new(SubagentHandle {
        id: Uuid::new_v4(),
        persona: "general-purpose".to_string(),
        task_preview: "watchdog noop test".to_string(),
        started_at: Instant::now(),
        state: Mutex::new(SubagentState::new_running()),
    });
    // Flip to Completed BEFORE arming so the watchdog sees terminal.
    {
        let mut st = handle.state.lock().await;
        st.status = SubagentStatus::Completed;
    }
    super::arm_detached_watchdog(handle.clone(), 50);
    tokio::time::sleep(Duration::from_millis(200)).await;
    let st = handle.state.lock().await;
    assert!(
        !st.killed,
        "watchdog must NOT mark killed when handle is already terminal"
    );
    assert_eq!(st.status, SubagentStatus::Completed);
}

#[tokio::test]
async fn delayed_escalation_requires_the_same_owned_process_generation() {
    let pid = std::process::id();
    let identity =
        capture_owned_process_identity(pid).expect("current test process has a stable identity");
    let handle = Arc::new(SubagentHandle {
        id: Uuid::new_v4(),
        persona: "general-purpose".to_string(),
        task_preview: "stable escalation identity".to_string(),
        started_at: Instant::now(),
        state: Mutex::new(SubagentState::new_running()),
    });
    {
        let mut state = handle.state.lock().await;
        state.pid = Some(pid);
        state.process_identity = Some(identity);
    }
    assert!(delayed_escalation_target_is_current(&handle, identity).await);

    handle.state.lock().await.process_identity = None;
    assert!(!delayed_escalation_target_is_current(&handle, identity).await);
}

/// Percentile helper: nearest-rank, empty input → Null, single
/// element → that element regardless of pct.
#[test]
fn percentile_edge_cases() {
    let mut empty: Vec<u128> = Vec::new();
    assert!(percentile(&mut empty, 50.0).is_null());

    let mut one = vec![42u128];
    assert_eq!(percentile(&mut one, 50.0), json!(42));
    assert_eq!(percentile(&mut one, 95.0), json!(42));

    // Sorted [10,20,30,40,50] — p50 = 30 (rank ceil(2.5)=3 → idx 2),
    // p95 = 50 (rank ceil(4.75)=5 → idx 4).
    let mut many = vec![10u128, 20, 30, 40, 50];
    assert_eq!(percentile(&mut many, 50.0), json!(30));
    assert_eq!(percentile(&mut many, 95.0), json!(50));
}

/// Concurrency proof: drive the registry through the public spawn/status
/// path with GROK_BIN pointed at a fake executable. Verifies N parallel
/// spawns produce N distinct
/// subagent_ids, the registry tracks them concurrently, and each one's
/// status is independently queryable. This is the load-bearing claim
/// behind "drop the one-at-a-time constraint" — see the user's brief
/// 2026-05-18.
#[tokio::test]
async fn concurrent_spawns_get_distinct_ids_and_resolve_independently() {
    use_fake_grok_bin();
    // Raise the cap — prior tests in the same process can leave the
    // registry pre-populated, which would race the 6-cap. 20 is
    // safe-margin for the 5 spawns this test does.
    std::env::set_var("SHELLX_MAX_SUBAGENTS", "20");
    let mut tasks = Vec::new();
    for i in 0..5 {
        let test_cwd = std::env::temp_dir().to_string_lossy().into_owned();
        let t = tokio::spawn(async move {
            spawn_subagent(
                "general-purpose",
                &format!("noop-test-{}", i),
                Some(test_cwd),
                false, // wait=false: we want fan-out, no blocking
                None,
                None,
            )
            .await
        });
        tasks.push(t);
    }
    let mut ids = Vec::new();
    for t in tasks {
        let v = t.await.expect("task panicked").expect("spawn ok");
        let id = v["subagent_id"]
            .as_str()
            .expect("subagent_id present")
            .to_string();
        ids.push(id);
    }
    // All 5 ids must be unique.
    let mut sorted = ids.clone();
    sorted.sort();
    sorted.dedup();
    assert_eq!(sorted.len(), ids.len(), "duplicate subagent_ids");
    // Each id must be independently queryable via status.
    for id in &ids {
        let s = status(id).await.expect("status ok");
        let recovered = s["subagent_id"].as_str().expect("id field");
        assert_eq!(recovered, id);
        // Status is one of the three terminal/running variants.
        let st = s["status"].as_str().expect("status field");
        assert!(
            matches!(st, "running" | "completed" | "failed"),
            "bad status: {}",
            st
        );
    }
}

// ──── Atomic ledger write inside the Agent MCP tool ────

/// When `ledger_dir` is passed to `spawn_subagent`, the spawn must
/// atomically write `<ledger_dir>/<subagent_id>.md` AFTER the child
/// has been spawned successfully. CI does not install grok, so the
/// test uses a fake executable and asserts on file presence + content
/// shape regardless of the eventual exit status of the child.
///
/// Load-bearing invariant: the parent build manager no longer touches
/// the file from its own write path, so Windows file-lock contention
/// is eliminated.
#[tokio::test]
async fn spawn_with_ledger_dir_writes_atomic_record() {
    use_fake_grok_bin();
    // Fresh tempdir under /tmp/ so we don't collide with any other
    // test or with a real session's subagent ledger.
    let unique = format!(
        "subagent-ledger-test-{}-{}",
        std::process::id(),
        Uuid::new_v4().simple()
    );
    let ledger = std::env::temp_dir().join(unique);
    // Intentionally DO NOT pre-create the directory — the spawn
    // must mkdir -p it itself (the build run's `subagents/`
    // directory often doesn't exist on first dispatch).
    assert!(!ledger.exists(), "tempdir should not pre-exist");

    let needle = format!("ledger-write-test-{}", Uuid::new_v4());
    let test_cwd = std::env::temp_dir().to_string_lossy().into_owned();
    let v = spawn_subagent(
        "general-purpose",
        &needle,
        Some(test_cwd),
        false, // detach — we just want to observe the ledger file
        Some(ledger.clone()),
        None,
    )
    .await
    .expect("spawn returns a handle with fake grok");

    let id_str = v["subagent_id"]
        .as_str()
        .expect("subagent_id present")
        .to_string();

    // The ledger file is written synchronously inside spawn_subagent
    // (after pid persist, before the detached run_to_completion
    // task is fired), so by the time spawn_subagent returns the
    // file MUST exist on disk.
    let expected_path = ledger.join(format!("{}.md", id_str));
    assert!(expected_path.exists(), "expected ledger file for fake grok");

    // Assert file shape: contains the persona, the subagent id, an
    // ISO timestamp, status: running, and the task preview.
    let body = std::fs::read_to_string(&expected_path).expect("ledger file readable");
    assert!(
        body.starts_with(&format!("# Subagent {}", id_str)),
        "ledger header missing/wrong: {:?}",
        &body[..body.len().min(120)]
    );
    assert!(
        body.contains("- persona: general-purpose"),
        "ledger missing persona line"
    );
    assert!(
        body.contains("- status: running")
            || body.contains("- status: completed")
            || body.contains("- status: failed"),
        "ledger missing expected status line"
    );
    assert!(
        body.contains(&needle),
        "ledger missing task_preview substring"
    );
    // ISO timestamp shape — at least the "YYYY-" prefix and "Z" tail.
    assert!(
        body.contains("- dispatched_at: 20") && body.contains("Z\n"),
        "ledger missing ISO timestamp"
    );

    // No tmp leftover next to the final file.
    let leftover_tmps: Vec<_> = std::fs::read_dir(&ledger)
        .expect("ledger dir readable")
        .filter_map(|e| e.ok())
        .filter(|e| e.file_name().to_string_lossy().ends_with(".tmp"))
        .collect();
    assert!(
        leftover_tmps.is_empty(),
        "atomic write left a .tmp file: {:?}",
        leftover_tmps
            .iter()
            .map(|e| e.file_name())
            .collect::<Vec<_>>()
    );

    // Cleanup.
    let _ = std::fs::remove_dir_all(&ledger);
}

#[tokio::test]
async fn ledger_terminal_update_replaces_running_status() {
    let unique = format!(
        "subagent-ledger-terminal-test-{}-{}",
        std::process::id(),
        Uuid::new_v4().simple()
    );
    let ledger = std::env::temp_dir().join(unique);
    tokio::fs::create_dir_all(&ledger)
        .await
        .expect("create temp ledger dir");
    let final_path = ledger.join("agent.md");
    tokio::fs::write(
            &final_path,
            "# Subagent abc\n\n- persona: reviewer\n- dispatched_at: 2026-05-21T10:00:00Z\n- status: running\n- task_preview: |\n  audit\n",
        )
        .await
        .expect("write initial ledger");

    let snapshot = LedgerTerminalSnapshot {
        status: "completed",
        finished_at: "2026-05-21T10:01:00Z".to_string(),
        elapsed_ms: Some(1234),
        exit_code: Some(0),
        killed: false,
        stdout: "review passed\n```fence from model\n".to_string(),
        stderr_tail: "warning tail".to_string(),
    };
    update_ledger_terminal_record(&final_path, &snapshot)
        .await
        .expect("terminal ledger update");

    let body = tokio::fs::read_to_string(&final_path)
        .await
        .expect("read updated ledger");
    assert!(body.contains("- status: completed"), "body: {}", body);
    assert!(!body.contains("- status: running"), "body: {}", body);
    assert!(
        body.contains("- finished_at: 2026-05-21T10:01:00Z"),
        "body: {}",
        body
    );
    assert!(body.contains("- elapsed_ms: 1234"), "body: {}", body);
    assert!(body.contains("- exit_code: 0"), "body: {}", body);
    assert!(body.contains("- killed: false"), "body: {}", body);
    assert!(body.contains("## stdout"), "body: {}", body);
    assert!(body.contains("review passed"), "body: {}", body);
    assert!(body.contains("` ` `fence from model"), "body: {}", body);
    assert!(body.contains("## stderr_tail"), "body: {}", body);
    assert!(body.contains("warning tail"), "body: {}", body);

    let _ = tokio::fs::remove_dir_all(&ledger).await;
}
