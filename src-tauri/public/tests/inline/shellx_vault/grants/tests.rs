use super::{GrantRequest, GrantScope};
use serde_json::{json, Value};

#[test]
fn grant_request_accepts_host_mcp_camel_case_scoped_ids() {
    for (scope, expected) in [
        (
            json!({ "kind": "agent", "agentId": "session-agent" }),
            GrantScope::Agent {
                agent_id: "session-agent".into(),
            },
        ),
        (
            json!({ "kind": "provider", "providerId": "provider-a" }),
            GrantScope::Provider {
                provider_id: "provider-a".into(),
            },
        ),
        (
            json!({ "kind": "connector", "connectorId": "connector-a" }),
            GrantScope::Connector {
                connector_id: "connector-a".into(),
            },
        ),
    ] {
        let request: GrantRequest = serde_json::from_value(json!({
            "secretRef": "synthetic/secret",
            "actorScope": scope,
            "operation": "fill",
        }))
        .expect("Host MCP scoped grant request must deserialize");
        assert_eq!(request.actor_scope, expected);
    }
}

#[test]
fn scoped_grant_ids_keep_existing_serialized_names_and_require_an_id() {
    for (kind, camel_name, snake_name) in [
        ("agent", "agentId", "agent_id"),
        ("provider", "providerId", "provider_id"),
        ("connector", "connectorId", "connector_id"),
    ] {
        let mut existing = json!({ "kind": kind });
        existing[snake_name] = json!("existing-caller");
        let scope: GrantScope = serde_json::from_value(existing)
            .expect("existing snake-case caller must still deserialize");
        let serialized = serde_json::to_value(scope).expect("serialize scope");
        assert_eq!(
            serialized[snake_name],
            Value::String("existing-caller".into())
        );
        assert!(serialized.get(camel_name).is_none());
        assert!(serde_json::from_value::<GrantScope>(json!({ "kind": kind })).is_err());
    }
}
