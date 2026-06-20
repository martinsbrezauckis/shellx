//! Continuous sync daemon — one implementation, two faces:
//! - [`watch`] keeps the `sbx watch` CLI behavior (stdout, Ctrl-C).
//! - [`watch_core`] is the embeddable engine: host apps (tauri-plugin-
//!   vault, shellX) supply an already-unlocked key, a stop signal, and an
//!   event sink instead of a terminal. One implementation means the CLI
//!   e2e scenario gates the desktop watcher too.
//!
//! Two triggers, both funnel into the same sync pass:
//! - **Filesystem events** via notify + full debouncer. Events under
//!   `.sxvault/` and our own `.sxvault-tmp-*` apply-temps are filtered so
//!   our own state writes never re-trigger a sync.
//! - **Remote poll** every `poll_secs`: cheap head check; a sync runs
//!   only when the server generation differs from our base.
//!
//! The watcher is never trusted to be complete (inotify queues overflow,
//! network mounts drop events): every
//! `rescan_every`-th poll tick forces a full sync pass regardless, and
//! every sync pass is itself a full scan (cheap, thanks to the rehash
//! cache).

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use notify_debouncer_full::{new_debouncer, notify::RecursiveMode};

use crate::client::Api;
use crate::config::{self, Paths, STATE_DIR, TMP_PREFIX};
use crate::engine::{self, Summary};

/// Daemon tuning knobs (CLI flags / host config map 1:1).
#[derive(Debug, Clone)]
pub struct WatchOptions {
    pub poll_secs: u64,
    pub debounce_ms: u64,
    pub rescan_every: u32,
}

