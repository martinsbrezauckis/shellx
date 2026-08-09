use super::*;

// ───── vision_describe (xAI Grok multimodal) ─────
//
// Calls xAI's OpenAI-compatible chat/completions endpoint with the
// current multimodal Grok model. Credential resolution is OAuth-first:
// 1. `~/.grok/auth.json` bearer written by `grok login`
// 2. ShellX Vault key "xai/api-key"
// 3. env GROK_VISION_API_KEY / XAI_API_KEY (developer overrides)
// 4. Legacy local password-store entries kept for back-compat.
//
// Returns both legacy `{description, usage}` fields and the newer
// `{text, ms_total}` shape so old callers and Grok's current tool habits
// both work.
pub(super) async fn tool_vision_describe(
    args: Value,
    ctx: &Arc<HostMcpContext>,
    tab_id: Option<&str>,
) -> Result<Value, String> {
    // Resolve image bytes + MIME.
    let path = args
        .get("path")
        .or_else(|| args.get("image_path"))
        .and_then(|v| v.as_str());
    let image_b64 = args.get("imageBase64").and_then(|v| v.as_str());
    let (data_url, src_label) = match (path, image_b64) {
        (Some(p), _) => {
            if p.is_empty() {
                return Err("vision_describe: empty path".to_string());
            }
            if let Some(ssh_ctx) = vision_ssh_context_for_tab(ctx, tab_id).await {
                if vision_remote_path_is_posix(p) {
                    (
                        read_vision_image_data_url_from_ssh(p, &ssh_ctx).await?,
                        p.to_string(),
                    )
                } else {
                    let resolved = resolve_readable_media_path(
                        "vision_describe",
                        p,
                        args.get("wslDistro").and_then(|v| v.as_str()),
                    )
                    .await?;
                    let mime = image_mime_for_path("vision_describe", &resolved, true)?;
                    let bytes =
                        read_file_with_cap_async("vision_describe", &resolved, 20 * 1024 * 1024)
                            .await?;
                    validate_image_magic("vision_describe", mime, &bytes)?;
                    use base64::Engine as _;
                    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
                    (format!("data:{};base64,{}", mime, b64), p.to_string())
                }
            } else {
                // Resolve to a host-readable path first, then apply the
                // same containment policy used by fs_read. WSL POSIX paths
                // are translated to UNC before validation when the tab has
                // WSL context; SSH paths need the HTTP MCP tab context above.
                let resolved = resolve_readable_media_path(
                    "vision_describe",
                    p,
                    args.get("wslDistro").and_then(|v| v.as_str()),
                )
                .await?;
                let mime = image_mime_for_path("vision_describe", &resolved, true)?;
                // Check metadata before reading so a malicious media path cannot
                // force a large allocation only to be rejected afterward.
                let bytes =
                    read_file_with_cap_async("vision_describe", &resolved, 20 * 1024 * 1024)
                        .await?;
                validate_image_magic("vision_describe", mime, &bytes)?;
                use base64::Engine as _;
                let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
                (format!("data:{};base64,{}", mime, b64), p.to_string())
            }
        }
        (None, Some(b)) => {
            if b.starts_with("data:") {
                (b.to_string(), "<base64>".to_string())
            } else {
                // Raw base64 — assume jpeg.
                (
                    format!("data:image/jpeg;base64,{}", b),
                    "<base64>".to_string(),
                )
            }
        }
        (None, None) => {
            return Err(
                "vision_describe: provide 'path', 'image_path', or 'imageBase64'".to_string(),
            );
        }
    };

    let prompt = args
        .get("prompt")
        .or_else(|| args.get("question"))
        .and_then(|v| v.as_str())
        .unwrap_or("Describe this image in detail. Be specific about what you see.")
        .to_string();
    let max_tokens = args
        .get("maxTokens")
        .or_else(|| args.get("max_tokens"))
        .and_then(|v| v.as_u64())
        .unwrap_or(800)
        .min(4096);

    let (bearer, auth_source) = resolve_xai_vision_bearer().await?;
    if bearer.len() < 8 {
        return Err("vision_describe: resolved xAI credential is suspiciously short".to_string());
    }

    // Default to grok-4.3, the current multimodal model available to
    // grok-build OAuth sessions. Allow override via:
    // - `model` argument in the tool call (per-request)
    // - env GROK_VISION_MODEL (global)
    let model = args
        .get("model")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .or_else(|| {
            std::env::var("GROK_VISION_MODEL")
                .ok()
                .filter(|s| !s.trim().is_empty())
        })
        .unwrap_or_else(|| "grok-4.3".to_string());
    let body = serde_json::json!({
        "model": model,
        "messages": [{
            "role": "user",
            "content": [
                {"type": "image_url", "image_url": {"url": data_url}},
                {"type": "text", "text": prompt}
            ]
        }],
        "max_tokens": max_tokens
    });

    let start = std::time::Instant::now();
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(90))
        .build()
        .map_err(|e| format!("vision_describe: http client init: {}", e))?;
    let resp = client
        .post("https://api.x.ai/v1/chat/completions")
        .bearer_auth(&bearer)
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("vision_describe: xAI request failed: {}", e))?;

    let status = resp.status();
    let resp_body: Value = resp
        .json()
        .await
        .map_err(|e| format!("vision_describe: parse response: {}", e))?;
    if !status.is_success() {
        return Err(format!(
            "vision_describe: xAI returned {}: {}",
            status,
            serde_json::to_string(&resp_body).unwrap_or_default()
        ));
    }
    let description = resp_body
        .get("choices")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("message"))
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_str())
        .unwrap_or("")
        .to_string();
    let usage = resp_body.get("usage").cloned().unwrap_or(Value::Null);
    let model = resp_body
        .get("model")
        .and_then(|v| v.as_str())
        .unwrap_or("grok-4.3")
        .to_string();
    Ok(json!({
        "text": description.clone(),
        "description": description,
        "model": model,
        "usage": usage,
        "source": src_label,
        "auth_source": auth_source,
        "ms_total": start.elapsed().as_millis() as u64,
    }))
}

