//! src-tauri/src/mcp_marketplace.rs — MCP marketplace v1.
//!
//! Architecture: **Option C — spawn-time injection.** Catalog entries +
//! vault secrets are merged into the `mcp_servers` param of `session/new`
//! at grok spawn time. Nothing auto-installs. `~/.grok/config.toml` stays
//! untouched by secrets.
//!
//! Two pieces of state:
//! 1. CATALOG (compile-time const) — list of all installable connectors
//! grouped by Tier S/A/B. Source of truth for shape + install spec.
//! 2. `~/.shellx/mcp-marketplace.json` — per-user enabled-list. Maps
//! catalog id → { installed: bool, enabled: bool }. Survives across
//! shellX restarts.
//!
//! At session/new time, `inject_marketplace_into_session_new` is called
//! by `acp::start_grok_session`. It reads the enabled-list, resolves vault
//! refs to plaintext (only into the spawned grok's stdin via session/new),
//! and merges the resulting MCP server entries into the existing
//! `mcp_servers` array. Secrets never touch disk via the marketplace path.
//!
//! UX guarantees (PluginsModal contract):
//! - "Install" toggles `installed: true, enabled: true`.
//! - "Remove" toggles `installed: false`.
//! - "Disable" toggles `enabled: false` but keeps the install.
//! - All operations are idempotent (re-install on existing entry is a no-op).
//! - Vault-key absence does NOT block install; the catalog row simply
//! can't be applied at session/new until the key lands. UI shows
//! "key needed" pill in that state.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

/// The transport mechanism the MCP server uses.
///
/// `stdio` — grok spawns the command as a child and talks JSON-RPC over
/// stdin/stdout. Most npm/uvx-distributed servers use this.
/// `http` — grok hits an HTTP endpoint with JSON-RPC bodies. Bearer or
/// custom headers for auth.
/// `sse` — server-sent events streaming variant of HTTP.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum McpKind {
    Stdio,
    Http,
    Sse,
}

/// Tier in the marketplace UX. Affects sort order + first-run install
/// suggestion ("Install Tier S defaults" button).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum McpTier {
    S, // Tier S — always-recommended (zero secrets)
    A, // Tier A — power tools (one vault key)
    B, // Tier B — specialty (niche, OAuth/keys)
    C, // Tier C — advanced (databases, infra, OAuth-heavy)
}

/// One immutable catalog entry. Defined as `&'static` in CATALOG below.
/// `Serialize` only — entries are construct-time const, never parsed from JSON.
#[derive(Debug, Clone, Serialize)]
pub struct McpCatalogEntry {
    pub id: &'static str,
    pub name: &'static str,
    pub tier: McpTier,
    pub kind: McpKind,
    /// One-line description (≤80 chars for the modal row).
    pub description: &'static str,
    /// Comma-separated marker for category-chip filter (Phase 2).
    pub category: &'static str,
    /// For stdio kind: shell-style command line that grok will spawn.
    /// May contain `$VAULT:path` placeholders that are resolved at
    /// injection time from the user's vault. Empty for HTTP kind.
    pub stdio_command: &'static str,
    /// For HTTP/SSE kind: endpoint URL. Empty for stdio.
    pub http_url: &'static str,
    /// For HTTP/SSE kind: bearer-prefix header value as
    /// `Authorization=Bearer $VAULT:vault-path`. Empty for stdio.
    pub http_auth: &'static str,
    /// Vault paths the entry needs. UI uses this to drive the
    /// "key needed" pill and to wire the "Add key" link to the
    /// vault panel.
    pub vault_keys: &'static [&'static str],
}

/// Per-id user state held in `~/.shellx/mcp-marketplace.json`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct McpEntryState {
    #[serde(default)]
    pub installed: bool,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

fn default_true() -> bool {
    true
}

/// On-disk persisted layout for marketplace state.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct MarketplaceFile {
    #[serde(default)]
    entries: HashMap<String, McpEntryState>,
}

