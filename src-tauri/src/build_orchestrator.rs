// src-tauri/src/build_orchestrator.rs
//
// Build Mode. `/build` is the public long-horizon command; the older goal
// orchestrator remains as legacy compatibility plumbing while this module owns
// the host state, receipts, and stricter completion gates.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::json;
use sha2::{Digest, Sha256};
use tokio::sync::RwLock;
use tracing::{info, warn};
use uuid::Uuid;

use crate::build_types::{
    BuildBlockerRecheckResult, BuildOperatorNote, BuildReceipt, BuildReceiptConfidence,
    BuildReceiptKind, BuildRunState, BuildRunStatus,
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
        if trimmed == "/goal" {
            return Some(String::new());
        }
        trimmed
            .strip_prefix("/build ")
            .or_else(|| trimmed.strip_prefix("/goal "))
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
Status: TODO\n\
- [ ] Confirm scope, risk, and expected files\n\n\
- [ ] Establish git baseline: run `git rev-parse --show-toplevel` and `git status --short`; if no repository exists, initialize git with `git init` in the actual project root before implementation, then keep using `git status --short`, `git diff --stat`, and checkpoints as work progresses\n\n\
## Phase 2 - Implementation\n\
Status: TODO\n\
- [ ] Make the smallest correct change with an `implementer` Agent using `wait=true`\n\n\
## Phase 3 - Review\n\
Status: TODO\n\
- [ ] If this changes code, dispatch a `reviewer` Agent using `wait=true` and record findings/fixes\n\
- [ ] Reviewer must run an AI slop / wiring audit: unwired UI controls, placeholder/mock code, fake success paths, missing frontend/backend bridges, config/schema drift, and release-debug leaks\n\n\
## Phase 4 - Verification\n\
Status: TODO\n\
- [ ] Dispatch a `test-writer` Agent using `wait=true` for meaningful test coverage when behavior changed\n\
- [ ] For UI, web app, website, HTML, Vite, Next, or Expo work, call `preview_start` to activate shellX Work Preview, then run `preview_diagnose`; if it returns `screenshotPath`, inspect it with `vision_describe`; fix every reported error and record the screenshot/log evidence. For SDK/API/CLI/backend/library work, do not create placeholder UI just to satisfy Preview Doctor\n\
- [ ] Dispatch a `verifier` Agent using `wait=true` or run real checks and record evidence\n\n\
## Phase 5 - Complete\n\
Status: TODO\n\
- [ ] Verify all host gates are satisfied\n\
- [ ] Call `build_complete` MCP tool with summary\n\
```\n\n\
            Plan as a manager. Do not execute any phase yet. Do not call Grok \
            Build bundled `/implement`, `/review`, `/check`, `/check-work`, \
            `/design`, `/best-of-n`, or `/execute-plan` from \
            ACP mode; use shellX `Agent`, `Agent_status`, and `Agent_output` \
            directly when execution begins. Prefer `implementer` for scoped \
            code work, `reviewer` for code review plus AI slop/wiring audit, \
            `test-writer` when behavior changed or coverage is uncertain, \
            `security-auditor` only for security-sensitive changes, and \
            `verifier` for evidence checks. For UI/web/app work, verification \
            must include `preview_start` plus the `preview_diagnose` tool; \
            if Preview Doctor returns `screenshotPath`, inspect it with \
            `vision_describe`; if Preview Doctor reports errors, fix them \
            before `build_complete`. Do not create placeholder UI/HTML for \
            SDK/API/CLI/backend/library work just to satisfy Preview Doctor. \
            Do not ask an Agent to start preview \
            servers through shell commands for this gate; Work Preview must \
            be shellX-owned so Preview Doctor sees the same URL and logs. \
            The reviewer task must check \
            for unwired controls, placeholders, fake success paths, missing \
            frontend/backend bridges, config/schema drift, and release-debug \
            leaks. \
            When writing Agent tasks, make them direct assignments. A subagent \
            must do its assigned work itself and must not be told to dispatch \
            another Agent, poll Agent output, or follow scratchboard manager \
            checklist lines as instructions for itself. \
            If `Agent` is denied by shellX permission/autonomy gates, do not \
            fall back to direct edits or shell commands for that phase. Record \
            `build_receipt` kind=`blockerOpened` with the denial reason and \
            wait for the operator to approve, reconnect in Auto mode, or stop \
            the run. \
            Use `wait=true` for sequential Build Mode phases so shellX records \
            the Agent start immediately and the manager receives output in the \
            same turn. Reserve `wait=false` for independent parallel fan-out; \
            when you use `wait=false`, poll `Agent_status`/`Agent_output` \
            before ending the turn. Prefer `wait_budget_ms` when the task is \
            quick and deterministic (for example 120000 for small local \
            verification tasks); wait-budget expiry returns a still-running \
            Agent handle and is not failed evidence. Only pass \
            `max_runtime_ms` when the operator explicitly wants a hard \
            wall-clock kill policy.\n\n\
            Git baseline is mandatory before implementation: identify the \
            actual project root, run `git rev-parse --show-toplevel` and \
            `git status --short`, and if no repository exists create one with \
            `git init` in the project root before editing. Do not initialize \
            a generic parent folder such as Downloads when the app/project \
            lives in a child folder. Use `git status --short`, \
            `git diff --stat`, and shellX checkpoints throughout the run.\n\n\
            Completion format is strict: while working, keep the top-level \
            `Status:` as `IN_PROGRESS`. Before calling `build_complete`, every \
            phase section must contain its own exact `Status: DONE` line and \
            every checkbox must be `[x]`. Do not invent `Status: COMPLETE`; \
            shellX will reject it. \
            The `build_complete` tool, not a scratchboard edit, is the \
            completion authority.\n\n\
            Write exactly the scratchboard path shown above and do not \
            substitute a generic `build.md`; concurrent sessions in the same \
            project each have their own scratchboard. Use your native \
            write/edit file tool for normal project paths, especially WSL/SSH \
            POSIX paths like `/home/...`, `/Users/...`, or `/srv/...`. Use \
            shellX host `fs_write` only when the scratchboard path is a \
            Windows/host path that the host MCP can access. If host `fs_write` \
            rejects a POSIX scratchboard path, immediately retry with the \
            native write/edit file tool instead of opening a blocker.\n\n\
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
        let preview_required = build_objective_requires_preview(objective);
        let state = BuildRunState {
            run_id: run_id.clone(),
            tab_id: tab_id.to_string(),
            objective: objective.to_string(),
            cwd: cwd.to_string_lossy().to_string(),
            transport_kind: transport_kind.to_string(),
            scratchboard_path: scratchboard_path.to_string_lossy().to_string(),
            status: BuildRunStatus::Draft,
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
            preview_required,
            preview_satisfied: false,
            open_blocker: None,
            pending_operator_notes: Vec::new(),
            last_receipt_id: None,
        };

        if ssh_config.is_none() && !transport_kind.trim().eq_ignore_ascii_case("ssh") {
            let stub = format!(
                "# Build: {objective}\n\nStatus: DRAFTING\n\n_grok is drafting the build plan..._\n"
            );
            if let Err(e) = crate::goal_orchestrator::write_scratchboard_text_for_transport(
                &scratchboard_path,
                &stub,
                transport_kind,
                None,
            )
            .await
            {
                warn!(
                    "build_orchestrator: build.md stub write failed for tab='{}' transport='{}' path={} err={}",
                    tab_id,
                    transport_kind,
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
        if let Some(state) = self.refresh_draft_plan_if_ready(tab_id).await {
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

    async fn refresh_draft_plan_if_ready(&self, tab_id: &str) -> Option<BuildRunState> {
        let (state, ssh_config) = {
            let map = self.states.read().await;
            let runtime = map.get(tab_id)?;
            if runtime.state.status != BuildRunStatus::Draft {
                return Some(runtime.state.clone());
            }
            (runtime.state.clone(), runtime.ssh_config.clone())
        };

        let path = PathBuf::from(&state.scratchboard_path);
        let ready = crate::goal_orchestrator::read_scratchboard_text_for_transport(
            &path,
            &state.transport_kind,
            ssh_config.as_ref(),
        )
        .await
        .map(|text| validate_build_approval_ready(&text).is_ok())
        .unwrap_or(false);
        if !ready {
            return Some(state);
        }

        let mut map = self.states.write().await;
        let Some(runtime) = map.get_mut(tab_id) else {
            return Some(state);
        };
        if runtime.state.run_id != state.run_id || runtime.state.status != BuildRunStatus::Draft {
            return Some(runtime.state.clone());
        }
        runtime.state.status = BuildRunStatus::AwaitingApproval;
        runtime.state.updated_at_ms = now_ms();
        if let Err(e) = crate::build_store::write_state(&self.store_base, &runtime.state) {
            warn!(
                "build_orchestrator: failed to persist refreshed draft plan state for tab='{}': {}",
                tab_id, e
            );
        }
        Some(runtime.state.clone())
    }

    async fn ensure_runtime_loaded(&self, tab_id: &str) -> Result<(), String> {
        if self.states.read().await.contains_key(tab_id) {
            return Ok(());
        }
        let Some(state) = crate::build_store::read_latest_state_for_tab(&self.store_base, tab_id)?
        else {
            return Ok(());
        };
        let mut map = self.states.write().await;
        if !map.contains_key(tab_id) {
            map.insert(
                tab_id.to_string(),
                BuildRuntimeState {
                    state,
                    ssh_config: None,
                },
            );
        }
        Ok(())
    }

    pub async fn clear_tab(&self, tab_id: &str) {
        self.states.write().await.remove(tab_id);
    }

    /// Remove one exact isolated release-test Build slot and its persisted
    /// run namespace. Normal Build history is durable; only the guarded Debug
    /// API cleanup path calls this helper for a `release-build-run-*` tab.
    #[cfg(feature = "debug-api")]
    pub async fn release_test_clear_tab(&self, tab_id: &str) -> Result<(), String> {
        self.states.write().await.remove(tab_id);
        crate::build_store::remove_release_test_tab(&self.store_base, tab_id)
    }

    pub async fn get_receipts(&self, tab_id: &str) -> Result<Vec<BuildReceipt>, String> {
        let state = self
            .get_state(tab_id)
            .await
            .ok_or_else(|| "no build run for this tab".to_string())?;
        let store_base = self.store_base.clone();
        let tab_id = tab_id.to_string();
        let run_id = state.run_id;
        tokio::task::spawn_blocking(move || {
            crate::build_store::read_receipts(&store_base, &tab_id, &run_id)
        })
        .await
        .map_err(|error| format!("build receipts reader join failed: {error}"))?
    }

    pub async fn in_flight_agent_summaries(&self, tab_id: &str) -> Result<Vec<String>, String> {
        let receipts = self.get_receipts(tab_id).await?;
        Ok(build_in_flight_agent_summaries(&receipts))
    }

    pub async fn in_flight_agent_ids(&self, tab_id: &str) -> Result<Vec<String>, String> {
        let receipts = self.get_receipts(tab_id).await?;
        Ok(build_in_flight_agent_ids(&receipts))
    }

    pub async fn approve_plan(&self, tab_id: &str) -> Result<bool, String> {
        let runtime = {
            let map = self.states.read().await;
            let Some(runtime) = map.get(tab_id) else {
                return Ok(false);
            };
            runtime.clone()
        };
        if !matches!(
            runtime.state.status,
            BuildRunStatus::Draft | BuildRunStatus::AwaitingApproval
        ) {
            return Ok(false);
        }
        let path = PathBuf::from(&runtime.state.scratchboard_path);
        let text = crate::goal_orchestrator::read_scratchboard_text_for_transport(
            &path,
            &runtime.state.transport_kind,
            runtime.ssh_config.as_ref(),
        )
        .await
        .map_err(|e| format!("cannot approve build plan: build.md is not readable: {}", e))?;
        validate_build_approval_ready(&text)?;
        let patched = mark_build_plan_in_progress(&text)?;
        crate::goal_orchestrator::write_scratchboard_text_for_transport(
            &path,
            &patched,
            &runtime.state.transport_kind,
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
        self.ensure_runtime_loaded(tab_id).await?;
        let mut map = self.states.write().await;
        let Some(runtime) = map.get_mut(tab_id) else {
            return Ok(false);
        };
        match runtime.state.status {
            BuildRunStatus::Active => {}
            BuildRunStatus::Paused => {}
            BuildRunStatus::TransportFailed => {
                let receipts = crate::build_store::read_receipts(
                    &self.store_base,
                    tab_id,
                    &runtime.state.run_id,
                )
                .unwrap_or_default();
                let mut recheck_state = runtime.state.clone();
                recheck_state.status = BuildRunStatus::Active;
                if evaluate_blocker_recheck(&recheck_state, &receipts).cleared {
                    runtime.state.open_blocker = None;
                }
            }
            _ => return Ok(false),
        }
        runtime.state.status = BuildRunStatus::Active;
        runtime.state.updated_at_ms = now_ms();
        crate::build_store::write_state(&self.store_base, &runtime.state)?;
        Ok(true)
    }

    pub async fn recheck_blocker(&self, tab_id: &str) -> Result<BuildBlockerRecheckResult, String> {
        let state = self
            .get_state(tab_id)
            .await
            .ok_or_else(|| "no build run for this tab".to_string())?;
        let receipts = crate::build_store::read_receipts(&self.store_base, tab_id, &state.run_id)?;
        let result = evaluate_blocker_recheck(&state, &receipts);
        if !result.cleared {
            return Ok(result);
        }

        let receipt_id = new_receipt_id();
        let receipt = BuildReceipt {
            receipt_id: receipt_id.clone(),
            run_id: state.run_id.clone(),
            tab_id: tab_id.to_string(),
            kind: BuildReceiptKind::BlockerResolved,
            created_at_ms: now_ms(),
            actor: "shellx".into(),
            summary: format!("Rechecked blocker: {}", result.message),
            confidence: BuildReceiptConfidence::TrustedHost,
            data: json!({
                "reason": "recheckBlocker",
                "matchedReceiptId": result.matched_receipt_id.clone(),
                "matchedSubagentId": result.matched_subagent_id.clone(),
            }),
        };
        self.append_receipt(receipt).await?;

        let mut map = self.states.write().await;
        if let Some(runtime) = map.get_mut(tab_id) {
            if runtime.state.run_id == state.run_id {
                runtime.state.open_blocker = None;
                if runtime.state.status == BuildRunStatus::Blocked {
                    runtime.state.status = BuildRunStatus::Active;
                }
                runtime.state.updated_at_ms = now_ms();
                crate::build_store::write_state(&self.store_base, &runtime.state)?;
                return Ok(result);
            }
        }

        let mut state = state;
        state.open_blocker = None;
        if state.status == BuildRunStatus::Blocked {
            state.status = BuildRunStatus::Active;
        }
        state.last_receipt_id = Some(receipt_id);
        state.updated_at_ms = now_ms();
        crate::build_store::write_state(&self.store_base, &state)?;
        Ok(result)
    }

    pub async fn add_operator_note(
        &self,
        tab_id: &str,
        text: &str,
    ) -> Result<BuildOperatorNote, String> {
        self.ensure_runtime_loaded(tab_id).await?;
        let text = text.trim();
        if text.is_empty() {
            return Err("operator note is empty".to_string());
        }
        let note = BuildOperatorNote {
            note_id: format!("bon-{}", Uuid::new_v4()),
            created_at_ms: now_ms(),
            text: text.to_string(),
        };
        let state = {
            let mut map = self.states.write().await;
            let Some(runtime) = map.get_mut(tab_id) else {
                return Err("no active /build run for this tab".to_string());
            };
            if matches!(
                runtime.state.status,
                BuildRunStatus::Complete | BuildRunStatus::Halted
            ) {
                return Err("cannot queue operator note for a finished build".to_string());
            }
            runtime.state.pending_operator_notes.push(note.clone());
            runtime.state.updated_at_ms = now_ms();
            crate::build_store::write_state(&self.store_base, &runtime.state)?;
            runtime.state.clone()
        };
        let summary = operator_note_summary(&note.text);
        self.append_receipt(BuildReceipt {
            receipt_id: new_receipt_id(),
            run_id: state.run_id,
            tab_id: tab_id.to_string(),
            kind: BuildReceiptKind::OperatorNoteQueued,
            created_at_ms: note.created_at_ms,
            actor: "operator".into(),
            summary,
            confidence: BuildReceiptConfidence::TrustedHost,
            data: json!({
                "noteId": note.note_id,
                "text": note.text,
            }),
        })
        .await?;
        Ok(note)
    }

    pub async fn mark_complete(&self, tab_id: &str, summary: &str) -> Result<bool, String> {
        if self.get_state(tab_id).await.is_none() {
            return Ok(false);
        }
        self.validate_complete(tab_id, summary).await?;
        Ok(true)
    }

    pub async fn halt(&self, tab_id: &str, summary: &str) -> Result<bool, String> {
        self.ensure_runtime_loaded(tab_id).await?;
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
        self.ensure_runtime_loaded(tab_id).await?;
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
        self.ensure_runtime_loaded(tab_id).await?;
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
        self.ensure_runtime_loaded(&receipt.tab_id).await?;
        let path_for_receipt = receipt
            .data
            .get("path")
            .or_else(|| receipt.data.get("dst"))
            .and_then(|v| v.as_str());
        let (scratchboard_match, build_evidence_log) = {
            let map = self.states.read().await;
            if let Some(runtime) = map
                .get(&receipt.tab_id)
                .filter(|runtime| runtime.state.run_id == receipt.run_id)
            {
                (
                    path_for_receipt
                        .map(|path| classify_scratchboard_receipt_path(path, &runtime.state)),
                    path_for_receipt
                        .map(|path| is_build_evidence_log_path(Path::new(path), &runtime.state))
                        .unwrap_or(false),
                )
            } else {
                (None, false)
            }
        };
        if let Some(scratchboard_match) = scratchboard_match {
            if let Some(path) = path_for_receipt {
                let path = path.to_string();
                if scratchboard_match.is_match() {
                    match receipt.kind {
                        BuildReceiptKind::FileWrite => {
                            receipt.kind = BuildReceiptKind::PlanWritten;
                            receipt.summary = format!("Build scratchboard written: {}", path);
                            if let serde_json::Value::Object(ref mut map) = receipt.data {
                                map.insert("scratchboard".into(), serde_json::Value::Bool(true));
                                map.insert(
                                    "scratchboardPath".into(),
                                    serde_json::Value::String(path),
                                );
                                if scratchboard_match == ScratchboardPathMatch::ValidatedAlias {
                                    map.insert(
                                        "scratchboardAlias".into(),
                                        serde_json::Value::Bool(true),
                                    );
                                }
                            }
                        }
                        BuildReceiptKind::FileDelete | BuildReceiptKind::FileCopy => {
                            return Ok(());
                        }
                        _ => {}
                    }
                } else if build_evidence_log {
                    if let serde_json::Value::Object(ref mut map) = receipt.data {
                        map.insert("buildInternal".into(), serde_json::Value::Bool(true));
                        map.insert("buildEvidenceLog".into(), serde_json::Value::Bool(true));
                    }
                }
            }
        }
        if receipt.kind == BuildReceiptKind::CheckpointCreated {
            let checkpoint_state = {
                let map = self.states.read().await;
                map.get(&receipt.tab_id)
                    .filter(|runtime| runtime.state.run_id == receipt.run_id)
                    .map(|runtime| {
                        (
                            runtime.ssh_config.is_none()
                                && runtime.state.transport_kind.trim() == "local",
                            runtime.state.clone(),
                        )
                    })
            };
            if let Some((is_local, state)) = checkpoint_state {
                maybe_attach_build_worktree_fingerprint(&mut receipt, is_local, &state);
            }
        }
        let plan_approval_ready = if receipt.kind == BuildReceiptKind::PlanWritten {
            let (path, transport_kind, ssh_config) = {
                let map = self.states.read().await;
                if let Some(runtime) = map
                    .get(&receipt.tab_id)
                    .filter(|runtime| runtime.state.run_id == receipt.run_id)
                {
                    let path = receipt
                        .data
                        .get("scratchboardPath")
                        .and_then(|v| v.as_str())
                        .unwrap_or(&runtime.state.scratchboard_path)
                        .to_string();
                    (
                        Some(PathBuf::from(path)),
                        runtime.state.transport_kind.clone(),
                        runtime.ssh_config.clone(),
                    )
                } else {
                    (None, "local".to_string(), None)
                }
            };
            if let Some(path) = path {
                match crate::goal_orchestrator::read_scratchboard_text_for_transport(
                    &path,
                    &transport_kind,
                    ssh_config.as_ref(),
                )
                .await
                {
                    Ok(text) => validate_build_approval_ready(&text).is_ok(),
                    Err(e) => {
                        warn!(
                            "build_orchestrator: planWritten validation read failed for tab='{}' path={} err={}",
                            receipt.tab_id,
                            path.display(),
                            e
                        );
                        false
                    }
                }
            } else {
                false
            }
        } else {
            false
        };

        let store_base = self.store_base.clone();
        let receipt_for_store = receipt.clone();
        tokio::task::spawn_blocking(move || {
            crate::build_store::append_receipt(&store_base, &receipt_for_store)
        })
        .await
        .map_err(|error| format!("build receipt writer join failed: {error}"))??;
        let mut map = self.states.write().await;
        let Some(runtime) = map.get_mut(&receipt.tab_id) else {
            return Ok(());
        };
        if runtime.state.run_id != receipt.run_id {
            return Ok(());
        }
        if matches!(
            runtime.state.status,
            BuildRunStatus::Complete | BuildRunStatus::Halted | BuildRunStatus::TransportFailed
        ) {
            return Ok(());
        }
        runtime.state.last_receipt_id = Some(receipt.receipt_id.clone());
        runtime.state.updated_at_ms = now_ms();
        if build_receipt_is_forward_progress(&receipt) {
            runtime.state.no_progress_cycles = 0;
        }
        match receipt.kind {
            BuildReceiptKind::CheckpointCreated => {
                let requires_fresh_gates =
                    checkpoint_receipt_requires_fresh_gates(&receipt.data, &runtime.state)
                        && !checkpoint_receipt_repeats_current_checkpoint_fingerprint(
                            &self.store_base,
                            &receipt.data,
                            &runtime.state,
                        );
                runtime.state.checkpoint_id = receipt
                    .data
                    .get("checkpointId")
                    .and_then(|v| v.as_str())
                    .map(ToOwned::to_owned)
                    .or_else(|| Some(receipt.receipt_id.clone()));
                if requires_fresh_gates {
                    mark_code_changed_requires_fresh_gates(&mut runtime.state, false);
                }
            }
            BuildReceiptKind::FileWrite
            | BuildReceiptKind::FileDelete
            | BuildReceiptKind::FileCopy => {
                let build_internal =
                    receipt.data.get("buildInternal").and_then(|v| v.as_bool()) == Some(true);
                if !build_internal {
                    mark_code_changed_requires_fresh_gates(&mut runtime.state, true);
                }
            }
            BuildReceiptKind::PlanWritten => {
                if let Some(path) = receipt
                    .data
                    .get("scratchboardPath")
                    .and_then(|v| v.as_str())
                {
                    runtime.state.scratchboard_path = path.to_string();
                }
                if plan_approval_ready && runtime.state.status == BuildRunStatus::Draft {
                    runtime.state.status = BuildRunStatus::AwaitingApproval;
                }
            }
            BuildReceiptKind::ReviewCompleted
                if trusted_receipt_satisfies_gate(&receipt, BuildReceiptKind::ReviewCompleted) =>
            {
                runtime.state.review_satisfied = true;
            }
            BuildReceiptKind::VerificationCompleted
                if trusted_receipt_satisfies_gate(
                    &receipt,
                    BuildReceiptKind::VerificationCompleted,
                ) =>
            {
                runtime.state.verification_satisfied = true;
            }
            BuildReceiptKind::PreviewDiagnosed
                if receipt.confidence != BuildReceiptConfidence::ModelDeclared
                    && receipt.data.get("ok").and_then(|v| v.as_bool()) == Some(true) =>
            {
                runtime.state.preview_satisfied = true;
            }
            BuildReceiptKind::ReviewCompleted | BuildReceiptKind::VerificationCompleted => {}
            BuildReceiptKind::PreviewDiagnosed => {}
            BuildReceiptKind::AgentStarted => {
                maybe_clear_stale_agent_progress_blocker(&mut runtime.state, &receipt);
            }
            BuildReceiptKind::AgentCompleted => {
                maybe_clear_completed_agent_blocker(&mut runtime.state, &receipt);
            }
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
        if build_has_in_flight_agent(&receipts) {
            return None;
        }
        let last_receipt = receipts
            .last()
            .map(|r| format!("{:?}: {}", r.kind, r.summary))
            .unwrap_or_else(|| "none".to_string());

        let text = crate::goal_orchestrator::read_scratchboard_text_for_transport(
            Path::new(&runtime.state.scratchboard_path),
            &runtime.state.transport_kind,
            runtime.ssh_config.as_ref(),
        )
        .await
        .unwrap_or_default();
        let board = crate::goal_orchestrator::parse_board(&text);
        if board.top_status.as_deref() == Some("GOAL_COMPLETE")
            && crate::goal_orchestrator::validate_board_text(&text).is_ok()
        {
            match self
                .validate_complete(
                    tab_id,
                    "Build Mode scratchboard status GOAL_COMPLETE observed",
                )
                .await
            {
                Ok(()) => return None,
                Err(reason) => {
                    let mut map = self.states.write().await;
                    let runtime = map.get_mut(tab_id)?;
                    runtime.state.continuations_total =
                        runtime.state.continuations_total.saturating_add(1);
                    runtime.state.last_continuation_at_ms = Some(now_ms());
                    runtime.state.no_progress_cycles = 0;
                    let operator_notes = std::mem::take(&mut runtime.state.pending_operator_notes);
                    runtime.state.updated_at_ms = now_ms();
                    let injection_count = runtime.state.continuations_total;
                    let _ = crate::build_store::write_state(&self.store_base, &runtime.state);
                    let operator_notes_block = format_operator_notes_block(&operator_notes);
                    return Some(format!(
                        "<build_completion_rejected>\n{}\n\nThe Build Mode scratchboard claims GOAL_COMPLETE, but shellX has not accepted the host gates. Reopen the relevant phase, record the missing checkpoint/review/verification receipts, then call `build_complete` again.{}\nContinuation #{}.\n</build_completion_rejected>",
                        reason, operator_notes_block, injection_count
                    ));
                }
            }
        }
        let completion_nudge = board.unchecked_count == 0 && board.phase_count > 0;
        let stale_forward_nudge = build_receipts_need_forward_nudge(&receipts);

        let mut map = self.states.write().await;
        let runtime = map.get_mut(tab_id)?;
        runtime.state.continuations_total = runtime.state.continuations_total.saturating_add(1);
        runtime.state.last_continuation_at_ms = Some(now_ms());
        runtime.state.no_progress_cycles = if completion_nudge {
            0
        } else if stale_forward_nudge {
            runtime.state.no_progress_cycles.saturating_add(1)
        } else {
            0
        };
        let operator_notes = std::mem::take(&mut runtime.state.pending_operator_notes);
        runtime.state.updated_at_ms = now_ms();
        let injection_count = runtime.state.continuations_total;
        let _ = crate::build_store::write_state(&self.store_base, &runtime.state);
        let operator_notes_block = format_operator_notes_block(&operator_notes);
        let forward_nudge_block =
            format_build_forward_nudge_block(runtime.state.no_progress_cycles);
        Some(if completion_nudge {
            let required_gates = format_required_build_gates(&runtime.state);
            format!(
                "<build_completion_check>\nThe Build Mode scratchboard appears complete, but shellX has not accepted completion for objective `{}`.\nCall `build_complete` now if the required gates are satisfied: {}. If a gate is missing, reopen the relevant phase and satisfy it.{}\nContinuation #{}.\n</build_completion_check>",
                runtime.state.objective,
                required_gates,
                operator_notes_block,
                injection_count
            )
        } else {
            format!(
                "<build_context>\nObjective: {}\nStatus: {:?}\nApproved plan hash: {}\nCurrent phase: {}\nContinuations: {}\nRequired gates: checkpoint={}, review={}, verification={}, preview={}\nSatisfied gates: checkpoint={}, review={}, verification={}, preview={}\nLast receipt: {}\nOpen blocker: {}\nScratchboard: {}\n{}{}\nAction now: inspect the next unchecked sub-stage in the Build Mode scratchboard and manage it to completion. Keep the git baseline current: run `git rev-parse --show-toplevel` and `git status --short` before code work when the root is unclear; if no repository exists, create one with `git init` in the actual project root, not a generic parent folder, then use `git status --short`, `git diff --stat`, and shellX checkpoints before reporting progress or completion. Prefer an `implementer` Agent for non-trivial code, a `reviewer` Agent for code review plus AI slop/wiring audit, a `test-writer` Agent when behavior changed or coverage is uncertain, and a `verifier` Agent for evidence checks. Do not invoke Grok Build bundled `/implement`, `/review`, `/check`, `/check-work`, `/design`, `/best-of-n`, or `/execute-plan` from this shellX ACP session; use shellX `Agent` receipts for hard gates. The reviewer should check unwired controls, placeholders, fake success paths, missing frontend/backend bridges, config/schema drift, and release-debug leaks. For UI/web/app work, call `preview_start` to activate shellX Work Preview, then run `preview_diagnose`; if it returns `screenshotPath`, inspect it with `vision_describe`; treat any Preview Doctor error as unfinished work and feed the evidence back into fixes before verification. Do not ask an Agent to start preview servers through shell commands for the Work Preview gate; shellX must own the preview process so Preview Doctor can inspect the same URL and logs. Agent task text must be a direct assignment to that subagent; never ask a subagent to dispatch another Agent, poll Agent output, or follow scratchboard manager checklist lines as its own instructions. Use `wait=true` for sequential Build Mode phases; reserve `wait=false` for independent fan-out and poll `Agent_status`/`Agent_output` before ending the turn. If `Agent` is denied by shellX permission/autonomy gates, do not fall back to direct edits or shell commands for that phase; record `build_receipt` kind=`blockerOpened` with the denial reason and wait for operator action. Record receipts in the scratchboard. Do not call `build_complete` until every required host gate is satisfied.\n</build_context>",
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
                runtime.state.preview_required,
                runtime.state.checkpoint_id.is_some(),
                runtime.state.review_satisfied,
                runtime.state.verification_satisfied,
                runtime.state.preview_satisfied,
                last_receipt,
                runtime.state.open_blocker.as_deref().unwrap_or("none"),
                runtime.state.scratchboard_path,
                operator_notes_block,
                forward_nudge_block,
            )
        })
    }

    pub async fn validate_complete(&self, tab_id: &str, summary: &str) -> Result<(), String> {
        self.validate_complete_with_current_fingerprint(tab_id, summary, None)
            .await
    }

    pub async fn validate_complete_with_current_fingerprint(
        &self,
        tab_id: &str,
        summary: &str,
        current_worktree_fingerprint: Option<String>,
    ) -> Result<(), String> {
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
        let text = crate::goal_orchestrator::read_scratchboard_text_for_transport(
            Path::new(&runtime.state.scratchboard_path),
            &runtime.state.transport_kind,
            runtime.ssh_config.as_ref(),
        )
        .await
        .map_err(|e| {
            format!(
                "build_complete rejected: Build Mode scratchboard is not readable: {}",
                e
            )
        })?;
        crate::goal_orchestrator::validate_board_text(&text)
            .map_err(|e| e.replace("goal_complete refused", "build_complete refused"))?;

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
                    mark_code_changed_requires_fresh_gates(&mut current.state, true);
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
        if runtime.state.code_changed {
            if let Some(checkpoint_id) = runtime.state.checkpoint_id.clone() {
                let is_nonlocal =
                    runtime.ssh_config.is_some() || runtime.state.transport_kind.trim() != "local";
                let current_fingerprint = if is_nonlocal {
                    Some(current_worktree_fingerprint.clone().ok_or_else(|| {
                        "build_complete rejected: non-local code-changing build requires current worktree fingerprint verification".to_string()
                    })?)
                } else {
                    local_build_worktree_fingerprint(
                        Path::new(&runtime.state.cwd),
                        Path::new(&runtime.state.scratchboard_path),
                    )?
                };
                if let Some(current_fingerprint) = current_fingerprint {
                    let checkpoint_fingerprint = latest_checkpoint_worktree_fingerprint(
                        &self.store_base,
                        tab_id,
                        &runtime.state.run_id,
                        &checkpoint_id,
                    )?;
                    if checkpoint_fingerprint.as_deref() != Some(current_fingerprint.as_str()) {
                        let mut map = self.states.write().await;
                        if let Some(current) = map.get_mut(tab_id) {
                            if current.state.run_id == runtime.state.run_id {
                                mark_code_changed_requires_fresh_gates(&mut current.state, true);
                                current.state.updated_at_ms = now_ms();
                                crate::build_store::write_state(&self.store_base, &current.state)?;
                                runtime = current.clone();
                                warn!(
                                    "build_orchestrator: checkpoint fingerprint stale for tab='{}' checkpoint='{}' checkpoint_fingerprint={:?} current_fingerprint={}",
                                    tab_id, checkpoint_id, checkpoint_fingerprint, current_fingerprint
                                );
                            }
                        }
                    }
                }
            }
        }
        if runtime.state.code_changed && runtime.state.checkpoint_id.is_none() {
            return Err(
                "build_complete rejected: code changed but no checkpoint receipt exists".into(),
            );
        }
        let gate_receipts = if runtime.state.review_required || runtime.state.verification_required
        {
            crate::build_store::read_receipts(&self.store_base, tab_id, &runtime.state.run_id)?
        } else {
            Vec::new()
        };
        if runtime.state.review_required
            && (!runtime.state.review_satisfied
                || latest_trusted_receipt(&gate_receipts, BuildReceiptKind::ReviewCompleted)
                    .is_none())
        {
            return Err(
                "build_complete rejected: code-changing build requires a trusted reviewer receipt with substantive review evidence"
                    .into(),
            );
        }
        if runtime.state.verification_required
            && (!runtime.state.verification_satisfied
                || latest_trusted_receipt(&gate_receipts, BuildReceiptKind::VerificationCompleted)
                    .is_none())
        {
            return Err(
                "build_complete rejected: build requires a trusted verification receipt with substantive verification evidence"
                    .into(),
            );
        }
        if runtime.state.preview_required && !runtime.state.preview_satisfied {
            return Err(
                "build_complete rejected: UI/web build requires a successful Preview Doctor receipt"
                    .into(),
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

fn build_objective_requires_preview(objective: &str) -> bool {
    let words = build_objective_words(objective);
    if words.is_empty() {
        return false;
    }

    let has_word = |needle: &str| words.iter().any(|word| word == needle);
    let has_phrase = |phrase: &[&str]| build_objective_has_phrase(&words, phrase);

    let explicitly_non_visual = has_phrase(&["no", "ui"])
        || has_phrase(&["non", "ui"])
        || has_phrase(&["not", "ui"])
        || has_phrase(&["without", "ui"])
        || has_word("headless");

    let library_or_service_work = has_word("sdk")
        || has_word("api")
        || has_word("library")
        || has_word("package")
        || has_word("cli")
        || has_word("backend")
        || has_word("server")
        || has_phrase(&["debug", "api"])
        || has_phrase(&["browser", "debug", "api"]);

    let explicit_visual_surface = (has_word("ui") && !explicitly_non_visual)
        || has_word("frontend")
        || has_phrase(&["front", "end"])
        || has_phrase(&["user", "interface"])
        || has_word("html")
        || has_word("vite")
        || has_word("react")
        || has_word("expo")
        || has_phrase(&["next", "js"])
        || has_word("nextjs")
        || has_word("preview")
        || has_word("screen")
        || has_word("dashboard")
        || has_word("form")
        || has_word("website")
        || has_word("webpage")
        || has_phrase(&["web", "page"])
        || has_phrase(&["web", "app"])
        || has_phrase(&["landing", "page"]);

    if explicitly_non_visual && library_or_service_work {
        return false;
    }
    if library_or_service_work && !explicit_visual_surface {
        return false;
    }
    if explicit_visual_surface {
        return true;
    }

    // A bare "web" usually means the operator expects a browser-visible
    // result, but do not let "browser" alone trigger Preview Doctor. Browser
    // SDK/API/control work is often non-visual and should not be nudged into
    // creating placeholder HTML just to satisfy a false UI gate.
    has_word("web") || has_word("page")
}

fn build_objective_words(objective: &str) -> Vec<String> {
    objective
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c.to_ascii_lowercase()
            } else {
                ' '
            }
        })
        .collect::<String>()
        .split_whitespace()
        .map(|word| word.to_string())
        .collect()
}

fn build_objective_has_phrase(words: &[String], phrase: &[&str]) -> bool {
    if phrase.is_empty() || words.len() < phrase.len() {
        return false;
    }
    words
        .windows(phrase.len())
        .any(|window| window.iter().zip(phrase.iter()).all(|(a, b)| a == b))
}

fn format_required_build_gates(state: &BuildRunState) -> String {
    let mut gates = Vec::new();
    if state.code_changed {
        gates.push("checkpoint");
    }
    if state.review_required {
        gates.push("review");
    }
    if state.verification_required {
        gates.push("verification");
    }
    if state.preview_required {
        gates.push("Preview Doctor");
    }
    if gates.is_empty() {
        "scratchboard completion".to_string()
    } else {
        gates.join(", ")
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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ScratchboardPathMatch {
    None,
    Exact,
    ValidatedAlias,
}

impl ScratchboardPathMatch {
    fn is_match(self) -> bool {
        !matches!(self, ScratchboardPathMatch::None)
    }
}

fn classify_scratchboard_receipt_path(path: &str, state: &BuildRunState) -> ScratchboardPathMatch {
    if build_receipt_path_matches(path, &state.scratchboard_path) {
        return ScratchboardPathMatch::Exact;
    }
    if !matches!(
        state.status,
        BuildRunStatus::Draft | BuildRunStatus::AwaitingApproval
    ) || state.approved_plan_hash.is_some()
    {
        return ScratchboardPathMatch::None;
    }
    if probable_build_plan_alias_path(path, state) && validated_build_plan_file(path) {
        ScratchboardPathMatch::ValidatedAlias
    } else {
        ScratchboardPathMatch::None
    }
}

fn probable_build_plan_alias_path(path: &str, state: &BuildRunState) -> bool {
    let actual = Path::new(path);
    let expected = Path::new(&state.scratchboard_path);
    if actual.parent() != expected.parent() {
        return false;
    }
    let Some(actual_name) = actual.file_name().and_then(|s| s.to_str()) else {
        return false;
    };
    let Some((actual_prefix, actual_ext)) = actual_name.rsplit_once('.') else {
        return false;
    };
    let tab = crate::session_git::sanitize_worktree_slug(&state.tab_id);
    let tab = if tab.is_empty() { "tab" } else { tab.as_str() };
    let required_prefix = format!("build.{}.", tab);
    actual_ext.eq_ignore_ascii_case("md") && actual_prefix.starts_with(&required_prefix)
}

fn validated_build_plan_file(path: &str) -> bool {
    let Ok(text) = std::fs::read_to_string(path) else {
        return false;
    };
    let has_build_heading = text
        .lines()
        .find(|line| !line.trim().is_empty())
        .map(|line| line.trim_start().starts_with("# Build:"))
        .unwrap_or(false);
    has_build_heading && validate_build_approval_ready(&text).is_ok()
}

fn is_build_evidence_log_path(path: &Path, state: &BuildRunState) -> bool {
    is_build_evidence_log_path_for_scratchboard(path, Path::new(&state.scratchboard_path))
}

fn is_build_evidence_log_path_for_scratchboard(path: &Path, scratchboard_path: &Path) -> bool {
    if path.file_name().and_then(|s| s.to_str()) != Some("build.md") {
        return false;
    }
    if path.parent() != scratchboard_path.parent() {
        return false;
    }
    validated_build_evidence_log_file(path)
}

fn validated_build_evidence_log_file(path: &Path) -> bool {
    let Ok(text) = std::fs::read_to_string(path) else {
        return false;
    };
    let lower = text.to_ascii_lowercase();
    lower.contains("build evidence log")
        || (lower.contains("build mode")
            && lower.contains("scratchboard")
            && lower.contains("build_complete"))
}

fn validate_build_approval_ready(text: &str) -> Result<(), String> {
    if text.contains("_grok is drafting the build plan") {
        return Err(
            "plan is still the shellX drafting stub; wait for Grok to write the Build Mode scratchboard".into(),
        );
    }
    let fp = crate::goal_orchestrator::parse_board(text);
    if fp.phase_count == 0 {
        return Err(
            "plan is not ready: Build Mode scratchboard has no `## Phase` headings yet".into(),
        );
    }
    if fp.unchecked_count == 0 {
        return Err(
            "plan is not ready: Build Mode scratchboard has no unchecked `- [ ]` phase steps"
                .into(),
        );
    }
    if !build_plan_has_slop_review_gate(text) {
        return Err(
            "plan is not ready: Review phase must include the AI slop / wiring audit step".into(),
        );
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

fn build_plan_has_slop_review_gate(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    lower.contains("ai slop")
        && lower.contains("wiring")
        && lower.contains("fake success")
        && (lower.contains("placeholder") || lower.contains("mock"))
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
                        "approved Build Mode scratchboard has top-level Status `{}` instead of AWAITING_APPROVAL",
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
        Err(
            "approved Build Mode scratchboard is missing top-level `Status: AWAITING_APPROVAL`"
                .into(),
        )
    }
}

