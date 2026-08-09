use super::*;

#[derive(serde::Deserialize)]
pub(super) struct SessionActivityQuery {
    #[serde(rename = "tabId", alias = "tab", alias = "tab_id")]
    tab_id: Option<String>,
    #[serde(rename = "sessionId", alias = "session_id")]
    session_id: Option<String>,
    #[serde(rename = "sessionCwd", alias = "cwd", alias = "session_cwd")]
    session_cwd: Option<String>,
    #[serde(default)]
    transport: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SessionActivityDebugResponse {
    #[serde(flatten)]
    source: crate::session_activity::SessionActivitySource,
    report: crate::session_activity::SessionActivityReport,
}

/// `GET /state/session_activity?tabId=X` — read-only source payload for
/// the Activity Browser. The React preview parses the returned session
/// hunk_records JSONL and external agents can consume the same source
/// without scraping UI. The debug API also attaches a compact derived
/// report so monitors do not need to parse JSONL for common summaries.
pub(super) async fn state_session_activity(
    Query(q): Query<SessionActivityQuery>,
    State(s): State<ApiState>,
) -> impl IntoResponse {
    let registry = s.app.state::<std::sync::Arc<crate::acp::SessionRegistry>>();
    let tab_id = resolve_query_tab_or_active(q.tab_id, &s);
    let ui = s.hub().ui_snapshot();
    let open = ui.open_tabs.iter().find(|tab| tab.tab_id == tab_id);
    let active = ui.active_tab.as_ref().filter(|tab| tab.tab_id == tab_id);
    let session_id = q
        .session_id
        .or_else(|| open.and_then(|tab| tab.session_id.clone()));
    let session_cwd = q
        .session_cwd
        .or_else(|| open.and_then(|tab| tab.cwd.clone()))
        .or_else(|| active.and_then(|tab| tab.cwd.clone()));
    let transport = q
        .transport
        .or_else(|| open.and_then(|tab| tab.connection_transport.clone()))
        .or_else(|| active.and_then(|tab| tab.connection_transport.clone()));
    match crate::session_activity::session_activity_source_for_tab_with_fallback(
        Some(tab_id),
        session_id,
        session_cwd,
        transport,
        registry.inner().clone(),
    )
    .await
    {
        Ok(snapshot) => {
            let report = crate::session_activity::build_session_activity_report(&snapshot);
            Json(SessionActivityDebugResponse {
                source: snapshot,
                report,
            })
            .into_response()
        }
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
    }
}

#[derive(Clone, Deserialize)]
pub(super) struct SessionGitQuery {
    #[serde(rename = "tabId", alias = "tab", alias = "tab_id")]
    pub(super) tab_id: Option<String>,
    #[serde(default)]
    pub(super) cwd: Option<String>,
    #[serde(default)]
    scope: Option<String>,
    #[serde(default)]
    pub(super) transport: Option<crate::provider_adapters::ProviderExecutionTransport>,
    #[serde(rename = "wslDistro", alias = "wsl_distro", default)]
    pub(super) wsl_distro: Option<String>,
    #[serde(rename = "sshHost", alias = "ssh_host", default)]
    pub(super) ssh_host: Option<String>,
    #[serde(rename = "sshPort", alias = "ssh_port", default)]
    pub(super) ssh_port: Option<u16>,
    #[serde(rename = "sshKeyVaultRef", alias = "ssh_key_vault_ref", default)]
    pub(super) ssh_key_vault_ref: Option<String>,
}

#[derive(Deserialize, Default)]
pub(super) struct SessionGitCheckpointBody {
    #[serde(rename = "tabId")]
    pub(super) tab_id: Option<String>,
    #[serde(default)]
    pub(super) cwd: Option<String>,
    #[serde(default)]
    label: Option<String>,
    #[serde(default)]
    pub(super) transport: Option<crate::provider_adapters::ProviderExecutionTransport>,
    #[serde(rename = "wslDistro", alias = "wsl_distro", default)]
    wsl_distro: Option<String>,
    #[serde(rename = "sshHost", alias = "ssh_host", default)]
    pub(super) ssh_host: Option<String>,
    #[serde(rename = "sshPort", alias = "ssh_port", default)]
    pub(super) ssh_port: Option<u16>,
    #[serde(rename = "sshKeyVaultRef", alias = "ssh_key_vault_ref", default)]
    pub(super) ssh_key_vault_ref: Option<String>,
}

#[derive(Deserialize, Default)]
pub(super) struct SessionGitWorktreeBody {
    #[serde(rename = "tabId")]
    tab_id: Option<String>,
    #[serde(default)]
    cwd: Option<String>,
    #[serde(rename = "sourceBranch", default)]
    source_branch: Option<String>,
    #[serde(rename = "newBranch", default)]
    new_branch: Option<String>,
    #[serde(default)]
    transport: Option<crate::provider_adapters::ProviderExecutionTransport>,
    #[serde(rename = "wslDistro", alias = "wsl_distro", default)]
    wsl_distro: Option<String>,
    #[serde(rename = "sshHost", alias = "ssh_host", default)]
    ssh_host: Option<String>,
    #[serde(rename = "sshPort", alias = "ssh_port", default)]
    ssh_port: Option<u16>,
    #[serde(rename = "sshKeyVaultRef", alias = "ssh_key_vault_ref", default)]
    ssh_key_vault_ref: Option<String>,
}

pub(super) fn explicit_session_git_provider_context(
    cwd: Option<&str>,
    transport: Option<&crate::provider_adapters::ProviderExecutionTransport>,
    wsl_distro: Option<&str>,
    ssh_host: Option<&str>,
    ssh_port: Option<u16>,
    ssh_key_vault_ref: Option<&str>,
) -> Option<crate::session_git::GitProviderContext> {
    transport.map(|transport| {
        crate::session_git::GitProviderContext::new(
            cwd.unwrap_or_default().to_string(),
            transport.clone(),
            wsl_distro
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToOwned::to_owned),
            ssh_host
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToOwned::to_owned),
            ssh_port,
            ssh_key_vault_ref
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToOwned::to_owned),
        )
    })
}

