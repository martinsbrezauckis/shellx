use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryKit {
    pub confirmation_id: String,
    pub words: Vec<String>,
    pub warning: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryState {
    pub confirmed: bool,
    pub confirmed_at_ms: Option<i64>,
    pub pending_confirmation_id: Option<String>,
}

impl Default for RecoveryState {
    fn default() -> Self {
        Self {
            confirmed: true,
            confirmed_at_ms: None,
            pending_confirmation_id: None,
        }
    }
}

pub fn generate_recovery_kit() -> RecoveryKit {
    let confirmation_id = hex::encode(vault_core::random_bytes::<16>());
    let raw = hex::encode(vault_core::random_bytes::<32>());
    let words = raw
        .as_bytes()
        .chunks(4)
        .map(|chunk| String::from_utf8_lossy(chunk).to_string())
        .collect::<Vec<_>>();
    RecoveryKit {
        confirmation_id,
        words,
        warning: "Save this recovery kit. ShellX cannot recover the vault without it.".into(),
    }
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
