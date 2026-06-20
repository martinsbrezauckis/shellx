use app_lib::shellx_browser::{
    browser_ad_decision_for_url, BrowserActionRequest, BrowserAdMode, BrowserAutonomyMode,
    BrowserBookmarkKind, BrowserBookmarkUpsertRequest, BrowserClearHistoryRequest,
    BrowserConsoleLogRequest, BrowserDeveloperModeApprovalRequest,
    BrowserDeveloperModeUpdateRequest, BrowserDialogRecordRequest, BrowserDialogResolveRequest,
    BrowserDomSummary, BrowserDownloadRequest, BrowserObservation, BrowserPermissionRecordRequest,
    BrowserPermissionResolveRequest, BrowserPrivacyUpdateRequest, BrowserSessionGrantRequest,
    BrowserSessionGrantResolveRequest, BrowserShieldUpdateRequest,
    BrowserSiteShieldOverrideRequest, BrowserSiteShieldRemoveRequest, BrowserTabHeartbeatRequest,
    BrowserTabLockRequest, BrowserTabUnlockRequest, BrowserTaskAutonomyUpdateRequest,
    BrowserTaskControlRequest, BrowserTransferApprovalRequest, BrowserTransferCompleteRequest,
    BrowserUploadRequest, BrowserVaultCredentialRequest, BrowserVaultDepositRequest,
    ShellxBrowserRegistry, StartBrowserTaskRequest, BROWSER_ENGINE_WEBVIEW_LABEL,
};

#[test]
fn browser_registry_starts_with_small_owned_profile_set() {
    let registry = ShellxBrowserRegistry::default();
    let state = registry.state();

    let profile_ids = state
        .profiles
        .iter()
        .map(|profile| profile.profile_id.as_str())
        .collect::<Vec<_>>();
    assert_eq!(
        profile_ids,
        vec!["personal", "agent-work", "task-disposable"]
    );
    assert!(state
        .profiles
        .iter()
        .any(|profile| profile.profile_id == "agent-work" && profile.agent_default));
    assert!(state
        .profiles
        .iter()
        .any(|profile| profile.profile_id == "agent-work"
            && profile
                .storage_root
                .as_deref()
                .unwrap_or_default()
                .contains("agent-work")));
}

#[test]
fn browser_shields_support_per_site_overrides() {
    let registry = ShellxBrowserRegistry::default();
    let task = registry
        .start_task(StartBrowserTaskRequest {
            goal: "Use site-specific shields".to_string(),
            start_url: Some("https://example.com/dashboard".to_string()),
            profile_id: Some("agent-work".to_string()),
            expected_domains: Some(vec!["example.com".to_string()]),
            ..StartBrowserTaskRequest::default()
        })
        .expect("task starts");

    let state = registry.state();
    assert!(state.shields.enabled);
    assert_eq!(state.shields.ad_tracker_mode, "balanced");
    assert_eq!(state.shields.cookie_mode, "blockThirdParty");
    assert_eq!(state.shields.fingerprinting_mode, "compatibility");
    assert!(state.shields.https_upgrade_enabled);
    assert!(!state.shields.script_blocking_enabled);

    let denied_global = registry
        .update_shields(BrowserShieldUpdateRequest {
            enabled: Some(false),
            ..BrowserShieldUpdateRequest::default()
        })
        .expect_err("global Shields updates require operator approval");
    assert!(
        denied_global.contains("operator"),
        "denial should explain operator requirement: {}",
        denied_global
    );

    let denied_site = registry
        .update_site_shields(BrowserSiteShieldOverrideRequest {
            host: "example.com".to_string(),
            ad_tracker_mode: Some("strict".to_string()),
            cookie_mode: Some("blockThirdParty".to_string()),
            fingerprinting_mode: Some("compatibility".to_string()),
            https_upgrade_enabled: Some(true),
            script_blocking_enabled: Some(true),
            ..BrowserSiteShieldOverrideRequest::default()
        })
        .expect_err("site Shields updates require operator approval");
    assert!(
        denied_site.contains("operator"),
        "denial should explain operator requirement: {}",
        denied_site
    );

    let update = registry
        .update_site_shields(BrowserSiteShieldOverrideRequest {
            host: "example.com".to_string(),
            ad_tracker_mode: Some("strict".to_string()),
            cookie_mode: Some("blockThirdParty".to_string()),
            fingerprinting_mode: Some("compatibility".to_string()),
            https_upgrade_enabled: Some(true),
            script_blocking_enabled: Some(true),
            operator_approved: true,
        })
        .expect("site override can be saved");

    assert_eq!(update.receipt.kind, "browserSiteShieldOverrideSaved");
    assert_eq!(update.override_settings.host, "example.com");
    assert!(update.override_settings.script_blocking_enabled);

    let state = registry.state();
    let tab = state
        .tabs
        .iter()
        .find(|tab| tab.task_id.as_deref() == Some(task.task_id.as_str()))
        .expect("task tab");
    assert_eq!(tab.shields.host.as_deref(), Some("example.com"));
    assert_eq!(tab.shields.effective_ad_tracker_mode, "strict");

    let denied_remove = registry
        .remove_site_shields(BrowserSiteShieldRemoveRequest {
            host: "example.com".to_string(),
            ..BrowserSiteShieldRemoveRequest::default()
        })
        .expect_err("site Shields removal requires operator approval");
    assert!(
        denied_remove.contains("operator"),
        "denial should explain operator requirement: {}",
        denied_remove
    );

    let removed = registry
        .remove_site_shields(BrowserSiteShieldRemoveRequest {
            host: "example.com".to_string(),
            operator_approved: true,
        })
        .expect("operator-approved site override removal succeeds");
    assert_eq!(removed.kind, "browserSiteShieldOverrideRemoved");
    assert!(registry.state().shields.site_overrides.is_empty());
}

#[test]
fn browser_bookmarks_support_folders_and_toolbar_pins() {
    let registry = ShellxBrowserRegistry::default();

    let folder = registry
        .upsert_bookmark(BrowserBookmarkUpsertRequest {
            label: "Work".to_string(),
            kind: Some(BrowserBookmarkKind::Folder),
            parent_id: None,
            url: None,
            toolbar_pinned: Some(true),
            toolbar_order: Some(0),
            ..BrowserBookmarkUpsertRequest::default()
        })
        .expect("folder bookmark can be created");

    let link = registry
        .upsert_bookmark(BrowserBookmarkUpsertRequest {
            label: "Docs".to_string(),
            kind: Some(BrowserBookmarkKind::Link),
            parent_id: Some(folder.bookmark.bookmark_id.clone()),
            url: Some("https://example.com/docs".to_string()),
            toolbar_pinned: Some(false),
            toolbar_order: None,
            ..BrowserBookmarkUpsertRequest::default()
        })
        .expect("link bookmark can be nested under folder");

    let pinned_link = registry
        .upsert_bookmark(BrowserBookmarkUpsertRequest {
            label: "Vault".to_string(),
            kind: Some(BrowserBookmarkKind::Link),
            parent_id: None,
            url: Some("shellx://vault".to_string()),
            toolbar_pinned: Some(true),
            toolbar_order: Some(1),
            ..BrowserBookmarkUpsertRequest::default()
        })
        .expect("direct toolbar bookmark can be pinned");

    let state = registry.state();
    assert!(state
        .bookmarks
        .iter()
        .any(|item| item.bookmark_id == folder.bookmark.bookmark_id
            && item.kind == BrowserBookmarkKind::Folder));
    assert!(state
        .bookmarks
        .iter()
        .any(|item| item.bookmark_id == link.bookmark.bookmark_id
            && item.parent_id == Some(folder.bookmark.bookmark_id.clone())));
    assert!(state
        .bookmarks
        .iter()
        .any(|item| item.bookmark_id == pinned_link.bookmark.bookmark_id && item.toolbar_pinned));
    assert_eq!(state.bookmark_toolbar.len(), 2);
    assert_eq!(
        state.bookmark_toolbar[0].bookmark_id,
        folder.bookmark.bookmark_id
    );
    assert_eq!(state.bookmark_toolbar[0].children.len(), 1);
    assert_eq!(
        state.bookmark_toolbar[1].bookmark_id,
        pinned_link.bookmark.bookmark_id
    );
}

