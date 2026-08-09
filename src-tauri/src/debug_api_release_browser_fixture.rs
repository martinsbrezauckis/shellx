//! Fixed Browser child-webview fixture for frozen installed-candidate tests.
//!
//! Native WebDriver attaches to ShellX's top-level windows, not the embedded
//! Browser page webview. This route provides only the two operations the
//! exhaustive Vault-fill oracle needs: install a fixed form on one exact test
//! origin, or read a fixed field's hash and input-event count. It accepts no
//! JavaScript, selector, URL, or secret material and is unavailable outside the
//! strictly validated isolated release profile.

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::{Json, Router};
use serde::{Deserialize, Serialize};

use crate::debug_api::{browser_registry, ApiState};
use crate::shellx_browser::{
    eval_browser_engine_json, BrowserEngineTabState, BrowserTabOwnerKind, BrowserTabSnapshot,
};
use crate::shellx_browser_engine::browser_engine_webview_label;

const TRUSTED_ORIGIN: &str = "https://example.com";

const PREPARE_SCRIPT: &str = r#"
(() => {
  const expectedOrigin = "https://example.com";
  if (location.origin !== expectedOrigin || !window.isSecureContext || document.readyState !== "complete") {
    return { ok: false, trusted: false, origin: expectedOrigin, inputs: 0, secretExposed: false };
  }
  document.title = "ShellX Trusted Vault Fill Fixture";
  document.body.replaceChildren();
  const main = document.createElement("main");
  main.setAttribute("data-shellx-release-fixture", "trusted-vault-fill-v1");
  main.innerHTML = '<h1>ShellX trusted Vault fill fixture</h1>'
    + '<label for="shellx-release-profile-email">Profile email</label>'
    + '<input id="shellx-release-profile-email" name="profile-email" type="email" autocomplete="email" />'
    + '<label for="shellx-release-vault-password">Password</label>'
    + '<input id="shellx-release-vault-password" name="password" type="password" autocomplete="current-password" aria-label="ShellX release password" />';
  document.body.append(main);
  const encodeHash = async (element) => {
    const bytes = new TextEncoder().encode(String(element.value || ""));
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    element.dataset.shellxValueSha256 = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
    element.dataset.shellxInputEvents = String(Number(element.dataset.shellxInputEvents || "0") + 1);
  };
  for (const element of main.querySelectorAll("input")) {
    element.addEventListener("input", () => void encodeHash(element));
    element.addEventListener("change", () => void encodeHash(element));
  }
  return { ok: true, trusted: true, origin: expectedOrigin, inputs: main.querySelectorAll("input").length, secretExposed: false };
})()
"#;

const PASSWORD_PROOF_SCRIPT: &str = r##"
(() => {
  const fixture = document.querySelector('main[data-shellx-release-fixture="trusted-vault-fill-v1"]');
  const element = fixture && fixture.querySelector("#shellx-release-vault-password");
  return {
    ok: true,
    fixture: Boolean(fixture),
    field: "password",
    present: Boolean(element),
    hash: element ? String(element.dataset.shellxValueSha256 || "") : "",
    events: element ? Number(element.dataset.shellxInputEvents || "0") : 0,
    secretExposed: false,
  };
})()
"##;

