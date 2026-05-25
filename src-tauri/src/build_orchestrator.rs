// src-tauri/src/build_orchestrator.rs
//
// Experimental `/build` mode. This intentionally runs beside `/goal`
// instead of replacing it: the old goal path remains stable while this module
// proves host-owned state, receipts, and stricter completion gates.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::json;
use sha2::{Digest, Sha256};
use tokio::sync::RwLock;
use tracing::{info, warn};
use uuid::Uuid;

use crate::build_types::{
    BuildReceipt, BuildReceiptConfidence, BuildReceiptKind, BuildRunState, BuildRunStatus,
};

#[derive(Clone, Debug)]
struct BuildRuntimeState {
    state: BuildRunState,
    ssh_config: Option<crate::acp::SshSpawnConfig>,
}

pub struct BuildOrchestrator {
    store_base: PathBuf,
    states: RwLock<HashMap<String, BuildRuntimeState>>,
}

impl BuildOrchestrator {
    pub fn new(store_base: PathBuf) -> Self {
        Self {
            store_base,
            states: RwLock::new(HashMap::new()),
        }
    }

    pub fn default_store_base() -> PathBuf {
        std::env::var("SHELLX_BUILD_RUNS_DIR")
            .map(PathBuf::from)
            .or_else(|_| {
                std::env::var("HOME")
                    .or_else(|_| std::env::var("USERPROFILE"))
                    .map(|home| PathBuf::from(home).join(".shellx").join("build-runs"))
            })
            .unwrap_or_else(|_| PathBuf::from(".shellx").join("build-runs"))
    }

    pub fn parse_build_command(prompt: &str) -> Option<String> {
        let trimmed = prompt.trim_start();
        if trimmed == "/build" {
            return Some(String::new());
        }
        trimmed
            .strip_prefix("/build ")
            .map(|rest| rest.trim().to_string())
    }

    pub fn plan_kickoff_text(objective: &str) -> String {
        Self::plan_kickoff_text_for_path(objective, "build.md")
    }

    pub fn plan_kickoff_text_for_path(objective: &str, scratchboard_path: &str) -> String {
        format!(
            "OBJECTIVE: {}\n\n\
            STEP 1 - propose a plan only. Write a phased checklist plan to \
            the exact Build Mode scratchboard path below using this format:\n\n\
            Scratchboard path: `{}`\n\n\
            ```md\n\
# Build: <one-line restatement of objective>\n\n\
Status: AWAITING_APPROVAL\n\n\
## Phase 1 - Plan assumptions\n\
- [ ] Confirm scope, risk, and expected files\n\n\
## Phase 2 - Implementation\n\
- [ ] Make the smallest correct change\n\n\
## Phase 3 - Review\n\
- [ ] If this changes code, dispatch a `reviewer` Agent and record findings/fixes\n\n\
## Phase 4 - Verification\n\
- [ ] Dispatch a `verifier` Agent or run real checks and record evidence\n\n\
## Phase 5 - Complete\n\
- [ ] Verify all host gates are satisfied\n\
- [ ] Call `build_complete` MCP tool with summary\n\
```\n\n\
            Plan as a manager. Do not execute any phase yet. Do not call Grok \
            Build bundled `/implement`, `/review`, `/check`, or `/design` from \
            ACP mode; use shellX `Agent`, `Agent_status`, and `Agent_output` \
            directly when execution begins. Prefer `implementer` for scoped \
            code work, `reviewer` for code review, `security-auditor` only for \
            security-sensitive changes, and `verifier` for evidence checks.\n\n\
            Use the shellx-host MCP tool `fs_write` when available. If the \
            path is absolute, write exactly that path and do not substitute a \
            generic `build.md`; concurrent sessions in the same project each \
            have their own scratchboard.\n\n\
            STEP 2 - STOP after writing the scratchboard. Reply briefly that the \
            plan is awaiting approval. shellX will not continue until the user \
            approves the Build Mode plan.",
            objective, scratchboard_path
        )
    }

    pub async fn start_run(
        &self,
        tab_id: &str,
        objective: &str,
        cwd: &Path,
        transport_kind: &str,
    ) -> Result<BuildRunState, String> {
        self.start_run_with_transport_context(tab_id, objective, cwd, transport_kind, None)
            .await
    }

    pub async fn start_run_with_transport_context(
        &self,
        tab_id: &str,
        objective: &str,
        cwd: &Path,
        transport_kind: &str,
        ssh_config: Option<crate::acp::SshSpawnConfig>,
    ) -> Result<BuildRunState, String> {
        let now = now_ms();
        let run_id = format!("build-{}", Uuid::new_v4());
        let scratchboard_path = pick_build_scratchboard_path(cwd, tab_id, &run_id);
        let state = BuildRunState {
            run_id: run_id.clone(),
            tab_id: tab_id.to_string(),
            objective: objective.to_string(),
            cwd: cwd.to_string_lossy().to_string(),
            transport_kind: transport_kind.to_string(),
            scratchboard_path: scratchboard_path.to_string_lossy().to_string(),
            status: BuildRunStatus::AwaitingApproval,
            approved_plan_hash: None,
            current_phase_id: None,
            continuations_total: 0,
            no_progress_cycles: 0,
            created_at_ms: now,
            updated_at_ms: now,
            approved_at_ms: None,
            last_continuation_at_ms: None,
            checkpoint_id: None,
            code_changed: false,
            review_required: false,
            review_satisfied: false,
            verification_required: false,
            verification_satisfied: false,
            open_blocker: None,
            last_receipt_id: None,
        };

        if ssh_config.is_none() && transport_kind != "ssh" {
            let stub = format!(
                "# Build: {objective}\n\nStatus: AWAITING_APPROVAL\n\n_grok is drafting the build plan..._\n"
            );
            if let Err(e) =
                crate::goal_orchestrator::write_scratchboard_text(&scratchboard_path, &stub).await
            {
                warn!(
                    "build_orchestrator: build.md stub write failed for tab='{}' path={} err={}",
                    tab_id,
                    scratchboard_path.display(),
                    e
                );
            }
        }

        crate::build_store::write_state(&self.store_base, &state)?;
        let runtime = BuildRuntimeState {
            state: state.clone(),
            ssh_config,
        };
        self.states
            .write()
            .await
            .insert(tab_id.to_string(), runtime);
        self.append_receipt(BuildReceipt {
            receipt_id: new_receipt_id(),
            run_id,
            tab_id: tab_id.to_string(),
            kind: BuildReceiptKind::RunStarted,
            created_at_ms: now,
            actor: "shellx".into(),
            summary: format!("Build Mode started: {}", objective),
            confidence: BuildReceiptConfidence::TrustedHost,
            data: json!({
                "cwd": cwd.to_string_lossy(),
                "transportKind": transport_kind,
                "scratchboardPath": scratchboard_path.to_string_lossy(),
            }),
        })
        .await?;

        info!(
            "build_orchestrator: tab='{}' run='{}' started scratchboard={}",
            tab_id, state.run_id, state.scratchboard_path
        );
        Ok(self.get_state(tab_id).await.unwrap_or(state))
    }

