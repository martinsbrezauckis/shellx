// src-tauri/src/outside_connectors.rs
//
// Outside connector presets for user-facing channels such as Telegram
// and Discord bots. Non-secret config lives in
// ~/.shellx/outside-connectors.json; provider tokens remain in Vault
// and are referenced by key name only.

use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;
use tracing::info;

use crate::vault::Vault;

const STORE_VERSION: u32 = 1;
const MAX_EVENTS: usize = 200;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutsideConnector {
    pub id: String,
    pub label: String,
    pub enabled: bool,
    pub provider: OutsideConnectorProvider,
    pub target: OutsideConnectorTarget,
    pub dispatch_mode: OutsideConnectorDispatchMode,
    pub require_approval: bool,
    pub created_ms: i64,
    pub updated_ms: i64,
    #[serde(default)]
    pub last_test_ms: Option<i64>,
    #[serde(default)]
    pub last_error: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum OutsideConnectorProvider {
    Telegram {
        bot_token_vault_key: String,
        #[serde(default)]
        allowed_chat_ids: Vec<String>,
    },
    Discord {
        bot_token_vault_key: String,
        #[serde(default)]
        allowed_target_ids: Vec<String>,
    },
}

impl OutsideConnectorProvider {
    pub fn kind_label(&self) -> &'static str {
        match self {
            Self::Telegram { .. } => "telegram",
            Self::Discord { .. } => "discord",
        }
    }
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OutsideConnectorCapabilities {
    pub provider: &'static str,
    pub label: &'static str,
    pub receipt_tier: &'static str,
    pub supports_threading: bool,
    pub supports_attachments: bool,
    pub supports_buttons: bool,
    pub markdown_dialect: &'static str,
    pub max_message_bytes: usize,
}

pub fn connector_capabilities() -> Vec<OutsideConnectorCapabilities> {
    vec![
        OutsideConnectorCapabilities {
            provider: "telegram",
            label: "Telegram bot",
            receipt_tier: "platform_accepted",
            supports_threading: false,
            supports_attachments: true,
            supports_buttons: false,
            markdown_dialect: "telegram_markdown_v2",
            max_message_bytes: 4096,
        },
        OutsideConnectorCapabilities {
            provider: "discord",
            label: "Discord bot",
            receipt_tier: "platform_accepted",
            supports_threading: false,
            supports_attachments: false,
            supports_buttons: false,
            markdown_dialect: "discord_markdown",
            max_message_bytes: 2000,
        },
    ]
}

impl OutsideConnector {
    pub fn allowed_ids(&self) -> &[String] {
        match &self.provider {
            OutsideConnectorProvider::Telegram {
                allowed_chat_ids, ..
            } => allowed_chat_ids,
            OutsideConnectorProvider::Discord {
                allowed_target_ids, ..
            } => allowed_target_ids,
        }
    }

    pub fn sender_allowed(
        &self,
        sender_id: &str,
        conversation_id: Option<&str>,
        guild_id: Option<&str>,
    ) -> bool {
        let allowed = self.allowed_ids();
        if allowed.is_empty() {
            return false;
        }
        let mut candidates = vec![sender_id.trim().to_string()];
        if !sender_id.contains(':') {
            candidates.push(format!("user:{}", sender_id.trim()));
        }
        if !matches!(&self.provider, OutsideConnectorProvider::Discord { .. }) {
            if let Some(conversation_id) = conversation_id.map(str::trim).filter(|s| !s.is_empty())
            {
                candidates.push(conversation_id.to_string());
                if !conversation_id.contains(':') {
                    candidates.push(format!("channel:{}", conversation_id));
                    candidates.push(format!("chat:{}", conversation_id));
                }
            }
            if let Some(guild_id) = guild_id.map(str::trim).filter(|s| !s.is_empty()) {
                candidates.push(guild_id.to_string());
                if !guild_id.contains(':') {
                    candidates.push(format!("guild:{}", guild_id));
                }
            }
        }
        allowed
            .iter()
            .map(|id| id.trim())
            .any(|id| candidates.iter().any(|candidate| candidate == id))
    }
}

fn format_target(target: &OutsideConnectorTarget) -> String {
    match target {
        OutsideConnectorTarget::ActiveTab => "active tab".to_string(),
        OutsideConnectorTarget::FixedTab { tab_id } => format!("fixed tab {}", tab_id),
    }
}

fn external_preview(connector: &OutsideConnector, input: &OutsideConnectorInboundInput) -> String {
    let conversation = input
        .conversation_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(input.sender_id.trim());
    format!(
        "{} {} -> shellX: {}",
        connector.provider.kind_label(),
        conversation,
        preview_text(&input.text, 140)
    )
}

fn preview_text(text: &str, max_chars: usize) -> String {
    let trimmed = text.trim();
    let mut out = String::new();
    for ch in trimmed.chars().take(max_chars) {
        out.push(ch);
    }
    if trimmed.chars().count() > max_chars {
        out.push_str("...");
    }
    out
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(
    tag = "mode",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum OutsideConnectorTarget {
    ActiveTab,
    FixedTab { tab_id: String },
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum OutsideConnectorDispatchMode {
    Inbox,
    AutoPrompt,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutsideConnectorInboundInput {
    pub sender_id: String,
    #[serde(default)]
    pub conversation_id: Option<String>,
    #[serde(default)]
    pub guild_id: Option<String>,
    pub text: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum OutsideConnectorEventDirection {
    Inbound,
    Outbound,
    System,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum OutsideConnectorEventStatus {
    Inbox,
    AutoPrompt,
    Rejected,
    Error,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutsideConnectorEvent {
    pub id: String,
    pub connector_id: String,
    pub connector_label: String,
    pub provider: String,
    pub direction: OutsideConnectorEventDirection,
    pub status: OutsideConnectorEventStatus,
    pub sender_id: String,
    #[serde(default)]
    pub conversation_id: Option<String>,
    #[serde(default)]
    pub guild_id: Option<String>,
    pub target: String,
    pub dispatch_mode: OutsideConnectorDispatchMode,
    pub require_approval: bool,
    pub text_preview: String,
    pub external_preview: String,
    #[serde(default)]
    pub reason: Option<String>,
    pub created_ms: i64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutsideConnectorTestResult {
    pub reachable: bool,
    pub provider: String,
    pub latency_ms: Option<u32>,
    pub identity: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
struct StoreFile {
    version: u32,
    #[serde(default)]
    connectors: Vec<OutsideConnector>,
}

#[derive(Debug, Deserialize)]
struct RawStoreFile {
    #[serde(default)]
    connectors: Vec<serde_json::Value>,
}

impl Default for StoreFile {
    fn default() -> Self {
        Self {
            version: STORE_VERSION,
            connectors: vec![],
        }
    }
}

pub struct OutsideConnectorStore {
    path: PathBuf,
    state: Mutex<Vec<OutsideConnector>>,
    events_path: PathBuf,
    events_state: Mutex<Vec<OutsideConnectorEvent>>,
}

impl OutsideConnectorStore {
    pub fn open() -> Result<Self, String> {
        Self::open_at(store_path()?)
    }

    pub fn open_at(path: PathBuf) -> Result<Self, String> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| {
                format!(
                    "outside_connectors: mkdir {} failed: {}",
                    parent.display(),
                    e
                )
            })?;
        }
        let connectors = if path.exists() {
            let raw = std::fs::read_to_string(&path).map_err(|e| {
                format!("outside_connectors: read {} failed: {}", path.display(), e)
            })?;
            if raw.trim().is_empty() {
                vec![]
            } else {
                parse_store_connectors(&raw)?
            }
        } else {
            vec![]
        };
        let events_path = events_path_for(&path);
        let events = load_events(&events_path)?;
        info!(
            "outside_connectors: opened at {} ({} connectors)",
            path.display(),
            connectors.len()
        );
        Ok(Self {
            path,
            state: Mutex::new(connectors),
            events_path,
            events_state: Mutex::new(events),
        })
    }

    pub async fn list(&self) -> Vec<OutsideConnector> {
        let guard = self.state.lock().await;
        guard.clone()
    }

    pub async fn save(&self, mut incoming: OutsideConnector) -> Result<OutsideConnector, String> {
        validate_connector(&incoming)?;
        let now = now_ms();
        let mut guard = self.state.lock().await;
        if incoming.id.trim().is_empty() {
            incoming.id = format!("oconn-{}", uuid::Uuid::new_v4());
            incoming.created_ms = now;
            incoming.last_test_ms = None;
            incoming.last_error = None;
        }
        incoming.updated_ms = now;
        if let Some(existing) = guard.iter_mut().find(|c| c.id == incoming.id) {
            incoming.created_ms = existing.created_ms;
            incoming.last_test_ms = existing.last_test_ms;
            incoming.last_error = existing.last_error.clone();
            *existing = incoming.clone();
        } else {
            guard.push(incoming.clone());
        }
        persist(&self.path, &guard)?;
        info!(
            "outside_connectors: saved id={} label={} provider={}",
            incoming.id,
            incoming.label,
            incoming.provider.kind_label()
        );
        Ok(incoming)
    }

    pub async fn delete(&self, id: &str) -> Result<bool, String> {
        let mut guard = self.state.lock().await;
        let before = guard.len();
        guard.retain(|c| c.id != id);
        let removed = guard.len() != before;
        persist(&self.path, &guard)?;
        if removed {
            info!("outside_connectors: deleted id={}", id);
        }
        Ok(removed)
    }

    pub async fn set_runtime_error(&self, id: &str, message: Option<&str>) -> Result<bool, String> {
        let mut guard = self.state.lock().await;
        let Some(connector) = guard.iter_mut().find(|c| c.id == id) else {
            return Ok(false);
        };
        connector.last_error = message
            .map(redact_connector_error_text)
            .filter(|s| !s.trim().is_empty());
        connector.updated_ms = now_ms();
        persist(&self.path, &guard)?;
        Ok(true)
    }

    pub async fn test(&self, id: &str) -> OutsideConnectorTestResult {
        let connector = {
            let guard = self.state.lock().await;
            guard.iter().find(|c| c.id == id).cloned()
        };
        let Some(connector) = connector else {
            return OutsideConnectorTestResult {
                reachable: false,
                provider: "unknown".to_string(),
                latency_ms: None,
                identity: None,
                error: Some("unknown connector id".to_string()),
            };
        };
        let result = match &connector.provider {
            OutsideConnectorProvider::Telegram {
                bot_token_vault_key,
                ..
            } => test_telegram(bot_token_vault_key).await,
            OutsideConnectorProvider::Discord {
                bot_token_vault_key,
                ..
            } => test_discord(bot_token_vault_key).await,
        };
        let mut guard = self.state.lock().await;
        if let Some(existing) = guard.iter_mut().find(|c| c.id == id) {
            existing.last_test_ms = Some(now_ms());
            existing.last_error = result.error.clone();
            let _ = persist(&self.path, &guard);
        }
        result
    }

    pub async fn events(&self, limit: usize) -> Vec<OutsideConnectorEvent> {
        let guard = self.events_state.lock().await;
        let take = limit.clamp(1, MAX_EVENTS);
        guard.iter().rev().take(take).cloned().collect()
    }

    pub async fn get(&self, id: &str) -> Option<OutsideConnector> {
        let guard = self.state.lock().await;
        guard.iter().find(|c| c.id == id).cloned()
    }

    pub async fn simulate_inbound(
        &self,
        id: &str,
        input: OutsideConnectorInboundInput,
    ) -> Result<OutsideConnectorEvent, String> {
        let connector = {
            let guard = self.state.lock().await;
            guard.iter().find(|c| c.id == id).cloned()
        }
        .ok_or_else(|| "unknown connector id".to_string())?;

        let (status, reason) = if !connector.enabled {
            (
                OutsideConnectorEventStatus::Rejected,
                Some("connector is disabled".to_string()),
            )
        } else if !connector.sender_allowed(
            &input.sender_id,
            input.conversation_id.as_deref(),
            input.guild_id.as_deref(),
        ) {
            (
                OutsideConnectorEventStatus::Rejected,
                Some("sender is not allowlisted for this connector".to_string()),
            )
        } else if matches!(
            connector.dispatch_mode,
            OutsideConnectorDispatchMode::AutoPrompt
        ) {
            (OutsideConnectorEventStatus::AutoPrompt, None)
        } else {
            (OutsideConnectorEventStatus::Inbox, None)
        };

        let event = OutsideConnectorEvent {
            id: format!("ocevt-{}", uuid::Uuid::new_v4()),
            connector_id: connector.id.clone(),
            connector_label: connector.label.clone(),
            provider: connector.provider.kind_label().to_string(),
            direction: OutsideConnectorEventDirection::Inbound,
            status,
            sender_id: input.sender_id.trim().to_string(),
            conversation_id: input
                .conversation_id
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(ToOwned::to_owned),
            guild_id: input
                .guild_id
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(ToOwned::to_owned),
            target: format_target(&connector.target),
            dispatch_mode: connector.dispatch_mode.clone(),
            require_approval: connector.require_approval,
            text_preview: preview_text(&input.text, 240),
            external_preview: external_preview(&connector, &input),
            reason,
            created_ms: now_ms(),
        };
        self.record_event(event.clone()).await?;
        Ok(event)
    }

    pub async fn record_outbound(
        &self,
        connector: &OutsideConnector,
        input: &OutsideConnectorInboundInput,
        status: OutsideConnectorEventStatus,
        text: &str,
        reason: Option<String>,
    ) -> Result<OutsideConnectorEvent, String> {
        let conversation = input
            .conversation_id
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or(input.sender_id.trim());
        let event = OutsideConnectorEvent {
            id: format!("ocevt-{}", uuid::Uuid::new_v4()),
            connector_id: connector.id.clone(),
            connector_label: connector.label.clone(),
            provider: connector.provider.kind_label().to_string(),
            direction: OutsideConnectorEventDirection::Outbound,
            status,
            sender_id: "shellX".to_string(),
            conversation_id: input
                .conversation_id
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(ToOwned::to_owned),
            guild_id: input
                .guild_id
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(ToOwned::to_owned),
            target: format_target(&connector.target),
            dispatch_mode: connector.dispatch_mode.clone(),
            require_approval: connector.require_approval,
            text_preview: preview_text(text, 240),
            external_preview: format!(
                "shellX -> {} {}: {}",
                connector.provider.kind_label(),
                conversation,
                preview_text(text, 140)
            ),
            reason,
            created_ms: now_ms(),
        };
        self.record_event(event.clone()).await?;
        Ok(event)
    }

    async fn record_event(&self, event: OutsideConnectorEvent) -> Result<(), String> {
        let mut guard = self.events_state.lock().await;
        guard.push(event);
        if guard.len() > MAX_EVENTS {
            let drop_count = guard.len() - MAX_EVENTS;
            guard.drain(0..drop_count);
        }
        persist_events(&self.events_path, &guard)
    }
}

fn parse_store_connectors(raw: &str) -> Result<Vec<OutsideConnector>, String> {
    let store: RawStoreFile = serde_json::from_str(raw)
        .map_err(|e| format!("outside_connectors: parse failed: {}", e))?;
    let mut connectors = Vec::with_capacity(store.connectors.len());
    for value in store.connectors {
        let provider_kind = value
            .get("provider")
            .and_then(|provider| provider.get("kind"))
            .and_then(serde_json::Value::as_str);
        if let Some(kind) = provider_kind {
            if !matches!(kind, "telegram" | "discord") {
                info!("outside_connectors: skipped unsupported provider connector");
                continue;
            }
        }
        let connector = serde_json::from_value::<OutsideConnector>(value)
            .map_err(|e| format!("outside_connectors: parse failed: {}", e))?;
        connectors.push(connector);
    }
    Ok(connectors)
}

fn store_path() -> Result<PathBuf, String> {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map_err(|_| "outside_connectors: HOME/USERPROFILE not set".to_string())?;
    Ok(PathBuf::from(home)
        .join(".shellx")
        .join("outside-connectors.json"))
}

fn events_path_for(path: &Path) -> PathBuf {
    path.parent()
        .unwrap_or_else(|| Path::new("."))
        .join("outside-connector-events.jsonl")
}

fn persist(path: &PathBuf, connectors: &[OutsideConnector]) -> Result<(), String> {
    let store = StoreFile {
        version: STORE_VERSION,
        connectors: connectors.to_vec(),
    };
    let json = serde_json::to_string_pretty(&store)
        .map_err(|e| format!("outside_connectors: serialize failed: {}", e))?;
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
            "outside_connectors: open private tmp {} failed: {}",
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
                "outside_connectors: open tmp {} failed: {}",
                tmp.display(),
                e
            )
        })?;
    tmp_file.write_all(json.as_bytes()).map_err(|e| {
        format!(
            "outside_connectors: write tmp {} failed: {}",
            tmp.display(),
            e
        )
    })?;
    tmp_file
        .sync_all()
        .map_err(|e| format!("outside_connectors: sync tmp failed: {}", e))?;
    drop(tmp_file);
    std::fs::rename(&tmp, path).map_err(|e| format!("outside_connectors: rename failed: {}", e))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

fn load_events(path: &Path) -> Result<Vec<OutsideConnectorEvent>, String> {
    if !path.exists() {
        return Ok(vec![]);
    }
    let raw = std::fs::read_to_string(path).map_err(|e| {
        format!(
            "outside_connectors: read events {} failed: {}",
            path.display(),
            e
        )
    })?;
    let mut events = Vec::new();
    for line in raw.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let event = serde_json::from_str::<OutsideConnectorEvent>(trimmed).map_err(|e| {
            format!(
                "outside_connectors: parse event {} failed: {}",
                path.display(),
                e
            )
        })?;
        events.push(event);
    }
    if events.len() > MAX_EVENTS {
        events.drain(0..events.len() - MAX_EVENTS);
    }
    Ok(events)
}

fn persist_events(path: &Path, events: &[OutsideConnectorEvent]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| {
            format!(
                "outside_connectors: mkdir events {} failed: {}",
                parent.display(),
                e
            )
        })?;
    }
    let mut body = String::new();
    for event in events {
        let line = serde_json::to_string(event)
            .map_err(|e| format!("outside_connectors: serialize event failed: {}", e))?;
        body.push_str(&line);
        body.push('\n');
    }
    let tmp = path.with_extension(format!("jsonl.{}.tmp", std::process::id()));
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
            "outside_connectors: open private event tmp {} failed: {}",
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
                "outside_connectors: open event tmp {} failed: {}",
                tmp.display(),
                e
            )
        })?;
    tmp_file.write_all(body.as_bytes()).map_err(|e| {
        format!(
            "outside_connectors: write event tmp {} failed: {}",
            tmp.display(),
            e
        )
    })?;
    tmp_file
        .sync_all()
        .map_err(|e| format!("outside_connectors: sync event tmp failed: {}", e))?;
    drop(tmp_file);
    std::fs::rename(&tmp, path)
        .map_err(|e| format!("outside_connectors: rename events failed: {}", e))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