/// 19-entry catalog covering Tier S (5) + Tier A (7) + Tier B (7).
/// Order is intentional and should remain stable for UI/display
/// consistency unless the catalog itself is redesigned.
/// Adding entries: append to this list; the id is the stable identifier.
pub const CATALOG: &[McpCatalogEntry] = &[
    // ─── Tier S ──────────────────────────────────────────────────────
    McpCatalogEntry {
        id: "context7",
        name: "Context7",
        tier: McpTier::S,
        kind: McpKind::Stdio,
        description: "Up-to-date library docs (Next.js, Drizzle, …)",
        category: "docs",
        stdio_command: "npx -y @upstash/context7-mcp",
        http_url: "",
        http_auth: "",
        vault_keys: &[],
    },
    McpCatalogEntry {
        id: "playwright",
        name: "Playwright",
        tier: McpTier::S,
        kind: McpKind::Stdio,
        description: "Headless browser open/click/type/screenshot/eval",
        category: "browser",
        stdio_command: "npx @playwright/mcp@latest",
        http_url: "",
        http_auth: "",
        vault_keys: &[],
    },
    McpCatalogEntry {
        id: "fetch",
        name: "Fetch",
        tier: McpTier::S,
        kind: McpKind::Stdio,
        description: "URL→markdown for any HTTP page (needs uv)",
        category: "browser",
        // No npm package exists for
        // `@modelcontextprotocol/server-fetch` (registry returns 404).
        // Fetch is Python-only on PyPI; canonical invocation is via uvx.
        // Requires `uv` installed on PATH (Windows: `winget install
        // astral-sh.uv` or `pipx install uv`).
        stdio_command: "uvx mcp-server-fetch",
        http_url: "",
        http_auth: "",
        vault_keys: &[],
    },
    McpCatalogEntry {
        id: "git",
        name: "Git",
        tier: McpTier::S,
        kind: McpKind::Stdio,
        description: "log / diff / blame / show on cwd (needs uv)",
        category: "code",
        // Requires `uv` on PATH (no npm equivalent exists).
        // Windows: `winget install astral-sh.uv`.
        stdio_command: "uvx mcp-server-git",
        http_url: "",
        http_auth: "",
        vault_keys: &[],
    },
    McpCatalogEntry {
        id: "memory",
        name: "Memory",
        tier: McpTier::S,
        kind: McpKind::Stdio,
        description: "Knowledge-graph entities + relations across sessions",
        category: "memory",
        stdio_command: "npx -y @modelcontextprotocol/server-memory",
        http_url: "",
        http_auth: "",
        vault_keys: &[],
    },
    // ─── Tier A ──────────────────────────────────────────────────────
    McpCatalogEntry {
        id: "github",
        name: "GitHub",
        tier: McpTier::A,
        kind: McpKind::Http,
        description: "PRs, issues, code search, run workflow (~51 tools)",
        category: "code",
        stdio_command: "",
        http_url: "https://api.githubcopilot.com/mcp/",
        http_auth: "Authorization=Bearer $VAULT:github/pat",
        vault_keys: &["github/pat"],
    },
    McpCatalogEntry {
        id: "cloudflare",
        name: "Cloudflare",
        tier: McpTier::A,
        kind: McpKind::Http,
        description: "Workers logs, KV/R2/D1, observability, builds",
        category: "cloud",
        stdio_command: "",
        http_url: "https://mcp.cloudflare.com/mcp",
        http_auth: "Authorization=Bearer $VAULT:cloudflare/api-token",
        vault_keys: &["cloudflare/api-token"],
    },
    McpCatalogEntry {
        id: "supabase",
        name: "Supabase",
        tier: McpTier::A,
        kind: McpKind::Stdio,
        description: "run SQL, list_tables, apply_migration, get_logs",
        category: "database",
        stdio_command:
            "npx -y @supabase/mcp-server-supabase --access-token $VAULT:supabase/access-token",
        http_url: "",
        http_auth: "",
        vault_keys: &["supabase/access-token"],
    },
    McpCatalogEntry {
        id: "stripe",
        name: "Stripe",
        tier: McpTier::A,
        kind: McpKind::Stdio,
        description: "create_payment_link, list_customers, refund, search_docs",
        category: "payments",
        stdio_command: "npx -y @stripe/mcp --api-key=$VAULT:stripe/secret-key",
        http_url: "",
        http_auth: "",
        vault_keys: &["stripe/secret-key"],
    },
    McpCatalogEntry {
        id: "serena",
        name: "Serena",
        tier: McpTier::A,
        kind: McpKind::Stdio,
        description: "Symbol-level refactors (find_symbol, refs, replace_symbol_body)",
        category: "code",
        stdio_command: "uvx --from git+https://github.com/oraios/serena serena start-mcp-server",
        http_url: "",
        http_auth: "",
        vault_keys: &[],
    },
    McpCatalogEntry {
        id: "notion",
        name: "Notion",
        tier: McpTier::A,
        kind: McpKind::Stdio,
        description: "search, query_database, append_block",
        category: "docs",
        stdio_command: "npx -y @notionhq/notion-mcp-server",
        http_url: "",
        http_auth: "",
        vault_keys: &["notion/integration-token"],
    },
    McpCatalogEntry {
        id: "firecrawl",
        name: "Firecrawl",
        tier: McpTier::A,
        kind: McpKind::Stdio,
        description: "scrape, crawl, search, extract (JS-heavy / SPA)",
        category: "browser",
        stdio_command: "npx -y firecrawl-mcp",
        http_url: "",
        http_auth: "",
        vault_keys: &["firecrawl/api-key"],
    },
    McpCatalogEntry {
        id: "brave-search",
        name: "Brave Search",
        tier: McpTier::A,
        kind: McpKind::Stdio,
        description: "Privacy-respecting web search (no tracking)",
        category: "browser",
        stdio_command: "npx -y @modelcontextprotocol/server-brave-search",
        http_url: "",
        http_auth: "",
        vault_keys: &["brave/api-key"],
    },
    // ─── Tier B ──────────────────────────────────────────────────────
    McpCatalogEntry {
        id: "vercel",
        name: "Vercel",
        tier: McpTier::B,
        kind: McpKind::Http,
        description: "list_deployments, env vars, logs",
        category: "cloud",
        stdio_command: "",
        http_url: "https://mcp.vercel.com",
        http_auth: "Authorization=Bearer $VAULT:vercel/token",
        vault_keys: &["vercel/token"],
    },
    McpCatalogEntry {
        id: "sentry",
        name: "Sentry",
        tier: McpTier::B,
        kind: McpKind::Http,
        description: "search_issues, get_event, set_status",
        category: "observability",
        stdio_command: "",
        http_url: "https://mcp.sentry.dev",
        http_auth: "Authorization=Bearer $VAULT:sentry/token",
        vault_keys: &["sentry/token"],
    },
    McpCatalogEntry {
        id: "linear",
        name: "Linear",
        tier: McpTier::B,
        kind: McpKind::Http,
        description: "list_issues, create_issue, cycle",
        category: "issues",
        stdio_command: "",
        http_url: "https://mcp.linear.app/sse",
        http_auth: "Authorization=Bearer $VAULT:linear/token",
        vault_keys: &["linear/token"],
    },
    McpCatalogEntry {
        id: "figma",
        name: "Figma",
        tier: McpTier::B,
        kind: McpKind::Stdio,
        description: "get_file, get_node, export",
        category: "design",
        stdio_command: "npx -y figma-developer-mcp --figma-api-key=$VAULT:figma/token",
        http_url: "",
        http_auth: "",
        vault_keys: &["figma/token"],
    },
    McpCatalogEntry {
        id: "huggingface",
        name: "Hugging Face",
        tier: McpTier::B,
        kind: McpKind::Http,
        description: "search models/datasets, run inference",
        category: "ml",
        stdio_command: "",
        http_url: "https://huggingface.co/mcp",
        http_auth: "Authorization=Bearer $VAULT:hf/token",
        vault_keys: &["hf/token"],
    },
    McpCatalogEntry {
        id: "slack",
        name: "Slack",
        tier: McpTier::B,
        kind: McpKind::Stdio,
        description: "list_channels, post_message, search",
        category: "comms",
        stdio_command: "npx -y @modelcontextprotocol/server-slack",
        http_url: "",
        http_auth: "",
        vault_keys: &["slack/bot-token"],
    },
    McpCatalogEntry {
        id: "markitdown",
        name: "MarkItDown",
        tier: McpTier::B,
        kind: McpKind::Stdio,
        description: "Convert PDF/DOCX/PPTX/etc to markdown",
        category: "docs",
        stdio_command: "uvx markitdown-mcp",
        http_url: "",
        http_auth: "",
        vault_keys: &[],
    },
    McpCatalogEntry {
        id: "telegram",
        name: "Telegram",
        tier: McpTier::B,
        kind: McpKind::Stdio,
        description: "Send/receive messages, manage chats via Bot API",
        category: "comms",
        stdio_command: "uvx mcp-telegram",
        http_url: "",
        http_auth: "",
        vault_keys: &["telegram/bot-token"],
    },
    McpCatalogEntry {
        id: "gitlab",
        name: "GitLab",
        tier: McpTier::B,
        kind: McpKind::Stdio,
        description: "MRs, issues, pipelines, project search",
        category: "code",
        stdio_command: "npx -y @modelcontextprotocol/server-gitlab",
        http_url: "",
        http_auth: "",
        vault_keys: &["gitlab/pat"],
    },
    // ─── Tier C — Advanced (databases, infra, OAuth-heavy) ───────────
    McpCatalogEntry {
        id: "postgres",
        name: "PostgreSQL",
        tier: McpTier::C,
        kind: McpKind::Stdio,
        description: "Schema introspection + read-only SQL on a connection string",
        category: "database",
        stdio_command:
            "npx -y @modelcontextprotocol/server-postgres $VAULT:postgres/connection-string",
        http_url: "",
        http_auth: "",
        vault_keys: &["postgres/connection-string"],
    },
    McpCatalogEntry {
        id: "sqlite",
        name: "SQLite",
        tier: McpTier::C,
        kind: McpKind::Stdio,
        description: "Query / list_tables / describe on a local .db file",
        category: "database",
        stdio_command: "uvx mcp-server-sqlite --db-path $VAULT:sqlite/db-path",
        http_url: "",
        http_auth: "",
        vault_keys: &["sqlite/db-path"],
    },
    McpCatalogEntry {
        id: "docker",
        name: "Docker",
        tier: McpTier::C,
        kind: McpKind::Stdio,
        description: "list/inspect/logs containers + images (local daemon)",
        category: "infra",
        stdio_command: "uvx docker-mcp",
        http_url: "",
        http_auth: "",
        vault_keys: &[],
    },
    McpCatalogEntry {
        id: "jira",
        name: "Jira",
        tier: McpTier::C,
        kind: McpKind::Stdio,
        description: "search_issues, create_issue, transition (Atlassian Cloud)",
        category: "issues",
        stdio_command: "uvx mcp-atlassian",
        http_url: "",
        http_auth: "",
        vault_keys: &[
            "atlassian/email",
            "atlassian/api-token",
            "atlassian/site-url",
        ],
    },
    McpCatalogEntry {
        id: "discord",
        name: "Discord",
        tier: McpTier::C,
        kind: McpKind::Stdio,
        description: "list_channels, send_message, manage roles (Bot API)",
        category: "comms",
        stdio_command: "npx -y mcp-discord",
        http_url: "",
        http_auth: "",
        vault_keys: &["discord/bot-token"],
    },
    McpCatalogEntry {
        id: "google-workspace",
        name: "Google Workspace",
        tier: McpTier::C,
        kind: McpKind::Stdio,
        description: "Gmail send, Drive search, Calendar, Docs, Sheets (OAuth)",
        category: "comms",
        stdio_command: "uvx workspace-mcp",
        http_url: "",
        http_auth: "",
        vault_keys: &[
            "google/oauth-refresh-token",
            "google/client-id",
            "google/client-secret",
        ],
    },
    McpCatalogEntry {
        id: "1password",
        name: "1Password",
        tier: McpTier::C,
        kind: McpKind::Stdio,
        description: "Vault item read for ephemeral credentials in commands",
        category: "security",
        stdio_command: "npx -y @1password/op-mcp",
        http_url: "",
        http_auth: "",
        vault_keys: &["1password/service-account-token"],
    },
    McpCatalogEntry {
        id: "qdrant",
        name: "Qdrant (Vector DB)",
        tier: McpTier::C,
        kind: McpKind::Stdio,
        description: "Semantic memory: store, search, list collections",
        category: "memory",
        stdio_command: "uvx mcp-server-qdrant",
        http_url: "",
        http_auth: "",
        vault_keys: &["qdrant/url", "qdrant/api-key"],
    },
];

