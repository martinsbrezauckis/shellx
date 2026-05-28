// src-tauri/src/outside_connector_runtime.rs
//
// Background receiver runtime for outside connectors. External messages
// are normalized into the same audited inbound path used by the simulator:
// allowlists are enforced before anything can reach a shellX inbox.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};
use tokio::time::{sleep, timeout};
use tokio_tungstenite::{connect_async, tungstenite::Message};
use tracing::{info, warn};

use crate::outside_connectors::{
    read_vault_value, sanitized_reqwest_error, OutsideConnector, OutsideConnectorDispatchMode,
    OutsideConnectorEventStatus, OutsideConnectorInboundInput, OutsideConnectorProvider,
    OutsideConnectorStore, OutsideConnectorTarget,
};

const TELEGRAM_POLL_TIMEOUT_SECS: u64 = 25;
const TELEGRAM_IDLE_SLEEP: Duration = Duration::from_secs(3);
const TELEGRAM_ERROR_SLEEP: Duration = Duration::from_secs(5);
const OUTSIDE_CONNECTOR_PROMPT_TIMEOUT: Duration = Duration::from_secs(60 * 60);
const DISCORD_GATEWAY_URL: &str = "wss://gateway.discord.gg/?v=10&encoding=json";
const DISCORD_INTENT_DIRECT_MESSAGES: u64 = 1 << 12;
const DISCORD_IDLE_SLEEP: Duration = Duration::from_secs(3);
const DISCORD_CONFIG_CHECK_SLEEP: Duration = Duration::from_secs(5);
const DISCORD_RECONNECT_MIN_SLEEP: Duration = Duration::from_secs(3);
const DISCORD_RECONNECT_MAX_SLEEP: Duration = Duration::from_secs(60);

