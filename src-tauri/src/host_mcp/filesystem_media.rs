use super::*;

/// `fs_read` — UTF-8-lossy, cursor-pageable text read. Truncation and the
/// next byte offset are signaled so callers can continue without returning the
/// entire document to the model at once.
pub(super) async fn tool_fs_read(args: Value) -> Result<Value, String> {
    let path_s = args
        .get("path")
        .and_then(|v| v.as_str())
        .ok_or("fs_read: missing 'path'")?;
    let path = validate_fs_path("fs_read", path_s)?;
    enforce_home_containment("fs_read", &path, FsAccessKind::Read)?;
    let max_bytes = match args.get("max_bytes") {
        Some(value) => value
            .as_u64()
            .ok_or("fs_read: max_bytes must be a positive integer")?,
        None => FS_READ_DEFAULT_MAX as u64,
    };
    if max_bytes == 0 || max_bytes > FS_READ_HARD_MAX as u64 {
        return Err(format!(
            "fs_read: max_bytes must be between 1 and {}",
            FS_READ_HARD_MAX
        ));
    }
    let offset_bytes = match args.get("offset_bytes") {
        Some(value) => value
            .as_u64()
            .ok_or("fs_read: offset_bytes must be a non-negative integer")?,
        None => 0,
    };

    let (bytes, total, truncated, next_offset_bytes) =
        read_file_range_with_cap_async("fs_read", &path, offset_bytes, max_bytes).await?;
    let content = String::from_utf8_lossy(&bytes).into_owned();
    let approx_tokens = content.len().div_ceil(4);
    Ok(json!({
        "content": content,
        "size_bytes": total,
        "offset_bytes": offset_bytes.min(total),
        "bytes_returned": bytes.len(),
        "next_offset_bytes": next_offset_bytes,
        "truncated": truncated,
        "approx_tokens": approx_tokens,
    }))
}

