//! Exact-target file transport for durable Task attachments.
//!
//! Every source is resolved inside the operator-selected task working folder,
//! copied into a content-addressed private folder, and re-read before durable
//! metadata may be recorded. Provider auth is delegated to the existing SSH
//! key reference resolver; credential files are never copied or inspected.

use crate::acp::{SshRemoteRuntime, SshSpawnConfig};
use crate::provider_adapters::ProviderExecutionTransport;
use crate::task_attachments::{
    task_attachment_provider_relative_path, TaskAttachmentRecord, TaskAttachmentRegistration,
    MAX_TASK_ATTACHMENTS_PER_REQUEST, MAX_TASK_ATTACHMENT_BYTES, MAX_TASK_ATTACHMENT_REQUEST_BYTES,
};
use crate::task_provider_dispatch::TaskProviderResolvedTarget;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use tokio::io::AsyncWriteExt as _;
use uuid::Uuid;

pub(crate) async fn persist_task_attachments(
    target: &TaskProviderResolvedTarget,
    canonical_cwd: &str,
    sources: &[String],
) -> Result<Vec<TaskAttachmentRegistration>, String> {
    validate_request(canonical_cwd, sources)?;
    let mut registrations = Vec::with_capacity(sources.len());
    let mut total_bytes = 0_u64;
    for source in sources {
        let bytes = read_import_source(target, canonical_cwd, source).await?;
        total_bytes = total_bytes
            .checked_add(bytes.len() as u64)
            .ok_or_else(|| "Task attachment byte count overflowed.".to_string())?;
        if total_bytes > MAX_TASK_ATTACHMENT_REQUEST_BYTES {
            return Err("Task attachments exceed the 100 MiB import limit.".to_string());
        }
        let digest = sha256_digest(&bytes);
        let extension = safe_extension(source);
        let provider_relative_path = task_attachment_provider_relative_path(&digest, &extension)
            .map_err(|_| "Task attachment filename is not supported.".to_string())?;
        write_and_verify(
            target,
            canonical_cwd,
            &provider_relative_path,
            &bytes,
            &digest,
        )
        .await?;
        registrations.push(TaskAttachmentRegistration {
            digest,
            connection_id: target.connection_id().to_string(),
            target_key: target.target_key().to_string(),
            canonical_cwd: canonical_cwd.to_string(),
            provider_relative_path,
            size_bytes: bytes.len() as u64,
        });
    }
    Ok(registrations)
}

pub(crate) async fn verify_task_attachment_records(
    target: &TaskProviderResolvedTarget,
    canonical_cwd: &str,
    records: &[TaskAttachmentRecord],
) -> Result<(), TaskAttachmentVerificationError> {
    if records.len() > MAX_TASK_ATTACHMENTS_PER_REQUEST {
        return Err(TaskAttachmentVerificationError::TooMany);
    }
    let mut total_bytes = 0_u64;
    for record in records {
        if record.target_key != target.target_key() {
            return Err(TaskAttachmentVerificationError::TargetMismatch);
        }
        let provider_path = provider_path(canonical_cwd, &record.provider_relative_path);
        let bytes = read_target_copy(target, canonical_cwd, &provider_path)
            .await
            .map_err(|_| TaskAttachmentVerificationError::MissingOrUnreadable)?;
        total_bytes = total_bytes
            .checked_add(bytes.len() as u64)
            .ok_or(TaskAttachmentVerificationError::TooLarge)?;
        if total_bytes > MAX_TASK_ATTACHMENT_REQUEST_BYTES {
            return Err(TaskAttachmentVerificationError::TooLarge);
        }
        if bytes.len() as u64 != record.size_bytes {
            return Err(TaskAttachmentVerificationError::SizeMismatch);
        }
        if sha256_digest(&bytes) != record.digest {
            return Err(TaskAttachmentVerificationError::DigestMismatch);
        }
    }
    Ok(())
}

