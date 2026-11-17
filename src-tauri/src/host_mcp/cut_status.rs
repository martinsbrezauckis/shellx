use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::{json, Value};

use super::cut_mcp::{call_cut_tool, resolve_cutd_program};

const CUT_STATUS_TIMEOUT_MS: u64 = 12_000;
#[cfg(target_os = "windows")]
const CUT_WINDOWS_APP_BASENAME: &str = "shellx-cut.exe";

/// The narrow, operator-visible state of the parent desktop-host ShellX Cut
/// bridge.
///
/// This deliberately describes readiness rather than exposing Cut's generated
/// MCP catalog. `cut_read { action: "status" }` and the Right Rail use this
/// same projection so their availability claims cannot drift apart.
#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum CutToolingState {
    Checking,
    Ready,
    InstalledEditorClosed,
    NotInstalled,
    UnsupportedTarget,
    UnavailableToProvider,
    // Reserved wire fallback used when a status projection cannot be formed.
    #[allow(dead_code)]
    Unavailable,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CutToolingStatus {
    pub schema_version: &'static str,
    pub status: CutToolingState,
    pub detail: String,
    pub target: String,
    pub can_open: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub action_hint: Option<String>,
    #[serde(skip)]
    doctor: Option<Value>,
    #[serde(skip)]
    program: Option<PathBuf>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CutTarget {
    Local,
    Wsl,
    Ssh,
    None,
    Other,
}

#[derive(Clone, Copy, Debug)]
struct CutToolingContext {
    target: CutTarget,
    provider_tooling_enabled: bool,
}

impl CutToolingContext {
    fn for_host_mcp() -> Self {
        Self {
            target: CutTarget::Local,
            provider_tooling_enabled: true,
        }
    }

    fn from_session(session: &Value) -> Self {
        let target = match session
            .get("transport")
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or("")
            .to_ascii_lowercase()
            .as_str()
        {
            "local" => CutTarget::Local,
            "wsl" => CutTarget::Wsl,
            "ssh" => CutTarget::Ssh,
            "" | "none" => CutTarget::None,
            _ => CutTarget::Other,
        };
        let provider_tooling_enabled = session
            .get("shellxToolExposure")
            .and_then(Value::as_str)
            .map(|exposure| exposure != "off")
            .unwrap_or(true);
        Self {
            target,
            provider_tooling_enabled,
        }
    }

    fn target_label(self) -> &'static str {
        match self.target {
            CutTarget::Local => "parent desktop host (local session)",
            CutTarget::Wsl => "parent desktop host via WSL relay",
            CutTarget::Ssh => "parent desktop host via SSH reverse tunnel",
            CutTarget::None => "no active ShellX host context",
            CutTarget::Other => "unsupported target",
        }
    }

    fn has_parent_desktop_host(self) -> bool {
        matches!(
            self.target,
            CutTarget::Local | CutTarget::Wsl | CutTarget::Ssh
        )
    }
}

impl CutToolingStatus {
    fn new(
        status: CutToolingState,
        detail: impl Into<String>,
        target: impl Into<String>,
        can_open: bool,
        action_hint: Option<&str>,
    ) -> Self {
        Self {
            schema_version: "shellx.cut.tooling-status.v1",
            status,
            detail: detail.into(),
            target: target.into(),
            can_open,
            action_hint: action_hint.map(str::to_string),
            doctor: None,
            program: None,
        }
    }

    fn with_probe(
        status: CutToolingState,
        detail: impl Into<String>,
        context: CutToolingContext,
        program: PathBuf,
        doctor: Option<Value>,
    ) -> Self {
        let can_open = cut_open_target(&program).is_some();
        Self {
            schema_version: "shellx.cut.tooling-status.v1",
            status,
            detail: detail.into(),
            target: context.target_label().to_string(),
            can_open,
            action_hint: can_open
                .then_some("Select Open to start the installed Cut editor.".to_string()),
            doctor,
            program: Some(program),
        }
    }

    /// Keeps the existing MCP response useful to callers while attaching the
    /// common typed status projection. It never emits the generated tool list.
    pub(crate) fn into_host_mcp_result(self) -> Value {
        let status = serde_json::to_value(&self).unwrap_or_else(|_| {
            json!({
                "schemaVersion": "shellx.cut.tooling-status.v1",
                "status": "unavailable",
                "detail": "ShellX Cut status could not be encoded safely.",
                "target": "parent desktop host",
                "canOpen": false,
            })
        });
        if let Some(mut doctor) = self.doctor {
            if let Some(object) = doctor.as_object_mut() {
                object.insert("shellxCutStatus".to_string(), status);
                return doctor;
            }
        }
        json!({
            "kind": "shellx_cut_status",
            "shellxCutStatus": status,
        })
    }
}

pub(crate) async fn snapshot_for_host_mcp() -> CutToolingStatus {
    snapshot_for_context(CutToolingContext::for_host_mcp()).await
}

