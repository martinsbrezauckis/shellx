//! src-tauri/src/winproc.rs — Windows process-spawn helpers.
//!
//! Centralizes the `CREATE_NO_WINDOW` flag (0x08000000) so every
//! `std::process::Command` and `tokio::process::Command` we launch on
//! Windows avoids popping a blank console window for the user. Without
//! this, every `wsl.exe`, `where`, `taskkill`, `pass`, `gh`, `git`, or
//! grok-shell-host MCP spawn would flash a cmd window in the user's
//! face. The flag must be applied at EVERY spawn site to prevent the
//! regression from re-occurring whenever someone adds a new
//! `Command::new(...)` site.
//!
//! Linux/macOS: every helper is a no-op pass-through. Compile-time
//! `cfg(target_os = "windows")` gates the flag application.
//!
//! Usage:
//! ```ignore
//! use crate::winproc::NoWindowExt;
//! let mut c = std::process::Command::new("wsl.exe");
//! c.args(["-l"]).no_window;
//! ```
//! Same for tokio::process::Command.
//!
//! Reference: https://learn.microsoft.com/en-us/windows/win32/procthread/process-creation-flags
//! `CREATE_NO_WINDOW = 0x08000000` suppresses the console window for a
//! console-subsystem child.

#[cfg(target_os = "windows")]
pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Extension trait providing `.no_window` for both std and tokio
/// `Command` builders. On non-Windows, no-op so the call site reads
/// identically across platforms.
pub trait NoWindowExt {
    /// Set CREATE_NO_WINDOW (0x08000000) on Windows; no-op elsewhere.
    fn no_window(&mut self) -> &mut Self;
}

impl NoWindowExt for std::process::Command {
    fn no_window(&mut self) -> &mut Self {
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt as _;
            self.creation_flags(CREATE_NO_WINDOW);
        }
        self
    }
}

impl NoWindowExt for tokio::process::Command {
    fn no_window(&mut self) -> &mut Self {
        #[cfg(target_os = "windows")]
        {
            self.creation_flags(CREATE_NO_WINDOW);
        }
        self
    }
}

// ─────────────────────────────────────────────────────────────────────
// Orphan-reaping when shellX dies unexpectedly.
//
// Windows — Job Object with JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE. A
// singleton job is created at app startup; each spawned child gets
// assigned to it. When shellX's process handle table closes (clean
// exit, crash, taskkill, logoff), the kernel closes the job and
// kills every assigned child. Tiny race between spawn returning
// and AssignProcessToJobObject — acceptable for resource cleanup.
//
// Linux — PR_SET_PDEATHSIG via prctl in a pre_exec hook on the child.
// Sends SIGTERM to the child when the parent's thread that called
// spawn dies. Race-free.
//
// macOS — no equivalent. Best-effort via `kill_on_drop(true)`.
//
// Spawn-site usage:
// let child = cmd.spawn?;
// crate::winproc::tie_to_parent_lifetime(child.id.unwrap_or(0));
//
// App startup once (lib.rs setup):
// crate::winproc::init_kill_on_close_group;
//
// Linux pre_exec helper (call BEFORE spawn):
// let mut cmd = tokio::process::Command::new(...);
// crate::winproc::apply_pdeathsig_preexec(&mut cmd);
// cmd.spawn?;
// ─────────────────────────────────────────────────────────────────────

#[cfg(target_os = "windows")]
mod win_job {
    use std::ptr::null_mut;
    use std::sync::OnceLock;
    use windows_sys::Win32::Foundation::{CloseHandle, FALSE, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_BASIC_LIMIT_INFORMATION,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows_sys::Win32::System::Threading::{
        OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE,
    };

    struct SafeHandle(HANDLE);
    unsafe impl Send for SafeHandle {}
    unsafe impl Sync for SafeHandle {}

    static JOB: OnceLock<SafeHandle> = OnceLock::new();

    pub fn init() -> Result<(), String> {
        if JOB.get().is_some() {
            return Ok(());
        }
        unsafe {
            let handle: HANDLE = CreateJobObjectW(null_mut(), std::ptr::null());
            if handle.is_null() {
                return Err("CreateJobObjectW returned null".into());
            }
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation = JOBOBJECT_BASIC_LIMIT_INFORMATION {
                LimitFlags: JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
                ..std::mem::zeroed()
            };
            let info_size = std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32;
            let info_ptr = (&info) as *const _ as *const std::ffi::c_void;
            if SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                info_ptr,
                info_size,
            ) == 0
            {
                CloseHandle(handle);
                return Err("SetInformationJobObject(KILL_ON_JOB_CLOSE) failed".into());
            }
            let _ = JOB.set(SafeHandle(handle));
            tracing::info!("winproc::win_job::init OK (kill-on-close job)");
        }
        Ok(())
    }

