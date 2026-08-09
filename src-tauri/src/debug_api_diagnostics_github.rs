use super::*;

use super::screenshot_http::{
    xcap_window_app_name, xcap_window_height, xcap_window_title, xcap_window_width,
};

#[derive(Deserialize, Default)]
#[serde(default)]
pub(super) struct DiagnosticsBody {
    /// Optional filter: only run checks whose name is in this list.
    /// `null` / missing → run all.
    only: Option<Vec<String>>,
}

/// Structural diagnostics suite.
/// `POST /diagnostics {only?: ["fs","host_mcp","screenshot","vault","sessions","connections","settings","auth"]}`
///
/// Runs each named check. Each check returns `{name, status: "pass"|"fail",
/// detail, evidence?}`. Final response is `{summary: {pass, fail, elapsedMs},
/// checks: [...]}`.
///
/// This v1 covers ONLY structural / "is the surface healthy" checks
/// (token file present, MCP HTTP port reachable, sessions dir writable,
/// etc.) — no grok-side orchestration. Future work: grok-driven checks
/// (image_gen end-to-end, host MCP tool round-trip, transport-aware fs
/// probe).
pub(super) async fn diagnostics_run(
    State(_s): State<ApiState>,
    body: Option<Json<DiagnosticsBody>>,
) -> Response {
    let started_ms = std::time::Instant::now();
    let body = body.map(|Json(b)| b).unwrap_or_default();
    let want = |name: &str| -> bool {
        match &body.only {
            None => true,
            Some(list) => list.iter().any(|s| s.eq_ignore_ascii_case(name)),
        }
    };
    let mut checks: Vec<serde_json::Value> = Vec::new();
    let mut pass = 0usize;
    let mut fail = 0usize;
    let record = |checks: &mut Vec<serde_json::Value>,
                  pass: &mut usize,
                  fail: &mut usize,
                  name: &str,
                  ok: bool,
                  detail: String,
                  evidence: Option<serde_json::Value>| {
        let status = if ok { "pass" } else { "fail" };
        if ok {
            *pass += 1;
        } else {
            *fail += 1;
        }
        let mut entry = serde_json::json!({
            "name": name,
            "status": status,
            "detail": detail,
        });
        if let Some(e) = evidence {
            entry["evidence"] = e;
        }
        checks.push(entry);
    };

    // fs — sessions dir exists + writable
    if want("fs") {
        let dir = sessions_dir();
        let exists = dir.exists();
        let writable = exists
            && std::fs::write(dir.join(".shellxagent-probe"), b"probe")
                .map(|_| {
                    let _ = std::fs::remove_file(dir.join(".shellxagent-probe"));
                    true
                })
                .unwrap_or(false);
        record(
            &mut checks,
            &mut pass,
            &mut fail,
            "fs",
            exists && writable,
            format!("sessions dir exists={}, writable={}", exists, writable),
            None,
        );
    }

    // host_mcp — effective MCP HTTP endpoint is reachable. Use the
    // post-bind port, not the preferred/default port, because zombie
    // listeners can force shellX onto a fallback.
    if want("host_mcp") {
        let mcp_port = crate::mcp_http::effective_mcp_port();
        let url = format!("http://127.0.0.1:{}/health", mcp_port);
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_millis(1200))
            .build();
        let (ok, detail) = match client {
            Ok(client) => match client.get(&url).send().await {
                Ok(resp) => {
                    let status = resp.status();
                    let body = resp.text().await.unwrap_or_default();
                    (
                        status.is_success() && body.contains("\"ok\":true"),
                        format!("GET {} -> {} {}", url, status, body),
                    )
                }
                Err(e) => (false, format!("GET {} failed: {}", url, e)),
            },
            Err(e) => (
                false,
                format!("failed to create HTTP client for {}: {}", url, e),
            ),
        };
        record(
            &mut checks,
            &mut pass,
            &mut fail,
            "host_mcp",
            ok,
            detail,
            Some(serde_json::json!({"port": mcp_port, "url": url})),
        );
    }

    // screenshot — endpoint responds with image/png
    if want("screenshot") {
        let r = tokio::task::spawn_blocking(|| -> Result<Vec<u8>, String> {
            let windows = xcap::Window::all().unwrap_or_default();
            let big = windows
                .into_iter()
                .filter(|w| {
                    let app = xcap_window_app_name(w).to_ascii_lowercase();
                    let title = xcap_window_title(w);
                    let app_is_shellx =
                        app == "shellx.exe" || app == "shellx" || app == "app.exe" || app == "app";
                    let title_is_shellx_exact = title.eq_ignore_ascii_case("shellX");
                    (app_is_shellx || title_is_shellx_exact)
                        && xcap_window_height(w) > 100
                        && xcap_window_width(w) > 200
                })
                .max_by_key(|w| (xcap_window_width(w) as u64) * (xcap_window_height(w) as u64));
            let img = if let Some(win) = big {
                win.capture_image().map_err(|e| format!("window: {}", e))?
            } else {
                let monitors = xcap::Monitor::all().map_err(|e| format!("monitors: {}", e))?;
                let primary = monitors
                    .into_iter()
                    .next()
                    .ok_or_else(|| "no monitor".to_string())?;
                primary
                    .capture_image()
                    .map_err(|e| format!("monitor: {}", e))?
            };
            let mut bytes: Vec<u8> = Vec::new();
            img.write_to(
                &mut std::io::Cursor::new(&mut bytes),
                xcap::image::ImageFormat::Png,
            )
            .map_err(|e| format!("encode: {}", e))?;
            Ok(bytes)
        })
        .await;
        match r {
            Ok(Ok(bytes)) => record(
                &mut checks,
                &mut pass,
                &mut fail,
                "screenshot",
                bytes.len() > 1000,
                format!("captured {} bytes", bytes.len()),
                Some(serde_json::json!({"bytes": bytes.len()})),
            ),
            Ok(Err(e)) => record(
                &mut checks,
                &mut pass,
                &mut fail,
                "screenshot",
                false,
                e,
                None,
            ),
            Err(e) => record(
                &mut checks,
                &mut pass,
                &mut fail,
                "screenshot",
                false,
                format!("task join error: {}", e),
                None,
            ),
        }
    }

    // Integrated ShellX Vault — shared backend status + metadata listing.
    // Legacy vault.enc remains import-only and must not drive diagnostics.
    if want("vault") {
        let backend = crate::shellx_vault::shared_backend();
        let status = backend.status().await;
        match backend.compat_list_keys(None).await {
            Ok(keys) => record(
                &mut checks,
                &mut pass,
                &mut fail,
                "vault",
                true,
                format!(
                    "integrated vault {:?}, unlocked={}, {} keys",
                    status.mode,
                    status.unlocked,
                    keys.len()
                ),
                Some(serde_json::json!({
                    "mode": status.mode,
                    "unlocked": status.unlocked,
                    "keyCount": keys.len(),
                    "legacyVaultDetected": status.legacy_vault_detected
                })),
            ),
            Err(error) => record(
                &mut checks,
                &mut pass,
                &mut fail,
                "vault",
                false,
                format!("integrated vault check failed: {}", error),
                Some(serde_json::json!({
                    "mode": status.mode,
                    "unlocked": status.unlocked,
                    "legacyVaultDetected": status.legacy_vault_detected
                })),
            ),
        }
    }

    // sessions — count of jsonl files + total bytes
    if want("sessions") {
        let dir = sessions_dir();
        let (count, bytes) = std::fs::read_dir(&dir)
            .map(|rd| {
                let mut count = 0u64;
                let mut bytes = 0u64;
                for e in rd.flatten() {
                    if e.path().extension().and_then(|s| s.to_str()) == Some("jsonl") {
                        count += 1;
                        bytes += e.metadata().map(|m| m.len()).unwrap_or(0);
                    }
                }
                (count, bytes)
            })
            .unwrap_or((0, 0));
        record(
            &mut checks,
            &mut pass,
            &mut fail,
            "sessions",
            count > 0,
            format!("{} session jsonl files, {} bytes total", count, bytes),
            Some(serde_json::json!({"count": count, "bytes": bytes})),
        );
    }

    // connections — preset count
    if want("connections") {
        let n = match crate::connections::ConnectionStore::open() {
            Ok(store) => store.list().await.len(),
            Err(_) => 0,
        };
        record(
            &mut checks,
            &mut pass,
            &mut fail,
            "connections",
            true,
            format!("{} connection presets", n),
            Some(serde_json::json!({"count": n})),
        );
    }

    // settings — parseable when present; first-run installs legitimately
    // have no settings.json yet and use in-memory defaults.
    if want("settings") {
        let settings_path = shellx_home()
            .unwrap_or_else(|_| std::path::PathBuf::from("/tmp"))
            .join(".shellx")
            .join("settings.json");
        let (ok, detail) = diagnostics_settings_status(&settings_path);
        record(
            &mut checks,
            &mut pass,
            &mut fail,
            "settings",
            ok,
            detail,
            None,
        );
    }

    // auth — shellxagent token present
    if want("auth") {
        let token_path = shellxagent_token_path();
        let ok = token_path
            .exists()
            .then(|| std::fs::read_to_string(&token_path).ok())
            .flatten()
            .map(|s| s.trim().len() >= 32)
            .unwrap_or(false);
        record(
            &mut checks,
            &mut pass,
            &mut fail,
            "auth",
            ok,
            format!(
                "shellxagent token {}",
                if ok { "ok" } else { "missing or invalid" }
            ),
            None,
        );
    }

    let elapsed_ms = started_ms.elapsed().as_millis();
    Json(serde_json::json!({
        "summary": {"pass": pass, "fail": fail, "elapsedMs": elapsed_ms, "version": "1.0"},
        "checks": checks,
    }))
    .into_response()
}

