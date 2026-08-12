use crate::shellx_browser::{
    lock_or_recover, BrowserBookmark, BrowserBookmarkToolbarItem, BrowserDeveloperModeSettings,
    BrowserDialogEvent, BrowserEnginePoolSnapshot, BrowserEngineSummary, BrowserFileTransferEntry,
    BrowserHistoryEntry, BrowserNativeSecurityCapabilities, BrowserNetworkEntry,
    BrowserPendingRequestSummary, BrowserPermissionEvent, BrowserPopupEvent,
    BrowserPrivacySettings, BrowserProfile, BrowserReceipt, BrowserRobotJob, BrowserSessionGrant,
    BrowserSettleSnapshot, BrowserShieldSettings, BrowserState, BrowserStateSnapshot,
    BrowserSummaryCounts, BrowserSummaryRevisions, BrowserSummarySnapshot, BrowserTabSnapshot,
    BrowserTabSummary, BrowserTaskSnapshot, BrowserTaskSummary, BrowserVaultDepositResponse,
    ShellxBrowserRegistry,
};

const BROWSER_SUMMARY_PENDING_REQUEST_LIMIT: usize = 10;
const BROWSER_SUMMARY_GOAL_CHARS: usize = 300;
const BROWSER_SUMMARY_TEXT_CHARS: usize = 200;
const BROWSER_SUMMARY_URL_CHARS: usize = 1_024;

fn bounded_summary_string(value: &str, max_chars: usize) -> String {
    let mut chars = value.chars();
    let mut bounded = chars.by_ref().take(max_chars).collect::<String>();
    if chars.next().is_some() {
        bounded.push_str("...");
    }
    bounded
}

fn bounded_summary_option(value: &Option<String>, max_chars: usize) -> Option<String> {
    value
        .as_deref()
        .map(|value| bounded_summary_string(value, max_chars))
}

fn summary_revision(label: &str, value: i64) -> String {
    format!("{label}-{}", value.max(0))
}

fn task_summary(task: &BrowserTaskSnapshot) -> BrowserTaskSummary {
    BrowserTaskSummary {
        task_id: task.task_id.clone(),
        profile_id: task.profile_id.clone(),
        owner_actor_id: task.owner_actor_id.clone(),
        owner_surface: task.owner_surface.clone(),
        owner_session_id: task.owner_session_id.clone(),
        goal: bounded_summary_string(&task.goal, BROWSER_SUMMARY_GOAL_CHARS),
        status: task.status.clone(),
        status_reason: bounded_summary_option(&task.status_reason, BROWSER_SUMMARY_TEXT_CHARS),
        current_url: bounded_summary_option(&task.current_url, BROWSER_SUMMARY_URL_CHARS),
        updated_at_ms: task.updated_at_ms,
    }
}

fn tab_summary(tab: &BrowserTabSnapshot) -> BrowserTabSummary {
    BrowserTabSummary {
        browser_tab_id: tab.browser_tab_id.clone(),
        engine_id: tab.engine_id.clone(),
        task_id: tab.task_id.clone(),
        profile_id: tab.profile_id.clone(),
        url: bounded_summary_option(&tab.url, BROWSER_SUMMARY_URL_CHARS),
        title: bounded_summary_option(&tab.title, BROWSER_SUMMARY_TEXT_CHARS),
        status: tab.status.clone(),
        owner_kind: tab.owner_kind.clone(),
        requires_user_attention: tab.requires_user_attention,
        updated_at_ms: tab.updated_at_ms,
    }
}

fn engine_summary(engine: &crate::shellx_browser::BrowserEngineSnapshot) -> BrowserEngineSummary {
    BrowserEngineSummary {
        engine_id: engine.engine_id.clone(),
        mounted: engine.mounted,
        browser_tab_id: engine.browser_tab_id.clone(),
        task_id: engine.task_id.clone(),
        url: bounded_summary_option(&engine.url, BROWSER_SUMMARY_URL_CHARS),
        pending_url: bounded_summary_option(&engine.pending_url, BROWSER_SUMMARY_URL_CHARS),
        title: bounded_summary_option(&engine.title, BROWSER_SUMMARY_TEXT_CHARS),
        load_status: engine.load_status.clone(),
        visibility_state: engine.visibility_state.clone(),
        updated_at_ms: engine.updated_at_ms,
    }
}