#[derive(Clone, Debug)]
struct RuntimeConnector {
    id: String,
    token_key: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeState {
    #[serde(default)]
    telegram_offsets: BTreeMap<String, i64>,
}

pub(crate) fn start_outside_connector_runtime(app: AppHandle) {
    let telegram_app = app.clone();
    tauri::async_runtime::spawn(async {
        telegram_poll_loop(telegram_app).await;
    });
    tauri::async_runtime::spawn(async {
        discord_gateway_supervisor_loop().await;
    });
    info!("outside connector runtime scheduled");
}

#[derive(Clone, Debug)]
pub(crate) struct TelegramParsedUpdate {
    pub update_id: Option<i64>,
    pub input: Option<OutsideConnectorInboundInput>,
}

pub(crate) fn telegram_update_to_inbound(update: &Value) -> TelegramParsedUpdate {
    let update_id = update.get("update_id").and_then(Value::as_i64);
    let message = update
        .get("message")
        .or_else(|| update.get("edited_message"));
    let input = message.and_then(telegram_message_to_inbound);
    TelegramParsedUpdate { update_id, input }
}

fn telegram_message_to_inbound(message: &Value) -> Option<OutsideConnectorInboundInput> {
    let chat_id = json_id_to_string(message.get("chat")?.get("id")?)?;
    let sender_id = message
        .get("from")
        .and_then(|from| from.get("id"))
        .and_then(json_id_to_string)
        .unwrap_or_else(|| chat_id.clone());
    let text = message
        .get("text")
        .or_else(|| message.get("caption"))
        .and_then(Value::as_str)?
        .trim()
        .to_string();
    if text.is_empty() {
        return None;
    }
    Some(OutsideConnectorInboundInput {
        sender_id,
        conversation_id: Some(chat_id),
        guild_id: None,
        text,
    })
}

pub(crate) fn discord_message_create_to_inbound(
    event: &Value,
) -> Option<OutsideConnectorInboundInput> {
    if event.get("guild_id").is_some() {
        return None;
    }
    let author = event.get("author")?;
    if author.get("bot").and_then(Value::as_bool).unwrap_or(false) {
        return None;
    }
    let sender_id = author.get("id")?.as_str()?.trim().to_string();
    if sender_id.is_empty() {
        return None;
    }
    let channel_id = event.get("channel_id")?.as_str()?.trim().to_string();
    if channel_id.is_empty() {
        return None;
    }
    let text = event.get("content")?.as_str()?.trim().to_string();
    if text.is_empty() {
        return None;
    }
    Some(OutsideConnectorInboundInput {
        sender_id,
        conversation_id: Some(channel_id),
        guild_id: None,
        text,
    })
}

fn json_id_to_string(value: &Value) -> Option<String> {
    match value {
        Value::String(s) if !s.trim().is_empty() => Some(s.trim().to_string()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

async fn telegram_poll_loop(app: AppHandle) {
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(TELEGRAM_POLL_TIMEOUT_SECS + 10))
        .build()
    {
        Ok(client) => client,
        Err(e) => {
            warn!(
                "outside_connector_runtime: telegram client init failed: {}",
                e
            );
            return;
        }
    };

    loop {
        let store = match crate::get_or_open_outside_connectors() {
            Ok(store) => store,
            Err(e) => {
                warn!(
                    "outside_connector_runtime: connector store unavailable: {}",
                    e
                );
                sleep(TELEGRAM_ERROR_SLEEP).await;
                continue;
            }
        };
        let connectors = enabled_telegram_connectors(&store).await;
        if connectors.is_empty() {
            sleep(TELEGRAM_IDLE_SLEEP).await;
            continue;
        }

        for connector in connectors {
            if let Err(e) = poll_telegram_connector(&app, &client, &store, &connector).await {
                let _ = store.set_runtime_error(&connector.id, Some(&e)).await;
                warn!(
                    "outside_connector_runtime: telegram poll failed for {}: {}",
                    connector.id, e
                );
                sleep(TELEGRAM_ERROR_SLEEP).await;
            }
        }
    }
}

async fn enabled_telegram_connectors(store: &Arc<OutsideConnectorStore>) -> Vec<RuntimeConnector> {
    store
        .list()
        .await
        .into_iter()
        .filter(|connector| connector.enabled)
        .filter_map(|connector| match connector.provider {
            OutsideConnectorProvider::Telegram {
                bot_token_vault_key,
                ..
            } => Some(RuntimeConnector {
                id: connector.id,
                token_key: bot_token_vault_key,
            }),
            _ => None,
        })
        .collect()
}

async fn enabled_discord_connectors(
    store: &Arc<OutsideConnectorStore>,
    token_key: Option<&str>,
) -> Vec<RuntimeConnector> {
    store
        .list()
        .await
        .into_iter()
        .filter(|connector| connector.enabled)
        .filter_map(|connector| match connector.provider {
            OutsideConnectorProvider::Discord {
                bot_token_vault_key,
                ..
            } if token_key
                .map(|key| key == bot_token_vault_key)
                .unwrap_or(true) =>
            {
                Some(RuntimeConnector {
                    id: connector.id,
                    token_key: bot_token_vault_key,
                })
            }
            _ => None,
        })
        .collect()
}

async fn poll_telegram_connector(
    app: &AppHandle,
    client: &reqwest::Client,
    store: &Arc<OutsideConnectorStore>,
    connector: &RuntimeConnector,
) -> Result<(), String> {
    let token = read_vault_value(&connector.token_key).await?;
    let token = crate::outside_connectors::normalize_telegram_bot_token(&token)?;

    let mut state = load_runtime_state();
    let offset = state.telegram_offsets.get(&connector.id).copied();
    let mut body = json!({
        "timeout": TELEGRAM_POLL_TIMEOUT_SECS,
        "allowed_updates": ["message"],
    });
    if let Some(offset) = offset {
        body["offset"] = json!(offset);
    }

    let url = format!("https://api.telegram.org/bot{}/getUpdates", token);
    let response = client
        .post(url)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("getUpdates request failed: {}", sanitized_reqwest_error(e)))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("getUpdates returned HTTP {}", status.as_u16()));
    }
    let payload = response
        .json::<Value>()
        .await
        .map_err(|e| format!("getUpdates response parse failed: {}", e))?;
    if !payload.get("ok").and_then(Value::as_bool).unwrap_or(false) {
        let description = payload
            .get("description")
            .and_then(Value::as_str)
            .unwrap_or("telegram returned ok=false");
        return Err(crate::outside_connectors::redact_connector_error_text(
            description,
        ));
    }

    let mut next_offset = offset;
    if let Some(updates) = payload.get("result").and_then(Value::as_array) {
        for update in updates {
            let parsed = telegram_update_to_inbound(update);
            if let Some(update_id) = parsed.update_id {
                next_offset = Some(next_offset.map_or(update_id + 1, |v| v.max(update_id + 1)));
            }
            if let Some(input) = parsed.input {
                let event = store.simulate_inbound(&connector.id, input.clone()).await?;
                info!(
                    "outside_connector_runtime: telegram inbound connector={} status={:?}",
                    connector.id, event.status
                );
                if event.status == OutsideConnectorEventStatus::AutoPrompt {
                    let token = token.clone();
                    let store = Arc::clone(store);
                    let connector_id = connector.id.clone();
                    let app = app.clone();
                    let client = client.clone();
                    tokio::spawn(async move {
                        if let Err(err) = dispatch_telegram_prompt(
                            &app,
                            &client,
                            &store,
                            &connector_id,
                            &token,
                            input,
                        )
                        .await
                        {
                            warn!(
                                "outside_connector_runtime: telegram dispatch failed for {}: {}",
                                connector_id, err
                            );
                        }
                    });
                }
            }
        }
    }
    if next_offset != offset {
        state
            .telegram_offsets
            .insert(connector.id.clone(), next_offset.unwrap_or_default());
        save_runtime_state(&state)?;
    }
    let _ = store.set_runtime_error(&connector.id, None).await;
    Ok(())
}

