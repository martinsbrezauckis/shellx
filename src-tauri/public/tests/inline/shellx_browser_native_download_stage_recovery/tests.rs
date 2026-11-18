use std::path::Path;

use super::*;

const UUID: &str = "550e8400e29b41d4a716446655440000";

fn marker(number: usize) -> String {
    let uuid = format!("{number:032x}");
    native_stage_marker_name(&format!("shellx-native-{uuid}.part")).unwrap()
}

fn prepared_directory(path: &Path) -> PreparedBrowserDestinationDir {
    PreparedBrowserDestinationDir {
        display_path: path.to_path_buf(),
        #[cfg(unix)]
        directory: open_trusted_directory(path).unwrap(),
        #[cfg(windows)]
        ancestor_handles: vec![open_windows_directory_no_reparse(path).unwrap()],
    }
}

#[test]
fn marker_name_accepts_only_the_created_opaque_stage_shape() {
    assert_eq!(
        native_stage_marker_name(&format!("shellx-native-{UUID}.part")).unwrap(),
        format!("shellx-native-{UUID}.part.pending")
    );
    for invalid in [
        "shellx-native-550e8400-e29b-41d4-a716-446655440000.part",
        "shellx-native-550E8400E29B41D4A716446655440000.part",
        "shellx-native-550e8400e29b41d4a716446655440000.part.pending",
        "../shellx-native-550e8400e29b41d4a716446655440000.part",
        "shellx-native-550e8400e29b41d4a716446655440000.part/child",
    ] {
        assert!(
            native_stage_marker_name(invalid).is_err(),
            "accepted {invalid}"
        );
    }
}

#[test]
fn capacity_counts_only_exact_pending_markers_without_touching_unrelated_files() {
    let directory = tempfile::tempdir().unwrap();
    let prepared = prepared_directory(directory.path());
    for number in 0..MAX_RETAINED_NATIVE_DOWNLOAD_STAGES - 1 {
        std::fs::write(directory.path().join(marker(number)), []).unwrap();
    }
    for name in [
        "shellx-native-not-a-uuid.part.pending",
        "shellx-native-550e8400e29b41d4a716446655440000.part",
        "unrelated.pending",
    ] {
        std::fs::write(directory.path().join(name), []).unwrap();
    }
    assert_eq!(
        retained_native_stage_count_from_directory(&prepared).unwrap(),
        31
    );
    ensure_native_stage_capacity(&prepared).unwrap();
    assert!(directory.path().join("unrelated.pending").exists());

    std::fs::write(
        directory
            .path()
            .join(marker(MAX_RETAINED_NATIVE_DOWNLOAD_STAGES)),
        [],
    )
    .unwrap();
    assert_eq!(
        retained_native_stage_count_from_directory(&prepared).unwrap(),
        32
    );
    let error = ensure_native_stage_capacity(&prepared).unwrap_err();
    assert!(error.contains("interrupted-stage retention limit"));
    assert!(error.contains("cleanup is pending"));
    assert!(!error.contains(&directory.path().display().to_string()));
}

#[test]
fn capacity_rejects_a_directory_that_exceeds_the_bounded_scan() {
    let directory = tempfile::tempdir().unwrap();
    let prepared = prepared_directory(directory.path());
    for number in 0..=MAX_NATIVE_STAGE_DIRECTORY_ENTRIES {
        std::fs::write(directory.path().join(format!("unrelated-{number}")), []).unwrap();
    }
    let error = ensure_native_stage_capacity(&prepared).unwrap_err();
    assert!(error.contains("bounded entry limit"));
    assert!(error.contains("cleanup is pending"));
    assert!(!error.contains(&directory.path().display().to_string()));
}

#[cfg(unix)]
#[test]
fn capacity_inspects_the_retained_directory_after_display_path_replacement() {
    let root = tempfile::tempdir().unwrap();
    let original = root.path().join("original");
    std::fs::create_dir(&original).unwrap();
    let prepared = prepared_directory(&original);
    for number in 0..MAX_RETAINED_NATIVE_DOWNLOAD_STAGES {
        std::fs::write(original.join(marker(number)), []).unwrap();
    }
    let moved = root.path().join("moved");
    std::fs::rename(&original, &moved).unwrap();
    std::fs::create_dir(&original).unwrap();

    let error = ensure_native_stage_capacity(&prepared).unwrap_err();
    assert!(error.contains("interrupted-stage retention limit"));
    assert!(!error.contains(&original.display().to_string()));
}
