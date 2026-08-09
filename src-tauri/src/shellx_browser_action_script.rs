use serde::Serialize;

use crate::shellx_browser_actionability::BROWSER_ELEMENT_ACTIONABILITY_SCRIPT;
use crate::shellx_browser_coordinate_input::BROWSER_COORDINATE_INPUT_SCRIPT;
use crate::shellx_browser_dom_traversal::BROWSER_DOM_TRAVERSAL_SCRIPT;
use crate::shellx_browser_element_identity::BROWSER_ELEMENT_IDENTITY_SCRIPT;
use crate::shellx_browser_scripts::{BROWSER_ENGINE_CONTROL_SCRIPT, BROWSER_ENGINE_OBSERVE_SCRIPT};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EngineControlPayload {
    pub(crate) action: String,
    #[serde(default)]
    pub(crate) selector: Option<String>,
    #[serde(rename = "expectedFingerprint", default)]
    pub(crate) expected_fingerprint: Option<String>,
    #[serde(rename = "expectedOrigin", default)]
    pub(crate) expected_origin: Option<String>,
    #[serde(default)]
    pub(crate) locator: Option<String>,
    #[serde(default)]
    pub(crate) value: Option<String>,
    #[serde(default)]
    pub(crate) key: Option<String>,
    #[serde(default)]
    pub(crate) x: Option<f64>,
    #[serde(default)]
    pub(crate) y: Option<f64>,
    #[serde(default)]
    pub(crate) force: bool,
}

pub(crate) fn browser_engine_observe_script() -> String {
    inject_element_identity(BROWSER_ENGINE_OBSERVE_SCRIPT)
}

pub(crate) fn browser_engine_control_script(
    payload: &EngineControlPayload,
) -> Result<String, String> {
    let payload = serde_json::to_string(payload)
        .map_err(|e| format!("failed to serialize Browser engine action: {e}"))?;
    let script = inject_element_identity(
        &BROWSER_ENGINE_CONTROL_SCRIPT.replace("__SHELLX_BROWSER_REQUEST__", &payload),
    );
    Ok(script.replace(
        "__SHELLX_NATIVE_COORDINATE_INPUT__",
        if cfg!(windows) { "true" } else { "false" },
    ))
}

fn inject_element_identity(script: &str) -> String {
    script
        .replace(
            "__SHELLX_ELEMENT_IDENTITY__",
            BROWSER_ELEMENT_IDENTITY_SCRIPT,
        )
        .replace("__SHELLX_DOM_TRAVERSAL__", BROWSER_DOM_TRAVERSAL_SCRIPT)
        .replace(
            "__SHELLX_COORDINATE_INPUT__",
            BROWSER_COORDINATE_INPUT_SCRIPT,
        )
        .replace(
            "__SHELLX_ELEMENT_ACTIONABILITY__",
            BROWSER_ELEMENT_ACTIONABILITY_SCRIPT,
        )
}