/// Vision-bridge helper: read an image's bytes from disk, with
/// transparent WSL UNC translation on Windows when the supplied path
/// is POSIX-absolute.
///
/// Resolution order:
/// 1. Read the path verbatim. Wins on Local Windows (`C:\...`),
/// Linux native, and pre-translated `\\wsl$\...` UNC forms.
/// 2. If that fails AND we're on Windows AND the path looks POSIX
/// (`/home/...`, `/root/...`, `/tmp/...`), try
/// `\\wsl$\<distro>\<path>`. When `wsl_distro_hint` is provided
/// we try it first; otherwise we enumerate running distros via
/// `wsl.exe --list --quiet --running` (cached 60s).
/// 3. If all attempts fail, return a clear error citing every
/// path that was tried.
///
/// SSH bridge is NOT covered here — scp'ing the file would require
/// the session's host + key context that isn't reachable from the
/// stateless MCP tool layer.
pub(super) async fn resolve_readable_media_path(
    tool: &str,
    input: &str,
    wsl_distro_hint: Option<&str>,
) -> Result<PathBuf, String> {
    let mut candidates: Vec<String> = Vec::new();

    #[cfg(target_os = "windows")]
    {
        let normalized = input.replace('\\', "/");
        let looks_posix = normalized.starts_with('/')
            && !normalized.to_ascii_lowercase().starts_with("/mnt/")
            && !normalized.to_ascii_lowercase().starts_with("/cygdrive/");
        if looks_posix {
            let mut distros: Vec<String> = Vec::new();
            if let Some(d) = wsl_distro_hint {
                if !d.trim().is_empty() {
                    distros.push(d.to_string());
                }
            }
            for d in wsl_running_distros().await {
                if !distros.iter().any(|x| x.eq_ignore_ascii_case(&d)) {
                    distros.push(d);
                }
            }
            for distro in distros {
                candidates.push(format!("\\\\wsl$\\{}{}", distro, input.replace('/', "\\")));
                candidates.push(format!(
                    "\\\\{}\\{}{}",
                    WSL_DOT_LOCALHOST_HOST,
                    distro,
                    input.replace('/', "\\")
                ));
            }
        } else {
            candidates.push(input.to_string());
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = wsl_distro_hint;
        candidates.push(input.to_string());
    }

    let mut last_err = String::new();
    for candidate in candidates {
        let path = match validate_fs_path(tool, &candidate) {
            Ok(p) => p,
            Err(e) => {
                last_err = e;
                continue;
            }
        };
        if let Err(e) = enforce_home_containment(tool, &path, FsAccessKind::Read) {
            last_err = e;
            continue;
        }
        match tokio::fs::metadata(&path).await {
            Ok(meta) if meta.is_file() => return Ok(path),
            Ok(_) => {
                last_err = format!("{}: not a regular file: {}", tool, path.display());
            }
            Err(e) => {
                last_err = format!("{}: stat {}: {}", tool, path.display(), e);
            }
        }
    }
    Err(if last_err.is_empty() {
        format!("{}: no readable media path candidate for {}", tool, input)
    } else {
        last_err
    })
}

#[derive(Clone)]
pub(super) struct VisionSshContext {
    pub(super) ssh: crate::acp::SshSpawnConfig,
    pub(super) cwd: Option<String>,
}

pub(super) async fn vision_ssh_context_for_tab(
    ctx: &Arc<HostMcpContext>,
    tab_id: Option<&str>,
) -> Option<VisionSshContext> {
    let app = ctx.app_handle.as_ref()?;
    let tab = tab_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or_else(|| std::env::var("SHELLX_HOST_MCP_TAB_ID").ok())?;

    use tauri::Manager;
    if let Some(registry) = app.try_state::<Arc<crate::acp::SessionRegistry>>() {
        if let Some(arc) = registry.get_existing(&tab).await {
            let guard = arc.lock().await;
            if let Some(ssh) = guard.ssh_config().cloned() {
                let cwd = guard
                    .get_debug_session_info()
                    .get("cwd")
                    .and_then(|value| value.as_str())
                    .map(str::to_string);
                return Some(VisionSshContext { ssh, cwd });
            }
        }
    }

    let provider_registry =
        app.try_state::<Arc<crate::provider_sessions::ProviderSessionRegistry>>()?;
    let state = provider_registry.state_for_tab_preferred(&tab);
    let run = state
        .active_run
        .as_ref()
        .or_else(|| state.recent_runs.first())?;
    if run.transport != crate::provider_adapters::ProviderExecutionTransport::Ssh {
        return None;
    }
    let host = run.ssh_host.as_deref()?.trim();
    if host.is_empty() {
        return None;
    }
    Some(VisionSshContext {
        ssh: crate::acp::SshSpawnConfig {
            host: host.to_string(),
            port: run.ssh_port,
            key_vault_ref: run.ssh_key_vault_ref.clone(),
            remote_grok_path: String::new(),
            remote_runtime: run.ssh_remote_runtime,
            wsl_distro: run.ssh_wsl_distro.clone(),
        },
        cwd: Some(run.cwd.clone()),
    })
}

pub(super) fn vision_remote_path_is_posix(path: &str) -> bool {
    let normalized = path.replace('\\', "/");
    normalized.starts_with('/')
        && !normalized.to_ascii_lowercase().starts_with("/mnt/")
        && !normalized.to_ascii_lowercase().starts_with("/cygdrive/")
}

pub(super) fn normalized_remote_path(path: &str) -> String {
    path.replace('\\', "/")
}

pub(super) fn remote_path_is_equal_or_under(path: &str, root: &str) -> bool {
    let path = path.trim_end_matches('/');
    let root = root.trim_end_matches('/');
    if path == root {
        return true;
    }
    let root_with_sep = format!("{root}/");
    path.starts_with(&root_with_sep)
}

pub(super) fn vision_remote_generated_media_scope(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    lower.contains("/.grok/sessions/")
        || lower.contains("/.codex/generated_images/")
        || lower.contains("/.shellx/assets/")
}

fn vision_remote_generated_media_sensitive_parent(path: &str) -> Option<&'static str> {
    let lower = path.to_ascii_lowercase();
    if lower.contains("/.codex/generated_images/") {
        Some("/.codex/")
    } else if lower.contains("/.grok/sessions/") {
        Some("/.grok/")
    } else if lower.contains("/.shellx/assets/") {
        Some("/.shellx/")
    } else {
        None
    }
}

