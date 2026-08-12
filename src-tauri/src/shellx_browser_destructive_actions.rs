use crate::shellx_browser::{
    BrowserClearHistoryRequest, BrowserHistoryScope, BrowserReceipt, ShellxBrowserRegistry,
};

pub const BROWSER_DESTRUCTIVE_ACTION_OPERATOR_ERROR_CODE: &str =
    "browser_destructive_action_requires_operator";
pub const BROWSER_DESTRUCTIVE_ACTION_OPERATOR_ERROR_MESSAGE: &str =
    "Browser destructive actions must be performed by the ShellX operator UI";

pub fn browser_destructive_action_requires_operator(_request: &BrowserClearHistoryRequest) -> bool {
    true
}

pub fn mark_browser_destructive_action_operator_approved(request: &mut BrowserClearHistoryRequest) {
    request.operator_approved = true;
}

pub fn clear_browser_history_from_operator(
    registry: &ShellxBrowserRegistry,
    scope: BrowserHistoryScope,
) -> Result<BrowserReceipt, String> {
    let mut request = BrowserClearHistoryRequest {
        scope,
        operator_approved: false,
    };
    mark_browser_destructive_action_operator_approved(&mut request);
    registry.clear_history(request)
}
