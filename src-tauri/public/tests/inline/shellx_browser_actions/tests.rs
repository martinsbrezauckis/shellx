use super::*;
use serde_json::json;

#[test]
fn engine_observation_deserializes_object_valued_metadata_lossily() {
    let observed: EngineObservationResult = serde_json::from_value(json!({
        "url": { "href": "https://app.example.test/signup" },
        "title": { "text": "Signup" },
        "text": ["Create", "account"],
        "markdown": { "body": "# Signup" },
        "refs": [{
            "refId": { "id": 1 },
            "role": ["button"],
            "label": { "text": "Continue" },
            "name": { "text": "Continue" },
            "testId": 42,
            "selector": { "css": "button[type=submit]" },
            "value": { "display": "Continue" },
            "action": { "kind": "clickRef" },
            "locatorSuggestions": [{
                "kind": { "kind": "role" },
                "value": { "value": "button:Continue" },
                "strict": "true",
                "matchCount": 1
            }],
            "visible": "true",
            "enabled": 1,
            "editable": false,
            "frameId": { "frame": "main" },
            "strictMatchCount": 1
        }],
        "formFields": [{
            "refId": { "id": "field-1" },
            "selector": { "css": "input[name=email]" },
            "label": { "text": "Email" },
            "fieldKind": ["email"],
            "value": { "display": "agent@example.test" },
            "required": true,
            "disabled": false,
            "autocomplete": { "value": "email" },
            "formAction": { "href": "/signup" }
        }],
        "formFieldGroups": [{
            "groupId": { "id": "group-1" },
            "groupKind": { "kind": "signup" },
            "label": { "text": "Signup form" },
            "formAction": { "href": "/signup" },
            "fieldIntents": ["email", "newPassword"],
            "fields": [{
                "refId": { "id": "field-1" },
                "selector": { "css": "input[name=email]" },
                "label": { "text": "Email" },
                "fieldKind": ["email"],
                "intent": { "kind": "email" },
                "required": true,
                "disabled": false,
                "sensitive": "false"
            }],
            "sensitive": "true"
        }],
        "accessibilityTree": [{
            "refId": { "id": 1 },
            "role": ["button"],
            "label": { "text": "Continue" },
            "selector": { "css": "button[type=submit]" },
            "action": { "kind": "clickRef" }
        }]
    }))
    .expect("object-valued metadata should not break Browser observation parsing");

    assert_eq!(observed.refs.len(), 1);
    assert!(observed.refs[0].label.contains("Continue"));
    assert_eq!(observed.form_fields.len(), 1);
    assert!(observed.form_fields[0].label.contains("Email"));
    assert_eq!(observed.form_field_groups.len(), 1);
    assert!(observed.form_field_groups[0].group_kind.contains("signup"));
    assert_eq!(
        observed.form_field_groups[0].field_intents,
        vec!["email".to_string(), "newPassword".to_string()]
    );
    assert_eq!(observed.form_field_groups[0].fields.len(), 1);
    assert_eq!(observed.accessibility_tree.len(), 1);
    assert!(observed.accessibility_tree[0].label.contains("Continue"));
    assert!(observed.title.contains("Signup"));
}
