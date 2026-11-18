use super::*;

#[test]
fn bounded_http_body_accepts_bytes_at_the_limit() {
    let mut body = b"abc".to_vec();
    append_bounded_chunk(&mut body, b"def", 6, "fixture").unwrap();
    assert_eq!(body, b"abcdef");
}

#[test]
fn bounded_http_body_rejects_chunked_overflow_before_append() {
    let mut body = b"abc".to_vec();
    let error = append_bounded_chunk(&mut body, b"defg", 6, "fixture").unwrap_err();
    assert!(error.contains("6-byte response cap"));
    assert_eq!(body, b"abc");
}