/// Resolve `~/.shellx/mcp-marketplace.json` path.
fn state_file_path() -> Result<PathBuf, String> {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map_err(|_| "HOME/USERPROFILE not set".to_string())?;
    let dir = PathBuf::from(home).join(".shellx");
    Ok(dir.join("mcp-marketplace.json"))
}

/// Read-and-parse the on-disk state. Missing file = empty state.
/// Malformed file = empty state + warn (so a corrupted file doesn't
/// nuke the user's setup; UI re-saves on next change).
fn read_state() -> MarketplaceFile {
    let Ok(path) = state_file_path() else {
        return MarketplaceFile::default();
    };
    let Ok(body) = fs::read_to_string(&path) else {
        return MarketplaceFile::default();
    };
    match serde_json::from_str::<MarketplaceFile>(&body) {
        Ok(f) => f,
        Err(e) => {
            tracing::warn!("mcp-marketplace.json malformed: {} — treating as empty", e);
            MarketplaceFile::default()
        }
    }
}

/// Atomic-rename write to avoid mid-update corruption.
fn write_state(f: &MarketplaceFile) -> Result<(), String> {
    let path = state_file_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("mkdir {}: {}", parent.display(), e))?;
    }
    let body = serde_json::to_string_pretty(f).map_err(|e| format!("serialize: {}", e))?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, body.as_bytes()).map_err(|e| format!("write tmp: {}", e))?;
    fs::rename(&tmp, &path).map_err(|e| format!("rename: {}", e))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