async fn dispatch_telegram_prompt(
    app: &AppHandle,
    client: &reqwest::Client,
    store: &Arc<OutsideConnectorStore>,
    connector_id: &str,
    token: &str,
    input: OutsideConnectorInboundInput,
) -> Result<(), String> {
    let connector = store
        .get(connector_id)
        .await
        .ok_or_else(|| "connector disappeared before dispatch".to_string())?;
    if !matches!(
        connector.dispatch_mode,
        OutsideConnectorDispatchMode::AutoPrompt
    ) {
        return Ok(());
    }
    let chat_id = input
        .conversation_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(input.sender_id.trim())
        .to_string();
    let tab_id = match target_tab_id(app, &connector).await {
        Ok(tab_id) => tab_id,
        Err(err) => {
            let msg = format!("shellX could not route this Telegram message: {}", err);
            let _ = send_telegram_text(client, token, &chat_id, &msg).await;
            let _ = store
                .record_outbound(
                    &connector,
                    &input,
                    OutsideConnectorEventStatus::Error,
                    &msg,
                    Some(err.clone()),
                )
                .await;
            return Err(err);
        }
    };

    let registry = app.state::<Arc<crate::acp::SessionRegistry>>();
    let Some(session_arc) = registry.get_existing(&tab_id).await else {
        let msg = format!(
            "shellX tab {} is not connected. Open/connect that tab before using Telegram control.",
            tab_id
        );
        let _ = send_telegram_text(client, token, &chat_id, &msg).await;
        let _ = store
            .record_outbound(
                &connector,
                &input,
                OutsideConnectorEventStatus::Error,
                &msg,
                Some("target tab is not connected".to_string()),
            )
            .await;
        return Err("target tab is not connected".to_string());
    };

    let started_ms = now_ms();
    let final_prompt = prepare_external_prompt(app, &session_arc, &tab_id, &input).await?;
    let rx = {
        let mut session = session_arc.lock().await;
        session.initiate_and_send_prompt(&final_prompt).await?
    };
    let outcome = timeout(OUTSIDE_CONNECTOR_PROMPT_TIMEOUT, rx).await;
    {
        let mut session = session_arc.lock().await;
        match &outcome {
            Ok(Ok(_)) => session.mark_prompt_responded(),
            Err(_) => session.mark_prompt_timeout(),
            Ok(Err(_)) => {}
        }
    }
    match outcome {
        Ok(Ok(_)) => {}
        Ok(Err(err)) => {
            let err_text = err.to_string();
            let msg = format!("shellX prompt failed: {}", err_text);
            let _ = send_telegram_text(client, token, &chat_id, &msg).await;
            let _ = store
                .record_outbound(
                    &connector,
                    &input,
                    OutsideConnectorEventStatus::Error,
                    &msg,
                    Some(err_text.clone()),
                )
                .await;
            return Err(err_text);
        }
        Err(_) => {
            let msg =
                "shellX prompt is still running; watch shellX for continued progress.".to_string();
            send_telegram_text(client, token, &chat_id, &msg).await?;
            let _ = store
                .record_outbound(
                    &connector,
                    &input,
                    OutsideConnectorEventStatus::AutoPrompt,
                    &msg,
                    Some("prompt wait timed out".to_string()),
                )
                .await;
            return Ok(());
        }
    }

    let reply = collect_agent_reply(app, &tab_id, started_ms)
        .unwrap_or_else(|| "shellX sent the message, but no text reply was captured.".to_string());
    send_telegram_text(client, token, &chat_id, &reply).await?;
    let _ = store
        .record_outbound(
            &connector,
            &input,
            OutsideConnectorEventStatus::AutoPrompt,
            &reply,
            None,
        )
        .await;

    if let Some(path) = first_existing_shellx_image_path(&reply) {
        if let Err(err) = send_telegram_photo(client, token, &chat_id, &path).await {
            warn!(
                "outside_connector_runtime: telegram sendPhoto failed for {}: {}",
                path.display(),
                err
            );
        }
    }
    Ok(())
}

async fn target_tab_id(app: &AppHandle, connector: &OutsideConnector) -> Result<String, String> {
    match &connector.target {
        OutsideConnectorTarget::FixedTab { tab_id } => Ok(tab_id.clone()),
        OutsideConnectorTarget::ActiveTab => {
            let Some(hub) = app.try_state::<Arc<crate::debug_api::DebugHub>>() else {
                return Err("active tab is unavailable before debug API starts".to_string());
            };
            hub.ui_snapshot()
                .active_tab_id
                .filter(|tab| !tab.trim().is_empty())
                .ok_or_else(|| "no active shellX tab is known yet".to_string())
        }
    }
}