pub(super) async fn resolve_xai_vision_bearer() -> Result<(String, &'static str), String> {
    if let Ok(token) = read_grok_oauth_token() {
        let trimmed = token.trim().to_string();
        if !trimmed.is_empty() {
            return Ok((trimmed, "oauth"));
        }
    }

    let vault = crate::shellx_vault::shared_backend();
    if let Ok(Some(k)) = vault.compat_get("xai/api-key").await {
        let trimmed = k.trim().to_string();
        if !trimmed.is_empty() {
            return Ok((trimmed, "vault:xai/api-key"));
        }
    }

    for env_name in ["GROK_VISION_API_KEY", "XAI_API_KEY"] {
        if let Ok(k) = std::env::var(env_name) {
            let trimmed = k.trim().to_string();
            if !trimmed.is_empty() {
                return Ok((trimmed, env_name));
            }
        }
    }

    for path in ["xai/api-key", "grok/api-key"] {
        match tokio::process::Command::new("pass")
            .arg("show")
            .arg(path)
            .output()
            .await
        {
            Ok(out) if out.status.success() => {
                let trimmed = String::from_utf8_lossy(&out.stdout).trim().to_string();
                if !trimmed.is_empty() {
                    return Ok((
                        trimmed,
                        if path == "xai/api-key" {
                            "pass:xai/api-key"
                        } else {
                            "pass:grok/api-key"
                        },
                    ));
                }
            }
            _ => {}
        }
    }

    Err("vision_describe: no xAI credential found. Run `grok login` so ~/.grok/auth.json is available, or add Settings -> Vault key `xai/api-key`, or set XAI_API_KEY/GROK_VISION_API_KEY.".to_string())
}

// ───── OAuth-token-backed xAI tools ─────
//
// Bearer JWT from `~/.grok/auth.json` works directly against api.x.ai/v1/*
// for STT/TTS/Vision — validated 2026-05-20. Avoids needing an api-key in
// `pass`/vault for the same endpoints the user is already logged into via
// `grok login`. The token file schema is roughly:
// { "https://auth.x.ai::<client_id>": { "key": "<JWT>", "expiry": ... } }
// Schema can shift across grok-build releases — we recursively walk the JSON
// looking for any `"key": "<string>"` longer than 100 chars (JWT-ish length).

