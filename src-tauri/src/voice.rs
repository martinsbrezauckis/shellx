//! src-tauri/src/voice.rs — push-to-talk STT.
//!
//! Wires the composer's push-to-talk mic button to xAI's Grok Speech-to-Text
//! API (https://api.x.ai/v1/stt, REST batch endpoint). The frontend captures
//! audio via `MediaRecorder` (WebM/Opus on Chrome/WebView2), sends the bytes
//! to the Rust `transcribe_audio_blob` command, which:
//!
//! 1. Resolves the xAI API key from one of (in priority order): the
//! `XAI_API_KEY` env var (developer convenience — set via shell);
//! `pass show xai/api-key` (the user's pass store; only works if the
//! GPG agent cache is unlocked); or `pass show grok/api-key` (alternate
//! naming). Each pass invocation runs with
//! PINENTRY_USER_DATA=USE_CURSES=0 so a locked GPG cache fails FAST
//! (~30ms) instead of hanging the agent on a missing TTY pinentry.
//!
//! 2. POSTs the audio bytes to `https://api.x.ai/v1/stt` as multipart/form-
//! data with fields:
//! - `file` — the audio bytes (filename "voice.webm")
//! - `model` — "grok-stt-1" (xAI's batch-STT default; flag is
//! configurable via `XAI_STT_MODEL` env if the model
//! name changes in a future xAI release)
//! - `response_format` — "json" (we extract the `text` field)
//!
//! `Authorization: Bearer <key>` header.
//!
//! 3. Parses the JSON response, returns `{text, ms_total}`. The frontend
//! inserts `text` at the composer cursor.
//!
//! Failure modes (all return Err with a clear message the frontend renders
//! to the user):
//! - API key missing → "Add `xai/api-key` to pass (or set XAI_API_KEY)
//! and re-launch."
//! - pass locked → "GPG cache locked. Run `pass show xai/api-key` in a
//! terminal once to unlock, then retry."
//! - Network / xAI 4xx-5xx → forwards the xAI error message.
//! - Empty audio (< 1 KB) → "No audio captured."
//!
//! Cost note: xAI STT batch is $0.10/hour, streaming $0.20/hour (April 2026
//! pricing). A typical push-to-talk dictation is ~3-10 seconds, so the
//! per-utterance cost is ~$0.0003 — negligible.
//!
//! Reference:
//! - https://x.ai/news/grok-stt-and-tts-apis (launch announcement, 2026-04-18)
//! - https://docs.x.ai/api#speech-to-text (POST /v1/stt spec)

use std::time::Duration;

use tracing::{info, warn};

#[cfg(target_os = "windows")]
use crate::winproc::NoWindowExt as _;

/// xAI STT REST endpoint. Lives behind a constant so a future endpoint
/// migration is one-line.
const XAI_STT_URL: &str = "https://api.x.ai/v1/stt";
/// Default model. Override via `XAI_STT_MODEL` env if xAI renames it.
const DEFAULT_STT_MODEL: &str = "grok-stt-1";

/// #355: xAI TTS endpoint. Returns audio bytes (default mp3).
const XAI_TTS_URL: &str = "https://api.x.ai/v1/tts";
const DEFAULT_TTS_MODEL: &str = "grok-tts-1";
// Default xAI TTS voice. Live API verified (2026-05-21): "ember" returns
// 404 "Voice 'ember' not found". The xAI catalog includes ara / eve /
// rex / sal / leo / una — verified during local testing. Using `ara`
// as the default. Override via `XAI_TTS_VOICE` env.
const DEFAULT_TTS_VOICE: &str = "ara";

/// Frontend-facing response shape — `text` is what gets inserted into
/// the composer; `ms_total` is the wall-clock from request start to
/// xAI response received, useful for the "STT 1.2s" badge.
#[derive(serde::Serialize)]
pub struct TranscribeResult {
    pub text: String,
    pub ms_total: u64,
}

