use serde_json::json;
use std::sync::Arc;
use std::time::Duration;
use tauri::{
    AppHandle, LogicalPosition, LogicalSize, Manager, Position, Size, WebviewUrl,
    WebviewWindowBuilder,
};
use tokio::sync::OwnedMutexGuard;

use crate::shellx_browser::{
    BrowserReceipt, BrowserWindowOpenResponse, BrowserWindowOpenTicket, ShellxBrowserRegistry,
    BROWSER_WINDOW_LABEL,
};

const BROWSER_WINDOW_OPEN_TIMEOUT_MS: u64 = 12_000;

#[derive(Clone, Debug)]
pub struct BrowserWindowOpenFailure {
    pub code: String,
    pub message: String,
    pub retryable: bool,
    pub timeout_ms: u64,
    pub diagnostics: serde_json::Value,
    pub receipt: BrowserReceipt,
}

impl BrowserWindowOpenFailure {
    pub fn as_json(&self) -> serde_json::Value {
        json!({
            "code": self.code,
            "message": self.message,
            "retryable": self.retryable,
            "timeoutMs": self.timeout_ms,
            "diagnostics": self.diagnostics,
        })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum BrowserWindowOpenDisposition {
    Existing,
    Created,
}

impl BrowserWindowOpenDisposition {
    fn as_str(self) -> &'static str {
        match self {
            Self::Existing => "existing",
            Self::Created => "created",
        }
    }
}

struct BrowserWindowOpenCompletion {
    guard: OwnedMutexGuard<()>,
    result: Result<BrowserWindowOpenDisposition, String>,
}

enum BrowserWindowOpenOperationResult {
    Completed(BrowserWindowOpenCompletion),
    TimedOut(tokio::task::JoinHandle<BrowserWindowOpenCompletion>),
    WorkerFailed(String),
}

enum LateBrowserWindowNativeState {
    Absent,
    Present(String),
}

pub async fn open_or_focus_browser_window_bounded(
    app: AppHandle,
    registry: Arc<ShellxBrowserRegistry>,
    start_url: Option<String>,
) -> Result<BrowserWindowOpenResponse, BrowserWindowOpenFailure> {
    let timeout_ms = BROWSER_WINDOW_OPEN_TIMEOUT_MS;
    let guard = match Arc::clone(&registry.window_open_lock).try_lock_owned() {
        Ok(guard) => guard,
        Err(_) => {
            return Err(record_window_open_failure(
                &registry,
                start_url,
                None,
                "browser_window_open_in_progress",
                "ShellX Browser window initialization is already in progress".to_string(),
                true,
                timeout_ms,
            ));
        }
    };
    let ticket = registry.prepare_window_open(start_url.clone());
    let open_app = app.clone();
    match run_browser_window_open_operation(guard, Duration::from_millis(timeout_ms), move || {
        open_or_focus_browser_window(&open_app)
    })
    .await
    {
        BrowserWindowOpenOperationResult::Completed(completion) => {
            let BrowserWindowOpenCompletion { guard, result } = completion;
            let response = match result {
                Ok(_) => registry
                    .open_window_record(ticket, start_url.clone())
                    .map_err(|message| {
                        record_window_open_failure(
                            &registry,
                            start_url,
                            None,
                            "browser_window_open_superseded",
                            message,
                            true,
                            timeout_ms,
                        )
                    }),
                Err(message) => Err(record_window_open_failure(
                    &registry,
                    start_url,
                    Some(ticket),
                    "browser_window_open_failed",
                    message,
                    true,
                    timeout_ms,
                )),
            };
            drop(guard);
            response
        }
        BrowserWindowOpenOperationResult::TimedOut(task) => {
            // Record the provisional rollback before the watcher can reconcile a
            // late native result. The task still owns the circuit-breaker guard.
            let failure = record_window_open_failure(
                &registry,
                start_url.clone(),
                Some(ticket),
                "browser_window_open_timeout",
                format!(
                    "ShellX Browser window initialization exceeded {} ms; the late opener remains isolated behind the circuit breaker",
                    timeout_ms
                ),
                true,
                timeout_ms,
            );
            spawn_late_browser_window_open_watcher(app, Arc::clone(&registry), ticket, task);
            Err(failure)
        }
        BrowserWindowOpenOperationResult::WorkerFailed(message) => Err(record_window_open_failure(
            &registry,
            start_url,
            Some(ticket),
            "browser_window_open_worker_failed",
            message,
            true,
            timeout_ms,
        )),
    }
}

fn record_window_open_failure(
    registry: &ShellxBrowserRegistry,
    start_url: Option<String>,
    ticket: Option<BrowserWindowOpenTicket>,
    code: &str,
    message: String,
    retryable: bool,
    timeout_ms: u64,
) -> BrowserWindowOpenFailure {
    let diagnostics = browser_window_runtime_diagnostics();
    let receipt = registry.record_window_open_failure(
        start_url,
        ticket,
        code,
        &message,
        timeout_ms,
        diagnostics.clone(),
    );
    BrowserWindowOpenFailure {
        code: code.to_string(),
        message,
        retryable,
        timeout_ms,
        diagnostics,
        receipt,
    }
}

async fn run_browser_window_open_operation<F>(
    guard: OwnedMutexGuard<()>,
    timeout_duration: Duration,
    opener: F,
) -> BrowserWindowOpenOperationResult
where
    F: FnOnce() -> Result<BrowserWindowOpenDisposition, String> + Send + 'static,
{
    let mut task = tokio::task::spawn_blocking(move || {
        let result = opener();
        BrowserWindowOpenCompletion { guard, result }
    });
    match tokio::time::timeout(timeout_duration, &mut task).await {
        Ok(Ok(completion)) => BrowserWindowOpenOperationResult::Completed(completion),
        Ok(Err(error)) => BrowserWindowOpenOperationResult::WorkerFailed(format!(
            "ShellX Browser window worker failed: {}",
            error
        )),
        Err(_) => BrowserWindowOpenOperationResult::TimedOut(task),
    }
}

fn spawn_late_browser_window_open_watcher(
    app: AppHandle,
    registry: Arc<ShellxBrowserRegistry>,
    ticket: BrowserWindowOpenTicket,
    task: tokio::task::JoinHandle<BrowserWindowOpenCompletion>,
) {
    tokio::spawn(async move {
        let Ok(completion) = task.await else {
            return;
        };
        let reconcile_registry = Arc::clone(&registry);
        let _ = tokio::task::spawn_blocking(move || {
            reconcile_late_browser_window_open(
                &reconcile_registry,
                ticket,
                completion,
                |disposition| reconcile_late_native_browser_window(&app, disposition),
            );
        })
        .await;
    });
}

fn reconcile_late_browser_window_open<F>(
    registry: &ShellxBrowserRegistry,
    ticket: BrowserWindowOpenTicket,
    completion: BrowserWindowOpenCompletion,
    reconcile_native: F,
) where
    F: FnOnce(BrowserWindowOpenDisposition) -> LateBrowserWindowNativeState,
{
    let BrowserWindowOpenCompletion { guard, result } = completion;
    if let Ok(disposition) = result {
        match reconcile_native(disposition) {
            LateBrowserWindowNativeState::Absent => {
                registry.record_window_destroyed();
            }
            LateBrowserWindowNativeState::Present(detail) => {
                registry.record_late_window_present(ticket, disposition.as_str(), &detail);
            }
        }
    }
    // A retry cannot focus or create this label until native presence and the
    // matching registry generation have been reconciled.
    drop(guard);
}

fn browser_window_runtime_diagnostics() -> serde_json::Value {
    let wsl = running_under_wsl();
    let wslg = wsl && std::env::var_os("WAYLAND_DISPLAY").is_some();
    let backend = if cfg!(target_os = "windows") {
        "webview2"
    } else if cfg!(target_os = "macos") {
        "wkwebview"
    } else {
        "webkitgtk"
    };
    json!({
        "platform": std::env::consts::OS,
        "backend": backend,
        "environment": if wslg { "wslg" } else if wsl { "wsl" } else { "native" },
        "classification": if wsl { "environmentSpecific" } else { "productRuntime" },
        "displayAvailable": std::env::var_os("DISPLAY").is_some(),
        "waylandAvailable": std::env::var_os("WAYLAND_DISPLAY").is_some(),
        "sessionBusAvailable": std::env::var_os("DBUS_SESSION_BUS_ADDRESS").is_some(),
    })
}

fn running_under_wsl() -> bool {
    if std::env::var_os("WSL_DISTRO_NAME").is_some() || std::env::var_os("WSL_INTEROP").is_some() {
        return true;
    }
    #[cfg(target_os = "linux")]
    {
        std::fs::read_to_string("/proc/sys/kernel/osrelease")
            .map(|value| value.to_ascii_lowercase().contains("microsoft"))
            .unwrap_or(false)
    }
    #[cfg(not(target_os = "linux"))]
    false
}

fn open_or_focus_browser_window(app: &AppHandle) -> Result<BrowserWindowOpenDisposition, String> {
    if focus_existing_browser_window(app) {
        return Ok(BrowserWindowOpenDisposition::Existing);
    }

    build_browser_window(app)?;
    Ok(BrowserWindowOpenDisposition::Created)
}

fn reconcile_late_native_browser_window(
    app: &AppHandle,
    disposition: BrowserWindowOpenDisposition,
) -> LateBrowserWindowNativeState {
    if disposition == BrowserWindowOpenDisposition::Existing {
        return if browser_window_label_is_present(app) {
            LateBrowserWindowNativeState::Present(
                "late opener focused the existing native window; timed-out start URL was not applied"
                    .to_string(),
            )
        } else {
            LateBrowserWindowNativeState::Absent
        };
    }

    let close_result = close_browser_window_label(app);
    let release_result = wait_for_browser_window_label_release(app);
    if browser_window_label_is_present(app) {
        LateBrowserWindowNativeState::Present(format!(
            "late-created native window remains present (close: {}; release: {})",
            close_result
                .as_ref()
                .err()
                .map(String::as_str)
                .unwrap_or("ok"),
            release_result
                .as_ref()
                .err()
                .map(String::as_str)
                .unwrap_or("ok")
        ))
    } else {
        LateBrowserWindowNativeState::Absent
    }
}

fn browser_window_label_is_present(app: &AppHandle) -> bool {
    app.get_window(BROWSER_WINDOW_LABEL).is_some()
        || app.get_webview_window(BROWSER_WINDOW_LABEL).is_some()
}

fn close_browser_window_label(app: &AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(BROWSER_WINDOW_LABEL) {
        return window
            .close()
            .map_err(|error| format!("failed to close late ShellX Browser window: {error}"));
    }
    if let Some(window) = app.get_window(BROWSER_WINDOW_LABEL) {
        return window
            .close()
            .map_err(|error| format!("failed to close late ShellX Browser window: {error}"));
    }
    Ok(())
}

fn wait_for_browser_window_label_release(app: &AppHandle) -> Result<(), String> {
    for _ in 0..40 {
        if !browser_window_label_is_present(app) {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    Err("ShellX Browser window label is still present after close request".to_string())
}

pub(crate) fn ensure_browser_window_for_engine(
    app: &AppHandle,
    restore_visible_geometry: bool,
) -> Result<(), String> {
    if let Some(window) = app.get_window(BROWSER_WINDOW_LABEL) {
        if restore_visible_geometry {
            restore_browser_window_geometry(&window);
        }
        return Ok(());
    }
    if let Some(window) = app.get_webview_window(BROWSER_WINDOW_LABEL) {
        if restore_visible_geometry {
            restore_browser_webview_window_geometry(&window);
        }
        return Ok(());
    }

    build_browser_window(app)
}

fn build_browser_window(app: &AppHandle) -> Result<(), String> {
    let builder = WebviewWindowBuilder::new(
        app,
        BROWSER_WINDOW_LABEL,
        WebviewUrl::App("shellx-browser.html".into()),
    )
    .title("ShellX Browser")
    .inner_size(1280.0, 860.0)
    .min_inner_size(860.0, 560.0)
    .center()
    .resizable(true);
    #[cfg(windows)]
    let builder = builder.additional_browser_args(
        crate::shellx_browser_webview_runtime::SHELLX_BROWSER_WEBVIEW2_ADDITIONAL_ARGS,
    );
    #[cfg(windows)]
    let builder = builder.data_directory(crate::webview_runtime_paths::app_webview_data_directory(
        app,
    )?);
    builder
        .build()
        .map_err(|e| format!("failed to open ShellX Browser window: {}", e))?;
    Ok(())
}

fn focus_existing_browser_window(app: &AppHandle) -> bool {
    if let Some(window) = app.get_window(BROWSER_WINDOW_LABEL) {
        restore_browser_window_geometry(&window);
        let _ = window.show();
        let _ = window.set_focus();
        return true;
    }
    if let Some(window) = app.get_webview_window(BROWSER_WINDOW_LABEL) {
        restore_browser_webview_window_geometry(&window);
        let _ = window.show();
        let _ = window.set_focus();
        return true;
    }
    false
}

fn restore_browser_window_geometry<R: tauri::Runtime>(window: &tauri::Window<R>) {
    let _ = window.show();
    let _ = window.unminimize();
    let too_small = window
        .outer_size()
        .map(|size| size.width < 860 || size.height < 560)
        .unwrap_or(false);
    let far_offscreen = window
        .outer_position()
        .map(|position| position.x < -8000 || position.y < -8000)
        .unwrap_or(false);
    if too_small || far_offscreen {
        let _ = window.set_size(Size::Logical(LogicalSize::new(1280.0, 860.0)));
        let _ = window.set_position(Position::Logical(LogicalPosition::new(160.0, 120.0)));
        let _ = window.center();
    }
}

fn restore_browser_webview_window_geometry<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>) {
    let _ = window.show();
    let _ = window.unminimize();
    let too_small = window
        .outer_size()
        .map(|size| size.width < 860 || size.height < 560)
        .unwrap_or(false);
    let far_offscreen = window
        .outer_position()
        .map(|position| position.x < -8000 || position.y < -8000)
        .unwrap_or(false);
    if too_small || far_offscreen {
        let _ = window.set_size(Size::Logical(LogicalSize::new(1280.0, 860.0)));
        let _ = window.set_position(Position::Logical(LogicalPosition::new(160.0, 120.0)));
        let _ = window.center();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use tokio::sync::oneshot;

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn late_created_window_reconciles_before_circuit_breaker_releases() {
        let registry = Arc::new(ShellxBrowserRegistry::default());
        let ticket = registry.prepare_window_open(Some("https://example.com".to_string()));
        let guard = Arc::clone(&registry.window_open_lock)
            .try_lock_owned()
            .expect("first opener acquires circuit breaker");
        let (started_tx, started_rx) = oneshot::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let operation = tokio::spawn(run_browser_window_open_operation(
            guard,
            Duration::from_millis(30),
            move || {
                let _ = started_tx.send(());
                release_rx
                    .recv()
                    .map_err(|error| format!("test release failed: {error}"))?;
                Ok(BrowserWindowOpenDisposition::Created)
            },
        ));

        started_rx.await.expect("hung opener started");
        let state_registry = Arc::clone(&registry);
        let state = tokio::time::timeout(
            Duration::from_millis(50),
            tokio::task::spawn_blocking(move || state_registry.state()),
        )
        .await
        .expect("Browser state remains responsive")
        .expect("state worker completes");
        assert!(!state.window_open);
        let task = match operation.await.expect("watchdog task completes") {
            BrowserWindowOpenOperationResult::TimedOut(task) => task,
            _ => panic!("hung opener should return its late worker"),
        };
        registry.record_window_open_failure(
            Some("https://example.com".to_string()),
            Some(ticket),
            "browser_window_open_timeout",
            "simulated timeout",
            30,
            json!({ "platform": "test" }),
        );
        assert!(Arc::clone(&registry.window_open_lock)
            .try_lock_owned()
            .is_err());

        release_tx.send(()).expect("release hung opener");
        let completion = task.await.expect("late worker completes");
        reconcile_late_browser_window_open(&registry, ticket, completion, |disposition| {
            assert_eq!(disposition, BrowserWindowOpenDisposition::Created);
            assert!(
                Arc::clone(&registry.window_open_lock)
                    .try_lock_owned()
                    .is_err(),
                "native cleanup runs while the circuit is held"
            );
            LateBrowserWindowNativeState::Absent
        });
        assert!(
            Arc::clone(&registry.window_open_lock)
                .try_lock_owned()
                .is_ok(),
            "circuit releases only after late cleanup and registry reconciliation"
        );
        assert!(!registry.state().window_open);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn late_existing_window_records_presence_without_applying_start_url() {
        let registry = Arc::new(ShellxBrowserRegistry::default());
        let ticket = registry.prepare_window_open(Some("https://example.com/private".to_string()));
        let guard = Arc::clone(&registry.window_open_lock)
            .try_lock_owned()
            .expect("opener acquires circuit breaker");
        let (release_tx, release_rx) = mpsc::channel();
        let result =
            run_browser_window_open_operation(guard, Duration::from_millis(10), move || {
                release_rx
                    .recv()
                    .map_err(|error| format!("test release failed: {error}"))?;
                Ok(BrowserWindowOpenDisposition::Existing)
            })
            .await;
        let task = match result {
            BrowserWindowOpenOperationResult::TimedOut(task) => task,
            _ => panic!("blocked opener should time out"),
        };
        registry.record_window_open_failure(
            Some("https://example.com/private".to_string()),
            Some(ticket),
            "browser_window_open_timeout",
            "simulated timeout",
            10,
            json!({ "platform": "test" }),
        );
        release_tx.send(()).expect("release existing opener");
        let completion = task.await.expect("late existing worker completes");
        reconcile_late_browser_window_open(&registry, ticket, completion, |disposition| {
            assert_eq!(disposition, BrowserWindowOpenDisposition::Existing);
            LateBrowserWindowNativeState::Present("test existing window".to_string())
        });
        let state = registry.state();
        assert!(state.window_open);
        assert!(state.pending_start_url.is_none());
        assert_eq!(
            state.receipts.last().map(|receipt| receipt.kind.as_str()),
            Some("browserWindowOpenRecovered")
        );
        assert_eq!(
            state.receipts.last().unwrap().evidence["startUrlApplied"],
            false
        );
    }

    #[test]
    fn failed_late_created_cleanup_records_presence_before_unlocking() {
        let registry = Arc::new(ShellxBrowserRegistry::default());
        let ticket = registry.prepare_window_open(Some("https://example.com".to_string()));
        let guard = Arc::clone(&registry.window_open_lock)
            .try_lock_owned()
            .expect("opener acquires circuit breaker");
        let completion = BrowserWindowOpenCompletion {
            guard,
            result: Ok(BrowserWindowOpenDisposition::Created),
        };

        reconcile_late_browser_window_open(&registry, ticket, completion, |disposition| {
            assert_eq!(disposition, BrowserWindowOpenDisposition::Created);
            assert!(Arc::clone(&registry.window_open_lock)
                .try_lock_owned()
                .is_err());
            LateBrowserWindowNativeState::Present("test close failure".to_string())
        });

        let state = registry.state();
        assert!(state.window_open);
        assert_eq!(
            state.receipts.last().unwrap().evidence["disposition"],
            "created"
        );
        assert!(Arc::clone(&registry.window_open_lock)
            .try_lock_owned()
            .is_ok());
    }

    #[test]
    fn window_open_failure_resets_provisional_state_and_records_diagnostics() {
        let registry = ShellxBrowserRegistry::default();
        let start_url = Some("https://example.com/path?secret=redacted".to_string());
        let ticket = registry.prepare_window_open(start_url.clone());
        assert!(!ticket.previous_window_open);
        assert_eq!(registry.state().pending_start_url, start_url);

        let receipt = registry.record_window_open_failure(
            start_url,
            Some(ticket),
            "browser_window_open_timeout",
            "simulated native opener timeout",
            25,
            json!({
                "platform": "test",
                "backend": "test-webview",
                "classification": "environmentSpecific",
            }),
        );
        let state = registry.state();
        assert!(!state.window_open);
        assert!(state.pending_start_url.is_none());
        assert!(!state.engine.mounted);
        assert_eq!(state.engine.load_status, "error");
        assert_eq!(receipt.kind, "browserWindowOpenFailed");
        assert_eq!(receipt.evidence["code"], "browser_window_open_timeout");
        assert_eq!(receipt.evidence["startUrlProvided"], true);
        assert!(receipt
            .evidence
            .to_string()
            .find("secret=redacted")
            .is_none());
    }
}