fn operator_note_summary(text: &str) -> String {
    let compact = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut preview: String = compact.chars().take(160).collect();
    if compact.chars().count() > 160 {
        preview.push('…');
    }
    format!(
        "Operator note queued for next build continuation: {}",
        preview
    )
}

fn format_operator_notes_block(notes: &[BuildOperatorNote]) -> String {
    if notes.is_empty() {
        return String::new();
    }
    let mut out =
        String::from("\n\nOperator notes queued while the build was running:\n<operator_notes>\n");
    for note in notes {
        let safe_text = note
            .text
            .replace("</operator_notes>", "<\\/operator_notes>");
        out.push_str(&format!(
            "- {} at {}: {}\n",
            note.note_id, note.created_at_ms, safe_text
        ));
    }
    out.push_str("</operator_notes>\n");
    out
}

fn build_receipts_need_forward_nudge(receipts: &[BuildReceipt]) -> bool {
    let mut stale_count = 0;
    let mut saw_review_or_verify = false;

    for receipt in receipts.iter().rev().take(16) {
        if build_receipt_is_forward_progress(receipt) {
            break;
        }
        if build_receipt_is_forward_nudge_neutral(receipt) {
            continue;
        }
        if build_receipt_is_stale_gate_cycle(receipt) {
            stale_count += 1;
            saw_review_or_verify |= build_receipt_is_review_or_verify_cycle(receipt);
            continue;
        }
        break;
    }

    stale_count >= 2 && saw_review_or_verify
}