    pub async fn get_state(&self, tab_id: &str) -> Option<BuildRunState> {
        if let Some(state) = self
            .states
            .read()
            .await
            .get(tab_id)
            .map(|runtime| runtime.state.clone())
        {
            return Some(state);
        }

        match crate::build_store::read_latest_state_for_tab(&self.store_base, tab_id) {
            Ok(state) => state,
            Err(e) => {
                warn!(
                    "build_orchestrator: failed to read persisted build state for tab='{}': {}",
                    tab_id, e
                );
                None
            }
        }
    }

    pub async fn clear_tab(&self, tab_id: &str) {
        self.states.write().await.remove(tab_id);
    }

    pub async fn get_receipts(&self, tab_id: &str) -> Result<Vec<BuildReceipt>, String> {
        let state = self
            .get_state(tab_id)
            .await
            .ok_or_else(|| "no build run for this tab".to_string())?;
        crate::build_store::read_receipts(&self.store_base, tab_id, &state.run_id)
    }

    pub async fn approve_plan(&self, tab_id: &str) -> Result<bool, String> {
        let runtime = {
            let map = self.states.read().await;
            let Some(runtime) = map.get(tab_id) else {
                return Ok(false);
            };
            runtime.clone()
        };
        if runtime.state.status != BuildRunStatus::AwaitingApproval {
            return Ok(false);
        }
        let path = PathBuf::from(&runtime.state.scratchboard_path);
        let text = crate::goal_orchestrator::read_scratchboard_text_for_path(
            &path,
            runtime.ssh_config.as_ref(),
        )
        .await
        .map_err(|e| format!("cannot approve build plan: build.md is not readable: {}", e))?;
        validate_build_approval_ready(&text)?;
        let patched = mark_build_plan_in_progress(&text)?;
        crate::goal_orchestrator::write_scratchboard_text_for_path(
            &path,
            &patched,
            runtime.ssh_config.as_ref(),
        )
        .await
        .map_err(|e| format!("cannot approve build plan: build.md write failed: {}", e))?;

        let hash = plan_hash(&text);
        {
            let mut map = self.states.write().await;
            let Some(runtime) = map.get_mut(tab_id) else {
                return Ok(false);
            };
            runtime.state.status = BuildRunStatus::Active;
            runtime.state.approved_plan_hash = Some(hash.clone());
            runtime.state.approved_at_ms = Some(now_ms());
            runtime.state.updated_at_ms = now_ms();
            crate::build_store::write_state(&self.store_base, &runtime.state)?;
        }

        let state = self
            .get_state(tab_id)
            .await
            .ok_or_else(|| "build run disappeared during approval".to_string())?;
        self.append_receipt(BuildReceipt {
            receipt_id: new_receipt_id(),
            run_id: state.run_id,
            tab_id: tab_id.to_string(),
            kind: BuildReceiptKind::PlanApproved,
            created_at_ms: now_ms(),
            actor: "user".into(),
            summary: "Build plan approved".into(),
            confidence: BuildReceiptConfidence::TrustedHost,
            data: json!({ "approvedPlanHash": hash }),
        })
        .await?;
        Ok(true)
    }

    pub async fn reject_plan(&self, tab_id: &str) -> Result<bool, String> {
        let prior = self.states.write().await.remove(tab_id);
        let Some(runtime) = prior else {
            return Ok(false);
        };
        let mut state = runtime.state.clone();
        state.status = BuildRunStatus::Halted;
        state.updated_at_ms = now_ms();
        crate::build_store::write_state(&self.store_base, &state)?;
        crate::build_store::append_receipt(
            &self.store_base,
            &BuildReceipt {
                receipt_id: new_receipt_id(),
                run_id: state.run_id,
                tab_id: tab_id.to_string(),
                kind: BuildReceiptKind::PlanRejected,
                created_at_ms: now_ms(),
                actor: "user".into(),
                summary: "Build plan rejected".into(),
                confidence: BuildReceiptConfidence::TrustedHost,
                data: json!({}),
            },
        )?;
        Ok(true)
    }

    pub async fn pause(&self, tab_id: &str) -> Result<bool, String> {
        self.set_status(tab_id, BuildRunStatus::Paused).await
    }

    pub async fn resume(&self, tab_id: &str) -> Result<bool, String> {
        let mut map = self.states.write().await;
        let Some(runtime) = map.get_mut(tab_id) else {
            return Ok(false);
        };
        if runtime.state.status != BuildRunStatus::Paused {
            return Ok(false);
        }
        runtime.state.status = BuildRunStatus::Active;
        runtime.state.updated_at_ms = now_ms();
        crate::build_store::write_state(&self.store_base, &runtime.state)?;
        Ok(true)
    }

