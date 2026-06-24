use serde_json::json;
use vault_broker::resources::{
    shellx_compat_item_id, CustomField, ResourceMigrationAction, ResourcePermission, VaultResource,
    VaultResourceKind, VAULT_RESOURCE_SCHEMA_VERSION,
};
use vault_client::items::VaultItem;

#[test]
fn resource_schema_preserves_unknown_fields_on_roundtrip() {
    let raw = json!({
        "id": "res-profile-main",
        "schemaVersion": "vault-resource-v1",
        "kind": "profileCard",
        "label": "Personal profile",
        "permission": "visibleAsk",
        "publicFields": {
            "email": "person@example.com",
            "country": "LV"
        },
        "secretFields": {},
        "customFields": [{
            "id": "field-hidden",
            "label": "Internal code",
            "kind": "hidden",
            "value": "blue",
            "concealed": true,
            "order": 7
        }],
        "futureField": {
            "kept": true
        }
    });

    let resource: VaultResource = serde_json::from_value(raw.clone()).unwrap();

    assert_eq!(resource.schema_version, VAULT_RESOURCE_SCHEMA_VERSION);
    assert_eq!(resource.kind, VaultResourceKind::ProfileCard);
    assert_eq!(resource.permission, ResourcePermission::VisibleAsk);

    let back = serde_json::to_value(&resource).unwrap();
    assert_eq!(back["futureField"], json!({ "kept": true }));
    assert_eq!(back["customFields"][0]["kind"], "hidden");
}

#[test]
fn resource_schema_migrates_shellx_compat_secret_note() {
    let item = compat_item(
        "providers/openai/api-key",
        "sk-test-secret",
        r#"{"shellxCompat":"shellx-compat-v1","description":"OpenAI key","userOnly":true,"resourceKind":"secret","resourceSummary":"API key","resourceProvider":"openai","resourceFields":["value"]}"#,
    );

    let (resource, receipt) = VaultResource::from_shellx_compat_item(&item).unwrap();

    assert_eq!(
        resource.id,
        "kv-9c0a7a93ba28854be95a1311b5d87d5495522ebce6c71dc27cf0c4c53a5c10ae"
    );
    assert_eq!(resource.kind, VaultResourceKind::Secret);
    assert_eq!(resource.permission, ResourcePermission::UserOnly);
    assert_eq!(resource.label, "providers/openai/api-key");
    assert_eq!(
        resource.secret_fields.get("value").unwrap(),
        "sk-test-secret"
    );
    assert_eq!(resource.public_fields["description"], "OpenAI key");
    assert_eq!(resource.public_fields["provider"], "openai");
    assert_eq!(
        receipt.action,
        ResourceMigrationAction::ShellxCompatNoteMigrated
    );
    assert_eq!(receipt.source_item_id, item.id);
}

#[test]
fn resource_schema_roundtrips_standalone_typed_resource_through_vault_item() {
    let resource = VaultResource {
        id: "res-card-main".to_string(),
        schema_version: VAULT_RESOURCE_SCHEMA_VERSION.to_string(),
        kind: VaultResourceKind::PaymentCard,
        label: "Personal card".to_string(),
        permission: ResourcePermission::UserOnly,
        public_fields: [
            ("network".to_string(), json!("visa")),
            ("expiryMonth".to_string(), json!("08")),
        ]
        .into(),
        secret_fields: [
            ("numberRef".to_string(), "secret-card-number".to_string()),
            ("securityCodeRef".to_string(), "secret-card-cvv".to_string()),
        ]
        .into(),
        custom_fields: vec![CustomField {
            id: "field-1".to_string(),
            label: "nickname".to_string(),
            kind: "text".to_string(),
            value: "daily".to_string(),
            concealed: false,
            autofill_hint: None,
            order: 1,
            extra: Default::default(),
        }],
        created_ms: 100,
        updated_ms: 200,
        extra: [("futureField".to_string(), json!({ "kept": true }))].into(),
    };

    let item = resource.to_vault_item();
    assert_eq!(item.kind, "resource");
    assert_eq!(item.title, "Personal card");
    assert_eq!(item.password, "");
    assert_eq!(item.extra["schemaVersion"], VAULT_RESOURCE_SCHEMA_VERSION);
    assert_eq!(item.extra["kind"], "paymentCard");

    let roundtrip = VaultResource::from_typed_vault_item(&item).unwrap();
    assert_eq!(roundtrip, resource);
}

#[test]
fn resource_schema_migrates_shellx_profile_card_and_stripe_wallet_kinds() {
    let profile = compat_item(
        "profile/main",
        r#"{"fullName":"Ada Lovelace","email":"ada@example.com"}"#,
        r#"{"shellxCompat":"shellx-compat-v1","resourceKind":"profileCard","resourceSummary":"Ada profile","resourceFields":["fullName","email"]}"#,
    );
    let (profile_resource, _) = VaultResource::from_shellx_compat_item(&profile).unwrap();
    assert_eq!(profile_resource.kind, VaultResourceKind::ProfileCard);
    assert_eq!(profile_resource.public_fields["summary"], "Ada profile");
    assert_eq!(
        profile_resource.secret_fields.get("value").unwrap(),
        r#"{"fullName":"Ada Lovelace","email":"ada@example.com"}"#
    );

    let wallet = compat_item(
        "wallets/stripe/test",
        "stripe-test-secret-ref",
        r#"{"shellxCompat":"shellx-compat-v1","resourceKind":"stripeAgentWallet","resourceProvider":"stripe","resourceSummary":"Test wallet","resourceFields":["budget","origin"]}"#,
    );
    let (wallet_resource, _) = VaultResource::from_shellx_compat_item(&wallet).unwrap();
    assert_eq!(wallet_resource.kind, VaultResourceKind::AgentWallet);
    assert_eq!(wallet_resource.public_fields["provider"], "stripe");
    assert_eq!(
        wallet_resource.public_fields["sourceKind"],
        "stripeAgentWallet"
    );
}

#[test]
fn resource_schema_ignores_non_shellx_compat_items() {
    let item = VaultItem {
        id: "note-1".to_string(),
        kind: "note".to_string(),
        title: "ordinary note".to_string(),
        username: String::new(),
        password: "secret".to_string(),
        url: String::new(),
        notes: "plain user note".to_string(),
        created_ms: 1,
        updated_ms: 2,
        extra: Default::default(),
    };

    assert!(VaultResource::from_shellx_compat_item(&item).is_none());
}

#[test]
fn resource_schema_shellx_compat_ids_are_stable() {
    assert_eq!(
        shellx_compat_item_id("providers/openai/api-key"),
        "kv-9c0a7a93ba28854be95a1311b5d87d5495522ebce6c71dc27cf0c4c53a5c10ae"
    );
}

fn compat_item(key: &str, value: &str, notes: &str) -> VaultItem {
    VaultItem {
        id: shellx_compat_item_id(key),
        kind: "note".to_string(),
        title: key.to_string(),
        username: String::new(),
        password: value.to_string(),
        url: String::new(),
        notes: notes.to_string(),
        created_ms: 11,
        updated_ms: 22,
        extra: Default::default(),
    }
}
