use super::super::*;

#[test]
fn host_pattern_matching() {
    // Exact match.
    assert!(host_matches_pattern("github.com", "github.com"));
    assert!(!host_matches_pattern("notgithub.com", "github.com"));
    // Glob match.
    assert!(host_matches_pattern(
        "raw.githubusercontent.com",
        "*.githubusercontent.com"
    ));
    assert!(host_matches_pattern(
        "deep.nested.githubusercontent.com",
        "*.githubusercontent.com"
    ));
    // Bare domain must NOT match the glob.
    assert!(!host_matches_pattern(
        "githubusercontent.com",
        "*.githubusercontent.com"
    ));
    // Case insensitivity.
    assert!(host_matches_pattern("GitHub.com", "github.com"));
}

#[test]
fn net_fetch_rejects_restricted_ip_literals_even_when_allow_listed() {
    let allow = NetAllow {
        hosts: vec![
            "169.254.169.254".to_string(),
            "10.0.0.1".to_string(),
            "100.64.0.1".to_string(),
            "100.127.255.254".to_string(),
        ],
    };

    for url in [
        "http://169.254.169.254/latest/meta-data",
        "http://10.0.0.1/admin",
        "http://100.64.0.1/mesh",
        "http://100.127.255.254/mesh",
    ] {
        let parsed = reqwest::Url::parse(url).expect("valid test url");
        let err = host_is_allowed(&parsed, &allow).expect_err("restricted ip must fail");
        assert!(
            err.contains("restricted IP"),
            "unexpected rejection for {}: {}",
            url,
            err
        );
    }
}

#[test]
fn media_mime_helpers_reject_unknown_extensions() {
    assert!(audio_mime_for_path("voice_stt_v2", std::path::Path::new("/tmp/a.env")).is_err());
    assert!(image_mime_for_path(
        "vision_describe_v2",
        std::path::Path::new("/tmp/a.env"),
        false
    )
    .is_err());
    assert_eq!(
        audio_mime_for_path("voice_stt_v2", std::path::Path::new("/tmp/a.webm")).unwrap(),
        "audio/webm"
    );
    assert_eq!(
        image_mime_for_path(
            "vision_describe_v2",
            std::path::Path::new("/tmp/a.png"),
            false
        )
        .unwrap(),
        "image/png"
    );
}

#[test]
fn media_magic_helpers_reject_extension_spoofing() {
    assert!(validate_image_magic("vision_describe_v2", "image/png", b"not an image").is_err());
    assert!(validate_audio_magic("voice_stt_v2", "audio/webm", b"not audio").is_err());
    assert!(
        validate_image_magic("vision_describe_v2", "image/png", b"\x89PNG\r\n\x1a\nrest").is_ok()
    );
    assert!(validate_audio_magic(
        "voice_stt_v2",
        "audio/webm",
        &[0x1a, 0x45, 0xdf, 0xa3, 0x00]
    )
    .is_ok());
}

#[test]
fn vision_remote_media_scope_accepts_generated_and_session_paths_only() {
    assert!(validate_vision_remote_media_path(
        "vision_describe",
        "/home/user/project/mountain_lake_sunrise.png",
        Some("/home/user/project"),
    )
    .is_ok());
    assert!(validate_vision_remote_media_path(
        "vision_describe",
        "/home/user/.codex/generated_images/run/ig_123.png",
        Some("/home/user/project"),
    )
    .is_ok());
    assert!(validate_vision_remote_media_path(
        "vision_describe",
        "/home/user/.grok/sessions/%2Fhome%2Fuser%2Fproject/sid/images/1.jpg",
        Some("/home/user/project"),
    )
    .is_ok());
    assert!(validate_vision_remote_media_path(
        "vision_describe",
        "/home/user/.shellx/assets/run/preview.png",
        Some("/home/user/project"),
    )
    .is_ok());
    assert!(validate_vision_remote_media_path(
        "vision_describe",
        "/etc/passwd.png",
        Some("/home/user/project"),
    )
    .is_err());
    assert!(validate_vision_remote_media_path(
        "vision_describe",
        "/home/user/project/../.ssh/id_rsa.png",
        Some("/home/user/project"),
    )
    .is_err());
    assert!(validate_vision_remote_media_path(
        "vision_describe",
        "~/.grok/sessions/sid/images/1.jpg",
        Some("/home/user/project"),
    )
    .is_err());
    assert!(validate_vision_remote_media_path(
        "vision_describe",
        "/home/user/.ssh/id_ed25519.png",
        Some("/home/user"),
    )
    .is_err());
    assert!(validate_vision_remote_media_path(
        "vision_describe",
        "/home/user/.codex/generated_images/run/.ssh/id_ed25519.png",
        Some("/home/user/project"),
    )
    .is_err());
}