    pub async fn mark_complete(&self, tab_id: &str, summary: &str) -> Result<bool, String> {
        if self.get_state(tab_id).await.is_none() {
            return Ok(false);
        }
        self.validate_complete(tab_id, summary).await?;
        Ok(true)
    }

    pub async fn halt(&self, tab_id: &str, summary: &str) -> Result<bool, String> {
        let state = {
            let map = self.states.read().await;
            let Some(runtime) = map.get(tab_id) else {
                return Ok(false);
            };
            if matches!(
                runtime.state.status,
                BuildRunStatus::Complete | BuildRunStatus::Halted | BuildRunStatus::TransportFailed
            ) {
                return Ok(false);
            }
            runtime.state.clone()
        };
        self.append_receipt(BuildReceipt {
            receipt_id: new_receipt_id(),
            run_id: state.run_id,
            tab_id: tab_id.to_string(),
            kind: BuildReceiptKind::RunHalted,
            created_at_ms: now_ms(),
            actor: "user".into(),
            summary: summary.to_string(),
            confidence: BuildReceiptConfidence::TrustedHost,
            data: json!({}),
        })
        .await?;
        Ok(true)
    }

    pub async fn mark_transport_failed(&self, tab_id: &str, summary: &str) -> Result<bool, String> {
        let state = {
            let map = self.states.read().await;
            let Some(runtime) = map.get(tab_id) else {
                return Ok(false);
            };
            if matches!(
                runtime.state.status,
                BuildRunStatus::Complete | BuildRunStatus::Halted | BuildRunStatus::TransportFailed
            ) {
                return Ok(false);
            }
            runtime.state.clone()
        };
        self.append_receipt(BuildReceipt {
            receipt_id: new_receipt_id(),
            run_id: state.run_id,
            tab_id: tab_id.to_string(),
            kind: BuildReceiptKind::TransportFailure,
            created_at_ms: now_ms(),
            actor: "shellx".into(),
            summary: summary.to_string(),
            confidence: BuildReceiptConfidence::TrustedHost,
            data: json!({ "stopReason": "error" }),
        })
        .await?;
        Ok(true)
    }

    async fn set_status(&self, tab_id: &str, status: BuildRunStatus) -> Result<bool, String> {
        let mut map = self.states.write().await;
        let Some(runtime) = map.get_mut(tab_id) else {
            return Ok(false);
        };
        runtime.state.status = status;
        runtime.state.updated_at_ms = now_ms();
        crate::build_store::write_state(&self.store_base, &runtime.state)?;
        Ok(true)
    }

    pub async fn append_receipt(&self, mut receipt: BuildReceipt) -> Result<(), String> {
        let scratchboard_path = {
            let map = self.states.read().await;
            map.get(&receipt.tab_id)
                .filter(|runtime| runtime.state.run_id == receipt.run_id)
                .map(|runtime| runtime.state.scratchboard_path.clone())
        };
        if let Some(scratchboard_path) = scratchboard_path {
            let path_for_receipt = receipt
                .data
                .get("path")
                .or_else(|| receipt.data.get("dst"))
                .and_then(|v| v.as_str());
            if let Some(path) = path_for_receipt {
                if build_receipt_path_matches(path, &scratchboard_path) {
                    if receipt.kind == BuildReceiptKind::FileWrite {
                        receipt.kind = BuildReceiptKind::PlanWritten;
                        receipt.summary = format!("Build scratchboard written: {}", path);
                        if let serde_json::Value::Object(ref mut map) = receipt.data {
                            map.insert("scratchboard".into(), serde_json::Value::Bool(true));
                        }
                    } else if matches!(
                        receipt.kind,
                        BuildReceiptKind::FileDelete | BuildReceiptKind::FileCopy
                    ) {
                        return Ok(());
                    }
                }
            }
        }
        crate::build_store::append_receipt(&self.store_base, &receipt)?;
        let mut map = self.states.write().await;
        let Some(runtime) = map.get_mut(&receipt.tab_id) else {
            return Ok(());
        };
        if runtime.state.run_id != receipt.run_id {
            return Ok(());
        }
        runtime.state.last_receipt_id = Some(receipt.receipt_id.clone());
        runtime.state.updated_at_ms = now_ms();
        match receipt.kind {
            BuildReceiptKind::CheckpointCreated => {
                runtime.state.checkpoint_id = receipt
                    .data
                    .get("checkpointId")
                    .and_then(|v| v.as_str())
                    .map(ToOwned::to_owned)
                    .or_else(|| Some(receipt.receipt_id.clone()));
                if checkpoint_receipt_has_changes(&receipt.data) {
                    runtime.state.code_changed = true;
                    runtime.state.review_required = true;
                    runtime.state.verification_required = true;
                }
            }
            BuildReceiptKind::FileWrite
            | BuildReceiptKind::FileDelete
            | BuildReceiptKind::FileCopy => {
                runtime.state.code_changed = true;
                runtime.state.review_required = true;
                runtime.state.verification_required = true;
            }
            BuildReceiptKind::ReviewCompleted
                if receipt.confidence != BuildReceiptConfidence::ModelDeclared =>
            {
                runtime.state.review_satisfied = true;
            }
            BuildReceiptKind::VerificationCompleted
                if receipt.confidence != BuildReceiptConfidence::ModelDeclared =>
            {
                runtime.state.verification_satisfied = true;
            }
            BuildReceiptKind::ReviewCompleted | BuildReceiptKind::VerificationCompleted => {}
            BuildReceiptKind::BlockerOpened => {
                runtime.state.status = BuildRunStatus::Blocked;
                runtime.state.open_blocker = Some(receipt.summary.clone());
            }
            BuildReceiptKind::BlockerResolved => {
                runtime.state.open_blocker = None;
                if runtime.state.status == BuildRunStatus::Blocked {
                    runtime.state.status = BuildRunStatus::Active;
                }
            }
            BuildReceiptKind::TransportFailure => {
                runtime.state.status = BuildRunStatus::TransportFailed;
            }
            BuildReceiptKind::RunHalted => {
                runtime.state.status = BuildRunStatus::Halted;
            }
            BuildReceiptKind::CompletionAccepted => {
                runtime.state.status = BuildRunStatus::Complete;
            }
            _ => {}
        }
        crate::build_store::write_state(&self.store_base, &runtime.state)
    }