    pub fn assign_pid(pid: u32) {
        if pid == 0 {
            return;
        }
        let Some(job) = JOB.get() else {
            tracing::debug!(
                "winproc::win_job::assign_pid({}) skipped — job not initialized",
                pid
            );
            return;
        };
        unsafe {
            let child_handle: HANDLE =
                OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, FALSE, pid);
            if child_handle.is_null() {
                tracing::warn!(
                    "winproc::win_job::assign_pid({}) OpenProcess returned null",
                    pid
                );
                return;
            }
            let ok = AssignProcessToJobObject(job.0, child_handle);
            if ok == 0 {
                tracing::warn!(
                    "winproc::win_job::assign_pid({}) AssignProcessToJobObject failed",
                    pid
                );
            }
            CloseHandle(child_handle);
        }
    }
}

/// Initialize the per-platform parent-lifetime group. Call once during
/// app startup. Safe to call multiple times (idempotent).
pub fn init_kill_on_close_group() {
    #[cfg(target_os = "windows")]
    {
        if let Err(e) = win_job::init() {
            tracing::warn!(
                "winproc::init_kill_on_close_group: {} (orphans on crash possible)",
                e
            );
        }
    }
}

/// Tie the freshly-spawned child to shellX's lifetime by PID. Windows-
/// only effect; on Linux the equivalent is set via `apply_pdeathsig_
/// preexec` BEFORE spawn (race-free). macOS has no equivalent.
pub fn tie_to_parent_lifetime(pid: u32) {
    #[cfg(target_os = "windows")]
    {
        win_job::assign_pid(pid);
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = pid;
    }
}