async fn prepare_external_prompt(
    app: &AppHandle,
    session_arc: &Arc<tokio::sync::Mutex<crate::acp::GrokAcpSession>>,
    tab_id: &str,
    input: &OutsideConnectorInboundInput,
) -> Result<String, String> {
    let text = input.text.trim();
    if let Some(obj) = crate::build_orchestrator::BuildOrchestrator::parse_build_command(text) {
        if obj.is_empty() {
            return Err("/build requires an objective: /build <what to accomplish>".to_string());
        }
        let cwd = {
            let guard = session_arc.lock().await;
            guard
                .get_cwd_for_restart()
                .map(PathBuf::from)
                .unwrap_or_else(|| {
                    std::env::var("HOME")
                        .or_else(|_| std::env::var("USERPROFILE"))
                        .map(PathBuf::from)
                        .unwrap_or_else(|_| PathBuf::from("."))
                })
        };
        let orch = app
            .state::<Arc<crate::build_orchestrator::BuildOrchestrator>>()
            .inner()
            .clone();
        let (transport_kind, ssh_config) = {
            let guard = session_arc.lock().await;
            (
                guard.transport_kind().to_string(),
                guard.ssh_config().cloned(),
            )
        };
        let state = orch
            .start_run_with_transport_context(tab_id, &obj, &cwd, &transport_kind, ssh_config)
            .await?;
        return Ok(
            crate::build_orchestrator::BuildOrchestrator::plan_kickoff_text_for_path(
                &obj,
                &state.scratchboard_path,
            ),
        );
    }

    Ok(format!(
        "External Telegram message for this shellX session.\n\nSender: {}\nChat: {}\n\nMessage:\n{}\n\nReply normally. Your response will be sent back to Telegram, so keep it concise unless the user explicitly asks for detailed output.",
        input.sender_id.trim(),
        input
            .conversation_id
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or(input.sender_id.trim()),
        text
    ))
}

fn collect_agent_reply(app: &AppHandle, tab_id: &str, started_ms: i64) -> Option<String> {
    let hub = app.try_state::<Arc<crate::debug_api::DebugHub>>()?;
    let mut out = String::new();
    for event in hub.recent(20_000) {
        if event.t < started_ms {
            continue;
        }
        let payload = event.payload;
        let meta_tab = payload
            .pointer("/params/_meta/tabId")
            .and_then(Value::as_str)
            .or_else(|| payload.pointer("/_meta/tabId").and_then(Value::as_str));
        if meta_tab != Some(tab_id) {
            continue;
        }
        let Some(update) = payload.pointer("/params/update") else {
            continue;
        };
        if update.get("sessionUpdate").and_then(Value::as_str) != Some("agent_message_chunk") {
            continue;
        }
        if let Some(text) = update
            .pointer("/content/text")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
        {
            out.push_str(text);
        }
    }
    let trimmed = out.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.chars().take(3900).collect())
    }
}

async fn send_telegram_text(
    client: &reqwest::Client,
    token: &str,
    chat_id: &str,
    text: &str,
) -> Result<(), String> {
    let url = format!("https://api.telegram.org/bot{}/sendMessage", token);
    for chunk in split_telegram_text(text) {
        let response = client
            .post(&url)
            .json(&json!({
                "chat_id": chat_id,
                "text": chunk,
                "disable_web_page_preview": true,
            }))
            .send()
            .await
            .map_err(|e| format!("sendMessage request failed: {}", sanitized_reqwest_error(e)))?;
        if !response.status().is_success() {
            return Err(format!(
                "sendMessage returned HTTP {}",
                response.status().as_u16()
            ));
        }
    }
    Ok(())
}

fn split_telegram_text(text: &str) -> Vec<String> {
    let mut chunks = Vec::new();
    let mut current = String::new();
    for ch in text.chars() {
        if current.len() + ch.len_utf8() > 3900 {
            chunks.push(current);
            current = String::new();
        }
        current.push(ch);
    }
    if !current.trim().is_empty() {
        chunks.push(current);
    }
    if chunks.is_empty() {
        chunks.push("(empty reply)".to_string());
    }
    chunks
}

async fn send_telegram_photo(
    client: &reqwest::Client,
    token: &str,
    chat_id: &str,
    path: &Path,
) -> Result<(), String> {
    let bytes = tokio::fs::read(path)
        .await
        .map_err(|e| format!("read image failed: {}", e))?;
    if bytes.len() > 10 * 1024 * 1024 {
        return Err("image exceeds Telegram sendPhoto safety cap".to_string());
    }
    if !looks_like_supported_image(&bytes) {
        return Err("image bytes did not match a supported image format".to_string());
    }
    let name = path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("shellx-preview.png")
        .to_string();
    let part = reqwest::multipart::Part::bytes(bytes).file_name(name);
    let form = reqwest::multipart::Form::new()
        .text("chat_id", chat_id.to_string())
        .part("photo", part);
    let url = format!("https://api.telegram.org/bot{}/sendPhoto", token);
    let response = client
        .post(url)
        .multipart(form)
        .send()
        .await
        .map_err(|e| format!("sendPhoto request failed: {}", sanitized_reqwest_error(e)))?;
    if !response.status().is_success() {
        return Err(format!(
            "sendPhoto returned HTTP {}",
            response.status().as_u16()
        ));
    }
    Ok(())
}

