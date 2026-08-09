use serde_json::{json, Value};

use super::{is_write_class_tool, tool_specs};

fn host_gateway_actions(write_class: bool) -> Vec<String> {
    let mut actions = tool_specs()
        .into_iter()
        .filter_map(|spec| spec.get("name").and_then(Value::as_str).map(str::to_string))
        .filter(|name| {
            !name.starts_with("browser_")
                && !matches!(
                    name.as_str(),
                    "capabilities_summary" | "search_tool" | "host_read" | "host_act"
                )
                && is_write_class_tool(name) == write_class
        })
        .collect::<Vec<_>>();
    actions.sort();
    actions.dedup();
    actions
}

/// Compact non-Browser Host surface advertised in MCP `tools/list`.
///
/// Exact legacy schemas remain available through `search_tool`, while the
/// gateway action enum guarantees that every hidden handler remains reachable
/// without injecting dozens of full schemas into every provider prompt.
pub(super) fn host_entry_tool_specs() -> Vec<Value> {
    let read_actions = host_gateway_actions(false);
    let act_actions = host_gateway_actions(true);
    vec![
        json!({
            "name": "host_read",
            "description": "Read ShellX host state through one compact entry point. Call capabilities_summary for orientation, then search_tool query=<action> for the exact legacy schema and pass those fields inside params. Host filesystem actions operate on the ShellX parent host, not automatically on a WSL/SSH provider target.",
            "inputSchema": {
                "type": "object",
                "additionalProperties": false,
                "properties": {
                    "action": { "type": "string", "enum": read_actions },
                    "params": { "type": "object", "description": "Arguments matching the exact schema returned by search_tool for this action.", "additionalProperties": true }
                },
                "required": ["action"]
            }
        }),
        json!({
            "name": "host_act",
            "description": "Run a permission-gated ShellX host mutation or external side effect through one compact entry point. Call search_tool query=<action> for the exact legacy schema and pass those fields inside params. The active ShellX tab autonomy gate is enforced before dispatch; Browser mutations stay on browser_act.",
            "inputSchema": {
                "type": "object",
                "additionalProperties": false,
                "properties": {
                    "action": { "type": "string", "enum": act_actions },
                    "params": { "type": "object", "description": "Arguments matching the exact schema returned by search_tool for this action.", "additionalProperties": true }
                },
                "required": ["action"]
            }
        }),
    ]
}

pub(super) fn route_host_entry(
    entry_name: &str,
    arguments: Value,
) -> Result<(String, Value), String> {
    let expected_write_class = match entry_name {
        "host_read" => false,
        "host_act" => true,
        _ => return Ok((entry_name.to_string(), arguments)),
    };
    let map = arguments
        .as_object()
        .ok_or_else(|| format!("{entry_name} arguments must be an object"))?;
    let action = map
        .get("action")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("{entry_name} requires action"))?;
    if action.starts_with("browser_") || matches!(action, "browser_read" | "browser_act") {
        return Err(format!(
            "{entry_name} does not route Browser tools; use browser_read or browser_act"
        ));
    }
    if matches!(action, "host_read" | "host_act") {
        return Err(format!(
            "{entry_name} cannot recursively route a Host gateway"
        ));
    }
    let known = tool_specs()
        .iter()
        .any(|spec| spec.get("name").and_then(Value::as_str) == Some(action));
    if !known {
        return Err(format!(
            "unsupported {entry_name} action '{action}'; use search_tool for exact action names"
        ));
    }
    let actual_write_class = is_write_class_tool(action);
    if actual_write_class != expected_write_class {
        let correct_gateway = if actual_write_class {
            "host_act"
        } else {
            "host_read"
        };
        return Err(format!(
            "action '{action}' is routed through {correct_gateway}, not {entry_name}"
        ));
    }
    let params = match map.get("params") {
        Some(Value::Object(params)) => Value::Object(params.clone()),
        Some(_) => return Err(format!("{entry_name}.params must be an object")),
        None => Value::Object(Default::default()),
    };
    Ok((action.to_string(), params))
}

#[cfg(test)]
mod tests {
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
}