    pub async fn consider_continue(&self, tab_id: &str, stop_reason: &str) -> Option<String> {
        if !matches!(stop_reason, "end_turn" | "max_tokens") {
            return None;
        }
        let runtime = {
            let map = self.states.read().await;
            map.get(tab_id)?.clone()
        };
        if runtime.state.status != BuildRunStatus::Active {
            return None;
        }
        if runtime.state.open_blocker.is_some() {
            return None;
        }
        let receipts =
            crate::build_store::read_receipts(&self.store_base, tab_id, &runtime.state.run_id)
                .unwrap_or_default();
        let last_receipt = receipts
            .last()
            .map(|r| format!("{:?}: {}", r.kind, r.summary))
            .unwrap_or_else(|| "none".to_string());

        let text = crate::goal_orchestrator::read_scratchboard_text_for_path(
            Path::new(&runtime.state.scratchboard_path),
            runtime.ssh_config.as_ref(),
        )
        .await
        .unwrap_or_default();
        let board = crate::goal_orchestrator::parse_board(&text);
        if board.top_status.as_deref() == Some("GOAL_COMPLETE")
            && crate::goal_orchestrator::validate_board_text(&text).is_ok()
        {
            match self
                .validate_complete(tab_id, "build.md status GOAL_COMPLETE observed")
                .await
            {
                Ok(()) => return None,
                Err(reason) => {
                    let mut map = self.states.write().await;
                    let runtime = map.get_mut(tab_id)?;
                    runtime.state.continuations_total =
                        runtime.state.continuations_total.saturating_add(1);
                    runtime.state.last_continuation_at_ms = Some(now_ms());
                    runtime.state.updated_at_ms = now_ms();
                    let injection_count = runtime.state.continuations_total;
                    let _ = crate::build_store::write_state(&self.store_base, &runtime.state);
                    return Some(format!(
                        "<build_completion_rejected>\n{}\n\nThe scratchboard claims GOAL_COMPLETE, but shellX has not accepted the host gates. Reopen the relevant phase, record the missing checkpoint/review/verification receipts, then call `build_complete` again.\nContinuation #{}.\n</build_completion_rejected>",
                        reason, injection_count
                    ));
                }
            }
        }
        let completion_nudge = board.unchecked_count == 0 && board.phase_count > 0;

        let mut map = self.states.write().await;
        let runtime = map.get_mut(tab_id)?;
        runtime.state.continuations_total = runtime.state.continuations_total.saturating_add(1);
        runtime.state.last_continuation_at_ms = Some(now_ms());
        runtime.state.updated_at_ms = now_ms();
        let injection_count = runtime.state.continuations_total;
        let _ = crate::build_store::write_state(&self.store_base, &runtime.state);
        Some(if completion_nudge {
            format!(
                "<build_completion_check>\nThe Build Mode scratchboard appears complete, but shellX has not accepted completion for objective `{}`.\nCall `build_complete` now if checkpoint, review, and verification receipt gates are satisfied. If a gate is missing, reopen the relevant phase and satisfy it.\nContinuation #{}.\n</build_completion_check>",
                runtime.state.objective,
                injection_count
            )
        } else {
            format!(
                "<build_context>\nObjective: {}\nStatus: {:?}\nApproved plan hash: {}\nCurrent phase: {}\nContinuations: {}\nRequired gates: checkpoint={}, review={}, verification={}\nSatisfied gates: checkpoint={}, review={}, verification={}\nLast receipt: {}\nOpen blocker: {}\nScratchboard: {}\n\nAction now: inspect the next unchecked sub-stage in build.md and manage it to completion. Prefer an `implementer` Agent for non-trivial code, a `reviewer` Agent for code review, and a `verifier` Agent for evidence checks. Record receipts. Do not call `build_complete` until every required host gate is satisfied.\n</build_context>",
                runtime.state.objective,
                runtime.state.status,
                runtime
                    .state
                    .approved_plan_hash
                    .as_deref()
                    .unwrap_or("none"),
                runtime
                    .state
                    .current_phase_id
                    .as_deref()
                    .unwrap_or("next unchecked"),
                injection_count,
                runtime.state.code_changed,
                runtime.state.review_required,
                runtime.state.verification_required,
                runtime.state.checkpoint_id.is_some(),
                runtime.state.review_satisfied,
                runtime.state.verification_satisfied,
                last_receipt,
                runtime.state.open_blocker.as_deref().unwrap_or("none"),
                runtime.state.scratchboard_path,
            )
        })
    }