#[cfg(test)]
pub(super) fn validate_vision_remote_media_path(
    tool: &str,
    remote_path: &str,
    cwd: Option<&str>,
) -> Result<String, String> {
    validate_vision_remote_media_path_for_runtime(
        tool,
        remote_path,
        cwd,
        crate::acp::SshRemoteRuntime::Posix,
    )
}

pub(super) fn validate_vision_remote_media_path_for_runtime(
    tool: &str,
    remote_path: &str,
    cwd: Option<&str>,
    remote_runtime: crate::acp::SshRemoteRuntime,
) -> Result<String, String> {
    let native_windows = remote_runtime == crate::acp::SshRemoteRuntime::Windows;
    let normalized = if native_windows {
        remote_path.replace('/', "\\")
    } else {
        normalized_remote_path(remote_path)
    };
    if normalized.is_empty() {
        return Err(format!("{tool}: empty remote image path"));
    }
    if normalized.contains('\0') {
        return Err(format!("{tool}: remote image path contains a null byte"));
    }
    if native_windows && !crate::acp::is_windows_absolute_remote_path(&normalized) {
        return Err(format!(
            "{tool}: SSH image path must be an absolute remote Windows path: {remote_path}"
        ));
    }
    if !native_windows && !vision_remote_path_is_posix(&normalized) {
        return Err(format!(
            "{tool}: SSH image path must be an absolute remote POSIX path: {remote_path}"
        ));
    }
    if normalized.split(['/', '\\']).any(|part| part == "..") {
        return Err(format!(
            "{tool}: remote image path contains traversal: {remote_path}"
        ));
    }
    let scope_path = normalized.replace('\\', "/");
    let generated_media_parent = vision_remote_generated_media_sensitive_parent(&scope_path);
    if let Some(needle) = SENSITIVE_FS_SUBSTRINGS.iter().copied().find(|needle| {
        Some(*needle) != generated_media_parent && scope_path.to_ascii_lowercase().contains(*needle)
    }) {
        return Err(format!(
            "{tool}: refusing sensitive remote image path {remote_path} (matches denylist pattern '{needle}')"
        ));
    }
    let in_generated_scope = vision_remote_generated_media_scope(&scope_path);
    let in_cwd = cwd
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.replace('\\', "/"))
        .is_some_and(|root| {
            if native_windows {
                remote_path_is_equal_or_under(
                    &scope_path.to_ascii_lowercase(),
                    &root.to_ascii_lowercase(),
                )
            } else {
                remote_path_is_equal_or_under(&scope_path, &root)
            }
        });
    if !in_generated_scope && !in_cwd {
        return Err(format!(
            "{tool}: remote image path outside generated media/session cwd scope: {remote_path}"
        ));
    }
    Ok(normalized)
}

pub(super) async fn vision_ssh_run(
    ssh: &crate::acp::SshSpawnConfig,
    remote_command: String,
    label: &str,
) -> Result<Vec<u8>, String> {
    crate::acp::validate_ssh_destination_arg(&ssh.host)?;
    let mut cmd = tokio::process::Command::new("ssh");
    cmd.arg("-o").arg("BatchMode=yes");
    cmd.arg("-o").arg("ConnectTimeout=5");
    cmd.arg("-T");
    if let Some(port) = ssh.port {
        cmd.arg("-p").arg(port.to_string());
    }
    if let Some(key_path) =
        crate::provider_adapters::resolve_provider_ssh_key_path(ssh.key_vault_ref.as_deref())
            .await?
    {
        cmd.arg("-i").arg(key_path);
    }
    let remote_command = if ssh.remote_runtime == crate::acp::SshRemoteRuntime::Windows {
        crate::acp::wrap_ssh_windows_command(&remote_command)
    } else {
        crate::acp::wrap_ssh_posix_command(
            ssh.remote_runtime,
            ssh.wsl_distro.as_deref(),
            &remote_command,
        )?
    };
    cmd.arg("--").arg(&ssh.host).arg(remote_command);
    use crate::winproc::NoWindowExt as _;
    cmd.no_window();
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());

    let out = cmd
        .output()
        .await
        .map_err(|e| format!("vision_describe: ssh spawn failed: {e}"))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(format!(
            "vision_describe: ssh {label} exited {:?}: {}",
            out.status.code(),
            if stderr.is_empty() {
                "no stderr".to_string()
            } else {
                stderr
            }
        ));
    }
    Ok(out.stdout)
}

