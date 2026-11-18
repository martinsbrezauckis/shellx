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
