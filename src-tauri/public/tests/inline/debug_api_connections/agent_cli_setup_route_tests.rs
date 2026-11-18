use super::reject_agent_cli_setup_inline_preset;

#[test]
fn mutating_agent_cli_setup_routes_reject_inline_presets() {
    assert!(reject_agent_cli_setup_inline_preset(false).is_ok());
    assert!(reject_agent_cli_setup_inline_preset(true)
        .unwrap_err()
        .contains("saved connectionId"));
}
