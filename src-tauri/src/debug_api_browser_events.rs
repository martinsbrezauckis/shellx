use crate::debug_api::ApiState;

pub(crate) fn emit_browser_receipt(
    state: &ApiState,
    receipt: &crate::shellx_browser::BrowserReceipt,
) {
    let payload = serde_json::json!({
        "revision": format!("state-{}", receipt.receipt_id),
        "receipt": receipt,
    });
    state
        .hub()
        .record_raw_event("browser-event", payload.clone());
    let _ = tauri::Emitter::emit(state.app(), "browser-event", payload);
}

pub(crate) fn emit_browser_recent_for_task(
    state: &ApiState,
    registry: &crate::shellx_browser::ShellxBrowserRegistry,
    task_id: &str,
    count: usize,
) {
    let mut receipts = registry
        .receipts(Some(20))
        .into_iter()
        .filter(|receipt| receipt.task_id.as_deref() == Some(task_id))
        .collect::<Vec<_>>();
    receipts.truncate(count);
    receipts.reverse();
    for receipt in receipts {
        emit_browser_receipt(state, &receipt);
    }
}

pub(crate) fn emit_browser_latest(
    state: &ApiState,
    registry: &crate::shellx_browser::ShellxBrowserRegistry,
) {
    if let Some(receipt) = registry.receipts(Some(1)).into_iter().next() {
        emit_browser_receipt(state, &receipt);
    }
}
