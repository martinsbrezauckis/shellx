use super::super::*;

#[test]
fn debug_ui_highlight_preserves_bounded_hit_test_and_rejects_invalid_points() {
    let hub = DebugHub::new();
    let patch: UiStatePatch = serde_json::from_value(serde_json::json!({
        "debugHighlights": [{"id":"point", "selector":"button", "hitTest":{"xFraction":0.1,"yFraction":0.9}}]
    })).expect("bounded hit-test request");
    hub.ui_apply(patch).expect("valid patch");
    let snapshot = serde_json::to_value(hub.ui_snapshot()).expect("snapshot");
    assert_eq!(snapshot["debugHighlights"][0]["hitTest"]["xFraction"], 0.1);
    assert_eq!(snapshot["debugHighlights"][0]["hitTest"]["yFraction"], 0.9);
    let patch: UiStatePatch = serde_json::from_value(serde_json::json!({
        "debugHighlights": [{"id":"bad", "selector":"button", "hitTest":{"xFraction":-0.1,"yFraction":0.5}}]
    })).expect("numeric request");
    hub.ui_apply(patch).expect("normalization");
    assert!(hub.ui_snapshot().debug_highlights.is_empty());
    let patch: UiStatePatch = serde_json::from_value(serde_json::json!({
        "debugHighlightResults": [{"id":"point", "selector":"button", "color":"cyan", "status":"resolved", "hitTest":{"x":45.0,"y":80.0,"matches":false}}]
    })).expect("hit-test response");
    hub.ui_apply(patch).expect("renderer result");
    let snapshot = serde_json::to_value(hub.ui_snapshot()).expect("snapshot");
    assert_eq!(
        snapshot["debugHighlightResults"][0]["hitTest"],
        serde_json::json!({"x":45.0,"y":80.0,"matches":false})
    );
    assert!(serde_json::from_value::<UiStatePatch>(serde_json::json!({
        "debugHighlights": [{"selector":"button", "hitTest":{"xFraction":0.5,"yFraction":0.5,"unbounded":"extra"}}]
    })).is_err());
}

#[test]
fn debug_ui_partial_tab_patch_preserves_omitted_connection_and_clears_explicit_null() {
    let hub = DebugHub::new();
    let report: UiStatePatch = serde_json::from_value(serde_json::json!({
        "source": "renderer", "activeTab": { "tabId": "remote", "cwd": "/old",
            "connectionId": "saved-ssh", "connectionLabel": "Remote", "connectionTransport": "ssh" }
    }))
    .unwrap();
    hub.ui_apply(report).unwrap();
    let omitted: UiStatePatch = serde_json::from_value(serde_json::json!({
        "activeTab": { "tabId": "remote", "cwd": "/new" }
    }))
    .unwrap();
    let result = hub.ui_apply(omitted).unwrap();
    let tab = result.active_tab.as_ref().unwrap();
    assert_eq!(tab.connection_id.as_deref(), Some("saved-ssh"));
    assert_eq!(tab.connection_transport.as_deref(), Some("ssh"));
    assert_eq!(tab.cwd.as_deref(), Some("/new"));
    let command = &result.command_stream.commands.back().unwrap().patch;
    assert!(
        command["activeTab"].get("connectionId").is_none(),
        "omission must not become a renderer clear command"
    );

    let clear: UiStatePatch = serde_json::from_value(serde_json::json!({
        "activeTab": { "tabId": "remote", "connectionId": null, "connectionLabel": "Local", "connectionTransport": "local" }
    })).unwrap();
    let previous = tab.clone();
    let result = hub.ui_apply(clear).unwrap();
    assert!(
        ui_active_tab_context_changed(Some(&previous), result.active_tab.as_ref().unwrap()),
        "the Build context guard must see an explicit clear"
    );
    assert!(result.active_tab.as_ref().unwrap().connection_id.is_none());
    assert_eq!(
        result.active_tab.as_ref().unwrap().cwd.as_deref(),
        Some("/new")
    );
    assert_eq!(
        result.command_stream.commands.back().unwrap().patch["activeTab"].get("connectionId"),
        Some(&serde_json::Value::Null)
    );
}

#[test]
fn debug_ui_partial_tab_patch_uses_the_named_tabs_existing_context() {
    let hub = DebugHub::new();
    hub.ui_apply(
        serde_json::from_value(serde_json::json!({ "source": "renderer",
            "activeTabId": "first", "openTabs": [
                { "tabId": "first", "connectionId": "first-preset", "cwd": "/first" },
                { "tabId": "second", "connectionId": "second-preset", "cwd": "/second" }
            ]
        }))
        .unwrap(),
    )
    .unwrap();
    let result = hub
        .ui_apply(
            serde_json::from_value(serde_json::json!({
                "activeTab": { "tabId": "second", "cwd": "/second/new" }
            }))
            .unwrap(),
        )
        .unwrap();
    let tab = result.active_tab.unwrap();
    assert_eq!(tab.tab_id, "second");
    assert_eq!(tab.connection_id.as_deref(), Some("second-preset"));
    assert_eq!(tab.cwd.as_deref(), Some("/second/new"));
}