/// What happened inside the daemon — hosts render these however they
/// like (CLI prints, the desktop plugin emits tauri events + tray state).
#[derive(Debug, Clone)]
pub enum WatchEvent {
    /// Watching is live (after the startup pass was scheduled).
    Started,
    /// A pass finished. `summary.warnings` included; no-op passes get
    /// this too — hosts decide what is worth showing.
    PassDone {
        reason: &'static str,
        summary: Summary,
    },
    /// A pass failed; the daemon lives on (next trigger retries).
    PassFailed { reason: &'static str, error: String },
    /// Non-fatal daemon hiccup (head check failed, …).
    Hiccup(String),
    /// The daemon exited (stop signal or watcher-thread death).
    Stopped,
}

/// Embeddable watch loop. Runs until `stop` flips to true (or the FS
/// watcher thread dies). The key is supplied unlocked — hosts own the
/// unlock UX; the CLI wrapper below does its own prompt.
pub async fn watch_core(
    api: Api,
    device: String,
    master: Arc<vault_core::MasterKey>,
    paths: Paths,
    opts: WatchOptions,
    mut stop: tokio::sync::watch::Receiver<bool>,
    on_event: impl Fn(WatchEvent) + Send + 'static,
) -> Result<()> {
    // FS events → tokio channel. The debouncer runs its own thread; the
    // callback filters our own state/temp files before signalling.
    let (tx, mut rx) = tokio::sync::mpsc::channel::<()>(16);
    let root_for_filter = paths.root.clone();
    let mut debouncer = new_debouncer(
        Duration::from_millis(opts.debounce_ms),
        None,
        move |result: notify_debouncer_full::DebounceEventResult| {
            let Ok(events) = result else { return }; // watch errors → poll still covers us
            let relevant = events.iter().any(|e| {
                e.paths.iter().any(|p| {
                    let in_state = p
                        .strip_prefix(&root_for_filter)
                        .map(|rel| {
                            rel.components()
                                .next()
                                .map(|c| c.as_os_str() == STATE_DIR)
                                .unwrap_or(false)
                        })
                        .unwrap_or(false);
                    let is_tmp = p
                        .file_name()
                        .map(|n| n.to_string_lossy().starts_with(TMP_PREFIX))
                        .unwrap_or(false);
                    !in_state && !is_tmp
                })
            });
            if relevant {
                let _ = tx.blocking_send(()); // full channel = sync already pending
            }
        },
    )?;
    debouncer.watch(&paths.root, RecursiveMode::Recursive)?;
    on_event(WatchEvent::Started);

    // Initial pass picks up anything that happened while not running.
    run_pass(&api, &device, &master, &paths, "startup", &on_event).await;

    let mut poll = tokio::time::interval(Duration::from_secs(opts.poll_secs.max(1)));
    poll.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    poll.tick().await; // immediate first tick consumed (we just synced)
    let mut ticks: u32 = 0;

    loop {
        let reason = tokio::select! {
            _ = stop.changed() => {
                if *stop.borrow() { break } else { continue }
            }
            ev = rx.recv() => {
                if ev.is_none() { break } // watcher thread died; poll-only would be silent — exit loudly
                while rx.try_recv().is_ok() {} // coalesce burst
                "local change"
            }
            _ = poll.tick() => {
                ticks += 1;
                if ticks.is_multiple_of(opts.rescan_every.max(1)) {
                    "periodic rescan" // full pass even if head unchanged
                } else {
                    // Cheap check: only sync when the server moved.
                    let base_gen = config::load_base(&paths).ok().flatten().map(|b| b.generation).unwrap_or(0);
                    match api.head().await {
                        Ok(h) => {
                            if h.as_ref().map(|h| h.generation).unwrap_or(0) != base_gen {
                                "remote change"
                            } else {
                                continue;
                            }
                        }
                        Err(e) => {
                            on_event(WatchEvent::Hiccup(format!("head check failed ({e}); retrying next poll")));
                            continue;
                        }
                    }
                }
            }
        };
        run_pass(&api, &device, &master, &paths, reason, &on_event).await;
    }

    on_event(WatchEvent::Stopped);
    Ok(())
}

/// One sync pass; errors become events and are absorbed (the daemon
/// lives on).
async fn run_pass(
    api: &Api,
    device: &str,
    master: &vault_core::MasterKey,
    paths: &Paths,
    reason: &'static str,
    on_event: &(impl Fn(WatchEvent) + Send + 'static),
) {
    match engine::sync_with(api, device, master, paths, false).await {
        Ok(summary) => on_event(WatchEvent::PassDone { reason, summary }),
        Err(e) => on_event(WatchEvent::PassFailed {
            reason,
            error: format!("{e:#}"),
        }),
    }
}

/// `sbx watch` — the CLI face: prompt/unlock, print events, Ctrl-C stops.
pub async fn watch(
    paths: &Paths,
    passphrase_file: Option<&Path>,
    poll_secs: u64,
    debounce_ms: u64,
    rescan_every: u32,
) -> Result<()> {
    let cfg = config::load_config(paths)?;
    let master = Arc::new(config::unlock(paths, passphrase_file)?);
    let api = Api::new(&cfg.server_url, &cfg.repo, &cfg.token)?;
    api.ping()
        .await
        .context("server unreachable at watch start")?;

    println!(
        "watching {} (debounce {debounce_ms} ms, remote poll {poll_secs}s) — Ctrl-C to stop",
        paths.root.display()
    );

    let (stop_tx, stop_rx) = tokio::sync::watch::channel(false);
    tokio::spawn(async move {
        let _ = tokio::signal::ctrl_c().await;
        let _ = stop_tx.send(true);
    });

    let opts = WatchOptions {
        poll_secs,
        debounce_ms,
        rescan_every,
    };
    watch_core(
        api,
        cfg.device,
        master,
        paths.clone(),
        opts,
        stop_rx,
        |event| match event {
            WatchEvent::Started => {}
            WatchEvent::PassDone { reason, summary: s } => {
                for w in &s.warnings {
                    eprintln!("warning: {w}");
                }
                // Stay quiet on no-ops — a daemon that logs every poll is noise.
                if s.pulled + s.deleted + s.renamed_conflicts + s.uploaded_chunks > 0
                    || s.committed_gen.is_some()
                {
                    println!(
                        "[{reason}] pulled {}, deleted {}, conflicts {}, uploaded {} chunk(s){}",
                        s.pulled,
                        s.deleted,
                        s.renamed_conflicts,
                        s.uploaded_chunks,
                        s.committed_gen
                            .map(|g| format!(", committed gen {g}"))
                            .unwrap_or_default()
                    );
                }
            }
            WatchEvent::PassFailed { reason, error } => {
                eprintln!("[{reason}] sync failed: {error}")
            }
            WatchEvent::Hiccup(msg) => eprintln!("watch: {msg}"),
            WatchEvent::Stopped => println!("watch stopped"),
        },
    )
    .await
}