pub(super) fn diagnostics_settings_status(settings_path: &std::path::Path) -> (bool, String) {
    if !settings_path.exists() {
        return (true, "settings.json missing; defaults active".to_string());
    }
    match std::fs::read_to_string(settings_path) {
        Ok(raw) => match serde_json::from_str::<serde_json::Value>(&raw) {
            Ok(_) => (true, "settings.json ok".to_string()),
            Err(e) => (false, format!("settings.json unparseable: {}", e)),
        },
        Err(e) => (false, format!("settings.json unreadable: {}", e)),
    }
}

/// Pure helper for `/sessions/<id>/snippet`: walks a JSONL stream,
/// concatenates `agent_message_chunk` text, records per-chunk timestamps,
/// then locates up to `cap` matches of `needle` and returns each as a
/// ≤500-char excerpt with the match wrapped in `<mark>…</mark>`.
///
/// Separated from the handler so unit tests can feed it a fake JSONL
/// reader without spinning the whole axum stack.
///
/// Returns serde_json::Value array — caller wraps it in the response
/// envelope.
pub(super) fn compute_session_snippets<R: std::io::Read>(
    reader: R,
    needle: &str,
    cap: usize,
) -> Vec<serde_json::Value> {
    use std::io::BufRead;
    let buf = std::io::BufReader::new(reader);
    let needle_low = needle.to_lowercase();

    // Concatenate all text the way `/sessions/search` does, but ALSO
    // record (blob_offset → event_t_ms) checkpoints so we can stamp
    // each match with a reasonable timestamp. Without per-event indices,
    // every match would carry the same t — useless for forensic UI.
    let mut blob = String::with_capacity(4096);
    let mut checkpoints: Vec<(usize, i64)> = Vec::new(); // (byte_offset, t_ms)
    for line in buf.lines().map_while(Result::ok) {
        let v: serde_json::Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        // Only collect text from agent_message_chunk events (the
        // user-visible streamed answer) — matches §B of the ACP audit.
        let su = v
            .pointer("/payload/params/update/sessionUpdate")
            .and_then(|s| s.as_str());
        if su != Some("agent_message_chunk") {
            continue;
        }
        let t = v
            .pointer("/payload/params/_meta/agentTimestampMs")
            .and_then(|n| n.as_i64())
            .or_else(|| v.pointer("/t").and_then(|n| n.as_i64()))
            .unwrap_or(0);
        if let Some(text) = v
            .pointer("/payload/params/update/content/text")
            .and_then(|s| s.as_str())
        {
            checkpoints.push((blob.len(), t));
            blob.push_str(text);
        }
    }

    // Locate up to `cap` matches and build excerpts around each.
    let blob_low = blob.to_lowercase();
    let mut hits: Vec<serde_json::Value> = Vec::with_capacity(cap);
    let mut cursor = 0usize;
    while hits.len() < cap {
        let rel = match blob_low[cursor..].find(&needle_low) {
            Some(r) => r,
            None => break,
        };
        let abs = cursor + rel;
        // ±~225 chars of context for ≤500-char total window (match
        // itself + boundary markers). Tightened to char boundaries so
        // we don't slice mid-codepoint and crash on UTF-8 content.
        let start = abs.saturating_sub(225);
        let end = (abs + needle.len() + 225).min(blob.len());
        let start = (0..=start)
            .rev()
            .find(|&i| blob.is_char_boundary(i))
            .unwrap_or(0);
        let end = (end..=blob.len())
            .find(|&i| blob.is_char_boundary(i))
            .unwrap_or(blob.len());
        let before = blob[start..abs].replace('\n', " ");
        let matched = &blob[abs..abs + needle.len()];
        let after = blob[abs + needle.len()..end].replace('\n', " ");
        let mut around = String::with_capacity(end - start + 16);
        if start > 0 {
            around.push_str("… ");
        }
        around.push_str(&before);
        around.push_str("<mark>");
        around.push_str(matched);
        around.push_str("</mark>");
        around.push_str(&after);
        if end < blob.len() {
            around.push_str(" …");
        }
        // 500-char cap on the rendered excerpt. We measure char-count
        // (not bytes) so wide-codepoint sessions still fit the window.
        if around.chars().count() > 500 {
            let mut s: String = around.chars().take(500).collect();
            s.push_str(" …");
            around = s;
        }
        // Find the latest checkpoint at or before this match offset.
        let t_ms = match checkpoints.binary_search_by(|(off, _)| off.cmp(&abs)) {
            Ok(i) => checkpoints[i].1,
            Err(0) => 0,
            Err(i) => checkpoints[i - 1].1,
        };
        hits.push(serde_json::json!({
            "tMs": t_ms,
            "around": around,
        }));
        cursor = abs + needle.len();
    }
    hits
}

