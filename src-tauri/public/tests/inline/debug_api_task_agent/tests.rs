use super::*;
use crate::{
    connections::{ConnectionProviderCapabilityTarget, ConnectionProviderScanStatus},
    shellx_browser_caller::SHELLX_MCP_CALLER_ID_HEADER,
    task_provider_catalog::{
        TaskProviderAvailability, TaskProviderCatalogProvider, TaskProviderDefaultModelMode,
        TASK_PROVIDER_CATALOG_SCHEMA_VERSION,
    },
};

fn catalogue() -> TaskProviderCatalog {
    TaskProviderCatalog {
        schema_version: TASK_PROVIDER_CATALOG_SCHEMA_VERSION.to_string(),
        guidance_provenance:
            crate::task_provider_catalog::TaskProviderCatalogGuidanceProvenance::from_cards(
                &crate::model_instruction_cards::model_instruction_cards_state(),
            ),
        snapshot_id: format!("sha256:{}", "a".repeat(64)),
        generated_at_ms: 1,
        fresh_until_ms: 60_001,
        target: ConnectionProviderCapabilityTarget {
            key: "local:linux".to_string(),
            label: "This computer".to_string(),
            transport: "local".to_string(),
            runtime: "posix".to_string(),
            wsl_distro: None,
            ssh_host: None,
            ssh_port: None,
        },
        providers: SUPPORTED_WORKERS
            .iter()
            .map(|provider_id| TaskProviderCatalogProvider {
                provider_id: (*provider_id).to_string(),
                label: worker_label(provider_id).to_string(),
                availability: TaskProviderAvailability {
                    status: ConnectionProviderScanStatus::Ready,
                    can_run: *provider_id != "antigravity-cli",
                    version: None,
                    detail: String::new(),
                    checked_at_ms: 1,
                },
                capability_guidance: Vec::new(),
                models: Vec::new(),
                default_model_mode: TaskProviderDefaultModelMode::ProviderDefault,
            })
            .collect(),
    }
}

#[test]
fn worker_order_defaults_to_the_current_ready_agent_and_rejects_unavailable_routes() {
    assert_eq!(
        selected_workers(&[], Some("codex-cli"), &catalogue()).unwrap(),
        vec!["codex-cli"]
    );
    assert_eq!(
        selected_workers(&[], Some("antigravity-cli"), &catalogue()).unwrap(),
        vec!["grok"]
    );
    assert_eq!(
        selected_workers(
            &["claude-code".to_string(), "grok".to_string()],
            None,
            &catalogue()
        )
        .unwrap(),
        vec!["claude-code", "grok"]
    );
    assert!(
        selected_workers(&["antigravity-cli".to_string()], None, &catalogue())
            .unwrap_err()
            .contains("not ready")
    );
}

#[test]
fn policy_and_tool_exposure_are_finite() {
    assert_eq!(
        task_execution_policy(Some("plan")),
        ("default".into(), "plan".into())
    );
    assert_eq!(
        task_execution_policy(Some("bypassPermissions")),
        ("bypassPermissions".into(), "bypassPermissions".into())
    );
    assert_eq!(task_tool_exposure(Some("hostFull")), "hostFull");
    assert_eq!(task_tool_exposure(Some("unknown")), "nativeFirst");
}

#[test]
fn agent_task_route_requires_one_valid_caller_before_conversation_intent() {
    let missing = require_agent_task_caller(&HeaderMap::new())
        .expect_err("a bearer-authenticated agent route still needs its ShellX caller");
    assert_eq!(missing.status(), StatusCode::FORBIDDEN);

    let mut duplicate = HeaderMap::new();
    duplicate.append(
        SHELLX_MCP_CALLER_ID_HEADER,
        "shellx-tab-a".parse().expect("valid first caller header"),
    );
    duplicate.append(
        SHELLX_MCP_CALLER_ID_HEADER,
        "shellx-tab-b".parse().expect("valid second caller header"),
    );
    let duplicate = require_agent_task_caller(&duplicate)
        .expect_err("duplicate caller headers must not fall back to operator authority");
    assert_eq!(duplicate.status(), StatusCode::BAD_REQUEST);

    let mut valid = HeaderMap::new();
    valid.insert(
        SHELLX_MCP_CALLER_ID_HEADER,
        "  shellx-tab-a  ".parse().expect("valid caller header"),
    );
    assert_eq!(
        require_agent_task_caller(&valid).expect("one valid caller is accepted"),
        "shellx-tab-a"
    );
}