/// Linux helper: install a `pre_exec` hook on a tokio Command that sets
/// PR_SET_PDEATHSIG(SIGTERM) on the child before exec. When shellX's
/// thread dies, the kernel SIGTERMs the child. Race-free.
///
/// Windows / macOS: no-op pass-through so callsites stay uniform.
#[cfg(target_os = "linux")]
pub fn apply_pdeathsig_preexec(cmd: &mut tokio::process::Command) -> &mut tokio::process::Command {
    // tokio::process::Command exposes its own `pre_exec` directly on
    // Linux, so no need to import std::os::unix::process::CommandExt.
    use nix::libc;
    unsafe {
        cmd.pre_exec(|| {
            // SAFETY: prctl is async-signal-safe per Linux man page.
            // PR_SET_PDEATHSIG = 1, SIGTERM = 15.
            let r = libc::prctl(1, 15, 0, 0, 0);
            if r == -1 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    cmd
}

#[cfg(not(target_os = "linux"))]
pub fn apply_pdeathsig_preexec(cmd: &mut tokio::process::Command) -> &mut tokio::process::Command {
    cmd
}

/// Start a child as a new Unix session/process-group leader so task-scoped
/// tree termination can address `-pid` without touching ShellX's own group.
/// Windows already uses `taskkill /T` and therefore needs no pre-exec hook.
#[cfg(unix)]
pub fn apply_new_session_preexec(
    cmd: &mut tokio::process::Command,
) -> &mut tokio::process::Command {
    use nix::libc;
    unsafe {
        cmd.pre_exec(|| {
            if libc::setsid() == -1 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    cmd
}

#[cfg(not(unix))]
pub fn apply_new_session_preexec(
    cmd: &mut tokio::process::Command,
) -> &mut tokio::process::Command {
    cmd
}

// ─────────────────────────────────────────────────────────────────────
// taskkill exit-code triage.
//
// Windows taskkill returns:
// 0 — process(es) terminated.
// 128 — "the process is not running" (already gone). On Win10+ this
// is the common case for a stale registry row where the actual
// PID exited between enumeration and the kill action.
// 1 — access denied or other failure.
// ... — other Win32 codes (rare).
//
// For a user-clicked "kill" on a Tasks-rail row, exit 128 means the
// dead-row is already cleaned up by the OS — silently treating it as
// Ok lets the row evict from the registry without flashing a red error
// at the user. Anything else is still a real failure.
//
// This helper is Windows-only because Unix uses signal::kill which
// returns a typed errno (ESRCH for "no such process") and the existing
// Unix paths already log + retire stale PIDs cleanly.
// ─────────────────────────────────────────────────────────────────────

/// `true` when this taskkill exit code means "process already gone".
/// The registry can evict the row without surfacing a red error.
///
/// On non-Windows the helper is unreachable (callers are gated under
/// `#[cfg(not(unix))]` / `#[cfg(target_os = "windows")]`) but the symbol
/// must exist for cross-platform `cargo check` to pass — hence the
/// `#[allow(dead_code)]` on the Unix branch.
#[cfg(target_os = "windows")]
pub fn taskkill_is_already_gone(code: Option<i32>) -> bool {
    matches!(code, Some(128))
}

#[allow(dead_code)]
#[cfg(not(target_os = "windows"))]
pub fn taskkill_is_already_gone(_code: Option<i32>) -> bool {
    false
}

#[cfg(any(target_os = "windows", test))]
fn taskkill_tree_args(pid: u32) -> [String; 4] {
    [
        "/PID".to_string(),
        pid.to_string(),
        "/T".to_string(),
        "/F".to_string(),
    ]
}

#[cfg(target_os = "windows")]
fn system_taskkill_path() -> Result<std::path::PathBuf, String> {
    use std::ffi::OsString;
    use std::os::windows::ffi::OsStringExt as _;
    use windows_sys::Win32::System::SystemInformation::GetSystemDirectoryW;

    // Windows documents 32,767 UTF-16 code units as the extended path bound.
    // Resolving taskkill through Kernel32 avoids current-directory and PATH
    // executable search when ShellX is launched inside an untrusted project.
    let mut buffer = vec![0_u16; 32_768];
    let buffer_len = u32::try_from(buffer.len())
        .map_err(|_| "Windows system directory buffer exceeded u32".to_string())?;
    // The bounded buffer remains owned for the duration of this call.
    // SAFETY: GetSystemDirectoryW writes at most `buffer_len` UTF-16 units and
    // does not retain the pointer after returning.
    let length = unsafe { GetSystemDirectoryW(buffer.as_mut_ptr(), buffer_len) };
    if length == 0 {
        return Err(format!(
            "GetSystemDirectoryW failed: {}",
            std::io::Error::last_os_error()
        ));
    }
    let length = usize::try_from(length)
        .map_err(|_| "Windows system directory length exceeded usize".to_string())?;
    if length >= buffer.len() {
        return Err("Windows system directory exceeded the bounded path buffer".to_string());
    }
    let mut path = std::path::PathBuf::from(OsString::from_wide(&buffer[..length]));
    path.push("taskkill.exe");
    Ok(path)
}

/// Terminate and reap one exact child owned by ShellX.
///
/// `tokio::process::Child::kill` terminates only the immediate Windows
/// process. Provider CLIs may spawn descendants which keep the session cwd or
/// stdio handles open after that root exits. Windows therefore uses
/// `taskkill /T /F` against the still-live owned PID; Unix keeps Tokio's
/// direct child termination because its provider launchers do not use the
/// Windows descendant model.
#[cfg(target_os = "windows")]
pub async fn terminate_owned_tokio_child_tree(
    child: &mut tokio::process::Child,
) -> Result<(), String> {
    if child
        .try_wait()
        .map_err(|error| format!("owned child status check failed: {error}"))?
        .is_some()
    {
        return Ok(());
    }
    let pid = child
        .id()
        .ok_or_else(|| "owned child has no process id".to_string())?;
    let mut command = tokio::process::Command::new(system_taskkill_path()?);
    command
        .args(taskkill_tree_args(pid))
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);
    command.no_window();
    let status = tokio::time::timeout(std::time::Duration::from_secs(15), command.status())
        .await
        .map_err(|_| format!("taskkill timed out for owned child PID {pid}"))?
        .map_err(|error| format!("taskkill spawn failed for owned child PID {pid}: {error}"))?;
    if !status.success() && !taskkill_is_already_gone(status.code()) {
        return Err(format!(
            "taskkill failed for owned child PID {pid}: exit={:?}",
            status.code()
        ));
    }
    tokio::time::timeout(std::time::Duration::from_secs(10), child.wait())
        .await
        .map_err(|_| format!("owned child PID {pid} was not reaped after taskkill"))?
        .map_err(|error| format!("owned child PID {pid} reap failed: {error}"))?;
    Ok(())
}

#[cfg(not(target_os = "windows"))]
pub async fn terminate_owned_tokio_child_tree(
    child: &mut tokio::process::Child,
) -> Result<(), String> {
    if child
        .try_wait()
        .map_err(|error| format!("owned child status check failed: {error}"))?
        .is_some()
    {
        return Ok(());
    }
    child
        .kill()
        .await
        .map_err(|error| format!("owned child termination failed: {error}"))
}

#[cfg(test)]
mod tests {
    use super::taskkill_tree_args;

    #[cfg(target_os = "windows")]
    use super::system_taskkill_path;

    #[test]
    fn owned_windows_child_tree_uses_exact_pid_and_descendant_force_flags() {
        assert_eq!(
            taskkill_tree_args(4242),
            ["/PID", "4242", "/T", "/F"].map(str::to_string)
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn owned_windows_child_tree_resolves_the_kernel32_system_taskkill() {
        let path = system_taskkill_path().expect("resolve the trusted taskkill executable");
        assert!(path.is_absolute());
        assert!(path.is_file());
        assert_eq!(
            path.file_name().and_then(|name| name.to_str()),
            Some("taskkill.exe")
        );
    }
}
