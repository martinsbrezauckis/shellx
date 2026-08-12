use axum::{
    extract::{Path as AxumPath, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{delete, get, post},
    Json, Router,
};

use crate::debug_api::{browser_registry, ApiState};
use crate::debug_api_browser_caller::browser_mcp_caller_id;
use crate::debug_api_browser_events::emit_browser_latest;

pub(crate) fn browser_settings_routes() -> Router<ApiState> {
    Router::new()
        .route(
            "/browser/bookmarks",
            get(browser_bookmarks_http).post(browser_bookmarks_post_http),
        )
        .route(
            "/browser/bookmarks/reorder",
            post(browser_bookmarks_reorder_http),
        )
        .route(
            "/browser/bookmarks/:bookmark_id",
            delete(browser_bookmarks_delete_http),
        )
        .route(
            "/browser/privacy",
            get(browser_privacy_get_http).post(browser_privacy_post_http),
        )
        .route(
            "/browser/personal-lock",
            get(browser_personal_lock_get_http).post(browser_personal_lock_post_http),
        )
        .route(
            "/browser/engine-pool",
            get(browser_engine_pool_get_http).post(browser_engine_pool_post_http),
        )
        .route(
            "/browser/shields",
            get(browser_shields_get_http).post(browser_shields_post_http),
        )
        .route(
            "/browser/shields/site",
            post(browser_shields_site_post_http),
        )
        .route(
            "/browser/shields/site/:host",
            delete(browser_shields_site_delete_http),
        )
        .route(
            "/browser/developer-mode",
            get(browser_developer_mode_get_http).post(browser_developer_mode_post_http),
        )
        .route(
            "/browser/developer-mode/approval",
            post(browser_developer_mode_approval_http),
        )
}

pub(crate) async fn browser_bookmarks_http(
    State(s): State<ApiState>,
    headers: HeaderMap,
) -> Response {
    let registry = match browser_registry(&s) {
        Ok(registry) => registry,
        Err(response) => return *response,
    };
    if browser_mcp_caller_id(&headers).is_some() {
        // A provider may discover the deliberately agent-facing workflow
        // catalog, but never receives personal bookmark links or folders.
        let bookmarks = registry
            .bookmarks()
            .into_iter()
            .filter(|bookmark| bookmark.agent_workflow.is_some())
            .collect::<Vec<_>>();
        Json(serde_json::json!({
            "bookmarks": bookmarks,
            "bookmarkToolbar": [],
            "scope": "agentWorkflowsOnly",
        }))
        .into_response()
    } else {
        Json(serde_json::json!({
            "bookmarks": registry.bookmarks(),
            "bookmarkToolbar": registry.bookmark_toolbar(),
        }))
        .into_response()
    }
}

pub(crate) async fn browser_bookmarks_post_http(
    State(s): State<ApiState>,
    Json(body): Json<crate::shellx_browser::BrowserBookmarkUpsertRequest>,
) -> Response {
    let registry = match browser_registry(&s) {
        Ok(registry) => registry,
        Err(response) => return *response,
    };
    match registry.upsert_bookmark(body) {
        Ok(response) => {
            emit_browser_latest(&s, &registry);
            Json(response).into_response()
        }
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "ok": false, "error": e })),
        )
            .into_response(),
    }
}

pub(crate) async fn browser_bookmarks_reorder_http(
    State(s): State<ApiState>,
    Json(body): Json<crate::shellx_browser::BrowserBookmarkReorderRequest>,
) -> Response {
    let registry = match browser_registry(&s) {
        Ok(registry) => registry,
        Err(response) => return *response,
    };
    match registry.reorder_bookmarks(body) {
        Ok(receipt) => {
            emit_browser_latest(&s, &registry);
            Json(serde_json::json!({
                "ok": true,
                "bookmarkToolbar": registry.bookmark_toolbar(),
                "receipt": receipt,
            }))
            .into_response()
        }
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "ok": false, "error": e })),
        )
            .into_response(),
    }
}

pub(crate) async fn browser_bookmarks_delete_http(
    State(s): State<ApiState>,
    AxumPath(bookmark_id): AxumPath<String>,
) -> Response {
    let registry = match browser_registry(&s) {
        Ok(registry) => registry,
        Err(response) => return *response,
    };
    match registry.delete_bookmark(&bookmark_id) {
        Ok(receipt) => {
            emit_browser_latest(&s, &registry);
            Json(serde_json::json!({ "ok": true, "receipt": receipt })).into_response()
        }
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "ok": false, "error": e })),
        )
            .into_response(),
    }
}

pub(crate) async fn browser_privacy_get_http(State(s): State<ApiState>) -> Response {
    let registry = match browser_registry(&s) {
        Ok(registry) => registry,
        Err(response) => return *response,
    };
    Json(serde_json::json!({
        "privacy": registry.privacy(),
    }))
    .into_response()
}

pub(crate) async fn browser_privacy_post_http(
    State(s): State<ApiState>,
    Json(body): Json<crate::shellx_browser::BrowserPrivacyUpdateRequest>,
) -> Response {
    let _ = (s, body);
    (
        StatusCode::FORBIDDEN,
        Json(serde_json::json!({
            "ok": false,
            "error": {
                "code": crate::shellx_browser_privacy::BROWSER_PRIVACY_OPERATOR_ERROR_CODE,
                "message": crate::shellx_browser_privacy::BROWSER_PRIVACY_OPERATOR_ERROR_MESSAGE
            }
        })),
    )
        .into_response()
}

