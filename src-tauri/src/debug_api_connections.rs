use super::*;

use crate::connections::{ConnectionPreset, ConnectionStore};

pub(super) static CONN_HTTP_CELL: std::sync::OnceLock<Arc<ConnectionStore>> =
    std::sync::OnceLock::new();

pub(super) fn connections_handle() -> Result<Arc<ConnectionStore>, String> {
    if let Some(s) = CONN_HTTP_CELL.get() {
        return Ok(s.clone());
    }
    let s = Arc::new(ConnectionStore::open()?);
    let _ = CONN_HTTP_CELL.set(s.clone());
    Ok(CONN_HTTP_CELL
        .get()
        .expect("CONN_HTTP_CELL just set")
        .clone())
}

pub(super) async fn connections_list_http(State(_s): State<ApiState>) -> impl IntoResponse {
    match connections_handle() {
        Ok(store) => {
            let presets = store.list().await;
            Json(serde_json::json!({ "presets": presets })).into_response()
        }
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({
                "error": { "code": "store_open_failed", "message": e }
            })),
        )
            .into_response(),
    }
}

pub(super) async fn connections_save_http(
    State(_s): State<ApiState>,
    Json(body): Json<ConnectionPreset>,
) -> impl IntoResponse {
    let store = match connections_handle() {
        Ok(s) => s,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({
                    "error": { "code": "store_open_failed", "message": e }
                })),
            )
                .into_response();
        }
    };
    match store.save(body).await {
        Ok(saved) => (StatusCode::CREATED, Json(saved)).into_response(),
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "error": { "code": "bad_request", "message": e }
            })),
        )
            .into_response(),
    }
}

pub(super) async fn connections_delete_http(
    State(_s): State<ApiState>,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> impl IntoResponse {
    let store = match connections_handle() {
        Ok(s) => s,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({
                    "error": { "code": "store_open_failed", "message": e }
                })),
            )
                .into_response();
        }
    };
    match store.delete(&id).await {
        Ok(true) => (StatusCode::NO_CONTENT, "").into_response(),
        Ok(false) => Json(serde_json::json!({ "alreadyGone": true })).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({
                "error": { "code": "internal", "message": e }
            })),
        )
            .into_response(),
    }
}

pub(super) async fn connections_test_http(
    State(_s): State<ApiState>,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> impl IntoResponse {
    let store = match connections_handle() {
        Ok(s) => s,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({
                    "error": { "code": "store_open_failed", "message": e }
                })),
            )
                .into_response();
        }
    };
    let r = store.test(&id).await;
    Json(r).into_response()
}

pub(super) async fn connections_provider_scan_http(
    State(_s): State<ApiState>,
    Json(body): Json<serde_json::Value>,
) -> impl IntoResponse {
    let preset = match parse_connections_provider_scan_body(body) {
        Ok(preset) => preset,
        Err(e) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({
                    "error": { "code": "bad_request", "message": e }
                })),
            )
                .into_response();
        }
    };
    match crate::connections::scan_connection_provider_capabilities(&preset).await {
        Ok(snapshot) => Json(snapshot).into_response(),
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "error": { "code": "bad_request", "message": e }
            })),
        )
            .into_response(),
    }
}