const PROFILE_PROOF_SCRIPT: &str = r##"
(() => {
  const fixture = document.querySelector('main[data-shellx-release-fixture="trusted-vault-fill-v1"]');
  const element = fixture && fixture.querySelector("#shellx-release-profile-email");
  return {
    ok: true,
    fixture: Boolean(fixture),
    field: "profileEmail",
    present: Boolean(element),
    hash: element ? String(element.dataset.shellxValueSha256 || "") : "",
    events: element ? Number(element.dataset.shellxInputEvents || "0") : 0,
    secretExposed: false,
  };
})()
"##;

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
enum FixtureAction {
    Prepare,
    Proof,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
enum FixtureField {
    Password,
    ProfileEmail,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FixtureRequest {
    action: FixtureAction,
    #[serde(rename = "browserTabId")]
    browser_tab_id: String,
    #[serde(rename = "taskId", default)]
    task_id: Option<String>,
    #[serde(default)]
    field: Option<FixtureField>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PrepareResult {
    ok: bool,
    trusted: bool,
    origin: String,
    inputs: u8,
    secret_exposed: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProofResult {
    ok: bool,
    fixture: bool,
    field: FixtureField,
    present: bool,
    hash: String,
    events: u32,
    secret_exposed: bool,
}

#[derive(Debug)]
struct FixtureTarget {
    browser_tab_id: String,
    task_id: Option<String>,
    engine_label: String,
}

#[derive(Clone, Copy, Debug)]
struct TargetFacts<'a> {
    requested_browser_tab_id: &'a str,
    requested_task_id: Option<&'a str>,
    active_browser_tab_id: Option<&'a str>,
    active_task_id: Option<&'a str>,
    tab: &'a BrowserTabSnapshot,
    engine_mounted: bool,
    engine_browser_tab_id: Option<&'a str>,
    engine_task_id: Option<&'a str>,
    engine_label: &'a str,
    expected_engine_label: &'a str,
    engine_load_status: &'a str,
}

#[derive(Clone, Debug)]
struct FixtureError {
    status: StatusCode,
    code: &'static str,
    message: &'static str,
}

impl FixtureError {
    fn unavailable() -> Self {
        Self {
            status: StatusCode::NOT_FOUND,
            code: "release_test_route_unavailable",
            message: "release-test route is unavailable outside an isolated test instance",
        }
    }

    fn invalid(code: &'static str, message: &'static str) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            code,
            message,
        }
    }

    fn conflict(code: &'static str, message: &'static str) -> Self {
        Self {
            status: StatusCode::CONFLICT,
            code,
            message,
        }
    }

