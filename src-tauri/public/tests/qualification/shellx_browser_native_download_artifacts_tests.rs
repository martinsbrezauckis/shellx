use super::*;
use std::io::Write;

#[cfg(windows)]
use std::ffi::c_void;
#[cfg(windows)]
use std::os::windows::ffi::OsStrExt;
#[cfg(windows)]
use std::os::windows::{fs::OpenOptionsExt, io::AsRawHandle};

use crate::shellx_browser::{
    BrowserDownloadRequest, BrowserTransferApprovalRequest, BrowserTransferCompleteRequest,
    ShellxBrowserRegistry, StartBrowserTaskRequest,
};
use crate::shellx_browser_transfers::mark_browser_transfer_operator_approved;

fn prepared_directory(path: &Path) -> PreparedBrowserDestinationDir {
    PreparedBrowserDestinationDir {
        display_path: path.to_path_buf(),
        #[cfg(unix)]
        directory: open_trusted_directory(path).unwrap(),
        #[cfg(windows)]
        ancestor_handles: vec![open_windows_directory_no_reparse(path).unwrap()],
    }
}

#[cfg(windows)]
fn windows_stage_identity(directory: &PreparedBrowserDestinationDir) -> WindowsDirectoryIdentity {
    windows_directory_identity(
        directory
            .ancestor_handles
            .last()
            .expect("Windows test directory retains a final handle"),
    )
    .expect("Windows test directory has a stable identity")
}

#[cfg(windows)]
#[link(name = "kernel32")]
extern "system" {
    fn DeviceIoControl(
        device: HANDLE,
        control_code: u32,
        input_buffer: *const c_void,
        input_buffer_size: u32,
        output_buffer: *mut c_void,
        output_buffer_size: u32,
        bytes_returned: *mut u32,
        overlapped: *mut c_void,
    ) -> i32;
}

#[cfg(windows)]
fn mount_point_reparse_buffer(target: &Path) -> Vec<u8> {
    const IO_REPARSE_TAG_MOUNT_POINT: u32 = 0xA000_0003;
    let mut substitute_name = vec![b'\\' as u16, b'?' as u16, b'?' as u16, b'\\' as u16];
    substitute_name.extend(target.as_os_str().encode_wide());
    let print_name: Vec<u16> = target.as_os_str().encode_wide().collect();
    let substitute_bytes = u16::try_from(substitute_name.len() * 2)
        .expect("owned test path fits a mount-point buffer");
    let print_bytes =
        u16::try_from(print_name.len() * 2).expect("owned test path fits a mount-point buffer");
    let path_bytes = usize::from(substitute_bytes) + 2 + usize::from(print_bytes) + 2;
    let reparse_data_length =
        u16::try_from(8 + path_bytes).expect("owned test reparse data fits documented bounds");
    let mut buffer = Vec::with_capacity(8 + usize::from(reparse_data_length));
    buffer.extend(IO_REPARSE_TAG_MOUNT_POINT.to_le_bytes());
    buffer.extend(reparse_data_length.to_le_bytes());
    buffer.extend(0u16.to_le_bytes());
    buffer.extend(0u16.to_le_bytes());
    buffer.extend(substitute_bytes.to_le_bytes());
    buffer.extend((substitute_bytes + 2).to_le_bytes());
    buffer.extend(print_bytes.to_le_bytes());
    for value in substitute_name {
        buffer.extend(value.to_le_bytes());
    }
    buffer.extend(0u16.to_le_bytes());
    for value in print_name {
        buffer.extend(value.to_le_bytes());
    }
    buffer.extend(0u16.to_le_bytes());
    assert_eq!(buffer.len(), 8 + usize::from(reparse_data_length));
    buffer
}

