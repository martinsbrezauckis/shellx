use super::*;
use std::path::Path;

#[test]
fn renderer_preview_uses_host_credential_corpus_with_only_generated_media_exception() {
    let generated_media = Path::new("/home/user/.grok/sessions/project/session/images/result.png");
    assert!(sensitive_path_match(SensitivePathContext::HostMcp, generated_media).is_some());
    assert!(
        sensitive_path_match(SensitivePathContext::RendererPreview, generated_media).is_none(),
        "renderer preview may display generated session media"
    );

    for sensitive in [
        Path::new("/home/user/.grok/sessions/project/session/images/auth.json"),
        Path::new("/home/user/.ssh/id_ed25519"),
    ] {
        assert!(
            sensitive_path_match(SensitivePathContext::RendererPreview, sensitive).is_some(),
            "renderer exception must not authorize {}",
            sensitive.display()
        );
    }
}
