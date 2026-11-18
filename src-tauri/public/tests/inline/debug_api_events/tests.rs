use super::*;

fn event(payload: serde_json::Value) -> RawEvent {
    RawEvent {
        t: 1,
        kind: "test".to_string(),
        payload,
    }
}

#[test]
fn tab_id_supports_grok_provider_and_flat_metadata_shapes() {
    let flat = event(serde_json::json!({ "_meta": { "tabId": "flat-tab" } }));
    let grok = event(serde_json::json!({ "params": { "_meta": { "tabId": "grok-tab" } } }));
    let provider = event(serde_json::json!({ "tabId": "provider-tab" }));

    assert_eq!(raw_event_tab_id(&flat), Some("flat-tab"));
    assert_eq!(raw_event_tab_id(&grok), Some("grok-tab"));
    assert_eq!(raw_event_tab_id(&provider), Some("provider-tab"));
}
