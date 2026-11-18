//! Identity-bound reads and writes for an SSH project's owned files.
//!
//! The caller supplies a session-owned project root and a lexical descendant.
//! The remote transaction then resolves every component through stable handles
//! in one bounded command. It refuses unavailable stable-handle primitives
//! instead of falling back to a check followed by a pathname reopen.

use std::time::Duration;

use sha2::{Digest, Sha256};
use tokio::process::Command;

use crate::acp::{validate_ssh_destination_arg, SshRemoteRuntime, SshSpawnConfig};

pub(crate) const REMOTE_PROJECT_FILE_MAX_BYTES: usize = 16 * 1024 * 1024;
const REMOTE_PROJECT_FILE_STDERR_BYTES: usize = 64 * 1024;
const REMOTE_PROJECT_FILE_TIMEOUT: Duration = Duration::from_secs(30);

struct ScopedRemoteCommand {
    command: String,
    setup_stdin: Vec<u8>,
}

#[derive(Clone)]
struct PayloadIntegrity {
    bytes: usize,
    sha256: String,
}

impl PayloadIntegrity {
    fn for_bytes(content: &[u8]) -> Self {
        Self {
            bytes: content.len(),
            sha256: format!("{:x}", Sha256::digest(content)),
        }
    }
}

/// Read a regular, singly-linked file below the selected remote project root.
/// The remote transaction holds all selected-root ancestor handles until I/O
/// completes and only emits data after it has verified the remote byte cap.
pub(crate) async fn read_scoped_remote_text(
    ssh: &SshSpawnConfig,
    project_root: &str,
    remote_path: &str,
) -> Result<String, String> {
    validate_scoped_remote_path(project_root, remote_path, ssh.remote_runtime)?;
    let command = scoped_remote_command(ssh, project_root, remote_path, None)?;
    let output = run_scoped_ssh(ssh, command, None).await?;
    String::from_utf8(output).map_err(|error| format!("remote project file was not UTF-8: {error}"))
}

/// Atomically replace a project-owned file through the same stable parent
/// handle used for validation. The transaction refuses linked/non-regular
/// existing targets and cleans an owned temporary on every error path.
pub(crate) async fn write_scoped_remote_text(
    ssh: &SshSpawnConfig,
    project_root: &str,
    remote_path: &str,
    content: &str,
) -> Result<(), String> {
    validate_scoped_remote_path(project_root, remote_path, ssh.remote_runtime)?;
    if content.len() > REMOTE_PROJECT_FILE_MAX_BYTES {
        return Err(format!(
            "remote project file write exceeds {} byte limit",
            REMOTE_PROJECT_FILE_MAX_BYTES
        ));
    }
    let integrity = PayloadIntegrity::for_bytes(content.as_bytes());
    let command = scoped_remote_command(ssh, project_root, remote_path, Some(&integrity))?;
    run_scoped_ssh(ssh, command, Some(content.as_bytes())).await?;
    Ok(())
}

/// Check the caller-owned lexical relationship before constructing a remote
/// command. The remote process performs the authoritative handle-bound check.
pub(crate) fn validate_scoped_remote_path(
    project_root: &str,
    remote_path: &str,
    remote_runtime: SshRemoteRuntime,
) -> Result<(), String> {
    if project_root.is_empty()
        || remote_path.is_empty()
        || project_root.len() > 4_096
        || remote_path.len() > 4_096
        || project_root.chars().any(char::is_control)
        || remote_path.chars().any(char::is_control)
    {
        return Err(
            "remote project path is empty, too long, or contains a control character".into(),
        );
    }

    if remote_runtime == SshRemoteRuntime::Windows {
        if !crate::acp::is_windows_absolute_remote_path(project_root)
            || !crate::acp::is_windows_absolute_remote_path(remote_path)
        {
            return Err("native Windows remote project paths must be drive-absolute".into());
        }
        let root = normalize_windows(project_root);
        let path = normalize_windows(remote_path);
        if root.len() <= 3 || has_parent_component(&root, '\\') || has_parent_component(&path, '\\')
        {
            return Err("remote project path is not a non-root lexical project descendant".into());
        }
        if !path_is_within(&path, &root, '\\') || path.eq_ignore_ascii_case(&root) {
            return Err("remote path must name a file inside the selected project".into());
        }
        return Ok(());
    }

    if !project_root.starts_with('/') || !remote_path.starts_with('/') {
        return Err("POSIX remote project paths must be absolute".into());
    }
    let root = project_root.trim_end_matches('/');
    let root = if root.is_empty() { "/" } else { root };
    if root == "/" || has_parent_component(root, '/') || has_parent_component(remote_path, '/') {
        return Err("remote project path is not a non-root lexical project descendant".into());
    }
    if !path_is_within(remote_path, root, '/') || remote_path == root {
        return Err("remote path must name a file inside the selected project".into());
    }
    Ok(())
}