fn validate_connector(c: &OutsideConnector) -> Result<(), String> {
    if c.label.trim().is_empty() {
        return Err("outside_connectors.save: label cannot be empty".to_string());
    }
    if c.label.len() > 64 {
        return Err("outside_connectors.save: label exceeds 64 chars".to_string());
    }
    if matches!(c.dispatch_mode, OutsideConnectorDispatchMode::AutoPrompt)
        && !matches!(c.provider, OutsideConnectorProvider::Telegram { .. })
    {
        return Err(
            "outside_connectors.save: session chat is currently supported for Telegram only"
                .to_string(),
        );
    }
    match &c.provider {
        OutsideConnectorProvider::Telegram {
            bot_token_vault_key,
            allowed_chat_ids,
        } => {
            validate_vault_key(bot_token_vault_key)?;
            for id in allowed_chat_ids {
                validate_external_id("telegram chat id", id)?;
            }
        }
        OutsideConnectorProvider::Discord {
            bot_token_vault_key,
            allowed_target_ids,
        } => {
            validate_vault_key(bot_token_vault_key)?;
            for id in allowed_target_ids {
                validate_external_id("discord target id", id)?;
                validate_discord_dm_user_id(id)?;
            }
        }
    }
    if let OutsideConnectorTarget::FixedTab { tab_id } = &c.target {
        validate_tab_id(tab_id)?;
    }
    Ok(())
}