#[test]
fn browser_tabs_lock_out_non_owner_and_allow_owner_actions() {
    let registry = ShellxBrowserRegistry::default();
    let task_a = registry
        .start_task(StartBrowserTaskRequest {
            goal: "Agent A owns this tab".to_string(),
            start_url: Some("https://example.com/a".to_string()),
            profile_id: Some("agent-work".to_string()),
            expected_domains: Some(vec!["example.com".to_string()]),
            ..StartBrowserTaskRequest::default()
        })
        .expect("task A should start");
    let task_b = registry
        .start_task(StartBrowserTaskRequest {
            goal: "Agent B owns a separate tab".to_string(),
            start_url: Some("https://example.com/b".to_string()),
            profile_id: Some("task-disposable".to_string()),
            expected_domains: Some(vec!["example.com".to_string()]),
            ..StartBrowserTaskRequest::default()
        })
        .expect("task B should start");

    let state = registry.state();
    assert_eq!(state.tabs.len(), 2);
    let tab_a = state
        .tabs
        .iter()
        .find(|tab| tab.task_id.as_deref() == Some(task_a.task_id.as_str()))
        .expect("tab A should be attached to task A")
        .clone();
    let tab_b = state
        .tabs
        .iter()
        .find(|tab| tab.task_id.as_deref() == Some(task_b.task_id.as_str()))
        .expect("tab B should be attached to task B")
        .clone();
    assert_ne!(tab_a.browser_tab_id, tab_b.browser_tab_id);
    assert_eq!(
        state.active_browser_tab_id.as_deref(),
        Some(tab_b.browser_tab_id.as_str())
    );

    let locked = registry
        .lock_tab(BrowserTabLockRequest {
            browser_tab_id: tab_a.browser_tab_id.clone(),
            owner_agent_id: "agent-a".to_string(),
            owner_run_id: "run-a".to_string(),
            ttl_seconds: Some(120),
            scope: Some("exclusive".to_string()),
        })
        .expect("tab A should lock");
    let lease_id = locked
        .tab
        .lock
        .as_ref()
        .expect("tab A has lock")
        .lease_id
        .clone();

    let denied_takeover = registry
        .lock_tab(BrowserTabLockRequest {
            browser_tab_id: tab_a.browser_tab_id.clone(),
            owner_agent_id: "agent-b".to_string(),
            owner_run_id: "run-b".to_string(),
            ttl_seconds: Some(120),
            scope: Some("exclusive".to_string()),
        })
        .expect_err("non-owner should not overwrite an active tab lock");
    assert!(
        denied_takeover.contains("already locked"),
        "takeover denial should explain active lock: {}",
        denied_takeover
    );

    let denied_force_unlock = registry
        .unlock_tab(BrowserTabUnlockRequest {
            browser_tab_id: tab_a.browser_tab_id.clone(),
            lease_id: Some("fake-lease".to_string()),
            owner_agent_id: Some("agent-b".to_string()),
            owner_run_id: Some("run-b".to_string()),
            force: true,
        })
        .expect_err("debug/API callers must not force-unlock other agent tabs");
    assert!(
        denied_force_unlock.contains("operator-only"),
        "force unlock denial should call out operator-only path: {}",
        denied_force_unlock
    );

    let denied_observe = registry
        .apply_action(BrowserActionRequest {
            browser_tab_id: Some(tab_a.browser_tab_id.clone()),
            task_id: Some(task_a.task_id.clone()),
            action: "observe".to_string(),
            owner_agent_id: Some("agent-b".to_string()),
            owner_run_id: Some("run-b".to_string()),
            ..BrowserActionRequest::default()
        })
        .expect("locked tab observe should return structured denial");
    assert!(!denied_observe.ok);
    assert_eq!(denied_observe.status, "tabLocked");
    assert_eq!(denied_observe.receipt.kind, "browserTabLockDenied");

    let denied_nav = registry
        .apply_action(BrowserActionRequest {
            browser_tab_id: Some(tab_a.browser_tab_id.clone()),
            task_id: Some(task_a.task_id.clone()),
            action: "navigate".to_string(),
            url: Some("https://example.com/blocked".to_string()),
            owner_agent_id: Some("agent-b".to_string()),
            owner_run_id: Some("run-b".to_string()),
            ..BrowserActionRequest::default()
        })
        .expect("locked tab mutation should return structured denial");
    assert!(!denied_nav.ok);
    assert_eq!(denied_nav.status, "tabLocked");
    assert_eq!(
        denied_nav.current_url.as_deref(),
        Some("https://example.com/a")
    );

    let owner_nav = registry
        .apply_action(BrowserActionRequest {
            browser_tab_id: Some(tab_a.browser_tab_id.clone()),
            task_id: Some(task_a.task_id.clone()),
            action: "navigate".to_string(),
            url: Some("https://example.com/allowed".to_string()),
            owner_agent_id: Some("agent-a".to_string()),
            owner_run_id: Some("run-a".to_string()),
            lock_lease_id: Some(lease_id.clone()),
            ..BrowserActionRequest::default()
        })
        .expect("owner should control locked tab");
    assert_eq!(owner_nav.status, "applied");
    assert_eq!(
        owner_nav.current_url.as_deref(),
        Some("https://example.com/allowed")
    );

    let heartbeat = registry
        .heartbeat_tab(BrowserTabHeartbeatRequest {
            browser_tab_id: tab_a.browser_tab_id.clone(),
            lease_id: lease_id.clone(),
            owner_agent_id: Some("agent-a".to_string()),
            owner_run_id: Some("run-a".to_string()),
            ttl_seconds: Some(180),
        })
        .expect("owner heartbeat should refresh lock");
    assert_eq!(heartbeat.receipt.kind, "browserTabHeartbeat");
    assert!(
        heartbeat
            .tab
            .lock
            .as_ref()
            .expect("lock remains")
            .expires_at_ms
            > heartbeat
                .tab
                .lock
                .as_ref()
                .expect("lock remains")
                .heartbeat_at_ms
    );

    let unlocked = registry
        .unlock_tab(BrowserTabUnlockRequest {
            browser_tab_id: tab_a.browser_tab_id,
            lease_id: Some(lease_id),
            owner_agent_id: Some("agent-a".to_string()),
            owner_run_id: Some("run-a".to_string()),
            force: false,
        })
        .expect("owner unlock should work");
    assert!(unlocked.tab.lock.is_none());
    assert_eq!(unlocked.receipt.kind, "browserTabUnlocked");
}

#[test]
fn browser_navigation_blocks_private_networks_without_explicit_scope() {
    let registry = ShellxBrowserRegistry::default();
    let blocked_start = registry
        .start_task(StartBrowserTaskRequest {
            goal: "Try local metadata".to_string(),
            start_url: Some("http://127.0.0.1:5757/".to_string()),
            profile_id: Some("agent-work".to_string()),
            ..StartBrowserTaskRequest::default()
        })
        .expect_err("private network task starts should require explicit scope");
    assert!(
        blocked_start.contains("private") || blocked_start.contains("local"),
        "private URL rejection should be explicit: {}",
        blocked_start
    );

    let scoped_local = registry
        .start_task(StartBrowserTaskRequest {
            goal: "Use an explicitly scoped local fixture".to_string(),
            start_url: Some("http://127.0.0.1:5757/fixture".to_string()),
            profile_id: Some("agent-work".to_string()),
            expected_domains: Some(vec!["127.0.0.1".to_string()]),
            ..StartBrowserTaskRequest::default()
        })
        .expect("explicitly scoped private host should be allowed");
    assert_eq!(
        scoped_local.current_url.as_deref(),
        Some("http://127.0.0.1:5757/fixture")
    );

    let blocked_nav = registry
        .apply_action(BrowserActionRequest {
            task_id: Some(scoped_local.task_id.clone()),
            action: "navigate".to_string(),
            url: Some("http://169.254.169.254/latest/meta-data/".to_string()),
            ..BrowserActionRequest::default()
        })
        .expect_err("metadata navigation should be rejected");
    assert!(
        blocked_nav.contains("private") || blocked_nav.contains("local"),
        "metadata URL rejection should be explicit: {}",
        blocked_nav
    );

    let public_nav = registry
        .apply_action(BrowserActionRequest {
            task_id: Some(scoped_local.task_id),
            action: "navigate".to_string(),
            url: Some("https://example.com/spec".to_string()),
            ..BrowserActionRequest::default()
        })
        .expect("public navigation should remain allowed");
    assert_eq!(public_nav.status, "applied");
    assert_eq!(
        public_nav.current_url.as_deref(),
        Some("https://example.com/spec")
    );
}

#[test]
fn browser_navigation_blocks_ipv4_mapped_ipv6_private_targets() {
    let registry = ShellxBrowserRegistry::default();
    let blocked = registry
        .start_task(StartBrowserTaskRequest {
            goal: "Try IPv4-mapped loopback".to_string(),
            start_url: Some("http://[::ffff:127.0.0.1]:5757/".to_string()),
            profile_id: Some("agent-work".to_string()),
            ..StartBrowserTaskRequest::default()
        })
        .expect_err("IPv4-mapped loopback must be treated as private");
    assert!(
        blocked.contains("private") || blocked.contains("local"),
        "mapped IPv6 rejection should be explicit: {}",
        blocked
    );
}

#[test]
fn browser_security_state_blocks_agent_credentials_on_insecure_pages() {
    let registry = ShellxBrowserRegistry::default();
    let task = registry
        .start_task(StartBrowserTaskRequest {
            goal: "Fill credentials only on trusted pages".to_string(),
            start_url: Some("http://192.0.2.10/login".to_string()),
            profile_id: Some("agent-work".to_string()),
            expected_domains: Some(vec!["192.0.2.10".to_string()]),
            ..StartBrowserTaskRequest::default()
        })
        .expect("HTTP task can start when the expected domain is explicit");

    let state = registry.state();
    let tab = state
        .tabs
        .iter()
        .find(|tab| tab.task_id.as_deref() == Some(task.task_id.as_str()))
        .expect("task tab");
    assert_eq!(tab.security_state.level, "insecureHttp");
    assert!(!tab.security_state.credential_entry_allowed);

    let blocked = registry
        .apply_action(BrowserActionRequest {
            task_id: Some(task.task_id.clone()),
            browser_tab_id: Some(tab.browser_tab_id.clone()),
            action: "fillRef".to_string(),
            ref_id: Some("password".to_string()),
            value: Some("dummy-value-not-secret".to_string()),
            ..BrowserActionRequest::default()
        })
        .expect("credential-shaped fill should return structured policy block");
    assert_eq!(blocked.status, "blocked");
    assert_eq!(
        blocked.required_approval.as_deref(),
        Some("insecureCredentialEntryApproval")
    );
    assert_eq!(
        blocked.receipt.kind,
        "browserInsecureCredentialEntryBlocked"
    );
    assert_eq!(
        blocked
            .security_state
            .as_ref()
            .map(|state| state.level.as_str()),
        Some("insecureHttp")
    );

    let secure = registry
        .start_task(StartBrowserTaskRequest {
            goal: "Secure credential fill remains grant-gated only".to_string(),
            start_url: Some("https://app.example.test/login".to_string()),
            profile_id: Some("agent-work".to_string()),
            expected_domains: Some(vec!["app.example.test".to_string()]),
            ..StartBrowserTaskRequest::default()
        })
        .expect("HTTPS task should start");
    let fill = registry
        .apply_action(BrowserActionRequest {
            task_id: Some(secure.task_id),
            action: "fillFromVaultGrant".to_string(),
            ref_id: Some("password".to_string()),
            ..BrowserActionRequest::default()
        })
        .expect("secure Vault fill should hit normal credential grant");
    assert_eq!(fill.required_approval.as_deref(), Some("credentialGrant"));
}

