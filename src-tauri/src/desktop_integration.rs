use serde::Serialize;
use tauri::{AppHandle, Emitter};

pub const EXTERNAL_ATTACH_EVENT: &str = "shellx:external-attachments";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalAttachmentPayload {
    pub paths: Vec<String>,
    pub source: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopIntegrationStatus {
    pub supported: bool,
    pub os: String,
    pub explorer_context_menu_installed: bool,
    pub send_to_shortcut_installed: bool,
    pub message: String,
}

pub(crate) fn parse_external_attachment_args<I, S>(args: I) -> Vec<String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let mut capture = false;
    let mut paths = Vec::new();

    for arg in args {
        let value = arg.as_ref();
        if value == "--attach" || value == "--attach-files" {
            capture = true;
            continue;
        }
        if let Some(path) = value.strip_prefix("--attach=") {
            if !path.trim().is_empty() {
                paths.push(path.to_string());
            }
            capture = true;
            continue;
        }
        if capture {
            if value == "--" {
                continue;
            }
            if value.starts_with("--") {
                capture = false;
                continue;
            }
            if !value.trim().is_empty() {
                paths.push(value.to_string());
            }
        }
    }

    paths
}

pub(crate) fn emit_external_attachments(
    app: &AppHandle,
    paths: Vec<String>,
    source: impl Into<String>,
) {
    if paths.is_empty() {
        return;
    }
    let _ = app.emit(
        EXTERNAL_ATTACH_EVENT,
        ExternalAttachmentPayload {
            paths,
            source: source.into(),
        },
    );
}

#[tauri::command]
pub async fn desktop_integration_status() -> Result<DesktopIntegrationStatus, String> {
    desktop_integration_status_inner()
}

#[tauri::command]
pub async fn desktop_integration_install_windows_context_menu(
) -> Result<DesktopIntegrationStatus, String> {
    desktop_integration_install_windows_context_menu_inner()
}

#[tauri::command]
pub async fn desktop_integration_remove_windows_context_menu(
) -> Result<DesktopIntegrationStatus, String> {
    desktop_integration_remove_windows_context_menu_inner()
}

#[cfg(not(target_os = "windows"))]
fn desktop_integration_status_inner() -> Result<DesktopIntegrationStatus, String> {
    Ok(DesktopIntegrationStatus {
        supported: false,
        os: std::env::consts::OS.to_string(),
        explorer_context_menu_installed: false,
        send_to_shortcut_installed: false,
        message: "Send files to shellX is only available on Windows.".to_string(),
    })
}

#[cfg(not(target_os = "windows"))]
fn desktop_integration_install_windows_context_menu_inner(
) -> Result<DesktopIntegrationStatus, String> {
    desktop_integration_status_inner()
}

#[cfg(not(target_os = "windows"))]
fn desktop_integration_remove_windows_context_menu_inner(
) -> Result<DesktopIntegrationStatus, String> {
    desktop_integration_status_inner()
}

#[cfg(target_os = "windows")]
fn desktop_integration_status_inner() -> Result<DesktopIntegrationStatus, String> {
    let explorer_context_menu_installed =
        registry_key_exists(FILE_VERB_KEY) || registry_key_exists(DIRECTORY_VERB_KEY);
    let send_to_shortcut_installed = send_to_shortcut_path().is_some_and(|p| p.exists());
    Ok(DesktopIntegrationStatus {
        supported: true,
        os: "windows".to_string(),
        explorer_context_menu_installed,
        send_to_shortcut_installed,
        message: if explorer_context_menu_installed || send_to_shortcut_installed {
            "Send files to shellX is installed.".to_string()
        } else {
            "Send files to shellX is not installed.".to_string()
        },
    })
}

#[cfg(target_os = "windows")]
fn desktop_integration_install_windows_context_menu_inner(
) -> Result<DesktopIntegrationStatus, String> {
    let exe = std::env::current_exe()
        .map_err(|e| format!("current_exe failed: {}", e))?
        .to_string_lossy()
        .to_string();
    let command = format!("\"{}\" --attach \"%1\"", exe);

    install_registry_verb(FILE_VERB_KEY, FILE_COMMAND_KEY, &exe, &command)?;
    install_registry_verb(DIRECTORY_VERB_KEY, DIRECTORY_COMMAND_KEY, &exe, &command)?;
    install_send_to_shortcut(&exe)?;
    desktop_integration_status_inner()
}

#[cfg(target_os = "windows")]
fn desktop_integration_remove_windows_context_menu_inner(
) -> Result<DesktopIntegrationStatus, String> {
    let _ = run_reg(["delete", FILE_VERB_KEY, "/f"]);
    let _ = run_reg(["delete", DIRECTORY_VERB_KEY, "/f"]);
    if let Some(path) = send_to_shortcut_path() {
        let _ = std::fs::remove_file(path);
    }
    desktop_integration_status_inner()
}

