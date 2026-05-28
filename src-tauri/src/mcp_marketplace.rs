//! src-tauri/src/mcp_marketplace.rs — MCP marketplace v1.
//!
//! Architecture: catalog-driven UI backed by Grok's native MCP config.
//! Installs write managed `[mcp_servers.shellx-mp-*]` sections into
//! `~/.grok/config.toml`, so Grok owns discovery, MCP startup, and
//! `grok mcp list/remove/doctor` visibility. ShellX keeps only the
//! curated catalog and local vault UX.
//!
//! Secrets never touch `config.toml`: generated sections reference
//! environment variables such as `${SHELLX_MCP_MARKETPLACE_GITHUB_PAT}`.
//! At Grok process spawn, shellX resolves the corresponding vault keys
//! into those env vars for the child process only.
//!
//! UX guarantees (PluginsModal contract):
//! - "Install" writes/enables Grok's native MCP config block.
//! - "Remove" toggles `installed: false`.
//! - "Disable" sets `enabled = false` but keeps the config block.
//! - All operations are idempotent (re-install on existing entry is a no-op).
//! - Vault-key absence does NOT block install; the catalog row simply
//! can't authenticate until the key lands. UI shows "key needed" in that state.

use serde::{Deserialize, Serialize};
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
        kind: McpKind::Sse,
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
        description: "Telegram account MCP via MTProto; requires login",
        category: "comms",
        stdio_command: "uvx mcp-telegram start",
        http_url: "",
        http_auth: "",
        vault_keys: &["telegram/api-id", "telegram/api-hash"],
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

/// Resolve Grok's user config. Mirrors skill_install's home convention
/// intentionally; this is the canonical file `grok mcp` manages.
fn grok_config_path() -> Result<PathBuf, String> {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map_err(|_| "HOME/USERPROFILE not set".to_string())?;
    Ok(PathBuf::from(home).join(".grok").join("config.toml"))
}

fn server_name_for_entry(id: &str) -> String {
    format!("shellx-mp-{}", id)
}

fn begin_marker(id: &str) -> String {
    format!(
        "# shellX:managed-mcp-marketplace:{} BEGIN - do not edit by hand",
        id
    )
}

fn end_marker(id: &str) -> String {
    format!("# shellX:managed-mcp-marketplace:{} END", id)
}

fn vault_env_name(key: &str) -> String {
    let mut out = String::from("SHELLX_MCP_MARKETPLACE_");
    for ch in key.chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch.to_ascii_uppercase());
        } else {
            out.push('_');
        }
    }
    out
}

fn toml_string(s: &str) -> String {
    let escaped = s
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\n', "\\n")
        .replace('\r', "\\r")
        .replace('\t', "\\t");
    format!("\"{}\"", escaped)
}

fn push_enabled(out: &mut String, enabled: bool) {
    out.push_str("enabled = ");
    out.push_str(if enabled { "true" } else { "false" });
    out.push('\n');
}

fn expand_vault_placeholders_to_env_refs(s: &str) -> String {
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
            out.push_str("${");
            out.push_str(&vault_env_name(key));
            out.push('}');
            i += 7 + end;
        } else {
            out.push(bytes[i] as char);
            i += 1;
        }
    }
    out
}

