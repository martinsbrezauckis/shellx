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

#[cfg(test)]
mod tests {
    use super::{browser_download_destination_dir, browser_upload_display_name};

    #[test]
    fn upload_display_name_never_preserves_a_caller_supplied_path() {
        assert_eq!(
            browser_upload_display_name(r"C:\Users\FixtureUser\private\report.txt"),
            "report.txt"
        );
        assert_eq!(
            browser_upload_display_name("/home/fixture-user/private/report.txt"),
            "report.txt"
        );
    }

    #[test]
    fn browser_download_destination_rejects_sensitive_home_paths() {
        let home = std::env::var("HOME")
            .or_else(|_| std::env::var("USERPROFILE"))
            .expect("HOME/USERPROFILE exists for tests");
        let sensitive = std::path::PathBuf::from(home).join(".ssh");
        let err = browser_download_destination_dir(Some(&sensitive.to_string_lossy()))
            .expect_err("Browser downloads must not write to sensitive home paths");
        assert!(
            err.contains("sensitive") || err.contains("denylist"),
            "expected sensitive path denial, got: {err}"
        );
    }
}