pub(crate) fn browser_task_belongs_to_agent_session(
    state: &BrowserState,
    task_id: Option<&str>,
    caller_session_id: &str,
) -> bool {
    let caller_session_id = caller_session_id.trim();
    task_id.is_some_and(|task_id| {
        state.tasks.iter().any(|task| {
            task.task_id == task_id && task.owner_session_id.as_deref() == Some(caller_session_id)
        })
    })
}

fn engine_pool_snapshot(state: &BrowserState) -> BrowserEnginePoolSnapshot {
    let mut engine_pool = state.engine_pool.clone();
    engine_pool.waiting = engine_pool
        .engines
        .iter()
        .flat_map(|engine| engine.waitlist.waiting.clone())
        .collect();
    engine_pool.parked_tabs = state
        .tabs
        .iter()
        .filter(|tab| tab.engine_state == crate::shellx_browser::BrowserEngineTabState::Parked)
        .map(|tab| tab.browser_tab_id.clone())
        .collect();
    engine_pool
}

fn pending_request_summaries(state: &BrowserState) -> Vec<BrowserPendingRequestSummary> {
    let mut pending = Vec::new();
    for grant in state
        .session_grants
        .iter()
        .filter(|grant| grant.status == "requested")
    {
        pending.push(BrowserPendingRequestSummary {
            request_id: grant.grant_id.clone(),
            kind: "sessionGrant".to_string(),
            task_id: grant.task_id.clone(),
            status: grant.status.clone(),
            summary: bounded_summary_string(&grant.reason, BROWSER_SUMMARY_TEXT_CHARS),
            created_at_ms: grant.created_at_ms,
        });
    }
    for dialog in state
        .dialogs
        .iter()
        .filter(|dialog| dialog.status == "pending")
    {
        pending.push(BrowserPendingRequestSummary {
            request_id: dialog.dialog_id.clone(),
            kind: "dialog".to_string(),
            task_id: dialog.task_id.clone(),
            status: dialog.status.clone(),
            summary: bounded_summary_string(&dialog.text, BROWSER_SUMMARY_TEXT_CHARS),
            created_at_ms: dialog.created_at_ms,
        });
    }
    for permission in state
        .permissions
        .iter()
        .filter(|permission| permission.status == "pending")
    {
        pending.push(BrowserPendingRequestSummary {
            request_id: permission.permission_id.clone(),
            kind: "permission".to_string(),
            task_id: permission.task_id.clone(),
            status: permission.status.clone(),
            summary: bounded_summary_string(
                &permission.permission_kind,
                BROWSER_SUMMARY_TEXT_CHARS,
            ),
            created_at_ms: permission.created_at_ms,
        });
    }
    for transfer in state
        .downloads
        .iter()
        .chain(state.uploads.iter())
        .filter(|entry| !matches!(entry.status.as_str(), "completed" | "failed" | "cancelled"))
    {
        pending.push(BrowserPendingRequestSummary {
            request_id: transfer.transfer_id.clone(),
            kind: transfer.direction.clone(),
            task_id: transfer.task_id.clone(),
            status: transfer.status.clone(),
            summary: bounded_summary_string(&transfer.reason, BROWSER_SUMMARY_TEXT_CHARS),
            created_at_ms: transfer.requested_at_ms,
        });
    }
    pending.sort_by_key(|request| std::cmp::Reverse(request.created_at_ms));
    pending.truncate(BROWSER_SUMMARY_PENDING_REQUEST_LIMIT);
    pending
}

impl ShellxBrowserRegistry {
    pub fn state(&self) -> BrowserStateSnapshot {
        let mut state = lock_or_recover(&self.state);
        crate::shellx_browser_tasks::repair_browser_task_invariants_locked(&mut state);
        let engine_pool = engine_pool_snapshot(&state);
        BrowserStateSnapshot {
            profiles: state.profiles.clone(),
            tabs: state.tabs.clone(),
            bookmarks: state.bookmarks.clone(),
            bookmark_toolbar: crate::shellx_browser_bookmarks::browser_bookmark_toolbar(
                &state.bookmarks,
            ),
            history: state.history.clone(),
            tasks: state.tasks.clone(),
            active_task_id: state.active_task_id.clone(),
            active_browser_tab_id: state.active_browser_tab_id.clone(),
            window_open: state.window_open,
            pending_start_url: state.pending_start_url.clone(),
            engine: state.engine.clone(),
            engine_pool,
            engine_waitlist: state.engine_waitlist.clone(),
            native_security: BrowserNativeSecurityCapabilities::current(),
            privacy: state.privacy.clone(),
            personal_lock: state.personal_lock.clone(),
            download_folder: state.download_folder.clone(),
            shields: state.shields.clone(),
            developer_mode: state.developer_mode.clone(),
            session_grants: state.session_grants.clone(),
            vault_deposits: state.vault_deposits.clone(),
            downloads: state.downloads.clone(),
            uploads: state.uploads.clone(),
            console_logs: state.console_logs.clone(),
            dialogs: state.dialogs.clone(),
            permissions: state.permissions.clone(),
            popups: state.popups.clone(),
            network: state.network.clone(),
            robots: state.robots.clone(),
            receipts: state.receipts.clone(),
        }
    }

