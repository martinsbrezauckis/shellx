use super::*;

#[test]
fn complete_jsonl_prefix_len_leaves_partial_line_for_next_poll() {
    let buf = b"{\"ok\":true}\n{\"partial\":";
    assert_eq!(complete_jsonl_prefix_len(buf), b"{\"ok\":true}\n".len());
}

#[test]
fn complete_jsonl_prefix_len_leaves_partial_utf8_for_next_poll() {
    let mut buf = b"{\"ok\":true}\n{\"text\":\"".to_vec();
    buf.push(0xE2);
    buf.push(0x82);
    assert_eq!(complete_jsonl_prefix_len(&buf), b"{\"ok\":true}\n".len());
}