fn validate_discord_dm_user_id(value: &str) -> Result<(), String> {
    let v = value.trim();
    let raw = v.strip_prefix("user:").unwrap_or(v);
    if raw.is_empty() || !raw.chars().all(|c| c.is_ascii_digit()) {
        return Err(
            "outside_connectors: Discord is DM-only in this release; use numeric user IDs or user:<id>"
                .to_string(),
        );
    }
    Ok(())
}

fn validate_external_id(label: &str, value: &str) -> Result<(), String> {
    let v = value.trim();
    if v.is_empty() {
        return Err(format!("outside_connectors: {} cannot be empty", label));
    }
    if v.len() > 128 {
        return Err(format!("outside_connectors: {} exceeds 128 chars", label));
    }
    if !v
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | ':' | '@' | '.'))
    {
        return Err(format!(
            "outside_connectors: {} may only contain ASCII letters, digits, - _ : @ .",
            label
        ));
    }
    Ok(())
}

fn validate_tab_id(tab_id: &str) -> Result<(), String> {
    let t = tab_id.trim();
    if t.is_empty() {
        return Err("outside_connectors: fixed tab id cannot be empty".to_string());
    }
    if t.len() > 128 {
        return Err("outside_connectors: fixed tab id exceeds 128 chars".to_string());
    }
    if !t
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | ':' | '.'))
    {
        return Err(
            "outside_connectors: fixed tab id may only contain ASCII letters, digits, - _ : ."
                .to_string(),
        );
    }
    Ok(())
}

