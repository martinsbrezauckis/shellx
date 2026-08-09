use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, OnceLock},
};
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};

use crate::shellx_browser::{
    lock_or_recover, now_ms, push_receipt, rollback_failed_task_engine_sync, safe_url_parts,
    sync_engine_to_tab_preserving_page, sync_engine_to_task, BrowserAutonomyMode, BrowserReceipt,
    BrowserTaskSnapshot, ShellxBrowserRegistry, StartBrowserTaskRequest, BROWSER_WINDOW_LABEL,
};

const SHELLX_MAIN_WINDOW_LABEL: &str = "main";
const BROWSER_COWORK_PROMPT_EVENT: &str = "shellx:browser-cowork-prompt";
const BROWSER_COWORK_PROMPT_MAX_CHARS: usize = 32_000;
const BROWSER_COWORK_PROMPT_TTL_MS: i64 = 60_000;
const BROWSER_COWORK_PENDING_LIMIT: usize = 64;

static PENDING_COWORK_PROMPTS: OnceLock<Mutex<HashMap<String, PendingBrowserCoworkPrompt>>> =
    OnceLock::new();

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserCoworkPromptRequest {
    #[serde(default)]
    pub task_id: Option<String>,
    pub target_tab_id: String,
    pub prompt: String,
    #[serde(default)]
    pub start_url: Option<String>,
    #[serde(default)]
    pub profile_id: Option<String>,
    #[serde(default)]
    pub autonomy: Option<BrowserAutonomyMode>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserCoworkPromptResponse {
    pub ok: bool,
    pub request_id: String,
    pub created_task: bool,
    pub task: BrowserTaskSnapshot,
    pub browser_tab_id: String,
    pub target_tab_id: String,
    pub receipt: BrowserReceipt,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserCoworkPromptEvent {
    request_id: String,
    task_id: String,
    browser_tab_id: String,
    target_tab_id: String,
    prompt: String,
    visible_prompt: String,
    created_task: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BrowserCoworkPromptNotification {
    request_id: String,
}

struct PendingBrowserCoworkPrompt {
    event: BrowserCoworkPromptEvent,
    expires_at_ms: i64,
}

fn lock_pending_cowork_prompts(
) -> std::sync::MutexGuard<'static, HashMap<String, PendingBrowserCoworkPrompt>> {
    PENDING_COWORK_PROMPTS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn insert_pending_cowork_prompt(event: BrowserCoworkPromptEvent) {
    let now = now_ms();
    let mut pending = lock_pending_cowork_prompts();
    pending.retain(|_, prompt| prompt.expires_at_ms > now);
    if pending.len() >= BROWSER_COWORK_PENDING_LIMIT {
        if let Some(oldest) = pending
            .iter()
            .min_by_key(|(_, prompt)| prompt.expires_at_ms)
            .map(|(request_id, _)| request_id.clone())
        {
            pending.remove(&oldest);
        }
    }
    pending.insert(
        event.request_id.clone(),
        PendingBrowserCoworkPrompt {
            event,
            expires_at_ms: now.saturating_add(BROWSER_COWORK_PROMPT_TTL_MS),
        },
    );
}

fn require_cowork_window(actual: &str, expected: &str, action: &str) -> Result<(), String> {
    if actual == expected {
        return Ok(());
    }
    Err(format!(
        "Browser cowork {action} is restricted to the '{expected}' window"
    ))
}

fn claim_cowork_prompt(request_id: &str) -> Result<BrowserCoworkPromptEvent, String> {
    let request_id = request_id.trim();
    if request_id.is_empty() || request_id.len() > 128 {
        return Err("Invalid Browser cowork prompt claim".to_string());
    }
    let now = now_ms();
    let mut pending = lock_pending_cowork_prompts();
    pending.retain(|_, prompt| prompt.expires_at_ms > now);
    pending
        .remove(request_id)
        .map(|prompt| prompt.event)
        .ok_or_else(|| {
            "Browser cowork prompt claim is unknown, expired, or already consumed".to_string()
        })
}

fn pending_cowork_prompt_ids() -> Vec<String> {
    let now = now_ms();
    let mut pending = lock_pending_cowork_prompts();
    pending.retain(|_, prompt| prompt.expires_at_ms > now);
    let mut ids = pending
        .iter()
        .map(|(request_id, prompt)| (prompt.expires_at_ms, request_id.clone()))
        .collect::<Vec<_>>();
    ids.sort_by_key(|(expires_at_ms, _)| *expires_at_ms);
    ids.into_iter().map(|(_, request_id)| request_id).collect()
}

#[tauri::command]
pub fn shellx_browser_claim_cowork_prompt(
    window: WebviewWindow,
    #[allow(non_snake_case)] requestId: String,
) -> Result<BrowserCoworkPromptEvent, String> {
    require_cowork_window(window.label(), SHELLX_MAIN_WINDOW_LABEL, "prompt claims")?;
    claim_cowork_prompt(&requestId)
}

#[tauri::command]
pub fn shellx_browser_replay_cowork_prompt_notifications(
    app: AppHandle,
    window: WebviewWindow,
) -> Result<usize, String> {
    require_cowork_window(
        window.label(),
        SHELLX_MAIN_WINDOW_LABEL,
        "prompt notification replay",
    )?;
    let request_ids = pending_cowork_prompt_ids();
    for request_id in &request_ids {
        app.emit_to(
            SHELLX_MAIN_WINDOW_LABEL,
            BROWSER_COWORK_PROMPT_EVENT,
            BrowserCoworkPromptNotification {
                request_id: request_id.clone(),
            },
        )
        .map_err(|error| format!("Failed to replay Browser cowork prompt notification: {error}"))?;
    }
    Ok(request_ids.len())
}

fn clean_cowork_target_tab_id(value: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() || value.len() > 128 {
        return Err("Browser coworking requires a valid ShellX session tab".to_string());
    }
    if !value
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | ':'))
    {
        return Err("Browser coworking target tab contains unsupported characters".to_string());
    }
    Ok(value.to_string())
}

fn clean_cowork_prompt(value: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() {
        return Err("Browser coworking prompt is required".to_string());
    }
    if value.chars().count() > BROWSER_COWORK_PROMPT_MAX_CHARS {
        return Err(format!(
            "Browser coworking prompt exceeds the {} character limit",
            BROWSER_COWORK_PROMPT_MAX_CHARS
        ));
    }
    Ok(value.to_string())
}

fn cowork_prompt_envelope(
    task: &BrowserTaskSnapshot,
    browser_tab_id: &str,
    visible_prompt: &str,
) -> String {
    let current_url = task
        .current_url
        .as_deref()
        .map(|url| safe_url_parts(url).url)
        .unwrap_or_else(|| "about:blank".to_string());
    format!(
        "ShellX Browser cowork request\n\
Browser task ID: {}\n\
Browser tab ID: {}\n\
Current URL: {}\n\
\n\
Work in the visible native ShellX Browser with the explicit task and tab IDs above. Use ShellX Browser tools, preserve operator pause/takeover/abort authority, and keep Vault or sensitive actions inside Request Center. Do not switch to a hidden or unrelated browser surface.\n\
\n\
User message:\n{}",
        task.task_id, browser_tab_id, current_url, visible_prompt
    )
}

fn existing_cowork_task(
    registry: &ShellxBrowserRegistry,
    task_id: &str,
    target_tab_id: &str,
) -> Result<(BrowserTaskSnapshot, String), String> {
    let state = registry.state();
    let task = state
        .tasks
        .iter()
        .find(|task| task.task_id == task_id)
        .cloned()
        .ok_or_else(|| format!("unknown Browser cowork task '{task_id}'"))?;
    if task.status != "running" {
        return Err(format!(
            "Browser cowork task is {}; use the visible operator controls before sending another message",
            task.status
        ));
    }
    if task.owner_session_id.as_deref() != Some(target_tab_id) {
        return Err(
            "Browser cowork task is attached to a different ShellX session; start a new task or return to its attached session"
                .to_string(),
        );
    }
    let browser_tab_id = state
        .tabs
        .iter()
        .find(|tab| tab.task_id.as_deref() == Some(task_id))
        .map(|tab| tab.browser_tab_id.clone())
        .ok_or_else(|| "Browser cowork task has no live Browser tab".to_string())?;
    Ok((task, browser_tab_id))
}

fn record_cowork_prompt_receipt(
    registry: &ShellxBrowserRegistry,
    task: &BrowserTaskSnapshot,
    browser_tab_id: &str,
    target_tab_id: &str,
    request_id: &str,
    prompt_chars: usize,
) -> BrowserReceipt {
    let mut state = lock_or_recover(&registry.state);
    push_receipt(
        &mut state,
        "browserCoworkPromptQueued",
        Some(task.task_id.clone()),
        Some(task.profile_id.clone()),
        "Browser cowork prompt queued to its attached ShellX session".to_string(),
        json!({
            "requestId": request_id,
            "browserTabId": browser_tab_id,
            "targetTabId": target_tab_id,
            "promptChars": prompt_chars,
        }),
    )
}

fn emit_browser_receipt(app: &AppHandle, receipt: &BrowserReceipt) {
    let payload = json!({
        "revision": format!("state-{}", receipt.receipt_id),
        "receipt": receipt,
    });
    #[cfg(feature = "debug-api")]
    if let Some(hub) = app.try_state::<Arc<crate::debug_api::DebugHub>>() {
        hub.record_raw_event("browser-event", payload.clone());
    }
    let _ = app.emit("browser-event", payload);
}

async fn rollback_failed_new_cowork_task(
    app: &AppHandle,
    registry: &Arc<ShellxBrowserRegistry>,
    task: &BrowserTaskSnapshot,
    previous_active_browser_tab_id: Option<&str>,
    failure: &str,
) -> String {
    match rollback_failed_task_engine_sync(
        app,
        registry,
        &task.task_id,
        previous_active_browser_tab_id,
        failure,
    )
    .await
    {
        Ok(rollback) => format!(
            "{failure}; Browser task start rollback ok={}",
            rollback
                .get("ok")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false)
        ),
        Err(rollback_error) => {
            format!("{failure}; Browser task start rollback failed: {rollback_error}")
        }
    }
}