/// Read the Bearer JWT from `~/.grok/auth.json`. Searches recursively for
/// any `"key": "<JWT>"` field whose value is longer than 100 chars — keeps
/// us resilient to grok-build's auth.json key-name shuffles. The caller is
/// responsible for handling the returned error as a friendly user message
/// (e.g. "run `grok login` first").
pub fn read_grok_oauth_token() -> Result<String, String> {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map_err(|_| "HOME/USERPROFILE unset".to_string())?;
    let path = std::path::PathBuf::from(home)
        .join(".grok")
        .join("auth.json");
    let body = std::fs::read_to_string(&path).map_err(|e| {
        format!(
            "read ~/.grok/auth.json failed: {} (run `grok login` first)",
            e
        )
    })?;
    let v: serde_json::Value =
        serde_json::from_str(&body).map_err(|e| format!("parse auth.json: {}", e))?;

    fn find_key(v: &serde_json::Value) -> Option<String> {
        if let Some(obj) = v.as_object() {
            if let Some(serde_json::Value::String(s)) = obj.get("key") {
                if s.len() > 100 {
                    return Some(s.clone());
                }
            }
            for val in obj.values() {
                if let Some(r) = find_key(val) {
                    return Some(r);
                }
            }
        }
        None
    }
    find_key(&v).ok_or_else(|| "no OAuth token in auth.json (run `grok login`)".to_string())
}

pub(super) fn optional_handle_list(args: &Value, key: &str) -> Result<Option<Vec<String>>, String> {
    let Some(value) = args.get(key) else {
        return Ok(None);
    };
    if value.is_null() {
        return Ok(None);
    }
    let arr = value
        .as_array()
        .ok_or_else(|| format!("x_search: '{}' must be an array of strings", key))?;
    if arr.len() > 20 {
        return Err(format!("x_search: '{}' supports at most 20 handles", key));
    }
    let mut out = Vec::with_capacity(arr.len());
    for item in arr {
        let handle = item
            .as_str()
            .ok_or_else(|| format!("x_search: '{}' entries must be strings", key))?
            .trim()
            .trim_start_matches('@')
            .to_string();
        if handle.len() > 64
            || !handle
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
        {
            return Err(format!(
                "x_search: '{key}' entries must be 1-64 ASCII letters, digits, or underscores"
            ));
        }
        if !handle.is_empty() {
            out.push(handle);
        }
    }
    if out.is_empty() {
        Ok(None)
    } else {
        Ok(Some(out))
    }
}

pub(super) fn optional_iso_date(args: &Value, key: &str) -> Result<Option<String>, String> {
    let Some(value) = args.get(key) else {
        return Ok(None);
    };
    if value.is_null() {
        return Ok(None);
    }
    let value = value
        .as_str()
        .ok_or_else(|| format!("x_search: '{key}' must be a YYYY-MM-DD string"))?
        .trim();
    if value.is_empty() {
        return Ok(None);
    }
    chrono::NaiveDate::parse_from_str(value, "%Y-%m-%d")
        .map_err(|_| format!("x_search: '{key}' must be a real date in YYYY-MM-DD form"))?;
    Ok(Some(value.to_string()))
}

pub(super) fn add_optional_bool_field(
    out: &mut serde_json::Map<String, Value>,
    args: &Value,
    key: &str,
) {
    if let Some(b) = args.get(key).and_then(|v| v.as_bool()) {
        out.insert(key.to_string(), Value::Bool(b));
    }
}