pub(super) fn session_git_provider_context_for_query(
    provider_registry: &crate::provider_sessions::ProviderSessionRegistry,
    tab_id: &str,
    q: &SessionGitQuery,
    cwd: Option<&str>,
) -> Option<crate::session_git::GitProviderContext> {
    explicit_session_git_provider_context(
        cwd,
        q.transport.as_ref(),
        q.wsl_distro.as_deref(),
        q.ssh_host.as_deref(),
        q.ssh_port,
        q.ssh_key_vault_ref.as_deref(),
    )
    .or_else(|| crate::session_git::git_provider_context_for_tab(provider_registry, tab_id))
}

pub(super) async fn restored_activity_git_provider_context_for_tab(
    s: &ApiState,
    tab_id: &str,
    registry: std::sync::Arc<crate::acp::SessionRegistry>,
) -> Option<crate::session_git::GitProviderContext> {
    let ui = s.hub().ui_snapshot();
    let open = ui.open_tabs.iter().find(|tab| tab.tab_id == tab_id);
    let active = ui.active_tab.as_ref().filter(|tab| tab.tab_id == tab_id);
    let session_id = open.and_then(|tab| tab.session_id.clone());
    let session_cwd = open
        .and_then(|tab| tab.cwd.clone())
        .or_else(|| active.and_then(|tab| tab.cwd.clone()));
    let transport = open
        .and_then(|tab| tab.connection_transport.clone())
        .or_else(|| active.and_then(|tab| tab.connection_transport.clone()));
    let source = crate::session_activity::session_activity_source_for_tab_with_fallback(
        Some(tab_id.to_string()),
        session_id,
        session_cwd,
        transport,
        registry,
    )
    .await
    .ok()?;
    let cwd = source
        .cwd
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())?
        .to_string();
    let transport = match source.transport.as_str() {
        "local" => crate::provider_adapters::ProviderExecutionTransport::Local,
        "wsl" => crate::provider_adapters::ProviderExecutionTransport::Wsl,
        "ssh" => crate::provider_adapters::ProviderExecutionTransport::Ssh,
        _ => return None,
    };
    let wsl_distro = if matches!(
        transport,
        crate::provider_adapters::ProviderExecutionTransport::Wsl
    ) {
        crate::session_activity::wsl_distro_from_scratch_dir(source.scratch_dir.as_deref())
    } else {
        None
    };
    Some(crate::session_git::GitProviderContext::new(
        cwd, transport, wsl_distro, None, None, None,
    ))
}

/// `GET /state/session_git?tabId=X` — read-only mirror of the Git rail
/// status model. The route runs git in the active tab environment and
/// prefers the tab's `agentCwd`, so WSL/SSH reports match what the agent
/// actually touched.
pub(super) async fn state_session_git(
    Query(q): Query<SessionGitQuery>,
    State(s): State<ApiState>,
) -> impl IntoResponse {
    let tab_id = resolve_query_tab_or_active(q.tab_id.clone(), &s);
    let registry = s.app.state::<std::sync::Arc<crate::acp::SessionRegistry>>();
    let provider_registry = s
        .app
        .state::<std::sync::Arc<crate::provider_sessions::ProviderSessionRegistry>>()
        .inner()
        .clone();
    let cwd = q.cwd.clone();
    let mut provider_context =
        session_git_provider_context_for_query(&provider_registry, &tab_id, &q, cwd.as_deref());
    if provider_context.is_none()
        && cwd
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .is_none()
    {
        provider_context =
            restored_activity_git_provider_context_for_tab(&s, &tab_id, registry.inner().clone())
                .await;
    }
    match crate::session_git::git_session_status_for_tab_with_provider(
        registry.inner().clone(),
        Some(tab_id),
        cwd,
        provider_context,
    )
    .await
    {
        Ok(snapshot) => Json(snapshot).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
    }
}