#[cfg(target_os = "windows")]
const FILE_VERB_KEY: &str = r"HKCU\Software\Classes\*\shell\shellX";
#[cfg(target_os = "windows")]
const FILE_COMMAND_KEY: &str = r"HKCU\Software\Classes\*\shell\shellX\command";
#[cfg(target_os = "windows")]
const DIRECTORY_VERB_KEY: &str = r"HKCU\Software\Classes\Directory\shell\shellX";
#[cfg(target_os = "windows")]
const DIRECTORY_COMMAND_KEY: &str = r"HKCU\Software\Classes\Directory\shell\shellX\command";

#[cfg(target_os = "windows")]
fn registry_key_exists(key: &str) -> bool {
    run_reg(["query", key]).is_ok()
}

#[cfg(target_os = "windows")]
fn install_registry_verb(
    verb_key: &str,
    command_key: &str,
    exe: &str,
    command: &str,
) -> Result<(), String> {
    run_reg(["add", verb_key, "/ve", "/d", "Send to shellX", "/f"])?;
    run_reg(["add", verb_key, "/v", "Icon", "/d", exe, "/f"])?;
    run_reg(["add", command_key, "/ve", "/d", command, "/f"])?;
    Ok(())
}

#[cfg(target_os = "windows")]
fn run_reg<const N: usize>(args: [&str; N]) -> Result<(), String> {
    use crate::winproc::NoWindowExt as _;

    let output = std::process::Command::new("reg.exe")
        .args(args)
        .no_window()
        .output()
        .map_err(|e| format!("reg.exe spawn failed: {}", e))?;
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    Err(if stderr.is_empty() { stdout } else { stderr })
}

#[cfg(target_os = "windows")]
fn send_to_shortcut_path() -> Option<std::path::PathBuf> {
    let appdata = std::env::var_os("APPDATA")?;
    Some(
        std::path::PathBuf::from(appdata)
            .join("Microsoft")
            .join("Windows")
            .join("SendTo")
            .join("shellX.lnk"),
    )
}

#[cfg(target_os = "windows")]
fn install_send_to_shortcut(exe: &str) -> Result<(), String> {
    use crate::winproc::NoWindowExt as _;

    let shortcut = send_to_shortcut_path()
        .ok_or_else(|| "APPDATA is unset; cannot locate SendTo folder".to_string())?;
    if let Some(parent) = shortcut.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("create SendTo folder failed: {}", e))?;
    }

    let script = format!(
        "$s=(New-Object -ComObject WScript.Shell).CreateShortcut('{}');\
         $s.TargetPath='{}';\
         $s.Arguments='--attach';\
         $s.IconLocation='{},0';\
         $s.Description='Send selected file(s) to shellX';\
         $s.Save()",
        ps_single_quote(&shortcut.to_string_lossy()),
        ps_single_quote(exe),
        ps_single_quote(exe),
    );
    let output = std::process::Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            &script,
        ])
        .no_window()
        .output()
        .map_err(|e| format!("powershell.exe spawn failed: {}", e))?;
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    Err(if stderr.is_empty() { stdout } else { stderr })
}

#[cfg(target_os = "windows")]
fn ps_single_quote(value: &str) -> String {
    value.replace('\'', "''")
}

#[cfg(test)]
mod tests {
    use super::parse_external_attachment_args;

    #[test]
    fn parses_attach_flag_with_multiple_paths() {
        let args = vec![
            "shellx.exe",
            "--attach",
            r"C:\Users\User\one.txt",
            r"C:\Users\User\two.md",
        ];
        assert_eq!(
            parse_external_attachment_args(args),
            vec![r"C:\Users\User\one.txt", r"C:\Users\User\two.md"]
        );
    }

    #[test]
    fn parses_attach_equals_and_stops_on_next_flag() {
        let args = vec![
            "shellx",
            "--attach=/tmp/a.txt",
            "/tmp/b.txt",
            "--mcp-server",
        ];
        assert_eq!(
            parse_external_attachment_args(args),
            vec!["/tmp/a.txt", "/tmp/b.txt"]
        );
    }

    #[test]
    fn ignores_plain_args_until_attach_flag() {
        let args = vec![
            "shellx",
            "--not-ours",
            r"C:\ignore-me.txt",
            "--attach-files",
            r"C:\Users\User\one.txt",
        ];
        assert_eq!(
            parse_external_attachment_args(args),
            vec![r"C:\Users\User\one.txt"]
        );
    }

    #[test]
    fn parses_send_to_shortcut_shape() {
        let args = vec![
            r"C:\Program Files\shellX\shellx.exe",
            "--attach",
            r"C:\Users\User\Desktop\first file.md",
            r"C:\Users\User\Desktop\second file.png",
        ];
        assert_eq!(
            parse_external_attachment_args(args),
            vec![
                r"C:\Users\User\Desktop\first file.md",
                r"C:\Users\User\Desktop\second file.png",
            ]
        );
    }
}