/// Remove one exact ledger-owned copy after the store has durably moved its
/// record to `reclaimPending`. A missing copy is idempotent success; a present
/// copy with changed bytes, a link/reparse point, or a changed target is never
/// deleted.
pub(crate) async fn reclaim_task_attachment_record(
    target: &TaskProviderResolvedTarget,
    record: &TaskAttachmentRecord,
) -> Result<(), String> {
    if record.connection_id != target.connection_id() || record.target_key != target.target_key() {
        return Err("The Task attachment target changed before reclamation.".to_string());
    }
    match target.run_target().execution {
        ProviderExecutionTransport::Ssh => reclaim_remote_attachment(target, record).await,
        ProviderExecutionTransport::Local | ProviderExecutionTransport::Wsl => {
            reclaim_local_attachment(target, record)
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum TaskAttachmentVerificationError {
    TooMany,
    TargetMismatch,
    MissingOrUnreadable,
    TooLarge,
    SizeMismatch,
    DigestMismatch,
}

fn validate_request(canonical_cwd: &str, sources: &[String]) -> Result<(), String> {
    if canonical_cwd.trim().is_empty()
        || canonical_cwd.len() > 4096
        || canonical_cwd.chars().any(char::is_control)
    {
        return Err("The Task working folder is invalid.".to_string());
    }
    if sources.is_empty() || sources.len() > MAX_TASK_ATTACHMENTS_PER_REQUEST {
        return Err("Select between 1 and 16 Task attachments.".to_string());
    }
    if sources.iter().any(|source| {
        source.trim().is_empty()
            || source.len() > 4096
            || source
                .chars()
                .any(|ch| ch == '\0' || ch == '\r' || ch == '\n')
            || has_traversal_segment(source)
    }) {
        return Err("A Task attachment path is invalid.".to_string());
    }
    Ok(())
}

async fn read_import_source(
    target: &TaskProviderResolvedTarget,
    canonical_cwd: &str,
    source: &str,
) -> Result<Vec<u8>, String> {
    match target.run_target().execution {
        ProviderExecutionTransport::Local | ProviderExecutionTransport::Wsl => {
            match read_local_source(target, canonical_cwd, source) {
                Ok(bytes) => Ok(bytes),
                Err(_) => read_operator_host_source(source),
            }
        }
        ProviderExecutionTransport::Ssh => {
            let host_source = PathBuf::from(crate::strip_windows_extended_path_prefix(source));
            if std::fs::symlink_metadata(&host_source).is_ok() {
                return read_operator_host_source(source);
            }
            let ssh = ssh_config(target)?;
            read_remote_source(&ssh, canonical_cwd, source).await
        }
    }
}

fn read_operator_host_source(source: &str) -> Result<Vec<u8>, String> {
    let source_path = PathBuf::from(crate::strip_windows_extended_path_prefix(source));
    crate::validate_no_symlink_components(&source_path.to_string_lossy())?;
    let metadata = std::fs::symlink_metadata(&source_path)
        .map_err(|_| "The selected Task attachment is unavailable on this computer.".to_string())?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("Task attachments must be regular files, not links or folders.".to_string());
    }
    let source_path = std::fs::canonicalize(&source_path)
        .map_err(|_| "The selected Task attachment is unavailable on this computer.".to_string())?;
    let home = operator_home()?;
    if !source_path.starts_with(&home) {
        return Err(
            "Task attachments selected on this computer must be inside the user home folder."
                .to_string(),
        );
    }
    crate::reject_if_sensitive_path(
        &source_path.to_string_lossy().replace('\\', "/"),
        "selected Task attachment",
    )?;
    if metadata.len() == 0 || metadata.len() > MAX_TASK_ATTACHMENT_BYTES {
        return Err("Each Task attachment must be between 1 byte and 25 MiB.".to_string());
    }
    let bytes = std::fs::read(&source_path)
        .map_err(|_| "The selected Task attachment could not be read.".to_string())?;
    if bytes.len() as u64 != metadata.len() || bytes.len() as u64 > MAX_TASK_ATTACHMENT_BYTES {
        return Err(
            "The selected Task attachment changed while it was being imported.".to_string(),
        );
    }
    Ok(bytes)
}

fn operator_home() -> Result<PathBuf, String> {
    #[cfg(target_os = "windows")]
    let home = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME"));
    #[cfg(not(target_os = "windows"))]
    let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"));
    let home = home.ok_or_else(|| "The user home folder is unavailable.".to_string())?;
    std::fs::canonicalize(PathBuf::from(home))
        .map_err(|_| "The user home folder is unavailable.".to_string())
}

async fn read_target_copy(
    target: &TaskProviderResolvedTarget,
    canonical_cwd: &str,
    source: &str,
) -> Result<Vec<u8>, String> {
    match target.run_target().execution {
        ProviderExecutionTransport::Ssh => {
            let ssh = ssh_config(target)?;
            read_remote_source(&ssh, canonical_cwd, source).await
        }
        ProviderExecutionTransport::Local | ProviderExecutionTransport::Wsl => {
            read_local_source(target, canonical_cwd, source)
        }
    }
}

fn read_local_source(
    target: &TaskProviderResolvedTarget,
    canonical_cwd: &str,
    source: &str,
) -> Result<Vec<u8>, String> {
    let host_cwd = local_host_path(target, canonical_cwd)?;
    let host_source = local_host_path(target, source)?;
    crate::validate_no_symlink_components(&host_cwd.to_string_lossy())?;
    crate::validate_no_symlink_components(&host_source.to_string_lossy())?;
    let cwd = std::fs::canonicalize(&host_cwd)
        .map_err(|_| "The Task working folder is unavailable.".to_string())?;
    let source_metadata = std::fs::symlink_metadata(&host_source)
        .map_err(|_| "A Task attachment is unavailable.".to_string())?;
    if source_metadata.file_type().is_symlink() || !source_metadata.is_file() {
        return Err("Task attachments must be regular files, not links or folders.".to_string());
    }
    let source_path = std::fs::canonicalize(&host_source)
        .map_err(|_| "A Task attachment is unavailable.".to_string())?;
    if !source_path.starts_with(&cwd) || source_path == cwd {
        return Err(
            "Task attachments must already be inside the selected working folder.".to_string(),
        );
    }
    let provider_source = source.replace('\\', "/");
    crate::reject_if_sensitive_path(&provider_source, "selected Task attachment")?;
    if source_metadata.len() == 0 || source_metadata.len() > MAX_TASK_ATTACHMENT_BYTES {
        return Err("Each Task attachment must be between 1 byte and 25 MiB.".to_string());
    }
    let bytes = std::fs::read(&source_path)
        .map_err(|_| "A Task attachment could not be read.".to_string())?;
    if bytes.len() as u64 != source_metadata.len() || bytes.len() as u64 > MAX_TASK_ATTACHMENT_BYTES
    {
        return Err("A Task attachment changed while it was being imported.".to_string());
    }
    Ok(bytes)
}

async fn read_remote_source(
    ssh: &SshSpawnConfig,
    canonical_cwd: &str,
    source: &str,
) -> Result<Vec<u8>, String> {
    let cwd = crate::ssh_realpath_for_preview(ssh, canonical_cwd)
        .await
        .map_err(|_| "The remote Task working folder is unavailable.".to_string())?;
    let resolved = crate::ssh_realpath_for_preview(ssh, source)
        .await
        .map_err(|_| "A remote Task attachment is unavailable.".to_string())?;
    if !provider_path_is_within(&resolved, &cwd, ssh.remote_runtime) || resolved == cwd {
        return Err(
            "Remote Task attachments must be inside the selected working folder.".to_string(),
        );
    }
    crate::reject_if_sensitive_path(
        &resolved.replace('\\', "/"),
        "selected remote Task attachment",
    )?;
    ensure_remote_regular_unlinked(ssh, &cwd, source, &resolved).await?;
    let bytes = crate::ssh_read_file_bytes_with_cap(
        ssh,
        &resolved,
        MAX_TASK_ATTACHMENT_BYTES,
        "Task attachment",
    )
    .await
    .map_err(|_| "A remote Task attachment could not be read.".to_string())?;
    if bytes.is_empty() {
        return Err("Task attachments must contain at least one byte.".to_string());
    }
    Ok(bytes)
}

async fn write_and_verify(
    target: &TaskProviderResolvedTarget,
    canonical_cwd: &str,
    relative_path: &str,
    bytes: &[u8],
    digest: &str,
) -> Result<(), String> {
    match target.run_target().execution {
        ProviderExecutionTransport::Ssh => {
            let ssh = ssh_config(target)?;
            let cwd = crate::ssh_realpath_for_preview(&ssh, canonical_cwd)
                .await
                .map_err(|_| "The remote Task working folder is unavailable.".to_string())?;
            let destination = provider_path(&cwd, relative_path);
            write_remote_attachment(&ssh, &cwd, &destination, bytes).await?;
            ensure_remote_regular_unlinked(&ssh, &cwd, &destination, &destination).await?;
            let verified = crate::ssh_read_file_bytes_with_cap(
                &ssh,
                &destination,
                MAX_TASK_ATTACHMENT_BYTES,
                "Task attachment copy",
            )
            .await
            .map_err(|_| "The remote Task attachment copy could not be verified.".to_string())?;
            if verified.len() != bytes.len() || sha256_digest(&verified) != digest {
                return Err("The remote Task attachment copy did not match its digest.".to_string());
            }
        }
        ProviderExecutionTransport::Local | ProviderExecutionTransport::Wsl => {
            write_local_attachment(target, canonical_cwd, relative_path, bytes, digest)?;
        }
    }
    Ok(())
}

fn write_local_attachment(
    target: &TaskProviderResolvedTarget,
    canonical_cwd: &str,
    relative_path: &str,
    bytes: &[u8],
    digest: &str,
) -> Result<(), String> {
    let host_cwd = local_host_path(target, canonical_cwd)?;
    crate::validate_no_symlink_components(&host_cwd.to_string_lossy())?;
    let cwd = std::fs::canonicalize(&host_cwd)
        .map_err(|_| "The Task working folder is unavailable.".to_string())?;
    let destination = relative_path
        .split('/')
        .fold(cwd.clone(), |path, part| path.join(part));
    let parent = destination
        .parent()
        .ok_or_else(|| "Task attachment destination is invalid.".to_string())?;
    ensure_private_local_directories(&cwd, parent)?;
    if let Ok(metadata) = std::fs::symlink_metadata(&destination) {
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err("Task attachment destination is not a regular file.".to_string());
        }
        let existing = std::fs::read(&destination)
            .map_err(|_| "Task attachment destination could not be verified.".to_string())?;
        if existing.len() == bytes.len() && sha256_digest(&existing) == digest {
            return Ok(());
        }
        return Err(
            "Task attachment content-addressed destination has conflicting bytes.".to_string(),
        );
    }
    crate::session_git::atomic_write_private_file(&destination, bytes, "ShellX Task attachment")?;
    let verified = std::fs::read(&destination)
        .map_err(|_| "Task attachment copy could not be verified.".to_string())?;
    if verified.len() != bytes.len() || sha256_digest(&verified) != digest {
        return Err("Task attachment copy did not match its digest.".to_string());
    }
    Ok(())
}

fn reclaim_local_attachment(
    target: &TaskProviderResolvedTarget,
    record: &TaskAttachmentRecord,
) -> Result<(), String> {
    let host_cwd = local_host_path(target, &record.canonical_cwd)?;
    crate::validate_no_symlink_components(&host_cwd.to_string_lossy())?;
    let cwd = std::fs::canonicalize(&host_cwd)
        .map_err(|_| "The Task attachment working folder is unavailable.".to_string())?;
    let destination = record
        .provider_relative_path
        .split('/')
        .fold(cwd.clone(), |path, part| path.join(part));
    let metadata = match std::fs::symlink_metadata(&destination) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(_) => return Err("The Task attachment copy could not be inspected.".to_string()),
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("The Task attachment copy is no longer an owned regular file.".to_string());
    }
    crate::validate_no_symlink_components(&destination.to_string_lossy())?;
    let resolved = std::fs::canonicalize(&destination)
        .map_err(|_| "The Task attachment copy could not be resolved.".to_string())?;
    if !resolved.starts_with(&cwd) {
        return Err("The Task attachment copy escaped its working folder.".to_string());
    }
    let bytes = std::fs::read(&resolved)
        .map_err(|_| "The Task attachment copy could not be verified.".to_string())?;
    if bytes.len() as u64 != record.size_bytes || sha256_digest(&bytes) != record.digest {
        return Err("The Task attachment copy changed and was not removed.".to_string());
    }
    std::fs::remove_file(&resolved)
        .map_err(|_| "The Task attachment copy could not be removed.".to_string())?;
    if let Some(parent) = resolved.parent() {
        let _ = std::fs::remove_dir(parent);
    }
    Ok(())
}