fn first_existing_shellx_image_path(text: &str) -> Option<PathBuf> {
    for raw in text.split_whitespace() {
        let token = raw.trim_matches(|c: char| {
            matches!(c, '"' | '\'' | '`' | ',' | '.' | ')' | '(' | '[' | ']')
        });
        let lower = token.to_ascii_lowercase();
        if !(lower.ends_with(".png")
            || lower.ends_with(".jpg")
            || lower.ends_with(".jpeg")
            || lower.ends_with(".webp"))
        {
            continue;
        }
        let path = PathBuf::from(token);
        if let Some(canonical) = canonical_shellx_external_image_path(&path) {
            return Some(canonical);
        }
    }
    None
}

fn canonical_shellx_external_image_path(path: &Path) -> Option<PathBuf> {
    let metadata = std::fs::symlink_metadata(path).ok()?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return None;
    }
    let canonical = path.canonicalize().ok()?;
    if shellx_external_image_path_allowed(&canonical) {
        Some(canonical)
    } else {
        None
    }
}

fn shellx_external_image_path_allowed(path: &Path) -> bool {
    let normalized = path
        .to_string_lossy()
        .replace('\\', "/")
        .trim_start_matches("//?/")
        .to_ascii_lowercase();
    normalized.contains("/.grok/sessions/")
        || normalized.contains("/.grok/shellx-preview-screenshots/")
}

