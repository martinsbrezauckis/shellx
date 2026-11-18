use super::*;
use crate::connections::ConnectionProviderScanEntry;

const NOW_MS: i64 = 1_800_000_100_000;

fn snapshot() -> ConnectionProviderCapabilitySnapshot {
    ConnectionProviderCapabilitySnapshot {
        schema_version: "shellx.provider-capability-snapshot.v2".to_string(),
        generated_at_ms: NOW_MS,
        fresh_until_ms: NOW_MS + TASK_PROVIDER_CATALOG_TTL_MS,
        target: ConnectionProviderCapabilityTarget {
            key: "ssh:windows_wsl:host.test:22:wsl=ubuntu".to_string(),
            transport: "ssh".to_string(),
            runtime: "windows_wsl".to_string(),
            label: "SSH Windows WSL host.test:22".to_string(),
            wsl_distro: Some("Ubuntu".to_string()),
            ssh_host: Some("host.test".to_string()),
            ssh_port: Some(22),
        },
        providers: PROVIDERS
            .iter()
            .enumerate()
            .map(|(index, (provider_id, _))| ConnectionProviderScanEntry {
                provider_id: (*provider_id).to_string(),
                can_run: true,
                status: ConnectionProviderScanStatus::Ready,
                binary: Some(format!("/private/provider/{provider_id}")),
                version: Some(format!("{provider_id} {}.0.0", index + 1)),
                binary_sha256: Some("a".repeat(64)),
                binary_bytes: Some(4_096),
                target_key: "ssh:windows_wsl:host.test:22:wsl=ubuntu".to_string(),
                detail: None,
                checked_at_ms: NOW_MS - 1_000,
            })
            .collect(),
    }
}

#[test]
fn catalogue_projects_all_four_providers_without_binary_or_model_claims() {
    let catalogue = task_provider_catalog_from_snapshot_at(
        &snapshot(),
        &crate::model_instruction_cards::model_instruction_cards_state(),
        NOW_MS,
    )
    .expect("fresh exact provider snapshot should project");

    assert_eq!(
        catalogue.schema_version,
        TASK_PROVIDER_CATALOG_SCHEMA_VERSION
    );
    assert_eq!(
        catalogue.guidance_provenance.source,
        "bundled-model-instruction-cards"
    );
    assert_eq!(
        catalogue.guidance_provenance.cards_version,
        crate::model_instruction_cards::MODEL_INSTRUCTION_CARDS_VERSION
    );
    assert_eq!(
        catalogue.guidance_provenance.cards_last_reviewed,
        crate::model_instruction_cards::MODEL_INSTRUCTION_CARDS_REVIEWED_ON
    );
    assert_eq!(
        catalogue.guidance_provenance.review_scope,
        crate::model_instruction_cards::MODEL_CARD_REVIEW_SCOPE
    );
    assert_eq!(
        catalogue.guidance_provenance.availability_authority,
        crate::model_instruction_cards::MODEL_CARD_AVAILABILITY_AUTHORITY
    );
    assert_eq!(
        catalogue.guidance_provenance.native_capability_evidence,
        crate::model_instruction_cards::MODEL_CARD_NATIVE_CAPABILITY_EVIDENCE
    );
    assert!(catalogue.snapshot_id.starts_with("sha256:"));
    assert_eq!(catalogue.snapshot_id.len(), 71);
    assert_eq!(catalogue.target.runtime, "windows_wsl");
    assert_eq!(catalogue.providers.len(), 4);
    assert_eq!(catalogue.providers[0].provider_id, "grok");
    assert_eq!(catalogue.providers[1].provider_id, "codex-cli");
    assert_eq!(catalogue.providers[2].provider_id, "claude-code");
    assert_eq!(catalogue.providers[3].provider_id, "antigravity-cli");
    assert!(catalogue
        .providers
        .iter()
        .all(|provider| provider.models.is_empty()));
    assert!(catalogue.providers.iter().all(|provider| {
        provider.default_model_mode == TaskProviderDefaultModelMode::ProviderDefault
    }));
    assert!(catalogue.providers.iter().all(|provider| {
        !serde_json::to_string(provider)
            .expect("serialize provider projection")
            .contains("/private/provider/")
    }));
    assert!(catalogue
        .providers
        .iter()
        .all(|provider| provider.availability.version.is_some()));
}

