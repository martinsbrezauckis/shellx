use super::*;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use tokio::sync::oneshot;

fn unique_tab(label: &str) -> String {
    format!(
        "{label}-{}",
        NEXT_GENERATION.fetch_add(1, Ordering::Relaxed)
    )
}

#[tokio::test]
async fn completed_task_unregisters_itself() {
    let tab = unique_tab("complete");
    let (tx, rx) = oneshot::channel();
    spawn_replace(&tab, TabTaskKind::DebugPromptWait, async move {
        let _ = rx.await;
    });
    assert!(registered(&tab, TabTaskKind::DebugPromptWait));
    let _ = tx.send(());
    tokio::time::timeout(std::time::Duration::from_secs(1), async {
        while registered(&tab, TabTaskKind::DebugPromptWait) {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("completed task should unregister promptly");
    assert!(!registered(&tab, TabTaskKind::DebugPromptWait));
}

#[tokio::test]
async fn replacement_aborts_only_the_previous_kind() {
    let tab = unique_tab("replace");
    let first_dropped = Arc::new(AtomicBool::new(false));
    let first_dropped_in_task = first_dropped.clone();
    let (_release_tx, release_rx) = oneshot::channel::<()>();
    let (started_tx, started_rx) = oneshot::channel::<()>();
    spawn_replace(&tab, TabTaskKind::BuildResumeInject, async move {
        struct DropReceipt(Arc<AtomicBool>);
        impl Drop for DropReceipt {
            fn drop(&mut self) {
                self.0.store(true, Ordering::SeqCst);
            }
        }
        let _receipt = DropReceipt(first_dropped_in_task);
        let _ = started_tx.send(());
        let _ = release_rx.await;
    });
    let _ = started_rx.await;

    spawn_replace(&tab, TabTaskKind::BuildResumeInject, async {
        std::future::pending::<()>().await;
    });
    tokio::time::timeout(std::time::Duration::from_secs(1), async {
        while !first_dropped.load(Ordering::SeqCst) {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("replaced task should be aborted promptly");
    assert!(first_dropped.load(Ordering::SeqCst));
    assert!(registered(&tab, TabTaskKind::BuildResumeInject));
    assert_eq!(abort_tab(&tab), 1);
}

#[tokio::test]
async fn tab_abort_cancels_each_owned_kind() {
    let tab = unique_tab("abort");
    spawn_replace(&tab, TabTaskKind::BuildResumeInject, async {
        std::future::pending::<()>().await;
    });
    spawn_replace(&tab, TabTaskKind::DebugPromptWait, async {
        std::future::pending::<()>().await;
    });
    assert_eq!(abort_tab(&tab), 2);
    assert!(!registered(&tab, TabTaskKind::BuildResumeInject));
    assert!(!registered(&tab, TabTaskKind::DebugPromptWait));
    assert_eq!(abort_tab(&tab), 0);
}
