use crate::shellx_browser::{
    lock_or_recover, BrowserBookmark, BrowserBookmarkToolbarItem, BrowserDeveloperModeSettings,
    BrowserDialogEvent, BrowserFileTransferEntry, BrowserNetworkEntry, BrowserPermissionEvent,
    BrowserPopupEvent, BrowserPrivacySettings, BrowserProfile, BrowserReceipt, BrowserRobotJob,
    BrowserShieldSettings, BrowserStateSnapshot, BrowserTabSnapshot, BrowserTaskSnapshot,
    ShellxBrowserRegistry,
};

impl ShellxBrowserRegistry {
    pub fn state(&self) -> BrowserStateSnapshot {
        let state = lock_or_recover(&self.state);
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

    pub fn profiles(&self) -> Vec<BrowserProfile> {
        lock_or_recover(&self.state).profiles.clone()
    }

    pub fn tabs(&self) -> Vec<BrowserTabSnapshot> {
        lock_or_recover(&self.state).tabs.clone()
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

    pub fn uploads(&self) -> Vec<BrowserFileTransferEntry> {
        lock_or_recover(&self.state).uploads.clone()
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
        lock_or_recover(&self.state).tasks.clone()
    }

    pub fn receipts(&self, limit: Option<usize>) -> Vec<BrowserReceipt> {
        let mut receipts = lock_or_recover(&self.state).receipts.clone();
        receipts.sort_by_key(|receipt| receipt.t);
        receipts.reverse();
        receipts.truncate(limit.unwrap_or(200).min(1000));
        receipts
    }

    pub fn dialogs(&self, limit: Option<usize>) -> Vec<BrowserDialogEvent> {
        let mut dialogs = lock_or_recover(&self.state).dialogs.clone();
        dialogs.sort_by_key(|entry| entry.created_at_ms);
        dialogs.reverse();
        dialogs.truncate(limit.unwrap_or(200).min(1000));
        dialogs
    }

    pub fn permissions(&self, limit: Option<usize>) -> Vec<BrowserPermissionEvent> {
        let mut permissions = lock_or_recover(&self.state).permissions.clone();
        permissions.sort_by_key(|entry| entry.created_at_ms);
        permissions.reverse();
        permissions.truncate(limit.unwrap_or(200).min(1000));
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

    pub fn robots(&self, limit: Option<usize>) -> Vec<BrowserRobotJob> {
        let mut jobs = lock_or_recover(&self.state).robots.clone();
        jobs.sort_by_key(|entry| entry.updated_at_ms);
        jobs.reverse();
        jobs.truncate(limit.unwrap_or(200).min(1000));
        jobs
    }
}
