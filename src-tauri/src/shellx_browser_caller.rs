use crate::shellx_browser::BrowserTaskSnapshot;

pub(crate) const SHELLX_MCP_CALLER_ID_HEADER: &str = "x-shellx-mcp-caller-id";

/// Stable, opaque agent identity derived only from the authenticated Host MCP
/// session. Browser requests must never choose this identity themselves.
pub(crate) fn shellx_mcp_agent_identity(caller_session_id: Option<&str>) -> Option<String> {
    caller_session_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| {
            let digest = blake3::hash(value.as_bytes()).to_hex().to_string();
            format!("shellx-agent-session:{}", &digest[..16])
        })
}

pub(crate) fn browser_vault_agent_identity(
    authenticated_agent_id: Option<&str>,
    requested_agent_id: Option<&str>,
) -> Option<String> {
    authenticated_agent_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .or_else(|| {
            requested_agent_id
                .map(str::trim)
                .filter(|value| !value.is_empty())
        })
        .map(str::to_string)
        .or_else(|| Some("shellx-browser-operator".to_string()))
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum BrowserTaskControlAuthority {
    Agent,
    Operator,
}

impl BrowserTaskControlAuthority {
    pub(crate) fn actor_id(self) -> &'static str {
        match self {
            Self::Agent => "shellxDebugApiAgent",
            Self::Operator => "shellxBrowserOperator",
        }
    }

    pub(crate) fn surface_id(self) -> &'static str {
        match self {
            Self::Agent => "debugApiBearer",
            Self::Operator => "tauriOperator",
        }
    }
}

pub(crate) fn ensure_browser_task_control_authority(
    task: &BrowserTaskSnapshot,
    authority: BrowserTaskControlAuthority,
    caller_session_id: Option<&str>,
) -> Result<(), String> {
    if authority == BrowserTaskControlAuthority::Operator {
        return Ok(());
    }
    let caller_matches = task
        .owner_session_id
        .as_deref()
        .zip(caller_session_id)
        .is_some_and(|(owner_session_id, caller_session_id)| owner_session_id == caller_session_id);
    if task.owner_actor_id == authority.actor_id()
        && task.owner_surface == authority.surface_id()
        && caller_matches
    {
        return Ok(());
    }
    Err(format!(
        "{}: task '{}' belongs to authenticated actor '{}' on '{}' session '{}'",
        crate::shellx_browser_tasks::BROWSER_TASK_OWNER_CONTROL_REQUIRED,
        task.task_id,
        task.owner_actor_id,
        task.owner_surface,
        task.owner_session_id.as_deref().unwrap_or("unbound")
    ))
}

pub(crate) fn normalize_browser_task_owner_session_id(
    owner_session_id: Option<&str>,
) -> Result<Option<String>, String> {
    let Some(owner_session_id) = owner_session_id.map(str::trim) else {
        return Ok(None);
    };
    if owner_session_id.is_empty() {
        return Ok(None);
    }
    if owner_session_id.len() > 200
        || !owner_session_id
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.' | ':'))
    {
        return Err("invalid Browser task owner session id".to_string());
    }
    Ok(Some(owner_session_id.to_string()))
}