#[test]
fn vision_remote_media_scope_accepts_native_windows_paths_case_insensitively() {
    let runtime = crate::acp::SshRemoteRuntime::Windows;
    assert!(validate_vision_remote_media_path_for_runtime(
        "vision_describe",
        r"C:\Users\Fixture\Project\capture.png",
        Some(r"c:\users\fixture\project"),
        runtime,
    )
    .is_ok());
    assert!(validate_vision_remote_media_path_for_runtime(
        "vision_describe",
        r"C:\Users\Fixture\.codex\generated_images\run\capture.png",
        Some(r"C:\Users\Fixture\Project"),
        runtime,
    )
    .is_ok());
    assert!(validate_vision_remote_media_path_for_runtime(
        "vision_describe",
        r"C:\Windows\Temp\capture.png",
        Some(r"C:\Users\Fixture\Project"),
        runtime,
    )
    .is_err());
    assert!(validate_vision_remote_media_path_for_runtime(
        "vision_describe",
        r"C:\Users\Fixture\Project\..\.ssh\id_rsa.png",
        Some(r"C:\Users\Fixture\Project"),
        runtime,
    )
    .is_err());
}

#[tokio::test]
#[ignore = "requires SHELLX_WINDOWS_SSH_HOST and SHELLX_WINDOWS_SSH_HOME"]
async fn live_native_windows_ssh_vision_read() {
    let host = std::env::var("SHELLX_WINDOWS_SSH_HOST")
        .expect("SHELLX_WINDOWS_SSH_HOST must name a test Windows endpoint");
    let home = std::env::var("SHELLX_WINDOWS_SSH_HOME")
        .expect("SHELLX_WINDOWS_SSH_HOME must be an absolute Windows user profile");
    let path = format!(
        r"{}\shellx-vision-live-{}.gif",
        home.trim_end_matches('\\'),
        std::process::id()
    );
    let ssh = crate::acp::SshSpawnConfig {
        host,
        port: None,
        key_vault_ref: None,
        remote_grok_path: "grok".to_string(),
        remote_runtime: crate::acp::SshRemoteRuntime::Windows,
        wsl_distro: None,
    };
    crate::acp::ssh_write_file(&ssh, &path, "GIF89a\0\0\0\0")
        .await
        .expect("write remote vision fixture");

    let context = VisionSshContext {
        ssh: ssh.clone(),
        cwd: Some(home.clone()),
    };
    let result = read_vision_image_data_url_from_ssh(&path, &context).await;
    let path_q = crate::acp::powershell_single_quote(&path);
    let _ = vision_ssh_run(
        &ssh,
        format!("if(Test-Path -LiteralPath {path_q}){{Remove-Item -LiteralPath {path_q} -Force}}"),
        "cleanup",
    )
    .await;

    let data = result.expect("read native Windows vision fixture");
    assert!(data.starts_with("data:image/gif;base64,"));
}