    pub fn core_state(&self) -> BrowserStateSnapshot {
        let mut state = lock_or_recover(&self.state);
        crate::shellx_browser_tasks::repair_browser_task_invariants_locked(&mut state);
        let mut tasks = state.tasks.clone();
        for task in &mut tasks {
            task.last_observation = None;
        }
        BrowserStateSnapshot {
            profiles: state.profiles.clone(),
            tabs: state.tabs.clone(),
            bookmarks: Vec::new(),
            bookmark_toolbar: Vec::new(),
            history: Vec::new(),
            tasks,
            active_task_id: state.active_task_id.clone(),
            active_browser_tab_id: state.active_browser_tab_id.clone(),
            window_open: state.window_open,
            pending_start_url: state.pending_start_url.clone(),
            engine: state.engine.clone(),
            engine_pool: engine_pool_snapshot(&state),
            engine_waitlist: state.engine_waitlist.clone(),
            native_security: BrowserNativeSecurityCapabilities::current(),
            privacy: state.privacy.clone(),
            personal_lock: state.personal_lock.clone(),
            download_folder: state.download_folder.clone(),
            shields: state.shields.clone(),
            developer_mode: state.developer_mode.clone(),
            session_grants: Vec::new(),
            vault_deposits: Vec::new(),
            downloads: Vec::new(),
            uploads: Vec::new(),
            console_logs: Vec::new(),
            dialogs: Vec::new(),
            permissions: Vec::new(),
            popups: Vec::new(),
            network: Vec::new(),
            robots: Vec::new(),
            receipts: Vec::new(),
        }
    }

