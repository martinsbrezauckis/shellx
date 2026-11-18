//! Correctness of PendingPermissionRegistry.
//!
//! Contract shared provider and host-tool permission paths rely on:
//! - insert(id) returns a Receiver that fires with the bool
//! passed to resolve(id, bool).
//! - resolve(unknown_id, _) returns false (no panic).
//! - forget(id) drops the Sender so the Receiver errors, and a
//! subsequent resolve(id, _) is a no-op returning false.
//! - Concurrent distinct ids do not cross-talk (HashMap routing
//! is by exact id match).
use super::*;
use std::sync::Arc;
use tokio::time::Duration;

#[test]
fn missing_permission_registry_response_fails_closed() {
    let resp = permission_registry_missing_response();
    assert_eq!(
        resp.pointer("/outcome/outcome").and_then(|v| v.as_str()),
        Some("cancelled")
    );
}

#[tokio::test]
async fn insert_then_resolve_allow_delivers_true() {
    let reg = Arc::new(PendingPermissionRegistry::new());
    let id = "req-allow".to_string();
    let rx = reg.insert(id.clone()).await;
    let r = reg.clone();
    let id2 = id.clone();
    tokio::spawn(async move {
        let _ = r.resolve(&id2, true).await;
    });
    let got = tokio::time::timeout(Duration::from_secs(1), rx)
        .await
        .unwrap()
        .unwrap();
    assert!(got, "Allow must deliver true to the awaiting handler");
}

#[tokio::test]
async fn insert_then_resolve_deny_delivers_false() {
    let reg = Arc::new(PendingPermissionRegistry::new());
    let id = "req-deny".to_string();
    let rx = reg.insert(id.clone()).await;
    let r = reg.clone();
    let id2 = id.clone();
    tokio::spawn(async move {
        let _ = r.resolve(&id2, false).await;
    });
    let got = tokio::time::timeout(Duration::from_secs(1), rx)
        .await
        .unwrap()
        .unwrap();
    assert!(!got, "Deny must deliver false to the awaiting handler");
}

#[tokio::test]
async fn resolve_unknown_id_returns_false() {
    let reg = PendingPermissionRegistry::new();
    let r = reg.resolve("missing-id", true).await;
    assert!(!r, "resolve of unknown id must return false");
}

#[tokio::test]
async fn forget_drops_sender_and_receiver_errors() {
    let reg = PendingPermissionRegistry::new();
    let id = "req-forget".to_string();
    let rx = reg.insert(id.clone()).await;
    reg.forget(&id).await;
    // Receiver must error when a timeout/cancellation path drops Sender.
    let res = tokio::time::timeout(Duration::from_millis(50), rx).await;
    match res {
        Ok(Err(_)) => { /* expected: Sender dropped */ }
        Ok(Ok(_)) => panic!("forget must NOT deliver a value"),
        Err(_) => panic!("forget must drop the sender promptly"),
    }
    assert!(!reg.resolve(&id, true).await);
}

#[tokio::test]
async fn concurrent_distinct_ids_deliver_correctly() {
    // Two pending requests, two resolves — each must hit its own
    // Receiver. Catches any HashMap-lookup cross-talk.
    let reg = Arc::new(PendingPermissionRegistry::new());
    let rx_a = reg.insert("a".to_string()).await;
    let rx_b = reg.insert("b".to_string()).await;

    let r1 = reg.clone();
    let r2 = reg.clone();
    tokio::spawn(async move {
        let _ = r1.resolve("a", true).await;
    });
    tokio::spawn(async move {
        let _ = r2.resolve("b", false).await;
    });

    let got_a = tokio::time::timeout(Duration::from_secs(1), rx_a)
        .await
        .unwrap()
        .unwrap();
    let got_b = tokio::time::timeout(Duration::from_secs(1), rx_b)
        .await
        .unwrap()
        .unwrap();
    assert!(got_a);
    assert!(!got_b);
}