// ─────────── GitHub PR/issue list for `#N` autocomplete ───────────
//
// Reads open PRs + issues via `gh pr list --json` / `gh issue list --json`.
// Falls back gracefully — if `gh` is missing or unauthenticated, returns
// empty arrays + an `error` field rather than 5xx so the autocomplete
// just shows "no matches".

pub(super) async fn state_github_items(
    State(s): State<ApiState>,
    Query(q): Query<StateTabQuery>,
) -> impl IntoResponse {
    let tab_id = q.tab_id.clone();
    let cwd = match q.cwd.filter(|value| !value.trim().is_empty()) {
        Some(cwd) => cwd,
        None => debug_tab_cwd(&s, tab_id.clone()).await,
    };
    let gh_bin = resolve_github_gh_binary();

    let pr_raw = debug_tab_command_text(
        &s,
        tab_id.clone(),
        &cwd,
        &gh_bin,
        &["pr", "list", "--json", "number,title,url", "--limit", "50"],
        10,
    )
    .await;
    let issue_raw = debug_tab_command_text(
        &s,
        tab_id,
        &cwd,
        &gh_bin,
        &[
            "issue",
            "list",
            "--json",
            "number,title,url",
            "--limit",
            "50",
        ],
        10,
    )
    .await;

    let prs = pr_raw
        .as_deref()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(s).ok())
        .unwrap_or(serde_json::json!([]));
    let issues = issue_raw
        .as_deref()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(s).ok())
        .unwrap_or(serde_json::json!([]));

    // Merge into a flat list with kind="pr"|"issue".
    let mut items: Vec<serde_json::Value> = vec![];
    if let Some(arr) = prs.as_array() {
        for it in arr {
            let mut obj = it.clone();
            if let Some(o) = obj.as_object_mut() {
                o.insert(
                    "kind".to_string(),
                    serde_json::Value::String("pr".to_string()),
                );
            }
            items.push(obj);
        }
    }
    if let Some(arr) = issues.as_array() {
        for it in arr {
            let mut obj = it.clone();
            if let Some(o) = obj.as_object_mut() {
                o.insert(
                    "kind".to_string(),
                    serde_json::Value::String("issue".to_string()),
                );
            }
            items.push(obj);
        }
    }
    Json(serde_json::json!({ "items": items })).into_response()
}