fn validate_vault_key(key: &str) -> Result<(), String> {
    if key.is_empty() {
        return Err("outside_connectors: vault key cannot be empty".to_string());
    }
    if key.len() > 256 {
        return Err("outside_connectors: vault key exceeds 256 chars".to_string());
    }
    if key.starts_with('/') || key.starts_with('.') || key.starts_with('-') {
        return Err("outside_connectors: vault key cannot start with /, ., or -".to_string());
    }
    if key.contains("..") || key.contains("//") {
        return Err("outside_connectors: vault key cannot contain '..' or '//'".to_string());
    }
    if !key
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '/' | '-'))
    {
        return Err(
            "outside_connectors: vault key may only contain ASCII alphanumeric and . _ / -"
                .to_string(),
        );
    }
    Ok(())
}

pub(crate) fn normalize_telegram_bot_token(raw: &str) -> Result<String, String> {
    let token = raw.trim();
    let Some((bot_id, secret)) = token.split_once(':') else {
        return Err("telegram bot token must have '<digits>:<token>' shape".to_string());
    };
    if bot_id.is_empty() || !bot_id.chars().all(|c| c.is_ascii_digit()) {
        return Err("telegram bot token id must be numeric".to_string());
    }
    if secret.is_empty()
        || !secret
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-'))
    {
        return Err(
            "telegram bot token secret may only contain ASCII alphanumeric, '_' or '-'".to_string(),
        );
    }
    Ok(token.to_string())
}