    fn into_response(self) -> Response {
        (
            self.status,
            Json(serde_json::json!({
                "ok": false,
                "error": self.code,
                "message": self.message,
                "secretExposed": false,
            })),
        )
            .into_response()
    }
}

pub(crate) fn release_browser_fixture_routes() -> Router<ApiState> {
    Router::new().route(
        "/release-test/browser/trusted-vault-fixture",
        post(fixture_http),
    )
}

async fn fixture_http(State(state): State<ApiState>, Json(body): Json<FixtureRequest>) -> Response {
    if let Err(error) = ensure_release_test_available(crate::isolated_test_instance_requested()) {
        return error.into_response();
    }
    if let Err(error) = validate_action_field(body.action, body.field) {
        return error.into_response();
    }
    let registry = match browser_registry(&state) {
        Ok(registry) => registry,
        Err(response) => return *response,
    };
    let target = match resolve_target(&registry.state(), &body) {
        Ok(target) => target,
        Err(error) => return error.into_response(),
    };
    let script = match (body.action, body.field) {
        (FixtureAction::Prepare, None) => PREPARE_SCRIPT,
        (FixtureAction::Proof, Some(FixtureField::Password)) => PASSWORD_PROOF_SCRIPT,
        (FixtureAction::Proof, Some(FixtureField::ProfileEmail)) => PROFILE_PROOF_SCRIPT,
        _ => unreachable!("action/field pair validated above"),
    };
    let value = match eval_browser_engine_json(state.app(), &target.engine_label, script).await {
        Ok(value) => value,
        Err(_) => {
            return FixtureError::conflict(
                "release_browser_fixture_execution_failed",
                "fixed Browser fixture action failed on the bound child webview",
            )
            .into_response()
        }
    };
    match body.action {
        FixtureAction::Prepare => prepare_response(value, target),
        FixtureAction::Proof => proof_response(value, target, body.field.expect("validated field")),
    }
}

fn ensure_release_test_available(available: bool) -> Result<(), FixtureError> {
    available
        .then_some(())
        .ok_or_else(FixtureError::unavailable)
}

fn validate_action_field(
    action: FixtureAction,
    field: Option<FixtureField>,
) -> Result<(), FixtureError> {
    match (action, field) {
        (FixtureAction::Prepare, None) | (FixtureAction::Proof, Some(_)) => Ok(()),
        (FixtureAction::Prepare, Some(_)) => Err(FixtureError::invalid(
            "release_browser_fixture_prepare_field_forbidden",
            "prepare accepts no field selector",
        )),
        (FixtureAction::Proof, None) => Err(FixtureError::invalid(
            "release_browser_fixture_proof_field_required",
            "proof requires one fixed field name",
        )),
    }
}

fn resolve_target(
    snapshot: &crate::shellx_browser::BrowserStateSnapshot,
    request: &FixtureRequest,
) -> Result<FixtureTarget, FixtureError> {
    let browser_tab_id = request.browser_tab_id.trim();
    if browser_tab_id.is_empty() || browser_tab_id.len() > 200 {
        return Err(FixtureError::invalid(
            "release_browser_fixture_invalid_tab",
            "browserTabId is absent or invalid",
        ));
    }
    let requested_task_id = request
        .task_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if request.task_id.is_some() && requested_task_id.is_none() {
        return Err(FixtureError::invalid(
            "release_browser_fixture_invalid_task",
            "taskId is empty or invalid",
        ));
    }
    let tab = snapshot
        .tabs
        .iter()
        .find(|tab| tab.browser_tab_id == browser_tab_id)
        .ok_or_else(|| {
            FixtureError::conflict(
                "release_browser_fixture_tab_missing",
                "the requested Browser tab is not present",
            )
        })?;
    let expected_engine_label = browser_engine_webview_label(&tab.engine_id);
    let engine = snapshot
        .engine_pool
        .engines
        .iter()
        .find(|engine| engine.engine_id == tab.engine_id)
        .ok_or_else(|| {
            FixtureError::conflict(
                "release_browser_fixture_engine_missing",
                "the requested Browser tab has no mounted engine",
            )
        })?;
    validate_target_facts(TargetFacts {
        requested_browser_tab_id: browser_tab_id,
        requested_task_id,
        active_browser_tab_id: snapshot.active_browser_tab_id.as_deref(),
        active_task_id: snapshot.active_task_id.as_deref(),
        tab,
        engine_mounted: engine.mounted,
        engine_browser_tab_id: engine.browser_tab_id.as_deref(),
        engine_task_id: engine.task_id.as_deref(),
        engine_label: &engine.webview_label,
        expected_engine_label: &expected_engine_label,
        engine_load_status: &engine.load_status,
    })?;
    Ok(FixtureTarget {
        browser_tab_id: browser_tab_id.to_string(),
        task_id: requested_task_id.map(str::to_string),
        engine_label: expected_engine_label,
    })
}

fn validate_target_facts(facts: TargetFacts<'_>) -> Result<(), FixtureError> {
    let tab = facts.tab;
    if facts.active_browser_tab_id != Some(facts.requested_browser_tab_id) || !tab.active {
        return Err(FixtureError::conflict(
            "release_browser_fixture_tab_not_active",
            "the requested Browser tab is not the active child webview",
        ));
    }
    if tab.task_id.as_deref() != facts.requested_task_id {
        return Err(FixtureError::conflict(
            "release_browser_fixture_task_mismatch",
            "taskId does not own the requested Browser tab",
        ));
    }
    match facts.requested_task_id {
        Some(task_id)
            if facts.active_task_id == Some(task_id)
                && tab.owner_kind == BrowserTabOwnerKind::Agent
                && tab.profile_id == "task-disposable" => {}
        None if tab.owner_kind == BrowserTabOwnerKind::User && tab.profile_id == "personal" => {}
        _ => {
            return Err(FixtureError::conflict(
                "release_browser_fixture_owner_mismatch",
                "the requested Browser tab is not owned by the expected release fixture",
            ))
        }
    }
    if !trusted_tab(tab) {
        return Err(FixtureError::conflict(
            "release_browser_fixture_origin_denied",
            "the requested Browser tab is not the exact trusted HTTPS origin",
        ));
    }
    if tab.engine_state != BrowserEngineTabState::Live
        || !facts.engine_mounted
        || facts.engine_browser_tab_id != Some(facts.requested_browser_tab_id)
        || facts.engine_task_id != facts.requested_task_id
        || facts.engine_label != facts.expected_engine_label
        || facts.engine_load_status == "navigating"
    {
        return Err(FixtureError::conflict(
            "release_browser_fixture_engine_mismatch",
            "the mounted child webview does not match the active Browser tab and task",
        ));
    }
    Ok(())
}

fn trusted_tab(tab: &BrowserTabSnapshot) -> bool {
    let Some(url) = tab
        .url
        .as_deref()
        .and_then(|value| tauri::Url::parse(value).ok())
    else {
        return false;
    };
    url.scheme() == "https"
        && url.host_str() == Some("example.com")
        && url.port().is_none()
        && url.username().is_empty()
        && url.password().is_none()
        && tab.security_state.level == "secure"
        && tab.security_state.credential_entry_allowed
}

fn prepare_response(value: serde_json::Value, target: FixtureTarget) -> Response {
    let result = match serde_json::from_value::<PrepareResult>(value) {
        Ok(result)
            if result.ok
                && result.trusted
                && result.origin == TRUSTED_ORIGIN
                && result.inputs == 2
                && !result.secret_exposed =>
        {
            result
        }
        _ => {
            return FixtureError::conflict(
                "release_browser_fixture_prepare_failed",
                "the fixed form was not installed on the exact trusted HTTPS origin",
            )
            .into_response()
        }
    };
    Json(serde_json::json!({
        "ok": result.ok,
        "action": "prepare",
        "browserTabId": target.browser_tab_id,
        "taskId": target.task_id,
        "trusted": result.trusted,
        "origin": result.origin,
        "inputs": result.inputs,
        "secretExposed": false,
    }))
    .into_response()
}

fn proof_response(
    value: serde_json::Value,
    target: FixtureTarget,
    expected_field: FixtureField,
) -> Response {
    let result = match serde_json::from_value::<ProofResult>(value) {
        Ok(result)
            if result.ok
                && result.field == expected_field
                && !result.secret_exposed
                && result.events <= 1_000_000
                && (result.hash.is_empty()
                    || (result.hash.len() == 64
                        && result.hash.bytes().all(|byte| {
                            byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)
                        }))) =>
        {
            result
        }
        _ => {
            return FixtureError::conflict(
                "release_browser_fixture_proof_failed",
                "the fixed field proof returned an invalid redacted envelope",
            )
            .into_response()
        }
    };
    Json(serde_json::json!({
        "ok": result.ok,
        "action": "proof",
        "field": result.field,
        "browserTabId": target.browser_tab_id,
        "taskId": target.task_id,
        "fixture": result.fixture,
        "present": result.present,
        "hash": result.hash,
        "events": result.events,
        "secretExposed": false,
    }))
    .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shellx_browser::{BrowserAdMode, BrowserPageSecurityState, BrowserTabShieldState};

