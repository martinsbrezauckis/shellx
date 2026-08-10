use super::*;

use std::path::PathBuf;

pub(super) fn settings_path() -> PathBuf {
    let home = shellx_home().unwrap_or_else(|_| PathBuf::from("/tmp"));
    home.join(".shellx").join("settings.json")
}

pub(super) fn read_settings_from_disk() -> serde_json::Value {
    let path = settings_path();
    match std::fs::read_to_string(&path) {
        Ok(s) => match serde_json::from_str::<serde_json::Value>(&s) {
            Ok(v) => normalize_settings_json(v),
            Err(_) => default_settings_json(),
        },
        Err(_) => default_settings_json(),
    }
}

pub(super) fn default_settings_json() -> serde_json::Value {
    serde_json::json!({
        "density": "default",
        "theme": "black",
        "chatFontPx": 19,
        "browserDownloadFolder": "",
        "githubGhBinary": "gh",
    })
}

pub(super) fn normalize_github_gh_binary_setting(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.eq_ignore_ascii_case("gh") {
        return Ok("gh".to_string());
    }
    if trimmed.eq_ignore_ascii_case("gh.exe") {
        return Ok("gh.exe".to_string());
    }
    Err("githubGhBinary must be exactly 'gh' or 'gh.exe'".to_string())
}

pub(super) fn resolve_github_gh_binary() -> String {
    if let Ok(env_bin) = std::env::var("SHELLX_GH_BIN") {
        if let Ok(bin) = normalize_github_gh_binary_setting(&env_bin) {
            return bin;
        }
        warn!("ignoring invalid SHELLX_GH_BIN value");
    }
    read_settings_from_disk()
        .get("githubGhBinary")
        .and_then(|v| v.as_str())
        .and_then(|s| normalize_github_gh_binary_setting(s).ok())
        .unwrap_or_else(|| "gh".to_string())
}

pub(super) fn normalize_settings_json(v: serde_json::Value) -> serde_json::Value {
    let mut out = default_settings_json();
    let Some(src) = v.as_object() else {
        return out;
    };
    let Some(dst) = out.as_object_mut() else {
        return out;
    };

    if matches!(
        src.get("density").and_then(|v| v.as_str()),
        Some("compact" | "default" | "comfortable")
    ) {
        dst.insert("density".into(), src["density"].clone());
    }
    if matches!(
        src.get("theme").and_then(|v| v.as_str()),
        Some("black" | "black_warm" | "bright")
    ) {
        dst.insert("theme".into(), src["theme"].clone());
    }
    if let Some(px) = src.get("chatFontPx").and_then(|v| v.as_f64()) {
        if px.is_finite() {
            let clamped = px.round().clamp(12.0, 26.0) as i64;
            dst.insert(
                "chatFontPx".into(),
                serde_json::Value::Number(clamped.into()),
            );
        }
    }
    if let Some(folder) = src
        .get("browserDownloadFolder")
        .and_then(|v| v.as_str())
        .map(str::trim)
    {
        dst.insert(
            "browserDownloadFolder".into(),
            serde_json::Value::String(folder.to_string()),
        );
    }
    if let Some(bin) = src
        .get("githubGhBinary")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        if let Ok(bin) = normalize_github_gh_binary_setting(bin) {
            dst.insert("githubGhBinary".into(), serde_json::Value::String(bin));
        }
    }
    out
}

pub(super) async fn get_settings(State(_s): State<ApiState>) -> impl IntoResponse {
    Json(read_settings_from_disk()).into_response()
}

pub(super) async fn set_settings(
    State(_s): State<ApiState>,
    Json(body): Json<serde_json::Value>,
) -> impl IntoResponse {
    let path = settings_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    // Merge with existing — partial updates preserve current settings.
    // Normalize before write so removed UI fields from old installs
    // (model/effort/daily caps/GitHub token flags) do not linger in the
    // public settings payload forever.
    let mut current = match std::fs::read_to_string(&path) {
        Ok(s) => serde_json::from_str::<serde_json::Value>(&s)
            .map(normalize_settings_json)
            .unwrap_or_else(|_| default_settings_json()),
        Err(_) => default_settings_json(),
    };
    if let (Some(curr_obj), Some(patch_obj)) = (current.as_object_mut(), body.as_object()) {
        for (k, v) in patch_obj {
            if matches!(
                k.as_str(),
                "density" | "theme" | "chatFontPx" | "browserDownloadFolder" | "githubGhBinary"
            ) {
                curr_obj.insert(k.clone(), v.clone());
            }
        }
    }
    current = normalize_settings_json(current);
    let serialized = serde_json::to_string_pretty(&current).unwrap_or_else(|_| "{}".to_string());
    if let Err(e) = std::fs::write(&path, serialized) {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("failed to write settings: {}", e),
        )
            .into_response();
    }
    info!("settings written to {}", path.display());
    Json(serde_json::json!({
        "ok": true,
        "settings": read_settings_from_disk()
    }))
    .into_response()
}

