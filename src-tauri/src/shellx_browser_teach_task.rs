//! Operator-reviewed Browser Teach to durable Task handoff.
//!
//! This boundary validates the exact immutable Teach revision, approval,
//! exported recipe, and successful dry-run receipt before persisting the
//! Browser workflow bookmark consumed by Tasks. Private artifact paths remain
//! inside Browser state and are never returned to the renderer.

use std::collections::BTreeSet;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::{State, Url};

use crate::shellx_browser::{
    lock_or_recover, now_ms, push_receipt, BrowserBookmarkAgentWorkflow, BrowserBookmarkKind,
    BrowserBookmarkUpsertRequest, ShellxBrowserRegistry,
};
use crate::shellx_browser_teach::BrowserTeachReceiptIdentity;

const MAX_REQUIRED_BINDINGS: usize = 16;
const MAX_REQUIRED_CAPABILITIES: usize = 24;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserTeachTaskHandoffRequest {
    pub draft_id: String,
    pub revision_id: String,
    pub revision_sha256: String,
    pub recipe_id: String,
    pub recipe_sha256: String,
    pub approval_id: String,
    pub rehearsal_receipt_id: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserTeachTaskHandoffResponse {
    pub request_id: String,
    pub workflow_id: String,
    pub workflow_digest: String,
    pub goal: String,
    pub owner_session_id: String,
    pub browser_task_id: String,
    pub browser_tab_id: String,
    pub required_vault_key_ids: Vec<String>,
    pub required_capabilities: Vec<String>,
    pub receipt: BrowserTeachReceiptIdentity,
}

#[derive(Clone, Debug)]
struct VerifiedTeachTaskHandoff {
    request_id: String,
    workflow_id: String,
    workflow_digest: String,
    recipe_id: String,
    recipe_path: String,
    goal: String,
    owner_session_id: String,
    browser_task_id: String,
    browser_tab_id: String,
    source_attempt_id: String,
    source_url: String,
    source_host: String,
    steps: u32,
    required_vault_key_ids: Vec<String>,
    required_capabilities: Vec<String>,
}

impl ShellxBrowserRegistry {
    /// Operator-only preparation of a Task draft binding. This method does not
    /// create, save, schedule, or run a Task and has no Debug API or Host MCP
    /// route.
    pub fn prepare_teach_task_handoff_from_operator(
        &self,
        request: BrowserTeachTaskHandoffRequest,
    ) -> Result<BrowserTeachTaskHandoffResponse, String> {
        let mut state = lock_or_recover(&self.state);
        let verified = verify_teach_task_handoff(&state, &request)?;
        let bookmark = self.upsert_bookmark_with_locked_state(
            &mut state,
            BrowserBookmarkUpsertRequest {
                bookmark_id: Some(verified.workflow_id.clone()),
                label: verified.goal.clone(),
                kind: Some(BrowserBookmarkKind::Link),
                url: Some(verified.source_url.clone()),
                category: Some("workflow".to_string()),
                toolbar_pinned: Some(false),
                agent_workflow: Some(BrowserBookmarkAgentWorkflow {
                    site_key: Some(verified.source_host.clone()),
                    task_type: Some("workflow".to_string()),
                    target: Some(verified.source_host.clone()),
                    surface: Some("browser".to_string()),
                    permissions_needed: verified.required_capabilities.clone(),
                    recipe_id: Some(verified.recipe_id.clone()),
                    recipe_path: Some(verified.recipe_path.clone()),
                    goal: Some(verified.goal.clone()),
                    steps: Some(verified.steps),
                    source: Some("shellx-browser-teach".to_string()),
                    created_at_ms: Some(now_ms()),
                    health: Some("fresh".to_string()),
                    last_attempt_id: Some(verified.source_attempt_id.clone()),
                    last_replay_status: Some("dry-run".to_string()),
                    last_replay_at_ms: Some(now_ms()),
                    drift_status: Some("fresh".to_string()),
                    ..BrowserBookmarkAgentWorkflow::default()
                }),
                ..BrowserBookmarkUpsertRequest::default()
            },
        )?;
        if bookmark.bookmark.bookmark_id != verified.workflow_id {
            return Err("Teach Task handoff persisted a different workflow identity".to_string());
        }
        let receipt = push_receipt(
            &mut state,
            "browserTeachTaskHandoffPrepared",
            Some(verified.browser_task_id.clone()),
            None,
            "Browser Teach workflow prepared for a Task draft".to_string(),
            json!({
                "requestId": verified.request_id,
                "workflowId": verified.workflow_id,
                "workflowDigest": verified.workflow_digest,
                "recipeId": verified.recipe_id,
                "goal": verified.goal,
                "ownerSessionId": verified.owner_session_id,
                "browserTabId": verified.browser_tab_id,
                "requiredVaultKeyIds": verified.required_vault_key_ids,
                "requiredCapabilities": verified.required_capabilities,
                "source": "shellx-browser-teach",
            }),
        );
        Ok(BrowserTeachTaskHandoffResponse {
            request_id: verified.request_id,
            workflow_id: verified.workflow_id,
            workflow_digest: verified.workflow_digest,
            goal: verified.goal,
            owner_session_id: verified.owner_session_id,
            browser_task_id: verified.browser_task_id,
            browser_tab_id: verified.browser_tab_id,
            required_vault_key_ids: verified.required_vault_key_ids,
            required_capabilities: verified.required_capabilities,
            receipt: BrowserTeachReceiptIdentity {
                receipt_id: receipt.receipt_id,
                kind: receipt.kind,
                created_at_ms: receipt.t,
                sequence: receipt.sequence,
            },
        })
    }
}

fn verify_teach_task_handoff(
    state: &crate::shellx_browser::BrowserState,
    request: &BrowserTeachTaskHandoffRequest,
) -> Result<VerifiedTeachTaskHandoff, String> {
    let draft_id = exact_identifier(&request.draft_id, "draftId", 220)?;
    let revision_id = exact_identifier(&request.revision_id, "revisionId", 220)?;
    let revision_sha256 = exact_sha256(&request.revision_sha256, "revisionSha256")?;
    let recipe_id = exact_identifier(&request.recipe_id, "recipeId", 240)?;
    let recipe_sha256 = exact_sha256(&request.recipe_sha256, "recipeSha256")?;
    let approval_id = exact_identifier(&request.approval_id, "approvalId", 240)?;
    let rehearsal_receipt_id =
        exact_identifier(&request.rehearsal_receipt_id, "rehearsalReceiptId", 240)?;
    let draft = state
        .teach_drafts
        .get(&draft_id)
        .ok_or_else(|| "Teach Task handoff draft was not found".to_string())?;
    if draft.current_revision.revision_id != revision_id
        || !draft
            .current_revision
            .sha256
            .eq_ignore_ascii_case(&revision_sha256)
    {
        return Err("Teach Task handoff requires the exact current revision".to_string());
    }
    let source = &draft.bundle.source;
    let owner_session_id = exact_identifier(&source.owner_session_id, "ownerSessionId", 240)?;
    let source_task_matches = state.tasks.iter().any(|task| {
        task.task_id == source.task_id
            && task.owner_session_id.as_deref() == Some(owner_session_id.as_str())
    });
    if !source_task_matches {
        return Err("Teach Task handoff source task ownership is unavailable".to_string());
    }
    let approved = state.receipts.iter().rev().any(|receipt| {
        receipt.kind == "browserTeachDraftApproved"
            && receipt.task_id.as_deref() == Some(source.task_id.as_str())
            && evidence_eq(receipt.evidence.get("approvalId"), &approval_id)
            && evidence_eq(receipt.evidence.get("draftId"), &draft_id)
            && evidence_eq(receipt.evidence.get("revisionId"), &revision_id)
            && evidence_eq(receipt.evidence.get("recipeId"), &recipe_id)
            && evidence_hash_eq(receipt.evidence.get("recipeSha256"), &recipe_sha256)
            && evidence_eq(receipt.evidence.get("source"), "shellx-browser-teach")
    });
    if !approved {
        return Err("Teach Task handoff requires the exact approval receipt".to_string());
    }
    let recipe_receipt = state
        .receipts
        .iter()
        .rev()
        .find(|receipt| {
            receipt.kind == "browserRecipeExported"
                && receipt.task_id.as_deref() == Some(source.task_id.as_str())
                && evidence_eq(receipt.evidence.get("recipeId"), &recipe_id)
                && evidence_eq(receipt.evidence.get("browserTabId"), &source.browser_tab_id)
                && evidence_hash_eq(receipt.evidence.get("sha256"), &recipe_sha256)
                && evidence_eq(receipt.evidence.get("source"), "shellx-browser-recipes")
        })
        .ok_or_else(|| "Teach Task handoff requires the exact recipe export receipt".to_string())?;
    let recipe_path = recipe_receipt
        .evidence
        .get("path")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Teach Task handoff recipe identity is unavailable".to_string())?
        .to_string();
    let rehearsal = state.receipts.iter().rev().find(|receipt| {
        receipt.receipt_id == rehearsal_receipt_id
            && receipt.kind == "browserTeachRecipeRehearsed"
            && receipt.task_id.as_deref() == Some(source.task_id.as_str())
            && evidence_eq(receipt.evidence.get("recipeId"), &recipe_id)
            && evidence_hash_eq(receipt.evidence.get("sha256"), &recipe_sha256)
            && evidence_eq(
                receipt.evidence.get("sourceReceiptId"),
                &recipe_receipt.receipt_id,
            )
            && receipt.evidence.get("dryRun").and_then(Value::as_bool) == Some(true)
            && receipt.evidence.get("stepsApplied").and_then(Value::as_u64) == Some(0)
            && receipt.evidence.get("stepsSkipped").and_then(Value::as_u64) == Some(0)
            && receipt.evidence.get("stepsPlanned").and_then(Value::as_u64)
                == u64::try_from(draft.current_revision.steps.len()).ok()
            && evidence_eq(receipt.evidence.get("source"), "shellx-browser-teach")
    });
    if rehearsal.is_none() {
        return Err(
            "Teach Task handoff requires the exact successful zero-skip rehearsal receipt"
                .to_string(),
        );
    }
    let source_url = task_handoff_source_url(state, &source.browser_tab_id)?;
    let parsed = Url::parse(&source_url)
        .map_err(|_| "Teach Task handoff source URL is invalid".to_string())?;
    let source_host = parsed
        .host_str()
        .map(str::to_ascii_lowercase)
        .ok_or_else(|| "Teach Task handoff source URL has no host".to_string())?;
    let required_vault_key_ids = bounded_unique(
        draft
            .current_revision
            .required_vault_bindings
            .iter()
            .map(|binding| binding.binding_id.as_deref()),
        MAX_REQUIRED_BINDINGS,
        "Vault binding",
    )?;
    let required_capabilities = bounded_unique(
        draft
            .current_revision
            .required_capabilities
            .iter()
            .map(|value| Some(value.as_str())),
        MAX_REQUIRED_CAPABILITIES,
        "capability",
    )?;
    let workflow_id = deterministic_id(
        "browser-workflow",
        [
            draft_id.as_str(),
            revision_id.as_str(),
            recipe_id.as_str(),
            recipe_sha256.as_str(),
        ],
    );
    let request_id = deterministic_id(
        "teach-task-handoff",
        [
            approval_id.as_str(),
            rehearsal_receipt_id.as_str(),
            workflow_id.as_str(),
        ],
    );
    Ok(VerifiedTeachTaskHandoff {
        request_id,
        workflow_id,
        workflow_digest: format!("sha256:{recipe_sha256}"),
        recipe_id,
        recipe_path,
        goal: draft.current_revision.goal.clone(),
        owner_session_id,
        browser_task_id: source.task_id.clone(),
        browser_tab_id: source.browser_tab_id.clone(),
        source_attempt_id: source.attempt_id.clone(),
        source_url,
        source_host,
        steps: u32::try_from(draft.current_revision.steps.len())
            .map_err(|_| "Teach Task handoff step count is invalid".to_string())?,
        required_vault_key_ids,
        required_capabilities,
    })
}

fn task_handoff_source_url(
    state: &crate::shellx_browser::BrowserState,
    browser_tab_id: &str,
) -> Result<String, String> {
    let tab_url = state
        .tabs
        .iter()
        .find(|tab| tab.browser_tab_id == browser_tab_id)
        .and_then(|tab| tab.url.as_deref());
    let receipt_urls = state.receipts.iter().rev().filter_map(|receipt| {
        (receipt.kind == "browserNavigated"
            && evidence_eq(receipt.evidence.get("browserTabId"), browser_tab_id))
        .then(|| receipt.evidence.get("url").and_then(Value::as_str))
        .flatten()
    });
    tab_url
        .into_iter()
        .chain(receipt_urls)
        .find_map(sanitized_http_url)
        .ok_or_else(|| "Teach Task handoff source HTTP(S) URL is unavailable".to_string())
}

fn sanitized_http_url(candidate: &str) -> Option<String> {
    let mut parsed = Url::parse(candidate.trim()).ok()?;
    if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
        return None;
    }
    let _ = parsed.set_username("");
    let _ = parsed.set_password(None);
    parsed.set_query(None);
    parsed.set_fragment(None);
    Some(parsed.to_string())
}