#[test]
fn guidance_is_joined_by_provider_but_never_changes_availability() {
    let mut source = snapshot();
    let grok = source
        .providers
        .iter_mut()
        .find(|provider| provider.provider_id == "grok")
        .expect("grok fixture");
    grok.can_run = false;
    grok.status = ConnectionProviderScanStatus::Missing;
    grok.binary = None;
    grok.version = None;
    grok.binary_sha256 = None;
    grok.binary_bytes = None;
    grok.detail = Some("No supported CLI binary resolved on this exact target.".to_string());

    let catalogue = task_provider_catalog_from_snapshot_at(
        &source,
        &crate::model_instruction_cards::model_instruction_cards_state(),
        NOW_MS,
    )
    .expect("missing provider remains a valid fresh observation");
    let grok = catalogue
        .providers
        .iter()
        .find(|provider| provider.provider_id == "grok")
        .expect("grok projection");
    assert_eq!(
        grok.availability.status,
        ConnectionProviderScanStatus::Missing
    );
    assert!(!grok.availability.can_run);
    assert!(!grok.capability_guidance.is_empty());
}

#[test]
fn catalogue_replaces_probe_details_with_typed_safe_descriptions() {
    let mut source = snapshot();
    source.providers[0].status = ConnectionProviderScanStatus::TargetUnavailable;
    source.providers[0].can_run = false;
    source.providers[0].version = Some("provider --version /private/bin token=secret".to_string());
    source.providers[0].detail =
        Some("ssh /private/key vault-ref=connections/private-token".to_string());

    let catalogue = task_provider_catalog_from_snapshot_at(
        &source,
        &crate::model_instruction_cards::model_instruction_cards_state(),
        NOW_MS,
    )
    .expect("typed target status remains a valid fresh observation");
    let serialized = serde_json::to_string(&catalogue).expect("serialize catalogue");
    assert!(!serialized.contains("/private/"));
    assert!(!serialized.contains("connections/private-token"));
    assert!(!serialized.contains("token=secret"));
    assert_eq!(
        catalogue.providers[0].availability.detail,
        "The exact target is unavailable for a provider capability check."
    );
}

#[test]
fn catalogue_projects_only_one_isolated_safe_semantic_version_token() {
    assert_eq!(
        safe_semantic_version_token(Some("codex-cli 0.136.0")),
        Some("0.136.0".to_string())
    );
    assert_eq!(
        safe_semantic_version_token(Some("Claude Code v1.2.3-beta.1+build.7")),
        Some("1.2.3-beta.1+build.7".to_string())
    );
}

#[test]
fn catalogue_refuses_paths_tokens_controls_and_ambiguous_version_lines() {
    for raw in [
        "codex-cli /private/bin 0.136.0",
        "codex-cli 0.136.0 token=secret",
        "codex-cli: 0.136.0",
        "codex-cli 0.136.0\\nprivate diagnostic",
        "codex-cli 0.136.0\n",
        "codex-cli 0.136.0 1.2.3",
        "codex-cli 0.136",
        "codex-cli 0.136.0;",
    ] {
        assert_eq!(safe_semantic_version_token(Some(raw)), None, "{raw}");
    }
}

#[test]
fn rejects_stale_and_mismatched_provider_targets() {
    let mut stale = snapshot();
    stale.fresh_until_ms = NOW_MS - 1;
    assert!(task_provider_catalog_from_snapshot_at(
        &stale,
        &crate::model_instruction_cards::model_instruction_cards_state(),
        NOW_MS,
    )
    .is_err());

    let mut mismatched = snapshot();
    mismatched.providers[0].target_key = "local:linux".to_string();
    let error = task_provider_catalog_from_snapshot_at(
        &mismatched,
        &crate::model_instruction_cards::model_instruction_cards_state(),
        NOW_MS,
    )
    .expect_err("different target must fail");
    assert!(error.contains("different target"));
}