pub(crate) fn redact_connector_error_text(input: &str) -> String {
    let marker = "api.telegram.org/bot";
    let mut out = String::with_capacity(input.len());
    let mut rest = input;
    while let Some(idx) = rest.find(marker) {
        let token_start = idx + marker.len();
        out.push_str(&rest[..token_start]);
        out.push_str("[redacted]");
        let after = &rest[token_start..];
        let token_end = after
            .find(|c: char| c == '/' || c.is_whitespace() || matches!(c, ')' | '"' | '\''))
            .unwrap_or(after.len());
        rest = &after[token_end..];
    }
    out.push_str(rest);
    out
}

pub(crate) fn sanitized_reqwest_error(e: reqwest::Error) -> String {
    redact_connector_error_text(&e.without_url().to_string())
}

async fn test_telegram(bot_token_vault_key: &str) -> OutsideConnectorTestResult {
    let t0 = Instant::now();
    let provider = "telegram".to_string();
    let token = match read_vault_value(bot_token_vault_key).await {
        Ok(v) if !v.trim().is_empty() => v,
        Ok(_) => {
            return OutsideConnectorTestResult {
                reachable: false,
                provider,
                latency_ms: Some(t0.elapsed().as_millis() as u32),
                identity: None,
                error: Some("telegram bot token vault key is empty".to_string()),
            };
        }
        Err(e) => {
            return OutsideConnectorTestResult {
                reachable: false,
                provider,
                latency_ms: Some(t0.elapsed().as_millis() as u32),
                identity: None,
                error: Some(e),
            };
        }
    };
    let token = match normalize_telegram_bot_token(&token) {
        Ok(t) => t,
        Err(e) => {
            return OutsideConnectorTestResult {
                reachable: false,
                provider,
                latency_ms: Some(t0.elapsed().as_millis() as u32),
                identity: None,
                error: Some(e),
            };
        }
    };
    let url = format!("https://api.telegram.org/bot{}/getMe", token);
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            return OutsideConnectorTestResult {
                reachable: false,
                provider,
                latency_ms: None,
                identity: None,
                error: Some(format!("telegram client init failed: {}", e)),
            };
        }
    };
    let resp = match client.get(url).send().await {
        Ok(r) => r,
        Err(e) => {
            return OutsideConnectorTestResult {
                reachable: false,
                provider,
                latency_ms: Some(t0.elapsed().as_millis() as u32),
                identity: None,
                error: Some(format!(
                    "telegram getMe request failed: {}",
                    sanitized_reqwest_error(e)
                )),
            };
        }
    };
    let status = resp.status();
    if !status.is_success() {
        return OutsideConnectorTestResult {
            reachable: false,
            provider,
            latency_ms: Some(t0.elapsed().as_millis() as u32),
            identity: None,
            error: Some(format!("telegram getMe returned HTTP {}", status.as_u16())),
        };
    }
    match resp.json::<TelegramGetMeResponse>().await {
        Ok(body) if body.ok => OutsideConnectorTestResult {
            reachable: true,
            provider,
            latency_ms: Some(t0.elapsed().as_millis() as u32),
            identity: body.result.map(|u| match u.username {
                Some(username) if !username.trim().is_empty() => {
                    format!("@{} ({})", username, u.id)
                }
                _ => format!("bot {}", u.id),
            }),
            error: None,
        },
        Ok(body) => OutsideConnectorTestResult {
            reachable: false,
            provider,
            latency_ms: Some(t0.elapsed().as_millis() as u32),
            identity: None,
            error: Some(
                body.description
                    .map(|description| redact_connector_error_text(&description))
                    .unwrap_or_else(|| "telegram getMe returned ok=false".to_string()),
            ),
        },
        Err(e) => OutsideConnectorTestResult {
            reachable: false,
            provider,
            latency_ms: Some(t0.elapsed().as_millis() as u32),
            identity: None,
            error: Some(format!("telegram getMe response parse failed: {}", e)),
        },
    }
}