pub(super) async fn vision_ssh_realpath(
    ssh: &crate::acp::SshSpawnConfig,
    remote_path: &str,
) -> Result<String, String> {
    let script = if ssh.remote_runtime == crate::acp::SshRemoteRuntime::Windows {
        let path = crate::acp::powershell_single_quote(remote_path);
        format!(
            "{prelude}$path={path};$item=Get-Item -LiteralPath $path -Force -ErrorAction Stop;[Console]::Out.WriteLine($item.FullName)",
            prelude = crate::acp::windows_remote_shell_prelude(),
        )
    } else {
        let q = crate::acp::shell_quote_for_remote(remote_path);
        format!(
            "p={q}; if command -v realpath >/dev/null 2>&1; then realpath -- \"$p\" 2>/dev/null || realpath \"$p\"; else python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' \"$p\"; fi"
        )
    };
    let out = vision_ssh_run(ssh, script, "realpath").await?;
    let resolved = String::from_utf8_lossy(&out).trim().to_string();
    if resolved.is_empty() {
        return Err(format!(
            "vision_describe: remote realpath returned no path for {remote_path}"
        ));
    }
    Ok(resolved)
}

pub(super) async fn vision_ssh_file_size(
    ssh: &crate::acp::SshSpawnConfig,
    remote_path: &str,
) -> Result<u64, String> {
    let script = if ssh.remote_runtime == crate::acp::SshRemoteRuntime::Windows {
        let path = crate::acp::powershell_single_quote(remote_path);
        format!(
            "{prelude}$item=Get-Item -LiteralPath {path} -Force -ErrorAction Stop;[Console]::Out.WriteLine([string]$item.Length)",
            prelude = crate::acp::windows_remote_shell_prelude(),
        )
    } else {
        let q = crate::acp::shell_quote_for_remote(remote_path);
        format!(
            "p={q}; if stat -c %s -- \"$p\" >/dev/null 2>&1; then stat -c %s -- \"$p\"; else stat -f %z \"$p\"; fi"
        )
    };
    let out = vision_ssh_run(ssh, script, "stat").await?;
    let s = String::from_utf8_lossy(&out).trim().to_string();
    s.parse::<u64>()
        .map_err(|e| format!("vision_describe: remote stat returned invalid size '{s}': {e}"))
}

pub(super) async fn vision_ssh_read_file_with_cap(
    ssh: &crate::acp::SshSpawnConfig,
    remote_path: &str,
    cap_bytes: u64,
) -> Result<Vec<u8>, String> {
    let size = vision_ssh_file_size(ssh, remote_path).await?;
    if size > cap_bytes {
        return Err(format!(
            "vision_describe: remote image too large ({size} bytes; cap {cap_bytes} bytes)"
        ));
    }
    let script = if ssh.remote_runtime == crate::acp::SshRemoteRuntime::Windows {
        let path = crate::acp::powershell_single_quote(remote_path);
        format!(
            "{prelude}$input=[IO.File]::OpenRead({path});try{{$stdout=[Console]::OpenStandardOutput();$input.CopyTo($stdout);$stdout.Flush()}}finally{{$input.Dispose()}}",
            prelude = crate::acp::windows_remote_shell_prelude(),
        )
    } else {
        let q = crate::acp::shell_quote_for_remote(remote_path);
        format!("cat -- {q}")
    };
    let out = vision_ssh_run(ssh, script, "cat").await?;
    if out.len() as u64 > cap_bytes {
        return Err(format!(
            "vision_describe: remote image too large ({} bytes; cap {} bytes)",
            out.len(),
            cap_bytes
        ));
    }
    Ok(out)
}