    pub fn summary(&self) -> BrowserSummarySnapshot {
        let mut state = lock_or_recover(&self.state);
        crate::shellx_browser_tasks::repair_browser_task_invariants_locked(&mut state);
        let active_task = state
            .active_task_id
            .as_deref()
            .and_then(|task_id| state.tasks.iter().find(|task| task.task_id == task_id))
            .map(task_summary);
        let active_tab = state
            .active_browser_tab_id
            .as_deref()
            .and_then(|tab_id| state.tabs.iter().find(|tab| tab.browser_tab_id == tab_id))
            .map(tab_summary);
        let active_engine = active_tab
            .as_ref()
            .and_then(|tab| {
                state
                    .engine_pool
                    .engines
                    .iter()
                    .find(|engine| engine.engine_id == tab.engine_id)
            })
            .or_else(|| active_tab.as_ref().map(|_| &state.engine))
            .map(engine_summary);
        let pending_requests = pending_request_summaries(&state);
        let task_revision = state
            .tasks
            .iter()
            .map(|task| task.updated_at_ms)
            .max()
            .unwrap_or_default();
        let tab_revision = state
            .tabs
            .iter()
            .map(|tab| tab.updated_at_ms)
            .max()
            .unwrap_or_default();
        let engine_revision = state
            .engine_pool
            .engines
            .iter()
            .map(|engine| engine.updated_at_ms)
            .chain(std::iter::once(state.engine.updated_at_ms))
            .max()
            .unwrap_or_default();
        let request_revision = pending_requests
            .iter()
            .map(|request| request.created_at_ms)
            .chain(
                state
                    .session_grants
                    .iter()
                    .filter_map(|grant| grant.resolved_at_ms.or(grant.applied_at_ms)),
            )
            .max()
            .unwrap_or_default();
        let activity_revision = state
            .receipts
            .iter()
            .map(|receipt| receipt.t)
            .chain(state.console_logs.iter().map(|entry| entry.t))
            .max()
            .unwrap_or_default();
        let state_revision = [
            task_revision,
            tab_revision,
            engine_revision,
            request_revision,
            activity_revision,
            state.privacy.updated_at_ms,
            state.personal_lock.updated_at_ms,
            state.shields.updated_at_ms,
            state.developer_mode.updated_at_ms,
        ]
        .into_iter()
        .max()
        .unwrap_or_default();
        let latest_receipt_id = state
            .receipts
            .last()
            .map(|receipt| receipt.receipt_id.as_str());
        let pending_request_count = state
            .session_grants
            .iter()
            .filter(|grant| grant.status == "requested")
            .count()
            + state
                .dialogs
                .iter()
                .filter(|dialog| dialog.status == "pending")
                .count()
            + state
                .permissions
                .iter()
                .filter(|permission| permission.status == "pending")
                .count()
            + state
                .downloads
                .iter()
                .chain(state.uploads.iter())
                .filter(|entry| {
                    !matches!(entry.status.as_str(), "completed" | "failed" | "cancelled")
                })
                .count();
        BrowserSummarySnapshot {
            browser_protocol_version: crate::build_metadata::BROWSER_PROTOCOL_VERSION,
            browser_schema_revision: crate::build_metadata::BROWSER_SCHEMA_REVISION,
            revisions: BrowserSummaryRevisions {
                state: latest_receipt_id
                    .map(|receipt_id| format!("state-{receipt_id}"))
                    .unwrap_or_else(|| summary_revision("state", state_revision)),
                tasks: summary_revision("tasks", task_revision),
                tabs: summary_revision("tabs", tab_revision),
                engine: summary_revision("engine", engine_revision),
                requests: summary_revision("requests", request_revision),
                activity: latest_receipt_id
                    .map(|receipt_id| format!("activity-{receipt_id}"))
                    .unwrap_or_else(|| summary_revision("activity", activity_revision)),
            },
            counts: BrowserSummaryCounts {
                profiles: state.profiles.len(),
                tabs: state.tabs.len(),
                tasks: state.tasks.len(),
                running_tasks: state
                    .tasks
                    .iter()
                    .filter(|task| task.status == "running")
                    .count(),
                bookmarks: state.bookmarks.len(),
                history: state.history.len(),
                receipts: state.receipts.len(),
                console_logs: state.console_logs.len(),
                downloads: state.downloads.len(),
                uploads: state.uploads.len(),
                pending_requests: pending_request_count,
                waiting_engines: state
                    .engine_pool
                    .engines
                    .iter()
                    .map(|engine| engine.waitlist.waiting.len())
                    .sum(),
            },
            active_task,
            active_tab,
            active_engine,
            pending_requests,
            window_open: state.window_open,
            personal_browser_locked: state.personal_lock.enabled && state.personal_lock.locked,
            pending_start_url: bounded_summary_option(
                &state.pending_start_url,
                BROWSER_SUMMARY_URL_CHARS,
            ),
        }
    }

    /// Return only Browser orientation data owned by one authenticated Host
    /// MCP session. The operator-facing Debug API omits the caller header and
    /// continues to receive the complete local Browser registry.
    pub fn summary_for_agent_session(&self, caller_session_id: &str) -> BrowserSummarySnapshot {
        let caller_session_id = caller_session_id.trim();
        let mut summary = self.summary();
        let tasks = self
            .tasks()
            .into_iter()
            .filter(|task| task.owner_session_id.as_deref() == Some(caller_session_id))
            .collect::<Vec<_>>();
        let task_ids = tasks
            .iter()
            .map(|task| task.task_id.as_str())
            .collect::<std::collections::HashSet<_>>();
        let tabs = self
            .tabs()
            .into_iter()
            .filter(|tab| {
                tab.task_id
                    .as_deref()
                    .is_some_and(|task_id| task_ids.contains(task_id))
            })
            .collect::<Vec<_>>();
        let tab_ids = tabs
            .iter()
            .map(|tab| tab.browser_tab_id.as_str())
            .collect::<std::collections::HashSet<_>>();

        summary.active_task = summary
            .active_task
            .filter(|task| task_ids.contains(task.task_id.as_str()));
        summary.active_tab = summary
            .active_tab
            .filter(|tab| tab_ids.contains(tab.browser_tab_id.as_str()));
        summary.active_engine = summary.active_engine.filter(|engine| {
            engine
                .task_id
                .as_deref()
                .is_some_and(|task_id| task_ids.contains(task_id))
        });
        summary.pending_requests.retain(|request| {
            request
                .task_id
                .as_deref()
                .is_some_and(|task_id| task_ids.contains(task_id))
        });
        summary.counts.profiles = tasks
            .iter()
            .map(|task| task.profile_id.as_str())
            .collect::<std::collections::HashSet<_>>()
            .len();
        summary.counts.tabs = tabs.len();
        summary.counts.tasks = tasks.len();
        summary.counts.running_tasks = tasks.iter().filter(|task| task.status == "running").count();
        summary.counts.bookmarks = 0;
        summary.counts.history = self
            .history_for_agent_session(caller_session_id, None)
            .len();
        summary.counts.receipts = 0;
        summary.counts.console_logs = 0;
        summary.counts.downloads = 0;
        summary.counts.uploads = 0;
        summary.counts.pending_requests = summary.pending_requests.len();
        summary.counts.waiting_engines = 0;
        summary.window_open = summary.window_open && !tabs.is_empty();
        summary.personal_browser_locked = false;
        summary.pending_start_url = None;
        summary
    }

