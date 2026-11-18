use super::*;

#[tokio::test]
async fn bounded_stream_capture_preserves_small_output_exactly() {
    let capture = drain_stream_tail_bounded(&b"small output"[..], 64)
        .await
        .expect("capture small output");
    assert_eq!(capture.into_lossy_string(), "small output");
}

#[tokio::test]
async fn bounded_stream_capture_drains_and_keeps_the_tail() {
    let input = b"0123456789abcdef";
    let capture = drain_stream_tail_bounded(&input[..], 6)
        .await
        .expect("capture bounded output");
    let text = capture.into_lossy_string();
    assert!(text.starts_with("abcdef\n"));
    assert!(text.contains("16 bytes total; last 6 bytes retained"));
}

#[tokio::test]
async fn bounded_stream_capture_is_valid_text_after_utf8_boundary_cut() {
    let input = "start-🙂-finish".as_bytes();
    let capture = drain_stream_tail_bounded(input, 9)
        .await
        .expect("capture UTF-8 output");
    let text = capture.into_lossy_string();
    assert!(text.ends_with("last 9 bytes retained]"));
    assert!(!text.is_empty());
}

#[tokio::test]
async fn bounded_stream_capture_drains_large_input_and_keeps_exact_tail() {
    let input = (0..(320 * 1024))
        .map(|index| (index % 251) as u8)
        .collect::<Vec<_>>();
    let cap = 32 * 1024;
    let capture = drain_stream_tail_bounded(&input[..], cap)
        .await
        .expect("capture large output");

    assert_eq!(capture.total_bytes, input.len() as u64);
    assert_eq!(capture.bytes, input[input.len() - cap..]);
}