pub(super) fn parse_connections_provider_scan_body(
    body: serde_json::Value,
) -> Result<ConnectionPreset, String> {
    let candidate = body.get("preset").cloned().unwrap_or_else(|| body.clone());
    serde_json::from_value::<ConnectionPreset>(candidate)
        .map_err(|e| format!("invalid connection preset: {e}"))
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub(super) struct AgentCliSetupQuery {
    connection_id: Option<String>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub(super) struct AgentCliSetupTargetBody {
    connection_id: Option<String>,
    preset: Option<ConnectionPreset>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct AgentCliSetupPrepareBody {
    connection_id: Option<String>,
    preset: Option<ConnectionPreset>,
    provider_id: String,
    method_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct AgentCliSetupConfirmBody {
    confirmation_id: String,
}

pub(super) async fn agent_cli_setup_state_http(
    State(_s): State<ApiState>,
    Query(q): Query<AgentCliSetupQuery>,
) -> impl IntoResponse {
    let preset = match resolve_agent_cli_setup_preset(q.connection_id).await {
        Ok(preset) => preset,
        Err(e) => return bad_agent_cli_setup_response(e),
    };
    match crate::agent_cli_setup::agent_cli_setup_state_for_preset(preset).await {
        Ok(state) => Json(state).into_response(),
        Err(e) => bad_agent_cli_setup_response(e),
    }
}

pub(super) async fn agent_cli_setup_prepare_http(
    State(_s): State<ApiState>,
    Json(body): Json<AgentCliSetupPrepareBody>,
) -> impl IntoResponse {
    if let Err(error) = reject_agent_cli_setup_inline_preset(body.preset.is_some()) {
        return bad_agent_cli_setup_response(error);
    }
    let preset = match resolve_agent_cli_setup_preset(body.connection_id).await {
        Ok(preset) => preset,
        Err(e) => return bad_agent_cli_setup_response(e),
    };
    match crate::agent_cli_setup::prepare_agent_cli_install(
        preset,
        body.provider_id,
        body.method_id,
    )
    .await
    {
        Ok(confirmation) => Json(confirmation).into_response(),
        Err(e) => bad_agent_cli_setup_response(e),
    }
}

pub(super) async fn agent_cli_setup_confirm_http(
    State(_s): State<ApiState>,
    Json(body): Json<AgentCliSetupConfirmBody>,
) -> impl IntoResponse {
    match crate::agent_cli_setup::confirm_agent_cli_install(body.confirmation_id).await {
        Ok(result) => Json(result).into_response(),
        Err(e) => bad_agent_cli_setup_response(e),
    }
}

pub(super) async fn agent_cli_setup_cancel_http(
    State(_s): State<ApiState>,
    Json(body): Json<AgentCliSetupConfirmBody>,
) -> impl IntoResponse {
    match crate::agent_cli_setup::cancel_agent_cli_install(body.confirmation_id).await {
        Ok(cleaned) => Json(serde_json::json!({ "ok": true, "cleaned": cleaned })).into_response(),
        Err(e) => bad_agent_cli_setup_response(e),
    }
}

pub(super) async fn agent_cli_setup_recheck_http(
    State(_s): State<ApiState>,
    Json(body): Json<AgentCliSetupTargetBody>,
) -> impl IntoResponse {
    if let Err(error) = reject_agent_cli_setup_inline_preset(body.preset.is_some()) {
        return bad_agent_cli_setup_response(error);
    }
    let preset = match resolve_agent_cli_setup_preset(body.connection_id).await {
        Ok(preset) => preset,
        Err(e) => return bad_agent_cli_setup_response(e),
    };
    match crate::agent_cli_setup::recheck_agent_cli_setup(preset).await {
        Ok(state) => Json(state).into_response(),
        Err(e) => bad_agent_cli_setup_response(e),
    }
}

pub(super) async fn resolve_agent_cli_setup_preset(
    connection_id: Option<String>,
) -> Result<ConnectionPreset, String> {
    if let Some(id) = connection_id
        .map(|id| id.trim().to_string())
        .filter(|id| !id.is_empty())
    {
        let store = connections_handle()?;
        let _ = store.reload_from_disk().await;
        return store
            .get(&id)
            .await
            .ok_or_else(|| format!("unknown connectionId '{id}'"));
    }
    Ok(ConnectionPreset {
        id: String::new(),
        label: "Current local".to_string(),
        transport: crate::acp::Transport::Local { grok_path: None },
        created_ms: now_ms(),
        last_used_ms: 0,
        provider_scan: Vec::new(),
    })
}

fn reject_agent_cli_setup_inline_preset(preset_present: bool) -> Result<(), String> {
    if preset_present {
        return Err(
            "agent CLI install and recheck routes require a saved connectionId; inline presets are read-only scan inputs"
                .to_string(),
        );
    }
    Ok(())
}

#[cfg(test)]
mod agent_cli_setup_route_tests {
    use super::reject_agent_cli_setup_inline_preset;

    #[test]
    fn mutating_agent_cli_setup_routes_reject_inline_presets() {
        assert!(reject_agent_cli_setup_inline_preset(false).is_ok());
        assert!(reject_agent_cli_setup_inline_preset(true)
            .unwrap_err()
            .contains("saved connectionId"));
    }
}

pub(super) fn bad_agent_cli_setup_response(message: String) -> Response {
    (
        StatusCode::BAD_REQUEST,
        Json(serde_json::json!({
            "error": { "code": "bad_request", "message": message }
        })),
    )
        .into_response()
}

// ─────────── Outside connector HTTP surface ───────────
//
// Auth inherits the existing bearer-token middleware. Secrets are not
// accepted here; bodies contain only vault-key references.

use crate::outside_connectors::{
    connector_capabilities, OutsideConnector, OutsideConnectorInboundInput,
};

#[derive(Deserialize, Default)]
pub(super) struct OutsideConnectorEventsQuery {
    limit: Option<usize>,
}

pub(super) async fn outside_connectors_list_http(State(_s): State<ApiState>) -> impl IntoResponse {
    match crate::get_or_open_outside_connectors() {
        Ok(store) => {
            let connectors = store.list().await;
            Json(serde_json::json!({ "connectors": connectors })).into_response()
        }
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({
                "error": { "code": "store_open_failed", "message": e }
            })),
        )
            .into_response(),
    }
}

pub(super) async fn outside_connectors_capabilities_http(
    State(_s): State<ApiState>,
) -> impl IntoResponse {
    Json(serde_json::json!({ "capabilities": connector_capabilities() })).into_response()
}

pub(super) async fn outside_connectors_events_http(
    State(_s): State<ApiState>,
    Query(q): Query<OutsideConnectorEventsQuery>,
) -> impl IntoResponse {
    match crate::get_or_open_outside_connectors() {
        Ok(store) => {
            let events = store.events(q.limit.unwrap_or(50)).await;
            Json(serde_json::json!({ "events": events })).into_response()
        }
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({
                "error": { "code": "store_open_failed", "message": e }
            })),
        )
            .into_response(),
    }
}

