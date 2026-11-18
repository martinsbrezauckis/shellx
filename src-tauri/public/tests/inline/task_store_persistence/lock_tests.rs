use super::*;

#[test]
fn lock_owner_releases_before_an_inherited_descriptor_closes() {
    let directory = tempfile::tempdir().unwrap();
    let owner = acquire_store_lock(directory.path()).unwrap();
    let inherited = owner.file.try_clone().unwrap();
    assert!(acquire_store_lock(directory.path()).is_err());
    drop(owner);
    let reopened = acquire_store_lock(directory.path())
        .expect("dropping the owner releases the lock while its duplicated descriptor remains");
    drop(reopened);
    drop(inherited);
}
