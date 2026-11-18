use super::*;

struct FailingReader {
    first: bool,
}

impl Read for FailingReader {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        if self.first {
            self.first = false;
            buffer[..4].copy_from_slice(b"part");
            Ok(4)
        } else {
            Err(std::io::Error::other("injected source failure"))
        }
    }
}

struct FailingWriter {
    first: bool,
}

impl Write for FailingWriter {
    fn write(&mut self, buffer: &[u8]) -> std::io::Result<usize> {
        if self.first {
            self.first = false;
            Ok(buffer.len().min(2))
        } else {
            Err(std::io::Error::other("injected destination failure"))
        }
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

#[test]
fn local_member_copy_reports_midstream_source_and_destination_faults() {
    let source_error = copy_archive_member(&mut FailingReader { first: true }, &mut Vec::new())
        .expect_err("a truncated source must fail the archive");
    assert!(source_error.to_string().contains("source failure"));

    let destination_error = copy_archive_member(
        &mut std::io::Cursor::new(b"complete"),
        &mut FailingWriter { first: true },
    )
    .expect_err("a truncated destination must fail the archive");
    assert!(destination_error
        .to_string()
        .contains("destination failure"));
}

#[test]
fn archive_admission_refuses_overlap_and_only_its_owner_removes_the_entry() {
    let tab_key = format!("archive-regression-{}", uuid::Uuid::new_v4());
    let first = ArchiveAdmission::reserve(&tab_key).expect("first owner");
    assert!(ArchiveAdmission::reserve(&tab_key).is_err());
    let first_control = first.control.clone();
    assert!(abort_in_flight_archive(&tab_key));
    assert!(first_control.canceled());
    // Exercise the stale-owner guard directly: a superseded owner cannot
    // remove another generation's entry during drop.
    let newer = first.owner.wrapping_add(1);
    let newer_control = Arc::new(ArchiveControl::new());
    lock_in_flight_archives().insert(
        tab_key.clone(),
        InFlightArchive {
            owner: newer,
            control: newer_control.clone(),
        },
    );
    drop(first);
    assert!(lock_in_flight_archives().contains_key(&tab_key));
    assert!(!newer_control.canceled());
    assert!(abort_in_flight_archive(&tab_key));
    assert!(newer_control.canceled());
    lock_in_flight_archives().remove(&tab_key);
    assert!(!abort_in_flight_archive(&tab_key));
}

#[cfg(unix)]
#[tokio::test]
async fn tab_abort_is_delivered_to_the_live_ssh_owner_and_releases_admission() {
    let dir = tempfile::tempdir().unwrap();
    let destination = dir.path().join("previous.tar.gz");
    std::fs::write(&destination, b"previous complete archive").unwrap();
    let tab_key = format!("archive-regression-{}", uuid::Uuid::new_v4());
    let task_key = tab_key.clone();
    let task_destination = destination.clone();
    let active = tokio::spawn(async move {
        let mut command = tokio::process::Command::new("sh");
        command.args(["-c", "printf partial; sleep 30 & wait"]);
        stream_owned_archive_command(
            &mut command,
            &task_destination,
            &task_key,
            std::time::Duration::from_secs(30),
            1024,
        )
        .await
    });
    for _ in 0..100 {
        if lock_in_flight_archives().contains_key(&tab_key) {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    assert!(abort_in_flight_archive(&tab_key));
    let error = tokio::time::timeout(std::time::Duration::from_secs(5), active)
        .await
        .expect("owned child must stop promptly")
        .unwrap()
        .unwrap_err();
    assert!(error.contains("canceled"), "{error}");
    assert!(!abort_in_flight_archive(&tab_key));
    assert_eq!(
        std::fs::read(&destination).unwrap(),
        b"previous complete archive"
    );
    assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
}

#[cfg(unix)]
#[tokio::test]
async fn completed_ssh_archive_releases_abort_ownership() {
    let dir = tempfile::tempdir().unwrap();
    let destination = dir.path().join("complete.tar.gz");
    let tab_key = format!("archive-regression-{}", uuid::Uuid::new_v4());
    let mut command = tokio::process::Command::new("sh");
    command.args(["-c", "printf complete"]);
    let copied = stream_owned_archive_command(
        &mut command,
        &destination,
        &tab_key,
        std::time::Duration::from_secs(2),
        1024,
    )
    .await
    .expect("owned archive should complete");
    assert_eq!(copied, 8);
    assert_eq!(std::fs::read(&destination).unwrap(), b"complete");
    assert!(!abort_in_flight_archive(&tab_key));
}

#[test]
fn canceled_blocking_owner_cannot_promote_over_existing_or_new_archive() {
    let dir = tempfile::tempdir().unwrap();
    let destination = dir.path().join("session.zip");
    std::fs::write(&destination, b"old complete archive").unwrap();
    let tab_key = format!("archive-regression-{}", uuid::Uuid::new_v4());
    let admission = ArchiveAdmission::reserve(&tab_key).unwrap();
    let control = admission.control.clone();
    let caller = ArchiveCallerCancel {
        control: control.clone(),
        armed: true,
    };
    let (release_tx, release_rx) = std::sync::mpsc::channel::<()>();
    let worker_destination = destination.clone();
    let worker = std::thread::spawn(move || {
        let _admission = admission;
        let staging =
            tempfile::NamedTempFile::new_in(worker_destination.parent().unwrap()).unwrap();
        std::fs::write(staging.path(), b"canceled bytes").unwrap();
        release_rx.recv().unwrap();
        control
            .promote(|| {
                staging
                    .persist(&worker_destination)
                    .map_err(|error| error.error.to_string())
            })
            .unwrap_err()
    });
    drop(caller);
    assert_eq!(
        std::fs::read(&destination).unwrap(),
        b"old complete archive"
    );
    assert!(
        ArchiveAdmission::reserve(&tab_key).is_err(),
        "worker retains admission"
    );
    release_tx.send(()).unwrap();
    assert!(worker.join().unwrap().contains("canceled"));
    assert_eq!(
        std::fs::read(&destination).unwrap(),
        b"old complete archive"
    );
    let newer = ArchiveAdmission::reserve(&tab_key).unwrap();
    let staging = tempfile::NamedTempFile::new_in(dir.path()).unwrap();
    std::fs::write(staging.path(), b"new complete archive").unwrap();
    newer
        .control
        .promote(|| {
            staging
                .persist(&destination)
                .map_err(|error| error.error.to_string())
        })
        .unwrap();
    drop(newer);
    assert_eq!(
        std::fs::read(&destination).unwrap(),
        b"new complete archive"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn ssh_stream_writes_held_stage_and_rejects_replaced_stage_path() {
    use tokio::io::AsyncWriteExt as _;
    let dir = tempfile::tempdir().unwrap();
    let sentinel = dir.path().join("sentinel");
    std::fs::write(&sentinel, b"must survive").unwrap();
    let staging = tempfile::NamedTempFile::new_in(dir.path()).unwrap();
    let owned_path = staging.path().to_path_buf();
    let output = tokio::fs::File::from_std(staging.as_file().try_clone().unwrap());
    std::fs::remove_file(&owned_path).unwrap();
    std::os::unix::fs::symlink(&sentinel, &owned_path).unwrap();
    let (mut sender, receiver) = tokio::io::duplex(32);
    sender.write_all(b"owned archive bytes").await.unwrap();
    drop(sender);
    assert_eq!(
        copy_archive_stdout(receiver, output, 1024).await.unwrap(),
        19
    );
    assert_eq!(std::fs::read(&sentinel).unwrap(), b"must survive");
    assert!(ensure_owned_staging_path(staging.as_file(), staging.path()).is_err());
}

#[cfg(unix)]
#[tokio::test]
async fn failed_ssh_stream_preserves_existing_destination_and_removes_its_staging() {
    let dir = tempfile::tempdir().unwrap();
    let destination = dir.path().join("previous.tar.gz");
    std::fs::write(&destination, b"previous complete archive").unwrap();
    let tab_key = format!("archive-regression-{}", uuid::Uuid::new_v4());
    let mut command = tokio::process::Command::new("sh");
    command.args(["-c", "printf partial; exit 7"]);
    let error = stream_owned_archive_command(
        &mut command,
        &destination,
        &tab_key,
        std::time::Duration::from_secs(2),
        1024,
    )
    .await
    .expect_err("failed child must not promote partial data");
    assert!(error.contains("exited 7"), "{error}");
    assert_eq!(
        std::fs::read(&destination).unwrap(),
        b"previous complete archive"
    );
    assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
    assert!(!lock_in_flight_archives().contains_key(&tab_key));
}

#[cfg(unix)]
#[tokio::test]
async fn overlapping_ssh_stream_is_refused_before_it_can_replace_abort_owner() {
    let dir = tempfile::tempdir().unwrap();
    let destination = dir.path().join("previous.tar.gz");
    std::fs::write(&destination, b"previous complete archive").unwrap();
    let tab_key = format!("archive-regression-{}", uuid::Uuid::new_v4());
    let task_key = tab_key.clone();
    let task_destination = destination.clone();
    let active = tokio::spawn(async move {
        let mut command = tokio::process::Command::new("sh");
        command.args(["-c", "printf partial; sleep 30 & wait"]);
        stream_owned_archive_command(
            &mut command,
            &task_destination,
            &task_key,
            std::time::Duration::from_secs(30),
            1024,
        )
        .await
    });
    for _ in 0..100 {
        if lock_in_flight_archives().contains_key(&tab_key) {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    let first_control = lock_in_flight_archives()
        .get(&tab_key)
        .map(|entry| entry.control.clone())
        .expect("first command registered");
    let mut second = tokio::process::Command::new("sh");
    second.args(["-c", "printf second"]);
    let error = stream_owned_archive_command(
        &mut second,
        &destination,
        &tab_key,
        std::time::Duration::from_secs(2),
        1024,
    )
    .await
    .expect_err("second child must be refused");
    assert!(error.contains("already active"), "{error}");
    assert!(Arc::ptr_eq(
        &lock_in_flight_archives().get(&tab_key).unwrap().control,
        &first_control
    ));
    active.abort();
    assert!(active.await.unwrap_err().is_cancelled());
    assert!(!lock_in_flight_archives().contains_key(&tab_key));
    assert_eq!(
        std::fs::read(&destination).unwrap(),
        b"previous complete archive"
    );
    assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
}
