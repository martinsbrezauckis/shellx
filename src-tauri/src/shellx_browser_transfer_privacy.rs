use crate::host_mcp::{enforce_home_containment, FsAccessKind};
use crate::shellx_browser::{clean_string, BrowserFileTransferEntry};

pub(crate) fn public_upload_transfer_entry(
    mut entry: BrowserFileTransferEntry,
) -> BrowserFileTransferEntry {
    entry.file_path = None;
    entry.final_path = None;
    entry
}

pub(crate) fn browser_upload_display_name(value: &str) -> String {
    clean_string(value)
        .replace('\\', "/")
        .rsplit('/')
        .next()
        .unwrap_or_default()
        .chars()
        .take(160)
        .collect()
}

pub(crate) fn browser_download_destination_dir(
    value: Option<&str>,
) -> Result<std::path::PathBuf, String> {
    let path = if let Some(path) = value.map(clean_string).filter(|path| !path.is_empty()) {
        std::path::PathBuf::from(path)
    } else {
        let home = std::env::var("USERPROFILE")
            .or_else(|_| std::env::var("HOME"))
            .map_err(|_| "USERPROFILE/HOME is not set".to_string())?;
        std::path::PathBuf::from(home).join("Downloads")
    };
    enforce_home_containment("browser_download_destination", &path, FsAccessKind::Write)?;
    Ok(path)
}
