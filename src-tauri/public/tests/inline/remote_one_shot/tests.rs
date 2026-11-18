use super::*;

#[test]
fn posix_wrapper_detaches_supervisor_preserves_stdin_and_uses_anonymous_status_pipe() {
    let script = bounded_posix_one_shot(
        "IFS= read -r token; printf '%s' \"$token\"",
        Duration::from_secs(9),
    );
    assert!(script.contains("exec 3<&0; exec 5>&1"));
    assert!(script.contains("4>&1 1>&5 | shellx_one_shot_collect_status"));
    assert!(script.contains("SHELLX_ONE_SHOT_STATUS:"));
    assert!(script.contains("setsid sh -c ':'"));
    assert!(script.contains("defined setsid() or exit 1"));
    assert!(
        POSIX_WATCHDOG_SCRIPT.contains("trap '' HUP INT TERM"),
        "the watchdog ignores transport signals while it owns the payload group"
    );
    // `supervisor` is quoted a second time for the detached outer shell, so
    // the first-level quote representation of the watchdog is deliberately
    // not a substring of the final transport command. The constant checks
    // above and the Unix behavioral fixtures below cover its raw contract
    // and executed cleanup behavior without mirroring nested quoting.
    assert!(script.contains("shellx_one_shot_timeout_cleanup"));
    assert!(script.contains("shellx_one_shot_normal_cleanup"));
    assert!(script.contains("SHELLX_ONE_SHOT_WATCHDOG_READY:"));
    assert!(script.contains("shellx_one_shot_timer=$!; wait"));
    assert!(script.contains("kill -TERM -\"$2\""));
    assert!(script.contains("kill -KILL -\"$2\""));
    assert!(script.contains("</dev/null 3<&- 4>&- 5>&- 2>/dev/null |"));
    assert!(script.contains("exec >/dev/null; sleep \"$1\""));
    assert!(script.contains("sh -c") && script.contains("<&3 3<&- 4>&- 5>&- &"));
    assert!(!script.contains("kill -0 \"$4\""));
    assert!(!script.contains("synthetic-stdin"));
}

#[test]
fn windows_wrapper_assigns_suspended_worker_to_a_kill_on_close_job() {
    let script = bounded_windows_one_shot("[Console]::In.ReadLine()", Duration::from_secs(11));
    assert!(script.contains("CREATE_SUSPENDED"));
    assert!(script.contains("JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE"));
    assert!(script.contains("StartSuspendedWithInheritedStandardHandles"));
    assert!(script.contains("AssignProcessToJobObject"));
    assert!(script.contains("PROC_THREAD_ATTRIBUTE_HANDLE_LIST"));
    assert!(script.contains("UpdateProcThreadAttribute handle list"));
    assert!(script.contains("ResumeThread"));
    assert!(script.contains("TerminateJobObject"));
    assert!(script.contains("WaitForSingleObject($shellxProcess,11000)"));
    assert!(script.contains("-EncodedCommand"));
    assert!(!script.contains("Start-Sleep -Seconds"));
    assert!(!script.contains("taskkill.exe"));
}