#[test]
fn browser_developer_mode_gates_full_cdp_access() {
    let registry = ShellxBrowserRegistry::default();
    let task = registry
        .start_task(StartBrowserTaskRequest {
            goal: "Inspect runtime with explicit Developer Mode approval".to_string(),
            start_url: Some("https://dev.example.test/tools".to_string()),
            profile_id: Some("agent-work".to_string()),
            expected_domains: Some(vec!["dev.example.test".to_string()]),
            ..StartBrowserTaskRequest::default()
        })
        .expect("task should start");
    assert!(!registry.state().developer_mode.enabled);

    let denied = registry
        .apply_action(BrowserActionRequest {
            task_id: Some(task.task_id.clone()),
            action: "cdpCommand".to_string(),
            sensitive_kind: Some("fullCdpAccess".to_string()),
            ..BrowserActionRequest::default()
        })
        .expect("CDP action should be policy-blocked before approval");
    assert_eq!(denied.status, "blocked");
    assert_eq!(
        denied.required_approval.as_deref(),
        Some("browserDeveloperModeApproval")
    );
    assert_eq!(denied.receipt.kind, "browserCdpAccessRequested");

    let settings = registry
        .update_developer_mode(BrowserDeveloperModeUpdateRequest {
            enabled: Some(true),
            full_cdp_access: Some(true),
            operator_approved: true,
            ..BrowserDeveloperModeUpdateRequest::default()
        })
        .expect("Developer Mode can be enabled");
    assert!(settings.enabled);
    assert!(settings.full_cdp_access);

    let denied_host = registry
        .apply_action(BrowserActionRequest {
            task_id: Some(task.task_id.clone()),
            action: "cdpCommand".to_string(),
            sensitive_kind: Some("fullCdpAccess".to_string()),
            ..BrowserActionRequest::default()
        })
        .expect("CDP action should still require host approval");
    assert_eq!(denied_host.status, "blocked");
    assert_eq!(denied_host.receipt.kind, "browserCdpAccessRequested");

    let approved = registry
        .approve_developer_mode_host(BrowserDeveloperModeApprovalRequest {
            task_id: Some(task.task_id.clone()),
            full_cdp_access: Some(true),
            operator_approved: true,
            ..BrowserDeveloperModeApprovalRequest::default()
        })
        .expect("active task host should be approved");
    assert!(approved
        .approved_hosts
        .iter()
        .any(|host| host == "dev.example.test"));

    let allowed = registry
        .apply_action(BrowserActionRequest {
            task_id: Some(task.task_id),
            action: "cdpCommand".to_string(),
            sensitive_kind: Some("fullCdpAccess".to_string()),
            ..BrowserActionRequest::default()
        })
        .expect("approved CDP action should reach engine-required path");
    assert_eq!(allowed.status, "requiresEngine");
    assert_eq!(allowed.required_approval, None);
}

#[test]
fn browser_developer_mode_approval_is_not_self_service() {
    let registry = ShellxBrowserRegistry::default();
    let task = registry
        .start_task(StartBrowserTaskRequest {
            goal: "Try self-approving Developer Mode".to_string(),
            start_url: Some("https://dev.example.test/tools".to_string()),
            profile_id: Some("agent-work".to_string()),
            expected_domains: Some(vec!["dev.example.test".to_string()]),
            ..StartBrowserTaskRequest::default()
        })
        .expect("task should start");

    let denied = registry
        .approve_developer_mode_host(BrowserDeveloperModeApprovalRequest {
            task_id: Some(task.task_id),
            full_cdp_access: Some(true),
            ..BrowserDeveloperModeApprovalRequest::default()
        })
        .expect_err("agent-facing approval must require an operator gesture");
    assert!(
        denied.contains("operator") || denied.contains("approval"),
        "denial should explain operator requirement: {}",
        denied
    );
}

#[test]
fn browser_developer_mode_operator_markers_are_internal() {
    let registry = ShellxBrowserRegistry::default();
    let forged_update: BrowserDeveloperModeUpdateRequest =
        serde_json::from_value(serde_json::json!({
            "enabled": true,
            "fullCdpAccess": true,
            "operatorApproved": true
        }))
        .expect("developer mode update request should deserialize");
    assert!(
        !forged_update.operator_approved,
        "operator approval must not be forgeable from JSON"
    );
    let denied_update = registry
        .update_developer_mode(forged_update)
        .expect_err("JSON-forged Developer Mode updates require a real operator path");
    assert!(
        denied_update.contains("operator"),
        "denial should explain operator requirement: {}",
        denied_update
    );

    let denied_disable = registry
        .update_developer_mode(BrowserDeveloperModeUpdateRequest {
            enabled: Some(false),
            ..BrowserDeveloperModeUpdateRequest::default()
        })
        .expect_err("Developer Mode disabling also belongs to the operator path");
    assert!(
        denied_disable.contains("operator"),
        "denial should explain operator requirement: {}",
        denied_disable
    );

    let forged_approval: BrowserDeveloperModeApprovalRequest =
        serde_json::from_value(serde_json::json!({
            "host": "dev.example.test",
            "fullCdpAccess": true,
            "operatorApproved": true
        }))
        .expect("developer mode approval request should deserialize");
    assert!(
        !forged_approval.operator_approved,
        "host approval must not be forgeable from JSON"
    );
    let denied_approval = registry
        .approve_developer_mode_host(forged_approval)
        .expect_err("JSON-forged Developer Mode host approval requires a real operator path");
    assert!(
        denied_approval.contains("operator"),
        "denial should explain operator requirement: {}",
        denied_approval
    );
}

#[test]
fn browser_privacy_modes_and_profile_storage_are_exposed() {
    let registry = ShellxBrowserRegistry::default();
    let state = registry.state();

    assert_eq!(state.privacy.global_ad_mode, BrowserAdMode::Balanced);
    assert_eq!(
        state.privacy.identity_policy,
        "platformDefaultChromiumWebView"
    );
    assert!(!state.privacy.exposes_shellx_identity);
    assert!(state.profiles.iter().all(|profile| profile
        .storage_root
        .as_deref()
        .unwrap_or("")
        .contains(".shellx")));

    let denied = registry
        .update_privacy(BrowserPrivacyUpdateRequest {
            global_ad_mode: Some(BrowserAdMode::Off),
            profile_id: Some("agent-work".to_string()),
            profile_ad_mode: Some(BrowserAdMode::VisualCleanCompatibility),
            ..BrowserPrivacyUpdateRequest::default()
        })
        .expect_err("privacy update should require operator approval");
    assert!(
        denied.contains("operator"),
        "denial should explain operator requirement: {}",
        denied
    );

    let updated = registry
        .update_privacy(BrowserPrivacyUpdateRequest {
            global_ad_mode: Some(BrowserAdMode::Off),
            profile_id: Some("agent-work".to_string()),
            profile_ad_mode: Some(BrowserAdMode::VisualCleanCompatibility),
            operator_approved: true,
        })
        .expect("operator-approved privacy update should apply");

    assert_eq!(updated.global_ad_mode, BrowserAdMode::Off);
    let profile_mode = updated
        .profile_modes
        .iter()
        .find(|mode| mode.profile_id == "agent-work")
        .expect("agent profile override exists");
    assert_eq!(
        profile_mode.ad_mode,
        BrowserAdMode::VisualCleanCompatibility
    );

    let state = registry.state();
    assert_eq!(state.privacy.global_ad_mode, BrowserAdMode::Off);
    assert!(state
        .receipts
        .iter()
        .any(|receipt| receipt.kind == "browserPrivacyModeChanged"));
}