/// Tauri command: takes the audio bytes from the React MediaRecorder
/// blob, transcribes via xAI STT, returns the text + timing.
///
/// `audio_bytes` is the raw Vec<u8> from the WebView's Blob — serialized
/// as a JSON array by Tauri's invoke bridge.
/// `mime_type` is whatever MediaRecorder produced (browser-dependent —
/// typically "audio/webm;codecs=opus" on Chromium-based WebView2).
#[tauri::command]
pub async fn transcribe_audio_blob(
    audio_bytes: Vec<u8>,
    mime_type: Option<String>,
) -> Result<TranscribeResult, String> {
    let start = std::time::Instant::now();
    if audio_bytes.len() < 1024 {
        return Err("No audio captured (recording was too short).".to_string());
    }
    /* Cap audio bytes to prevent
     * memory-exhaustion DoS. A user (or buggy MediaRecorder) could
     * accumulate gigabytes of audio; the Vec<u8> is marshalled through
     * serde_json as an array of integers (≈4× memory overhead during
     * the invoke deserialize), so a 100 MB recording could spike ≈400
     * MB. 30 MB at typical Opus bitrate (≈48 kbps) covers ≈80 minutes
     * of speech — well past any reasonable single push-to-talk
     * dictation. Surfaced to the user with a clear error so the UI can
     * suggest "split into multiple shorter clips". */
    const MAX_AUDIO_BYTES: usize = 30 * 1024 * 1024;
    if audio_bytes.len() > MAX_AUDIO_BYTES {
        return Err(format!(
            "Recording too long ({} MB); max {} MB. Split into shorter clips.",
            audio_bytes.len() / (1024 * 1024),
            MAX_AUDIO_BYTES / (1024 * 1024)
        ));
    }
    let api_key = resolve_xai_key().await.ok_or_else(|| {
        // Frontend (MicButton.tsx) detects the leading "STT_NO_KEY:"
        // marker and renders an inline explainer pointing at
        // Settings → Vault instead of a generic error toast.
        "STT_NO_KEY: xAI API key not configured. Add it in \
             Settings → Vault as `xai/api-key`, or set the XAI_API_KEY \
             env var. Voice transcription needs api.x.ai access (separate \
             from the local Grok session auth at ~/.grok/auth.json)."
            .to_string()
    })?;

    let mime = mime_type.unwrap_or_else(|| "audio/webm".to_string());
    let filename = match mime.as_str() {
        m if m.starts_with("audio/webm") => "voice.webm",
        m if m.starts_with("audio/ogg") => "voice.ogg",
        m if m.starts_with("audio/wav") => "voice.wav",
        m if m.starts_with("audio/mp3") || m.starts_with("audio/mpeg") => "voice.mp3",
        m if m.starts_with("audio/mp4") || m.starts_with("audio/m4a") => "voice.m4a",
        _ => "voice.bin",
    };

    let model = std::env::var("XAI_STT_MODEL").unwrap_or_else(|_| DEFAULT_STT_MODEL.to_string());

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(45)) // batch STT for short clips finishes in <2s
        .build()
        .map_err(|e| format!("reqwest client build failed: {}", e))?;

    let part_file = reqwest::multipart::Part::bytes(audio_bytes.clone())
        .file_name(filename.to_string())
        .mime_str(&mime)
        .map_err(|e| format!("mime_str failed: {}", e))?;
    let form = reqwest::multipart::Form::new()
        .part("file", part_file)
        .text("model", model.clone())
        .text("response_format", "json");

    let resp = client
        .post(XAI_STT_URL)
        .bearer_auth(&api_key)
        .multipart(form)
        .send()
        .await
        .map_err(|e| format!("xAI STT request failed: {}", e))?;

    let status = resp.status();
    let body = resp
        .text()
        .await
        .map_err(|e| format!("read xAI response body failed: {}", e))?;
    if !status.is_success() {
        warn!(
            "xAI STT non-2xx: {} body={}",
            status,
            body.chars().take(400).collect::<String>()
        );
        return Err(format!("xAI STT {}: {}", status, body));
    }

    // Response shape (per xAI docs):
    // { "text": "...", "language": "en", "duration": 3.4, "segments": [...] }
    // We only need `text` for the composer.
    let parsed: serde_json::Value = serde_json::from_str(&body).map_err(|e| {
        format!(
            "xAI STT response not JSON: {}: {}",
            e,
            &body[..body.len().min(200)]
        )
    })?;
    let text = parsed
        .get("text")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .trim()
        .to_string();

    let ms_total = start.elapsed().as_millis() as u64;
    info!(
        "voice: transcribed {}B audio ({}) → {}chars in {}ms",
        audio_bytes.len(),
        filename,
        text.len(),
        ms_total
    );
    Ok(TranscribeResult { text, ms_total })
}

