use super::*;

#[test]
fn host_gateway_routes_read_and_write_classes_without_browser_overlap() {
    let (read_name, read_args) = route_host_entry(
        "host_read",
        json!({"action": "fs_stat", "params": {"path": "/tmp/example"}}),
    )
    .expect("read route");
    assert_eq!(read_name, "fs_stat");
    assert_eq!(read_args["path"], "/tmp/example");

    let (act_name, act_args) = route_host_entry(
        "host_act",
        json!({"action": "fs_write", "params": {"path": "/tmp/example", "content": "ok"}}),
    )
    .expect("write route");
    assert_eq!(act_name, "fs_write");
    assert_eq!(act_args["content"], "ok");

    assert!(route_host_entry("host_read", json!({"action": "fs_write"}))
        .unwrap_err()
        .contains("host_act"));
    assert!(route_host_entry("host_act", json!({"action": "fs_stat"}))
        .unwrap_err()
        .contains("host_read"));
    assert!(
        route_host_entry("host_read", json!({"action": "browser_state"}))
            .unwrap_err()
            .contains("browser_read")
    );
    assert!(route_host_entry("host_act", json!({"action": "cut_act"}))
        .unwrap_err()
        .contains("cut_read"));
}

#[test]
fn host_gateway_action_enums_cover_every_hidden_non_browser_tool_once() {
    let specs = host_entry_tool_specs();
    let read = specs[0]["inputSchema"]["properties"]["action"]["enum"]
        .as_array()
        .expect("read enum");
    let act = specs[1]["inputSchema"]["properties"]["action"]["enum"]
        .as_array()
        .expect("act enum");
    for spec in tool_specs() {
        let name = spec["name"].as_str().expect("tool name");
        if name.starts_with("browser_")
            || name.starts_with("cut_")
            || matches!(name, "capabilities_summary" | "search_tool")
        {
            continue;
        }
        let count = read
            .iter()
            .chain(act.iter())
            .filter(|item| item.as_str() == Some(name))
            .count();
        assert_eq!(count, 1, "{name} must appear in exactly one Host gateway");
        assert_eq!(
            act.iter().any(|item| item.as_str() == Some(name)),
            is_write_class_tool(name),
            "{name} gateway class must match the permission table"
        );
    }
}
