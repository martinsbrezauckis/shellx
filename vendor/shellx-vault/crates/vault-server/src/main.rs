//! vault-server (ShellX Vault) — dumb encrypted blob + manifest store (multi-repo).
//!
//! The server's whole contract: store opaque blobs by ID per repository,
//! CAS-append and serve sealed manifests, enforce repo-scoped bearer-token
//! auth and quotas. It never sees keys, plaintext, filenames, or tree
//! structure; see docs/SECURITY.md.
//!
//! Subcommands:
//! - `init` — write a fresh config with a "default" repo + first device
//!   token (printed ONCE)
//! - `add-repo` — add a repository (own keyfile + tokens + quota)
//! - `add-token` — mint a token for a repo (rw or ro)
//! - `serve` — run the HTTP server (loopback by default; external access
//!   via Cloudflare tunnel per INFRASTRUCTURE.md)
//!
//! Config changes require a restart — acceptable for a personal server,
//! and it keeps `serve` free of config-reload complexity.

use vault_server::{api, config, store};

use std::path::PathBuf;
use std::sync::Arc;

use clap::{Parser, Subcommand};

use crate::config::{
    generate_token, validate_repo_name, Access, RepoEntry, ServerConfig, TokenEntry, CONFIG_VERSION,
};

#[derive(Parser)]
#[command(
    name = "vault-server",
    version,
    about = "Zero-knowledge sync blob server"
)]
struct Cli {
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Create a config file with a "default" repo + first device token.
    Init {
        /// Where all repo storage will live.
        #[arg(long)]
        data_dir: PathBuf,
        /// Listen address. Keep loopback; expose via tunnel.
        #[arg(long, default_value = "127.0.0.1:7440")]
        bind: String,
        /// Config file to create (refuses to overwrite).
        #[arg(long)]
        config: PathBuf,
        /// Name of the first device token.
        #[arg(long, default_value = "device-1")]
        token_name: String,
    },
    /// Add a repository (unit of crypto isolation; own tokens + quota).
    AddRepo {
        #[arg(long)]
        config: PathBuf,
        /// Repo name: [a-z0-9-], 1-64 chars.
        #[arg(long)]
        name: String,
        /// Storage cap in GiB (omit for unlimited).
        #[arg(long)]
        quota_gib: Option<u64>,
    },
    /// Add a device/agent token to a repo (server restart required).
    AddToken {
        #[arg(long)]
        config: PathBuf,
        /// Token name, e.g. "laptop" or "agent-claude".
        #[arg(long)]
        name: String,
        /// Which repo this token may access.
        #[arg(long, default_value = "default")]
        repo: String,
        /// Access level: rw (full sync), ro (read-only), or deposit
        /// (write-only vault deposits — R2.7 agent tokens).
        #[arg(long, default_value = "rw")]
        access: String,
    },
    /// Run the server.
    Serve {
        #[arg(long)]
        config: PathBuf,
    },
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    match Cli::parse().cmd {
        Cmd::Init {
            data_dir,
            bind,
            config,
            token_name,
        } => {
            if config.exists() {
                return Err(format!("refusing to overwrite existing config {config:?}").into());
            }
            let (raw, hash) = generate_token();
            let cfg = ServerConfig {
                version: CONFIG_VERSION,
                bind,
                data_dir: data_dir.to_string_lossy().into_owned(),
                trash_grace_days: 7,
                allow_remote_bind: false,
                repos: vec![RepoEntry {
                    name: "default".into(),
                    quota_bytes: None,
                }],
                tokens: vec![TokenEntry {
                    name: token_name.clone(),
                    repo: "default".into(),
                    token_hash: hash,
                    access: Access::Rw,
                }],
            };
            std::fs::create_dir_all(&data_dir)?;
            cfg.save(&config)?;
            // The raw token is shown exactly once and never stored server-side.
            println!("config written: {} (repo: default)", config.display());
            println!("token for '{token_name}' (save it NOW, it cannot be recovered):");
            println!("{raw}");
        }
        Cmd::AddRepo {
            config,
            name,
            quota_gib,
        } => {
            validate_repo_name(&name)?;
            let mut cfg = ServerConfig::load(&config)?;
            if cfg.repos.iter().any(|r| r.name == name) {
                return Err(format!("repo '{name}' already exists").into());
            }
            cfg.repos.push(RepoEntry {
                name: name.clone(),
                quota_bytes: quota_gib.map(|g| g * 1024 * 1024 * 1024),
            });
            cfg.save(&config)?;
            println!(
                "repo '{name}' added ({}). Mint tokens with: vault-server add-token --repo {name} --name <device>",
                quota_gib.map(|g| format!("quota {g} GiB")).unwrap_or_else(|| "unlimited".into())
            );
        }
        Cmd::AddToken {
            config,
            name,
            repo,
            access,
        } => {
            let mut cfg = ServerConfig::load(&config)?;
            if !cfg.repos.iter().any(|r| r.name == repo) {
                return Err(format!("repo '{repo}' does not exist (add-repo first)").into());
            }
            if cfg.tokens.iter().any(|t| t.name == name && t.repo == repo) {
                return Err(format!("token '{name}' already exists for repo '{repo}'").into());
            }
            let access = match access.as_str() {
                "rw" => Access::Rw,
                "ro" => Access::Ro,
                "deposit" => Access::Deposit,
                other => return Err(format!("invalid access {other:?} (rw|ro|deposit)").into()),
            };
            let (raw, hash) = generate_token();
            cfg.tokens.push(TokenEntry {
                name: name.clone(),
                repo: repo.clone(),
                token_hash: hash,
                access,
            });
            cfg.save(&config)?;
            println!("token for '{name}' on repo '{repo}' ({access:?}) — save it NOW, it cannot be recovered:");
            println!("{raw}");
        }
        Cmd::Serve { config } => {
            serve(config)?;
        }
    }
    Ok(())
}

