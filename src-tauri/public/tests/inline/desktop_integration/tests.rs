use super::parse_external_attachment_args;

#[test]
fn parses_attach_flag_with_multiple_paths() {
    let args = vec![
        "shellx.exe",
        "--attach",
        r"C:\Users\FixtureUser\one.txt",
        r"C:\Users\FixtureUser\two.md",
    ];
    assert_eq!(
        parse_external_attachment_args(args),
        vec![
            r"C:\Users\FixtureUser\one.txt",
            r"C:\Users\FixtureUser\two.md"
        ]
    );
}

#[test]
fn parses_attach_equals_and_stops_on_next_flag() {
    let args = vec![
        "shellx",
        "--attach=/tmp/a.txt",
        "/tmp/b.txt",
        "--mcp-server",
    ];
    assert_eq!(
        parse_external_attachment_args(args),
        vec!["/tmp/a.txt", "/tmp/b.txt"]
    );
}

#[test]
fn ignores_plain_args_until_attach_flag() {
    let args = vec![
        "shellx",
        "--not-ours",
        r"C:\ignore-me.txt",
        "--attach-files",
        r"C:\Users\FixtureUser\one.txt",
    ];
    assert_eq!(
        parse_external_attachment_args(args),
        vec![r"C:\Users\FixtureUser\one.txt"]
    );
}

#[test]
fn parses_send_to_shortcut_shape() {
    let args = vec![
        r"C:\Program Files\shellX\shellx.exe",
        "--attach",
        r"C:\Users\FixtureUser\Desktop\first file.md",
        r"C:\Users\FixtureUser\Desktop\second file.png",
    ];
    assert_eq!(
        parse_external_attachment_args(args),
        vec![
            r"C:\Users\FixtureUser\Desktop\first file.md",
            r"C:\Users\FixtureUser\Desktop\second file.png",
        ]
    );
}