pub(super) async fn read_vision_image_data_url_from_ssh(
    path: &str,
    ssh_ctx: &VisionSshContext,
) -> Result<String, String> {
    let checked = validate_vision_remote_media_path_for_runtime(
        "vision_describe",
        path,
        ssh_ctx.cwd.as_deref(),
        ssh_ctx.ssh.remote_runtime,
    )?;
    let resolved = vision_ssh_realpath(&ssh_ctx.ssh, &checked).await?;
    let resolved = validate_vision_remote_media_path_for_runtime(
        "vision_describe",
        &resolved,
        ssh_ctx.cwd.as_deref(),
        ssh_ctx.ssh.remote_runtime,
    )?;
    let mime = image_mime_for_path("vision_describe", Path::new(&resolved), true)?;
    let bytes = vision_ssh_read_file_with_cap(&ssh_ctx.ssh, &resolved, 20 * 1024 * 1024).await?;
    validate_image_magic("vision_describe", mime, &bytes)?;
    use base64::Engine as _;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(format!("data:{};base64,{}", mime, b64))
}

pub(super) fn image_mime_for_path(
    tool: &str,
    path: &std::path::Path,
    allow_bmp: bool,
) -> Result<&'static str, String> {
    let ext = path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "png" => Ok("image/png"),
        "jpg" | "jpeg" => Ok("image/jpeg"),
        "webp" => Ok("image/webp"),
        "gif" => Ok("image/gif"),
        "bmp" if allow_bmp => Ok("image/bmp"),
        _ => Err(format!(
            "{}: file extension not allowed (only png/jpg/jpeg/webp/gif{})",
            tool,
            if allow_bmp { "/bmp" } else { "" }
        )),
    }
}

pub(super) fn audio_mime_for_path(
    tool: &str,
    path: &std::path::Path,
) -> Result<&'static str, String> {
    let ext = path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "mp3" => Ok("audio/mpeg"),
        "wav" => Ok("audio/wav"),
        "ogg" | "opus" => Ok("audio/ogg"),
        "webm" => Ok("audio/webm"),
        "m4a" | "mp4" => Ok("audio/mp4"),
        "flac" => Ok("audio/flac"),
        _ => Err(format!(
            "{}: file extension not allowed (only mp3/wav/ogg/opus/webm/m4a/mp4/flac)",
            tool
        )),
    }
}

pub(super) fn validate_image_magic(tool: &str, mime: &str, bytes: &[u8]) -> Result<(), String> {
    let ok = match mime {
        "image/png" => bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
        "image/jpeg" => bytes.starts_with(&[0xff, 0xd8, 0xff]),
        "image/gif" => bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a"),
        "image/webp" => bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP",
        "image/bmp" => bytes.starts_with(b"BM"),
        _ => false,
    };
    if ok {
        Ok(())
    } else {
        Err(format!(
            "{}: file bytes do not match declared image type {}",
            tool, mime
        ))
    }
}

pub(super) fn validate_audio_magic(tool: &str, mime: &str, bytes: &[u8]) -> Result<(), String> {
    let ok = match mime {
        "audio/mpeg" => {
            bytes.starts_with(b"ID3")
                || bytes.first() == Some(&0xff)
                    && bytes.get(1).map(|b| (b & 0xe0) == 0xe0).unwrap_or(false)
        }
        "audio/wav" => bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WAVE",
        "audio/ogg" => bytes.starts_with(b"OggS"),
        "audio/webm" => bytes.starts_with(&[0x1a, 0x45, 0xdf, 0xa3]),
        "audio/mp4" => bytes.len() >= 12 && &bytes[4..8] == b"ftyp",
        "audio/flac" => bytes.starts_with(b"fLaC"),
        _ => false,
    };
    if ok {
        Ok(())
    } else {
        Err(format!(
            "{}: file bytes do not match declared audio type {}",
            tool, mime
        ))
    }
}