#[test]
fn browser_file_transfer_requests_are_intent_backed() {
    let registry = ShellxBrowserRegistry::default();
    let task = registry
        .start_task(StartBrowserTaskRequest {
            goal: "Download a statement and upload a selected form".to_string(),
            start_url: Some("https://example.com/account".to_string()),
            profile_id: Some("agent-work".to_string()),
            expected_domains: Some(vec!["example.com".to_string()]),
            ..StartBrowserTaskRequest::default()
        })
        .expect("task should start");
    let tab = registry
        .state()
        .tabs
        .iter()
        .find(|tab| tab.task_id.as_deref() == Some(task.task_id.as_str()))
        .expect("task tab")
        .clone();

    let download = registry
        .request_download_intent(BrowserDownloadRequest {
            task_id: Some(task.task_id.clone()),
            browser_tab_id: Some(tab.browser_tab_id.clone()),
            url: "https://example.com/statement.pdf".to_string(),
            file_name: Some("statement.pdf".to_string()),
            destination_dir: Some("/home/user/downloads".to_string()),
            reason: "User asked the agent to download the account statement".to_string(),
        })
        .expect("download intent should be recorded");
    assert_eq!(download.status, "requested");
    assert_eq!(download.direction, "download");
    assert_eq!(
        download.destination.as_deref(),
        Some("/home/user/downloads")
    );
    assert_eq!(download.receipt.kind, "browserDownloadRequested");
    let rejected_completion = registry
        .complete_download(BrowserTransferCompleteRequest {
            transfer_id: download.transfer_id.clone(),
            final_path: Some("/home/user/downloads/statement.pdf".to_string()),
            mime_type: Some("application/pdf".to_string()),
            bytes: Some(4096),
            sha256: Some("a".repeat(64)),
            retention_reason: Some("User asked to retain the downloaded statement".to_string()),
            ..BrowserTransferCompleteRequest::default()
        })
        .expect_err("download completion without approval should fail");
    assert!(rejected_completion.contains("approvalId"));
    let rejected_forged_completion = registry
        .complete_download(BrowserTransferCompleteRequest {
            transfer_id: download.transfer_id.clone(),
            final_path: Some("/root/statement.pdf".to_string()),
            mime_type: Some("application/pdf".to_string()),
            bytes: Some(4096),
            sha256: Some("a".repeat(64)),
            retention_reason: Some("User asked to retain the downloaded statement".to_string()),
            approval_id: Some("not-a-host-granted-approval".to_string()),
            ..BrowserTransferCompleteRequest::default()
        })
        .expect_err("download completion with forged approval should fail before path checks");
    assert!(
        rejected_forged_completion.contains("host-granted"),
        "forged approval denial should not expose filesystem validation ordering: {}",
        rejected_forged_completion
    );
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
    let download_final_path = format!("{home}/.shellx/test-transfer/statement.pdf");
    let upload_final_path = format!("{home}/.shellx/test-transfer/tax-form.pdf");

    let completed_download = registry
        .grant_transfer_for_user(BrowserTransferApprovalRequest {
            transfer_id: download.transfer_id.clone(),
            direction: "download".to_string(),
            sha256: Some("a".repeat(64)),
            origin: Some("https://example.com".to_string()),
            ttl_seconds: Some(900),
            operator_approved: true,
        })
        .and_then(|approval| {
            registry.complete_download(BrowserTransferCompleteRequest {
                transfer_id: download.transfer_id.clone(),
                final_path: Some(download_final_path.clone()),
                mime_type: Some("application/pdf".to_string()),
                bytes: Some(4096),
                sha256: Some("a".repeat(64)),
                source_url: Some("https://example.com/statement.pdf?token=redacted".to_string()),
                destination: Some("local-downloads".to_string()),
                retention_reason: Some("User asked to retain the downloaded statement".to_string()),
                approval_id: Some(approval.approval_id),
            })
        })
        .expect("host-approved download completion should be recorded");
    assert_eq!(completed_download.status, "completed");
    assert_eq!(completed_download.receipt.kind, "browserDownloadCompleted");
    assert_eq!(
        completed_download.final_path.as_deref(),
        Some(download_final_path.as_str())
    );
    assert_eq!(
        completed_download.mime_type.as_deref(),
        Some("application/pdf")
    );
    assert_eq!(completed_download.content_kind.as_deref(), Some("document"));
    assert_eq!(completed_download.bytes, Some(4096));
    assert_eq!(
        completed_download.sha256.as_deref(),
        Some("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
    );
    assert!(completed_download
        .approval_id
        .as_deref()
        .unwrap_or_default()
        .starts_with("browser-transfer-approval-"));
    assert_eq!(
        completed_download.source_url.as_deref(),
        Some("https://example.com/statement.pdf")
    );

    let upload = registry
        .request_upload_intent(BrowserUploadRequest {
            task_id: Some(task.task_id.clone()),
            browser_tab_id: Some(tab.browser_tab_id.clone()),
            file_path: "/home/user/forms/tax-form.pdf".to_string(),
            display_name: Some("tax-form.pdf".to_string()),
            destination_origin: Some("https://example.com".to_string()),
            ref_id: Some("upload".to_string()),
            reason: "User selected the tax form for upload".to_string(),
        })
        .expect("upload intent should be recorded");
    assert_eq!(upload.status, "requested");
    assert_eq!(upload.direction, "upload");
    assert_eq!(upload.receipt.kind, "browserUploadRequested");
    let completed_upload = registry
        .grant_transfer_for_user(BrowserTransferApprovalRequest {
            transfer_id: upload.transfer_id.clone(),
            direction: "upload".to_string(),
            sha256: Some("b".repeat(64)),
            origin: Some("https://example.com".to_string()),
            ttl_seconds: Some(900),
            operator_approved: true,
        })
        .and_then(|approval| {
            registry.complete_upload(BrowserTransferCompleteRequest {
                transfer_id: upload.transfer_id.clone(),
                final_path: Some(upload_final_path.clone()),
                mime_type: Some("application/pdf".to_string()),
                bytes: Some(8192),
                sha256: Some("b".repeat(64)),
                source_url: Some("https://example.com/upload".to_string()),
                destination: Some("https://example.com".to_string()),
                retention_reason: Some("User asked to keep an upload receipt".to_string()),
                approval_id: Some(approval.approval_id),
            })
        })
        .expect("host-approved upload completion should be recorded");
    assert_eq!(completed_upload.status, "completed");
    assert_eq!(completed_upload.receipt.kind, "browserUploadCompleted");
    assert_eq!(completed_upload.content_kind.as_deref(), Some("document"));
    assert_eq!(
        completed_upload.destination.as_deref(),
        Some("https://example.com")
    );

    let raw_download = registry
        .apply_action(BrowserActionRequest {
            task_id: Some(task.task_id.clone()),
            action: "downloadFile".to_string(),
            ..BrowserActionRequest::default()
        })
        .expect("raw download action remains gated");
    assert_eq!(
        raw_download.required_approval.as_deref(),
        Some("downloadApproval")
    );

    let raw_upload = registry
        .apply_action(BrowserActionRequest {
            task_id: Some(task.task_id),
            action: "uploadFile".to_string(),
            ..BrowserActionRequest::default()
        })
        .expect("raw upload action remains gated");
    assert_eq!(raw_upload.required_approval.as_deref(), Some("fileGrant"));
}

#[test]
fn browser_engine_labels_include_active_tab_identity() {
    let registry = ShellxBrowserRegistry::default();
    let task = registry
        .start_task(StartBrowserTaskRequest {
            goal: "Bind visible engine to the active Browser tab".to_string(),
            start_url: Some("https://example.com/engine".to_string()),
            profile_id: Some("agent-work".to_string()),
            expected_domains: Some(vec!["example.com".to_string()]),
            ..StartBrowserTaskRequest::default()
        })
        .expect("task should start");
    let state = registry.state();
    let tab = state
        .tabs
        .iter()
        .find(|tab| tab.task_id.as_deref() == Some(task.task_id.as_str()))
        .expect("task tab");

    assert!(tab.engine_id.starts_with("browser-engine-agent-"));
    let engine_webview_label = tab
        .engine_webview_label
        .as_deref()
        .expect("task tab should have an engine webview label");
    assert!(engine_webview_label.starts_with(BROWSER_ENGINE_WEBVIEW_LABEL));
    assert_ne!(engine_webview_label, BROWSER_ENGINE_WEBVIEW_LABEL);
    let engine = state
        .engine_pool
        .engines
        .iter()
        .find(|engine| engine.engine_id == tab.engine_id)
        .expect("task tab should have a matching engine pool entry");
    assert_eq!(engine.webview_label, engine_webview_label);
    assert_eq!(
        state.active_browser_tab_id.as_deref(),
        Some(tab.browser_tab_id.as_str())
    );
    assert!(tab.active);
    assert_eq!(tab.url.as_deref(), Some("https://example.com/engine"));
}

#[test]
fn browser_ad_decisions_are_deterministic_by_mode() {
    let off =
        browser_ad_decision_for_url(&BrowserAdMode::Off, "https://ad.doubleclick.net/banner.js");
    assert!(!off.suppressed);
    assert!(!off.presentation_masked);
    assert_eq!(off.mode, BrowserAdMode::Off);

    let balanced = browser_ad_decision_for_url(
        &BrowserAdMode::Balanced,
        "https://ad.doubleclick.net/banner.js",
    );
    assert!(balanced.suppressed);
    assert!(!balanced.presentation_masked);
    assert_eq!(balanced.category.as_deref(), Some("advertising"));
    assert_eq!(balanced.rule_id.as_deref(), Some("host:doubleclick"));

    let visual = browser_ad_decision_for_url(
        &BrowserAdMode::VisualCleanCompatibility,
        "https://ad.doubleclick.net/banner.js",
    );
    assert!(!visual.suppressed);
    assert!(visual.presentation_masked);
    assert_eq!(visual.category.as_deref(), Some("advertising"));

    let first_party =
        browser_ad_decision_for_url(&BrowserAdMode::Balanced, "https://example.com/app.js");
    assert!(!first_party.suppressed);
    assert!(!first_party.presentation_masked);
    assert_eq!(first_party.category, None);
}

#[test]
fn browser_task_navigation_observation_and_sensitive_action_receipts_are_deterministic() {
    let registry = ShellxBrowserRegistry::default();
    let task = registry
        .start_task(StartBrowserTaskRequest {
            goal: "Read a public product spec and prepare a private summary".to_string(),
            start_url: Some("https://example.com/spec".to_string()),
            profile_id: Some("agent-work".to_string()),
            autonomy: Some(BrowserAutonomyMode::AssistedAutonomous),
            expected_domains: Some(vec!["example.com".to_string()]),
            ..StartBrowserTaskRequest::default()
        })
        .expect("task should start");

    assert_eq!(task.profile_id, "agent-work");
    assert_eq!(task.status, "running");
    let autonomy_update = registry
        .update_task_autonomy(BrowserTaskAutonomyUpdateRequest {
            task_id: Some(task.task_id.clone()),
            autonomy: BrowserAutonomyMode::ApprovalFirst,
        })
        .expect("active task autonomy should update");
    assert_eq!(autonomy_update.autonomy, BrowserAutonomyMode::ApprovalFirst);
    assert!(registry
        .state()
        .receipts
        .iter()
        .any(|receipt| receipt.kind == "browserTaskAutonomyUpdated"));

    let nav = registry
        .apply_action(BrowserActionRequest {
            task_id: Some(task.task_id.clone()),
            action: "navigate".to_string(),
            url: Some("https://example.com/spec".to_string()),
            ..BrowserActionRequest::default()
        })
        .expect("navigation should be accepted");
    assert_eq!(nav.status, "applied");
    assert_eq!(nav.current_url.as_deref(), Some("https://example.com/spec"));
    assert_eq!(nav.receipt.kind, "browserNavigated");

    let observe = registry
        .apply_action(BrowserActionRequest {
            task_id: Some(task.task_id.clone()),
            action: "observe".to_string(),
            ..BrowserActionRequest::default()
        })
        .expect("observe should be accepted");
    assert_eq!(observe.status, "applied");
    assert_eq!(observe.receipt.kind, "browserPageObserved");
    let observation = observe.observation.as_ref().expect("observation");
    assert!(observation.refs.iter().any(|item| item.ref_id == "page"));
    assert_eq!(observation.dom_summary.links, 0);
    assert_eq!(observation.dom_summary.text_bytes, observation.text.len());
    assert!(observation.form_fields.is_empty());
    assert!(observation
        .accessibility_tree
        .iter()
        .any(|item| item.ref_id.as_deref() == Some("page")));
    assert!(observation
        .accessibility_tree
        .iter()
        .any(|item| item.ref_id.as_deref() == Some("address")));

    let blocked = registry
        .apply_action(BrowserActionRequest {
            task_id: Some(task.task_id.clone()),
            action: "submitFinal".to_string(),
            ref_id: Some("submit".to_string()),
            ..BrowserActionRequest::default()
        })
        .expect("blocked action should still return a structured result");
    assert_eq!(blocked.status, "blocked");
    assert_eq!(blocked.receipt.kind, "browserActionBlocked");
    assert_eq!(
        blocked.required_approval.as_deref(),
        Some("finalActionApproval")
    );

    let receipts = registry.receipts(None);
    let kinds = receipts
        .iter()
        .map(|receipt| receipt.kind.as_str())
        .collect::<Vec<_>>();
    assert!(kinds.contains(&"browserTaskStarted"));
    assert!(kinds.contains(&"browserProfileOpened"));
    assert!(kinds.contains(&"browserNavigated"));
    assert!(kinds.contains(&"browserPageObserved"));
    assert!(kinds.contains(&"browserActionBlocked"));
}

#[test]
fn browser_history_and_bookmark_current_track_real_navigation() {
    let registry = ShellxBrowserRegistry::default();
    let task = registry
        .start_task(StartBrowserTaskRequest {
            goal: "Research docs and keep useful pages".to_string(),
            start_url: Some("https://example.com/start".to_string()),
            profile_id: Some("agent-work".to_string()),
            autonomy: Some(BrowserAutonomyMode::AssistedAutonomous),
            expected_domains: Some(vec!["example.com".to_string()]),
            ..StartBrowserTaskRequest::default()
        })
        .expect("task should start");

    assert_eq!(registry.state().history.len(), 1);
    assert_eq!(registry.state().history[0].url, "https://example.com/start");

    registry
        .apply_action(BrowserActionRequest {
            task_id: Some(task.task_id.clone()),
            action: "navigate".to_string(),
            url: Some("https://example.com/docs".to_string()),
            ..BrowserActionRequest::default()
        })
        .expect("navigation should be recorded");

    let state = registry.state();
    assert_eq!(state.history.len(), 2);
    assert_eq!(state.history[0].url, "https://example.com/docs");
    assert_eq!(state.history[0].profile_id, "agent-work");

    let bookmark = registry
        .apply_action(BrowserActionRequest {
            task_id: Some(task.task_id.clone()),
            action: "bookmarkCurrent".to_string(),
            value: Some("Docs page".to_string()),
            ..BrowserActionRequest::default()
        })
        .expect("current page should be bookmarkable");
    assert_eq!(bookmark.status, "applied");
    assert_eq!(bookmark.receipt.kind, "browserBookmarkSaved");

    let state = registry.state();
    assert!(state.bookmarks.iter().any(|item| item.url.as_deref()
        == Some("https://example.com/docs")
        && item.label == "Docs page"));
    assert!(state
        .receipts
        .iter()
        .any(|receipt| receipt.kind == "browserBookmarkSaved"));

    let blocked_clear = registry
        .apply_action(BrowserActionRequest {
            task_id: Some(task.task_id.clone()),
            action: "clearHistory".to_string(),
            ..BrowserActionRequest::default()
        })
        .expect("debug API clear history should return a policy response");
    assert_eq!(blocked_clear.status, "blocked");
    assert_eq!(
        blocked_clear.required_approval.as_deref(),
        Some("destructiveActionApproval")
    );
    assert_eq!(registry.state().history.len(), 2);

    let clear_receipt = registry.clear_history(BrowserClearHistoryRequest {
        operator_approved: true,
    });
    assert!(clear_receipt.is_ok());
    let clear_receipt = clear_receipt.expect("operator clear-history should succeed");
    assert_eq!(clear_receipt.kind, "browserHistoryCleared");
    assert!(registry.state().history.is_empty());
}

#[test]
fn browser_clear_history_markers_are_internal() {
    let registry = ShellxBrowserRegistry::default();
    let task = registry
        .start_task(StartBrowserTaskRequest {
            goal: "Create history before clearing".to_string(),
            start_url: Some("https://example.com/start".to_string()),
            profile_id: Some("agent-work".to_string()),
            autonomy: Some(BrowserAutonomyMode::AssistedAutonomous),
            expected_domains: Some(vec!["example.com".to_string()]),
            ..StartBrowserTaskRequest::default()
        })
        .expect("task should start");
    registry
        .apply_action(BrowserActionRequest {
            task_id: Some(task.task_id),
            action: "navigate".to_string(),
            url: Some("https://example.com/next".to_string()),
            ..BrowserActionRequest::default()
        })
        .expect("navigation should add history");
    assert_eq!(registry.state().history.len(), 2);

    let forged_request: BrowserClearHistoryRequest = serde_json::from_value(serde_json::json!({
        "operatorApproved": true
    }))
    .expect("forged request should parse");
    assert!(
        !forged_request.operator_approved,
        "operator marker must not be deserializable"
    );
    let rejected = registry
        .clear_history(forged_request)
        .expect_err("clear-history should require operator path");
    assert!(rejected.contains("browser_destructive_action_requires_operator"));
    assert_eq!(registry.state().history.len(), 2);

    let receipt = registry
        .clear_history(BrowserClearHistoryRequest {
            operator_approved: true,
        })
        .expect("operator-approved clear-history should succeed");
    assert_eq!(receipt.kind, "browserHistoryCleared");
    assert!(registry.state().history.is_empty());
}

#[test]
fn browser_actions_return_compact_agent_step_summary() {
    let registry = ShellxBrowserRegistry::default();
    let task = registry
        .start_task(StartBrowserTaskRequest {
            goal: "Use a compact action loop".to_string(),
            start_url: Some("https://example.com/dashboard".to_string()),
            profile_id: Some("agent-work".to_string()),
            autonomy: Some(BrowserAutonomyMode::AssistedAutonomous),
            expected_domains: Some(vec!["example.com".to_string()]),
            ..StartBrowserTaskRequest::default()
        })
        .expect("task should start");

    let observed = registry
        .apply_action(BrowserActionRequest {
            task_id: Some(task.task_id.clone()),
            action: "observe".to_string(),
            ..BrowserActionRequest::default()
        })
        .expect("observe should return structured response");
    let summary = observed
        .step_summary
        .as_ref()
        .expect("actions expose compact post-action summary");
    assert_eq!(summary.action, "observe");
    assert_eq!(summary.status, "applied");
    assert_eq!(
        summary.current_url.as_deref(),
        Some("https://example.com/dashboard")
    );
    assert_eq!(summary.security_level, "secure");
    assert!(summary.refs >= 3);
    assert!(summary.accessibility_nodes >= 3);
    assert!(summary.needs_observe);
    assert!(summary
        .next_actions
        .iter()
        .any(|action| action == "clickRef"));
    assert!(summary
        .recovery_hints
        .iter()
        .any(|hint| hint.contains("native Browser engine")));

    let blocked = registry
        .apply_action(BrowserActionRequest {
            task_id: Some(task.task_id.clone()),
            action: "clickRef".to_string(),
            ref_id: Some("page".to_string()),
            ..BrowserActionRequest::default()
        })
        .expect("engine-required action should return structured response");
    let blocked_summary = blocked
        .step_summary
        .as_ref()
        .expect("blocked actions also expose recovery summary");
    assert_eq!(blocked_summary.action, "clickRef");
    assert_eq!(blocked_summary.status, "requiresEngine");
    assert!(blocked_summary.needs_observe);
    assert!(blocked_summary
        .recovery_hints
        .iter()
        .any(|hint| hint.contains("native Browser engine")));
}

#[test]
fn browser_step_summary_redacts_oauth_query_and_fragment() {
    let registry = ShellxBrowserRegistry::default();
    let raw_url = "https://accounts.google.com/v3/signin/accountchooser?continue=https%3A%2F%2Faistudio.google.com%2Fapp%2Fapikey&ifkv=secret-oauth-state#fragment-secret";
    let task = registry
        .start_task(StartBrowserTaskRequest {
            goal: "Open AI Studio sign-in".to_string(),
            start_url: Some(raw_url.to_string()),
            profile_id: Some("agent-work".to_string()),
            autonomy: Some(BrowserAutonomyMode::AssistedAutonomous),
            expected_domains: Some(vec!["accounts.google.com".to_string()]),
            ..StartBrowserTaskRequest::default()
        })
        .expect("task should start");

    let observed = registry
        .apply_action(BrowserActionRequest {
            task_id: Some(task.task_id),
            action: "observe".to_string(),
            ..BrowserActionRequest::default()
        })
        .expect("observe should return structured response");
    let summary_url = observed
        .step_summary
        .as_ref()
        .and_then(|summary| summary.current_url.as_deref())
        .expect("step summary includes current URL");

    assert!(
        summary_url.contains("[redacted secret]"),
        "step summary should mark redacted query/fragment: {summary_url}"
    );
    assert!(
        !summary_url.contains("continue=")
            && !summary_url.contains("ifkv=")
            && !summary_url.contains("fragment-secret"),
        "step summary must not expose OAuth query or fragment: {summary_url}"
    );
}

#[test]
fn browser_action_model_covers_mvp_surface_without_faking_engine_work() {
    let registry = ShellxBrowserRegistry::default();
    let task = registry
        .start_task(StartBrowserTaskRequest {
            goal: "Exercise the browser action surface".to_string(),
            start_url: Some("https://example.com/".to_string()),
            profile_id: Some("agent-work".to_string()),
            autonomy: Some(BrowserAutonomyMode::AssistedAutonomous),
            expected_domains: Some(vec!["example.com".to_string()]),
            ..StartBrowserTaskRequest::default()
        })
        .expect("task should start");

    for action in [
        "click",
        "type",
        "scroll",
        "waitFor",
        "select",
        "extractTable",
        "captureScreenshot",
    ] {
        let response = registry
            .apply_action(BrowserActionRequest {
                task_id: Some(task.task_id.clone()),
                action: action.to_string(),
                ref_id: Some("page".to_string()),
                ..BrowserActionRequest::default()
            })
            .expect("engine action should return structured response");
        assert_eq!(response.status, "requiresEngine", "{action}");
        assert!(response.requires_engine, "{action}");
        assert_eq!(response.receipt.kind, "browserActionBlocked", "{action}");
    }

    let upload = registry
        .apply_action(BrowserActionRequest {
            task_id: Some(task.task_id.clone()),
            action: "uploadFile".to_string(),
            ref_id: Some("upload".to_string()),
            ..BrowserActionRequest::default()
        })
        .expect("upload action should be policy-gated");
    assert_eq!(upload.status, "blocked");
    assert_eq!(upload.required_approval.as_deref(), Some("fileGrant"));

    let download = registry
        .apply_action(BrowserActionRequest {
            task_id: Some(task.task_id.clone()),
            action: "downloadFile".to_string(),
            ref_id: Some("download".to_string()),
            ..BrowserActionRequest::default()
        })
        .expect("download action should be policy-gated");
    assert_eq!(download.status, "blocked");
    assert_eq!(
        download.required_approval.as_deref(),
        Some("downloadApproval")
    );

    let fill = registry
        .apply_action(BrowserActionRequest {
            task_id: Some(task.task_id.clone()),
            action: "fillFromVaultGrant".to_string(),
            ref_id: Some("password".to_string()),
            ..BrowserActionRequest::default()
        })
        .expect("vault fill should be policy-gated");
    assert_eq!(fill.status, "blocked");
    assert_eq!(fill.required_approval.as_deref(), Some("credentialGrant"));

    let ask = registry
        .apply_action(BrowserActionRequest {
            task_id: Some(task.task_id.clone()),
            action: "askUser".to_string(),
            ref_id: Some("login".to_string()),
            ..BrowserActionRequest::default()
        })
        .expect("askUser should produce a handoff receipt");
    assert_eq!(ask.status, "blocked");
    assert_eq!(ask.required_approval.as_deref(), Some("userHandoff"));
    assert_eq!(ask.receipt.kind, "browserUserHandoffRequired");
}

#[test]
fn browser_transfer_approval_markers_are_internal() {
    let registry = ShellxBrowserRegistry::default();
    let task = registry
        .start_task(StartBrowserTaskRequest {
            goal: "Try to self-approve a browser transfer".to_string(),
            start_url: Some("https://example.com/account".to_string()),
            profile_id: Some("agent-work".to_string()),
            ..StartBrowserTaskRequest::default()
        })
        .expect("task should start");
    let download = registry
        .request_download_intent(BrowserDownloadRequest {
            task_id: Some(task.task_id),
            browser_tab_id: None,
            url: "https://example.com/statement.pdf".to_string(),
            file_name: Some("statement.pdf".to_string()),
            destination_dir: None,
            reason: "User asked the agent to download a statement".to_string(),
        })
        .expect("download intent should be recorded");
    let forged_approval: BrowserTransferApprovalRequest =
        serde_json::from_value(serde_json::json!({
            "transferId": download.transfer_id,
            "direction": "download",
            "sha256": "a".repeat(64),
            "operatorApproved": true
        }))
        .expect("transfer approval request should deserialize");
    let denied = registry
        .grant_transfer_for_user(forged_approval)
        .expect_err("JSON-forged transfer approvals require a real operator path");
    assert!(
        denied.contains("operator"),
        "denial should explain operator requirement: {}",
        denied
    );
}

#[test]
fn browser_prompt_resolution_markers_are_internal() {
    let registry = ShellxBrowserRegistry::default();
    let task = registry
        .start_task(StartBrowserTaskRequest {
            goal: "Try to self-resolve browser prompts".to_string(),
            start_url: Some("https://example.com/account".to_string()),
            profile_id: Some("agent-work".to_string()),
            ..StartBrowserTaskRequest::default()
        })
        .expect("task should start");
    let dialog = registry
        .record_dialog_event(BrowserDialogRecordRequest {
            task_id: Some(task.task_id.clone()),
            browser_tab_id: None,
            dialog_type: "beforeunload".to_string(),
            text: "Leave site?".to_string(),
            url: Some("https://example.com/account".to_string()),
            requires_approval: true,
        })
        .expect("dialog should be recorded");
    let forged_dialog: BrowserDialogResolveRequest = serde_json::from_value(serde_json::json!({
        "dialogId": dialog.dialog_id,
        "action": "accept",
        "operatorApproved": true
    }))
    .expect("dialog resolve request should deserialize");
    assert!(
        !forged_dialog.operator_approved,
        "dialog operator approval must not be forgeable from JSON"
    );
    let denied_dialog = registry
        .resolve_dialog_event(forged_dialog)
        .expect_err("JSON-forged dialog resolution requires a real operator path");
    assert!(
        denied_dialog.contains("operator"),
        "denial should explain operator requirement: {}",
        denied_dialog
    );
    let operator_dialog = registry
        .record_dialog_event(BrowserDialogRecordRequest {
            task_id: Some(task.task_id.clone()),
            browser_tab_id: None,
            dialog_type: "prompt".to_string(),
            text: "Enter workspace label".to_string(),
            url: Some("https://example.com/account".to_string()),
            requires_approval: true,
        })
        .expect("operator dialog should be recorded");
    let resolved_dialog = registry
        .resolve_dialog_event(BrowserDialogResolveRequest {
            dialog_id: operator_dialog.dialog_id,
            task_id: None,
            action: Some("accept".to_string()),
            prompt_value: Some("redacted".to_string()),
            approval_id: Some("operator-approval".to_string()),
            operator_approved: true,
        })
        .expect("operator-approved dialog resolution succeeds");
    assert_eq!(resolved_dialog.status, "accepted");
    assert!(resolved_dialog.prompt_value_provided);

    let permission = registry
        .record_permission_event(BrowserPermissionRecordRequest {
            task_id: Some(task.task_id),
            browser_tab_id: None,
            permission_kind: "notifications".to_string(),
            url: Some("https://example.com/account".to_string()),
            user_initiated: true,
            requires_approval: true,
        })
        .expect("permission should be recorded");
    let forged_permission: BrowserPermissionResolveRequest =
        serde_json::from_value(serde_json::json!({
            "permissionId": permission.permission_id,
            "action": "grant",
            "operatorApproved": true
        }))
        .expect("permission resolve request should deserialize");
    assert!(
        !forged_permission.operator_approved,
        "permission operator approval must not be forgeable from JSON"
    );
    let denied_permission = registry
        .resolve_permission_event(forged_permission)
        .expect_err("JSON-forged permission resolution requires a real operator path");
    assert!(
        denied_permission.contains("operator"),
        "denial should explain operator requirement: {}",
        denied_permission
    );
    let operator_permission = registry
        .record_permission_event(BrowserPermissionRecordRequest {
            task_id: resolved_dialog.task_id,
            browser_tab_id: None,
            permission_kind: "notifications".to_string(),
            url: Some("https://example.com/account".to_string()),
            user_initiated: true,
            requires_approval: true,
        })
        .expect("operator permission should be recorded");
    let resolved_permission = registry
        .resolve_permission_event(BrowserPermissionResolveRequest {
            permission_id: operator_permission.permission_id,
            action: Some("deny".to_string()),
            approval_id: Some("operator-approval".to_string()),
            operator_approved: true,
        })
        .expect("operator-approved permission resolution succeeds");
    assert_eq!(resolved_permission.status, "denied");
}

#[test]
fn browser_session_grant_resolution_markers_are_internal() {
    let registry = ShellxBrowserRegistry::default();
    let grant = registry
        .request_session_grant(BrowserSessionGrantRequest {
            task_id: None,
            from_profile_id: "personal".to_string(),
            to_profile_id: "agent-work".to_string(),
            reason: "Agent needs this session for one task".to_string(),
            ttl_seconds: Some(900),
        })
        .expect("session grant request should be recorded");
    let forged_resolution: BrowserSessionGrantResolveRequest =
        serde_json::from_value(serde_json::json!({
            "grantId": grant.grant_id,
            "approved": true,
            "operatorApproved": true
        }))
        .expect("session grant resolve request should deserialize");
    assert!(
        !forged_resolution.operator_approved,
        "session grant operator approval must not be forgeable from JSON"
    );
    let denied = registry
        .resolve_session_grant(forged_resolution)
        .expect_err("JSON-forged session grant resolution requires a real operator path");
    assert!(
        denied.contains("operator"),
        "denial should explain operator requirement: {}",
        denied
    );

    let operator_grant = registry
        .request_session_grant(BrowserSessionGrantRequest {
            task_id: None,
            from_profile_id: "personal".to_string(),
            to_profile_id: "agent-work".to_string(),
            reason: "Operator approves this session for one task".to_string(),
            ttl_seconds: Some(900),
        })
        .expect("operator session grant request should be recorded");
    let resolved = registry
        .resolve_session_grant(BrowserSessionGrantResolveRequest {
            grant_id: operator_grant.grant_id,
            approved: true,
            operator_approved: true,
        })
        .expect("operator-approved session grant resolution succeeds");
    assert_eq!(resolved.status, "granted");
}

#[test]
fn browser_task_terminal_states_cancel_pending_session_grants() {
    let registry = ShellxBrowserRegistry::default();

    let completed_task = registry
        .start_task(StartBrowserTaskRequest {
            goal: "Use a remembered session".to_string(),
            start_url: Some("https://example.com/account".to_string()),
            profile_id: Some("agent-work".to_string()),
            autonomy: Some(BrowserAutonomyMode::AssistedAutonomous),
            expected_domains: Some(vec!["example.com".to_string()]),
            ..StartBrowserTaskRequest::default()
        })
        .expect("task should start");
    let completed_grant = registry
        .request_session_grant(BrowserSessionGrantRequest {
            task_id: Some(completed_task.task_id.clone()),
            from_profile_id: "personal".to_string(),
            to_profile_id: "agent-work".to_string(),
            reason: "Use remembered session for this task".to_string(),
            ttl_seconds: Some(900),
        })
        .expect("session grant request should be recorded");
    registry
        .finish_task(
            Some(completed_task.task_id.clone()),
            Some("completed".to_string()),
        )
        .expect("task finish succeeds");
    let state = registry.state();
    let cancelled = state
        .session_grants
        .iter()
        .find(|grant| grant.grant_id == completed_grant.grant_id)
        .expect("completed task grant should still be auditable");
    assert_eq!(cancelled.status, "cancelled");
    assert!(cancelled.resolved_at_ms.is_some());
    assert!(state.receipts.iter().any(|receipt| {
        receipt.kind == "browserSessionGrantCancelled"
            && receipt.task_id.as_deref() == Some(completed_task.task_id.as_str())
    }));

    let paused_task = registry
        .start_task(StartBrowserTaskRequest {
            goal: "Pause without losing grant prompt".to_string(),
            start_url: Some("https://example.com/pause".to_string()),
            profile_id: Some("agent-work".to_string()),
            ..StartBrowserTaskRequest::default()
        })
        .expect("pause task should start");
    let paused_grant = registry
        .request_session_grant(BrowserSessionGrantRequest {
            task_id: Some(paused_task.task_id.clone()),
            from_profile_id: "personal".to_string(),
            to_profile_id: "agent-work".to_string(),
            reason: "Keep prompt while paused".to_string(),
            ttl_seconds: Some(900),
        })
        .expect("paused task grant should be recorded");
    registry
        .control_task(BrowserTaskControlRequest {
            task_id: Some(paused_task.task_id.clone()),
            action: "pause".to_string(),
            reason: None,
            requested_by: Some("test".to_string()),
        })
        .expect("pause succeeds");
    let state = registry.state();
    let still_pending = state
        .session_grants
        .iter()
        .find(|grant| grant.grant_id == paused_grant.grant_id)
        .expect("paused grant should still exist");
    assert_eq!(still_pending.status, "requested");
    assert!(still_pending.resolved_at_ms.is_none());

    let aborted_task = registry
        .start_task(StartBrowserTaskRequest {
            goal: "Abort closes grant prompt".to_string(),
            start_url: Some("https://example.com/abort".to_string()),
            profile_id: Some("agent-work".to_string()),
            ..StartBrowserTaskRequest::default()
        })
        .expect("abort task should start");
    let aborted_grant = registry
        .request_session_grant(BrowserSessionGrantRequest {
            task_id: Some(aborted_task.task_id.clone()),
            from_profile_id: "personal".to_string(),
            to_profile_id: "agent-work".to_string(),
            reason: "Abort should close this".to_string(),
            ttl_seconds: Some(900),
        })
        .expect("aborted task grant should be recorded");
    let aborted = registry
        .control_task(BrowserTaskControlRequest {
            task_id: Some(aborted_task.task_id.clone()),
            action: "abort".to_string(),
            reason: Some("operator cancelled".to_string()),
            requested_by: Some("test".to_string()),
        })
        .expect("abort succeeds");
    assert_eq!(
        aborted.receipt.evidence["cancelledGrants"].as_u64(),
        Some(1)
    );
    let state = registry.state();
    let cancelled = state
        .session_grants
        .iter()
        .find(|grant| grant.grant_id == aborted_grant.grant_id)
        .expect("aborted grant should still be auditable");
    assert_eq!(cancelled.status, "cancelled");
    assert!(cancelled.resolved_at_ms.is_some());

    let takeover_task = registry
        .start_task(StartBrowserTaskRequest {
            goal: "User takeover closes grant prompt".to_string(),
            start_url: Some("https://example.com/takeover".to_string()),
            profile_id: Some("agent-work".to_string()),
            ..StartBrowserTaskRequest::default()
        })
        .expect("takeover task should start");
    let takeover_grant = registry
        .request_session_grant(BrowserSessionGrantRequest {
            task_id: Some(takeover_task.task_id.clone()),
            from_profile_id: "personal".to_string(),
            to_profile_id: "agent-work".to_string(),
            reason: "User takeover should close this".to_string(),
            ttl_seconds: Some(900),
        })
        .expect("takeover task grant should be recorded");
    registry
        .control_task(BrowserTaskControlRequest {
            task_id: Some(takeover_task.task_id.clone()),
            action: "userTakeover".to_string(),
            reason: Some("user took over".to_string()),
            requested_by: Some("test".to_string()),
        })
        .expect("takeover succeeds");
    let state = registry.state();
    let cancelled = state
        .session_grants
        .iter()
        .find(|grant| grant.grant_id == takeover_grant.grant_id)
        .expect("takeover grant should still be auditable");
    assert_eq!(cancelled.status, "cancelled");
    assert!(cancelled.resolved_at_ms.is_some());
}

#[test]
fn browser_console_logs_are_visible_for_debug_api_drivers() {
    let registry = ShellxBrowserRegistry::default();
    let task = registry
        .start_task(StartBrowserTaskRequest {
            goal: "Open a page and expose console failures to the agent".to_string(),
            start_url: Some("https://example.com/app".to_string()),
            profile_id: Some("agent-work".to_string()),
            autonomy: Some(BrowserAutonomyMode::AssistedAutonomous),
            expected_domains: Some(vec!["example.com".to_string()]),
            ..StartBrowserTaskRequest::default()
        })
        .expect("task should start");

    let log = registry
        .record_console_log(BrowserConsoleLogRequest {
            task_id: Some(task.task_id.clone()),
            level: "error".to_string(),
            source: Some("page-console".to_string()),
            message: "Uncaught TypeError: demo is not a function".to_string(),
            url: Some("https://example.com/app".to_string()),
            line: Some(42),
            column: Some(7),
            details: Some(serde_json::json!({ "stack": "demo@app.js:42:7" })),
        })
        .expect("console log should be recorded");

    assert_eq!(log.level, "error");
    assert_eq!(log.task_id.as_deref(), Some(task.task_id.as_str()));
    assert_eq!(log.source, "page-console");
    assert_eq!(log.line, Some(42));

    let logs = registry.console_logs(Some(10));
    assert!(logs.iter().any(|entry| entry.log_id == log.log_id));
    assert!(registry
        .state()
        .console_logs
        .iter()
        .any(|entry| entry.message.contains("Uncaught TypeError")));

    let receipts = registry.receipts(Some(10));
    assert!(receipts
        .iter()
        .any(|receipt| receipt.kind == "browserConsoleError"));

    let fake_token = ["xai-secret-token-", "123456789"].concat();
    let redacted = registry
        .record_console_log(BrowserConsoleLogRequest {
            task_id: Some(task.task_id),
            level: "error".to_string(),
            source: Some("page-console".to_string()),
            message: "Credential-shaped details should be scrubbed".to_string(),
            details: Some(serde_json::json!({
                "Authorization": format!("Bearer {fake_token}")
            })),
            ..BrowserConsoleLogRequest::default()
        })
        .expect("console log details should be accepted");
    let serialized = serde_json::to_string(&redacted).expect("serialize console log");
    assert!(!serialized.contains(&fake_token));
}

#[test]
fn browser_vault_deposit_is_write_only_and_does_not_echo_secret() {
    let registry = ShellxBrowserRegistry::default();
    let task = registry
        .start_task(StartBrowserTaskRequest {
            goal: "Create an AWS API key and deposit it to Vault".to_string(),
            profile_id: Some("agent-work".to_string()),
            autonomy: Some(BrowserAutonomyMode::AssistedAutonomous),
            ..StartBrowserTaskRequest::default()
        })
        .expect("task should start");

    let deposit = registry
        .create_vault_deposit(BrowserVaultDepositRequest {
            task_id: Some(task.task_id),
            label: "AWS API key from signup".to_string(),
            secret_value: "AKIA_TEST_SECRET_SHOULD_NOT_ECHO".to_string(),
            source_url: Some("https://console.aws.amazon.com/".to_string()),
        })
        .expect("deposit should be accepted");

    assert!(deposit.deposit_id.starts_with("browser-deposit-"));
    assert_ne!(
        deposit.storage_commit_hash,
        "AKIA_TEST_SECRET_SHOULD_NOT_ECHO"
    );
    assert_eq!(deposit.server_receipt.id, deposit.deposit_id);
    assert_eq!(
        deposit.server_receipt.payload_hash,
        deposit.storage_commit_hash
    );
    assert!(deposit.server_receipt.created_ms > 0);
    assert!(deposit
        .server_receipt
        .from_token
        .starts_with("browser-agent-token:"));
    let serialized = serde_json::to_string(&deposit).expect("serialize deposit response");
    assert!(!serialized.contains("AKIA_TEST_SECRET_SHOULD_NOT_ECHO"));
    assert_eq!(deposit.receipt.kind, "browserVaultDepositCreated");
    assert!(!deposit
        .receipt
        .summary
        .contains("AKIA_TEST_SECRET_SHOULD_NOT_ECHO"));
}

#[test]
fn browser_vault_fill_receipt_does_not_include_secret() {
    let registry = ShellxBrowserRegistry::default();
    let task = registry
        .start_task(StartBrowserTaskRequest {
            goal: "Fill a login from Vault".to_string(),
            start_url: Some("https://app.example.test/login".to_string()),
            profile_id: Some("agent-work".to_string()),
            autonomy: Some(BrowserAutonomyMode::AssistedAutonomous),
            expected_domains: Some(vec!["app.example.test".to_string()]),
            ..StartBrowserTaskRequest::default()
        })
        .expect("task should start");
    let blocked = registry
        .apply_action(BrowserActionRequest {
            task_id: Some(task.task_id.clone()),
            action: "fillFromVaultGrant".to_string(),
            value: Some("SXV_BROWSER_SECRET_123".to_string()),
            ref_id: Some("password".to_string()),
            sensitive_kind: Some("credentialUse".to_string()),
            ..BrowserActionRequest::default()
        })
        .expect("credential fill should return structured approval block");
    assert!(!blocked.ok);
    assert_eq!(
        blocked.required_approval.as_deref(),
        Some("credentialGrant")
    );
    assert!(!serde_json::to_string(&blocked)
        .unwrap()
        .contains("SXV_BROWSER_SECRET_123"));

    let receipt = registry
        .record_vault_fill_receipt(BrowserVaultCredentialRequest {
            task_id: Some(task.task_id),
            origin: "https://app.example.test".to_string(),
            item_id: "item-login-1".to_string(),
            grant_id: Some("grant-fill".to_string()),
        })
        .expect("fill receipt should be recorded");
    assert!(receipt.ok);
    assert!(!receipt.secret_exposed);
    assert_eq!(receipt.action, "fill");

    let state_json = serde_json::to_string(&registry.state()).unwrap();
    assert!(!state_json.contains("SXV_BROWSER_SECRET_123"));
    assert!(!state_json.contains("passwordValue"));
}

#[test]
fn browser_vault_generate_receipt_does_not_include_secret() {
    let registry = ShellxBrowserRegistry::default();
    let task = registry
        .start_task(StartBrowserTaskRequest {
            goal: "Generate a password".to_string(),
            start_url: Some("https://signup.example.test/".to_string()),
            profile_id: Some("agent-work".to_string()),
            autonomy: Some(BrowserAutonomyMode::AssistedAutonomous),
            expected_domains: Some(vec!["signup.example.test".to_string()]),
            ..StartBrowserTaskRequest::default()
        })
        .expect("task should start");
    let receipt = registry
        .record_vault_generate_receipt(BrowserVaultCredentialRequest {
            task_id: Some(task.task_id),
            origin: "https://signup.example.test".to_string(),
            item_id: "item-new-login".to_string(),
            grant_id: Some("grant-generate".to_string()),
        })
        .expect("generate receipt should be recorded");
    assert!(receipt.ok);
    assert!(!receipt.secret_exposed);
    assert_eq!(receipt.action, "generate");

    let receipt_json = serde_json::to_string(&receipt).unwrap();
    let state_json = serde_json::to_string(&registry.state()).unwrap();
    assert!(!receipt_json.contains("SXV_BROWSER_SECRET_123"));
    assert!(!state_json.contains("SXV_BROWSER_SECRET_123"));
}

#[test]
fn browser_vault_deposit_uses_storage_commit_receipt_shape() {
    let registry = ShellxBrowserRegistry::default();
    let deposit = registry
        .create_vault_deposit(BrowserVaultDepositRequest {
            task_id: Some("task-vault-deposit".to_string()),
            label: "Generated password".to_string(),
            secret_value: "SXV_BROWSER_SECRET_123".to_string(),
            source_url: Some("https://signup.example.test/".to_string()),
        })
        .expect("deposit should be accepted");
    let serialized = serde_json::to_string(&deposit).expect("serialize deposit response");
    assert!(!serialized.contains("SXV_BROWSER_SECRET_123"));
    assert!(deposit
        .receipt
        .evidence
        .get("storageCommitHash")
        .and_then(|value| value.as_str())
        .is_some());
    assert_eq!(
        deposit
            .receipt
            .evidence
            .get("secretExposed")
            .and_then(|value| value.as_bool()),
        Some(false)
    );
    assert!(deposit.receipt.evidence.get("secretValue").is_none());
    assert!(!serde_json::to_string(&registry.state())
        .unwrap()
        .contains("SXV_BROWSER_SECRET_123"));
}

#[test]
fn browser_engine_observation_records_requested_task_context() {
    let registry = ShellxBrowserRegistry::default();
    let first = registry
        .start_task(StartBrowserTaskRequest {
            goal: "Observe the first page".to_string(),
            start_url: Some("https://first.example.test/".to_string()),
            profile_id: Some("agent-work".to_string()),
            expected_domains: Some(vec!["first.example.test".to_string()]),
            ..StartBrowserTaskRequest::default()
        })
        .expect("first task starts");
    let _second = registry
        .start_task(StartBrowserTaskRequest {
            goal: "Observe the second page".to_string(),
            start_url: Some("https://second.example.test/".to_string()),
            profile_id: Some("agent-work".to_string()),
            expected_domains: Some(vec!["second.example.test".to_string()]),
            ..StartBrowserTaskRequest::default()
        })
        .expect("second task starts and becomes active");

    let accepted = registry.record_engine_observation(
        BrowserActionRequest {
            task_id: Some(first.task_id.clone()),
            action: "observe".to_string(),
            ..BrowserActionRequest::default()
        },
        "observe",
        BrowserObservation {
            task_id: first.task_id.clone(),
            snapshot_id: String::new(),
            url: Some("https://first.example.test/".to_string()),
            title: "First page".to_string(),
            text: "First page".to_string(),
            markdown: "# First page\n\nFirst page".to_string(),
            refs: Vec::new(),
            dom_summary: BrowserDomSummary {
                text_bytes: "First page".len(),
                ..BrowserDomSummary::default()
            },
            form_fields: Vec::new(),
            accessibility_tree: Vec::new(),
            privacy_stats: None,
            untrusted_input: true,
            requires_engine: false,
        },
    );

    assert!(
        accepted.is_ok(),
        "engine observation for a background task should update that task's assigned engine"
    );
    let state = registry.state();
    let first_task = state
        .tasks
        .iter()
        .find(|task| task.task_id == first.task_id)
        .expect("first task still exists");
    assert_eq!(
        first_task.current_url.as_deref(),
        Some("https://first.example.test/")
    );
    let first_tab = state
        .tabs
        .iter()
        .find(|tab| tab.task_id.as_deref() == Some(first.task_id.as_str()))
        .expect("first task tab still exists");
    assert_eq!(
        first_tab.url.as_deref(),
        Some("https://first.example.test/")
    );
    assert_eq!(first_tab.title.as_deref(), Some("First page"));
    let first_engine = state
        .engine_pool
        .engines
        .iter()
        .find(|engine| engine.engine_id == first_tab.engine_id)
        .expect("first task engine exists");
    assert_eq!(first_engine.load_status, "observed");
    assert_eq!(
        first_engine.url.as_deref(),
        Some("https://first.example.test/")
    );
}

#[test]
fn browser_debug_api_requests_accept_camel_case_wire_fields() {
    let request: BrowserActionRequest = serde_json::from_value(serde_json::json!({
        "taskId": "browser-task-1",
        "action": "fillRef",
        "refId": "email",
        "value": "user@example.test",
        "sensitiveKind": "credentialUse"
    }))
    .expect("camelCase action request should parse");

    assert_eq!(request.task_id.as_deref(), Some("browser-task-1"));
    assert_eq!(request.action, "fillRef");
    assert_eq!(request.ref_id.as_deref(), Some("email"));
    assert_eq!(request.sensitive_kind.as_deref(), Some("credentialUse"));
}