/// Per-process cached state. We re-read on every list query (cheap —
/// the file is tiny); installed/uninstall calls go through the mutex
/// to serialize concurrent writes from multiple Tauri invokes.
static STATE_LOCK: Mutex<()> = Mutex::new(());

/// Status returned for a single catalog entry — what the UI needs to
/// render the row.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpEntryStatus {
    pub id: String,
    pub name: String,
    pub tier: McpTier,
    pub kind: McpKind,
    pub description: String,
    pub category: String,
    pub vault_keys: Vec<String>,
    pub installed: bool,
    pub enabled: bool,
    /// Per-key availability — true means vault has a non-empty value.
    /// Used to drive the "key needed" pill: if any required key is
    /// missing, the row shows "key needed" instead of "available".
    pub keys_available: Vec<bool>,
    pub all_keys_present: bool,
}

/// List the full catalog merged with on-disk enabled state and live
/// vault availability. UI calls this on PluginsModal open + on every
/// vault change event.
pub async fn list_marketplace() -> Result<Vec<McpEntryStatus>, String> {
    let file = read_state();
    // Vault is OPTIONAL. If it's unreachable (e.g. master.key not yet
    // generated), entries with required keys simply show
    // `keysAvailable: [false, …]` and the UI renders the "key needed"
    // pill. Tier S entries (no keys) still list as `+ available`.
    let vault_opt = crate::vault::Vault::open().ok();
    let mut out = Vec::with_capacity(CATALOG.len());
    for entry in CATALOG {
        let st = file.entries.get(entry.id).cloned().unwrap_or_default();
        let mut keys_available = Vec::with_capacity(entry.vault_keys.len());
        for key in entry.vault_keys {
            let has = match vault_opt.as_ref() {
                Some(v) => v.get(key).await.ok().flatten().is_some(),
                None => false,
            };
            keys_available.push(has);
        }
        let all_keys_present = keys_available.iter().all(|b| *b);
        out.push(McpEntryStatus {
            id: entry.id.to_string(),
            name: entry.name.to_string(),
            tier: entry.tier,
            kind: entry.kind,
            description: entry.description.to_string(),
            category: entry.category.to_string(),
            vault_keys: entry.vault_keys.iter().map(|s| s.to_string()).collect(),
            installed: st.installed,
            enabled: st.enabled,
            keys_available,
            all_keys_present,
        });
    }
    Ok(out)
}