async fn reclaim_remote_attachment(
    target: &TaskProviderResolvedTarget,
    record: &TaskAttachmentRecord,
) -> Result<(), String> {
    let ssh = ssh_config(target)?;
    let cwd = crate::ssh_realpath_for_preview(&ssh, &record.canonical_cwd)
        .await
        .map_err(|_| "The remote Task working folder is unavailable.".to_string())?;
    let destination = provider_path(&cwd, &record.provider_relative_path);
    if remote_attachment_is_absent(&ssh, &destination).await? {
        return Ok(());
    }
    ensure_remote_regular_unlinked(&ssh, &cwd, &destination, &destination).await?;
    let bytes = match crate::ssh_read_file_bytes_with_cap(
        &ssh,
        &destination,
        MAX_TASK_ATTACHMENT_BYTES,
        "Task attachment copy",
    )
    .await
    {
        Ok(bytes) => bytes,
        Err(_) => return Err("The remote Task attachment copy could not be verified.".to_string()),
    };
    if bytes.len() as u64 != record.size_bytes || sha256_digest(&bytes) != record.digest {
        return Err("The remote Task attachment copy changed and was not removed.".to_string());
    }
    let script = if ssh.remote_runtime == SshRemoteRuntime::Windows {
        windows_delete_script(&cwd, &destination)
    } else {
        posix_delete_script(&cwd, &destination)
    };
    crate::ssh_run_preview_command(&ssh, script, "Task attachment reclaim")
        .await
        .map_err(|_| "The remote Task attachment copy could not be removed.".to_string())?;
    Ok(())
}