pub(super) async fn read_file_with_cap_async(
    tool: &str,
    path: &std::path::Path,
    cap_bytes: u64,
) -> Result<Vec<u8>, String> {
    let meta = tokio::fs::metadata(path)
        .await
        .map_err(|e| format!("{}: stat {}: {}", tool, path.display(), e))?;
    if !meta.is_file() {
        return Err(format!("{}: not a regular file: {}", tool, path.display()));
    }
    if meta.len() > cap_bytes {
        return Err(format!(
            "{}: file too large ({} bytes; cap {} bytes)",
            tool,
            meta.len(),
            cap_bytes
        ));
    }
    tokio::fs::read(path)
        .await
        .map_err(|e| format!("{}: read {}: {}", tool, path.display(), e))
}

pub(super) async fn read_file_prefix_with_cap_async(
    tool: &str,
    path: &std::path::Path,
    cap_bytes: u64,
) -> Result<(Vec<u8>, u64, bool), String> {
    let meta = tokio::fs::metadata(path)
        .await
        .map_err(|e| format!("{}: stat {}: {}", tool, path.display(), e))?;
    if !meta.is_file() {
        return Err(format!("{}: not a regular file: {}", tool, path.display()));
    }
    let total = meta.len();
    let capped = total.min(cap_bytes);
    let to_read: usize = capped
        .try_into()
        .map_err(|_| format!("{}: cap too large for this platform", tool))?;
    let mut file = tokio::fs::File::open(path)
        .await
        .map_err(|e| format!("{}: open {}: {}", tool, path.display(), e))?;
    let mut bytes = vec![0u8; to_read];
    if to_read > 0 {
        file.read_exact(&mut bytes)
            .await
            .map_err(|e| format!("{}: read {}: {}", tool, path.display(), e))?;
    }
    Ok((bytes, total, total > cap_bytes))
}

pub(super) async fn read_file_range_with_cap_async(
    tool: &str,
    path: &std::path::Path,
    offset_bytes: u64,
    cap_bytes: u64,
) -> Result<(Vec<u8>, u64, bool, Option<u64>), String> {
    let meta = tokio::fs::metadata(path)
        .await
        .map_err(|e| format!("{}: stat {}: {}", tool, path.display(), e))?;
    if !meta.is_file() {
        return Err(format!("{}: not a regular file: {}", tool, path.display()));
    }
    let total = meta.len();
    let offset = offset_bytes.min(total);
    let available = total.saturating_sub(offset);
    let capped = available.min(cap_bytes);
    let to_read: usize = capped
        .try_into()
        .map_err(|_| format!("{}: cap too large for this platform", tool))?;
    let mut file = tokio::fs::File::open(path)
        .await
        .map_err(|e| format!("{}: open {}: {}", tool, path.display(), e))?;
    if offset > 0 {
        file.seek(std::io::SeekFrom::Start(offset))
            .await
            .map_err(|e| format!("{}: seek {}: {}", tool, path.display(), e))?;
    }
    let mut bytes = vec![0u8; to_read];
    if to_read > 0 {
        file.read_exact(&mut bytes)
            .await
            .map_err(|e| format!("{}: read {}: {}", tool, path.display(), e))?;
    }
    let end_offset = offset.saturating_add(capped);
    let next_offset_bytes = (end_offset < total).then_some(end_offset);
    Ok((bytes, total, next_offset_bytes.is_some(), next_offset_bytes))
}

pub(super) fn read_file_with_cap_sync(
    tool: &str,
    path: &std::path::Path,
    cap_bytes: u64,
) -> Result<Vec<u8>, String> {
    let meta =
        std::fs::metadata(path).map_err(|e| format!("{}: stat {}: {}", tool, path.display(), e))?;
    if !meta.is_file() {
        return Err(format!("{}: not a regular file: {}", tool, path.display()));
    }
    if meta.len() > cap_bytes {
        return Err(format!(
            "{}: file too large ({} bytes; cap {} bytes)",
            tool,
            meta.len(),
            cap_bytes
        ));
    }
    std::fs::read(path).map_err(|e| format!("{}: read {}: {}", tool, path.display(), e))
}

