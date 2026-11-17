// Debug API UI patch schema. Unknown fields are rejected through
// `deny_unknown_fields`.

use serde::{Deserialize, Serialize};

use super::{
    DebugHighlightRequest, DebugHighlightResult, PanelSizes, PreviewTarget, UiActiveTabContext,
    UiOpenTabContext,
};

/// Unlike the observed tab context, this wire type preserves omitted fields.
/// In particular, an omitted connection keeps the preset; explicit null clears it.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UiActiveTabPatch {
    pub tab_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub autonomy: Option<String>,
    #[serde(
        default,
        deserialize_with = "present_connection_id",
        skip_serializing_if = "Option::is_none"
    )]
    pub connection_id: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub connection_label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub connection_transport: Option<String>,
}

fn present_connection_id<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Option<String>>, D::Error> {
    Option::<String>::deserialize(deserializer).map(Some)
}

impl UiActiveTabPatch {
    pub fn apply_to(&self, previous: Option<&UiActiveTabContext>) -> UiActiveTabContext {
        let mut next = previous
            .filter(|tab| tab.tab_id == self.tab_id)
            .cloned()
            .unwrap_or_else(|| UiActiveTabContext {
                tab_id: self.tab_id.clone(),
                cwd: None,
                autonomy: None,
                connection_id: None,
                connection_label: None,
                connection_transport: None,
            });
        if let Some(value) = &self.cwd {
            next.cwd = Some(value.clone());
        }
        if let Some(value) = &self.autonomy {
            next.autonomy = Some(value.clone());
        }
        if let Some(value) = &self.connection_id {
            next.connection_id = value.clone();
        }
        if let Some(value) = &self.connection_label {
            next.connection_label = Some(value.clone());
        }
        if let Some(value) = &self.connection_transport {
            next.connection_transport = Some(value.clone());
        }
        next
    }
}

// Renderer reports describe what happened; only explicit operator fields enter
// this bounded delivery stream. Never reconstruct commands from merged UiState.
pub const UI_COMMAND_MAX_BYTES: usize = 64 * 1024;
const UI_COMMAND_STREAM_MAX_BYTES: usize = 128 * 1024;
const UI_COMMAND_STREAM_MAX_ENTRIES: usize = 64;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UiCommand {
    pub sequence: u64,
    pub patch: serde_json::Value,
    #[serde(skip)]
    bytes: usize,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UiCommandStream {
    pub epoch: String,
    pub sequence: u64,
    pub commands: std::collections::VecDeque<UiCommand>,
    #[serde(skip)]
    bytes: usize,
}

impl Default for UiCommandStream {
    fn default() -> Self {
        Self {
            epoch: uuid::Uuid::new_v4().to_string(),
            sequence: 0,
            commands: std::collections::VecDeque::new(),
            bytes: 0,
        }
    }
}

impl UiCommandStream {
    pub fn record(&mut self, patch: &UiStatePatch) -> Result<(), &'static str> {
        let source = patch
            .source
            .as_deref()
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase();
        if source == "renderer" || source.starts_with("renderer-") || source == "shellx-browser-ui"
        {
            return Ok(());
        }
        let mut value = serde_json::to_value(patch).map_err(|_| "invalid_ui_command")?;
        let fields = value.as_object_mut().ok_or("invalid_ui_command")?;
        fields.retain(|key, value| {
            !value.is_null()
                && matches!(
                    key.as_str(),
                    "panels"
                        | "preview"
                        | "clearPreview"
                        | "autonomy"
                        | "bottomTab"
                        | "leftTab"
                        | "rightTab"
                        | "activeTabId"
                        | "activeTab"
                        | "debugHighlights"
                        | "openModal"
                        | "composerMenu"
                        | "debugClick"
                        | "debugInput"
                        | "debugDrag"
                        | "debugSurface"
                        | "clickSelector"
                        | "cwdPicker"
                        | "vaultRequestCenterOpen"
                        | "setupGuideDismissed"
                        | "refreshPastChats"
                        | "source"
                )
        });
        if !fields
            .keys()
            .any(|key| !matches!(key.as_str(), "source" | "debugSurface"))
        {
            return Ok(());
        }
        let bytes = serde_json::to_vec(&value)
            .map_err(|_| "invalid_ui_command")?
            .len();
        if bytes > UI_COMMAND_MAX_BYTES {
            return Err("ui_command_too_large");
        }
        self.sequence += 1;
        self.commands.push_back(UiCommand {
            sequence: self.sequence,
            patch: value,
            bytes,
        });
        self.bytes += bytes;
        while self.commands.len() > UI_COMMAND_STREAM_MAX_ENTRIES
            || self.bytes > UI_COMMAND_STREAM_MAX_BYTES
        {
            if let Some(command) = self.commands.pop_front() {
                self.bytes -= command.bytes;
            }
        }
        Ok(())
    }
}

