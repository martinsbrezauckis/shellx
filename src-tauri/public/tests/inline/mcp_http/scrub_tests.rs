use super::scrub_credentials;
use serde_json::json;

#[test]
fn redacts_bearer_under_non_sensitive_key() {
    let mut v = json!({"body": "Bearer 1234567890abcdef1234567890abcdef"});
    scrub_credentials(&mut v);
    assert_eq!(v["body"], "***REDACTED***");
}

#[test]
fn redacts_hex_token_in_free_field() {
    let mut v = json!({"note": "deadbeefcafebabe1234567890abcdef"});
    scrub_credentials(&mut v);
    assert_eq!(v["note"], "***REDACTED***");
}

#[test]
fn preserves_generated_media_path_output() {
    let path = "IMAGE_PATH=/home/user/.codex/generated_images/11111111-2222-4333-8444-555555555555/ig_111111111111111111111111111111111111111111111111.png";
    let mut v = json!({ "text": path });
    scrub_credentials(&mut v);
    assert_eq!(v["text"], path);
}

#[test]
fn preserves_absolute_media_path_output() {
    let path = "IMAGE_PATH=/home/user/example-image-output.png";
    let mut v = json!({ "text": path });
    scrub_credentials(&mut v);
    assert_eq!(v["text"], path);
}

#[test]
fn preserves_regular_filesystem_paths_for_debug_controls() {
    let posix = "/home/alice/example-mobile-app";
    let windows = "C:\\Users\\FixtureUser\\example-mobile-app";
    let mut v = json!({
        "patch": {
            "cwdPicker": {
                "path": posix,
            },
            "debugInput": {
                "value": windows,
            },
        },
        "tokenPath": posix,
    });

    scrub_credentials(&mut v);

    assert_eq!(v["patch"]["cwdPicker"]["path"], posix);
    assert_eq!(v["patch"]["debugInput"]["value"], windows);
    assert_eq!(v["tokenPath"], "***REDACTED***");
}

#[test]
fn preserves_opaque_routing_slugs_in_text() {
    let tab_id = "tab-fixture-provider-handoff-001";
    let run_id = "provider-session-11111111-2222-4333-8444-555555555555";
    let mut v = json!({ "text": [tab_id, run_id] });
    scrub_credentials(&mut v);
    assert_eq!(v["text"][0], tab_id);
    assert_eq!(v["text"][1], run_id);
}

#[test]
fn still_redacts_generated_media_path_under_sensitive_key() {
    let path = "/home/user/.codex/generated_images/11111111-2222-4333-8444-555555555555/ig_111111111111111111111111111111111111111111111111.png";
    let mut v = json!({ "token": path });
    scrub_credentials(&mut v);
    assert_eq!(v["token"], "***REDACTED***");
}

#[test]
fn redacts_common_vendor_prefixes_in_free_field() {
    let slack_like = ["xox", "b-123456789012-ABCDEFGHIJKLMNO"].concat();
    let mut v = json!({
        "slack": slack_like,
        "gitlab": "glpat-1234567890abcdef",
        "google": "AIzaSyB1234567890abcdef",
        "sendgrid": "SG.abcdefghi.1234567890abcdef",
    });
    scrub_credentials(&mut v);
    assert_eq!(v["slack"], "***REDACTED***");
    assert_eq!(v["gitlab"], "***REDACTED***");
    assert_eq!(v["google"], "***REDACTED***");
    assert_eq!(v["sendgrid"], "***REDACTED***");
}

#[test]
fn redacts_high_entropy_all_letter_token() {
    let mut v = json!({"note": "qwertyuiopasdfghjklzxcvbnm"});
    scrub_credentials(&mut v);
    assert_eq!(v["note"], "***REDACTED***");
}

#[test]
fn leaves_short_strings_alone() {
    let mut v = json!({"note": "hello world"});
    scrub_credentials(&mut v);
    assert_eq!(v["note"], "hello world");
}

#[test]
fn preserves_release_health_marker() {
    let marker = "release-health-macos-g16";
    let mut v = json!({"patch": {"source": marker}});
    scrub_credentials(&mut v);
    assert_eq!(v["patch"]["source"], marker);
}

#[test]
fn leaves_long_camelcase_identifiers_alone() {
    let mut v = json!({"name": "ThisIsALongCamelCaseIdentifierName"});
    scrub_credentials(&mut v);
    assert_eq!(v["name"], "ThisIsALongCamelCaseIdentifierName");
}

#[test]
fn leaves_acp_protocol_and_tool_identifiers_alone() {
    let mut v = json!({
        "method": "session/update",
        "params": {
            "update": {
                "sessionUpdate": "available_commands_update",
                "_meta": {
                    "tools": [
                        "tool_call_delta_chunk",
                        "run_terminal_command",
                        "shellx-host-http__Agent",
                        "grok-shell-host__build_receipt",
                        "shellx-mp-git__git_diff",
                        "grok-shell-host__secret_get",
                        "shellx-host-http__secret_set",
                        "fs_list_dir",
                        "desktop_mouse_drag"
                    ]
                }
            }
        }
    });

    scrub_credentials(&mut v);

    assert_eq!(v["method"], "session/update");
    assert_eq!(
        v["params"]["update"]["sessionUpdate"],
        "available_commands_update"
    );
    assert_eq!(
        v["params"]["update"]["_meta"]["tools"][0],
        "tool_call_delta_chunk"
    );
    assert_eq!(
        v["params"]["update"]["_meta"]["tools"][2],
        "shellx-host-http__Agent"
    );
    assert_eq!(
        v["params"]["update"]["_meta"]["tools"][5],
        "grok-shell-host__secret_get"
    );
    assert_eq!(
        v["params"]["update"]["_meta"]["tools"][6],
        "shellx-host-http__secret_set"
    );
    assert_eq!(
        v["params"]["update"]["_meta"]["tools"][8],
        "desktop_mouse_drag"
    );
}

#[test]
fn redacts_jwt_in_free_field() {
    let jwt_like = [
        "eyJhbGciOiJIUzI1NiJ9",
        "eyJzdWIiOiIxMjM0NTY3ODkwIn0",
        "signaturepart",
    ]
    .join(".");
    let mut v = json!({
        "payload": jwt_like
    });
    scrub_credentials(&mut v);
    assert_eq!(v["payload"], "***REDACTED***");
}

#[test]
fn still_redacts_under_sensitive_keys() {
    let mut v = json!({"Authorization": "Bearer abc"});
    scrub_credentials(&mut v);
    assert_eq!(v["Authorization"], "***REDACTED***");
}
