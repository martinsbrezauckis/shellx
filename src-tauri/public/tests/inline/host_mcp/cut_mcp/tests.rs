use super::*;

#[test]
fn advertised_cut_gateway_stays_compact_and_does_not_inline_verbs() {
    let specs = cut_entry_tool_specs();
    assert_eq!(specs.len(), 2);
    assert_eq!(specs[0]["name"], "cut_read");
    assert_eq!(specs[1]["name"], "cut_act");
    let encoded = serde_json::to_vec(&specs).expect("serialize Cut entry specs");
    assert!(
        encoded.len() < 4_000,
        "Cut gateway grew to {} bytes",
        encoded.len()
    );
    assert!(!String::from_utf8_lossy(&encoded).contains("timeline_clip_split"));
}

#[test]
fn dotted_cut_verbs_normalize_without_accepting_shell_syntax() {
    assert_eq!(normalize_verb("project.state").unwrap(), "project_state");
    assert_eq!(
        normalize_verb("timeline_clip_split").unwrap(),
        "timeline_clip_split"
    );
    assert!(normalize_verb("project.state;whoami").is_err());
    assert!(normalize_verb("../cutd").is_err());
}

#[test]
fn search_results_are_bounded_and_show_argument_names() {
    let mut sample = json!({
        "description": "Split one timeline clip at a frame.",
        "inputSchema": {
            "properties": { "clip_id": {"type":"string"}, "frame": {"type":"integer"} },
            "required": ["clip_id", "frame"]
        }
    });
    sample["name"] = json!("timeline_clip_split");
    let tools = vec![sample];
    let rows = search_tool_rows(&tools, "split", 1);
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["verb"], "timeline_clip_split");
    assert_eq!(rows[0]["arguments"].as_array().unwrap().len(), 2);
}

#[test]
fn cut_call_result_drops_duplicate_json_text_but_keeps_structured_output() {
    let result = compact_cut_call_result(
        json!({
            "content": [{"type":"text", "text":"{\"ok\":true,\"result\":{\"x\":1}}"}],
            "structuredContent": {"ok":true, "result":{"x":1}},
            "isError": false
        }),
        "project_state",
    );
    assert_eq!(result["structuredContent"]["ok"], true);
    assert!(result["content"][0]["text"]
        .as_str()
        .unwrap()
        .contains("project_state completed"));
}

#[tokio::test]
async fn bounded_stream_reader_rejects_oversized_output_before_buffering_it() {
    let bytes = vec![b'x'; 33];
    let mut input = bytes.as_slice();
    let error = read_bounded_stream(&mut input, 32, "test")
        .await
        .expect_err("oversized stream must fail closed");
    assert!(error.contains("exceeded the safe bridge limit of 32 bytes"));
}
