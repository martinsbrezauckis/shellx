use super::*;

#[tokio::test]
async fn cancellable_session_start_interrupts_a_stalled_handshake() {
    let registry = std::sync::Arc::new(crate::acp::SessionRegistry::new());
    let tab = "debug-api-stalled-connect";
    let mut lease = registry
        .begin_session_start(tab)
        .expect("connect should register its startup token");
    let cancel_registry = registry.clone();

    let (outcome, cancellation) = tokio::join!(
        run_cancellable_session_start(&lease, async {
            std::future::pending::<Result<(), String>>().await
        }),
        async move {
            tokio::task::yield_now().await;
            cancel_registry
                .cancel_session_start(tab)
                .expect("abort should find the stalled connect")
        }
    );

    assert_eq!(outcome, ConnectStartOutcome::Cancelled);
    assert!(registry.session_start_is_current(tab, &cancellation));
    lease.finish();
}

#[tokio::test]
async fn cancellable_session_start_preserves_a_normal_result() {
    let registry = crate::acp::SessionRegistry::new();
    let tab = "debug-api-completed-connect";
    let mut lease = registry
        .begin_session_start(tab)
        .expect("connect should register its startup token");

    let outcome = run_cancellable_session_start(&lease, async { Ok(()) }).await;

    assert_eq!(outcome, ConnectStartOutcome::Finished(Ok(())));
    lease.finish();
}

#[tokio::test]
async fn hard_abort_of_an_absent_tab_does_not_create_a_registry_row() {
    let registry = crate::acp::SessionRegistry::new();
    let tab = "debug-api-absent-hard-abort";

    let result = abort_existing_hard_session(&registry, tab).await;

    assert!(result.is_none());
    assert!(registry.get_existing(tab).await.is_none());
    assert!(registry.list_tabs().await.is_empty());
}
