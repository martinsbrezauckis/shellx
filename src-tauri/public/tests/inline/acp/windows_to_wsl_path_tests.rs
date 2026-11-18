use super::windows_to_wsl_path;

#[test]
fn translates_ascii_windows_drives_without_slicing_unicode() {
    assert_eq!(
        windows_to_wsl_path(r"C:\Users\ExampleUser"),
        "/mnt/c/Users/ExampleUser"
    );
    assert_eq!(windows_to_wsl_path("€:/not-a-drive"), "€:/not-a-drive");
    assert_eq!(windows_to_wsl_path("/home/example"), "/home/example");
}
