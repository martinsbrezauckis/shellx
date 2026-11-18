use super::taskkill_tree_args;

#[cfg(target_os = "windows")]
use super::trusted_system_taskkill_path;

#[test]
fn owned_windows_child_tree_uses_exact_pid_and_descendant_force_flags() {
    assert_eq!(
        taskkill_tree_args(4242),
        ["/PID", "4242", "/T", "/F"].map(str::to_string)
    );
}

#[cfg(target_os = "windows")]
#[test]
fn owned_windows_child_tree_resolves_the_kernel32_system_taskkill() {
    let path = trusted_system_taskkill_path().expect("resolve the trusted taskkill executable");
    assert!(path.is_absolute());
    assert!(path.is_file());
    assert_eq!(
        path.file_name().and_then(|name| name.to_str()),
        Some("taskkill.exe")
    );
}