    pub fn task_summaries(&self) -> Vec<BrowserTaskSummary> {
        let mut state = lock_or_recover(&self.state);
        crate::shellx_browser_tasks::repair_browser_task_invariants_locked(&mut state);
        let mut tasks = state.tasks.iter().map(task_summary).collect::<Vec<_>>();
        tasks.sort_by_key(|task| std::cmp::Reverse(task.updated_at_ms));
        tasks
    }

    pub fn task_summaries_for_agent_session(
        &self,
        caller_session_id: &str,
    ) -> Vec<BrowserTaskSummary> {
        self.task_summaries()
            .into_iter()
            .filter(|task| task.owner_session_id.as_deref() == Some(caller_session_id.trim()))
            .collect()
    }

    pub fn task_details(&self, include_observations: bool) -> Vec<BrowserTaskSnapshot> {
        let mut tasks = self.tasks();
        tasks.sort_by_key(|task| std::cmp::Reverse(task.updated_at_ms));
        if !include_observations {
            for task in &mut tasks {
                task.last_observation = None;
            }
        }
        tasks
    }

    pub fn task_details_for_agent_session(
        &self,
        caller_session_id: &str,
        include_observations: bool,
    ) -> Vec<BrowserTaskSnapshot> {
        self.task_details(include_observations)
            .into_iter()
            .filter(|task| task.owner_session_id.as_deref() == Some(caller_session_id.trim()))
            .collect()
    }

    pub fn settle_state(
        &self,
        task_id: Option<&str>,
        browser_tab_id: Option<&str>,
    ) -> Result<BrowserSettleSnapshot, String> {
        let state = lock_or_recover(&self.state);
        let tab = task_id
            .and_then(|task_id| {
                state
                    .tabs
                    .iter()
                    .find(|tab| tab.task_id.as_deref() == Some(task_id))
            })
            .or_else(|| {
                browser_tab_id
                    .and_then(|tab_id| state.tabs.iter().find(|tab| tab.browser_tab_id == tab_id))
            })
            .or_else(|| {
                state
                    .active_browser_tab_id
                    .as_deref()
                    .and_then(|tab_id| state.tabs.iter().find(|tab| tab.browser_tab_id == tab_id))
            })
            .ok_or_else(|| "Browser settle target has no matching task or tab".to_string())?;
        let task = tab
            .task_id
            .as_deref()
            .and_then(|task_id| state.tasks.iter().find(|task| task.task_id == task_id));
        let engine = state
            .engine_pool
            .engines
            .iter()
            .find(|engine| engine.engine_id == tab.engine_id)
            .or_else(|| (state.engine.engine_id == tab.engine_id).then_some(&state.engine))
            .ok_or_else(|| "Browser settle target engine is not allocated".to_string())?;
        // A pooled engine can briefly retain the previous page (or about:blank)
        // after it has been rebound to a new tab.  pending_url/load_status alone
        // therefore cannot prove that the requested tab is actually rendered.
        let engine_matches_tab = engine.browser_tab_id.as_deref() == Some(&tab.browser_tab_id)
            && engine.task_id == tab.task_id
            && engine.url == tab.url;
        let settled = engine_matches_tab
            && engine.pending_url.is_none()
            && !matches!(engine.load_status.as_str(), "navigating" | "loading");
        Ok(BrowserSettleSnapshot {
            settled,
            task_id: tab.task_id.clone(),
            browser_tab_id: Some(tab.browser_tab_id.clone()),
            task_status: task.map(|task| task.status.clone()),
            tab_status: Some(tab.status.clone()),
            engine_id: Some(engine.engine_id.clone()),
            engine_load_status: Some(engine.load_status.clone()),
            engine_url: bounded_summary_option(&engine.url, BROWSER_SUMMARY_URL_CHARS),
            pending_url: bounded_summary_option(&engine.pending_url, BROWSER_SUMMARY_URL_CHARS),
            revision: summary_revision("engine", engine.updated_at_ms),
        })
    }

