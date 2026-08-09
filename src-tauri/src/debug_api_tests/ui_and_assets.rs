use super::super::*;

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
    });
    let snapshot = hub.ui_snapshot();
    assert_eq!(snapshot.right_tab.as_deref(), Some("Preview"));
    assert_eq!(snapshot.bottom_tab.as_deref(), Some("Logs"));

    hub.ui_apply(UiStatePatch {
        right_tab: Some("external-pane".to_string()),
        bottom_tab: Some("external-bottom".to_string()),
        ..UiStatePatch::default()
    });
    let snapshot = hub.ui_snapshot();
    assert_eq!(snapshot.right_tab.as_deref(), Some("external-pane"));
    assert_eq!(snapshot.bottom_tab.as_deref(), Some("external-bottom"));
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
    });
    assert!(hub.ui_snapshot().preview.is_some());

    hub.ui_apply(UiStatePatch {
        clear_preview: Some(true),
        ..UiStatePatch::default()
    });
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
    hub.ui_apply(patch);
    assert!(
        serde_json::to_value(hub.ui_snapshot())
            .expect("UI snapshot must serialize")
            .get("refreshPastChats")
            .is_none(),
        "the renderer refresh request must not persist in authoritative UI state",
    );
}

#[test]
fn debug_ui_attachment_paths_are_transient_relays() {
    let patch: UiStatePatch = serde_json::from_value(serde_json::json!({
        "debugAttachPaths": ["/tmp/owned.txt"],
        "debugRemoveAttachmentPaths": ["/tmp/owned.txt"],
    }))
    .expect("attachment patch must deserialize");
    assert_eq!(
        patch.debug_attach_paths,
        Some(vec!["/tmp/owned.txt".to_string()])
    );
    assert_eq!(
        patch.debug_remove_attachment_paths,
        Some(vec!["/tmp/owned.txt".to_string()]),
    );
    let serialized = serde_json::to_value(&patch).expect("attachment patch must serialize");
    assert_eq!(
        serialized.get("debugAttachPaths"),
        Some(&serde_json::json!(["/tmp/owned.txt"])),
    );
    assert_eq!(
        serialized.get("debugRemoveAttachmentPaths"),
        Some(&serde_json::json!(["/tmp/owned.txt"])),
    );

    let hub = DebugHub::new();
    hub.ui_apply(patch);
    let snapshot = serde_json::to_value(hub.ui_snapshot()).expect("UI snapshot must serialize");
    assert!(snapshot.get("debugAttachPaths").is_none());
    assert!(snapshot.get("debugRemoveAttachmentPaths").is_none());
}

#[test]
fn debug_renderer_fixture_is_a_transient_relay() {
    let fixture = serde_json::json!({
        "id": "event-projections",
        "attachmentPath": "/tmp/owned.txt",
        "imagePath": "/tmp/owned.png",
    });
    let patch: UiStatePatch = serde_json::from_value(serde_json::json!({
        "debugRendererFixture": fixture,
    }))
    .expect("renderer fixture patch must deserialize");
    assert_eq!(patch.debug_renderer_fixture, Some(fixture.clone()));
    assert_eq!(
        serde_json::to_value(&patch)
            .expect("renderer fixture patch must serialize")
            .get("debugRendererFixture"),
        Some(&fixture),
    );

    let hub = DebugHub::new();
    hub.ui_apply(patch);
    assert!(
        serde_json::to_value(hub.ui_snapshot())
            .expect("UI snapshot must serialize")
            .get("debugRendererFixture")
            .is_none(),
        "the renderer fixture command must not persist in authoritative UI state",
    );
}

#[test]
fn debug_plugins_fixture_is_a_transient_relay() {
    let patch: UiStatePatch = serde_json::from_value(serde_json::json!({
        "debugPluginsFixture": "owned-safe",
    }))
    .expect("Plugins fixture patch must deserialize");
    assert_eq!(patch.debug_plugins_fixture.as_deref(), Some("owned-safe"));
    assert_eq!(
        serde_json::to_value(&patch)
            .expect("Plugins fixture patch must serialize")
            .get("debugPluginsFixture"),
        Some(&serde_json::json!("owned-safe")),
    );

    let hub = DebugHub::new();
    hub.ui_apply(patch);
    assert!(
        serde_json::to_value(hub.ui_snapshot())
            .expect("UI snapshot must serialize")
            .get("debugPluginsFixture")
            .is_none(),
        "the Plugins fixture command must not persist in authoritative UI state",
    );
}

