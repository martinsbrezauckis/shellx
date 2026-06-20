//! vault-client (ShellX Vault) — the full sync client as a LIBRARY.
//!
//! Everything the `sbx` CLI does lives here so other frontends can link
//! the same engine instead of shelling out:
//! - R2 web UI: `vault-core` compiles to WASM for browser crypto; this
//!   crate's `client` module shapes the HTTP calls.
//! - R3 desktop app (Tauri): the UI process links this crate directly —
//!   the app IS the sync engine, no daemon IPC.
//! - R4 shellX / agents: machine-readable types (`engine::Summary`,
//!   `engine::ConflictEvent`, `engine::StatusReport`) serialize to JSON.
//!
//! Modules:
//! - [`config`] — client config, keyfile handling, local state (base/
//!   cache/conflict registry) under `<root>/.sxvault/`
//! - [`client`] — typed HTTP API (repo-scoped routes, bearer auth)
//! - [`scan`]   — local tree walker (+ `.sxvaultignore`, rehash cache)
//! - [`engine`] — three-way merge, sync pass, prune, log/restore,
//!   conflict registry
//! - [`watch`]  — continuous-sync daemon loop

pub mod client;
pub mod config;
pub mod engine;
pub mod export;
pub mod items;
pub mod scan;
pub mod watch;