async fn ensure_remote_regular_unlinked(
    ssh: &SshSpawnConfig,
    cwd: &str,
    raw_path: &str,
    resolved_path: &str,
) -> Result<(), String> {
    let script = if ssh.remote_runtime == SshRemoteRuntime::Windows {
        windows_link_guard_script(cwd, raw_path, resolved_path)
    } else {
        posix_link_guard_script(cwd, raw_path, resolved_path)
    };
    crate::ssh_run_preview_command(ssh, script, "Task attachment link guard")
        .await
        .map_err(|_| "The remote Task attachment path is linked or unavailable.".to_string())?;
    Ok(())
}

fn posix_link_guard_script(cwd: &str, raw_path: &str, resolved_path: &str) -> String {
    let cwd = crate::acp::shell_quote_for_remote(cwd);
    let raw_path = crate::acp::shell_quote_for_remote(raw_path);
    let resolved_path = crate::acp::shell_quote_for_remote(resolved_path);
    format!(
        "set -eu; cwd={cwd}; raw={raw_path}; expected={resolved_path}; case \"$raw\" in /*) ;; *) exit 64;; esac; realcwd=$(realpath \"$cwd\"); resolved=$(realpath \"$raw\"); [ \"$resolved\" = \"$expected\" ] || exit 65; case \"$resolved\" in \"$realcwd/\"*) ;; *) exit 66;; esac; current=$raw; while [ \"$current\" != / ]; do [ ! -L \"$current\" ] || exit 67; parent=${{current%/*}}; [ -n \"$parent\" ] || parent=/; [ \"$parent\" != \"$current\" ] || exit 68; current=$parent; done; [ -f \"$raw\" ] && [ ! -L \"$raw\" ] || exit 69"
    )
}