fn format_build_forward_nudge_block(cycles: u32) -> String {
    if cycles == 0 {
        return String::new();
    }
    let (level, body) = if cycles >= 4 {
        (
            3,
            "Manager correction required:\n\
             - Keep the build active; this is not a blocker.\n\
             - Rewrite the scratchboard next-action section to one concrete implementation or compile-fix task.\n\
             - Then dispatch an implementer Agent with wait=true for that task.\n\
             - Do not dispatch reviewer, verifier, test-writer, or preview-only work again until a source delta or fresh checkpoint exists.",
        )
    } else if cycles >= 2 {
        (
            2,
            "Forced forward step:\n\
             - Keep the build active; this is not a blocker.\n\
             - Your next action must be exactly one of: dispatch implementer for the next concrete incomplete item; fix the first failing build/test/smoke error; or call build_complete if the full objective gates are truly satisfied.\n\
             - Do not dispatch another reviewer or verifier for the same scope until there is a new source delta or fresh checkpoint.",
        )
    } else {
        (
            1,
            "Forward nudge:\n\
             - Recent receipts look like review/verification repetition without implementation progress.\n\
             - Do not dispatch another reviewer or verifier for the same scope.\n\
             - Choose one concrete unchecked implementation item, compile/test failure, or real completion path and move that forward.",
        )
    };

    format!(
        "\n<build_forward_nudge level=\"{}\" cycles=\"{}\">\n{}\n</build_forward_nudge>\n",
        level, cycles, body
    )
}

fn build_receipt_is_forward_progress(receipt: &BuildReceipt) -> bool {
    match receipt.kind {
        BuildReceiptKind::CheckpointCreated => true,
        BuildReceiptKind::FileWrite | BuildReceiptKind::FileDelete | BuildReceiptKind::FileCopy => {
            receipt.data.get("buildInternal").and_then(|v| v.as_bool()) != Some(true)
        }
        BuildReceiptKind::AgentStarted | BuildReceiptKind::AgentCompleted => {
            build_receipt_agent_persona(receipt)
                .map(build_persona_is_forward_progress)
                .unwrap_or(false)
        }
        _ => false,
    }
}

fn build_receipt_is_forward_nudge_neutral(receipt: &BuildReceipt) -> bool {
    matches!(
        receipt.kind,
        BuildReceiptKind::OperatorNoteQueued
            | BuildReceiptKind::PromptSent
            | BuildReceiptKind::CommandObserved
            | BuildReceiptKind::CompletionRequested
            | BuildReceiptKind::CompletionRejected
    )
}

fn build_receipt_is_stale_gate_cycle(receipt: &BuildReceipt) -> bool {
    matches!(
        receipt.kind,
        BuildReceiptKind::PlanWritten
            | BuildReceiptKind::ReviewCompleted
            | BuildReceiptKind::VerificationCompleted
            | BuildReceiptKind::PreviewDiagnosed
    ) || build_receipt_agent_persona(receipt)
        .map(build_persona_is_gate_only)
        .unwrap_or(false)
}

fn build_receipt_is_review_or_verify_cycle(receipt: &BuildReceipt) -> bool {
    matches!(
        receipt.kind,
        BuildReceiptKind::ReviewCompleted | BuildReceiptKind::VerificationCompleted
    ) || build_receipt_agent_persona(receipt)
        .map(|persona| matches!(persona, "reviewer" | "verifier"))
        .unwrap_or(false)
}