/// Mark the entry as installed + enabled. Re-install on existing
/// entry just re-enables it (idempotent). Errors only on file I/O.
pub fn install_marketplace_entry(id: &str) -> Result<(), String> {
    let _guard = STATE_LOCK
        .lock()
        .map_err(|e| format!("lock poisoned: {}", e))?;
    if !CATALOG.iter().any(|e| e.id == id) {
        return Err(format!("unknown marketplace id: {}", id));
    }
    let mut file = read_state();
    file.entries.insert(
        id.to_string(),
        McpEntryState {
            installed: true,
            enabled: true,
        },
    );
    write_state(&file)?;
    tracing::info!("mcp_marketplace: installed entry id={}", id);
    Ok(())
}

/// Mark the entry as uninstalled. Preserves the enabled bit for
/// the case of "Uninstall → re-install later wants enable on".
pub fn uninstall_marketplace_entry(id: &str) -> Result<(), String> {
    let _guard = STATE_LOCK
        .lock()
        .map_err(|e| format!("lock poisoned: {}", e))?;
    let mut file = read_state();
    if let Some(st) = file.entries.get_mut(id) {
        st.installed = false;
    }
    write_state(&file)?;
    tracing::info!("mcp_marketplace: uninstalled entry id={}", id);
    Ok(())
}