pub(super) async fn outside_connectors_save_http(
    State(_s): State<ApiState>,
    Json(body): Json<OutsideConnector>,
) -> impl IntoResponse {
    let store = match crate::get_or_open_outside_connectors() {
        Ok(s) => s,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({
                    "error": { "code": "store_open_failed", "message": e }
                })),
            )
                .into_response();
        }
    };
    match store.save(body).await {
        Ok(saved) => (StatusCode::CREATED, Json(saved)).into_response(),
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "error": { "code": "bad_request", "message": e }
            })),
        )
            .into_response(),
    }
}

pub(super) async fn outside_connectors_delete_http(
    State(_s): State<ApiState>,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> impl IntoResponse {
    let store = match crate::get_or_open_outside_connectors() {
        Ok(s) => s,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({
                    "error": { "code": "store_open_failed", "message": e }
                })),
            )
                .into_response();
        }
    };
    match store.delete(&id).await {
        Ok(true) => (StatusCode::NO_CONTENT, "").into_response(),
        Ok(false) => Json(serde_json::json!({ "alreadyGone": true })).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({
                "error": { "code": "internal", "message": e }
            })),
        )
            .into_response(),
    }
}

pub(super) async fn outside_connectors_test_http(
    State(_s): State<ApiState>,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> impl IntoResponse {
    match crate::get_or_open_outside_connectors() {
        Ok(store) => Json(store.test(&id).await).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({
                "error": { "code": "store_open_failed", "message": e }
            })),
        )
            .into_response(),
    }
}

pub(super) async fn outside_connectors_simulate_http(
    State(_s): State<ApiState>,
    axum::extract::Path(id): axum::extract::Path<String>,
    Json(input): Json<OutsideConnectorInboundInput>,
) -> impl IntoResponse {
    let store = match crate::get_or_open_outside_connectors() {
        Ok(store) => store,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({
                    "error": { "code": "store_open_failed", "message": e }
                })),
            )
                .into_response();
        }
    };
    match store.simulate_inbound(&id, input).await {
        Ok(event) => (StatusCode::CREATED, Json(event)).into_response(),
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "error": { "code": "bad_request", "message": e }
            })),
        )
            .into_response(),
    }
}