/// Partial UI patch — every field optional so callers can update only
/// what changed. The renderer POSTs this to /panels, /preview, /autonomy
/// etc and the debug driver reads /state/* to verify.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UiStatePatch {
    pub panels: Option<PanelSizes>,
    pub preview: Option<PreviewTarget>,
    #[serde(
        rename = "clearPreview",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub clear_preview: Option<bool>,
    pub autonomy: Option<String>,
    #[serde(rename = "bottomTab", default)]
    pub bottom_tab: Option<String>,
    #[serde(rename = "leftTab", default)]
    pub left_tab: Option<String>,
    #[serde(rename = "rightTab", default)]
    pub right_tab: Option<String>,
    #[serde(rename = "activeTabId", default)]
    pub active_tab_id: Option<String>,
    #[serde(rename = "activeTab", default)]
    pub active_tab: Option<UiActiveTabPatch>,
    #[serde(rename = "openTabs", default)]
    pub open_tabs: Option<Vec<UiOpenTabContext>>,
    /// Debug-driver tutorial/demo callouts. Stored in UiState so a
    /// screenshot script can verify which selectors resolved.
    #[serde(rename = "debugHighlights", default)]
    pub debug_highlights: Option<Vec<DebugHighlightRequest>>,
    /// Renderer-reported resolution state for the current callouts.
    #[serde(rename = "debugHighlightResults", default)]
    pub debug_highlight_results: Option<Vec<DebugHighlightResult>>,









    /// Renderer-reported receipts for trusted-operator diagnostic actions.
    #[serde(rename = "debugActionResults", default)]
    pub debug_action_results: Option<Vec<serde_json::Value>>,
    /// Debug-driver renderer command for composer popovers such as
    /// connection/agent/branch. Relayed only; not persisted in UiState.
    #[serde(rename = "composerMenu", default)]
    pub composer_menu: Option<String>,
    /// Debug-driver renderer command for App-level modals such as
    /// settings/help/palette/assets. Relayed only; not persisted in UiState.
    #[serde(rename = "openModal", default)]
    pub open_modal: Option<String>,


    /// Debug-driver renderer command for opening the non-approval Vault
    /// Request Center popover. Approval/deny buttons remain human-only.
    #[serde(rename = "vaultRequestCenterOpen", default)]
    pub vault_request_center_open: Option<bool>,
    /// Debug-driver renderer command for resetting or dismissing the
    /// first-run setup guide before UI evidence capture.
    #[serde(rename = "setupGuideDismissed", default)]
    pub setup_guide_dismissed: Option<bool>,
    /// Debug-driver renderer command for rescanning the bounded stored-session
    /// index after an owned history file is created or removed. Relayed only;
    /// no transcript content is accepted or returned through this field.
    #[serde(rename = "refreshPastChats", default)]
    pub refresh_past_chats: Option<bool>,









    /// Trusted-operator bounded DOM click diagnostic. Relayed only; not persisted in UiState.
    #[serde(rename = "debugClick", default)]
    pub debug_click: Option<serde_json::Value>,
    /// Trusted-operator bounded DOM input diagnostic. Relayed only; not persisted in UiState.
    #[serde(rename = "debugInput", default)]
    pub debug_input: Option<serde_json::Value>,
    /// Trusted-operator bounded DOM drag diagnostic. Relayed only; not persisted in UiState.
    #[serde(rename = "debugDrag", default)]
    pub debug_drag: Option<serde_json::Value>,
    /// Optional renderer surface for trusted-operator diagnostic commands. Relayed only;
    /// not persisted in UiState. Supported values are frontend-owned, e.g.
    /// "browser" for the standalone ShellX Browser chrome.
    #[serde(rename = "debugSurface", default)]
    pub debug_surface: Option<String>,
    /// Legacy trusted-operator diagnostic alias for debugClick.
    #[serde(rename = "clickSelector", default)]
    pub click_selector: Option<serde_json::Value>,
    /// Debug-driver renderer command. The backend only relays this
    /// through `debug-ui-state-patch`; it is intentionally not stored
    /// in UiState because modal-open state is transient.
    #[serde(rename = "cwdPicker", default)]
    pub cwd_picker: Option<serde_json::Value>,
    /// Optional mutation source for debug receipts. Renderer-originated
    /// patches set this to "renderer"; external drivers can set their own
    /// stable label.
    #[serde(default)]
    pub source: Option<String>,
    /// Explicit opt-in for automation that intentionally changes cwd or
    /// connection metadata on a tab with an active Build Mode run.
    #[serde(rename = "allowBuildTabMutation", default)]
    pub allow_build_tab_mutation: Option<bool>,
}
