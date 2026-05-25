// src-tauri/src/outside_connectors.rs
//
// Outside connector presets for user-facing channels such as Telegram
// and local bridge relays. Non-secret config lives in
// ~/.shellx/outside-connectors.json; provider tokens remain in Vault
// and are referenced by key name only.

use std::io::Write as _;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;
use tracing::info;

use crate::vault::Vault;

const STORE_VERSION: u32 = 1;

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
    GenericRelay {
        shared_secret_vault_key: String,
        #[serde(default)]
        allowed_sender_ids: Vec<String>,
    },
}

impl OutsideConnectorProvider {
    pub fn kind_label(&self) -> &'static str {
        match self {
            Self::Telegram { .. } => "telegram",
            Self::GenericRelay { .. } => "generic_relay",
        }
    }
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
}

impl OutsideConnectorStore {
    pub fn open() -> Result<Self, String> {
        let path = store_path()?;
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
                let store: StoreFile = serde_json::from_str(&raw)
                    .map_err(|e| format!("outside_connectors: parse failed: {}", e))?;
                store.connectors
            }
        } else {
            vec![]
        };
        info!(
            "outside_connectors: opened at {} ({} connectors)",
            path.display(),
            connectors.len()
        );
        Ok(Self {
            path,
            state: Mutex::new(connectors),
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
            OutsideConnectorProvider::GenericRelay {
                shared_secret_vault_key,
                ..
            } => test_generic_relay(shared_secret_vault_key).await,
        };
        let mut guard = self.state.lock().await;
        if let Some(existing) = guard.iter_mut().find(|c| c.id == id) {
            existing.last_test_ms = Some(now_ms());
            existing.last_error = result.error.clone();
            let _ = persist(&self.path, &guard);
        }
        result
    }
}

fn store_path() -> Result<PathBuf, String> {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map_err(|_| "outside_connectors: HOME/USERPROFILE not set".to_string())?;
    Ok(PathBuf::from(home)
        .join(".shellx")
        .join("outside-connectors.json"))
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

fn validate_connector(c: &OutsideConnector) -> Result<(), String> {
    if c.label.trim().is_empty() {
        return Err("outside_connectors.save: label cannot be empty".to_string());
    }
    if c.label.len() > 64 {
        return Err("outside_connectors.save: label exceeds 64 chars".to_string());
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
        OutsideConnectorProvider::GenericRelay {
            shared_secret_vault_key,
            allowed_sender_ids,
        } => {
            validate_vault_key(shared_secret_vault_key)?;
            for id in allowed_sender_ids {
                validate_external_id("sender id", id)?;
            }
        }
    }
    if let OutsideConnectorTarget::FixedTab { tab_id } = &c.target {
        validate_tab_id(tab_id)?;
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

async fn test_generic_relay(secret_vault_key: &str) -> OutsideConnectorTestResult {
    let t0 = Instant::now();
    let provider = "generic_relay".to_string();
    match read_vault_value(secret_vault_key).await {
        Ok(value) if !value.trim().is_empty() => OutsideConnectorTestResult {
            reachable: true,
            provider,
            latency_ms: Some(t0.elapsed().as_millis() as u32),
            identity: Some("shared secret present".to_string()),
            error: None,
        },
        Ok(_) => OutsideConnectorTestResult {
            reachable: false,
            provider,
            latency_ms: Some(t0.elapsed().as_millis() as u32),
            identity: None,
            error: Some("shared secret vault key is empty".to_string()),
        },
        Err(e) => OutsideConnectorTestResult {
            reachable: false,
            provider,
            latency_ms: Some(t0.elapsed().as_millis() as u32),
            identity: None,
            error: Some(e),
        },
    }
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
    let url = format!("https://api.telegram.org/bot{}/getMe", token.trim());
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
                error: Some(format!("telegram getMe request failed: {}", e)),
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

async fn read_vault_value(key: &str) -> Result<String, String> {
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
}
