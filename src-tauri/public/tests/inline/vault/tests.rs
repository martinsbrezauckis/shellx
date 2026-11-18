use super::*;

fn temp_vault_path(name: &str) -> (tempfile::TempDir, PathBuf) {
    let dir = tempfile::Builder::new()
        .prefix(&format!("shellx-vault-{name}-"))
        .tempdir()
        .expect("create isolated Vault directory");
    let path = dir.path().join("vault.enc");
    (dir, path)
}

fn test_cipher() -> ChaCha20Poly1305 {
    let mut key = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut key);
    ChaCha20Poly1305::new(ChaChaKey::from_slice(&key))
}

fn write_test_envelope(
    path: &Path,
    cipher: &ChaCha20Poly1305,
    state: &Plaintext,
) -> Result<(), String> {
    let env = encrypt_envelope(cipher, state)?;
    let body = serde_json::to_string_pretty(&env)
        .map_err(|e| format!("test envelope serialize failed: {}", e))?;
    std::fs::write(path, body)
        .map_err(|e| format!("test envelope write {} failed: {}", path.display(), e))
}

fn vault_for_test(path: PathBuf, cipher: ChaCha20Poly1305, _state: Plaintext) -> Vault {
    Vault {
        cipher,
        io_lock: Mutex::new(()),
        path,
    }
}

#[tokio::test]
async fn get_reads_latest_envelope_instead_of_cached_plaintext() {
    let (_temp_dir, path) = temp_vault_path("latest-envelope");
    let cipher = test_cipher();
    let mut initial = Plaintext::new();
    initial.insert("service/token".to_string(), "old".to_string());
    write_test_envelope(&path, &cipher, &initial).unwrap();
    let vault = vault_for_test(path.clone(), cipher, initial);

    let mut updated = Plaintext::new();
    updated.insert("service/token".to_string(), "new".to_string());
    write_test_envelope(&path, &vault.cipher, &updated).unwrap();

    let value = vault.get("service/token").await.unwrap();
    assert_eq!(value.as_deref(), Some("new"));
}

#[test]
fn persist_helper_zeroizes_plaintext_after_error() {
    let mut state = Plaintext::new();
    state.insert("service/token".to_string(), "secret-value".to_string());

    let err = persist_plaintext_then_zeroize(&mut state, |_| -> Result<(), String> {
        Err("persist failed".to_string())
    })
    .expect_err("persist error should propagate");

    assert_eq!(err, "persist failed");
    assert!(
        state.values().all(|value| value.is_empty()),
        "plaintext values must be zeroized even when persist fails"
    );
}

#[test]
fn validate_key_accepts_namespaced() {
    assert!(validate_key("user.openai_api_key").is_ok());
    assert!(validate_key("connections.prod.ssh_key_path").is_ok());
    assert!(validate_key("a/b/c-d_e.f").is_ok());
}

#[test]
fn validate_key_rejects_traversal() {
    assert!(validate_key("../etc/passwd").is_err());
    assert!(validate_key("a/../b").is_err());
    assert!(validate_key("/abs").is_err());
    assert!(validate_key("").is_err());
    assert!(validate_key(".hidden").is_err());
    assert!(validate_key("a b").is_err());
    assert!(validate_key("a;b").is_err());
    assert!(validate_key("a$b").is_err());
    assert!(validate_key("a//b").is_err());
}

#[test]
fn validate_key_rejects_oversized() {
    let huge = "a".repeat(257);
    assert!(validate_key(&huge).is_err());
}

/// Round-trip a small map through encrypt/decrypt with a fresh
/// ChaCha20 instance — confirms the wire format is self-consistent
/// without touching the OS keyring.
#[test]
fn envelope_roundtrip() {
    let mut key = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut key);
    let cipher = ChaCha20Poly1305::new(ChaChaKey::from_slice(&key));

    let mut state = Plaintext::new();
    state.insert("user.openai_api_key".to_string(), "sk-test".to_string());
    // RFC 5737 TEST-NET-1 — never routable, safe in public test fixtures.
    state.insert(
        "connections.example.host".to_string(),
        "192.0.2.42".to_string(),
    );

    let env = encrypt_envelope(&cipher, &state).expect("encrypt ok");
    assert_eq!(env.version, VAULT_VERSION);
    assert_eq!(env.cipher, "chacha20poly1305");
    assert!(!env.nonce.is_empty());
    assert!(!env.ciphertext.is_empty());

    let back = decrypt_envelope(&cipher, &env).expect("decrypt ok");
    assert_eq!(back, state);
}

/// Wrong-key path must fail decrypt — confirms AEAD authentication.
#[test]
fn envelope_rejects_wrong_key() {
    let mut k1 = [0u8; 32];
    let mut k2 = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut k1);
    rand::rngs::OsRng.fill_bytes(&mut k2);
    let c1 = ChaCha20Poly1305::new(ChaChaKey::from_slice(&k1));
    let c2 = ChaCha20Poly1305::new(ChaChaKey::from_slice(&k2));

    let mut state = Plaintext::new();
    state.insert("x".to_string(), "y".to_string());

    let env = encrypt_envelope(&c1, &state).expect("encrypt ok");
    let r = decrypt_envelope(&c2, &env);
    assert!(r.is_err(), "decrypt under wrong key must fail");
}

/// Empty-map round-trip — important because the first open of a
/// fresh vault writes an empty plaintext.
#[test]
fn envelope_empty_roundtrip() {
    let mut key = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut key);
    let cipher = ChaCha20Poly1305::new(ChaChaKey::from_slice(&key));
    let state = Plaintext::new();
    let env = encrypt_envelope(&cipher, &state).expect("encrypt ok");
    let back = decrypt_envelope(&cipher, &env).expect("decrypt ok");
    assert_eq!(back.len(), 0);
}
