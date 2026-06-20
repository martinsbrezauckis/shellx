//! vault-server as a LIBRARY — the embeddable face (R3.6 local mode).
//!
//! The desktop app (tauri-plugin-vault) spawns this same server
//! IN-PROCESS on 127.0.0.1:0 when the user chooses "store on this
//! computer": identical storage format, identical API, zero code fork —
//! the vault is the account, the repo just lives on local disk. The VPS
//! binary (main.rs) wraps this lib + the embedded web SPA.
//!
//! Loopback security note: bound to
//! 127.0.0.1 only, bearer-token-gated; browsers can't reach it cross-
//! origin without the token. The master key already lives in the same
//! process — the loopback hop adds no new exposure class on a
//! single-user desktop.

pub mod api;
pub mod config;
pub mod store;

use std::sync::Arc;

use api::{AppState, TokenInfo};
use config::{Access, RepoEntry};
use store::Repos;

/// A running embedded server: its actual bound address + shutdown handle.
pub struct EmbeddedServer {
    pub addr: std::net::SocketAddr,
    shutdown: Option<tokio::sync::oneshot::Sender<()>>,
    join: tokio::task::JoinHandle<()>,
}

impl EmbeddedServer {
    /// Graceful stop (drop also aborts the task as a backstop).
    pub async fn stop(mut self) {
        if let Some(tx) = self.shutdown.take() {
            let _ = tx.send(());
        }
        let _ = self.join.await;
    }
}

/// Serve a single-repo store on 127.0.0.1:0 (OS-picked port) inside the
/// caller's tokio runtime. `token` is the RAW bearer token the embedding
/// app will use (its blake3 hash is what the router checks — nothing is
/// persisted here; the caller owns config/token storage).
pub async fn serve_embedded(
    data_dir: &std::path::Path,
    repo: &str,
    token: &str,
) -> anyhow::Result<EmbeddedServer> {
    let repos = Repos::open(
        data_dir,
        &[RepoEntry {
            name: repo.into(),
            quota_bytes: None,
        }],
    )?;
    let tokens = vec![TokenInfo {
        hash: *blake3::hash(token.as_bytes()).as_bytes(),
        repo: repo.into(),
        access: Access::Rw,
        name: "local".into(),
    }];
    let state = Arc::new(AppState { repos, tokens });
    let app = api::router(state).layer(axum::middleware::from_fn(api::security_headers));

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let addr = listener.local_addr()?;
    let (tx, rx) = tokio::sync::oneshot::channel::<()>();
    let join = tokio::spawn(async move {
        let _ = axum::serve(listener, app)
            .with_graceful_shutdown(async {
                let _ = rx.await;
            })
            .await;
    });
    Ok(EmbeddedServer {
        addr,
        shutdown: Some(tx),
        join,
    })
}