fn windows_link_guard_script(cwd: &str, raw_path: &str, resolved_path: &str) -> String {
    let cwd = crate::acp::powershell_single_quote(cwd);
    let raw_path = crate::acp::powershell_single_quote(raw_path);
    let resolved_path = crate::acp::powershell_single_quote(resolved_path);
    format!(
        "{}$cwd=(Resolve-Path -LiteralPath {cwd} -ErrorAction Stop).ProviderPath.TrimEnd('\\');$raw=[IO.Path]::GetFullPath({raw_path});$expected=(Resolve-Path -LiteralPath {resolved_path} -ErrorAction Stop).ProviderPath;$prefix=$cwd+'\\';if(-not $raw.StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase)){{exit 64}};$resolved=(Resolve-Path -LiteralPath $raw -ErrorAction Stop).ProviderPath;if(-not $resolved.Equals($expected,[StringComparison]::OrdinalIgnoreCase)){{exit 65}};if(-not $resolved.StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase)){{exit 66}};$current=$raw;while($current.Length -gt $cwd.Length){{$item=Get-Item -LiteralPath $current -Force -ErrorAction Stop;if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){{exit 67}};$parent=Split-Path -Parent $current;if([string]::IsNullOrEmpty($parent) -or $parent.Equals($current,[StringComparison]::OrdinalIgnoreCase)){{exit 68}};$current=$parent}};if(-not $current.Equals($cwd,[StringComparison]::OrdinalIgnoreCase)){{exit 69}};$final=Get-Item -LiteralPath $raw -Force -ErrorAction Stop;if($final.PSIsContainer){{exit 70}}",
        crate::acp::windows_remote_shell_prelude(),
    )
}