// ─────────── Session JSONL persistence ───────────
//
// Sessions are persisted to ~/.shellx/sessions/<sessionId>.jsonl —
// one raw event per line. The disk writer lives in the renderer for
// now (it has the full RawEvent stream); the read side is here so any
// future "Resume last session" UX can pull the JSONL back. The history
// listing scans the directory and returns mtime-sorted basenames + a
// truncated title taken from the first session_summary_generated line.

pub(super) fn sessions_dir() -> PathBuf {
    let home = shellx_home().unwrap_or_else(|_| PathBuf::from("/tmp"));
    home.join(".shellx").join("sessions")
}

pub(super) fn valid_session_id(id: &str) -> bool {
    !id.is_empty()
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

pub(super) async fn list_session_history(State(_s): State<ApiState>) -> impl IntoResponse {
    let dir = sessions_dir();
    let _ = std::fs::create_dir_all(&dir);
    let entries = match std::fs::read_dir(&dir) {
        Ok(rd) => rd,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("cannot read sessions dir: {}", e),
            )
                .into_response();
        }
    };
    let mut rows: Vec<(String, std::time::SystemTime, u64)> = vec![];
    for ent in entries.flatten() {
        let path = ent.path();
        if path.extension().and_then(|s| s.to_str()) != Some("jsonl") {
            continue;
        }
        let meta = match ent.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        let mtime = meta.modified().unwrap_or(std::time::UNIX_EPOCH);
        let size = meta.len();
        let id = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();
        rows.push((id, mtime, size));
    }
    // sort by mtime DESC
    rows.sort_by_key(|row| std::cmp::Reverse(row.1));
    let out: Vec<serde_json::Value> = rows
        .into_iter()
        .take(50)
        .map(|(id, mtime, size)| {
            let ms = mtime
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0);
            // Pull title from JSONL — scan first 500 lines for a
            // session_summary_generated event.
            let title = read_session_title(&id).unwrap_or_else(|| id.clone());
            serde_json::json!({
                "id": id,
                "title": title,
                "tMs": ms,
                "sizeBytes": size,
            })
        })
        .collect();
    Json(serde_json::json!({ "sessions": out })).into_response()
}

pub(super) fn read_session_title(id: &str) -> Option<String> {
    let path = sessions_dir().join(format!("{}.jsonl", id));
    let content = std::fs::read_to_string(&path).ok()?;
    for (i, l) in crate::split_session_jsonl_records(&content)
        .into_iter()
        .enumerate()
    {
        if i > 500 {
            break;
        }
        if !l.contains("session_summary_generated") {
            continue;
        }
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&l) {
            let title = v
                .pointer("/payload/params/update/session_summary")
                .and_then(|t| t.as_str())
                .map(|s| s.to_string());
            if title.is_some() {
                return title;
            }
        }
    }
    None
}

/// Full-text content search across every session JSONL
/// in `~/.shellx/sessions/`. Implements the "Search inside chats"
/// behavior the user reported as still missing from FindPopover (which
/// previously only filtered by tab title).
///
/// Query string: `?q=<needle>` (case-insensitive substring match).
/// Optional `&limit=N` (default 20, cap 200). Each result row:
/// { id, title, mtimeMs, matchCount, snippet }
///
/// snippet = the first ~160 chars of the first text-bearing line that
/// contains `q`, with the match highlighted by surrounding context.
///
/// Scans agent_message_chunk / user_message text from session/update
/// notifications. Ignores tool-call JSON noise to keep snippets human-
/// readable.
#[derive(Deserialize)]
pub(super) struct SearchQuery {
    q: String,
    #[serde(default)]
    limit: Option<usize>,
}

