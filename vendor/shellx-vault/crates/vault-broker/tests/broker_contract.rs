use vault_broker::devices::{DeviceKind, VaultDevice};
use vault_broker::profile::{ProfileDirInput, ProfileDirSource, ProfileDiscovery, ProfilePlatform};
use vault_broker::resources::ResourcePermission;
use vault_broker::VaultBroker;

#[test]
fn broker_contract_exposes_profile_discovery_from_one_product_api() {
    let tmp = tempfile::tempdir().unwrap();
    let broker = VaultBroker::for_profile_input(ProfileDirInput {
        platform: ProfilePlatform::Linux,
        home: Some(tmp.path().join("home")),
        xdg_config_home: Some(tmp.path().join("xdg")),
        appdata: None,
        override_dir: None,
    })
    .unwrap();

    assert_eq!(
        broker.profile_dirs().source,
        ProfileDirSource::PlatformDefault
    );
    assert_eq!(
        broker.profile_dirs().canonical_dir,
        tmp.path().join("xdg").join("shellx-vault")
    );
    assert!(matches!(
        broker.profile_discovery().unwrap(),
        ProfileDiscovery::NoProfile { .. }
    ));
}

#[test]
fn broker_contract_exposes_shared_device_registry() {
    let tmp = tempfile::tempdir().unwrap();
    let mut broker = VaultBroker::for_profile_input(ProfileDirInput {
        platform: ProfilePlatform::Linux,
        home: Some(tmp.path().join("home")),
        xdg_config_home: Some(tmp.path().join("xdg")),
        appdata: None,
        override_dir: None,
    })
    .unwrap();

    broker.devices_mut().register(VaultDevice {
        device_id: "workstation".to_string(),
        label: "Workstation".to_string(),
        kind: DeviceKind::Linux,
        created_at_ms: 1,
        revoked_at_ms: None,
    });

    assert!(broker.devices().is_active("workstation"));
}

#[test]
fn broker_contract_exposes_shared_grant_policy() {
    let tmp = tempfile::tempdir().unwrap();
    let mut broker = VaultBroker::for_profile_input(ProfileDirInput {
        platform: ProfilePlatform::Linux,
        home: Some(tmp.path().join("home")),
        xdg_config_home: Some(tmp.path().join("xdg")),
        appdata: None,
        override_dir: None,
    })
    .unwrap();

    broker
        .grant_policy_mut()
        .set_resource_permission("res-user-only", ResourcePermission::UserOnly);

    assert!(
        broker
            .grant_policy()
            .agent_visible_resources()
            .all(|resource_id| resource_id != "res-user-only"),
        "user-only resources must be hidden through the broker policy API"
    );
}