async fn run_scoped_ssh(
    ssh: &SshSpawnConfig,
    remote: ScopedRemoteCommand,
    payload: Option<&[u8]>,
) -> Result<Vec<u8>, String> {
    validate_ssh_destination_arg(&ssh.host)?;
    let mut command = Command::new("ssh");
    command
        .arg("-o")
        .arg("BatchMode=yes")
        .arg("-o")
        .arg("ConnectTimeout=5")
        .arg("-T");
    if let Some(port) = ssh.port {
        command.arg("-p").arg(port.to_string());
    }
    command.arg("--").arg(&ssh.host).arg(remote.command);

    let mut stdin = remote.setup_stdin;
    if let Some(payload) = payload {
        stdin.extend_from_slice(payload);
    }
    let output = if stdin.is_empty() {
        crate::bounded_command::run_bounded_output(
            &mut command,
            "scoped remote project file transaction",
            REMOTE_PROJECT_FILE_TIMEOUT,
            REMOTE_PROJECT_FILE_MAX_BYTES,
            REMOTE_PROJECT_FILE_STDERR_BYTES,
        )
        .await?
    } else {
        crate::bounded_command::run_bounded_output_with_stdin(
            &mut command,
            "scoped remote project file transaction",
            REMOTE_PROJECT_FILE_TIMEOUT,
            REMOTE_PROJECT_FILE_MAX_BYTES,
            REMOTE_PROJECT_FILE_STDERR_BYTES,
            &stdin,
        )
        .await?
    };
    if output.status.success() {
        return Ok(output.stdout);
    }

    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let reason = if stderr.is_empty() {
        "the remote transaction exited without a diagnostic".to_string()
    } else {
        stderr.chars().take(512).collect()
    };
    Err(format!(
        "remote project file access was refused or failed (status {:?}): {reason}",
        output.status.code(),
    ))
}

fn scoped_remote_command(
    ssh: &SshSpawnConfig,
    project_root: &str,
    remote_path: &str,
    integrity: Option<&PayloadIntegrity>,
) -> Result<ScopedRemoteCommand, String> {
    let payload = match ssh.remote_runtime {
        SshRemoteRuntime::Windows => {
            windows_transaction_script(project_root, remote_path, integrity)
        }
        runtime => crate::acp::wrap_ssh_posix_command(
            runtime,
            ssh.wsl_distro.as_deref(),
            &posix_transaction_script(project_root, remote_path, integrity),
        )?,
    };

    match ssh.remote_runtime {
        SshRemoteRuntime::Posix => Ok(ScopedRemoteCommand {
            command: crate::remote_one_shot::bounded_ssh_posix_command(
                ssh.remote_runtime,
                ssh.wsl_distro.as_deref(),
                &payload,
                REMOTE_PROJECT_FILE_TIMEOUT,
            )?,
            setup_stdin: Vec::new(),
        }),
        // Native Windows and Windows+WSL both use the streamed Windows
        // dispatcher. This keeps the large C#/Python bootstrap out of SSH argv
        // and gives the complete remote payload a Job Object lifecycle.
        SshRemoteRuntime::Windows | SshRemoteRuntime::WindowsWsl => {
            let bounded = crate::remote_one_shot::bounded_ssh_windows_command(
                &payload,
                REMOTE_PROJECT_FILE_TIMEOUT,
            );
            Ok(ScopedRemoteCommand {
                command: bounded.command,
                setup_stdin: bounded.setup_stdin,
            })
        }
    }
}

