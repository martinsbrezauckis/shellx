use std::{env, fs, path::PathBuf};

use base64::Engine as _;
use minisign_verify::{PublicKey, Signature};

fn required_arg(args: &[String], name: &str) -> Result<String, String> {
    args.windows(2)
        .find(|pair| pair[0] == name)
        .map(|pair| pair[1].clone())
        .ok_or_else(|| format!("missing required argument {name}"))
}

fn decode_base64_text(value: &str, label: &str) -> Result<String, String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(value.trim())
        .map_err(|error| format!("decode {label} base64 failed: {error}"))?;
    String::from_utf8(bytes).map_err(|error| format!("decode {label} UTF-8 failed: {error}"))
}

fn run() -> Result<(), String> {
    let args = env::args().skip(1).collect::<Vec<_>>();
    let artifact = PathBuf::from(required_arg(&args, "--artifact")?);
    let signature_path = PathBuf::from(required_arg(&args, "--signature")?);
    let configured_public_key = required_arg(&args, "--public-key")?;

    let artifact_bytes = fs::read(&artifact).map_err(|error| {
        format!(
            "read updater artifact {} failed: {error}",
            artifact.display()
        )
    })?;
    let encoded_signature = fs::read_to_string(&signature_path).map_err(|error| {
        format!(
            "read updater signature {} failed: {error}",
            signature_path.display()
        )
    })?;
    let public_key_text = decode_base64_text(&configured_public_key, "configured updater key")?;
    let signature_text = decode_base64_text(&encoded_signature, "updater signature")?;
    let public_key = PublicKey::decode(&public_key_text)
        .map_err(|error| format!("parse configured updater public key failed: {error}"))?;
    let signature = Signature::decode(&signature_text)
        .map_err(|error| format!("parse updater signature failed: {error}"))?;
    public_key
        .verify(&artifact_bytes, &signature, true)
        .map_err(|error| format!("updater signature verification failed: {error}"))?;
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