#[tokio::main]
async fn serve(config: PathBuf) -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .init();

    let cfg = ServerConfig::load(&config)?;
    let mut tokens = Vec::new();
    for t in &cfg.tokens {
        if !cfg.repos.iter().any(|r| r.name == t.repo) {
            return Err(format!("token '{}' references unknown repo '{}'", t.name, t.repo).into());
        }
        let bytes = hex::decode(&t.token_hash)
            .map_err(|_| format!("token '{}' hash is not hex", t.name))?;
        tokens.push(api::TokenInfo {
            hash: <[u8; 32]>::try_from(bytes.as_slice())
                .map_err(|_| format!("token '{}' hash is not 32 bytes", t.name))?,
            repo: t.repo.clone(),
            access: t.access,
            name: t.name.clone(),
        });
    }
    if tokens.is_empty() {
        return Err("config has no tokens — nobody could authenticate".into());
    }
    // House rule: services bind loopback; the tunnel does exposure.
    // FAIL CLOSED (audit 2026-06-12 medium): a warning did not stop an
    // accidental 0.0.0.0 bind from exposing bearer-token endpoints to the
    // network — refuse unless the config explicitly opts in.
    if !config::bind_is_loopback(&cfg.bind) {
        if cfg.allow_remote_bind {
            tracing::warn!(
                "UNSAFE: bind address {} is NOT loopback (allow_remote_bind=true) — \
                 every bearer-token endpoint is network-reachable; the supported \
                 exposure path is a Cloudflare tunnel in front of a loopback bind",
                cfg.bind
            );
        } else {
            return Err(format!(
                "refusing to bind non-loopback address {} — services bind 127.0.0.1 and \
                 the tunnel does exposure; set allow_remote_bind=true in the config to \
                 override deliberately",
                cfg.bind
            )
            .into());
        }
    }
    let repos = store::Repos::open(std::path::Path::new(&cfg.data_dir), &cfg.repos)?;
    for t in &tokens {
        tracing::info!("token '{}' → repo '{}' ({:?})", t.name, t.repo, t.access);
    }
    let state = Arc::new(api::AppState { repos, tokens });

    // Trash purge: once at startup, then daily. Grace from config.
    let grace = std::time::Duration::from_secs(cfg.trash_grace_days * 86_400);
    state.repos.purge_all_trash(grace);
    let purge_state = state.clone();
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(std::time::Duration::from_secs(86_400));
        tick.tick().await; // consume the immediate first tick (just purged)
        loop {
            tick.tick().await;
            purge_state.repos.purge_all_trash(grace);
        }
    });

    // API router (bearer-auth'd) + embedded SPA (no auth — it is static
    // public code; all DATA access still goes through /v1 with tokens).
    // Security headers wrap everything. The SPA fallback serves index.html
    // for client-side routes; /v1 paths match the API router first.
    let spa = memory_serve::load!()
        .index_file(Some("/index.html"))
        .fallback(Some("/index.html"))
        .into_router();
    let app = api::router(state)
        .merge(spa)
        .layer(axum::middleware::from_fn(api::security_headers));
    let listener = tokio::net::TcpListener::bind(&cfg.bind).await?;
    tracing::info!(
        "vault-server listening on {} ({} repo(s), data: {})",
        cfg.bind,
        cfg.repos.len(),
        cfg.data_dir
    );
    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
            tracing::info!("shutting down");
        })
        .await?;
    Ok(())
}
