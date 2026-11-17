//! Remote lifecycle wrappers for short ShellX commands.
//!
//! `bounded_command` owns the local ssh.exe/wsl.exe process. These wrappers
//! establish a remote owner before a payload begins, so a local transport loss
//! cannot make an already-started one-shot command unbounded. They cannot
//! confirm immediate remote exit during a network partition; they do retain a
//! deadline on the remote host once the owner is running.

use std::time::Duration;

const POSIX_WATCHDOG_GRACE: Duration = Duration::from_secs(5);
// Keep a brief TERM grace on normal completion too: macOS background shells
// can still be starting their final child when the payload shell returns.
// Back-to-back TERM/KILL left that child holding capture pipes in native tests.
// The watchdog stays alive and anchors the PGID throughout this bounded grace.
const POSIX_WATCHDOG_SCRIPT: &str = "shellx_one_shot_timeout_cleanup() { kill -TERM -\"$2\" 2>/dev/null || true; sleep \"$3\"; kill -KILL -\"$2\" 2>/dev/null || true; }; shellx_one_shot_normal_cleanup() { kill -TERM -\"$2\" 2>/dev/null || true; sleep 0.1; kill -KILL -\"$2\" 2>/dev/null || true; }; trap 'shellx_one_shot_normal_cleanup \"$@\"' USR1; trap '' HUP INT TERM; printf 'SHELLX_ONE_SHOT_WATCHDOG_READY:%s\\n' \"$$\"; exec >/dev/null; sleep \"$1\" & shellx_one_shot_timer=$!; wait \"$shellx_one_shot_timer\"; shellx_one_shot_timeout_cleanup \"$@\"";

/// Wrap a POSIX payload in a detached supervisor and an owned session group.
///
/// The top-level transport shell duplicates stdin to FD 3, then starts an
/// isolated supervisor. Its normal stdout is restored to FD 5 while FD 4 is a
/// private, anonymous status pipe back to the transport shell. That lets the
/// payload retain byte-for-byte stdin/stdout semantics without persisting
/// input, while a killed transport shell cannot kill the remote owner.
///
/// The watchdog stays in the payload group and ignores TERM. It therefore
/// keeps the PGID allocated between TERM and KILL, which prevents the delayed
/// KILL from ever targeting a recycled process group. On a normal logical
/// result, the supervisor sends the result over FD 4 first and then asks that
/// watchdog to perform the same bounded group cleanup.
pub(crate) fn bounded_posix_one_shot(payload: &str, deadline: Duration) -> String {
    let deadline_secs = deadline.as_secs().max(1);
    let grace_secs = POSIX_WATCHDOG_GRACE.as_secs();
    let payload = crate::acp::shell_quote_for_remote(payload);
    let watchdog = crate::acp::shell_quote_for_remote(POSIX_WATCHDOG_SCRIPT);
    let supervisor = crate::acp::shell_quote_for_remote(&format!(
        "shellx_one_shot_group=$$; \
sh -c {watchdog} \"shellx-one-shot-$shellx_one_shot_group\" {deadline_secs} \"$shellx_one_shot_group\" {grace_secs} </dev/null 3<&- 4>&- 5>&- 2>/dev/null | \
( IFS= read -r shellx_one_shot_ready || {{ printf '%s\\n' 'SHELLX_ONE_SHOT_STATUS:125' >&4; exit 125; }}; \
case \"$shellx_one_shot_ready\" in SHELLX_ONE_SHOT_WATCHDOG_READY:*) shellx_one_shot_watchdog=${{shellx_one_shot_ready#SHELLX_ONE_SHOT_WATCHDOG_READY:}} ;; *) printf '%s\\n' 'SHELLX_ONE_SHOT_STATUS:125' >&4; exit 125 ;; esac; \
case \"$shellx_one_shot_watchdog\" in ''|*[!0-9]*) printf '%s\\n' 'SHELLX_ONE_SHOT_STATUS:125' >&4; exit 125 ;; esac; \
if ! kill -0 \"$shellx_one_shot_watchdog\" 2>/dev/null; then printf '%s\\n' 'SHELLX_ONE_SHOT_STATUS:125' >&4; exit 125; fi; \
sh -c {payload} <&3 3<&- 4>&- 5>&- & \
shellx_one_shot_payload=$!; \
wait \"$shellx_one_shot_payload\"; shellx_one_shot_status=$?; \
printf 'SHELLX_ONE_SHOT_STATUS:%s\\n' \"$shellx_one_shot_status\" >&4 || true; \
kill -USR1 \"$shellx_one_shot_watchdog\" 2>/dev/null || true; \
exit \"$shellx_one_shot_status\" )"
    ));
    format!(
        "exec 3<&0; exec 5>&1; \
if command -v setsid >/dev/null 2>&1 && setsid sh -c ':' >/dev/null 2>&1; then shellx_one_shot_launcher=setsid; \
elif command -v perl >/dev/null 2>&1 && perl -MPOSIX=setsid -e 'defined setsid() or exit 1' >/dev/null 2>&1; then shellx_one_shot_launcher=perl; \
else echo 'ShellX remote one-shot requires setsid or Perl POSIX::setsid' >&2; exit 127; fi; \
shellx_one_shot_collect_status() {{ IFS= read -r shellx_one_shot_line || exit 125; case \"$shellx_one_shot_line\" in SHELLX_ONE_SHOT_STATUS:*) shellx_one_shot_status=${{shellx_one_shot_line#SHELLX_ONE_SHOT_STATUS:}} ;; *) exit 125 ;; esac; case \"$shellx_one_shot_status\" in ''|*[!0-9]*) exit 125 ;; esac; if [ \"$shellx_one_shot_status\" -gt 255 ] 2>/dev/null; then exit 125; fi; exit \"$shellx_one_shot_status\"; }}; \
if [ \"$shellx_one_shot_launcher\" = setsid ]; then setsid sh -c {supervisor} 4>&1 1>&5 | shellx_one_shot_collect_status & \
else perl -MPOSIX=setsid -e 'setsid(); exec @ARGV' sh -c {supervisor} 4>&1 1>&5 | shellx_one_shot_collect_status & fi; \
shellx_one_shot_collector=$!; wait \"$shellx_one_shot_collector\"; exit $?",
    )
}