fn looks_like_supported_image(bytes: &[u8]) -> bool {
    bytes.starts_with(b"\x89PNG\r\n\x1a\n")
        || bytes.starts_with(b"\xff\xd8\xff")
        || bytes.starts_with(b"GIF87a")
        || bytes.starts_with(b"GIF89a")
        || (bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP")
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

async fn discord_gateway_supervisor_loop() {
    let mut tasks: BTreeMap<String, tokio::task::JoinHandle<()>> = BTreeMap::new();
    loop {
        let store = match crate::get_or_open_outside_connectors() {
            Ok(store) => store,
            Err(e) => {
                warn!(
                    "outside_connector_runtime: connector store unavailable: {}",
                    e
                );
                sleep(DISCORD_RECONNECT_MIN_SLEEP).await;
                continue;
            }
        };
        let connectors = enabled_discord_connectors(&store, None).await;
        let token_keys = distinct_discord_token_keys(&connectors);
        tasks.retain(|token_key, task| {
            let keep =
                token_keys.iter().any(|active_key| active_key == token_key) && !task.is_finished();
            if !keep {
                task.abort();
            }
            keep
        });

        for token_key in token_keys {
            if tasks.contains_key(&token_key) {
                continue;
            }
            let task_key = token_key.clone();
            let handle = tokio::spawn(async move {
                run_discord_gateway_reconnect_loop(task_key).await;
            });
            tasks.insert(token_key, handle);
        }

        sleep(DISCORD_IDLE_SLEEP).await;
    }
}

async fn run_discord_gateway_reconnect_loop(token_key: String) {
    let mut reconnect_sleep = DISCORD_RECONNECT_MIN_SLEEP;
    loop {
        if !discord_token_key_enabled(&token_key).await {
            info!("outside_connector_runtime: discord gateway stopped for disabled token key");
            return;
        }
        let token = match read_vault_value(&token_key).await {
            Ok(token) if !token.trim().is_empty() => token,
            Ok(_) => {
                warn!("outside_connector_runtime: discord token is empty");
                update_discord_token_runtime_error(&token_key, Some("discord token is empty"))
                    .await;
                sleep(DISCORD_RECONNECT_MIN_SLEEP).await;
                continue;
            }
            Err(e) => {
                update_discord_token_runtime_error(&token_key, Some(&e)).await;
                warn!(
                    "outside_connector_runtime: discord token unavailable: {}",
                    e
                );
                sleep(DISCORD_RECONNECT_MIN_SLEEP).await;
                continue;
            }
        };

        match run_discord_gateway(token_key.clone(), token).await {
            Ok(()) => reconnect_sleep = DISCORD_RECONNECT_MIN_SLEEP,
            Err(e) => {
                update_discord_token_runtime_error(&token_key, Some(&e)).await;
                warn!("outside_connector_runtime: discord gateway stopped: {}", e);
                sleep(reconnect_sleep).await;
                reconnect_sleep = (reconnect_sleep * 2).min(DISCORD_RECONNECT_MAX_SLEEP);
            }
        }
    }
}

fn distinct_discord_token_keys(connectors: &[RuntimeConnector]) -> Vec<String> {
    connectors
        .iter()
        .map(|connector| connector.token_key.trim())
        .filter(|key| !key.is_empty())
        .map(ToOwned::to_owned)
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

async fn discord_token_key_enabled(token_key: &str) -> bool {
    match crate::get_or_open_outside_connectors() {
        Ok(store) => !enabled_discord_connectors(&store, Some(token_key))
            .await
            .is_empty(),
        Err(e) => {
            warn!(
                "outside_connector_runtime: connector store unavailable during discord config check: {}",
                e
            );
            false
        }
    }
}

fn discord_gateway_identify_token(token: &str) -> String {
    let trimmed = token.trim();
    if trimmed.len() >= 4 && trimmed[..4].eq_ignore_ascii_case("bot ") {
        trimmed[4..].trim().to_string()
    } else {
        trimmed.to_string()
    }
}

async fn run_discord_gateway(token_key: String, token: String) -> Result<(), String> {
    let (ws, _) = connect_async(DISCORD_GATEWAY_URL)
        .await
        .map_err(|e| format!("connect failed: {}", e))?;
    let (mut write, mut read) = ws.split();

    let hello = next_json_message(&mut read).await?;
    let interval_ms = hello
        .get("d")
        .and_then(|d| d.get("heartbeat_interval"))
        .and_then(Value::as_u64)
        .ok_or_else(|| "gateway hello missing heartbeat_interval".to_string())?;

    let identify = json!({
        "op": 2,
        "d": {
            "token": discord_gateway_identify_token(&token),
            "intents": DISCORD_INTENT_DIRECT_MESSAGES,
            "properties": {
                "os": std::env::consts::OS,
                "browser": "shellX",
                "device": "shellX"
            }
        }
    });
    write
        .send(Message::Text(identify.to_string()))
        .await
        .map_err(|e| format!("identify send failed: {}", e))?;
    update_discord_token_runtime_error(&token_key, None).await;

    let mut seq: Option<i64> = hello.get("s").and_then(Value::as_i64);
    let mut heartbeat = tokio::time::interval(Duration::from_millis(interval_ms));
    heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    heartbeat.tick().await;
    let mut config_check = tokio::time::interval(DISCORD_CONFIG_CHECK_SLEEP);
    config_check.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    config_check.tick().await;
    let mut heartbeat_ack = true;

    loop {
        tokio::select! {
            _ = config_check.tick() => {
                if !discord_token_key_enabled(&token_key).await {
                    return Ok(());
                }
            }
            _ = heartbeat.tick() => {
                if !heartbeat_ack {
                    return Err("missed heartbeat ack".to_string());
                }
                heartbeat_ack = false;
                send_discord_heartbeat(&mut write, seq).await?;
            }
            message = read.next() => {
                let Some(message) = message else {
                    return Err("gateway closed".to_string());
                };
                let message = message.map_err(|e| format!("gateway read failed: {}", e))?;
                let value = message_to_json(message)?;
                if let Some(s) = value.get("s").and_then(Value::as_i64) {
                    seq = Some(s);
                }
                match value.get("op").and_then(Value::as_i64) {
                    Some(0) if value.get("t").and_then(Value::as_str) == Some("MESSAGE_CREATE") => {
                        if let Some(input) = value.get("d").and_then(discord_message_create_to_inbound) {
                            record_discord_inbound(&token_key, input).await?;
                        }
                    }
                    Some(1) => send_discord_heartbeat(&mut write, seq).await?,
                    Some(7) => return Err("gateway requested reconnect".to_string()),
                    Some(9) => return Err("gateway invalid session".to_string()),
                    Some(10) => {}
                    Some(11) => heartbeat_ack = true,
                    _ => {}
                }
            }
        }
    }
}

async fn record_discord_inbound(
    token_key: &str,
    input: OutsideConnectorInboundInput,
) -> Result<(), String> {
    let store = crate::get_or_open_outside_connectors()?;
    let connectors = enabled_discord_connectors(&store, Some(token_key)).await;
    for connector in connectors {
        let event = store.simulate_inbound(&connector.id, input.clone()).await?;
        info!(
            "outside_connector_runtime: discord inbound connector={} status={:?}",
            connector.id, event.status
        );
    }
    Ok(())
}

async fn update_discord_token_runtime_error(token_key: &str, error: Option<&str>) {
    let Ok(store) = crate::get_or_open_outside_connectors() else {
        return;
    };
    for connector in enabled_discord_connectors(&store, Some(token_key)).await {
        let _ = store.set_runtime_error(&connector.id, error).await;
    }
}

async fn send_discord_heartbeat<S>(write: &mut S, seq: Option<i64>) -> Result<(), String>
where
    S: futures_util::Sink<Message> + Unpin,
    S::Error: std::fmt::Display,
{
    write
        .send(Message::Text(json!({ "op": 1, "d": seq }).to_string()))
        .await
        .map_err(|e| format!("heartbeat send failed: {}", e))
}

async fn next_json_message<S>(read: &mut S) -> Result<Value, String>
where
    S: futures_util::Stream<Item = Result<Message, tokio_tungstenite::tungstenite::Error>> + Unpin,
{
    loop {
        let Some(message) = read.next().await else {
            return Err("gateway closed before hello".to_string());
        };
        let message = message.map_err(|e| format!("gateway read failed: {}", e))?;
        match message_to_json(message) {
            Ok(value) => return Ok(value),
            Err(_) => continue,
        }
    }
}

fn message_to_json(message: Message) -> Result<Value, String> {
    match message {
        Message::Text(text) => {
            serde_json::from_str(&text).map_err(|e| format!("gateway json parse failed: {}", e))
        }
        Message::Close(frame) => Err(format!("gateway close frame: {:?}", frame)),
        _ => Err("gateway non-text message ignored".to_string()),
    }
}

fn runtime_state_path() -> Result<PathBuf, String> {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map_err(|_| "outside_connector_runtime: HOME/USERPROFILE not set".to_string())?;
    Ok(PathBuf::from(home)
        .join(".shellx")
        .join("outside-connector-runtime.json"))
}

fn load_runtime_state() -> RuntimeState {
    runtime_state_path()
        .ok()
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|raw| serde_json::from_str::<RuntimeState>(&raw).ok())
        .unwrap_or_default()
}

fn save_runtime_state(state: &RuntimeState) -> Result<(), String> {
    let path = runtime_state_path()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| {
            format!(
                "outside_connector_runtime: mkdir {} failed: {}",
                parent.display(),
                e
            )
        })?;
    }
    let json = serde_json::to_string_pretty(state)
        .map_err(|e| format!("outside_connector_runtime: serialize state failed: {}", e))?;
    atomic_write_private(&path, &json)
}

