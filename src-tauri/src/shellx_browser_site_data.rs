use serde::Deserialize;
#[cfg(windows)]
use serde_json::json;
use tauri::AppHandle;

use crate::shellx_browser::{clean_string, eval_browser_engine_json};
use crate::shellx_browser_actions::EngineControlResult;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PageOriginInfo {
    origin: String,
    url: Option<String>,
    title: Option<String>,
}

async fn page_origin_info(app: &AppHandle, engine_label: &str) -> Result<PageOriginInfo, String> {
    let value = eval_browser_engine_json(
        app,
        engine_label,
        "(() => ({ origin: location.origin, url: location.href, title: document.title || location.href }))()",
    )
    .await?;
    let info: PageOriginInfo = serde_json::from_value(value)
        .map_err(|error| format!("Browser clear-site origin parse failed: {error}"))?;
    let origin = clean_string(&info.origin);
    if !origin.starts_with("https://") && !origin.starts_with("http://") {
        return Err("Browser clear-site data requires an http/https origin".to_string());
    }
    Ok(PageOriginInfo { origin, ..info })
}

#[cfg(windows)]
pub(crate) async fn clear_browser_site_data(
    app: &AppHandle,
    engine_label: &str,
) -> Result<EngineControlResult, String> {
    use crate::shellx_browser_actions::call_browser_engine_cdp;

    let info = page_origin_info(app, engine_label).await?;
    let mut steps = Vec::new();
    match call_browser_engine_cdp(app, engine_label, "Network.clearBrowserCache", json!({})) {
        Ok(_) => steps.push("browser cache cleared".to_string()),
        Err(error) => steps.push(format!("browser cache clear skipped: {error}")),
    }
    call_browser_engine_cdp(
        app,
        engine_label,
        "Storage.clearDataForOrigin",
        json!({
            "origin": info.origin,
            "storageTypes": "appcache,cache_storage,file_systems,indexeddb,local_storage,service_workers,shader_cache,websql"
        }),
    )?;
    steps.push("non-cookie origin storage cleared".to_string());
    call_browser_engine_cdp(
        app,
        engine_label,
        "Page.reload",
        json!({ "ignoreCache": true }),
    )?;
    steps.push("page reloaded ignoring cache".to_string());
    Ok(site_data_result(info, steps.join("; ")))
}

#[cfg(not(windows))]
pub(crate) async fn clear_browser_site_data(
    app: &AppHandle,
    engine_label: &str,
) -> Result<EngineControlResult, String> {
    use tokio::time::{sleep, Duration, Instant};

    let info = page_origin_info(app, engine_label).await?;
    let scheduled =
        eval_browser_engine_json(app, engine_label, WEBKIT_SITE_DATA_CLEAR_SCRIPT).await?;
    if scheduled.get("scheduled").and_then(|value| value.as_bool()) != Some(true) {
        return Err("Browser WebKit site-data cleanup did not schedule".to_string());
    }
    let deadline = Instant::now() + Duration::from_secs(6);
    let (operations, failures) = loop {
        let state = eval_browser_engine_json(
            app,
            engine_label,
            "(() => window.__shellxSiteDataClearState || { status: 'missing' })()",
        )
        .await?;
        if state.get("status").and_then(|value| value.as_str()) == Some("done") {
            break (
                state
                    .get("operations")
                    .and_then(|value| value.as_u64())
                    .unwrap_or(0),
                state
                    .get("failures")
                    .and_then(|value| value.as_u64())
                    .unwrap_or(0),
            );
        }
        if Instant::now() >= deadline {
            return Err("Browser WebKit site-data cleanup timed out".to_string());
        }
        sleep(Duration::from_millis(50)).await;
    };
    eval_browser_engine_json(
        app,
        engine_label,
        "(() => { setTimeout(() => location.reload(), 0); return true; })()",
    )
    .await?;
    Ok(site_data_result(
        info,
        format!(
            "origin storage cleanup completed ({operations} operation(s), {failures} skipped); cookies preserved; page reload requested"
        ),
    ))
}

fn site_data_result(info: PageOriginInfo, detail: String) -> EngineControlResult {
    EngineControlResult {
        ok: true,
        status: "applied".to_string(),
        message: Some(format!("site application data recovery applied: {detail}")),
        url: info.url,
        title: info.title,
        ..EngineControlResult::default()
    }
}

#[cfg(not(windows))]
const WEBKIT_SITE_DATA_CLEAR_SCRIPT: &str = r#"
(() => {
  const stateKey = "__shellxSiteDataClearState";
  const jobs = [];
  let synchronousOperations = 0;
  let synchronousFailures = 0;
  const attempt = (operation) => {
    try { operation(); synchronousOperations += 1; } catch (_) { synchronousFailures += 1; }
  };
  attempt(() => localStorage.clear());
  attempt(() => sessionStorage.clear());
  if (globalThis.caches?.keys) {
    jobs.push(caches.keys().then((keys) => Promise.all(keys.map((key) => caches.delete(key)))));
  }
  if (navigator.serviceWorker?.getRegistrations) {
    jobs.push(navigator.serviceWorker.getRegistrations().then((items) => Promise.all(items.map((item) => item.unregister()))));
  }
  if (globalThis.indexedDB?.databases) {
    jobs.push(indexedDB.databases().then((items) => Promise.all(items.map((item) => new Promise((resolve) => {
      if (!item.name) return resolve(true);
      const request = indexedDB.deleteDatabase(item.name);
      request.onsuccess = () => resolve(true);
      request.onerror = () => resolve(false);
      request.onblocked = () => resolve(false);
    })))));
  }
  window[stateKey] = { status: "running" };
  Promise.allSettled(jobs).then((results) => {
    const asynchronousFailures = results.filter((item) => item.status === "rejected"
      || (Array.isArray(item.value) && item.value.some((value) => value === false))).length;
    window[stateKey] = {
      status: "done",
      operations: synchronousOperations + results.length,
      failures: synchronousFailures + asynchronousFailures
    };
  });
  return { scheduled: true };
})()
"#;
