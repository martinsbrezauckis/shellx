use futures_util::FutureExt as _;
use std::{
    collections::HashMap,
    future::Future,
    panic::AssertUnwindSafe,
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex, MutexGuard, OnceLock,
    },
};

/// Long-lived, per-tab work that must not survive its owning UI/session state.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub(crate) enum TabTaskKind {
    BuildResumeInject,
    DebugPromptWait,
}

impl TabTaskKind {
    fn label(self) -> &'static str {
        match self {
            Self::BuildResumeInject => "build-resume-inject",
            Self::DebugPromptWait => "debug-prompt-wait",
        }
    }
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct TabTaskKey {
    tab_id: String,
    kind: TabTaskKind,
}

struct TabTaskRegistration {
    generation: u64,
    task: Option<tokio::task::JoinHandle<()>>,
}

static TAB_TASKS: OnceLock<Mutex<HashMap<TabTaskKey, TabTaskRegistration>>> = OnceLock::new();
static NEXT_GENERATION: AtomicU64 = AtomicU64::new(1);

fn registry() -> &'static Mutex<HashMap<TabTaskKey, TabTaskRegistration>> {
    TAB_TASKS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn lock_registry() -> MutexGuard<'static, HashMap<TabTaskKey, TabTaskRegistration>> {
    registry()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn unregister_if_current(key: &TabTaskKey, generation: u64) {
    let mut tasks = lock_registry();
    if tasks
        .get(key)
        .is_some_and(|registration| registration.generation == generation)
    {
        tasks.remove(key);
    }
}

/// Spawn one owned task for a `(tab, kind)` pair.
///
/// A newer task replaces and aborts the older task. The start gate prevents the
/// future from running before its handle is attached, and generation-aware
/// cleanup cannot unregister a newer replacement.
pub(crate) fn spawn_replace<F>(tab_id: &str, kind: TabTaskKind, future: F)
where
    F: Future<Output = ()> + Send + 'static,
{
    let key = TabTaskKey {
        tab_id: tab_id.to_string(),
        kind,
    };
    let generation = NEXT_GENERATION.fetch_add(1, Ordering::Relaxed);
    let replaced = lock_registry().insert(
        key.clone(),
        TabTaskRegistration {
            generation,
            task: None,
        },
    );
    if let Some(registration) = replaced {
        if let Some(task) = registration.task {
            task.abort();
        }
    }

    let (start_tx, start_rx) = tokio::sync::oneshot::channel::<()>();
    let task_key = key.clone();
    let task = tokio::spawn(async move {
        if start_rx.await.is_err() {
            unregister_if_current(&task_key, generation);
            return;
        }
        if AssertUnwindSafe(future).catch_unwind().await.is_err() {
            tracing::error!(
                "tab task panicked: tab_id={} kind={}",
                task_key.tab_id,
                task_key.kind.label()
            );
        }
        unregister_if_current(&task_key, generation);
    });

    let mut task = Some(task);
    {
        let mut tasks = lock_registry();
        if let Some(registration) = tasks
            .get_mut(&key)
            .filter(|registration| registration.generation == generation)
        {
            registration.task = task.take();
        }
    }
    if let Some(task) = task {
        task.abort();
    } else {
        let _ = start_tx.send(());
    }
}

pub(crate) fn abort_kind(tab_id: &str, kind: TabTaskKind) -> bool {
    let key = TabTaskKey {
        tab_id: tab_id.to_string(),
        kind,
    };
    let registration = lock_registry().remove(&key);
    if let Some(registration) = registration {
        if let Some(task) = registration.task {
            task.abort();
        }
        true
    } else {
        false
    }
}

pub(crate) fn abort_tab(tab_id: &str) -> usize {
    let registrations = {
        let mut tasks = lock_registry();
        let keys = tasks
            .keys()
            .filter(|key| key.tab_id == tab_id)
            .cloned()
            .collect::<Vec<_>>();
        keys.into_iter()
            .filter_map(|key| tasks.remove(&key))
            .collect::<Vec<_>>()
    };
    let count = registrations.len();
    for registration in registrations {
        if let Some(task) = registration.task {
            task.abort();
        }
    }
    count
}

#[cfg(test)]
fn registered(tab_id: &str, kind: TabTaskKind) -> bool {
    lock_registry().contains_key(&TabTaskKey {
        tab_id: tab_id.to_string(),
        kind,
    })
}

#[cfg(test)]
mod tests {
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
}