fn stdio_env_for_entry(entry: &McpCatalogEntry) -> Vec<(&'static str, String)> {
    match entry.id {
        "notion" => vec![(
            "OPENAPI_MCP_HEADERS",
            "{\"Authorization\":\"Bearer $VAULT:notion/integration-token\",\"Notion-Version\":\"2022-06-28\"}".to_string(),
        )],
        "firecrawl" => vec![("FIRECRAWL_API_KEY", "$VAULT:firecrawl/api-key".to_string())],
        "brave-search" => vec![("BRAVE_API_KEY", "$VAULT:brave/api-key".to_string())],
        "slack" => vec![("SLACK_BOT_TOKEN", "$VAULT:slack/bot-token".to_string())],
        "telegram" => vec![
            ("API_ID", "$VAULT:telegram/api-id".to_string()),
            ("API_HASH", "$VAULT:telegram/api-hash".to_string()),
        ],
        "gitlab" => vec![(
            "GITLAB_PERSONAL_ACCESS_TOKEN",
            "$VAULT:gitlab/pat".to_string(),
        )],
        "jira" => vec![
            ("ATLASSIAN_USERNAME", "$VAULT:atlassian/email".to_string()),
            ("ATLASSIAN_API_TOKEN", "$VAULT:atlassian/api-token".to_string()),
            ("JIRA_URL", "$VAULT:atlassian/site-url".to_string()),
        ],
        "discord" => vec![("DISCORD_TOKEN", "$VAULT:discord/bot-token".to_string())],
        "google-workspace" => vec![
            (
                "GOOGLE_REFRESH_TOKEN",
                "$VAULT:google/oauth-refresh-token".to_string(),
            ),
            ("GOOGLE_CLIENT_ID", "$VAULT:google/client-id".to_string()),
            (
                "GOOGLE_CLIENT_SECRET",
                "$VAULT:google/client-secret".to_string(),
            ),
        ],
        "1password" => vec![(
            "OP_SERVICE_ACCOUNT_TOKEN",
            "$VAULT:1password/service-account-token".to_string(),
        )],
        "qdrant" => vec![
            ("QDRANT_URL", "$VAULT:qdrant/url".to_string()),
            ("QDRANT_API_KEY", "$VAULT:qdrant/api-key".to_string()),
        ],
        _ => Vec::new(),
    }
}

fn managed_block_range(source: &str, id: &str) -> Option<(usize, usize)> {
    let begin = begin_marker(id);
    let end = end_marker(id);
    let b = source.find(&begin)?;
    let line_start = source[..b].rfind('\n').map(|i| i + 1).unwrap_or(0);
    let e = source[b + begin.len()..].find(&end)? + b + begin.len();
    let line_end = source[e..]
        .find('\n')
        .map(|i| e + i + 1)
        .unwrap_or(source.len());
    Some((line_start, line_end))
}

fn strip_managed_block_for_entry(source: &str, id: &str) -> String {
    let mut out = source.to_string();
    while let Some((start, end)) = managed_block_range(&out, id) {
        let before = out[..start].trim_end_matches('\n');
        let after = out[end..].trim_start_matches('\n');
        out = match (before.is_empty(), after.is_empty()) {
            (true, true) => String::new(),
            (true, false) => after.to_string(),
            (false, true) => before.to_string(),
            (false, false) => format!("{}\n{}", before, after),
        };
    }
    out
}

fn managed_block_for_entry(source: &str, id: &str) -> Option<String> {
    let (start, end) = managed_block_range(source, id)?;
    Some(source[start..end].trim().to_string())
}

fn has_managed_block_for_entry(source: &str, id: &str) -> bool {
    managed_block_range(source, id).is_some()
}

fn strip_unmanaged_server_section(source: &str, server_name: &str) -> String {
    let headers = [
        format!("mcp_servers.{}", server_name),
        format!("mcp_servers.{}.headers", server_name),
        format!("mcp_servers.{}.env", server_name),
    ];
    let mut out = source.to_string();
    for header in headers {
        out = strip_toml_section(&out, &header);
    }
    out
}

pub fn strip_managed_marketplace_config(source: &str) -> String {
    let mut out = source.to_string();
    for entry in CATALOG {
        out = strip_managed_block_for_entry(&out, entry.id);
        out = strip_unmanaged_server_section(&out, &server_name_for_entry(entry.id));
    }
    out
}

fn strip_toml_section(source: &str, header: &str) -> String {
    let mut out = source.to_string();
    loop {
        let next = strip_toml_section_once(&out, header);
        if next == out {
            return out;
        }
        out = next;
    }
}