pub(crate) async fn browser_personal_lock_get_http(State(s): State<ApiState>) -> Response {
    let registry = match browser_registry(&s) {
        Ok(registry) => registry,
        Err(response) => return *response,
    };
    Json(serde_json::json!({
        "personalLock": registry.state().personal_lock,
    }))
    .into_response()
}

pub(crate) async fn browser_personal_lock_post_http(
    State(s): State<ApiState>,
    Json(body): Json<crate::shellx_browser::BrowserPersonalLockUpdateRequest>,
) -> Response {
    let _ = (s, body);
    (
        StatusCode::FORBIDDEN,
        Json(serde_json::json!({
            "ok": false,
            "error": {
                "code": crate::shellx_browser_personal_lock::BROWSER_PERSONAL_LOCK_OPERATOR_ERROR_CODE,
                "message": crate::shellx_browser_personal_lock::BROWSER_PERSONAL_LOCK_OPERATOR_ERROR_MESSAGE
            }
        })),
    )
        .into_response()
}

pub(crate) async fn browser_engine_pool_get_http(State(s): State<ApiState>) -> Response {
    let registry = match browser_registry(&s) {
        Ok(registry) => registry,
        Err(response) => return *response,
    };
    Json(serde_json::json!({
        "enginePool": registry.state().engine_pool,
    }))
    .into_response()
}

pub(crate) async fn browser_engine_pool_post_http(
    State(s): State<ApiState>,
    Json(body): Json<crate::shellx_browser::BrowserEnginePoolUpdateRequest>,
) -> Response {
    let registry = match browser_registry(&s) {
        Ok(registry) => registry,
        Err(response) => return *response,
    };
    match registry.update_engine_pool(body) {
        Ok(engine_pool) => {
            emit_browser_latest(&s, &registry);
            Json(serde_json::json!({ "enginePool": engine_pool })).into_response()
        }
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "ok": false, "error": e })),
        )
            .into_response(),
    }
}

pub(crate) async fn browser_shields_get_http(State(s): State<ApiState>) -> Response {
    let registry = match browser_registry(&s) {
        Ok(registry) => registry,
        Err(response) => return *response,
    };
    Json(serde_json::json!({
        "shields": registry.shields(),
    }))
    .into_response()
}

pub(crate) async fn browser_shields_post_http(
    State(s): State<ApiState>,
    Json(body): Json<crate::shellx_browser::BrowserShieldUpdateRequest>,
) -> Response {
    let _ = (s, body);
    (
        StatusCode::FORBIDDEN,
        Json(serde_json::json!({
            "ok": false,
            "error": {
                "code": crate::shellx_browser_shields::BROWSER_SHIELDS_OPERATOR_ERROR_CODE,
                "message": crate::shellx_browser_shields::BROWSER_SHIELDS_OPERATOR_ERROR_MESSAGE
            }
        })),
    )
        .into_response()
}

pub(crate) async fn browser_shields_site_post_http(
    State(s): State<ApiState>,
    Json(body): Json<crate::shellx_browser::BrowserSiteShieldOverrideRequest>,
) -> Response {
    let _ = (s, body);
    (
        StatusCode::FORBIDDEN,
        Json(serde_json::json!({
            "ok": false,
            "error": {
                "code": crate::shellx_browser_shields::BROWSER_SHIELDS_OPERATOR_ERROR_CODE,
                "message": crate::shellx_browser_shields::BROWSER_SHIELDS_OPERATOR_ERROR_MESSAGE
            }
        })),
    )
        .into_response()
}

pub(crate) async fn browser_shields_site_delete_http(
    State(s): State<ApiState>,
    AxumPath(host): AxumPath<String>,
) -> Response {
    let _ = (s, host);
    (
        StatusCode::FORBIDDEN,
        Json(serde_json::json!({
            "ok": false,
            "error": {
                "code": crate::shellx_browser_shields::BROWSER_SHIELDS_OPERATOR_ERROR_CODE,
                "message": crate::shellx_browser_shields::BROWSER_SHIELDS_OPERATOR_ERROR_MESSAGE
            }
        })),
    )
        .into_response()
}

pub(crate) async fn browser_developer_mode_get_http(State(s): State<ApiState>) -> Response {
    let registry = match browser_registry(&s) {
        Ok(registry) => registry,
        Err(response) => return *response,
    };
    Json(serde_json::json!({
        "developerMode": registry.developer_mode(),
    }))
    .into_response()
}

pub(crate) async fn browser_developer_mode_post_http(
    State(s): State<ApiState>,
    Json(body): Json<crate::shellx_browser::BrowserDeveloperModeUpdateRequest>,
) -> Response {
    let _ = (s, body);
    (
        StatusCode::FORBIDDEN,
        Json(serde_json::json!({
            "ok": false,
            "error": {
                "code": crate::shellx_browser_developer_mode::BROWSER_DEVELOPER_MODE_OPERATOR_ERROR_CODE,
                "message": crate::shellx_browser_developer_mode::BROWSER_DEVELOPER_MODE_OPERATOR_ERROR_MESSAGE
            }
        })),
    )
        .into_response()
}

pub(crate) async fn browser_developer_mode_approval_http(
    State(s): State<ApiState>,
    Json(body): Json<crate::shellx_browser::BrowserDeveloperModeApprovalRequest>,
) -> Response {
    let _ = (s, body);
    (
        StatusCode::FORBIDDEN,
        Json(serde_json::json!({
            "ok": false,
            "error": {
                "code": crate::shellx_browser_developer_mode::BROWSER_DEVELOPER_MODE_OPERATOR_ERROR_CODE,
                "message": crate::shellx_browser_developer_mode::BROWSER_DEVELOPER_MODE_OPERATOR_ERROR_MESSAGE
            }
        })),
    )
        .into_response()
}