#[tauri::command]
pub async fn shellx_browser_send_cowork_prompt(
    app: AppHandle,
    window: WebviewWindow,
    registry: State<'_, Arc<ShellxBrowserRegistry>>,
    request: BrowserCoworkPromptRequest,
) -> Result<BrowserCoworkPromptResponse, String> {
    require_cowork_window(window.label(), BROWSER_WINDOW_LABEL, "prompt sends")?;
    if app.get_webview_window(SHELLX_MAIN_WINDOW_LABEL).is_none() {
        return Err(
            "Open the main ShellX window and choose an agent tab before Browser coworking"
                .to_string(),
        );
    }
    let target_tab_id = clean_cowork_target_tab_id(&request.target_tab_id)?;
    let visible_prompt = clean_cowork_prompt(&request.prompt)?;
    let registry = Arc::clone(&*registry);
    let previous_active_browser_tab_id = registry.state().active_browser_tab_id;
    let (task, browser_tab_id, created_task) = if let Some(task_id) = request
        .task_id
        .as_deref()
        .map(str::trim)
        .filter(|task_id| !task_id.is_empty())
    {
        let (task, browser_tab_id) = existing_cowork_task(&registry, task_id, &target_tab_id)?;
        (task, browser_tab_id, false)
    } else {
        let task = registry.start_task_for_agent_session(
            StartBrowserTaskRequest {
                goal: visible_prompt.clone(),
                start_url: request.start_url,
                profile_id: request.profile_id,
                autonomy: request.autonomy,
                expected_domains: None,
                blocked_domains: None,
            },
            Some(&target_tab_id),
        )?;
        let browser_tab_id = registry
            .state()
            .tabs
            .iter()
            .find(|tab| tab.task_id.as_deref() == Some(task.task_id.as_str()))
            .map(|tab| tab.browser_tab_id.clone())
            .ok_or_else(|| "Browser cowork task started without a Browser tab".to_string())?;
        (task, browser_tab_id, true)
    };

    let engine_sync = if created_task {
        sync_engine_to_task(&app, &registry, &task).await
    } else {
        let tab = registry
            .state()
            .tabs
            .into_iter()
            .find(|tab| tab.browser_tab_id == browser_tab_id)
            .ok_or_else(|| "Browser cowork task lost its Browser tab".to_string())?;
        sync_engine_to_tab_preserving_page(&app, &registry, &tab).await
    };
    if let Err(error) = engine_sync {
        if created_task {
            return Err(rollback_failed_new_cowork_task(
                &app,
                &registry,
                &task,
                previous_active_browser_tab_id.as_deref(),
                &error,
            )
            .await);
        }
        return Err(error);
    }

    let request_id = crate::shellx_browser::browser_id("browser-cowork");
    let event = BrowserCoworkPromptEvent {
        request_id: request_id.clone(),
        task_id: task.task_id.clone(),
        browser_tab_id: browser_tab_id.clone(),
        target_tab_id: target_tab_id.clone(),
        prompt: cowork_prompt_envelope(&task, &browser_tab_id, &visible_prompt),
        visible_prompt: visible_prompt.clone(),
        created_task,
    };
    insert_pending_cowork_prompt(event);
    if let Err(error) = app.emit_to(
        SHELLX_MAIN_WINDOW_LABEL,
        BROWSER_COWORK_PROMPT_EVENT,
        BrowserCoworkPromptNotification {
            request_id: request_id.clone(),
        },
    ) {
        lock_pending_cowork_prompts().remove(&request_id);
        let failure = format!("Failed to queue Browser cowork prompt: {error}");
        if created_task {
            return Err(rollback_failed_new_cowork_task(
                &app,
                &registry,
                &task,
                previous_active_browser_tab_id.as_deref(),
                &failure,
            )
            .await);
        }
        return Err(failure);
    }

    let receipt = record_cowork_prompt_receipt(
        &registry,
        &task,
        &browser_tab_id,
        &target_tab_id,
        &request_id,
        visible_prompt.chars().count(),
    );
    emit_browser_receipt(&app, &receipt);
    Ok(BrowserCoworkPromptResponse {
        ok: true,
        request_id,
        created_task,
        task,
        browser_tab_id,
        target_tab_id,
        receipt,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cowork_prompt_envelope_binds_visible_browser_ids_and_operator_policy() {
        let registry = ShellxBrowserRegistry::default();
        let task = registry
            .start_task_for_agent_session(
                StartBrowserTaskRequest {
                    goal: "Explain this page".to_string(),
                    start_url: Some(
                        "https://example.com/path?access_token=secret#fragment".to_string(),
                    ),
                    ..StartBrowserTaskRequest::default()
                },
                Some("tab-main"),
            )
            .expect("cowork task");
        let tab = registry
            .state()
            .tabs
            .into_iter()
            .find(|tab| tab.task_id.as_deref() == Some(task.task_id.as_str()))
            .expect("task tab");
        let prompt = cowork_prompt_envelope(&task, &tab.browser_tab_id, "Explain this page");

        assert!(prompt.contains(&task.task_id));
        assert!(prompt.contains(&tab.browser_tab_id));
        assert!(prompt.contains("visible native ShellX Browser"));
        assert!(prompt.contains("pause/takeover/abort"));
        assert!(prompt.contains("https://example.com/path"));
        assert!(!prompt.contains("access_token") && !prompt.contains("secret#fragment"));
        assert!(prompt.ends_with("User message:\nExplain this page"));
    }

    #[test]
    fn existing_cowork_task_requires_running_matching_owner_session() {
        let registry = ShellxBrowserRegistry::default();
        let task = registry
            .start_task_for_agent_session(
                StartBrowserTaskRequest {
                    goal: "Cowork".to_string(),
                    ..StartBrowserTaskRequest::default()
                },
                Some("tab-owner"),
            )
            .expect("cowork task");

        assert!(existing_cowork_task(&registry, &task.task_id, "tab-other")
            .expect_err("other owner rejected")
            .contains("different ShellX session"));
        assert!(existing_cowork_task(&registry, &task.task_id, "tab-owner").is_ok());
    }

    #[test]
    fn cowork_inputs_are_bounded() {
        assert!(clean_cowork_target_tab_id("../tab").is_err());
        assert!(clean_cowork_prompt(" ").is_err());
        assert!(clean_cowork_prompt(&"x".repeat(BROWSER_COWORK_PROMPT_MAX_CHARS + 1)).is_err());
    }

    #[test]
    fn cowork_commands_are_bound_to_their_own_windows() {
        assert!(require_cowork_window(BROWSER_WINDOW_LABEL, BROWSER_WINDOW_LABEL, "send").is_ok());
        assert!(
            require_cowork_window(SHELLX_MAIN_WINDOW_LABEL, BROWSER_WINDOW_LABEL, "send").is_err()
        );
        assert!(
            require_cowork_window(SHELLX_MAIN_WINDOW_LABEL, SHELLX_MAIN_WINDOW_LABEL, "claim")
                .is_ok()
        );
        assert!(
            require_cowork_window(BROWSER_WINDOW_LABEL, SHELLX_MAIN_WINDOW_LABEL, "claim").is_err()
        );
    }

    #[test]
    fn cowork_prompt_claim_is_one_time() {
        let request_id = format!("claim-{}", now_ms());
        insert_pending_cowork_prompt(BrowserCoworkPromptEvent {
            request_id: request_id.clone(),
            task_id: "task".to_string(),
            browser_tab_id: "browser-tab".to_string(),
            target_tab_id: "session-tab".to_string(),
            prompt: "bounded prompt".to_string(),
            visible_prompt: "visible".to_string(),
            created_task: true,
        });

        assert_eq!(
            claim_cowork_prompt(&request_id)
                .expect("first claim")
                .task_id,
            "task"
        );
        assert!(claim_cowork_prompt(&request_id).is_err());
    }
}