fn build_receipt_agent_persona(receipt: &BuildReceipt) -> Option<&str> {
    receipt.data.get("persona").and_then(|v| v.as_str())
}

fn build_persona_is_forward_progress(persona: &str) -> bool {
    matches!(
        persona,
        "implementer" | "test-writer" | "release-manager" | "security-auditor"
    )
}

fn build_persona_is_gate_only(persona: &str) -> bool {
    matches!(persona, "reviewer" | "verifier")
}

fn maybe_clear_completed_agent_blocker(state: &mut BuildRunState, receipt: &BuildReceipt) {
    if state.status != BuildRunStatus::Blocked {
        return;
    }
    let Some(blocker) = state.open_blocker.as_deref() else {
        return;
    };
    let Some(subagent_id) = receipt.data.get("subagentId").and_then(|v| v.as_str()) else {
        return;
    };
    if subagent_id.is_empty() || !blocker.contains(subagent_id) {
        return;
    }
    let blocker_lower = blocker.to_ascii_lowercase();
    if !blocker_lower.contains("in-flight agent") && !blocker_lower.contains("still running") {
        return;
    }
    if receipt.data.get("status").and_then(|v| v.as_str()) == Some("running") {
        return;
    }

    state.open_blocker = None;
    state.status = BuildRunStatus::Active;
}

fn maybe_clear_stale_agent_progress_blocker(state: &mut BuildRunState, receipt: &BuildReceipt) {
    if state.status != BuildRunStatus::Blocked {
        return;
    }
    if state
        .open_blocker
        .as_deref()
        .unwrap_or("")
        .trim()
        .is_empty()
    {
        return;
    }
    if receipt.confidence == BuildReceiptConfidence::ModelDeclared {
        return;
    }

    state.open_blocker = None;
    state.status = BuildRunStatus::Active;
}

fn evaluate_blocker_recheck(
    state: &BuildRunState,
    receipts: &[BuildReceipt],
) -> BuildBlockerRecheckResult {
    let Some(blocker) = state
        .open_blocker
        .as_deref()
        .filter(|s| !s.trim().is_empty())
    else {
        return BuildBlockerRecheckResult {
            checked: false,
            cleared: false,
            message: "No blocker is open.".into(),
            matched_receipt_id: None,
            matched_subagent_id: None,
        };
    };

    if matches!(
        state.status,
        BuildRunStatus::Complete | BuildRunStatus::Halted | BuildRunStatus::TransportFailed
    ) {
        return BuildBlockerRecheckResult {
            checked: true,
            cleared: false,
            message: "Still blocked: terminal build state is not changed by recheck.".into(),
            matched_receipt_id: None,
            matched_subagent_id: None,
        };
    }

    let blocker_lower = blocker.to_ascii_lowercase();
    if blocker_lower.contains("review") && state.review_satisfied {
        if let Some(receipt) = latest_trusted_receipt(receipts, BuildReceiptKind::ReviewCompleted) {
            return blocker_cleared(
                "Blocker cleared; trusted reviewer receipt satisfies the review gate.",
                Some(receipt),
                build_receipt_agent_id(receipt),
            );
        }
    }
    if blocker_lower.contains("verif") && state.verification_satisfied {
        if let Some(receipt) =
            latest_trusted_receipt(receipts, BuildReceiptKind::VerificationCompleted)
        {
            return blocker_cleared(
                "Blocker cleared; trusted verification receipt satisfies the verification gate.",
                Some(receipt),
                build_receipt_agent_id(receipt),
            );
        }
    }
    if blocker_lower.contains("preview") && state.preview_satisfied {
        if let Some(receipt) = latest_trusted_receipt(receipts, BuildReceiptKind::PreviewDiagnosed)
        {
            return blocker_cleared(
                "Blocker cleared; successful preview receipt satisfies the preview gate.",
                Some(receipt),
                build_receipt_agent_id(receipt),
            );
        }
    }

    let candidate_ids = collect_blocker_candidate_agent_ids(blocker, receipts);
    for subagent_id in &candidate_ids {
        let mut saw_started = false;
        let mut latest_completed: Option<&BuildReceipt> = None;
        for receipt in receipts {
            if build_receipt_agent_id(receipt) != Some(subagent_id.as_str()) {
                continue;
            }
            match receipt.kind {
                BuildReceiptKind::AgentStarted => saw_started = true,
                BuildReceiptKind::AgentCompleted
                    if receipt.data.get("status").and_then(|v| v.as_str()) != Some("running") =>
                {
                    latest_completed = Some(receipt);
                }
                BuildReceiptKind::ReviewCompleted | BuildReceiptKind::VerificationCompleted
                    if receipt.confidence != BuildReceiptConfidence::ModelDeclared =>
                {
                    latest_completed = Some(receipt);
                }
                _ => {}
            }
        }
        if let Some(receipt) = latest_completed {
            return blocker_cleared(
                "Blocker cleared; referenced Agent now has a terminal trusted receipt.",
                Some(receipt),
                Some(subagent_id),
            );
        }
        if saw_started {
            return BuildBlockerRecheckResult {
                checked: true,
                cleared: false,
                message: format!(
                    "Still blocked: referenced Agent {} has not produced a terminal receipt.",
                    subagent_id
                ),
                matched_receipt_id: None,
                matched_subagent_id: Some(subagent_id.clone()),
            };
        }
    }

    BuildBlockerRecheckResult {
        checked: true,
        cleared: false,
        message: "Still blocked: no trusted receipt proves this blocker is stale.".into(),
        matched_receipt_id: None,
        matched_subagent_id: candidate_ids.into_iter().next(),
    }
}

fn blocker_cleared(
    message: &str,
    receipt: Option<&BuildReceipt>,
    subagent_id: Option<&str>,
) -> BuildBlockerRecheckResult {
    BuildBlockerRecheckResult {
        checked: true,
        cleared: true,
        message: message.into(),
        matched_receipt_id: receipt.map(|r| r.receipt_id.clone()),
        matched_subagent_id: subagent_id.map(ToOwned::to_owned),
    }
}

fn latest_trusted_receipt(
    receipts: &[BuildReceipt],
    kind: BuildReceiptKind,
) -> Option<&BuildReceipt> {
    receipts
        .iter()
        .rev()
        .find(|receipt| trusted_receipt_satisfies_gate(receipt, kind.clone()))
}

fn trusted_receipt_satisfies_gate(receipt: &BuildReceipt, kind: BuildReceiptKind) -> bool {
    if receipt.kind != kind || receipt.confidence == BuildReceiptConfidence::ModelDeclared {
        return false;
    }
    match kind {
        BuildReceiptKind::ReviewCompleted | BuildReceiptKind::VerificationCompleted => {
            receipt
                .data
                .get("gateEvidence")
                .and_then(|v| v.get("accepted"))
                .and_then(|v| v.as_bool())
                == Some(true)
        }
        _ => true,
    }
}

fn collect_blocker_candidate_agent_ids(blocker: &str, receipts: &[BuildReceipt]) -> Vec<String> {
    let mut ids = Vec::new();
    push_unique_ids(&mut ids, uuid_like_ids(blocker));
    for receipt in receipts.iter().rev() {
        if receipt.kind != BuildReceiptKind::BlockerOpened || receipt.summary != blocker {
            continue;
        }
        collect_candidate_ids_from_json(&mut ids, &receipt.data);
        break;
    }
    ids
}

fn collect_candidate_ids_from_json(ids: &mut Vec<String>, value: &serde_json::Value) {
    match value {
        serde_json::Value::String(s) => push_unique_ids(ids, uuid_like_ids(s)),
        serde_json::Value::Array(values) => {
            for value in values {
                collect_candidate_ids_from_json(ids, value);
            }
        }
        serde_json::Value::Object(map) => {
            for value in map.values() {
                collect_candidate_ids_from_json(ids, value);
            }
        }
        _ => {}
    }
}

fn push_unique_ids(ids: &mut Vec<String>, candidates: Vec<String>) {
    for candidate in candidates {
        if !ids.iter().any(|seen| seen == &candidate) {
            ids.push(candidate);
        }
    }
}

fn uuid_like_ids(text: &str) -> Vec<String> {
    text.split(|c: char| !(c.is_ascii_hexdigit() || c == '-'))
        .filter(|part| is_uuid_like(part))
        .map(ToOwned::to_owned)
        .collect()
}

fn is_uuid_like(s: &str) -> bool {
    if s.len() != 36 {
        return false;
    }
    s.chars().enumerate().all(|(idx, c)| match idx {
        8 | 13 | 18 | 23 => c == '-',
        _ => c.is_ascii_hexdigit(),
    })
}

fn plan_hash(text: &str) -> String {
    let digest = Sha256::digest(text.as_bytes());
    format!("{:x}", digest)
}

fn mark_code_changed_requires_fresh_gates(state: &mut BuildRunState, invalidate_checkpoint: bool) {
    state.code_changed = true;
    state.review_required = true;
    state.review_satisfied = false;
    state.verification_required = true;
    state.verification_satisfied = false;
    if state.preview_required {
        state.preview_satisfied = false;
    }
    if invalidate_checkpoint {
        state.checkpoint_id = None;
    }
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
    build_git_command(cwd, args)
        .output()
        .map(|out| out.status.success())
        .unwrap_or(false)
}

fn git_output_lines(cwd: &Path, args: &[&str]) -> Vec<String> {
    build_git_command(cwd, args)
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
    if build_receipt_path_matches(
        absolute.to_string_lossy().as_ref(),
        scratchboard_path.to_string_lossy().as_ref(),
    ) {
        return true;
    }
    if normalized == "build.md"
        && is_build_evidence_log_path_for_scratchboard(&absolute, scratchboard_path)
    {
        return true;
    }
    let Ok(absolute_canon) = std::fs::canonicalize(&absolute) else {
        return false;
    };
    let Ok(scratchboard_canon) = std::fs::canonicalize(scratchboard_path) else {
        return false;
    };
    build_receipt_path_matches(
        absolute_canon.to_string_lossy().as_ref(),
        scratchboard_canon.to_string_lossy().as_ref(),
    )
}

fn latest_checkpoint_worktree_fingerprint(
    store_base: &Path,
    tab_id: &str,
    run_id: &str,
    checkpoint_id: &str,
) -> Result<Option<String>, String> {
    let receipts = crate::build_store::read_receipts(store_base, tab_id, run_id)?;
    Ok(receipts
        .iter()
        .rev()
        .find(|receipt| {
            receipt.kind == BuildReceiptKind::CheckpointCreated
                && receipt
                    .data
                    .get("checkpointId")
                    .and_then(|v| v.as_str())
                    .map(|id| id == checkpoint_id)
                    .unwrap_or(false)
        })
        .and_then(|receipt| {
            receipt
                .data
                .get("buildWorktreeFingerprint")
                .or_else(|| receipt.data.get("worktreeFingerprint"))
                .and_then(|v| v.as_str())
                .map(ToOwned::to_owned)
        }))
}

fn maybe_attach_build_worktree_fingerprint(
    receipt: &mut BuildReceipt,
    is_local: bool,
    state: &BuildRunState,
) {
    if !is_local {
        return;
    }
    let Ok(Some(fingerprint)) = local_build_worktree_fingerprint(
        Path::new(&state.cwd),
        Path::new(&state.scratchboard_path),
    ) else {
        return;
    };
    if let serde_json::Value::Object(ref mut map) = receipt.data {
        map.insert(
            "buildWorktreeFingerprint".into(),
            serde_json::Value::String(fingerprint),
        );
    }
}

fn local_build_worktree_fingerprint(
    cwd: &Path,
    scratchboard_path: &Path,
) -> Result<Option<String>, String> {
    if !cwd.exists() {
        return Ok(None);
    }
    if !git_command_success(cwd, &["rev-parse", "--is-inside-work-tree"]) {
        return Ok(None);
    }
    let repo_root = git_output_text(cwd, &["rev-parse", "--show-toplevel"])?
        .trim()
        .to_string();
    let repo_root = PathBuf::from(repo_root);
    let mut hasher = Sha256::new();
    hasher.update(b"shellx-build-worktree-fingerprint-v1\0");
    if let Ok(head) = git_output_bytes(&repo_root, &["rev-parse", "HEAD"]) {
        hasher.update(b"head\0");
        hasher.update(&head);
        hasher.update(b"\0");
    }
    for (label, args) in [
        ("unstaged", &["diff", "--binary", "--"][..]),
        ("staged", &["diff", "--cached", "--binary", "--"][..]),
    ] {
        let output = git_output_bytes(&repo_root, args)?;
        hasher.update(label.as_bytes());
        hasher.update(b"\0");
        hasher.update(Sha256::digest(&output));
        hasher.update(b"\0");
    }
    for rel in git_output_nul_paths(
        &repo_root,
        &["ls-files", "--others", "--exclude-standard", "-z"],
    )? {
        if is_build_internal_git_path(&repo_root, &rel, scratchboard_path) {
            continue;
        }
        let path = repo_root.join(&rel);
        let metadata = match std::fs::symlink_metadata(&path) {
            Ok(m) => m,
            Err(_) => continue,
        };
        hasher.update(b"untracked\0");
        hasher.update(rel.as_bytes());
        hasher.update(b"\0");
        let file_type = metadata.file_type();
        if file_type.is_symlink() {
            hasher.update(b"symlink\0");
            if let Ok(target) = std::fs::read_link(&path) {
                hasher.update(target.to_string_lossy().as_bytes());
            }
            hasher.update(b"\0");
        } else if file_type.is_file() {
            let (size, digest) = sha256_file_hex(&path)?;
            hasher.update(b"file\0");
            hasher.update(size.to_string().as_bytes());
            hasher.update(b"\0");
            hasher.update(digest.as_bytes());
            hasher.update(b"\0");
        } else {
            hasher.update(b"other\0");
        }
    }
    Ok(Some(format!("{:x}", hasher.finalize())))
}

fn sha256_file_hex(path: &Path) -> Result<(u64, String), String> {
    use std::io::Read;
    let mut file =
        std::fs::File::open(path).map_err(|e| format!("open {} failed: {}", path.display(), e))?;
    let mut hasher = Sha256::new();
    let mut total = 0u64;
    let mut buf = vec![0u8; 64 * 1024].into_boxed_slice();
    loop {
        let n = file
            .read(&mut buf)
            .map_err(|e| format!("read {} failed: {}", path.display(), e))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        total = total.saturating_add(n as u64);
    }
    Ok((total, format!("{:x}", hasher.finalize())))
}

fn git_output_bytes(cwd: &Path, args: &[&str]) -> Result<Vec<u8>, String> {
    let out = build_git_command(cwd, args)
        .output()
        .map_err(|e| format!("git {:?} spawn failed: {}", args, e))?;
    if out.status.success() {
        Ok(out.stdout)
    } else {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        Err(format!(
            "git {:?} exited {:?}: {}",
            args,
            out.status.code(),
            stderr
        ))
    }
}

fn build_git_command(cwd: &Path, args: &[&str]) -> std::process::Command {
    let mut cmd = std::process::Command::new("git");
    cmd.args(crate::session_git::hardened_git_args_for_str(args))
        .current_dir(cwd);
    crate::session_git::apply_git_hardening_env_std(&mut cmd);
    #[cfg(target_os = "windows")]
    {
        use crate::winproc::NoWindowExt as _;
        cmd.no_window();
    }
    cmd
}

fn git_output_text(cwd: &Path, args: &[&str]) -> Result<String, String> {
    String::from_utf8(git_output_bytes(cwd, args)?)
        .map_err(|e| format!("git {:?} returned non-UTF8 stdout: {}", args, e))
}

