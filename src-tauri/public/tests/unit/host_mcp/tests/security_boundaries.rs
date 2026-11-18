use super::super::*;

#[test]
fn agent_scoped_vault_grants_derive_identity_from_authenticated_caller() {
    let caller_a = vault_grant_request_body(
        json!({
            "secretRef": "accounts/example-password",
            "operation": "fill",
            "actorKind": "agent",
            "agentId": "spoofed-agent-b",
            "origin": "https://accounts.example"
        }),
        Some("caller-a"),
    )
    .expect("agent grant is caller bound");
    let caller_b = vault_grant_request_body(
        json!({
            "secretRef": "accounts/example-password",
            "operation": "fill",
            "actorScope": { "kind": "agent", "agentId": "spoofed-agent-a" },
            "origin": "https://accounts.example"
        }),
        Some("caller-b"),
    )
    .expect("explicit agent scope is caller bound");
    assert_eq!(
        caller_a["actorScope"]["agentId"],
        json!(vault_agent_actor_id(Some("caller-a")))
    );
    assert_ne!(
        caller_a["actorScope"]["agentId"],
        caller_b["actorScope"]["agentId"]
    );
    assert!(vault_grant_request_body(
        json!({
            "secretRef": "accounts/example-password",
            "operation": "fill",
            "actorKind": "agent",
            "origin": "https://accounts.example"
        }),
        None,
    )
    .expect_err("agent grants require an authenticated caller")
    .contains("authenticated Host MCP caller"));
}

#[test]
fn vault_grant_requests_never_infer_an_actor_scope() {
    let omitted = vault_grant_request_body(
        json!({
            "secretRef": "providers/example-token",
            "operation": "providerUse"
        }),
        Some("caller-a"),
    )
    .expect_err("omitted scope must fail before creating a pending grant");
    assert!(omitted.contains("requires an explicit actorScope or actorKind"));

    let explicit_all_agents = vault_grant_request_body(
        json!({
            "secretRef": "providers/example-token",
            "operation": "providerUse",
            "actorKind": "allShellxAgents"
        }),
        Some("caller-a"),
    )
    .expect("the deliberate broad scope remains available for operator review");
    assert_eq!(
        explicit_all_agents["actorScope"],
        json!({ "kind": "allShellxAgents" })
    );
}
