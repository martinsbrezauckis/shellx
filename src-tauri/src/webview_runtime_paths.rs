use std::path::PathBuf;

pub(crate) fn app_webview_data_directory<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
) -> Result<PathBuf, String> {
    let local_app_data = std::env::var_os("LOCALAPPDATA")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .ok_or_else(|| {
            "LOCALAPPDATA must resolve to an absolute per-user Windows path".to_string()
        })?;
    Ok(local_app_data
        .join(&app.config().identifier)
        .join("webview-data"))
}
