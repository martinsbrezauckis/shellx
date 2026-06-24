//! Receipt foundation for brokered Vault actions.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ReceiptDecision {
    Allowed,
    Denied,
}

impl ReceiptDecision {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Allowed => "allowed",
            Self::Denied => "denied",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct VaultReceipt {
    pub receipt_id: String,
    pub actor_id: String,
    pub resource_id: String,
    pub action: String,
    pub grant_id: Option<String>,
    pub decision: ReceiptDecision,
    #[serde(default)]
    pub reason: Option<String>,
    pub created_at_ms: i64,
    pub secret_exposed: bool,
}
