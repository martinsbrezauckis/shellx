use super::*;
use crate::shellx_browser::BrowserBookmarkAgentWorkflow;

#[test]
fn workflow_bookmarks_preserve_normalized_agent_metadata() {
    let mut state = BrowserState::default();

    let response = upsert_browser_bookmark_locked(
        &mut state,
        BrowserBookmarkUpsertRequest {
            bookmark_id: Some("wf-google-ai-key".to_string()),
            label: "Get Google AI Studio key".to_string(),
            url: Some("https://aistudio.google.com/app/apikey".to_string()),
            toolbar_pinned: Some(true),
            agent_workflow: Some(BrowserBookmarkAgentWorkflow {
                site_key: Some(" HTTPS://WWW.Google.COM/aistudio ".to_string()),
                task_type: Some("Get API Key".to_string()),
                target: Some(" API Key ".to_string()),
                surface: Some(" AI Studio ".to_string()),
                aliases: vec![" Gemini developer key ".to_string()],
                permissions_needed: vec![" cookies.accept ".to_string()],
                secret_kinds: vec![" api-token ".to_string()],
                recipe_id: Some("browser-recipe-123".to_string()),
                recipe_path: Some("/tmp/shellx-browser-recipes/recipe.json".to_string()),
                goal: Some("Get an API key and store it in Vault".to_string()),
                steps: Some(4),
                source: Some("shellx-browser-recorder".to_string()),
                health: Some("fresh".to_string()),
                drift_status: Some("fresh".to_string()),
                ..BrowserBookmarkAgentWorkflow::default()
            }),
            ..BrowserBookmarkUpsertRequest::default()
        },
    )
    .expect("workflow bookmark is saved");

    assert_eq!(response.bookmark.category, "workflow");
    let workflow = response
        .bookmark
        .agent_workflow
        .expect("workflow metadata is preserved");
    assert_eq!(workflow.site_key.as_deref(), Some("google.com"));
    assert_eq!(workflow.task_type.as_deref(), Some("get"));
    assert_eq!(workflow.target.as_deref(), Some("api-key"));
    assert_eq!(workflow.surface.as_deref(), Some("ai-studio"));
    assert_eq!(workflow.secret_kinds, vec!["apiToken".to_string()]);

    let toolbar = browser_bookmark_toolbar(&state.bookmarks);
    let toolbar_workflow = toolbar
        .iter()
        .find(|item| item.bookmark_id == "wf-google-ai-key")
        .and_then(|item| item.agent_workflow.as_ref())
        .expect("toolbar exposes workflow metadata for agent discovery");
    assert_eq!(
        toolbar_workflow.recipe_id.as_deref(),
        Some("browser-recipe-123")
    );
}

#[test]
fn workflow_task_type_preserves_signup_intent() {
    assert_eq!(
        clean_workflow_task_type(Some("sign-up".to_string())).as_deref(),
        Some("register")
    );
    assert_eq!(
        clean_workflow_task_type(Some("signup".to_string())).as_deref(),
        Some("register")
    );
    assert_eq!(
        clean_workflow_task_type(Some("sign-in".to_string())).as_deref(),
        Some("login")
    );
}

#[test]
fn workflow_evaluation_metadata_preserves_fail_closed_ratings_and_current_refreshes() {
    let degraded = normalize_agent_workflow(BrowserBookmarkAgentWorkflow {
        health: Some("degraded".to_string()),
        drift_status: Some("needs-review".to_string()),
        last_improvement_score: Some(-25),
        last_improvement_rating: Some("safety-regression".to_string()),
        last_attempt_id: Some("attempt-17".to_string()),
        last_attempt_path: Some("/tmp/attempt-17.json".to_string()),
        last_evaluation_report_path: Some("/tmp/evaluation-17.json".to_string()),
        refresh_reason: Some("The page contract changed".to_string()),
        refresh_candidate_recipe_path: Some("/tmp/recipe-refresh.json".to_string()),
        ..BrowserBookmarkAgentWorkflow::default()
    })
    .expect("degraded workflow remains available");

    assert_eq!(
        degraded.last_improvement_rating.as_deref(),
        Some("safety-regression")
    );
    assert_eq!(degraded.last_improvement_score, Some(-25));
    assert_eq!(
        degraded.refresh_candidate_recipe_path.as_deref(),
        Some("/tmp/recipe-refresh.json")
    );

    let fresh = normalize_agent_workflow(BrowserBookmarkAgentWorkflow {
        health: Some("fresh".to_string()),
        drift_status: Some("fresh".to_string()),
        refresh_reason: degraded.refresh_reason,
        refresh_candidate_recipe_path: degraded.refresh_candidate_recipe_path,
        ..BrowserBookmarkAgentWorkflow::default()
    })
    .expect("fresh workflow remains available");

    assert_eq!(fresh.refresh_reason, None);
    assert_eq!(fresh.refresh_candidate_recipe_path, None);
}