fn strip_toml_section_once(source: &str, header: &str) -> String {
    let needle = format!("[{}]", header);
    let Some(idx) = source.find(&needle) else {
        return source.to_string();
    };
    let after_section_start = idx + needle.len();
    let after = &source[after_section_start..];
    let next_header = after.find("\n[").map(|rel| after_section_start + rel + 1);
    let next_shellx_marker = after
        .find("\n# shellX:")
        .map(|rel| after_section_start + rel + 1);
    let cut_end = [next_header, next_shellx_marker]
        .into_iter()
        .flatten()
        .min()
        .unwrap_or(source.len());
    let mut out = String::with_capacity(source.len());
    out.push_str(&source[..idx]);
    if cut_end < source.len() {
        out.push_str(&source[cut_end..]);
    }
    out
}

fn server_section(source: &str, server_name: &str) -> Option<String> {
    let needle = format!("[mcp_servers.{}]", server_name);
    let idx = source.find(&needle)?;
    let after_start = idx + needle.len();
    let after = &source[after_start..];
    let end = after
        .find("\n[")
        .map(|rel| after_start + rel + 1)
        .unwrap_or(source.len());
    Some(source[idx..end].to_string())
}

fn section_enabled(section: &str) -> bool {
    for line in section.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('#') {
            continue;
        }
        if let Some((key, val)) = trimmed.split_once('=') {
            if key.trim() == "enabled" {
                return val.trim().trim_end_matches(',') != "false";
            }
        }
    }
    true
}

fn config_section_for_entry(entry: &McpCatalogEntry, enabled: bool) -> String {
    config_section_for_entry_for_platform(entry, enabled, cfg!(windows))
}

fn config_section_for_entry_for_platform(
    entry: &McpCatalogEntry,
    enabled: bool,
    windows_stdio: bool,
) -> String {
    let id = entry.id;
    let server_name = server_name_for_entry(id);
    let mut out = String::new();
    out.push_str(&begin_marker(id));
    out.push('\n');
    out.push_str(&format!("[mcp_servers.{}]\n", server_name));
    match entry.kind {
        McpKind::Stdio => {
            let resolved_cmd = expand_vault_placeholders_to_env_refs(entry.stdio_command);
            let parts: Vec<&str> = resolved_cmd.split_whitespace().collect();
            if let Some((cmd, args)) = parts.split_first() {
                let (cmd, args): (String, Vec<String>) = if windows_stdio {
                    let proxy = std::env::current_exe()
                        .ok()
                        .map(|p| p.to_string_lossy().to_string())
                        .unwrap_or_else(|| "shellx.exe".to_string());
                    let mut wrapped = vec!["--stdio-proxy".to_string()];
                    wrapped.extend(parts.iter().map(|s| (*s).to_string()));
                    (proxy, wrapped)
                } else {
                    (
                        (*cmd).to_string(),
                        args.iter().map(|s| (*s).to_string()).collect(),
                    )
                };
                out.push_str("command = ");
                out.push_str(&toml_string(&cmd));
                out.push('\n');
                out.push_str("args = [");
                for (idx, arg) in args.iter().enumerate() {
                    if idx > 0 {
                        out.push_str(", ");
                    }
                    out.push_str(&toml_string(arg));
                }
                out.push_str("]\n");
            }
            push_enabled(&mut out, enabled);
            let env = stdio_env_for_entry(entry);
            if !env.is_empty() {
                out.push_str(&format!("[mcp_servers.{}.env]\n", server_name));
                for (key, value) in env {
                    out.push_str(key);
                    out.push_str(" = ");
                    out.push_str(&toml_string(&expand_vault_placeholders_to_env_refs(&value)));
                    out.push('\n');
                }
            }
        }
        McpKind::Http | McpKind::Sse => {
            out.push_str("url = ");
            out.push_str(&toml_string(entry.http_url));
            out.push('\n');
            out.push_str("type = ");
            out.push_str(&toml_string(match entry.kind {
                McpKind::Http => "http",
                McpKind::Sse => "sse",
                McpKind::Stdio => unreachable!(),
            }));
            out.push('\n');
            let mut headers: Vec<(String, String)> = Vec::new();
            for hdr in entry.http_auth.split(';').filter(|s| !s.trim().is_empty()) {
                if let Some((k, v)) = hdr.split_once('=') {
                    headers.push((
                        k.trim().to_string(),
                        expand_vault_placeholders_to_env_refs(v.trim()),
                    ));
                }
            }
            if !headers.is_empty() {
                out.push_str("headers = { ");
                for (idx, (k, v)) in headers.iter().enumerate() {
                    if idx > 0 {
                        out.push_str(", ");
                    }
                    out.push_str(&toml_string(k));
                    out.push_str(" = ");
                    out.push_str(&toml_string(v));
                }
                out.push_str(" }\n");
            }
            push_enabled(&mut out, enabled);
        }
    }
    out.push_str(&end_marker(id));
    out.push('\n');
    out
}

