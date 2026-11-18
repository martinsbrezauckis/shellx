//! Regression coverage for the renderer-side credential denylist.
//! Anchored to the shared `reject_if_sensitive_path`
//! helper so both `read_text_file_for_path` and
//! `read_image_as_data_url` inherit the same matrix.
use super::*;

#[test]
fn rejects_auth_json_under_grok() {
    let r = reject_if_sensitive_path("/home/x/.grok/auth.json", "/home/x/.grok/auth.json");
    assert!(r.is_err(), "auth.json must be rejected");
}

#[test]
fn rejects_grok_config_toml() {
    let r = reject_if_sensitive_path("/home/x/.grok/config.toml", "/home/x/.grok/config.toml");
    assert!(r.is_err(), "grok config.toml must be rejected");
}

#[test]
fn rejects_vault_files() {
    for name in ["vault.enc", "vault.salt", "vault.master.key"] {
        let p = format!("/home/x/.shellx/{name}");
        assert!(
            reject_if_sensitive_path(&p, &p).is_err(),
            "{name} must be rejected"
        );
    }
}

#[test]
fn rejects_tokens_and_ssh_keys() {
    for p in [
        "/home/x/.shellx/shellxagent.token",
        "/home/x/.shellx/mcp.token",
        "/home/x/.ssh/id_ed25519",
        "/home/x/.aws/credentials",
        "/home/x/.password-store/foo.gpg",
        "/home/x/.gnupg/private-keys-v1.d/abc.key",
        "/home/x/.netrc",
        "/home/x/.pgpass",
    ] {
        assert!(
            reject_if_sensitive_path(p, p).is_err(),
            "must reject sensitive path: {p}"
        );
    }
}

#[tokio::test]
async fn attach_text_classifier_rejects_sensitive_paths_before_reading() {
    let path = if cfg!(target_os = "windows") {
        r"C:\Users\x\.ssh\id_ed25519"
    } else {
        "/home/x/.ssh/id_ed25519"
    };
    let err = read_text_file_if_text(path.to_string(), Some(64))
        .await
        .expect_err("sensitive attach path must be rejected");
    assert!(
        err.contains("known credential/token file"),
        "should reject by sensitive-path policy, got: {err}"
    );
}

#[test]
fn accepts_ordinary_image_under_grok() {
    let p = "/home/x/.grok/sessions/abc/images/1.jpg";
    assert!(
        reject_if_sensitive_path(p, p).is_ok(),
        "ordinary grok-generated image must pass"
    );
}

#[test]
fn accepts_user_doc_under_cwd() {
    let p = "/home/x/projects/foo/notes.md";
    assert!(
        reject_if_sensitive_path(p, p).is_ok(),
        "ordinary user doc must pass"
    );
}

#[test]
fn case_insensitive_match() {
    // Path components may arrive uppercased after UNC-prefix
    // lowercasing in the caller; the helper itself must still
    // catch sensitive names regardless of input case.
    let p = "/Home/X/.SHELLX/VAULT.ENC";
    assert!(
        reject_if_sensitive_path(p, p).is_err(),
        "case-insensitive match required"
    );
}

#[test]
fn pasted_attachment_filename_is_sanitized() {
    let name = sanitize_attachment_filename("..\\evil:image?.png", Some("image/png"), 42);
    assert_eq!(name, "attachment-42.png");
    let name = sanitize_attachment_filename("screen:shot?.png", Some("image/png"), 42);
    assert_eq!(name, "screen_shot_.png");
}

#[test]
fn pasted_attachment_decodes_data_url_and_checks_image_magic() {
    use base64::Engine as _;
    let png = b"\x89PNG\r\n\x1a\nrest";
    let b64 = base64::engine::general_purpose::STANDARD.encode(png);
    let decoded = decode_attachment_base64(&format!("data:image/png;base64,{b64}"))
        .expect("data URL decodes");
    assert_eq!(decoded, png);
    assert!(validate_declared_image_bytes(Some("image/png"), &decoded).is_ok());
    assert!(
        validate_declared_image_bytes(Some("image/png"), b"not really png").is_err(),
        "declared PNG must match PNG magic"
    );
}