pub(super) async fn search_sessions(
    State(_s): State<ApiState>,
    axum::extract::Query(qs): axum::extract::Query<SearchQuery>,
) -> impl IntoResponse {
    let needle = qs.q.trim().to_string();
    if needle.is_empty() {
        return Json(serde_json::json!({ "results": [] })).into_response();
    }
    let limit = qs.limit.unwrap_or(20).min(200);
    let needle_low = needle.to_lowercase();

    let dir = sessions_dir();
    let entries = match std::fs::read_dir(&dir) {
        Ok(rd) => rd,
        Err(_) => return Json(serde_json::json!({ "results": [] })).into_response(),
    };

    let mut hits: Vec<(String, std::time::SystemTime, usize, String)> = Vec::new();
    for ent in entries.flatten() {
        let path = ent.path();
        if path.extension().and_then(|s| s.to_str()) != Some("jsonl") {
            continue;
        }
        let id = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();
        let mtime = ent
            .metadata()
            .and_then(|m| m.modified())
            .unwrap_or(std::time::UNIX_EPOCH);

        // Normalize old JSONL files where concurrent appends sometimes
        // left adjacent JSON objects on one physical line. Search needs
        // one parseable RawEventFrame per record.
        let records = match std::fs::read_to_string(&path) {
            Ok(s) => crate::split_session_jsonl_records(&s),
            Err(_) => continue,
        };
        // Concatenate ALL text from this session (across every event) into
        // one blob, then search. Grok streams agent_message_chunk events
        // with very small text fragments (often 1-3 chars), so a per-line
        // grep misses any needle that spans two chunks. Concat-then-search
        // is the only way to find such matches.
        // // We join fragments with NO separator — grok's chunks are the
        // pieces of a continuous text stream and were meant to be glued
        // back. A space delimiter (earlier attempt) broke "GAMMA-ZETA-PYRAMID"
        // into "GAM MA -Z ETA -P Y RAM ID" and no needle could match.
        // The downside (theoretical fake-match across event boundaries)
        // is far less harmful than the upside (search actually works).
        let mut blob = String::with_capacity(4096);
        for line in records {
            // Quick JSON parse — only events with a text payload count.
            let v: serde_json::Value = match serde_json::from_str(&line) {
                Ok(v) => v,
                Err(_) => continue,
            };
            for ptr in [
                "/payload/params/update/content/text",
                "/payload/params/update/text",
                "/payload/text",
            ] {
                if let Some(t) = v.pointer(ptr).and_then(|s| s.as_str()) {
                    blob.push_str(t);
                }
            }
        }
        // Now search the blob. matchCount = number of needle occurrences
        // in the concatenated text. snippet = first match centered.
        let blob_low = blob.to_lowercase();
        let mut match_count = 0usize;
        let mut search_from = 0usize;
        while let Some(rel) = blob_low[search_from..].find(&needle_low) {
            match_count += 1;
            search_from += rel + needle_low.len();
        }
        let snippet: Option<String> = if match_count > 0 {
            let idx_low = blob_low.find(&needle_low).unwrap_or(0);
            let start = idx_low.saturating_sub(60);
            let end = (idx_low + needle.len() + 100).min(blob.len());
            // Round to char boundaries so we don't slice mid-codepoint.
            let start = (0..=start)
                .rev()
                .find(|&i| blob.is_char_boundary(i))
                .unwrap_or(0);
            let end = (end..=blob.len())
                .find(|&i| blob.is_char_boundary(i))
                .unwrap_or(blob.len());
            let mut s = blob[start..end].replace('\n', " ");
            if start > 0 {
                s.insert_str(0, "… ");
            }
            if end < blob.len() {
                s.push_str(" …");
            }
            Some(s)
        } else {
            None
        };
        if match_count > 0 {
            let title = read_session_title(&id).unwrap_or_else(|| id.clone());
            hits.push((
                id.clone(),
                mtime,
                match_count,
                snippet.unwrap_or_else(|| title.clone()),
            ));
        }
    }
    // Sort by match count DESC, then mtime DESC.
    hits.sort_by(|a, b| b.2.cmp(&a.2).then(b.1.cmp(&a.1)));
    let out: Vec<serde_json::Value> = hits
        .into_iter()
        .take(limit)
        .map(|(id, mtime, n, snippet)| {
            let ms = mtime
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0);
            let title = read_session_title(&id).unwrap_or_else(|| id.clone());
            serde_json::json!({
                "id": id,
                "title": title,
                "mtimeMs": ms,
                "matchCount": n,
                "snippet": snippet,
            })
        })
        .collect();
    Json(serde_json::json!({ "results": out, "query": needle })).into_response()
}

