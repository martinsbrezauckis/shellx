use super::*;

fn parse(value: &str) -> Result<String, &'static str> {
    parse_manual_open_url(&Url::parse(value).expect("test URL parses"))
}

#[test]
fn accepts_exact_manual_open_url_in_either_query_order() {
    assert_eq!(
        parse("shellx-app://manual/open?feature=shellx.interface.settings.vault&v=1"),
        Ok("shellx.interface.settings.vault".to_string())
    );
    assert_eq!(
        parse("shellx-app://manual/open?v=1&feature=shellx.interface.right.tasks"),
        Ok("shellx.interface.right.tasks".to_string())
    );
}

#[test]
fn rejects_alternate_uri_shapes_and_query_smuggling() {
    for value in [
        "other-app://manual/open?feature=shellx.interface.right.tasks&v=1",
        "shellx-app://other/open?feature=shellx.interface.right.tasks&v=1",
        "shellx-app://manual/other?feature=shellx.interface.right.tasks&v=1",
        "shellx-app://manual/open?feature=shellx.interface.right.tasks&v=2",
        "shellx-app://manual/open?feature=shellx.interface.right.tasks",
        "shellx-app://manual/open?feature=shellx.interface.right.tasks&v=1&extra=1",
        "shellx-app://manual/open?feature=shellx.interface.right.tasks&feature=other&v=1",
        "shellx-app://manual/open?feature=shellx.interface.right.tasks&v=1#ignored",
        "shellx-app://user@manual/open?feature=shellx.interface.right.tasks&v=1",
        "shellx-app://manual:444/open?feature=shellx.interface.right.tasks&v=1",
        "shellx-app://manual/open?feature=%00&v=1",
    ] {
        assert!(parse(value).is_err(), "must reject {value}");
    }
}

#[test]
fn queue_is_last_wins_and_claim_is_destructive() {
    let state = ManualDeepLinkState::default();
    let first = state.enqueue_main("shellx.interface.right.tasks".to_string());
    let second = state.enqueue_main("shellx.interface.settings.vault".to_string());
    assert!(second.sequence > first.sequence);
    assert_eq!(state.take_main(), Some(second));
    assert_eq!(state.take_main(), None);
}