fn git_output_nul_paths(cwd: &Path, args: &[&str]) -> Result<Vec<String>, String> {
    let mut paths: Vec<String> = git_output_bytes(cwd, args)?
        .split(|b| *b == 0)
        .filter(|part| !part.is_empty())
        .filter_map(|part| String::from_utf8(part.to_vec()).ok())
        .collect();
    paths.sort();
    Ok(paths)
}

fn checkpoint_receipt_has_changes(data: &serde_json::Value) -> bool {
    if data.get("agentCodeChange").and_then(|v| v.as_bool()) == Some(true) {
        return true;
    }
    ["staged", "unstaged", "untracked", "conflicts"]
        .iter()
        .filter_map(|key| data.get(*key).and_then(|v| v.as_u64()))
        .any(|n| n > 0)
}

fn checkpoint_receipt_requires_fresh_gates(
    data: &serde_json::Value,
    state: &BuildRunState,
) -> bool {
    if !checkpoint_receipt_has_changes(data) {
        return false;
    }
    if !state.code_changed {
        return true;
    }
    data.get("checkpointId")
        .and_then(|v| v.as_str())
        .map(|id| {
            id.contains("agent-implementer-complete") || id.contains("agent-test-writer-complete")
        })
        .unwrap_or(false)
}

fn checkpoint_receipt_repeats_current_checkpoint_fingerprint(
    store_base: &Path,
    data: &serde_json::Value,
    state: &BuildRunState,
) -> bool {
    let Some(current_checkpoint_id) = state.checkpoint_id.as_deref() else {
        return false;
    };
    let Some(new_fingerprint) = data
        .get("buildWorktreeFingerprint")
        .or_else(|| data.get("worktreeFingerprint"))
        .and_then(|v| v.as_str())
    else {
        return false;
    };
    latest_checkpoint_worktree_fingerprint(
        store_base,
        &state.tab_id,
        &state.run_id,
        current_checkpoint_id,
    )
    .ok()
    .flatten()
    .as_deref()
        == Some(new_fingerprint)
}

fn build_has_in_flight_agent(receipts: &[BuildReceipt]) -> bool {
    !build_in_flight_agent_summaries(receipts).is_empty()
}

fn build_in_flight_agent_summaries(receipts: &[BuildReceipt]) -> Vec<String> {
    let mut started: Vec<(Option<String>, String)> = Vec::new();
    for receipt in receipts {
        match receipt.kind {
            BuildReceiptKind::AgentStarted => {
                started.push((
                    build_receipt_agent_id(receipt).map(ToOwned::to_owned),
                    build_receipt_agent_summary(receipt),
                ));
            }
            BuildReceiptKind::AgentCompleted => {
                if build_receipt_agent_status(receipt) == Some("running") {
                    continue;
                }
                if let Some(id) = build_receipt_agent_id(receipt) {
                    if let Some(pos) = started
                        .iter()
                        .position(|(started_id, _)| started_id.as_deref() == Some(id))
                    {
                        started.remove(pos);
                    }
                } else if let Some(pos) = started
                    .iter()
                    .position(|(started_id, _)| started_id.is_none())
                {
                    started.remove(pos);
                }
            }
            _ => {}
        }
    }
    started.into_iter().map(|(_, summary)| summary).collect()
}

fn build_in_flight_agent_ids(receipts: &[BuildReceipt]) -> Vec<String> {
    let mut started: Vec<Option<String>> = Vec::new();
    for receipt in receipts {
        match receipt.kind {
            BuildReceiptKind::AgentStarted => {
                started.push(build_receipt_agent_id(receipt).map(ToOwned::to_owned));
            }
            BuildReceiptKind::AgentCompleted => {
                if build_receipt_agent_status(receipt) == Some("running") {
                    continue;
                }
                if let Some(id) = build_receipt_agent_id(receipt) {
                    if let Some(pos) = started
                        .iter()
                        .position(|started_id| started_id.as_deref() == Some(id))
                    {
                        started.remove(pos);
                    }
                } else if let Some(pos) = started.iter().position(|started_id| started_id.is_none())
                {
                    started.remove(pos);
                }
            }
            _ => {}
        }
    }
    started.into_iter().flatten().collect()
}

fn build_receipt_agent_id(receipt: &BuildReceipt) -> Option<&str> {
    receipt
        .data
        .get("subagentId")
        .or_else(|| receipt.data.get("subagent_id"))
        .and_then(|v| v.as_str())
}

fn build_receipt_agent_status(receipt: &BuildReceipt) -> Option<&str> {
    receipt.data.get("status").and_then(|v| v.as_str())
}

