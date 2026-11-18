use super::*;
use std::io::Write;

fn write_tmp(name: &str, bytes: &[u8]) -> std::path::PathBuf {
    let dir = std::env::temp_dir();
    let path = dir.join(format!("grok-shell-sniff-{}", name));
    let mut f = std::fs::File::create(&path).expect("tmp create");
    f.write_all(bytes).expect("tmp write");
    path
}

#[test]
fn whitelisted_extension_inlines_text() {
    let p = write_tmp("a.md", b"# Hello\n");
    let r = classify_file(&p, 64 * 1024).unwrap();
    match r {
        TextSniffResult::Text { content } => assert_eq!(content, "# Hello\n"),
        TextSniffResult::Binary => panic!("expected Text"),
    }
    std::fs::remove_file(&p).ok();
}

#[test]
fn binary_with_text_extension_falls_back_to_binary() {
    // Pretend a binary blob was renamed to .json.
    let p = write_tmp(
        "a.json",
        &[0xFFu8, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46],
    );
    let r = classify_file(&p, 64 * 1024).unwrap();
    matches!(r, TextSniffResult::Binary)
        .then_some(())
        .expect("expected Binary");
    std::fs::remove_file(&p).ok();
}

#[test]
fn oversize_returns_binary_without_reading() {
    let big: Vec<u8> = vec![b'a'; 200 * 1024];
    let p = write_tmp("big.txt", &big);
    let r = classify_file(&p, 64 * 1024).unwrap();
    matches!(r, TextSniffResult::Binary)
        .then_some(())
        .expect("expected Binary");
    std::fs::remove_file(&p).ok();
}

#[test]
fn unknown_extension_inlines_when_plausible() {
    // No extension, but plain ASCII text.
    let p = write_tmp("README", b"this is a readme file\nwith two lines\n");
    let r = classify_file(&p, 64 * 1024).unwrap();
    matches!(r, TextSniffResult::Text { .. })
        .then_some(())
        .expect("expected Text");
    std::fs::remove_file(&p).ok();
}

#[test]
fn unknown_extension_rejects_binary_blob() {
    // PE header bytes + lots of zeros.
    let mut bytes = vec![b'M', b'Z'];
    bytes.extend(std::iter::repeat_n(0u8, 200));
    let p = write_tmp("blob.dat", &bytes);
    let r = classify_file(&p, 64 * 1024).unwrap();
    matches!(r, TextSniffResult::Binary)
        .then_some(())
        .expect("expected Binary");
    std::fs::remove_file(&p).ok();
}

#[test]
fn dotfile_known_name_inlines() {
    let p = write_tmp(".gitignore", b"node_modules\n");
    let r = classify_file(&p, 64 * 1024).unwrap();
    matches!(r, TextSniffResult::Text { .. })
        .then_some(())
        .expect("expected Text");
    std::fs::remove_file(&p).ok();
}

#[test]
fn empty_file_is_text() {
    let p = write_tmp("empty.txt", b"");
    let r = classify_file(&p, 64 * 1024).unwrap();
    match r {
        TextSniffResult::Text { content } => assert_eq!(content, ""),
        TextSniffResult::Binary => panic!("expected Text"),
    }
    std::fs::remove_file(&p).ok();
}