async fn test_discord(bot_token_vault_key: &str) -> OutsideConnectorTestResult {
    let t0 = Instant::now();
    let provider = "discord".to_string();
    let token = match read_vault_value(bot_token_vault_key).await {
        Ok(v) if !v.trim().is_empty() => v,
        Ok(_) => {
            return OutsideConnectorTestResult {
                reachable: false,
                provider,
                latency_ms: Some(t0.elapsed().as_millis() as u32),
                identity: None,
                error: Some("discord bot token vault key is empty".to_string()),
            };
        }
        Err(e) => {
            return OutsideConnectorTestResult {
                reachable: false,
                provider,
                latency_ms: Some(t0.elapsed().as_millis() as u32),
                identity: None,
                error: Some(e),
            };
        }
    };
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            return OutsideConnectorTestResult {
                reachable: false,
                provider,
                latency_ms: None,
                identity: None,
                error: Some(format!("discord client init failed: {}", e)),
            };
        }
    };
    let resp = match client
        .get("https://discord.com/api/v10/users/@me")
        .header(reqwest::header::AUTHORIZATION, discord_auth_header(&token))
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => {
            return OutsideConnectorTestResult {
                reachable: false,
                provider,
                latency_ms: Some(t0.elapsed().as_millis() as u32),
                identity: None,
                error: Some(format!(
                    "discord identity request failed: {}",
                    sanitized_reqwest_error(e)
                )),
            };
        }
    };
    let status = resp.status();
    if !status.is_success() {
        return OutsideConnectorTestResult {
            reachable: false,
            provider,
            latency_ms: Some(t0.elapsed().as_millis() as u32),
            identity: None,
            error: Some(format!(
                "discord identity returned HTTP {}",
                status.as_u16()
            )),
        };
    }
    match resp.json::<DiscordCurrentUser>().await {
        Ok(body) => OutsideConnectorTestResult {
            reachable: true,
            provider,
            latency_ms: Some(t0.elapsed().as_millis() as u32),
            identity: Some(format!("{} ({})", body.username, body.id)),
            error: None,
        },
        Err(e) => OutsideConnectorTestResult {
            reachable: false,
            provider,
            latency_ms: Some(t0.elapsed().as_millis() as u32),
            identity: None,
            error: Some(format!("discord identity response parse failed: {}", e)),
        },
    }
}

fn discord_auth_header(token: &str) -> String {
    let trimmed = token.trim();
    if trimmed.to_ascii_lowercase().starts_with("bot ") {
        trimmed.to_string()
    } else {
        format!("Bot {}", trimmed)
    }
}