pub(super) fn parse_x_search_response(value: &Value, max_answer_chars: usize) -> Value {
    const MAX_CITATIONS: usize = 64;
    const MAX_TOOL_CALLS: usize = 16;
    const MAX_TOOL_INPUT_CHARS: usize = 2_000;
    let mut answer_parts: Vec<String> = Vec::new();
    let mut citations: Vec<Value> = Vec::new();
    let mut seen_urls: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut tool_calls: Vec<Value> = Vec::new();
    let mut citations_truncated = false;
    let mut tool_calls_truncated = false;

    if let Some(output) = value.get("output").and_then(|v| v.as_array()) {
        for item in output {
            if item.get("type").and_then(|v| v.as_str()) == Some("custom_tool_call") {
                if tool_calls.len() < MAX_TOOL_CALLS {
                    let input = item.get("input").cloned().unwrap_or(Value::Null);
                    let input_rendered = serde_json::to_string(&input).unwrap_or_default();
                    let input_chars = input_rendered.chars().count();
                    let input_truncated = input_chars > MAX_TOOL_INPUT_CHARS;
                    let compact_input = if input_truncated {
                        Value::String(input_rendered.chars().take(MAX_TOOL_INPUT_CHARS).collect())
                    } else {
                        input
                    };
                    tool_calls.push(json!({
                        "name": item.get("name").and_then(|value| value.as_str()).unwrap_or("").chars().take(96).collect::<String>(),
                        "input": compact_input,
                        "inputChars": input_chars,
                        "inputTruncated": input_truncated,
                    }));
                } else {
                    tool_calls_truncated = true;
                }
            }
            if let Some(content) = item.get("content").and_then(|v| v.as_array()) {
                for block in content {
                    if let Some(text) = block.get("text").and_then(|v| v.as_str()) {
                        if !text.is_empty() {
                            answer_parts.push(text.to_string());
                        }
                    }
                    if let Some(annotations) = block.get("annotations").and_then(|v| v.as_array()) {
                        for ann in annotations {
                            let url = ann.get("url").and_then(|v| v.as_str()).unwrap_or("");
                            if url.is_empty() || !seen_urls.insert(url.to_string()) {
                                continue;
                            }
                            if citations.len() >= MAX_CITATIONS {
                                citations_truncated = true;
                                continue;
                            }
                            citations.push(json!({
                                "url": url.chars().take(4_096).collect::<String>(),
                                "title": ann.get("title").and_then(|v| v.as_str()).unwrap_or("").chars().take(512).collect::<String>(),
                                "type": ann.get("type").and_then(|v| v.as_str()).unwrap_or("url_citation"),
                                "startIndex": ann.get("start_index").and_then(|v| v.as_u64()),
                                "endIndex": ann.get("end_index").and_then(|v| v.as_u64()),
                            }));
                        }
                    }
                }
            }
        }
    }

    let mut answer = answer_parts.join("\n\n").trim().to_string();
    let mut truncated = false;
    if answer.chars().count() > max_answer_chars {
        answer = answer.chars().take(max_answer_chars).collect::<String>();
        truncated = true;
    }
    let x_search_calls = value
        .pointer("/usage/server_side_tool_usage_details/x_search_calls")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);

    json!({
        "answer": answer,
        "citations": citations,
        "citationsTruncated": citations_truncated,
        "toolCalls": tool_calls,
        "toolCallsTruncated": tool_calls_truncated,
        "xSearchCalls": x_search_calls,
        "responseId": value.get("id").and_then(|v| v.as_str()).unwrap_or(""),
        "model": value.get("model").and_then(|v| v.as_str()).unwrap_or(""),
        "truncated": truncated,
    })
}

