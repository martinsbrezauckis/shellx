use super::*;
use std::path::{Path, PathBuf};

fn fixture_root(label: &str) -> PathBuf {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("clock after epoch")
        .as_nanos();
    let temp = std::env::temp_dir();
    let temp = std::fs::canonicalize(&temp).unwrap_or(temp);
    temp.join(format!(
        "shellx-scoped-integrity-{label}-{}-{stamp}",
        std::process::id()
    ))
}

#[cfg(unix)]
async fn transact(
    root: &Path,
    target: &Path,
    expected: &[u8],
    delivered: &[u8],
) -> std::process::Output {
    let integrity = PayloadIntegrity::for_bytes(expected);
    let script = posix_transaction_script(
        root.to_str().expect("UTF-8 fixture root"),
        target.to_str().expect("UTF-8 fixture target"),
        Some(&integrity),
    );
    let mut command = Command::new("sh");
    command.args(["-lc", &script]);
    crate::bounded_command::run_bounded_output_with_stdin(
        &mut command,
        "scoped file integrity fixture",
        Duration::from_secs(5),
        REMOTE_PROJECT_FILE_MAX_BYTES,
        REMOTE_PROJECT_FILE_STDERR_BYTES,
        delivered,
    )
    .await
    .expect("local POSIX fixture should execute")
}

#[cfg(unix)]
#[tokio::test]
async fn posix_refuses_incomplete_surplus_and_tampered_streams_without_replacement() {
    let base = fixture_root("posix");
    let root = base.join("project");
    std::fs::create_dir_all(&root).expect("create fixture root");
    let target = root.join("notes.txt");
    let original = b"original content\n";
    std::fs::write(&target, original).expect("write original");
    let expected = b"valid replacement\n";

    for delivered in [
        &expected[..expected.len() - 1],
        &b""[..],
        &b"valid replacement\nextra"[..],
        &b"valix replacement\n"[..],
    ] {
        let result = transact(&root, &target, expected, delivered).await;
        assert!(!result.status.success(), "{:?}", delivered);
        assert!(String::from_utf8_lossy(&result.stderr).contains("write integrity frame"));
        assert_eq!(std::fs::read(&target).expect("original survives"), original);
    }

    let valid = "Rīga\nline two\t\u{0001}\0".as_bytes();
    let result = transact(&root, &target, valid, valid).await;
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    assert_eq!(std::fs::read(&target).expect("valid replacement"), valid);

    let empty = transact(&root, &target, b"", b"").await;
    assert!(
        empty.status.success(),
        "{}",
        String::from_utf8_lossy(&empty.stderr)
    );
    assert_eq!(
        std::fs::read(&target).expect("valid empty replacement"),
        b""
    );
    std::fs::remove_dir_all(&base).expect("fixture cleanup");
}

#[cfg(windows)]
#[tokio::test]
async fn windows_refuses_incomplete_surplus_and_tampered_streams_without_replacement() {
    let base = fixture_root("windows");
    let root = base.join("project");
    std::fs::create_dir_all(&root).expect("create fixture root");
    let target = root.join("notes.txt");
    let original = b"original content\r\n";
    std::fs::write(&target, original).expect("write original");
    let expected = b"valid replacement\n";

    for delivered in [
        &expected[..expected.len() - 1],
        &b""[..],
        &b"valid replacement\nextra"[..],
        &b"valix replacement\n"[..],
    ] {
        let result = transact_windows(&root, &target, expected, delivered).await;
        assert!(!result.status.success(), "{:?}", delivered);
        assert!(String::from_utf8_lossy(&result.stderr).contains("write integrity frame"));
        assert_eq!(std::fs::read(&target).expect("original survives"), original);
    }

    let valid = "Rīga\nline two\t\u{0001}\0".as_bytes();
    let result = transact_windows(&root, &target, valid, valid).await;
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    assert_eq!(std::fs::read(&target).expect("valid replacement"), valid);

    let empty = transact_windows(&root, &target, b"", b"").await;
    assert!(
        empty.status.success(),
        "{}",
        String::from_utf8_lossy(&empty.stderr)
    );
    assert_eq!(
        std::fs::read(&target).expect("valid empty replacement"),
        b""
    );
    std::fs::remove_dir_all(&base).expect("fixture cleanup");
}

#[cfg(windows)]
async fn transact_windows(
    root: &Path,
    target: &Path,
    expected: &[u8],
    delivered: &[u8],
) -> std::process::Output {
    let integrity = PayloadIntegrity::for_bytes(expected);
    let script = windows_transaction_script(
        root.to_str().expect("UTF-8 fixture root"),
        target.to_str().expect("UTF-8 fixture target"),
        Some(&integrity),
    );
    let script_path = root.join("transaction.ps1");
    std::fs::write(&script_path, format!("\u{feff}{script}")).expect("write fixture script");
    let mut command = Command::new("powershell.exe");
    command.args([
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
    ]);
    command.arg(&script_path);
    crate::bounded_command::run_bounded_output_with_stdin(
        &mut command,
        "scoped Windows file integrity fixture",
        Duration::from_secs(15),
        REMOTE_PROJECT_FILE_MAX_BYTES,
        REMOTE_PROJECT_FILE_STDERR_BYTES,
        delivered,
    )
    .await
    .expect("local Windows fixture should execute")
}
