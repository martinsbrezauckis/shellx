use super::*;

#[test]
fn compact_draft_response_stays_private_and_bounded() {
    let data = json!({
        "taskId": "task-owned",
        "limit": 20,
        "drafts": (0..20).map(|index| json!({
            "draftId": format!("draft-{index}"),
            "bundleId": format!("bundle-{index}"),
            "bundleSha256": "a".repeat(64),
            "taskId": "task-owned",
            "browserTabId": "tab-owned",
            "attemptId": format!("attempt-{index}"),
            "currentRevisionId": format!("revision-{index}"),
            "currentRevisionSha256": "b".repeat(64),
            "revision": 1,
            "stepCount": 2,
            "valueCount": 0,
            "blockingIssues": 0,
            "createdAtMs": 1,
            "privatePath": "/home/operator/.shellx/browser-artifacts/private.json",
        })).collect::<Vec<_>>(),
    });
    let compact = compact_teach_drafts(&data);
    let encoded = serde_json::to_vec(&compact).expect("compact JSON encodes");
    assert!(encoded.len() <= MAX_COMPACT_TEACH_RESPONSE_BYTES);
    assert!(!String::from_utf8(encoded).unwrap().contains("privatePath"));
}