pub(crate) async fn read_vault_value(key: &str) -> Result<String, String> {
    validate_vault_key(key)?;
    let vault = Arc::new(Vault::open()?);
    vault
        .get(key)
        .await?
        .ok_or_else(|| format!("vault key '{}' is not set", key))
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[derive(Debug, Deserialize)]
struct TelegramGetMeResponse {
    ok: bool,
    result: Option<TelegramUser>,
    description: Option<String>,
}

#[derive(Debug, Deserialize)]
struct TelegramUser {
    id: i64,
    username: Option<String>,
}

#[derive(Debug, Deserialize)]
struct DiscordCurrentUser {
    id: String,
    username: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_safe_vault_keys() {
        assert!(validate_vault_key("telegram/bot-token").is_ok());
        assert!(validate_vault_key("../bad").is_err());
        assert!(validate_vault_key("telegram//token").is_err());
    }

    #[test]
    fn validates_fixed_tab_ids() {
        assert!(validate_tab_id("tab-abc_123").is_ok());
        assert!(validate_tab_id("../secret").is_err());
        assert!(validate_tab_id("").is_err());
    }

    #[test]
    fn validates_telegram_bot_token_before_url_path_use() {
        assert_eq!(
            normalize_telegram_bot_token(" 123456:ABC_def-ghi ").unwrap(),
            "123456:ABC_def-ghi"
        );
        for bad in [
            "not-a-token",
            "123456",
            "123456:abc/def",
            "123456:abc?def",
            "abc:token",
        ] {
            assert!(
                normalize_telegram_bot_token(bad).is_err(),
                "bad token should be rejected: {bad}"
            );
        }
    }

    #[test]
    fn provider_capabilities_describe_receipt_tiers() {
        let caps = connector_capabilities();
        let telegram = caps
            .iter()
            .find(|c| c.provider == "telegram")
            .expect("telegram caps");
        let discord = caps
            .iter()
            .find(|c| c.provider == "discord")
            .expect("discord caps");

        assert_eq!(telegram.receipt_tier, "platform_accepted");
        assert_eq!(discord.receipt_tier, "platform_accepted");
        assert!(telegram.supports_attachments);
        assert!(!telegram.supports_buttons);
        assert!(!discord.supports_threading);
        assert!(!discord.supports_attachments);
        assert!(!discord.supports_buttons);
    }

    #[test]
    fn telegram_error_redaction_hides_bot_token_url_segments() {
        let raw = "telegram getMe request failed: error sending request for url (https://api.telegram.org/bot123456:ABC_def-ghi/getMe)";

        let redacted = redact_connector_error_text(raw);

        assert!(!redacted.contains("123456:ABC_def-ghi"));
        assert!(redacted.contains("bot[redacted]/getMe"));
    }

    #[test]
    fn allowlist_matches_provider_specific_sender() {
        let connector = sample_discord_connector(vec!["user:30".into()]);

        assert!(connector.sender_allowed("user:30", Some("channel:20"), Some("guild:10")));
        assert!(connector.sender_allowed("30", Some("channel:20"), Some("guild:10")));
        assert!(!connector.sender_allowed("user:31", Some("channel:30"), None));
    }

    #[test]
    fn discord_connector_validation_is_dm_user_only() {
        let mut connector = sample_discord_connector(vec!["guild:10".into()]);
        assert!(validate_connector(&connector).is_err());

        connector.provider = OutsideConnectorProvider::Discord {
            bot_token_vault_key: "discord/bot-token".into(),
            allowed_target_ids: vec!["channel:20".into()],
        };
        assert!(validate_connector(&connector).is_err());

        connector.provider = OutsideConnectorProvider::Discord {
            bot_token_vault_key: "discord/bot-token".into(),
            allowed_target_ids: vec!["user:30".into(), "31".into()],
        };
        assert!(validate_connector(&connector).is_ok());
    }

    #[test]
    fn telegram_auto_prompt_dispatch_is_validated() {
        let mut connector = sample_telegram_connector(vec!["123".into()]);
        connector.dispatch_mode = OutsideConnectorDispatchMode::AutoPrompt;

        assert!(validate_connector(&connector).is_ok());

        let mut discord = sample_discord_connector(vec!["123".into()]);
        discord.dispatch_mode = OutsideConnectorDispatchMode::AutoPrompt;
        let err = validate_connector(&discord).expect_err("discord auto prompt is not wired");
        assert!(err.contains("Telegram only"));
    }

    #[tokio::test]
    async fn runtime_error_updates_connector_health() {
        let store =
            OutsideConnectorStore::open_at(test_store_path("runtime-error")).expect("store");
        let saved = store
            .save(sample_telegram_connector(vec!["123".into()]))
            .await
            .expect("save");

        store
            .set_runtime_error(&saved.id, Some("poll failed"))
            .await
            .expect("set error");
        assert_eq!(
            store.list().await[0].last_error.as_deref(),
            Some("poll failed")
        );

        store
            .set_runtime_error(&saved.id, None)
            .await
            .expect("clear error");
        assert_eq!(store.list().await[0].last_error, None);
    }

    #[tokio::test]
    async fn auto_prompt_connector_records_dispatch_event() {
        let path = test_store_path("legacy-auto-prompt");
        std::fs::create_dir_all(path.parent().expect("parent")).expect("mkdir");
        std::fs::write(
            &path,
            r#"{
  "version": 1,
  "connectors": [
    {
      "id": "oconn-telegram",
      "label": "Telegram",
      "enabled": true,
      "provider": {
        "kind": "telegram",
        "botTokenVaultKey": "telegram/bot-token",
        "allowedChatIds": ["123"]
      },
      "target": { "mode": "activeTab" },
      "dispatchMode": "autoPrompt",
      "requireApproval": false,
      "createdMs": 2,
      "updatedMs": 2
    }
  ]
}"#,
        )
        .expect("write");
        let store = OutsideConnectorStore::open_at(path).expect("store");

        let event = store
            .simulate_inbound(
                "oconn-telegram",
                OutsideConnectorInboundInput {
                    sender_id: "123".into(),
                    conversation_id: Some("123".into()),
                    guild_id: None,
                    text: "hello".into(),
                },
            )
            .await
            .expect("event");

        assert_eq!(event.status, OutsideConnectorEventStatus::AutoPrompt);
        assert!(event.reason.is_none());
    }

    #[test]
    fn discord_allowlist_does_not_match_channel_or_guild_ids() {
        let connector = sample_discord_connector(vec!["user:30".into()]);

        assert!(!connector.sender_allowed("user:31", Some("channel:21"), Some("guild:11")));
    }

    #[tokio::test]
    async fn simulated_inbound_rejects_disallowed_sender() {
        let store = OutsideConnectorStore::open_at(test_store_path("reject")).expect("store");
        let saved = store
            .save(sample_telegram_connector(vec!["123".into()]))
            .await
            .expect("save");

        let event = store
            .simulate_inbound(
                &saved.id,
                OutsideConnectorInboundInput {
                    sender_id: "999".into(),
                    conversation_id: Some("999".into()),
                    guild_id: None,
                    text: "hello".into(),
                },
            )
            .await
            .expect("event");

        assert_eq!(event.status, OutsideConnectorEventStatus::Rejected);
        assert!(event.reason.unwrap_or_default().contains("not allowlisted"));
    }

    #[tokio::test]
    async fn simulated_inbound_records_inbox_event() {
        let store = OutsideConnectorStore::open_at(test_store_path("inbox")).expect("store");
        let saved = store
            .save(sample_telegram_connector(vec!["123".into()]))
            .await
            .expect("save");

        let event = store
            .simulate_inbound(
                &saved.id,
                OutsideConnectorInboundInput {
                    sender_id: "123".into(),
                    conversation_id: Some("123".into()),
                    guild_id: None,
                    text: "show sessions".into(),
                },
            )
            .await
            .expect("event");

        assert_eq!(event.status, OutsideConnectorEventStatus::Inbox);
        assert_eq!(store.events(10).await.len(), 1);
    }

    #[tokio::test]
    async fn open_skips_unsupported_provider_connectors() {
        let path = test_store_path("unsupported-provider");
        std::fs::create_dir_all(path.parent().expect("parent")).expect("mkdir");
        std::fs::write(
            &path,
            r#"{
  "version": 1,
  "connectors": [
    {
      "id": "oconn-unsupported",
      "label": "Unsupported",
      "enabled": true,
      "provider": { "kind": "removed_provider", "webhookVaultKey": "legacy/webhook" },
      "target": { "mode": "activeTab" },
      "dispatchMode": "inbox",
      "requireApproval": true,
      "createdMs": 1,
      "updatedMs": 1
    },
    {
      "id": "oconn-telegram",
      "label": "Telegram",
      "enabled": true,
      "provider": {
        "kind": "telegram",
        "botTokenVaultKey": "telegram/bot-token",
        "allowedChatIds": ["123"]
      },
      "target": { "mode": "activeTab" },
      "dispatchMode": "inbox",
      "requireApproval": true,
      "createdMs": 2,
      "updatedMs": 2
    }
  ]
}"#,
        )
        .expect("write");

        let store = OutsideConnectorStore::open_at(path).expect("store");
        let connectors = store.list().await;

        assert_eq!(connectors.len(), 1);
        assert_eq!(connectors[0].id, "oconn-telegram");
    }

    fn sample_discord_connector(allowed_target_ids: Vec<String>) -> OutsideConnector {
        OutsideConnector {
            id: "oconn-discord".into(),
            label: "Discord".into(),
            enabled: true,
            provider: OutsideConnectorProvider::Discord {
                bot_token_vault_key: "discord/bot-token".into(),
                allowed_target_ids,
            },
            target: OutsideConnectorTarget::ActiveTab,
            dispatch_mode: OutsideConnectorDispatchMode::Inbox,
            require_approval: true,
            created_ms: 0,
            updated_ms: 0,
            last_test_ms: None,
            last_error: None,
        }
    }

    fn sample_telegram_connector(allowed_chat_ids: Vec<String>) -> OutsideConnector {
        OutsideConnector {
            id: "".into(),
            label: "Telegram".into(),
            enabled: true,
            provider: OutsideConnectorProvider::Telegram {
                bot_token_vault_key: "telegram/bot-token".into(),
                allowed_chat_ids,
            },
            target: OutsideConnectorTarget::ActiveTab,
            dispatch_mode: OutsideConnectorDispatchMode::Inbox,
            require_approval: true,
            created_ms: 0,
            updated_ms: 0,
            last_test_ms: None,
            last_error: None,
        }
    }

    fn test_store_path(name: &str) -> PathBuf {
        std::env::temp_dir()
            .join(format!(
                "shellx-outside-connectors-{}-{}",
                name,
                uuid::Uuid::new_v4()
            ))
            .join("outside-connectors.json")
    }
}
