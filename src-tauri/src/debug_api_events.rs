use super::*;

#[derive(Deserialize)]
pub(super) struct RecentQuery {
    limit: Option<usize>,
    /// Optional tab filter. Matches flat metadata, Grok ACP metadata,
    /// and provider-session `payload.tabId`. Dispatchers that watch one
    /// tab no longer need to pull the global ring and post-filter it.
    /// `tab_id` over the wire (we re-export as both casings since
    /// existing callers use the camel form too).
    #[serde(alias = "tabId", alias = "tab", alias = "sessionId")]
    tab_id: Option<String>,
    /// When `1`, wrap the result in
    /// `{ events, count, earliestT, latestT }`. Default 0 keeps the
    /// bare-array shape for back-compat with the React UI and older
    /// drivers that don't expect an envelope.
    #[serde(rename = "envelope", default)]
    envelope: Option<u8>,
    /// Replay cursor. When set, only
    /// events with `t > since` are returned. Combined with `limit` and
    /// `tab_id`, this lets a dispatcher resume polling after a
    /// disconnect without re-pulling the entire ring. The client
    /// records the largest `t` it has already seen and passes it back.
    /// Millis since unix epoch — matches RawEvent.t.
    /// /// Also accept `sinceMs` as alias — some external drivers reach
    /// for the more explicit name and were silently no-op'd before
    /// this alias.
    #[serde(alias = "sinceMs")]
    since: Option<i64>,
}

fn raw_event_tab_id(event: &RawEvent) -> Option<&str> {
    event
        .payload
        .pointer("/_meta/tabId")
        .or_else(|| event.payload.pointer("/params/_meta/tabId"))
        .or_else(|| event.payload.get("tabId"))
        .and_then(|value| value.as_str())
}

pub(super) async fn events_recent(
    State(s): State<ApiState>,
    Query(q): Query<RecentQuery>,
) -> impl IntoResponse {
    // #421 — default 200 was too tight under multi-tab load (12-22s
    // window). Bump to 1000. The full-scan + filter path below kicks
    // in whenever tabId or since is set, so this only affects the
    // "fire-hose, no filter" diagnostic path.
    let lim = q.limit.unwrap_or(1000).min(RING_CAPACITY);
    // When a tab filter OR since cursor is supplied we walk the entire
    // ring (~8k cap) and apply the filter BEFORE the limit. Otherwise
    // "last 200" of a tab whose recent activity has been pushed out by
    // chatter in another tab returns 0 — exactly the false negative
    // tab-filter false-negative case. Walking 8k events is cheap;
    // filters are O(1) each.
    let want_full_scan = q.tab_id.is_some() || q.since.is_some();
    let events = if want_full_scan {
        s.hub().recent(RING_CAPACITY)
    } else {
        s.hub().recent(lim)
    };
    let tab_filter = q.tab_id.as_deref();
    let since_cursor = q.since;
    let mut keep: Vec<RawEvent> = events
        .into_iter()
        .filter(|ev| {
            if let Some(c) = since_cursor {
                if ev.t <= c {
                    return false;
                }
            }
            if let Some(want) = tab_filter {
                let ev_tab = raw_event_tab_id(ev).unwrap_or("");
                if ev_tab != want {
                    return false;
                }
            }
            true
        })
        .collect();
    // After filtering, trim to limit from the OLDEST end so the response
    // is always "the most recent N matching events". keep is in
    // chronological order because the ring is.
    if keep.len() > lim {
        let drop_n = keep.len() - lim;
        keep.drain(0..drop_n);
    }
    // Opt-in envelope. Default = bare array (back-compat).
    if matches!(q.envelope, Some(1)) {
        let earliest_t = keep.first().map(|e| e.t);
        let latest_t = keep.last().map(|e| e.t);
        let count = keep.len();
        Json(serde_json::json!({
            "events": keep,
            "count": count,
            "earliestT": earliest_t,
            "latestT": latest_t,
        }))
        .into_response()
    } else {
        Json(keep).into_response()
    }
}

#[cfg(test)]
#[allow(clippy::items_after_test_module)]
mod tests {
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
}

pub(super) async fn events_ws(
    State(s): State<ApiState>,
    ws: WebSocketUpgrade,
) -> impl IntoResponse {
    let hub = s.hub();
    ws.on_upgrade(move |socket| handle_ws(socket, hub))
}

pub(super) async fn handle_ws(mut socket: WebSocket, hub: Arc<DebugHub>) {
    let _connection_guard = hub.begin_debug_websocket_connection();
    // Subscribe before copying the backlog. Events recorded while the backlog
    // is being serialized then remain queued in `rx` instead of falling into
    // the old snapshot-before-subscribe race. Consumers de-duplicate the small
    // possible overlap by event id/content identity.
    let mut rx = hub.tx.subscribe();
    // 1. Send the recent backlog first so a fresh connection has context.
    let backlog = hub.recent(200);
    for ev in backlog {
        if let Ok(text) = serde_json::to_string(&ev) {
            if socket.send(Message::Text(text)).await.is_err() {
                return;
            }
        }
    }
    // 2. Forward every event recorded after the subscription above.
    loop {
        tokio::select! {
                   recv = rx.recv() => match recv {
                       Ok(ev) => {
                           let text = match serde_json::to_string(&ev) {
                               Ok(t) => t,
                               Err(_) => continue,
                           };
                           if socket.send(Message::Text(text)).await.is_err() {
                               return;
                           }
                       }
                       Err(broadcast::error::RecvError::Lagged(_)) => {
        // Slow client; warn and continue from latest.
                           let _ = socket.send(Message::Text(
                               r#"{"kind":"debug-api","payload":{"warning":"lagged"}}"#.into()
                           )).await;
                       }
                       Err(broadcast::error::RecvError::Closed) => return,
                   },
        // Detect disconnects + ignore client messages.
                   msg = socket.recv() => match msg {
                       Some(Ok(_)) => continue,
                       _ => return,
                   }
               }
    }
}