/// Resolve the xAI API key. Order ( OAuth wins by default):
/// 1. **grok-build OAuth bearer** at `~/.grok/auth.json`. Same Bearer the
/// installed grok-build CLI uses; covers STT/TTS/Vision against
/// `api.x.ai/v1/*` for any user already logged into grok-build. This is
/// the default for shipped users — they DON'T need a separate xai/api-key.
/// 2. **Encrypted in-app vault** — `vault.get("xai/api-key")`. For users
/// who want to use a separate API key (different account / billing /
/// developer testing). Wins over env/pass so a per-user override sticks.
/// 3. `XAI_API_KEY` env var — developer convenience.
/// 4. `pass show xai/api-key` — local pass store.
/// 5. `pass show grok/api-key` — alternate naming kept for back-compat.
///
/// Returns `None` only if `~/.grok/auth.json` is missing AND no key in any
/// other source. The frontend renders a "run `grok login` first" hint in
/// that case (see `MicButton.tsx`).
async fn resolve_xai_key() -> Option<String> {
    // (1) OAuth — default for any user logged into grok-build.
    if let Ok(token) = crate::host_mcp::read_grok_oauth_token() {
        let trimmed = token.trim().to_string();
        if !trimmed.is_empty() {
            return Some(trimmed);
        }
    }
    // (2) Encrypted vault — explicit override.
    if let Ok(vault) = crate::vault::Vault::open() {
        if let Ok(Some(k)) = vault.get("xai/api-key").await {
            let trimmed = k.trim().to_string();
            if !trimmed.is_empty() {
                return Some(trimmed);
            }
        }
    }
    // (3) env override
    if let Ok(k) = std::env::var("XAI_API_KEY") {
        let trimmed = k.trim().to_string();
        if !trimmed.is_empty() {
            return Some(trimmed);
        }
    }
    // (4) and (5) pass paths
    for path in &["xai/api-key", "grok/api-key"] {
        if let Some(k) = try_pass_show(path) {
            return Some(k);
        }
    }
    None
}