const WINDOWS_JOB_NATIVE: &str = r#"
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

public static class ShellXOneShotNative {
    const uint CREATE_SUSPENDED = 0x00000004;
    const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
    const uint EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
    const uint STARTF_USESTDHANDLES = 0x00000100;
    const uint DUPLICATE_SAME_ACCESS = 0x00000002;
    const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    const int PROC_THREAD_ATTRIBUTE_HANDLE_LIST = 0x00020002;
    const int JobObjectExtendedLimitInformation = 9;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct StartupInfo {
        public int cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public int dwX;
        public int dwY;
        public int dwXSize;
        public int dwYSize;
        public int dwXCountChars;
        public int dwYCountChars;
        public int dwFillAttribute;
        public uint dwFlags;
        public short wShowWindow;
        public short cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct ProcessInfo {
        public IntPtr ProcessHandle;
        public IntPtr ThreadHandle;
        public int ProcessId;
        public int ThreadId;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct StartupInfoEx {
        public StartupInfo StartupInfo;
        public IntPtr AttributeList;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct BasicLimitInformation {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public IntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct IoCounters {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct ExtendedLimitInformation {
        public BasicLimitInformation BasicLimitInformation;
        public IoCounters IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool CreateProcess(
        string applicationName,
        StringBuilder commandLine,
        IntPtr processAttributes,
        IntPtr threadAttributes,
        bool inheritHandles,
        uint creationFlags,
        IntPtr environment,
        string currentDirectory,
        ref StartupInfoEx startupInfo,
        out ProcessInfo processInformation);
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr GetStdHandle(int which);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool DuplicateHandle(IntPtr sourceProcess, IntPtr sourceHandle, IntPtr targetProcess, out IntPtr targetHandle, uint access, bool inherit, uint options);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool TerminateProcess(IntPtr process, uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returned);
    [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref ExtendedLimitInformation info, int length);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool TerminateJobObject(IntPtr job, uint exitCode);

    static void Check(bool ok, string operation) {
        if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error(), operation);
    }

    static IntPtr DuplicateInheritedStandardHandle(int which) {
        IntPtr copy;
        Check(DuplicateHandle(GetCurrentProcess(), GetStdHandle(which), GetCurrentProcess(), out copy, 0, true, DUPLICATE_SAME_ACCESS), "DuplicateHandle standard handle");
        return copy;
    }

    public static IntPtr CreateKillOnCloseJob() {
        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateJobObject");
        try {
            ExtendedLimitInformation info = new ExtendedLimitInformation();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            Check(SetInformationJobObject(job, JobObjectExtendedLimitInformation, ref info, Marshal.SizeOf(typeof(ExtendedLimitInformation))), "SetInformationJobObject KILL_ON_JOB_CLOSE");
            return job;
        } catch {
            CloseHandle(job);
            throw;
        }
    }

    public static ProcessInfo StartSuspendedWithInheritedStandardHandles(string application, string commandLine) {
        IntPtr input = IntPtr.Zero;
        IntPtr output = IntPtr.Zero;
        IntPtr error = IntPtr.Zero;
        IntPtr attributes = IntPtr.Zero;
        IntPtr inherited = IntPtr.Zero;
        bool attributesInitialized = false;
        try {
            input = DuplicateInheritedStandardHandle(-10);
            output = DuplicateInheritedStandardHandle(-11);
            error = DuplicateInheritedStandardHandle(-12);
            IntPtr attributeBytes = IntPtr.Zero;
            InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref attributeBytes);
            if (attributeBytes == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "InitializeProcThreadAttributeList size");
            attributes = Marshal.AllocHGlobal(attributeBytes);
            Check(InitializeProcThreadAttributeList(attributes, 1, 0, ref attributeBytes), "InitializeProcThreadAttributeList");
            attributesInitialized = true;
            inherited = Marshal.AllocHGlobal(IntPtr.Size * 3);
            Marshal.WriteIntPtr(inherited, 0, input);
            Marshal.WriteIntPtr(inherited, IntPtr.Size, output);
            Marshal.WriteIntPtr(inherited, IntPtr.Size * 2, error);
            Check(UpdateProcThreadAttribute(attributes, 0, (IntPtr)PROC_THREAD_ATTRIBUTE_HANDLE_LIST, inherited, (IntPtr)(IntPtr.Size * 3), IntPtr.Zero, IntPtr.Zero), "UpdateProcThreadAttribute handle list");
            StartupInfoEx startup = new StartupInfoEx();
            startup.StartupInfo.cb = Marshal.SizeOf(typeof(StartupInfoEx));
            startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
            startup.StartupInfo.hStdInput = input;
            startup.StartupInfo.hStdOutput = output;
            startup.StartupInfo.hStdError = error;
            startup.AttributeList = attributes;
            ProcessInfo process;
            Check(CreateProcess(application, new StringBuilder(commandLine), IntPtr.Zero, IntPtr.Zero, true, CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT, IntPtr.Zero, null, ref startup, out process), "CreateProcess suspended worker");
            return process;
        } finally {
            if (attributesInitialized) DeleteProcThreadAttributeList(attributes);
            if (inherited != IntPtr.Zero) Marshal.FreeHGlobal(inherited);
            if (attributes != IntPtr.Zero) Marshal.FreeHGlobal(attributes);
            if (input != IntPtr.Zero) CloseHandle(input);
            if (output != IntPtr.Zero) CloseHandle(output);
            if (error != IntPtr.Zero) CloseHandle(error);
        }
    }

    public static void Assign(IntPtr job, IntPtr process) { Check(AssignProcessToJobObject(job, process), "AssignProcessToJobObject"); }
    public static uint ExitCode(IntPtr process) { uint code; Check(GetExitCodeProcess(process, out code), "GetExitCodeProcess"); return code; }
}
"#;

/// Wrap a Windows PowerShell payload in a remote Job Object.
///
/// The worker is created suspended with duplicated inherited standard handles,
/// assigned to a kill-on-close job, and only then resumed. If any setup step
/// fails, the suspended worker is terminated before its payload can execute.
/// The controller waits for the worker itself with the supplied deadline;
/// controller death closes the job handle and kills its tree, while normal
/// completion explicitly terminates the job to reap payload-spawned background
/// children before returning the worker's original status.
fn windows_one_shot_worker(payload: &str) -> String {
    format!(
        "{}&([ScriptBlock]::Create({}));$shellxOneShotStatus=$LASTEXITCODE;if($null -eq $shellxOneShotStatus){{$shellxOneShotStatus=0}};exit $shellxOneShotStatus",
        crate::acp::windows_remote_shell_prelude(),
        crate::acp::powershell_single_quote(payload),
    )
}

pub(crate) fn bounded_windows_one_shot(payload: &str, deadline: Duration) -> String {
    use base64::Engine as _;

    let deadline_millis = deadline.as_millis().clamp(1, u128::from(u32::MAX));
    let worker = windows_one_shot_worker(payload);
    let worker_utf16 = worker
        .encode_utf16()
        .flat_map(u16::to_le_bytes)
        .collect::<Vec<_>>();
    let worker_encoded = base64::engine::general_purpose::STANDARD.encode(worker_utf16);
    let native = crate::acp::powershell_single_quote(WINDOWS_JOB_NATIVE);
    format!(
        "{prelude}$ErrorActionPreference='Stop';$shellxNative={native};Add-Type -TypeDefinition $shellxNative -ErrorAction Stop;$shellxWorker=Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\powershell.exe';$shellxWorkerCommand='\"'+$shellxWorker.Replace('\"','')+'\" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand {worker_encoded}';$shellxJob=[IntPtr]::Zero;$shellxProcess=[IntPtr]::Zero;$shellxThread=[IntPtr]::Zero;$shellxAssigned=$false;$shellxStatus=125;try{{$shellxJob=[ShellXOneShotNative]::CreateKillOnCloseJob();$shellxInfo=[ShellXOneShotNative]::StartSuspendedWithInheritedStandardHandles($shellxWorker,$shellxWorkerCommand);$shellxProcess=$shellxInfo.ProcessHandle;$shellxThread=$shellxInfo.ThreadHandle;[ShellXOneShotNative]::Assign($shellxJob,$shellxProcess);$shellxAssigned=$true;if([ShellXOneShotNative]::ResumeThread($shellxThread) -eq 0xffffffff){{throw 'ResumeThread failed'}};[ShellXOneShotNative]::CloseHandle($shellxThread)|Out-Null;$shellxThread=[IntPtr]::Zero;$shellxWait=[ShellXOneShotNative]::WaitForSingleObject($shellxProcess,{deadline_millis});if($shellxWait -eq 258){{$shellxStatus=124}}elseif($shellxWait -eq 0){{$shellxStatus=[int][ShellXOneShotNative]::ExitCode($shellxProcess)}}else{{throw ('WaitForSingleObject failed: '+$shellxWait)}}}}catch{{[Console]::Error.WriteLine(('ShellX remote Windows one-shot setup failed: '+$_.Exception.Message));$shellxStatus=125}}finally{{try{{if($shellxAssigned){{if(-not [ShellXOneShotNative]::TerminateJobObject($shellxJob,1)){{throw 'TerminateJobObject failed'}};if($shellxProcess -ne [IntPtr]::Zero -and [ShellXOneShotNative]::WaitForSingleObject($shellxProcess,5000) -ne 0){{throw 'Job Object worker did not exit within cleanup bound'}}}}elseif($shellxProcess -ne [IntPtr]::Zero){{if(-not [ShellXOneShotNative]::TerminateProcess($shellxProcess,1)){{throw 'TerminateProcess suspended worker failed'}};if([ShellXOneShotNative]::WaitForSingleObject($shellxProcess,5000) -ne 0){{throw 'Suspended worker did not exit within cleanup bound'}}}}}}catch{{[Console]::Error.WriteLine(('ShellX remote Windows one-shot cleanup failed: '+$_.Exception.Message));$shellxStatus=125}}finally{{if($shellxThread -ne [IntPtr]::Zero){{[ShellXOneShotNative]::CloseHandle($shellxThread)|Out-Null}};if($shellxProcess -ne [IntPtr]::Zero){{[ShellXOneShotNative]::CloseHandle($shellxProcess)|Out-Null}};if($shellxJob -ne [IntPtr]::Zero){{[ShellXOneShotNative]::CloseHandle($shellxJob)|Out-Null}}}}}};exit $shellxStatus",
        prelude = crate::acp::windows_remote_shell_prelude(),
    )
}

pub(crate) fn bounded_ssh_posix_command(
    runtime: crate::acp::SshRemoteRuntime,
    wsl_distro: Option<&str>,
    payload: &str,
    deadline: Duration,
) -> Result<String, String> {
    crate::acp::wrap_ssh_posix_command(
        runtime,
        wsl_distro,
        &bounded_posix_one_shot(payload, deadline),
    )
}

/// Native-Windows SSH dispatch is intentionally small: OpenSSH can route the
/// command through cmd.exe, whose practical argv limit is much lower than a
/// Job Object bootstrap. The controller is therefore sent as a base64 line on
/// stdin, followed byte-for-byte by any payload stdin (for example a Grok MCP
/// token). `windows_native_ssh_dispatch_command` consumes that line with an
/// unbuffered stream read, so it cannot eat the first bytes of the payload.
pub(crate) struct BoundedSshWindowsCommand {
    pub(crate) command: String,
    pub(crate) setup_stdin: Vec<u8>,
}

pub(crate) fn bounded_ssh_windows_command(
    payload: &str,
    deadline: Duration,
) -> BoundedSshWindowsCommand {
    use base64::Engine as _;

    let mut setup_stdin = base64::engine::general_purpose::STANDARD
        .encode(bounded_windows_one_shot(payload, deadline).as_bytes())
        .into_bytes();
    setup_stdin.push(b'\n');
    BoundedSshWindowsCommand {
        command: crate::acp::wrap_ssh_windows_command(
            &crate::acp::windows_native_ssh_dispatch_command(),
        ),
        setup_stdin,
    }
}