#[test]
fn release_lazy_surface_fixture_is_a_transient_relay() {
    let patch: UiStatePatch = serde_json::from_value(serde_json::json!({
        "releaseTestLazySurface": "owned-error",
    }))
    .expect("LazySurface fixture patch must deserialize");
    assert_eq!(
        patch.release_test_lazy_surface.as_deref(),
        Some("owned-error")
    );
    assert_eq!(
        serde_json::to_value(&patch)
            .expect("LazySurface fixture patch must serialize")
            .get("releaseTestLazySurface"),
        Some(&serde_json::json!("owned-error")),
    );

    let hub = DebugHub::new();
    hub.ui_apply(patch);
    assert!(
        serde_json::to_value(hub.ui_snapshot())
            .expect("UI snapshot must serialize")
            .get("releaseTestLazySurface")
            .is_none(),
        "the LazySurface fixture command must not persist in authoritative UI state",
    );
}

#[test]
fn release_legacy_autonomy_fixture_is_a_transient_relay() {
    let patch: UiStatePatch = serde_json::from_value(serde_json::json!({
        "releaseTestLegacyAutonomy": "legacy-default",
    }))
    .expect("legacy autonomy fixture patch must deserialize");
    assert_eq!(
        patch.release_test_legacy_autonomy.as_deref(),
        Some("legacy-default")
    );

    let hub = DebugHub::new();
    hub.ui_apply(patch);
    assert!(
        serde_json::to_value(hub.ui_snapshot())
            .expect("UI snapshot must serialize")
            .get("releaseTestLegacyAutonomy")
            .is_none(),
        "the legacy autonomy fixture command must not persist in authoritative UI state",
    );
}

#[test]
fn debug_plugins_production_fixture_requires_exact_isolated_profile() {
    let production: UiStatePatch = serde_json::from_value(serde_json::json!({
        "debugPluginsFixture": "owned-production",
    }))
    .expect("production Plugins fixture patch must deserialize");
    let safe: UiStatePatch = serde_json::from_value(serde_json::json!({
        "debugPluginsFixture": "owned-safe",
    }))
    .expect("safe Plugins fixture patch must deserialize");
    assert!(debug_ui_plugins_production_fixture_denial_for(
        &production,
        Some("1"),
        Some("shellx-final-0123456789abcdef"),
        Some("1"),
        Some("1"),
        Some("C:\\Temp\\shellx-final-webdriver-0123456789abcdef"),
        Some("C:\\Temp\\shellx-final-webdriver-0123456789abcdef\\vault-e2e"),
    )
    .is_none());
    assert!(debug_ui_plugins_production_fixture_denial_for(
        &production,
        Some("1"),
        Some("shellx-final-0123456789abcdef"),
        None,
        Some("1"),
        Some("/tmp/shellx-final-webdriver-0123456789abcdef"),
        Some("/tmp/shellx-final-webdriver-0123456789abcdef/vault-e2e"),
    )
    .is_some());
    assert!(debug_ui_plugins_production_fixture_denial_for(
        &production,
        Some("1"),
        Some("shellx-final-0123456789abcdef"),
        Some("1"),
        Some("1"),
        Some("/home/operator"),
        Some("/home/operator/vault-e2e"),
    )
    .is_some());
    assert!(debug_ui_plugins_production_fixture_denial_for(
        &safe, None, None, None, None, None, None,
    )
    .is_none());
}

#[test]
fn debug_build_plan_fixture_is_a_transient_relay() {
    let patch: UiStatePatch = serde_json::from_value(serde_json::json!({
        "debugBuildPlanFixture": "owned-ready",
    }))
    .expect("Build plan fixture patch must deserialize");
    assert_eq!(
        patch.debug_build_plan_fixture.as_deref(),
        Some("owned-ready")
    );
    assert_eq!(
        serde_json::to_value(&patch)
            .expect("Build plan fixture patch must serialize")
            .get("debugBuildPlanFixture"),
        Some(&serde_json::json!("owned-ready")),
    );

    let hub = DebugHub::new();
    hub.ui_apply(patch);
    assert!(
        serde_json::to_value(hub.ui_snapshot())
            .expect("UI snapshot must serialize")
            .get("debugBuildPlanFixture")
            .is_none(),
        "the Build plan fixture command must not persist in authoritative UI state",
    );
}

