use super::*;

fn workflow(recipe_sha256: Option<&str>) -> Value {
    let mut workflow = json!({
        "recipePath": "/private/shellx-browser-recipes/saved.json",
        "siteKey": "login.example.test",
    });
    if let Some(recipe_sha256) = recipe_sha256 {
        workflow["recipeSha256"] = Value::String(recipe_sha256.to_string());
    }
    workflow
}

#[test]
fn bookmark_replay_binding_rejects_an_unrelated_path_and_requires_the_saved_digest() {
    let sha256 = "4a".repeat(32);
    let binding = browser_workflow_replay_binding(
        &workflow(Some(&sha256)),
        Some("/private/shellx-browser-recipes/saved.json".to_string()),
    )
    .expect("the exact bookmark path and digest are accepted");
    assert_eq!(binding.recipe_sha256, sha256);
    assert_eq!(
        binding.expected_domain.as_deref(),
        Some("login.example.test")
    );

    let mismatch = browser_workflow_replay_binding(
        &workflow(Some(&sha256)),
        Some("/private/shellx-browser-recipes/unrelated.json".to_string()),
    )
    .expect_err("a bookmark must not replay a caller-supplied different recipe");
    assert!(mismatch.contains("recipePath does not match"), "{mismatch}");

    let legacy = browser_workflow_replay_binding(&workflow(None), None)
        .expect_err("a bookmark without its saved digest must be resaved");
    assert!(legacy.contains("recipeSha256"), "{legacy}");
}