    pub fn profiles(&self) -> Vec<BrowserProfile> {
        lock_or_recover(&self.state).profiles.clone()
    }

    pub fn profiles_for_agent_session(&self, caller_session_id: &str) -> Vec<BrowserProfile> {
        let state = lock_or_recover(&self.state);
        let profile_ids = state
            .tasks
            .iter()
            .filter(|task| task.owner_session_id.as_deref() == Some(caller_session_id.trim()))
            .map(|task| task.profile_id.as_str())
            .collect::<std::collections::HashSet<_>>();
        state
            .profiles
            .iter()
            .filter(|profile| {
                profile.profile_id != "personal"
                    && profile_ids.contains(profile.profile_id.as_str())
            })
            .cloned()
            .map(|mut profile| {
                profile.storage_root = None;
                profile
            })
            .collect()
    }

    pub fn tabs(&self) -> Vec<BrowserTabSnapshot> {
        lock_or_recover(&self.state).tabs.clone()
    }

    pub fn tabs_for_agent_session(&self, caller_session_id: &str) -> Vec<BrowserTabSnapshot> {
        let caller_session_id = caller_session_id.trim();
        let state = lock_or_recover(&self.state);
        let task_ids = state
            .tasks
            .iter()
            .filter(|task| task.owner_session_id.as_deref() == Some(caller_session_id))
            .map(|task| task.task_id.as_str())
            .collect::<std::collections::HashSet<_>>();
        state
            .tabs
            .iter()
            .filter(|tab| {
                tab.task_id
                    .as_deref()
                    .is_some_and(|task_id| task_ids.contains(task_id))
            })
            .cloned()
            .collect()
    }

    pub fn privacy(&self) -> BrowserPrivacySettings {
        lock_or_recover(&self.state).privacy.clone()
    }

    pub fn shields(&self) -> BrowserShieldSettings {
        lock_or_recover(&self.state).shields.clone()
    }

    pub fn developer_mode(&self) -> BrowserDeveloperModeSettings {
        lock_or_recover(&self.state).developer_mode.clone()
    }

    pub fn downloads(&self) -> Vec<BrowserFileTransferEntry> {
        lock_or_recover(&self.state).downloads.clone()
    }

    pub fn downloads_for_agent_session(
        &self,
        caller_session_id: &str,
    ) -> Vec<BrowserFileTransferEntry> {
        let state = lock_or_recover(&self.state);
        state
            .downloads
            .iter()
            .filter(|entry| {
                browser_task_belongs_to_agent_session(
                    &state,
                    entry.task_id.as_deref(),
                    caller_session_id,
                )
            })
            .cloned()
            .collect()
    }

    pub fn uploads(&self) -> Vec<BrowserFileTransferEntry> {
        lock_or_recover(&self.state)
            .uploads
            .clone()
            .into_iter()
            .map(crate::shellx_browser_transfer_privacy::public_upload_transfer_entry)
            .collect()
    }

    pub fn uploads_for_agent_session(
        &self,
        caller_session_id: &str,
    ) -> Vec<BrowserFileTransferEntry> {
        let state = lock_or_recover(&self.state);
        state
            .uploads
            .iter()
            .filter(|entry| {
                browser_task_belongs_to_agent_session(
                    &state,
                    entry.task_id.as_deref(),
                    caller_session_id,
                )
            })
            .cloned()
            .map(crate::shellx_browser_transfer_privacy::public_upload_transfer_entry)
            .collect()
    }

    pub fn bookmarks(&self) -> Vec<BrowserBookmark> {
        lock_or_recover(&self.state).bookmarks.clone()
    }