pub(crate) async fn snapshot_for_session(session: &Value) -> CutToolingStatus {
    snapshot_for_context(CutToolingContext::from_session(session)).await
}

async fn snapshot_for_context(context: CutToolingContext) -> CutToolingStatus {
    if !context.has_parent_desktop_host() {
        return CutToolingStatus::new(
            CutToolingState::UnsupportedTarget,
            "ShellX Cut needs an active ShellX desktop-host context. Local, WSL, and SSH sessions can use the parent host through ShellX Host MCP.",
            context.target_label(),
            false,
            Some("Start or select a ShellX session with a parent desktop host."),
        );
    }
    if !context.provider_tooling_enabled {
        return CutToolingStatus::new(
            CutToolingState::UnavailableToProvider,
            "This provider session has ShellX tooling turned off, so Cut is not available to it.",
            context.target_label(),
            false,
            Some("Enable ShellX tools for this provider session, then Check again."),
        );
    }

    let program = match resolve_cutd_program() {
        Ok(program) => program,
        Err(_) => {
            return CutToolingStatus::new(
                CutToolingState::NotInstalled,
                "ShellX Cut is not installed on this desktop host.",
                context.target_label(),
                false,
                Some("Install ShellX Cut, then select Check."),
            )
        }
    };

    match call_cut_tool(&program, "system_doctor", json!({}), CUT_STATUS_TIMEOUT_MS).await {
        Ok(doctor) if doctor.get("isError").and_then(Value::as_bool) != Some(true) => {
            CutToolingStatus::with_probe(
                CutToolingState::Ready,
                "ShellX Cut is installed and its editor answered the status check.",
                context,
                program,
                Some(doctor),
            )
        }
        Ok(doctor) => CutToolingStatus::with_probe(
            CutToolingState::InstalledEditorClosed,
            "ShellX Cut is installed, but its editor is closed or did not accept the status check.",
            context,
            program,
            Some(doctor),
        ),
        Err(_) => CutToolingStatus::with_probe(
            CutToolingState::InstalledEditorClosed,
            "ShellX Cut is installed, but its editor is closed or did not accept the status check.",
            context,
            program,
            None,
        ),
    }
}

/// Launch Cut only after an explicit operator action from the Right Rail.
/// Polling and status checks never call this function.
pub(crate) fn open_from_status(status: CutToolingStatus) -> Result<CutToolingStatus, String> {
    if status.status == CutToolingState::UnsupportedTarget
        || status.status == CutToolingState::UnavailableToProvider
        || status.status == CutToolingState::NotInstalled
    {
        return Err(status.detail);
    }
    let program = status
        .program
        .as_deref()
        .ok_or_else(|| "ShellX Cut could not resolve an installed editor to open.".to_string())?;
    let target = cut_open_target(program).ok_or_else(|| {
        "ShellX Cut is installed, but this desktop target has no safe editor launcher to open. Use Cut directly, then select Check."
            .to_string()
    })?;
    launch_cut_for_operator(target)?;
    Ok(CutToolingStatus::new(
        CutToolingState::Checking,
        "Open request sent to ShellX Cut. Select Check when the editor is ready.",
        status.target,
        false,
        Some("ShellX never opens Cut automatically."),
    ))
}

enum CutOpenTarget {
    #[cfg(target_os = "windows")]
    WindowsExecutable(PathBuf),
    #[cfg(target_os = "macos")]
    MacApplication(PathBuf),
}

fn cut_open_target(program: &Path) -> Option<CutOpenTarget> {
    #[cfg(target_os = "windows")]
    {
        let application = windows_cut_application(program)?;
        application
            .is_file()
            .then_some(CutOpenTarget::WindowsExecutable(application))
    }
    #[cfg(target_os = "macos")]
    {
        let application = program
            .ancestors()
            .find(|path| path.file_name().and_then(|name| name.to_str()) == Some("ShellX Cut.app"))?
            .to_path_buf();
        application
            .is_dir()
            .then_some(CutOpenTarget::MacApplication(application))
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let _ = program;
        None
    }
}

#[cfg(target_os = "windows")]
fn windows_cut_application(program: &Path) -> Option<PathBuf> {
    Some(program.parent()?.join(CUT_WINDOWS_APP_BASENAME))
}

fn launch_cut_for_operator(target: CutOpenTarget) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let CutOpenTarget::WindowsExecutable(application) = target;
        std::process::Command::new(&application)
            .spawn()
            .map_err(|error| format!("could not open ShellX Cut: {error}"))?;
        Ok(())
    }
    #[cfg(target_os = "macos")]
    {
        let CutOpenTarget::MacApplication(application) = target;
        std::process::Command::new("open")
            .arg(&application)
            .spawn()
            .map_err(|error| format!("could not open ShellX Cut: {error}"))?;
        Ok(())
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let _ = target;
        Err("ShellX Cut has no safe editor launcher for this desktop target.".to_string())
    }
}
