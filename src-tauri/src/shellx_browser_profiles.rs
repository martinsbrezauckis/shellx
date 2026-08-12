use crate::shellx_browser::{BrowserProfile, BrowserState};

pub(crate) fn default_profiles() -> Vec<BrowserProfile> {
    vec![
        BrowserProfile {
            profile_id: "personal".to_string(),
            label: "Personal".to_string(),
            description:
                "User-driven browsing profile; agent access requires an explicit session grant."
                    .to_string(),
            agent_default: false,
            cookies_enabled: true,
            persistent: true,
            storage_root: Some(browser_profile_storage_root("personal")),
        },
        BrowserProfile {
            profile_id: "agent-work".to_string(),
            label: "Agent Work".to_string(),
            description: "Default agent profile for ordinary authenticated workflows.".to_string(),
            agent_default: true,
            cookies_enabled: true,
            persistent: true,
            storage_root: Some(browser_profile_storage_root("agent-work")),
        },
        BrowserProfile {
            profile_id: "task-disposable".to_string(),
            label: "Task Disposable".to_string(),
            description: "Ephemeral task profile for isolated one-off workflows.".to_string(),
            agent_default: false,
            cookies_enabled: false,
            persistent: false,
            // A disposable WebView root is allocated from its exact task and
            // engine identity at native mount time.  There is intentionally no
            // stable profile directory to expose or reuse here.
            storage_root: None,
        },
    ]
}

fn shellx_browser_data_root() -> std::path::PathBuf {
    std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| std::path::PathBuf::from("."))
        .join(".shellx")
        .join("browser")
}

pub(crate) fn browser_profile_storage_root(profile_id: &str) -> String {
    shellx_browser_data_root()
        .join("profiles")
        .join(safe_storage_segment(profile_id))
        .join("webview-data")
        .to_string_lossy()
        .into_owned()
}

fn safe_storage_segment(value: &str) -> String {
    let segment = value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                ch
            } else {
                '-'
            }
        })
        .collect::<String>();
    let segment = segment.trim_matches('-');
    if segment.is_empty() {
        "default".to_string()
    } else {
        segment.to_string()
    }
}

pub(crate) fn resolve_profile_id(
    state: &BrowserState,
    requested: Option<&str>,
) -> Result<String, String> {
    let profile_id = requested
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("agent-work");
    if state
        .profiles
        .iter()
        .any(|profile| profile.profile_id == profile_id)
    {
        Ok(profile_id.to_string())
    } else {
        Err(format!("unknown browser profile '{}'", profile_id))
    }
}
