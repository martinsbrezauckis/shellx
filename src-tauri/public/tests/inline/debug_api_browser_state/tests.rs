use super::*;

#[test]
fn browser_quiet_check_reports_no_effects_and_preserves_revisions() {
    let registry = crate::shellx_browser::ShellxBrowserRegistry::default();
    let before = serde_json::to_value(registry.summary().revisions).expect("revisions");
    let settle = browser_idle_settle_snapshot(&registry, None).expect("idle settle snapshot");
    let check = browser_quiet_check_value(&registry, settle, None);
    let after = serde_json::to_value(registry.summary().revisions).expect("revisions");

    assert_eq!(check["schema"], "shellx/browser-quiet-check@1");
    assert_eq!(check["mode"], "quiet");
    assert!(check["effects"]
        .as_object()
        .is_some_and(|effects| effects.values().all(|value| value == false)));
    assert_eq!(check["summary"]["revisions"], before);
    assert_eq!(after, before);
}