    pub async fn validate_complete(&self, tab_id: &str, summary: &str) -> Result<(), String> {
        let mut runtime = {
            let map = self.states.read().await;
            map.get(tab_id)
                .cloned()
                .ok_or_else(|| "no active build run for this tab".to_string())?
        };
        if runtime.state.status != BuildRunStatus::Active {
            return Err(format!(
                "build_complete rejected: build status is {:?}, not Active",
                runtime.state.status
            ));
        }
        if let Some(blocker) = &runtime.state.open_blocker {
            return Err(format!(
                "build_complete rejected: blocker is still open: {}",
                blocker
            ));
        }
        let text = crate::goal_orchestrator::read_scratchboard_text_for_path(
            Path::new(&runtime.state.scratchboard_path),
            runtime.ssh_config.as_ref(),
        )
        .await
        .map_err(|e| format!("build_complete rejected: build.md is not readable: {}", e))?;
        crate::goal_orchestrator::validate_board_text(&text)
            .map_err(|e| e.replace("goal_complete refused", "build_complete refused"))?;

        let receipts =
            crate::build_store::read_receipts(&self.store_base, tab_id, &runtime.state.run_id)?;
        if !runtime.state.code_changed
            && runtime.ssh_config.is_none()
            && local_git_worktree_has_code_changes(
                Path::new(&runtime.state.cwd),
                Path::new(&runtime.state.scratchboard_path),
            )
        {
            let mut map = self.states.write().await;
            if let Some(current) = map.get_mut(tab_id) {
                if current.state.run_id == runtime.state.run_id {
                    current.state.code_changed = true;
                    current.state.review_required = true;
                    current.state.verification_required = true;
                    current.state.updated_at_ms = now_ms();
                    crate::build_store::write_state(&self.store_base, &current.state)?;
                    runtime = current.clone();
                    info!(
                        "build_orchestrator: detected dirty local git worktree for tab='{}' before completion",
                        tab_id
                    );
                }
            }
        }
        if runtime.state.code_changed && runtime.state.checkpoint_id.is_none() {
            return Err(
                "build_complete rejected: code changed but no checkpoint receipt exists".into(),
            );
        }
        if runtime.state.review_required
            && !has_hard_receipt(&receipts, BuildReceiptKind::ReviewCompleted)
        {
            return Err(
                "build_complete rejected: code-changing build requires a trusted reviewer receipt"
                    .into(),
            );
        }
        if runtime.state.verification_required
            && !has_hard_receipt(&receipts, BuildReceiptKind::VerificationCompleted)
        {
            return Err(
                "build_complete rejected: build requires a trusted verification receipt".into(),
            );
        }

        self.append_receipt(BuildReceipt {
            receipt_id: new_receipt_id(),
            run_id: runtime.state.run_id,
            tab_id: tab_id.to_string(),
            kind: BuildReceiptKind::CompletionAccepted,
            created_at_ms: now_ms(),
            actor: "shellx".into(),
            summary: summary.to_string(),
            confidence: BuildReceiptConfidence::TrustedHost,
            data: json!({}),
        })
        .await
    }
}

fn pick_build_scratchboard_path(cwd: &Path, tab_id: &str, run_id: &str) -> PathBuf {
    let cwd_str = cwd.to_string_lossy();
    let tab = crate::session_git::sanitize_worktree_slug(tab_id);
    let tab = if tab.is_empty() {
        "tab".to_string()
    } else {
        tab
    };
    let run = run_id
        .trim_start_matches("build-")
        .chars()
        .take(12)
        .collect::<String>();
    let filename = format!("build.{}.{}.md", tab, run);
    if cwd_str.starts_with('/') {
        PathBuf::from(format!("{}/{}", cwd_str.trim_end_matches('/'), filename))
    } else {
        cwd.join(filename)
    }
}

fn build_receipt_path_matches(a: &str, b: &str) -> bool {
    let normalize = |s: &str| {
        s.replace('\\', "/")
            .trim_end_matches('/')
            .to_ascii_lowercase()
    };
    normalize(a) == normalize(b)
}

fn validate_build_approval_ready(text: &str) -> Result<(), String> {
    if text.contains("_grok is drafting the build plan") {
        return Err(
            "plan is still the shellX drafting stub; wait for Grok to write build.md".into(),
        );
    }
    let fp = crate::goal_orchestrator::parse_board(text);
    if fp.phase_count == 0 {
        return Err("plan is not ready: build.md has no `## Phase` headings yet".into());
    }
    if fp.unchecked_count == 0 {
        return Err("plan is not ready: build.md has no unchecked `- [ ]` phase steps".into());
    }
    match fp.top_status.as_deref() {
        Some("AWAITING_APPROVAL") => Ok(()),
        Some(other) => Err(format!(
            "plan is not awaiting approval: top-level Status is `{}`",
            other
        )),
        None => Err("plan is not ready: top-level `Status:` line is missing".into()),
    }
}

fn mark_build_plan_in_progress(text: &str) -> Result<String, String> {
    let mut out = String::with_capacity(text.len());
    let mut saw_phase = false;
    let mut replaced = false;
    for segment in text.split_inclusive('\n') {
        let has_lf = segment.ends_with('\n');
        let line_without_lf = if has_lf {
            &segment[..segment.len() - 1]
        } else {
            segment
        };
        let (line, newline) = if has_lf && line_without_lf.ends_with('\r') {
            (&line_without_lf[..line_without_lf.len() - 1], "\r\n")
        } else if has_lf {
            (line_without_lf, "\n")
        } else {
            (line_without_lf, "")
        };
        let trimmed = line.trim_start();
        if trimmed.starts_with("## Phase") {
            saw_phase = true;
        }
        if !saw_phase && !replaced {
            let lower = trimmed.to_ascii_lowercase();
            if let Some(rest) = lower.strip_prefix("status:") {
                let token = rest.split_whitespace().next().unwrap_or("");
                if token != "awaiting_approval" {
                    return Err(format!(
                        "approved build.md has top-level Status `{}` instead of AWAITING_APPROVAL",
                        token.to_ascii_uppercase()
                    ));
                }
                let indent_len = line.len() - trimmed.len();
                out.push_str(&line[..indent_len]);
                out.push_str("Status: IN_PROGRESS");
                out.push_str(newline);
                replaced = true;
                continue;
            }
        }
        out.push_str(segment);
    }
    if replaced {
        Ok(out)
    } else {
        Err("approved build.md is missing top-level `Status: AWAITING_APPROVAL`".into())
    }
}

fn plan_hash(text: &str) -> String {
    let digest = Sha256::digest(text.as_bytes());
    format!("{:x}", digest)
}

fn has_hard_receipt(receipts: &[BuildReceipt], kind: BuildReceiptKind) -> bool {
    receipts.iter().any(|receipt| {
        receipt.kind == kind && receipt.confidence != BuildReceiptConfidence::ModelDeclared
    })
}