async fn remote_attachment_is_absent(
    ssh: &SshSpawnConfig,
    destination: &str,
) -> Result<bool, String> {
    let script = if ssh.remote_runtime == SshRemoteRuntime::Windows {
        format!(
            "{}$item=Get-Item -LiteralPath {} -Force -ErrorAction SilentlyContinue;if($null -eq $item){{[Console]::Out.Write('absent')}}else{{[Console]::Out.Write('present')}}",
            crate::acp::windows_remote_shell_prelude(),
            crate::acp::powershell_single_quote(destination),
        )
    } else {
        let destination = crate::acp::shell_quote_for_remote(destination);
        format!(
            "dest={destination}; if [ ! -e \"$dest\" ] && [ ! -L \"$dest\" ]; then printf absent; else printf present; fi"
        )
    };
    let output = crate::ssh_run_preview_command(ssh, script, "Task attachment presence")
        .await
        .map_err(|_| "The remote Task attachment copy could not be inspected.".to_string())?;
    match String::from_utf8_lossy(&output).trim() {
        "absent" => Ok(true),
        "present" => Ok(false),
        _ => Err("The remote Task attachment presence result was invalid.".to_string()),
    }
}

fn ensure_private_local_directories(cwd: &Path, parent: &Path) -> Result<(), String> {
    if !parent.starts_with(cwd) {
        return Err("Task attachment destination escapes the working folder.".to_string());
    }
    let relative = parent
        .strip_prefix(cwd)
        .map_err(|_| "Task attachment destination escapes the working folder.".to_string())?;
    let mut current = cwd.to_path_buf();
    for component in relative.components() {
        current.push(component.as_os_str());
        match std::fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
                return Err(
                    "Task attachment directory contains a link or non-directory.".to_string(),
                );
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                std::fs::create_dir(&current)
                    .map_err(|_| "Task attachment directory could not be created.".to_string())?;
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt as _;
                    std::fs::set_permissions(&current, std::fs::Permissions::from_mode(0o700))
                        .map_err(|_| {
                            "Task attachment directory could not be secured.".to_string()
                        })?;
                }
            }
            Err(_) => return Err("Task attachment directory could not be inspected.".to_string()),
        }
    }
    let resolved = std::fs::canonicalize(parent)
        .map_err(|_| "Task attachment directory could not be resolved.".to_string())?;
    if !resolved.starts_with(cwd) {
        return Err("Task attachment directory escapes the working folder.".to_string());
    }
    Ok(())
}

