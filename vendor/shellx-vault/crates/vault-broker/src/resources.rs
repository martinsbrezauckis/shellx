//! Typed Vault resource foundation.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use vault_client::items::VaultItem;

pub const VAULT_RESOURCE_SCHEMA_VERSION: &str = "vault-resource-v1";
const SHELLX_COMPAT_NOTES_MARKER: &str = "shellx-compat-v1";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum VaultResourceKind {
    Login,
    Secret,
    ProfileCard,
    PaymentCard,
    AgentWallet,
    EmailInbox,
    DeveloperCredential,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ResourcePermission {
    UserOnly,
    #[default]
    VisibleAsk,
    AlwaysAllowed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VaultResource {
    pub id: String,
    #[serde(rename = "schemaVersion", default = "default_schema_version")]
    pub schema_version: String,
    pub kind: VaultResourceKind,
    pub label: String,
    #[serde(default)]
    pub permission: ResourcePermission,
    #[serde(default, rename = "publicFields")]
    pub public_fields: BTreeMap<String, Value>,
    #[serde(default, rename = "secretFields")]
    pub secret_fields: BTreeMap<String, String>,
    #[serde(default, rename = "customFields")]
    pub custom_fields: Vec<CustomField>,
    #[serde(default)]
    pub created_ms: i64,
    #[serde(default)]
    pub updated_ms: i64,
    #[serde(flatten)]
    pub extra: BTreeMap<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CustomField {
    pub id: String,
    pub label: String,
    pub kind: String,
    pub value: String,
    #[serde(default)]
    pub concealed: bool,
    #[serde(default)]
    pub autofill_hint: Option<String>,
    #[serde(default)]
    pub order: i64,
    #[serde(flatten)]
    pub extra: BTreeMap<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ResourceMigrationAction {
    ShellxCompatNoteMigrated,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ResourceMigrationReceipt {
    pub action: ResourceMigrationAction,
    pub source_item_id: String,
    pub resource_id: String,
    pub created_ms: i64,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ShellxCompatItemNotes {
    shellx_compat: String,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    user_only: bool,
    #[serde(default)]
    resource_kind: ShellxResourceKind,
    #[serde(default)]
    resource_summary: Option<String>,
    #[serde(default)]
    resource_provider: Option<String>,
    #[serde(default)]
    resource_fields: Vec<String>,
}

#[derive(Debug, Clone, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
enum ShellxResourceKind {
    #[default]
    Secret,
    ProfileCard,
    EmailInbox,
    StripeAgentWallet,
}

impl VaultResource {
    pub fn to_vault_item(&self) -> VaultItem {
        let mut extra = match serde_json::to_value(self).unwrap_or(Value::Null) {
            Value::Object(map) => map.into_iter().collect::<BTreeMap<_, _>>(),
            _ => BTreeMap::new(),
        };
        extra.remove("id");

        VaultItem {
            id: self.id.clone(),
            kind: "resource".to_string(),
            title: self.label.clone(),
            username: String::new(),
            password: String::new(),
            url: String::new(),
            notes: String::new(),
            created_ms: self.created_ms,
            updated_ms: self.updated_ms,
            extra,
        }
    }

    pub fn from_typed_vault_item(item: &VaultItem) -> Option<VaultResource> {
        if item.kind != "resource" {
            return None;
        }
        let mut object = item
            .extra
            .clone()
            .into_iter()
            .collect::<Map<String, Value>>();
        object
            .entry("id".to_string())
            .or_insert_with(|| Value::String(item.id.clone()));
        object
            .entry("label".to_string())
            .or_insert_with(|| Value::String(item.title.clone()));
        object
            .entry("createdMs".to_string())
            .or_insert_with(|| Value::Number(item.created_ms.into()));
        object
            .entry("updatedMs".to_string())
            .or_insert_with(|| Value::Number(item.updated_ms.into()));

        serde_json::from_value(Value::Object(object)).ok()
    }

    pub fn from_shellx_compat_item(
        item: &VaultItem,
    ) -> Option<(VaultResource, ResourceMigrationReceipt)> {
        let notes = parse_shellx_compat_notes(&item.notes)?;
        let mut public_fields = BTreeMap::new();
        if let Some(description) = clean_optional(notes.description) {
            public_fields.insert("description".to_string(), Value::String(description));
        }
        if let Some(summary) = clean_optional(notes.resource_summary) {
            public_fields.insert("summary".to_string(), Value::String(summary));
        }
        if let Some(provider) = clean_optional(notes.resource_provider) {
            public_fields.insert("provider".to_string(), Value::String(provider));
        }
        if !notes.resource_fields.is_empty() {
            public_fields.insert(
                "resourceFields".to_string(),
                Value::Array(
                    notes
                        .resource_fields
                        .into_iter()
                        .filter_map(clean_field_name)
                        .map(Value::String)
                        .collect(),
                ),
            );
        }

        let kind = match notes.resource_kind {
            ShellxResourceKind::Secret => VaultResourceKind::Secret,
            ShellxResourceKind::ProfileCard => VaultResourceKind::ProfileCard,
            ShellxResourceKind::EmailInbox => VaultResourceKind::EmailInbox,
            ShellxResourceKind::StripeAgentWallet => {
                public_fields.insert(
                    "sourceKind".to_string(),
                    Value::String("stripeAgentWallet".to_string()),
                );
                public_fields
                    .entry("provider".to_string())
                    .or_insert_with(|| Value::String("stripe".to_string()));
                VaultResourceKind::AgentWallet
            }
        };

        let mut secret_fields = BTreeMap::new();
        secret_fields.insert("value".to_string(), item.password.clone());
        let resource = VaultResource {
            id: if item.id.trim().is_empty() {
                shellx_compat_item_id(&item.title)
            } else {
                item.id.clone()
            },
            schema_version: VAULT_RESOURCE_SCHEMA_VERSION.to_string(),
            kind,
            label: item.title.clone(),
            permission: if notes.user_only {
                ResourcePermission::UserOnly
            } else {
                ResourcePermission::VisibleAsk
            },
            public_fields,
            secret_fields,
            custom_fields: Vec::new(),
            created_ms: item.created_ms,
            updated_ms: item.updated_ms,
            extra: BTreeMap::new(),
        };
        let receipt = ResourceMigrationReceipt {
            action: ResourceMigrationAction::ShellxCompatNoteMigrated,
            source_item_id: item.id.clone(),
            resource_id: resource.id.clone(),
            created_ms: item.updated_ms,
        };
        Some((resource, receipt))
    }
}

pub fn shellx_compat_item_id(key: &str) -> String {
    let digest = blake3::hash(format!("shellx-vault-kv-v1\0{key}").as_bytes());
    format!("kv-{}", digest.to_hex())
}

fn default_schema_version() -> String {
    VAULT_RESOURCE_SCHEMA_VERSION.to_string()
}

fn parse_shellx_compat_notes(notes: &str) -> Option<ShellxCompatItemNotes> {
    if notes == SHELLX_COMPAT_NOTES_MARKER {
        return Some(ShellxCompatItemNotes {
            shellx_compat: SHELLX_COMPAT_NOTES_MARKER.to_string(),
            ..Default::default()
        });
    }
    let parsed: ShellxCompatItemNotes = serde_json::from_str(notes).ok()?;
    if parsed.shellx_compat == SHELLX_COMPAT_NOTES_MARKER {
        Some(parsed)
    } else {
        None
    }
}

fn clean_optional(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn clean_field_name(value: String) -> Option<String> {
    let value = value.trim().to_string();
    if value.is_empty() {
        None
    } else {
        Some(value)
    }
}