    #[test]
    fn route_is_unavailable_without_exact_test_instance() {
        let error = ensure_release_test_available(false).unwrap_err();
        assert_eq!(error.status, StatusCode::NOT_FOUND);
        assert_eq!(error.code, "release_test_route_unavailable");
    }

    #[test]
    fn request_schema_rejects_arbitrary_script_selector_and_url() {
        for extra in [
            r#""script":"alert(1)""#,
            r#""selector":"input""#,
            r#""url":"https://example.com/""#,
        ] {
            let body = format!(r#"{{"action":"prepare","browserTabId":"tab-1",{extra}}}"#);
            assert!(serde_json::from_str::<FixtureRequest>(&body).is_err());
        }
        assert!(serde_json::from_str::<FixtureRequest>(
            r#"{"action":"unknown","browserTabId":"tab-1"}"#
        )
        .is_err());
        assert!(serde_json::from_str::<FixtureRequest>(
            r#"{"action":"proof","browserTabId":"tab-1","field":"other"}"#
        )
        .is_err());
    }

    #[test]
    fn actions_require_their_exact_fixed_field_shape() {
        assert!(validate_action_field(FixtureAction::Prepare, None).is_ok());
        assert!(validate_action_field(FixtureAction::Proof, Some(FixtureField::Password)).is_ok());
        assert!(
            validate_action_field(FixtureAction::Prepare, Some(FixtureField::Password)).is_err()
        );
        assert!(validate_action_field(FixtureAction::Proof, None).is_err());
    }

    #[test]
    fn scripts_are_fixed_and_proof_never_reads_field_value() {
        assert!(PREPARE_SCRIPT.contains(TRUSTED_ORIGIN));
        assert!(PREPARE_SCRIPT.contains("ShellX Trusted Vault Fill Fixture"));
        assert!(PREPARE_SCRIPT.contains("trusted-vault-fill-v1"));
        assert!(PREPARE_SCRIPT.contains("shellx-release-vault-password"));
        assert!(PREPARE_SCRIPT.contains("shellx-release-profile-email"));
        assert!(!PREPARE_SCRIPT.contains("arguments["));
        for script in [PASSWORD_PROOF_SCRIPT, PROFILE_PROOF_SCRIPT] {
            assert!(!script.contains("arguments["));
            assert!(!script.contains("element.value"));
            assert!(script.contains("shellxValueSha256"));
            assert!(script.contains("shellxInputEvents"));
            assert!(script.contains("secretExposed: false"));
        }
    }

    #[test]
    fn target_binding_rejects_wrong_tab_task_origin_and_engine() {
        let mut tab = fixture_tab();
        assert!(validate_target_facts(fixture_facts(&tab)).is_ok());

        let mut facts = fixture_facts(&tab);
        facts.active_browser_tab_id = Some("other-tab");
        assert_eq!(
            validate_target_facts(facts).unwrap_err().code,
            "release_browser_fixture_tab_not_active"
        );

        tab.task_id = Some("other-task".to_string());
        assert_eq!(
            validate_target_facts(fixture_facts(&tab)).unwrap_err().code,
            "release_browser_fixture_task_mismatch"
        );
        tab.task_id = Some("task-1".to_string());

        tab.url = Some("https://other.example/".to_string());
        assert_eq!(
            validate_target_facts(fixture_facts(&tab)).unwrap_err().code,
            "release_browser_fixture_origin_denied"
        );
        tab.url = Some("https://example.com/".to_string());

        let mut facts = fixture_facts(&tab);
        facts.engine_browser_tab_id = Some("other-tab");
        assert_eq!(
            validate_target_facts(facts).unwrap_err().code,
            "release_browser_fixture_engine_mismatch"
        );
    }

    #[test]
    fn target_binding_accepts_only_expected_user_or_agent_ownership() {
        let mut tab = fixture_tab();
        tab.owner_kind = BrowserTabOwnerKind::User;
        assert_eq!(
            validate_target_facts(fixture_facts(&tab)).unwrap_err().code,
            "release_browser_fixture_owner_mismatch"
        );

        tab.task_id = None;
        tab.profile_id = "personal".to_string();
        let mut facts = fixture_facts(&tab);
        facts.requested_task_id = None;
        facts.active_task_id = None;
        facts.engine_task_id = None;
        assert!(validate_target_facts(facts).is_ok());

        tab.security_state.credential_entry_allowed = false;
        let mut facts = fixture_facts(&tab);
        facts.requested_task_id = None;
        facts.active_task_id = None;
        facts.engine_task_id = None;
        assert_eq!(
            validate_target_facts(facts).unwrap_err().code,
            "release_browser_fixture_origin_denied"
        );
    }

    fn fixture_tab() -> BrowserTabSnapshot {
        BrowserTabSnapshot {
            browser_tab_id: "tab-1".to_string(),
            engine_id: "browser-engine-foreground".to_string(),
            task_id: Some("task-1".to_string()),
            profile_id: "task-disposable".to_string(),
            url: Some("https://example.com/".to_string()),
            expected_domains: vec!["example.com".to_string()],
            title: Some("Example Domain".to_string()),
            status: "active".to_string(),
            active: true,
            security_state: BrowserPageSecurityState {
                level: "secure".to_string(),
                scheme: "https".to_string(),
                host: Some("example.com".to_string()),
                credential_entry_allowed: true,
                requires_separate_credential_approval: true,
                summary: "Secure HTTPS page".to_string(),
            },
            shields: BrowserTabShieldState::default(),
            engine_webview_label: Some("shellx-browser-page".to_string()),
            engine_state: BrowserEngineTabState::Live,
            last_visual_capture_at_ms: None,
            requires_user_attention: false,
            storage_root: None,
            privacy_mode: BrowserAdMode::Balanced,
            owner_kind: BrowserTabOwnerKind::Agent,
            delegated_task_id: None,
            delegated_grant_id: None,
            lock: None,
            created_at_ms: 1,
            updated_at_ms: 1,
        }
    }

    fn fixture_facts(tab: &BrowserTabSnapshot) -> TargetFacts<'_> {
        TargetFacts {
            requested_browser_tab_id: "tab-1",
            requested_task_id: Some("task-1"),
            active_browser_tab_id: Some("tab-1"),
            active_task_id: Some("task-1"),
            tab,
            engine_mounted: true,
            engine_browser_tab_id: Some("tab-1"),
            engine_task_id: Some("task-1"),
            engine_label: "shellx-browser-page",
            expected_engine_label: "shellx-browser-page",
            engine_load_status: "loaded",
        }
    }
}
