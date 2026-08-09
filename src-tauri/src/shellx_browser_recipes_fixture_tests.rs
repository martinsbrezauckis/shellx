use super::*;

#[test]
fn recipe_replay_policy_matches_shared_reliability_fixtures() {
    let fixture: serde_json::Value = serde_json::from_str(include_str!(
        "../tests/fixtures/browser-reliability-cases.json"
    ))
    .expect("browser reliability fixture parses");
    for case in fixture["replayCases"].as_array().expect("replay cases") {
        let name = case["name"].as_str().expect("case name");
        let request = BrowserRecipeReplayRequest {
            recipe: Some(json!({
                "schemaVersion": 2,
                "steps": case["steps"].clone(),
            })),
            dry_run: Some(true),
            ..BrowserRecipeReplayRequest::default()
        };
        let plan = browser_recipe_replay_plan(&request).expect("fixture plan builds");
        let actions = plan
            .actions
            .iter()
            .map(|action| action.request.action.as_str())
            .collect::<Vec<_>>();
        let expected_actions = case["expectedActions"]
            .as_array()
            .expect("expected actions")
            .iter()
            .filter_map(serde_json::Value::as_str)
            .collect::<Vec<_>>();
        let skipped_reasons = plan
            .skipped_steps
            .iter()
            .map(|step| step.reason.as_str())
            .collect::<Vec<_>>();
        let expected_skipped = case["expectedSkippedReasons"]
            .as_array()
            .expect("expected skipped reasons")
            .iter()
            .filter_map(serde_json::Value::as_str)
            .collect::<Vec<_>>();
        let decision_ids = plan
            .decision_points
            .iter()
            .filter_map(|point| point.get("decisionId").and_then(serde_json::Value::as_str))
            .collect::<Vec<_>>();
        let expected_decisions = case["expectedDecisionIds"]
            .as_array()
            .expect("expected decision ids")
            .iter()
            .filter_map(serde_json::Value::as_str)
            .collect::<Vec<_>>();

        assert_eq!(actions, expected_actions, "{name}: actions");
        assert_eq!(skipped_reasons, expected_skipped, "{name}: skipped");
        assert_eq!(decision_ids, expected_decisions, "{name}: decisions");
    }
}