fn upsert_grok_config_entry(entry: &McpCatalogEntry, enabled: bool) -> Result<(), String> {
    let path = grok_config_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("mkdir {}: {}", parent.display(), e))?;
    }
    let existing = fs::read_to_string(&path).unwrap_or_default();
    let server_name = server_name_for_entry(entry.id);
    let stripped = strip_managed_block_for_entry(&existing, entry.id);
    let stripped = strip_unmanaged_server_section(&stripped, &server_name);
    let new_block = config_section_for_entry(entry, enabled);
    let updated = if stripped.trim().is_empty() {
        new_block
    } else {
        format!("{}\n\n{}", stripped.trim_end(), new_block)
    };
    write_grok_config_validated(&path, &updated)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

fn remove_grok_config_entry(id: &str) -> Result<(), String> {
    let path = grok_config_path()?;
    let existing = match fs::read_to_string(&path) {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(format!("read {}: {}", path.display(), e)),
    };
    let server_name = server_name_for_entry(id);
    let stripped = strip_managed_block_for_entry(&existing, id);
    let stripped = strip_unmanaged_server_section(&stripped, &server_name);
    write_grok_config_validated(&path, stripped.trim_end())?;
    Ok(())
}

fn write_grok_config_validated(path: &PathBuf, updated: &str) -> Result<(), String> {
    if !updated.trim().is_empty() {
        toml::from_str::<toml::Value>(updated)
            .map_err(|e| format!("generated TOML for {} is invalid: {}", path.display(), e))?;
    }
    let tmp = path.with_extension(format!("toml.{}.tmp", std::process::id()));
    fs::write(&tmp, updated.as_bytes())
        .map_err(|e| format!("write tmp {}: {}", tmp.display(), e))?;
    fs::rename(&tmp, path).map_err(|e| format!("rename {}: {}", path.display(), e))?;
    Ok(())
}

fn installed_enabled_from_grok_config(id: &str) -> Option<(bool, bool)> {
    let path = grok_config_path().ok()?;
    let source = fs::read_to_string(path).ok()?;
    let section = server_section(&source, &server_name_for_entry(id))?;
    Some((true, section_enabled(&section)))
}