pub(super) async fn read_session_jsonl(
    State(_s): State<ApiState>,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> impl IntoResponse {
    // Reject path traversal and Windows absolute paths. Session ids are
    // basenames only: UUID-ish text plus legacy short ids.
    if !valid_session_id(&id) {
        return (StatusCode::BAD_REQUEST, "invalid session id").into_response();
    }
    let path = sessions_dir().join(format!("{}.jsonl", id));
    match std::fs::read_to_string(&path) {
        Ok(s) => {
            let mut normalized = crate::split_session_jsonl_records(&s).join("\n");
            if !normalized.is_empty() {
                normalized.push('\n');
            }
            // Return as text/plain so caller can stream-parse JSONL.
            (
                StatusCode::OK,
                [("content-type", "application/x-ndjson; charset=utf-8")],
                normalized,
            )
                .into_response()
        }
        Err(e) => (StatusCode::NOT_FOUND, format!("session not found: {}", e)).into_response(),
    }
}

/// Focused snippet endpoint for FindPopover's preview
/// pane. After the cross-session `/sessions/search` returns a hit, the UI
/// selects one row and calls this endpoint to fetch a wider context
/// excerpt around every match of `q` inside that ONE session.
///
/// Request:
/// GET /sessions/<id>/snippet?q=<text>&ctxLines=<N>
/// `ctxLines` is currently unused (the excerpt is char-based, not
/// line-based — sessions are dominated by streamed agent_message_chunk
/// events with no \n inside the text, so a line-based window collapses
/// to nothing useful). Accepted as a hint for forward compatibility
/// and to match the renderer's FindPopover request shape.
///
/// Response:
/// { id, query, hits: [ { tMs, around: string } ] }
///
/// `around` is a ≤500-char excerpt of the streamed message text with the
/// match wrapped in `<mark>...</mark>` (HTML — the renderer already uses
/// <mark> for the same purpose in FindPopover's highlight helper).
///
/// Behavior:
/// - Walks the on-disk JSONL once, concatenating every
/// `agent_message_chunk` payload's `content.text` into a single blob
/// (same approach as `/sessions/search` so cross-chunk matches work).
/// We also record the event timestamp on the first chunk in each
/// contiguous message group, so the response can report a `tMs` for
/// each match.
/// - Caps results at 5 hits — protects the renderer against a 1000-hit
/// blob blowing up the preview pane DOM.
/// - The id is sanitized the same way `read_session_jsonl` sanitizes:
/// allow only `[A-Za-z0-9_-]` so Windows `C:\...` and backslash
/// traversal cannot escape the sessions directory.
#[derive(Deserialize)]
pub(super) struct SnippetQuery {
    q: String,
    #[serde(rename = "ctxLines")]
    #[serde(default)]
    _ctx_lines: Option<usize>,
}

pub(super) async fn session_snippet(
    State(_s): State<ApiState>,
    axum::extract::Path(id): axum::extract::Path<String>,
    axum::extract::Query(qs): axum::extract::Query<SnippetQuery>,
) -> impl IntoResponse {
    // Sanitize id — must not allow path traversal or Windows absolute paths.
    if !valid_session_id(&id) {
        return (StatusCode::BAD_REQUEST, "invalid session id").into_response();
    }
    let needle = qs.q.trim().to_string();
    if needle.is_empty() {
        return Json(serde_json::json!({
            "id": id,
            "query": "",
            "hits": [],
        }))
        .into_response();
    }
    let path = sessions_dir().join(format!("{}.jsonl", id));
    let content = match std::fs::read_to_string(&path) {
        Ok(s) => s,
        Err(e) => {
            return (StatusCode::NOT_FOUND, format!("session not found: {}", e)).into_response();
        }
    };
    let mut normalized = crate::split_session_jsonl_records(&content).join("\n");
    if !normalized.is_empty() {
        normalized.push('\n');
    }
    let hits = compute_session_snippets(std::io::Cursor::new(normalized), &needle, 5);
    Json(serde_json::json!({
        "id": id,
        "query": needle,
        "hits": hits,
    }))
    .into_response()
}

#[derive(Deserialize, Default)]
#[serde(default)]
pub(super) struct ArchiveBody {
    #[serde(rename = "savePath")]
    save_path: Option<String>,
}

/// `POST /sessions/:tabId/archive`.
///
/// Two modes:
/// 1. `{savePath: "C:\\foo.zip"}` — archives to that server-side path,
/// returns JSON `ArchiveSummary`. Use this when the orchestrator runs
/// on the same host as shellX and wants the file persisted there.
/// 2. Empty body (or `savePath` omitted) — archives to a temp file,
/// streams the bytes back in the response body as
/// `application/zip` (Local/WSL) or `application/gzip` (SSH), deletes
/// the temp afterward. Use this when the orchestrator wants the
/// archive bytes directly (e.g. an orchestrator via WSL reads from
/// response body).
///
/// `tabId` in the URL path identifies which session to archive. Sanitized
/// against traversal characters but allows the per-tab `tab-<uuid>` shape.
/// `/sessions/:id/archive` — accepts a grok session id (UUID-shaped) and
/// resolves it to the owning tab id via SessionRegistry. AGENT-B7 fix:
/// the route was previously aliased straight to `archive_session` which
/// treats the path param as a tab id; passing a real session id created
/// a ghost tab with no cwd and returned 500 "session has no cwd yet".
pub(super) async fn archive_session_by_session_id(
    State(s): State<ApiState>,
    axum::extract::Path(session_id): axum::extract::Path<String>,
    body: Option<Json<ArchiveBody>>,
) -> Response {
    let registry = s
        .app
        .state::<std::sync::Arc<crate::acp::SessionRegistry>>()
        .inner()
        .clone();
    let tab_id = match registry.find_tab_by_session_id(&session_id).await {
        Some(t) => t,
        None => {
            return (
                StatusCode::NOT_FOUND,
                Json(serde_json::json!({
                    "ok": false,
                    "error": "session_not_found",
                    "message": format!(
                        "no live tab owns session id '{}'. Use POST /tabs/<tabId>/archive \
                         to archive by tab id directly.",
                        session_id
                    ),
                })),
            )
                .into_response();
        }
    };
    archive_session(State(s), axum::extract::Path(tab_id), body).await
}

pub(super) async fn archive_session(
    State(s): State<ApiState>,
    axum::extract::Path(tab_id): axum::extract::Path<String>,
    body: Option<Json<ArchiveBody>>,
) -> Response {
    if tab_id.is_empty() || tab_id.contains('/') || tab_id.contains("..") {
        return (StatusCode::BAD_REQUEST, "invalid tabId").into_response();
    }
    let registry = s
        .app
        .state::<std::sync::Arc<crate::acp::SessionRegistry>>()
        .inner()
        .clone();
    let Some(arc) = registry.get_existing(&tab_id).await else {
        return (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({
                "ok": false,
                "error": "tab_not_found",
                "message": format!("no live session exists for tab '{}'", tab_id),
            })),
        )
            .into_response();
    };
    let save_path_opt = body
        .and_then(|Json(b)| b.save_path)
        .filter(|p| !p.trim().is_empty());

    // Mode 1: explicit savePath — archive there, return JSON metadata.
    if let Some(save_path) = save_path_opt {
        return match crate::session_archive::archive_session_artifacts_inner(
            Some(tab_id),
            save_path,
            registry,
        )
        .await
        {
            Ok(summary) => Json(summary).into_response(),
            Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
        };
    }

    // Mode 2: stream the archive bytes back. Pick extension by transport.
    let guard = arc.lock().await;
    let info = guard.get_debug_session_info();
    drop(guard);
    let is_ssh = info.get("isSsh").and_then(|v| v.as_bool()).unwrap_or(false);
    let ext = if is_ssh { "tar.gz" } else { "zip" };
    let mime = if is_ssh {
        "application/gzip"
    } else {
        "application/zip"
    };
    let temp_path = std::env::temp_dir().join(format!(
        "shellxagent-archive-{}.{}",
        uuid::Uuid::new_v4(),
        ext
    ));
    let temp_path_str = temp_path.to_string_lossy().to_string();
    match crate::session_archive::archive_session_artifacts_inner(
        Some(tab_id.clone()),
        temp_path_str.clone(),
        registry,
    )
    .await
    {
        Ok(_) => match tokio::fs::read(&temp_path).await {
            Ok(bytes) => {
                let _ = tokio::fs::remove_file(&temp_path).await;
                let filename = format!("shellx-archive-{}.{}", tab_id, ext);
                Response::builder()
                    .status(StatusCode::OK)
                    .header("Content-Type", mime)
                    .header(
                        "Content-Disposition",
                        format!("attachment; filename=\"{}\"", filename),
                    )
                    .body(Body::from(bytes))
                    .unwrap_or_else(|_| {
                        (StatusCode::INTERNAL_SERVER_ERROR, "build response failed").into_response()
                    })
            }
            Err(e) => {
                let _ = tokio::fs::remove_file(&temp_path).await;
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    format!("read temp archive failed: {}", e),
                )
                    .into_response()
            }
        },
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
    }
}