/// Run `pass show <path>` with PINENTRY disabled so a locked GPG cache
/// fails fast. Returns Some(trimmed_value) on success, None on any
/// failure (missing entry, locked cache, no `pass` on PATH).
fn try_pass_show(path: &str) -> Option<String> {
    let mut cmd = std::process::Command::new("pass");
    cmd.arg("show").arg(path);
    cmd.env("GPG_TTY", "");
    cmd.env("PINENTRY_USER_DATA", "USE_CURSES=0");
    #[cfg(target_os = "windows")]
    {
        cmd.no_window();
    }
    let out = cmd.output().ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

/// Tauri command exposed so the Settings UI can show "STT: ready / no
/// API key configured" without leaking key material. Returns the source
/// label only (`"vault"`, `"env"`, `"pass:xai/api-key"`, `"pass:grok/api-key"`,
/// or `"none"`), NEVER the key value itself.
///
/// Probe order MUST match `resolve_xai_key`
/// (vault → env → pass) so vault-only users (who paste their key into
/// Settings → Vault and never touch env or pass) get an honest "vault"
/// label instead of "none". Prior version skipped the vault probe and
/// would have lied about a working STT setup once a Settings → Voice
/// status indicator UI lands.
#[tauri::command]
pub async fn voice_credential_source() -> String {
    // OAuth first — matches resolve_xai_key order. UI shows "oauth" so
    // the user knows STT works without a separate API key.
    if let Ok(token) = crate::host_mcp::read_grok_oauth_token() {
        if !token.trim().is_empty() {
            return "oauth".to_string();
        }
    }
    if let Ok(vault) = crate::vault::Vault::open() {
        if let Ok(Some(_)) = vault.get("xai/api-key").await {
            return "vault".to_string();
        }
    }
    if let Ok(k) = std::env::var("XAI_API_KEY") {
        if !k.trim().is_empty() {
            return "env".to_string();
        }
    }
    for path in &["xai/api-key", "grok/api-key"] {
        if try_pass_show(path).is_some() {
            return format!("pass:{}", path);
        }
    }
    "none".to_string()
}

/// #355: xAI TTS. Frontend passes the text from grok's reply
/// once it arrives; we POST to xAI's `/v1/tts`, get audio bytes back,
/// return them base64-encoded so the WebView can feed them to an
/// `<audio>` element via `data:audio/mpeg;base64,...`. Voice + model
/// are overridable via `XAI_TTS_VOICE` / `XAI_TTS_MODEL` env vars.
///
/// Same credential resolution as STT (OAuth → vault → env → pass).
#[derive(serde::Serialize)]
pub struct SynthesizeResult {
    /// `data:audio/mpeg;base64,...` ready for the WebView `<audio>` src.
    pub audio_data_url: String,
    /// MIME of the underlying audio (typically `audio/mpeg`).
    pub mime: String,
    pub ms_total: u64,
}

#[tauri::command]
pub async fn synthesize_voice(text: String) -> Result<SynthesizeResult, String> {
    if text.trim().is_empty() {
        return Err("empty text".to_string());
    }
    // Cap at ~4000 chars per call — TTS endpoint limits + most replies
    // get truncated to "voice-friendly length" anyway. The voice-chat
    // prompt-mode hint pushes grok toward short conversational replies.
    let truncated = if text.chars().count() > 4000 {
        let take_n: String = text.chars().take(4000).collect();
        warn!(
            "voice: synthesize_voice text trimmed from {} to 4000 chars",
            text.len()
        );
        take_n
    } else {
        text
    };

    let start = std::time::Instant::now();
    let api_key = resolve_xai_key().await.ok_or_else(|| {
        "STT_NO_KEY: no xAI credential (run `grok login` or add xai/api-key to vault)".to_string()
    })?;

    let model = std::env::var("XAI_TTS_MODEL").unwrap_or_else(|_| DEFAULT_TTS_MODEL.to_string());
    let voice = std::env::var("XAI_TTS_VOICE").unwrap_or_else(|_| DEFAULT_TTS_VOICE.to_string());

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(|e| format!("reqwest client build failed: {}", e))?;

    // xAI TTS payload shape (verified live 2026-05-21):
    // {model, voice, text, language, response_format}
    // Initial fix swapped `input` → `text` (xAI naming). The
    // second 422 from live testing showed `language` is ALSO required;
    // dropping it returns 422 "missing field `language`". Default `en`
    // matches voice repertoire; override via XAI_TTS_LANGUAGE env.
    let language = std::env::var("XAI_TTS_LANGUAGE").unwrap_or_else(|_| "en".to_string());
    let body = serde_json::json!({
        "model": model,
        "voice": voice,
        "text": truncated,
        "language": language,
        "response_format": "mp3",
    });

    let resp = client
        .post(XAI_TTS_URL)
        .bearer_auth(&api_key)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("xAI TTS request failed: {}", e))?;

    let status = resp.status();
    if !status.is_success() {
        let err_body = resp.text().await.unwrap_or_default();
        warn!(
            "xAI TTS non-2xx: {} body={}",
            status,
            err_body.chars().take(400).collect::<String>()
        );
        return Err(format!("xAI TTS {}: {}", status, err_body));
    }

    // Upstream could return arbitrary bytes; cap at
    // 16 MiB to avoid OOM when the data URL hits the <audio> src.
    // 16 MiB of mp3 is ~17 hours of speech at 64 kbps — more than
    // any sane TTS reply needs.
    const MAX_AUDIO_BYTES: u64 = 16 * 1024 * 1024;
    if let Some(declared) = resp.content_length() {
        if declared > MAX_AUDIO_BYTES {
            return Err(format!(
                "xAI TTS response too large: {} bytes (cap {})",
                declared, MAX_AUDIO_BYTES
            ));
        }
    }
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("read xAI TTS body failed: {}", e))?;
    if (bytes.len() as u64) > MAX_AUDIO_BYTES {
        return Err(format!(
            "xAI TTS response too large: {} bytes (cap {})",
            bytes.len(),
            MAX_AUDIO_BYTES
        ));
    }

    use base64::Engine as _;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    let mime = "audio/mpeg".to_string();
    let audio_data_url = format!("data:{};base64,{}", mime, b64);

    let ms_total = start.elapsed().as_millis() as u64;
    info!(
        "voice: synthesized {}chars → {}B audio in {}ms (voice={}, model={})",
        truncated.len(),
        bytes.len(),
        ms_total,
        voice,
        model
    );
    Ok(SynthesizeResult {
        audio_data_url,
        mime,
        ms_total,
    })
}
