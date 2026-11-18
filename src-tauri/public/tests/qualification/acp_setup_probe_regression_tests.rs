#[cfg(target_os = "linux")]
use super::*;

#[cfg(target_os = "linux")]
fn fake_ssh_executable(body: &str) -> std::path::PathBuf {
    use std::os::unix::fs::PermissionsExt;
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("clock")
        .as_nanos();
    let path = std::env::temp_dir().join(format!(
        "shellx-acp-fake-ssh-{}-{nonce}",
        std::process::id()
    ));
    std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).expect("write fake ssh");
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700))
        .expect("make fake ssh executable");
    path
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn ssh_setup_probe_accepts_marker_from_fake_executable() {
    let executable = fake_ssh_executable("printf '%s\\n' SHELLX_POSIX");
    let output = ssh_platform_probe_output_with_executable(
        executable.to_str().expect("path"),
        "fixture-host",
        None,
        None,
        "printf '%s\\n' SHELLX_POSIX",
        SshRemoteRuntime::Posix,
        None,
    )
    .await
    .expect("normal fake probe");
    assert!(output.status.success());
    assert_eq!(
        classify_ssh_remote_platform(&String::from_utf8_lossy(&output.stdout)),
        Some(SshRemotePlatform::Posix)
    );
    std::fs::remove_file(executable).expect("remove fake ssh");
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn ssh_setup_probe_reaps_hung_fake_executable() {
    let pid_file = std::env::temp_dir().join(format!("shellx-acp-hung-{}", std::process::id()));
    let executable = fake_ssh_executable(&format!(
        "printf '%s' \"$$\" > '{}'; printf '%s\\n' SHELLX_POSIX; sleep 30",
        pid_file.display(),
    ));
    let error = ssh_platform_probe_output_with_executable(
        executable.to_str().expect("path"),
        "fixture-host",
        None,
        None,
        "printf '%s\\n' SHELLX_POSIX",
        SshRemoteRuntime::Posix,
        None,
    )
    .await
    .expect_err("hung fake ssh must time out");
    assert!(error.contains("timed out after 8000 ms"), "{error}");
    let pid = std::fs::read_to_string(&pid_file)
        .expect("fake ssh pid")
        .parse::<u32>()
        .expect("numeric pid");
    assert!(
        !std::path::Path::new(&format!("/proc/{pid}")).exists(),
        "fake ssh child remains"
    );
    std::fs::remove_file(executable).expect("remove fake ssh");
    std::fs::remove_file(pid_file).expect("remove pid file");
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn ssh_setup_probe_rejects_fake_output_flood() {
    let executable = fake_ssh_executable("dd if=/dev/zero bs=1024 count=80 2>/dev/null");
    let error = ssh_platform_probe_output_with_executable(
        executable.to_str().expect("path"),
        "fixture-host",
        None,
        None,
        "printf '%s\\n' SHELLX_POSIX",
        SshRemoteRuntime::Posix,
        None,
    )
    .await
    .expect_err("fake ssh flood must hit output cap");
    assert!(
        error.contains("stdout") && error.contains("limit"),
        "{error}"
    );
    std::fs::remove_file(executable).expect("remove fake ssh");
}