#[test]
fn debug_shellxagent_fixture_is_a_transient_relay() {
    let patch: UiStatePatch = serde_json::from_value(serde_json::json!({
        "debugShellxagentFixture": "owned-safe",
    }))
    .expect("ShellX Agent fixture patch must deserialize");
    assert_eq!(
        patch.debug_shellxagent_fixture.as_deref(),
        Some("owned-safe")
    );
    assert_eq!(
        serde_json::to_value(&patch)
            .expect("ShellX Agent fixture patch must serialize")
            .get("debugShellxagentFixture"),
        Some(&serde_json::json!("owned-safe")),
    );

    let hub = DebugHub::new();
    hub.ui_apply(patch);
    assert!(
        serde_json::to_value(hub.ui_snapshot())
            .expect("UI snapshot must serialize")
            .get("debugShellxagentFixture")
            .is_none(),
        "the ShellX Agent fixture command must not persist in authoritative UI state",
    );
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
    });
    hub.ui_apply(UiStatePatch {
        active_tab: Some(UiActiveTabContext {
            tab_id: "replay".to_string(),
            cwd: Some("/tmp/replay".to_string()),
            autonomy: None,
            connection_id: None,
            connection_label: Some("Local".to_string()),
            connection_transport: Some("local".to_string()),
        }),
        ..UiStatePatch::default()
    });
    hub.ui_apply(UiStatePatch {
        active_tab_id: Some("manager".to_string()),
        source: Some("replay-harness".to_string()),
        ..UiStatePatch::default()
    });

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
        active_tab: Some(UiActiveTabContext {
            tab_id: "manager".to_string(),
            cwd: Some("/home/user/shellx".to_string()),
            autonomy: Some("bypassPermissions".to_string()),
            connection_id: None,
            connection_label: Some("Local".to_string()),
            connection_transport: Some("local".to_string()),
        }),
        ..UiStatePatch::default()
    });
    hub.ui_apply(UiStatePatch {
        open_tabs: Some(vec![UiOpenTabContext {
            tab_id: "manager".to_string(),
            cwd: Some("/home/user/shellx".to_string()),
            connection_label: Some("Local".to_string()),
            connection_transport: Some("local".to_string()),
            ..UiOpenTabContext::default()
        }]),
        ..UiStatePatch::default()
    });

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
        active_tab: Some(UiActiveTabContext {
            tab_id: "replay".to_string(),
            cwd: Some("/tmp/replay".to_string()),
            autonomy: None,
            connection_id: None,
            connection_label: Some("Local".to_string()),
            connection_transport: Some("local".to_string()),
        }),
        ..UiStatePatch::default()
    });
    hub.ui_apply(UiStatePatch {
        active_tab_id: Some("manager".to_string()),
        ..UiStatePatch::default()
    });

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
    hub.ui_apply(patch);
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
    });

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
    });
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
    });
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
        }]),
        debug_surface: Some("app".to_string()),
        source: Some("debug-driver".to_string()),
        ..UiStatePatch::default()
    });

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
    let image_path = "/home/user/.codex/generated_images/019e9789-e342-74a0-bb96-dd9ffde49bf4/ig_00aff7bcb171a9dc016a22b2bf9bb48191aa9d903d1734babe.png";
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
    let original_path = "/home/user/.codex/generated_images/019e984f-2fb2-7683-8d53-e9c642bef1ec/ig_03724ec19d7b26fb016a22e55b16988191ae87bd544923af0e.png";
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
    let original_path = "/home/user/.codex/generated_images/019e9816-8701-74b0-bcd4-7e3b218171a7/ig_0931eb331b49f8c8016a22d6c0b7dc81938fff5bf643c40f89.png";
    let grok_path = "/home/user/.grok/sessions/%2Fhome%2Fuser/019e9816-8ed4-78d2-adf1-a1a123f5c882/images/1.jpg";
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
                "text": "| Grok Imagine | `~/.grok/sessions/%2Fhome%2Fuser/019e9816-8ed4-78d2-adf1-a1a123f5c882/images/1.jpg` |\n| GPT Image | `/.codex/generated_images/019e9816-8701-74b0-bcd4-7e3b218171a7/ig_0931eb331b49f8c8016a22d6c0b7dc81938fff5bf643c40f89.png` | `~/.grok/sessions/%2Fhome%2Fuser/019e9816-8ed4-78d2-adf1-a1a123f5c882/images/1.jpg` |",
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