async fn write_remote_attachment(
    ssh: &SshSpawnConfig,
    cwd: &str,
    destination: &str,
    bytes: &[u8],
) -> Result<(), String> {
    let temporary = format!("{destination}.tmp.{}", Uuid::new_v4());
    let command = if ssh.remote_runtime == SshRemoteRuntime::Windows {
        windows_write_script(cwd, destination, &temporary)
    } else {
        posix_write_script(cwd, destination, &temporary)
    };
    crate::acp::validate_ssh_destination_arg(&ssh.host)?;
    let mut process = tokio::process::Command::new("ssh");
    process.arg("-o").arg("BatchMode=yes");
    process.arg("-o").arg("ConnectTimeout=10");
    process.arg("-T");
    if let Some(port) = ssh.port {
        process.arg("-p").arg(port.to_string());
    }
    if let Some(key_path) =
        crate::provider_adapters::resolve_provider_ssh_key_path(ssh.key_vault_ref.as_deref())
            .await?
    {
        process.arg("-i").arg(key_path);
    }
    process.arg("--").arg(&ssh.host);
    let command = if ssh.remote_runtime == SshRemoteRuntime::Windows {
        crate::acp::wrap_ssh_windows_command(&command)
    } else {
        crate::acp::wrap_ssh_posix_command(ssh.remote_runtime, ssh.wsl_distro.as_deref(), &command)?
    };
    process.arg(command);
    process.stdin(std::process::Stdio::piped());
    process.stdout(std::process::Stdio::null());
    process.stderr(std::process::Stdio::piped());
    use crate::winproc::NoWindowExt as _;
    process.no_window();
    let mut child = process
        .spawn()
        .map_err(|_| "Remote Task attachment copy could not start.".to_string())?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| "Remote Task attachment copy has no input stream.".to_string())?;
    stdin
        .write_all(bytes)
        .await
        .map_err(|_| "Remote Task attachment bytes could not be sent.".to_string())?;
    stdin
        .shutdown()
        .await
        .map_err(|_| "Remote Task attachment input could not be closed.".to_string())?;
    drop(stdin);
    let output = child
        .wait_with_output()
        .await
        .map_err(|_| "Remote Task attachment copy did not finish.".to_string())?;
    if !output.status.success() {
        return Err("Remote Task attachment copy was refused by the target.".to_string());
    }
    Ok(())
}

fn posix_write_script(cwd: &str, destination: &str, temporary: &str) -> String {
    let cwd = crate::acp::shell_quote_for_remote(cwd);
    let destination = crate::acp::shell_quote_for_remote(destination);
    let temporary = crate::acp::shell_quote_for_remote(temporary);
    format!(
        "set -eu; cwd={cwd}; dest={destination}; tmp={temporary}; root=\"$cwd/.shellx\"; tree=\"$root/task-attachments\"; dir=${{dest%/*}}; for p in \"$root\" \"$tree\" \"$dir\"; do [ ! -L \"$p\" ] || exit 65; if [ ! -d \"$p\" ]; then mkdir -m 700 -- \"$p\"; fi; done; realcwd=$(realpath \"$cwd\"); realdir=$(realpath \"$dir\"); case \"$realdir/\" in \"$realcwd/.shellx/task-attachments/\"*) ;; *) exit 66;; esac; [ ! -L \"$dest\" ] || exit 67; trap 'rm -f -- \"$tmp\"' EXIT; umask 077; cat > \"$tmp\"; chmod 600 \"$tmp\"; mv -f -- \"$tmp\" \"$dest\"; trap - EXIT"
    )
}

fn windows_write_script(cwd: &str, destination: &str, temporary: &str) -> String {
    let cwd = crate::acp::powershell_single_quote(cwd);
    let destination = crate::acp::powershell_single_quote(destination);
    let temporary = crate::acp::powershell_single_quote(temporary);
    format!(
        "{}$cwd={cwd};$dest={destination};$tmp={temporary};$root=Join-Path $cwd '.shellx';$tree=Join-Path $root 'task-attachments';$dir=Split-Path -Parent $dest;foreach($p in @($root,$tree,$dir)){{if(Test-Path -LiteralPath $p){{$item=Get-Item -LiteralPath $p -Force;if(-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)){{exit 65}}}}else{{New-Item -ItemType Directory -Path $p -Force | Out-Null}}}};$realCwd=(Resolve-Path -LiteralPath $cwd).ProviderPath.TrimEnd('\\');$realDir=(Resolve-Path -LiteralPath $dir).ProviderPath;$expected=$realCwd+'\\.shellx\\task-attachments\\';if(-not $realDir.StartsWith($expected,[StringComparison]::OrdinalIgnoreCase)){{exit 66}};if(Test-Path -LiteralPath $dest){{$item=Get-Item -LiteralPath $dest -Force;if($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)){{exit 67}}}};$input=[Console]::OpenStandardInput();$file=[IO.File]::Open($tmp,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None);try{{$input.CopyTo($file);$file.Flush($true)}}finally{{$file.Dispose()}};Move-Item -LiteralPath $tmp -Destination $dest -Force",
        crate::acp::windows_remote_shell_prelude(),
    )
}