fn posix_transaction_script(
    project_root: &str,
    remote_path: &str,
    integrity: Option<&PayloadIntegrity>,
) -> String {
    // Python 3 is a deliberate capability requirement. It supplies portable
    // descriptor-relative APIs on Linux, macOS, and Windows+WSL without using
    // Linux-specific /proc paths or reopening a checked pathname.
    let source = r#"
import errno, hashlib, os, secrets, stat, sys

MAX_BYTES = __SHELLX_MAX_BYTES__

def fail(message, code=73):
    sys.stderr.write("SHELLX_REMOTE_PROJECT_FILE_REFUSED: " + message + "\n")
    raise SystemExit(code)

def unsupported(message):
    sys.stderr.write("SHELLX_REMOTE_PROJECT_FILE_UNSUPPORTED: " + message + "\n")
    raise SystemExit(74)

def flags_directory():
    required = ("O_DIRECTORY", "O_NOFOLLOW", "O_CLOEXEC", "O_NONBLOCK")
    if any(not hasattr(os, name) for name in required):
        unsupported("descriptor-relative directory access is unavailable")
    if not hasattr(os, "supports_dir_fd") or os.open not in os.supports_dir_fd:
        unsupported("openat-style directory descriptors are unavailable")
    return os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC

def open_root_directory(root, flags, descriptors):
    if not root.startswith("/") or root == "/":
        fail("selected project root is not an absolute non-root directory")
    current = os.open("/", flags)
    descriptors.append(current)
    for part in root.split("/")[1:]:
        if not part or part in (".", ".."):
            fail("selected project root contains an invalid component")
        current = os.open(part, flags, dir_fd=current)
        descriptors.append(current)
    return current

def regular_single_link(fd):
    info = os.fstat(fd)
    if not stat.S_ISREG(info.st_mode):
        fail("target is not a regular file")
    if info.st_nlink != 1:
        fail("target has more than one hard link")

def read_bounded(fd):
    data = bytearray()
    while len(data) <= MAX_BYTES:
        block = os.read(fd, min(65536, MAX_BYTES + 1 - len(data)))
        if not block:
            break
        data.extend(block)
    if len(data) > MAX_BYTES:
        fail("target exceeds remote byte limit")
    return data

def read_stdin_bounded(expected_bytes, expected_sha256):
    if expected_bytes < 0 or expected_bytes > MAX_BYTES or len(expected_sha256) != 64 or any(c not in "0123456789abcdef" for c in expected_sha256):
        fail("invalid write integrity frame")
    data = bytearray()
    incoming = sys.stdin.buffer
    while len(data) <= MAX_BYTES:
        block = incoming.read(min(65536, MAX_BYTES + 1 - len(data)))
        if not block:
            break
        data.extend(block)
    if len(data) > MAX_BYTES:
        fail("write exceeds remote byte limit")
    if len(data) != expected_bytes or hashlib.sha256(data).hexdigest() != expected_sha256:
        fail("write integrity frame does not match received bytes")
    return data

def write_all(fd, block):
    offset = 0
    while offset < len(block):
        offset += os.write(fd, block[offset:])

def main(root, relative, write, expected_bytes, expected_sha256):
    directory_flags = flags_directory()
    if not hasattr(os, "rename") or os.rename not in os.supports_dir_fd:
        unsupported("descriptor-relative rename is unavailable")
    parts = relative.split("/")
    if not parts or any(not part or part in (".", "..") for part in parts):
        fail("invalid project-relative file path")
    descriptors = []
    temporary = None
    temporary_name = None
    renamed = False
    try:
        current = open_root_directory(root, directory_flags, descriptors)
        for part in parts[:-1]:
            current = os.open(part, directory_flags, dir_fd=current)
            descriptors.append(current)
        name = parts[-1]
        nofollow_read = os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW | os.O_CLOEXEC
        if not write:
            target = os.open(name, nofollow_read, dir_fd=current)
            try:
                regular_single_link(target)
                sys.stdout.buffer.write(read_bounded(target))
                sys.stdout.buffer.flush()
            finally:
                os.close(target)
            return
        try:
            target = os.open(name, nofollow_read, dir_fd=current)
        except OSError as error:
            if error.errno != errno.ENOENT:
                raise
        else:
            try:
                regular_single_link(target)
            finally:
                os.close(target)
        for _ in range(32):
            candidate = ".shellx-project-tmp-" + secrets.token_hex(16)
            try:
                temporary = os.open(candidate, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=current)
            except FileExistsError:
                continue
            temporary_name = candidate
            break
        if temporary is None or temporary_name is None:
            fail("could not allocate a private temporary file")
        try:
            regular_single_link(temporary)
            write_all(temporary, read_stdin_bounded(expected_bytes, expected_sha256))
            os.fsync(temporary)
        finally:
            os.close(temporary)
            temporary = None
        os.rename(temporary_name, name, src_dir_fd=current, dst_dir_fd=current)
        renamed = True
        os.fsync(current)
        target = os.open(name, nofollow_read, dir_fd=current)
        try:
            regular_single_link(target)
        finally:
            os.close(target)
    except OSError as error:
        fail(os.strerror(error.errno) if error.errno else str(error))
    finally:
        if temporary is not None:
            try:
                os.close(temporary)
            except OSError:
                pass
        if temporary_name is not None and not renamed and descriptors:
            try:
                os.unlink(temporary_name, dir_fd=descriptors[-1])
            except OSError:
                pass
        for descriptor in reversed(descriptors):
            try:
                os.close(descriptor)
            except OSError:
                pass

main(sys.argv[1], sys.argv[2], sys.argv[3] == "write", int(sys.argv[4]), sys.argv[5])
"#;
    let source = source.replace(
        "__SHELLX_MAX_BYTES__",
        &REMOTE_PROJECT_FILE_MAX_BYTES.to_string(),
    );
    let encoded = {
        use base64::Engine as _;
        base64::engine::general_purpose::STANDARD.encode(source.as_bytes())
    };
    let root = crate::acp::shell_quote_for_remote(project_root);
    let mode = if integrity.is_some() { "write" } else { "read" };
    let expected_bytes = integrity.map_or(0, |value| value.bytes);
    let expected_sha256 = integrity.map_or("-", |value| value.sha256.as_str());
    let relative = remote_path
        .strip_prefix(project_root.trim_end_matches('/'))
        .and_then(|rest| rest.strip_prefix('/'))
        .unwrap_or_default();
    format!(
        "set -eu; command -v python3 >/dev/null 2>&1 || {{ printf '%s\\n' 'SHELLX_REMOTE_PROJECT_FILE_UNSUPPORTED: python3 is required for stable descriptor access' >&2; exit 74; }}; script=$(printf %s {encoded}|{{ base64 -d 2>/dev/null || base64 -D 2>/dev/null; }}) || {{ printf '%s\\n' 'SHELLX_REMOTE_PROJECT_FILE_UNSUPPORTED: base64 decoder is required for stable descriptor access' >&2; exit 74; }}; exec python3 -c \"$script\" {root} {} {mode} {expected_bytes} {expected_sha256}",
        crate::acp::shell_quote_for_remote(relative),
    )
}

