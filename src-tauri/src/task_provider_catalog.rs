//! Environment-bound provider catalogue for first-class Tasks.
//!
//! This is deliberately a projection of `connections::scan_connection_provider_capabilities`,
//! not a second detector. Instruction cards only add capability guidance; they never make a
//! provider available and they never supply a model inventory.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::connections::{
    scan_connection_provider_capabilities, ConnectionPreset, ConnectionProviderCapabilitySnapshot,
    ConnectionProviderCapabilityTarget, ConnectionProviderScanStatus,
};
use crate::model_instruction_cards::ModelInstructionCardsState;

pub const TASK_PROVIDER_CATALOG_SCHEMA_VERSION: &str = "shellx.task-provider-catalog.v1";
pub const TASK_PROVIDER_CATALOG_TTL_MS: i64 = 60_000;

const MAX_CLOCK_SKEW_MS: i64 = 5_000;
const PROVIDERS: [(&str, &str); 4] = [
    ("grok", "Grok"),
    ("codex-cli", "Codex CLI"),
    ("claude-code", "Claude Code"),
    ("antigravity-cli", "Antigravity CLI"),
];

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TaskProviderCatalog {
    pub schema_version: String,
    /// Opaque identity of the exact provider-capability snapshot used for this projection.
    pub snapshot_id: String,
    pub generated_at_ms: i64,
    pub fresh_until_ms: i64,
    pub target: ConnectionProviderCapabilityTarget,
    pub providers: Vec<TaskProviderCatalogProvider>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TaskProviderCatalogProvider {
    pub provider_id: String,
    pub label: String,
    pub availability: TaskProviderAvailability,
    pub capability_guidance: Vec<TaskProviderCapabilityGuidance>,
    /// Deliberately empty until a provider-native structured model enumeration exists.
    pub models: Vec<TaskProviderCatalogModel>,
    pub default_model_mode: TaskProviderDefaultModelMode,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TaskProviderAvailability {
    pub status: ConnectionProviderScanStatus,
    pub can_run: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    pub detail: String,
    pub checked_at_ms: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TaskProviderCapabilityGuidance {
    pub id: String,
    pub label: String,
    pub level: String,
    pub source_card_ids: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TaskProviderCatalogModel {
    pub id: String,
    pub label: String,
    pub source: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub verified_at_ms: Option<i64>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum TaskProviderDefaultModelMode {
    ProviderDefault,
}

/// Query the only provider-availability authority, then project its exact fresh target scan.
///
/// This function does not read authentication files, launch a provider, or enumerate models.
pub async fn scan_task_provider_catalog(
    preset: &ConnectionPreset,
) -> Result<TaskProviderCatalog, String> {
    let snapshot = scan_connection_provider_capabilities(preset).await?;
    task_provider_catalog_from_snapshot(&snapshot)
}

/// Build a task catalogue from an already collected capability snapshot.
///
/// This is useful for bounded API projections and tests. Callers that need a new scan should use
/// [`scan_task_provider_catalog`] so the target is derived by the connection scan authority.
pub fn task_provider_catalog_from_snapshot(
    snapshot: &ConnectionProviderCapabilitySnapshot,
) -> Result<TaskProviderCatalog, String> {
    task_provider_catalog_from_snapshot_at(
        snapshot,
        &crate::model_instruction_cards::model_instruction_cards_state(),
        now_ms(),
    )
}

pub fn task_provider_catalog_from_snapshot_at(
    snapshot: &ConnectionProviderCapabilitySnapshot,
    cards: &ModelInstructionCardsState,
    now_ms: i64,
) -> Result<TaskProviderCatalog, String> {
    validate_capability_snapshot(snapshot, now_ms)?;

    let providers_by_id = snapshot
        .providers
        .iter()
        .map(|provider| (provider.provider_id.as_str(), provider))
        .collect::<BTreeMap<_, _>>();

    let providers = PROVIDERS
        .iter()
        .map(|&(provider_id, label)| {
            let provider = providers_by_id
                .get(provider_id)
                .ok_or_else(|| {
                    format!(
                        "task provider catalogue lost validated provider {provider_id} during projection"
                    )
                })?;
            Ok(TaskProviderCatalogProvider {
                provider_id: provider_id.to_string(),
                label: label.to_string(),
                availability: TaskProviderAvailability {
                    status: provider.status,
                    can_run: provider.can_run,
                    // The source scan may retain a target-local path or
                    // provider-controlled diagnostic for the Connections UI.
                    // Task catalogues are safe to expose through the
                    // authenticated Debug API, so retain only a strictly
                    // isolated semantic-version token. Never forward the
                    // provider-controlled version line itself.
                    version: safe_semantic_version_token(provider.version.as_deref()),
                    detail: public_availability_detail(provider.status),
                    checked_at_ms: provider.checked_at_ms,
                },
                capability_guidance: capability_guidance(cards, provider_id),
                // A bundled model card is capability guidance, never structured model evidence.
                models: Vec::new(),
                default_model_mode: TaskProviderDefaultModelMode::ProviderDefault,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;

    Ok(TaskProviderCatalog {
        schema_version: TASK_PROVIDER_CATALOG_SCHEMA_VERSION.to_string(),
        snapshot_id: capability_snapshot_id(snapshot)?,
        generated_at_ms: snapshot.generated_at_ms,
        fresh_until_ms: snapshot.fresh_until_ms,
        target: snapshot.target.clone(),
        providers,
    })
}

const MAX_VERSION_SOURCE_BYTES: usize = 512;
const MAX_VERSION_TOKEN_BYTES: usize = 64;

/// Project one provider-controlled `--version` line to an isolated semantic
/// version token such as `0.136.0`. A version is useful capability evidence in
/// Task Manager, but the original line may include paths, flags, credentials,
/// or diagnostics. Reject rather than guessing whenever the source is not
/// unambiguous and safe to reduce to exactly one ASCII SemVer-like token.
fn safe_semantic_version_token(raw: Option<&str>) -> Option<String> {
    let raw = raw?;
    if raw.is_empty()
        || raw.len() > MAX_VERSION_SOURCE_BYTES
        || raw.chars().any(|character| {
            character.is_control()
                || matches!(character, '/' | '\\' | ':' | '=')
                || !character.is_ascii()
        })
    {
        return None;
    }
    let raw = raw.trim();
    if raw.is_empty() {
        return None;
    }

    let mut candidates = raw
        .split_ascii_whitespace()
        .filter_map(normalize_semantic_version_token);
    let version = candidates.next()?;
    if candidates.next().is_some() {
        return None;
    }
    Some(version)
}

/// Normalizes an optional `v` prefix while accepting only a three-part numeric
/// core and conservative SemVer pre-release/build identifiers. The resulting
/// string contains no whitespace, path separator, punctuation other than the
/// SemVer delimiters, or arbitrary provider text.
fn normalize_semantic_version_token(token: &str) -> Option<String> {
    if token.is_empty()
        || token.len() > MAX_VERSION_TOKEN_BYTES
        || !token.is_ascii()
        || token.chars().any(|character| {
            character.is_control()
                || character.is_ascii_whitespace()
                || matches!(character, '/' | '\\' | ':' | '=')
        })
    {
        return None;
    }
    let token = token.strip_prefix('v').unwrap_or(token);
    let suffix_index = token
        .char_indices()
        .find_map(|(index, character)| matches!(character, '-' | '+').then_some(index))
        .unwrap_or(token.len());
    let core = &token[..suffix_index];
    if !valid_semantic_core(core) {
        return None;
    }
    let suffix = &token[suffix_index..];
    if !valid_semantic_suffix(suffix) {
        return None;
    }
    Some(token.to_string())
}

fn valid_semantic_core(core: &str) -> bool {
    let parts = core.split('.').collect::<Vec<_>>();
    parts.len() == 3
        && parts.iter().all(|part| {
            !part.is_empty()
                && part.bytes().all(|byte| byte.is_ascii_digit())
                && (part == &"0" || !part.starts_with('0'))
        })
}

fn valid_semantic_suffix(suffix: &str) -> bool {
    if suffix.is_empty() {
        return true;
    }
    let (pre_release, build) = match suffix.split_once('+') {
        Some((pre_release, build)) if !build.contains('+') => (pre_release, Some(build)),
        Some(_) => return false,
        None => (suffix, None),
    };
    let valid_identifier_list = |value: &str| {
        !value.is_empty()
            && value.split('.').all(|identifier| {
                !identifier.is_empty()
                    && identifier
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
            })
    };
    let pre_release_valid = if pre_release.is_empty() {
        true
    } else {
        pre_release
            .strip_prefix('-')
            .is_some_and(valid_identifier_list)
    };
    let build_valid = build.map_or(true, valid_identifier_list);
    pre_release_valid && build_valid
}

/// Stable public descriptions for the finite scan status. This deliberately
/// never forwards the connection probe's arbitrary stderr, binary path, Vault
/// reference, or provider-controlled version output into a persisted Task
/// revision or Debug API response.
fn public_availability_detail(status: ConnectionProviderScanStatus) -> String {
    match status {
        ConnectionProviderScanStatus::Ready => String::new(),
        ConnectionProviderScanStatus::Missing => {
            "No supported CLI binary resolved on this exact target.".to_string()
        }
        ConnectionProviderScanStatus::VersionFailed => {
            "The exact target did not complete its bounded CLI version check.".to_string()
        }
        ConnectionProviderScanStatus::IdentityFailed => {
            "The exact target did not preserve a stable CLI identity during checking.".to_string()
        }
        ConnectionProviderScanStatus::TargetUnavailable => {
            "The exact target is unavailable for a provider capability check.".to_string()
        }
        ConnectionProviderScanStatus::AuthNeeded => {
            "The exact target requires provider authentication before it can run work.".to_string()
        }
        ConnectionProviderScanStatus::CanaryFailed => {
            "The exact target did not pass its provider runtime capability check.".to_string()
        }
        ConnectionProviderScanStatus::Unknown => {
            "The exact target returned an unsupported provider availability state.".to_string()
        }
    }
}

fn capability_snapshot_id(
    snapshot: &ConnectionProviderCapabilitySnapshot,
) -> Result<String, String> {
    let canonical = serde_json::to_vec(snapshot).map_err(|error| {
        format!("task provider catalogue could not identify its source snapshot: {error}")
    })?;
    Ok(format!("sha256:{:x}", Sha256::digest(canonical)))
}

fn capability_guidance(
    cards: &ModelInstructionCardsState,
    provider_id: &str,
) -> Vec<TaskProviderCapabilityGuidance> {
    let mut grouped = BTreeMap::<(String, String, String), BTreeSet<String>>::new();
    for card in cards
        .cards
        .iter()
        .filter(|card| card.provider_id == provider_id)
    {
        for capability in &card.capabilities {
            grouped
                .entry((
                    capability.id.clone(),
                    capability.label.clone(),
                    capability.level.clone(),
                ))
                .or_default()
                .insert(card.id.clone());
        }
    }
    grouped
        .into_iter()
        .map(
            |((id, label, level), source_card_ids)| TaskProviderCapabilityGuidance {
                id,
                label,
                level,
                source_card_ids: source_card_ids.into_iter().collect(),
            },
        )
        .collect()
}

fn validate_capability_snapshot(
    snapshot: &ConnectionProviderCapabilitySnapshot,
    now_ms: i64,
) -> Result<(), String> {
    if snapshot.schema_version != "shellx.provider-capability-snapshot.v2" {
        return Err(
            "task provider catalogue requires the provider capability snapshot v2".to_string(),
        );
    }
    if snapshot.generated_at_ms > now_ms.saturating_add(MAX_CLOCK_SKEW_MS) {
        return Err(
            "task provider catalogue rejects a future provider capability snapshot".to_string(),
        );
    }
    if snapshot
        .fresh_until_ms
        .saturating_sub(snapshot.generated_at_ms)
        != TASK_PROVIDER_CATALOG_TTL_MS
        || snapshot.fresh_until_ms < now_ms
    {
        return Err(
            "task provider catalogue rejects a stale provider capability snapshot".to_string(),
        );
    }
    if snapshot.target.key.trim().is_empty()
        || snapshot.target.transport.trim().is_empty()
        || snapshot.target.runtime.trim().is_empty()
        || snapshot.target.label.trim().is_empty()
    {
        return Err("task provider catalogue requires an exact target identity".to_string());
    }

    let expected = PROVIDERS
        .iter()
        .map(|(provider_id, _)| *provider_id)
        .collect::<BTreeSet<_>>();
    let mut seen = BTreeSet::new();
    for provider in &snapshot.providers {
        if !expected.contains(provider.provider_id.as_str()) {
            return Err(format!(
                "task provider catalogue received unsupported provider {}",
                provider.provider_id
            ));
        }
        if !seen.insert(provider.provider_id.as_str()) {
            return Err(format!(
                "task provider catalogue received duplicate provider {}",
                provider.provider_id
            ));
        }
        if provider.target_key != snapshot.target.key {
            return Err(format!(
                "task provider catalogue rejects provider {} from a different target",
                provider.provider_id
            ));
        }
        if provider.checked_at_ms > snapshot.generated_at_ms.saturating_add(MAX_CLOCK_SKEW_MS)
            || provider.checked_at_ms
                < snapshot
                    .generated_at_ms
                    .saturating_sub(TASK_PROVIDER_CATALOG_TTL_MS)
        {
            return Err(format!(
                "task provider catalogue rejects provider {} with an invalid checked time",
                provider.provider_id
            ));
        }
        if provider.status == ConnectionProviderScanStatus::Unknown {
            return Err(format!(
                "task provider catalogue rejects provider {} with unknown availability",
                provider.provider_id
            ));
        }
    }
    if seen != expected {
        let missing = expected.difference(&seen).copied().collect::<Vec<_>>();
        return Err(format!(
            "task provider catalogue requires all providers; missing {}",
            missing.join(", ")
        ));
    }
    Ok(())
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(i64::MAX)
}

#[cfg(test)]
mod tests {
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
        source.providers[0].version =
            Some("provider --version /private/bin token=secret".to_string());
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
}