#[test]
fn windows_ssh_wrapper_streams_large_job_controller_before_payload_stdin() {
    use base64::Engine as _;

    let payload = "[Console]::In.ReadLine()";
    let bounded = bounded_ssh_windows_command(payload, Duration::from_secs(11));
    let dispatcher = crate::acp::windows_native_ssh_dispatch_command();
    assert!(
        bounded.command.len() < 8_000,
        "native Windows SSH argv must remain below the cmd.exe practical limit"
    );
    assert!(bounded.setup_stdin.ends_with(b"\n"));
    let script = base64::engine::general_purpose::STANDARD
        .decode(&bounded.setup_stdin[..bounded.setup_stdin.len() - 1])
        .expect("one-shot setup is base64")
        .into_iter()
        .collect::<Vec<_>>();
    let script = String::from_utf8(script).expect("one-shot setup is UTF-8");
    let worker = windows_one_shot_worker(payload)
        .encode_utf16()
        .flat_map(u16::to_le_bytes)
        .collect::<Vec<_>>();
    let worker = base64::engine::general_purpose::STANDARD.encode(worker);
    assert!(script.contains("StartSuspendedWithInheritedStandardHandles"));
    assert!(
        script.contains(&worker),
        "controller must preserve the payload inside its nested UTF-16 command"
    );
    assert!(dispatcher.contains("[Console]::OpenStandardInput(1)"));
    assert!(!dispatcher.contains("[Console]::In.ReadLine()"));
    assert!(
        !bounded
            .command
            .contains("StartSuspendedWithInheritedStandardHandles"),
        "Job controller must not expand the native Windows SSH argv"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn posix_wrapper_preserves_stdin_and_ends_nested_descendant_at_deadline() {
    use std::process::Command as StdCommand;
    use std::time::Instant;

    let mut command = tokio::process::Command::new("sh");
    command.args([
            "-lc",
            &bounded_posix_one_shot(
                "IFS= read -r value; (trap '' TERM; sleep 30) & descendant=$!; printf '%s|%s\\n' \"$value\" \"$descendant\"; sleep 30",
                Duration::from_secs(1),
            ),
        ]);
    let started = Instant::now();
    let output = crate::bounded_command::run_bounded_output_with_stdin(
        &mut command,
        "remote one-shot stdin fixture",
        Duration::from_secs(10),
        1024,
        1024,
        b"synthetic-stdin\n",
    )
    .await
    .expect("remote watchdog fixture should finish locally");
    let status = output.status;
    let stdout = String::from_utf8(output.stdout).expect("fixture output is utf-8");
    let (stdin, descendant) = stdout
        .trim_end()
        .split_once('|')
        .expect("fixture should report stdin and descendant pid");
    assert_eq!(stdin, "synthetic-stdin");
    let descendant = descendant
        .parse::<u32>()
        .expect("fixture should report a numeric descendant pid");
    assert!(!status.success());
    assert!(
        started.elapsed() < Duration::from_secs(9),
        "remote watchdog and group cleanup should be bounded, elapsed={:?}",
        started.elapsed()
    );
    let descendant_text = descendant.to_string();
    let alive = StdCommand::new("kill")
        .args(["-0", descendant_text.as_str()])
        .output()
        .expect("kill fixture command starts");
    assert!(
        !alive.status.success(),
        "nested descendant {descendant} survived the owned session timeout"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn posix_wrapper_survives_outer_shell_kill_and_enforces_remote_deadline() {
    use std::process::Command as StdCommand;
    use tokio::io::{AsyncBufReadExt, BufReader};

    let mut command = tokio::process::Command::new("sh");
    command.args([
        "-lc",
        &bounded_posix_one_shot(
            "(trap '' TERM; sleep 30) & descendant=$!; printf '%s\\n' \"$descendant\"; sleep 30",
            Duration::from_secs(1),
        ),
    ]);
    command.stdout(std::process::Stdio::piped());
    let mut child = command.spawn().expect("outer transport shell starts");
    let stdout = child.stdout.take().expect("outer shell has stdout");
    let mut lines = BufReader::new(stdout).lines();
    let descendant = lines
        .next_line()
        .await
        .expect("fixture stdout reads")
        .expect("payload reports a descendant")
        .trim()
        .parse::<u32>()
        .expect("fixture descendant pid is numeric");
    child
        .start_kill()
        .expect("outer transport shell can be killed");
    let _ = child.wait().await.expect("outer transport shell reaps");
    tokio::time::sleep(Duration::from_secs(7)).await;
    let descendant_text = descendant.to_string();
    let alive = StdCommand::new("kill")
        .args(["-0", descendant_text.as_str()])
        .output()
        .expect("kill fixture command starts");
    assert!(
        !alive.status.success(),
        "detached remote deadline left descendant {descendant} after transport-shell death"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn posix_wrapper_normal_result_repeatedly_cleans_background_without_pipe_hold() {
    use std::process::Command as StdCommand;
    use std::time::Instant;

    // A fast payload makes the pre-signal watchdog window observable in
    // practice. Repeating the fixture verifies that the readiness record
    // is received before any payload can ask the watchdog to clean up.
    for attempt in 0..16 {
        let mut command = tokio::process::Command::new("sh");
        command.args([
            "-lc",
            &bounded_posix_one_shot(
                "(trap '' TERM; sleep 30) & descendant=$!; printf '%s\\n' \"$descendant\"; exit 0",
                Duration::from_secs(20),
            ),
        ]);
        let started = Instant::now();
        let output = crate::bounded_command::run_bounded_output(
            &mut command,
            "remote one-shot normal background fixture",
            Duration::from_secs(4),
            1024,
            1024,
        )
        .await
        .expect("normal payload should return without watchdog pipe hold");
        assert!(output.status.success(), "attempt {attempt}");
        assert!(
            started.elapsed() < Duration::from_millis(1500),
            "background cleanup held product capture pipes on attempt {attempt}, elapsed={:?}",
            started.elapsed()
        );
        let descendant = String::from_utf8(output.stdout)
            .expect("fixture output is utf-8")
            .trim()
            .parse::<u32>()
            .expect("fixture reports descendant pid");
        tokio::time::sleep(Duration::from_millis(100)).await;
        let descendant_text = descendant.to_string();
        let alive = StdCommand::new("kill")
            .args(["-0", descendant_text.as_str()])
            .output()
            .expect("kill fixture command starts");
        assert!(
            !alive.status.success(),
            "normal result left background descendant {descendant} alive on attempt {attempt}"
        );
    }
}

#[cfg(windows)]
#[tokio::test]
async fn windows_wrapper_preserves_stdin_and_ends_owned_tree_at_deadline() {
    use std::process::Command as StdCommand;
    use std::time::Instant;

    let payload = "\
$value=[Console]::In.ReadLine();\
[Console]::Out.WriteLine($value);\
$child=Start-Process -FilePath $env:ComSpec -ArgumentList @('/d','/c','ping -n 30 127.0.0.1 >nul') -PassThru -NoNewWindow;\
[Console]::Out.WriteLine(('child='+$child.Id));\
Wait-Process -Id $child.Id";
    let mut command = tokio::process::Command::new("powershell.exe");
    command.args([
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        &bounded_windows_one_shot(payload, Duration::from_secs(1)),
    ]);
    let started = Instant::now();
    let output = crate::bounded_command::run_bounded_output_with_stdin(
        &mut command,
        "remote one-shot Windows stdin fixture",
        Duration::from_secs(10),
        1024,
        1024,
        b"synthetic-stdin\n",
    )
    .await
    .expect("Windows job fixture should finish locally");
    let stdout = String::from_utf8(output.stdout).expect("fixture output is utf-8");
    assert!(stdout.lines().any(|line| line.trim() == "synthetic-stdin"));
    let child_pid = stdout
        .lines()
        .find_map(|line| line.trim().strip_prefix("child="))
        .expect("fixture should report a descendant pid")
        .parse::<u32>()
        .expect("fixture descendant pid is numeric");
    assert_eq!(output.status.code(), Some(124));
    assert!(
        started.elapsed() < Duration::from_secs(9),
        "Windows job timeout should be bounded, elapsed={:?}",
        started.elapsed()
    );
    assert_windows_process_absent(&StdCommand::new("powershell.exe"), child_pid);
}

#[cfg(windows)]
#[tokio::test]
async fn windows_ssh_dispatch_keeps_payload_bytes_after_streamed_bootstrap() {
    use base64::Engine as _;

    let bootstrap =
        "$value=[Console]::In.ReadLine();[Console]::Out.WriteLine(('payload='+$value));exit 0";
    let mut stdin = base64::engine::general_purpose::STANDARD
        .encode(bootstrap.as_bytes())
        .into_bytes();
    stdin.extend_from_slice(b"\npayload-after-bootstrap\n");
    let dispatch =
        crate::acp::wrap_ssh_windows_command(&crate::acp::windows_native_ssh_dispatch_command());
    let mut command = tokio::process::Command::new("cmd.exe");
    command.args(["/d", "/s", "/c", &dispatch]);
    let output = crate::bounded_command::run_bounded_output_with_stdin(
        &mut command,
        "Windows SSH bootstrap boundary fixture",
        Duration::from_secs(10),
        1024,
        1024,
        &stdin,
    )
    .await
    .expect("Windows dispatcher fixture should finish");
    assert!(output.status.success());
    assert!(
        String::from_utf8_lossy(&output.stdout)
            .lines()
            .any(|line| line.trim() == "payload=payload-after-bootstrap"),
        "dispatcher consumed payload bytes after its bootstrap: {}",
        String::from_utf8_lossy(&output.stdout)
    );
}

#[cfg(windows)]
#[tokio::test]
async fn windows_ssh_one_shot_preserves_payload_bytes_through_dispatch_and_worker() {
    let bounded = bounded_ssh_windows_command(
        "$value=[Console]::In.ReadLine();[Console]::Out.WriteLine(('payload='+$value));exit 0",
        Duration::from_secs(10),
    );
    let mut stdin = bounded.setup_stdin;
    stdin.extend_from_slice(b"payload-after-controller-bootstrap\n");
    let mut command = tokio::process::Command::new("cmd.exe");
    command.args(["/d", "/s", "/c", &bounded.command]);
    let output = crate::bounded_command::run_bounded_output_with_stdin(
        &mut command,
        "Windows SSH one-shot stdin chain fixture",
        Duration::from_secs(15),
        1024,
        1024,
        &stdin,
    )
    .await
    .expect("Windows one-shot stdin chain should finish");
    assert!(output.status.success());
    assert!(
        String::from_utf8_lossy(&output.stdout)
            .lines()
            .any(|line| line.trim() == "payload=payload-after-controller-bootstrap"),
        "controller/worker path lost payload bytes after bootstrap: {}",
        String::from_utf8_lossy(&output.stdout)
    );
}

#[cfg(windows)]
#[tokio::test]
async fn windows_wrapper_normal_result_kills_background_child_before_return() {
    use std::process::Command as StdCommand;

    let payload = "\
$child=Start-Process -FilePath $env:ComSpec -ArgumentList @('/d','/c','ping -n 30 127.0.0.1 >nul') -PassThru -NoNewWindow;\
[Console]::Out.WriteLine(('child='+$child.Id));\
exit 0";
    let mut command = tokio::process::Command::new("powershell.exe");
    command.args([
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        &bounded_windows_one_shot(payload, Duration::from_secs(10)),
    ]);
    let output = crate::bounded_command::run_bounded_output(
        &mut command,
        "remote one-shot Windows normal background fixture",
        Duration::from_secs(10),
        1024,
        1024,
    )
    .await
    .expect("Windows job normal fixture should finish locally");
    assert!(output.status.success());
    let child_pid = String::from_utf8(output.stdout)
        .expect("fixture output is utf-8")
        .lines()
        .find_map(|line| line.trim().strip_prefix("child="))
        .expect("fixture should report a descendant pid")
        .parse::<u32>()
        .expect("fixture descendant pid is numeric");
    assert_windows_process_absent(&StdCommand::new("powershell.exe"), child_pid);
}

#[cfg(windows)]
fn assert_windows_process_absent(command: &std::process::Command, pid: u32) {
    let exists = command
            .get_program()
            .to_str()
            .map(|program| {
                std::process::Command::new(program)
                    .args([
                        "-NoLogo",
                        "-NoProfile",
                        "-NonInteractive",
                        "-Command",
                        &format!(
                            "if($null -ne (Get-Process -Id {pid} -ErrorAction SilentlyContinue)){{exit 1}};exit 0"
                        ),
                    ])
                    .output()
            })
            .expect("PowerShell path is utf-8")
            .expect("PowerShell process query starts");
    assert!(
        exists.status.success(),
        "Windows descendant {pid} survived the owned Job Object cleanup"
    );
}
