use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum GrantOperation {
    Fill,
    ProfileFill,
    EmailCodeRead,
    AgentWalletUse,
    InjectEnv,
    ProviderUse,
    ConnectorUse,
    Deposit,
    RawReveal,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum GrantScope {
    Agent {
        #[serde(alias = "agentId")]
        agent_id: String,
    },
    Provider {
        #[serde(alias = "providerId")]
        provider_id: String,
    },
    Workspace {
        workspace: String,
    },
    BrowserOrigin {
        origin: String,
    },
    Connector {
        #[serde(alias = "connectorId")]
        connector_id: String,
    },
    AllShellxAgents,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GrantActorContext {
    pub agent_id: Option<String>,
    pub provider_id: Option<String>,
    pub workspace: Option<String>,
    pub origin: Option<String>,
    pub connector_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GrantRequest {
    pub secret_ref: String,
    pub actor_scope: GrantScope,
    pub operation: GrantOperation,
    #[serde(default)]
    pub origin: Option<String>,
    pub expires_at_ms: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GrantSummary {
    pub grant_id: String,
    pub secret_ref: String,
    pub actor_scope: String,
    pub operation: String,
    pub origin: Option<String>,
    pub created_at_ms: i64,
    pub expires_at_ms: Option<i64>,
    pub revoked: bool,
    pub approved: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum GrantDecision {
    AllowMediated,
    AllowRawReveal,
    Deny { reason: String },
}

#[cfg(test)]
#[path = "../../public/tests/inline/shellx_vault/grants/tests.rs"]
mod tests;