/// `x_search` — server-side X post search via xAI Responses API using
/// the same OAuth bearer Grok Build stores under `~/.grok/auth.json`.
pub(super) async fn tool_x_search(args: Value) -> Result<Value, String> {
    const MAX_RESPONSE_BYTES: usize = 4 * 1024 * 1024;
    let query = args
        .get("query")
        .and_then(|v| v.as_str())
        .ok_or("x_search: missing 'query'")?
        .trim();
    if query.is_empty() {
        return Err("x_search: query is empty".to_string());
    }
    if query.chars().count() > 2000 {
        return Err("x_search: query exceeds 2000 character cap".to_string());
    }

    let allowed = optional_handle_list(&args, "allowed_x_handles")?;
    let excluded = optional_handle_list(&args, "excluded_x_handles")?;
    if allowed.is_some() && excluded.is_some() {
        return Err(
            "x_search: allowed_x_handles and excluded_x_handles cannot be combined".to_string(),
        );
    }

    let mut tool = serde_json::Map::new();
    tool.insert("type".to_string(), Value::String("x_search".to_string()));
    if let Some(handles) = allowed {
        tool.insert("allowed_x_handles".to_string(), json!(handles));
    }
    if let Some(handles) = excluded {
        tool.insert("excluded_x_handles".to_string(), json!(handles));
    }
    let from_date = optional_iso_date(&args, "from_date")?;
    let to_date = optional_iso_date(&args, "to_date")?;
    if from_date
        .as_deref()
        .zip(to_date.as_deref())
        .is_some_and(|(from, to)| from > to)
    {
        return Err("x_search: from_date must not be later than to_date".to_string());
    }
    if let Some(value) = from_date {
        tool.insert("from_date".to_string(), Value::String(value));
    }
    if let Some(value) = to_date {
        tool.insert("to_date".to_string(), Value::String(value));
    }
    add_optional_bool_field(&mut tool, &args, "enable_image_understanding");
    add_optional_bool_field(&mut tool, &args, "enable_video_understanding");

    let requested_model = args
        .get("model")
        .and_then(|v| v.as_str())
        .unwrap_or("grok-4.3")
        .trim();
    let model = if requested_model.is_empty() {
        "grok-4.3"
    } else {
        requested_model
    };
    if model.len() > 128
        || !model
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
    {
        return Err("x_search: model must be a 1-128 character xAI model id".to_string());
    }
    let max_answer_chars = args
        .get("max_answer_chars")
        .and_then(|v| v.as_u64())
        .unwrap_or(6000)
        .clamp(1000, 20_000) as usize;
    let bearer = read_grok_oauth_token()?;
    let body = json!({
        "model": model,
        "input": [
            { "role": "user", "content": query }
        ],
        "tools": [Value::Object(tool)],
    });
    let start = std::time::Instant::now();
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(90))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| format!("x_search: client: {}", e))?;
    let res = client
        .post("https://api.x.ai/v1/responses")
        .bearer_auth(&bearer)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("x_search: POST /v1/responses: {}", e))?;
    let status = res.status().as_u16();
    let body_bytes =
        crate::http_body::read_reqwest_body_bounded(res, MAX_RESPONSE_BYTES, "x_search response")
            .await?;
    if status != 200 {
        let body_text = String::from_utf8_lossy(&body_bytes);
        return Err(format!(
            "x_search: xAI Responses HTTP {}: {}",
            status,
            body_text.chars().take(700).collect::<String>()
        ));
    }
    let response: Value =
        serde_json::from_slice(&body_bytes).map_err(|e| format!("x_search: parse json: {}", e))?;
    let mut parsed = parse_x_search_response(&response, max_answer_chars);
    if let Value::Object(ref mut map) = parsed {
        map.insert(
            "msTotal".to_string(),
            Value::Number(serde_json::Number::from(start.elapsed().as_millis() as u64)),
        );
    }
    Ok(parsed)
}