fn atomic_write_private(path: &Path, body: &str) -> Result<(), String> {
    let tmp = path.with_extension(format!("json.{}.tmp", std::process::id()));
    #[cfg(unix)]
    let mut tmp_file = {
        use std::os::unix::fs::OpenOptionsExt;
        std::fs::OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .mode(0o600)
            .open(&tmp)
    }
    .map_err(|e| {
        format!(
            "outside_connector_runtime: open private tmp {} failed: {}",
            tmp.display(),
            e
        )
    })?;
    #[cfg(not(unix))]
    let mut tmp_file = std::fs::OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(&tmp)
        .map_err(|e| {
            format!(
                "outside_connector_runtime: open tmp {} failed: {}",
                tmp.display(),
                e
            )
        })?;
    use std::io::Write as _;
    tmp_file.write_all(body.as_bytes()).map_err(|e| {
        format!(
            "outside_connector_runtime: write tmp {} failed: {}",
            tmp.display(),
            e
        )
    })?;
    tmp_file
        .sync_all()
        .map_err(|e| format!("outside_connector_runtime: sync tmp failed: {}", e))?;
    drop(tmp_file);
    std::fs::rename(&tmp, path)
        .map_err(|e| format!("outside_connector_runtime: rename failed: {}", e))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::fs;

    use serde_json::json;

    use super::*;

    fn temp_dir(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "shellx-outside-connector-{}-{}-{}",
            label,
            std::process::id(),
            now_ms()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("temp dir");
        dir
    }

    #[test]
    fn telegram_message_update_maps_to_inbound_input() {
        let update = json!({
            "update_id": 104006921,
            "message": {
                "message_id": 1,
                "from": { "id": 1234567890_i64, "is_bot": false },
                "chat": { "id": 1234567890_i64, "type": "private" },
                "date": 1779742300,
                "text": "hello shellx"
            }
        });

        let parsed = telegram_update_to_inbound(&update);

        assert_eq!(parsed.update_id, Some(104006921));
        let input = parsed.input.expect("message should be parsed");
        assert_eq!(input.sender_id, "1234567890");
        assert_eq!(input.conversation_id.as_deref(), Some("1234567890"));
        assert_eq!(input.guild_id, None);
        assert_eq!(input.text, "hello shellx");
    }

    #[test]
    fn telegram_non_message_update_is_ignored_but_exposes_update_id() {
        let update = json!({
            "update_id": 104006922,
            "callback_query": {
                "id": "cb-1",
                "from": { "id": 1234567890_i64, "is_bot": false }
            }
        });

        let parsed = telegram_update_to_inbound(&update);

        assert_eq!(parsed.update_id, Some(104006922));
        assert!(parsed.input.is_none());
    }

    #[test]
    fn discord_dm_message_create_maps_to_inbound_input() {
        let event = json!({
            "id": "msg-1",
            "channel_id": "dm-channel-1",
            "content": "hello from discord",
            "author": {
                "id": "111222333444555666",
                "username": "martin",
                "bot": false
            }
        });

        let input = discord_message_create_to_inbound(&event).expect("DM should be parsed");

        assert_eq!(input.sender_id, "111222333444555666");
        assert_eq!(input.conversation_id.as_deref(), Some("dm-channel-1"));
        assert_eq!(input.guild_id, None);
        assert_eq!(input.text, "hello from discord");
    }

    #[test]
    fn discord_ignores_guild_and_bot_messages() {
        let guild_event = json!({
            "id": "msg-2",
            "channel_id": "guild-channel-1",
            "guild_id": "guild-1",
            "content": "guild message",
            "author": { "id": "111222333444555666", "bot": false }
        });
        let bot_event = json!({
            "id": "msg-3",
            "channel_id": "dm-channel-1",
            "content": "bot echo",
            "author": { "id": "999888777666555444", "bot": true }
        });

        assert!(discord_message_create_to_inbound(&guild_event).is_none());
        assert!(discord_message_create_to_inbound(&bot_event).is_none());
    }

    #[test]
    fn discord_gateway_identify_token_strips_optional_bot_prefix() {
        assert_eq!(discord_gateway_identify_token("Bot abc.def"), "abc.def");
        assert_eq!(discord_gateway_identify_token("bot abc.def"), "abc.def");
        assert_eq!(discord_gateway_identify_token("abc.def"), "abc.def");
    }

    #[test]
    fn discord_token_keys_are_distinct_and_stable() {
        let connectors = vec![
            RuntimeConnector {
                id: "a".into(),
                token_key: "discord/one".into(),
            },
            RuntimeConnector {
                id: "b".into(),
                token_key: "discord/two".into(),
            },
            RuntimeConnector {
                id: "c".into(),
                token_key: "discord/one".into(),
            },
        ];

        assert_eq!(
            distinct_discord_token_keys(&connectors),
            vec!["discord/one".to_string(), "discord/two".to_string()]
        );
    }

    #[test]
    fn telegram_photo_relay_only_allows_shellx_generated_image_paths() {
        let root = temp_dir("photo-relay");
        let private_dir = root.join("Pictures");
        fs::create_dir_all(&private_dir).expect("private dir");
        let private_image = private_dir.join("secret.png");
        fs::write(&private_image, b"\x89PNG\r\n\x1a\nprivate").expect("private image");

        let generated_dir = root
            .join(".grok")
            .join("sessions")
            .join("sid")
            .join("images");
        fs::create_dir_all(&generated_dir).expect("generated dir");
        let generated_image = generated_dir.join("1.png");
        fs::write(&generated_image, b"\x89PNG\r\n\x1a\ngenerated").expect("generated image");
        let canonical_generated_image = generated_image.canonicalize().expect("canonical image");

        assert!(shellx_external_image_path_allowed(&generated_image));
        assert!(!shellx_external_image_path_allowed(&private_image));
        assert_eq!(
            first_existing_shellx_image_path(&format!(
                "{} {}",
                private_image.display(),
                generated_image.display()
            )),
            Some(canonical_generated_image)
        );
    }

    #[cfg(unix)]
    #[test]
    fn telegram_photo_relay_rejects_allowed_path_symlink_to_private_image() {
        use std::os::unix::fs::symlink;

        let root = temp_dir("photo-relay-symlink");
        let private_dir = root.join("Pictures");
        fs::create_dir_all(&private_dir).expect("private dir");
        let private_image = private_dir.join("secret.png");
        fs::write(&private_image, b"\x89PNG\r\n\x1a\nprivate").expect("private image");

        let generated_dir = root
            .join(".grok")
            .join("sessions")
            .join("sid")
            .join("images");
        fs::create_dir_all(&generated_dir).expect("generated dir");
        let symlinked_image = generated_dir.join("relay.png");
        symlink(&private_image, &symlinked_image).expect("symlink image");

        assert!(shellx_external_image_path_allowed(&symlinked_image));
        assert_eq!(
            first_existing_shellx_image_path(&symlinked_image.display().to_string()),
            None
        );
    }

    #[test]
    fn telegram_photo_relay_validates_image_magic() {
        assert!(looks_like_supported_image(b"\x89PNG\r\n\x1a\nbody"));
        assert!(looks_like_supported_image(b"\xff\xd8\xffjpeg"));
        assert!(looks_like_supported_image(b"GIF89abody"));
        assert!(looks_like_supported_image(b"RIFFxxxxWEBPbody"));
        assert!(!looks_like_supported_image(b"not actually an image"));
    }
}