// ─────────── GitHub PR create via gh CLI ───────────

#[derive(Deserialize)]
pub(super) struct PrCreateBody {
    base: String,
    title: String,
    body: String,
    #[serde(default)]
    draft: Option<bool>,
    #[serde(default)]
    head: Option<String>,
    #[serde(
        rename = "tabId",
        alias = "tab",
        alias = "tab_id",
        alias = "sessionId",
        default
    )]
    pub(super) tab_id: Option<String>,
    /// Per-operation approval gate for a remote GitHub mutation.
    /// Auth to the local debug API proves caller identity, not intent.
    #[serde(
        rename = "confirmRemoteCreate",
        alias = "confirm_remote_create",
        default
    )]
    pub(super) confirm_remote_create: bool,
    /// Fixed isolated-candidate boundary used to prove the approved UI submit
    /// path without invoking gh or contacting GitHub.
    #[serde(rename = "releaseTestBoundary", default)]
    pub(super) release_test_boundary: Option<String>,
}

pub(super) async fn github_pr_create(
    State(s): State<ApiState>,
    Json(body): Json<PrCreateBody>,
) -> impl IntoResponse {
    if !body.confirm_remote_create {
        return (
            StatusCode::PRECONDITION_REQUIRED,
            Json(serde_json::json!({
                "error": "approval_required",
                "hint": "Creating a GitHub PR mutates remote state. Re-submit with confirmRemoteCreate:true after explicit per-operation approval.",
            })),
        )
            .into_response();
    }
    if let Some(boundary) = body.release_test_boundary.as_deref() {
        if boundary != "stop-before-remote" {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({
                    "error": "invalid_release_test_boundary",
                    "hint": "releaseTestBoundary accepts only stop-before-remote",
                })),
            )
                .into_response();
        }
        if !crate::isolated_test_instance_requested() {
            return (
                StatusCode::NOT_FOUND,
                Json(serde_json::json!({
                    "error": "release_test_route_unavailable",
                    "hint": "The PR create boundary is unavailable outside an isolated test instance.",
                })),
            )
                .into_response();
        }
        if body.base.trim().is_empty() || body.title.trim().is_empty() {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({
                    "error": "release_test_pr_draft_invalid",
                    "hint": "The isolated PR boundary requires non-empty base and title fields.",
                })),
            )
                .into_response();
        }
        return (
            StatusCode::PRECONDITION_FAILED,
            Json(serde_json::json!({
                "error": "release_test_remote_mutation_blocked",
                "receipt": "release fixture PR create stopped before remote mutation",
            })),
        )
            .into_response();
    }
    let cwd = {
        let registry = s.app.state::<std::sync::Arc<crate::acp::SessionRegistry>>();
        let tab_key = crate::acp::tab_id_or_default(body.tab_id.clone());
        let Some(session_arc) = registry.get_existing(&tab_key).await else {
            return (
                StatusCode::CONFLICT,
                Json(serde_json::json!({
                    "error": "session_not_connected",
                    "tabId": tab_key,
                    "hint": "Open or connect the tab whose cwd should own this PR, then try again.",
                })),
            )
                .into_response();
        };
        let guard = session_arc.lock().await;
        guard
            .get_debug_session_info()
            .get("cwd")
            .and_then(|v| v.as_str().map(String::from))
    };
    let Some(cwd) = cwd else {
        return (
            StatusCode::CONFLICT,
            Json(serde_json::json!({
                "error": "session_cwd_missing",
                "hint": "The active tab has no cwd yet; connect it before creating a PR.",
            })),
        )
            .into_response();
    };

    let mut args: Vec<String> = vec![
        "pr".into(),
        "create".into(),
        "--base".into(),
        body.base.clone(),
        "--title".into(),
        body.title.clone(),
        "--body".into(),
        body.body.clone(),
    ];
    if let Some(h) = &body.head {
        args.push("--head".into());
        args.push(h.clone());
    }
    if body.draft.unwrap_or(false) {
        args.push("--draft".into());
    }

    // Honor the advanced `githubGhBinary` setting here too, with
    // env-var override + "gh" fallback through the allow-listed resolver.
    let gh_bin = resolve_github_gh_binary();
    let out = tokio::task::spawn_blocking(move || {
        // Suppress console flash on Windows.
        use crate::winproc::NoWindowExt as _;
        std::process::Command::new(&gh_bin)
            .args(&args)
            .current_dir(&cwd)
            .no_window()
            .output()
    })
    .await;

    let output = match out {
        Ok(Ok(o)) => o,
        Ok(Err(e)) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("gh spawn failed: {}", e),
            )
                .into_response();
        }
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("gh task join failed: {}", e),
            )
                .into_response();
        }
    };
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        return (
            StatusCode::BAD_GATEWAY,
            format!(
                "gh exited {}: {}",
                output.status.code().unwrap_or(-1),
                stderr
            ),
        )
            .into_response();
    }
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    // gh pr create prints the URL on the last line.
    let url = stdout.lines().last().unwrap_or("").to_string();
    Json(serde_json::json!({
        "ok": true,
        "url": url,
        "output": stdout,
    }))
    .into_response()
}