fn posix_delete_script(cwd: &str, destination: &str) -> String {
    let cwd = crate::acp::shell_quote_for_remote(cwd);
    let destination = crate::acp::shell_quote_for_remote(destination);
    format!(
        "set -eu; cwd={cwd}; dest={destination}; dir=${{dest%/*}}; [ -f \"$dest\" ] && [ ! -L \"$dest\" ] || exit 65; realcwd=$(realpath \"$cwd\"); realdir=$(realpath \"$dir\"); case \"$realdir/\" in \"$realcwd/.shellx/task-attachments/\"*) ;; *) exit 66;; esac; rm -f -- \"$dest\"; rmdir -- \"$dir\" 2>/dev/null || true"
    )
}

fn windows_delete_script(cwd: &str, destination: &str) -> String {
    let cwd = crate::acp::powershell_single_quote(cwd);
    let destination = crate::acp::powershell_single_quote(destination);
    format!(
        "{}$cwd={cwd};$dest={destination};$dir=Split-Path -Parent $dest;$item=Get-Item -LiteralPath $dest -Force -ErrorAction Stop;if($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)){{exit 65}};$realCwd=(Resolve-Path -LiteralPath $cwd).ProviderPath.TrimEnd('\\');$realDir=(Resolve-Path -LiteralPath $dir).ProviderPath;$expected=$realCwd+'\\.shellx\\task-attachments\\';if(-not $realDir.StartsWith($expected,[StringComparison]::OrdinalIgnoreCase)){{exit 66}};Remove-Item -LiteralPath $dest -Force;if((Get-ChildItem -LiteralPath $dir -Force | Measure-Object).Count -eq 0){{Remove-Item -LiteralPath $dir -Force}}",
        crate::acp::windows_remote_shell_prelude(),
    )
}

fn ssh_config(target: &TaskProviderResolvedTarget) -> Result<SshSpawnConfig, String> {
    let run = target.run_target();
    let host = run
        .ssh_host
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "The Task SSH target is incomplete.".to_string())?;
    Ok(SshSpawnConfig {
        host: host.to_string(),
        port: run.ssh_port,
        key_vault_ref: run.ssh_key_vault_ref.clone(),
        remote_grok_path: String::new(),
        remote_runtime: run.ssh_remote_runtime,
        wsl_distro: run.ssh_wsl_distro.clone(),
    })
}

fn local_host_path(
    target: &TaskProviderResolvedTarget,
    provider_path: &str,
) -> Result<PathBuf, String> {
    if target.run_target().execution == ProviderExecutionTransport::Wsl
        && cfg!(target_os = "windows")
    {
        let distro = target
            .run_target()
            .wsl_distro
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| "The Task WSL target is incomplete.".to_string())?;
        if !provider_path.starts_with('/') {
            return Err("The Task WSL path must be absolute.".to_string());
        }
        return Ok(PathBuf::from(format!(
            "\\\\wsl$\\{}{}",
            distro,
            provider_path.replace('/', "\\")
        )));
    }
    Ok(PathBuf::from(provider_path))
}

fn provider_path(cwd: &str, relative: &str) -> String {
    crate::join_provider_visible_path(cwd, &relative.split('/').collect::<Vec<_>>())
}

fn provider_path_is_within(path: &str, cwd: &str, runtime: SshRemoteRuntime) -> bool {
    let mut path = path.replace('\\', "/").trim_end_matches('/').to_string();
    let mut cwd = cwd.replace('\\', "/").trim_end_matches('/').to_string();
    if runtime == SshRemoteRuntime::Windows {
        path = path.to_ascii_lowercase();
        cwd = cwd.to_ascii_lowercase();
    }
    !cwd.is_empty() && (path == cwd || path.starts_with(&format!("{cwd}/")))
}

fn has_traversal_segment(value: &str) -> bool {
    value.replace('\\', "/").split('/').any(|part| part == "..")
}

fn safe_extension(source: &str) -> String {
    let extension = Path::new(source)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("bin")
        .to_ascii_lowercase();
    if extension.is_empty()
        || extension.len() > 16
        || !extension.chars().all(|ch| ch.is_ascii_alphanumeric())
    {
        "bin".to_string()
    } else {
        extension
    }
}

fn sha256_digest(bytes: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(bytes))
}

#[cfg(test)]
#[path = "task_attachment_transport_tests.rs"]
mod tests;
