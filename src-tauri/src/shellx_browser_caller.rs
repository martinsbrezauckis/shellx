use crate::shellx_browser::BrowserTaskSnapshot;

pub(crate) const SHELLX_MCP_CALLER_ID_HEADER: &str = "x-shellx-mcp-caller-id";

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
    let caller_matches = match task.owner_session_id.as_deref() {
        Some(owner_session_id) => caller_session_id == Some(owner_session_id),
        None => true,
    };
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
        task.owner_session_id.as_deref().unwrap_or("legacy")
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
