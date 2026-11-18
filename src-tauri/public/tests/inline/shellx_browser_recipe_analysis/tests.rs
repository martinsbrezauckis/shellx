use super::*;

#[test]
fn redacted_text_adds_a_fresh_observation_decision_point() {
    let steps = vec![
        json!({ "action": "waitFor", "valueRedacted": true }),
        json!({ "action": "findText", "queryRedacted": true }),
    ];

    let points = recipe_decision_points(&steps);

    assert!(points.iter().any(|point| {
        point.get("decisionId").and_then(|value| value.as_str())
            == Some("fresh-observation-after-redacted-text")
    }));
}

#[test]
fn explicit_non_redacted_find_text_does_not_add_reobserve_point() {
    let steps = vec![json!({
        "action": "findText",
        "queryRedacted": false
    })];

    let points = recipe_decision_points(&steps);

    assert!(!points.iter().any(|point| {
        point.get("decisionId").and_then(|value| value.as_str())
            == Some("fresh-observation-after-redacted-text")
    }));
}