    pub fn bookmark_toolbar(&self) -> Vec<BrowserBookmarkToolbarItem> {
        crate::shellx_browser_bookmarks::browser_bookmark_toolbar(
            &lock_or_recover(&self.state).bookmarks,
        )
    }

    pub fn tasks(&self) -> Vec<BrowserTaskSnapshot> {
        let mut state = lock_or_recover(&self.state);
        crate::shellx_browser_tasks::repair_browser_task_invariants_locked(&mut state);
        state.tasks.clone()
    }

    pub fn history(&self, limit: Option<usize>) -> Vec<BrowserHistoryEntry> {
        let mut history = lock_or_recover(&self.state).history.clone();
        history.sort_by_key(|entry| std::cmp::Reverse(entry.visited_at_ms));
        history.truncate(limit.unwrap_or(500).min(2_000));
        history
    }

    pub fn history_for_agent_session(
        &self,
        caller_session_id: &str,
        limit: Option<usize>,
    ) -> Vec<BrowserHistoryEntry> {
        let caller_session_id = caller_session_id.trim();
        let state = lock_or_recover(&self.state);
        let task_ids = state
            .tasks
            .iter()
            .filter(|task| task.owner_session_id.as_deref() == Some(caller_session_id))
            .map(|task| task.task_id.as_str())
            .collect::<std::collections::HashSet<_>>();
        let mut history = state
            .history
            .iter()
            .filter(|entry| {
                entry
                    .task_id
                    .as_deref()
                    .is_some_and(|task_id| task_ids.contains(task_id))
                    && entry.profile_id != "personal"
            })
            .cloned()
            .collect::<Vec<_>>();
        history.sort_by_key(|entry| std::cmp::Reverse(entry.visited_at_ms));
        history.truncate(limit.unwrap_or(500).min(2_000));
        history
    }

    pub fn session_grants(&self, limit: Option<usize>) -> Vec<BrowserSessionGrant> {
        let mut grants = lock_or_recover(&self.state).session_grants.clone();
        grants.sort_by_key(|grant| std::cmp::Reverse(grant.created_at_ms));
        grants.truncate(limit.unwrap_or(200).min(1_000));
        grants
    }

    pub fn session_grants_for_agent_session(
        &self,
        caller_session_id: &str,
        limit: Option<usize>,
    ) -> Vec<BrowserSessionGrant> {
        let state = lock_or_recover(&self.state);
        let mut grants = state
            .session_grants
            .iter()
            .filter(|grant| {
                browser_task_belongs_to_agent_session(
                    &state,
                    grant.task_id.as_deref(),
                    caller_session_id,
                )
            })
            .cloned()
            .collect::<Vec<_>>();
        grants.sort_by_key(|grant| std::cmp::Reverse(grant.created_at_ms));
        grants.truncate(limit.unwrap_or(200).min(1_000));
        grants
    }

    pub fn vault_deposits(&self, limit: Option<usize>) -> Vec<BrowserVaultDepositResponse> {
        let mut deposits = lock_or_recover(&self.state).vault_deposits.clone();
        deposits.sort_by_key(|deposit| std::cmp::Reverse(deposit.receipt.t));
        deposits.truncate(limit.unwrap_or(200).min(1_000));
        deposits
    }

    pub fn vault_deposits_for_agent_session(
        &self,
        caller_session_id: &str,
        limit: Option<usize>,
    ) -> Vec<BrowserVaultDepositResponse> {
        let state = lock_or_recover(&self.state);
        let mut deposits = state
            .vault_deposits
            .iter()
            .filter(|deposit| {
                browser_task_belongs_to_agent_session(
                    &state,
                    deposit.task_id.as_deref(),
                    caller_session_id,
                )
            })
            .cloned()
            .collect::<Vec<_>>();
        deposits.sort_by_key(|deposit| std::cmp::Reverse(deposit.receipt.t));
        deposits.truncate(limit.unwrap_or(200).min(1_000));
        deposits
    }

    pub fn receipts(&self, limit: Option<usize>) -> Vec<BrowserReceipt> {
        let mut receipts = lock_or_recover(&self.state).receipts.clone();
        receipts.sort_by_key(|receipt| receipt.t);
        receipts.reverse();
        receipts.truncate(limit.unwrap_or(200).min(1000));
        receipts
    }