fn build_receipt_agent_summary(receipt: &BuildReceipt) -> String {
    let persona = receipt
        .data
        .get("persona")
        .and_then(|v| v.as_str())
        .unwrap_or("agent");
    let subagent_id = build_receipt_agent_id(receipt).unwrap_or("unknown");
    format!("{} {}", persona, subagent_id)
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

    fn approvable_build_plan() -> &'static str {
        r#"# Build: test

Status: AWAITING_APPROVAL

## Phase 1 - Plan
- [ ] planned

## Phase 2 - Review
- [ ] Reviewer must run an AI slop / wiring audit: unwired UI controls, placeholder/mock code, fake success paths, missing frontend/backend bridges, config/schema drift, and release-debug leaks
"#
    }

    fn receipt(
        state: &BuildRunState,
        kind: BuildReceiptKind,
        confidence: BuildReceiptConfidence,
    ) -> BuildReceipt {
        let data = match kind {
            BuildReceiptKind::ReviewCompleted => json!({
                "checkpointId": "cp-1",
                "persona": "reviewer",
                "status": "completed",
                "stdoutChars": 420,
                "gateEvidence": {
                    "accepted": true,
                    "reason": "review report shape matched",
                    "matchedMarkers": ["review", "summary", "finding"],
                    "stdoutChars": 420
                }
            }),
            BuildReceiptKind::VerificationCompleted => json!({
                "checkpointId": "cp-1",
                "persona": "verifier",
                "status": "completed",
                "stdoutChars": 420,
                "gateEvidence": {
                    "accepted": true,
                    "reason": "verification report shape matched",
                    "matchedMarkers": ["verification", "behavior evidence", "gaps"],
                    "stdoutChars": 420
                }
            }),
            _ => json!({ "checkpointId": "cp-1" }),
        };
        BuildReceipt {
            receipt_id: new_receipt_id(),
            run_id: state.run_id.clone(),
            tab_id: state.tab_id.clone(),
            kind,
            created_at_ms: now_ms(),
            actor: "test".into(),
            summary: "ok".into(),
            confidence,
            data,
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
        assert_eq!(
            BuildOrchestrator::parse_build_command("/goal ship it").as_deref(),
            Some("ship it")
        );
    }

    #[test]
    fn plan_kickoff_text_is_plan_only() {
        let text = BuildOrchestrator::plan_kickoff_text("change code");
        assert!(text.contains("Scratchboard path:"));
        assert!(text.contains("Status: AWAITING_APPROVAL"));
        assert!(text.contains("Status: TODO"));
        assert!(text.contains("Do not execute any phase yet"));
        assert!(text.contains("build_complete"));
        assert!(text.contains("Do not invent `Status: COMPLETE`"));
        assert!(text.contains("Do not call Grok"));
        assert!(
            text.contains("native write/edit file tool")
                && text.contains("WSL/SSH")
                && text.contains("instead of opening a blocker"),
            "build kickoff should steer POSIX scratchboard writes away from host fs_write"
        );
        assert!(
            text.contains("test-writer"),
            "build kickoff should advertise a dedicated test-writing persona"
        );
        assert!(
            text.contains("AI slop / wiring audit") && text.contains("fake success paths"),
            "build kickoff should require the slop/wiring review pass"
        );
        assert!(
            text.contains("wait=true"),
            "build kickoff should steer sequential agent phases toward wait=true"
        );
        assert!(
            text.contains("wait=false"),
            "build kickoff should reserve wait=false for real fan-out"
        );
        assert!(
            text.contains("Establish git baseline")
                && text.contains("git rev-parse --show-toplevel")
                && text.contains("git init")
                && text.contains("git status --short"),
            "build kickoff should require a git baseline task"
        );
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

    #[test]
    fn build_fingerprint_ignores_scratchboard_content() {
        let cwd = temp_base("build-fingerprint-cwd");
        run_git(&cwd, &["init"]);
        run_git(
            &cwd,
            &["config", "user.email", "shellx-test@example.invalid"],
        );
        run_git(&cwd, &["config", "user.name", "shellX Test"]);
        std::fs::write(cwd.join("index.mjs"), "export const label = 'before';\n").unwrap();
        run_git(&cwd, &["add", "index.mjs"]);
        run_git(&cwd, &["commit", "-m", "initial"]);

        let scratchboard = cwd.join("build.tab1.abcdef.md");
        std::fs::write(&scratchboard, "# Build: test\n\nStatus: IN_PROGRESS\n").unwrap();
        let first = local_build_worktree_fingerprint(&cwd, &scratchboard)
            .unwrap()
            .expect("fingerprint");
        std::fs::write(
            &scratchboard,
            "# Build: test\n\nStatus: IN_PROGRESS\n\n## Phase\n- [x] done\n",
        )
        .unwrap();
        let second = local_build_worktree_fingerprint(&cwd, &scratchboard)
            .unwrap()
            .expect("fingerprint");
        assert_eq!(
            first, second,
            "scratchboard-only edits should not stale build checkpoints"
        );

        std::fs::create_dir_all(cwd.join("dist")).unwrap();
        std::fs::write(cwd.join("dist/release-summary.json"), "{}\n").unwrap();
        let third = local_build_worktree_fingerprint(&cwd, &scratchboard)
            .unwrap()
            .expect("fingerprint");
        assert_ne!(
            second, third,
            "non-scratchboard release artifacts should remain part of the build fingerprint"
        );
        let _ = std::fs::remove_dir_all(cwd);
    }

    #[tokio::test]
    async fn local_build_complete_uses_build_fingerprint_not_generic_session_fingerprint() {
        let cwd = temp_base("local-complete-build-fp-cwd");
        let store = temp_base("local-complete-build-fp-store");
        run_git(&cwd, &["init"]);
        run_git(
            &cwd,
            &["config", "user.email", "shellx-test@example.invalid"],
        );
        run_git(&cwd, &["config", "user.name", "shellX Test"]);
        std::fs::write(cwd.join("index.mjs"), "export const label = 'before';\n").unwrap();
        run_git(&cwd, &["add", "index.mjs"]);
        run_git(&cwd, &["commit", "-m", "initial"]);

        let orch = BuildOrchestrator::new(store.clone());
        let state = orch.start_run("tab1", "test", &cwd, "local").await.unwrap();
        std::fs::write(&state.scratchboard_path, complete_board()).unwrap();
        {
            let mut map = orch.states.write().await;
            map.get_mut("tab1").unwrap().state.status = BuildRunStatus::Active;
        }

        std::fs::write(cwd.join("index.mjs"), "export const label = 'after';\n").unwrap();
        std::fs::create_dir_all(cwd.join("dist")).unwrap();
        std::fs::write(cwd.join("dist/release-summary.json"), "{}\n").unwrap();
        let mut checkpoint = receipt(
            &state,
            BuildReceiptKind::CheckpointCreated,
            BuildReceiptConfidence::TrustedHost,
        );
        checkpoint.data = json!({
            "checkpointId": "cp-local-build-fp",
            "staged": 0,
            "unstaged": 1,
            "untracked": 1,
        });
        orch.append_receipt(checkpoint).await.unwrap();
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

        std::fs::write(
            &state.scratchboard_path,
            format!(
                "{}\n<!-- final scratchboard-only edit -->\n",
                complete_board()
            ),
        )
        .unwrap();
        let checkpoint_fingerprint = latest_checkpoint_worktree_fingerprint(
            &store,
            "tab1",
            &state.run_id,
            "cp-local-build-fp",
        )
        .unwrap()
        .expect("checkpoint fingerprint");
        let generic_fingerprint = crate::session_git::local_worktree_fingerprint(&cwd)
            .unwrap()
            .expect("generic fingerprint");
        assert_ne!(
            checkpoint_fingerprint, generic_fingerprint,
            "the generic session fingerprint includes scratchboard-only edits"
        );

        orch.validate_complete_with_current_fingerprint("tab1", "done", Some(generic_fingerprint))
            .await
            .unwrap();
        assert_eq!(
            orch.get_state("tab1").await.unwrap().status,
            BuildRunStatus::Complete
        );

        let _ = std::fs::remove_dir_all(cwd);
        let _ = std::fs::remove_dir_all(store);
    }

    #[tokio::test]
    async fn late_receipts_do_not_reopen_terminal_builds() {
        let cwd = temp_base("late-receipt-cwd");
        let store = temp_base("late-receipt-store");
        let orch = BuildOrchestrator::new(store.clone());
        let state = orch.start_run("tab1", "test", &cwd, "local").await.unwrap();
        {
            let mut map = orch.states.write().await;
            map.get_mut("tab1").unwrap().state.status = BuildRunStatus::Complete;
        }

        let mut blocker = receipt(
            &state,
            BuildReceiptKind::BlockerOpened,
            BuildReceiptConfidence::ModelDeclared,
        );
        blocker.summary = "late post-complete blocker".into();
        orch.append_receipt(blocker).await.unwrap();

        let current = orch.get_state("tab1").await.unwrap();
        assert_eq!(current.status, BuildRunStatus::Complete);
        assert_eq!(current.open_blocker, None);

        let _ = std::fs::remove_dir_all(cwd);
        let _ = std::fs::remove_dir_all(store);
    }

    #[tokio::test]
    async fn agent_completion_clears_matching_in_flight_agent_blocker() {
        let cwd = temp_base("agent-blocker-cwd");
        let store = temp_base("agent-blocker-store");
        let orch = BuildOrchestrator::new(store.clone());
        let state = orch.start_run("tab1", "test", &cwd, "local").await.unwrap();
        let subagent_id = "2c76d5b3-27fb-4bbb-9d28-d7bde7dd8dc6";

        let mut blocker = receipt(
            &state,
            BuildReceiptKind::BlockerOpened,
            BuildReceiptConfidence::ModelDeclared,
        );
        blocker.summary =
            format!("blocked by in-flight Agent {subagent_id} still running with 0 stdout");
        orch.append_receipt(blocker).await.unwrap();

        let blocked = orch.get_state("tab1").await.unwrap();
        assert_eq!(blocked.status, BuildRunStatus::Blocked);
        assert!(blocked
            .open_blocker
            .as_deref()
            .unwrap()
            .contains(subagent_id));

        let mut completed = receipt(
            &state,
            BuildReceiptKind::AgentCompleted,
            BuildReceiptConfidence::TrustedHost,
        );
        completed.data = json!({
            "subagentId": subagent_id,
            "status": "completed",
            "exitCode": 0
        });
        orch.append_receipt(completed).await.unwrap();

        let current = orch.get_state("tab1").await.unwrap();
        assert_eq!(current.status, BuildRunStatus::Active);
        assert_eq!(current.open_blocker, None);

        let _ = std::fs::remove_dir_all(cwd);
        let _ = std::fs::remove_dir_all(store);
    }

    #[tokio::test]
    async fn trusted_agent_start_after_blocker_marks_build_active() {
        let cwd = temp_base("agent-progress-clears-blocker-cwd");
        let store = temp_base("agent-progress-clears-blocker-store");
        let orch = BuildOrchestrator::new(store.clone());
        let state = orch.start_run("tab1", "test", &cwd, "local").await.unwrap();

        let mut blocker = receipt(
            &state,
            BuildReceiptKind::BlockerOpened,
            BuildReceiptConfidence::ModelDeclared,
        );
        blocker.summary = "reviewer Agent spawn failed; waiting for operator action".into();
        orch.append_receipt(blocker).await.unwrap();

        let mut started = receipt(
            &state,
            BuildReceiptKind::AgentStarted,
            BuildReceiptConfidence::TrustedHost,
        );
        started.summary = "implementer Agent started: next build stage".into();
        started.data = json!({
            "subagentId": "agent-2",
            "persona": "implementer",
            "status": "running"
        });
        orch.append_receipt(started).await.unwrap();

        let current = orch.get_state("tab1").await.unwrap();
        assert_eq!(current.status, BuildRunStatus::Active);
        assert_eq!(current.open_blocker, None);

        let _ = std::fs::remove_dir_all(cwd);
        let _ = std::fs::remove_dir_all(store);
    }

    #[tokio::test]
    async fn operator_notes_are_injected_once_on_next_build_continuation() {
        let cwd = temp_base("operator-note-cwd");
        let store = temp_base("operator-note-store");
        let orch = BuildOrchestrator::new(store.clone());
        let state = orch.start_run("tab1", "test", &cwd, "local").await.unwrap();
        std::fs::write(
            &state.scratchboard_path,
            "# Build: test\n\nStatus: IN_PROGRESS\n\n## Phase\nStatus: IN_PROGRESS\n- [ ] next\n",
        )
        .unwrap();
        {
            let mut map = orch.states.write().await;
            map.get_mut("tab1").unwrap().state.status = BuildRunStatus::Active;
        }

        let note = orch
            .add_operator_note("tab1", "Use the simpler fill tolerance first.")
            .await
            .unwrap();
        assert!(note.note_id.starts_with("bon-"));

        let queued = orch.get_state("tab1").await.unwrap();
        assert_eq!(queued.pending_operator_notes.len(), 1);

        let prompt = orch.consider_continue("tab1", "end_turn").await.unwrap();
        assert!(prompt.contains("<operator_notes>"));
        assert!(prompt.contains("Use the simpler fill tolerance first."));

        let drained = orch.get_state("tab1").await.unwrap();
        assert!(drained.pending_operator_notes.is_empty());

        let next_prompt = orch.consider_continue("tab1", "end_turn").await.unwrap();
        assert!(!next_prompt.contains("<operator_notes>"));

        let _ = std::fs::remove_dir_all(cwd);
        let _ = std::fs::remove_dir_all(store);
    }

    #[tokio::test]
    async fn recheck_blocker_clears_satisfied_review_gate_blocker() {
        let cwd = temp_base("recheck-review-blocker-cwd");
        let store = temp_base("recheck-review-blocker-store");
        let orch = BuildOrchestrator::new(store.clone());
        let state = orch.start_run("tab1", "test", &cwd, "local").await.unwrap();

        let mut blocker = receipt(
            &state,
            BuildReceiptKind::BlockerOpened,
            BuildReceiptConfidence::ModelDeclared,
        );
        blocker.summary = "reviewer gate blocked by timed out reviewer".into();
        orch.append_receipt(blocker).await.unwrap();

        let mut review = receipt(
            &state,
            BuildReceiptKind::ReviewCompleted,
            BuildReceiptConfidence::TrustedHost,
        );
        review.summary = "replacement reviewer completed".into();
        orch.append_receipt(review).await.unwrap();

        let result = orch.recheck_blocker("tab1").await.unwrap();
        assert!(result.checked);
        assert!(result.cleared);
        assert!(result.message.contains("Blocker cleared"));

        let current = orch.get_state("tab1").await.unwrap();
        assert_eq!(current.status, BuildRunStatus::Active);
        assert_eq!(current.open_blocker, None);

        let receipts = orch.get_receipts("tab1").await.unwrap();
        assert!(receipts
            .iter()
            .any(|r| r.kind == BuildReceiptKind::BlockerResolved
                && r.actor == "shellx"
                && r.summary.contains("Rechecked blocker")));

        let _ = std::fs::remove_dir_all(cwd);
        let _ = std::fs::remove_dir_all(store);
    }

    #[tokio::test]
    async fn recheck_blocker_keeps_running_agent_blocker() {
        let cwd = temp_base("recheck-running-agent-cwd");
        let store = temp_base("recheck-running-agent-store");
        let orch = BuildOrchestrator::new(store.clone());
        let state = orch.start_run("tab1", "test", &cwd, "local").await.unwrap();
        let subagent_id = "7f6b8b33-29fe-4811-85b3-1fefc870b7a0";

        let mut started = receipt(
            &state,
            BuildReceiptKind::AgentStarted,
            BuildReceiptConfidence::TrustedHost,
        );
        started.data = json!({
            "subagentId": subagent_id,
            "persona": "reviewer",
            "status": "running"
        });
        orch.append_receipt(started).await.unwrap();

        let mut blocker = receipt(
            &state,
            BuildReceiptKind::BlockerOpened,
            BuildReceiptConfidence::ModelDeclared,
        );
        blocker.summary =
            format!("blocked by in-flight Agent {subagent_id} still running with 0 stdout");
        orch.append_receipt(blocker).await.unwrap();

        let result = orch.recheck_blocker("tab1").await.unwrap();
        assert!(result.checked);
        assert!(!result.cleared);
        assert!(result.message.contains("Still blocked"));

        let current = orch.get_state("tab1").await.unwrap();
        assert_eq!(current.status, BuildRunStatus::Blocked);
        assert!(current
            .open_blocker
            .as_deref()
            .unwrap()
            .contains(subagent_id));

        let _ = std::fs::remove_dir_all(cwd);
        let _ = std::fs::remove_dir_all(store);
    }

    #[tokio::test]
    async fn approve_build_plan_hashes_snapshot() {
        let cwd = temp_base("approve-cwd");
        let store = temp_base("approve-store");
        let orch = BuildOrchestrator::new(store.clone());
        let state = orch.start_run("tab1", "test", &cwd, "local").await.unwrap();
        let plan = approvable_build_plan();
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

    #[cfg(feature = "debug-api")]
    #[tokio::test]
    async fn release_test_clear_tab_removes_runtime_and_persisted_state() {
        let cwd = temp_base("release-clear-cwd");
        let store = temp_base("release-clear-store");
        let orch = BuildOrchestrator::new(store.clone());
        orch.start_run("release-build-run-owned", "test", &cwd, "local")
            .await
            .unwrap();
        assert!(orch.get_state("release-build-run-owned").await.is_some());

        orch.release_test_clear_tab("release-build-run-owned")
            .await
            .unwrap();

        assert!(orch.get_state("release-build-run-owned").await.is_none());
        let _ = std::fs::remove_dir_all(cwd);
        let _ = std::fs::remove_dir_all(store);
    }

    #[tokio::test]
    async fn start_run_stays_draft_until_valid_plan_written() {
        let cwd = temp_base("draft-plan-cwd");
        let store = temp_base("draft-plan-store");
        let orch = BuildOrchestrator::new(store.clone());
        let state = orch
            .start_run("tab-draft", "test", &cwd, "local")
            .await
            .unwrap();
        assert_eq!(state.status, BuildRunStatus::Draft);
        let stub = std::fs::read_to_string(&state.scratchboard_path).unwrap();
        assert!(stub.contains("Status: DRAFTING"));

        let mut stub_write = receipt(
            &state,
            BuildReceiptKind::FileWrite,
            BuildReceiptConfidence::ObservedAcp,
        );
        stub_write.data = json!({ "path": state.scratchboard_path.clone() });
        orch.append_receipt(stub_write).await.unwrap();
        let still_draft = orch.get_state("tab-draft").await.unwrap();
        assert_eq!(still_draft.status, BuildRunStatus::Draft);

        let plan = approvable_build_plan();
        std::fs::write(&still_draft.scratchboard_path, plan).unwrap();
        let mut plan_write = receipt(
            &still_draft,
            BuildReceiptKind::FileWrite,
            BuildReceiptConfidence::ObservedAcp,
        );
        plan_write.data = json!({ "path": still_draft.scratchboard_path.clone() });
        orch.append_receipt(plan_write).await.unwrap();
        let awaiting = orch.get_state("tab-draft").await.unwrap();
        assert_eq!(awaiting.status, BuildRunStatus::AwaitingApproval);

        let _ = std::fs::remove_dir_all(cwd);
        let _ = std::fs::remove_dir_all(store);
    }

    #[tokio::test]
    async fn draft_plan_poll_recovers_after_write_observation_race() {
        let cwd = temp_base("draft-plan-race-cwd");
        let store = temp_base("draft-plan-race-store");
        let orch = BuildOrchestrator::new(store.clone());
        let state = orch
            .start_run("tab-draft-race", "test", &cwd, "local")
            .await
            .unwrap();
        assert_eq!(state.status, BuildRunStatus::Draft);

        let mut early_write = receipt(
            &state,
            BuildReceiptKind::FileWrite,
            BuildReceiptConfidence::ObservedAcp,
        );
        early_write.data = json!({ "path": state.scratchboard_path.clone() });
        orch.append_receipt(early_write).await.unwrap();
        let still_draft = orch.get_state("tab-draft-race").await.unwrap();
        assert_eq!(still_draft.status, BuildRunStatus::Draft);

        std::fs::write(&still_draft.scratchboard_path, approvable_build_plan()).unwrap();
        let recovered = orch.get_state("tab-draft-race").await.unwrap();
        assert_eq!(recovered.status, BuildRunStatus::AwaitingApproval);

        let _ = std::fs::remove_dir_all(cwd);
        let _ = std::fs::remove_dir_all(store);
    }

    #[tokio::test]
    async fn approve_build_rejects_plan_without_slop_review_gate() {
        let cwd = temp_base("approve-noslop-cwd");
        let store = temp_base("approve-noslop-store");
        let orch = BuildOrchestrator::new(store.clone());
        let state = orch
            .start_run("tab-noslop", "test", &cwd, "local")
            .await
            .unwrap();
        let plan = r#"# Build: test

Status: AWAITING_APPROVAL

## Phase 1 - Plan
- [ ] planned

## Phase 2 - Review
- [ ] Reviewer checks code
"#;
        std::fs::write(&state.scratchboard_path, plan).unwrap();
        let err = orch.approve_plan("tab-noslop").await.unwrap_err();
        assert!(err.contains("AI slop / wiring audit"), "got: {}", err);
        let _ = std::fs::remove_dir_all(cwd);
        let _ = std::fs::remove_dir_all(store);
    }

    #[tokio::test]
    async fn plan_written_accepts_valid_tab_scoped_alias_path() {
        let cwd = temp_base("alias-plan-cwd");
        let store = temp_base("alias-plan-store");
        let orch = BuildOrchestrator::new(store.clone());
        let state = orch
            .start_run("build-live-023e", "test", &cwd, "local")
            .await
            .unwrap();
        let alias_path = cwd.join("build.build-live-023e.other-run-id.md");
        let plan = approvable_build_plan();
        std::fs::write(&alias_path, plan).unwrap();
        let mut write = receipt(
            &state,
            BuildReceiptKind::FileWrite,
            BuildReceiptConfidence::ObservedAcp,
        );
        write.data = json!({ "path": alias_path.to_string_lossy() });
        orch.append_receipt(write).await.unwrap();

        let updated = orch.get_state("build-live-023e").await.unwrap();
        assert_eq!(updated.status, BuildRunStatus::AwaitingApproval);
        assert_eq!(
            updated.scratchboard_path,
            alias_path.to_string_lossy().to_string()
        );
        assert!(
            !updated.code_changed,
            "scratchboard plan writes must not trip code-change gates"
        );
        let receipts = orch.get_receipts("build-live-023e").await.unwrap();
        let plan_receipt = receipts
            .iter()
            .find(|r| r.kind == BuildReceiptKind::PlanWritten)
            .expect("planWritten receipt");
        assert_eq!(
            plan_receipt
                .data
                .get("scratchboardAlias")
                .and_then(|v| v.as_bool()),
            Some(true)
        );

        assert!(orch.approve_plan("build-live-023e").await.unwrap());
        let approved = orch.get_state("build-live-023e").await.unwrap();
        assert_eq!(approved.status, BuildRunStatus::Active);
        assert_eq!(approved.approved_plan_hash, Some(plan_hash(plan)));
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
    async fn build_complete_rejects_weak_review_gate_receipt() {
        let cwd = temp_base("weak-review-cwd");
        let store = temp_base("weak-review-store");
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
        let mut weak_review = receipt(
            &state,
            BuildReceiptKind::ReviewCompleted,
            BuildReceiptConfidence::TrustedHost,
        );
        weak_review.data = json!({
            "persona": "reviewer",
            "status": "completed",
            "stdoutChars": 2,
            "gateEvidence": {
                "accepted": false,
                "reason": "too little reviewer output",
                "matchedMarkers": [],
                "stdoutChars": 2
            }
        });
        orch.append_receipt(weak_review).await.unwrap();
        orch.append_receipt(receipt(
            &state,
            BuildReceiptKind::VerificationCompleted,
            BuildReceiptConfidence::TrustedHost,
        ))
        .await
        .unwrap();

        let updated = orch.get_state("tab1").await.unwrap();
        assert!(
            !updated.review_satisfied,
            "weak reviewer output must not satisfy review gate"
        );
        let err = orch.validate_complete("tab1", "done").await.unwrap_err();
        assert!(err.contains("reviewer receipt"), "got: {}", err);
        assert!(err.contains("evidence"), "got: {}", err);

        let _ = std::fs::remove_dir_all(cwd);
        let _ = std::fs::remove_dir_all(store);
    }

    #[tokio::test]
    async fn build_complete_rejects_weak_verification_gate_receipt() {
        let cwd = temp_base("weak-verification-cwd");
        let store = temp_base("weak-verification-store");
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
        let mut weak_verification = receipt(
            &state,
            BuildReceiptKind::VerificationCompleted,
            BuildReceiptConfidence::TrustedHost,
        );
        weak_verification.data = json!({
            "persona": "verifier",
            "status": "completed",
            "stdoutChars": 2,
            "gateEvidence": {
                "accepted": false,
                "reason": "too little verifier output",
                "matchedMarkers": [],
                "stdoutChars": 2
            }
        });
        orch.append_receipt(weak_verification).await.unwrap();

        let updated = orch.get_state("tab1").await.unwrap();
        assert!(
            !updated.verification_satisfied,
            "weak verifier output must not satisfy verification gate"
        );
        let err = orch.validate_complete("tab1", "done").await.unwrap_err();
        assert!(err.contains("verification receipt"), "got: {}", err);
        assert!(err.contains("evidence"), "got: {}", err);

        let _ = std::fs::remove_dir_all(cwd);
        let _ = std::fs::remove_dir_all(store);
    }

    #[tokio::test]
    async fn build_complete_rejects_missing_preview_gate_for_ui_work() {
        let cwd = temp_base("reject-preview-cwd");
        let store = temp_base("reject-preview-store");
        let orch = BuildOrchestrator::new(store.clone());
        let state = orch
            .start_run("tab1", "build a web page", &cwd, "local")
            .await
            .unwrap();
        assert!(state.preview_required);
        std::fs::write(&state.scratchboard_path, complete_board()).unwrap();
        {
            let mut map = orch.states.write().await;
            map.get_mut("tab1").unwrap().state.status = BuildRunStatus::Active;
        }
        let err = orch.validate_complete("tab1", "done").await.unwrap_err();
        assert!(err.contains("Preview Doctor"), "got: {}", err);

        let mut preview = receipt(
            &state,
            BuildReceiptKind::PreviewDiagnosed,
            BuildReceiptConfidence::TrustedHost,
        );
        preview.data = json!({
            "ok": true,
            "url": "http://localhost:12345/",
            "summary": "Preview Doctor passed"
        });
        orch.append_receipt(preview).await.unwrap();
        orch.validate_complete("tab1", "done").await.unwrap();

        let _ = std::fs::remove_dir_all(cwd);
        let _ = std::fs::remove_dir_all(store);
    }

    #[test]
    fn preview_gate_ignores_non_visual_browser_sdk_objectives() {
        assert!(!build_objective_requires_preview(
            "Create a standalone TypeScript package called shellx-browser-driver-sdk for the Browser Debug API over HTTP. No UI."
        ));
        assert!(!build_objective_requires_preview(
            "Build a browser automation SDK with CLI examples"
        ));
        assert!(build_objective_requires_preview("build a web page"));
        assert!(build_objective_requires_preview(
            "build a browser settings screen"
        ));
    }

    #[tokio::test]
    async fn browser_debug_api_sdk_build_can_complete_without_preview_gate() {
        let cwd = temp_base("browser-sdk-no-preview-cwd");
        let store = temp_base("browser-sdk-no-preview-store");
        let orch = BuildOrchestrator::new(store.clone());
        let state = orch
            .start_run(
                "tab1",
                "Create a standalone TypeScript package called shellx-browser-driver-sdk for the Browser Debug API over HTTP. No UI.",
                &cwd,
                "local",
            )
            .await
            .unwrap();
        assert!(
            !state.preview_required,
            "Browser Debug API SDK work must not require Preview Doctor"
        );
        std::fs::write(&state.scratchboard_path, complete_board()).unwrap();
        {
            let mut map = orch.states.write().await;
            map.get_mut("tab1").unwrap().state.status = BuildRunStatus::Active;
        }
        orch.validate_complete("tab1", "done").await.unwrap();

        let _ = std::fs::remove_dir_all(cwd);
        let _ = std::fs::remove_dir_all(store);
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
    async fn agent_checkpoint_marker_for_nongit_requires_review_and_verification() {
        let cwd = temp_base("agent-nongit-cwd");
        let store = temp_base("agent-nongit-store");
        let orch = BuildOrchestrator::new(store.clone());
        let state = orch.start_run("tab1", "test", &cwd, "local").await.unwrap();
        std::fs::write(&state.scratchboard_path, complete_board()).unwrap();
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
            "checkpointId": "agent-implementer-complete-nongit",
            "agentCodeChange": true,
            "checkpointUnavailable": true,
            "checkpointUnavailableReason": "git rev-parse failed",
        });
        orch.append_receipt(checkpoint).await.unwrap();

        let gated = orch.get_state("tab1").await.unwrap();
        assert!(gated.code_changed);
        assert_eq!(
            gated.checkpoint_id.as_deref(),
            Some("agent-implementer-complete-nongit")
        );
        assert!(gated.review_required);
        assert!(gated.verification_required);

        let err = orch.validate_complete("tab1", "done").await.unwrap_err();
        assert!(err.contains("reviewer receipt"), "got: {}", err);

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

        let _ = std::fs::remove_dir_all(cwd);
        let _ = std::fs::remove_dir_all(store);
    }

    #[tokio::test]
    async fn nonlocal_build_complete_rejects_without_current_fingerprint() {
        let cwd = temp_base("nonlocal-no-fingerprint-cwd");
        let store = temp_base("nonlocal-no-fingerprint-store");
        let orch = BuildOrchestrator::new(store.clone());
        let state = orch.start_run("tab1", "test", &cwd, "wsl").await.unwrap();
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
        let mut checkpoint = receipt(
            &state,
            BuildReceiptKind::CheckpointCreated,
            BuildReceiptConfidence::TrustedHost,
        );
        checkpoint.data = json!({
            "checkpointId": "cp-1",
            "staged": 1,
            "unstaged": 0,
            "untracked": 0,
            "worktreeFingerprint": "fp-1",
        });
        orch.append_receipt(checkpoint).await.unwrap();
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

        let err = orch.validate_complete("tab1", "done").await.unwrap_err();
        assert!(err.contains("current worktree fingerprint"), "got: {}", err);
        let _ = std::fs::remove_dir_all(cwd);
        let _ = std::fs::remove_dir_all(store);
    }

    #[tokio::test]
    async fn nonlocal_build_complete_accepts_matching_current_fingerprint() {
        let cwd = temp_base("nonlocal-matching-fingerprint-cwd");
        let store = temp_base("nonlocal-matching-fingerprint-store");
        let orch = BuildOrchestrator::new(store.clone());
        let state = orch.start_run("tab1", "test", &cwd, "ssh").await.unwrap();
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
        let mut checkpoint = receipt(
            &state,
            BuildReceiptKind::CheckpointCreated,
            BuildReceiptConfidence::TrustedHost,
        );
        checkpoint.data = json!({
            "checkpointId": "cp-1",
            "staged": 1,
            "unstaged": 0,
            "untracked": 0,
            "worktreeFingerprint": "fp-1",
        });
        orch.append_receipt(checkpoint).await.unwrap();
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

        orch.validate_complete_with_current_fingerprint("tab1", "done", Some("fp-1".into()))
            .await
            .unwrap();
        assert_eq!(
            orch.get_state("tab1").await.unwrap().status,
            BuildRunStatus::Complete
        );
        let _ = std::fs::remove_dir_all(cwd);
        let _ = std::fs::remove_dir_all(store);
    }

    #[tokio::test]
    async fn build_complete_rejects_stale_checkpoint_fingerprint() {
        let cwd = temp_base("stale-checkpoint-cwd");
        let store = temp_base("stale-checkpoint-store");
        run_git(&cwd, &["init"]);
        run_git(
            &cwd,
            &["config", "user.email", "shellx-test@example.invalid"],
        );
        run_git(&cwd, &["config", "user.name", "shellX Test"]);
        std::fs::write(cwd.join("message.txt"), "before\n").unwrap();
        run_git(&cwd, &["add", "message.txt"]);
        run_git(&cwd, &["commit", "-m", "initial"]);

        let orch = BuildOrchestrator::new(store.clone());
        let state = orch.start_run("tab1", "test", &cwd, "local").await.unwrap();
        std::fs::write(&state.scratchboard_path, complete_board()).unwrap();
        {
            let mut map = orch.states.write().await;
            map.get_mut("tab1").unwrap().state.status = BuildRunStatus::Active;
        }

        std::fs::write(cwd.join("message.txt"), "checkpointed\n").unwrap();
        let fingerprint = crate::session_git::local_worktree_fingerprint(&cwd)
            .unwrap()
            .expect("git fingerprint");
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
            "worktreeFingerprint": fingerprint,
        });
        orch.append_receipt(checkpoint).await.unwrap();
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

        std::fs::write(cwd.join("message.txt"), "changed after checkpoint\n").unwrap();
        let err = orch.validate_complete("tab1", "done").await.unwrap_err();
        assert!(err.contains("checkpoint receipt"), "got: {}", err);
        let updated = orch.get_state("tab1").await.unwrap();
        assert!(updated.checkpoint_id.is_none());
        assert!(!updated.review_satisfied);
        assert!(!updated.verification_satisfied);

        let _ = std::fs::remove_dir_all(cwd);
        let _ = std::fs::remove_dir_all(store);
    }

    #[tokio::test]
    async fn code_change_after_review_invalidates_completion_gates() {
        let cwd = temp_base("stale-gate-cwd");
        let store = temp_base("stale-gate-store");
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

        orch.append_receipt(receipt(
            &state,
            BuildReceiptKind::FileWrite,
            BuildReceiptConfidence::ObservedAcp,
        ))
        .await
        .unwrap();

        let updated = orch.get_state("tab1").await.unwrap();
        assert!(updated.checkpoint_id.is_none());
        assert!(!updated.review_satisfied);
        assert!(!updated.verification_satisfied);
        let err = orch.validate_complete("tab1", "done").await.unwrap_err();
        assert!(err.contains("checkpoint receipt"), "got: {}", err);

        let _ = std::fs::remove_dir_all(cwd);
        let _ = std::fs::remove_dir_all(store);
    }

    #[tokio::test]
    async fn build_evidence_log_write_does_not_invalidate_completion_gates() {
        let cwd = temp_base("evidence-log-cwd");
        let store = temp_base("evidence-log-store");
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

        let evidence_path = cwd.join("build.md");
        std::fs::write(
            &evidence_path,
            "# shellX Build Evidence Log\n\nBuild Mode scratchboard: build.tab1.test.md\n\nCall build_complete after gates pass.\n",
        )
        .unwrap();
        let mut evidence_write = receipt(
            &state,
            BuildReceiptKind::FileWrite,
            BuildReceiptConfidence::ObservedAcp,
        );
        evidence_write.data = json!({ "path": evidence_path.to_string_lossy() });
        orch.append_receipt(evidence_write).await.unwrap();

        let updated = orch.get_state("tab1").await.unwrap();
        assert_eq!(updated.checkpoint_id.as_deref(), Some("cp-1"));
        assert!(updated.review_satisfied);
        assert!(updated.verification_satisfied);
        let receipts = orch.get_receipts("tab1").await.unwrap();
        let evidence_receipt = receipts
            .iter()
            .rev()
            .find(|r| r.kind == BuildReceiptKind::FileWrite)
            .expect("evidence fileWrite receipt");
        assert_eq!(
            evidence_receipt
                .data
                .get("buildEvidenceLog")
                .and_then(|v| v.as_bool()),
            Some(true)
        );

        let _ = std::fs::remove_dir_all(cwd);
        let _ = std::fs::remove_dir_all(store);
    }

    #[test]
    fn git_dirty_check_ignores_recognized_build_evidence_log() {
        let cwd = temp_base("evidence-log-git-cwd");
        run_git(&cwd, &["init"]);
        run_git(
            &cwd,
            &["config", "user.email", "shellx-test@example.invalid"],
        );
        run_git(&cwd, &["config", "user.name", "shellX Test"]);
        std::fs::write(cwd.join("index.html"), "<h1>ok</h1>\n").unwrap();
        run_git(&cwd, &["add", "index.html"]);
        run_git(&cwd, &["commit", "-m", "initial"]);
        let scratchboard = cwd.join("build.tab1.abc123.md");
        std::fs::write(&scratchboard, complete_board()).unwrap();
        std::fs::write(
            cwd.join("build.md"),
            "# shellX Build Evidence Log\n\nBuild Mode scratchboard: build.tab1.abc123.md\n\nCall build_complete after gates pass.\n",
        )
        .unwrap();

        assert!(
            !local_git_worktree_has_code_changes(&cwd, &scratchboard),
            "recognized Build Mode evidence log should not dirty completion gates"
        );
        std::fs::write(cwd.join("notes.md"), "real code-adjacent change\n").unwrap();
        assert!(local_git_worktree_has_code_changes(&cwd, &scratchboard));

        let _ = std::fs::remove_dir_all(cwd);
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
    async fn bookkeeping_checkpoint_preserves_satisfied_gates() {
        let cwd = temp_base("checkpoint-bookkeeping-cwd");
        let store = temp_base("checkpoint-bookkeeping-store");
        let orch = BuildOrchestrator::new(store.clone());
        let state = orch.start_run("tab1", "test", &cwd, "wsl").await.unwrap();
        {
            let mut map = orch.states.write().await;
            let st = &mut map.get_mut("tab1").unwrap().state;
            st.status = BuildRunStatus::Active;
            st.code_changed = true;
            st.review_required = true;
            st.review_satisfied = true;
            st.verification_required = true;
            st.verification_satisfied = true;
            st.checkpoint_id = Some("cp-before".into());
        }

        let mut checkpoint = receipt(
            &state,
            BuildReceiptKind::CheckpointCreated,
            BuildReceiptConfidence::TrustedHost,
        );
        checkpoint.data = json!({
            "checkpointId": "post-verifier-reviewed-state",
            "staged": 0,
            "unstaged": 3,
            "untracked": 4,
            "conflicts": 0,
        });
        orch.append_receipt(checkpoint).await.unwrap();

        let updated = orch.get_state("tab1").await.unwrap();
        assert_eq!(
            updated.checkpoint_id.as_deref(),
            Some("post-verifier-reviewed-state")
        );
        assert!(updated.review_satisfied);
        assert!(updated.verification_satisfied);
        let _ = std::fs::remove_dir_all(cwd);
        let _ = std::fs::remove_dir_all(store);
    }

    #[tokio::test]
    async fn code_writer_checkpoint_requires_fresh_gates() {
        let cwd = temp_base("checkpoint-code-writer-cwd");
        let store = temp_base("checkpoint-code-writer-store");
        let orch = BuildOrchestrator::new(store.clone());
        let state = orch.start_run("tab1", "test", &cwd, "wsl").await.unwrap();
        {
            let mut map = orch.states.write().await;
            let st = &mut map.get_mut("tab1").unwrap().state;
            st.status = BuildRunStatus::Active;
            st.code_changed = true;
            st.review_required = true;
            st.review_satisfied = true;
            st.verification_required = true;
            st.verification_satisfied = true;
            st.checkpoint_id = Some("cp-before".into());
        }

        let mut checkpoint = receipt(
            &state,
            BuildReceiptKind::CheckpointCreated,
            BuildReceiptConfidence::TrustedHost,
        );
        checkpoint.data = json!({
            "checkpointId": "1779832326218-agent-test-writer-complete",
            "staged": 0,
            "unstaged": 3,
            "untracked": 4,
            "conflicts": 0,
        });
        orch.append_receipt(checkpoint).await.unwrap();

        let updated = orch.get_state("tab1").await.unwrap();
        assert_eq!(
            updated.checkpoint_id.as_deref(),
            Some("1779832326218-agent-test-writer-complete")
        );
        assert!(!updated.review_satisfied);
        assert!(!updated.verification_satisfied);
        let _ = std::fs::remove_dir_all(cwd);
        let _ = std::fs::remove_dir_all(store);
    }

    #[tokio::test]
    async fn no_op_test_writer_checkpoint_preserves_satisfied_gates() {
        let cwd = temp_base("checkpoint-test-writer-noop-cwd");
        let store = temp_base("checkpoint-test-writer-noop-store");
        let orch = BuildOrchestrator::new(store.clone());
        let state = orch.start_run("tab1", "test", &cwd, "wsl").await.unwrap();
        {
            let mut map = orch.states.write().await;
            let st = &mut map.get_mut("tab1").unwrap().state;
            st.status = BuildRunStatus::Active;
            st.code_changed = true;
            st.review_required = true;
            st.verification_required = true;
        }

        let mut implementation_checkpoint = receipt(
            &state,
            BuildReceiptKind::CheckpointCreated,
            BuildReceiptConfidence::TrustedHost,
        );
        implementation_checkpoint.data = json!({
            "checkpointId": "post-implementer-buildstamp",
            "staged": 0,
            "unstaged": 2,
            "untracked": 1,
            "conflicts": 0,
            "buildWorktreeFingerprint": "fp-1",
        });
        orch.append_receipt(implementation_checkpoint)
            .await
            .unwrap();
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
            BuildReceiptConfidence::TrustedHost,
        ))
        .await
        .unwrap();

        let mut no_op_test_writer_checkpoint = receipt(
            &state,
            BuildReceiptKind::CheckpointCreated,
            BuildReceiptConfidence::TrustedHost,
        );
        no_op_test_writer_checkpoint.data = json!({
            "checkpointId": "1779836703735-agent-test-writer-complete",
            "staged": 0,
            "unstaged": 2,
            "untracked": 2,
            "conflicts": 0,
            "buildWorktreeFingerprint": "fp-1",
        });
        orch.append_receipt(no_op_test_writer_checkpoint)
            .await
            .unwrap();

        let updated = orch.get_state("tab1").await.unwrap();
        assert!(updated.review_satisfied);
        assert!(updated.verification_satisfied);

        let mut real_test_writer_checkpoint = receipt(
            &state,
            BuildReceiptKind::CheckpointCreated,
            BuildReceiptConfidence::TrustedHost,
        );
        real_test_writer_checkpoint.data = json!({
            "checkpointId": "1779836703999-agent-test-writer-complete",
            "staged": 0,
            "unstaged": 3,
            "untracked": 2,
            "conflicts": 0,
            "buildWorktreeFingerprint": "fp-2",
        });
        orch.append_receipt(real_test_writer_checkpoint)
            .await
            .unwrap();

        let updated = orch.get_state("tab1").await.unwrap();
        assert!(!updated.review_satisfied);
        assert!(!updated.verification_satisfied);
        let _ = std::fs::remove_dir_all(cwd);
        let _ = std::fs::remove_dir_all(store);
    }

    #[tokio::test]
    async fn release_manager_checkpoint_preserves_satisfied_gates() {
        let cwd = temp_base("checkpoint-release-manager-cwd");
        let store = temp_base("checkpoint-release-manager-store");
        let orch = BuildOrchestrator::new(store.clone());
        let state = orch.start_run("tab1", "test", &cwd, "wsl").await.unwrap();
        {
            let mut map = orch.states.write().await;
            let st = &mut map.get_mut("tab1").unwrap().state;
            st.status = BuildRunStatus::Active;
            st.code_changed = true;
            st.review_required = true;
            st.review_satisfied = true;
            st.verification_required = true;
            st.verification_satisfied = true;
            st.checkpoint_id = Some("cp-before".into());
        }

        let mut checkpoint = receipt(
            &state,
            BuildReceiptKind::CheckpointCreated,
            BuildReceiptConfidence::TrustedHost,
        );
        checkpoint.data = json!({
            "checkpointId": "1779835948461-agent-release-manager-complete",
            "staged": 0,
            "unstaged": 2,
            "untracked": 3,
            "conflicts": 0,
        });
        orch.append_receipt(checkpoint).await.unwrap();

        let updated = orch.get_state("tab1").await.unwrap();
        assert_eq!(
            updated.checkpoint_id.as_deref(),
            Some("1779835948461-agent-release-manager-complete")
        );
        assert!(updated.review_satisfied);
        assert!(updated.verification_satisfied);
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
    async fn resume_recovers_transport_failed_run_after_auth_refresh() {
        let cwd = temp_base("transport-resume-cwd");
        let store = temp_base("transport-resume-store");
        let orch = BuildOrchestrator::new(store.clone());
        orch.start_run("tab1", "test", &cwd, "local").await.unwrap();
        {
            let mut map = orch.states.write().await;
            map.get_mut("tab1").unwrap().state.status = BuildRunStatus::Active;
        }

        assert!(orch
            .mark_transport_failed("tab1", "responses API error: 401")
            .await
            .unwrap());
        assert!(orch.resume("tab1").await.unwrap());
        let resumed = orch.get_state("tab1").await.unwrap();
        assert_eq!(resumed.status, BuildRunStatus::Active);

        let _ = std::fs::remove_dir_all(cwd);
        let _ = std::fs::remove_dir_all(store);
    }

    #[tokio::test]
    async fn resume_active_run_returns_true_for_reinject_after_reconnect() {
        let cwd = temp_base("active-resume-reinject-cwd");
        let store = temp_base("active-resume-reinject-store");
        let orch = BuildOrchestrator::new(store.clone());
        orch.start_run("tab1", "test", &cwd, "local").await.unwrap();
        {
            let mut map = orch.states.write().await;
            map.get_mut("tab1").unwrap().state.status = BuildRunStatus::Active;
        }

        assert!(orch.resume("tab1").await.unwrap());
        let resumed = orch.get_state("tab1").await.unwrap();
        assert_eq!(resumed.status, BuildRunStatus::Active);

        let _ = std::fs::remove_dir_all(cwd);
        let _ = std::fs::remove_dir_all(store);
    }

    #[tokio::test]
    async fn resume_recovers_persisted_transport_failed_run_after_restart() {
        let cwd = temp_base("transport-resume-persisted-cwd");
        let store = temp_base("transport-resume-persisted-store");
        let writer = BuildOrchestrator::new(store.clone());
        writer
            .start_run("tab1", "test", &cwd, "local")
            .await
            .unwrap();
        {
            let mut map = writer.states.write().await;
            map.get_mut("tab1").unwrap().state.status = BuildRunStatus::Active;
        }
        assert!(writer
            .mark_transport_failed("tab1", "responses API error: 401")
            .await
            .unwrap());

        let reader = BuildOrchestrator::new(store.clone());
        assert!(reader.resume("tab1").await.unwrap());
        let resumed = reader.get_state("tab1").await.unwrap();
        assert_eq!(resumed.status, BuildRunStatus::Active);

        let _ = std::fs::remove_dir_all(cwd);
        let _ = std::fs::remove_dir_all(store);
    }

    #[tokio::test]
    async fn operator_note_can_queue_on_persisted_transport_failed_run() {
        let cwd = temp_base("transport-note-persisted-cwd");
        let store = temp_base("transport-note-persisted-store");
        let writer = BuildOrchestrator::new(store.clone());
        writer
            .start_run("tab1", "test", &cwd, "local")
            .await
            .unwrap();
        {
            let mut map = writer.states.write().await;
            map.get_mut("tab1").unwrap().state.status = BuildRunStatus::Active;
        }
        assert!(writer
            .mark_transport_failed("tab1", "responses API error: 401")
            .await
            .unwrap());

        let reader = BuildOrchestrator::new(store.clone());
        let note = reader
            .add_operator_note("tab1", "auth popup completed; continue existing build")
            .await
            .unwrap();
        assert!(note.text.contains("auth popup"));
        let state = reader.get_state("tab1").await.unwrap();
        assert_eq!(state.pending_operator_notes.len(), 1);

        let _ = std::fs::remove_dir_all(cwd);
        let _ = std::fs::remove_dir_all(store);
    }

    #[tokio::test]
    async fn resume_transport_failure_clears_stale_satisfied_blocker() {
        let cwd = temp_base("transport-resume-blocker-cwd");
        let store = temp_base("transport-resume-blocker-store");
        let orch = BuildOrchestrator::new(store.clone());
        let state = orch.start_run("tab1", "test", &cwd, "local").await.unwrap();
        {
            let mut map = orch.states.write().await;
            map.get_mut("tab1").unwrap().state.status = BuildRunStatus::Active;
        }

        let mut blocker = receipt(
            &state,
            BuildReceiptKind::BlockerOpened,
            BuildReceiptConfidence::TrustedHost,
        );
        blocker.summary = "review blocked until reviewer Agent completes".into();
        orch.append_receipt(blocker).await.unwrap();
        orch.append_receipt(receipt(
            &state,
            BuildReceiptKind::ReviewCompleted,
            BuildReceiptConfidence::TrustedHost,
        ))
        .await
        .unwrap();
        assert!(orch
            .mark_transport_failed("tab1", "responses API error: 401")
            .await
            .unwrap());

        assert!(orch.resume("tab1").await.unwrap());
        let resumed = orch.get_state("tab1").await.unwrap();
        assert_eq!(resumed.status, BuildRunStatus::Active);
        assert_eq!(resumed.open_blocker, None);

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
        let prompt = orch.consider_continue("tab1", "end_turn").await.unwrap();
        assert!(
            prompt.contains("git rev-parse --show-toplevel")
                && prompt.contains("git status --short")
                && prompt.contains("checkpoint"),
            "build continuation should keep git baseline/checkpoint guidance visible"
        );
        orch.pause("tab1").await.unwrap();
        assert!(orch.consider_continue("tab1", "end_turn").await.is_none());
        let _ = std::fs::remove_dir_all(cwd);
        let _ = std::fs::remove_dir_all(store);
    }

    #[tokio::test]
    async fn build_continuation_waits_while_agent_is_in_flight() {
        let cwd = temp_base("continue-agent-cwd");
        let store = temp_base("continue-agent-store");
        let orch = BuildOrchestrator::new(store.clone());
        let state = orch.start_run("tab1", "test", &cwd, "local").await.unwrap();
        {
            let mut map = orch.states.write().await;
            map.get_mut("tab1").unwrap().state.status = BuildRunStatus::Active;
        }
        let mut started = receipt(
            &state,
            BuildReceiptKind::AgentStarted,
            BuildReceiptConfidence::TrustedHost,
        );
        started.data = json!({ "subagentId": "agent-1", "persona": "release-manager" });
        orch.append_receipt(started).await.unwrap();
        assert_eq!(
            orch.in_flight_agent_summaries("tab1").await.unwrap(),
            vec!["release-manager agent-1".to_string()]
        );
        assert!(orch.consider_continue("tab1", "end_turn").await.is_none());

        let mut completed = receipt(
            &state,
            BuildReceiptKind::AgentCompleted,
            BuildReceiptConfidence::TrustedHost,
        );
        completed.data = json!({ "subagentId": "agent-1", "persona": "release-manager" });
        orch.append_receipt(completed).await.unwrap();
        assert!(orch
            .in_flight_agent_summaries("tab1")
            .await
            .unwrap()
            .is_empty());
        assert!(orch.consider_continue("tab1", "end_turn").await.is_some());

        let _ = std::fs::remove_dir_all(cwd);
        let _ = std::fs::remove_dir_all(store);
    }

    #[tokio::test]
    async fn running_agent_completed_snapshot_stays_in_flight() {
        let cwd = temp_base("continue-agent-running-cwd");
        let store = temp_base("continue-agent-running-store");
        let orch = BuildOrchestrator::new(store.clone());
        let state = orch.start_run("tab1", "test", &cwd, "local").await.unwrap();
        {
            let mut map = orch.states.write().await;
            map.get_mut("tab1").unwrap().state.status = BuildRunStatus::Active;
        }
        let mut started = receipt(
            &state,
            BuildReceiptKind::AgentStarted,
            BuildReceiptConfidence::TrustedHost,
        );
        started.data = json!({ "subagentId": "agent-1", "persona": "implementer" });
        orch.append_receipt(started).await.unwrap();

        let mut wait_budget_snapshot = receipt(
            &state,
            BuildReceiptKind::AgentCompleted,
            BuildReceiptConfidence::TrustedHost,
        );
        wait_budget_snapshot.data = json!({
            "subagentId": "agent-1",
            "persona": "implementer",
            "status": "running",
            "waitBudgetExpired": true
        });
        orch.append_receipt(wait_budget_snapshot).await.unwrap();

        assert_eq!(
            orch.in_flight_agent_summaries("tab1").await.unwrap(),
            vec!["implementer agent-1".to_string()]
        );
        assert_eq!(
            orch.in_flight_agent_ids("tab1").await.unwrap(),
            vec!["agent-1".to_string()]
        );
        assert!(orch.consider_continue("tab1", "end_turn").await.is_none());

        let _ = std::fs::remove_dir_all(cwd);
        let _ = std::fs::remove_dir_all(store);
    }

    #[tokio::test]
    async fn build_continuation_forward_nudges_stale_review_verify_loop_without_blocking() {
        let cwd = temp_base("continue-stale-loop-cwd");
        let store = temp_base("continue-stale-loop-store");
        let orch = BuildOrchestrator::new(store.clone());
        let state = orch
            .start_run("tab1", "paint app", &cwd, "local")
            .await
            .unwrap();
        std::fs::write(
            &state.scratchboard_path,
            "# Build: paint app\n\nStatus: IN_PROGRESS\n\n## Phase\nStatus: IN_PROGRESS\n- [ ] implement next paint tool\n",
        )
        .unwrap();
        {
            let mut map = orch.states.write().await;
            let st = &mut map.get_mut("tab1").unwrap().state;
            st.status = BuildRunStatus::Active;
            st.code_changed = true;
            st.review_required = true;
            st.verification_required = true;
            st.checkpoint_id = Some("cp-1".into());
        }

        let mut review = receipt(
            &state,
            BuildReceiptKind::ReviewCompleted,
            BuildReceiptConfidence::TrustedHost,
        );
        review.summary = "0 new findings on same visual scope".into();
        orch.append_receipt(review).await.unwrap();
        let mut verify = receipt(
            &state,
            BuildReceiptKind::VerificationCompleted,
            BuildReceiptConfidence::TrustedHost,
        );
        verify.summary = "verification gate satisfiable on same testable scope".into();
        orch.append_receipt(verify).await.unwrap();

        let prompt = orch.consider_continue("tab1", "end_turn").await.unwrap();
        assert!(
            prompt.contains("<build_forward_nudge"),
            "stale review/verify suffix should produce a forward nudge, got: {}",
            prompt
        );
        assert!(
            prompt.contains("Do not dispatch another reviewer or verifier for the same scope"),
            "nudge should prevent repeating the same reviewer/verifier loop, got: {}",
            prompt
        );
        let nudged = orch.get_state("tab1").await.unwrap();
        assert_eq!(nudged.status, BuildRunStatus::Active);
        assert_eq!(nudged.open_blocker, None);
        assert_eq!(nudged.no_progress_cycles, 1);

        let prompt = orch.consider_continue("tab1", "end_turn").await.unwrap();
        assert!(
            prompt.contains("Forced forward step"),
            "second stale continuation should escalate the nudge, got: {}",
            prompt
        );
        let nudged = orch.get_state("tab1").await.unwrap();
        assert_eq!(nudged.status, BuildRunStatus::Active);
        assert_eq!(nudged.no_progress_cycles, 2);

        let _ = std::fs::remove_dir_all(cwd);
        let _ = std::fs::remove_dir_all(store);
    }

    #[tokio::test]
    async fn build_continuation_resets_forward_nudge_after_checkpoint_progress() {
        let cwd = temp_base("continue-stale-reset-cwd");
        let store = temp_base("continue-stale-reset-store");
        let orch = BuildOrchestrator::new(store.clone());
        let state = orch
            .start_run("tab1", "paint app", &cwd, "local")
            .await
            .unwrap();
        std::fs::write(
            &state.scratchboard_path,
            "# Build: paint app\n\nStatus: IN_PROGRESS\n\n## Phase\nStatus: IN_PROGRESS\n- [ ] implement next paint tool\n",
        )
        .unwrap();
        {
            let mut map = orch.states.write().await;
            let st = &mut map.get_mut("tab1").unwrap().state;
            st.status = BuildRunStatus::Active;
            st.no_progress_cycles = 3;
        }

        let mut checkpoint = receipt(
            &state,
            BuildReceiptKind::CheckpointCreated,
            BuildReceiptConfidence::TrustedHost,
        );
        checkpoint.data = json!({
            "checkpointId": "cp-new",
            "staged": 0,
            "unstaged": 1,
            "untracked": 0,
            "buildWorktreeFingerprint": "fp-new"
        });
        orch.append_receipt(checkpoint).await.unwrap();

        let prompt = orch.consider_continue("tab1", "end_turn").await.unwrap();
        assert!(
            !prompt.contains("<build_forward_nudge"),
            "fresh checkpoint progress should return to the normal continuation prompt, got: {}",
            prompt
        );
        let nudged = orch.get_state("tab1").await.unwrap();
        assert_eq!(nudged.no_progress_cycles, 0);

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