fn local_git_worktree_has_code_changes(cwd: &Path, scratchboard_path: &Path) -> bool {
    if !cwd.exists() {
        return false;
    }
    if !git_command_success(cwd, &["rev-parse", "--is-inside-work-tree"]) {
        return false;
    }
    for args in [
        &["diff", "--name-only", "--diff-filter=ACDMRTUXB"][..],
        &["diff", "--cached", "--name-only", "--diff-filter=ACDMRTUXB"][..],
        &["ls-files", "--others", "--exclude-standard"][..],
    ] {
        for rel in git_output_lines(cwd, args) {
            if !is_build_internal_git_path(cwd, &rel, scratchboard_path) {
                return true;
            }
        }
    }
    false
}

fn git_command_success(cwd: &Path, args: &[&str]) -> bool {
    std::process::Command::new("git")
        .args(args)
        .current_dir(cwd)
        .output()
        .map(|out| out.status.success())
        .unwrap_or(false)
}

fn git_output_lines(cwd: &Path, args: &[&str]) -> Vec<String> {
    std::process::Command::new("git")
        .args(args)
        .current_dir(cwd)
        .output()
        .ok()
        .filter(|out| out.status.success())
        .map(|out| {
            String::from_utf8_lossy(&out.stdout)
                .lines()
                .map(str::trim)
                .filter(|line| !line.is_empty())
                .map(ToOwned::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

fn is_build_internal_git_path(cwd: &Path, rel: &str, scratchboard_path: &Path) -> bool {
    let normalized = rel.replace('\\', "/");
    if normalized == ".grok" || normalized.starts_with(".grok/") {
        return true;
    }
    let absolute = cwd.join(rel);
    build_receipt_path_matches(
        absolute.to_string_lossy().as_ref(),
        scratchboard_path.to_string_lossy().as_ref(),
    )
}

fn checkpoint_receipt_has_changes(data: &serde_json::Value) -> bool {
    ["staged", "unstaged", "untracked", "conflicts"]
        .iter()
        .filter_map(|key| data.get(*key).and_then(|v| v.as_u64()))
        .any(|n| n > 0)
}

fn new_receipt_id() -> String {
    format!("br-{}", Uuid::new_v4())
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::build_types::{BuildReceiptConfidence, BuildReceiptKind};

    fn temp_base(name: &str) -> PathBuf {
        let mut path = std::env::temp_dir();
        path.push(format!("shellx-build-orch-{}-{}", name, std::process::id()));
        let _ = std::fs::remove_dir_all(&path);
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    fn complete_board() -> String {
        r#"# Build: test

Status: IN_PROGRESS

## Phase 1 - Plan
Status: DONE
- [x] planned

## Phase 2 - Complete
Status: DONE
- [x] Call build_complete
"#
        .to_string()
    }

    fn goal_complete_board() -> String {
        complete_board().replace("Status: IN_PROGRESS", "Status: GOAL_COMPLETE")
    }

    fn receipt(
        state: &BuildRunState,
        kind: BuildReceiptKind,
        confidence: BuildReceiptConfidence,
    ) -> BuildReceipt {
        BuildReceipt {
            receipt_id: new_receipt_id(),
            run_id: state.run_id.clone(),
            tab_id: state.tab_id.clone(),
            kind,
            created_at_ms: now_ms(),
            actor: "test".into(),
            summary: "ok".into(),
            confidence,
            data: json!({ "checkpointId": "cp-1" }),
        }
    }

    fn run_git(cwd: &Path, args: &[&str]) {
        let output = std::process::Command::new("git")
            .args(args)
            .current_dir(cwd)
            .output()
            .unwrap_or_else(|e| panic!("git {:?} spawn failed: {}", args, e));
        assert!(
            output.status.success(),
            "git {:?} failed\nstdout={}\nstderr={}",
            args,
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[test]
    fn parse_build_command_extracts_objective() {
        assert_eq!(
            BuildOrchestrator::parse_build_command("/build ship it").as_deref(),
            Some("ship it")
        );
        assert_eq!(
            BuildOrchestrator::parse_build_command("   /build").as_deref(),
            Some("")
        );
        assert!(BuildOrchestrator::parse_build_command("/goal ship it").is_none());
    }

    #[test]
    fn plan_kickoff_text_is_plan_only() {
        let text = BuildOrchestrator::plan_kickoff_text("change code");
        assert!(text.contains("Scratchboard path:"));
        assert!(text.contains("Status: AWAITING_APPROVAL"));
        assert!(text.contains("Do not execute any phase yet"));
        assert!(text.contains("build_complete"));
        assert!(text.contains("Do not call Grok"));
    }

    #[test]
    fn scratchboard_path_is_tab_and_run_scoped() {
        let cwd = PathBuf::from("/tmp/project");
        let a = pick_build_scratchboard_path(&cwd, "tab-a", "build-111111111111-aaaa");
        let b = pick_build_scratchboard_path(&cwd, "tab-b", "build-222222222222-bbbb");
        assert_ne!(a, b);
        assert!(a.to_string_lossy().contains("tab-a"));
        assert!(b.to_string_lossy().contains("tab-b"));
    }

    #[tokio::test]
    async fn approve_build_plan_hashes_snapshot() {
        let cwd = temp_base("approve-cwd");
        let store = temp_base("approve-store");
        let orch = BuildOrchestrator::new(store.clone());
        let state = orch.start_run("tab1", "test", &cwd, "local").await.unwrap();
        let plan = r#"# Build: test

Status: AWAITING_APPROVAL

## Phase 1 - Plan
- [ ] planned
"#;
        std::fs::write(&state.scratchboard_path, plan).unwrap();
        assert!(orch.approve_plan("tab1").await.unwrap());
        let approved = orch.get_state("tab1").await.unwrap();
        assert_eq!(approved.status, BuildRunStatus::Active);
        assert_eq!(approved.approved_plan_hash, Some(plan_hash(plan)));
        let patched = std::fs::read_to_string(&state.scratchboard_path).unwrap();
        assert!(patched.contains("Status: IN_PROGRESS"));
        let _ = std::fs::remove_dir_all(cwd);
        let _ = std::fs::remove_dir_all(store);
    }

    #[tokio::test]
    async fn build_complete_rejects_missing_review_gate() {
        let cwd = temp_base("reject-cwd");
        let store = temp_base("reject-store");
        let orch = BuildOrchestrator::new(store.clone());
        let state = orch.start_run("tab1", "test", &cwd, "local").await.unwrap();
        std::fs::write(&state.scratchboard_path, complete_board()).unwrap();
        {
            let mut map = orch.states.write().await;
            let runtime = map.get_mut("tab1").unwrap();
            runtime.state.status = BuildRunStatus::Active;
            runtime.state.code_changed = true;
            runtime.state.review_required = true;
            runtime.state.verification_required = false;
            runtime.state.checkpoint_id = Some("cp-1".into());
        }
        let err = orch.validate_complete("tab1", "done").await.unwrap_err();
        assert!(err.contains("reviewer receipt"), "got: {}", err);
        let _ = std::fs::remove_dir_all(cwd);
        let _ = std::fs::remove_dir_all(store);
        let _ = state;
    }

    #[tokio::test]
    async fn build_complete_detects_dirty_git_worktree_without_file_receipt() {
        let cwd = temp_base("dirty-git-cwd");
        let store = temp_base("dirty-git-store");
        run_git(&cwd, &["init"]);
        run_git(
            &cwd,
            &["config", "user.email", "shellx-test@example.invalid"],
        );
        run_git(&cwd, &["config", "user.name", "shellX Test"]);
        std::fs::write(cwd.join("message.txt"), "before\n").unwrap();
        run_git(&cwd, &["add", "message.txt"]);
        run_git(&cwd, &["commit", "-m", "initial"]);
        std::fs::write(cwd.join("message.txt"), "after\n").unwrap();

        let orch = BuildOrchestrator::new(store.clone());
        let state = orch.start_run("tab1", "test", &cwd, "local").await.unwrap();
        std::fs::write(&state.scratchboard_path, complete_board()).unwrap();
        {
            let mut map = orch.states.write().await;
            map.get_mut("tab1").unwrap().state.status = BuildRunStatus::Active;
        }

        let err = orch.validate_complete("tab1", "done").await.unwrap_err();
        assert!(err.contains("checkpoint receipt"), "got: {}", err);
        let updated = orch.get_state("tab1").await.unwrap();
        assert!(
            updated.code_changed,
            "dirty git worktree should mark code_changed"
        );
        assert!(
            updated.review_required,
            "dirty git worktree should require review"
        );
        assert!(
            updated.verification_required,
            "dirty git worktree should require verification"
        );

        let _ = std::fs::remove_dir_all(cwd);
        let _ = std::fs::remove_dir_all(store);
    }

    #[tokio::test]
    async fn manual_mark_complete_uses_completion_gates() {
        let cwd = temp_base("manual-complete-cwd");
        let store = temp_base("manual-complete-store");
        let orch = BuildOrchestrator::new(store.clone());
        let state = orch.start_run("tab1", "test", &cwd, "local").await.unwrap();
        std::fs::write(&state.scratchboard_path, complete_board()).unwrap();
        {
            let mut map = orch.states.write().await;
            let runtime = map.get_mut("tab1").unwrap();
            runtime.state.status = BuildRunStatus::Active;
            runtime.state.code_changed = true;
            runtime.state.review_required = true;
            runtime.state.verification_required = true;
            runtime.state.checkpoint_id = Some("cp-1".into());
        }

        let err = orch.mark_complete("tab1", "done").await.unwrap_err();
        assert!(err.contains("reviewer receipt"), "got: {}", err);
        assert_eq!(
            orch.get_state("tab1").await.unwrap().status,
            BuildRunStatus::Active
        );
        let _ = std::fs::remove_dir_all(cwd);
        let _ = std::fs::remove_dir_all(store);
    }

    #[tokio::test]
    async fn build_complete_accepts_required_receipts() {
        let cwd = temp_base("accept-cwd");
        let store = temp_base("accept-store");
        let orch = BuildOrchestrator::new(store.clone());
        let state = orch.start_run("tab1", "test", &cwd, "local").await.unwrap();
        std::fs::write(&state.scratchboard_path, complete_board()).unwrap();
        {
            let mut map = orch.states.write().await;
            let runtime = map.get_mut("tab1").unwrap();
            runtime.state.status = BuildRunStatus::Active;
            runtime.state.code_changed = true;
            runtime.state.review_required = true;
            runtime.state.verification_required = true;
            runtime.state.checkpoint_id = Some("cp-1".into());
        }
        orch.append_receipt(receipt(
            &state,
            BuildReceiptKind::ReviewCompleted,
            BuildReceiptConfidence::TrustedHost,
        ))
        .await
        .unwrap();
        orch.append_receipt(receipt(
            &state,
            BuildReceiptKind::VerificationCompleted,
            BuildReceiptConfidence::ObservedAcp,
        ))
        .await
        .unwrap();
        orch.validate_complete("tab1", "done").await.unwrap();
        assert_eq!(
            orch.get_state("tab1").await.unwrap().status,
            BuildRunStatus::Complete
        );
        let _ = std::fs::remove_dir_all(cwd);
        let _ = std::fs::remove_dir_all(store);
    }

    #[tokio::test]
    async fn halt_marks_run_halted_without_accepting_completion() {
        let cwd = temp_base("halt-cwd");
        let store = temp_base("halt-store");
        let orch = BuildOrchestrator::new(store.clone());
        let state = orch.start_run("tab1", "test", &cwd, "local").await.unwrap();
        {
            let mut map = orch.states.write().await;
            map.get_mut("tab1").unwrap().state.status = BuildRunStatus::Active;
        }

        assert!(orch.halt("tab1", "Stopped from cockpit").await.unwrap());
        let halted = orch.get_state("tab1").await.unwrap();
        assert_eq!(halted.status, BuildRunStatus::Halted);
        let receipts = orch.get_receipts("tab1").await.unwrap();
        assert!(receipts
            .iter()
            .any(|r| r.kind == BuildReceiptKind::RunHalted));
        assert!(!receipts
            .iter()
            .any(|r| r.kind == BuildReceiptKind::CompletionAccepted));
        let _ = std::fs::remove_dir_all(cwd);
        let _ = std::fs::remove_dir_all(store);
        let _ = state;
    }

    #[tokio::test]
    async fn checkpoint_with_diff_marks_code_changed_and_requires_gates() {
        let cwd = temp_base("checkpoint-diff-cwd");
        let store = temp_base("checkpoint-diff-store");
        let orch = BuildOrchestrator::new(store.clone());
        let state = orch.start_run("tab1", "test", &cwd, "wsl").await.unwrap();
        {
            let mut map = orch.states.write().await;
            map.get_mut("tab1").unwrap().state.status = BuildRunStatus::Active;
        }

        let mut checkpoint = receipt(
            &state,
            BuildReceiptKind::CheckpointCreated,
            BuildReceiptConfidence::TrustedHost,
        );
        checkpoint.data = json!({
            "checkpointId": "cp-1",
            "staged": 0,
            "unstaged": 1,
            "untracked": 0,
        });
        orch.append_receipt(checkpoint).await.unwrap();

        let updated = orch.get_state("tab1").await.unwrap();
        assert!(updated.code_changed);
        assert!(updated.review_required);
        assert!(updated.verification_required);
        assert_eq!(updated.checkpoint_id.as_deref(), Some("cp-1"));
        let _ = std::fs::remove_dir_all(cwd);
        let _ = std::fs::remove_dir_all(store);
    }

    #[tokio::test]
    async fn transport_failure_marks_active_run_failed() {
        let cwd = temp_base("transport-failure-cwd");
        let store = temp_base("transport-failure-store");
        let orch = BuildOrchestrator::new(store.clone());
        orch.start_run("tab1", "test", &cwd, "ssh").await.unwrap();
        {
            let mut map = orch.states.write().await;
            map.get_mut("tab1").unwrap().state.status = BuildRunStatus::Active;
        }

        assert!(orch
            .mark_transport_failed("tab1", "responses API error: 403")
            .await
            .unwrap());
        let failed = orch.get_state("tab1").await.unwrap();
        assert_eq!(failed.status, BuildRunStatus::TransportFailed);
        let receipts = orch.get_receipts("tab1").await.unwrap();
        assert!(receipts.iter().any(|r| {
            r.kind == BuildReceiptKind::TransportFailure
                && r.summary.contains("responses API error")
        }));
        let _ = std::fs::remove_dir_all(cwd);
        let _ = std::fs::remove_dir_all(store);
    }

    #[tokio::test]
    async fn reads_persisted_state_and_receipts_when_run_is_not_active() {
        let cwd = temp_base("persisted-read-cwd");
        let store = temp_base("persisted-read-store");
        let writer = BuildOrchestrator::new(store.clone());
        let state = writer
            .start_run("tab1", "test", &cwd, "local")
            .await
            .unwrap();
        writer.clear_tab("tab1").await;

        let reader = BuildOrchestrator::new(store.clone());
        let loaded = reader.get_state("tab1").await.unwrap();
        assert_eq!(loaded.run_id, state.run_id);

        let receipts = reader.get_receipts("tab1").await.unwrap();
        assert!(receipts
            .iter()
            .any(|r| r.kind == BuildReceiptKind::RunStarted));

        let _ = std::fs::remove_dir_all(cwd);
        let _ = std::fs::remove_dir_all(store);
    }

    #[tokio::test]
    async fn build_continuation_respects_hard_gates() {
        let cwd = temp_base("continue-cwd");
        let store = temp_base("continue-store");
        let orch = BuildOrchestrator::new(store.clone());
        orch.start_run("tab1", "test", &cwd, "local").await.unwrap();
        assert!(orch.consider_continue("tab1", "end_turn").await.is_none());
        {
            let mut map = orch.states.write().await;
            map.get_mut("tab1").unwrap().state.status = BuildRunStatus::Active;
        }
        assert!(orch.consider_continue("tab1", "cancelled").await.is_none());
        assert!(orch.consider_continue("tab1", "end_turn").await.is_some());
        orch.pause("tab1").await.unwrap();
        assert!(orch.consider_continue("tab1", "end_turn").await.is_none());
        let _ = std::fs::remove_dir_all(cwd);
        let _ = std::fs::remove_dir_all(store);
    }

    #[tokio::test]
    async fn build_continuation_rejects_goal_complete_without_gates() {
        let cwd = temp_base("complete-nudge-cwd");
        let store = temp_base("complete-nudge-store");
        let orch = BuildOrchestrator::new(store.clone());
        let state = orch.start_run("tab1", "test", &cwd, "local").await.unwrap();
        std::fs::write(&state.scratchboard_path, goal_complete_board()).unwrap();
        {
            let mut map = orch.states.write().await;
            let runtime = map.get_mut("tab1").unwrap();
            runtime.state.status = BuildRunStatus::Active;
            runtime.state.code_changed = true;
            runtime.state.review_required = true;
            runtime.state.verification_required = true;
        }

        let prompt = orch.consider_continue("tab1", "end_turn").await.unwrap();
        assert!(
            prompt.contains("build_complete rejected"),
            "got: {}",
            prompt
        );
        assert!(
            prompt.contains("checkpoint receipt") || prompt.contains("reviewer receipt"),
            "got: {}",
            prompt
        );
        assert_eq!(
            orch.get_state("tab1").await.unwrap().status,
            BuildRunStatus::Active
        );
        let _ = std::fs::remove_dir_all(cwd);
        let _ = std::fs::remove_dir_all(store);
    }
}