/// Toggle enabled state without changing installed.
pub fn set_marketplace_entry_enabled(id: &str, enabled: bool) -> Result<(), String> {
    let _guard = STATE_LOCK
        .lock()
        .map_err(|e| format!("lock poisoned: {}", e))?;
    let mut file = read_state();
    let st = file.entries.entry(id.to_string()).or_default();
    st.enabled = enabled;
    write_state(&file)?;
    tracing::info!("mcp_marketplace: set enabled id={} → {}", id, enabled);
    Ok(())
}

/// Build a JSON array of mcp_server entries ready to merge into the
/// `session/new` request's `mcp_servers` param. Resolves `$VAULT:path`
/// placeholders to plaintext values from the vault at injection time.
///
/// Entries with missing vault keys are SKIPPED (with a warning log) —
/// the install lingers on disk but stays inactive until the user
/// provides the key. Mirrors the proposal's "key needed" UX state.
///
/// Returns Ok(Value::Array). Empty array if no entries are
/// installed+enabled or vault is unreachable. Never errors hard — a
/// broken marketplace MUST NOT block grok from spawning.
#[allow(dead_code)]
pub async fn build_session_new_entries() -> Value {
    build_session_new_entries_for_transport("local").await
}

/// Transport-aware variant. AGENT-B8 fix: when grok runs on a remote
/// box (WSL / SSH), stdio marketplace entries spawn the command in
/// grok's own process — i.e. on the remote box. The packaged stdio
/// commands (`uvx`, `npx`, `cmd.exe`, …) are not present on the
/// remote PATH, so grok logs 6× `Failed to spawn MCP server
/// 'shellx-mp-*': No such file or directory` and the marketplace
/// servers are effectively dead on those transports. Skipping stdio
/// entries when transport != "local" turns those silent failures into
/// honest no-ops (the user can see the entries are not loaded in the
/// marketplace panel for that tab). HTTP/SSE entries stay on every
/// transport — they're network fetches that don't need a remote
/// binary.
///
/// `transport_kind` accepts: "local" | "wsl" | "ssh" (other values
/// are treated as remote).
pub async fn build_session_new_entries_for_transport(transport_kind: &str) -> Value {
    let file = read_state();
    let is_remote = !matches!(transport_kind, "local");
    let vault_opt = crate::vault::Vault::open().ok();
    let mut out = Vec::new();
    for entry in CATALOG {
        let Some(st) = file.entries.get(entry.id) else {
            continue;
        };
        if !(st.installed && st.enabled) {
            continue;
        }
        // Resolve vault refs first — bail this entry if any key missing.
        let mut resolved: HashMap<String, String> = HashMap::new();
        let mut skip_reason: Option<String> = None;
        if !entry.vault_keys.is_empty() {
            let Some(vault) = vault_opt.as_ref() else {
                tracing::warn!(
                    "mcp_marketplace: skipping '{}' — vault unreachable (vault.master.key missing) but entry requires {} key(s)",
                    entry.id, entry.vault_keys.len()
                );
                continue;
            };
            for key in entry.vault_keys {
                match vault.get(key).await.ok().flatten() {
                    Some(v) if !v.is_empty() => {
                        resolved.insert(key.to_string(), v);
                    }
                    _ => {
                        skip_reason = Some(format!("vault key '{}' missing", key));
                        break;
                    }
                }
            }
        }
        if let Some(r) = skip_reason {
            tracing::warn!("mcp_marketplace: skipping '{}' — {}", entry.id, r);
            continue;
        }
        // Build the JSON entry per kind. #431 — server prefix uses a
        // single dash (`shellx-mp-<id>`) NOT `shellx-mp__<id>`. Grok-
        // build treats `__` as the server/tool boundary in qualified
        // names; with the old `__` prefix, every tool from a
        // marketplace server became `shellx-mp__<id>__<tool>` (two
        // `__` instances) and was silently dropped with
        // "qualified name contains '__' more than once". Single dash
        // keeps the namespace-prefix readable while leaving exactly
        // one `__` at the server/tool boundary.
        let server_name = format!("shellx-mp-{}", entry.id);
        // AGENT-B8 fix: stdio entries spawn the command IN GROK'S PROCESS,
        // i.e. on whichever machine grok is running on. For WSL/SSH
        // transports that means the binary (uvx, npx, cmd.exe…) has to
        // exist on the REMOTE box's PATH — and it almost never does.
        // grok logs N× "Failed to spawn MCP server: No such file or
        // directory" and the marketplace ends up effectively disabled
        // on those transports. Skip the entry instead of injecting a
        // doomed config row.
        if is_remote && matches!(entry.kind, McpKind::Stdio) {
            tracing::info!(
                "mcp_marketplace: skipping stdio entry '{}' on {} transport \
                 (binary would need to be installed on the remote box)",
                entry.id,
                transport_kind
            );
            continue;
        }
        match entry.kind {
            McpKind::Stdio => {
                let resolved_cmd = expand_vault_placeholders(entry.stdio_command, &resolved);
                let parts: Vec<&str> = resolved_cmd.split_whitespace().collect();
                if parts.is_empty() {
                    tracing::warn!(
                        "mcp_marketplace: '{}' stdio_command empty after resolve",
                        entry.id
                    );
                    continue;
                }
                // #416 — on Windows, `uvx` / `npx` are PATHEXT shims (.cmd /
                // .exe) and grok-build's `CreateProcessW` lookup fails on
                // the bare name. Wrapping with `cmd.exe /c` lets the shell
                // resolve through PATHEXT. We do NOT wrap on non-Windows
                // (Linux/macOS grok-build resolves them natively).
                let (cmd_str, args_vec): (String, Vec<String>) = if cfg!(windows) {
                    let mut a: Vec<String> = vec!["/c".to_string()];
                    a.extend(parts.iter().map(|s| (*s).to_string()));
                    ("cmd.exe".to_string(), a)
                } else {
                    (
                        parts[0].to_string(),
                        parts[1..].iter().map(|s| (*s).to_string()).collect(),
                    )
                };
                out.push(json!({
                    "name": server_name,
                    "command": cmd_str,
                    "args": args_vec.iter().map(|s| Value::String(s.clone())).collect::<Vec<_>>(),
                    "env": [],
                }));
            }
            McpKind::Http | McpKind::Sse => {
                let mut headers = serde_json::Map::new();
                for hdr in entry.http_auth.split(';').filter(|s| !s.trim().is_empty()) {
                    let (k, v) = match hdr.split_once('=') {
                        Some((k, v)) => (k.trim(), v.trim()),
                        None => continue,
                    };
                    let resolved_v = expand_vault_placeholders(v, &resolved);
                    headers.insert(k.to_string(), Value::String(resolved_v));
                }
                out.push(json!({
                    "name": server_name,
                    "url": entry.http_url,
                    "headers": Value::Object(headers),
                }));
            }
        }
    }
    Value::Array(out)
}

/// Substitute every `$VAULT:path` placeholder with the resolved
/// plaintext value from the supplied map. Unmatched placeholders are
/// left as-is so they're visible if a future refactor changes vault paths.
fn expand_vault_placeholders(s: &str, resolved: &HashMap<String, String>) -> String {
    let mut out = String::with_capacity(s.len());
    let bytes = s.as_bytes();
    let mut i = 0usize;
    while i < bytes.len() {
        if bytes[i..].starts_with(b"$VAULT:") {
            let after = &s[i + 7..];
            let end = after
                .find(|c: char| c.is_whitespace() || c == '=' || c == '"' || c == '\'')
                .unwrap_or(after.len());
            let key = &after[..end];
            if let Some(v) = resolved.get(key) {
                out.push_str(v);
            } else {
                out.push_str("$VAULT:");
                out.push_str(key);
            }
            i += 7 + end;
        } else {
            out.push(bytes[i] as char);
            i += 1;
        }
    }
    out
}
