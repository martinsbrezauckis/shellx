//! Password generation — ONE implementation shared by every surface
//! (web via vault-wasm, desktop/shellX via tauri-plugin-vault, future
//! CLI). Rejection-sampled over the OS RNG: uniform over the alphabet,
//! no modulo bias.
//!
//! Lifted from vault-wasm (R2.6) verbatim in R3.4 when the desktop
//! editor needed it host-side; the wasm export now wraps this.

/// Generate a random password. `length` clamps to 8..=128. Lowercase is
/// always included; `upper`/`digits`/`symbols` extend the alphabet.
pub fn generate_password(length: usize, upper: bool, digits: bool, symbols: bool) -> String {
    let mut alphabet: Vec<u8> = (b'a'..=b'z').collect();
    if upper {
        alphabet.extend(b'A'..=b'Z');
    }
    if digits {
        alphabet.extend(b'0'..=b'9');
    }
    if symbols {
        alphabet.extend_from_slice(b"!@#$%^&*()-_=+[]{}:,.?/");
    }
    let len = length.clamp(8, 128);
    let mut out = String::with_capacity(len);
    // Rejection sampling: draw bytes, keep those below the largest
    // multiple of alphabet.len() — uniform over the alphabet.
    let cap = (256 / alphabet.len()) * alphabet.len();
    while out.len() < len {
        let buf: [u8; 32] = crate::keys::random_bytes();
        for b in buf {
            if (b as usize) < cap && out.len() < len {
                out.push(alphabet[b as usize % alphabet.len()] as char);
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn respects_length_and_classes() {
        let p = generate_password(24, true, true, true);
        assert_eq!(p.len(), 24);
        let p2 = generate_password(24, false, false, false);
        assert!(p2.bytes().all(|b| b.is_ascii_lowercase()));
        // Clamping.
        assert_eq!(generate_password(2, false, false, false).len(), 8);
        assert_eq!(generate_password(9999, false, false, false).len(), 128);
    }

    #[test]
    fn two_draws_differ() {
        assert_ne!(
            generate_password(32, true, true, true),
            generate_password(32, true, true, true)
        );
    }
}