fn exact_identifier(value: &str, label: &str, max: usize) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty()
        || value.len() > max
        || !value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.' | ':'))
    {
        return Err(format!("Teach Task handoff {label} is invalid"));
    }
    Ok(value.to_string())
}

fn exact_sha256(value: &str, label: &str) -> Result<String, String> {
    let value = value.trim();
    if value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(format!("Teach Task handoff {label} is invalid"));
    }
    Ok(value.to_ascii_lowercase())
}

fn evidence_eq(value: Option<&Value>, expected: &str) -> bool {
    value.and_then(Value::as_str) == Some(expected)
}

fn evidence_hash_eq(value: Option<&Value>, expected: &str) -> bool {
    value
        .and_then(Value::as_str)
        .is_some_and(|value| value.eq_ignore_ascii_case(expected))
}

fn bounded_unique<'a>(
    values: impl Iterator<Item = Option<&'a str>>,
    max: usize,
    label: &str,
) -> Result<Vec<String>, String> {
    let mut unique = BTreeSet::new();
    for value in values {
        let value = value
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| format!("Teach Task handoff {label} is missing"))?;
        if value.len() > 256 || value.chars().any(char::is_control) {
            return Err(format!("Teach Task handoff {label} is invalid"));
        }
        unique.insert(value.to_string());
        if unique.len() > max {
            return Err(format!("Teach Task handoff has too many {label} values"));
        }
    }
    Ok(unique.into_iter().collect())
}

fn deterministic_id<'a>(prefix: &str, values: impl IntoIterator<Item = &'a str>) -> String {
    let mut hasher = Sha256::new();
    for value in values {
        hasher.update(value.as_bytes());
        hasher.update([0]);
    }
    let digest = format!("{:x}", hasher.finalize());
    format!("{prefix}-{}", &digest[..24])
}

#[tauri::command]
pub fn shellx_browser_operator_prepare_teach_task_handoff(
    registry: State<'_, Arc<ShellxBrowserRegistry>>,
    request: BrowserTeachTaskHandoffRequest,
) -> Result<BrowserTeachTaskHandoffResponse, String> {
    registry.prepare_teach_task_handoff_from_operator(request)
}