#[test]
fn successful_empty_native_download_retains_empty_digest_and_cleans_stage() {
    let source = tempfile::tempdir().unwrap();
    // Completion enforces the real home boundary. Use only this owned,
    // automatically removed fixture, without changing process-wide HOME.
    let destination = tempfile::Builder::new()
        .prefix("shellx-native-empty-test-")
        .tempdir_in(configured_browser_home().unwrap())
        .unwrap();
    let path = source.path().join("empty.part");
    std::fs::write(&path, []).unwrap();
    let source_directory = prepared_directory(source.path());
    let marker_file_name = "empty.part.pending";
    let marker_guard =
        reserve_native_browser_download_stage_marker(&source_directory, marker_file_name)
            .expect("reserve valid empty-stage marker")
            .expect("empty-stage marker path was unused");
    #[cfg(windows)]
    let windows_directory_identity = windows_stage_identity(&source_directory);
    let stage = BrowserNativeDownloadStage {
        directory: source_directory,
        file_name: "empty.part".into(),
        marker_file_name: marker_file_name.into(),
        path: path.clone(),
        #[cfg(windows)]
        marker_guard: Mutex::new(Some(marker_guard)),
        #[cfg(windows)]
        windows_directory_identity,
    };
    #[cfg(not(windows))]
    drop(marker_guard);
    let directory = prepared_directory(destination.path());
    let result = finalize_to_prepared_directory(&stage, directory, "empty.txt").unwrap();
    assert_eq!(result.artifact().bytes, 0);
    assert_eq!(
        result.artifact().sha256,
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
    assert!(std::fs::metadata(&result.artifact().final_path)
        .unwrap()
        .is_file());
    assert_eq!(
        std::fs::metadata(&result.artifact().final_path)
            .unwrap()
            .len(),
        0
    );
    assert!(!path.exists(), "successful stage is removed");
    complete_native_browser_download_stage(&stage).expect("valid marker is cleaned after success");
    assert!(!source.path().join(marker_file_name).exists());
    let registry = ShellxBrowserRegistry::default();
    let source_url = "https://downloads.example.test/empty.txt";
    let task = registry
        .start_task(StartBrowserTaskRequest {
            goal: "download an empty file".into(),
            start_url: Some(source_url.into()),
            expected_domains: Some(vec!["downloads.example.test".into()]),
            ..Default::default()
        })
        .unwrap();
    let download = registry
        .request_download_intent(BrowserDownloadRequest {
            task_id: Some(task.task_id),
            url: source_url.into(),
            file_name: Some("empty.txt".into()),
            reason: "empty native download fixture".into(),
            requires_operator_approval: true,
            ..Default::default()
        })
        .unwrap();
    let approval = registry
        .grant_transfer_for_user(mark_browser_transfer_operator_approved(
            BrowserTransferApprovalRequest {
                transfer_id: download.transfer_id.clone(),
                direction: "download".into(),
                origin: Some(source_url.into()),
                ..Default::default()
            },
        ))
        .unwrap();
    let completed = registry
        .complete_download_from_protected_artifact(
            BrowserTransferCompleteRequest {
                transfer_id: download.transfer_id,
                final_path: Some(result.artifact().final_path.clone()),
                mime_type: Some("text/plain".into()),
                bytes: Some(0),
                sha256: Some(result.artifact().sha256.clone()),
                source_url: Some(source_url.into()),
                destination: Some("native-webview".into()),
                retention_reason: Some("nativeBrowserDownload".into()),
                approval_id: Some(approval.approval_id),
            },
            &result,
        )
        .unwrap();
    assert_eq!(completed.status, "completed");
    assert_eq!(completed.bytes, Some(0));
    assert_eq!(
        completed.sha256.as_deref(),
        Some(result.artifact().sha256.as_str())
    );
}

#[test]
fn missing_native_stage_is_not_an_empty_success() {
    let source = tempfile::tempdir().unwrap();
    let destination = tempfile::tempdir().unwrap();
    let source_directory = prepared_directory(source.path());
    #[cfg(windows)]
    let windows_directory_identity = windows_stage_identity(&source_directory);
    let stage = BrowserNativeDownloadStage {
        directory: source_directory,
        file_name: "missing.part".into(),
        marker_file_name: "missing.part.pending".into(),
        path: source.path().join("missing.part"),
        #[cfg(windows)]
        marker_guard: Mutex::new(None),
        #[cfg(windows)]
        windows_directory_identity,
    };
    let directory = prepared_directory(destination.path());
    assert!(finalize_to_prepared_directory(&stage, directory, "missing.txt").is_err());
    assert_eq!(std::fs::read_dir(destination.path()).unwrap().count(), 0);
}

#[test]
fn retained_partial_native_destination_keeps_recovery_marker_without_fabricated_metadata() {
    let root = tempfile::tempdir().expect("fixture directory exists");
    let directory = prepared_directory(root.path());
    let file_name = format!("shellx-native-{}.part", uuid::Uuid::new_v4().simple());
    let marker_file_name = native_download_stage_recovery::native_stage_marker_name(&file_name)
        .expect("opaque stage name has an exact marker leaf");
    let marker_guard = reserve_native_browser_download_stage_marker(&directory, &marker_file_name)
        .expect("reserve marker")
        .expect("opaque stage marker is reserved");
    #[cfg(windows)]
    let expected_windows_directory_identity = windows_stage_identity(&directory);
    let stage = BrowserNativeDownloadStage {
        directory,
        file_name,
        marker_file_name: marker_file_name.clone(),
        path: root.path().join("unused-stage.part"),
        #[cfg(windows)]
        marker_guard: Mutex::new(Some(marker_guard)),
        #[cfg(windows)]
        windows_directory_identity: expected_windows_directory_identity,
    };
    #[cfg(not(windows))]
    drop(marker_guard);
    let retained_final = root.path().join("partial-final.bin");
    let retained_final_text = retained_final.to_string_lossy().into_owned();
    std::fs::write(&retained_final, b"partial").expect("write created destination");

    let error = retained_native_download_finalization_error(
        &stage,
        &retained_final,
        None,
        None,
        "synthetic interrupted copy".to_string(),
    );
    assert!(matches!(
        error,
        BrowserNativeDownloadFinalizationError::RetainedFinal {
            bytes: None,
            sha256: None,
            ..
        }
    ));
    assert_eq!(
        std::fs::read(&retained_final).expect("created destination remains"),
        b"partial"
    );
    // Windows rewrites through the retained exclusive marker handle. A
    // second record must seek after truncation rather than leaving a sparse
    // JSON file at the previous cursor position.
    record_native_browser_download_final_cleanup_pending(&stage, &retained_final_text, None, None)
        .expect("rewrite retained marker through its existing handle");
    #[cfg(windows)]
    {
        // The production handle remains exclusive until descriptor-bound
        // cleanup. This fixture releases it only to inspect the completed
        // JSON payload after the second rewrite.
        drop(
            stage
                .marker_guard
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .take(),
        );
    }
    let marker: serde_json::Value = serde_json::from_slice(
        &std::fs::read(root.path().join(marker_file_name)).expect("read retained marker"),
    )
    .expect("marker is JSON");
    assert_eq!(
        marker.get("state"),
        Some(&serde_json::json!("cleanupPending"))
    );
    assert_eq!(
        marker.get("finalPath"),
        Some(&serde_json::json!(retained_final_text))
    );
    assert_eq!(marker.get("bytes"), Some(&serde_json::Value::Null));
    assert_eq!(marker.get("sha256"), Some(&serde_json::Value::Null));
}

#[cfg(windows)]
#[test]
fn windows_stage_handoff_retains_exclusive_marker_while_allowing_child_rename() {
    let root = tempfile::tempdir().expect("fixture directory exists");
    let parent = root.path().join("parent");
    let stage_path = parent.join("stage");
    std::fs::create_dir(&parent).expect("create owned parent");
    std::fs::create_dir(&stage_path).expect("create owned stage");
    let mut directory = PreparedBrowserDestinationDir {
        display_path: stage_path.clone(),
        ancestor_handles: vec![
            open_windows_directory_no_reparse(&parent).expect("pin owned parent"),
            open_windows_directory_no_reparse(&stage_path).expect("pin owned stage"),
        ],
    };
    let file_name = format!("shellx-native-{}.part", uuid::Uuid::new_v4().simple());
    let marker_file_name = native_download_stage_recovery::native_stage_marker_name(&file_name)
        .expect("opaque stage name has an exact marker leaf");
    let marker_guard = reserve_native_browser_download_stage_marker(&directory, &marker_file_name)
        .expect("reserve exclusive marker")
        .expect("marker path was unused");
    let expected_windows_directory_identity = windows_stage_identity(&directory);
    let final_guard = directory
        .ancestor_handles
        .pop()
        .expect("stage has a direct guard to hand off");
    drop(final_guard);
    assert_eq!(directory.ancestor_handles.len(), 1, "parent stays pinned");
    let stage = BrowserNativeDownloadStage {
        directory,
        file_name: file_name.clone(),
        marker_file_name: marker_file_name.clone(),
        path: stage_path.join(&file_name),
        marker_guard: Mutex::new(Some(marker_guard)),
        windows_directory_identity: expected_windows_directory_identity,
    };

    let empty_sibling = parent.join("empty-sibling");
    std::fs::create_dir(&empty_sibling).expect("create sibling under pinned parent");
    // The parent pin is not a child-delete lock. The exclusive marker is
    // the final stage's nonempty/reparse defense, so this behavior stays
    // explicit rather than becoming an accidental security assumption.
    std::fs::remove_dir(&empty_sibling).expect("empty sibling delete remains permitted");

    std::fs::write(stage.path(), b"temporary").expect("create stage temporary leaf");
    let renamed = stage_path.join("renamed.part");
    std::fs::rename(stage.path(), &renamed).expect("temporary child rename is permitted");
    assert!(renamed.is_file());
    let renamed_marker = stage_path.join("renamed-marker.pending");
    assert!(
        std::fs::remove_file(stage_path.join(&marker_file_name)).is_err(),
        "the retained exclusive marker denies pathname deletion"
    );
    assert!(
        std::fs::rename(stage_path.join(&marker_file_name), &renamed_marker).is_err(),
        "the retained exclusive marker denies pathname rename"
    );
    assert!(
        std::fs::rename(&stage_path, parent.join("moved-stage")).is_err(),
        "the pinned stage and exclusive marker deny a stage-directory rename"
    );
    assert!(
        std::fs::remove_dir(&stage_path).is_err(),
        "the live marker keeps the stage directory unavailable for deletion"
    );

    native_download_stage_recovery::ensure_native_stage_capacity(&stage.directory)
        .expect("capacity inspection reads but does not remove active marker");
    assert!(stage_path.join(&marker_file_name).is_file());
    let strict = reacquire_strict_windows_stage_directory(&stage)
        .expect("strict stage handle is reacquired after handoff");
    assert_eq!(
        windows_directory_identity(&strict).expect("reacquired identity"),
        stage.windows_directory_identity
    );
    drop(strict);

    std::fs::remove_file(&renamed).expect("remove owned renamed temporary leaf");
    discard_native_browser_download_stage(&stage).expect("strict cleanup releases marker last");
    assert!(!stage_path.join(&marker_file_name).exists());
    complete_native_browser_download_stage(&stage)
        .expect("already-removed marker cleanup remains idempotent");
}

#[cfg(windows)]
#[test]
fn windows_stage_handoff_sentinel_refuses_mount_point_reparse_mutation() {
    const ERROR_DIR_NOT_EMPTY: u32 = 145;
    const FILE_SHARE_READ: u32 = 0x0000_0001;
    const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
    const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
    const FSCTL_SET_REPARSE_POINT: u32 = 0x0009_00A4;

    let root = tempfile::tempdir().expect("fixture directory exists");
    let parent = root.path().join("parent");
    let stage_path = parent.join("stage");
    let target = parent.join("target");
    std::fs::create_dir(&parent).expect("create owned parent");
    std::fs::create_dir(&stage_path).expect("create owned stage");
    std::fs::create_dir(&target).expect("create owned reparse target");
    let mut directory = PreparedBrowserDestinationDir {
        display_path: stage_path.clone(),
        ancestor_handles: vec![
            open_windows_directory_no_reparse(&parent).expect("pin owned parent"),
            open_windows_directory_no_reparse(&stage_path).expect("pin owned stage"),
        ],
    };
    let file_name = format!("shellx-native-{}.part", uuid::Uuid::new_v4().simple());
    let marker_file_name = native_download_stage_recovery::native_stage_marker_name(&file_name)
        .expect("opaque stage name has an exact marker leaf");
    let marker_guard = reserve_native_browser_download_stage_marker(&directory, &marker_file_name)
        .expect("reserve exclusive marker")
        .expect("marker path was unused");
    let windows_directory_identity = windows_stage_identity(&directory);
    drop(
        directory
            .ancestor_handles
            .pop()
            .expect("stage has a direct guard to hand off"),
    );
    let stage = BrowserNativeDownloadStage {
        directory,
        file_name,
        marker_file_name,
        path: stage_path.join("unused-stage.part"),
        marker_guard: Mutex::new(Some(marker_guard)),
        windows_directory_identity,
    };

    let writer = std::fs::OpenOptions::new()
        .write(true)
        .share_mode(FILE_SHARE_READ)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
        .open(&stage_path)
        .expect("stage accepts the WebView-style directory writer after handoff");
    let buffer = mount_point_reparse_buffer(&target);
    let mut bytes_returned = 0u32;
    // SAFETY: the writer is a live directory handle and the owned reparse
    // buffer has the mount-point ABI used by FSCTL_SET_REPARSE_POINT.
    let set = unsafe {
        DeviceIoControl(
            writer.as_raw_handle() as HANDLE,
            FSCTL_SET_REPARSE_POINT,
            buffer.as_ptr().cast(),
            buffer.len() as u32,
            std::ptr::null_mut(),
            0,
            &mut bytes_returned,
            std::ptr::null_mut(),
        )
    };
    assert_eq!(set, 0, "exclusive pending sentinel blocks reparse mutation");
    // SAFETY: DeviceIoControl just failed and documents GetLastError as its
    // error source. Windows reports the sentinel as a nonempty directory.
    assert_eq!(unsafe { GetLastError() }, ERROR_DIR_NOT_EMPTY);
    drop(writer);

    discard_native_browser_download_stage(&stage)
        .expect("strict cleanup removes the exclusive sentinel");
}

#[cfg(unix)]
#[test]
fn posix_protected_rollback_retains_the_final_leaf_for_recovery() {
    let root = tempfile::tempdir().expect("fixture directory exists");
    let destination_dir = prepared_directory(root.path());
    let mut destination = create_unique_destination_file(&destination_dir, "retained.bin")
        .expect("exclusive destination reserves its leaf");
    destination
        .file
        .write_all(b"owned bytes")
        .expect("owned destination writes");
    let owned_path = destination.path.clone();
    let artifact = ProtectedBrowserNativeDownloadArtifact {
        artifact: BrowserLocalArtifact {
            final_path: owned_path.to_string_lossy().into_owned(),
            display_name: "retained.bin".to_string(),
            mime_type: None,
            bytes: b"owned bytes".len() as u64,
            sha256: "0".repeat(64),
        },
        _destination_dir: destination_dir,
        _destination_file: destination.file,
    };

    let error = discard_protected_native_browser_download_artifact(artifact)
        .expect_err("POSIX must not delete a name after losing exact leaf identity");
    assert!(error.contains("retained"), "got: {error}");
    assert_eq!(
        std::fs::read(&owned_path).expect("final leaf remains for recovery"),
        b"owned bytes"
    );
}

#[cfg(windows)]
#[test]
fn windows_protected_rollback_deletes_only_the_retained_create_new_handle() {
    let root = tempfile::tempdir().expect("fixture directory exists");
    let destination_dir = prepared_directory(root.path());
    let mut destination = create_unique_destination_file(&destination_dir, "rollback.bin")
        .expect("exclusive destination reserves its leaf");
    destination
        .file
        .write_all(b"owned bytes")
        .expect("owned destination writes");
    let owned_path = destination.path.clone();
    let replacement = root.path().join("replacement.bin");
    std::fs::write(&replacement, b"replacement bytes").expect("replacement fixture writes");

    assert!(
        std::fs::remove_file(&owned_path).is_err(),
        "the retained exclusive handle denies a pathname delete before rollback"
    );
    assert!(
        std::fs::rename(&replacement, &owned_path).is_err(),
        "the retained exclusive handle denies replacing its reserved leaf"
    );

    let artifact = ProtectedBrowserNativeDownloadArtifact {
        artifact: BrowserLocalArtifact {
            final_path: owned_path.to_string_lossy().into_owned(),
            display_name: "rollback.bin".to_string(),
            mime_type: None,
            bytes: b"owned bytes".len() as u64,
            sha256: "0".repeat(64),
        },
        _destination_dir: destination_dir,
        _destination_file: destination.file,
    };
    discard_protected_native_browser_download_artifact(artifact)
        .expect("rollback disposes the exact CREATE_NEW handle");
    assert!(
        !owned_path.exists(),
        "the original reserved leaf is removed after handle disposition"
    );

    std::fs::rename(&replacement, &owned_path)
        .expect("a later replacement is possible only after owned rollback completes");
    assert_eq!(
        std::fs::read(&owned_path).expect("replacement remains present"),
        b"replacement bytes"
    );
}