    pub fn receipts_for_agent_session(
        &self,
        caller_session_id: &str,
        limit: Option<usize>,
    ) -> Vec<BrowserReceipt> {
        let state = lock_or_recover(&self.state);
        let mut receipts = state
            .receipts
            .iter()
            .filter(|receipt| {
                browser_task_belongs_to_agent_session(
                    &state,
                    receipt.task_id.as_deref(),
                    caller_session_id,
                )
            })
            .cloned()
            .collect::<Vec<_>>();
        receipts.sort_by_key(|receipt| std::cmp::Reverse(receipt.t));
        receipts.truncate(limit.unwrap_or(200).min(1_000));
        receipts
    }

    pub fn dialogs(&self, limit: Option<usize>) -> Vec<BrowserDialogEvent> {
        let mut dialogs = lock_or_recover(&self.state).dialogs.clone();
        dialogs.sort_by_key(|entry| entry.created_at_ms);
        dialogs.reverse();
        dialogs.truncate(limit.unwrap_or(200).min(1000));
        dialogs
    }

    pub fn dialogs_for_agent_session(
        &self,
        caller_session_id: &str,
        limit: Option<usize>,
    ) -> Vec<BrowserDialogEvent> {
        let state = lock_or_recover(&self.state);
        let mut dialogs = state
            .dialogs
            .iter()
            .filter(|entry| {
                browser_task_belongs_to_agent_session(
                    &state,
                    entry.task_id.as_deref(),
                    caller_session_id,
                )
            })
            .cloned()
            .collect::<Vec<_>>();
        dialogs.sort_by_key(|entry| std::cmp::Reverse(entry.created_at_ms));
        dialogs.truncate(limit.unwrap_or(200).min(1_000));
        dialogs
    }

    pub fn permissions(&self, limit: Option<usize>) -> Vec<BrowserPermissionEvent> {
        let mut permissions = lock_or_recover(&self.state).permissions.clone();
        permissions.sort_by_key(|entry| entry.created_at_ms);
        permissions.reverse();
        permissions.truncate(limit.unwrap_or(200).min(1000));
        permissions
    }

    pub fn permissions_for_agent_session(
        &self,
        caller_session_id: &str,
        limit: Option<usize>,
    ) -> Vec<BrowserPermissionEvent> {
        let state = lock_or_recover(&self.state);
        let mut permissions = state
            .permissions
            .iter()
            .filter(|entry| {
                browser_task_belongs_to_agent_session(
                    &state,
                    entry.task_id.as_deref(),
                    caller_session_id,
                )
            })
            .cloned()
            .collect::<Vec<_>>();
        permissions.sort_by_key(|entry| std::cmp::Reverse(entry.created_at_ms));
        permissions.truncate(limit.unwrap_or(200).min(1_000));
        permissions
    }

    pub fn popups(&self, limit: Option<usize>) -> Vec<BrowserPopupEvent> {
        let mut popups = lock_or_recover(&self.state).popups.clone();
        popups.sort_by_key(|entry| entry.created_at_ms);
        popups.reverse();
        popups.truncate(limit.unwrap_or(200).min(1000));
        popups
    }

    pub fn network_entries(&self, limit: Option<usize>) -> Vec<BrowserNetworkEntry> {
        let mut entries = lock_or_recover(&self.state).network.clone();
        entries.sort_by_key(|entry| entry.t);
        entries.reverse();
        entries.truncate(limit.unwrap_or(200).min(1000));
        entries
    }

    pub fn network_entries_for_agent_session(
        &self,
        caller_session_id: &str,
        limit: Option<usize>,
    ) -> Vec<BrowserNetworkEntry> {
        let state = lock_or_recover(&self.state);
        let mut entries = state
            .network
            .iter()
            .filter(|entry| {
                browser_task_belongs_to_agent_session(
                    &state,
                    entry.task_id.as_deref(),
                    caller_session_id,
                )
            })
            .cloned()
            .collect::<Vec<_>>();
        entries.sort_by_key(|entry| std::cmp::Reverse(entry.t));
        entries.truncate(limit.unwrap_or(200).min(1_000));
        entries
    }

    pub fn robots(&self, limit: Option<usize>) -> Vec<BrowserRobotJob> {
        let mut jobs = lock_or_recover(&self.state).robots.clone();
        jobs.sort_by_key(|entry| entry.updated_at_ms);
        jobs.reverse();
        jobs.truncate(limit.unwrap_or(200).min(1000));
        jobs
    }
}
