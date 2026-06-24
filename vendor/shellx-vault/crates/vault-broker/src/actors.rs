//! Actor registry foundation for Vault permission decisions.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ActorKind {
    User,
    Shellx,
    StandaloneVault,
    Browser,
    McpAgent,
    Cli,
    MatrixNode,
    Connector,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct VaultActor {
    pub actor_id: String,
    pub kind: ActorKind,
    pub display_name: String,
    pub device_id: String,
    #[serde(default)]
    pub public_key: Option<String>,
    pub created_at_ms: i64,
    #[serde(default)]
    pub revoked_at_ms: Option<i64>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ActorRegistry {
    actors: BTreeMap<String, VaultActor>,
}

impl ActorRegistry {
    pub fn register(&mut self, actor: VaultActor) {
        self.actors.insert(actor.actor_id.clone(), actor);
    }

    pub fn revoke(&mut self, actor_id: &str, revoked_at_ms: i64) -> Option<VaultActor> {
        let actor = self.actors.get_mut(actor_id)?;
        actor.revoked_at_ms = Some(revoked_at_ms);
        Some(actor.clone())
    }

    pub fn get(&self, actor_id: &str) -> Option<&VaultActor> {
        self.actors.get(actor_id)
    }

    pub fn is_active(&self, actor_id: &str) -> bool {
        self.get(actor_id)
            .map(|actor| actor.revoked_at_ms.is_none())
            .unwrap_or(false)
    }

    pub fn actors(&self) -> &BTreeMap<String, VaultActor> {
        &self.actors
    }
}
