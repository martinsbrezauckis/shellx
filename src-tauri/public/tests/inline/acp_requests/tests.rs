use super::*;

#[test]
fn interject_contract_uses_grok_extension_wire_name_and_camel_case_params() {
    let request = AcpRequest {
        jsonrpc: "2.0".to_string(),
        id: 7,
        method: GROK_INTERJECT_METHOD.to_string(),
        params: GrokInterjectParams {
            session_id: "session-1".to_string(),
            text: "Check the failing test first.".to_string(),
            interjection_id: "interjection-1".to_string(),
        },
    };
    let value = serde_json::to_value(request).expect("interject request serializes");

    assert_eq!(value["method"], "_x.ai/interject");
    assert_eq!(value["params"]["sessionId"], "session-1");
    assert_eq!(value["params"]["text"], "Check the failing test first.");
    assert_eq!(value["params"]["interjectionId"], "interjection-1");
    assert!(value["params"].get("session_id").is_none());
}

#[tokio::test]
async fn failed_request_without_writer_does_not_leak_pending_response() {
    let session = GrokAcpSession::new();

    let error = session
        .send_request_with_timeout(
            "test/request",
            serde_json::json!({}),
            Duration::from_secs(1),
        )
        .await
        .expect_err("a session without stdin must reject requests");

    assert_eq!(error, "No active stdin writer");
    assert!(session.pending_responses.lock().await.is_empty());
}

#[tokio::test]
async fn timed_out_request_does_not_leak_pending_response() {
    let pending_responses = Arc::new(TokioMutex::new(HashMap::new()));
    let (sender, receiver) = oneshot::channel();
    pending_responses.lock().await.insert(
        9,
        PendingAcpRequest {
            method: "test/timeout".to_string(),
            sender,
        },
    );
    let pending = PendingAcpResponse {
        id: 9,
        method: "test/timeout".to_string(),
        request_timeout: Duration::from_millis(1),
        receiver,
        pending_responses: pending_responses.clone(),
        polled: false,
    };

    let error = pending.wait().await.expect_err("request must time out");

    assert!(error.starts_with("ACP request timeout for test/timeout"));
    assert!(pending_responses.lock().await.is_empty());
}

#[tokio::test]
async fn cancelled_polled_request_does_not_leak_pending_response() {
    let pending_responses = Arc::new(TokioMutex::new(HashMap::new()));
    let (sender, receiver) = oneshot::channel();
    pending_responses.lock().await.insert(
        11,
        PendingAcpRequest {
            method: "test/cancel".to_string(),
            sender,
        },
    );
    let pending = PendingAcpResponse {
        id: 11,
        method: "test/cancel".to_string(),
        request_timeout: Duration::from_secs(30),
        receiver,
        pending_responses: pending_responses.clone(),
        polled: false,
    };

    let result = timeout(Duration::from_millis(1), pending).await;

    assert!(result.is_err(), "outer wait should time out");
    assert!(pending_responses.lock().await.is_empty());
}

#[tokio::test]
async fn never_polled_request_remains_registered_for_fire_and_forget_response() {
    let pending_responses = Arc::new(TokioMutex::new(HashMap::new()));
    let (sender, receiver) = oneshot::channel();
    pending_responses.lock().await.insert(
        12,
        PendingAcpRequest {
            method: "session/prompt".to_string(),
            sender,
        },
    );
    let pending = PendingAcpResponse {
        id: 12,
        method: "session/prompt".to_string(),
        request_timeout: Duration::from_secs(30),
        receiver,
        pending_responses: pending_responses.clone(),
        polled: false,
    };

    drop(pending);

    assert!(pending_responses.lock().await.contains_key(&12));
}