fn windows_transaction_script(
    project_root: &str,
    remote_path: &str,
    integrity: Option<&PayloadIntegrity>,
) -> String {
    windows_transaction_script_with_temporary_name(project_root, remote_path, integrity, None)
}

fn windows_transaction_script_with_temporary_name(
    project_root: &str,
    remote_path: &str,
    integrity: Option<&PayloadIntegrity>,
    first_temporary_name: Option<&str>,
) -> String {
    // Directory handles intentionally share only reads: a peer cannot rename,
    // delete, or reparse-mutate a selected-project ancestor during the
    // transaction. Every path is then compared to the held root handle.
    let source = r#"
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using Microsoft.Win32.SafeHandles;

public static class ShellxScopedProjectFile {
  const int MAX_BYTES = __SHELLX_MAX_BYTES__;
  const uint GENERIC_READ = 0x80000000;
  const uint GENERIC_WRITE = 0x40000000;
  const uint FILE_READ_ATTRIBUTES = 0x00000080;
  const uint DELETE = 0x00010000;
  const uint FILE_SHARE_READ = 0x00000001;
  const uint CREATE_NEW = 1;
  const uint OPEN_EXISTING = 3;
  const uint FILE_ATTRIBUTE_NORMAL = 0x00000080;
  const uint FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;
  const uint FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000;
  const uint FILE_ATTRIBUTE_DIRECTORY = 0x00000010;
  const uint FILE_ATTRIBUTE_REPARSE_POINT = 0x00000400;
  const int ERROR_FILE_NOT_FOUND = 2;
  const int ERROR_PATH_NOT_FOUND = 3;
  const int ERROR_FILE_EXISTS = 80;
  const int ERROR_ALREADY_EXISTS = 183;
  const int FileRenameInformationClass = 10;
  const int FileDispositionInfo = 4;
  [StructLayout(LayoutKind.Sequential)] public struct Info {
    public uint Attributes; public System.Runtime.InteropServices.ComTypes.FILETIME Creation;
    public System.Runtime.InteropServices.ComTypes.FILETIME Access;
    public System.Runtime.InteropServices.ComTypes.FILETIME Write;
    public uint Volume; public uint SizeHigh; public uint SizeLow; public uint Links;
    public uint FileIndexHigh; public uint FileIndexLow;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern SafeFileHandle CreateFile(string path, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle handle, out Info info);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern uint GetFinalPathNameByHandle(SafeFileHandle handle, StringBuilder path, uint length, uint flags);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetFileInformationByHandle(SafeFileHandle handle, int informationClass, IntPtr information, uint size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool WriteFile(SafeFileHandle handle, IntPtr buffer, uint count, out uint written, IntPtr overlapped);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool FlushFileBuffers(SafeFileHandle handle);
  [StructLayout(LayoutKind.Sequential)] struct IoStatusBlock { public IntPtr Status; public UIntPtr Information; }
  [DllImport("ntdll.dll")] static extern int NtSetInformationFile(SafeFileHandle file, out IoStatusBlock result, IntPtr info, uint size, int informationClass);
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct FileRenameInformation {
    public uint ReplaceIfExists;
    public IntPtr RootDirectory; public uint FileNameLength; public char FileName;
  }
  [StructLayout(LayoutKind.Sequential)] struct FileDispositionInformation {
    [MarshalAs(UnmanagedType.U1)] public bool DeleteFile;
  }
  static Exception Refuse(string message) { return new IOException("SHELLX_REMOTE_PROJECT_FILE_REFUSED: " + message); }
  static Info GetInfo(SafeFileHandle handle) { Info info; if (!GetFileInformationByHandle(handle, out info)) throw Refuse("could not inspect stable handle"); return info; }
  static SafeFileHandle Open(string path, uint access, bool directory) {
    uint flags = FILE_FLAG_OPEN_REPARSE_POINT | (directory ? FILE_FLAG_BACKUP_SEMANTICS : 0);
    SafeFileHandle handle = CreateFile(path, access, FILE_SHARE_READ, IntPtr.Zero, OPEN_EXISTING, flags, IntPtr.Zero);
    if (handle.IsInvalid) {
      int error = Marshal.GetLastWin32Error(); handle.Dispose();
      if (error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND) throw new FileNotFoundException("stable path was not found", path);
      throw Refuse("could not open stable handle (Win32 error " + error + ")");
    }
    Info info = GetInfo(handle);
    if ((info.Attributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) { handle.Dispose(); throw Refuse("reparse point is not allowed"); }
    if (directory != ((info.Attributes & FILE_ATTRIBUTE_DIRECTORY) != 0)) { handle.Dispose(); throw Refuse("unexpected file type"); }
    return handle;
  }
  static string Final(SafeFileHandle handle) {
    StringBuilder buffer = new StringBuilder(32768); uint count = GetFinalPathNameByHandle(handle, buffer, (uint)buffer.Capacity, 0);
    if (count == 0 || count >= buffer.Capacity) throw Refuse("could not resolve stable handle identity");
    string path = buffer.ToString();
    if (path.StartsWith("\\\\?\\UNC\\", StringComparison.OrdinalIgnoreCase)) return "\\\\" + path.Substring(8);
    return path.StartsWith("\\\\?\\", StringComparison.Ordinal) ? path.Substring(4) : path;
  }
  static bool Within(string path, string root) {
    path = path.TrimEnd('\\'); root = root.TrimEnd('\\');
    return path.Equals(root, StringComparison.OrdinalIgnoreCase) || path.StartsWith(root + "\\", StringComparison.OrdinalIgnoreCase);
  }
  static IEnumerable<string> Ancestors(string root, string parent) {
    string volume = Path.GetPathRoot(root); string current = volume;
    string remainder = parent.Substring(volume.Length).Trim('\\');
    foreach (string part in remainder.Split(new [] {'\\'}, StringSplitOptions.RemoveEmptyEntries)) { current = Path.Combine(current, part); yield return current; }
  }
  static void RequireSingleRegular(SafeFileHandle handle) {
    Info info = GetInfo(handle);
    if ((info.Attributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) != 0) throw Refuse("target is not a regular file");
    if (info.Links != 1) throw Refuse("target has more than one hard link");
  }
  static byte[] ReadBounded(Stream input, string label) {
    using (MemoryStream output = new MemoryStream()) {
      byte[] buffer = new byte[65536];
      while (output.Length <= MAX_BYTES) {
        int count = input.Read(buffer, 0, Math.Min(buffer.Length, MAX_BYTES + 1 - (int)output.Length));
        if (count == 0) break;
        output.Write(buffer, 0, count);
      }
      if (output.Length > MAX_BYTES) throw Refuse(label + " exceeds remote byte limit");
      return output.ToArray();
    }
  }
  static void RequireWriteIntegrity(byte[] incoming, int expectedBytes, string expectedSha256) {
    if (expectedBytes < 0 || expectedBytes > MAX_BYTES || expectedSha256 == null || expectedSha256.Length != 64)
      throw Refuse("invalid write integrity frame");
    foreach (char c in expectedSha256) if (!Uri.IsHexDigit(c)) throw Refuse("invalid write integrity frame");
    using (SHA256 sha = SHA256.Create()) {
      string actual = BitConverter.ToString(sha.ComputeHash(incoming)).Replace("-", "").ToLowerInvariant();
      if (incoming.Length != expectedBytes || !actual.Equals(expectedSha256, StringComparison.OrdinalIgnoreCase))
        throw Refuse("write integrity frame does not match received bytes");
    }
  }
  static SafeFileHandle CreateOwnedTemporary(string parent, string firstTemporaryName) {
    for (int attempt = 0; attempt < 32; attempt++) {
      string name = attempt == 0 && !String.IsNullOrEmpty(firstTemporaryName)
        ? firstTemporaryName
        : ".shellx-project-tmp-" + Guid.NewGuid().ToString("N");
      string path = Path.Combine(parent, name);
      SafeFileHandle handle = CreateFile(path, GENERIC_WRITE | FILE_READ_ATTRIBUTES | DELETE, FILE_SHARE_READ, IntPtr.Zero, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, IntPtr.Zero);
      if (!handle.IsInvalid) return handle;
      int error = Marshal.GetLastWin32Error(); handle.Dispose();
      if (error == ERROR_FILE_EXISTS || error == ERROR_ALREADY_EXISTS) continue;
      throw Refuse("could not create private temporary file (Win32 error " + error + ")");
    }
    throw Refuse("could not allocate a private temporary file");
  }
  static void WriteAll(SafeFileHandle handle, byte[] content) {
    GCHandle pinned = GCHandle.Alloc(content, GCHandleType.Pinned);
    try {
      int offset = 0;
      while (offset < content.Length) {
        uint written;
        IntPtr start = Marshal.UnsafeAddrOfPinnedArrayElement(content, offset);
        if (!WriteFile(handle, start, (uint)(content.Length - offset), out written, IntPtr.Zero) || written == 0) throw Refuse("could not write private temporary file");
        offset += (int)written;
      }
      if (!FlushFileBuffers(handle)) throw Refuse("could not flush private temporary file");
    } finally { pinned.Free(); }
  }
  static void RenameIntoParent(SafeFileHandle temporary, SafeFileHandle parent, string name) {
    if (!Path.GetDirectoryName(Final(temporary)).Equals(Final(parent), StringComparison.OrdinalIgnoreCase)) throw Refuse("private temporary file left the held parent");
    byte[] nameBytes = Encoding.Unicode.GetBytes(name);
    int offset = (int)Marshal.OffsetOf(typeof(FileRenameInformation), "FileName");
    int size = Marshal.SizeOf(typeof(FileRenameInformation)) + nameBytes.Length;
    IntPtr info = Marshal.AllocHGlobal(size);
    try {
      FileRenameInformation rename = new FileRenameInformation();
      // Nt's simple-name rename stays in the opened temporary file's parent.
      // Passing RootDirectory reopens the destination directory for writing,
      // conflicting with our intentional no-write/no-delete ancestor locks.
      // Keep those locks; never resolve the name through the process CWD.
      rename.ReplaceIfExists = 1; rename.RootDirectory = IntPtr.Zero; rename.FileNameLength = (uint)nameBytes.Length;
      Marshal.Copy(new byte[size], 0, info, size);
      Marshal.StructureToPtr(rename, info, false);
      Marshal.Copy(nameBytes, 0, IntPtr.Add(info, offset), nameBytes.Length);
      IoStatusBlock result;
      int status = NtSetInformationFile(temporary, out result, info, (uint)size, FileRenameInformationClass);
      if (status < 0) throw Refuse("could not atomically rename private temporary file (NTSTATUS " + status.ToString("X8") + ")");
    } finally { Marshal.FreeHGlobal(info); }
  }
  static void DeleteOwnedTemporary(SafeFileHandle temporary) {
    FileDispositionInformation disposition = new FileDispositionInformation(); disposition.DeleteFile = true;
    int size = Marshal.SizeOf(typeof(FileDispositionInformation)); IntPtr info = Marshal.AllocHGlobal(size);
    try {
      Marshal.StructureToPtr(disposition, info, false);
      if (!SetFileInformationByHandle(temporary, FileDispositionInfo, info, (uint)size)) throw Refuse("could not clean up private temporary file (Win32 error " + Marshal.GetLastWin32Error() + ")");
    } finally { Marshal.FreeHGlobal(info); }
  }
  public static void Run(string rootInput, string rawInput, bool write, int expectedBytes, string expectedSha256, string firstTemporaryName) {
    string root = Path.GetFullPath(rootInput).TrimEnd('\\'); string raw = Path.GetFullPath(rawInput);
    if (!Within(raw, root) || raw.Equals(root, StringComparison.OrdinalIgnoreCase)) throw Refuse("path is outside selected project");
    string parent = Path.GetDirectoryName(raw); string name = Path.GetFileName(raw);
    if (String.IsNullOrEmpty(parent) || String.IsNullOrEmpty(name)) throw Refuse("path has no stable parent/name");
    List<SafeFileHandle> locks = new List<SafeFileHandle>(); string rootFinal = null;
    try {
      foreach (string ancestor in Ancestors(root, parent)) {
        SafeFileHandle handle = Open(ancestor, GENERIC_READ, true); locks.Add(handle);
        string final = Final(handle);
        if (rootFinal == null && ancestor.Equals(root, StringComparison.OrdinalIgnoreCase)) rootFinal = final;
        if (rootFinal != null && !Within(final, rootFinal)) throw Refuse("ancestor left selected project");
      }
      if (rootFinal == null) throw Refuse("selected project could not be locked");
      if (!write) {
        using (SafeFileHandle file = Open(raw, GENERIC_READ, false)) {
          RequireSingleRegular(file); if (!Within(Final(file), rootFinal)) throw Refuse("target left selected project");
          using (FileStream input = new FileStream(file, FileAccess.Read)) {
            byte[] content = ReadBounded(input, "target"); Console.OpenStandardOutput().Write(content, 0, content.Length);
          }
        }
        return;
      }
      try { using (SafeFileHandle existing = Open(raw, FILE_READ_ATTRIBUTES, false)) { RequireSingleRegular(existing); if (!Within(Final(existing), rootFinal)) throw Refuse("target left selected project"); } }
      catch (FileNotFoundException) { }
      byte[] incoming = ReadBounded(Console.OpenStandardInput(), "write");
      RequireWriteIntegrity(incoming, expectedBytes, expectedSha256);
      SafeFileHandle temporary = CreateOwnedTemporary(parent, firstTemporaryName);
      bool renamed = false;
      try {
        RequireSingleRegular(temporary);
        WriteAll(temporary, incoming);
        RenameIntoParent(temporary, locks[locks.Count - 1], name);
        renamed = true;
      } finally { try { if (!renamed) DeleteOwnedTemporary(temporary); } finally { temporary.Dispose(); } }
    } finally { for (int index = locks.Count - 1; index >= 0; index--) locks[index].Dispose(); }
  }
}
"#;
    let source = source.replace(
        "__SHELLX_MAX_BYTES__",
        &REMOTE_PROJECT_FILE_MAX_BYTES.to_string(),
    );
    let first_temporary_name = first_temporary_name
        .map(crate::acp::powershell_single_quote)
        .unwrap_or_else(|| "$null".to_string());
    let expected_bytes = integrity.map_or(0, |value| value.bytes);
    let expected_sha256 = integrity.map_or("-", |value| value.sha256.as_str());
    format!(
        "{}$ErrorActionPreference='Stop';try{{Add-Type -TypeDefinition @'\n{}\n'@ -ErrorAction Stop}}catch{{[Console]::Error.WriteLine('SHELLX_REMOTE_PROJECT_FILE_UNSUPPORTED: native Windows stable-handle helper is unavailable: '+$_.Exception.Message);exit 74}};$root={};$raw={};try{{[ShellxScopedProjectFile]::Run($root,$raw,${},{},{},{})}}catch{{[Console]::Error.WriteLine($_.Exception.Message);exit 73}}",
        crate::acp::windows_remote_shell_prelude(),
        source,
        crate::acp::powershell_single_quote(project_root),
        crate::acp::powershell_single_quote(remote_path),
        if integrity.is_some() { "true" } else { "false" },
        expected_bytes,
        crate::acp::powershell_single_quote(expected_sha256),
        first_temporary_name,
    )
}

fn normalize_windows(path: &str) -> String {
    path.replace('/', "\\").trim_end_matches('\\').to_string()
}

fn has_parent_component(path: &str, separator: char) -> bool {
    path.split(separator).any(|part| part == "..")
}

fn path_is_within(path: &str, root: &str, separator: char) -> bool {
    let root = root.trim_end_matches(separator);
    if separator == '\\' {
        let path = path.to_ascii_lowercase();
        let root = root.to_ascii_lowercase();
        return path == root
            || path
                .strip_prefix(&root)
                .is_some_and(|rest| rest.starts_with(separator));
    }
    path == root
        || path
            .strip_prefix(root)
            .is_some_and(|rest| rest.starts_with(separator))
}

#[cfg(test)]
#[path = "../public/tests/qualification/remote_project_file_integrity_tests.rs"]
mod integrity_tests;

#[cfg(test)]
#[path = "../public/tests/inline/remote_project_file/tests.rs"]
mod tests;