#[test]
fn debug_ui_commands_separate_operator_intent_from_renderer_observations() {
    let hub = DebugHub::new();
    hub.ui_apply(UiStatePatch {
        active_tab_id: Some("old-tab".into()),
        source: Some("renderer".into()),
        ..Default::default()
    })
    .unwrap();
    let command = hub
        .ui_apply(UiStatePatch {
            debug_highlights: Some(vec![]),
            debug_surface: Some("app".into()),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(command.active_tab_id.as_deref(), Some("old-tab"));
    assert_eq!(command.command_stream.sequence, 1);
    assert_eq!(
        command.command_stream.commands[0].patch,
        serde_json::json!({ "debugHighlights": [], "debugSurface": "app" })
    );
    hub.ui_apply(UiStatePatch {
        active_tab_id: Some("new-tab".into()),
        source: Some("renderer".into()),
        ..Default::default()
    })
    .unwrap();
    let observed = hub.ui_snapshot();
    assert_eq!(observed.command_stream.sequence, 1);
    assert_eq!(
        observed.command_stream.commands[0].patch,
        command.command_stream.commands[0].patch
    );
    assert!(observed.ui_revision > command.ui_revision);
    assert_eq!(
        command.active_tab_id.as_deref(),
        Some("old-tab"),
        "returned snapshots are bound to their mutation"
    );
}

#[test]
fn debug_ui_commands_are_bounded_and_reject_oversize_before_mutation() {
    let hub = DebugHub::new();
    for _ in 0..70 {
        hub.ui_apply(UiStatePatch {
            debug_click: Some(serde_json::json!({ "selector": "button" })),
            ..Default::default()
        })
        .unwrap();
    }
    let before = serde_json::to_value(hub.ui_snapshot()).unwrap();
    assert_eq!(before["commandStream"]["sequence"], 70);
    assert_eq!(
        before["commandStream"]["commands"]
            .as_array()
            .unwrap()
            .len(),
        64
    );
    assert_eq!(before["commandStream"]["commands"][0]["sequence"], 7);
    assert_eq!(
        hub.ui_apply(UiStatePatch {
            active_tab_id: Some("must-not-change".into()),
            debug_input: Some(serde_json::json!({ "value": "x".repeat(65 * 1024) })),
            ..Default::default()
        })
        .unwrap_err(),
        "ui_command_too_large"
    );
    assert_eq!(serde_json::to_value(hub.ui_snapshot()).unwrap(), before);
    for _ in 0..10 {
        hub.ui_apply(UiStatePatch {
            debug_input: Some(serde_json::json!({ "value": "x".repeat(40 * 1024) })),
            ..Default::default()
        })
        .unwrap();
    }
    assert_eq!(
        hub.ui_snapshot().command_stream.commands.len(),
        3,
        "byte budget applies independently of entry count"
    );
    assert_ne!(
        hub.ui_snapshot().command_stream.epoch,
        DebugHub::new().ui_snapshot().command_stream.epoch
    );
}

fn asset_test_tab(
    tab_id: &str,
    session_id: &str,
    cwd: &str,
    transport: &str,
) -> DebugAssetSourceTab {
    DebugAssetSourceTab {
        tab_id: tab_id.to_string(),
        session_id: Some(session_id.to_string()),
        cwd: Some(cwd.to_string()),
        transport: Some(transport.to_string()),
        connection_label: Some(transport.to_string()),
    }
}

fn asset_tool_event(
    tab_id: &str,
    prompt_id: &str,
    tool_call_id: &str,
    title: &str,
    session_update: &str,
    text: Option<&str>,
    t: i64,
) -> RawEvent {
    let mut update = serde_json::json!({
        "sessionUpdate": session_update,
        "toolCallId": tool_call_id,
        "title": title,
        "status": if session_update == "tool_call" { "Pending" } else { "Completed" }
    });
    if let Some(text) = text {
        update["rawOutput"] = serde_json::json!({ "text": text });
    }
    RawEvent {
        t,
        kind: "grok-acp-event".to_string(),
        payload: serde_json::json!({
            "method": "session/update",
            "params": {
                "_meta": {
                    "tabId": tab_id,
                    "promptId": prompt_id
                },
                "update": update
            }
        }),
    }
}

#[test]
fn debug_ui_state_normalizes_known_tab_wire_values() {
    let hub = DebugHub::new();
    hub.ui_apply(UiStatePatch {
        right_tab: Some("preview".to_string()),
        bottom_tab: Some("logs".to_string()),
        ..UiStatePatch::default()
    })
    .expect("valid UI patch");
    let snapshot = hub.ui_snapshot();
    assert_eq!(snapshot.right_tab.as_deref(), Some("Preview"));
    assert_eq!(snapshot.bottom_tab.as_deref(), Some("Logs"));

    hub.ui_apply(UiStatePatch {
        right_tab: Some("external-pane".to_string()),
        bottom_tab: Some("external-bottom".to_string()),
        ..UiStatePatch::default()
    })
    .expect("valid UI patch");
    let snapshot = hub.ui_snapshot();
    assert_eq!(snapshot.right_tab.as_deref(), Some("external-pane"));
    assert_eq!(snapshot.bottom_tab.as_deref(), Some("external-bottom"));
}

#[test]
fn debug_ui_partial_patch_preserves_setup_guide_dismissal() {
    let hub = DebugHub::new();
    hub.ui_apply(UiStatePatch {
        setup_guide_dismissed: Some(true),
        ..UiStatePatch::default()
    })
    .expect("valid UI patch");

    hub.ui_apply(UiStatePatch {
        bottom_tab: Some("logs".to_string()),
        ..UiStatePatch::default()
    })
    .expect("valid UI patch");

    assert_eq!(hub.ui_snapshot().setup_guide_dismissed, Some(true));

    hub.ui_apply(UiStatePatch {
        setup_guide_dismissed: Some(false),
        ..UiStatePatch::default()
    })
    .expect("valid UI patch");
    assert_eq!(hub.ui_snapshot().setup_guide_dismissed, Some(false));
}

#[test]
fn debug_ui_preview_can_restore_an_explicit_empty_baseline() {
    let hub = DebugHub::new();
    hub.ui_apply(UiStatePatch {
        preview: Some(PreviewTarget {
            kind: "file".to_string(),
            path: "/tmp/shellx-preview-proof.txt".to_string(),
            tab_id: Some("preview-proof".to_string()),
            session_cwd: Some("/tmp".to_string()),
            line_range: None,
        }),
        ..UiStatePatch::default()
    })
    .expect("valid UI patch");
    assert!(hub.ui_snapshot().preview.is_some());

    hub.ui_apply(UiStatePatch {
        clear_preview: Some(true),
        ..UiStatePatch::default()
    })
    .expect("valid UI patch");
    assert!(hub.ui_snapshot().preview.is_none());
}

#[test]
fn debug_ui_refresh_past_chats_is_a_transient_relay() {
    let patch: UiStatePatch = serde_json::from_value(serde_json::json!({
        "refreshPastChats": true,
    }))
    .expect("refresh patch must deserialize");
    assert_eq!(patch.refresh_past_chats, Some(true));
    assert_eq!(
        serde_json::to_value(&patch)
            .expect("refresh patch must serialize")
            .get("refreshPastChats"),
        Some(&serde_json::Value::Bool(true)),
    );

    let hub = DebugHub::new();
    hub.ui_apply(patch).expect("valid UI patch");
    assert!(
        serde_json::to_value(hub.ui_snapshot())
            .expect("UI snapshot must serialize")
            .get("refreshPastChats")
            .is_none(),
        "the renderer refresh request must not persist in authoritative UI state",
    );
}

#[test]
fn ui_state_patch_rejects_private_fixture_fields_without_private_qualification() {
    let parsed = serde_json::from_value::<UiStatePatch>(serde_json::json!({
        "debugRendererFixture": { "id": "owned-fixture" },
    }));

    assert!(
        parsed
            .expect_err("ordinary Debug API must reject private fixture fields")
            .to_string()
            .contains("debugRendererFixture"),
        "unknown private fixture fields must fail instead of being silently ignored",
    );
}

#[test]
fn public_debug_ui_rejects_attachment_fixture_relays() {
    for field in ["debugAttachPaths", "debugRemoveAttachmentPaths"] {
        let error = serde_json::from_value::<UiStatePatch>(serde_json::json!({
            field: ["/tmp/owned.txt"],
        }))
        .expect_err("ordinary Debug API must reject private attachment fixture fields");
        assert!(
            error.to_string().contains(field),
            "unknown private fixture field {field} must fail instead of being silently ignored",
        );
    }
}

#[test]
fn debug_ui_active_tab_id_restores_matching_open_tab_context() {
    let hub = DebugHub::new();
    hub.ui_apply(UiStatePatch {
        open_tabs: Some(vec![
            UiOpenTabContext {
                tab_id: "manager".to_string(),
                cwd: Some("/home/user/shellx".to_string()),
                connection_label: Some("WSL Ubuntu".to_string()),
                connection_transport: Some("wsl".to_string()),
                ..UiOpenTabContext::default()
            },
            UiOpenTabContext {
                tab_id: "replay".to_string(),
                cwd: Some("/tmp/replay".to_string()),
                connection_label: Some("Local".to_string()),
                connection_transport: Some("local".to_string()),
                ..UiOpenTabContext::default()
            },
        ]),
        ..UiStatePatch::default()
    })
    .expect("valid UI patch");
    hub.ui_apply(UiStatePatch {
        active_tab: Some(ui_state_http::UiActiveTabPatch {
            tab_id: "replay".to_string(),
            cwd: Some("/tmp/replay".to_string()),
            autonomy: None,
            connection_id: None,
            connection_label: Some("Local".to_string()),
            connection_transport: Some("local".to_string()),
        }),
        ..UiStatePatch::default()
    })
    .expect("valid UI patch");
    hub.ui_apply(UiStatePatch {
        active_tab_id: Some("manager".to_string()),
        source: Some("replay-harness".to_string()),
        ..UiStatePatch::default()
    })
    .expect("valid UI patch");

    let snapshot = hub.ui_snapshot();
    assert_eq!(snapshot.active_tab_id.as_deref(), Some("manager"));
    assert_eq!(
        snapshot
            .active_tab
            .as_ref()
            .and_then(|tab| tab.cwd.as_deref()),
        Some("/home/user/shellx")
    );
    assert_eq!(
        snapshot
            .active_tab
            .as_ref()
            .and_then(|tab| tab.connection_transport.as_deref()),
        Some("wsl")
    );
    assert_eq!(
        snapshot.last_ui_patch_source.as_deref(),
        Some("replay-harness")
    );
    assert!(snapshot.ui_revision >= 3);
}

#[test]
fn debug_ui_open_tabs_refresh_preserves_active_tab_autonomy() {
    let hub = DebugHub::new();
    hub.ui_apply(UiStatePatch {
        active_tab: Some(ui_state_http::UiActiveTabPatch {
            tab_id: "manager".to_string(),
            cwd: Some("/home/user/shellx".to_string()),
            autonomy: Some("bypassPermissions".to_string()),
            connection_id: None,
            connection_label: Some("Local".to_string()),
            connection_transport: Some("local".to_string()),
        }),
        ..UiStatePatch::default()
    })
    .expect("valid UI patch");
    hub.ui_apply(UiStatePatch {
        open_tabs: Some(vec![UiOpenTabContext {
            tab_id: "manager".to_string(),
            cwd: Some("/home/user/shellx".to_string()),
            connection_label: Some("Local".to_string()),
            connection_transport: Some("local".to_string()),
            ..UiOpenTabContext::default()
        }]),
        ..UiStatePatch::default()
    })
    .expect("valid UI patch");

    let snapshot = hub.ui_snapshot();
    assert_eq!(
        snapshot
            .active_tab
            .as_ref()
            .and_then(|tab| tab.autonomy.as_deref()),
        Some("bypassPermissions")
    );
}

#[test]
fn debug_ui_active_tab_id_clears_stale_context_when_open_tab_unknown() {
    let hub = DebugHub::new();
    hub.ui_apply(UiStatePatch {
        active_tab: Some(ui_state_http::UiActiveTabPatch {
            tab_id: "replay".to_string(),
            cwd: Some("/tmp/replay".to_string()),
            autonomy: None,
            connection_id: None,
            connection_label: Some("Local".to_string()),
            connection_transport: Some("local".to_string()),
        }),
        ..UiStatePatch::default()
    })
    .expect("valid UI patch");
    hub.ui_apply(UiStatePatch {
        active_tab_id: Some("manager".to_string()),
        ..UiStatePatch::default()
    })
    .expect("valid UI patch");

    let snapshot = hub.ui_snapshot();
    assert_eq!(snapshot.active_tab_id.as_deref(), Some("manager"));
    assert!(snapshot.active_tab.is_none());
}

#[test]
fn debug_ui_highlights_round_trip_and_report_resolution() {
    let patch: UiStatePatch = serde_json::from_value(serde_json::json!({
        "debugHighlights": [
            {
                "id": "composer",
                "selector": "[data-debug-id='composer-prompt']",
                "label": "Composer prompt",
                "color": "yellow",
                "observe": ["pressed", "pressed", "focused", "title", "href", "scrollLeft", "scrollWidth", "clientWidth", "mounted", "nonempty"]
            }
        ]
    }))
    .expect("debugHighlights should parse");

    let hub = DebugHub::new();
    hub.ui_apply(patch).expect("valid UI patch");
    let snapshot = hub.ui_snapshot();
    assert_eq!(snapshot.debug_highlights.len(), 1);
    assert_eq!(
        snapshot.debug_highlights[0].selector,
        "[data-debug-id='composer-prompt']"
    );
    assert_eq!(
        snapshot.debug_highlights[0].label.as_deref(),
        Some("Composer prompt")
    );
    assert_eq!(
        snapshot.debug_highlights[0].observe,
        [
            DebugElementObservationField::Pressed,
            DebugElementObservationField::Focused,
            DebugElementObservationField::Title,
            DebugElementObservationField::Href,
            DebugElementObservationField::ScrollLeft,
            DebugElementObservationField::ScrollWidth,
            DebugElementObservationField::ClientWidth,
            DebugElementObservationField::Mounted,
            DebugElementObservationField::Nonempty,
        ]
    );

    hub.ui_apply(UiStatePatch {
        debug_highlight_results: Some(vec![DebugHighlightResult {
            id: "composer".to_string(),
            selector: "[data-debug-id='composer-prompt']".to_string(),
            label: Some("Composer prompt".to_string()),
            color: "#f9a825".to_string(),
            status: "resolved".to_string(),
            message: None,
            rect: Some(DebugHighlightRect {
                left: 12.0,
                top: 34.0,
                width: 320.0,
                height: 72.0,
            }),
            observation: Some(DebugElementObservation {
                pressed: Some(true),
                value: Some("v".repeat(300)),
                title: Some("t".repeat(300)),
                href: Some(format!("https://example.com/{}", "h".repeat(300))),
                scroll_left: Some(240.0),
                scroll_width: Some(1440.0),
                client_width: Some(720.0),
                mounted: Some(true),
                nonempty: Some(true),
                ..DebugElementObservation::default()
            }),
            ..DebugHighlightResult::default()
        }]),
        source: Some("renderer".to_string()),
        ..UiStatePatch::default()
    })
    .expect("valid UI patch");

    let snapshot = hub.ui_snapshot();
    assert_eq!(snapshot.debug_highlight_results.len(), 1);
    assert_eq!(snapshot.debug_highlight_results[0].status, "resolved");
    assert_eq!(
        snapshot.debug_highlight_results[0]
            .rect
            .as_ref()
            .unwrap()
            .width,
        320.0
    );
    assert_eq!(snapshot.last_ui_patch_source.as_deref(), Some("renderer"));
    assert_eq!(
        snapshot.debug_highlight_results[0]
            .observation
            .as_ref()
            .and_then(|value| value.pressed),
        Some(true)
    );
    assert_eq!(
        snapshot.debug_highlight_results[0]
            .observation
            .as_ref()
            .and_then(|value| value.nonempty),
        Some(true)
    );
    assert_eq!(
        snapshot.debug_highlight_results[0]
            .observation
            .as_ref()
            .and_then(|value| value.value.as_ref())
            .map(String::len),
        Some(256)
    );
    assert_eq!(
        snapshot.debug_highlight_results[0]
            .observation
            .as_ref()
            .and_then(|value| value.scroll_left),
        Some(240.0)
    );
    assert_eq!(
        snapshot.debug_highlight_results[0]
            .observation
            .as_ref()
            .and_then(|value| value.mounted),
        Some(true)
    );
    assert_eq!(
        snapshot.debug_highlight_results[0]
            .observation
            .as_ref()
            .and_then(|value| value.title.as_ref())
            .map(String::len),
        Some(256)
    );
    assert_eq!(
        snapshot.debug_highlight_results[0]
            .observation
            .as_ref()
            .and_then(|value| value.href.as_ref())
            .map(String::len),
        Some(256)
    );

    hub.ui_apply(UiStatePatch {
        debug_highlight_results: Some(vec![DebugHighlightResult {
            id: "composer".to_string(),
            selector: "[data-debug-id='composer-prompt']".to_string(),
            color: "#f9a825".to_string(),
            status: "resolved".to_string(),
            observation: Some(DebugElementObservation {
                href: Some("javascript:alert(1)".to_string()),
                ..DebugElementObservation::default()
            }),
            ..DebugHighlightResult::default()
        }]),
        source: Some("renderer".to_string()),
        ..UiStatePatch::default()
    })
    .expect("valid UI patch");
    assert!(hub.ui_snapshot().debug_highlight_results[0]
        .observation
        .as_ref()
        .and_then(|value| value.href.as_ref())
        .is_none());
    let serialized = serde_json::to_value(hub.ui_snapshot()).expect("UI snapshot should serialize");
    assert_eq!(
        serialized["debugHighlightResults"][0]["observation"],
        serde_json::json!({}),
        "unobserved fields must be omitted instead of crossing the Debug API as null placeholders"
    );
}

#[test]
fn debug_ui_highlight_request_rejects_unknown_observation_fields() {
    let parsed = serde_json::from_value::<UiStatePatch>(serde_json::json!({
        "debugHighlights": [{
            "id": "composer",
            "selector": "[data-debug-id='composer-prompt']",
            "observe": ["title", "secret"]
        }]
    }));

    assert!(
        parsed.is_err(),
        "unknown observation fields must fail closed at the API boundary"
    );
}

#[test]
fn debug_ui_highlight_request_clears_stale_surface_results() {
    let hub = DebugHub::new();
    hub.ui_apply(UiStatePatch {
        debug_highlight_results: Some(vec![DebugHighlightResult {
            id: "old-popover".to_string(),
            selector: "[data-debug-id='old-popover']".to_string(),
            label: Some("Old popover".to_string()),
            color: "#00acc1".to_string(),
            status: "missing".to_string(),
            message: Some("stale".to_string()),
            rect: None,
            ..DebugHighlightResult::default()
        }]),
        debug_surface: Some("app".to_string()),
        source: Some("renderer".to_string()),
        ..UiStatePatch::default()
    })
    .expect("valid UI patch");
    assert_eq!(
        hub.ui_snapshot()
            .debug_highlight_results_by_surface
            .get("app")
            .map(Vec::len),
        Some(1)
    );

    hub.ui_apply(UiStatePatch {
        debug_highlights: Some(vec![DebugHighlightRequest {
            id: Some("header".to_string()),
            selector: "[data-debug-id='header-vault-request-center']".to_string(),
            label: Some("Header".to_string()),
            color: Some("cyan".to_string()),
            index: None,
            text: None,
            observe: Vec::new(),
            hit_test: None,
        }]),
        debug_surface: Some("app".to_string()),
        source: Some("debug-driver".to_string()),
        ..UiStatePatch::default()
    })
    .expect("valid UI patch");

    let snapshot = hub.ui_snapshot();
    assert!(snapshot.debug_highlight_results.is_empty());
    assert_eq!(
        snapshot
            .debug_highlight_results_by_surface
            .get("app")
            .map(Vec::len),
        Some(0)
    );
}

#[test]
fn connect_body_accepts_build_tab_mutation_opt_in() {
    let body: ConnectBody = serde_json::from_value(serde_json::json!({
        "cwd": "/tmp/project",
        "tabId": "tab-build",
        "allowBuildTabMutation": true
    }))
    .expect("connect body should parse allowBuildTabMutation");

    assert!(body.allow_build_tab_mutation);
}

#[test]
fn raw_event_recording_redacts_credentials() {
    let hub = DebugHub::new();
    hub.record_raw_event(
        "provider-session-event",
        serde_json::json!({
            "headers": {
                "Authorization": "Bearer shellx-secret-token",
            },
            "nested": {
                "apiKey": "xai-secret-key",
            },
            "message": "normal output stays visible",
        }),
    );

    let recent = hub.recent(1);
    let payload = &recent[0].payload;
    assert_eq!(payload["headers"]["Authorization"], "***REDACTED***");
    assert_eq!(payload["nested"]["apiKey"], "***REDACTED***");
    assert_eq!(payload["message"], "normal output stays visible");
}

#[test]
fn raw_event_recording_enforces_per_event_and_ring_byte_limits() {
    let hub = DebugHub::new();
    hub.record_raw_event(
        "provider-session-event",
        serde_json::json!({ "message": "x".repeat(RAW_EVENT_MAX_BYTES + 1024) }),
    );

    let recent = hub.recent(1);
    assert_eq!(recent[0].payload["truncated"], true);
    assert_eq!(recent[0].payload["reason"], "debugEventByteLimit");

    for index in 0..40 {
        hub.record_raw_event(
            "bounded-ring-test",
            serde_json::json!({
                "index": index,
                "message": "y".repeat(RAW_EVENT_MAX_BYTES / 2),
            }),
        );
    }
    assert!(hub.buffered_bytes() <= RING_MAX_BYTES);
    assert!(hub.recent(100).len() < 40);
}

#[test]
fn debug_session_assets_extracts_generated_media_by_live_tab() {
    let img = "/home/user/.grok/sessions/%2Fhome%2Fuser%2Fproject/sid/images/result one.png";
    let vid = "/home/user/.grok/sessions/%2Fhome%2Fuser%2Fproject-b/sid/videos/demo (final).mp4";
    let tabs = vec![
        asset_test_tab("tab-a", "sid-a", "/home/user/project-a", "wsl"),
        asset_test_tab("tab-b", "sid-b", "/home/user/project-b", "ssh"),
    ];
    let events = vec![
        asset_tool_event("tab-a", "p1", "img-1", "image_gen", "tool_call", None, 100),
        asset_tool_event(
            "tab-a",
            "p1",
            "img-1",
            "image_gen",
            "tool_call_update",
            Some(&format!("Successfully generated image and saved to {img}.")),
            101,
        ),
        asset_tool_event("tab-b", "p2", "vid-1", "video_gen", "tool_call", None, 200),
        asset_tool_event(
            "tab-b",
            "p2",
            "vid-1",
            "video_gen",
            "tool_call_update",
            Some(&format!("Preview: [clip]({vid})")),
            201,
        ),
        asset_tool_event(
            "tab-closed",
            "p3",
            "img-x",
            "image_gen",
            "tool_call_update",
            Some("Image generated and saved to /home/user/.grok/sessions/x/images/closed.png"),
            300,
        ),
        asset_tool_event(
            "tab-a",
            "p4",
            "search-1",
            "search_tool",
            "tool_call_update",
            Some("Docs say image output path must end in .jpg/.jpeg/.png."),
            400,
        ),
    ];

    let state = debug_collect_session_assets_for_tabs(&events, &tabs, None, 200);

    assert_eq!(state.count, 2);
    assert_eq!(state.images.len(), 1);
    assert_eq!(state.videos.len(), 1);
    assert_eq!(state.images[0].path, img);
    assert_eq!(state.images[0].source_tab_id, "tab-a");
    assert_eq!(state.images[0].source_session_id.as_deref(), Some("sid-a"));
    assert_eq!(state.images[0].source_transport.as_deref(), Some("wsl"));
    assert_eq!(state.videos[0].path, vid);
    assert_eq!(state.videos[0].source_transport.as_deref(), Some("ssh"));
    assert!(!state
        .assets
        .iter()
        .any(|asset| asset.source_tab_id == "tab-closed"));
    assert!(!state
        .assets
        .iter()
        .any(|asset| asset.path.contains(".jpg/.jpeg")));
}

#[test]
fn debug_session_assets_extracts_grok_imagegen_path_field() {
    let raw_path = r"\\?\C:\Users\FixtureUser\.grok\sessions\C%3A%5CUsers%5CFixtureUser%5CDownloads\sid\images\1.jpg";
    let clean_path = r"C:\Users\FixtureUser\.grok\sessions\C%3A%5CUsers%5CFixtureUser%5CDownloads\sid\images\1.jpg";
    let tabs = vec![asset_test_tab(
        "tab-image",
        "sid-image",
        r"C:\Users\FixtureUser\Downloads",
        "local",
    )];
    let events = vec![
        RawEvent {
            t: 100,
            kind: "grok-acp-event".to_string(),
            payload: serde_json::json!({
                "method": "session/update",
                "params": {
                    "_meta": {
                        "tabId": "tab-image",
                        "promptId": "prompt-image"
                    },
                    "update": {
                        "sessionUpdate": "tool_call",
                        "toolCallId": "call-image-1",
                        "title": "image_gen",
                        "status": "Pending"
                    }
                }
            }),
        },
        RawEvent {
            t: 101,
            kind: "grok-acp-event".to_string(),
            payload: serde_json::json!({
                "method": "session/update",
                "params": {
                    "_meta": {
                        "tabId": "tab-image",
                        "promptId": "prompt-image"
                    },
                    "update": {
                        "sessionUpdate": "tool_call_update",
                        "toolCallId": "call-image-1",
                        "status": "completed",
                        "path": raw_path,
                        "type": "ImageGen"
                    }
                }
            }),
        },
    ];

    let state = debug_collect_session_assets_for_tabs(&events, &tabs, Some("tab-image"), 200);

    assert_eq!(state.count, 1);
    assert_eq!(state.images.len(), 1);
    assert_eq!(state.videos.len(), 0);
    assert_eq!(state.images[0].path, clean_path);
    assert_eq!(state.images[0].title, "1.jpg");
    assert_eq!(state.images[0].tool_title, "image_gen");
    assert_eq!(state.images[0].status, "completed");
}

#[test]
fn debug_session_assets_extracts_provider_session_media_text() {
    let image_path = r"C:\Users\FixtureUser\.grok\sessions\C%3A%5CUsers%5CFixtureUser%5CDownloads\sid\images\codex.png";
    let split_image_path = r"C:\Users\FixtureUser\.grok\sessions\C%3A%5CUsers%5CFixtureUser%5CDownloads\sid\images\claude-split.png";
    let video_path = "/home/user/.grok/sessions/%2Fhome%2Fuser%2Fproject/sid/videos/claude.mp4";
    let tabs = vec![
        asset_test_tab(
            "tab-codex",
            "provider-run",
            r"C:\Users\FixtureUser\Downloads",
            "local",
        ),
        asset_test_tab("tab-claude", "provider-b-run", "/home/user/project", "wsl"),
    ];
    let events = vec![
        RawEvent {
            t: 100,
            kind: "provider-session-event".to_string(),
            payload: serde_json::json!({
                "_meta": { "tabId": "tab-codex" },
                "tabId": "tab-codex",
                "runId": "provider-run",
                "providerId": "codex-cli",
                "kind": "text",
                "text": format!("Generated image saved to {image_path}.")
            }),
        },
        RawEvent {
            t: 100,
            kind: "provider-session-event".to_string(),
            payload: serde_json::json!({
                "_meta": { "tabId": "tab-codex" },
                "tabId": "tab-codex",
                "runId": "provider-run",
                "providerId": "codex-cli",
                "kind": "command",
                "text": r#"cp /tmp/generated.png "/home/user/out/codex-image-smoke-${stamp}.png""#
            }),
        },
        RawEvent {
            t: 101,
            kind: "provider-session-event".to_string(),
            payload: serde_json::json!({
                "_meta": { "tabId": "tab-codex" },
                "tabId": "tab-codex",
                "runId": "provider-run",
                "providerId": "codex-cli",
                "kind": "completed",
                "exitCode": 0
            }),
        },
        RawEvent {
            t: 200,
            kind: "provider-session-event".to_string(),
            payload: serde_json::json!({
                "_meta": { "tabId": "tab-claude" },
                "tabId": "tab-claude",
                "runId": "provider-b-run",
                "providerId": "claude-code",
                "kind": "textDelta",
                "text": format!("Preview video: {video_path}")
            }),
        },
        RawEvent {
            t: 300,
            kind: "provider-session-event".to_string(),
            payload: serde_json::json!({
                "_meta": { "tabId": "tab-claude" },
                "tabId": "tab-claude",
                "runId": "provider-b-run-split",
                "providerId": "claude-code",
                "kind": "textDelta",
                "text": r"Generated image saved to C:\Users\FixtureUser\.grok\sessions\C%3A%5CUsers%5CFixtureUser%5CDownloads\sid\images\claude-"
            }),
        },
        RawEvent {
            t: 301,
            kind: "provider-session-event".to_string(),
            payload: serde_json::json!({
                "_meta": { "tabId": "tab-claude" },
                "tabId": "tab-claude",
                "runId": "provider-b-run-split",
                "providerId": "claude-code",
                "kind": "textDelta",
                "text": "split.png"
            }),
        },
        RawEvent {
            t: 302,
            kind: "provider-session-event".to_string(),
            payload: serde_json::json!({
                "_meta": { "tabId": "tab-claude" },
                "tabId": "tab-claude",
                "runId": "provider-b-run-split",
                "providerId": "claude-code",
                "kind": "completed",
                "exitCode": 0
            }),
        },
        RawEvent {
            t: 400,
            kind: "provider-session-event".to_string(),
            payload: serde_json::json!({
                "_meta": { "tabId": "tab-codex" },
                "tabId": "tab-codex",
                "runId": "provider-run",
                "providerId": "codex-cli",
                "kind": "raw",
                "rawType": "stderr",
                "text": "Path must end in .jpg/.jpeg/.png."
            }),
        },
    ];

    let state = debug_collect_session_assets_for_tabs(&events, &tabs, None, 200);

    assert_eq!(state.count, 3);
    assert_eq!(state.images.len(), 2);
    assert_eq!(state.videos.len(), 1);
    assert!(state.images.iter().any(|asset| asset.path == image_path));
    assert!(state
        .images
        .iter()
        .any(|asset| asset.path == image_path && asset.status == "completed"));
    assert!(state
        .images
        .iter()
        .any(|asset| asset.path == split_image_path
            && asset.tool_title == "Claude Code output"
            && asset.status == "completed"));
    assert_eq!(state.videos[0].path, video_path);
    assert_eq!(state.videos[0].source_tab_id, "tab-claude");
    assert!(!state
        .assets
        .iter()
        .any(|asset| asset.path.contains(".jpg/.")));
    assert!(!state
        .assets
        .iter()
        .any(|asset| asset.path.contains("${stamp}")));
}

#[test]
fn debug_session_assets_extracts_provider_inline_code_media_path() {
    let image_path = "/home/user/project/output-inline.png";
    let video_path = "/home/user/project/output-inline.mp4";
    let tabs = vec![asset_test_tab(
        "tab-codex",
        "provider-run",
        "/home/user/project",
        "wsl",
    )];
    let events = vec![
        RawEvent {
            t: 100,
            kind: "provider-session-event".to_string(),
            payload: serde_json::json!({
                "_meta": { "tabId": "tab-codex" },
                "tabId": "tab-codex",
                "runId": "provider-run",
                "providerId": "codex-cli",
                "kind": "text",
                "text": format!("Saved image to `{image_path}`"),
            }),
        },
        RawEvent {
            t: 101,
            kind: "provider-session-event".to_string(),
            payload: serde_json::json!({
                "_meta": { "tabId": "tab-codex" },
                "tabId": "tab-codex",
                "runId": "provider-run",
                "providerId": "codex-cli",
                "kind": "text",
                "text": format!("Saved video to `{video_path}`"),
            }),
        },
    ];

    let state = debug_collect_session_assets_for_tabs(&events, &tabs, None, 200);

    assert_eq!(state.count, 2);
    assert_eq!(state.images[0].path, image_path);
    assert_eq!(state.videos[0].path, video_path);
}

#[test]
fn debug_session_assets_extracts_codex_generated_image_command_path() {
    let image_path = "/home/user/.codex/generated_images/00000000-0000-4000-8000-000000000001/ig_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png";
    let tabs = vec![asset_test_tab(
        "tab-codex",
        "provider-run",
        "/home/user/project",
        "ssh",
    )];
    let events = vec![
        RawEvent {
            t: 100,
            kind: "provider-session-event".to_string(),
            payload: serde_json::json!({
                "_meta": { "tabId": "tab-codex" },
                "tabId": "tab-codex",
                "runId": "provider-run",
                "providerId": "codex-cli",
                "kind": "command",
                "rawType": "command_execution",
                "text": format!(
                    "cp {image_path} /home/user/project/shellx-gpt-image-cross-smoke.png && file /home/user/project/shellx-gpt-image-cross-smoke.png"
                )
            }),
        },
        RawEvent {
            t: 101,
            kind: "provider-session-event".to_string(),
            payload: serde_json::json!({
                "_meta": { "tabId": "tab-codex" },
                "tabId": "tab-codex",
                "runId": "provider-run",
                "providerId": "codex-cli",
                "kind": "completed",
                "exitCode": 0
            }),
        },
    ];

    let state = debug_collect_session_assets_for_tabs(&events, &tabs, Some("tab-codex"), 200);

    assert_eq!(state.count, 1);
    assert_eq!(state.images.len(), 1);
    assert_eq!(state.images[0].path, image_path);
    assert_eq!(state.images[0].tool_title, "Codex CLI command");
    assert_eq!(state.images[0].status, "completed");
    assert_eq!(state.images[0].source_transport.as_deref(), Some("ssh"));
}

#[test]
fn debug_session_assets_ignore_shell_command_fragments_between_media_paths() {
    let original_path = "/home/user/.codex/generated_images/00000000-0000-4000-8000-000000000002/ig_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.png";
    let copied_path = "/home/user/project/gpt-image-codex.png";
    let tabs = vec![asset_test_tab(
        "tab-codex",
        "provider-run",
        "/home/user/project",
        "ssh",
    )];
    let events = vec![
        RawEvent {
            t: 100,
            kind: "provider-session-event".to_string(),
            payload: serde_json::json!({
                "_meta": { "tabId": "tab-codex" },
                "tabId": "tab-codex",
                "runId": "provider-run",
                "providerId": "codex-cli",
                "kind": "command",
                "rawType": "command_execution",
                "text": format!(
                    "mkdir -p /home/user/project && rm -f {copied_path} && cp {original_path} {copied_path}"
                )
            }),
        },
        RawEvent {
            t: 101,
            kind: "provider-session-event".to_string(),
            payload: serde_json::json!({
                "_meta": { "tabId": "tab-codex" },
                "tabId": "tab-codex",
                "runId": "provider-run",
                "providerId": "codex-cli",
                "kind": "text",
                "text": format!("GPT_IMAGE_RESULT path={copied_path} bytes=1642132"),
            }),
        },
        RawEvent {
            t: 102,
            kind: "provider-session-event".to_string(),
            payload: serde_json::json!({
                "_meta": { "tabId": "tab-codex" },
                "tabId": "tab-codex",
                "runId": "provider-run",
                "providerId": "codex-cli",
                "kind": "completed",
                "exitCode": 0
            }),
        },
    ];

    let state = debug_collect_session_assets_for_tabs(&events, &tabs, Some("tab-codex"), 200);

    assert_eq!(state.count, 2);
    assert_eq!(state.images.len(), 2);
    assert!(state.images.iter().any(|asset| asset.path == original_path));
    assert!(state.images.iter().any(|asset| asset.path == copied_path));
    assert!(!state
        .assets
        .iter()
        .any(|asset| asset.path.contains("&&") || asset.path.contains("rm -f")));
}

#[test]
fn debug_session_assets_does_not_overmatch_provider_prose_before_posix_path() {
    let image_path = "/home/user/shellx-media-smoke/codex/codex-image-postrebuild-1780551200.png";
    let tabs = vec![asset_test_tab(
        "tab-codex",
        "provider-run",
        "/home/user/shellx-media-smoke/codex",
        "wsl",
    )];
    let events = vec![
        RawEvent {
            t: 100,
            kind: "provider-session-event".to_string(),
            payload: serde_json::json!({
                "_meta": { "tabId": "tab-codex" },
                "tabId": "tab-codex",
                "runId": "provider-run",
                "providerId": "codex-cli",
                "kind": "text",
                "text": format!(
                    "Generated with OpenAI image generation instead of code/SVG synthesis. \
                     Since the requested asset is a creative bitmap, saved output to {image_path}\n\
                     SHELLX_CODEX_IMAGE_POSTREBUILD_OK"
                )
            }),
        },
        RawEvent {
            t: 101,
            kind: "provider-session-event".to_string(),
            payload: serde_json::json!({
                "_meta": { "tabId": "tab-codex" },
                "tabId": "tab-codex",
                "runId": "provider-run",
                "providerId": "codex-cli",
                "kind": "completed",
                "exitCode": 0
            }),
        },
    ];

    let state = debug_collect_session_assets_for_tabs(&events, &tabs, None, 200);

    assert_eq!(state.count, 1);
    assert_eq!(state.images.len(), 1);
    assert_eq!(state.images[0].path, image_path);
    assert_eq!(state.images[0].status, "completed");
    assert_eq!(state.images[0].t, 101);
    assert!(!state
        .assets
        .iter()
        .any(|asset| asset.path.contains("SVG synthesis")));
}

#[test]
fn debug_session_assets_ignore_grep_regex_media_patterns() {
    let tabs = vec![asset_test_tab(
        "tab-grok",
        "sid-grok",
        "/home/user/project",
        "ssh",
    )];
    let events = vec![
            asset_tool_event(
                "tab-grok",
                "p1",
                "grep-1",
                "Shell",
                "tool_call",
                None,
                100,
            ),
            asset_tool_event(
                "tab-grok",
                "p1",
                "grep-1",
                "Shell",
                "tool_call_update",
                Some(
                    "grep -n 'send_prompt_to_provider\\|Provider session\\|blue rocket\\|\\.png\\|images/generations' updates.jsonl",
                ),
                101,
            ),
        ];

    let state = debug_collect_session_assets_for_tabs(&events, &tabs, None, 200);

    assert_eq!(state.count, 0);
    assert!(state.assets.is_empty());
}

#[test]
fn debug_session_assets_ignore_provider_table_ghosts_and_keep_copied_codex_path() {
    let copied_path = "/home/user/mountain_lake_sunrise.png";
    let original_path = "/home/user/.codex/generated_images/00000000-0000-4000-8000-000000000003/ig_cccccccccccccccccccccccccccccccccccccccccccccccccc.png";
    let grok_path = "/home/user/.grok/sessions/%2Fhome%2Fuser/00000000-0000-4000-8000-000000000004/images/1.jpg";
    let tabs = vec![asset_test_tab("tab-ssh", "sid-ssh", "/home/user", "ssh")];
    let events = vec![
        RawEvent {
            t: 100,
            kind: "provider-session-event".to_string(),
            payload: serde_json::json!({
                "_meta": { "tabId": "tab-ssh" },
                "tabId": "tab-ssh",
                "runId": "run-codex",
                "providerId": "codex-cli",
                "kind": "text",
                "text": copied_path,
            }),
        },
        RawEvent {
            t: 101,
            kind: "provider-session-event".to_string(),
            payload: serde_json::json!({
                "_meta": { "tabId": "tab-ssh" },
                "tabId": "tab-ssh",
                "runId": "run-codex",
                "providerId": "codex-cli",
                "kind": "text",
                "text": format!("Original GPT Image output: {original_path}"),
            }),
        },
        RawEvent {
            t: 102,
            kind: "provider-session-event".to_string(),
            payload: serde_json::json!({
                "_meta": { "tabId": "tab-ssh" },
                "tabId": "tab-ssh",
                "runId": "run-claude",
                "providerId": "claude-code",
                "kind": "text",
                "text": "| Grok Imagine | `~/.grok/sessions/%2Fhome%2Fuser/00000000-0000-4000-8000-000000000004/images/1.jpg` |\n| GPT Image | `/.codex/generated_images/00000000-0000-4000-8000-000000000003/ig_cccccccccccccccccccccccccccccccccccccccccccccccccc.png` | `~/.grok/sessions/%2Fhome%2Fuser/00000000-0000-4000-8000-000000000004/images/1.jpg` |",
            }),
        },
        RawEvent {
            t: 103,
            kind: "grok-acp-event".to_string(),
            payload: serde_json::json!({
                "method": "session/update",
                "params": {
                    "_meta": { "tabId": "tab-ssh", "promptId": "prompt-grok" },
                    "sessionId": "sid-ssh",
                    "update": {
                        "sessionUpdate": "tool_call_update",
                        "toolCallId": "image-1",
                        "title": "imagine: mountain lake",
                        "status": "completed",
                        "path": grok_path,
                        "type": "ImageGen",
                        "rawOutput": { "type": "Text", "text": format!("Successfully generated image and saved to {grok_path}") }
                    }
                }
            }),
        },
    ];

    let state = debug_collect_session_assets_for_tabs(&events, &tabs, Some("tab-ssh"), 200);

    assert_eq!(state.images.len(), 3);
    assert!(state.images.iter().any(|asset| asset.path == copied_path));
    assert!(state.images.iter().any(|asset| asset.path == original_path));
    assert!(state.images.iter().any(|asset| asset.path == grok_path));
    assert!(!state
        .assets
        .iter()
        .any(|asset| asset.path == "/images/1.jpg"));
    assert!(!state
        .assets
        .iter()
        .any(|asset| asset.path.starts_with("/.codex/")));
    assert!(!state
        .assets
        .iter()
        .any(|asset| asset.path.contains('|') || asset.path.contains('`')));
}

#[test]
fn debug_session_assets_supports_tab_filter_and_limit() {
    let tabs = vec![
        asset_test_tab("tab-a", "sid-a", "/home/user/project-a", "wsl"),
        asset_test_tab("tab-b", "sid-b", "/home/user/project-b", "local"),
    ];
    let events = vec![
        asset_tool_event(
            "tab-a",
            "p1",
            "img-1",
            "image_gen",
            "tool_call_update",
            Some("Saved to /home/user/.grok/sessions/a/images/1.png"),
            100,
        ),
        asset_tool_event(
            "tab-b",
            "p2",
            "img-2",
            "image_gen",
            "tool_call_update",
            Some("Saved to /home/user/.grok/sessions/b/images/2.png"),
            200,
        ),
    ];

    let filtered = debug_collect_session_assets_for_tabs(&events, &tabs, Some("tab-a"), 200);
    let limited = debug_collect_session_assets_for_tabs(&events, &tabs, None, 1);

    assert_eq!(filtered.count, 1);
    assert_eq!(filtered.assets[0].source_tab_id, "tab-a");
    assert_eq!(limited.count, 1);
    assert_eq!(limited.assets[0].source_tab_id, "tab-b");
}