/// Cached enumeration of running WSL distros. `wsl.exe --list --quiet
/// --running` is fast but still ~50ms — caching for 60s keeps repeat
/// vision calls cheap. Cache is reset implicitly on process restart.
#[cfg(target_os = "windows")]
pub async fn wsl_running_distros() -> Vec<String> {
    use std::sync::Mutex;
    use std::sync::OnceLock;
    use std::time::Instant;
    struct Cache {
        fetched_at: Instant,
        names: Vec<String>,
    }
    static CELL: OnceLock<Mutex<Option<Cache>>> = OnceLock::new();
    let lock = CELL.get_or_init(|| Mutex::new(None));
    {
        let guard = lock.lock().unwrap_or_else(|poisoned| {
            tracing::warn!("wsl distro cache mutex was poisoned; recovering inner value");
            poisoned.into_inner()
        });
        if let Some(c) = guard.as_ref() {
            if c.fetched_at.elapsed().as_secs() < 60 {
                return c.names.clone();
            }
        }
    }
    let out = tokio::task::spawn_blocking(|| {
        std::process::Command::new("wsl.exe")
            .args(["--list", "--quiet", "--running"])
            .output()
    })
    .await;
    let names = match out {
        Ok(Ok(o)) if o.status.success() => {
            // wsl.exe outputs UTF-16 LE.
            let raw: Vec<u16> = o
                .stdout
                .chunks_exact(2)
                .map(|c| u16::from_le_bytes([c[0], c[1]]))
                .collect();
            let s = String::from_utf16_lossy(&raw);
            s.lines()
                .map(|l| l.trim().trim_matches('\u{0}').to_string())
                .filter(|l| !l.is_empty())
                .collect::<Vec<_>>()
        }
        _ => Vec::new(),
    };
    let mut guard = lock.lock().unwrap_or_else(|poisoned| {
        tracing::warn!("wsl distro cache mutex was poisoned; recovering inner value");
        poisoned.into_inner()
    });
    *guard = Some(Cache {
        fetched_at: Instant::now(),
        names: names.clone(),
    });
    names
}

#[cfg(not(target_os = "windows"))]
pub async fn wsl_running_distros() -> Vec<String> {
    Vec::new()
}

/// `fs_read_binary` (B2, 2026-05-19) — read raw bytes, return base64.
/// `fs_read` is UTF-8-lossy by design (text-oriented); binary blobs
/// like images and archives lose information through that path. This
/// command preserves bytes exactly. 16 MiB default cap — anything
/// larger is truncated with `truncated=true` in the envelope. MIME
/// is sniffed from extension only (no magic-byte inspection), enough
/// for common image/archive/document types.
pub(super) async fn tool_fs_read_binary(args: Value) -> Result<Value, String> {
    use base64::Engine as _;
    let path_s = args
        .get("path")
        .and_then(|v| v.as_str())
        .ok_or("fs_read_binary: missing 'path'")?;
    let path = validate_fs_path("fs_read_binary", path_s)?;
    enforce_home_containment("fs_read_binary", &path, FsAccessKind::Read)?;
    const FS_READ_BINARY_DEFAULT_MAX: usize = 16 * 1024 * 1024;
    let max_bytes = args
        .get("max_bytes")
        .and_then(|v| v.as_u64())
        .unwrap_or(FS_READ_BINARY_DEFAULT_MAX as u64);
    let (bytes, total, truncated) =
        read_file_prefix_with_cap_async("fs_read_binary", &path, max_bytes).await?;
    let ext = path
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| s.to_ascii_lowercase())
        .unwrap_or_default();
    let mime = match ext.as_str() {
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "bmp" => "image/bmp",
        "mp4" | "m4v" => "video/mp4",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        "mkv" => "video/x-matroska",
        "pdf" => "application/pdf",
        "zip" => "application/zip",
        "gz" | "tgz" => "application/gzip",
        "tar" => "application/x-tar",
        _ => "application/octet-stream",
    };
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(json!({
        "content_base64": b64,
        "size_bytes": total,
        "truncated": truncated,
        "mime": mime,
    }))
}
