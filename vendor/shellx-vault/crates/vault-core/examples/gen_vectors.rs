//! Emit cross-implementation test vectors as JSON on stdout: a real
//! keyfile (DEFAULT KDF params — the browser must handle production
//! Argon2id cost), a sealed manifest, and a sealed chunk. The browser
//! test (web/e2e) unlocks and decrypts these with vault-wasm and compares
//! byte-for-byte — proving CLI and WASM speak the identical format.
//!
//! Usage: cargo run -q --example gen_vectors -p vault-core

use vault_core::{chunk_enc_key, chunk_id, crypto, ChunkRef, FileEntry, Keyfile, Snapshot};

fn main() {
    let passphrase = "browser-vector-passphrase";
    let (master, keyfile) = Keyfile::create(passphrase, Default::default()).expect("keyfile");

    let plaintext =
        b"cross-implementation vector: CLI sealed this, the browser must open it".to_vec();
    let id = chunk_id(&master.chunk_id_key(), &plaintext);
    let sealed_chunk = crypto::seal(
        &chunk_enc_key(&master.chunk_enc_root(), &id),
        id.to_hex().as_bytes(),
        &plaintext,
    );

    let snapshot = Snapshot::new(
        None,
        "vector-device",
        1_780_000_000_000,
        vec![FileEntry {
            path: "docs/vector.txt".into(),
            executable: false,
            mtime_ns: 1_780_000_000_000_000_000,
            size: plaintext.len() as u64,
            chunks: vec![ChunkRef {
                id,
                size: plaintext.len() as u32,
            }],
        }],
    );
    let sealed_manifest = snapshot.seal(&master);

    println!(
        "{}",
        serde_json::json!({
            "passphrase": passphrase,
            "keyfile": keyfile,
            "chunk_id": id.to_hex(),
            "sealed_chunk_hex": hex::encode(&sealed_chunk),
            "plaintext_hex": hex::encode(&plaintext),
            "sealed_manifest_hex": hex::encode(&sealed_manifest),
            "expected_path": "docs/vector.txt",
        })
    );
}