/// `voice_tts` — synthesize speech via xAI Grok-TTS. Writes an MP3 blob to
/// `out_path` (defaults to `<cwd>/.shellx-out/tts-<unix_secs>.mp3`). Uses
/// the OAuth bearer from `~/.grok/auth.json` — no api-key plumbing needed.
pub(super) async fn tool_voice_tts(args: Value) -> Result<Value, String> {
    const MAX_TTS_RESPONSE_BYTES: usize = 16 * 1024 * 1024;
    let text = args
        .get("text")
        .and_then(|v| v.as_str())
        .ok_or("voice_tts: missing 'text'")?;
    if text.is_empty() {
        return Err("voice_tts: text is empty".into());
    }
    if text.len() > 5000 {
        return Err("voice_tts: text exceeds 5000 char cap".into());
    }
    let voice = args.get("voice").and_then(|v| v.as_str()).unwrap_or("eve");
    let language = args
        .get("language")
        .and_then(|v| v.as_str())
        .unwrap_or("en");
    // Resolve out_path with HOME containment validation.
    let out_path = match args.get("out_path").and_then(|v| v.as_str()) {
        Some(p) => validate_fs_path("voice_tts", p)?,
        None => {
            let cwd = std::env::current_dir().map_err(|e| format!("cwd: {}", e))?;
            let ts = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0);
            cwd.join(".shellx-out").join(format!("tts-{}.mp3", ts))
        }
    };
    enforce_home_containment("voice_tts", &out_path, FsAccessKind::Write)?;
    let bearer = read_grok_oauth_token()?;
    if let Some(parent) = out_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir parent: {}", e))?;
    }
    let body = serde_json::json!({
        "model": "grok-tts",
        "voice": voice,
        "text": text,
        "language": language,
    });
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| format!("client: {}", e))?;
    let res = client
        .post("https://api.x.ai/v1/tts")
        .bearer_auth(&bearer)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("api.x.ai POST /v1/tts: {}", e))?;
    let status = res.status().as_u16();
    let bytes = crate::http_body::read_reqwest_body_bounded(
        res,
        if status == 200 {
            MAX_TTS_RESPONSE_BYTES
        } else {
            64 * 1024
        },
        "xAI TTS response",
    )
    .await?;
    if status != 200 {
        let err_text = String::from_utf8_lossy(&bytes)
            .chars()
            .take(500)
            .collect::<String>();
        return Err(format!("xAI TTS HTTP {}: {}", status, err_text));
    }
    validate_audio_magic("voice_tts", "audio/mpeg", &bytes)?;
    crate::session_git::write_private_file(&out_path, &bytes, "voice_tts output")?;
    Ok(serde_json::json!({
        "path": out_path.to_string_lossy(),
        "bytes": bytes.len(),
        "voice": voice,
        "language": language,
    }))
}

/// `voice_stt_v2` — transcribe audio via xAI Grok-STT using the OAuth
/// bearer. Replacement for the api-key STT path in `voice.rs` (we keep
/// the legacy path alive; this is the additive OAuth route).
pub(super) async fn tool_voice_stt_v2(args: Value) -> Result<Value, String> {
    const MAX_STT_RESPONSE_BYTES: usize = 2 * 1024 * 1024;
    let audio_path = args
        .get("audio_path")
        .and_then(|v| v.as_str())
        .ok_or("voice_stt_v2: missing 'audio_path'")?;
    let path = validate_fs_path("voice_stt_v2", audio_path)?;
    enforce_home_containment("voice_stt_v2", &path, FsAccessKind::Read)?;
    let mime = audio_mime_for_path("voice_stt_v2", &path)?;
    let audio_bytes = read_file_with_cap_sync("voice_stt_v2", &path, 30 * 1024 * 1024)?;
    validate_audio_magic("voice_stt_v2", mime, &audio_bytes)?;
    let bearer = read_grok_oauth_token()?;

    let fname = path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("audio.mp3")
        .to_string();
    let part = reqwest::multipart::Part::bytes(audio_bytes)
        .file_name(fname)
        .mime_str(mime)
        .map_err(|e| format!("mime: {}", e))?;
    let form = reqwest::multipart::Form::new()
        .text("model", "grok-stt")
        .part("file", part);
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| format!("client: {}", e))?;
    let res = client
        .post("https://api.x.ai/v1/stt")
        .bearer_auth(&bearer)
        .multipart(form)
        .send()
        .await
        .map_err(|e| format!("POST /v1/stt: {}", e))?;
    let status = res.status().as_u16();
    let body = crate::http_body::read_reqwest_body_bounded(
        res,
        MAX_STT_RESPONSE_BYTES,
        "xAI STT response",
    )
    .await?;
    if status != 200 {
        return Err(format!(
            "xAI STT HTTP {}: {}",
            status,
            String::from_utf8_lossy(&body)
                .chars()
                .take(500)
                .collect::<String>()
        ));
    }
    let v: Value = serde_json::from_slice(&body).map_err(|e| format!("parse json: {}", e))?;
    Ok(v)
}

/// Hidden compatibility alias for older sessions that learned
/// `vision_describe_v2`. The advertised tool is now `vision_describe`;
/// keep this dispatcher arm so resumed sessions do not fail mid-task.
pub(super) async fn tool_vision_describe_v2(
    args: Value,
    ctx: &Arc<HostMcpContext>,
    tab_id: Option<&str>,
) -> Result<Value, String> {
    tool_vision_describe(args, ctx, tab_id).await
}

// ───── shared helpers ─────

pub(super) fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
