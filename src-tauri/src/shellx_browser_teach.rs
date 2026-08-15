use std::collections::BTreeMap;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::State;

use crate::shellx_browser::{
    lock_or_recover, now_ms, push_receipt, BrowserRecipeReplayRequest, BrowserState,
    ShellxBrowserRegistry,
};
use crate::shellx_browser_caller::BrowserTaskControlAuthority;
use crate::shellx_browser_prompt_guard::BrowserPromptGuardOutcome;

const FLIGHT_ARTIFACT_FOLDER: &str = "shellx-browser-flight-recorder";
const TEACH_BUNDLE_FOLDER: &str = "shellx-browser-teach-bundles";
const TEACH_REVISION_FOLDER: &str = "shellx-browser-teach-revisions";
const RECIPE_ARTIFACT_FOLDER: &str = "shellx-browser-recipes";
const MAX_FLIGHT_ARTIFACT_BYTES: u64 = 512 * 1_024;
const MAX_TEACH_ARTIFACT_BYTES: usize = 512 * 1_024;
const MAX_TEACH_STEPS: usize = 100;
const MAX_TEACH_VALUES: usize = 64;
const MAX_TEACH_ISSUES: usize = 64;
const MAX_TEACH_EVIDENCE_REFS: usize = 256;
const DEFAULT_DRAFT_LIMIT: usize = 8;
const MAX_DRAFT_LIMIT: usize = 20;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserTeachPrepareRequest {
    #[serde(rename = "attemptId", alias = "attempt_id")]
    pub attempt_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserTeachDraftsQuery {
    #[serde(rename = "taskId", alias = "task_id")]
    pub task_id: String,
    #[serde(default)]
    pub limit: Option<usize>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserTeachRevisionRequest {
    #[serde(rename = "draftId", alias = "draft_id")]
    pub draft_id: String,
    #[serde(rename = "expectedRevisionId", alias = "expected_revision_id")]
    pub expected_revision_id: String,
    #[serde(rename = "expectedRevisionSha256", alias = "expected_revision_sha256")]
    pub expected_revision_sha256: String,
    #[serde(default)]
    pub goal: Option<String>,
    #[serde(rename = "orderedStepIds", alias = "ordered_step_ids", default)]
    pub ordered_step_ids: Option<Vec<String>>,
    #[serde(rename = "valueEdits", alias = "value_edits", default)]
    pub value_edits: Option<Vec<BrowserTeachValueEdit>>,
    #[serde(rename = "vaultBindings", alias = "vault_bindings", default)]
    pub vault_bindings: Option<Vec<BrowserTeachVaultBinding>>,
    #[serde(
        rename = "requiredCapabilities",
        alias = "required_capabilities",
        default
    )]
    pub required_capabilities: Option<Vec<String>>,
    #[serde(
        rename = "ambiguityResolutions",
        alias = "ambiguity_resolutions",
        default
    )]
    pub ambiguity_resolutions: Option<Vec<String>>,
    #[serde(rename = "revisionNote", alias = "revision_note", default)]
    pub revision_note: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserTeachValueEdit {
    #[serde(rename = "valueId", alias = "value_id")]
    pub value_id: String,
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub literal: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserTeachVaultBinding {
    #[serde(rename = "valueId", alias = "value_id")]
    pub value_id: String,
    #[serde(rename = "bindingId", alias = "binding_id", default)]
    pub binding_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserTeachApprovalRequest {
    #[serde(rename = "draftId", alias = "draft_id")]
    pub draft_id: String,
    #[serde(rename = "revisionId", alias = "revision_id")]
    pub revision_id: String,
    #[serde(rename = "revisionSha256", alias = "revision_sha256")]
    pub revision_sha256: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserTeachRehearseRequest {
    #[serde(rename = "recipeId", alias = "recipe_id")]
    pub recipe_id: String,
    pub sha256: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserTeachPrepareResponse {
    pub bundle: BrowserTeachBundle,
    pub revision: BrowserTeachRevision,
    pub draft: BrowserTeachDraftSummary,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserTeachRevisionResponse {
    pub revision: BrowserTeachRevision,
    pub draft: BrowserTeachDraftSummary,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserTeachRehearseResponse {
    pub recipe_id: String,
    pub sha256: String,
    pub dry_run: bool,
    pub steps_planned: usize,
    pub steps_skipped: usize,
    pub steps_applied: usize,
    pub receipt: BrowserTeachReceiptIdentity,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserTeachReceiptIdentity {
    pub receipt_id: String,
    pub kind: String,
    pub created_at_ms: i64,
    pub sequence: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserTeachDraftListResponse {
    pub task_id: String,
    pub drafts: Vec<BrowserTeachDraftSummary>,
    pub limit: usize,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserTeachDraftSummary {
    pub draft_id: String,
    pub bundle_id: String,
    pub bundle_sha256: String,
    pub task_id: String,
    pub browser_tab_id: String,
    pub attempt_id: String,
    pub current_revision_id: String,
    pub current_revision_sha256: String,
    pub revision: u64,
    pub step_count: usize,
    pub value_count: usize,
    pub blocking_issues: usize,
    pub created_at_ms: i64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserTeachBundle {
    pub schema_version: String,
    pub bundle_id: String,
    pub created_at_ms: i64,
    pub source: BrowserTeachSource,
    pub steps: Vec<BrowserTeachStep>,
    pub values: Vec<BrowserTeachValue>,
    pub ambiguities: Vec<BrowserTeachIssue>,
    pub loss: Vec<BrowserTeachIssue>,
    pub bytes: usize,
    pub sha256: String,
    pub redaction_receipt: Value,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserTeachSource {
    pub attempt_id: String,
    pub task_id: String,
    pub browser_tab_id: String,
    pub bytes: u64,
    pub sha256: String,
    pub created_at_ms: i64,
    pub owner_session_id: String,
    pub evidence_complete: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserTeachStep {
    pub step_id: String,
    pub source_sequence: u64,
    pub operation: String,
    pub classification: String,
    #[serde(default)]
    pub target_ref: Option<String>,
    #[serde(default)]
    pub value_refs: Vec<String>,
    #[serde(default)]
    pub assertion_refs: Vec<String>,
    #[serde(default)]
    pub decision_point_refs: Vec<String>,
    pub evidence_refs: Vec<String>,
    /// This is a sanitized, Action Recipe V2-compatible projection. It is
    /// deliberately not a second replay language.
    pub recipe_step: Value,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserTeachValue {
    pub value_id: String,
    pub label: String,
    pub kind: String,
    #[serde(default)]
    pub literal: Option<String>,
    pub required_vault_binding: bool,
    pub source_evidence_refs: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserTeachIssue {
    pub issue_id: String,
    pub code: String,
    pub blocking: bool,
    #[serde(default)]
    pub source_sequence: Option<u64>,
    pub detail: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserTeachRevision {
    pub schema_version: String,
    pub revision_id: String,
    pub revision: u64,
    #[serde(default)]
    pub parent_revision_id: Option<String>,
    pub bundle_id: String,
    pub bundle_sha256: String,
    pub goal: String,
    pub steps: Vec<BrowserTeachStep>,
    pub values: Vec<BrowserTeachValue>,
    pub required_vault_bindings: Vec<BrowserTeachVaultBinding>,
    pub required_capabilities: Vec<String>,
    pub ambiguity_resolutions: Vec<String>,
    pub action_summary: BrowserTeachActionSummary,
    #[serde(default)]
    pub revision_note: Option<String>,
    pub author_surface: String,
    pub created_at_ms: i64,
    pub bytes: usize,
    pub sha256: String,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserTeachActionSummary {
    pub reads: usize,
    pub derives: usize,
    pub actions: usize,
    pub assertions: usize,
    pub decision_points: usize,
    pub blocking_issues: usize,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserTeachApprovalResponse {
    pub recipe: BrowserTeachRecipeIdentity,
    pub approval: BrowserTeachApprovalReceipt,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserTeachRecipeIdentity {
    pub recipe_id: String,
    pub task_id: String,
    pub browser_tab_id: String,
    pub bytes: usize,
    pub sha256: String,
    pub steps: usize,
    /// Action Recipe V2 compatibility source. Teach provenance is separate so
    /// existing receipt-bound replay continues to accept the artifact.
    pub source: String,
    pub teach_source: String,
    pub created_at_ms: i64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserTeachApprovalReceipt {
    pub approval_id: String,
    pub draft_id: String,
    pub revision_id: String,
    pub recipe_id: String,
    pub created_at_ms: i64,
    pub status: String,
}

/// Runtime index only. The bundle and every revision are immutable private
/// artifacts; this index identifies the current revision without ever being
/// serialized to an agent or UI response.
#[derive(Clone, Debug)]
pub(crate) struct BrowserTeachDraftIndex {
    pub(crate) bundle: BrowserTeachBundle,
    pub(crate) current_revision: BrowserTeachRevision,
    _bundle_path: String,
    revision_paths: BTreeMap<String, String>,
}

struct VerifiedTeachSource {
    source: BrowserTeachSource,
    artifact: Value,
    goal: String,
}

impl ShellxBrowserRegistry {
    pub fn prepare_teach_draft(
        &self,
        request: BrowserTeachPrepareRequest,
    ) -> Result<BrowserTeachPrepareResponse, String> {
        self.prepare_teach_draft_with_authority(
            request,
            BrowserTaskControlAuthority::Operator,
            None,
        )
    }

    pub fn prepare_teach_draft_for_agent_session(
        &self,
        request: BrowserTeachPrepareRequest,
        caller_session_id: Option<&str>,
    ) -> Result<BrowserTeachPrepareResponse, String> {
        self.prepare_teach_draft_with_authority(
            request,
            BrowserTaskControlAuthority::Agent,
            caller_session_id,
        )
    }

    fn prepare_teach_draft_with_authority(
        &self,
        request: BrowserTeachPrepareRequest,
        authority: BrowserTaskControlAuthority,
        caller_session_id: Option<&str>,
    ) -> Result<BrowserTeachPrepareResponse, String> {
        let attempt_id = safe_identifier(&request.attempt_id, "attemptId", 200)?;
        let mut state = lock_or_recover(&self.state);
        if let Some(existing) = state
            .teach_drafts
            .values()
            .find(|draft| draft.bundle.source.attempt_id == attempt_id)
        {
            ensure_browser_task_control_authority_for_teach(
                &state,
                &existing.bundle.source.task_id,
                authority,
                caller_session_id,
            )?;
            return Ok(prepare_response(existing));
        }

        let verified = verify_teach_source(&state, &attempt_id, authority, caller_session_id)?;
        let bundle_id = deterministic_id(
            "teach-bundle",
            [
                verified.source.attempt_id.as_str(),
                verified.source.task_id.as_str(),
                verified.source.browser_tab_id.as_str(),
                verified.source.sha256.as_str(),
            ],
        );
        let created_at_ms = now_ms();
        let (steps, values, ambiguities, loss) =
            extract_teach_bundle(&bundle_id, &verified.artifact)?;
        let mut bundle = BrowserTeachBundle {
            schema_version: "sx.workflow-teach-bundle.v1".to_string(),
            bundle_id: bundle_id.clone(),
            created_at_ms,
            source: verified.source,
            steps,
            values,
            ambiguities,
            loss,
            bytes: 0,
            sha256: String::new(),
            redaction_receipt: json!({
                "sourceArtifactRedactionVerified": true,
                "rawSecrets": false,
                "cookies": false,
                "headers": false,
                "queryAndFragments": false,
                "pageBodies": false,
                "screenshots": false,
            }),
        };
        set_semantic_identity(&mut bundle)?;
        let encoded_len = serde_json::to_vec(&bundle)
            .map_err(|error| format!("Teach bundle encode failed: {error}"))?
            .len();
        if encoded_len > MAX_TEACH_ARTIFACT_BYTES {
            return Err(format!(
                "Teach bundle exceeds the {MAX_TEACH_ARTIFACT_BYTES} byte budget"
            ));
        }
        let (bundle_path, _, _) = crate::shellx_browser_artifacts::write_browser_json_artifact(
            TEACH_BUNDLE_FOLDER,
            "teach-bundle",
            &bundle.bundle_id,
            bundle.created_at_ms,
            &serde_json::to_value(&bundle)
                .map_err(|error| format!("Teach bundle encode failed: {error}"))?,
        )?;
        let mut revision = initial_revision(&bundle, verified.goal, authority.surface_id());
        set_semantic_identity(&mut revision)?;
        let revision_path = write_teach_revision(&revision)?;
        let draft_id = deterministic_id(
            "teach-draft",
            [bundle.bundle_id.as_str(), bundle.sha256.as_str()],
        );
        let mut revision_paths = BTreeMap::new();
        revision_paths.insert(revision.revision_id.clone(), revision_path);
        let draft = BrowserTeachDraftIndex {
            bundle,
            current_revision: revision,
            _bundle_path: bundle_path,
            revision_paths,
        };
        let summary = draft_summary(&draft, &draft_id);
        let response = prepare_response_with_summary(&draft, summary);
        state.teach_drafts.insert(draft_id.clone(), draft);
        push_receipt(
            &mut state,
            "browserTeachDraftPrepared",
            Some(response.draft.task_id.clone()),
            None,
            format!("Browser Teach draft prepared: {draft_id}"),
            json!({
                "draftId": draft_id,
                "bundleId": response.bundle.bundle_id,
                "bundleSha256": response.bundle.sha256,
                "attemptId": response.bundle.source.attempt_id,
                "browserTabId": response.bundle.source.browser_tab_id,
                "steps": response.bundle.steps.len(),
                "values": response.bundle.values.len(),
                "blockingIssues": response.draft.blocking_issues,
                "source": "shellx-browser-teach",
            }),
        );
        Ok(response)
    }

    pub fn list_teach_drafts_for_agent_session(
        &self,
        task_id: String,
        limit: Option<usize>,
        caller_session_id: Option<&str>,
    ) -> Result<BrowserTeachDraftListResponse, String> {
        self.list_teach_drafts_with_authority(
            task_id,
            limit,
            BrowserTaskControlAuthority::Agent,
            caller_session_id,
        )
    }

    pub fn list_teach_drafts(
        &self,
        task_id: String,
        limit: Option<usize>,
    ) -> Result<BrowserTeachDraftListResponse, String> {
        self.list_teach_drafts_with_authority(
            task_id,
            limit,
            BrowserTaskControlAuthority::Operator,
            None,
        )
    }

    fn list_teach_drafts_with_authority(
        &self,
        task_id: String,
        limit: Option<usize>,
        authority: BrowserTaskControlAuthority,
        caller_session_id: Option<&str>,
    ) -> Result<BrowserTeachDraftListResponse, String> {
        let task_id = safe_identifier(&task_id, "taskId", 200)?;
        let state = lock_or_recover(&self.state);
        ensure_browser_task_control_authority_for_teach(
            &state,
            &task_id,
            authority,
            caller_session_id,
        )?;
        let limit = limit
            .unwrap_or(DEFAULT_DRAFT_LIMIT)
            .clamp(1, MAX_DRAFT_LIMIT);
        let mut drafts = state
            .teach_drafts
            .iter()
            .filter(|(_, draft)| draft.bundle.source.task_id == task_id)
            .map(|(draft_id, draft)| draft_summary(draft, draft_id))
            .collect::<Vec<_>>();
        drafts.sort_by_key(|draft| std::cmp::Reverse(draft.created_at_ms));
        drafts.truncate(limit);
        Ok(BrowserTeachDraftListResponse {
            task_id,
            drafts,
            limit,
        })
    }

    pub fn revise_teach_draft_for_agent_session(
        &self,
        request: BrowserTeachRevisionRequest,
        caller_session_id: Option<&str>,
    ) -> Result<BrowserTeachRevisionResponse, String> {
        self.revise_teach_draft_with_authority(
            request,
            BrowserTaskControlAuthority::Agent,
            caller_session_id,
        )
    }

    pub fn revise_teach_draft(
        &self,
        request: BrowserTeachRevisionRequest,
    ) -> Result<BrowserTeachRevisionResponse, String> {
        self.revise_teach_draft_with_authority(request, BrowserTaskControlAuthority::Operator, None)
    }

    fn revise_teach_draft_with_authority(
        &self,
        request: BrowserTeachRevisionRequest,
        authority: BrowserTaskControlAuthority,
        caller_session_id: Option<&str>,
    ) -> Result<BrowserTeachRevisionResponse, String> {
        let draft_id = safe_identifier(&request.draft_id, "draftId", 220)?;
        let mut state = lock_or_recover(&self.state);
        let draft = state
            .teach_drafts
            .get(&draft_id)
            .cloned()
            .ok_or_else(|| "Teach draft was not found".to_string())?;
        ensure_browser_task_control_authority_for_teach(
            &state,
            &draft.bundle.source.task_id,
            authority,
            caller_session_id,
        )?;
        ensure_current_revision(&draft.current_revision, &request)?;
        let mut revision = revise_from_current(&draft, &request, authority.surface_id())?;
        set_semantic_identity(&mut revision)?;
        let revision_path = write_teach_revision(&revision)?;
        let stored = state
            .teach_drafts
            .get_mut(&draft_id)
            .expect("Teach draft was checked before its immutable revision write");
        stored
            .revision_paths
            .insert(revision.revision_id.clone(), revision_path);
        stored.current_revision = revision.clone();
        let summary = draft_summary(stored, &draft_id);
        push_receipt(
            &mut state,
            "browserTeachDraftRevised",
            Some(summary.task_id.clone()),
            None,
            format!("Browser Teach draft revised: {}", revision.revision_id),
            json!({
                "draftId": draft_id,
                "bundleId": revision.bundle_id,
                "revisionId": revision.revision_id,
                "revision": revision.revision,
                "revisionSha256": revision.sha256,
                "blockingIssues": summary.blocking_issues,
                "source": "shellx-browser-teach",
            }),
        );
        Ok(BrowserTeachRevisionResponse {
            revision,
            draft: summary,
        })
    }

    /// This method is intentionally not exposed through the Debug API or Host
    /// MCP. The Tauri command below is the sole approval entry point.
    pub fn approve_teach_draft_from_operator(
        &self,
        request: BrowserTeachApprovalRequest,
    ) -> Result<BrowserTeachApprovalResponse, String> {
        let draft_id = safe_identifier(&request.draft_id, "draftId", 220)?;
        let mut state = lock_or_recover(&self.state);
        let draft = state
            .teach_drafts
            .get(&draft_id)
            .cloned()
            .ok_or_else(|| "Teach draft was not found".to_string())?;
        if request.revision_id.trim() != draft.current_revision.revision_id
            || !request
                .revision_sha256
                .trim()
                .eq_ignore_ascii_case(&draft.current_revision.sha256)
        {
            return Err(
                "Teach draft approval requires the exact current revision ID and hash".to_string(),
            );
        }
        validate_teach_approval(&state, &draft)?;
        let created_at_ms = now_ms();
        let recipe_id = deterministic_id(
            "browser-recipe",
            [
                draft_id.as_str(),
                draft.current_revision.revision_id.as_str(),
                draft.current_revision.sha256.as_str(),
            ],
        );
        let recipe = teach_recipe_value(&recipe_id, created_at_ms, &draft)?;
        let (recipe_path, bytes, sha256) =
            crate::shellx_browser_artifacts::write_browser_json_artifact(
                RECIPE_ARTIFACT_FOLDER,
                "recipe",
                &recipe_id,
                created_at_ms,
                &recipe,
            )?;
        let profile_id = state
            .tasks
            .iter()
            .find(|task| task.task_id == draft.bundle.source.task_id)
            .map(|task| task.profile_id.clone());
        push_receipt(
            &mut state,
            "browserRecipeExported",
            Some(draft.bundle.source.task_id.clone()),
            profile_id,
            format!("Browser Teach recipe approved: {recipe_id}"),
            json!({
                "recipeId": recipe_id,
                "browserTabId": draft.bundle.source.browser_tab_id,
                "path": recipe_path,
                "bytes": bytes,
                "sha256": sha256,
                "steps": draft.current_revision.steps.len(),
                "source": "shellx-browser-recipes",
                "redactionPolicy": recipe["redactionPolicy"].clone(),
            }),
        );
        let approval_id = deterministic_id(
            "teach-approval",
            [recipe_id.as_str(), draft.current_revision.sha256.as_str()],
        );
        push_receipt(
            &mut state,
            "browserTeachDraftApproved",
            Some(draft.bundle.source.task_id.clone()),
            None,
            format!("Browser Teach draft approved as recipe: {recipe_id}"),
            json!({
                "approvalId": approval_id,
                "draftId": draft_id,
                "revisionId": draft.current_revision.revision_id,
                "recipeId": recipe_id,
                "recipeSha256": sha256,
                "status": "recipeDraftCreated",
                "applied": false,
                "source": "shellx-browser-teach",
            }),
        );
        Ok(BrowserTeachApprovalResponse {
            recipe: BrowserTeachRecipeIdentity {
                recipe_id: recipe_id.clone(),
                task_id: draft.bundle.source.task_id.clone(),
                browser_tab_id: draft.bundle.source.browser_tab_id.clone(),
                bytes,
                sha256,
                steps: draft.current_revision.steps.len(),
                source: "shellx-browser-recorder".to_string(),
                teach_source: "shellx-browser-teach".to_string(),
                created_at_ms,
            },
            approval: BrowserTeachApprovalReceipt {
                approval_id,
                draft_id,
                revision_id: draft.current_revision.revision_id,
                recipe_id,
                created_at_ms,
                status: "recipeDraftCreated".to_string(),
            },
        })
    }

    /// Rehearsal is deliberately operator-only and planner-only. The renderer
    /// supplies receipt identity, never an artifact path, and this method never
    /// invokes the existing replay executor.
    pub fn rehearse_teach_recipe_from_operator(
        &self,
        request: BrowserTeachRehearseRequest,
    ) -> Result<BrowserTeachRehearseResponse, String> {
        let recipe_id = safe_identifier(&request.recipe_id, "recipeId", 240)?;
        let sha256 = safe_sha256(&request.sha256, "recipe digest")?;
        let (task_id, browser_tab_id, profile_id, recipe_path, source_receipt_id) = {
            let state = lock_or_recover(&self.state);
            let teach_approved = state.receipts.iter().rev().any(|receipt| {
                receipt.kind == "browserTeachDraftApproved"
                    && receipt.evidence.get("recipeId").and_then(Value::as_str)
                        == Some(recipe_id.as_str())
                    && receipt
                        .evidence
                        .get("recipeSha256")
                        .and_then(Value::as_str)
                        .is_some_and(|value| value.eq_ignore_ascii_case(&sha256))
                    && receipt.evidence.get("source").and_then(Value::as_str)
                        == Some("shellx-browser-teach")
            });
            if !teach_approved {
                return Err(
                    "Teach rehearsal requires the matching Teach approval receipt".to_string(),
                );
            }
            let receipt = state
                .receipts
                .iter()
                .rev()
                .find(|receipt| {
                    receipt.kind == "browserRecipeExported"
                        && receipt.evidence.get("recipeId").and_then(Value::as_str)
                            == Some(recipe_id.as_str())
                        && receipt
                            .evidence
                            .get("sha256")
                            .and_then(Value::as_str)
                            .is_some_and(|value| value.eq_ignore_ascii_case(&sha256))
                        && receipt.evidence.get("source").and_then(Value::as_str)
                            == Some("shellx-browser-recipes")
                })
                .ok_or_else(|| {
                    "Teach rehearsal requires the exact approved recipe export receipt".to_string()
                })?;
            let recipe_path = receipt
                .evidence
                .get("path")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|path| !path.is_empty())
                .ok_or_else(|| {
                    "Teach rehearsal export receipt has no private recipe identity".to_string()
                })?
                .to_string();
            (
                receipt.task_id.clone(),
                receipt
                    .evidence
                    .get("browserTabId")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                receipt.profile_id.clone(),
                recipe_path,
                receipt.receipt_id.clone(),
            )
        };
        let plan = self.browser_recipe_replay_plan(&BrowserRecipeReplayRequest {
            task_id: task_id.clone(),
            browser_tab_id: browser_tab_id.clone(),
            recipe_path: Some(recipe_path),
            recipe: None,
            dry_run: Some(true),
            reason: Some("Operator Teach rehearsal".to_string()),
        })?;
        let steps_planned = plan.steps_planned;
        let mut prompt_guard_receipt_ids = Vec::new();
        let mut prompt_guard_blocked_steps = 0usize;
        for action in &plan.actions {
            match self.guard_browser_action_against_prompt_injection(&action.request, None)? {
                BrowserPromptGuardOutcome::NotRequired => {}
                BrowserPromptGuardOutcome::Proceed(receipt) => {
                    prompt_guard_receipt_ids.push(receipt.receipt_id);
                }
                BrowserPromptGuardOutcome::Blocked(response) => {
                    prompt_guard_receipt_ids.push(response.receipt.receipt_id);
                    prompt_guard_blocked_steps = prompt_guard_blocked_steps.saturating_add(1);
                }
            }
        }
        let steps_skipped = plan
            .skipped_steps
            .len()
            .saturating_add(prompt_guard_blocked_steps);
        let receipt = {
            let mut state = lock_or_recover(&self.state);
            push_receipt(
                &mut state,
                "browserTeachRecipeRehearsed",
                task_id,
                profile_id,
                format!("Browser Teach recipe rehearsed: {recipe_id}"),
                json!({
                    "recipeId": recipe_id,
                    "sha256": sha256,
                    "sourceReceiptId": source_receipt_id,
                    "dryRun": true,
                    "stepsPlanned": steps_planned,
                    "stepsSkipped": steps_skipped,
                    "stepsApplied": 0,
                    "promptGuardPolicyVersion": crate::shellx_browser_prompt_guard::BROWSER_PROMPT_GUARD_POLICY_VERSION,
                    "promptGuardReceiptIds": prompt_guard_receipt_ids,
                    "promptGuardBlockedSteps": prompt_guard_blocked_steps,
                    "source": "shellx-browser-teach",
                }),
            )
        };
        Ok(BrowserTeachRehearseResponse {
            recipe_id,
            sha256,
            dry_run: true,
            steps_planned,
            steps_skipped,
            steps_applied: 0,
            receipt: BrowserTeachReceiptIdentity {
                receipt_id: receipt.receipt_id,
                kind: receipt.kind,
                created_at_ms: receipt.t,
                sequence: receipt.sequence,
            },
        })
    }
}

#[path = "shellx_browser_teach_revision.rs"]
mod shellx_browser_teach_revision;
#[path = "shellx_browser_teach_source.rs"]
mod shellx_browser_teach_source;
#[cfg(test)]
#[path = "shellx_browser_teach_tests.rs"]
mod shellx_browser_teach_tests;

use shellx_browser_teach_revision::{
    draft_summary, ensure_browser_task_control_authority_for_teach, ensure_current_revision,
    initial_revision, prepare_response, prepare_response_with_summary, revise_from_current,
    set_semantic_identity, teach_recipe_value, validate_teach_approval, write_teach_revision,
};
use shellx_browser_teach_source::{
    deterministic_id, extract_teach_bundle, safe_identifier, safe_sha256, verify_teach_source,
};

#[tauri::command]
pub fn shellx_browser_operator_prepare_teach_draft(
    registry: State<'_, Arc<ShellxBrowserRegistry>>,
    request: BrowserTeachPrepareRequest,
) -> Result<BrowserTeachPrepareResponse, String> {
    registry.prepare_teach_draft(request)
}

#[tauri::command]
pub fn shellx_browser_operator_list_teach_drafts(
    registry: State<'_, Arc<ShellxBrowserRegistry>>,
    #[allow(non_snake_case)] taskId: String,
    limit: Option<usize>,
) -> Result<BrowserTeachDraftListResponse, String> {
    registry.list_teach_drafts(taskId, limit)
}

#[tauri::command]
pub fn shellx_browser_operator_revise_teach_draft(
    registry: State<'_, Arc<ShellxBrowserRegistry>>,
    request: BrowserTeachRevisionRequest,
) -> Result<BrowserTeachRevisionResponse, String> {
    registry.revise_teach_draft(request)
}

#[tauri::command]
pub fn shellx_browser_operator_rehearse_teach_recipe(
    registry: State<'_, Arc<ShellxBrowserRegistry>>,
    request: BrowserTeachRehearseRequest,
) -> Result<BrowserTeachRehearseResponse, String> {
    registry.rehearse_teach_recipe_from_operator(request)
}

#[tauri::command]
pub fn shellx_browser_operator_approve_teach_draft(
    registry: State<'_, Arc<ShellxBrowserRegistry>>,
    request: BrowserTeachApprovalRequest,
) -> Result<BrowserTeachApprovalResponse, String> {
    registry.approve_teach_draft_from_operator(request)
}