fn telegram_section_uses_legacy_bot_token_env(source: &str) -> bool {
    if let Some((start, end)) = managed_block_range(source, "telegram") {
        let block = &source[start..end];
        return block.contains("TELEGRAM_BOT_TOKEN") || block.contains("telegram/bot-token");
    }
    let server_name = server_name_for_entry("telegram");
    let main = server_section(source, &server_name).unwrap_or_default();
    let env = server_section(source, &format!("{}.env", server_name)).unwrap_or_default();
    main.contains("TELEGRAM_BOT_TOKEN")
        || main.contains("telegram/bot-token")
        || env.contains("TELEGRAM_BOT_TOKEN")
        || env.contains("telegram/bot-token")
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
    migrate_legacy_state_to_grok_config();
    let file = read_state();
    // Vault is OPTIONAL. If it's unreachable (e.g. master.key not yet
    // generated), entries with required keys simply show
    // `keysAvailable: [false, …]` and the UI renders the "key needed"
    // pill. Tier S entries (no keys) still list as `+ available`.
    let vault_opt = crate::vault::Vault::open().ok();
    let mut out = Vec::with_capacity(CATALOG.len());
    for entry in CATALOG {
        let st = file.entries.get(entry.id).cloned().unwrap_or_default();
        let config_state = installed_enabled_from_grok_config(entry.id);
        let installed = config_state
            .map(|(installed, _)| installed)
            .unwrap_or(st.installed);
        let enabled = config_state
            .map(|(_, enabled)| enabled)
            .unwrap_or(st.enabled);
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
            installed,
            enabled,
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
    let entry = CATALOG
        .iter()
        .find(|e| e.id == id)
        .ok_or_else(|| format!("unknown marketplace id: {}", id))?;
    upsert_grok_config_entry(entry, true)?;
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
    remove_grok_config_entry(id)?;
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
    let entry = CATALOG
        .iter()
        .find(|e| e.id == id)
        .ok_or_else(|| format!("unknown marketplace id: {}", id))?;
    upsert_grok_config_entry(entry, enabled)?;
    let mut file = read_state();
    let st = file.entries.entry(id.to_string()).or_default();
    st.enabled = enabled;
    write_state(&file)?;
    tracing::info!("mcp_marketplace: set enabled id={} → {}", id, enabled);
    Ok(())
}

/// One-time compatibility migration from the legacy shellX-only state file
/// into Grok's native MCP config. Best-effort by design: plugin-panel reads
/// must never block because config migration failed.
fn migrate_legacy_state_to_grok_config() {
    let _guard = match STATE_LOCK.lock() {
        Ok(guard) => guard,
        Err(e) => {
            tracing::warn!("mcp_marketplace: migration lock poisoned: {}", e);
            return;
        }
    };
    migrate_legacy_state_to_grok_config_locked();
}

fn migrate_legacy_state_to_grok_config_locked() {
    let mut file = read_state();
    let mut state_dirty = false;
    for entry in CATALOG {
        if let Some((installed, enabled)) = installed_enabled_from_grok_config(entry.id) {
            if installed {
                let source = grok_config_path()
                    .ok()
                    .and_then(|path| fs::read_to_string(path).ok())
                    .unwrap_or_default();
                if entry.id == "telegram" && telegram_section_uses_legacy_bot_token_env(&source) {
                    // Older shellX builds wired the third-party `mcp-telegram`
                    // package to the native bot-token vault key. That package is
                    // account/MTProto based and requires API_ID/API_HASH plus an
                    // interactive login session, so the legacy block can only
                    // fail Grok MCP doctor. Keep the row installed for visibility,
                    // but disable it and rewrite the block with the correct env.
                    if let Err(e) = upsert_grok_config_entry(entry, false) {
                        tracing::warn!(
                            "mcp_marketplace: legacy telegram bot-token migration failed: {}",
                            e
                        );
                    } else {
                        let st = file.entries.entry(entry.id.to_string()).or_default();
                        st.installed = true;
                        st.enabled = false;
                        state_dirty = true;
                    }
                    continue;
                }
                if !has_managed_block_for_entry(&source, entry.id) {
                    if let Err(e) = upsert_grok_config_entry(entry, enabled) {
                        tracing::warn!(
                            "mcp_marketplace: managed-block repair for '{}' failed: {}",
                            entry.id,
                            e
                        );
                    }
                } else if managed_block_for_entry(&source, entry.id).as_deref()
                    != Some(config_section_for_entry(entry, enabled).trim())
                {
                    if let Err(e) = upsert_grok_config_entry(entry, enabled) {
                        tracing::warn!(
                            "mcp_marketplace: stale managed-block repair for '{}' failed: {}",
                            entry.id,
                            e
                        );
                    }
                }
            }
            continue;
        }
        let Some(st) = file.entries.get(entry.id) else {
            continue;
        };
        if !st.installed {
            continue;
        }
        if let Err(e) = upsert_grok_config_entry(entry, st.enabled) {
            tracing::warn!(
                "mcp_marketplace: legacy migration for '{}' failed: {}",
                entry.id,
                e
            );
        }
    }
    if state_dirty {
        if let Err(e) = write_state(&file) {
            tracing::warn!("mcp_marketplace: state migration write failed: {}", e);
        }
    }
}

/// Enabled marketplace config blocks for project-scoped remote config.
/// Local sessions use `~/.grok/config.toml` directly, but WSL/SSH Grok
/// reads the project config shellX writes just before spawn.
pub fn enabled_project_config_blocks() -> String {
    migrate_legacy_state_to_grok_config();
    let mut out = String::new();
    for entry in CATALOG {
        let Some((installed, enabled)) = installed_enabled_from_grok_config(entry.id) else {
            continue;
        };
        if installed && enabled {
            if !out.is_empty() {
                out.push('\n');
            }
            out.push_str(&config_section_for_entry_for_platform(entry, true, false));
        }
    }
    out
}

/// Environment variables needed by Grok-native marketplace config blocks.
/// Config stores `${SHELLX_MCP_MARKETPLACE_*}` placeholders, while this
/// returns plaintext values resolved from the local vault just before Grok
/// is spawned.
pub async fn marketplace_env_vars() -> Vec<(String, String)> {
    migrate_legacy_state_to_grok_config();
    let vault_opt = crate::vault::Vault::open().ok();
    let Some(vault) = vault_opt.as_ref() else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for entry in CATALOG {
        let Some((installed, enabled)) = installed_enabled_from_grok_config(entry.id) else {
            continue;
        };
        if !(installed && enabled) {
            continue;
        }
        for key in entry.vault_keys {
            match vault.get(key).await.ok().flatten() {
                Some(v) if !v.is_empty() => {
                    out.push((vault_env_name(key), v));
                }
                _ => {
                    tracing::warn!(
                        "mcp_marketplace: env for '{}' missing vault key '{}'",
                        entry.id,
                        key
                    );
                }
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vault_placeholders_become_env_refs() {
        assert_eq!(
            expand_vault_placeholders_to_env_refs("Authorization=Bearer $VAULT:github/pat"),
            "Authorization=Bearer ${SHELLX_MCP_MARKETPLACE_GITHUB_PAT}"
        );
    }

    #[test]
    fn http_config_block_uses_grok_native_mcp_shape_without_plain_secret() {
        let github = CATALOG.iter().find(|e| e.id == "github").unwrap();
        let block = config_section_for_entry(github, true);
        assert!(block.contains("[mcp_servers.shellx-mp-github]"));
        assert!(block.contains("url = \"https://api.githubcopilot.com/mcp/\""));
        assert!(block.contains("type = \"http\""));
        assert!(
            block.contains("\"Authorization\" = \"Bearer ${SHELLX_MCP_MARKETPLACE_GITHUB_PAT}\"")
        );
        assert!(!block.contains("$VAULT:github/pat"));
    }

    #[test]
    fn generated_config_block_is_valid_toml() {
        for entry in CATALOG {
            let block = config_section_for_entry(entry, true);
            toml::from_str::<toml::Value>(&block)
                .unwrap_or_else(|e| panic!("{} config must parse as TOML: {}", entry.id, e));
        }
    }

    #[test]
    fn stdio_keyed_entries_emit_per_server_env_table() {
        let notion = CATALOG.iter().find(|e| e.id == "notion").unwrap();
        let block = config_section_for_entry(notion, true);
        assert!(block.contains("[mcp_servers.shellx-mp-notion.env]"));
        assert!(block.contains("OPENAPI_MCP_HEADERS"));
        assert!(block.contains("${SHELLX_MCP_MARKETPLACE_NOTION_INTEGRATION_TOKEN}"));
        assert!(!block.contains("$VAULT:notion/integration-token"));
        toml::from_str::<toml::Value>(&block).expect("notion config must parse as TOML");
    }

    #[test]
    fn telegram_marketplace_uses_account_credentials_not_bot_token() {
        let telegram = CATALOG.iter().find(|e| e.id == "telegram").unwrap();
        assert_eq!(
            telegram.vault_keys,
            &["telegram/api-id", "telegram/api-hash"]
        );
        let block = config_section_for_entry_for_platform(telegram, false, true);
        assert!(block.contains("enabled = false"));
        assert!(block.contains("API_ID"));
        assert!(block.contains("API_HASH"));
        assert!(!block.contains("TELEGRAM_BOT_TOKEN"));
        assert!(!block.contains("telegram/bot-token"));
    }

    #[test]
    fn detects_legacy_telegram_bot_token_inside_env_block() {
        let source = r#"
# shellX:managed-mcp-marketplace:telegram BEGIN - do not edit by hand
[mcp_servers.shellx-mp-telegram]
command = "cmd.exe"
args = ["/c", "uvx", "mcp-telegram", "start"]
enabled = true
[mcp_servers.shellx-mp-telegram.env]
TELEGRAM_BOT_TOKEN = "${SHELLX_MCP_MARKETPLACE_TELEGRAM_BOT_TOKEN}"
# shellX:managed-mcp-marketplace:telegram END
"#;
        assert!(telegram_section_uses_legacy_bot_token_env(source));
    }

    #[test]
    fn linear_uses_sse_transport_type() {
        let linear = CATALOG.iter().find(|e| e.id == "linear").unwrap();
        let block = config_section_for_entry(linear, true);
        assert!(block.contains("url = \"https://mcp.linear.app/sse\""));
        assert!(block.contains("type = \"sse\""));
    }

    #[test]
    fn remote_project_config_uses_posix_stdio_commands() {
        let context7 = CATALOG.iter().find(|e| e.id == "context7").unwrap();
        let block = config_section_for_entry_for_platform(context7, true, false);
        assert!(block.contains("command = \"npx\""));
        assert!(!block.contains("cmd.exe"));
        assert!(!block.contains("--stdio-proxy"));

        let windows_block = config_section_for_entry_for_platform(context7, true, true);
        assert!(windows_block.contains("--stdio-proxy"));
        assert!(windows_block.contains("\"npx\""));
        assert!(!windows_block.contains("command = \"cmd.exe\""));
    }

    #[test]
    fn strip_unmanaged_server_section_removes_main_and_headers_sections() {
        let source = r#"
[mcp_servers.keep]
command = "ok"

[mcp_servers.shellx-mp-demo]
url = "https://example.invalid/mcp"
enabled = true

[mcp_servers.shellx-mp-demo.headers]
Authorization = "Bearer nope"

[mcp_servers.shellx-mp-demo.env]
TOKEN = "nope"

[mcp_servers.after]
command = "still"
"#;
        let stripped = strip_unmanaged_server_section(source, "shellx-mp-demo");
        assert!(stripped.contains("[mcp_servers.keep]"));
        assert!(stripped.contains("[mcp_servers.after]"));
        assert!(!stripped.contains("shellx-mp-demo"));
    }

    #[test]
    fn strip_unmanaged_server_section_removes_duplicate_sections() {
        let source = r#"
[mcp_servers.shellx-mp-demo]
url = "https://one.invalid"

[mcp_servers.keep]
command = "ok"

[mcp_servers.shellx-mp-demo]
url = "https://two.invalid"

[mcp_servers.shellx-mp-demo.env]
TOKEN = "nope"

[mcp_servers.shellx-mp-demo.env]
TOKEN = "still-nope"
"#;
        let stripped = strip_unmanaged_server_section(source, "shellx-mp-demo");
        assert!(stripped.contains("[mcp_servers.keep]"));
        assert!(!stripped.contains("shellx-mp-demo"));
        toml::from_str::<toml::Value>(&stripped).expect("stripped config should parse");
    }

    #[test]
    fn strip_toml_section_preserves_following_shellx_sentinel() {
        let source = r#"
[mcp_servers.shellx-mp-demo.env]
TOKEN = "x"
# shellX:managed-mcp:grok-shell-host BEGIN - do not edit by hand
[mcp_servers.grok-shell-host]
command = "app"
"#;
        let stripped = strip_toml_section(source, "mcp_servers.shellx-mp-demo.env");

        assert!(!stripped.contains("TOKEN = \"x\""));
        assert!(stripped.contains("# shellX:managed-mcp:grok-shell-host BEGIN"));
        assert!(stripped.contains("[mcp_servers.grok-shell-host]"));
    }

    #[test]
    fn section_enabled_defaults_true_and_respects_false() {
        assert!(section_enabled("[mcp_servers.x]\nurl = \"u\"\n"));
        assert!(!section_enabled(
            "[mcp_servers.x]\nurl = \"u\"\nenabled = false\n"
        ));
    }
}