/// `POST /state/session_git/checkpoint` — local checkpoint creation for
/// headless diagnostics and debug-api drivers. This mirrors the desktop
/// Git rail command and never mutates a remote.
pub(super) async fn state_session_git_checkpoint(
    Query(q): Query<SessionGitQuery>,
    State(s): State<ApiState>,
    body: Option<Json<SessionGitCheckpointBody>>,
) -> Response {
    let body = body.map(|Json(b)| b).unwrap_or_default();
    let tab_id = resolve_query_tab_or_active(body.tab_id.clone().or(q.tab_id.clone()), &s);
    let cwd = body.cwd.clone().or(q.cwd.clone());
    let registry = s.app.state::<std::sync::Arc<crate::acp::SessionRegistry>>();
    let provider_registry = s
        .app
        .state::<std::sync::Arc<crate::provider_sessions::ProviderSessionRegistry>>()
        .inner()
        .clone();
    let provider_context = explicit_session_git_provider_context(
        cwd.as_deref(),
        body.transport.as_ref().or(q.transport.as_ref()),
        body.wsl_distro.as_deref().or(q.wsl_distro.as_deref()),
        body.ssh_host.as_deref().or(q.ssh_host.as_deref()),
        body.ssh_port.or(q.ssh_port),
        body.ssh_key_vault_ref
            .as_deref()
            .or(q.ssh_key_vault_ref.as_deref()),
    )
    .or_else(|| crate::session_git::git_provider_context_for_tab(&provider_registry, &tab_id));
    let build_orch = s
        .app
        .state::<std::sync::Arc<crate::build_orchestrator::BuildOrchestrator>>();
    match crate::session_git::git_session_create_checkpoint_for_tab_with_provider(
        registry.inner().clone(),
        build_orch.inner().clone(),
        Some(tab_id),
        cwd,
        body.label,
        provider_context,
    )
    .await
    {
        Ok(snapshot) => Json(snapshot).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
    }
}

/// `POST /state/session_git/worktree` — local worktree creation for
/// debug-api drivers. This mirrors the desktop Git rail command and only
/// runs local/WSL/SSH git in the tab environment; it never mutates a remote.
pub(super) async fn state_session_git_worktree(
    Query(q): Query<SessionGitQuery>,
    State(s): State<ApiState>,
    body: Option<Json<SessionGitWorktreeBody>>,
) -> Response {
    let body = body.map(|Json(b)| b).unwrap_or_default();
    let tab_id = resolve_query_tab_or_active(body.tab_id.clone().or(q.tab_id.clone()), &s);
    let cwd = body.cwd.clone().or(q.cwd.clone());
    let registry = s.app.state::<std::sync::Arc<crate::acp::SessionRegistry>>();
    let provider_registry = s
        .app
        .state::<std::sync::Arc<crate::provider_sessions::ProviderSessionRegistry>>()
        .inner()
        .clone();
    let provider_context = explicit_session_git_provider_context(
        cwd.as_deref(),
        body.transport.as_ref().or(q.transport.as_ref()),
        body.wsl_distro.as_deref().or(q.wsl_distro.as_deref()),
        body.ssh_host.as_deref().or(q.ssh_host.as_deref()),
        body.ssh_port.or(q.ssh_port),
        body.ssh_key_vault_ref
            .as_deref()
            .or(q.ssh_key_vault_ref.as_deref()),
    )
    .or_else(|| crate::session_git::git_provider_context_for_tab(&provider_registry, &tab_id));
    match crate::session_git::git_session_create_worktree_for_tab_with_provider(
        registry.inner().clone(),
        Some(tab_id),
        cwd,
        body.source_branch,
        body.new_branch,
        provider_context,
    )
    .await
    {
        Ok(snapshot) => Json(snapshot).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
    }
}

/// `GET /state/session_git/diff?tabId=X&scope=head` — read-only diff
/// preview for external agents and diagnostics scripts.
pub(super) async fn state_session_git_diff(
    Query(q): Query<SessionGitQuery>,
    State(s): State<ApiState>,
) -> impl IntoResponse {
    let tab_id = resolve_query_tab_or_active(q.tab_id.clone(), &s);
    let registry = s.app.state::<std::sync::Arc<crate::acp::SessionRegistry>>();
    let provider_registry = s
        .app
        .state::<std::sync::Arc<crate::provider_sessions::ProviderSessionRegistry>>()
        .inner()
        .clone();
    let cwd = q.cwd.clone();
    let provider_context =
        session_git_provider_context_for_query(&provider_registry, &tab_id, &q, cwd.as_deref());
    match crate::session_git::git_session_diff_for_tab_with_provider(
        registry.inner().clone(),
        Some(tab_id),
        cwd,
        q.scope,
        provider_context,
    )
    .await
    {
        Ok(snapshot) => Json(snapshot).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
    }
}