#[test]
fn media_read_cap_rejects_before_large_read() {
    let path = std::env::temp_dir().join(format!(
        "shellx-media-cap-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    ));
    let file = std::fs::File::create(&path).expect("create temp media");
    file.set_len(32).expect("grow sparse temp media");
    drop(file);

    let err = read_file_with_cap_sync("vision_describe_v2", &path, 16).unwrap_err();
    assert!(err.contains("file too large"), "unexpected error: {}", err);
    let _ = std::fs::remove_file(path);
}

// ─── #381 M6 — bounded stdio reader ───

/// `read_bounded_line` must:
/// 1. accept lines ≤ cap unchanged,
/// 2. drop a line longer than the cap WITHOUT exhausting heap
/// beyond ~cap, and
/// 3. resync to the next newline so the subsequent valid line is
/// still surfaced — i.e. one bad payload does not poison the
/// whole stream.
/// This test pipes `2 * STDIO_MAX_LINE_BYTES` of garbage as the
/// first line, then a normal JSON-RPC line as the second, and
/// asserts only the normal line is returned.
/// /// Note: we don't drive `run_stdio` directly because that owns
/// `tokio::io::stdin`. Testing the helper covers the same code
/// path — `run_stdio`'s loop is a thin wrapper over it.
#[tokio::test(flavor = "current_thread")]
async fn read_bounded_line_drops_overflow_then_resyncs() {
    // Construct: [overflow-line]\n[good-line]\n
    // Overflow line: `2 * MAX` bytes of 'A', terminated by '\n'.
    // The reader should detect overflow at byte MAX, drain to the
    // first '\n', then surface the good line.
    // // For test runtime / memory, use a SHRUNK cap by composing the
    // helper against a small-cap variant? No — `read_bounded_line`
    // reads the module constant. Allocating ~64 MiB once in a test
    // is acceptable on dev hardware. We use Vec::with_capacity to
    // avoid mid-build reallocs.
    let overflow_size = 2 * STDIO_MAX_LINE_BYTES;
    let mut input: Vec<u8> = Vec::with_capacity(overflow_size + 64);
    input.resize(overflow_size, b'A');
    input.push(b'\n');
    let good = br#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#;
    input.extend_from_slice(good);
    input.push(b'\n');

    // `&[u8]` impls AsyncBufRead via futures-cursor in tokio, but
    // we wrap in BufReader to mirror the production reader shape.
    let cursor = std::io::Cursor::new(input);
    let mut reader = BufReader::with_capacity(64 * 1024, cursor);

    // First read: overflow path.
    let first = read_bounded_line(&mut reader).await.expect("io ok");
    assert!(
        matches!(first, BoundedLine::Overflow),
        "expected Overflow, got {:?}",
        first
    );

    // Second read: the good line is intact.
    let second = read_bounded_line(&mut reader).await.expect("io ok");
    match second {
        BoundedLine::Line(bytes) => {
            let s = std::str::from_utf8(&bytes).expect("utf8");
            // Parse as JSON to confirm framing survived the resync.
            let v: Value = serde_json::from_str(s)
                .expect("good line must parse as json after overflow resync");
            assert_eq!(v.get("method").and_then(|m| m.as_str()), Some("ping"));
        }
        other => panic!("expected Line after overflow, got {:?}", other),
    }

    // Third read: EOF.
    let third = read_bounded_line(&mut reader).await.expect("io ok");
    assert!(
        matches!(third, BoundedLine::Eof),
        "expected Eof, got {:?}",
        third
    );
}

/// Sanity: a single normal line round-trips without the newline.
#[tokio::test]
async fn read_bounded_line_strips_terminators() {
    let cursor = std::io::Cursor::new(b"hello\r\nworld\n".to_vec());
    let mut reader = BufReader::with_capacity(64, cursor);

    let a = read_bounded_line(&mut reader).await.unwrap();
    assert!(matches!(&a, BoundedLine::Line(b) if b == b"hello"));
    let b = read_bounded_line(&mut reader).await.unwrap();
    assert!(matches!(&b, BoundedLine::Line(bs) if bs == b"world"));
    let c = read_bounded_line(&mut reader).await.unwrap();
    assert!(matches!(c, BoundedLine::Eof));
}
